/**
 * What the app believes about which build it is and which others exist.
 *
 * Two things are worth pinning here and neither needs a browser. The first is
 * the arithmetic that reads a commit out of a base path — the whole feature
 * hangs off it, it is one regex, and getting it wrong in the *permissive*
 * direction means the site root decides it is an archived build and stops
 * registering a service worker. The second is the parser, which reads a file
 * fetched over the network and written by a different commit than the one
 * reading it: every field that survives becomes a row in a menu that navigates
 * somewhere, so a lenient parser is a 404 offered from a dropdown.
 *
 * The fetch itself is not exercised. It is four lines of `try`/`catch` around
 * one `fetch`, every branch of which lands on `null`, and a test that stubs the
 * global would be testing the stub.
 */

import { describe, expect, it } from 'vitest'

import { parseVersions, splitBase, versionLabel, versionPath } from '@/versions'

describe('splitBase', () => {
  it('reads the commit and the site out of an archived base', () => {
    expect(splitBase('/metacooler.js/v/a1b2c3d/')).toEqual({
      site: '/metacooler.js/',
      commit: 'a1b2c3d',
    })
    // A user or org site, served from the root.
    expect(splitBase('/v/a1b2c3d/')).toEqual({ site: '/', commit: 'a1b2c3d' })
    // A repository big enough that `--short` gives more than seven.
    expect(splitBase('/metacooler.js/v/a1b2c3d4e5/')).toEqual({
      site: '/metacooler.js/',
      commit: 'a1b2c3d4e5',
    })
  })

  it('says a plain base is pinned to nothing', () => {
    for (const base of ['/', '/metacooler.js/', './']) {
      expect(splitBase(base)).toEqual({ site: base, commit: null })
    }
  })

  it('is not fooled by a path that merely contains a v', () => {
    // Each of these would, if matched, stop the *site* registering a service
    // worker and make its about dialog claim to be an archived build.
    for (const base of [
      '/metacooler.js/versions/', // starts with v
      '/metacooler.js/v/main/', // not a hash
      '/metacooler.js/v/a1b2c3/', // too short for `git rev-parse --short`
      '/metacooler.js/v/A1B2C3D/', // git writes lower case
      '/metacooler.js/v/a1b2c3d', // no trailing slash: not a base
    ]) {
      expect(splitBase(base).commit).toBeNull()
    }
  })
})

describe('versionPath', () => {
  it('sends the newest build to the site root, where the worker is', () => {
    expect(versionPath('/metacooler.js/', null)).toBe('/metacooler.js/')
  })

  it('sends every other build to its own directory', () => {
    expect(versionPath('/metacooler.js/', 'a1b2c3d')).toBe('/metacooler.js/v/a1b2c3d/')
  })

  it('round-trips with splitBase, which is the property that matters', () => {
    const path = versionPath('/metacooler.js/', 'a1b2c3d')
    expect(splitBase(path)).toEqual({ site: '/metacooler.js/', commit: 'a1b2c3d' })
  })
})

const entry = {
  commit: 'a1b2c3d',
  version: '0.5.1',
  date: '2026-08-05T11:22:33+02:00',
  subject: 'feat(ui): a dropdown that runs another commit',
  tag: '',
}

/** The same build, as it would be recorded if it were a release. */
const released = { ...entry, tag: 'v0.5.1' }

