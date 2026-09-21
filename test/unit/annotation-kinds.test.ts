/**
 * The kind predicates, and the invariants that hold between them.
 *
 * Four questions are asked about an `AnnotationKind` across this application —
 * does it draw a profile, may its axis be moved, does it get a track's full
 * controls, and is it filled from the worker's `sample` — and each is asked in
 * a dozen places. They are four questions and not one: a barChart draws no
 * profile, gets no row of track controls and has a value axis the reader may
 * drag all the same (§8.17). Getting one of them wrong is not a visible failure: the lane
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
  ANNOTATION_KINDS,
  drawnFromSamples,
  drawsAProfile,
  hasAMovableAxis,
  hasTrackControls,
  isIntervalSet,
  isMetadata,
  readsAlignments,
  type AnnotationKind,
} from '@/annotations/types'

/**
 * Every member of the union, so a new one cannot slip past these tests.
 *
 * Imported rather than re-listed. This file's whole subject is a kind missing
 * from a list nobody notices, and a private copy here would be one more of
 * exactly those — green while the application was wrong. `ANNOTATION_KINDS`
 * carries a `satisfies` that fails to compile if it and the union drift.
 */
const KINDS: readonly AnnotationKind[] = ANNOTATION_KINDS

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

  it('moves an axis only on a lane that has one — a profile, or a chart', () => {
    // The invariant used to be *a movable axis implies a profile*, and the
    // barChart is what broke it rather than what slipped through it: §8.17 gave
    // a lane of glyphs a pair of limits, because both readings it had were
    // relative and two files' lanes could not be compared by eye. An axis is a
    // pair of numbers a picture is drawn against; a profile is one way of
    // drawing against one.
    for (const kind of KINDS) {
      if (!hasAMovableAxis(kind)) continue
      expect(
        drawsAProfile(kind) || kind === 'barchart',
        `${kind} has a movable axis and nothing drawn against it`,
      ).toBe(true)
    }
  })

  it('starts a sequence lane at [0, 1] and lets a reader move it', () => {
    // It used to be pinned, on the argument that an axis which is not [0, 1] is
    // not a fraction any more. The pin was only ever half kept: the lane
    // recorded its limits as click targets, the editor stored what was typed,
    // and the settings card offered `limits [0] [1] auto` — while the lane
    // alone withheld the autoscale mark that is the way back from a typed pair.
    // Yeast GC sits between 0.35 and 0.45, so narrowing the axis is the natural
    // move and the reader was then stuck. `[0, 1]` survives as the *default*,
    // which is what keeps two views of one genome matching.
    expect(drawsAProfile('sequence')).toBe(true)
    expect(hasAMovableAxis('sequence')).toBe(true)
    // …and it is still not a bigWig: smoothing and the rest of the track row
    // are about a measured signal, and GC is computed from the bases.
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

/**
 * "An interval set" is one rule, and every place that asks gets the same answer.
 *
 * It was four literals — the analysis form's `kindsFor`, and the availability
 * gates of overlap, metaplot and APA — and `variants` was added to the first
 * without the other three. Nothing errored. What a reader got was a task whose
 * parameter would happily accept a VCF sitting behind a gate that would not
 * open for one, saying *load a BED or a GTF* while a variant set was on screen.
 *
 * Asserted against the **source**, because there is no runtime surface that
 * shows the shape of the failure: each gate is a closure over an entry list,
 * and testing them one at a time is what let three of them drift from the
 * fourth in the first place. What this catches is a fifth site spelling the
 * rule out again.
 */
describe('what counts as a set of intervals', () => {
  const SITES = [
    'src/analysis/tasks/overlap.ts',
    'src/analysis/tasks/metaplot.ts',
    'src/analysis/tasks/apa.ts',
    'src/ui/ParamForm.ts',
  ]

  it('is asked through the predicate everywhere it is asked', () => {
    for (const site of SITES) {
      const source = readFileSync(join(process.cwd(), site), 'utf8')
      expect(source, site).toContain('isIntervalSet')
    }
  })

  it('is not written out as a literal array in a task descriptor either', () => {
    // The fifth copy, and the one the check below could not see. `apa.ts`
    // carried `needsKinds: ['gtf', 'segments', 'variants']` **twice** — an
    // array of literals rather than a chain of comparisons — so the barChart
    // that `isIntervalSet` had just let through the availability gate was then
    // refused by the anchors control that gate exists to offer. Nothing errored:
    // the task was available and half of it could not be filled.
    for (const site of SITES) {
      const source = readFileSync(join(process.cwd(), site), 'utf8')
      const listed = /needsKinds:\s*\[[^\]]*'(gtf|segments|variants|barchart)'/
      expect(listed.test(source), `${site} lists the kinds instead of deriving them`).toBe(false)
    }
  })

  it('is spelled out as a kind list nowhere', () => {
    // The exact shape that drifted: `kind === 'gtf' || kind === 'segments'`.
    for (const site of SITES) {
      const source = readFileSync(join(process.cwd(), site), 'utf8')
      const spelled = /kind === '(gtf|segments|variants|barchart)'\s*\|\|\s*\w+\.kind === '(gtf|segments|variants|barchart)'/
      expect(spelled.test(source), `${site} spells the rule out`).toBe(false)
    }
  })

  it('holds exactly the kinds that are FeatureSets', () => {
    // The claim behind the predicate: these four differ in what a reader means
    // by a row, not in what they are. A kind that is not a `FeatureSet` cannot
    // be aggregated over and must not be offered — and one that *is* must be,
    // which is what a barChart added here is about: its rows are intervals
    // whatever is drawn inside them, and a metaplot over them is a reading
    // nobody should have to convert a file to ask for (§8.17). A structure's
    // beads are the same argument once more: an interval that has a place in
    // space is still an interval (§25).
    expect(KINDS.filter(isIntervalSet).sort()).toEqual([
      'barchart',
      'gtf',
      'segments',
      'structure',
      'variants',
    ])
  })
})

/**
 * A structure is a fifth feature kind, and beside a map nothing more than that.
 *
 * §8.14's argument for a variant set, made for a model (§25): a `FeatureSet`
 * like a peak set, so no payload arm, no lane renderer and no cache had to be
 * written for the boxes it draws beside a map. What it has besides is a place
 * per bead, and the place is read by a cell of the deck rather than by a lane —
 * so the kind answers no profile question, and it is an interval set.
 */
describe('a structure', () => {
  it('draws no profile and gets no track controls', () => {
    expect(drawsAProfile('structure')).toBe(false)
    expect(hasAMovableAxis('structure')).toBe(false)
    expect(hasTrackControls('structure')).toBe(false)
    expect(drawnFromSamples('structure')).toBe(false)
    expect(readsAlignments('structure')).toBe(false)
    expect(isMetadata('structure')).toBe(false)
  })
})

/**
 * A variant set is a third feature kind, and nothing more than that.
 *
 * The whole design (§8.14) rests on it being a `FeatureSet` like a peak set and
 * a gene model: no new payload arm, no new renderer, no new cache. Every one of
 * those would have been a *silent* cost rather than a loud one —
 * `payload.kind === 'features'` is tested at a dozen sites across the browser,
 * the map lanes, the search box, the export and the analysis inputs, and a
 * third arm makes each of them skip the lane rather than fail on it. So what is
 * pinned here is the negative: the kind answers no profile question, and it is
 * exactly as much of a track as a BED is, which is none.
 */
describe('a variant lane', () => {
  it('is a feature kind and not a value one', () => {
    expect(drawsAProfile('variants')).toBe(false)
    expect(hasAMovableAxis('variants')).toBe(false)
    expect(hasTrackControls('variants')).toBe(false)
    expect(drawnFromSamples('variants')).toBe(false)
    expect(isMetadata('variants')).toBe(false)
  })

  it('answers every predicate the way a peak set does', () => {
    // The claim the design is built on, stated as an equality rather than as
    // five literals: if a variant set ever stops behaving like `segments` under
    // one of these, it has stopped being a `FeatureSet` and the reuse it was
    // chosen for has quietly gone.
    for (const ask of [drawsAProfile, hasAMovableAxis, hasTrackControls, drawnFromSamples, isMetadata]) {
      expect(ask('variants'), ask.name).toBe(ask('segments'))
    }
  })

  it('does not read a BAM, whatever else it has in common with one', () => {
    // Both draw variants and neither is the other. `readsAlignments` gates the
    // filters written through between a BAM's two rows, and a VCF has no reads
    // to filter.
    expect(readsAlignments('variants')).toBe(false)
  })
})

/**
 * A barChart is a fourth feature kind, and nothing more than that (§8.17).
 *
 * The same design §8.14 settled for a VCF, taken one step further: a row here
 * carries a whole *vector*, which is the strongest case there has been for a
 * payload of its own — and it is refused for the same reason, because a second
 * feature shape does not break `payload.kind === 'features'`, it makes every
 * one of that test's dozen call sites skip the lane in silence. So the vector
 * is one optional field on the set and every predicate below answers exactly as
 * a peak set does.
 *
 * The one that is load-bearing rather than merely correct is {@link drawsAProfile}.
 * A barChart has values and a ceiling, which is most of what a track has, and
 * `true` here would put it on the sampled road — a `sample` request per frame
 * for a lane whose values are already in hand, and an autoscale group it would
 * drag around by numbers that are not in the group's units.
 */
describe('a barChart lane', () => {
  it('is a feature kind that nonetheless has an axis', () => {
    expect(drawsAProfile('barchart')).toBe(false)
    expect(drawnFromSamples('barchart')).toBe(false)
    expect(isMetadata('barchart')).toBe(false)
    // §8.17's fixed limits, and every way of moving them: the ceiling drag, the
    // ⌘-scroll, the autoscale spot. It still gets no *row* of track controls —
    // no autoscale group, no mode or flip switch — because a chart is not a
    // measurement in anybody else's units.
    expect(hasAMovableAxis('barchart')).toBe(true)
    expect(hasTrackControls('barchart')).toBe(false)
  })

  it('answers every predicate the way a peak set does, its axis apart', () => {
    for (const ask of [drawsAProfile, hasTrackControls, drawnFromSamples, isMetadata]) {
      expect(ask('barchart'), ask.name).toBe(ask('segments'))
    }
    expect(hasAMovableAxis('barchart')).not.toBe(hasAMovableAxis('segments'))
  })

  it('is a set of intervals, whatever is drawn inside them', () => {
    expect(isIntervalSet('barchart')).toBe(true)
  })

  it('does not read a BAM', () => {
    expect(readsAlignments('barchart')).toBe(false)
  })
})

/**
 * The pile is the other half of a BAM, and it is not a track.
 *
 * A BAM imports as two rows — the depth, which is a coverage profile in every
 * sense, and the pile, which is a stack of rectangles. Every predicate above is
 * about a *profile*, and answering any of them `true` for the pile would put a
 * value axis on a lane that has no values: an autoscale group it would drag
 * around by its read count, a ceiling that scales nothing, a `sample` fetched
 * per frame and thrown away.
 */
describe('a pile lane', () => {
  it('answers none of the profile questions', () => {
    expect(drawsAProfile('reads')).toBe(false)
    expect(hasAMovableAxis('reads')).toBe(false)
    expect(hasTrackControls('reads')).toBe(false)
    expect(isMetadata('reads')).toBe(false)
  })

  it('is not filled from `sample`, because a pile is not a number per pixel', () => {
    // The one predicate whose false answer is *load-bearing* rather than merely
    // correct: a `true` here would spend a `sample` request per frame on a lane
    // that draws from `reads`, and the two would race for the same worker.
    expect(drawnFromSamples('reads')).toBe(false)
  })

  it('shares the file, and so the filters, with the depth beside it', () => {
    expect(readsAlignments('reads')).toBe(true)
    expect(readsAlignments('alignments')).toBe(true)
  })

  it('is the only kind besides the depth that reads a BAM', () => {
    for (const kind of KINDS) {
      if (kind === 'reads' || kind === 'alignments') continue
      expect(readsAlignments(kind), kind).toBe(false)
    }
  })
})

describe('the kinds that draw no profile at all', () => {
  it('leaves the feature kinds out of every axis question', () => {
    for (const kind of [
      'gtf',
      'segments',
      'variants',
      'barchart',
      'pairs',
      'classes',
    ] as AnnotationKind[]) {
      expect(drawsAProfile(kind), kind).toBe(false)
      expect(hasTrackControls(kind), kind).toBe(false)
      expect(drawnFromSamples(kind), kind).toBe(false)
      // The barChart is the one exception and only to this one question; see
      // the lane's own block above for what §8.17 gave it and why.
      if (kind !== 'barchart') expect(hasAMovableAxis(kind), kind).toBe(false)
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
