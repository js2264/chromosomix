/**
 * Where the documentation is (SPECS §32): the root of doc.chromosomix.app,
 * which serves the latest release's copy — and main's, until the first release
 * that carries the site.
 *
 * Every door to it in the app — the header's book, the palette's
 * *Documentation*, *About*, the command line's `--help` — opens the root, and
 * not this build's own version's copy, because a build cannot name its own
 * copy: the site at chromosomix.app is built from main on every push and
 * carries the version of the release before it, whose copy may not exist, nor
 * describe what main now does. The root's menu is one choice away from every
 * other copy.
 */
export const DOCS_URL = 'https://doc.chromosomix.app/'
