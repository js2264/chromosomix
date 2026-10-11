/**
 * The sixth invocation of the bundler, over the same source: **the copy that
 * goes to npm**, built to be served from wherever somebody puts it.
 *
 * This is what makes `?embed=1` usable by a page whose author does not want to
 * depend on anybody's hosting — including ours. A published tarball is an
 * immutable, checksummed copy of one version of the viewer: unpack it into a
 * lab site, a portal, a course page, an institutional server, or point a frame
 * at it on a registry CDN. The site at GitHub Pages remains what the project
 * runs; this is what other people can run.
 *
 * A *spread* of `vite.config.ts`, exactly like `vite.pinned.config.ts` and
 * `vite.desktop.config.ts`, and for the same reason those give: the web build
 * is what the deploy workflow publishes, and two configs written side by side
 * drift apart in the direction of "it works on the website".
 *
 * ## The one difference that is not the pinned build's
 *
 * **The base is relative.** An archived build knows exactly where it will be
 * served from — its base contains a commit hash — and bakes absolute asset URLs
 * accordingly. This build knows nothing: `/vendor/chromosomix/0.12.0/` on one
 * site, `/npm/chromosomix@0.12.0/dist/` on a CDN, `/viewer/` on the next.
 * `./` is the honest answer, and it is also the *only* one that lets one
 * published tarball serve all three without a rebuild per host.
 *
 * What it costs is one rule for whoever mounts it: **the URL has to end in a
 * slash, or name `index.html`.** A relative base resolves against the document,
 * so `…/viewer` without the slash resolves the assets one directory too high.
 * Most servers redirect; a CDN generally does not.
 *
 * ## The three it shares with the pinned build, for the same reasons
 *
 * 1. **No service worker.** A copy mounted under a path it does not own must not
 *    claim a scope there — on a CDN it would be claiming one over somebody
 *    else's package. `registerServiceWorker()` refuses a portable build in any
 *    case (`src/pwa.ts`), so the plugin list here is the second half of one
 *    decision rather than a duplicate of it.
 * 2. **Not installable.** `stripPwaTags()`, and the sharper form of its usual
 *    argument: a dock icon must not open a vendored copy of a viewer that
 *    somebody dropped into a page as a figure.
 * 3. **No source maps, no `public/`.** ~20 MB of the ~26 MB a site build weighs
 *    is maps. A tarball is downloaded by everyone who installs the package and
 *    is cached forever by a registry CDN, so the same argument the archive makes
 *    about the Pages budget applies here to somebody else's bandwidth.
 *
 * `shellIcon` puts the one file back that `publicDir: false` takes away and the
 * header actually asks for — the same pairing, and the same bug it was written
 * after, as the other two builds that switch `public/` off.
 *
 * ## Why it writes to `dist/`, which the site build also uses
 *
 * Because `files` in `package.json` and the CDN path both want the conventional
 * name, and `…/dist-package/index.html` is a URL people would type by hand.
 * The collision is made safe by never publishing what happens to be sitting
 * there: `prepack` runs this build, so `npm pack` and `npm publish` both empty
 * the directory and fill it from source, and `check-package-build.mjs` then
 * asserts the shape of what came out. A site build left in `dist/` cannot reach
 * a tarball — it would fail that check on its source maps alone.
 */

import { defineConfig } from 'vite'

import base from './vite.config'
import { cspMeta } from './scripts/csp.mjs'
import { stripPwaTags } from './scripts/pwa-tags.mjs'
import { shellIcon } from './scripts/shell-icon.mjs'

export default defineConfig({
  ...base,
  // Relative, and the guard against it silently becoming absolute again is in
  // `package-shape.mjs`: a root-absolute URL in the built document is a 404 for
  // every mount that is not the site root, which is all of them.
  base: './',
  publicDir: false,
  // The site's policy too. A copy on somebody else's server is the copy whose
  // headers we cannot know, which is the case a meta is for (`scripts/csp.mjs`).
  plugins: [stripPwaTags(), shellIcon('chromosomix-package-shell-icon'), cspMeta()],
  build: {
    ...base.build,
    emptyOutDir: true,
    sourcemap: false,
  },
})
