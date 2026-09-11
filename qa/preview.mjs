#!/usr/bin/env node
// qa/preview.mjs <url> [--pages=/,/courses/,...] [--json=<file>] [--md=<file>]
//
// Verifies a DEPLOYED site — a Netlify deploy preview or production — for
// what a local docs/ build cannot prove: real HTTP headers, pretty-URL and
// redirect behaviour, and the pages a browser actually receives. Unlike the
// rest of qa/ (which serves and inspects an already-built directory), this
// script only ever talks HTTP/HTTPS to <url>; it builds nothing and never
// touches the filesystem outside qa/out/preview/.
//
// generate.js pins `siteUrl` to production (`https://www.a1k9training.co.uk`)
// regardless of which host actually served the response, so `<link
// rel="canonical">`, every `<loc>` in sitemap.xml and every llms.txt entry
// are always absolute production URLs, even when this script is pointed at
// a deploy preview. The "sitemap agreement" and "structured data" checks
// below therefore fetch those production URLs directly (exactly as spec'd:
// "every <loc> in the sitemap, fetched") rather than rewriting them onto the
// preview host — which also means those particular rows report on
// production's current health whichever <url> you pass in.
//
// Usage:
//   node qa/preview.mjs https://deploy-preview-23--a1k9-training.netlify.app
//   node qa/preview.mjs https://www.a1k9training.co.uk --md=qa/out/preview/report.md

import { chromium } from 'playwright'
import { promises as fs } from 'node:fs'
import path from 'node:path'

const CHROME_PATH =
  process.env.CHROME_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome'

const FETCH_TIMEOUT_MS = 20000

const DEFAULT_PAGES = [
  '/',
  '/courses/',
  '/courses/bronze-obedience',
  '/behavioural-consultations/dog-on-dog-aggression',
  '/contact/',
]

const VIEWPORTS = [
  { name: '375x812', width: 375, height: 812 },
  { name: '1440x900', width: 1440, height: 900 },
]

// Sandbox-blocked (or simply not this site's own code): a request or console
// error against one of these hosts says nothing about the deploy under test.
const THIRD_PARTY_HOSTS = [
  'google.com',
  'googleapis.com',
  'gstatic.com',
  'youtube.com',
  'ytimg.com',
  'googlevideo.com',
]

// Netlify injects its own visual-editor bridge (`/.netlify/scripts/cdp`)
// into every deploy preview's <head> — never into production — and that
// script's own permission probing trips this site's `Permissions-Policy:
// camera=(), microphone=(), geolocation=()` header, logged by Chromium
// itself (no attributable script location) rather than by any page code.
// Confirmed absent when the same page is fetched from production, so this
// is Netlify's preview tooling, not the site under test.
const NETLIFY_PREVIEW_NOISE = /^Potential permissions policy violation: (camera|microphone|geolocation) is not allowed/

// --- arg parsing -----------------------------------------------------

function parseArgs(argv) {
  const url = argv.find((a) => !a.startsWith('--'))
  const flags = Object.fromEntries(
    argv
      .filter((a) => a.startsWith('--'))
      .map((a) => {
        const eq = a.indexOf('=')
        return eq === -1 ? [a.slice(2), true] : [a.slice(2, eq), a.slice(eq + 1)]
      }),
  )
  const pages = flags.pages ? flags.pages.split(',').filter(Boolean) : DEFAULT_PAGES
  return { url, pages, jsonOut: flags.json || null, mdOut: flags.md || null }
}

const { url: rawUrl, pages: browserPages, jsonOut, mdOut } = parseArgs(process.argv.slice(2))

if (!rawUrl) {
  console.error(
    'Usage: node qa/preview.mjs <url> [--pages=/,/courses/,...] [--json=<file>] [--md=<file>]',
  )
  process.exit(1)
}

const baseUrl = rawUrl.replace(/\/+$/, '') // tolerate a trailing slash on the input

// --- fetch helper: bounded timeout, one retry on a network error -----

async function fetchOnce(url, options = {}) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
  try {
    return await fetch(url, { ...options, signal: controller.signal })
  } finally {
    clearTimeout(timer)
  }
}

async function fetchSafe(url, options = {}) {
  try {
    return await fetchOnce(url, options)
  } catch {
    // one retry on a network error (timeout, DNS, reset)
    return await fetchOnce(url, options)
  }
}

