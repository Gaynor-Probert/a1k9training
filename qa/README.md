# QA harness

Playwright + Lighthouse + axe-core QA harness for the a1k9training rebuild
(see `planning/2026-09-07-tailwind-migration-plan.md`, "Loop 0"). Everything
here is plain Node ESM (`.mjs`), driven by npm scripts. Nothing in `qa/`
builds the site — every script takes a **directory of already-built HTML**
(a `docs/` build, or the frozen `qa/.baseline-site`) and serves/inspects it.

## Layout

```
qa/
  serve.mjs          static server, Netlify pretty-URL emulation
  pages.mjs          derives the page list from a built site dir
  snapshot.mjs        screenshots + content records
  lighthouse.mjs      mobile Lighthouse, median of N runs
  axe.mjs              axe-core accessibility scan
  compare.mjs          content.json vs baseline, pass/fail gate
  no-bootstrap.mjs     Bootstrap 3 class/asset grep, pass/fail gate
  .baseline-site/     (gitignored) frozen copy of the pre-migration Bootstrap build
  baseline/           committed JSON baselines (content.json, lighthouse.json, axe.json)
  out/<label>/        (gitignored) per-run output: screenshots + JSON
```

## Scripts

### `qa/serve.mjs <dir> [port]`

Dependency-free static file server. Emulates Netlify's pretty-URL
resolution so served paths match how the site behaves once deployed:

- `/` → `index.html`
- `/foo` → `foo.html`, else `foo/index.html`, else 404
- `/foo/` → `foo/index.html`, else 404
- `/foo.ext` → served literally (no fallback)

Correct `Content-Type` for html/css/js/json/xml/svg/png/jpg/gif/webp/avif/
ico/woff/woff2/ttf/otf/eot/pdf/map/webmanifest. Exports `serve(dir, port)` →
`{ server, port, url, close() }`, and doubles as a CLI:

```
npm run qa:serve -- qa/.baseline-site 8080
```

### `qa/pages.mjs <siteDir> [--assert=N]`

Walks a built site dir and derives the Netlify-pretty page-path list from
its `*.html` files (`index.html` → `/`, `dir/index.html` → `/dir/`, else
`/dir/name`). Exports `listPages(siteDir)`. The baseline has 18 pages:

```
node qa/pages.mjs qa/.baseline-site --assert=18
```

### `qa/snapshot.mjs <siteDir> <label>`

Serves `siteDir`, visits every page at 375×812 (mobile emulated,
`deviceScaleFactor: 2`), 768×1024 and 1440×900, and:

