---
subject-hash: 877201383d605184398e1913c4137ea16fb74ad3
---

## What it does

Runs once per record in `src/models/courses` for the `/courses/*` fan-out registered in `generate.js`. If the record names a `faqs` file it loads that JSON and swaps the path for its `faqs` array, then returns `slug`, `title` and `description` for the page and the whole record as `model` for `src/pages/courses/course.hbs`. Nothing else is derived here: the course ladder, the breadcrumb and `aliases` are read straight off the record by helpers in `generate.js` and by kiss itself.

## Why it is this way

The `faqs` path in a record is written relative to this file (`../models/faqs/gold.json`), a v1 convention kept through the v2 migration; `createRequire(import.meta.url)` is what lets an ESM controller resolve it from here. Only the courses with an FAQ block carry the field, so the load is conditional. The controller stays a thin pass-through so that a course is described entirely by its own record file: adding or reordering one means editing that file and nothing else.

## Gotchas

- It mutates `model.faqs` in place rather than returning a new value. The kiss-ssg cheat sheet says an in-place mutation of a folder model is contained to one build, so this is safe under `npm run build`, but the same pattern on a plain-object model (see `AIKB/notes/controllers/faqmapper.md`) is not.
- `src/controllers/behavioural-consultations.js` is a copy of this file; change both or neither.
- The FAQ JSON's shape is `{ "faqs": [{ "q", "a" }] }`; `src/partials/faqs.hbs` and the `faqPage` JSON-LD helper both assume it.
