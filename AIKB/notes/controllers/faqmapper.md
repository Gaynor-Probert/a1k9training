---
subject-hash: 9f34e2fa9adf0d76eb66f601bb264c6f79483542
---

## What it does

The controller for the two section index pages, `/courses/` and `/behavioural-consultations/`. Their models are plain objects written inline in `generate.js` (hero image, caption side, and a `faqs` path); this loads the FAQ JSON named by that path, replaces the path with the array, and returns the model. Title and description come from the `.page()` options, not from here.

## Why it is this way

The index pages have no record folder. Each is one page with a handful of fields, so an inline object model is the lightest fit, and this small controller exists only to give them the same FAQ convention (`../models/faqs/<section>.json`, relative to the controller) as the fan-out pages. It is shared by both indexes because they are identical in this respect.

## Gotchas

- Unlike `course.js`, this one always requires `model.faqs`: an index page without the field would throw, which is deliberate, since both indexes carry an FAQ block and its JSON-LD.
- It mutates the inline object model in place. The kiss-ssg cheat sheet is explicit that a plain-object model is replayed from a shallow snapshot on every dev-server whole-site rebuild, so the mutated object would come back with `faqs` already an array and the second rebuild would hand `require` an array instead of a path. That has not been reproduced in this repository yet; the fix if it bites is to return a new object with the loaded `faqs` instead of assigning. Production builds are one pass and unaffected.
