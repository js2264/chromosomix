/**
 * The two lane renderers' arithmetic: the per-pixel reduction a value track is
 * drawn from, the value axis it is drawn against, and the row packing a feature
 * lane is laid out with.
 *
 * All three are pure and none needs a canvas, which is the point of having split
 * them out of the drawing (spec §8.4): what can go wrong here is a number, and a
 * number can be asserted.
 */

import { describe, expect, it } from 'vitest'

import { parseBed } from '../../src/annotations/parse'
import type { TrackSampleSet } from '../../src/annotations/types'
import { featureAt, layoutFeatures, rowsThatFit } from '../../src/render/features'
import type { LaneFrame } from '../../src/render/lane'
import { locusAxisFrom, type LocusAxis } from '../../src/render/locus'
import { formatLimit, normaliser, profileOf, resolveLimits } from '../../src/render/tracks'
import { FeatureBuilder } from '../../src/annotations/featureset'
import type { FeatureSet } from '../../src/annotations/types'

const BINSIZE = 1000

/** One contig, 100 bins of 1 kb, as a region view of it would render. */
function yeastAxis(): LocusAxis {
  const axis = locusAxisFrom({
    runs: [{ label: 'I', start: 0, end: 100, unitStart: 0, unitLength: 100_000 }],
    blockStart: 0,
    level: 'bin',
    binsize: BINSIZE,
    contigLength: () => 100_000,
  })
  if (axis === null) throw new Error('axis')
  return axis
}

/** A lane `pixels` long showing `domain`, with a linear coordinate mapping. */
function frameOf(domain: [number, number], pixels: number): LaneFrame {
  const span = domain[1] - domain[0]
  return {
    orientation: 'bottom',
    toPixel: (unit) => ((unit - domain[0]) / span) * pixels,
    toUnit: (pixel) => domain[0] + (pixel / pixels) * span,
    domain,
    alongFrom: 0,
    alongTo: pixels,
    acrossFrom: 0,
    thickness: 40,
  }
}

/** Base-resolution samples over one contig. */
function samples(
  intervals: Array<[number, number, number]>,
  band?: Array<[number, number]>,
  /** The disagreeing share of each interval, for an alignment lane (§8.13). */
  variant?: number[],
): TrackSampleSet {
  return {
    basesPerPixel: 1,
    regions: [
      {
        contig: 'I',
        start: 0,
        end: 100_000,
        starts: Int32Array.from(intervals.map((row) => row[0])),
        ends: Int32Array.from(intervals.map((row) => row[1])),
        values: Float32Array.from(intervals.map((row) => row[2])),
        min: band === undefined ? null : Float32Array.from(band.map((row) => row[0])),
        max: band === undefined ? null : Float32Array.from(band.map((row) => row[1])),
        variant: variant === undefined ? null : Float32Array.from(variant),
        summary: band !== undefined,
      },
    ],
    extent: null,
  }
}

