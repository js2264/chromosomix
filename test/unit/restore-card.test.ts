/**
 * The sentence the restore offer makes.
 *
 * Prose, and worth a test anyway, because this is the only evidence a reader has
 * about *which* session they are being offered. "3 tabs, 4 days ago,
 * yeast.mcool and 2 more" is what decides whether they press Restore; getting
 * the count or the age wrong sends them to the wrong answer, and neither is
 * visible as a bug afterwards — the tabs simply come back and are not the ones
 * they meant.
 */

import { describe, expect, it } from 'vitest'

import { agoLabel, bannerLine, filesLabel } from '@/ui/RestoreCard'
import type { WorkspaceSummary } from '@/state/workspace'

const NOW = new Date('2026-08-13T12:00:00Z')

describe('agoLabel', () => {
  it('coarsens to the largest unit that is still true', () => {
    expect(agoLabel('2026-08-13T11:59:30Z', NOW)).toBe('just now')
    expect(agoLabel('2026-08-13T11:30:00Z', NOW)).toBe('30 minutes ago')
    expect(agoLabel('2026-08-13T11:00:00Z', NOW)).toBe('an hour ago')
    expect(agoLabel('2026-08-13T04:00:00Z', NOW)).toBe('8 hours ago')
    expect(agoLabel('2026-08-12T12:00:00Z', NOW)).toBe('yesterday')
    expect(agoLabel('2026-08-09T12:00:00Z', NOW)).toBe('4 days ago')
  })

  it('says nothing rather than something wrong', () => {
    // A record with no stamp, one written by a build that had no stamp, and one
    // from a machine whose clock is ahead. The sentence omits the clause; a
    // wrong time here is worse than no time, because it is the only thing the
    // reader has to go on.
    expect(agoLabel('', NOW)).toBeNull()
    expect(agoLabel('not a date', NOW)).toBeNull()
    expect(agoLabel('2026-08-14T12:00:00Z', NOW)).toBeNull()
  })
})

describe('filesLabel', () => {
  it('names one, two, or the first two and a count', () => {
    expect(filesLabel([])).toBe('nothing')
    expect(filesLabel(['a.cool'])).toBe('a.cool')
    expect(filesLabel(['a.cool', 'b.cool'])).toBe('a.cool and b.cool')
    expect(filesLabel(['a.cool', 'b.cool', 'c.cool', 'd.cool'])).toBe('a.cool, b.cool and 2 more')
  })

  it('shows the file name rather than the URL it was read from', () => {
    // Through `fileLabel`, so the banner names a file the way every other
    // surface in the app names it: the bucket path dropped, and the entry
    // shortened to the resolution. A banner three lines deep in URLs is one
    // nobody reads, and one that invented its own shortening would be the one
    // place a file is called something different.
    expect(filesLabel(['https://bucket.example.org/data/yeast.mcool::resolutions/1000'])).toBe(
      'yeast.mcool::1000',
    )
  })
})

describe('bannerLine', () => {
  const summary = (over: Partial<WorkspaceSummary> = {}): WorkspaceSummary => ({
    tabs: 3,
    files: ['yeast.mcool', 'ecoli.cool', 'hum53.metacool'],
    tracks: 8,
    ...over,
  })

  it('reads as one sentence', () => {
    expect(bannerLine(summary(), '4 days ago')).toBe(
      'You had 3 tabs open 4 days ago: yeast.mcool, ecoli.cool and 1 more, with 8 tracks.',
    )
  })

  it('is singular where it should be, and silent about tracks when there are none', () => {
    expect(bannerLine(summary({ tabs: 1, files: ['a.cool'], tracks: 0 }), 'just now')).toBe(
      'You had 1 tab open just now: a.cool.',
    )
    expect(bannerLine(summary({ tabs: 1, files: ['a.cool'], tracks: 1 }), null)).toBe(
      'You had 1 tab open: a.cool, with 1 track.',
    )
  })
})
