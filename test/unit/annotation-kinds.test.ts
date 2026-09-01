/**
 * The kind predicates, and the invariants that hold between them.
 *
 * Four questions are asked about an `AnnotationKind` across this application —
 * does it draw a profile, may its axis be moved, does it get a track's full
 * controls, and is it filled from the worker's `sample` — and each is asked in
 * a dozen places. Getting one of them wrong is not a visible failure: the lane
 * is simply empty, or a control silently does nothing, with no error anywhere.
 *
 * That is exactly how `alignments` shipped broken once. It answered
 * {@link drawsAProfile} and {@link hasAMovableAxis} truthfully, and was missing
 * from the two guards that decide whether a lane is *filled* — so the coverage
 * lane was correct end to end in the worker and drew nothing on either surface.
 *
 * So the relationships are pinned here rather than the memberships. A list of
 * kinds per predicate is a copy of the implementation and passes whatever the
 * implementation says; an invariant between them is a claim that catches the
 * next kind added to one list and not the other.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import {
  drawnFromSamples,
  drawsAProfile,
  hasAMovableAxis,
  hasTrackControls,
  isMetadata,
  type AnnotationKind,
} from '@/annotations/types'

/** Every member of the union, so a new one cannot slip past these tests. */
const KINDS: AnnotationKind[] = [
  'gtf',
  'track',
  'segments',
  'pairs',
  'sequence',
  'metadata',
  'classes',
  'alignments',
]

describe('what a lane can be filled from', () => {
  it('gives every profile-drawing kind a road to its values', () => {
    // The invariant that was violated. A kind that draws a profile must get its
    // values from somewhere: over the wire through `sample`, or out of the open
    // file's own tables. A kind in neither draws an empty lane and says nothing.
    for (const kind of KINDS) {
      if (!drawsAProfile(kind)) continue
      const reachable = drawnFromSamples(kind) || isMetadata(kind)
      expect(reachable, `${kind} draws a profile with no way to fill it`).toBe(true)
    }
  })

  it('does not fetch samples for a kind that would not draw them', () => {
    for (const kind of KINDS) {
      if (!drawnFromSamples(kind)) continue
      expect(drawsAProfile(kind), `${kind} is sampled but draws no profile`).toBe(true)
    }
  })

  it('keeps metadata off the sampled road, since its values are in the open file', () => {
    // Not a detail: `BrowserView.fill` and `AnnotationLanes.buildEdge` would
    // ask the worker for a column it has never heard of.
    expect(drawnFromSamples('metadata')).toBe(false)
    expect(drawsAProfile('metadata')).toBe(true)
  })
})

describe('what a lane can be controlled with', () => {
  it('gives a full set of track controls only where the axis can move', () => {
    for (const kind of KINDS) {
      if (!hasTrackControls(kind)) continue
      expect(hasAMovableAxis(kind), `${kind} has limits it cannot apply`).toBe(true)
      expect(drawsAProfile(kind), `${kind} has an axis with nothing on it`).toBe(true)
    }
  })

  it('moves an axis only on a lane that has one', () => {
    for (const kind of KINDS) {
      if (!hasAMovableAxis(kind)) continue
      expect(drawsAProfile(kind), `${kind} has a movable axis and no profile`).toBe(true)
    }
  })

  it('keeps a sequence lane pinned, since GC is a fraction', () => {
    // An axis that is not [0, 1] is not a fraction any more, so the same genome
    // would look different in two views.
    expect(drawsAProfile('sequence')).toBe(true)
    expect(hasAMovableAxis('sequence')).toBe(false)
    expect(hasTrackControls('sequence')).toBe(false)
  })

  it('withholds group membership from a metadata column', () => {
    // It may be rescaled and may not join a group: a column of the open file
    // put on a shared axis with a bigWig asserts they are in the same units.
    expect(hasAMovableAxis('metadata')).toBe(true)
    expect(hasTrackControls('metadata')).toBe(false)
  })
})

describe('an alignment lane', () => {
  it('is a track in every sense a coverage profile needs to be', () => {
    // The four answers together are the whole of why a coverage lane needed no
    // renderer of its own (§8.13).
    expect(drawsAProfile('alignments')).toBe(true)
    expect(hasAMovableAxis('alignments')).toBe(true)
    expect(hasTrackControls('alignments')).toBe(true)
    expect(drawnFromSamples('alignments')).toBe(true)
  })

  it('is not one of the open file’s own columns', () => {
    expect(isMetadata('alignments')).toBe(false)
  })
})

describe('the kinds that draw no profile at all', () => {
  it('leaves the feature kinds out of every axis question', () => {
    for (const kind of ['gtf', 'segments', 'pairs', 'classes'] as AnnotationKind[]) {
      expect(drawsAProfile(kind), kind).toBe(false)
      expect(hasAMovableAxis(kind), kind).toBe(false)
      expect(hasTrackControls(kind), kind).toBe(false)
      expect(drawnFromSamples(kind), kind).toBe(false)
    }
  })
})

/**
 * Every cache the browser view holds is reconciled, and torn down, together.
 *
 * `ReadCache` shipped with `prune` and `destroy` written, documented and called
 * from nowhere: the view reconciled its samples and its residues against the
 * store on every frame and simply never mentioned its third cache. That is the
 * same shape of failure this file exists for — nothing errors, nothing looks
 * wrong, a dropped BAM just keeps a decode running in front of every other
 * lane's `sample` and holds the largest payload the worker sends for the life
 * of the tab.
 *
 * Asserted against the source, because there is no runtime surface that would
 * show it: the caches are private and the leak is invisible by construction. A
 * fourth cache added to the view and not to both lists fails here.
 */
describe('the browser view lets go of everything it holds', () => {
  const source = readFileSync(join(process.cwd(), 'src/ui/BrowserView.ts'), 'utf8')

  /** The caches constructed as fields of the view. */
  const CACHES = ['cache', 'bases', 'piles']

  it('constructs exactly the caches these tests know about', () => {
    // If this fails, a cache was added or renamed and the two below are now
    // asserting less than they claim.
    const built = [...source.matchAll(/this\.(\w+) = new (?:Sample|Base|Read)Cache\(/g)].map(
      (m) => m[1],
    )
    expect(built.sort()).toEqual([...CACHES].sort())
  })

  it('prunes every one of them against the live entries, once per frame', () => {
    for (const cache of CACHES) {
      expect(source, `${cache}.prune`).toContain(`this.${cache}.prune(live)`)
    }
  })

  it('destroys every one of them when the view goes away', () => {
    for (const cache of CACHES) {
      expect(source, `${cache}.destroy`).toContain(`this.${cache}.destroy()`)
    }
  })
})
