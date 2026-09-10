/**
 * Scaled-region mode, driven through the runner rather than through the kernel.
 *
 * `analysis-metaplot.test.ts` checks that `windowRow` gives every feature body
 * the same columns. Two things about the mode cannot be checked there, because
 * both are properties of the *loop around* the kernel:
 *
 * - **the columns of a whole run**, which is the claim a reader actually reads
 *   off the figure: two genes an order of magnitude apart in length have to
 *   contribute to the same columns, so the averaged curve steps where the
 *   layout says the body begins rather than ramping across a third of the plot;
 * - **the dropped-feature note**, which is counted over the plan and not over
 *   the sampling. The plan does not depend on the track, so a count accumulated
 *   inside the track loop came out multiplied by however many tracks were
 *   ticked — a note that says a number the reader cannot reconcile with the
 *   feature set in front of them is worse than no note at all.
 */

import { describe, expect, it } from 'vitest'

import { runMetaplot } from '@/analysis/run/metaplot'
import type { TrackJobContext } from '@/analysis/job'
import type { AnalysisFraming, CurveOutput, Params } from '@/analysis/types'
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

/** One sequence's worth of features, from their extents alone. */
function featureSet(extents: ReadonlyArray<[number, number]>): FeatureSet {
  const n = extents.length
  return {
    contigs: ['I'],
    length: n,
    contig: new Int32Array(n),
    start: Int32Array.from(extents.map(([from]) => from)),
    end: Int32Array.from(extents.map(([, to]) => to)),
    strand: new Int8Array(n),
    score: Float32Array.from(extents.map((_, i) => n - i)),
    name: extents.map((_, i) => `f${i}`),
    id: extents.map(() => ''),
    detail: extents.map(() => ''),
    exonAt: new Int32Array(n + 1),
    exonStart: new Int32Array(0),
    exonEnd: new Int32Array(0),
    cdsStart: Int32Array.from(new Array<number>(n).fill(-1)),
    cdsEnd: Int32Array.from(new Array<number>(n).fill(-1)),
    contigAt: Int32Array.from([0, n]),
    maxSpan: Int32Array.from([Math.max(...extents.map(([from, to]) => to - from))]),
  }
}

/**
 * A job over those features whose track reads 1 inside a feature and 0 outside.
 *
 * An exact indicator, so the answer is obvious by inspection: a scaled-region
 * run over it must come back 0 across the flank columns and 1 across the body
 * columns, whatever the features' lengths, because that is what *the body is
 * resampled to a fixed width* means.
 */
function job(
  extents: ReadonlyArray<[number, number]>,
  params: Params,
  notes: string[],
): TrackJobContext {
  return {
    params,
    framing: FRAMING,
    inputs: {
      features: { features: featureSet(extents) },
      labels: { t1: 'one', t2: 'two', t3: 'three' },
    },
    cancelled: () => false,
    throwIfCancelled: () => {},
    progress: () => {},
    note: (text: string) => notes.push(text),
    sample: (_entry, regions): Promise<TrackSampleSet> =>
      Promise.resolve({
        basesPerPixel: 50,
        extent: null,
        regions: regions.map((region) => {
          // Every edge inside the window, in order: the region's own ends plus
          // whichever feature boundaries fall between them.
          const edges = [region.start, region.end]
          for (const [from, to] of extents) {
            for (const edge of [from, to]) {
              if (edge > region.start && edge < region.end) edges.push(edge)
            }
          }
          edges.sort((a, b) => a - b)
          const starts = edges.slice(0, -1)
          const ends = edges.slice(1)
          return {
            contig: region.contig,
            start: region.start,
            end: region.end,
            starts: Int32Array.from(starts),
            ends: Int32Array.from(ends),
            values: Float32Array.from(
              starts.map((from, i) =>
                extents.some(([lo, hi]) => from >= lo && ends[i] <= hi) ? 1 : 0,
              ),
            ),
            min: null,
            max: null,
            variant: null,
            summary: false,
          }
        }),
      }),
    lengthOf: () => 10_000_000,
  }
}

/** The shipped defaults of the mode: 2 kb flanks at 50 bp, a 100-column body. */
const PARAMS = (tracks: string[]): Params => ({
  tracks,
  features: 'ann1',
  mode: 'scaled',
  flank: 2000,
  step: 50,
  body: 100,
  stranded: true,
  subset: 'all',
  average: 'mean',
  band: 'none',
  heatmap: false,
})

const curveOf = (outputs: Awaited<ReturnType<typeof runMetaplot>>): CurveOutput => {
  const found = outputs.find((output): output is CurveOutput => output.kind === 'curve')
  if (found === undefined) throw new Error('the run produced no curve')
  return found
}

describe('the metaplot runner, over scaled regions', () => {
  it('stacks features of wildly different lengths in the same columns', async () => {
    // A 5 kb gene and a 50 kb one, averaged. Mapping each window uniformly put
    // the short one's body in columns 40 to 140 and the long one's in 7 to 173,
    // so the mean of a perfect step function came back as a ramp starting a
    // third of the way along the plot and reading about a half at column 40 —
    // an averaged curve belonging to neither feature, which is the failure the
    // whole mode exists to prevent.
    const notes: string[] = []
    const curve = curveOf(
      await runMetaplot(job([[100_000, 105_000], [300_000, 350_000]], PARAMS(['t1']), notes)),
    )
    const y = Array.from(curve.series[0].y)
    expect(y).toHaveLength(180)
    expect(y.slice(0, 40)).toEqual(new Array<number>(40).fill(0))
    expect(y.slice(40, 140)).toEqual(new Array<number>(100).fill(1))
    expect(y.slice(140)).toEqual(new Array<number>(40).fill(0))
  })

  it('counts a dropped feature once, not once per ticked track', async () => {
    // Two of the six are shorter than the body width. The plan that drops them
    // depends on the features and the window shape and on nothing about the
    // file being read, so it is the same plan for every track — and the note
    // has to say two however many bigWigs are ticked. Accumulated inside the
    // track loop it said six for three tracks: a number that cannot be arrived
    // at from the set the reader loaded.
    const extents: Array<[number, number]> = [
      [100_000, 100_050],
      [200_000, 205_000],
      [300_000, 300_010],
      [400_000, 410_000],
      [500_000, 520_000],
      [600_000, 630_000],
    ]
    const alone: string[] = []
    await runMetaplot(job(extents, PARAMS(['t1']), alone))
    const together: string[] = []
    await runMetaplot(job(extents, PARAMS(['t1', 't2', 't3']), together))

    // The multiplication first, because it is the thing that makes the number
    // unreachable; then the number itself, and the wording — `scaledWindows`
    // drops for two reasons and the note used to name only one of them.
    expect(together).toEqual(alone)
    expect(alone).toHaveLength(1)
    expect(alone[0]).toMatch(/^2 features were dropped/)
    expect(alone[0]).toContain('body width')
  })

  it('says nothing at all when every feature made a window', async () => {
    const notes: string[] = []
    await runMetaplot(job([[100_000, 105_000], [300_000, 350_000]], PARAMS(['t1', 't2']), notes))
    expect(notes).toEqual([])
  })
})
