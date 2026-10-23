/**
 * The metaplot kernel: windows, strand, clipping and the band.
 *
 * The four things a metaplot gets wrong in a way that survives review, all
 * checked here against inputs whose answer is obvious by inspection:
 *
 * - **strand**, because a plot that ignores it averages every asymmetric signal
 *   against its own mirror and reports a symmetric shape that belongs to nothing;
 * - **clipping**, because a feature near a telomere has a short window, and
 *   stretching that window across the full width silently compresses the signal
 *   inwards instead of leaving the unreachable columns empty;
 * - **the band**, because a bootstrap that resamples columns independently is a
 *   statement about each column rather than about the feature set, and the two
 *   look identical on a plot;
 * - **standardising**, because a z-score taken per ranking group instead of per
 *   track re-centres every group on zero and deletes the offset between them,
 *   which is the entire reason the reader split the set.
 */

import { describe, expect, it } from 'vitest'

import {
  aggregate,
  axisFor,
  referenceWindows,
  scaledWindows,
  standardiseTrack,
  windowRow,
} from '@/analysis/metaplot'
import { makeRandom } from '@/analysis/random'
import type { TrackSamples } from '@/annotations/types'

const lengthOf = (): number => 10_000

/** A track that is 1 everywhere in `[from, to)` and absent elsewhere. */
function samples(contig: string, from: number, to: number, value = 1): TrackSamples {
  return {
    contig,
    start: from,
    end: to,
    starts: Int32Array.from([from]),
    ends: Int32Array.from([to]),
    values: Float32Array.from([value]),
    min: null,
    max: null,
    variant: null,
    summary: false,
  }
}

/**
 * A track that reads 1 inside `[from, to)` and 0 across the rest of a window.
 *
 * An exact step function, which is what makes a scaled-region row readable by
 * inspection: every column is either wholly inside the feature or wholly
 * outside it, so the row says which columns the body was given.
 */
function indicator(
  window: { contig: string; start: number; end: number },
  from: number,
  to: number,
): TrackSamples {
  return {
    contig: window.contig,
    start: window.start,
    end: window.end,
    starts: Int32Array.from([window.start, from, to]),
    ends: Int32Array.from([from, to, window.end]),
    values: Float32Array.from([0, 1, 0]),
    min: null,
    max: null,
    variant: null,
    summary: false,
  }
}

/** A `count × slots` block of rows, row-major, as the runner builds one. */
const rows = (values: number[][]): Float64Array => Float64Array.from(values.flat())