describe('per-pixel reduction', () => {
  it('carries a constant track through unchanged', () => {
    const profile = profileOf(frameOf([0, 100], 100), yeastAxis(), samples([[0, 100_000, 7]]))
    expect(profile.mean[0]).toBeCloseTo(7, 5)
    expect(profile.mean[99]).toBeCloseTo(7, 5)
    expect(profile.extent).toEqual({ min: 7, max: 7 })
  })

  // The number that belongs in a pixel is the mean over its *base pairs*, not
  // over its intervals: otherwise one narrow spike outvotes the coverage around
  // it, and a whole-genome view is a picture of its own outliers.
  it('weights by how much of the pixel each interval covers', () => {
    // One pixel is one bin here (100 bins over 100 px). Bin 0 holds 900 bp at 0
    // and 100 bp at 10, so its mean is 1, not 5.
    const profile = profileOf(
      frameOf([0, 100], 100),
      yeastAxis(),
      samples([
        [0, 900, 0],
        [900, 1000, 10],
      ]),
    )
    expect(profile.mean[0]).toBeCloseTo(1, 5)
  })

  it('leaves a gap as no data, not as zero', () => {
    const profile = profileOf(
      frameOf([0, 100], 100),
      yeastAxis(),
      samples([
        [0, 10_000, 5],
        [20_000, 30_000, 5],
      ]),
    )
    expect(profile.mean[5]).toBe(5)
    expect(Number.isNaN(profile.mean[15])).toBe(true)
    expect(profile.mean[25]).toBe(5)
  })

  // A 1 bp feature at whole-genome zoom covers 7e-5 of a pixel. Weighted by
  // width alone it rounds to nothing beside its neighbours and disappears.
  it('lets a sub-pixel interval claim the pixel it lands in', () => {
    const profile = profileOf(frameOf([0, 100], 100), yeastAxis(), samples([[50_000, 50_001, 42]]))
    expect(profile.mean[50]).toBeCloseTo(42, 3)
  })

  it('keeps the min/max envelope from a summary level', () => {
    const profile = profileOf(
      frameOf([0, 100], 100),
      yeastAxis(),
      samples([[0, 1000, 5]], [[1, 9]]),
    )
    expect(profile.envelope).toBe(true)
    expect(profile.low[0]).toBe(1)
    expect(profile.high[0]).toBe(9)
  })

  // The axis describes the ink. A whole-genome pixel covers 13 kb and its
  // envelope reaches whatever single base was highest inside it — which is a
  // fact about the data and, since the envelope stopped being drawn, not a fact
  // about anything on screen. Scaling to it flattens the line onto its baseline
  // for a band that is no longer there.
  it('scales to the means, which are what is drawn, not to the envelope', () => {
    const intervals: Array<[number, number, number]> = []
    const band: Array<[number, number]> = []
    for (let i = 0; i < 100; i++) {
      intervals.push([i * 1000, (i + 1) * 1000, 5])
      // Two pixels in a hundred hold a base that is two hundred times the rest.
      band.push([0, i === 40 || i === 80 ? 1000 : 12])
    }
    const profile = profileOf(frameOf([0, 100], 100), yeastAxis(), samples(intervals, band))
    expect(profile.extent?.max).toBe(5)
    expect(profile.extent?.min).toBe(0)
    // …and the envelope is still recorded, because the readout can say what a
    // pixel hid even though the axis no longer answers to it.
    expect(profile.high[40]).toBe(1000)
  })

  // Whatever the envelope does, the *line* must fit: a lane whose drawn values
  // ran off the top would be worse than one whose band is clipped.
  it('never puts the ceiling below the largest mean', () => {
    const profile = profileOf(
      frameOf([0, 100], 100),
      yeastAxis(),
      samples(
        [
          [0, 1000, 900],
          [1000, 100_000, 1],
        ],
        [
          [900, 900],
          [1, 1],
        ],
      ),
    )
    expect(profile.extent?.max).toBe(900)
  })

  it('ignores samples for a contig the axis does not show', () => {
    const set = samples([[0, 1000, 5]])
    set.regions[0].contig = 'ZZZ'
    expect(profileOf(frameOf([0, 100], 100), yeastAxis(), set).extent).toBeNull()
  })

  it('is empty with nothing to draw', () => {
    const profile = profileOf(frameOf([0, 100], 100), yeastAxis(), null)
    expect(profile.extent).toBeNull()
    expect(profile.mean.every(Number.isNaN)).toBe(true)
  })
})

/**
 * The disagreeing share of a depth lane, reduced the same way the depth is.
 *
 * The whole point of the column is the *ratio* of the two, so the two have to
 * come through `profileOf` under the same weights: reduced any other way the
 * fraction is right at one pixel per interval and wrong everywhere else, which
 * is the width nobody tests at.
 */
describe('a lane that disagrees with its reference', () => {
  it('carries no variant column at all where nothing carried one', () => {
    // `null` and zeros are different claims and must stay different: "these
    // reads agree with the reference" against "no reference was loaded".
    const profile = profileOf(frameOf([0, 100], 100), yeastAxis(), samples([[0, 1000, 4]]))
    expect(profile.variant).toBeNull()
  })

  it('reduces the disagreement under the same weights as the depth', () => {
    // Two intervals into one pixel each: the fraction out is the fraction in.
    const profile = profileOf(
      frameOf([0, 2], 2),
      yeastAxis(),
      samples(
        [
          [0, 1000, 8],
          [1000, 2000, 4],
        ],
        undefined,
        [2, 0],
      ),
    )
    const variant = profile.variant as Float32Array
    expect(variant).not.toBeNull()
    expect(variant[0] / profile.mean[0]).toBeCloseTo(0.25, 6)
    expect(variant[1]).toBeCloseTo(0, 6)
  })

  it('keeps the fraction when several intervals fall into one pixel', () => {
    // The case a naive sum gets wrong. Four bins into one pixel, half of the
    // depth disagreeing in each: the pixel's fraction is still a half, not four
    // halves.
    const profile = profileOf(
      frameOf([0, 4], 1),
      yeastAxis(),
      samples(
        [
          [0, 1000, 4],
          [1000, 2000, 4],
          [2000, 3000, 4],
          [3000, 4000, 4],
        ],
        undefined,
        [2, 2, 2, 2],
      ),
    )
    const variant = profile.variant as Float32Array
    expect(profile.mean[0]).toBeCloseTo(4, 6)
    expect(variant[0] / profile.mean[0]).toBeCloseTo(0.5, 6)
  })
})

