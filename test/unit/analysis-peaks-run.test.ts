/**
 * The peak-calling runner, against a fake context — the decisions it makes that
 * are not yapc's or IDR's to make.
 *
 * `yapc.test.ts` holds the kernels to their definitions and
 * `analysis-peaks-golden.test.ts` holds the whole to yapc's and IDR's own output.
 * What is left is what the runner decides on its own, each of which would be
 * invisible if it were wrong:
 *
 * - **A refusal is a note, not a throw** (§18.3): no track, a track as its own
 *   replicate, no sequence ticked, a track that will not answer.
 * - **With one track there is no test**, the lane says so in its name, and a
 *   flat stretch — concave by yapc's test, scoring zero — is not a peak.
 * - **A track without a sequence is zeros there**, as yapc reads it, and the
 *   run names it.
 * - **IDR is not fitted to fewer than twenty peaks**, which is its command's own
 *   floor, and a fit that ends against the edge of its box names every edge.
 * - **A Stop is read between windows**, which is the point of reading in them.
 * - **The same run twice is the same answer** (§18.4).
 */

import { describe, expect, it } from 'vitest'

import type { TrackJobContext } from '@/analysis/job'
import { fitNote, runPeaks } from '@/analysis/run/peaks'
import type {
  AnalysisFraming,
  CurveOutput,
  IntervalsOutput,
  Params,
  TableOutput,
  TaskOutput,
} from '@/analysis/types'
import type { FeatureSet, Region, TrackSampleSet } from '@/annotations/types'
import { cellText } from '@/figures/tableFigure'

const FRAMING: AnalysisFraming = {
  uri: 'tracks',
  rows: [0, 0],
  cols: [0, 0],
  binsize: 0,
  binsPerCell: 1,
  balance: false,
  value: 'count',
  normalise: null,
  level: 'bin',
  label: 'loaded tracks, no contact map',
}

/** One value per base for each sequence a fake track has. */
type Track = Record<string, Float32Array>

/** Bumps on a noisy floor: a coverage track with `bumps` peaks in it. */
function coverage(length: number, bumps: Array<[at: number, height: number]>, seed: number): Float32Array {
  const values = new Float32Array(length)
  let state = seed
  const random = (): number => {
    state = (state * 16807) % 2147483647
    return state / 2147483647
  }
  for (let i = 0; i < length; i++) {
    let value = 1 + random() * 2
    for (const [at, height] of bumps) value += height * Math.exp(-((i - at) ** 2) / (2 * 50 * 50))
    values[i] = Math.round(value)
  }
  return values
}

/** A track's answer to one `sample`, as the annotations worker gives it at base resolution. */
function answer(track: Track, regions: Region[], basesPerPixel: number): TrackSampleSet {
  const out: TrackSampleSet['regions'] = []
  for (const region of regions) {
    const values = track[region.contig]
    if (values === undefined) continue
    const starts: number[] = []
    const ends: number[] = []
    const kept: number[] = []
    for (let i = region.start; i < Math.min(region.end, values.length); i++) {
      if (Number.isNaN(values[i])) continue
      const last = kept.length - 1
      if (last >= 0 && ends[last] === i && kept[last] === values[i]) ends[last] = i + 1
      else {
        starts.push(i)
        ends.push(i + 1)
        kept.push(values[i])
      }
    }
    out.push({
      contig: region.contig,
      start: region.start,
      end: region.end,
      starts: Int32Array.from(starts),
      ends: Int32Array.from(ends),
      values: Float32Array.from(kept),
      min: null,
      max: null,
      variant: null,
      summary: false,
    })
  }
  return { basesPerPixel, regions: out, extent: null }
}

interface Bench {
  job: TrackJobContext
  notes: string[]
  reads: number
}

function bench(
  tracks: Record<string, Track>,
  params: Params,
  lengths: Record<string, number>,
  options: { cancelAfter?: number; refuse?: string } = {},
): Bench {
  const notes: string[] = []
  const state = { reads: 0 }
  const job: TrackJobContext = {
    params,
    framing: FRAMING,
    inputs: { contigLengths: lengths, labels: { a: 'a.bw', b: 'b.bw' } },
    cancelled: () => options.cancelAfter !== undefined && state.reads > options.cancelAfter,
    throwIfCancelled: () => {
      if (options.cancelAfter !== undefined && state.reads > options.cancelAfter) {
        const error = new Error('cancelled')
        error.name = 'AbortError'
        throw error
      }
    },
    progress: () => {},
    note: (text) => {
      notes.push(text)
    },
    sample: async (entry, regions, basesPerPixel) => {
      state.reads++
      if (options.refuse !== undefined) return { basesPerPixel, regions: [], extent: null, note: options.refuse }
      const track = tracks[entry]
      if (track === undefined) throw new Error(`no track ${entry}`)
      return answer(track, regions, basesPerPixel)
    },
    lengthOf: (contig) => lengths[contig],
  }
  return {
    job,
    notes,
    get reads() {
      return state.reads
    },
  }
}

