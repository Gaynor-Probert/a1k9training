#!/usr/bin/env node
// qa/lighthouse.mjs <siteDir> <label> [--pages=/,/courses/] [--runs=N]
//
// Runs Lighthouse (mobile form factor, simulated throttling — the library
// default) N times per page (default 3) and keeps the *median* run per
// metric. Writes a summary to qa/out/<label>/lighthouse.json (and, for
// label === 'baseline', a copy to qa/baseline/lighthouse.json).
//
// Metrics captured per page: performance score, LCP, CLS, TBT, speed index,
// total byte weight, and the single largest image request (url + bytes).

import lighthouse from 'lighthouse'
import * as chromeLauncher from 'chrome-launcher'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { serve } from './serve.mjs'
import { listPages } from './pages.mjs'

const CHROME_PATH =
  process.env.CHROME_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome'

function median(nums) {
  const sorted = [...nums].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 !== 0 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}

/**
 * Run Lighthouse once against `url`.
 * @param {string} url
 * @param {number} port chrome remote-debugging port
 */
async function runOnce(url, port) {
  const result = await lighthouse(
    url,
    { port, output: 'json', logLevel: 'silent' },
    undefined, // library default config: mobile form factor, simulated throttling
  )
  const lhr = result.lhr
  const audits = lhr.audits

  const networkRequests = audits['network-requests']?.details?.items ?? []
  let largestImage = null
  for (const item of networkRequests) {
    const isImage =
      item.resourceType === 'Image' || (item.mimeType ?? '').startsWith('image/')
    if (!isImage) continue
    const bytes = item.transferSize ?? item.resourceSize ?? 0
    if (!largestImage || bytes > largestImage.bytes) {
      largestImage = { url: item.url, bytes }
    }
  }

  return {
    performanceScore: (lhr.categories.performance?.score ?? 0) * 100,
    lcpMs: audits['largest-contentful-paint']?.numericValue ?? null,
    cls: audits['cumulative-layout-shift']?.numericValue ?? null,
    tbtMs: audits['total-blocking-time']?.numericValue ?? null,
    speedIndexMs: audits['speed-index']?.numericValue ?? null,
    totalByteWeight: audits['total-byte-weight']?.numericValue ?? null,
    largestImage,
  }
}

/**
 * Run Lighthouse `runs` times against `url` and return per-metric medians
 * plus the raw per-run results.
 */
async function runMedian(url, port, runs) {
  const results = []
  for (let i = 0; i < runs; i++) {
    // eslint-disable-next-line no-await-in-loop
    results.push(await runOnce(url, port))
  }
  const pick = (key) => median(results.map((r) => r[key]).filter((v) => v != null))
  // Largest image is stable across runs for a static site; take the one
  // reported by the run whose byte weight is closest to the median.
  const byteWeights = results.map((r) => r.totalByteWeight ?? 0)
  const medianByteWeight = median(byteWeights)
  const closestRunIndex = byteWeights.reduce(
    (best, w, i) =>
      Math.abs(w - medianByteWeight) < Math.abs(byteWeights[best] - medianByteWeight) ? i : best,
    0,
  )

  return {
    runs: results,
    median: {
      performanceScore: pick('performanceScore'),
      lcpMs: pick('lcpMs'),
      cls: pick('cls'),
      tbtMs: pick('tbtMs'),
      speedIndexMs: pick('speedIndexMs'),
      totalByteWeight: medianByteWeight,
      largestImage: results[closestRunIndex].largestImage,
    },
  }
}

/**
 * Run the full Lighthouse pass for a built site.
 * @param {string} siteDir
 * @param {string} label
 * @param {{ pages?: string[], runs?: number }} [options]
 */
export async function runLighthouse(siteDir, label, options = {}) {
  const runs = options.runs ?? 3
  const allPages = await listPages(siteDir)
  const pages = options.pages && options.pages.length ? options.pages : allPages

  const handle = await serve(siteDir, 0)
  const chrome = await chromeLauncher.launch({
    chromePath: CHROME_PATH,
    chromeFlags: ['--headless=new', '--no-sandbox', '--disable-gpu'],
  })

  const summary = { label, generated: new Date().toISOString(), runs, pages: {} }

  try {
    for (const urlPath of pages) {
      console.log(`[lighthouse] ${urlPath} (${runs} runs)`)
      // eslint-disable-next-line no-await-in-loop
      summary.pages[urlPath] = await runMedian(handle.url + urlPath, chrome.port, runs)
    }
  } finally {
    await chrome.kill()
    await handle.close()
  }

  const outDir = path.resolve('qa/out', label)
  await fs.mkdir(outDir, { recursive: true })
  const outFile = path.join(outDir, 'lighthouse.json')
  await fs.writeFile(outFile, JSON.stringify(summary, null, 2))
  console.log(`Wrote ${outFile}`)

  if (label === 'baseline') {
    const baselineDir = path.resolve('qa/baseline')
    await fs.mkdir(baselineDir, { recursive: true })
    await fs.copyFile(outFile, path.join(baselineDir, 'lighthouse.json'))
    console.log(`Copied to ${path.join(baselineDir, 'lighthouse.json')}`)
  }

  return summary
}

function parseArgs(argv) {
  const positional = []
  let pages = null
  let runs = 3
  for (const arg of argv) {
    if (arg.startsWith('--pages=')) {
      pages = arg
        .slice('--pages='.length)
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
    } else if (arg.startsWith('--runs=')) {
      runs = Number(arg.slice('--runs='.length))
    } else {
      positional.push(arg)
    }
  }
  return { positional, pages, runs }
}

const isMain = process.argv[1] === fileURLToPath(import.meta.url)
if (isMain) {
  const { positional, pages, runs } = parseArgs(process.argv.slice(2))
  const [siteDir, label] = positional
  if (!siteDir || !label) {
    console.error(
      'Usage: node qa/lighthouse.mjs <siteDir> <label> [--pages=/,/courses/] [--runs=N]',
    )
    process.exit(1)
  }
  await runLighthouse(siteDir, label, { pages, runs })
}