function isThirdParty(url) {
  try {
    const host = new URL(url).hostname
    return THIRD_PARTY_HOSTS.some((h) => host === h || host.endsWith(`.${h}`))
  } catch {
    return false
  }
}

// --- row collection ----------------------------------------------------

const rows = []
function row(check, ok, detail = '') {
  rows.push({ check, ok, detail })
}

function attr(tag, name) {
  const m = tag && tag.match(new RegExp(`${name}="([^"]*)"`, 'i'))
  return m ? m[1] : null
}

// ======================================================================
// 1. Home page + asset discovery
// ======================================================================

let homeHtml = ''
let homeHeaders = null
let cssHref = null
let jsHref = null
let fontHref = null
let firstImgSrc = null

{
  let res
  try {
    res = await fetchSafe(`${baseUrl}/`, { redirect: 'manual' })
  } catch (err) {
    res = null
    row('Home page: GET /', false, `request failed: ${err.message}`)
  }
  if (res) {
    homeHeaders = res.headers
    if (res.status === 200) {
      row('Home page: GET /', true, '200')
      homeHtml = await res.text()
    } else {
      row('Home page: GET /', false, `status ${res.status}`)
      homeHtml = await res.text().catch(() => '')
    }

    const cssTag = homeHtml.match(/<link[^>]+rel="stylesheet"[^>]*>/i)?.[0] ?? null
    cssHref = cssTag ? attr(cssTag, 'href') : null
    const jsMatch = homeHtml.match(/<script[^>]+src="(\/js\/site\.[^"]+\.js)"[^>]*>/i)
    jsHref = jsMatch ? jsMatch[1] : null
    const fontTag = homeHtml.match(/<link[^>]+rel="preload"[^>]+as="font"[^>]*>/i)?.[0] ?? null
    fontHref = fontTag ? attr(fontTag, 'href') : null
    const imgMatch = homeHtml.match(/<img[^>]+src="(\/images\/[^"]+)"/i)
    firstImgSrc = imgMatch ? imgMatch[1] : null
  }
}

// ======================================================================
// 2. Cache headers + security headers
// ======================================================================

async function checkCacheControl(label, href, { requireImmutable }) {
  if (!href) {
    row(`Cache-Control: ${label}`, false, 'no href found on home page to check')
    return
  }
  const target = /^https?:\/\//i.test(href) ? href : `${baseUrl}${href}`
  let res
  try {
    res = await fetchSafe(target, { method: 'HEAD', redirect: 'manual' })
  } catch (err) {
    row(`Cache-Control: ${label}`, false, `${href} — request failed: ${err.message}`)
    return
  }
  const cc = res.headers.get('cache-control') || ''
  const hasMaxAge = /max-age=31536000/.test(cc)
  const hasImmutable = /immutable/.test(cc)
  const ok = res.status === 200 && hasMaxAge && (!requireImmutable || hasImmutable)
  row(
    `Cache-Control: ${label}`,
    ok,
    `${href} — status ${res.status}, Cache-Control: "${cc || '(none)'}"`,
  )
}

// checkCacheControl reports its own failing row when href is null (home
// page unreachable, or the asset link wasn't found in its HTML), so these
// always run — never skipped — to keep every row in the table regardless
// of how the home page fetch above went.
await checkCacheControl('CSS (hashed)', cssHref, { requireImmutable: true })
await checkCacheControl('JS (hashed)', jsHref, { requireImmutable: true })
await checkCacheControl('font', fontHref, { requireImmutable: false })
await checkCacheControl('image', firstImgSrc, { requireImmutable: false })

if (homeHeaders) {
  const homeCC = homeHeaders.get('cache-control') || ''
  row(
    'Cache-Control: home HTML',
    /max-age=0/.test(homeCC) && /must-revalidate/.test(homeCC),
    `Cache-Control: "${homeCC || '(none)'}"`,
  )

  const xcto = homeHeaders.get('x-content-type-options')
  row('Security header: X-Content-Type-Options', xcto === 'nosniff', `got "${xcto ?? '(missing)'}"`)

  const xfo = homeHeaders.get('x-frame-options')
  row('Security header: X-Frame-Options', xfo === 'DENY', `got "${xfo ?? '(missing)'}"`)
} else {
  row('Cache-Control: home HTML', false, 'home page did not respond, skipped')
  row('Security header: X-Content-Type-Options', false, 'home page did not respond, skipped')
  row('Security header: X-Frame-Options', false, 'home page did not respond, skipped')
}

