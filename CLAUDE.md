# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

The site of Gaynor Probert, a dog behaviourist and trainer in South Wales
(`a1k9training.co.uk`). A static site built with
[kiss-ssg](https://www.npmjs.com/package/kiss-ssg) (Handlebars views +
Markdown partials, MVC-style: page → model → controller) and styled with
Tailwind CSS v4. It was migrated off Bootstrap 3 in place; `planning/` holds
the migration plan and session notes, and `qa/` exists specifically to gate
that migration against regressions (see below).

**kiss-ssg API reference:**

@node_modules/kiss-ssg/llms.txt

The file above is imported automatically into context on every session —
it's the package's own cheat sheet for `.page()`/`.pages()`/`.generate()`/
`.watch()`, config, and every built-in Handlebars helper. Consult it before
making non-trivial `generate.js` changes. Deeper per-topic notes live
alongside it in `node_modules/kiss-ssg/AIKB/`.

## Commands

```bash
npm run build            # production build: Tailwind compiles, then kiss-ssg generates docs/
npm run check             # dry-run the build via `kiss-ssg check`; prints a report, writes nothing
npm run dev                # kiss dev server with live reload; Tailwind keeps recompiling in the background
npm run images:optimise   # resize/convert a newly added source image to WebP (idempotent)
```

`npm run build` is the exact command Netlify runs on push; publish directory
is `docs/` (gitignored — never edit it by hand, it's emptied on every
build). Tailwind is not a separate build step: `generate.js` declares it as
a kiss asset-pipeline step (`config.assets.pipeline`), so it runs before
kiss copies/hashes assets, under `build`, `check` and `dev` alike. Edit
`src/styles/site.css`; never `src/assets/css/site.css` (generated,
gitignored).

There is no lint or test script configured (`.eslintrc.cjs`/`.prettierrc`
exist but `eslint` itself isn't a dependency and no `npm run lint` exists).
Correctness is verified by building (`npm run build`), serving `docs/`
(`npm run qa:serve -- docs <port>`), and checking the rendered page —
plus the QA harness below for anything beyond a one-off visual check.

### QA harness (`qa/`)

Playwright + Lighthouse + axe-core, driven by plain Node ESM scripts — full
detail in `qa/README.md`. Everything here inspects an **already-built**
directory (`docs/`, or `qa/.baseline-site`, a frozen build of the last merged master); the
harness itself never builds the site.

```bash
npm run qa                # build, then every gate: page count, no-Bootstrap, SEO, snapshot, compare, axe
npm run qa:lh              # Lighthouse mobile, median of 3 runs per page (slow)
npm run qa:serve -- docs 8123   # serve a built dir locally with Netlify's pretty-URL rules
npm run qa:preview -- <url>     # verify a DEPLOYED site: real headers, redirect-free URLs, llms.txt, schema, Playwright
```

After opening a PR, run `/pr-verify` (`.claude/skills/pr-verify/SKILL.md`): it
finds the Netlify deploy-preview URL on the PR's commit status and runs
`qa:preview` against it. `.github/workflows/preview-qa.yml` does the same
automatically as the `Preview QA` check.

- `qa/snapshot.mjs` + `qa/compare.mjs` gate against `qa/baseline/content.json`
  (a snapshot of the last merged master build; refresh it by building master
  into `qa/.baseline-site` and running `npm run qa:baseline` whenever copy
  changes land on master) on: lost text, lost internal links, form-field
  diffs, console errors, failed requests, horizontal overflow at 375px.
  `qa/baseline/pre-migration/` keeps the original Bootstrap-site records.
- `qa/no-bootstrap.mjs` fails if any Bootstrap 3 class/idiom shows up in the
  built output — the guard against regressing the migration.
- `qa/axe.mjs` scans every page at 375/1440px; group violations by impact.
  It does **not** catch non-text contrast (e.g. a `:focus-visible` ring) —
  that needs a manual WCAG ratio check against the actual token values in
  `@theme`.
- All of the above expect a Chromium executable; on Windows, Playwright's
  own downloaded browser needs to be pointed at explicitly, e.g.
  `CHROME_PATH=".../ms-playwright/chromium-<rev>/chrome-win64/chrome.exe"`
  (the scripts default to a Linux CI path).

## Architecture

### Page pipeline: `generate.js` → model → controller → view

Every route is registered in `generate.js` via kiss-ssg's `.page()` (one
page) or `.pages()` (fan out one page per item in an array/folder model).
For a fan-out page, e.g. `/courses/*`:

```
generate.js:  .pages({ view: 'courses/course.hbs', model: 'courses', controller: 'course.js', path: 'courses' })
src/models/courses/bronze-obedience.json   → data for one page (slug, title, description, image, components: {...})
src/controllers/course.js                    → reshapes the model into { slug, title, description, model }
src/pages/courses/course.hbs                → the Handlebars view, extends a layout, renders model.components.*
```

