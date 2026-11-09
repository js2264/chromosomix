/**
 * Which build of the documentation this is, from the environment the docs
 * workflow sets (`.github/workflows/docs.yml`, SPECS §32). Read by the Astro
 * config and by the components, at build time; a local build with nothing set
 * is the build of `main` at the root, which is what a reader working on the
 * documentation wants to look at.
 *
 *   DOCS_VERSION   `dev` for main, or a release's tag: `v0.20.0`
 *   DOCS_BASE      where this copy is served: `/dev/`, `/v0.20.0/`, or `/` for
 *                  the copy of the latest release at the root
 *   DOCS_APP_URL   the app this copy opens: the live site for main and for the
 *                  root copy, the release's own pinned build for a release
 *   DOCS_COMMIT    the commit it was built from, for the footer
 *   DOCS_PREVIEW   the pull request a preview copy is of, a number: set only
 *                  by the preview workflow, for the copy served beside that
 *                  pull request's app at `pr/<number>/docs/` (SPECS §32.5)
 */

const env = process.env

/** `/dev`, `dev/` and `dev` are all `/dev/`. */
function asBase(value) {
  const trimmed = (value ?? '/').trim().replace(/^\/+|\/+$/g, '')
  return trimmed === '' ? '/' : `/${trimmed}/`
}

export const VERSION = (env.DOCS_VERSION ?? 'dev').trim() || 'dev'
export const IS_DEV = VERSION === 'dev'
export const BASE = asBase(env.DOCS_BASE)
export const APP_URL = (env.DOCS_APP_URL ?? 'https://chromosomix.app/').trim()
export const COMMIT = (env.DOCS_COMMIT ?? '').trim()

/** The site every copy is a part of, and the address of its manifest. */
export const SITE = 'https://doc.chromosomix.app'
export const MANIFEST = '/versions.json'

/** The repository, for edit links and links to its files. */
export const REPOSITORY = 'https://github.com/js2264/chromosomix'

/** The number in `DOCS_PREVIEW`, or `null` for anything that is not a pull request's. */
export function previewOf(value) {
  const number = Number((value ?? '').trim())
  return Number.isInteger(number) && number > 0 ? number : null
}

/**
 * The pull request this copy previews, or `null` for every published copy.
 *
 * A preview is main's copy in every other respect — unreleased, kept out of
 * search engines — but it is served beside the pull request's app on
 * chromosomix.app, where `/versions.json` is the app's manifest and not this
 * site's: so it carries no version menu, and says what it is in a banner of its
 * own rather than offering the latest release.
 */
export const PREVIEW = previewOf(env.DOCS_PREVIEW)

/** The pull request's page, for a preview's banner and footer. */
export const PREVIEW_URL = PREVIEW === null ? null : `${REPOSITORY}/pull/${PREVIEW}`

/** How this copy names itself in its header: `v0.20.0`, `dev` for main, `#158` for a preview. */
export const VERSION_LABEL = PREVIEW !== null ? `#${PREVIEW}` : IS_DEV ? 'dev' : VERSION

/**
 * Whether to check every internal link: on wherever the copy is served at the
 * root, which is the build pull requests and local builds make. A copy under a
 * version's path is the same pages, already checked; the validator would ask
 * there for links that carry the path, which the pages do not write
 * (`base-links.mjs` adds it).
 */
export const VALIDATE_LINKS = BASE === '/' && env.DOCS_VALIDATE_LINKS !== 'false'

/** `path` under this copy's base: `withBase('/files/opening/')`. */
export function withBase(path) {
  if (!path.startsWith('/') || path.startsWith('//')) return path
  return BASE === '/' ? path : `${BASE.slice(0, -1)}${path}`
}
