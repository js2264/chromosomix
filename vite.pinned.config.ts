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

import { defineConfig } from 'vite'

import base from './vite.config'
import { cspMeta } from './scripts/csp.mjs'
import { stripPwaTags } from './scripts/pwa-tags.mjs'
import { shellIcon } from './scripts/shell-icon.mjs'
import { thirdPartyNotices } from './scripts/third-party-notices.mjs'

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
// Two shapes, one kind of build: an archived push lives under `v/<commit>/`
// and a pull-request preview under `pr/<number>/` (docs/deploy.md, "Pull
// requests get a preview"). Both are copies served from a sub-path, and
// everything else about them — no worker, not installable, no data — is the
// same, which is why they share a config and a checker.
const SHAPE = /^\/(?:[\w.-]+\/)*(?:v\/[0-9a-f]{7,40}|pr\/[1-9][0-9]{0,6})\/$/
if (!SHAPE.test(PINNED_BASE)) {
  throw new Error(
    `PINNED_BASE must look like /<site base>v/<commit>/ or /<site base>pr/<number>/ — got ${JSON.stringify(PINNED_BASE)}. ` +
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

export default defineConfig({
  ...base,
  base: PINNED_BASE,
  publicDir: false,
  // The site's policy, which an archived copy keeps: it is the same page,
  // served from the same origin a few directories down (`scripts/csp.mjs`).
  plugins: [stripPwaTags(), shellIcon('chromosomix-pinned-shell-icon'), cspMeta(), thirdPartyNotices()],
  define: {
    ...base.define,
    // An archived copy counts nothing: its readers are reading a link, and its
    // counts would be the live site's under an old version (§31).
    __USAGE_ENDPOINT__: JSON.stringify(''),
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