describe('the value axis', () => {
  it('anchors a one-signed autoscale at zero', () => {
    expect(resolveLimits({ auto: true, min: 0, max: 1 }, { min: 3, max: 90 })).toEqual({
      min: 0,
      max: 90,
    })
  })

  // A log ratio that crossed zero off-centre would put "no change" somewhere
  // arbitrary in the lane, which is the one position a reader needs to find.
  it('makes a signed autoscale symmetric', () => {
    expect(resolveLimits({ auto: true, min: 0, max: 1 }, { min: -2, max: 5 })).toEqual({
      min: -5,
      max: 5,
    })
  })

  it('honours a manual clip, and refuses an inverted one', () => {
    expect(resolveLimits({ auto: false, min: 1, max: 9 }, null)).toEqual({ min: 1, max: 9 })
    expect(resolveLimits({ auto: false, min: 9, max: 1 }, null)).toEqual({ min: 0, max: 1 })
  })

  // The `log2` option these three used to cover is gone: it was a per-track
  // dropdown whose effect on a 44-pixel lane was hard to read and easy to forget
  // having set, and it put a lane on a different value axis from the one beside
  // it — which is the opposite of what the autoscale group is for.
  it('places a value by where it falls between the limits', () => {
    const norm = normaliser({ min: 0, max: 10 })
    expect(norm(0)).toBeCloseTo(0, 6)
    expect(norm(2.5)).toBeCloseTo(0.25, 6)
    expect(norm(10)).toBeCloseTo(1, 6)
  })

  // A signed track's floor is not zero, and a value below it is still placed by
  // the same subtraction — the caller clips, this does not.
  it('measures from the floor, not from zero', () => {
    const norm = normaliser({ min: -4, max: 4 })
    expect(norm(-4)).toBeCloseTo(0, 6)
    expect(norm(0)).toBeCloseTo(0.5, 6)
    expect(norm(4)).toBeCloseTo(1, 6)
  })

  // `resolveLimits` refuses to hand one over, but a group range collapses to a
  // point whenever every track in it is flat — and a divide by zero there would
  // be a lane of NaN rather than a lane of nothing.
  it('answers zero for a span of zero rather than dividing by it', () => {
    const norm = normaliser({ min: 5, max: 5 })
    expect(norm(5)).toBe(0)
    expect(norm(9)).toBe(0)
  })

  it('writes a limit the way an axis corner has room for', () => {
    expect(formatLimit(0)).toBe('0')
    expect(formatLimit(1598.85)).toBe('1599')
    expect(formatLimit(2.5)).toBe('2.5')
    expect(formatLimit(0.16046)).toBe('0.16')
    expect(formatLimit(1e-9)).toBe('1.0e-9')
  })
})

/**
 * When a lane stops trying to resolve individual features.
 *
 * The rule is not "more features than pixels" — it is *more features than the
 * lane can draw apart*, and those differ the moment a lane gives its features a
 * minimum drawn width. A variant is one base, drawn at a floor of three pixels
 * so it can be seen and hit; at the old threshold a stretch of variants seven
 * bases apart at whole-contig zoom drew as several hundred three-pixel marks
 * that merged into one solid bar, in whichever ink was laid down last. That
 * reads as one three-kilobase variant, which is a claim the file does not make.
 * Collapsing says the true thing instead: there are many here.
 */
