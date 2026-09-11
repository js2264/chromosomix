/**
 * Which past builds a deploy keeps, and which it deletes.
 *
 * The one rule in this repository whose mistakes are **not** recoverable by
 * pushing again. Everything else the deploy does is idempotent — a wrong bundle
 * is replaced by the next build — but a directory this rule drops is a build
 * nobody can get back, because it was only ever a copy of a commit that is
 * still in git and would have to be rebuilt by a runner with the same
 * toolchain. So the retention window is pinned here rather than trusted, and so
 * is the shape of the file the app reads.
 *
 * The subtle rule, and the one that was wrong first, is the version one: `npm
 * version minor` bumps `package.json` and tags *that commit*, so the release is
 * the **oldest** build carrying a version and not the newest. Keeping the
 * newest keeps a build that calls itself `0.6.0`, is labelled `0.6.0` in the
 * menu, and is not `v0.6.0` — which is worse than not keeping one at all,
 * because it is wrong rather than absent. There is a test for exactly that
 * below and it is the reason this file is longer than it looks like it needs
 * to be.
 *
 * The last test is the seam: the manifest is written by
 * `scripts/versions-manifest.mjs` in Node and read by `src/versions.ts` in the
 * browser, and those are two parsers that have to agree about one file. Running
 * the writer's output through the reader is what stops them drifting.
 */

import { describe, expect, it } from 'vitest'

import {
  EMPTY,
  KEEP_RECENT,
  droppedCommits,
  droppedTags,
  isPublishableTag,
  nextManifest,
  parseManifest,
  tagAliases,
  withPull,
  withoutPull,
  pullDirectory,
} from '../../scripts/versions-manifest.mjs'
import { parseVersions } from '@/versions'

interface Build {
  commit: string
  version: string
  date: string
  subject: string
  tag: string
}

/**
 * A build, `n` days before the end of April 2026, at version `version`.
 *
 * The date is computed rather than spelt, because these tests need `n` to order
 * *monotonically* past 30 and a `2026-04-${30 - n}` template silently stops
 * doing that at the end of the month — it produces `2026-04--30`, which sorts
 * before `2026-04-29` and quietly reverses the history under a test about
 * which build is oldest.
 */
const build = (n: number, version = '0.5.1', tag = ''): Build => ({
  commit: n.toString(16).padStart(7, 'a'),
  version,
  date: new Date(Date.UTC(2026, 3, 30) - n * 86_400_000).toISOString(),
  subject: `commit ${n}`,
  tag,
})

/** A manifest holding the given builds, newest first. */
const manifest = (...builds: Build[]): { latest: string; versions: Build[] } => ({
  latest: builds[0]?.commit ?? '',
  versions: builds,
})

/** A run of ordinary pushes, oldest first, ending at `to`. */
const pushes = (from: number, to: number, version: string, start = EMPTY) => {
  let current = start
  for (let n = from; n >= to; n -= 1) current = nextManifest(current, build(n, version))
  return current
}

describe('isPublishableTag', () => {
  it('takes the tags a release is actually called', () => {
    for (const tag of ['v0.5.1', 'v1.0.0-rc.1', '2026.04', 'v1.0.0+build.7']) {
      expect(isPublishableTag(tag)).toBe(true)
    }
  })

  it('refuses anything that would not be a directory name', () => {
    // A tag becomes a path segment beside the commits and is written into an
    // HTML page unescaped, which this character class is what makes safe.
    for (const tag of ['release/1.0', '../etc', '.hidden', '', 'a b', 'v1"><script>', 'déjà']) {
      expect(isPublishableTag(tag)).toBe(false)
    }
  })

  it('refuses a tag spelt like a commit, which would claim a build directory', () => {
    expect(isPublishableTag('a1b2c3d')).toBe(false)
  })
})

