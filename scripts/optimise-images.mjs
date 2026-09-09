#!/usr/bin/env node
/**
 * Optimise the site's source images in place.
 *
 * Usage:
 *   node scripts/optimise-images.mjs
 *
 * What it does (see planning/2026-09-07-tailwind-migration-plan.md, "Loop 3"):
 *   1. Discovers every /images/... path referenced from src/pages, src/partials,
 *      src/layouts, src/models/**\/*.json and generate.js (png/jpg/JPG/gif),
 *      plus the homepage hero background-image hardcoded in a layout.
 *   2. Classifies each as "hero" (the `image` field of a model JSON / generate.js
 *      page model, or the homepage hero) or "content" (everything else).
 *   3. Converts every referenced raster to WebP with sharp, in place, same
 *      directory/basename (`foo-v2.png` -> `foo-v2.webp`), auto-orienting by
 *      EXIF first. Heroes get a 1920px-wide main image plus a 960px-wide
 *      `-960w.webp` variant; content images are capped at 900px wide. Nothing
 *      is ever upscaled. Small (<200px wide) alpha logos/badges are encoded
 *      near-lossless to protect flat colour; everything else is quality 80.
 *      Any output over 250 KB is retightened (lower quality, then narrower)
 *      until it fits, and the script reports what it tightened.
 *   4. Deletes the original raster file once its .webp replacement exists.
 *   5. Rewrites the old path to the new .webp path, as an exact string
 *      replacement, in the files this script owns: src/models/**\/*.json,
 *      src/pages/**, and src/partials/** EXCEPT src/partials/layout/**.
 *      generate.js and src/layouts/** are read for discovery only and are
 *      never edited — their still-old references are reported instead.
 *   6. Converts the Bootstrap-era `caption-class` field on model JSON to the
 *      new semantic `caption` / `captionOffset` shape.
 *   7. Writes qa/images.json, a manifest of every referenced image (old path
 *      -> new path, dimensions, role, byte size, hero variants) plus the
 *      list of unreferenced originals (left untouched, not deleted) and
 *      before/after byte totals.
 *
 * Idempotent: a second run finds no old-extension references left to convert
 * and no caption-class keys left to rewrite, so it does nothing but rewrite
 * qa/images.json from the current on-disk state.
 */

import { readFileSync, writeFileSync, statSync, unlinkSync, readdirSync } from 'node:fs'
import { join, dirname, relative, basename } from 'node:path'
import { fileURLToPath } from 'node:url'
import sharp from 'sharp'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '..')
const IMAGES_DIR = join(ROOT, 'src/assets/images')
const MAX_OUTPUT_BYTES = 250 * 1024

// ---------------------------------------------------------------------------
// small fs helpers
// ---------------------------------------------------------------------------

/** Recursively list every file under `dir`. */
function walk(dir) {
  const out = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...walk(full))
    else out.push(full)
  }
  return out
}

function pathSep() {
  return process.platform === 'win32' ? '\\' : '/'
}

