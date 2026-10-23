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

import { defineConfig } from 'vite'

import base from './vite.config'
import { stripPwaTags } from './scripts/pwa-tags.mjs'
import { shellIcon } from './scripts/shell-icon.mjs'
import { thirdPartyNotices } from './scripts/third-party-notices.mjs'

export default defineConfig({
  ...base,
  // Relative, so the renderer asks for `./assets/…` and the protocol handler
  // can be rooted wherever it likes. A root-absolute `/` also works today, but
  // only because the handler happens to serve from the renderer directory —
  // `./` removes that coupling, and it is greppable, which is what lets
  // `desktop-shape.mjs` assert it.
  base: './',
  // `public/` now holds only the icons and the manifest, but this build wants
  // none of them: an installed application has its own icon and does not
  // install itself from a web manifest. Keeping the directory off is also the
  // first of the two guards that no data file reaches the installer — the
  // second reads the packed asar, because a config is a claim and the archive
  // is the answer — and that guard stays worth having whether or not there
  // happens to be a dataset in `public/` today.
  publicDir: false,
  // Replaces the web plugin list entirely: the service worker plugin is not
  // here, so `sw.js` is never emitted for this target. That is guard one of
  // three (see `src/pwa.ts`).
  //
  // `shellIcon()` puts back the one file from `public/` the renderer actually
  // asks for. Without it `markUrl()` resolves to a file that is not there and
  // the header carries a broken image — which is what every desktop release
  // before this one shipped. The pinned config had solved the same problem
  // privately; the plugin now lives in one place so the next config to switch
  // `publicDir` off inherits the fix instead of the bug.
  plugins: [stripPwaTags(), shellIcon('chromosomix-desktop-shell-icon'), thirdPartyNotices()],
  define: {
    ...base.define,
    __APP_TARGET__: JSON.stringify('desktop'),
    // The desktop app counts nothing (§31).
    __USAGE_ENDPOINT__: JSON.stringify(''),
    // `__DEMO_BASE__` is deliberately *not* overridden any more. It used to name the website,
    // because the demos were published beside the app and a renderer served
    // from `app://viewer` had to be told where the website was — and it had to
    // name the canonical origin rather than `pkg.homepage`, since the Pages URL
    // answers 301 to the custom domain without an `Access-Control-Allow-Origin`
    // header on the redirect, which blocked every example. The demos are on the
    // bucket now, which both targets reach the same way, so the special case
    // and the redirect it was avoiding are both gone. The spread above carries
    // the web build's value, `DEMO_BASE` included.
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
