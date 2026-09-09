/**
 * The metaplot runner's z-score, which is a claim about *which rows* rather than
 * about the arithmetic.
 *
 * `standardiseTrack` is checked against inputs whose answer is obvious in
 * `analysis-metaplot.test.ts`. What cannot be checked there is the thing the
 * option is easiest to get wrong in: **the population**. Standardising is per
 * track and over the union of that track's ranking groups, and a runner that
 * called the kernel once per group as it read each group — the shape the loop
 * had before, and the shape it falls back into under any tidy-up that moves the
 * call inside the inner loop — would pass every kernel test and still produce
 * the one figure the option must never produce: four quartiles all re-centred on
 * zero, the ranking alive in the legend and gone from the picture.
 *
 * So this drives `runMetaplot` itself, with two groups of one track that are ten
 * units apart, and asserts they are still ten units apart afterwards. The rest
 * of the file covers what the option changes around the numbers: the y axis is
 * relabelled, and the heatmap is standardised alongside the curve rather than
 * quietly staying raw underneath it.
 */

import { describe, expect, it } from 'vitest'

import { runMetaplot } from '@/analysis/run/metaplot'
import type { TrackJobContext } from '@/analysis/job'
import type { AnalysisFraming, CurveOutput, MatrixOutput, Params } from '@/analysis/types'
import type { FeatureSet, TrackSampleSet } from '@/annotations/types'

const FRAMING: AnalysisFraming = {
  uri: 'test.cool',
  label: 'I',
  binsize: 1000,
  binsPerCell: 1,
  rows: [0, 100],
  cols: [0, 100],
  balance: false,
  value: '',
  normalise: null,
  level: 'bin',
}

/**
 * Four features on one sequence, ranked by a score column.
 *
 * Descending score is the runner's own order, so `groups: 2` splits them into
 * the first two and the last two — which is the split the signal below is built
 * to make visible.
 */
function fourFeatures(): FeatureSet {
  const starts = [1000, 2000, 3000, 4000]
  const n = starts.length
  return {
    contigs: ['I'],
    length: n,
    contig: new Int32Array(n),
    start: Int32Array.from(starts),
    end: Int32Array.from(starts.map((from) => from + 100)),
    strand: new Int8Array(n),
    score: Float32Array.from([4, 3, 2, 1]),
    name: starts.map((_, i) => `f${i}`),
    id: starts.map(() => ''),
    detail: starts.map(() => ''),
    exonAt: new Int32Array(n + 1),
    exonStart: new Int32Array(0),
    exonEnd: new Int32Array(0),
    cdsStart: Int32Array.from(new Array<number>(n).fill(-1)),
    cdsEnd: Int32Array.from(new Array<number>(n).fill(-1)),
    contigAt: Int32Array.from([0, n]),
    maxSpan: Int32Array.from([100]),
  }
}

/**
 * The signal each feature sits in the middle of: flat over its whole window.
 *
 * Keyed by the *window's* start, which is the feature's start less the flank —
 * the runner asks by coordinate and matches the reply by coordinate, so this is
 * the same lookup from the other side. The top two features are at 10 and 12,
 * the bottom two at 0 and 2: two groups whose means are ten apart, which is the
 * offset the whole file is about.
 */
const SIGNAL: Record<number, number> = { 900: 10, 1900: 12, 2900: 0, 3900: 2 }

function job(params: Params): TrackJobContext {
  return {
    params,
    framing: FRAMING,
    inputs: { features: { features: fourFeatures() }, labels: { t1: 'signal' } },
    cancelled: () => false,
    throwIfCancelled: () => {},
    progress: () => {},
    note: () => {},
    sample: (_entry, regions): Promise<TrackSampleSet> =>
      Promise.resolve({
        basesPerPixel: 50,
        extent: null,
        regions: regions.map((region) => ({
          contig: region.contig,
          start: region.start,
          end: region.end,
          starts: Int32Array.from([region.start]),
          ends: Int32Array.from([region.end]),
          values: Float32Array.from([SIGNAL[region.start] ?? Number.NaN]),
          min: null,
          max: null,
          variant: null,
          summary: false,
        })),
      }),
    lengthOf: () => 100_000,
  }
}