A model's `components` object is a map of names → partial paths (e.g.
`"intro": "courses/bronze/intro"`), resolved by the view via
`{{> (lookup model.components 'intro')}}`. Controllers should return new
values rather than mutate the model in place — an object-model mutation
persists across dev-server rebuilds (see the imported cheat sheet for why).

`src/controllers/faqMapper.js`/`metaMapper.js` are small reusable
controllers; `about.js`/`course.js`/`behavioural-consultations.js` are
per-section.

### Templates: layouts, pages, partials

- `src/layouts/layout.hbs` — the general-purpose layout: a model-driven
  photo hero (`model.image`, `model.caption` left/right, optional
  `model.captionOffset`) with a `{{#block "intro"}}` caption box, then
  `{{#block "main"}}`.
- `src/layouts/layout-video.hbs` — home page only: the same hero shape but
  with a muted, lazy-loaded YouTube background (`data-video-id`, driven by
  `src/assets/js/site.js`).
- Both layouts style every element inside the hero caption box with
  arbitrary-variant selectors, e.g. `[&_p]:mb-6`, `[&_a:not(.btn)]:text-accent-300`.
  **A descendant selector like `[&_a]:...` beats a single class like
  `.btn-secondary` on specificity** — any `.btn` placed inside hero content
  needs the `:not(.btn)` exclusion already applied to `a`/similar rules, or
  it silently inherits the wrong color/underline. This has bitten real
  pages before; check for it when adding markup inside a hero block.
- `src/pages/*.hbs` extend a layout (`{{#extend "layout"}}`) and fill its
  named blocks (`{{#content "intro"}}` / `{{#content "main"}}`).
- `src/partials/` holds `.md` and `.hbs`/`.html` fragments referenced by
  model `components` maps or included directly; `layout/` inside it holds
  the shell (navbar, footer, header `<head>` partial with SEO/JSON-LD).
- Tailwind's preflight zeroes all margins, including `<p>`. A paragraph
  followed by another block (a CTA button, a card) needs an explicit margin
  utility (this repo's convention: `mb-6` on the paragraph, or `mt-8` on the
  wrapper that follows) — nothing restores it by default.

### Design system (`src/styles/site.css`)

Tailwind v4 entry point; explicit `@source` globs list only real template
locations (excludes `src/assets` and `qa/`, which would otherwise get
scanned for class names). Design tokens live in `@theme`: a green `brand`
ramp, a warm `sand` ground, a dark-slate `ink` text ramp, and an `accent`
amber reserved for calls to action — every text/background pairing in the
shell is WCAG AA. `:focus-visible` uses a two-layer ring (amber `outline` +
a dark `box-shadow` ring just outside it) specifically so the indicator
clears 3:1 contrast on both the site's light surfaces (white cards) and
dark ones (nav, hero) with one rule — see the comment above it before
changing either color.

`@layer components` holds a deliberately small set of classes —
`.btn`/`.btn-primary`/`.btn-secondary`/`.btn-accent`/`.btn-sm`/`.btn-lg`,
`.card`, `.callout`, `.page-header`, `.figure-left`/`.figure-right`,
`.badge`, `.prose-site` — for the Markdown and raw-HTML partials, which
can't carry a dozen utilities per element. Templates should reach for plain
Tailwind utilities everywhere else. `.prose-site` re-tunes the typography
plugin's default palette to the site's `ink`/`brand` tokens.

### Assets and caching

`src/assets/` is copied verbatim into `docs/` (images, fonts, `js/`,
generated `css/`). `assets: { hash: true }` in `generate.js` renames every
emitted `.css`/`.js` with a content hash; templates always reference the
unhashed name through kiss's `{{asset}}` helper
(`href="/{{asset "css/site.css"}}"`) and the manifest resolves it.
`src/assets/_headers` sets long-lived immutable caching for hashed CSS/JS, a
year for images/fonts, and security headers; `src/assets/_redirects` keeps
pre-2015 URLs alive.

**Cache busting is by URL, never by header.** CSS and JS bust themselves:
kiss renames them with a content hash on every change, so a changed file is
a new URL. Images and fonts are **not** hashed and are cached for a year, so
a browser that has one will not ask again until it expires — **never
overwrite an image or font in place.** Change the file, bump its version
suffix (`hero-v1.webp` → `hero-v2.webp`, the convention every image already
follows), and update the references; the old file can stay or go. The same
applies to the self-hosted font (`buenard-700-v1.woff2`).

**Adding an image:** drop the original into `src/assets/images/...`, run
`npm run images:optimise`, then reference the `.webp` it writes with the
`width`/`height` it records in `qa/images.json`.

### Deploy

Netlify builds on push (`npm run build`, publish dir `docs/`); it must
install devDependencies (Tailwind's CLI is one) on Node ≥ 22.12.
`kiss-ssg` is on the published `^2.1.0` release, which carries the
asset-pipeline hook, the trailing-slash canonical fix and `.llms()` (the
generated `llms.txt`) this project depends on.
