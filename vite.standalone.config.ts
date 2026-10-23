/**
 * One HTML file that opens from a disk and works — the fifth target.
 *
 * The same rule as the desktop and CLI configs: a second reading of `src/`,
 * never an edit to the first. `npm run build` is what the deploy workflow runs
 * and must keep working byte for byte.
 *
 * ## What this is for
 *
 * Three situations the hosted site, the PWA and the desktop installers between
 * them do not cover: an **air-gapped or HPC machine** with no route to the
 * website, a **reviewer** who will not install anything, and a **locked-down
 * laptop holding unpublished patient-derived data** — which is the reader §11
 * was written for. Emailing them a file they double-click is the whole feature.
 *
 * ## The four constraints a `file://` page imposes
 *
 * Every one of these was measured in Chromium before this config was written,
 * and every one of them is absolute rather than a degradation:
 *
 * 1. **A module worker cannot be constructed.** `worker.format: 'iife'` plus the
 *    `?worker&inline` imports in `src/worker/spawn.standalone.ts` give classic
 *    workers over blob URLs, which do work.
 * 2. **A sibling `.js` cannot be fetched** — the same CORS refusal that blocks a
 *    dynamic import. `inlineDynamicImports` collapses the graph to one chunk and
 *    {@link singleFile} folds that chunk into the HTML.
 * 3. **No network at all.** The origin is opaque, so every remote read fails.
 *    `__STANDALONE__` is how the interface knows not to offer one, and the
 *    page's own policy (`connect-src data:` and nothing else, computed by
 *    {@link singleFile} over what it inlined) makes it a rule the browser
 *    enforces on the page and on its blob workers alike, rather than a
 *    circumstance. `data:` is the bigWig reader's: it fetches its own wasm
 *    from one, and a `data:` URL has no host behind it.
 * 4. **No service worker.** Registration is refused; `pwa.ts` already treats a
 *    refusal as "this page has no cache" and needs no change.
 *
 * The one thing that turned out *not* to be a constraint is the largest: h5wasm
 * ships its wasm base64-inlined in its own JavaScript, so there is no `.wasm` to
 * fetch and nothing to work around.
 *
 * ## What it costs
 *
 * About fourteen megabytes of HTML — the app, its four workers and h5wasm, all
 * inlined — parsed on every open with no HTTP cache behind it. That is the
 * price of the format: one file carries everything a page would otherwise
 * fetch, h5wasm's four megabytes of compiled HDF5 among it.
 */

import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join as joinPath, resolve as resolvePath } from 'node:path'
import { execSync } from 'node:child_process'
import { fileURLToPath, URL } from 'node:url'
import { defineConfig, type Plugin } from 'vite'

import { withStandaloneCsp } from './scripts/csp.mjs'
import { standaloneIndexProblems } from './scripts/standalone-shape.mjs'
import { noticesComment, thirdPartyCollector, thirdPartyNotices } from './scripts/third-party-notices.mjs'

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as {
  version?: string
  homepage?: string
}
const VERSION = pkg.version ?? '0.0.0'

/** `public/icon-192.png` as a data URI — the header's mark, with no file. */
function markDataUrl(): string {
  const bytes = readFileSync(new URL('./public/icon-192.png', import.meta.url))
  return `data:image/png;base64,${bytes.toString('base64')}`
}

function git(args: string[]): string {
  try {
    return execSync(`git ${args.join(' ')}`, { stdio: ['ignore', 'pipe', 'ignore'] })
      .toString()
      .trim()
  } catch {
    return ''
  }
}

/**
 * Fold every emitted script and stylesheet into `index.html`, and drop them.
 *
 * Written here rather than depended on. `vite-plugin-singlefile` does this and
 * does it well; it is sixty lines, this repo writes its own build plugins
 * already (`vite.config.ts`'s service-worker emitter), and the alternative is a
 * dependency in the chain that produces the artefact whose whole selling point
 * is that it depends on nothing.
 *
 * **`JSON.stringify` is not enough to make a bundle safe inside `<script>`.**
 * The parser ends the element at the first literal `</script` regardless of
 * JavaScript context, so a bundle containing that sequence in a string — which
 * this one does, in the noscript-adjacent markup the app writes — truncates the
 * script and produces a blank page with no error. The escape below is the
 * standard one and it is the reason this is not three lines.
 */
