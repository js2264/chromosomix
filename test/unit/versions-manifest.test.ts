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
  nextManifest,
  parseManifest,
} from '../../scripts/versions-manifest.mjs'
import { parseVersions } from '@/versions'

/** A build, `n` days before the end of April 2026, at version `version`. */
const build = (n: number, version = '0.5.1'): {
  commit: string
  version: string
  date: string
  subject: string
} => ({
  commit: n.toString(16).padStart(7, 'a'),
  version,
  date: `2026-04-${String(30 - n).padStart(2, '0')}T09:00:00Z`,
  subject: `commit ${n}`,
})

/** A manifest holding the given builds, newest first. */
const manifest = (...builds: ReturnType<typeof build>[]): { latest: string; versions: typeof builds } => ({
  latest: builds[0]?.commit ?? '',
  versions: builds,
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

  it('keeps the last KEEP_RECENT pushes', () => {
    let current = EMPTY
    // Newest last, so each call is the newest commit — a run of ordinary pushes.
    for (let n = KEEP_RECENT + 10; n >= 1; n -= 1) current = nextManifest(current, build(n))
    expect(current.versions).toHaveLength(KEEP_RECENT)
    expect(current.versions[0]?.commit).toBe(build(1).commit)
  })

  it('keeps the newest build of every version that was ever published', () => {
    // Three releases and a long tail of pushes on the newest one. The two old
    // releases are outside the recent window and must survive it anyway: that
    // is the difference between a debugging window and an archive.
    let current = nextManifest(EMPTY, build(60, '0.3.0'))
    current = nextManifest(current, build(50, '0.4.0'))
    for (let n = KEEP_RECENT + 5; n >= 1; n -= 1) current = nextManifest(current, build(n, '0.5.0'))

    const kept = current.versions.map((one) => one.commit)
    expect(kept).toContain(build(60, '0.3.0').commit)
    expect(kept).toContain(build(50, '0.4.0').commit)
    // One row for 0.5.0 beyond the recent window would be the *newest* 0.5.0,
    // which is already in it — so the total is the window plus the two releases.
    expect(current.versions).toHaveLength(KEEP_RECENT + 2)
  })

  it('never drops the build being published, however old the commit', () => {
    let current = EMPTY
    for (let n = KEEP_RECENT; n >= 1; n -= 1) current = nextManifest(current, build(n, '0.5.0'))
    // A rebuild of something ancient, on a version that is already represented.
    const ancient = { ...build(99, '0.5.0'), commit: 'fedcba9' }
    const next = nextManifest(current, ancient)
    expect(next.versions.map((one) => one.commit)).toContain('fedcba9')
  })

  it('refuses a build that does not name a commit', () => {
    expect(() => nextManifest(EMPTY, { ...build(1), commit: 'HEAD' })).toThrow()
  })
})

describe('droppedCommits', () => {
  it('names exactly the directories the new manifest no longer covers', () => {
    let current = EMPTY
    for (let n = KEEP_RECENT; n >= 1; n -= 1) current = nextManifest(current, build(n, '0.5.0'))
    const next = nextManifest(current, build(0, '0.5.0'))
    // The oldest of the window falls out, and nothing else does.
    expect(droppedCommits(current, next)).toEqual([build(KEEP_RECENT, '0.5.0').commit])
  })

  it('names nothing while the archive is still filling up', () => {
    const before = manifest(build(1))
    expect(droppedCommits(before, nextManifest(before, build(0)))).toEqual([])
  })
})

describe('the file the two sides share', () => {
  it('is written by the deploy in the shape the app reads', () => {
    const written = nextManifest(manifest(build(2), build(3)), build(1))
    const read = parseVersions(JSON.parse(JSON.stringify(written)))
    expect(read).not.toBeNull()
    expect(read?.latest).toBe(written.latest)
    expect(read?.entries.map((one) => one.commit)).toEqual(written.versions.map((one) => one.commit))
  })
})
