import 'colors'
import Kiss from 'kiss-ssg'

const args = process.argv.slice(2)

const d = new Date()
const year = d.getFullYear()

const kiss = new Kiss({
  dev: args.length > 0,
  verbose: true,
  folders: { build: './docs' },
  siteUrl: 'https://www.a1k9training.co.uk',
  // Every emitted .css/.js is renamed to carry a hash of its own bytes, so the
  // host can cache them for ever. Templates keep asking for the plain name via
  // the {{asset}} helper — see src/layouts/*.hbs.
  assets: { hash: true },
  year: year,
})

// Equality test for template conditionals — the hero uses it to place the
// caption: {{#if (eq model.caption "right")}}. Handlebars ships no such helper.
kiss.handlebars.registerHelper('eq', (a, b) => a === b)

// v2 renders .md partials with remarkable's `breaks: true`, so every hard-wrapped
// line in a markdown partial becomes a <br> — v1 used `breaks: false`. Keeping the
// v1 setting stops paragraphs in src/partials/**/*.md breaking mid-sentence at the
// source's wrap points. Partials are rendered at construction, so re-register after
// changing it. Delete both lines to adopt the v2 default.
kiss.remarkable.set({ breaks: false })
kiss.registerPartials()

kiss
  .page({
    view: 'index.hbs',
    title: 'Dog Behaviour and Trainer South Wales | A1K9 Training',
    description:
      'Gaynor Probert K9 Behaviour and Training - Improving relationships between dogs and their owners',
  })

  .page({
    view: 'behavioural-consultations/index.hbs',
    model: {
      image: '/images/consultations/consultations-v1.webp',
      caption: 'right',
    },
    title: 'Dog Behavioural Consultations in South Wales by Gaynor Probert',
  })
  .pages({
    view: 'behavioural-consultations/consultation.hbs',
    model: 'behavioural-consultations',
    controller: 'behavioural-consultations.js',
    path: 'behavioural-consultations',
  })

  .page({
    view: 'courses/index.hbs',
    model: {
      image: '/images/courses/classes-v1.1.webp',
      caption: 'left',
      faqs: '../models/faqs/courses.json',
    },
    controller: 'faqMapper.js',
    title: 'Dog Training Classes in South Wales with Gaynor Probert',
  })
  .pages({
    view: 'courses/course.hbs',
    model: 'courses',
    controller: 'course.js',
    path: 'courses',
  })

  .pages({
    view: 'about.hbs',
    model: 'about',
    controller: 'about.js',
  })

  .page({
    view: 'find-us.hbs',
    model: {
      image: '/images/about/horse-sit-v1.webp',
      caption: 'right',
      captionOffset: true,
    },
    title: 'Find A1K9 Training',
    path: 'find-us',
    slug: 'index',
  })

  .generate()

// v2 reports a page, controller or dev-server failure by rejecting complete().
// Without this catch a broken build still exits 0 and deploys a site with
// pages missing. complete()'s own callback never runs for a failed build, so
// 'Success' means the whole build was written.
kiss
  .complete(function () {
    console.log('Success'.rainbow)
    if (this.config.dev)
      console.log(`http://${this.config.devHost}:${this.config.port}`.yellow)
  })
  .catch((err) => {
    for (const failure of err.failures ?? [])
      console.error(
        `${failure.view} | ${failure.buildTo} | ${failure.error.message}`.red,
      )
    process.exitCode = 1
  })