describe('referenceWindows', () => {
  it('centres a window on the chosen point and fills every slot', () => {
    const { windows, layout } = referenceWindows(
      [{ contig: 'chrI', start: 5000, end: 6000, strand: 1 }],
      { at: 'start', flank: 1000, step: 100, lengthOf },
    )
    expect(layout.slots).toBe(20)
    expect(windows[0].start).toBe(4000)
    expect(windows[0].end).toBe(6000)
    expect(windows[0].slotFrom).toBe(0)
    expect(windows[0].slotTo).toBe(20)
  })

  it('anchors on the far end of a minus-strand feature', () => {
    const [plus] = referenceWindows(
      [{ contig: 'chrI', start: 5000, end: 6000, strand: 1 }],
      { at: 'start', flank: 500, step: 100, lengthOf },
    ).windows
    const [minus] = referenceWindows(
      [{ contig: 'chrI', start: 5000, end: 6000, strand: -1 }],
      { at: 'start', flank: 500, step: 100, lengthOf },
    ).windows
    // The *start* of a minus-strand feature is its higher coordinate.
    expect(plus.start).toBe(4500)
    expect(minus.start).toBe(5500)
  })

  it('clips a window at the start of a sequence and says which slots it lost', () => {
    const { windows } = referenceWindows(
      [{ contig: 'chrI', start: 300, end: 400, strand: 1 }],
      { at: 'start', flank: 1000, step: 100, lengthOf },
    )
    expect(windows[0].start).toBe(0)
    // Seven columns of the upstream flank are off the end of the chromosome, so
    // the row fills the last thirteen. Stretching it over all twenty would move
    // the anchor's signal seven columns to the left.
    expect(windows[0].slotFrom).toBe(7)
    expect(windows[0].slotTo).toBe(20)
  })

  it('centres an odd-length feature where deepTools does, half its length rounded down from its start', () => {
    // `chopRegionsFromMiddle`: a 211 bp peak at 282,054 is centred on 282,159,
    // not on the rounded midpoint one base to the right — which on a sharp
    // CTCF peak in 50 bp columns moved a column's mean by a percent.
    const [odd] = referenceWindows([{ contig: 'chrI', start: 1000, end: 1211, strand: 1 }], {
      at: 'centre',
      flank: 100,
      step: 50,
      lengthOf,
    }).windows
    expect(odd.start).toBe(1005)
    expect(odd.end).toBe(1205)
  })

  it('keeps a column step-wide when the sequence ends part of the way through it', () => {
    // A 1 kb flank about 350: 650 bp of it is off the chromosome, six whole
    // columns and half of the seventh. The seventh is kept, for the half it
    // has, and the row's columns stay 100 bp each from the anchor — where
    // rounding the loss to seven and spreading 1,350 bp over thirteen columns
    // drew every column of the row a few base pairs off its place.
    const { windows } = referenceWindows([{ contig: 'chrI', start: 350, end: 400, strand: 1 }], {
      at: 'start',
      flank: 1000,
      step: 100,
      lengthOf,
    })
    expect(windows[0].start).toBe(0)
    expect(windows[0].slotFrom).toBe(6)
    expect(windows[0].span).toEqual({ start: -50, end: 1350 })
    const row = windowRow(
      { ...samples('chrI', 0, 1350), starts: Int32Array.from([0, 50]), ends: Int32Array.from([50, 1350]),
        values: Float32Array.from([4, 1]) },
      windows[0],
      20,
    )
    // The seventh column is 50 bp of 4 and 50 bp past the end: 4, not a mean
    // diluted by the bases that are not there.
    expect(row[6]).toBe(4)
    expect(row[7]).toBe(1)
    expect(Number.isNaN(row[5])).toBe(true)
  })

  it('puts the clipping on the far side for a minus-strand feature', () => {
    const { windows } = referenceWindows(
      [{ contig: 'chrI', start: 300, end: 400, strand: -1 }],
      { at: 'end', flank: 1000, step: 100, lengthOf },
    )
    // Reading right to left, the columns lost at low coordinates are the
    // *downstream* ones — so the row starts at slot 0 and ends short.
    expect(windows[0].slotFrom).toBe(0)
    expect(windows[0].slotTo).toBe(13)
  })
})

describe('scaledWindows', () => {
  it('lays out flank, body, flank', () => {
    const { layout } = scaledWindows([], { body: 50, flank: 1000, step: 100, lengthOf })
    expect(layout.slots).toBe(70)
    expect(layout.bodyFrom).toBe(10)
    expect(layout.bodyTo).toBe(60)
  })

  it('drops a feature shorter than one column of body rather than stretching it', () => {
    const { windows, dropped } = scaledWindows(
      [
        { contig: 'chrI', start: 1000, end: 1010, strand: 1 },
        { contig: 'chrI', start: 2000, end: 4000, strand: 1 },
      ],
      { body: 50, flank: 0, step: 100, lengthOf },
    )
    // A ten-base feature resampled to fifty columns is fifty copies of one
    // number, which drags the average towards it for no evidence.
    expect(dropped).toBe(1)
    expect(windows).toHaveLength(1)
  })

  it('gives every feature body the same columns, whatever its length', () => {
    // The promise the layout above makes, kept — and it is `windowRow` that has
    // to keep it, which is why the window carries the body's extent. Mapping
    // the whole window uniformly instead handed each feature a share of the row
    // set by its own length: with these shipped defaults a 20 kb gene's body
    // occupied columns 15 to 165 and a 100 kb gene's columns 4 to 176, against
    // a layout promising 40 to 140 for both. Nothing was resampled to a fixed
    // width, no two features were aligned, and the average was the middle of a
    // short gene against the start of a long one.
    const shipped = { body: 100, flank: 2000, step: 50, lengthOf: (): number => 1e9 }
    for (const length of [5000, 20_000, 100_000]) {
      for (const strand of [1, -1]) {
        const start = 100_000
        const { windows, layout } = scaledWindows(
          [{ contig: 'chrI', start, end: start + length, strand }],
          shipped,
        )
        const row = windowRow(indicator(windows[0], start, start + length), windows[0], layout.slots)
        const body = Array.from({ length: layout.slots }, (_, column) =>
          column >= layout.bodyFrom && column < layout.bodyTo ? 1 : 0,
        )
        // Exactly, not nearly: a column is wholly body or wholly flank here, so
        // anything in between is a boundary in the wrong place.
        expect(Array.from(row), `${length} bp on strand ${strand}`).toEqual(body)
      }
    }
  })

  it('keeps the flanks in base pairs while the body is resampled', () => {
    // The other half of the same promise, and the half a body-only fix would
    // break: the ends of a scaled plot are `step` base pairs a column at the
    // feature's own coordinates, however long the feature is. The first upstream
    // column of a 2 kb flank at 500 bp holds [-2000, -1500) from the start.
    const { windows, layout } = scaledWindows(
      [{ contig: 'chrI', start: 100_000, end: 150_000, strand: 1 }],
      { body: 10, flank: 2000, step: 500, lengthOf: (): number => 1e9 },
    )
    const row = windowRow(indicator(windows[0], 98_000, 98_500), windows[0], layout.slots)
    expect(layout.bodyFrom).toBe(4)
    expect(Array.from(row.slice(0, 4))).toEqual([1, 0, 0, 0])
  })
})

