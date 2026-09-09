export default ({ model }) => {
  return {
    slug: model.slug,
    title: model.title,
    description: model.description,
    model: model,
  }
}
