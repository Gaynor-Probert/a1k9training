export default ({ model }) => {
  return {
    path: 'about',
    slug: model.slug,
    model,
    title: model.title,
    description: model.description,
  }
}
