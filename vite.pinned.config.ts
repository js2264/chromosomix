/**
 * The third invocation of the bundler, over the same source: **one archived
 * commit of the site**, built to be served from `…/v/<commit>/`.
 *
 * This is what makes the version dropdown in `src/ui/VersionPicker.ts` point at
 * anything. The site root always serves the newest build; every push also
 * builds this copy of itself under its own commit, and the deploy workflow
 * keeps the copies from previous pushes beside it, so a reader who says "this
 * looked different last week" can go and look at last week.
 *
 * A *spread* of `vite.config.ts`, exactly like `vite.desktop.config.ts` and for
 * exactly the same reason: the web build is what GitHub Pages publishes, and
 * two configs written side by side drift apart in the direction of "it works on
 * the website". Five keys are overridden; everything else — the aliases, the
 * `optimizeDeps` exclusion that keeps h5wasm's `.wasm` a real file, the ES
 * worker format, the build target, the version stamp — is whatever the site is
 * built with today.
 *
 * The four differences from the site build, all of them consequences of the
 * same fact — this is a *copy*, and the site is the original:
 *
 * 1. **No service worker.** The plugin list is replaced, so `sw.js` is never
 *    emitted, and `registerServiceWorker()` refuses to run from a pinned base
 *    in any case. Two builds of one app registering workers under nested scopes
 *    is a cache that outlives the reason anyone opened the old build.
 * 2. **Not installable.** `stripPwaTags()` takes the manifest and touch-icon
 *    links out for the reasons written where it lives — the sharpest being that
 *    a dock icon must not open a version somebody pinned once to check a figure.
 * 3. **No data.** `publicDir` is off. The 250 MB of demo datasets are on the
 *    bucket now, which every archived copy reaches exactly as the live build
 *    does, so there is nothing in `public/` left to exclude — but archiving a
 *    directory of that size per commit would exhaust the 1 GB Pages budget in
 *    four pushes, which is why the switch stays off and is asserted after the
 *    build rather than trusted.
 * 4. **No source maps.** ~13 MB of the ~19 MB a build weighs. They earn their
 *    place on the site, where a console error in the field is worth reading;
 *    they do not earn it twenty times over in an archive whose whole point is
 *    to stay small enough to keep.
 *
 * What is left is ~5 MB per commit, most of it the HDF5 build — and that chunk
 * is content-hashed and identical between builds, so the archive branch stores
 * one copy of it however many commits are kept.
 */

import { readFileSync } from 'node:fs'
import { defineConfig, type Plugin } from 'vite'

import base from './vite.config'
import { stripPwaTags } from './scripts/pwa-tags.mjs'

/**
 * Where this copy will be served from, passed in by the deploy workflow.
 *
 * Vite writes asset URLs at build time, so a wrong base here is a blank page
 * with three 404s — and unlike the site build there is no sensible default to
 * fall back to, because the answer contains a commit hash. Checked rather than
 * defaulted: the shape is `<site base>v/<commit>/`, and anything else is a
 * mistake worth failing the build over.
 */
const PINNED_BASE = process.env.PINNED_BASE ?? ''
const SHAPE = /^\/(?:[\w.-]+\/)*v\/[0-9a-f]{7,40}\/$/
if (!SHAPE.test(PINNED_BASE)) {
  throw new Error(
    `PINNED_BASE must look like /<site base>v/<commit>/ — got ${JSON.stringify(PINNED_BASE)}. ` +
      'It is the sub-path this archived build will be served from, and Vite bakes it into ' +
      'every asset URL, so there is nothing to guess.',
  )
}

/*
 * There used to be a `SITE_BASE` here, stripping `v/<commit>/` off the base to
 * find the site root, because that is where the demo data was. Nothing needs it
 * now: the data is on the bucket, and the version manifest is fetched at
 * runtime by `src/versions.ts`, which derives the site root from the URL the
 * build is actually being served from — which is the more robust of the two,
 * since it is right even for an archived build opened from a mirror.
 */

/**
 * The one file from `public/` an archived build still needs.
 *
 * `markUrl()` in `src/ui/mark.ts` asks for `<base>icon-192.png`, and with
 * `publicDir` off there is nothing to answer with — a broken image in the
 * header, which is the first thing anyone would notice and the last thing they
 * would attribute to a build flag. Emitted from the same file the site copies,
 * so there is no second drawing of the mark; 15 KB against a 5 MB build.
 *
 * Pointing it back at the site root instead would work today and break the
 * moment someone opens an archived build from a mirror, so the copy stays.
 */
function shellIcon(): Plugin {
  return {
    name: 'metacooler-pinned-shell-icon',
    apply: 'build',
    generateBundle() {
      this.emitFile({
        type: 'asset',
        fileName: 'icon-192.png',
        source: readFileSync(new URL('./public/icon-192.png', import.meta.url)),
      })
    },
  }
}

export default defineConfig({
  ...base,
  base: PINNED_BASE,
  publicDir: false,
  plugins: [stripPwaTags(), shellIcon()],
  define: {
    ...base.define,
    // `__DEMO_BASE__` is deliberately *not* overridden. It used to be
    // `SITE_BASE` — root-relative, because an archived build was served from the
    // same site as the 250 MB of data it pointed at, and a hard-coded origin
    // would have been one more thing to get wrong when the site moved. The data
    // is on the bucket now, which an archived build reaches exactly as the live
    // one does, so the spread above carries the web build's empty value and
    // `demoExamples()` falls through to `DEMO_BUCKET`.
    //
    // Leaving the old line in place would have been the subtle failure: it
    // named the *site root*, and `demoExamples()` used to append the `demo/`
    // segment itself. It does not any more — the segment is part of the bucket
    // prefix — so `SITE_BASE` would now build `/<repo>/yeast/…`, a 404 on every
    // example, in the one build nobody opens for months.
  },
  build: {
    ...base.build,
    outDir: 'dist-pinned',
    emptyOutDir: true,
    sourcemap: false,
  },
})
