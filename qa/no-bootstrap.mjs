#!/usr/bin/env node
// qa/no-bootstrap.mjs <siteDir>
//
// Scans every built .html and .css file under siteDir for Bootstrap 3 class
// names and vendor asset references. Prints file:line matches and exits 1
// if any are found. Run against the baseline it should (and does) fail —
// that's the point: proving the detector works before it starts gating the
// migrated build.

import { promises as fs } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// Matched as substrings, not word-boundary tokens, since some (e.g.
// 'bootstrap', 'jquery') are meant to catch file paths and comments too.
export const PATTERNS = [
  'col-xs-',
  'img-responsive',
  'pull-right',
  'pull-left',
  'hidden-xs',
  'glyphicon',
  // Class-scoped: 'panel' and 'thumbnail' are ordinary words (nav-panel,
  // a caption) — only Bootstrap's own class names count.
  /class="[^"]*\b(panel|panel-[a-z]+|thumbnail)\b/,
  'navbar-',
  'btn-default',
  'form-group',
  'form-inline',
  'caret',
  'data-toggle',
  'bootstrap',
  'jquery',
]

async function walk(dir, exts) {
  const entries = await fs.readdir(dir, { withFileTypes: true })
  const files = []
  for (const entry of entries) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      files.push(...(await walk(full, exts)))
    } else if (entry.isFile() && exts.some((ext) => entry.name.endsWith(ext))) {
      files.push(full)
    }
  }
  return files
}

/**
 * Scan a built site for Bootstrap 3 class names / vendor references.
 * @param {string} siteDir
 * @returns {Promise<{file: string, line: number, pattern: string, text: string}[]>}
 */
export async function scanForBootstrap(siteDir) {
  const root = path.resolve(siteDir)
  const files = await walk(root, ['.html', '.css'])
  const matches = []

  for (const file of files) {
    // eslint-disable-next-line no-await-in-loop
    const content = await fs.readFile(file, 'utf8')
    const lines = content.split('\n')
    lines.forEach((lineText, idx) => {
      for (const pattern of PATTERNS) {
        const hit = pattern instanceof RegExp ? pattern.test(lineText) : lineText.includes(pattern)
        if (hit) {
          matches.push({
            file: path.relative(root, file),
            line: idx + 1,
            pattern: String(pattern),
            text: lineText.trim().slice(0, 160),
          })
        }
      }
    })
  }

  return matches
}

const isMain = process.argv[1] === fileURLToPath(import.meta.url)
if (isMain) {
  const [siteDir] = process.argv.slice(2)
  if (!siteDir) {
    console.error('Usage: node qa/no-bootstrap.mjs <siteDir>')
    process.exit(1)
  }
  const matches = await scanForBootstrap(siteDir)
  if (matches.length === 0) {
    console.log('No Bootstrap 3 classes or assets found.')
  } else {
    for (const m of matches) {
      console.log(`${m.file}:${m.line}: [${m.pattern}] ${m.text}`)
    }
    console.error(`\n${matches.length} Bootstrap 3 match(es) found.`)
    process.exit(1)
  }
}