- writes a full-page screenshot to `qa/out/<label>/<viewport>/<page-slug>.png`
- extracts one **content record** per page (captured at 375×812, since
  that's also where the horizontal-overflow check runs): title, meta
  description, canonical href, `lang`, `h1` list, ordered headings
  (`{tag, text}`, whitespace-normalised), visible body text
  (`document.body.innerText`, normalised), internal link hrefs in document
  order, images (`src`, `alt`, natural/rendered width, `loading`, whether
  both `width`/`height` attrs are present), forms (name, `data-netlify`,
  and each field's name/type/required), console errors, failed requests
  (status ≥ 400), total transferred bytes (overall and per resource type,
  from Playwright's `request.sizes()`), and whether
  `document.documentElement.scrollWidth > innerWidth` at 375 wide.

  **Console errors and failed requests are split same-origin vs
  third-party** (`consoleErrors`/`failedRequests` vs
  `thirdPartyConsoleErrors`/`thirdPartyFailedRequests`). Only the
  same-origin ones gate `compare.mjs` — a network-sandboxed CI/QA box
  cannot reach Google Analytics, the Google Fonts CDN, YouTube's API or the
  Google Maps embed, and those failures say nothing about the site's own
  code. Third-party failures are still recorded, just not gated on.

Writes `qa/out/<label>/content.json`; for `label === baseline`, also copies
to `qa/baseline/content.json`.

```
npm run qa:snapshot -- qa/.baseline-site baseline
```

### `qa/lighthouse.mjs <siteDir> <label> [--pages=/,/courses/] [--runs=N]`

Runs Lighthouse against every page (library default config: mobile form
factor, simulated throttling — the same "mobile, simulated" profile the
spec asks for), `--runs` times per page (default 3), and keeps the
**median** of each metric: performance score, LCP, CLS, TBT, speed index,
total byte weight, and the single largest image request (url + bytes, from
the run closest to the median byte weight). Uses `chrome-launcher` against
`CHROME_PATH` (defaults to the pre-installed
`/opt/pw-browsers/chromium-1194/chrome-linux/chrome`).

Writes `qa/out/<label>/lighthouse.json` (baseline copy as above). Use
`--pages` and `--runs` to keep iteration cheap while developing:

```
npm run qa:lh -- qa/.baseline-site baseline
npm run qa:lh -- docs dev --pages=/,/courses/ --runs=1
```

### `qa/axe.mjs <siteDir> <label>`

Runs an axe-core scan (`@axe-core/playwright`) on every page at 375 and
1440 wide, groups violations by impact (`critical`/`serious`/`moderate`/
`minor`), and writes `qa/out/<label>/axe.json` (baseline copy as above).

```
npm run qa:axe -- qa/.baseline-site baseline
```

### `qa/compare.mjs <label>`

Compares `qa/out/<label>/content.json` against `qa/baseline/content.json`
and prints a compact per-page table, then writes the full diff to
`qa/out/<label>/compare.json`. Per page it reports: missing/extra pages,
title change, heading-sequence diff, visible-text similarity (token-set
Jaccard, 0–1) plus the list of baseline sentences no longer found verbatim
in the current text, internal-link add/remove, images missing `alt` or
width/height attrs, form field differences, console errors, failed
requests, and the horizontal-overflow flag.

**Exit code 1** when any page has: a missing text sentence longer than 40
characters, a lost internal link, a form field difference, console errors,
failed requests, or horizontal overflow at 375.

```
node qa/compare.mjs baseline   # self-comparison, should be clean
npm run qa:compare -- dev
```

### `qa/no-bootstrap.mjs <siteDir>`

Greps every built `.html`/`.css` file for Bootstrap 3 idioms — `col-xs-`,
`img-responsive`, `pull-right`, `pull-left`, `hidden-xs`, `glyphicon`,
`panel`, `thumbnail`, `navbar-`, `btn-default`, `form-group`,
`form-inline`, `page-header`, `caret`, `data-toggle`, `bootstrap`,
`jquery` — and prints `file:line` matches. Exits 1 if any are found (the
baseline is expected to fail this; a migrated build should pass it).

```
npm run qa:no-bootstrap -- qa/.baseline-site   # expected to exit 1
npm run qa:no-bootstrap -- docs                # should exit 0 post-migration
```

## npm scripts

| Script | What it runs |
|---|---|
| `qa:serve` | `node qa/serve.mjs` — pass `-- <dir> <port>` |
| `qa:snapshot` | `node qa/snapshot.mjs` — pass `-- <siteDir> <label>` |
| `qa:lh` | `node qa/lighthouse.mjs` — pass `-- <siteDir> <label> [--pages=...] [--runs=N]` |
| `qa:axe` | `node qa/axe.mjs` — pass `-- <siteDir> <label>` |
| `qa:compare` | `node qa/compare.mjs` — pass `-- <label>` |
| `qa:no-bootstrap` | `node qa/no-bootstrap.mjs` — pass `-- <siteDir>` |
| `qa:baseline` | snapshot + lighthouse + axe against `qa/.baseline-site`, label `baseline` |

## Running a QA pass on a new build

```bash
npm run build                                   # produces docs/
node qa/pages.mjs docs --assert=18              # sanity check the page count
npm run qa:snapshot -- docs dev
npm run qa:lh -- docs dev
npm run qa:axe -- docs dev
node qa/compare.mjs dev                         # gates on regressions vs baseline
node qa/no-bootstrap.mjs docs                   # gates on leftover Bootstrap 3
```

## Known limitations

- `network-requests`/`request.sizes()`-based byte totals reflect what
  Chromium actually transferred in that run (cache-cold, since each
  snapshot page gets a fresh Playwright context); they will not exactly
  match a browser devtools "size" column that accounts for compression
  differently in every case, but they are consistent run-to-run for
  before/after comparison.
- `compare.mjs`'s text similarity is a token-set Jaccard score, not a full
  diff — it is a fast regression smell test, not a proofreading tool.
  Sentence matching for the "missing sentence" list is exact-substring
  after whitespace normalisation, so a sentence that merely gets
  re-punctuated (e.g. an em dash swapped for a comma) will show as
  "missing" even though the meaning is unchanged.
- `no-bootstrap.mjs` matches patterns as substrings of each line, so on a
  minified single-line HTML file (the case for this project's current
  Handlebars/kiss-ssg output) every match is reported against the same
  line number; it's still accurate for pass/fail gating, just not useful
  for pinpointing an exact line in minified output.
- Lighthouse is asked for a mobile, simulated-throttling run (the
  library's default config), which is far less noisy in a container than
  real network throttling, but still varies a few points run-to-run —
  hence the median-of-3 default. Bump `--runs` for a steadier number when
  it matters more than speed.
- `axe.mjs` scans two widths (375, 1440) per page, not the same three
  viewports `snapshot.mjs` screenshots — deliberate, to keep the accessibility
  pass around 2× rather than 3× the page count.
