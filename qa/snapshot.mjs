#!/usr/bin/env node
// qa/snapshot.mjs <siteDir> <label>
//
// Serves `siteDir`, visits every page (qa/pages.mjs) at three viewports,
// takes full-page screenshots, and extracts a content record per page
// (title, headings, visible text, links, images, forms, console/network
// health, byte weight, horizontal overflow at 375). Writes:
//   qa/out/<label>/<viewport>/<page-slug>.png
//   qa/out/<label>/content.json
// and, when label === 'baseline', also copies content.json to
// qa/baseline/content.json.

import { chromium } from 'playwright'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { serve } from './serve.mjs'
import { listPages } from './pages.mjs'

const CHROME_PATH =
  process.env.CHROME_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome'

const VIEWPORTS = [
  {
    name: '375x812',
    width: 375,
    height: 812,
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
  },
  {
    name: '768x1024',
    width: 768,
    height: 1024,
    deviceScaleFactor: 1,
    isMobile: false,
    hasTouch: false,
  },
  {
    name: '1440x900',
    width: 1440,
    height: 900,
    deviceScaleFactor: 1,
    isMobile: false,
    hasTouch: false,
  },
]

// The viewport whose content record is treated as canonical (and where the
// horizontal-overflow flag is measured, per spec: "at 375").
const CONTENT_VIEWPORT = '375x812'

/**
 * Convert a Netlify pretty-URL page path into a filesystem-safe slug.
 * '/' -> 'index', '/courses/' -> 'courses', '/courses/bronze-obedience' -> 'courses-bronze-obedience'
 * @param {string} urlPath
 */