describe('collapsing to density', () => {
  /** `n` one-base features spread evenly across `span` bases. */
  function points(n: number, span: number): TrackSampleSet['regions'][number] {
    return samples(Array.from({ length: n }, (_, i) => {
      const at = Math.round((i * span) / n)
      return [at, at + 1, 1] as [number, number, number]
    })).regions[0]
  }

  function setOf(n: number, span: number): FeatureSet {
    const region = points(n, span)
    const builder = new FeatureBuilder()
    for (let i = 0; i < region.starts.length; i++) {
      builder.add('I', region.starts[i], region.ends[i])
    }
    return builder.finish()
  }

  it('keeps the old rule exactly where no minimum width is asked for', () => {
    // A peak that is one pixel wide *is* one pixel of genome, and every caller
    // but the variant lane still gets `span / 2`.
    const frame = frameOf([0, 100_000], 1000)
    expect(layoutFeatures(frame, yeastAxis(), setOf(400, 100_000), 4).dense).toBe(false)
    expect(layoutFeatures(frame, yeastAxis(), setOf(600, 100_000), 4).dense).toBe(true)
  })

  it('collapses sooner once each feature is given room to be seen', () => {
    // 400 marks across 1000 pixels is 2.5 pixels apart — under the three a
    // variant is drawn at, so they merge. The old threshold called this sparse.
    const frame = frameOf([0, 100_000], 1000)
    expect(layoutFeatures(frame, yeastAxis(), setOf(400, 100_000), 4, 3).dense).toBe(true)
    // …and still resolves them where there is genuinely room.
    expect(layoutFeatures(frame, yeastAxis(), setOf(100, 100_000), 4, 3).dense).toBe(false)
  })

  it('collapses at the width the marks actually need, not at a chosen number', () => {
    // Stated from the constants: one mark needs its drawn floor plus the gap
    // that makes two read as two. A test that pinned a count would pass while
    // the floor and the threshold drifted apart.
    const frame = frameOf([0, 100_000], 1000)
    const each = 3 + 2
    const fits = Math.floor(1000 / each)
    expect(layoutFeatures(frame, yeastAxis(), setOf(fits, 100_000), 4, 3).dense).toBe(false)
    expect(layoutFeatures(frame, yeastAxis(), setOf(fits + 40, 100_000), 4, 3).dense).toBe(true)
  })
})

describe('feature packing', () => {
  const axis = yeastAxis()

  it('puts features that do not overlap in one row', () => {
    const set = parseBed('I\t0\t5000\ta\nI\t20000\t25000\tb\n')
    const layout = layoutFeatures(frameOf([0, 100], 400), axis, set, 4)
    expect(layout.rows).toBe(1)
    expect(layout.placements.map((p) => p.row)).toEqual([0, 0])
    expect(layout.total).toBe(2)
  })

  it('stacks features that do overlap', () => {
    const set = parseBed('I\t0\t20000\ta\nI\t5000\t25000\tb\nI\t6000\t26000\tc\n')
    const layout = layoutFeatures(frameOf([0, 100], 400), axis, set, 4)
    expect(layout.rows).toBe(3)
    expect(layout.placements.map((p) => p.row)).toEqual([0, 1, 2])
  })

  // Every row is full at every position: no packing separates them, so the lane
  // stops claiming to and says how many are there.
  it('collapses to one row when there are more features than pixels', () => {
    const rows: string[] = []
    for (let i = 0; i < 400; i++) rows.push(`I\t${i * 250}\t${i * 250 + 200}\tp${i}`)
    const layout = layoutFeatures(frameOf([0, 100], 200), axis, parseBed(rows.join('\n')), 4)
    expect(layout.dense).toBe(true)
    expect(layout.rows).toBe(1)
    expect(layout.total).toBe(400)
  })

  // Overlapping the row that frees up soonest loses the least; dropping the
  // feature would make the lane silently incomplete.
  it('never drops a feature when the rows run out', () => {
    const rows: string[] = []
    for (let i = 0; i < 6; i++) rows.push(`I\t0\t${50_000 + i}\tg${i}`)
    const layout = layoutFeatures(frameOf([0, 100], 400), axis, parseBed(rows.join('\n')), 2)
    expect(layout.placements.length).toBe(6)
    expect(new Set(layout.placements.map((p) => p.row))).toEqual(new Set([0, 1]))
  })

  it('only lays out what the window shows', () => {
    const set = parseBed('I\t0\t1000\ta\nI\t90000\t91000\tb\n')
    const layout = layoutFeatures(frameOf([0, 10], 400), axis, set, 4)
    expect(layout.placements.map((p) => set.name[p.index])).toEqual(['a'])
  })

  it('fits rows to the thickness it is given', () => {
    expect(rowsThatFit(16)).toBe(1)
    expect(rowsThatFit(46)).toBe(4)
    expect(rowsThatFit(1000)).toBe(8)
  })
})

describe('hit testing', () => {
  const axis = yeastAxis()

  it('finds the feature under a point, and nothing beside it', () => {
    const frame = frameOf([0, 100], 400)
    const set = parseBed('I\t0\t5000\ta\nI\t50000\t55000\tb\n')
    const layout = layoutFeatures(frame, axis, set, 1)
    // Bin 52 of 100, over a 400 px lane: 208 px along.
    expect(featureAt(frame, layout, 208, 20)?.index).toBe(1)
    expect(featureAt(frame, layout, 120, 20)).toBeNull()
  })

  it('misses when the pointer is outside the lane', () => {
    const frame = frameOf([0, 100], 400)
    const layout = layoutFeatures(frame, axis, parseBed('I\t0\t5000\ta\n'), 1)
    expect(featureAt(frame, layout, 5, 60)).toBeNull()
  })
})
