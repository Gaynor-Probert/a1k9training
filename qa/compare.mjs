#!/usr/bin/env node
// qa/compare.mjs <label>
//
// Compares qa/out/<label>/content.json against qa/baseline/content.json and
// prints a compact per-page report. Exits 1 when any page has: a missing
// text sentence longer than 40 chars, a lost internal link, a form field
// difference, console errors, failed requests, or horizontal overflow.

import { promises as fs } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

function tokenSet(text) {
  return new Set((text.toLowerCase().match(/[a-z0-9']+/g) || []).filter((t) => t.length > 1))
}

function jaccard(a, b) {
  const setA = tokenSet(a)
  const setB = tokenSet(b)
  if (setA.size === 0 && setB.size === 0) return 1
  let intersection = 0
  for (const t of setA) if (setB.has(t)) intersection++
  const union = setA.size + setB.size - intersection
  return union === 0 ? 1 : intersection / union
}

// A text run is one block's text (the snapshot keeps block boundaries as
// newlines) split further at sentence punctuation. Both sides are reduced to
// lower-case alphanumerics so a CSS text-transform, a re-spaced "Q 1 :" label
// or a moved footer link cannot masquerade as lost copy — only missing words can.
function fold(text) {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
}

function sentences(text) {
  return text
    .split(/\n|(?<=[.!?])\s+/)
    .map((s) => fold(s))
    .filter((s) => s.length > 0)
}

function missingSentences(baselineText, currentText) {
  const currentFolded = ' ' + fold(currentText) + ' '
  return sentences(baselineText).filter((s) => !currentFolded.includes(' ' + s + ' '))
}

function headingSequence(headings) {
  return (headings || []).map((h) => `${h.tag}:${h.text}`)
}

function diffArray(before, after) {
  const beforeSet = new Set(before)
  const afterSet = new Set(after)
  return {
    missing: before.filter((x) => !afterSet.has(x)),
    added: after.filter((x) => !beforeSet.has(x)),
  }
}

function formsKey(form) {
  return (form.fields || []).map((f) => `${f.name}|${f.type}|${f.required}`).sort()
}

function compareForms(baselineForms = [], currentForms = []) {
  const diffs = []
  const maxLen = Math.max(baselineForms.length, currentForms.length)
  for (let i = 0; i < maxLen; i++) {
    const before = baselineForms[i]
    const after = currentForms[i]
    if (!before || !after) {
      diffs.push({ form: before?.name ?? after?.name ?? `#${i}`, issue: !after ? 'form removed' : 'form added' })
      continue
    }
    const beforeFields = formsKey(before)
    const afterFields = formsKey(after)
    const { missing, added } = diffArray(beforeFields, afterFields)
    if (missing.length || added.length || before.dataNetlify !== after.dataNetlify) {
      diffs.push({
        form: before.name ?? `#${i}`,
        missingFields: missing,
        addedFields: added,
        dataNetlifyChanged: before.dataNetlify !== after.dataNetlify,
      })
    }
  }
  return diffs
}

function imageIssues(images = []) {
  return images
    .filter((img) => !img.alt || !img.hasDimensionAttrs)
    .map((img) => ({
      src: img.src,
      // An empty alt is a deliberate decorative image; only an absent one fails.
      missingAlt: img.alt == null,
      missingDimensions: !img.hasDimensionAttrs,
    }))
}

/**
 * Compare one page's baseline vs current content record.
 */
function comparePage(baseline, current) {
  const result = { status: 'ok', issues: [] }

  if (!baseline) {
    result.status = 'extra'
    return result
  }
  if (!current) {
    result.status = 'missing'
    result.issues.push('page missing from current build')
    return result
  }

  if (baseline.title !== current.title) {
    result.titleChange = { before: baseline.title, after: current.title }
  }

  const beforeHeadings = headingSequence(baseline.headings)
  const afterHeadings = headingSequence(current.headings)
  if (beforeHeadings.join('|') !== afterHeadings.join('|')) {
    result.headingDiff = diffArray(beforeHeadings, afterHeadings)
  }

  const similarity = jaccard(baseline.visibleText || '', current.visibleText || '')
  const missingText = missingSentences(baseline.visibleText || '', current.visibleText || '')
  result.textSimilarity = Number(similarity.toFixed(3))
  result.missingSentences = missingText
  const longMissingSentence = missingText.some((s) => s.length > 40)
  if (longMissingSentence) result.issues.push('missing text sentence > 40 chars')

  const linkDiff = diffArray(baseline.internalLinks || [], current.internalLinks || [])
  result.linkDiff = linkDiff
  if (linkDiff.missing.length) result.issues.push('lost internal link')

  const imgIssues = imageIssues(current.images)
  if (imgIssues.length) result.imageIssues = imgIssues

  const formDiffs = compareForms(baseline.forms, current.forms)
  if (formDiffs.length) {
    result.formDiffs = formDiffs
    // An added field (a honeypot) is reported, never gating; a lost or changed
    // field, or a lost data-netlify attribute, is.
    const lossy = formDiffs.some(
      (d) => d.issue || d.missingFields?.length || d.dataNetlifyChanged,
    )
    if (lossy) result.issues.push('form field difference')
  }

  if ((current.consoleErrors || []).length) {
    result.consoleErrors = current.consoleErrors
    result.issues.push('console errors')
  }

  if ((current.failedRequests || []).length) {
    result.failedRequests = current.failedRequests
    result.issues.push('failed requests')
  }

  if (current.horizontalOverflow) {
    result.issues.push('horizontal overflow at 375')
  }

  if (result.issues.length) result.status = 'issues'
  return result
}

/**
 * @param {string} label
 */
export async function compare(label) {
  const baselineFile = path.resolve('qa/baseline/content.json')
  const currentFile = path.resolve('qa/out', label, 'content.json')

  const baseline = JSON.parse(await fs.readFile(baselineFile, 'utf8'))
  const current = JSON.parse(await fs.readFile(currentFile, 'utf8'))

  const allPaths = new Set([...Object.keys(baseline.pages), ...Object.keys(current.pages)])
  const report = {}
  let failed = false

  for (const p of [...allPaths].sort()) {
    const result = comparePage(baseline.pages[p], current.pages[p])
    report[p] = result
    if (result.status === 'missing' || result.status === 'issues') failed = true
  }

  return { report, failed }
}

function printTable(report) {
  const rows = Object.entries(report).map(([p, r]) => {
    const flags = []
    if (r.status === 'missing') flags.push('MISSING')
    if (r.status === 'extra') flags.push('EXTRA')
    if (r.titleChange) flags.push('title')
    if (r.headingDiff && (r.headingDiff.missing.length || r.headingDiff.added.length))
      flags.push('headings')
    if (r.textSimilarity != null && r.textSimilarity < 1) flags.push(`text=${r.textSimilarity}`)
    if (r.linkDiff && (r.linkDiff.missing.length || r.linkDiff.added.length)) flags.push('links')
    if (r.imageIssues?.length) flags.push('images')
    if (r.formDiffs?.length) flags.push('forms')
    if (r.consoleErrors?.length) flags.push('console')
    if (r.failedRequests?.length) flags.push('failed-req')
    if (r.issues?.includes('horizontal overflow at 375')) flags.push('overflow')
    return { page: p, status: r.status, flags: flags.join(',') || '-' }
  })

  const pageWidth = Math.max(4, ...rows.map((r) => r.page.length))
  const statusWidth = Math.max(6, ...rows.map((r) => r.status.length))
  console.log(`${'PAGE'.padEnd(pageWidth)}  ${'STATUS'.padEnd(statusWidth)}  FLAGS`)
  for (const row of rows) {
    console.log(`${row.page.padEnd(pageWidth)}  ${row.status.padEnd(statusWidth)}  ${row.flags}`)
  }
}

const isMain = process.argv[1] === fileURLToPath(import.meta.url)
if (isMain) {
  const [label] = process.argv.slice(2)
  if (!label) {
    console.error('Usage: node qa/compare.mjs <label>')
    process.exit(1)
  }
  const { report, failed } = await compare(label)
  printTable(report)

  const outFile = path.resolve('qa/out', label, 'compare.json')
  await fs.writeFile(outFile, JSON.stringify(report, null, 2))
  console.log(`\nWrote ${outFile}`)

  if (failed) {
    console.error('\nCompare FAILED: one or more pages have gating issues.')
    process.exit(1)
  } else {
    console.log('\nCompare OK: no gating issues found.')
  }
}
