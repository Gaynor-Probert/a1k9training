const Kiss = require('kiss-ssg')
var args = process.argv.slice(2)

var d = new Date()
var year = d.getFullYear()

const kiss = new Kiss({
  dev: args.length > 0,
  verbose: true,
  folders: { build: './docs' },
  sass: { includePaths: ['./node_modules/bootstrap/scss'] },
  year: year,
})

  .page({
    view: 'index.hbs',
    title: 'Gaynor Probert - Dog Behaviour and Trainer South Wales',
    description:
      'Gaynor Probert K9 Behaviour and Training - Improving relationships between dogs and their owners',
  })

  .page({
    view: 'behavioural-consultations/index.hbs',
    model: {
      image: '/images/consultations/consultations-v1.png',
      'caption-class': 'pull-right',
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
      image: '/images/courses/classes-v1.1.png',
      'caption-class': 'pull-left',
      faqs: '../models/faqs/courses.json',
    },
    controller: 'faqMapper.js',
    title: 'Dog Training Classes South Wales with Gaynor Probert',
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
      image: '/images/about/horse-sit-v1.png',
      'caption-class': 'pull-right push-down',
    },
    title: 'Find A1K9 Training',
    path: 'find-us',
    slug: 'index',
  })

  .generate(function () {
    console.log('Success'.rainbow)
    if (this.config.dev) console.log('http://localhost:3000'.yellow)
  })
