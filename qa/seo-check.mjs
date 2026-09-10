#!/usr/bin/env node
// qa/seo-check.mjs <siteDir> — SEO/head sanity check over a built site.
//
// Builds its page list straight from the *.html files under <siteDir> (any
// file that isn't a real page — e.g. the Google site-verification file kiss
// copies straight through from src/assets/ — is skipped by checking for an
// <html> tag), then for every page asserts:
//
//   - exactly one <title>, exactly one <h1>
//   - lang="en-GB" on <html>
//   - a canonical <link> whose href matches the page's own pretty URL
//   - og:title and og:url present
//   - og:image resolves to a file that actually exists under siteDir
//   - the LocalBusiness JSON-LD parses, and carries a `location` array of
//     exactly two Place entries, each with a postalCode
//   - (warning, not failure — see generate.js's per-model `description`)
//     a non-empty meta description
//
// Also checks that sitemap.xml exists, parses, and lists exactly the same
// page set (in the same pretty-URL shape) as the HTML files on disk; that
// _headers and _redirects are present in siteDir and that _headers' `/*`
// block precedes every other path block (see that file's own comment); and
// that robots.txt allows the named AI crawlers and lists the sitemap.
//
// No HTML/XML parsing library is used — the site is minified, single-line
// HTML this script itself doesn't control the shape of elsewhere, so every
// check below is a small, deliberately permissive regex over the raw text.
//
// Usage: node qa/seo-check.mjs docs

import fs from 'node:fs'
import path from 'node:path'
import 'colors'

const siteDir = process.argv[2]
if (!siteDir) {
  console.error('Usage: node qa/seo-check.mjs <siteDir>')
  process.exit(1)
}
if (!fs.existsSync(siteDir)) {
  console.error(`No such directory: ${siteDir}`)
  process.exit(1)
}

const SITE_URL = 'https://www.a1k9training.co.uk'

// --- helpers ----------------------------------------------------------

/** Walk siteDir, returning every *.html file's absolute path. */
function walkHtmlFiles(dir) {
  const out = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) out.push(...walkHtmlFiles(full))
    else if (entry.isFile() && entry.name.endsWith('.html')) out.push(full)
  }
  return out
}

// The same collapse kiss's canonical/sitemap use, restored to the trailing-
// slash-on-a-folder-index shape generate.js's `pageUrl` helper and
// `fixSitemapTrailingSlashes` step put back (see generate.js) — so this
// script's idea of "the right URL for this file" matches what the site
// itself emits, not kiss's un-patched default.
function prettyUrlForFile(siteDirAbs, filePath) {
  const rel = path.relative(siteDirAbs, filePath).split(path.sep).join('/')
  const parts = rel.split('/')
  const base = parts[parts.length - 1]
  const dir = parts.slice(0, -1)
  if (base === 'index.html') return dir.length ? `/${dir.join('/')}/` : '/'
  const noExt = base.replace(/\.html$/, '')
  return `/${[...dir, noExt].join('/')}`
}

function count(re, text) {
  const m = text.match(re)
  return m ? m.length : 0
}

function attr(tag, name) {
  const m = tag.match(new RegExp(`${name}="([^"]*)"`, 'i'))
  return m ? m[1] : null
}

function firstTag(re, text) {
  const m = text.match(re)
  return m ? m[0] : null
}

function isRealPage(html) {
  return /<html[\s>]/i.test(html)
}

// --- collect the page set ----------------------------------------------

const siteDirAbs = path.resolve(siteDir)
const allHtmlFiles = walkHtmlFiles(siteDirAbs)
const pages = []
for (const file of allHtmlFiles) {
  const html = fs.readFileSync(file, 'utf8')
  if (!isRealPage(html)) continue
  pages.push({
    file,
    rel: path.relative(siteDirAbs, file),
    url: prettyUrlForFile(siteDirAbs, file),
    html,
  })
}
pages.sort((a, b) => a.url.localeCompare(b.url))

if (pages.length === 0) {
  console.error(`No page HTML found under ${siteDir}`)
  process.exit(1)
}

// --- per-page checks -----------------------------------------------------

const rows = []
let anyFailure = false

