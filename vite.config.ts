import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { defineConfig, type Plugin } from 'vite'
import { fileURLToPath, URL } from 'node:url'

import { cspMeta } from './scripts/csp.mjs'
import { precacheUrls } from './scripts/sw-manifest.mjs'
import { thirdPartyCollector, thirdPartyNotices } from './scripts/third-party-notices.mjs'
import { llmsFull } from './scripts/llms.mjs'

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as {
  version?: string
  homepage?: string
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
/**
 * Serve a `.gz` file as the bytes it is, under `npm run dev`.
 *
 * Vite's static middleware answers a `.gz` with `Content-Encoding: gzip`, so
 * the browser inflates it on the way in — which is right for a pre-compressed
 * `.js.gz` and wrong for a file whose gzip *is* the format: a `.g3d.gz`, a
 * `.bed.gz`, a bgzipped anything. A byte-range read of such a file then gets
 * inflated bytes of a different length and fails as a network error, while
 * the same file on the built site is served plainly and opens. The demo's
 * structure is one (`demo/yeast/Yeast_structure.g3d.gz`), so the dev server
 * is taught what the site already does: no encoding header on a `.gz`.
 */
function gzippedAsIs(): Plugin {
  return {
    name: 'chromosomix-gz-as-is',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (!/\.gz(\?|$)/.test(req.url ?? '')) return next()
        const setHeader = res.setHeader.bind(res)
        res.setHeader = (name, value) => {
          if (String(name).toLowerCase() === 'content-encoding') return res
          return setHeader(name, value)
        }
        next()
      })
    },
  }
}

function serviceWorker(base: string): Plugin {
  return {
    name: 'chromosomix-service-worker',
    apply: 'build',
    generateBundle(_options, bundle) {
      const source = readFileSync(new URL('./src/sw.js', import.meta.url), 'utf8')
      // `index.html` is emitted by Vite's html plugin and is in the bundle by
      // the time this runs; the public/ directory is copied separately and is
      // therefore absent, which is exactly the line the precache wants drawn.
      const urls = precacheUrls(Object.keys(bundle), base)
      const cacheName = ['chromosomix', VERSION, COMMIT].filter(Boolean).join('-')
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
  // The last two are the web target's *own* values, not placeholders for
  // someone else's: `vite.desktop.config.ts` spreads this object and overrides
  // them. Written here rather than only there so that both guards that read
  // them fold away — esbuild replaces the token, sees a constant comparison,
  // and drops the branch — and the deployed bundle carries no trace of a second
  // target. A `define` missing from one config is a token that survives into
  // the output as an undefined identifier, which is why neither is optional.
  define: {
    __APP_VERSION__: JSON.stringify(VERSION),
    __APP_HOMEPAGE__: JSON.stringify(pkg.homepage ?? ''),
    __APP_COMMIT__: JSON.stringify(COMMIT),
    __APP_COMMIT_DATE__: JSON.stringify(git(['log', '-1', '--format=%cs'])),
    __APP_TARGET__: JSON.stringify('web'),
    // Empty means "the bucket `ui/examples.ts` names". Both targets ship it
    // empty now that the demos are on S3 rather than in `public/`, so the two
    // builds read the identical URLs and there is no per-target base left to
    // get wrong. `DEMO_BASE` overrides it for a fork with its own bucket, or
    // for a local copy of `demo/` when the network is not available.
    __DEMO_BASE__: JSON.stringify(process.env.DEMO_BASE ?? ''),
    // The site's own registrations with Google and Dropbox, none of them a
    // secret, read from the repository's Actions variables by the deploy
    // (`config/siteDefaults.ts`, docs/deploy.md). Empty is the build there
    // was before: every value pasted by hand.
    __GOOGLE_CLIENT_ID__: JSON.stringify(process.env.GOOGLE_CLIENT_ID ?? ''),
    __GOOGLE_API_KEY__: JSON.stringify(process.env.GOOGLE_API_KEY ?? ''),
    __DROPBOX_APP_KEY__: JSON.stringify(process.env.DROPBOX_APP_KEY ?? ''),
  },
  // The policy is the site's and every copy's: the pinned and package configs
  // replace this list and name `cspMeta()` again, where the desktop's — whose
  // policy is a response header (`electron/protocol.cts`) — deliberately does
  // not. See `scripts/csp.mjs` for every clause and why a meta.
  //
  // The notices are every build's, and every config that replaces this list
  // names `thirdPartyNotices()` again, last, where the worker builds report into
  // it from `worker.plugins` below (`scripts/third-party-notices.mjs`).
  //
  // `llms-full.txt` is the site's alone, beside the `llms.txt`, `robots.txt` and
  // `sitemap.xml` its `public/` carries (`scripts/llms.mjs`).
  plugins: [serviceWorker(process.env.BASE_PATH ?? '/'), gzippedAsIs(), cspMeta(), thirdPartyNotices(), llmsFull()],
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  optimizeDeps: {
    exclude: ['h5wasm'],
  },
  worker: {
    format: 'es',
    // Each worker is a Rollup of its own, which the page's plugins never see;
    // this is how what the readers and the kernels compile in reaches the notices.
    plugins: () => [thirdPartyCollector()],
  },
  build: {
    target: 'es2022',
    sourcemap: true,
  },
  server: {
    fs: { allow: ['..'] },
  },
})
