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

import {
  isStaleShell,
  parseVersions,
  pullLabel,
  pullPath,
  splitBase,
  versionLabel,
  versionPath,
} from '@/versions'

describe('splitBase', () => {
  it('reads the commit and the site out of an archived base', () => {
    expect(splitBase('/metacooler.js/v/a1b2c3d/')).toEqual({
      site: '/metacooler.js/',
      commit: 'a1b2c3d',
      pull: null,
    })
    // A user or org site, served from the root.
    expect(splitBase('/v/a1b2c3d/')).toEqual({ site: '/', commit: 'a1b2c3d', pull: null })
    // A repository big enough that `--short` gives more than seven.
    expect(splitBase('/metacooler.js/v/a1b2c3d4e5/')).toEqual({
      site: '/metacooler.js/',
      commit: 'a1b2c3d4e5',
      pull: null,
    })
  })

  it('reads the pull request out of a preview base, and the site with it', () => {
    expect(splitBase('/metacooler.js/pr/12/')).toEqual({
      site: '/metacooler.js/',
      commit: null,
      pull: 12,
    })
    expect(splitBase('/pr/7/')).toEqual({ site: '/', commit: null, pull: 7 })
    // Not a directory a preview is ever published in.
    for (const base of ['/metacooler.js/pr/0/', '/metacooler.js/pr/012/', '/metacooler.js/pr/x/', '/metacooler.js/pr/12']) {
      expect(splitBase(base).pull).toBeNull()
    }
  })

  it('says a plain base is pinned to nothing', () => {
    for (const base of ['/', '/metacooler.js/', './']) {
      expect(splitBase(base)).toEqual({ site: base, commit: null, pull: null })
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

describe('pullPath', () => {
  it('sends a preview to its own directory, and round-trips with splitBase', () => {
    expect(pullPath('/metacooler.js/', 12)).toBe('/metacooler.js/pr/12/')
    expect(splitBase(pullPath('/', 3))).toEqual({ site: '/', commit: null, pull: 3 })
  })
})

describe('the previews in a manifest', () => {
  const manifest = {
    latest: 'a1b2c3d',
    versions: [{ commit: 'a1b2c3d', version: '0.12.0', date: '2026-09-11T10:00:00Z', subject: 'x', tag: '' }],
    pulls: [
      { number: 12, commit: 'b2c3d4e', title: 'Remote sources', branch: 'claude/remote', date: '2026-09-11T11:00:00Z' },
      { number: 40, commit: 'c3d4e5f', title: 'Later', branch: 'later', date: '2026-09-12T11:00:00Z' },
      { number: 40, commit: 'ffffff1', title: 'dup', branch: 'dup', date: '' },
      { number: 0, commit: 'd4e5f60', title: 'not a number', branch: '', date: '' },
      { number: 13, commit: 'not-a-commit', title: 'no dir', branch: '', date: '' },
    ],
  }

  it('reads them newest first, one per number, dropping what cannot name a directory', () => {
    const read = parseVersions(manifest)
    expect(read?.pulls.map((pull) => pull.number)).toEqual([40, 12])
    expect(read?.pulls[0]?.commit).toBe('c3d4e5f')
  })

  it('reads a manifest written before previews existed as one with none', () => {
    const { pulls: _pulls, ...older } = manifest
    expect(parseVersions(older)?.pulls).toEqual([])
  })

  it('labels a preview by its number and commit, then its title', () => {
    expect(pullLabel({ number: 12, commit: 'b2c3d4e', title: 'Remote sources', branch: 'x', date: '' })).toBe(
      'PR #12 · b2c3d4e — Remote sources',
    )
    expect(pullLabel({ number: 12, commit: 'b2c3d4e', title: '', branch: 'x', date: '' })).toBe('PR #12 · b2c3d4e')
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
    expect(splitBase(path)).toEqual({ site: '/metacooler.js/', commit: 'a1b2c3d', pull: null })
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

describe('isStaleShell', () => {
  it('is true when the root serves a build newer than the one running', () => {
    // The reported bug: at the site root, a worker answering with a shell it
    // cached two deploys ago. The menu showed 0.6.0 selected with 0.6.1 marked
    // latest, and picking 0.6.1 navigated to the root — which that same worker
    // answered from the same cache, for ever.
    expect(isStaleShell('c797c1e', 'e98eaf7', null)).toBe(true)
  })

  it('is false when the running build is what the root publishes', () => {
    expect(isStaleShell('e98eaf7', 'e98eaf7', null)).toBe(false)
  })

  it('is false on an archived build, however old it is', () => {
    // A pinned build is *meant* to be older than the root, and it is served
    // from its own directory rather than from the root's cache. Calling that
    // stale would drop a working worker on every visit to one.
    expect(isStaleShell('c797c1e', 'e98eaf7', 'c797c1e')).toBe(false)
  })

  it('is false when the build cannot say what it is', () => {
    // A tarball build, or a test: an unknown answer must not become an
    // accusation, and the coarse recovery it unlocks must not fire on a guess.
    expect(isStaleShell('', 'e98eaf7', null)).toBe(false)
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
