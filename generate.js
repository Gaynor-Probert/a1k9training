import fs from 'node:fs'
import 'colors'
import Kiss, { utils } from 'kiss-ssg'

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

// The two venues named on src/pages/contact.hbs ("A1K9 Dog Training Academy
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
// `location` is the LOCATIONS pair above, sourced from src/pages/contact.hbs.
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

// The same id → served-path resolution templates get from {{link}}, for the
// helpers below that assemble a breadcrumb trail or a course track in JS rather
// than in markup. `canonical` gives the pretty form Netlify serves without a
// redirect (`/courses/`, `/courses/bronze-obedience`), the same string the
// page's own <link rel="canonical"> and its sitemap <loc> carry. Render-time
// only: the registry it reads is filled by the .page()/.pages() calls further
// down, so nothing may call it at module load — an unknown id throws, which is
// the point (a dead link fails the build instead of shipping).
const linkTo = (id, slug) =>
  kiss.handlebars.helpers.link(id, { hash: { canonical: true, slug } })

// The site's four sections — one entry per top-level folder: the label used for
// it wherever it is named, the page id of its index, and the fan-out id its
// child pages hang off (`{{link child slug=…}}`; null where a section has no
// children). The navbar still carries its own copy of these labels in markup,
// so renaming a section means editing src/partials/layout/navbar.hbs too.
const SECTIONS = {
  'behavioural-consultations': {
    label: 'Consultations',
    id: 'behavioural-consultations/index',
    child: 'behavioural-consultations/consultation',
  },
  courses: { label: 'Courses', id: 'courses/index', child: 'courses/course' },
  about: { label: 'About Us', id: 'about/index', child: 'about' },
  contact: { label: 'Contact', id: 'contact', child: null },
}

// The breadcrumb trail for the page being rendered, derived from that page's own
// URL rather than declared page by page — so the visual trail
// (src/partials/layout/breadcrumb.hbs) and the BreadcrumbList JSON-LD below are
// always the same list, which is what Google asks for and what stops the two
// drifting as pages are added.
//
// This site is exactly two levels deep: a page URL is either a section index
// ('courses') or one child of it ('courses/bronze-obedience'). A child's own
// crumb comes from `model.crumb`, a short label matching the navbar — NOT
// `model.heading`, which on this site is a marketing headline ("Solid
// Foundation Training", "Congratulations! You have a new puppy.") and made a
// nonsense of the trail while it was being used for this.
//
// Returns [] for the home page: it is the root, and gets no trail.
kiss.handlebars.registerHelper('breadcrumb', function (options) {
  const key = utils.toURLKey(options?.data?.root?.pageURL ?? '')
  if (!key) return []

  const [sectionSlug, childSlug] = key.split('/')
  const section = SECTIONS[sectionSlug]
  if (!section) return []

  const trail = [{ name: 'Home', url: linkTo('index') }]
  if (!childSlug) {
    trail.push({ name: section.label, url: linkTo(section.id), current: true })
    return trail
  }

  trail.push({ name: section.label, url: linkTo(section.id) })
  const model = options?.data?.root?.model
  trail.push({
    name: model?.crumb || model?.heading || childSlug,
    url: linkTo(section.child, childSlug),
    current: true,
  })
  return trail
})

// The course progression, read from the course models themselves so that adding
// or reordering a course means editing its own .json and nothing else.
//
// Junior -> Bronze -> Silver -> Gold -> Platinum is a strict chain: each course
// is the prerequisite for the next, and a model's `level` is its place in it.
// Puppy Socialisation is NOT rung zero — it is a standalone socialisation class
// that feeds into Junior without being required first, which is what `onramp`
// marks and what the dashed connector says in the rendered track. One to One is
// a private format rather than a stage, carries neither field, and so gets no
// track at all.
const COURSE_MODELS = './src/models/courses'
// No `url` here: the steps are built at module load, before any page is
// registered, so the URL is resolved per step at render time (`withUrl` in the
// courseLadder helper) where {{link}} can vouch for it.
const ladderStep = (m) => ({
  slug: m.slug,
  rung: m.rung,
  name: m.crumb,
})
const courseModels = fs
  .readdirSync(COURSE_MODELS)
  .filter((f) => f.endsWith('.json'))
  .map((f) => JSON.parse(fs.readFileSync(`${COURSE_MODELS}/${f}`, 'utf8')))

