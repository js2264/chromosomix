import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { defineConfig, type Plugin } from 'vite'
import { fileURLToPath, URL } from 'node:url'

import { precacheUrls } from './scripts/sw-manifest.mjs'

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as {
  version?: string
}

/**
 * Ask git one question, or give up quietly.
 *
 * A build from a source tarball, or from a checkout with no history, has no
 * repository to ask — and a viewer that refused to build because it could not
 * name its own commit would be a worse trade than one whose about dialog says a
 * little less. `execFileSync` rather than a shell: no interpolation, nothing to
 * quote.
 */
function git(args: string[]): string {
  try {
    return execFileSync('git', args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
  } catch {
    return ''
  }
}

const VERSION = pkg.version ?? '0.0.0'
const COMMIT = git(['rev-parse', '--short', 'HEAD'])

/**
 * Emit `sw.js` with the list of files this build actually produced.
 *
 * The manifest cannot be written by hand: every asset is content-hashed, so the
 * names change on every build and a stale list is a worker that installs and
 * then serves a chunk that no longer exists. `generateBundle` is the first
 * moment the real names are known, and `emitFile` puts the worker beside them.
 *
 * The worker itself is a plain, commented `.js` file rather than a string in
 * this config, because it is the part someone will need to read when the cache
 * misbehaves. Only two placeholders are substituted.
 *
 * Dev is deliberately untouched: `vite dev` serves modules unbundled, so there
 * is nothing coherent to precache, and a worker holding yesterday's chunks is
 * the classic reason "my change does not show up".
 */
function serviceWorker(base: string): Plugin {
  return {
    name: 'metacooler-service-worker',
    apply: 'build',
    generateBundle(_options, bundle) {
      const source = readFileSync(new URL('./src/sw.js', import.meta.url), 'utf8')
      // `index.html` is emitted by Vite's html plugin and is in the bundle by
      // the time this runs; the public/ directory is copied separately and is
      // therefore absent, which is exactly the line the precache wants drawn.
      const urls = precacheUrls(Object.keys(bundle), base)
      const cacheName = ['metacooler', VERSION, COMMIT].filter(Boolean).join('-')
      // Each placeholder must appear exactly once. It is a text substitution,
      // so a second mention — in a comment, say — silently takes the value and
      // leaves the code holding an identifier that is not defined: a worker
      // that throws on install, which browsers report only in devtools, on a
      // page that otherwise looks fine. Caught here instead.
      for (const token of ['__CACHE_NAME__', '__PRECACHE__']) {
        const count = source.split(token).length - 1
        if (count !== 1) {
          this.error(`src/sw.js must mention ${token} exactly once, found ${count}`)
        }
      }
      this.emitFile({
        type: 'asset',
        fileName: 'sw.js',
        source: source
          .replace('__CACHE_NAME__', JSON.stringify(cacheName))
          .replace('__PRECACHE__', JSON.stringify(urls, null, 2)),
      })
    },
  }
}

// GitHub Pages serves the app from a sub-path; override with BASE_PATH at build
// time. `h5wasm` ships a .wasm asset that must not be inlined or renamed, so it
// is excluded from dependency pre-bundling.
export default defineConfig({
  base: process.env.BASE_PATH ?? '/',
  // What the bundle says about itself (`src/version.ts`). The commit *date*
  // rather than the build date: rebuilding identical source must not produce a
  // bundle that claims to be newer than the one beside it.
  define: {
    __APP_VERSION__: JSON.stringify(VERSION),
    __APP_COMMIT__: JSON.stringify(COMMIT),
    __APP_COMMIT_DATE__: JSON.stringify(git(['log', '-1', '--format=%cs'])),
  },
  plugins: [serviceWorker(process.env.BASE_PATH ?? '/')],
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  optimizeDeps: {
    exclude: ['h5wasm'],
  },
  worker: {
    format: 'es',
  },
  build: {
    target: 'es2022',
    sourcemap: true,
  },
  server: {
    fs: { allow: ['..'] },
  },
})