describe('parseManifest', () => {
  it('starts from empty when there is no manifest yet', () => {
    // The first deploy after this feature lands, and every deploy after the
    // archive branch is deleted on purpose.
    expect(parseManifest('')).toEqual(EMPTY)
    expect(parseManifest('not json')).toEqual(EMPTY)
    expect(parseManifest('{"latest":"a1b2c3d"}')).toEqual(EMPTY)
  })

  it('drops a row that could not name a directory', () => {
    const read = parseManifest(
      JSON.stringify({ latest: 'aaaaaa1', versions: [build(1), { commit: '../x' }, null] }),
    )
    expect(read.versions.map((one) => one.commit)).toEqual([build(1).commit])
  })

  it('drops a tag it would not publish, keeping the build', () => {
    const read = parseManifest(
      JSON.stringify({ latest: 'aaaaaa1', versions: [{ ...build(1), tag: 'release/1.0' }] }),
    )
    expect(read.versions).toHaveLength(1)
    expect(read.versions[0]?.tag).toBe('')
  })
})

describe('nextManifest', () => {
  it('puts the new build in and points latest at it', () => {
    const next = nextManifest(EMPTY, build(1))
    expect(next.latest).toBe(build(1).commit)
    expect(next.versions).toEqual([build(1)])
  })

  it('replaces a commit rather than listing it twice, so a re-run is safe', () => {
    const before = manifest(build(1))
    const next = nextManifest(before, { ...build(1), subject: 'rebuilt' })
    expect(next.versions).toHaveLength(1)
    expect(next.versions[0]?.subject).toBe('rebuilt')
  })

  it('orders by the commit date and not by when the runner got to it', () => {
    // What `workflow_dispatch` on an older ref produces. The rebuilt commit is
    // what the root now serves — so it is `latest` — but it is not the newest
    // thing in the history and must not be listed as though it were.
    const before = manifest(build(1), build(5))
    const next = nextManifest(before, build(9))
    expect(next.versions.map((one) => one.commit)).toEqual([
      build(1).commit,
      build(5).commit,
      build(9).commit,
    ])
    expect(next.latest).toBe(build(9).commit)
  })

  it('keeps the last KEEP_RECENT pushes, newest first', () => {
    const current = pushes(KEEP_RECENT + 10, 1, '0.5.0')
    expect(current.versions.slice(0, KEEP_RECENT).map((one) => one.commit)).toEqual(
      Array.from({ length: KEEP_RECENT }, (_, i) => build(i + 1).commit),
    )
  })

  it('costs one extra entry per version, which is the version rule holding on', () => {
    // Thirty pushes all carrying 0.5.0: twenty in the window, plus the oldest,
    // which the version rule pinned the moment that version first appeared and
    // never lets go. On a fresh archive that oldest entry is not a release —
    // it is only the first build the archive ever saw — and keeping it costs
    // 5 MB. That is the price of the rule catching a release whose tag was
    // pushed late, and it is per version rather than per push.
    const current = pushes(KEEP_RECENT + 10, 1, '0.5.0')
    expect(current.versions).toHaveLength(KEEP_RECENT + 1)
    expect(current.versions.at(-1)?.commit).toBe(build(KEEP_RECENT + 10).commit)
  })

  it('keeps a tagged build for ever, long past the recent window', () => {
    const release = nextManifest(EMPTY, build(60, '0.4.0', 'v0.4.0'))
    const current = pushes(KEEP_RECENT + 5, 1, '0.5.0', release)
    expect(current.versions.map((one) => one.commit)).toContain(build(60).commit)
    expect(current.versions.find((one) => one.commit === build(60).commit)?.tag).toBe('v0.4.0')
  })

  it('keeps the release commit of a version, not the last build carrying it', () => {
    // The bug this rule was written wrong for. `npm version minor` bumps
    // package.json and tags that commit; every push after it reports the same
    // version until the next bump. Keeping the newest such build would keep a
    // build that says 0.5.0 and is not v0.5.0 — wrong rather than absent.
    const release = nextManifest(EMPTY, build(60, '0.5.0', 'v0.5.0'))
    const withTail = pushes(59, 40, '0.5.0', release) // untagged work on 0.5.0
    const current = pushes(KEEP_RECENT + 5, 1, '0.6.0', withTail)

    const old = current.versions.filter((one) => one.version === '0.5.0')
    expect(old).toHaveLength(1)
    expect(old[0]?.commit).toBe(build(60).commit)
    expect(old[0]?.tag).toBe('v0.5.0')
  })

  it('keeps a release that was pushed without its tag, by the version alone', () => {
    // `git push` then `git push --tags` as two commands: the deploy runs before
    // the tag is visible, so the entry has no tag at all. The version rule is
    // what catches that build, which is the reason both rules exist.
    const release = nextManifest(EMPTY, build(60, '0.5.0'))
    const current = pushes(KEEP_RECENT + 5, 1, '0.6.0', pushes(59, 40, '0.5.0', release))
    const old = current.versions.filter((one) => one.version === '0.5.0')
    expect(old).toHaveLength(1)
    expect(old[0]?.commit).toBe(build(60).commit)
  })

  it('never drops the build being published, however old the commit', () => {
    const current = pushes(KEEP_RECENT, 1, '0.5.0')
    // A rebuild of something ancient, on a version that is already represented.
    const ancient = { ...build(99, '0.5.0'), commit: 'fedcba9' }
    expect(nextManifest(current, ancient).versions.map((one) => one.commit)).toContain('fedcba9')
  })

  it('refuses a build that does not name a commit', () => {
    expect(() => nextManifest(EMPTY, { ...build(1), commit: 'HEAD' })).toThrow()
  })

  it('refuses to record a tag it would not publish', () => {
    expect(nextManifest(EMPTY, { ...build(1), tag: '../etc' }).versions[0]?.tag).toBe('')
  })
})