export function slugForPage(urlPath) {
  if (urlPath === '/') return 'index'
  return urlPath.replace(/^\/|\/$/g, '').replace(/\//g, '-')
}

/**
 * Extract the content record for the currently loaded page.
 * @param {import('playwright').Page} page
 */
async function extractContent(page) {
  return page.evaluate(() => {
    function normalize(s) {
      return (s || '').replace(/\s+/g, ' ').trim()
    }
    const title = document.title
    const description =
      document.querySelector('meta[name="description"]')?.getAttribute('content') ?? null
    const canonical = document.querySelector('link[rel="canonical"]')?.getAttribute('href') ?? null
    const lang = document.documentElement.getAttribute('lang')
    const h1 = Array.from(document.querySelectorAll('h1')).map((h) => normalize(h.textContent))
    const headings = Array.from(document.querySelectorAll('h1,h2,h3,h4,h5,h6')).map((h) => ({
      tag: h.tagName.toLowerCase(),
      text: normalize(h.textContent),
    }))
    // Keep block boundaries as newlines so the comparator can check each
    // text run on its own instead of a run that spans nav, hero and body.
    const visibleText = document.body.innerText
      .replace(/[ \t\u00a0]+/g, ' ')
      .replace(/ *\n+ */g, '\n')
      .trim()

    const origin = location.origin
    const internalLinks = []
    for (const a of document.querySelectorAll('a[href]')) {
      const href = a.getAttribute('href')
      if (!href || href === '#' || href.startsWith('mailto:') || href.startsWith('tel:')) continue
      try {
        const u = new URL(href, location.href)
        if (u.origin === origin) internalLinks.push(u.pathname + u.search)
      } catch {
        // ignore unparsable hrefs
      }
    }

    const images = Array.from(document.querySelectorAll('img')).map((img) => ({
      src: img.getAttribute('src'),
      alt: img.getAttribute('alt'),
      naturalWidth: img.naturalWidth,
      naturalHeight: img.naturalHeight,
      renderedWidth: img.clientWidth,
      loading: img.getAttribute('loading'),
      hasDimensionAttrs: img.hasAttribute('width') && img.hasAttribute('height'),
    }))

    const forms = Array.from(document.querySelectorAll('form')).map((form) => ({
      name: form.getAttribute('name'),
      dataNetlify: form.hasAttribute('data-netlify'),
      fields: Array.from(form.querySelectorAll('input,textarea,select,button[name]')).map((el) => ({
        name: el.getAttribute('name'),
        type:
          el.tagName.toLowerCase() === 'select'
            ? 'select'
            : el.tagName.toLowerCase() === 'textarea'
              ? 'textarea'
              : el.getAttribute('type') || 'text',
        required: el.hasAttribute('required'),
      })),
    }))

    const horizontalOverflow = document.documentElement.scrollWidth > window.innerWidth

    return {
      title,
      description,
      canonical,
      lang,
      h1,
      headings,
      visibleText,
      internalLinks,
      images,
      forms,
      horizontalOverflow,
    }
  })
}

/** Wait (best-effort, bounded) for all <img> elements to finish loading. */
async function waitForImages(page, timeoutMs = 5000) {
  try {
    await page.evaluate(
      ({ timeoutMs }) =>
        Promise.race([
          Promise.all(
            Array.from(document.images).map((img) =>
              img.complete
                ? Promise.resolve()
                : new Promise((res) => {
                    img.addEventListener('load', res, { once: true })
                    img.addEventListener('error', res, { once: true })
                  }),
            ),
          ),
          new Promise((res) => setTimeout(res, timeoutMs)),
        ]),
      { timeoutMs },
    )
  } catch {
    // page may have navigated away; not fatal
  }
}

async function snapshotPage({ context, baseUrl, urlPath, shotDir, captureContent }) {
  const page = await context.newPage()
  const siteOrigin = new URL(baseUrl).origin
  const isSameOrigin = (url) => {
    try {
      return new URL(url).origin === siteOrigin
    } catch {
      return false
    }
  }

  // Third-party resources (Google Analytics, Google Fonts CDN, YouTube, the
  // Google Maps embed, ...) are unreachable in a network-sandboxed QA
  // environment and fail there regardless of the site's own code quality —
  // they're kept for visibility but never gate the compare.mjs pass/fail
  // check, which only cares about the site's own (same-origin) health.
  const consoleErrors = []
  const thirdPartyConsoleErrors = []
  const failedRequests = []
  const thirdPartyFailedRequests = []
  const bytesByType = {}
  let totalBytes = 0

  page.on('console', (msg) => {
    if (msg.type() !== 'error') return
    const locationUrl = msg.location()?.url
    if (!locationUrl || isSameOrigin(locationUrl)) consoleErrors.push(msg.text())
    else thirdPartyConsoleErrors.push({ text: msg.text(), url: locationUrl })
  })
  page.on('pageerror', (err) => consoleErrors.push(String(err?.message ?? err)))
  page.on('response', (res) => {
    if (res.status() < 400) return
    const entry = { url: res.url(), status: res.status() }
    if (isSameOrigin(res.url())) failedRequests.push(entry)
    else thirdPartyFailedRequests.push(entry)
  })
  page.on('requestfailed', (req) => {
    const failure = req.failure()
    if (!failure) return
    const entry = { url: req.url(), status: `failed: ${failure.errorText}` }
    if (isSameOrigin(req.url())) failedRequests.push(entry)
    else thirdPartyFailedRequests.push(entry)
  })
  const sizePromises = []
  page.on('requestfinished', (req) => {
    sizePromises.push(
      req
        .sizes()
        .then((sizes) => {
          const bytes = (sizes.responseBodySize || 0) + (sizes.responseHeadersSize || 0)
          totalBytes += bytes
          const type = req.resourceType()
          bytesByType[type] = (bytesByType[type] || 0) + bytes
        })
        .catch(() => {
          // some requests (data: URLs, cached) don't support sizes()
        }),
    )
  })

  let navigationError = null
  try {
    await page.goto(baseUrl + urlPath, { waitUntil: 'networkidle', timeout: 30000 })
  } catch (err) {
    navigationError = String(err?.message ?? err)
  }

  await waitForImages(page)
  await Promise.allSettled(sizePromises)

  await fs.mkdir(shotDir, { recursive: true })
  try {
    await page.screenshot({
      path: path.join(shotDir, `${slugForPage(urlPath)}.png`),
      fullPage: true,
    })
  } catch (err) {
    if (!navigationError) navigationError = String(err?.message ?? err)
  }

  let record = null
  if (captureContent) {
    record = navigationError
      ? {
          title: null,
          description: null,
          canonical: null,
          lang: null,
          h1: [],
          headings: [],
          visibleText: '',
          internalLinks: [],
          images: [],
          forms: [],
          horizontalOverflow: false,
        }
      : await extractContent(page)
    // (thirdParty* fields are attached below alongside the rest of the record)
    record.navigationError = navigationError
    record.consoleErrors = consoleErrors
    record.failedRequests = failedRequests
    record.thirdPartyConsoleErrors = thirdPartyConsoleErrors
    record.thirdPartyFailedRequests = thirdPartyFailedRequests
    record.totalBytes = totalBytes
    record.bytesByType = bytesByType
  }

  await page.close()
  return record
}

/**
 * Run the full snapshot pass for a built site.
 * @param {string} siteDir
 * @param {string} label
 */
export async function snapshot(siteDir, label) {
  const pages = await listPages(siteDir)
  const handle = await serve(siteDir, 0)
  const browser = await chromium.launch({
    executablePath: CHROME_PATH,
    headless: true,
    args: ['--headless=new', '--no-sandbox', '--disable-gpu'],
  })

  const outDir = path.resolve('qa/out', label)
  await fs.mkdir(outDir, { recursive: true })

  const contentRecords = {}

  try {
    for (const viewport of VIEWPORTS) {
      const context = await browser.newContext({
        viewport: { width: viewport.width, height: viewport.height },
        deviceScaleFactor: viewport.deviceScaleFactor,
        isMobile: viewport.isMobile,
        hasTouch: viewport.hasTouch,
      })
      const shotDir = path.join(outDir, viewport.name)

      for (const urlPath of pages) {
        const captureContent = viewport.name === CONTENT_VIEWPORT
        console.log(`[${viewport.name}] ${urlPath}`)
        const record = await snapshotPage({
          context,
          baseUrl: handle.url,
          urlPath,
          shotDir,
          captureContent,
        })
        if (captureContent) contentRecords[urlPath] = record
      }
      await context.close()
    }
  } finally {
    await browser.close()
    await handle.close()
  }

  const outFile = path.join(outDir, 'content.json')
  // `siteDir` is recorded so qa/compare.mjs can tell whether the build moved on
  // after this snapshot was taken — see its staleness guard.
  const payload = {
    label,
    generated: new Date().toISOString(),
    siteDir: path.resolve(siteDir),
    pages: contentRecords,
  }
  await fs.writeFile(outFile, JSON.stringify(payload, null, 2))
  console.log(`Wrote ${outFile}`)

  if (label === 'baseline') {
    const baselineDir = path.resolve('qa/baseline')
    await fs.mkdir(baselineDir, { recursive: true })
    await fs.copyFile(outFile, path.join(baselineDir, 'content.json'))
    console.log(`Copied to ${path.join(baselineDir, 'content.json')}`)
  }

  return payload
}

const isMain = process.argv[1] === fileURLToPath(import.meta.url)
if (isMain) {
  const [siteDir, label] = process.argv.slice(2)
  if (!siteDir || !label) {
    console.error('Usage: node qa/snapshot.mjs <siteDir> <label>')
    process.exit(1)
  }
  await snapshot(siteDir, label)
}