function peaksOf(outputs: readonly TaskOutput[]): IntervalsOutput | undefined {
  return outputs.find((output): output is IntervalsOutput => output.kind === 'intervals')
}

function setOf(output: IntervalsOutput | undefined): FeatureSet {
  if (output === undefined || output.payload.kind !== 'features') throw new Error('no peaks')
  return output.payload.data
}

const LENGTHS = { chrA: 30_000, chrB: 12_000 }
const BUMPS_A: Array<[number, number]> = [
  [3_000, 400],
  [9_000, 250],
  [15_000, 180],
  [21_000, 120],
  [26_000, 90],
]
const ONE: Record<string, Track> = {
  a: { chrA: coverage(30_000, BUMPS_A, 7), chrB: coverage(12_000, [[6_000, 300]], 11) },
}

describe('what the runner refuses, and how', () => {
  it('asks for a track rather than calling on none', async () => {
    const { job, notes } = bench(ONE, {}, LENGTHS)
    expect(await runPeaks(job)).toEqual([])
    expect(notes.join(' ')).toMatch(/No track was chosen/)
  })

  it('will not test a track against itself', async () => {
    const { job, notes } = bench(ONE, { signal: 'a', replicate: 'a' }, LENGTHS)
    expect(await runPeaks(job)).toEqual([])
    expect(notes.join(' ')).toMatch(/cannot test itself/)
  })

  it('says so when no sequence is ticked, rather than calling on every one', async () => {
    const { job, notes } = bench(ONE, { signal: 'a', sequences: [] }, LENGTHS)
    expect(await runPeaks(job)).toEqual([])
    expect(notes.join(' ')).toMatch(/No sequence is ticked/)
  })

  it('passes on what a track says when it will not answer', async () => {
    const { job, notes } = bench(ONE, { signal: 'a' }, LENGTHS, { refuse: 'Too wide to read here.' })
    expect(await runPeaks(job)).toEqual([])
    expect(notes).toContain('Too wide to read here.')
  })

  it('names a track that has none of the sequences asked about', async () => {
    const { job, notes } = bench({ a: { chrZ: new Float32Array(10) } }, { signal: 'a' }, LENGTHS)
    expect(await runPeaks(job)).toEqual([])
    expect(notes.join(' ')).toMatch(/a\.bw has none of the sequences ticked/)
  })
})

describe('one track', () => {
  it('calls a peak at each bump, its summit on the bump, and says there was no test', async () => {
    const { job, notes } = bench(ONE, { signal: 'a', truncate: 6 }, LENGTHS)
    const outputs = await runPeaks(job)
    const peaks = peaksOf(outputs)
    expect(peaks?.label).toBe('Peaks · a.bw · no IDR')
    expect(peaks?.noun).toEqual({ one: 'peak', many: 'peaks' })
    const set = setOf(peaks)
    expect(set.length).toBe(6)
    // The summit is the thick part, where yapc's `_peaksall.bed` puts it.
    const summits = Array.from({ length: set.length }, (_, i) => ({
      contig: set.contigs[set.contig[i]],
      at: set.cdsStart[i],
    }))
    for (const [at] of [...BUMPS_A]) {
      expect(summits.some((s) => s.contig === 'chrA' && Math.abs(s.at - at) <= 3), `a summit at ${at}`).toBe(true)
    }
    expect(summits.some((s) => s.contig === 'chrB' && Math.abs(s.at - 6_000) <= 3)).toBe(true)
    for (let i = 0; i < set.length; i++) expect(set.cdsEnd[i] - set.cdsStart[i]).toBe(1)
    expect(notes.join(' ')).toMatch(/no test of significance/)
    // Laid out in the assembly's order, which is the order a BED of it is in.
    expect(set.contigs).toEqual(['chrA', 'chrB'])
  })

  it('leaves out a flat stretch, which yapc’s test counts as concave', async () => {
    // Explicit zeros over a few kilobases: `d2 < 10⁻¹⁰` everywhere in them, a
    // concave region scoring zero. IDR would rank it last in both replicates;
    // with one track there is no IDR, so it is dropped here, and said.
    const flat = coverage(30_000, BUMPS_A, 7)
    flat.fill(0, 10_500, 14_000)
    const { job, notes } = bench({ a: { chrA: flat } }, { signal: 'a' }, { chrA: 30_000 })
    const set = setOf(peaksOf(await runPeaks(job)))
    for (let i = 0; i < set.length; i++) {
      expect(set.score[i], 'every peak curves down').toBeGreaterThan(0)
    }
    expect(notes.join(' ')).toMatch(/flat/)
  })

  it('draws the curvature of what was kept against what was not', async () => {
    const { job } = bench(ONE, { signal: 'a', truncate: 3 }, LENGTHS)
    const figure = (await runPeaks(job)).find((output): output is CurveOutput => output.kind === 'curve')
    expect(figure?.yScale).toBe('log')
    expect(figure?.series.map((series) => series.name)).toEqual(['peaks', 'below the cut'])
    expect(figure?.series[0].n).toBe(3)
    expect(figure?.series.every((series) => series.mark === 'violin')).toBe(true)
  })

  it('lists every peak only when asked, held as the lane holds it and printed 1-based', async () => {
    const without = await runPeaks(bench(ONE, { signal: 'a', truncate: 3 }, LENGTHS).job)
    expect(without.some((output) => output.id === 'peaks-list')).toBe(false)
    const outputs = await runPeaks(bench(ONE, { signal: 'a', truncate: 3, perPeak: true }, LENGTHS).job)
    const table = outputs.find((output): output is TableOutput => output.id === 'peaks-list')
    const set = setOf(peaksOf(outputs))
    expect(table?.rows.length).toBe(3)
    const first = table!.rows[0]
    // Held 0-based, so the TSV saved from it is read back onto the same bases
    // (§8.3), and flagged so the table prints it 1-based (§26.1).
    const i = Array.from(set.start).indexOf(Number(first.start))
    expect(i, 'the table’s start is the lane’s').toBeGreaterThanOrEqual(0)
    expect(Number(first.summit)).toBe(set.cdsStart[i])
    const column = (key: string) => table!.columns.find((entry) => entry.key === key)!
    expect(column('start').coordinate).toBe('start')
    expect(column('summit').coordinate).toBe('start')
    expect(column('end').coordinate).toBe('end')
    expect(cellText(column('start'), first.start)).toBe((Number(first.start) + 1).toLocaleString('en-US'))
  })
})

