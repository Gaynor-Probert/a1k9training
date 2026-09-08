#!/usr/bin/env node
// qa/serve.mjs — a dependency-free static file server that emulates Netlify's
// "pretty URL" resolution for a built kiss-ssg site, for use by the rest of
// the qa/ harness (snapshot, lighthouse, axe) and standalone as a CLI.
//
// Netlify pretty-URL resolution, reproduced here:
//   /                       -> index.html
//   /foo                    -> foo.html, else foo/index.html, else 404
//   /foo/                   -> foo/index.html, else 404
//   /foo.ext                -> served literally (static asset)
// This mirrors how Netlify serves a kiss-ssg build without extensions in
// hrefs, which is how every internal link in this site is authored.

import http from 'node:http'
import { createReadStream, promises as fs } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.eot': 'application/vnd.ms-fontobject',
  '.pdf': 'application/pdf',
  '.map': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
}

/**
 * Resolve a URL pathname to an on-disk file under `root`, applying Netlify's
 * pretty-URL rules. Returns the absolute file path, or null if nothing
 * matches (caller should respond 404).
 *
 * @param {string} root
 * @param {string} pathname decoded URL pathname, e.g. '/courses/bronze-obedience'
 * @returns {Promise<string|null>}
 */
async function resolveFile(root, pathname) {
  const safe = path.normalize(pathname).replace(/^(\.\.[/\\])+/, '')
  const clean = safe
    .split('/')
    .filter((seg) => seg !== '' && seg !== '.' && seg !== '..')
    .join('/')

  const candidates = []
  if (clean === '' || pathname.endsWith('/')) {
    candidates.push(path.join(root, clean, 'index.html'))
  } else {
    const ext = path.extname(clean)
    if (ext) {
      candidates.push(path.join(root, clean))
    } else {
      candidates.push(path.join(root, `${clean}.html`))
      candidates.push(path.join(root, clean, 'index.html'))
    }
  }

  const rootResolved = path.resolve(root)
  for (const candidate of candidates) {
    const resolved = path.resolve(candidate)
    if (resolved !== rootResolved && !resolved.startsWith(rootResolved + path.sep)) {
      continue
    }
    try {
      const stat = await fs.stat(resolved)
      if (stat.isFile()) return resolved
    } catch {
      // try next candidate
    }
  }
  return null
}

/**
 * Start a static server for `dir` on `port`, emulating Netlify pretty URLs.
 *
 * @param {string} dir directory to serve
 * @param {number} port port to listen on (0 for an ephemeral port)
 * @returns {Promise<{server: import('node:http').Server, port: number, url: string, close: () => Promise<void>}>}
 */
export function serve(dir, port) {
  const root = path.resolve(dir)
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost')
      const pathname = decodeURIComponent(url.pathname)
      const file = await resolveFile(root, pathname)
      if (!file) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
        res.end(`404 Not Found: ${pathname}`)
        return
      }
      const ext = path.extname(file).toLowerCase()
      const contentType = CONTENT_TYPES[ext] ?? 'application/octet-stream'
      res.writeHead(200, { 'Content-Type': contentType })
      createReadStream(file).pipe(res)
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' })
      res.end(`500 Internal Server Error: ${err.message}`)
    }
  })

  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, () => {
      const actualPort = server.address().port
      resolve({
        server,
        port: actualPort,
        url: `http://localhost:${actualPort}`,
        close: () => new Promise((res) => server.close(() => res())),
      })
    })
  })
}

// CLI entry point: `node qa/serve.mjs <dir> <port>`
const isMain = process.argv[1] === fileURLToPath(import.meta.url)
if (isMain) {
  const [dir, portArg] = process.argv.slice(2)
  if (!dir) {
    console.error('Usage: node qa/serve.mjs <dir> [port]')
    process.exit(1)
  }
  const port = portArg ? Number(portArg) : 8080
  const handle = await serve(dir, port)
  console.log(`Serving ${path.resolve(dir)} at ${handle.url}`)
  process.on('SIGINT', async () => {
    await handle.close()
    process.exit(0)
  })
}