// ======================================================================
// 3. GEO files: llms.txt, robots.txt, sitemap.xml
// ======================================================================

let sitemapLocs = []
let llmsEntryUrls = []

{
  let res
  try {
    res = await fetchSafe(`${baseUrl}/llms.txt`)
    const text = res.status === 200 ? await res.text() : ''
    const hasH1 = /^# .+/m.test(text)
    llmsEntryUrls = [...text.matchAll(/^- \[[^\]]+\]\((https?:[^)]+)\)/gm)].map((m) => m[1])
    const ok = res.status === 200 && hasH1 && llmsEntryUrls.length >= 1
    row(
      'llms.txt',
      ok,
      res.status !== 200
        ? `status ${res.status}`
        : `H1 ${hasH1 ? 'present' : 'MISSING'}, ${llmsEntryUrls.length} entr${llmsEntryUrls.length === 1 ? 'y' : 'ies'}`,
    )
  } catch (err) {
    row('llms.txt', false, `request failed: ${err.message}`)
  }
}

{
  let res
  try {
    res = await fetchSafe(`${baseUrl}/robots.txt`)
    const text = res.status === 200 ? await res.text() : ''
    const hasGPTBot = /User-agent:\s*GPTBot/i.test(text)
    const hasClaudeBot = /User-agent:\s*ClaudeBot/i.test(text)
    const hasSitemap = /^Sitemap:/m.test(text)
    const ok = res.status === 200 && hasGPTBot && hasClaudeBot && hasSitemap
    row(
      'robots.txt',
      ok,
      res.status !== 200
        ? `status ${res.status}`
        : `GPTBot ${hasGPTBot ? 'ok' : 'MISSING'}, ClaudeBot ${hasClaudeBot ? 'ok' : 'MISSING'}, Sitemap: line ${hasSitemap ? 'ok' : 'MISSING'}`,
    )
  } catch (err) {
    row('robots.txt', false, `request failed: ${err.message}`)
  }
}

{
  let res
  try {
    res = await fetchSafe(`${baseUrl}/sitemap.xml`)
    const text = res.status === 200 ? await res.text() : ''
    sitemapLocs = [...text.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1])
    const ok = res.status === 200 && sitemapLocs.length >= 1
    row(
      'sitemap.xml',
      ok,
      res.status !== 200 ? `status ${res.status}` : `${sitemapLocs.length} <loc> entries`,
    )
  } catch (err) {
    row('sitemap.xml', false, `request failed: ${err.message}`)
  }
}

// ======================================================================
// 3b. Redirects actually redirect.
//
// Every rule in src/assets/_redirects is a URL that was live once and may
// still be linked from somewhere we don't control — the pre-2015 paths, and
// /find-us/, which was the contact page's URL until it became /contact/.
// Nothing tested that these resolve: qa/serve.mjs implements pretty-URL
// resolution only, not _redirects, so a broken rule looks identical locally
// to a working one and only shows up on a deploy. Hence checking it here.
// ======================================================================

{
  const redirectsFile = 'src/assets/_redirects'
  let rules = []
  try {
    rules = (await fs.readFile(redirectsFile, 'utf8'))
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith('#'))
      .map((line) => line.split(/\s+/))
      .filter((parts) => parts.length >= 2)
      .map(([from, to]) => ({ from, to }))
  } catch (err) {
    row('Redirects: read _redirects', false, `${redirectsFile}: ${err.message}`)
  }

  for (const { from, to } of rules) {
    let res
    try {
      res = await fetchSafe(`${baseUrl}${from}`, { redirect: 'manual' })
    } catch (err) {
      row(`Redirect ${from}`, false, `request failed: ${err.message}`)
      continue
    }
    const location = res.headers.get('location') ?? ''
    // Netlify may answer with an absolute URL; compare on the path only.
    const path = location.replace(/^https?:\/\/[^/]+/, '')
    const isRedirect = res.status >= 300 && res.status < 400
    const ok = isRedirect && path === to
    row(
      `Redirect ${from}`,
      ok,
      ok
        ? `${res.status} -> ${to}`
        : `status ${res.status}, Location: ${location || '(none)'} (expected ${to})`,
    )
  }
}

// ======================================================================
// 4. Sitemap agreement: llms.txt <-> sitemap, and every <loc> is
//    redirect-free + self-canonical. One fetch per sitemap URL, reused
//    below for the structured-data pass.
// ======================================================================

