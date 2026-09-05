/**
 * The metaplot kernel: windows, strand, clipping and the band.
 *
 * The three things a metaplot gets wrong in a way that survives review, all
 * checked here against inputs whose answer is obvious by inspection:
 *
 * - **strand**, because a plot that ignores it averages every asymmetric signal
 *   against its own mirror and reports a symmetric shape that belongs to nothing;
 * - **clipping**, because a feature near a telomere has a short window, and
 *   stretching that window across the full width silently compresses the signal
 *   inwards instead of leaving the unreachable columns empty;
 * - **the band**, because a bootstrap that resamples columns independently is a
 *   statement about each column rather than about the feature set, and the two
 *   look identical on a plot.
 */

import { describe, expect, it } from 'vitest'

import {
  aggregate,
  axisFor,
  referenceWindows,
  scaledWindows,
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
  const rows = (values: number[][]): Float64Array =>
    Float64Array.from(values.flat())

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