describe('droppedCommits', () => {
  it('names exactly the directory that fell out of the window', () => {
    // Twenty-five pushes: the window holds n=1..20, and n=25 is pinned by the
    // version rule. One more push moves the window, so n=20 falls out — and
    // n=25 does not, which is the whole difference between the two rules.
    const current = pushes(KEEP_RECENT + 5, 1, '0.5.0')
    const next = nextManifest(current, build(0, '0.5.0'))
    expect(droppedCommits(current, next)).toEqual([build(KEEP_RECENT, '0.5.0').commit])
  })

  it('names nothing while the archive is still filling up', () => {
    const before = manifest(build(1))
    expect(droppedCommits(before, nextManifest(before, build(0)))).toEqual([])
  })

  it('names nothing when the previous manifest could not be read', () => {
    // The disaster this shape rules out: an unreadable versions.json parses to
    // empty, and a rule of the form "delete what the new manifest does not
    // mention" would empty the archive. Comparison against `previous` cannot.
    expect(droppedCommits(parseManifest('corrupt'), nextManifest(EMPTY, build(1)))).toEqual([])
  })
})

describe('the tag aliases', () => {
  it('names one directory per release, pointing at its commit', () => {
    const next = nextManifest(manifest(build(9, '0.4.0', 'v0.4.0')), build(1, '0.5.0', 'v0.5.0'))
    expect(tagAliases(next)).toEqual([
      { tag: 'v0.5.0', commit: build(1).commit },
      { tag: 'v0.4.0', commit: build(9).commit },
    ])
  })

  it('names none when nothing has been released', () => {
    expect(tagAliases(pushes(5, 1, '0.5.0'))).toEqual([])
  })

  it('drops an alias only when its build goes', () => {
    const before = manifest(build(2, '0.4.0', 'v0.4.0'))
    // A tagged build is kept for ever, so its alias never falls out this way.
    expect(droppedTags(before, nextManifest(before, build(1, '0.5.0')))).toEqual([])
    // But an entry that loses its tag — a re-tag, a manifest edited by hand —
    // leaves a directory behind, and this is what sweeps it.
    const untagged = { latest: '', versions: [{ ...build(2, '0.4.0'), tag: '' }] }
    expect(droppedTags(before, untagged)).toEqual(['v0.4.0'])
  })
})