function singleFile(): Plugin {
  let outDir = 'dist-standalone'
  return {
    name: 'chromosomix-single-file',
    enforce: 'post',
    configResolved(config) {
      outDir = config.build.outDir
    },
    /**
     * `closeBundle`, on disk — not `generateBundle` on the bundle object.
     *
     * The obvious hook is the wrong one and the failure is instructive: Vite's
     * own HTML plugin injects the `<script src>` tags in *its* `generateBundle`,
     * and `enforce: 'post'` does not order that hook against a core plugin's. A
     * version of this that inlined the chunk there produced a 12 MB page with
     * the whole app inlined *and* two dangling `<script src>` tags beside it,
     * pointing at chunks this plugin had just deleted. It looked like it had
     * worked.
     *
     * By `closeBundle` the HTML on disk is final, whoever wrote what into it.
     */
    closeBundle() {
      const root = resolvePath(outDir)
      const indexPath = joinPath(root, 'index.html')
      let html = readFileSync(indexPath, 'utf8')
      const consumed = new Set<string>()

      const inline = (pattern: RegExp, wrap: (body: string) => string): void => {
        html = html.replace(pattern, (tag, href: string) => {
          const file = joinPath(root, href.replace(/^\.?\//, ''))
          if (!existsSync(file)) return tag
          consumed.add(file)
          // The parser ends the element at the first literal `</script` or
          // `</style` regardless of JavaScript or CSS context, so a bundle
          // containing that sequence in a string truncates the element and
          // produces a blank page with no error at all. This escape is the
          // reason the inlining is not one line.
          const body = readFileSync(file, 'utf8')
            .replace(/<\/script/gi, '<\\/script')
            .replace(/<\/style/gi, '<\\/style')
          return wrap(body)
        })
      }

      inline(
        /<script\b[^>]*\ssrc="([^"]+)"[^>]*><\/script>/g,
        (body) => `<script type="module">${body}</script>`,
      )
      inline(
        /<link\b[^>]*\srel="stylesheet"[^>]*\shref="([^"]+)"[^>]*>/g,
        (body) => `<style>${body}</style>`,
      )
      inline(
        /<link\b[^>]*\shref="([^"]+\.css)"[^>]*\srel="stylesheet"[^>]*>/g,
        (body) => `<style>${body}</style>`,
      )

      // The PWA tags point at a `public/` this build does not emit, exactly as
      // they do for the desktop target. Removed rather than left as
      // root-absolute references with no file behind them.
      html = html
        .replace(/\s*<link rel="manifest"[^>]*>/g, '')
        .replace(/\s*<link rel="apple-touch-icon"[^>]*>/g, '')
        .replace(/\s*<meta name="theme-color"[^>]*>/g, '')

      // The notices every other build writes beside its page, written into this
      // one — it may not be two files — as a comment ahead of `</html>`.
      // Collected by `thirdPartyNotices({ fileName: null })` and the workers'
      // collectors in `generateBundle`, which every build has finished by
      // `closeBundle` (`scripts/third-party-notices.mjs`).
      if (!/<\/html>\s*$/i.test(html)) throw new Error('standalone build: index.html does not end in </html>')
      html = html.replace(/<\/html>\s*$/i, `${noticesComment()}\n</html>\n`)

      // The policy, **last**, because it is computed over the page: it names
      // the hash of each script and stylesheet just inlined, and any edit after
      // this line would leave it naming something the page no longer holds —
      // which the browser answers by refusing the app's one script. A file
      // can be sent no header, and the site's `'self'` policy would refuse
      // every inlined element, so this page carries its own (`scripts/csp.mjs`).
      html = withStandaloneCsp(html)

      writeFileSync(indexPath, html)
      for (const file of consumed) rmSync(file, { force: true })
      // Whatever directory the assets were in, now that it is empty.
      rmSync(joinPath(root, 'assets'), { recursive: true, force: true })

      const problems = standaloneIndexProblems(html)
      if (problems.length > 0) {
        throw new Error(`standalone build is not self-contained:\n  ${problems.join('\n  ')}`)
      }
    },
  }
}