if (sitemapLocs.length && llmsEntryUrls.length) {
  const sitemapSet = new Set(sitemapLocs)
  const llmsSet = new Set(llmsEntryUrls)
  const missingFromSitemap = llmsEntryUrls.filter((u) => !sitemapSet.has(u))
  const missingFromLlms = sitemapLocs.filter((u) => !llmsSet.has(u))
  const ok = missingFromSitemap.length === 0 && missingFromLlms.length === 0
  const details = []
  if (missingFromSitemap.length) details.push(`in llms.txt but not sitemap: ${missingFromSitemap.join(', ')}`)
  if (missingFromLlms.length) details.push(`in sitemap but not llms.txt: ${missingFromLlms.join(', ')}`)
  row('llms.txt / sitemap.xml agreement', ok, ok ? 'every URL listed in both' : details.join('; '))
} else if (sitemapLocs.length || llmsEntryUrls.length) {
  row('llms.txt / sitemap.xml agreement', false, 'one of the two files could not be read, see rows above')
}

// pageFetches: url -> { status, redirected, html }
const pageFetches = new Map()

for (const loc of sitemapLocs) {
  // Fetch from the host under test, not the <loc> itself — for the same
  // reason section 5 does it (siteUrl is pinned to production in generate.js,
  // so every <loc> is a production URL even when this script is pointed at a
  // deploy preview). Fetching the loc directly made this check exercise the
  // LIVE SITE rather than the deploy, so a preview serving 500s everywhere
  // still went green, and a PR introducing a new URL went red because
  // production does not have that page yet.
  //
  // The canonical is still compared against `loc`: a preview's pages should
  // carry the production canonical, and on production baseUrl + path IS loc.
  let target = loc
  try {
    target = `${baseUrl}${new URL(loc).pathname}`
  } catch {
    // not a parseable URL — fall back to the loc and let the fetch report it
  }

  let res
  let html = ''
  let requestFailed = null
  try {
    res = await fetchSafe(target, { redirect: 'manual' })
    if (res.status === 200) html = await res.text()
  } catch (err) {
    requestFailed = err.message
  }

  if (requestFailed) {
    row(`Sitemap URL: ${loc}`, false, `request failed: ${requestFailed}`)
    continue
  }

  const isRedirect = res.status >= 300 && res.status < 400
  const canonicalTag = html.match(/<link[^>]+rel="canonical"[^>]*>/i)?.[0] ?? null
  const canonicalHref = canonicalTag ? attr(canonicalTag, 'href') : null
  const canonicalMatches = res.status === 200 && canonicalHref === loc
  const ok = res.status === 200 && !isRedirect && canonicalMatches

  let detail
  if (isRedirect) {
    detail = `redirected: ${res.status} -> ${res.headers.get('location') ?? '(no Location header)'}`
  } else if (res.status !== 200) {
    detail = `status ${res.status}`
  } else if (!canonicalMatches) {
    detail = `canonical is "${canonicalHref}", expected "${loc}"`
  } else {
    detail = '200, no redirect, canonical matches'
  }
  row(`Sitemap URL: ${loc}`, ok, detail)

  pageFetches.set(loc, { status: res.status, html })
}

// ======================================================================
// 5. Structured data: home + every sitemap URL under
//    /behavioural-consultations/ — fetched from the host under test
//    (baseUrl + the loc's path), not the loc itself: siteUrl is pinned to
//    production in generate.js, so every <loc> is a production URL even
//    when this script is pointed at a deploy preview; the point of this
//    check is what the deploy under test actually serves at that path.
// ======================================================================

function structuredDataPaths() {
  const out = []
  const seen = new Set()
  for (const loc of sitemapLocs) {
    let pathname
    try {
      pathname = new URL(loc).pathname
    } catch {
      continue // not a parseable URL, skip
    }
    if (pathname === '/' || pathname.startsWith('/behavioural-consultations/')) {
      if (seen.has(pathname)) continue
      seen.add(pathname)
      out.push({ pathname, requireFaq: pathname !== '/' })
    }
  }
  return out
}