describe('windowRow', () => {
  it('area-weights an interval across the columns it covers', () => {
    const window = {
      contig: 'chrI',
      start: 0,
      end: 100,
      strand: 1,
      slotFrom: 0,
      slotTo: 10,
    }
    // Signal over the first half only: five columns at 1, five empty.
    const row = windowRow(samples('chrI', 0, 50), window, 10)
    expect(Array.from(row.slice(0, 5))).toEqual([1, 1, 1, 1, 1])
    for (const value of row.slice(5)) expect(value).toBeNaN()
  })

  it('reverses the row for a minus-strand feature', () => {
    const window = {
      contig: 'chrI',
      start: 0,
      end: 100,
      strand: -1,
      slotFrom: 0,
      slotTo: 10,
    }
    const row = windowRow(samples('chrI', 0, 50), window, 10)
    // The same signal, read right to left, so the filled half is the far one.
    for (const value of row.slice(0, 5)) expect(value).toBeNaN()
    expect(Array.from(row.slice(5))).toEqual([1, 1, 1, 1, 1])
  })

  it('maps a reference-point window exactly as it always has', () => {
    // Reference-point mode is what the pyBigWig goldens compare against, and
    // teaching `windowRow` about scaled-region bodies must not have moved it by
    // a single bit. These are the numbers the one linear map produced before
    // `Window.body` existed, over intervals deliberately out of step with the
    // columns so that every column is a genuine mixture of two of them —
    // asserted exactly rather than to a tolerance, because a tolerance is
    // precisely what would let a reformulation drift.
    const uneven: TrackSamples = {
      contig: 'chrI',
      start: 1000,
      end: 1500,
      starts: Int32Array.from([950, 1063, 1211, 1288, 1402]),
      ends: Int32Array.from([1063, 1211, 1288, 1402, 1600]),
      values: Float32Array.from([2, 5, 11, 7, 3]),
      min: null,
      max: null,
      variant: null,
      summary: false,
    }
    const at = (strand: number, slotFrom: number, slotTo: number): number[] =>
      Array.from(
        windowRow(uneven, { contig: 'chrI', start: 1000, end: 1500, strand, slotFrom, slotTo }, 10),
      )
    expect(at(1, 0, 10)).toEqual([
      2, 4.22, 5, 5.000000000000001, 9.680000000000001, 10.039999999999997, 7, 7, 3.16, 3,
    ])
    expect(at(-1, 0, 10)).toEqual([
      3.0000000000000004, 3.160000000000002, 7, 6.999999999999999, 10.039999999999997,
      9.680000000000005, 5, 5, 4.219999999999999, 2,
    ])
    const NA = Number.NaN
    expect(at(1, 3, 8)).toEqual([
      NA, NA, NA, 3.1100000000000003, 5, 9.860000000000001, 6.999999999999999, 3.08, NA, NA,
    ])
  })

  it('lands a clipped window in the slots it covers and no others', () => {
    const window = {
      contig: 'chrI',
      start: 0,
      end: 50,
      strand: 1,
      slotFrom: 5,
      slotTo: 10,
    }
    const row = windowRow(samples('chrI', 0, 50), window, 10)
    for (const value of row.slice(0, 5)) expect(value).toBeNaN()
    expect(Array.from(row.slice(5))).toEqual([1, 1, 1, 1, 1])
  })
})

