#!/usr/bin/env node
// qa/pages.mjs — derives the list of page URL paths from a built site
// directory, using the same Netlify pretty-URL convention as qa/serve.mjs:
//   dir/index.html          -> /
//   dir/foo/index.html      -> /foo/
//   dir/foo.html            -> /foo
//   dir/foo/bar.html        -> /foo/bar
//
// Used by qa/snapshot.mjs, qa/lighthouse.mjs and qa/axe.mjs to enumerate
// every page of a built site without hand-maintaining a list.

import { promises as fs } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Recursively collect every *.html file under `dir`.
 * @param {string} dir
 * @returns {Promise<string[]>} absolute file paths
 */
async function walkHtml(dir) {
  const entries = await fs.readdir(dir, { withFileTypes: true })
  const files = []
  for (const entry of entries) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      files.push(...(await walkHtml(full)))
    } else if (entry.isFile() && entry.name.endsWith('.html')) {
      files.push(full)
    }
  }
  return files
}

/**
 * Convert an absolute .html file path into its Netlify pretty-URL path.
 * @param {string} root site root directory
 * @param {string} file absolute path to an .html file under root
 * @returns {string} URL path, e.g. '/', '/courses/', '/courses/bronze-obedience'
 */
export function toUrlPath(root, file) {
  const rel = path.relative(root, file).split(path.sep).join('/')
  if (rel === 'index.html') return '/'
  if (rel.endsWith('/index.html')) {
    return `/${rel.slice(0, -'index.html'.length)}`
  }
  return `/${rel.slice(0, -'.html'.length)}`
}

/**
 * Derive the sorted, de-duplicated list of page URL paths for a built site.
 * @param {string} siteDir
 * @returns {Promise<string[]>}
 */
export async function listPages(siteDir) {
  const root = path.resolve(siteDir)
  const files = await walkHtml(root)
  const urls = files.map((f) => toUrlPath(root, f))
  return [...new Set(urls)].sort()
}

// CLI entry point: `node qa/pages.mjs <siteDir> [--assert=N]`
const isMain = process.argv[1] === fileURLToPath(import.meta.url)
if (isMain) {
  const args = process.argv.slice(2)
  const siteDir = args.find((a) => !a.startsWith('--'))
  const assertArg = args.find((a) => a.startsWith('--assert='))
  if (!siteDir) {
    console.error('Usage: node qa/pages.mjs <siteDir> [--assert=N]')
    process.exit(1)
  }
  const pages = await listPages(siteDir)
  for (const p of pages) console.log(p)
  console.error(`\n${pages.length} page(s) found in ${path.resolve(siteDir)}`)
  if (assertArg) {
    const expected = Number(assertArg.split('=')[1])
    if (pages.length !== expected) {
      console.error(`Expected ${expected} pages, found ${pages.length}`)
      process.exit(1)
    }
  }
}
