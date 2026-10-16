/**
 * Features that share a window, through the metaplot runner.
 *
 * Transcripts of one gene that start at one TSS ask for the same stretch of a
 * track — a fifth of the RefSeq set does — and the runner asks the track for
 * each distinct stretch once and makes each distinct row once (`rowsFor`). What
 * that must not change is any number: every feature's row is still the row of
 * its own window, a shared one included, which is what this holds the run to —
 * against `windowRow` on each feature's window, asked of the same track with no
 * sharing at all.
 */

import { describe, expect, it } from 'vitest'

import { referenceWindows, windowRow } from '@/analysis/metaplot'
import { runMetaplot } from '@/analysis/run/metaplot'
import type { TrackJobContext } from '@/analysis/job'
import type { AnalysisFraming, CurveOutput, MatrixOutput, Params } from '@/analysis/types'
import type { FeatureSet, Region, TrackSampleSet, TrackSamples } from '@/annotations/types'

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
 * Seven features over three stretches of the track: three plus-strand
 * transcripts from one start; two minus-strand ones ending at one place and a
 * plus-strand one starting there — one stretch, read both ways, so two rows —
 * and one feature of its own. Four distinct rows in all.
 */
const FEATURES = [
  { start: 5000, end: 9000, strand: 1 },
  { start: 5000, end: 6200, strand: 1 },
  { start: 5000, end: 12_000, strand: 1 },
  { start: 14_000, end: 20_000, strand: -1 },
  { start: 17_500, end: 20_000, strand: -1 },
  { start: 20_000, end: 23_000, strand: 1 },
  { start: 31_000, end: 33_000, strand: 1 },
]

function features(): FeatureSet {
  const n = FEATURES.length
  return {
    contigs: ['I'],
    length: n,
    contig: new Int32Array(n),
    start: Int32Array.from(FEATURES.map((f) => f.start)),
    end: Int32Array.from(FEATURES.map((f) => f.end)),
    strand: Int8Array.from(FEATURES.map((f) => f.strand)),
    score: Float32Array.from(FEATURES.map((_, i) => n - i)),
    name: FEATURES.map((_, i) => `f${i}`),
    id: FEATURES.map(() => ''),
    detail: FEATURES.map(() => ''),
    exonAt: new Int32Array(n + 1),
    exonStart: new Int32Array(0),
    exonEnd: new Int32Array(0),
    cdsStart: Int32Array.from(new Array<number>(n).fill(-1)),
    cdsEnd: Int32Array.from(new Array<number>(n).fill(-1)),
    contigAt: Int32Array.from([0, n]),
    maxSpan: Int32Array.from([Math.max(...FEATURES.map((f) => f.end - f.start))]),
  }
}

/**
 * A track of uneven intervals — 1 to 37 bp each, some missing, values that
 * differ from place to place — so a row is real arithmetic over many intervals
 * rather than one flat value.
 */
function track(region: Region): TrackSamples {
  const starts: number[] = []
  const ends: number[] = []
  const values: number[] = []
  for (let at = 0; at < 40_000; ) {
    const width = 1 + ((at * 7919) % 37)
    if (at + width > region.start && at < region.end && (at / 7) % 11 !== 3) {
      starts.push(at)
      ends.push(at + width)
      values.push(Math.sin(at / 97) * 10 + (at % 13))
    }
    at += width
  }
  return {
    contig: region.contig,
    start: region.start,
    end: region.end,
    starts: Int32Array.from(starts),
    ends: Int32Array.from(ends),
    values: Float32Array.from(values),
    min: null,
    max: null,
    variant: null,
    summary: false,
  }
}

function job(params: Params, asked: Region[]): TrackJobContext {
  return {
    params,
    framing: FRAMING,
    inputs: { features: { features: features() }, labels: { t1: 'signal' } },
    cancelled: () => false,
    throwIfCancelled: () => {},
    progress: () => {},
    note: () => {},
    sample: (_entry, regions): Promise<TrackSampleSet> => {
      asked.push(...regions)
      return Promise.resolve({ basesPerPixel: 50, extent: null, regions: regions.map(track) })
    },
    lengthOf: () => 100_000,
  }
}

const PARAMS: Params = {
  tracks: ['t1'],
  features: 'ann1',
  mode: 'reference',
  at: 'start',
  flank: 2000,
  step: 50,
  stranded: true,
  subset: 'all',
  average: 'mean',
  band: 'none',
  heatmap: true,
}

describe('the metaplot runner, over features that share a window', () => {
  it('asks the track for each distinct stretch once', async () => {
    const asked: Region[] = []
    await runMetaplot(job(PARAMS, asked))
    const stretches = asked.map((region) => `${region.contig}:${region.start}-${region.end}`)
    expect(new Set(stretches).size).toBe(stretches.length)
    expect(stretches).toHaveLength(3)
  })

  it('gives every feature the row of its own window, as windowRow makes it', async () => {
    const outputs = await runMetaplot(job(PARAMS, []))
    const heatmap = outputs.find((output): output is MatrixOutput => output.kind === 'matrix')
    const curve = outputs.find((output): output is CurveOutput => output.kind === 'curve')
    if (heatmap === undefined || curve === undefined) throw new Error('the run drew no heatmap or no curve')

    // Each feature's row, from its own window and its own reading of the track.
    const { windows, layout } = referenceWindows(
      FEATURES.map((f) => ({ contig: 'I', ...f })),
      { at: 'start', flank: 2000, step: 50, lengthOf: () => 100_000 },
    )
    expect(windows).toHaveLength(FEATURES.length)
    const want = windows.map((window) => windowRow(track(window), window, layout.slots))

    // The heatmap holds them in its own order; as a set of rows, they are these.
    const got: number[][] = []
    for (let row = 0; row < heatmap.nrows; row++) {
      got.push(Array.from(heatmap.values.subarray(row * heatmap.ncols, (row + 1) * heatmap.ncols)))
    }
    const key = (row: ArrayLike<number>): string => Array.from(row, (v) => Math.fround(v)).join(',')
    expect(got.map(key).sort()).toEqual(want.map(key).sort())

    // And the curve is their mean, slot by slot.
    for (let slot = 0; slot < layout.slots; slot++) {
      let total = 0
      let seen = 0
      for (const row of want) {
        if (!Number.isFinite(row[slot])) continue
        total += row[slot]
        seen++
      }
      expect(seen).toBeGreaterThan(0)
      expect(curve.series[0].y[slot]).toBeCloseTo(total / seen, 12)
    }
  })
})
