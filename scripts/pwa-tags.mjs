/**
 * Take the three installability tags out of a built `index.html`.
 *
 * Shared by the two builds that are *not* the site: `vite.desktop.config.ts`,
 * whose renderer is already an application, and `vite.pinned.config.ts`, whose
 * output is one archived commit of the site rather than the site itself.
 * Written as one plugin in one file rather than twice, because the second copy
 * is the one that gets a regex fixed in it and the first is the one that ships.
 *
 * None of the three tags means anything in either build. A manifest describes
 * how a *site* would like to be installed, `theme-color` tints browser chrome
 * that a packaged window does not have, and `apple-touch-icon` is an iOS home
 * screen. Left in, the manifest and the touch icon are worse than inert — they
 * are links to files neither build emits (`publicDir: false`), so the page
 * opens with failed requests on the console of an app whose whole claim is that
 * it needs no network.
 *
 * For the pinned build there is a second reason, and it is the one that
 * matters: an archived commit must not be installable. Two builds of the same
 * app offering themselves to the same browser under the same name is a dock
 * icon that opens a version of the viewer the user pinned once, in July, to
 * check a figure.
 *
 * The favicon stays, in every build. It is a data URI, so there is no file for
 * it to fail to find, and a packaged renderer resolves it exactly as the site
 * does — which is the reason it is a data URI and not a fourth thing in
 * `public/`.
 *
 * **A note takes the manifest's place**, rather than the tags leaving a silent
 * gap. Somebody reading a stripped document — usually while working out why
 * there is no service worker — should find a sentence saying the tags were
 * removed on purpose, and where.
 *
 * The **anchor for that note is the manifest link itself**, and it is worth
 * saying why, because it was not always. The note used to replace the paragraph
 * in `index.html` that described the three tags, matched by the string
 * `src/pwa.ts` inside it — until a documentation pass removed the paragraph, at
 * which point the substitution matched nothing and the note stopped being
 * emitted. Nothing caught it: the tags were still stripped, every build check
 * still passed, and only the sentence explaining the absence was gone. Prose is
 * the wrong thing to key on, because prose is the thing people edit. A tag is
 * not: `index.html` cannot lose its manifest link without the site losing its
 * manifest.
 *
 * Doing *less* than this claims is caught downstream in any case, by
 * `indexHtmlProblems` — both stripped links are root-absolute, which is the rule
 * that catches a survivor.
 *
 * `apply: 'build'` because `transformIndexHtml` also runs in dev, and dev is
 * still the browser.
 */

/** The substitution itself, as a string function, so a test can run it. */
export function stripPwaTagsFrom(html) {
  return html
    // The note stands where the manifest link stood, at its indentation, and
    // *not* globally: a second manifest link is not a case worth writing code
    // for, and one that somehow existed would survive into a root-absolute
    // reference, which `indexHtmlProblems` refuses out loud. Consuming its own
    // anchor is also what makes this idempotent — run twice, there is no link
    // left to match and no second note.
    .replace(
      /^([ \t]*)<link\s+rel="manifest"[^>]*>\r?\n?/im,
      '$1<!-- The manifest, touch-icon and theme-color tags are stripped for this build. -->\n',
    )
    .replace(/^[ \t]*<link\s+rel="apple-touch-icon"[^>]*>\r?\n?/gim, '')
    .replace(/^[ \t]*<meta\s+name="theme-color"[^>]*>\r?\n?/gim, '')
}

/** The same thing as a Vite plugin, which is how both configs use it. */
export function stripPwaTags() {
  return {
    name: 'metacooler-strip-pwa-tags',
    apply: 'build',
    transformIndexHtml(html) {
      return stripPwaTagsFrom(html)
    },
  }
}
