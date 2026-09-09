import { createRequire } from 'node:module'
import 'colors'

const require = createRequire(import.meta.url)

export default ({ model }) => {
  console.log('Loading faqs:'.grey, model.faqs)
  const faqs = require(model.faqs)
  model.faqs = faqs.faqs
  return {
    model,
  }
}
