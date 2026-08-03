/**
 * Which built files the service worker precaches.
 *
 * Shared by `vite.config.ts`, which calls it at the end of a build, and by
 * `test/unit/precache.test.ts`, which is the only way to check the answer
 * without publishing a wrong one first — a precache that misses a chunk is an
 * app that half-loads on a train, and one that includes too much is a first
 * visit that downloads a hundred megabytes nobody asked for.
 *
 * Three rules, and each one is a mistake that has been made by somebody:
 *
 * 1. **Only what the app is made of.** Code, styles and the shell. Anything the
 *    app *reads* — a `.metacool`, a `.mcool`, the demo datasets and track
 *    resources under `public/demo/` — is data, and data is what the viewer
 *    opens, not what it is. The demo files alone are 250 MB; precaching them
 *    would turn a page load into a download of every dataset the site ships.
 * 2. **No source maps.** They are ~12 MB of this build, they are fetched only
 *    when devtools is open, and they are useless offline for the same reason.
 * 3. **Nothing from another origin.** A remote `.metacool` is read with range
 *    requests, and a cache is the wrong shape for those (a 206 is not a
 *    response you can serve from `caches`). Those requests must reach the
 *    network untouched, which they do because they are never in this list.
 */

/**
 * Files from `public/` that are part of the app rather than data it opens.
 *
 * Named one by one, because `public/` is where both live: these three and 250 MB
 * of demo datasets and track resources sit in the same directory, and a rule
 * clever enough to tell them apart by pattern is a rule that will one day sweep
 * in a file nobody meant. Three names in a list cannot.
 *
 * The manifest earns its place: without it an installed window cannot read its
 * own name and icon offline, which is the one moment it matters.
 */
export const SHELL_PUBLIC_FILES = ['manifest.webmanifest', 'icon-192.png', 'icon-512.png']

/** Extensions the app is *made of*, as opposed to ones it reads. */
const SHELL_EXTENSIONS = ['.js', '.css', '.html', '.woff2']

/** `true` when a built file belongs in the precache. */
export function isShellAsset(fileName) {
  if (fileName.endsWith('.map')) return false
  return SHELL_EXTENSIONS.some((extension) => fileName.endsWith(extension))
}

/**
 * The precache list, as URLs the browser will actually request.
 *
 * `base` is Vite's, so a site served from `/metacooler.js/` precaches
 * `/metacooler.js/assets/…` and not `/assets/…` — the second is what a
 * sub-path deployment 404s on, and a service worker that fails to install is
 * silent about it.
 *
 * The navigation URL (`base` itself) leads, because it is what a reload asks
 * for and `index.html` is only its alias.
 */
export function precacheUrls(fileNames, base = '/') {
  const prefix = base.endsWith('/') ? base : `${base}/`
  const assets = [...fileNames]
    .filter(isShellAsset)
    .sort()
    .map((name) => `${prefix}${name}`)
    .filter((url) => url !== `${prefix}index.html`)
  const shell = SHELL_PUBLIC_FILES.map((name) => `${prefix}${name}`)
  return [prefix, ...assets, ...shell]
}
