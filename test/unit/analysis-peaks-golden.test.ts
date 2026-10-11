/**
 * Calling peaks, against yapc 0.1 and idr 2.0.3 themselves (§18.9, §18.10).
 *
 * A second caller is held to what the first was: a published method, ported,
 * with a golden built from **that method's own output** and compared call for
 * call. `scripts/make_analysis_golden.py` builds three, in an environment where
 * yapc's release and IDR's commit run unmodified (see the script's section on
 * them), over the demo data a reader can open:
 *
 * - **`yapc`** — yapc's own `coverage`, `d2smooth`, `find_concave_regions` and
 *   `scores` over `Yeast_ATAC.bw`, on four chromosomes: the kernel, two windows
 *   of the second derivative as yapc reads it back from its bigWig, every
 *   concave region with its summit and score, and `main()`'s cut to the
 *   strongest thousand. Regions and summits compare **exactly**: they are
 *   integers decided by float32 comparisons, and one off is a different peak.
 * - **`yapc_idr`** — yapc's `main()` run whole on two tracks, IDR included, and
 *   the BED files it writes at its six thresholds. The two tracks are ATAC and a
 *   Pol II ChIP, which are not replicates; that is what drives IDR's EM out of
 *   its box and onto coordinate ascent, the path only a bad pair takes.
 * - **`idr`** — IDR's own simulator and fit on a pair drawn from its model, which
 *   stays on the EM path throughout, compared round for round.
 *
 * The runs use this repository's own track reader for the demo bigWigs
 * (`cli/tracks.ts`, which answers in the worker's shape), so what is compared is
 * the task as a reader runs it, windows, seams and all.
 */

import { existsSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

import { BigWig } from '@gmod/bbi'
import { LocalFile } from 'generic-filehandle2'

import { fitIdr, globalIdr, localIdr } from '@/analysis/idr'
import type { TrackJobContext } from '@/analysis/job'
import { runPeaks } from '@/analysis/run/peaks'
import type { AnalysisFraming, IntervalsOutput, Params, TableOutput, TaskOutput } from '@/analysis/types'
import {
  ConcaveScan,
  convolutionReach,
  convolveSame,
  runsOver,
  yapcKernel,
  type ConcaveRegions,
} from '@/analysis/yapc'
import type { FeatureSet } from '@/annotations/types'
import { loadTracks } from '@/cli/tracks'

import {
  analysisGoldensPresent,
  expectSeries,
  loadAnalysisGolden,
  numbers,
  type GoldenNumbers,
} from '../support/analysisGoldens'

const DEMO = new URL('../../demo/yeast/', import.meta.url).pathname
const ATAC = `${DEMO}Yeast_ATAC.bw`
const POL2 = `${DEMO}Yeast_ChIP_Pol2-vs-input.bw`

const ready =
  analysisGoldensPresent() &&
  existsSync(ATAC) &&
  existsSync(POL2) &&
  existsSync(new URL('../golden/analysis/yapc.json', import.meta.url).pathname)
const suite = ready ? describe : describe.skip

// ---------------------------------------------------------------------------
// Goldens
// ---------------------------------------------------------------------------

interface YapcGolden {
  track: string
  chroms: string[]
  width: number
  times: number
  min_width: number
  truncate: number
  halfwidth: number
  tolerance: number
  kernel: number[]
  windows: Array<{ contig: string; start: number; end: number; d2: GoldenNumbers }>
  regions: { contig: string[]; start: number[]; end: number[]; mode: number[]; score: GoldenNumbers }
  n_wide: number
  kept: {
    contig: string[]
    start: number[]
    end: number[]
    fixed_start: number[]
    fixed_end: number[]
  }
}

interface YapcIdrGolden {
  tracks: string[]
  chroms: string[]
  tolerance: number
  idr_tolerance: number
  ties: number
  table: {
    contig: string[]
    start: number[]
    end: number[]
    mode: number[]
    score1: GoldenNumbers
    score2: GoldenNumbers
    min_rank: GoldenNumbers
    global_idr: GoldenNumbers
  }
  passing: Record<string, number[]>
}

interface IdrGolden {
  n: number
  tolerance: number
  idr_tolerance: number
  rounds: number
  coordinate_ascent: boolean
  r1: number[]
  r2: number[]
  theta: number[]
  local_idr: GoldenNumbers
  global_idr: GoldenNumbers
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

const FRAMING: AnalysisFraming = {
  uri: ATAC,
  rows: [0, 0],
  cols: [0, 0],
  binsize: 0,
  binsPerCell: 1,
  balance: false,
  value: 'count',
  normalise: null,
  level: 'bin',
  label: 'Yeast_ATAC.bw · loaded tracks, no contact map',
}

/** A run of the task over the demo bigWigs, as `chromosomix peaks` runs it. */
async function run(params: Params): Promise<{ outputs: TaskOutput[]; notes: string[] }> {
  const tracks = await loadTracks([ATAC, POL2])
  const lengths: Record<string, number> = {}
  for (const contig of tracks.get(ATAC)?.contigs ?? []) lengths[contig.name] = contig.length
  const notes: string[] = []
  const job: TrackJobContext = {
    params,
    framing: FRAMING,
    inputs: {
      contigLengths: lengths,
      labels: { [ATAC]: 'Yeast_ATAC.bw', [POL2]: 'Yeast_ChIP_Pol2-vs-input.bw' },
    },
    cancelled: () => false,
    throwIfCancelled: () => {},
    progress: () => {},
    note: (text) => {
      notes.push(text)
    },
    sample: async (entry, regions, basesPerPixel) => {
      const track = tracks.get(entry)
      if (track === undefined) throw new Error(`no track ${entry}`)
      return track.sample(regions, basesPerPixel)
    },
    lengthOf: (contig) => lengths[contig],
  }
  return { outputs: await runPeaks(job), notes }
}

function intervalsOf(outputs: readonly TaskOutput[]): FeatureSet {
  const found = outputs.find((output): output is IntervalsOutput => output.kind === 'intervals')
  if (found === undefined || found.payload.kind !== 'features') throw new Error('no peaks')
  return found.payload.data
}

function tableOf(outputs: readonly TaskOutput[], id: string): TableOutput {
  const found = outputs.find((output): output is TableOutput => output.kind === 'table' && output.id === id)
  if (found === undefined) throw new Error(`no table ${id}`)
  return found
}

/** `contig:start-end` for each feature, in whatever order they came. */
function keysOf(set: FeatureSet): string[] {
  return Array.from({ length: set.length }, (_, i) => `${set.contigs[set.contig[i]]}:${set.start[i]}-${set.end[i]}`)
}

/** One track's concave regions over some chromosomes, fed through in windows. */
async function scanDemo(chroms: readonly string[], window: number): Promise<ConcaveRegions[]> {
  const file = new BigWig({ filehandle: new LocalFile(ATAC) })
  const header = await file.getHeader()
  const kernel = yapcKernel(150, 3)
  const out: ConcaveRegions[] = []
  for (const chrom of chroms) {
    const length = header.refsByNumber[header.refsByName[chrom]].length
    const scan = new ConcaveScan(chrom, length, [false])
    const { left, right } = convolutionReach(kernel, length)
    for (let from = 0; from < length; from += window) {
      const to = Math.min(length, from + window)
      const lo = Math.max(0, from - left)
      const hi = Math.min(length, to + right)
      const features = await file.getFeatures(chrom, lo, hi)
      const runs = runsOver(
        features.map((f) => f.start),
        features.map((f) => f.end),
        features.map((f) => f.score ?? Number.NaN),
        lo,
        hi,
      )
      const d2 = convolveSame(runs, kernel, length, from, to)
      scan.feed(from, d2, [d2])
    }
    out.push(scan.finish())
  }
  return out
}

// ---------------------------------------------------------------------------
// yapc's candidate stage
// ---------------------------------------------------------------------------

suite('peak calling, against yapc 0.1 on one track', () => {
  const golden = ready ? loadAnalysisGolden<YapcGolden>('yapc') : null

  it('builds the same kernel', () => {
    const g = golden!
    const kernel = yapcKernel(g.width, g.times)
    // The golden carries fifteen significant digits, and numpy's BLAS adds the
    // composite's taps in an order of its own; the two agree to 3 × 10⁻¹³.
    expectSeries(kernel.values, numbers(g.kernel), 1e-11, 'kernel')
  })

  it('reads the same second derivative back, float32 and gaps included', async () => {
    // Two windows as yapc reads them out of `_d2smooth.bw`: the start of I, and
    // the first stretch the track has no value for, which the convolution must
    // widen by exactly its reach on each side.
    const g = golden!
    const file = new BigWig({ filehandle: new LocalFile(ATAC) })
    const header = await file.getHeader()
    const kernel = yapcKernel(g.width, g.times)
    for (const window of g.windows) {
      const length = header.refsByNumber[header.refsByName[window.contig]].length
      const { left, right } = convolutionReach(kernel, length)
      const lo = Math.max(0, window.start - left)
      const hi = Math.min(length, window.end + right)
      const features = await file.getFeatures(window.contig, lo, hi)
      const runs = runsOver(
        features.map((f) => f.start),
        features.map((f) => f.end),
        features.map((f) => f.score ?? Number.NaN),
        lo,
        hi,
      )
      const d2 = convolveSame(runs, kernel, length, window.start, window.end).map(Math.fround)
      expectSeries(d2, numbers(window.d2), g.tolerance, `${window.contig}:${window.start}`)
    }
  })

  it('finds every concave region, summit and score, across the seams of its windows', async () => {
    const g = golden!
    // 64 kb windows rather than the runner's 256 kb: four times the seams, on
    // the same answer.
    const scanned = await scanDemo(g.chroms, 1 << 16)
    const ours = new Map<string, { end: number; mode: number; score: number }>()
    for (const regions of scanned) {
      for (let i = 0; i < regions.starts.length; i++) {
        ours.set(`${regions.contig}:${regions.starts[i]}`, {
          end: regions.ends[i],
          mode: regions.modes[i],
          score: regions.scores[0][i],
        })
      }
    }
    expect(ours.size).toBe(g.regions.start.length)
    const expected = numbers(g.regions.score)
    const actual = new Float64Array(expected.length)
    for (let i = 0; i < g.regions.start.length; i++) {
      const key = `${g.regions.contig[i]}:${g.regions.start[i]}`
      const found = ours.get(key)
      expect(found, key).toBeDefined()
      expect(found!.end, `${key} end`).toBe(g.regions.end[i])
      expect(found!.mode, `${key} summit`).toBe(g.regions.mode[i])
      actual[i] = found!.score
    }
    // Ten significant digits in the golden, and a floor for a flat region's
    // score, which is the kernel's sum times the signal and differs between two
    // correct implementations in its leading digit.
    expectSeries(actual, expected, g.tolerance, 'scores', 1e-8)
  })

  it('keeps the same strongest thousand, and bounds them yapc’s two ways', async () => {
    const g = golden!
    const base: Params = {
      signal: ATAC,
      sequences: g.chroms,
      truncate: g.truncate,
      width: g.width,
      times: g.times,
      minWidth: g.min_width,
    }
    const plain = await run({ ...base, halfWidth: 0 })
    const expected = g.kept.contig.map((contig, i) => `${contig}:${g.kept.start[i]}-${g.kept.end[i]}`)
    expect(keysOf(intervalsOf(plain.outputs)).sort()).toEqual([...expected].sort())
    // The candidates at least the minimum wide, summed over the per-sequence
    // table: `main()`'s width filter.
    const wide = tableOf(plain.outputs, 'peaks-sequences').rows.reduce((sum, row) => sum + Number(row.wide), 0)
    expect(wide).toBe(g.n_wide)

    const fixed = await run({ ...base, halfWidth: g.halfwidth })
    const lengths: Record<string, number> = {}
    for (const contig of (await loadTracks([ATAC])).get(ATAC)?.contigs ?? []) lengths[contig.name] = contig.length
    // yapc writes a start below zero where a summit is near one; the port cuts
    // it at the sequence, and that is the only difference.
    const bounded = g.kept.contig.map(
      (contig, i) =>
        `${contig}:${Math.max(0, g.kept.fixed_start[i])}-${Math.min(lengths[contig], g.kept.fixed_end[i])}`,
    )
    expect(keysOf(intervalsOf(fixed.outputs)).sort()).toEqual([...bounded].sort())
  })
})

// ---------------------------------------------------------------------------
// yapc's pipeline, with IDR
// ---------------------------------------------------------------------------

suite('peak calling, against yapc 0.1 on two tracks with IDR', () => {
  const golden = ready ? loadAnalysisGolden<YapcIdrGolden>('yapc_idr') : null

  it(
    'tests the same regions, scores them the same, and passes the same peaks at every cut',
    async () => {
      const g = golden!
      expect(g.ties, 'the golden has no tied scores to be ordered at random').toBe(0)
      const { outputs, notes } = await run({
        signal: ATAC,
        replicate: POL2,
        sequences: g.chroms,
        idr: '0.05',
        perPeak: true,
      })

      // The table IDR was run on: region for region, both scores, and each
      // region's global IDR as yapc scales it.
      const rows = tableOf(outputs, 'peaks-list').rows
      expect(rows.length).toBe(g.table.start.length)
      const byKey = new Map(rows.map((row) => [`${row.sequence}:${Number(row.start)}`, row]))
      const score1 = new Float64Array(rows.length)
      const score2 = new Float64Array(rows.length)
      const scaled = new Float64Array(rows.length)
      for (let i = 0; i < g.table.start.length; i++) {
        const key = `${g.table.contig[i]}:${g.table.start[i]}`
        const row = byKey.get(key)
        expect(row, key).toBeDefined()
        expect(row!.end, `${key} end`).toBe(g.table.end[i])
        expect(Number(row!.summit), `${key} summit`).toBe(g.table.mode[i])
        score1[i] = Number(row!.curvature0)
        score2[i] = Number(row!.curvature1)
        scaled[i] = -Math.log10(Math.max(1e-5, Number(row!.idr)))
      }
      expectSeries(score1, numbers(g.table.score1), g.tolerance, 'ATAC scores', 1e-8)
      expectSeries(score2, numbers(g.table.score2), g.tolerance, 'Pol II scores', 1e-8)
      expectSeries(scaled, numbers(g.table.global_idr), 0, 'scaled global IDR', g.idr_tolerance)

      // yapc's six BED files, as counts in the thresholds table and as the set
      // drawn at the one asked for.
      const counts = tableOf(outputs, 'peaks-idr').rows
      for (const row of counts) {
        expect(row.peaks, `IDR ≤ ${row.threshold}`).toBe(g.passing[String(row.threshold)].length)
      }
      const drawn = g.passing['0.05'].map((i) => `${g.table.contig[i]}:${g.table.start[i]}-${g.table.end[i]}`)
      expect(keysOf(intervalsOf(outputs)).sort()).toEqual([...drawn].sort())

      // And the run says that this pair is not a pair of replicates.
      expect(notes.join(' ')).toMatch(/edge of IDR’s parameter box/)
    },
    120_000,
  )
})

// ---------------------------------------------------------------------------
// IDR alone
// ---------------------------------------------------------------------------

suite('IDR, against idr 2.0.3 on a pair drawn from its own model', () => {
  const golden = ready ? loadAnalysisGolden<IdrGolden>('idr') : null

  it('fits the same parameters along the same path', async () => {
    const g = golden!
    const fit = await fitIdr(Int32Array.from(g.r1), Int32Array.from(g.r2))
    // The same number of rounds is the claim that matters: a fit that took one
    // more or one fewer converged somewhere else by up to its tolerance.
    expect(fit.rounds).toBe(g.rounds)
    expect(fit.coordinateAscent).toBe(g.coordinate_ascent)
    expectSeries(Float64Array.from(fit.theta), Float64Array.from(g.theta), g.tolerance, 'theta')
  })

  it('computes the same local and global IDR for every peak', async () => {
    const g = golden!
    const r1 = Int32Array.from(g.r1)
    const r2 = Int32Array.from(g.r2)
    const fit = await fitIdr(r1, r2)
    const local = localIdr(fit.theta, r1, r2)
    expectSeries(local, numbers(g.local_idr), 0, 'local IDR', g.idr_tolerance)
    expectSeries(globalIdr(local), numbers(g.global_idr), 0, 'global IDR', g.idr_tolerance)
  })
})
