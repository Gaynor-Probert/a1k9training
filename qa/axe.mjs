#!/usr/bin/env node
// qa/axe.mjs <siteDir> <label>
//
// Runs an axe-core accessibility scan (via @axe-core/playwright) against
// every page at 375 and 1440 wide. Violations are grouped by impact
// (critical/serious/moderate/minor). Writes qa/out/<label>/axe.json (and,
// for label === 'baseline', a copy to qa/baseline/axe.json).

import { chromium } from 'playwright'
import AxeBuilder from '@axe-core/playwright'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { serve } from './serve.mjs'
import { listPages } from './pages.mjs'

const CHROME_PATH =
  process.env.CHROME_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome'

const WIDTHS = [375, 1440]
const IMPACTS = ['critical', 'serious', 'moderate', 'minor']

function groupByImpact(violations) {
  const groups = { critical: [], serious: [], moderate: [], minor: [] }
  for (const v of violations) {
    const impact = IMPACTS.includes(v.impact) ? v.impact : 'minor'
    groups[impact].push({
      id: v.id,
      description: v.description,
      help: v.help,
      helpUrl: v.helpUrl,
      nodes: v.nodes.map((n) => ({
        target: n.target,
        html: n.html,
        failureSummary: n.failureSummary,
      })),
    })
  }
  return groups
}

function countsOf(groups) {
  return Object.fromEntries(IMPACTS.map((impact) => [impact, groups[impact].length]))
}

/**
 * Run the full axe pass for a built site.
 * @param {string} siteDir
 * @param {string} label
 */
export async function runAxe(siteDir, label) {
  const pages = await listPages(siteDir)
  const handle = await serve(siteDir, 0)
  const browser = await chromium.launch({
    executablePath: CHROME_PATH,
    headless: true,
    args: ['--headless=new', '--no-sandbox', '--disable-gpu'],
  })

  const summary = { label, generated: new Date().toISOString(), pages: {} }

  try {
    for (const urlPath of pages) {
      summary.pages[urlPath] = {}
      for (const width of WIDTHS) {
        console.log(`[axe] ${urlPath} @ ${width}`)
        const context = await browser.newContext({ viewport: { width, height: 900 } })
        const page = await context.newPage()
        // eslint-disable-next-line no-await-in-loop
        await page.goto(handle.url + urlPath, { waitUntil: 'networkidle', timeout: 30000 })
        // eslint-disable-next-line no-await-in-loop
        const results = await new AxeBuilder({ page }).analyze()
        const groups = groupByImpact(results.violations)
        summary.pages[urlPath][width] = {
          counts: countsOf(groups),
          violations: groups,
        }
        // eslint-disable-next-line no-await-in-loop
        await context.close()
      }
    }
  } finally {
    await browser.close()
    await handle.close()
  }

  const outDir = path.resolve('qa/out', label)
  await fs.mkdir(outDir, { recursive: true })
  const outFile = path.join(outDir, 'axe.json')
  await fs.writeFile(outFile, JSON.stringify(summary, null, 2))
  console.log(`Wrote ${outFile}`)

  if (label === 'baseline') {
    const baselineDir = path.resolve('qa/baseline')
    await fs.mkdir(baselineDir, { recursive: true })
    await fs.copyFile(outFile, path.join(baselineDir, 'axe.json'))
    console.log(`Copied to ${path.join(baselineDir, 'axe.json')}`)
  }

  return summary
}

const isMain = process.argv[1] === fileURLToPath(import.meta.url)
if (isMain) {
  const [siteDir, label] = process.argv.slice(2)
  if (!siteDir || !label) {
    console.error('Usage: node qa/axe.mjs <siteDir> <label>')
    process.exit(1)
  }
  await runAxe(siteDir, label)
}