describe('aggregate', () => {
  it('averages the features that reached a column, skipping the ones that did not', () => {
    const out = aggregate(rows([[1, 2], [3, Number.NaN]]), 2, 2, {
      average: 'mean',
      trim: 0.1,
      band: 'none',
      iterations: 0,
      level: 0.95,
      rng: makeRandom(1),
    })
    expect(out.mean[0]).toBe(2)
    // Only one feature had evidence for the second column.
    expect(out.mean[1]).toBe(2)
    expect(out.n).toBe(2)
  })

  it('offers a median, for a set the mean does not describe', () => {
    const out = aggregate(rows([[1], [1], [100]]), 3, 1, {
      average: 'median',
      trim: 0.1,
      band: 'none',
      iterations: 0,
      level: 0.95,
      rng: makeRandom(1),
    })
    expect(out.mean[0]).toBe(1)
  })

  it('gives the same band twice for the same seed', () => {
    const data = rows([[1], [2], [3], [4], [5], [6], [7], [8]])
    const run = (seed: number): [number, number] => {
      const out = aggregate(data, 8, 1, {
        average: 'mean',
        trim: 0.1,
        band: 'bootstrap',
        iterations: 200,
        level: 0.95,
        rng: makeRandom(seed),
      })
      return [out.low[0], out.high[0]]
    }
    // S16.4: a figure has to come out the same twice.
    expect(run(7)).toEqual(run(7))
    // And the seed has to *matter*, checked across several rather than against
    // one other: a percentile of a bootstrap over eight values is quantised, so
    // any two given seeds can legitimately land on the same bound, and a test
    // that asserted otherwise would fail for a reason that is not a bug.
    const bounds = [1, 2, 3, 4, 5].map((seed) => run(seed).join())
    expect(new Set(bounds).size).toBeGreaterThan(1)
  })

  it('puts the band around the average rather than through it', () => {
    const data = rows([[1], [2], [3], [4], [5], [6], [7], [8]])
    const out = aggregate(data, 8, 1, {
      average: 'mean',
      trim: 0.1,
      band: 'bootstrap',
      iterations: 400,
      level: 0.95,
      rng: makeRandom(3),
    })
    expect(out.low[0]).toBeLessThanOrEqual(out.mean[0])
    expect(out.high[0]).toBeGreaterThanOrEqual(out.mean[0])
  })

  it('answers an empty set without throwing', () => {
    const out = aggregate(new Float64Array(0), 0, 3, {
      average: 'mean',
      trim: 0.1,
      band: 'bootstrap',
      iterations: 10,
      level: 0.95,
      rng: makeRandom(1),
    })
    expect(out.n).toBe(0)
    expect(Array.from(out.mean).every(Number.isNaN)).toBe(true)
  })
})

