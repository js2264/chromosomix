/**
 * Which site an archived build was made for, and how to move it to another.
 *
 * Vite bakes the base an archived build is served from into its asset URLs,
 * its worker URLs and the `import.meta.env.BASE_URL` it reads its own place
 * from (`src/versions.ts`), so a copy built for `/metacooler.js/v/a1b2c3d/`
 * and served from `/v/a1b2c3d/` is a blank page with a 404 for every script.
 * That is exactly what happens to every build on the `pages-archive` branch
 * the day the site moves — to a custom domain, where it is served from `/`,
 * or to a renamed repository — because they were built once, for the old
 * address, and are only ever copied after that.
 *
 * Rebuilding thirty old commits to fix one string is not an option worth
 * having: some of them no longer build the way they did. The string is the
 * same everywhere it appears and nothing else in a bundle looks like it — a
 * base followed by `v/<commit>/` or `pr/<number>/` — so rewriting it is exact.
 *
 * Builds from before `src/versions.ts` derived the site root from `BASE_URL`
 * also carry that root on its own, as a quoted constant (`"/metacooler.js/"`),
 * for the manifest and the way back to the newest build. That one is rewritten
 * only when quoted and only when it is not `/`: a quoted `"/"` is in every
 * bundle for a hundred other reasons, so a build made for the root cannot have
 * its root constant moved, and none can — every build that carries one was made
 * for a sub-path, and the site has been at the root only from the custom domain
 * on.
 *
 * Pure functions over strings; `archive-rebase.mjs` walks the directories.
 */

/** The two kinds of copy the archive holds, by the directory each lives in. */
export const ARCHIVE_KINDS = /** @type {const} */ (['v', 'pr'])

/** A directory name that is a build rather than a release alias. */
const BUILD_NAME = {
  v: /^[0-9a-f]{7,40}$/,
  pr: /^[1-9][0-9]{0,6}$/,
}

/** Whether `name`, under `kind`, is a build this module can move. */
export function isBuildDirectory(kind, name) {
  return BUILD_NAME[kind]?.test(name) ?? false
}

/** Files a base can be baked into. Everything else (the icon) is left alone. */
const TEXT = /\.(?:html|js|mjs|css|json|webmanifest)$/

/** Whether a built file is text a base could be baked into. */
export function isTextAsset(name) {
  return TEXT.test(name)
}

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * The site root a build was made for, read off its own `index.html`.
 *
 * The document loads its entry script from `<site>v/<commit>/assets/…` (or
 * `<site>pr/<number>/assets/…`), so whatever stands before the build's own
 * directory is the site it was built for. `null` when no asset URL names the
 * directory — not a build this module understands, and therefore one it must
 * not touch.
 */
export function bakedSiteBase(html, kind, name) {
  const own = `${kind}/${name}/assets/`
  const match = new RegExp(`(?:src|href)="([^"]*?)${escapeRegExp(own)}`).exec(html)
  if (match === null) return null
  const site = match[1]
  return site.startsWith('/') && site.endsWith('/') ? site : null
}

/**
 * One file of a build, moved from the site it was made for to another.
 *
 * `from` and `to` are site roots (`/metacooler.js/`, `/`); the build's own
 * directory is `kind`/`name`. Returns the text unchanged when the two roots are
 * the same, which is what makes running it on every deploy safe.
 */
export function rebaseText(text, { from, to, kind, name }) {
  if (from === to) return text
  const own = `${kind}/${name}/`
  let out = text.split(`${from}${own}`).join(`${to}${own}`)
  if (from !== '/') {
    for (const quote of ['"', "'", '`']) out = out.split(`${quote}${from}${quote}`).join(`${quote}${to}${quote}`)
  }
  return out
}
