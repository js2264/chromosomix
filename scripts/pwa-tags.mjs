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
 * The comment goes with them, and that is not tidiness. It says the app is
 * installable and works offline after the first visit; in these builds there is
 * no manifest and no service worker, so leaving it behind ships a paragraph
 * that is false about the artifact it is inside — read, eventually, by whoever
 * is trying to work out why there is no worker.
 *
 * Matched on the tags rather than on the comment's wording, with the comment
 * removed only as the block that precedes them: if `index.html` is reworded
 * this silently does less, and doing less here is caught by
 * `indexHtmlProblems` — both stripped links are root-absolute, which is the
 * rule that catches them.
 *
 * `apply: 'build'` because `transformIndexHtml` also runs in dev, and dev is
 * still the browser.
 */

/** The substitution itself, as a string function, so a test can run it. */
export function stripPwaTagsFrom(html) {
  return html
    .replace(
      /^[ \t]*<!--(?:(?!-->)[\s\S])*?`src\/pwa\.ts`(?:(?!-->)[\s\S])*?-->\r?\n?/m,
      '    <!-- The manifest, touch-icon and theme-color tags are stripped for this build. -->\n',
    )
    .replace(/^[ \t]*<link\s+rel="manifest"[^>]*>\r?\n?/gim, '')
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
