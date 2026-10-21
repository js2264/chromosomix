/**
 * *Signal by group* (§18.8), run against a genome built so its answers are known.
 *
 * A 100 kb sequence whose track reads 0.7 over its first half and 0.5 over its
 * second, with A called over the first half and B over the next 30 kb: A must
 * come out higher than B and than the rest, every stretch of it higher than
 * every stretch of B, and the grouping by a track's sign must find the same
 * boundary and write it out as intervals. Every track is read at its own
 * resolution, never from a zoom level whose records straddle a stretch's edge.
 */

import { describe, expect, it } from 'vitest'

import { FeatureBuilder } from '@/annotations/featureset'
import type { FeatureSet, Region, TrackSampleSet, TrackSamples } from '@/annotations/types'
import type { TrackJobContext } from '@/analysis/job'
import { cut, runGroupSignal } from '@/analysis/run/groupsignal'
import type {
  AnalysisFraming,
  CurveOutput,
  IntervalsOutput,
  Params,
  TableOutput,
  TaskOutput,
} from '@/analysis/types'

const LENGTH = 100_000

/** Two tracks as functions of position: a GC-like step, and an eigenvector-like sign. */
const TRACKS: Record<string, (at: number) => number> = {
  gc: (at) => (at < 50_000 ? 0.7 : 0.5),
  e1: (at) => (at < 40_000 ? 1 : -1),
  ramp: (at) => at / LENGTH,
}

/** The track's own records, and its one zoom level's: each a mean over its span. */
const OWN = 100
const ZOOM = 896

/** Every resolution a run asked for. */
const asked: number[] = []

/**
 * Answers over each region asked as a bigWig does: from its zoom level where
 * that is at most twice the bases per pixel asked for, as bbi picks one, and
 * from its own records otherwise — a zoom record laid across an edge carries
 * the far side's signal.
 */
function sample(entry: string, regions: Region[], basesPerPixel: number): Promise<TrackSampleSet> {
  asked.push(basesPerPixel)
  const f = TRACKS[entry]
  const width = ZOOM <= 2 * basesPerPixel ? ZOOM : OWN
  const meanOver = (start: number): number => {
    let sum = 0
    for (let at = start; at < start + width; at++) sum += f(at)
    return sum / width
  }
  const answers: TrackSamples[] = regions.map((region) => {
    const from = Math.floor(region.start / width)
    const to = Math.ceil(region.end / width)
    const starts = Int32Array.from({ length: to - from }, (_, i) => (from + i) * width)
    return {
      contig: region.contig,
      start: region.start,
      end: region.end,
      starts,
      ends: Int32Array.from(starts, (start) => start + width),
      values: Float32Array.from(starts, meanOver),
      min: null,
      max: null,
      variant: null,
      summary: width === ZOOM,
    }
  })
  return Promise.resolve({ basesPerPixel, regions: answers, extent: null })
}

function compartments(): FeatureSet {
  const builder = new FeatureBuilder()
  builder.add('chr', 0, 50_000, { name: 'A' })
  builder.add('chr', 50_000, 80_000, { name: 'B' })
  return builder.finish()
}

const FRAMING: AnalysisFraming = {
  uri: 'toy.fa',
  label: 'toy.fa · loaded tracks, no contact map',
  binsize: 0,
  binsPerCell: 1,
  rows: [0, 0],
  cols: [0, 0],
  balance: false,
  value: '',
  normalise: null,
  level: 'bin',
}

async function run(params: Params, set: FeatureSet = compartments()): Promise<{ outputs: TaskOutput[]; notes: string[] }> {
  const notes: string[] = []
  const job: TrackJobContext = {
    params: { tracks: ['gc'], resolution: 10_000, ...params },
    framing: FRAMING,
    inputs: {
      contigLengths: { chr: LENGTH },
      features: { features: set },
      labels: { gc: 'GC content', e1: 'E1', ramp: 'ramp', ab: 'A/B compartments' },
    },
    cancelled: () => false,
    throwIfCancelled: () => {},
    progress: () => {},
    note: (text) => notes.push(text),
    sample,
    lengthOf: () => LENGTH,
  }
  return { outputs: await runGroupSignal(job), notes }
}

const table = (outputs: TaskOutput[], id: string): TableOutput | undefined =>
  outputs.find((one): one is TableOutput => one.kind === 'table' && one.id === id)