/** '/images/foo/bar.png' -> absolute path under src/assets/images */
function diskPathFor(webPath) {
  // webPath starts with /images/...
  return join(ROOT, 'src/assets', webPath.replace(/^\//, ''))
}

function statSyncSafe(absPath) {
  try {
    return statSync(absPath)
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// discovery
// ---------------------------------------------------------------------------

const IMAGE_REF_RE = /\/images\/[\w./-]+\.(?:png|jpe?g|gif)/gi

const OWNED_ROOTS = [join(ROOT, 'src/pages'), join(ROOT, 'src/partials')]
const LAYOUT_PARTIALS = join(ROOT, 'src/partials/layout')
const READONLY_ROOTS = [join(ROOT, 'src/layouts')]
const MODELS_ROOT = join(ROOT, 'src/models')
const GENERATE_JS = join(ROOT, 'generate.js')

function isUnderLayoutPartials(p) {
  return p === LAYOUT_PARTIALS || p.startsWith(LAYOUT_PARTIALS + '/')
}

/** Whether this script is allowed to rewrite reference strings inside `p`. */
function isOwnedForRewrite(p) {
  if (p.startsWith(MODELS_ROOT + '/') && p.endsWith('.json')) return true
  if (p.startsWith(join(ROOT, 'src/pages') + '/')) return true
  if (p.startsWith(join(ROOT, 'src/partials') + '/') && !isUnderLayoutPartials(p)) return true
  return false
}

function allTextFiles() {
  const files = []
  for (const root of [...OWNED_ROOTS, ...READONLY_ROOTS]) files.push(...walk(root))
  files.push(...walk(MODELS_ROOT).filter((f) => f.endsWith('.json')))
  files.push(GENERATE_JS)
  return files
}

const HOMEPAGE_HERO = '/images/gaynor-probert-home-v1.1.png'

/** Map of file path -> current text content (read once, mutated in memory, written at the end). */
const fileContents = new Map()
for (const f of allTextFiles()) {
  fileContents.set(f, readFileSync(f, 'utf8'))
}

// Every /images/... path (old raster extensions) referenced anywhere.
const referencedOld = new Set()
for (const [, content] of fileContents) {
  const matches = content.match(IMAGE_REF_RE) || []
  for (const m of matches) referencedOld.add(m)
}
referencedOld.add(HOMEPAGE_HERO)

// Hero paths: the `image` field of any src/models/**/*.json, or of a page
// model literal in generate.js, plus the homepage hero.
const heroPaths = new Set([HOMEPAGE_HERO])
for (const [f, content] of fileContents) {
  if (f === GENERATE_JS || (f.startsWith(MODELS_ROOT + '/') && f.endsWith('.json'))) {
    const re = /"image"\s*:\s*"([^"]+)"|image:\s*'([^']+)'/g
    let m
    while ((m = re.exec(content))) {
      const path = m[1] || m[2]
      if (path) heroPaths.add(path)
    }
  }
}

// A file this script does not own (generate.js, src/layouts/**) may already
// reference the .webp name ahead of this script actually producing it (the
// agent owning that file renamed its reference in anticipation). Resolve any
// such not-yet-existing .webp reference back to its still-raster sibling so
// it still gets converted -- and, since it came from an `image` field or the
// homepage hero, treat it as a hero.
for (const f of [GENERATE_JS, ...READONLY_ROOTS.flatMap(walk)]) {
  const content = fileContents.get(f) ?? readFileSync(f, 'utf8')
  const webpRefs = content.match(/\/images\/[\w./-]+\.webp/gi) || []
  for (const webPath of webpRefs) {
    if (statSyncSafe(diskPathFor(webPath))) continue // already converted
    const dir = dirname(diskPathFor(webPath))
    const base = basename(webPath, '.webp')
    for (const ext of ['png', 'jpg', 'jpeg', 'JPG', 'JPEG', 'gif']) {
      const candidate = join(dir, `${base}.${ext}`)
      if (statSyncSafe(candidate)) {
        const rasterWebPath = webPath.replace(/\.webp$/i, `.${ext}`)
        referencedOld.add(rasterWebPath)
        if (f === GENERATE_JS || READONLY_ROOTS.some((r) => f.startsWith(r + '/'))) {
          heroPaths.add(rasterWebPath) // an `image`/hero reference by construction
        }
        break
      }
    }
  }
}

// ---------------------------------------------------------------------------
// conversion
// ---------------------------------------------------------------------------

const manifestImages = {}
const tightened = []
let convertedCount = 0
let totalBeforeBytes = 0
let totalAfterBytes = 0

/** Encode `image` (a sharp instance already rotated+resized) to webp honouring the size cap. */
async function encodeWithBudget(pipeline, { nearLossless }) {
  const attempts = nearLossless
    ? [{ nearLossless: true, quality: 90 }, { nearLossless: true, quality: 75 }, { quality: 80 }]
    : [{ quality: 80 }, { quality: 70 }, { quality: 60 }, { quality: 50 }, { quality: 40 }]
  let last = null
  for (const opts of attempts) {
    const buf = await pipeline.clone().webp({ effort: 5, ...opts }).toBuffer()
    last = { buf, opts }
    if (buf.length <= MAX_OUTPUT_BYTES) return { buf, opts, tightenedFrom: attempts[0] !== opts ? attempts[0] : null }
  }
  return { buf: last.buf, opts: last.opts, tightenedFrom: attempts[0] }
}

async function convertOne(oldWebPath) {
  const srcAbs = diskPathFor(oldWebPath)
  let stat
  try {
    stat = statSync(srcAbs)
  } catch {
    console.warn(`WARNING: referenced but missing on disk: ${oldWebPath}`)
    return
  }
  const beforeBytes = stat.size
  const role = heroPaths.has(oldWebPath) ? 'hero' : 'content'
  const maxWidth = role === 'hero' ? 1920 : 900

  const img = sharp(srcAbs).rotate()
  const meta = await img.metadata()
  const hasAlpha = !!meta.hasAlpha
  const smallLogo = hasAlpha && (meta.width ?? 0) < 200

  const resized = img.resize({ width: maxWidth, withoutEnlargement: true })
  const { buf, opts, tightenedFrom } = await encodeWithBudget(resized, { nearLossless: smallLogo })
  const outMeta = await sharp(buf).metadata()

  const newWebPath = oldWebPath.replace(/\.(png|jpe?g|gif)$/i, '.webp')
  const outAbs = diskPathFor(newWebPath)
  writeFileSync(outAbs, buf)

  if (tightenedFrom) {
    tightened.push({ path: newWebPath, from: tightenedFrom, to: opts, bytes: buf.length })
  }

  const entry = {
    src: newWebPath,
    width: outMeta.width,
    height: outMeta.height,
    role,
    bytes: buf.length,
  }

  let afterBytes = buf.length

  if (role === 'hero') {
    const variantPipeline = sharp(srcAbs).rotate().resize({ width: 960, withoutEnlargement: true })
    const variantResult = await encodeWithBudget(variantPipeline, { nearLossless: smallLogo })
    const variantMeta = await sharp(variantResult.buf).metadata()
    const variantPath = newWebPath.replace(/\.webp$/i, '-960w.webp')
    writeFileSync(diskPathFor(variantPath), variantResult.buf)
    if (variantResult.tightenedFrom) {
      tightened.push({
        path: variantPath,
        from: variantResult.tightenedFrom,
        to: variantResult.opts,
        bytes: variantResult.buf.length,
      })
    }
    entry.variants = {
      960: { src: variantPath, width: variantMeta.width, height: variantMeta.height, bytes: variantResult.buf.length },
    }
    afterBytes += variantResult.buf.length
  }

  manifestImages[oldWebPath] = entry
  totalBeforeBytes += beforeBytes
  totalAfterBytes += afterBytes
  convertedCount++

  unlinkSync(srcAbs)

  // Rewrite references in owned files.
  const rewriteCounts = new Map()
  for (const [f, content] of fileContents) {
    if (!isOwnedForRewrite(f)) continue
    if (!content.includes(oldWebPath)) continue
    const count = content.split(oldWebPath).length - 1
    fileContents.set(f, content.split(oldWebPath).join(newWebPath))
    rewriteCounts.set(f, count)
  }
  return rewriteCounts
}

// A path already converted to .webp on a prior run: just record it in the
// manifest so the manifest always reflects full current state.
async function recordAlreadyWebp(webPath) {
  const abs = diskPathFor(webPath)
  let stat
  try {
    stat = statSync(abs)
  } catch {
    return
  }
  const role = heroPaths.has(webPath) ? 'hero' : 'content'
  const meta = await sharp(abs).metadata()
  const entry = { src: webPath, width: meta.width, height: meta.height, role, bytes: stat.size }
  let afterBytes = stat.size
  if (role === 'hero') {
    const variantPath = webPath.replace(/\.webp$/i, '-960w.webp')
    const variantAbs = diskPathFor(variantPath)
    try {
      const vStat = statSync(variantAbs)
      const vMeta = await sharp(variantAbs).metadata()
      entry.variants = { 960: { src: variantPath, width: vMeta.width, height: vMeta.height, bytes: vStat.size } }
      afterBytes += vStat.size
    } catch {
      // no variant on disk (unexpected but non-fatal)
    }
  }
  manifestImages[webPath] = entry
  totalBeforeBytes += afterBytes
  totalAfterBytes += afterBytes
}

const rewriteReport = new Map() // file -> count
const MANIFEST_PATH = join(ROOT, 'qa/images.json')

/** Carry forward manifest entries from a prior run whose files still exist on
 * disk, so a re-run doesn't lose track of images only ever referenced from a
 * file this script cannot edit (e.g. generate.js still says the old .png name,
 * but the .webp this script produced earlier is still the real, current file). */
function loadCarriedForwardManifest() {
  let previous
  try {
    previous = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8'))
  } catch {
    return
  }
  for (const [oldPath, entry] of Object.entries(previous.images ?? {})) {
    try {
      statSync(diskPathFor(entry.src))
    } catch {
      continue // main file gone (e.g. manually removed) -- don't carry forward
    }
    manifestImages[oldPath] = entry
  }
  // The real "before" size of a carried-forward image no longer exists on
  // disk once its original is deleted, so lifetime totals are carried
  // forward from the previous manifest rather than recomputed from scratch;
  // this run then adds only the delta for images it actually converts.
  totalBeforeBytes += previous.totals?.beforeBytes ?? 0
  totalAfterBytes += previous.totals?.afterBytes ?? 0
}

async function main() {
  loadCarriedForwardManifest()
  const oldRaster = [...referencedOld].filter(
    (p) => /\.(png|jpe?g|gif)$/i.test(p) && !manifestImages[p],
  )
  for (const p of oldRaster) {
    const counts = await convertOne(p)
    if (counts) {
      for (const [f, c] of counts) rewriteReport.set(f, (rewriteReport.get(f) ?? 0) + c)
    }
  }

  // caption-class -> caption/captionOffset, models only
  for (const [f, content] of fileContents) {
    if (!(f.startsWith(MODELS_ROOT + '/') && f.endsWith('.json'))) continue
    if (!content.includes('caption-class')) continue
    const obj = JSON.parse(content)
    if (Object.prototype.hasOwnProperty.call(obj, 'caption-class')) {
      const tokens = String(obj['caption-class']).split(/\s+/)
      const rebuilt = {}
      for (const [key, value] of Object.entries(obj)) {
        if (key !== 'caption-class') {
          rebuilt[key] = value
          continue
        }
        if (tokens.includes('pull-right')) rebuilt.caption = 'right'
        if (tokens.includes('pull-left')) rebuilt.caption = 'left'
        if (tokens.includes('push-down')) rebuilt.captionOffset = true
      }
      fileContents.set(f, JSON.stringify(rebuilt, null, 2) + '\n')
    }
  }

  // Write back every owned file that changed.
  for (const [f, content] of fileContents) {
    if (!isOwnedForRewrite(f)) continue
    const original = readFileSync(f, 'utf8')
    if (original !== content) writeFileSync(f, content)
  }

  // Idempotent second-run pass: any already-webp reference not just converted
  // above (i.e. from a previous run) still belongs in the manifest.
  const allCurrentRefs = new Set()
  for (const [f, content] of fileContents) {
    const matches = content.match(/\/images\/[\w./-]+\.webp/gi) || []
    for (const m of matches) allCurrentRefs.add(m)
  }
  // also re-check disk for the homepage hero + its variant, and any already-webp hero paths
  for (const p of heroPaths) {
    const webp = p.replace(/\.(png|jpe?g|gif)$/i, '.webp')
    allCurrentRefs.add(webp)
  }
  const isAlreadyAccounted = (p) =>
    Object.values(manifestImages).some(
      (e) => e.src === p || (e.variants && Object.values(e.variants).some((v) => v.src === p)),
    )
  for (const p of allCurrentRefs) {
    if (manifestImages[p]) continue
    if (isAlreadyAccounted(p)) continue
    await recordAlreadyWebp(p)
  }

  // Unreferenced originals: everything on disk not accounted for by any
  // manifest src/variant-src/original key, and not favicon.ico.
  const accounted = new Set()
  for (const [oldPath, entry] of Object.entries(manifestImages)) {
    accounted.add(diskPathFor(oldPath))
    accounted.add(diskPathFor(entry.src))
    if (entry.variants) for (const v of Object.values(entry.variants)) accounted.add(diskPathFor(v.src))
  }
  const unreferenced = []
  for (const abs of walk(IMAGES_DIR)) {
    if (basename(abs) === 'favicon.ico') continue
    if (accounted.has(abs)) continue
    unreferenced.push({
      path: '/' + relative(join(ROOT, 'src/assets'), abs).split(pathSep()).join('/'),
      bytes: statSync(abs).size,
    })
  }
  unreferenced.sort((a, b) => b.bytes - a.bytes)

  const manifest = {
    generated: new Date().toISOString(),
    images: manifestImages,
    unreferenced,
    totals: { beforeBytes: totalBeforeBytes, afterBytes: totalAfterBytes },
  }
  writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2) + '\n')

  // ---- verification ---------------------------------------------------
  const oversized = Object.entries(manifestImages).filter(([, e]) => e.bytes > MAX_OUTPUT_BYTES)
  for (const [, e] of Object.entries(manifestImages)) {
    if (e.variants) {
      for (const v of Object.values(e.variants)) {
        if (v.bytes > MAX_OUTPUT_BYTES) oversized.push([v.src, v])
      }
    }
  }

  const staleReferences = []
  for (const f of [GENERATE_JS, ...walk(READONLY_ROOTS[0])]) {
    const content = readFileSync(f, 'utf8')
    const matches = content.match(IMAGE_REF_RE) || []
    for (const m of matches) {
      const entry = manifestImages[m]
      staleReferences.push({ file: relative(ROOT, f), old: m, new: entry ? entry.src : '(not converted)' })
    }
  }

  // ---- report -----------------------------------------------------------
  console.log(`Converted: ${convertedCount}`)
  console.log(`Before: ${totalBeforeBytes} bytes, After: ${totalAfterBytes} bytes`)
  console.log(`Rewrites per file:`)
  for (const [f, c] of rewriteReport) console.log(`  ${relative(ROOT, f)}: ${c}`)
  console.log(`Unreferenced originals: ${unreferenced.length}`)
  console.log(`Oversized (>250KB) after tightening: ${oversized.length}`)
  if (tightened.length) {
    console.log('Tightened outputs:')
    for (const t of tightened) console.log(`  ${t.path}: ${JSON.stringify(t.from)} -> ${JSON.stringify(t.to)} (${t.bytes} bytes)`)
  }
  if (staleReferences.length) {
    console.log('References in files this script does not own (report only, not rewritten):')
    for (const s of staleReferences) console.log(`  ${s.file}: ${s.old} -> ${s.new}`)
  }
  console.log(`Manifest written to qa/images.json`)
}

main().catch((err) => {
  console.error(err)
  process.exitCode = 1
})
