/**
 * A picture of the app that can become the app (SPECS §32.4).
 *
 * A page marks one by the picture's title — `live:` and then the part of a
 * link to the app after its address, `#uri=…` or `?config=…`, the view the
 * picture shows:
 *
 * ```md
 * ![What it shows](../../../assets/screens/browse/x.webp "live: #uri=https://…&view=region&region=IV")
 * ```
 *
 * The build keeps the picture and puts a button on it (`screens.mjs`); a press
 * swaps it for the app itself, embedded (`?embed=1`, §21), on that view. Until
 * then the page loads nothing of the app: a reader who never presses pays for a
 * picture, and a printed page, a search engine and a reader without scripts
 * still have one. Each copy of the site embeds its own app — a release's copy
 * that release's pinned build (`site.mjs`'s `APP_URL`) — so the live view is
 * the version the page describes.
 *
 * Nothing to install, so the repository's own suite reads every page's links
 * through the app's own link reader (`test/unit/docs-live.test.ts`).
 */

/** The link a picture's title names, `#…` or `?…`, or `null` for a title that names none. */
export function liveLink(title) {
  if (typeof title !== 'string') return null
  const match = /^live:\s*(\S+)\s*$/.exec(title)
  if (match === null) return null
  const link = match[1]
  return link.startsWith('#') || link.startsWith('?') ? link : null
}

/** The address that embeds the app at `app` on `link`: the link with `embed=1` first in its query. */
export function embedAddress(app, link) {
  return link.startsWith('?') ? `${app}?embed=1&${link.slice(1)}` : `${app}?embed=1${link}`
}

/** The address of the same view in the full app, for a tab of its own. */
export function viewerAddress(app, link) {
  return `${app}${link}`
}