/**
 * Pull-request previews share the manifest and nothing else with the pushes:
 * a push neither adds nor removes one, a preview is replaced on every push to
 * its pull request, and closing the pull request is the only thing that takes
 * it out. Each of those is a way of quietly leaking a directory.
 */
describe('the previews', () => {
  const preview = (number: number, commit = 'b2c3d4e') => ({
    number,
    commit,
    title: 'Remote sources',
    branch: 'claude/remote',
    date: '2026-09-11T11:00:00Z',
  })

  it('are read back, newest number first, dropping what cannot name a directory', () => {
    const read = parseManifest(
      JSON.stringify({
        latest: '',
        versions: [],
        pulls: [preview(3), preview(12), { number: 'x', commit: 'b2c3d4e' }, { number: 5, commit: 'nope' }],
      }),
    )
    expect(read.pulls.map((one: { number: number }) => one.number)).toEqual([12, 3])
  })

  it('are none in a manifest written before they existed', () => {
    expect(parseManifest(JSON.stringify({ latest: '', versions: [] })).pulls).toEqual([])
  })

  it('survive a push untouched', () => {
    const before = { ...manifest(build(2)), pulls: [preview(12)] }
    const after = nextManifest(before, build(1))
    expect(after.pulls).toEqual([preview(12)])
  })

  it('are replaced, not repeated, by a second push to the same pull request', () => {
    const once = withPull({ ...EMPTY }, preview(12, 'b2c3d4e'))
    const twice = withPull(once, preview(12, 'c3d4e5f'))
    expect(twice.pulls).toEqual([preview(12, 'c3d4e5f')])
  })

  it('are removed by the number alone, and removing an absent one is nothing', () => {
    const two = withPull(withPull({ ...EMPTY }, preview(12)), preview(40))
    expect(withoutPull(two, 12).pulls.map((one: { number: number }) => one.number)).toEqual([40])
    expect(withoutPull(two, 99).pulls).toEqual(two.pulls)
  })

  it('refuse a row that could not name a directory', () => {
    expect(() => withPull({ ...EMPTY }, { number: 0, commit: 'b2c3d4e' })).toThrow()
    expect(() => withPull({ ...EMPTY }, { number: 12, commit: 'main' })).toThrow()
  })

  it('live under pr/<number>', () => {
    expect(pullDirectory(12)).toBe('pr/12')
  })
})

describe('the file the two sides share', () => {
  it('is written by the deploy in the shape the app reads', () => {
    const written = nextManifest(manifest(build(2), build(3, '0.4.0', 'v0.4.0')), build(1))
    const read = parseVersions(JSON.parse(JSON.stringify(written)))
    expect(read).not.toBeNull()
    expect(read?.latest).toBe(written.latest)
    expect(read?.entries.map((one) => one.commit)).toEqual(written.versions.map((one) => one.commit))
    expect(read?.entries.map((one) => one.tag)).toEqual(written.versions.map((one) => one.tag))
  })

  it('carries a preview from the archive script to the menu', () => {
    const written = withPull(nextManifest(manifest(build(2)), build(1)), {
      number: 12,
      commit: 'b2c3d4e',
      title: 'Remote sources',
      branch: 'claude/remote',
      date: '2026-09-11T11:00:00Z',
    })
    const read = parseVersions(JSON.parse(JSON.stringify(written)))
    expect(read?.pulls).toEqual([
      { number: 12, commit: 'b2c3d4e', title: 'Remote sources', branch: 'claude/remote', date: '2026-09-11T11:00:00Z' },
    ])
  })
})
