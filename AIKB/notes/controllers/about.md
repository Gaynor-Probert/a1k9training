---
subject-hash: 6f0c19f075e4e0088c40e725d9b2d8da5a50e946
---

## What it does

Runs once per record in `src/models/about` for the About fan-out and returns `path: 'about'`, the record's `slug`, `title` and `description`, and the record as `model` for `src/pages/about.hbs`. That is all: the About pages have no FAQ block, so nothing is loaded.

## Why it is this way

`path` is set here rather than on the `.pages()` call so that the section's URL prefix lives beside the records it applies to. The section index is itself a record (`src/models/about/index.json`, slug `index`, the Philosophy page), which is why the fan-out produces `/about/` alongside its three siblings and why `/about-philosophy/` is that record's alias. Each record's `next` object (a `name` plus a page `id` such as `about/facilities`) drives the "Next:" button in the view through `{{link}}`, so the chain Philosophy, Facilities, Gaynor, Sara, Contact is data rather than markup.

## Gotchas

- A `person` object on a record (only `src/models/about/gaynor-probert.json` and `src/models/about/sara-thomas.json` carry one) switches on the Person JSON-LD in the view; Philosophy and Facilities deliberately have none.
- The whole fan-out shares one `sitemapPriority` (0.60) because the options object is shared; giving the index a higher one would have to happen here, per record.
