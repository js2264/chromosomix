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

/** How this copy names itself in its header: `v0.20.0`, or `dev` for main. */
export const VERSION_LABEL = IS_DEV ? 'dev' : VERSION

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