for (const page of pages) {
  const { html } = page
  const failures = []
  const warnings = []

  const titleCount = count(/<title\b[^>]*>/gi, html)
  if (titleCount !== 1) failures.push(`title count = ${titleCount}`)

  const h1Count = count(/<h1\b[^>]*>/gi, html)
  if (h1Count !== 1) failures.push(`h1 count = ${h1Count}`)

  const htmlTag = firstTag(/<html\b[^>]*>/i, html)
  const lang = htmlTag ? attr(htmlTag, 'lang') : null
  if (lang !== 'en-GB') failures.push(`lang="${lang}" (expected "en-GB")`)

  const canonicalTag = firstTag(
    /<link\b[^>]*rel="canonical"[^>]*>/i,
    html,
  )
  const canonicalHref = canonicalTag ? attr(canonicalTag, 'href') : null
  const expectedCanonical = `${SITE_URL}${page.url}`
  if (canonicalHref !== expectedCanonical)
    failures.push(
      `canonical href = ${JSON.stringify(canonicalHref)} (expected ${JSON.stringify(expectedCanonical)})`,
    )

  const ogTitleTag = firstTag(
    /<meta\b[^>]*property="og:title"[^>]*>/i,
    html,
  )
  if (!ogTitleTag || !attr(ogTitleTag, 'content'))
    failures.push('og:title missing')

  const ogUrlTag = firstTag(/<meta\b[^>]*property="og:url"[^>]*>/i, html)
  const ogUrl = ogUrlTag ? attr(ogUrlTag, 'content') : null
  if (!ogUrl) failures.push('og:url missing')

  const ogImageTag = firstTag(
    /<meta\b[^>]*property="og:image"[^>]*>/i,
    html,
  )
  const ogImage = ogImageTag ? attr(ogImageTag, 'content') : null
  if (!ogImage) {
    failures.push('og:image missing')
  } else if (!ogImage.startsWith(SITE_URL)) {
    failures.push(`og:image is not on ${SITE_URL}: ${ogImage}`)
  } else {
    const imgPath = ogImage.slice(SITE_URL.length).split(/[?#]/)[0]
    const imgFile = path.join(siteDirAbs, decodeURIComponent(imgPath))
    if (!fs.existsSync(imgFile))
      failures.push(`og:image file does not exist: ${imgPath}`)
  }

  const ldJsonMatch = html.match(
    /<script\b[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/i,
  )
  if (!ldJsonMatch) {
    failures.push('JSON-LD script missing')
  } else {
    try {
      const localBusiness = JSON.parse(ldJsonMatch[1])
      // generate.js's localBusiness helper is always the first ld+json
      // script in <head> (src/partials/layout/header.hbs) — see its
      // `location` array of the two venues src/pages/find-us.hbs names.
      const locations = Array.isArray(localBusiness.location)
        ? localBusiness.location
        : []
      if (locations.length !== 2) {
        failures.push(
          `LocalBusiness location array has ${locations.length} entries (expected 2)`,
        )
      } else {
        locations.forEach((loc, i) => {
          if (!loc?.address?.postalCode)
            failures.push(`LocalBusiness location[${i}] has no postalCode`)
        })
      }
    } catch (err) {
      failures.push(`JSON-LD does not parse: ${err.message}`)
    }
  }

  const descTag = firstTag(
    /<meta\b[^>]*name="description"[^>]*>/i,
    html,
  )
  const desc = descTag ? attr(descTag, 'content') : null
  if (!desc || !desc.trim())
    warnings.push('meta description is empty (description sweep pending)')

  if (failures.length) anyFailure = true
  rows.push({ url: page.url, failures, warnings })
}

// --- llms.txt ---------------------------------------------------------
// kiss writes it from the page registry; every entry URL must be one the
// sitemap also lists, and every sitemap URL must have an entry.
const llmsFailures = []
const llmsPath = path.join(siteDirAbs, 'llms.txt')
if (!fs.existsSync(llmsPath)) {
  llmsFailures.push('llms.txt does not exist')
} else {
  const txt = fs.readFileSync(llmsPath, 'utf8')
  if (!/^# .+/m.test(txt)) llmsFailures.push('llms.txt has no H1 title')
  if (!/^> .+/m.test(txt)) llmsFailures.push('llms.txt has no blockquote summary')
  const entryUrls = [...txt.matchAll(/^- \[[^\]]+\]\((https?:[^)]+)\)/gm)].map((m) => m[1])
  const smXml = fs.existsSync(path.join(siteDirAbs, 'sitemap.xml'))
    ? fs.readFileSync(path.join(siteDirAbs, 'sitemap.xml'), 'utf8')
    : ''
  const smUrls = [...smXml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1])
  for (const u of entryUrls) if (!smUrls.includes(u)) llmsFailures.push(`llms.txt entry not in sitemap: ${u}`)
  for (const u of smUrls) if (!entryUrls.includes(u)) llmsFailures.push(`sitemap URL missing from llms.txt: ${u}`)
  if (entryUrls.length === 0) llmsFailures.push('llms.txt has no entries')
}

// --- sitemap.xml -----------------------------------------------------

const sitemapFailures = []
const sitemapPath = path.join(siteDirAbs, 'sitemap.xml')
if (!fs.existsSync(sitemapPath)) {
  sitemapFailures.push('sitemap.xml does not exist')
} else {
  const xml = fs.readFileSync(sitemapPath, 'utf8')
  const locs = [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1])
  if (locs.length === 0) {
    sitemapFailures.push('sitemap.xml has no <loc> entries (does it parse?)')
  }
  if (!/<urlset\b/i.test(xml) || !/<\/urlset>/i.test(xml)) {
    sitemapFailures.push('sitemap.xml does not look like a <urlset> document')
  }
  const sitemapUrls = new Set(
    locs.map((loc) => loc.replace(SITE_URL, '') || '/'),
  )
  const pageUrls = new Set(pages.map((p) => p.url))
  const missing = [...pageUrls].filter((u) => !sitemapUrls.has(u))
  const extra = [...sitemapUrls].filter((u) => !pageUrls.has(u))
  if (missing.length)
    sitemapFailures.push(`sitemap.xml is missing: ${missing.join(', ')}`)
  if (extra.length)
    sitemapFailures.push(`sitemap.xml has extra entries: ${extra.join(', ')}`)
}
if (sitemapFailures.length) anyFailure = true
if (llmsFailures.length) anyFailure = true

