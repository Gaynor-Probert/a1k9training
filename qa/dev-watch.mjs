// Loop 1 gate: a template edit reaches the browser through kiss's dev server
// with Tailwind running as a config.assets.pipeline watch step.
// Usage: node qa/dev-watch.mjs   (from the repo root; nothing else on :3001)
import { spawn, execSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { chromium } from 'playwright'

const MARKER_FILE = 'src/partials/layout/footer.hbs'
const MARKER = ['mt-[', '13px]'].join('') // assembled so Tailwind never sees it in this file
const ORIGIN = 'http://127.0.0.1:3001'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const original = readFileSync(MARKER_FILE, 'utf8')
const dev = spawn('node', ['generate', 'dev'], { stdio: ['ignore', 'pipe', 'pipe'] })
let log = ''
dev.stdout.on('data', (d) => (log += d))
dev.stderr.on('data', (d) => (log += d))
const results = []
const check = (name, ok, detail = '') => results.push({ name, ok, detail })
try {
  let up = false
  for (let i = 0; i < 60 && !up; i++) {
    await sleep(1000)
    up = await fetch(ORIGIN + '/').then((r) => r.ok).catch(() => false)
  }
  check('dev server up on :3001', up)
  const cssOf = async () => {
    const html = await fetch(ORIGIN + '/').then((r) => r.text())
    const href = html.match(/href="(\/css\/site[^"]*\.css)"/)?.[1]
    return { href, css: href ? await fetch(ORIGIN + href).then((r) => r.text()) : '' }
  }
  const before = await cssOf()
  check('stylesheet served', !!before.href, before.href)
  check('marker absent before edit', !before.css.includes(MARKER.replace('[', '\\[').replace(']', '\\]')))
  check('tailwind watch spawned', /\[tailwind\]/.test(log))
  const browser = await chromium.launch()
  const page = await browser.newPage()
  await page.goto(ORIGIN + '/', { waitUntil: 'load' })
  const hadSpan = await page.locator('#qa-marker').count()
  writeFileSync(MARKER_FILE, original + `\n<span id="qa-marker" class="${MARKER}"></span>\n`)
  let cssOk = false, domOk = false, after = before
  for (let i = 0; i < 30 && !(cssOk && domOk); i++) {
    await sleep(1000)
    after = await cssOf()
    cssOk = after.css.includes(MARKER.replace('[', '\\[').replace(']', '\\]'))
    domOk = (await page.locator('#qa-marker').count()) === 1
  }
  check('compiled CSS gained the new utility (watch step)', cssOk, after.href)
  check('stylesheet name changed (hashed asset re-copied)', after.href !== before.href, `${before.href} -> ${after.href}`)
  check('browser reloaded and shows the edit (livereload)', hadSpan === 0 && domOk)
  const applied = domOk && (await page.locator('#qa-marker').evaluate((el) => getComputedStyle(el).marginTop))
  check('new utility is applied in the browser', applied === '13px', String(applied))
  await browser.close()
} finally {
  writeFileSync(MARKER_FILE, original)
  dev.kill('SIGINT')
  await new Promise((r) => dev.on('exit', r))
  await sleep(1500)
  let leftovers = ''
  try { leftovers = execSync("pgrep -af '[t]ailwindcss' || true").toString().trim() } catch {}
  check('no tailwind process left after close()', leftovers === '', leftovers)
}
for (const r of results) console.log(r.ok ? 'PASS' : 'FAIL', r.name, r.detail ? `(${r.detail})` : '')
const failed = results.filter((r) => !r.ok)
if (failed.length) { console.log('--- dev log tail ---\n' + log.slice(-3000)); process.exit(1) }
