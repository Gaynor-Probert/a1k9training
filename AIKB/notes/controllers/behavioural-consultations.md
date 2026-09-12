---
subject-hash: 11f8b7629362a8a382d91c9bc8ba7f80df59aff0
---

## What it does

Runs once per record in `src/models/behavioural-consultations` for the `/behavioural-consultations/*` fan-out in `generate.js`: loads the record's optional `faqs` file into its `faqs` array and returns `slug`, `title`, `description` and the record as `model` for `src/pages/behavioural-consultations/consultation.hbs`.

## Why it is this way

A line-for-line copy of `src/controllers/course.js`. The two sections have the same record shape and the same FAQ convention (a path relative to the controller, resolved with `createRequire`). It was kept as a separate file rather than shared so that each section's controller can diverge without touching the other; so far neither has.

## Gotchas

- Same in-place `model.faqs` mutation as `course.js`; see that note.
- Both consultation records carry a pre-2015 `aliases` entry (`/behavioural-consultations-dog-on-dog-aggression/` and its sibling). kiss promotes `aliases` from the record itself, not from what this controller returns, so the controller does not pass it through and does not need to.
