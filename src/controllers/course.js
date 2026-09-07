import { createRequire } from 'node:module'
import 'colors'

// The faqs path in a model is relative to this file, so the require has to
// resolve from here — createRequire(import.meta.url) keeps that unchanged
// now the controller is ESM.
const require = createRequire(import.meta.url)

export default ({ model }) => {
  if (model.faqs) {
    console.log('Loading faqs:'.grey, model.faqs)
    const faqs = require(model.faqs)
    model.faqs = faqs.faqs
  }

  return {
    slug: model.slug,
    title: model.title,
    description: model.description,
    model: model,
  }
}