export default defineConfig({
  // Relative, and it has to be: a root-absolute asset path on a `file://` page
  // resolves to the filesystem root. Nothing is emitted beside the HTML anyway,
  // but a stray reference would then point at `/assets/…` on the reader's disk.
  base: './',
  define: {
    __APP_VERSION__: JSON.stringify(VERSION),
    __APP_HOMEPAGE__: JSON.stringify(pkg.homepage ?? ''),
    __APP_COMMIT__: JSON.stringify(git(['rev-parse', '--short', 'HEAD'])),
    __APP_COMMIT_DATE__: JSON.stringify(git(['log', '-1', '--format=%cs'])),
    __APP_TARGET__: JSON.stringify('standalone'),
    __DEMO_BASE__: JSON.stringify(''),
    // No registration reaches a `file://` page: it has no origin to register
    // a client id against and no referrer to restrict a key to.
    __GOOGLE_CLIENT_ID__: JSON.stringify(''),
    __GOOGLE_API_KEY__: JSON.stringify(''),
    __DROPBOX_APP_KEY__: JSON.stringify(''),
    // Nothing to count to, and a policy that could not reach it (§19, §31).
    __TELEMETRY_ENDPOINT__: JSON.stringify(''),
    __TELEMETRY_WEBSITE__: JSON.stringify(''),
    __STANDALONE__: 'true',
    // The mark, inline. `vite.pinned.config.ts` answers the same question by
    // emitting the file beside the build; this target may not emit a second
    // file at all, so the same bytes become a data URI. Read from `public/`,
    // so there is still exactly one drawing of the mark.
    __MARK_URL__: JSON.stringify(markDataUrl()),
  },
  publicDir: false,
  plugins: [thirdPartyNotices({ fileName: null }), singleFile()],
  resolve: {
    alias: [
      // The one behavioural swap in the whole target. See `worker/spawn.ts`.
      {
        find: /^(.*)\/worker\/spawn$/,
        replacement: fileURLToPath(new URL('./src/worker/spawn.standalone.ts', import.meta.url)),
      },
      {
        find: './spawn',
        replacement: fileURLToPath(new URL('./src/worker/spawn.standalone.ts', import.meta.url)),
      },
      // …and the correlation's helpers, started from inside the analysis worker
      // (`analysis/worker/spawnGram.ts`), for the same reason.
      {
        find: /^(.*)\/spawnGram$/,
        replacement: fileURLToPath(new URL('./src/analysis/worker/spawnGram.standalone.ts', import.meta.url)),
      },
      // …and pastis-NB's likelihood helpers (`analysis/worker/spawnLikelihood.ts`).
      {
        find: /^(.*)\/spawnLikelihood$/,
        replacement: fileURLToPath(new URL('./src/analysis/worker/spawnLikelihood.standalone.ts', import.meta.url)),
      },
      { find: '@', replacement: fileURLToPath(new URL('./src', import.meta.url)) },
    ],
  },
  optimizeDeps: { exclude: ['h5wasm'] },
  worker: {
    // Classic, not `es`. A module worker cannot be constructed from a `file://`
    // page at all — this is the flag that decides whether the app has a reader.
    format: 'iife',
    plugins: () => [thirdPartyCollector()],
    rollupOptions: {
      output: {
        // The workers code-split too — the reader lazily reaches h5wasm — and
        // an IIFE cannot. Collapsing each worker to one chunk is required by
        // the format rather than chosen, and is right anyway: a worker chunk
        // is a sibling file, and a sibling file is unfetchable here.
        inlineDynamicImports: true,
      },
    },
  },
  build: {
    target: 'es2022',
    outDir: 'dist-standalone',
    emptyOutDir: true,
    // No sourcemap: it would be a second file, which is the one thing this
    // target may not produce.
    sourcemap: false,
    // Every asset becomes a data URI rather than a file beside the HTML.
    assetsInlineLimit: Number.MAX_SAFE_INTEGER,
    cssCodeSplit: false,
    // One chunk is the *requirement* here, so the warning about it is noise
    // that trains an operator to ignore the build's output. Raised past what
    // this target can plausibly produce rather than switched off, so a build
    // that doubles still says something.
    chunkSizeWarningLimit: 20_000,
    rollupOptions: {
      output: {
        // One chunk. A `file://` page may not fetch a sibling, so a code-split
        // build is one that loads its shell and then fails to load itself.
        inlineDynamicImports: true,
        manualChunks: undefined,
      },
    },
  },
})
