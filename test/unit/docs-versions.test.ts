/**
 * Which copies of the documentation the site holds, and what its root is
 * (SPECS §32, `scripts/docs-versions.mjs`).
 *
 * The rule whose mistake costs most is the root's: it is the copy every link
 * to doc.chromosomix.app without a version lands on, and it must be the
 * highest release's — not the most recently published one, which a fix for an
 * older line would be. The other rule worth pinning is what a new root copy may
 * replace: everything that is the old root copy's, and never a version's
 * directory or a file the site itself owns.
 */

import { describe, expect, it } from 'vitest'

import {
  DEV,
  EMPTY,
  collisions,
  isCopyDirectory,
  isRelease,
  newerFirst,
  parseManifest,
  robotsTxt,
  rootBeforeFirstRelease,
  rootCopyEntries,
  serialise,
  withDev,
  withRelease,
} from '../../scripts/docs-versions.mjs'

describe('a release that has a copy', () => {
  it('is v and three numbers', () => {
    expect(isRelease('v0.20.0')).toBe(true)
    expect(isRelease('v1.2.30')).toBe(true)
    for (const name of ['0.20.0', 'v0.20', 'v0.20.0-rc.1', 'v01.2.3', 'dev', 'latest', '', null]) expect(isRelease(name)).toBe(false)
  })

  it('is ordered by version, not by text', () => {
    const versions = ['v0.9.0', 'v0.20.0', 'v0.19.1', 'v0.10.0', 'v1.0.0']
    expect([...versions].sort(newerFirst)).toEqual(['v1.0.0', 'v0.20.0', 'v0.19.1', 'v0.10.0', 'v0.9.0'])
  })
})

describe('the manifest', () => {
  it('starts empty, and an unreadable one is empty', () => {
    expect(parseManifest('')).toEqual(EMPTY)
    expect(parseManifest('{not json')).toEqual(EMPTY)
    expect(parseManifest('null')).toEqual(EMPTY)
  })

  it('makes the highest version the latest, whatever order they were published in', () => {
    let manifest = parseManifest('')
    manifest = withRelease(manifest, { version: 'v0.20.0', commit: 'abc1234', date: '2026-11-20' })
    manifest = withRelease(manifest, { version: 'v0.19.1', commit: 'def5678', date: '2026-11-21' })
    expect(manifest.latest).toBe('v0.20.0')
    expect(manifest.releases.map((row) => row.version)).toEqual(['v0.20.0', 'v0.19.1'])
    expect(manifest.releases[1].path).toBe('/v0.19.1/')
  })

  it('replaces a release published again rather than listing it twice', () => {
    let manifest = withRelease(parseManifest(''), { version: 'v0.20.0', commit: 'abc1234' })
    manifest = withRelease(manifest, { version: 'v0.20.0', commit: 'fed4321' })
    expect(manifest.releases).toHaveLength(1)
    expect(manifest.releases[0].commit).toBe('fed4321')
  })

  it('refuses a copy for anything but a release', () => {
    expect(() => withRelease(parseManifest(''), { version: 'v0.20.0-rc.1' })).toThrow(/not a release/)
  })

  it('records main beside the releases without touching them', () => {
    const released = withRelease(parseManifest(''), { version: 'v0.20.0', commit: 'abc1234' })
    const both = withDev(released, { commit: '1234abc', date: '2026-11-22' })
    expect(both.dev).toEqual({ path: `/${DEV}/`, commit: '1234abc', date: '2026-11-22' })
    expect(both.releases).toEqual(released.releases)
    expect(both.latest).toBe('v0.20.0')
  })

  it('reads back what it writes, and works out the latest again from the rows', () => {
    const manifest = withDev(withRelease(parseManifest(''), { version: 'v0.20.0', commit: 'abc1234', date: 'd' }), { commit: '1234abc' })
    expect(parseManifest(serialise(manifest))).toEqual(manifest)
    const edited = JSON.parse(serialise(manifest))
    edited.latest = 'v9.9.9'
    edited.releases.push({ version: 'not-a-release' }, { version: 'v0.20.0', commit: 'zzz' })
    expect(parseManifest(JSON.stringify(edited))).toEqual(manifest)
  })
})

describe('the root', () => {
  it('is everything but the copies and the site’s own files', () => {
    const names = ['index.html', '_astro', 'pagefind', 'start', 'v0.19.0', 'v0.20.0', 'dev', 'versions.json', 'CNAME', '.nojekyll', 'robots.txt', 'README.md', '.git', '404.html']
    expect(rootCopyEntries(names)).toEqual(['index.html', '_astro', 'pagefind', 'start', '404.html'])
    expect(isCopyDirectory('v0.20.0')).toBe(true)
    expect(isCopyDirectory('dev')).toBe(true)
    expect(isCopyDirectory('start')).toBe(false)
  })

  it('refuses a root copy that would land on a copy or a file of the site', () => {
    expect(collisions(['index.html', '_astro', 'start'])).toEqual([])
    expect(collisions(['index.html', 'dev', 'CNAME', 'v1.0.0'])).toEqual(['dev', 'CNAME', 'v1.0.0'])
  })

  it('sends a reader to main’s copy before the first release', () => {
    const page = rootBeforeFirstRelease()
    expect(page).toContain('url=/dev/')
    expect(page).toContain('noindex')
  })

  it('lets crawlers in, so that the noindex and the canonical links are read', () => {
    expect(robotsTxt()).toMatch(/^User-agent: \*\nAllow: \/\n/)
    expect(robotsTxt()).not.toMatch(/Disallow/)
  })
})