describe('standardiseTrack', () => {
  /** The mean of a block's finite values, which is what a flat curve reads as. */
  const meanOf = (block: Float64Array): number => {
    const finite = Array.from(block).filter(Number.isFinite)
    return finite.reduce((total, value) => total + value, 0) / finite.length
  }

  it('puts two tracks of wildly different scales on one axis', () => {
    // The same shape twice, once in something like CPM and once in something
    // like a log2 ratio. Drawn raw they share no axis at all — one of them is a
    // flat line along the bottom of the frame — and standardised they are the
    // same curve, which is the claim the option makes.
    const cpm = rows([[100, 300], [200, 400]])
    const ratio = rows([[-1.5, -0.5], [-1, 0]])
    expect(Math.max(...cpm) - Math.min(...cpm)).toBeGreaterThan(
      100 * (Math.max(...ratio) - Math.min(...ratio)),
    )

    standardiseTrack([cpm])
    standardiseTrack([ratio])
    const options = {
      average: 'mean' as const,
      trim: 0.1,
      band: 'none' as const,
      iterations: 0,
      level: 0.95,
      rng: makeRandom(1),
    }
    const a = aggregate(cpm, 2, 2, options)
    const b = aggregate(ratio, 2, 2, options)
    for (let slot = 0; slot < 2; slot++) expect(a.mean[slot]).toBeCloseTo(b.mean[slot], 12)
    // And on a scale a reader can put a number to: the curve is in standard
    // deviations, so a two-column run over four values lands inside ±2.
    for (const value of a.mean) expect(Math.abs(value)).toBeLessThan(2)
  })

  it('centres a constant track rather than dividing by nothing', () => {
    // Zero spread: dividing would fill the plot with ±Infinity, which is not a
    // picture of anything and which the average and the bootstrap both carry.
    const flat = rows([[7, 7], [7, 7]])
    const stats = standardiseTrack([flat])
    expect(stats.scaled).toBe(false)
    expect(stats.sd).toBe(0)
    expect(Array.from(flat)).toEqual([0, 0, 0, 0])
    const out = aggregate(flat, 2, 2, {
      average: 'mean',
      trim: 0.1,
      band: 'sd',
      iterations: 0,
      level: 0.95,
      rng: makeRandom(1),
    })
    expect(Array.from(out.mean).every(Number.isFinite)).toBe(true)
  })

  it('says nothing about a track with one observation, and poisons nothing', () => {
    // A sample standard deviation needs a second observation; `NaN` there means
    // *no spread measured*, which is not a spread of none — so this is centred
    // too, and the gap beside it is still a gap.
    const lonely = rows([[5, Number.NaN]])
    const stats = standardiseTrack([lonely])
    expect(stats.scaled).toBe(false)
    expect(stats.sd).toBeNaN()
    expect(lonely[0]).toBe(0)
    expect(lonely[1]).toBeNaN()
  })

  it('leaves a gap a gap, and keeps it out of the statistics', () => {
    // The uncovered slots are `NaN` in both rows, so the mean and the SD are the
    // ones of the first column alone — and standardising must not fill them in
    // with a 0, which would plant a value one SD below the mean everywhere no
    // read reached.
    const gappy = rows([[1, Number.NaN], [3, Number.NaN]])
    const stats = standardiseTrack([gappy])
    expect(stats.mean).toBe(2)
    expect(stats.sd).toBeCloseTo(Math.SQRT2, 12)
    expect(gappy[0]).toBeCloseTo(-Math.SQRT1_2, 12)
    expect(gappy[2]).toBeCloseTo(Math.SQRT1_2, 12)
    expect(gappy[1]).toBeNaN()
    expect(gappy[3]).toBeNaN()
  })

  it('standardises a track\'s ranking groups together, so their offset survives', () => {
    // The point of the whole parameter. Two groups of one track, the top one ten
    // units above the bottom one: standardised together they stay apart by ten
    // pooled SDs' worth, and the ranking the reader split the set for is still
    // in the picture.
    const top = rows([[10, 12], [11, 13]])
    const bottom = rows([[0, 2], [1, 3]])
    const stats = standardiseTrack([top, bottom])
    expect(stats.mean).toBe(6.5)
    expect(stats.scaled).toBe(true)

    const options = {
      average: 'mean' as const,
      trim: 0.1,
      band: 'none' as const,
      iterations: 0,
      level: 0.95,
      rng: makeRandom(1),
    }
    const high = aggregate(top, 2, 2, options)
    const low = aggregate(bottom, 2, 2, options)
    for (let slot = 0; slot < 2; slot++) {
      expect(high.mean[slot]).toBeGreaterThan(low.mean[slot])
      // Exactly the raw offset, in units of the pooled spread.
      expect(high.mean[slot] - low.mean[slot]).toBeCloseTo(10 / stats.sd, 12)
    }

    // The counterfactual, which is what makes the assertion above worth making:
    // the same two groups standardised one at a time both come back centred on
    // zero, the offset gone and the legend the only place the ranking survives.
    const apartTop = rows([[10, 12], [11, 13]])
    const apartBottom = rows([[0, 2], [1, 3]])
    standardiseTrack([apartTop])
    standardiseTrack([apartBottom])
    expect(meanOf(apartTop)).toBeCloseTo(0, 12)
    expect(meanOf(apartBottom)).toBeCloseTo(0, 12)
  })

  it('answers a track with nothing in it without throwing', () => {
    const empty = rows([[Number.NaN, Number.NaN]])
    const stats = standardiseTrack([empty])
    expect(stats.mean).toBeNaN()
    expect(stats.scaled).toBe(false)
    expect(Array.from(empty).every(Number.isNaN)).toBe(true)
  })
})

describe('axisFor', () => {
  it('is base pairs from the anchor for a reference-point plot', () => {
    const { x, label } = axisFor({ slots: 4, bodyFrom: 2, bodyTo: 2, flankStep: 100 })
    expect(Array.from(x)).toEqual([-150, -50, 50, 150])
    expect(label).toContain('bp')
  })

  it('is the column index for a scaled plot, and says so', () => {
    // There is no single honest unit across a flank in base pairs and a body in
    // proportion, so the axis does not invent one.
    const { x, label } = axisFor({ slots: 4, bodyFrom: 1, bodyTo: 3, flankStep: 100 })
    expect(Array.from(x)).toEqual([0, 1, 2, 3])
    expect(label).not.toContain('bp')
  })
})
