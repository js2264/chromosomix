/**
 * Track correlation: what a window's value is, and what the run reads to get it.
 *
 * A window's value is the **mean over the bases it covers** — pyBigWig's
 * `stats(…, exact=True)`, and what deepTools reads wherever it reads base-level
 * data — so every record is weighted by how much of the window it covers. It was
 * weighted by its whole width, and read from whatever zoom level the window's
 * size selected for drawing: a 17 kb record laid over a 10 kb window put the
 * neighbours' signal into it, and a mouse genome's correlation came out at 0.81
 * where the windows' own means give 0.88. The reference here is that mean taken
 * base by base, which shares nothing with the runner but the definition.
 */

import { describe, expect, it } from 'vitest'

import type { TrackJobContext } from '@/analysis/job'
import { runTrackCorrelation } from '@/analysis/run/trackcorr'
import { pearson, spearman } from '@/analysis/stats'
import type { AnalysisFraming, Params, TableOutput, TaskOutput } from '@/analysis/types'
import type { FeatureSet, Region, TrackSamples, TrackSampleSet } from '@/annotations/types'

const FRAMING: AnalysisFraming = {
  uri: 'tracks',
  label: 'loaded tracks, no contact map',
  binsize: 0,
  binsPerCell: 1,
  rows: [0, 0],
  cols: [0, 0],
  balance: false,
  value: '',
  normalise: null,
  level: 'bin',
}

/** A bigWig's records: half-open intervals with one value each, anywhere. */
interface Record3 {
  start: number
  end: number
  value: number
}

/** Records of varied widths with gaps between some, seeded so the test is fixed. */
function records(length: number, seed: number): Record3[] {
  let state = seed
  const next = (): number => {
    state = (state * 1103515245 + 12345) % 2147483648
    return state / 2147483648
  }
  const out: Record3[] = []
  let at = 0
  while (at < length) {
    const width = 1 + Math.floor(next() * 140)
    const end = Math.min(length, at + width)
    // A tenth of the genome has no record at all, which a mean must skip.
    if (next() > 0.1) out.push({ start: at, end, value: Math.round(next() * 1000) / 10 })
    at = end
  }
  return out
}

/** What a bigWig answers at base resolution: the records overlapping each region, unclipped. */
function answer(held: Record<string, Record3[]>, regions: Region[]): TrackSampleSet {
  const out: TrackSamples[] = []
  for (const region of regions) {
    const hits = held[region.contig].filter((r) => r.end > region.start && r.start < region.end)
    out.push({
      contig: region.contig,
      start: region.start,
      end: region.end,
      starts: Int32Array.from(hits.map((r) => r.start)),
      ends: Int32Array.from(hits.map((r) => r.end)),
      values: Float32Array.from(hits.map((r) => r.value)),
      min: null,
      max: null,
      variant: null,
      summary: false,
    })
  }
  return { basesPerPixel: 1, regions: out, extent: null }
}

/** The mean over the bases a track covers in `[from, to)`, base by base. */
function exactMean(held: Record3[], from: number, to: number): number {
  let total = 0
  let bases = 0
  for (const r of held) {
    for (let base = Math.max(from, r.start); base < Math.min(to, r.end); base++) {
      total += Math.fround(r.value)
      bases++
    }
  }
  return bases > 0 ? total / bases : Number.NaN
}

interface Call {
  entry: string
  regions: Region[]
  basesPerPixel: number
}

async function run(
  params: Params,
  tracks: Record<string, Record<string, Record3[]>>,
  lengths: Record<string, number>,
  extra: { features?: FeatureSet } = {},
): Promise<{ outputs: TaskOutput[]; calls: Call[] }> {
  const calls: Call[] = []
  const job: TrackJobContext = {
    params: { tracks: Object.keys(tracks), over: 'bins', binsize: 100, method: 'pearson', ...params },
    framing: FRAMING,
    inputs: {
      contigLengths: lengths,
      ...(extra.features === undefined ? {} : { features: { features: extra.features } }),
    } as never,
    cancelled: () => false,
    throwIfCancelled: () => {},
    progress: () => {},
    note: () => {},
    sample: async (entry, regions, basesPerPixel) => {
      calls.push({ entry, regions: regions.map((r) => ({ ...r })), basesPerPixel })
      return answer(tracks[entry], regions)
    },
    lengthOf: (contig) => lengths[contig],
  }
  return { outputs: await runTrackCorrelation(job), calls }
}

const pairs = (outputs: TaskOutput[]): TableOutput =>
  outputs.find((one): one is TableOutput => one.kind === 'table') as TableOutput

