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

// The image pipeline (scripts/optimise-images.mjs) writes a 960px-wide sibling
// beside every hero — `foo.webp` → `foo-960w.webp` — so a phone never downloads
// the 1920px file. {{imageVariant model.image '960w'}} names that sibling.
kiss.handlebars.registerHelper('imageVariant', (src, suffix) =>
  typeof src === 'string' ? src.replace(/(\.[a-z0-9]+)$/i, `-${suffix}$1`) : '',
)

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

// The two venues named on src/pages/find-us.hbs ("A1K9 Dog Training Academy
// now runs from two venues near Swansea"). Only fields this repo actually
// sources are included:
//  - A1K9 Training Grounds: locality + postcode come from that page's first
//    map embed's `pb=` query string ("Pontarddulais,+Swansea+SA4+8NP"); the
//    lat/long come from the same embed's `!2d…!3d…` pair (longitude then
//    latitude).
//  - Llys Nini Animal Centre (RSPCA): the page states its locality and
//    postcode directly in the heading text, but the repo holds no
//    coordinates for it (its map is a plain `?q=` search embed, not a
//    `pb=` embed with a lat/long pair) — so it gets an address and no `geo`,
//    rather than an invented one.
// No street address or opening hours are invented for either venue.
const LOCATIONS = [
  {
    '@type': 'Place',
    name: 'A1K9 Training Grounds',
    address: {
      '@type': 'PostalAddress',
      addressLocality: 'Pontarddulais',
      addressRegion: 'West Glamorgan',
      postalCode: 'SA4 8NP',
      addressCountry: 'GB',
    },
    geo: {
      '@type': 'GeoCoordinates',
      latitude: 51.7053036589514,
      longitude: -3.9974988901576323,
    },
  },
  {
    '@type': 'Place',
    name: 'Llys Nini Animal Centre (RSPCA)',
    address: {
      '@type': 'PostalAddress',
      addressLocality: 'Penllergaer',
      addressRegion: 'West Glamorgan',
      postalCode: 'SA4 9WB',
      addressCountry: 'GB',
    },
  },
]

// LocalBusiness JSON-LD (src/partials/layout/header.hbs, every page). Built
// as a helper rather than hand-typed JSON in the template so title/description
// text and image paths go through JSON.stringify's own escaping instead of
// Handlebars'. Only fields this repo actually sources are included — no
// street address or opening hours live anywhere in it, so none are invented
// here. The Facebook link comes from src/pages/index.hbs's "Open Page »" card
// (tracking query string dropped); the phone number is the site's tel: link.
// `location` is the LOCATIONS pair above, sourced from src/pages/find-us.hbs.
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
    location: LOCATIONS,
  }
})

const BUSINESS_REF = {
  '@type': 'LocalBusiness',
  name: 'A1K9 Behaviour and Training Academy',
  url: `${kiss.config.siteUrl}/`,
}

// FAQPage JSON-LD, for src/partials/faqs.hbs — used on /courses/ and every
// course page that carries a `faqs` field (see src/models/courses/*.json).
// `this` inside faqs.hbs is already the plain [{q, a}] array the faqMapper/
// course controllers load, so the helper just reshapes it.
kiss.handlebars.registerHelper('faqPage', (faqs) => ({
  '@context': 'https://schema.org',
  '@type': 'FAQPage',
  mainEntity: (faqs || []).map((faq) => ({
    '@type': 'Question',
    name: faq.q,
    acceptedAnswer: { '@type': 'Answer', text: faq.a },
  })),
}))

// Service JSON-LD for a course or consultation page — src/pages/courses/course.hbs
// and src/pages/behavioural-consultations/{index,consultation}.hbs. `provider`
// points back at the same LocalBusiness the header's JSON-LD describes.
kiss.handlebars.registerHelper('serviceSchema', (name, description, url) => ({
  '@context': 'https://schema.org',
  '@type': 'Service',
  serviceType: name,
  name,
  description,
  provider: BUSINESS_REF,
  areaServed: 'South Wales',
  url,
}))

// Person JSON-LD for a team member's About page — src/pages/about.hbs, gated
// on the model carrying a `person` object (only gaynor-probert.json and
// sara-thomas.json do; Philosophy and Facilities don't get one). `credentials`
// is an optional array of plain strings, e.g. accreditation names.
kiss.handlebars.registerHelper(
  'personSchema',
  (name, jobTitle, description, image, url, credentials) => {
    const siteUrl = kiss.config.siteUrl
    const schema = {
      '@context': 'https://schema.org',
      '@type': 'Person',
      name,
      jobTitle,
      description,
      image: `${siteUrl}${image}`,
      url,
      worksFor: BUSINESS_REF,
    }
    if (Array.isArray(credentials) && credentials.length) {
      schema.hasCredential = credentials.map((c) => ({
        '@type': 'EducationalOccupationalCredential',
        name: c,
      }))
    }
    return schema
  },
)

// BreadcrumbList JSON-LD. Called with (name, url) pairs in order, e.g.
// {{{stringify (breadcrumbList "Home" "/" "Courses" "/courses/" model.heading (canonical))}}}
// — the trailing Handlebars options object is popped off, not a real pair.
kiss.handlebars.registerHelper('breadcrumbList', (...args) => {
  args.pop()
  const siteUrl = kiss.config.siteUrl
  const items = []
  for (let i = 0; i < args.length; i += 2) items.push([args[i], args[i + 1]])
  return {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: items.map(([name, url], index) => ({
      '@type': 'ListItem',
      position: index + 1,
      name,
      item: /^https?:\/\//.test(url) ? url : `${siteUrl}${url}`,
    })),
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
      faqs: '../models/faqs/consultations.json',
    },
    controller: 'faqMapper.js',
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
  // llms.txt (llmstxt.org): the index answer engines read first. kiss derives
  // every entry from the page registry — the same titles, descriptions and
  // canonical URLs as the sitemap — so it cannot drift; the two things only a
  // human can write live in src/llms/.
  .llms({
    title: 'A1K9 Behaviour and Training Academy',
    summary: 'src/llms/summary.md',
    notes: 'src/llms/notes.md',
    sections: {
      root: 'Home and contact',
      courses: 'Dog training courses',
      'behavioural-consultations': 'Behavioural consultations',
      about: 'About',
      'find-us': 'Home and contact',
    },
  })

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
