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
  assets: {
    hash: true,
    // Tailwind runs as a kiss asset pipeline step: `run` compiles the
    // stylesheet into src/assets/css before the asset copy (production and
    // `kiss-ssg check` alike), and in dev mode `watch` keeps it compiling as
    // templates change. Output is gitignored; kiss copies and hashes it.
    pipeline: [
      {
        name: 'tailwind',
        run: 'npx @tailwindcss/cli -i src/styles/site.css -o src/assets/css/site.css --minify',
        watch:
          'npx @tailwindcss/cli -i src/styles/site.css -o src/assets/css/site.css --minify --watch=always',
      },
    ],
  },
  year: year,
})

// Equality test for template conditionals — the hero uses it to place the
// caption: {{#if (eq model.caption "right")}}. Handlebars ships no such helper.
kiss.handlebars.registerHelper('eq', (a, b) => a === b)

// The page's hero image, for og:image and the LocalBusiness JSON-LD in
// src/partials/layout/header.hbs. Every inner page's model carries its own
// `image` (see the *.json under src/models/); the one page that doesn't is
// the home page, which renders through layout-video.hbs with its hero image
// hardcoded there rather than in a model — so that same path is the fallback
// here, kept in sync with layout-video.hbs by hand.
const HOME_HERO_IMAGE = '/images/gaynor-probert-home-v1.1.webp'
kiss.handlebars.registerHelper(
  'heroImage',
  (model) => (model && model.image) || HOME_HERO_IMAGE,
)

// LocalBusiness JSON-LD (src/partials/layout/header.hbs, every page). Built
// as a helper rather than hand-typed JSON in the template so title/description
// text and image paths go through JSON.stringify's own escaping instead of
// Handlebars'. Only fields this repo actually sources are included — no
// street address or opening hours live anywhere in it, so none are invented
// here. The Facebook link comes from src/pages/index.hbs's "Open Page »" card
// (tracking query string dropped); the phone number is the site's tel: link.
kiss.handlebars.registerHelper('localBusiness', function (model) {
  const siteUrl = kiss.config.siteUrl
  const image = (model && model.image) || HOME_HERO_IMAGE
  return {
    '@context': 'https://schema.org',
    '@type': 'LocalBusiness',
    name: 'A1K9 Behaviour and Training Academy',
    alternateName: 'Gaynor Probert Dog Behaviour and Training',
    url: `${siteUrl}/`,
    telephone: '+447798500390',
    areaServed: 'South Wales',
    image: `${siteUrl}${image}`,
    sameAs: ['https://www.facebook.com/A1K9PDT'],
  }
})

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
    sitemapPriority: '1.00',
    sitemapChangefreq: 'monthly',
  })

  .page({
    view: 'behavioural-consultations/index.hbs',
    model: {
      image: '/images/consultations/consultations-v1.webp',
      caption: 'right',
    },
    title: 'Dog Behavioural Consultations in South Wales by Gaynor Probert',
    description:
      'Professional behavioural consultations for dog aggression in South Wales. Expert help from Gaynor Probert to rehabilitate your dog.',
    sitemapPriority: '0.80',
    sitemapChangefreq: 'monthly',
  })
  .pages({
    view: 'behavioural-consultations/consultation.hbs',
    model: 'behavioural-consultations',
    controller: 'behavioural-consultations.js',
    path: 'behavioural-consultations',
    sitemapPriority: '0.60',
    sitemapChangefreq: 'monthly',
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
    description:
      'Dog training courses every weekend at A1K9 Academy near Swansea. Group classes for all abilities help dogs learn and socialise.',
    sitemapPriority: '0.80',
    sitemapChangefreq: 'monthly',
  })
  .pages({
    view: 'courses/course.hbs',
    model: 'courses',
    controller: 'course.js',
    path: 'courses',
    sitemapPriority: '0.60',
    sitemapChangefreq: 'monthly',
  })

  .pages({
    view: 'about.hbs',
    model: 'about',
    controller: 'about.js',
    // The about/gaynor-probert/about-facilities/about-sara-thomas fan-out
    // shares one options object, so it can't give its own "about/" index a
    // higher priority than its siblings without a controller change — and
    // src/controllers/about.js is out of scope while another agent is mid-
    // migration on it. 0.60 for the whole section is the sensible default
    // until that lands.
    sitemapPriority: '0.60',
    sitemapChangefreq: 'monthly',
  })

  .page({
    view: 'find-us.hbs',
    model: {
      image: '/images/about/horse-sit-v1.webp',
      caption: 'right',
      captionOffset: true,
    },
    title: 'Find A1K9 Training',
    description:
      'Contact A1K9 Dog Training Academy near Swansea in South Wales to book dog training courses or a behavioural consultation, and find us on the map.',
    path: 'find-us',
    slug: 'index',
    sitemapPriority: '0.80',
    sitemapChangefreq: 'monthly',
  })

  .generate()
  .sitemap()

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