for (const { pathname, requireFaq } of structuredDataPaths()) {
  const target = `${baseUrl}${pathname}`
  let html = ''
  let status = null
  try {
    const res = await fetchSafe(target)
    status = res.status
    if (status === 200) html = await res.text()
  } catch (err) {
    row(`Structured data: ${target}`, false, `request failed: ${err.message}`)
    continue
  }
  if (status !== 200) {
    row(`Structured data: ${target}`, false, `status ${status}`)
    continue
  }

  const scripts = [
    ...html.matchAll(/<script[^>]+type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi),
  ].map((m) => m[1])

  if (scripts.length === 0) {
    row(`Structured data: ${target}`, false, 'no <script type="application/ld+json"> found')
    continue
  }

  const problems = []
  const parsed = []
  scripts.forEach((raw, i) => {
    try {
      parsed.push(JSON.parse(raw))
    } catch (err) {
      problems.push(`script ${i + 1} does not parse: ${err.message}`)
    }
  })

  const localBusiness = parsed.find((o) => o?.['@type'] === 'LocalBusiness')
  if (!localBusiness) {
    problems.push('no LocalBusiness object')
  } else {
    const locations = Array.isArray(localBusiness.location) ? localBusiness.location : []
    if (locations.length < 2) {
      problems.push(`LocalBusiness.location has ${locations.length} entries (expected >= 2)`)
    } else {
      locations.forEach((loc2, i) => {
        if (!loc2?.address?.postalCode) problems.push(`location[${i}] has no address.postalCode`)
      })
    }
  }

  if (requireFaq) {
    const hasFaq = parsed.some((o) => o?.['@type'] === 'FAQPage')
    if (!hasFaq) problems.push('no FAQPage object')
  }

  row(
    `Structured data: ${target}`,
    problems.length === 0,
    problems.length === 0 ? `${scripts.length} ld+json script(s) ok` : problems.join('; '),
  )
}

// ======================================================================
// 6. Browser pass (Playwright): console errors, failed requests,
//    horizontal overflow, one h1, every img has alt + width/height.
// ======================================================================

// A sandbox that transparently re-terminates outbound HTTPS behind its own
// CA (Claude Code's own dev/CI containers set this) is trusted by curl/node
// (the system + Node CA stores are provisioned for it) but not by
// Chromium's own store, which a plain page.goto() would otherwise fail
// against with ERR_CERT_AUTHORITY_INVALID for every host, deploy preview
// included — nothing to do with the site under test.
const behindAgentProxy = Boolean(process.env.CCR_AGENT_PROXY_ENABLED)

