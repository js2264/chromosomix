/**
 * The second invocation of the bundler, over the same source.
 *
 * This file is deliberately a *spread* of `vite.config.ts` rather than an
 * edited copy of it. That is the whole guarantee the desktop target rests on:
 * the web build is what GitHub Pages publishes, `deploy.yml` runs `npm run
 * build` and nothing here can reach it. Five keys are overridden and everything
 * else — the aliases, the `optimizeDeps` exclusion that keeps h5wasm's `.wasm`
 * a real file, the ES worker format, the build target — is whatever the web
 * build is using today, including changes made to it after this file was
 * written. Copying those values would mean two configs drifting apart, and the
 * drift would present as "it works on the website".
 *
 * Two things that look like alternatives are not:
 *
 * - **`--mode desktop` is wrong.** Vite derives `isProduction` from the mode,
 *   so naming a mode other than `production` flips `import.meta.env.PROD` to
 *   false — which turns off the very guard in `src/pwa.ts` this build depends
 *   on, and switches the app into dev behaviour inside a packaged binary.
 * - **`BASE_PATH=./ vite build` is wrong.** The web config reads that variable,
 *   but a `VAR=value command` prefix is not parsed by the default shell on the
 *   Windows runner, so the release job would silently build with base `/`.
 */

import { defineConfig, type Plugin } from 'vite'

import base from './vite.config'

/**
 * Take the three installability tags out of the packaged `index.html`, and the
 * comment that introduces them.
 *
 * None of them means anything in a window that is already an application: a
 * manifest describes how a *site* would like to be installed, `theme-color`
 * tints browser chrome that is not there, and `apple-touch-icon` is an iOS home
 * screen. Left in, the manifest and the touch icon are worse than inert — they
 * are links to files this build does not emit (`publicDir: false`), so the
 * renderer opens with failed requests on the console of an app whose whole claim
 * is that it needs no network.
 *
 * The favicon stays, in every build. It is a data URI, so there is no file for
 * it to fail to find, and a packaged renderer resolves it exactly as the site
 * does — which is the reason it is a data URI and not a fourth thing in
 * `public/`.
 *
 * The comment goes with them, and that is not tidiness. It says the app is
 * installable and works offline after the first visit; in this build there is no
 * manifest and no service worker, so leaving it behind ships a paragraph that is
 * false about the artifact it is inside — read, eventually, by whoever is trying
 * to work out why there is no worker.
 *
 * Matched on the tags rather than on the comment's wording, with the comment
 * removed only as the block that precedes them: if `index.html` is reworded this
 * silently does less, and doing less here is caught by `indexHtmlProblems` —
 * both stripped links are root-absolute, which is the rule that catches them.
 *
 * `apply: 'build'` because `transformIndexHtml` also runs in dev, and dev is
 * still the browser.
 */
function stripPwaTags(): Plugin {
  return {
    name: 'metacooler-strip-pwa-tags',
    apply: 'build',
    transformIndexHtml(html) {
      return html
        .replace(
          /^[ \t]*<!--(?:(?!-->)[\s\S])*?`src\/pwa\.ts`(?:(?!-->)[\s\S])*?-->\r?\n?/m,
          '    <!-- The manifest, touch-icon and theme-color tags are stripped for the desktop build. -->\n',
        )
        .replace(/^[ \t]*<link\s+rel="manifest"[^>]*>\r?\n?/gim, '')
        .replace(/^[ \t]*<link\s+rel="apple-touch-icon"[^>]*>\r?\n?/gim, '')
        .replace(/^[ \t]*<meta\s+name="theme-color"[^>]*>\r?\n?/gim, '')
    },
  }
}

export default defineConfig({
  ...base,
  // Relative, so the renderer asks for `./assets/…` and the protocol handler
  // can be rooted wherever it likes. A root-absolute `/` also works today, but
  // only because the handler happens to serve from the renderer directory —
  // `./` removes that coupling, and it is greppable, which is what lets
  // `desktop-shape.mjs` assert it.
  base: './',
  // The 250 MB of demo datasets in `public/` are the app's *data*, and this
  // build reads them over the network like any other remote file. This is the
  // first of the two guards that keep them out of the installer; the second
  // reads the packed asar, because a config is a claim and the archive is the
  // answer.
  publicDir: false,
  // Replaces the web plugin list entirely: the service worker plugin is not
  // here, so `sw.js` is never emitted for this target. That is guard one of
  // three (see `src/pwa.ts`).
  plugins: [stripPwaTags()],
  define: {
    ...base.define,
    __APP_TARGET__: JSON.stringify('desktop'),
    // The canonical final origin, not `pkg.homepage`. The GitHub Pages URL
    // answers 301 to the custom domain *without* an `Access-Control-Allow-Origin`
    // header on the redirect, and a cross-origin fetch is blocked before the
    // redirect is followed — so pointing this at `homepage` ships a picker in
    // which every example errors, which is the first thing a new user clicks.
    __DEMO_BASE__: JSON.stringify(process.env.DEMO_BASE ?? 'https://jserizay.com/metacooler.js/'),
  },
  build: {
    ...base.build,
    outDir: 'dist-electron/renderer',
    emptyOutDir: true,
    // No source maps: they are ~12 MB, they are excluded from the package
    // anyway, and there is no devtools to fetch them in a packaged build.
    sourcemap: false,
  },
})