describe('a window’s value', () => {
  it('is the mean over the bases it covers, each record weighted by its overlap', async () => {
    // Four windows of 100 bp across records [0, 100) at 1, [100, 280) at 3 and
    // [280, 400) at 9. The third window is 80 bases of the second record and 20
    // of the third, so its mean is 4.2; weighted by the two records' whole widths
    // it came out at (3·180 + 9·120) / 300 = 5.4 — a different shape, and so a
    // different correlation, rather than the same vector rescaled.
    const a = {
      I: [
        { start: 0, end: 100, value: 1 },
        { start: 100, end: 280, value: 3 },
        { start: 280, end: 400, value: 9 },
      ],
    }
    const b = { I: [0, 1, 2, 3].map((k) => ({ start: k * 100, end: (k + 1) * 100, value: k + 1 })) }
    const { outputs } = await run({}, { a, b }, { I: 400 })
    const r = Number(pairs(outputs).rows[0].r)
    expect(r).toBeCloseTo(pearson([1, 3, 4.2, 9], [1, 2, 3, 4]), 12)
    expect(Math.abs(r - pearson([1, 3, 5.4, 9], [1, 2, 3, 4]))).toBeGreaterThan(1e-3)
  })

  it('agrees with the base-by-base mean, and its correlation with the one taken from it', async () => {
    const lengths = { I: 23_456, II: 9_870 }
    const make = (seed: number): Record<string, Record3[]> => ({
      I: records(lengths.I, seed),
      II: records(lengths.II, seed + 7),
    })
    const tracks = { x: make(11), y: make(29) }
    for (const [method, measure] of [
      ['pearson', pearson],
      ['spearman', spearman],
    ] as const) {
      for (const size of [100, 1_000, 3_000]) {
        const { outputs } = await run({ method, binsize: size }, tracks, lengths)
        const columns = Object.values(tracks).map((track) => {
          const out: number[] = []
          for (const [contig, length] of Object.entries(lengths)) {
            for (let start = 0; start + size <= length; start += size) {
              out.push(exactMean(track[contig], start, start + size))
            }
          }
          return out
        })
        expect(Number(pairs(outputs).rows[0].r), `${method} at ${size}`).toBeCloseTo(
          measure(columns[0], columns[1]),
          10,
        )
      }
    }
  })

  it('is read at base resolution, never at a zoom level, whatever the window', async () => {
    const tracks = { x: { I: records(50_000, 3) }, y: { I: records(50_000, 5) } }
    const { calls } = await run({ binsize: 10_000 }, tracks, { I: 50_000 })
    expect(calls.length).toBeGreaterThan(0)
    expect(calls.every((call) => call.basesPerPixel === 1)).toBe(true)
  })

  it('reads a long sequence a megabase at a time, every window once', async () => {
    // 3.5 Mb at 100 bp is 35,000 windows: asked for as one request each, a
    // 61 Mb chromosome was 614,000 of them and the run was killed for memory.
    const length = 3_500_000
    const tracks = { x: { I: [{ start: 0, end: length, value: 1 }] }, y: { I: [{ start: 0, end: length, value: 2 }] } }
    const { calls } = await run({}, tracks, { I: length })
    const mine = calls.filter((call) => call.entry === 'x')
    expect(mine.length).toBeGreaterThan(1)
    // What one request covers, all its regions together, is what it holds.
    for (const call of mine) {
      const span = call.regions.reduce((sum, r) => sum + (r.end - r.start), 0)
      expect(span).toBeLessThanOrEqual(1 << 20)
    }
    const reads = mine.flatMap((call) => call.regions)
    // Laid end to end from 0, with no gap and no overlap, to the last whole window.
    let at = 0
    for (const read of reads) {
      expect(read.start).toBe(at)
      expect(read.start % 100).toBe(0)
      at = read.end
    }
    expect(at).toBe(length)
  })

  it('takes whole windows only', async () => {
    const tracks = { x: { I: records(1_050, 1) }, y: { I: records(1_050, 2) } }
    const { outputs } = await run({}, tracks, { I: 1_050 })
    const matrix = outputs.find((one) => one.kind === 'matrix')
    expect(matrix?.kind === 'matrix' ? matrix.stats?.[0]?.value : undefined).toBe(10)
  })
})

describe('over a feature set', () => {
  it('is the mean over each feature’s own bases, records clipped to it', async () => {
    const a = { I: [{ start: 0, end: 1_000, value: 4 }, { start: 1_000, end: 2_000, value: 8 }] }
    const b = { I: [{ start: 0, end: 2_000, value: 1 }] }
    const c = { I: records(2_000, 9) }
    const n = 3
    // Three features: wholly in the first record, straddling both, wholly in the second.
    const spans: Array<[number, number]> = [[100, 300], [900, 1_300], [1_500, 1_900]]
    const features = {
      contigs: ['I'],
      length: n,
      contig: new Int32Array(n),
      start: Int32Array.from(spans.map(([s]) => s)),
      end: Int32Array.from(spans.map(([, e]) => e)),
    } as unknown as FeatureSet
    const { outputs } = await run({ over: 'features', features: 'peaks' }, { a, b, c }, { I: 2_000 }, { features })
    const rows = pairs(outputs).rows
    const ac = rows.find((row) => [row.a, row.b].sort().join() === 'a,c')
    // a over the three is [4, (4·100 + 8·300) / 400 = 7, 8].
    const means = spans.map(([s, e]) => exactMean(c.I, s, e))
    expect(Number(ac?.r)).toBeCloseTo(pearson([4, 7, 8], means), 10)
  })
})