// --- _headers / _redirects -----------------------------------------------

const siteFailures = []
for (const name of ['_headers', '_redirects']) {
  if (!fs.existsSync(path.join(siteDirAbs, name)))
    siteFailures.push(`${name} is missing from ${siteDir}`)
}

// _headers rule order: Netlify lets a later, more specific rule win over an
// earlier one for the same header, so the broad `/*` block (page default +
// security headers) has to come first, with the asset-specific blocks
// (/css/*, /js/*, /images/*, /fonts/*) after it — see src/assets/_headers'
// own top comment. A `/*` block placed last would let it win over
// /css/*'s immutable Cache-Control, which is the live defect this guards.
const headersPath = path.join(siteDirAbs, '_headers')
if (fs.existsSync(headersPath)) {
  const headersText = fs.readFileSync(headersPath, 'utf8')
  const pathBlocks = [...headersText.matchAll(/^(\/\S*)/gm)].map(
    (m) => m[1],
  )
  const catchAllIndex = pathBlocks.indexOf('/*')
  if (catchAllIndex === -1) {
    siteFailures.push('_headers has no /* block')
  } else if (catchAllIndex !== 0) {
    siteFailures.push(
      `_headers: /* block must precede every other path block (found after ${pathBlocks.slice(0, catchAllIndex).join(', ')})`,
    )
  }
}

// robots.txt: the deliberate AI-crawler allow policy (src/assets/robots.txt)
// must survive the build — GPTBot and ClaudeBot standing for the named-crawler
// block, plus the Sitemap line the rest of this script already depends on.
const robotsPath = path.join(siteDirAbs, 'robots.txt')
if (!fs.existsSync(robotsPath)) {
  siteFailures.push('robots.txt is missing from ' + siteDir)
} else {
  const robotsText = fs.readFileSync(robotsPath, 'utf8')
  if (!/^User-agent:\s*GPTBot/m.test(robotsText))
    siteFailures.push('robots.txt has no GPTBot entry')
  if (!/^User-agent:\s*ClaudeBot/m.test(robotsText))
    siteFailures.push('robots.txt has no ClaudeBot entry')
  if (!robotsText.includes(`Sitemap: ${SITE_URL}/sitemap.xml`))
    siteFailures.push('robots.txt has no Sitemap: line')
}

if (siteFailures.length) anyFailure = true

// --- report ------------------------------------------------------------

const pad = (s, n) => (s.length >= n ? s : s + ' '.repeat(n - s.length))
const urlWidth = Math.max(3, ...rows.map((r) => r.url.length))

console.log(pad('URL', urlWidth) + '  STATUS')
console.log('-'.repeat(urlWidth) + '  ' + '-'.repeat(20))
for (const row of rows) {
  const status = row.failures.length
    ? 'FAIL'.red
    : row.warnings.length
      ? 'WARN'.yellow
      : 'ok'.green
  console.log(`${pad(row.url, urlWidth)}  ${status}`)
  for (const f of row.failures) console.log(`${' '.repeat(urlWidth)}    ${'✗'.red} ${f}`)
  for (const w of row.warnings) console.log(`${' '.repeat(urlWidth)}    ${'!'.yellow} ${w}`)
}

console.log('')
console.log('sitemap.xml / site files:')
if (sitemapFailures.length === 0) console.log(`  ${'ok'.green}`)
for (const f of sitemapFailures) console.log(`  ${'✗'.red} ${f}`)
console.log('\nllms.txt:')
if (llmsFailures.length === 0) console.log(`  ${'ok'.green}`)
for (const f of llmsFailures) console.log(`  ${'✗'.red} ${f}`)
for (const f of siteFailures) console.log(`  ${'✗'.red} ${f}`)

const failedPages = rows.filter((r) => r.failures.length).length
const warnedPages = rows.filter((r) => r.warnings.length).length
console.log('')
console.log(
  `${pages.length} page(s) checked, ${failedPages} failed, ${warnedPages} warned` +
    (sitemapFailures.length || llmsFailures.length || siteFailures.length
      ? `, ${sitemapFailures.length + llmsFailures.length + siteFailures.length} site-level failure(s)`
      : ''),
)

if (anyFailure) {
  console.log('FAILED'.red)
  process.exit(1)
} else {
  console.log('PASSED'.green)
}
