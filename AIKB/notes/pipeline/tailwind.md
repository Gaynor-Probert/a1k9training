---
subject-hash: 56a316d5e0cbd20c0f34670fc23a9e6966bc2624
---

## What it does

Compiles `src/styles/site.css` (the Tailwind v4 entry point: design tokens and the small `@layer components` set) into a minified stylesheet under the assets folder, as a kiss asset-pipeline step declared in `generate.js`. Because it is a pipeline step it runs before the asset copy under `npm run build`, `npm run check` and `npm run dev` alike, and kiss then copies and content-hashes the output like any other asset; templates ask for it as `{{asset "css/site.css"}}`. In dev mode the `watch` command keeps it recompiling as templates change.

## Why it is this way

Tailwind used to be a separate npm script chained ahead of kiss, which meant a check or a dev server could run against a stale stylesheet. Declaring it as a pipeline step ties the compile to every kind of build. The `@source` globs in the entry file list only real template locations so that the QA harness and the assets folder are never scanned for class names. `--minify` is on for every mode because the hash is of the emitted bytes and a dev/prod difference would be a different URL for nothing.

## Gotchas

- The compiled file is gitignored and generated; edit `src/styles/site.css`, never the output.
- `--watch=always` (not plain `--watch`) is required in the `watch` command: kiss gives the process no stdin, and Tailwind exits at once when stdin closes.
- A `kiss-ssg check` is therefore not read-only over the working tree. It rewrites the compiled stylesheet, which is one more reason that file is gitignored.
- The `:focus-visible` two-layer ring in the entry file is tuned to pass 3:1 on both light and dark surfaces; `qa/axe.mjs` does not catch non-text contrast, so a token change there needs a manual ratio check.