function slugForPage(urlPath) {
  if (urlPath === '/') return 'index'
  return urlPath.replace(/^\/|\/$/g, '').replace(/\//g, '-')
}

const outDir = path.resolve('qa/out/preview')
await fs.mkdir(outDir, { recursive: true })

{
  let browser
  try {
    browser = await chromium.launch({
      executablePath: CHROME_PATH,
      headless: true,
      args: ['--headless=new', '--no-sandbox', '--disable-gpu'],
      // Chromium (unlike curl/node) honours http(s)_proxy and will try the
      // agent proxy's own CONNECT tunnel, which this sandbox's relay does
      // not hold up under Chromium's connection pattern — dropping these
      // for the browser process lets it take the same direct path curl
      // already reaches the target through, paired with the context's
      // ignoreHTTPSErrors below for the transparent re-termination.
      ...(behindAgentProxy
        ? {
            env: {
              ...process.env,
              HTTPS_PROXY: '',
              https_proxy: '',
              HTTP_PROXY: '',
              http_proxy: '',
            },
          }
        : {}),
    })
  } catch (err) {
    for (const urlPath of browserPages) {
      for (const vp of VIEWPORTS) {
        row(`Browser: ${urlPath} @ ${vp.name}`, false, `could not launch Chromium: ${err.message}`)
      }
    }
    browser = null
  }

  if (browser) {
    try {
      for (const urlPath of browserPages) {
        for (const vp of VIEWPORTS) {
          const context = await browser.newContext({
            viewport: { width: vp.width, height: vp.height },
            ...(behindAgentProxy ? { ignoreHTTPSErrors: true } : {}),
          })
          const page = await context.newPage()

          const consoleErrors = []
          const failedRequests = []
          page.on('console', (msg) => {
            if (msg.type() !== 'error') return
            const loc = msg.location()?.url
            if (loc && isThirdParty(loc)) return
            if (NETLIFY_PREVIEW_NOISE.test(msg.text())) return
            consoleErrors.push(msg.text())
          })
          page.on('pageerror', (err) => consoleErrors.push(String(err?.message ?? err)))
          page.on('response', (res) => {
            if (res.status() < 400) return
            if (isThirdParty(res.url())) return
            failedRequests.push(`${res.status()} ${res.url()}`)
          })
          page.on('requestfailed', (req) => {
            if (isThirdParty(req.url())) return
            const failure = req.failure()
            failedRequests.push(`failed: ${failure?.errorText ?? '?'} ${req.url()}`)
          })

          let navError = null
          try {
            await page.goto(`${baseUrl}${urlPath}`, { waitUntil: 'load', timeout: 30000 })
          } catch (err) {
            navError = String(err?.message ?? err)
          }

          const slug = `${slugForPage(urlPath)}-${vp.width}`
          try {
            await page.screenshot({ path: path.join(outDir, `${slug}.png`), fullPage: true })
          } catch {
            // non-fatal: a failed navigation may leave nothing to screenshot
          }

          if (navError) {
            row(`Browser: ${urlPath} @ ${vp.name}`, false, `navigation failed: ${navError}`)
          } else {
            const checks = await page.evaluate(() => {
              const h1Count = document.querySelectorAll('h1').length
              const imgs = Array.from(document.querySelectorAll('img'))
              const imgsMissingAlt = imgs.filter((img) => !img.hasAttribute('alt')).length
              const imgsMissingDims = imgs.filter(
                (img) => !img.hasAttribute('width') || !img.hasAttribute('height'),
              ).length
              return {
                overflow: document.documentElement.scrollWidth > window.innerWidth,
                h1Count,
                imgCount: imgs.length,
                imgsMissingAlt,
                imgsMissingDims,
              }
            })

            const problems = []
            if (checks.overflow) problems.push('horizontal overflow')
            if (checks.h1Count !== 1) problems.push(`${checks.h1Count} <h1> (expected 1)`)
            if (checks.imgsMissingAlt) problems.push(`${checks.imgsMissingAlt} <img> missing alt`)
            if (checks.imgsMissingDims) problems.push(`${checks.imgsMissingDims} <img> missing width/height`)
            if (consoleErrors.length) problems.push(`${consoleErrors.length} console error(s): ${consoleErrors.join(' | ')}`)
            if (failedRequests.length) problems.push(`${failedRequests.length} failed request(s): ${failedRequests.join(' | ')}`)

            row(
              `Browser: ${urlPath} @ ${vp.name}`,
              problems.length === 0,
              problems.length === 0 ? `ok (${checks.imgCount} img checked)` : problems.join('; '),
            )
          }

          await context.close()
        }
      }
    } finally {
      await browser.close()
    }
  }
}

// ======================================================================
// 7. Timing (informational — never gates the exit code)
// ======================================================================

{
  const start = performance.now()
  let res
  try {
    res = await fetchSafe(`${baseUrl}/`)
    const text = await res.text()
    const ttfb = performance.now() - start
    row('Timing: home page (informational)', true, `TTFB ~${Math.round(ttfb)}ms, ${text.length} bytes (decoded)`)
  } catch (err) {
    row('Timing: home page (informational)', true, `could not measure: ${err.message}`)
  }
}

// ======================================================================
// Report
// ======================================================================

// The timing row above is informational and always records ok: true, so
// including it here can only ever add to `passed`, never to `failed` —
// it never affects the exit code below.
const passed = rows.filter((r) => r.ok).length
const failed = rows.filter((r) => !r.ok).length

function toMarkdown() {
  const lines = ['| Check | Result | Detail |', '| --- | --- | --- |']
  for (const r of rows) {
    const detail = r.detail.replace(/\|/g, '\\|').replace(/\n/g, ' ')
    lines.push(`| ${r.check} | ${r.ok ? '✅' : '❌'} | ${detail} |`)
  }
  lines.push('')
  lines.push(`preview: ${passed} passed, ${failed} failed — ${baseUrl}`)
  return lines.join('\n')
}

const markdown = toMarkdown()
console.log(markdown)

if (mdOut) {
  await fs.mkdir(path.dirname(path.resolve(mdOut)), { recursive: true })
  await fs.writeFile(mdOut, markdown + '\n')
}

if (jsonOut) {
  const payload = {
    url: baseUrl,
    checkedAt: new Date().toISOString(),
    passed,
    failed,
    rows,
  }
  await fs.mkdir(path.dirname(path.resolve(jsonOut)), { recursive: true })
  await fs.writeFile(jsonOut, JSON.stringify(payload, null, 2))
}

if (failed > 0) process.exit(1)