const LADDER = courseModels
  .filter((m) => typeof m.level === 'number')
  .sort((a, b) => a.level - b.level)
  .map(ladderStep)
const ONRAMP = courseModels.filter((m) => m.onramp).map(ladderStep)[0] ?? null

// The track for the course page being rendered: every step in order, the one
// the visitor is on flagged, and the next course up. Returns null for any page
// that is not a course on the ladder (One to One, the courses index, everything
// outside /courses/), and the partial renders nothing for a null.
kiss.handlebars.registerHelper('courseLadder', function (options) {
  const [section, slug] = utils
    .toURLKey(options?.data?.root?.pageURL ?? '')
    .split('/')
  if (section !== 'courses' || !slug) return null

  const rung = LADDER.findIndex((s) => s.slug === slug)
  const isOnramp = ONRAMP?.slug === slug
  if (rung === -1 && !isOnramp) return null

  const withUrl = (s) =>
    s ? { ...s, url: linkTo('courses/course', s.slug) } : null
  const steps = []
  if (ONRAMP)
    steps.push({ ...withUrl(ONRAMP), current: isOnramp, optional: true })
  LADDER.forEach((s, i) =>
    steps.push({
      ...withUrl(s),
      current: s.slug === slug,
      // the only dashed connector is the optional one from the on-ramp into
      // the first rung; every other step follows its predecessor strictly
      dashedIn: i === 0 && Boolean(ONRAMP),
    }),
  )

  return {
    steps,
    current: steps.find((s) => s.current),
    next: withUrl(isOnramp ? LADDER[0] : LADDER[rung + 1]),
    isOnramp,
  }
})

// BreadcrumbList JSON-LD, built from the trail the visual breadcrumb renders:
// {{{stringify (breadcrumbList (breadcrumb))}}} in a page's head. Passing one
// array to both is what keeps the markup describing a trail the visitor can
// actually see.
kiss.handlebars.registerHelper('breadcrumbList', (trail) => {
  const siteUrl = kiss.config.siteUrl
  const items = Array.isArray(trail) ? trail : []
  return {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: items.map(({ name, url }, index) => ({
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
    view: 'contact.hbs',
    model: {
      image: '/images/about/horse-sit-v1.webp',
      caption: 'right',
      captionOffset: true,
    },
    title: 'Contact A1K9 Training',
    description:
      'Contact A1K9 Dog Training Academy near Swansea in South Wales to book dog training courses or a behavioural consultation, and find us on the map.',
    path: 'contact',
    slug: 'index',
    // The contact page moved from /find-us/ to /contact/ (the label the navbar
    // and breadcrumb already used). Unlike the pre-2015 paths the course,
    // consultation and about records carry as their own `aliases`, this URL
    // was live and indexed until the rename, so the 301 is what carries its
    // ranking. kiss writes every alias into docs/_redirects.
    aliases: ['/find-us/'],
    sitemapPriority: '0.80',
    sitemapChangefreq: 'monthly',
  })

  // Where Netlify sends a visitor after a successful form post (the forms'
  // `action`). Like the 404 it is a real page but not a destination — kept out
  // of sitemap.xml and llms.txt, and given `noHero` so the confirmation is the
  // first thing on screen.
  .page({
    view: 'thanks.hbs',
    model: { noHero: true },
    title: 'Thank you | A1K9 Training',
    description:
      'Your enquiry has been sent to Gaynor Probert at A1K9 Training. She will get back to you shortly.',
    path: 'thanks',
    slug: 'index',
    ignoreSitemap: true,
    ignoreLlms: true,
  })

  // Netlify serves docs/404.html for any unmatched path. It is a real page in
  // the build but not a destination: kept out of sitemap.xml and llms.txt so
  // neither search engines nor answer engines offer it as a result, and given
  // `noHero` so the routes back sit above the fold instead of below a 60vh photo.
  .page({
    view: '404.hbs',
    model: { noHero: true },
    title: 'Page not found | A1K9 Training',
    description:
      'That page could not be found. Find dog training courses, behavioural consultations and contact details for A1K9 Training near Swansea.',
    slug: '404',
    ignoreSitemap: true,
    ignoreLlms: true,
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
      contact: 'Home and contact',
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
