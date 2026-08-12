/**
 * Emit `public/icon-192.png` beside a build that has `publicDir` switched off.
 *
 * Shared by the two builds that turn `public/` off but still emit files:
 * `vite.pinned.config.ts`, whose output is one archived commit of the site, and
 * `vite.desktop.config.ts`, whose renderer is packaged into an installer. Both
 * switch it off for good reasons that have nothing to do with the mark — an
 * archived build must not be installable, and a desktop build must not carry a
 * dataset into the asar — and both then need this one file back.
 *
 * `markUrl()` in `src/ui/mark.ts` asks for `<base>icon-192.png`, and with
 * `publicDir` off there is nothing to answer with: a broken image in the header,
 * which is the first thing anyone notices and the last thing they attribute to a
 * build flag. **The desktop build shipped exactly that**, for every release that
 * had a desktop target, because the pinned config solved the problem privately
 * and the desktop config was written without knowing there was a problem to
 * solve. That is the whole reason this is a file rather than a second copy of
 * nine lines — the same argument `pwa-tags.mjs` makes for itself, arrived at the
 * other way round.
 *
 * Emitted from the file the site copies, so there is still exactly one drawing
 * of the mark, which is what `scripts/make-app-icons.py` exists to guarantee.
 * 10 KB against builds measured in megabytes.
 *
 * Pointing the header back at the site root instead would work today and break
 * the moment somebody opens an archived build from a mirror, or an installed
 * app with no network — which is the case the desktop target is *for*. So the
 * copy stays.
 *
 * The third build with `publicDir` off, `vite.standalone.config.ts`, cannot use
 * this: it may not emit a second file at all. It answers the same question with
 * the same bytes as a data URI (`__MARK_URL__`).
 */

import { readFileSync } from 'node:fs'

/**
 * @param {string} name Plugin name, so the two configs are distinguishable in
 *   a build log and in `vite --debug plugin-transform`.
 */
export function shellIcon(name) {
  return {
    name,
    // `generateBundle` also runs for nothing in dev; `apply: 'build'` is the
    // same guard `stripPwaTags()` uses, and for the same reason.
    apply: 'build',
    generateBundle() {
      this.emitFile({
        type: 'asset',
        fileName: 'icon-192.png',
        source: readFileSync(new URL('../public/icon-192.png', import.meta.url)),
      })
    },
  }
}