describe('parseVersions', () => {
  it('reads a manifest the deploy wrote', () => {
    const parsed = parseVersions({ latest: 'a1b2c3d', versions: [entry] })
    expect(parsed?.latest).toBe('a1b2c3d')
    expect(parsed?.entries).toEqual([entry])
  })

  it('refuses anything that is not a manifest', () => {
    // The realistic failures: a 404 page, a proxy's JSON, a file half written.
    for (const raw of [null, 42, 'versions', [], {}, { versions: [entry] }]) {
      expect(parseVersions(raw)).toBeNull()
    }
  })

  it('refuses a manifest whose latest is not a commit', () => {
    expect(parseVersions({ latest: 'main', versions: [entry] })).toBeNull()
  })

  it('drops a row rather than offering a link to nowhere', () => {
    const parsed = parseVersions({
      latest: 'a1b2c3d',
      versions: [
        entry,
        { commit: '../../etc', version: '0.1.0' },
        { commit: 'nothex!', version: '0.1.0' },
        'a1b2c3d',
        null,
      ],
    })
    expect(parsed?.entries.map((one) => one.commit)).toEqual(['a1b2c3d'])
  })

  it('keeps the first of two rows for one commit, since the list is newest first', () => {
    const parsed = parseVersions({
      latest: 'a1b2c3d',
      versions: [entry, { ...entry, version: '0.4.0' }],
    })
    expect(parsed?.entries).toHaveLength(1)
    expect(parsed?.entries[0]?.version).toBe('0.5.1')
  })

  it('fills in what a row does not say instead of dropping it', () => {
    // A build made where git could answer nothing is still a build somebody can
    // run; it just has less to say about itself, exactly as `buildLine()` does.
    const parsed = parseVersions({ latest: 'a1b2c3d', versions: [{ commit: 'a1b2c3d' }] })
    expect(parsed?.entries[0]).toEqual({
      commit: 'a1b2c3d',
      version: '',
      date: '',
      subject: '',
      tag: '',
    })
  })

  it('reads a release tag', () => {
    expect(parseVersions({ latest: 'a1b2c3d', versions: [released] })?.entries[0]?.tag).toBe('v0.5.1')
  })

  it('drops a tag that would not be a directory, keeping the build', () => {
    // The tag becomes a path segment — `…/v/v0.5.1/` — so this is the check
    // standing between a manifest somebody edited and a link out of the app.
    for (const tag of ['release/1.0', '../etc', '.hidden', 'a b', 42, null]) {
      const parsed = parseVersions({ latest: 'a1b2c3d', versions: [{ ...entry, tag }] })
      expect(parsed?.entries).toHaveLength(1)
      expect(parsed?.entries[0]?.tag).toBe('')
    }
  })

  it('drops a tag spelt like a commit, which would shadow a build directory', () => {
    const parsed = parseVersions({ latest: 'a1b2c3d', versions: [{ ...entry, tag: 'deadbee' }] })
    expect(parsed?.entries[0]?.tag).toBe('')
  })

  it('bounds a subject, which is arbitrary text from a commit message', () => {
    const parsed = parseVersions({
      latest: 'a1b2c3d',
      versions: [{ ...entry, subject: 'x'.repeat(400) }],
    })
    expect(parsed?.entries[0]?.subject.length).toBeLessThanOrEqual(120)
  })

  it('treats an empty list as no manifest, so one fallback serves every caller', () => {
    expect(parseVersions({ latest: 'a1b2c3d', versions: [] })).toBeNull()
  })
})

describe('versionLabel', () => {
  it('reads like the build line in the about dialog, with the date alone', () => {
    expect(versionLabel(entry, false)).toBe('0.5.1 · a1b2c3d · 2026-08-05')
  })

  it('marks the one the site root is serving', () => {
    expect(versionLabel(entry, true)).toBe('0.5.1 · a1b2c3d · 2026-08-05 — latest')
  })

  it('marks a release, which the version beside it does not', () => {
    // The point of the marker: every build between two releases reports the
    // earlier release's version, so a dozen rows say `0.5.1` and one of them
    // is `v0.5.1`. Without this they are indistinguishable.
    expect(versionLabel(released, false)).toBe('0.5.1 · a1b2c3d · 2026-08-05 — release v0.5.1')
  })

  it('marks a release that is also what the root serves', () => {
    expect(versionLabel(released, true)).toBe(
      '0.5.1 · a1b2c3d · 2026-08-05 — release v0.5.1, latest',
    )
  })

  it('names the tag rather than implying it, since it need not match the version', () => {
    expect(versionLabel({ ...entry, tag: '2026.04' }, false)).toContain('release 2026.04')
  })

  it('omits what it does not know rather than writing empty parts', () => {
    expect(
      versionLabel({ commit: 'a1b2c3d', version: '', date: '', subject: '', tag: '' }, false),
    ).toBe('a1b2c3d')
  })
})