describe('two tracks', () => {
  const TWO: Record<string, Track> = {
    a: ONE.a,
    // The replicate has chrA only.
    b: { chrA: coverage(30_000, BUMPS_A, 13) },
  }

  it('names a sequence the replicate does not have, and reads it as zeros there', async () => {
    const { job, notes } = bench(TWO, { signal: 'a', replicate: 'b', perPeak: true }, LENGTHS)
    const outputs = await runPeaks(job)
    expect(notes.join(' ')).toMatch(/b\.bw has no chrB/)
    const table = outputs.find((output): output is TableOutput => output.id === 'peaks-list')
    const onB = table?.rows.filter((row) => row.sequence === 'chrB') ?? []
    expect(onB.length).toBeGreaterThan(0)
    // yapc's `scores()` yields `-inf` for a track without the sequence.
    for (const row of onB) expect(row.curvature1).toBe(Number.NEGATIVE_INFINITY)
  })

  it('does not fit IDR to fewer than twenty peaks, and says what it reports instead', async () => {
    const { job, notes } = bench(TWO, { signal: 'a', replicate: 'b', truncate: 5 }, LENGTHS)
    const outputs = await runPeaks(job)
    expect(notes.join(' ')).toMatch(/IDR needs at least 20 peaks/)
    expect(setOf(peaksOf(outputs)).length).toBe(5)
    expect(outputs.some((output) => output.id === 'peaks-idr')).toBe(false)
  })
})

describe('the note on a fit', () => {
  const fit = (theta: [number, number, number, number]) => ({ theta, rounds: 12, coordinateAscent: true })

  it('names every edge of IDR’s box the fit ended against, and nothing inside it', () => {
    // A pair of replicates: inside the box, and no warning.
    expect(fitNote(fit([2.1, 1.0, 0.8, 0.4]), 2_000, 900, 0.05)).not.toMatch(/edge/)
    // The ATAC and Pol II pair of the demo, whose mean sits at zero with the rest.
    const note = fitNote(fit([0, 20, 0.1, 0.99]), 18_019, 8_647, 0.05)
    expect(note).toMatch(
      /— the mean at its floor of 0, the spread at its ceiling of 20, the correlation at its floor of 0\.10, the reproducible share at its ceiling of 0\.99 —/,
    )
    // Where the line search stops short of a bound, which is still the bound.
    expect(fitNote(fit([1.5, 19.9995, 0.5, 0.5]), 100, 10, 0.05)).toMatch(
      /— the spread at its ceiling of 20 —/,
    )
    expect(fitNote(fit([1.5, 0.2, 0.99, 0.01]), 100, 10, 0.05)).toMatch(
      /— the spread at its floor of 0\.20, the correlation at its ceiling of 0\.99, the reproducible share at its floor of 0\.01 —/,
    )
  })
})

describe('a run', () => {
  it('stops at the next window when it is called off', async () => {
    // Two windows into a sequence four long: the Stop is read at the check that
    // follows the window's read, and the rest of the sequence is never asked for.
    const long = { a: { chrA: coverage(1_100_000, [[500_000, 300]], 3) } }
    const b = bench(long, { signal: 'a' }, { chrA: 1_100_000 }, { cancelAfter: 1 })
    await expect(runPeaks(b.job)).rejects.toMatchObject({ name: 'AbortError' })
    expect(b.reads).toBe(2)
  })

  it('gives the same answer twice', async () => {
    const first = await runPeaks(bench(ONE, { signal: 'a', perPeak: true }, LENGTHS).job)
    const second = await runPeaks(bench(ONE, { signal: 'a', perPeak: true }, LENGTHS).job)
    expect(second).toEqual(first)
  })
})