/** One track, two ranking groups, a flat two-column window either side. */
const PARAMS = (zscore: boolean): Params => ({
  tracks: ['t1'],
  features: 'ann1',
  mode: 'reference',
  at: 'start',
  flank: 100,
  step: 50,
  stranded: true,
  rankBy: 'score',
  subset: 'groups',
  groups: 2,
  zscore,
  average: 'mean',
  band: 'none',
  heatmap: true,
})

const curveOf = (outputs: Awaited<ReturnType<typeof runMetaplot>>): CurveOutput => {
  const found = outputs.find((output): output is CurveOutput => output.kind === 'curve')
  if (found === undefined) throw new Error('the run produced no curve')
  return found
}

const matrixOf = (outputs: Awaited<ReturnType<typeof runMetaplot>>): MatrixOutput => {
  const found = outputs.find((output): output is MatrixOutput => output.kind === 'matrix')
  if (found === undefined) throw new Error('the run produced no heatmap')
  return found
}

describe('the metaplot runner, standardising', () => {
  it('leaves the figure alone when nobody asked for it', async () => {
    const curve = curveOf(await runMetaplot(job(PARAMS(false))))
    expect(curve.series.map((series) => series.name)).toEqual([
      'signal · group 1',
      'signal · group 2',
    ])
    // The raw means, in the track's own units, and the label that names them.
    expect(Array.from(curve.series[0].y)).toEqual([11, 11, 11, 11])
    expect(Array.from(curve.series[1].y)).toEqual([1, 1, 1, 1])
    expect(curve.yLabel).toBe('Mean signal')
  })

  it('standardises a track across its groups, so the ranking survives', async () => {
    const raw = curveOf(await runMetaplot(job(PARAMS(false))))
    const curve = curveOf(await runMetaplot(job(PARAMS(true))))

    // Sixteen values — two groups of two features over four columns — mean 6,
    // sample SD over the union. The groups' means are 11 and 1.
    const sd = Math.sqrt((4 * 16 + 4 * 36 + 4 * 36 + 4 * 16) / 15)
    for (let slot = 0; slot < 4; slot++) {
      expect(curve.series[0].y[slot]).toBeCloseTo((11 - 6) / sd, 12)
      expect(curve.series[1].y[slot]).toBeCloseTo((1 - 6) / sd, 12)
      // The claim, stated the way a reader would state it: the gap between the
      // groups is the raw gap in units of the track's spread. Standardised group
      // by group both curves would sit on zero and this would be 0.
      expect(curve.series[0].y[slot] - curve.series[1].y[slot]).toBeCloseTo(10 / sd, 12)
      expect(raw.series[0].y[slot] - raw.series[1].y[slot]).toBe(10)
    }
    expect(curve.series[0].y[0]).toBeGreaterThan(0)
    expect(curve.series[1].y[0]).toBeLessThan(0)
  })

  it('relabels the y axis, which no longer carries the track’s unit', async () => {
    const curve = curveOf(await runMetaplot(job(PARAMS(true))))
    expect(curve.yLabel).toContain('z-score')
    expect(curve.yLabel).not.toBe('Mean signal')
  })

  it('draws the heatmap in the same numbers as the curve above it', async () => {
    // The heatmap is built from the very rows the curve was summarised from, so
    // it is standardised or raw exactly as the curve is. Two pictures of one run
    // disagreeing about what was measured is the failure this rules out.
    const raw = matrixOf(await runMetaplot(job(PARAMS(false))))
    const zscored = matrixOf(await runMetaplot(job(PARAMS(true))))
    expect(Math.max(...raw.values)).toBe(12)
    expect(raw.label).not.toContain('z-scored')

    const sd = Math.sqrt((4 * 16 + 4 * 36 + 4 * 36 + 4 * 16) / 15)
    // The first group's two features, at 12 and 10, in standard deviations.
    expect(Math.max(...zscored.values)).toBeCloseTo((12 - 6) / sd, 6)
    expect(Math.min(...zscored.values)).toBeCloseTo((10 - 6) / sd, 6)
    expect(zscored.label).toContain('z-scored')
  })

  it('reads a session stored before the option existed as one with it off', async () => {
    // No `zscore` key at all, which is every metaplot recipe saved so far.
    const params = { ...PARAMS(false) }
    delete params.zscore
    const curve = curveOf(await runMetaplot(job(params)))
    expect(Array.from(curve.series[0].y)).toEqual([11, 11, 11, 11])
    expect(curve.yLabel).toBe('Mean signal')
  })
})
