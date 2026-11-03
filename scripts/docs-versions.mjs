/**
 * Which copies of the documentation the site holds, and what its root is
 * (SPECS §32): the rules `scripts/docs-publish.mjs` applies to the `gh-pages`
 * branch of js2264/chromosomix-docs, kept apart from it so that a test can hold
 * them (`test/unit/docs-versions.test.ts`).
 *
 * The site, as GitHub Pages serves it at doc.chromosomix.app:
 *
 *   /                the latest release's copy, built a second time for the root
 *   /v0.20.0/        each release's copy, built from its tag and kept for ever
 *   /dev/            main's copy, rebuilt on every push
 *   /versions.json   this manifest, which every copy's version menu reads
 *
 * **The latest release is the highest version, not the newest publish**, so a
 * fix released for an older line — v0.19.1 after v0.20.0 — gets its copy under
 * `/v0.19.1/` and leaves the root alone. **The root belongs to the latest
 * release's copy and nothing else**: what a new latest release's root copy
 * replaces is everything at the root that is not a version's directory or one
 * of the files the site itself owns, and a copy that would put something at the
 * root under one of those names is refused rather than allowed to overwrite it.
 * Until the first release there is no root copy, and the root sends a reader to
 * `/dev/`.
 *
 * Plain JavaScript, for the reason `versions-manifest.mjs` is: a workflow runs
 * it and a test imports it, with nothing to compile in between.
 */

/** The manifest's shape, as every copy's menu reads it (`documentation/src/components/SiteTitle.astro`). */
export const SCHEMA = 1

/** A release that has a copy: `v` and three numbers. A prerelease tag has none. */
const RELEASE = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/

/** A short or full commit hash, as the manifest records one. */
const COMMIT = /^[0-9a-f]{7,40}$/

/** Main's copy, by its directory. */
export const DEV = 'dev'

/** Files at the root that are the site's own, and no copy's. */
export const SITE_FILES = Object.freeze(['versions.json', 'CNAME', '.nojekyll', 'robots.txt', 'README.md'])

/** The site's own address, which `CNAME` says to GitHub Pages. */
export const DOMAIN = 'doc.chromosomix.app'

export const EMPTY = Object.freeze({ schema: SCHEMA, latest: null, releases: [], dev: null })

export function isRelease(version) {
  return typeof version === 'string' && RELEASE.test(version)
}

/** Newer first: `v0.20.0` before `v0.19.1` before `v0.9.0`. */
export function newerFirst(a, b) {
  const [, ...pa] = RELEASE.exec(a).map(Number)
  const [, ...pb] = RELEASE.exec(b).map(Number)
  for (let index = 0; index < 3; index += 1) if (pa[index] !== pb[index]) return pb[index] - pa[index]
  return 0
}

/** A directory at the root that holds a copy: a release's, or main's. */
export function isCopyDirectory(name) {
  return name === DEV || isRelease(name)
}

/** The names at the root that belong to the root copy: everything but the copies' directories and the site's files. */
export function rootCopyEntries(names) {
  return names.filter((name) => !isCopyDirectory(name) && !SITE_FILES.includes(name) && name !== '.git')
}

/**
 * The names in a root copy that would land on something it must not replace —
 * a copy's directory or one of the site's own files — which a publish refuses.
 */
export function collisions(names) {
  return names.filter((name) => isCopyDirectory(name) || SITE_FILES.includes(name) || name === '.git')
}

const text = (value) => (typeof value === 'string' ? value : '')

function releaseRow(entry) {
  if (typeof entry !== 'object' || entry === null || !isRelease(entry.version)) return null
  const commit = text(entry.commit)
  return {
    version: entry.version,
    path: `/${entry.version}/`,
    commit: COMMIT.test(commit) ? commit : '',
    date: text(entry.date),
  }
}

/**
 * The manifest a branch holds, read leniently: a missing or unreadable file is
 * the empty manifest, and a row that does not name a release is dropped, as
 * the menu would drop it, rather than repaired. `latest` is worked out again
 * from the rows, so a hand-edited one cannot point at a copy that is not there.
 */
export function parseManifest(source) {
  let raw
  try {
    raw = JSON.parse(source)
  } catch {
    return { ...EMPTY, releases: [] }
  }
  if (typeof raw !== 'object' || raw === null) return { ...EMPTY, releases: [] }
  const seen = new Set()
  const releases = []
  for (const entry of Array.isArray(raw.releases) ? raw.releases : []) {
    const row = releaseRow(entry)
    if (row === null || seen.has(row.version)) continue
    seen.add(row.version)
    releases.push(row)
  }
  releases.sort((a, b) => newerFirst(a.version, b.version))
  const dev =
    typeof raw.dev === 'object' && raw.dev !== null
      ? { path: `/${DEV}/`, commit: COMMIT.test(text(raw.dev.commit)) ? raw.dev.commit : '', date: text(raw.dev.date) }
      : null
  return { schema: SCHEMA, latest: releases[0]?.version ?? null, releases, dev }
}

/** The manifest with a release's copy added, or replaced where it was published before. */
export function withRelease(manifest, { version, commit, date }) {
  if (!isRelease(version)) throw new Error(`${version} is not a release: a copy is published for v<major>.<minor>.<patch> only`)
  const releases = manifest.releases.filter((row) => row.version !== version)
  releases.push({ version, path: `/${version}/`, commit: text(commit), date: text(date) })
  releases.sort((a, b) => newerFirst(a.version, b.version))
  return { schema: SCHEMA, latest: releases[0].version, releases, dev: manifest.dev }
}

/** The manifest with main's copy recorded. */
export function withDev(manifest, { commit, date }) {
  return { ...manifest, schema: SCHEMA, dev: { path: `/${DEV}/`, commit: text(commit), date: text(date) } }
}

/** The manifest as the branch stores it: stable, readable, one trailing newline. */
export function serialise(manifest) {
  return `${JSON.stringify(manifest, null, 2)}\n`
}

/**
 * What crawlers are told: everything may be read. Main's copy keeps itself out
 * of an index with a `noindex` on every page, and every release's copy names
 * the root copy's page as canonical — and a crawler only sees either if it is
 * let in, which a `Disallow` would stop.
 */
export function robotsTxt() {
  return `User-agent: *\nAllow: /\n\nSitemap: https://${DOMAIN}/sitemap-index.xml\n`
}

/** The root before the first release: a page that sends the reader to main's copy. */
export function rootBeforeFirstRelease() {
  return [
    '<!doctype html>',
    '<html lang="en">',
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    '<meta name="robots" content="noindex">',
    `<meta http-equiv="refresh" content="0; url=/${DEV}/">`,
    '<title>chromosomix documentation</title>',
    `<link rel="canonical" href="https://${DOMAIN}/${DEV}/">`,
    '</head>',
    '<body>',
    `<p>The documentation of chromosomix is at <a href="/${DEV}/">/${DEV}/</a> until its first release.</p>`,
    '</body>',
    '</html>',
    '',
  ].join('\n')
}