describe('groups from a feature set', () => {
  const params: Params = { groupBy: 'features', features: 'ab', split: 'name', outside: true }

  it('splits the set by name, with the rest of the genome as a group', async () => {
    const { outputs } = await run(params)
    const groups = table(outputs, 'groupsignal-groups')
    expect(groups?.rows.map((row) => row.group)).toEqual(['A', 'B', 'rest of the genome'])
    // Stretches of at most 10 kb: five of A, three of B, two of the rest.
    expect(groups?.rows.map((row) => row.n)).toEqual([5, 3, 2])
    expect(groups?.rows.map((row) => row.bases)).toEqual([50_000, 30_000, 20_000])
    expect(Number(groups?.rows[0].mean)).toBeCloseTo(0.7, 5)
    expect(Number(groups?.rows[1].mean)).toBeCloseTo(0.5, 5)
  })

  it('tests every pair, and all the groups together, with q-values', async () => {
    const { outputs } = await run(params)
    const tests = table(outputs, 'groupsignal-tests')
    expect(tests?.rows[0].test).toBe('Kruskal–Wallis H')
    const aVsB = tests?.rows.find((row) => row.a === 'A' && row.b === 'B')
    expect(aVsB?.effect).toBe(1)
    expect(Number(aVsB?.difference)).toBeCloseTo(0.2, 5)
    expect(Number(aVsB?.q)).toBeGreaterThanOrEqual(Number(aVsB?.p))
  })

  it('draws each group as a violin, in the group’s own colour', async () => {
    const { outputs } = await run(params)
    const figure = outputs.find((one): one is CurveOutput => one.kind === 'curve')
    expect(figure?.label).toBe('GC content by A/B compartments, by name')
    expect(figure?.series.map((series) => series.mark)).toEqual(['violin', 'violin', 'violin'])
    expect(figure?.series.map((series) => series.n)).toEqual([5, 3, 2])
    expect(figure?.series[2].colour).toBe('#999999')
  })

  it('leaves the rest out when asked, and scores every feature when asked', async () => {
    const { outputs } = await run({ ...params, outside: false, perFeature: true })
    expect(table(outputs, 'groupsignal-groups')?.rows.map((row) => row.group)).toEqual(['A', 'B'])
    const perFeature = table(outputs, 'groupsignal-features')
    expect(perFeature?.rows.map((row) => row.name)).toEqual(['A', 'B'])
    expect(Number(perFeature?.rows[0].track1)).toBeCloseTo(0.7, 5)
  })

  it('leaves out a group with nothing in it, and says so', async () => {
    const tiling = new FeatureBuilder()
    tiling.add('chr', 0, 50_000, { name: 'A' })
    tiling.add('chr', 50_000, LENGTH, { name: 'B' })
    const { outputs, notes } = await run(params, tiling.finish())
    expect(table(outputs, 'groupsignal-groups')?.rows.map((row) => row.group)).toEqual(['A', 'B'])
    expect(notes.join(' ')).toContain('rest of the genome had no stretch')
    const figure = outputs.find((one): one is CurveOutput => one.kind === 'curve')
    expect(figure?.series).toHaveLength(2)
  })

  it('reads every track at its own resolution, never a zoom level’s', async () => {
    asked.length = 0
    const { outputs } = await run({ ...params, perFeature: true })
    expect(new Set(asked)).toEqual(new Set([1]))
    // A's stretches all read 0.7 and B's 0.5, the stretches either side of 50 kb
    // too, where a zoom record across the edge would mix the two.
    const groups = table(outputs, 'groupsignal-groups')
    for (const row of groups?.rows ?? []) expect(Number(row.sd)).toBeLessThan(1e-9)
    expect(Number(groups?.rows[0].mean)).toBeCloseTo(0.7, 6)
    expect(Number(groups?.rows[1].mean)).toBeCloseTo(0.5, 6)
    const perFeature = table(outputs, 'groupsignal-features')
    expect(Number(perFeature?.rows[0].track1)).toBeCloseTo(0.7, 6)
    expect(Number(perFeature?.rows[1].track1)).toBeCloseTo(0.5, 6)
  })

  it('refuses to run without a set, and says why', async () => {
    const { outputs, notes } = await run({ ...params, features: '' })
    expect(outputs).toEqual([])
    expect(notes.join(' ')).toContain('No feature set was chosen')
  })
})

describe('groups from a track', () => {
  it('cuts the bins by the track’s sign, and writes the grouping out as intervals', async () => {
    const { outputs } = await run({ groupBy: 'track', groupTrack: 'e1', cut: 'sign' })
    const groups = table(outputs, 'groupsignal-groups')
    expect(groups?.rows.map((row) => row.group)).toEqual(['above 0', 'below 0'])
    expect(groups?.rows.map((row) => row.n)).toEqual([4, 6])
    const segments = outputs.find((one): one is IntervalsOutput => one.kind === 'intervals')
    const data = segments?.payload.kind === 'features' ? segments.payload.data : undefined
    expect(data?.name).toEqual(['above 0', 'below 0'])
    expect(Array.from(data?.start ?? [])).toEqual([0, 40_000])
    expect(Array.from(data?.end ?? [])).toEqual([40_000, 100_000])
  })

  it('cuts them into quantiles, named by the values they span', async () => {
    const { outputs } = await run({ groupBy: 'track', groupTrack: 'ramp', cut: 'quantiles', quantiles: 2 })
    const names = table(outputs, 'groupsignal-groups')?.rows.map((row) => String(row.group))
    expect(names).toHaveLength(2)
    expect(names?.[0]).toMatch(/^Q1 \(/)
    expect(table(outputs, 'groupsignal-groups')?.rows.map((row) => row.n)).toEqual([5, 5])
  })
})

describe('cutting a run into stretches', () => {
  it('keeps a run no longer than a bin whole, across a grid line or not', () => {
    expect(cut(0, 300, 10_000)).toEqual([[0, 300]])
    expect(cut(9_800, 10_200, 10_000)).toEqual([[9_800, 10_200]])
  })

  it('cuts a longer one where the grid falls, and joins a sliver to its neighbour', () => {
    expect(cut(2_000, 35_000, 10_000)).toEqual([
      [2_000, 10_000],
      [10_000, 20_000],
      [20_000, 30_000],
      [30_000, 35_000],
    ])
    expect(cut(8_000, 31_000, 10_000)).toEqual([
      [8_000, 20_000],
      [20_000, 31_000],
    ])
  })
})
