---
name: pr-verify
description: Verify a pull request's Netlify deploy preview end to end — find the preview URL from the PR's commit status, wait for it to be ready, run qa/preview.mjs against it (real cache headers, redirect-free canonical URLs, llms.txt / robots / sitemap, structured data, a Playwright pass with screenshots), and record the result on the PR. Use after opening any PR on this repo, when asked to "verify the preview", "check the deploy preview", or before merging.
---

# PR Verify

`npm run qa` proves what `docs/` contains. It cannot prove what Netlify serves:
header precedence in `_headers`, pretty-URL resolution, whether a canonical
URL answers 200 or 301, whether the preview even built. Every PR on this
repo gets a **Netlify Deploy Preview**, posted as a commit status on the head
commit, and this skill closes the gap by testing that URL.

## When to use

- Right after opening a PR (the natural tail of the work).
- Before merging, if the PR head has moved since the last verification.
- When asked to verify or check a preview, or when the `Preview QA` GitHub
  Actions check is red and you need the detail locally.

## Steps

### 1 — Find the preview URL (never guess it)

The Netlify site slug is `a1k9-training`, with a hyphen; a guessed hostname
404s. Read it from the PR instead:

- **GitHub MCP:** `pull_request_read` with `method: get_status`. The status
  with context `netlify/a1k9-training/deploy-preview` has the URL in
  `target_url`; its `description` is `Deploy Preview ready!` when the build
  has finished, and `Deploy Preview pending` / `failed` otherwise.
- **`gh` CLI:** `gh pr view <n> --json statusCheckRollup` and read the same
  context, or `gh api repos/{owner}/{repo}/commits/<sha>/status`.

If the status is pending, wait (poll every 30 s, up to 10 minutes). A failed
status means the Netlify build broke: open the deploy log at the status URL,
fix the build locally (`npm run build`), push, and start again. Do not
verify a stale preview.

### 2 — Run the live checks

```bash
npm run qa:preview -- <preview-url> --md=qa/out/preview/report.md
```

`qa/preview.mjs` prints a pass/fail table and exits 1 on any failure. The
rows are: home 200; year-long immutable `Cache-Control` on the hashed CSS
and JS, a year on images and fonts, revalidate on HTML, the security
headers; `llms.txt`, `robots.txt` and `sitemap.xml` present and well
formed; every sitemap URL answers 200 with **no redirect** and its canonical
equals itself; `llms.txt` and the sitemap list the same URLs; LocalBusiness
JSON-LD carries both venues; FAQPage on the consultation pages; and a
Playwright pass at 375 and 1440 for console errors, failed requests,
horizontal overflow, one h1 and image attributes, with screenshots in
`qa/out/preview/`.

### 3 — Record the result on the PR

- All green: tick the post-deploy box in the PR's test plan and paste the
  table as a PR comment (or edit the PR body) so a reviewer sees the live
  evidence beside the diff. Keep it to the table and the summary line.
- Any red: fix at source (`src/assets/_headers`, `generate.js`, the
  template), push, and repeat from step 1. Never mark a PR verified with a
  red row; never edit `docs/` by hand.

### 4 — Production, after merge

The same script verifies production: `npm run qa:preview -- https://www.a1k9training.co.uk`.
Run it once the master deploy is live, because Netlify's header rules and
redirects apply per deploy and a merge is a new deploy.

## What this skill is not

- Not a substitute for `npm run qa`: run the local gates first, this after.
- Not Lighthouse. Scores come from `npm run qa:lh` against a local build,
  where the machine is the variable you control.
- Not a way to fix Netlify: it reports, you change the source and redeploy.

## Also automated

`.github/workflows/preview-qa.yml` runs the same script automatically when
Netlify reports a deploy preview as ready (the `deployment_status` event),
and reports as the `Preview QA` check on the PR. This skill is the manual,
detailed path; the workflow is the net that runs whether or not anyone
remembers.
