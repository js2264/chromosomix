/**
 * Loop calling against `cooltools.dots`, stage by stage (§18.10).
 *
 * The second caller, held to the bar §18.9 sets for one: a port of a published
 * method, with a golden that is the method's own output. `scripts/make_analysis_golden.py`
 * runs cooltools 0.7.1 over `demo/yeast/Yeast_microC_G2M_1kb.cool` by calling the
 * functions `dots()` calls, in its order, and records what each returns — then
 * runs `dots()` whole and refuses to write the golden unless its calls are the
 * staged ones. Each stage is compared here on its own, because each is a place
 * the two could part and they are different bugs: the expected the λ are built
 * on, the kernels, the λ-chunk edges and their labels, which pixels are scored
 * and at what λ, the genome-wide histograms, the thresholds drawn from them, the
 * pixels that pass, their q-values, every pixel's cluster and the calls the
 * filter keeps.
 *
 * Two configurations, and both halves are load-bearing: `dots()`'s own defaults
 * (every chromosome scanned whole, 40 λ-chunks at an FDR of 0.1, a 20 kb radius)
 * and the command line's (a 200-bin band, 45 chunks at 0.02, 39 kb). The
 * chromosomes are part of the answer — the thresholds are over all four. Beside
 * them, SciPy's Poisson tail over every λ a chunk is tested at, and sklearn's
 * BIRCH on point sets large enough to split its nodes, which the demo's few
 * clusters never do.
 */

import { existsSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

import { birch, fma } from '@/analysis/birch'
import {
  DotCaller,
  HICCUPS_KERNELS,
  expectedCis,
  kernelMatrix,
  labelEdges,
  lambdaEdges,
  scoreSequence,
  type DotsResult,
  type RawBand,
} from '@/analysis/hiccups'
import { poissonSf } from '@/analysis/poisson'
import { runHiccups } from '@/analysis/run/hiccups'
import type { AnalysisFraming } from '@/analysis/types'
import { MetaCooler } from '@/metacooler/MetaCooler'
import { LocalFileSource } from '@/sources/LocalFileSource'

import {
  ANALYSIS_GOLDEN_DIR,
  analysisGoldensPresent,
  expectSeries,
  loadAnalysisGolden,
  numbers,
  type GoldenNumbers,
} from '../support/analysisGoldens'

const DEMO = new URL('../../demo/yeast/', import.meta.url).pathname
const COOLER = `${DEMO}Yeast_microC_G2M_1kb.cool`

const ready =
  analysisGoldensPresent() && existsSync(COOLER) && existsSync(`${ANALYSIS_GOLDEN_DIR}hiccups.json`)
const suite = ready ? describe : describe.skip

/**
 * How far apart the two may be, and why each bound is what it is.
 *
 * The expected and every λ agree to the fifteen significant digits the golden
 * keeps; the q-values and the Poisson tail to about 1e-13, which is V8's `exp`
 * and `log` against glibc's inside SciPy's incomplete gamma; everything decided
 * by a comparison — which pixels, how many in a chunk, a threshold, a cluster,
 * a centroid — exactly.
 */
const TOL_LAMBDA = 1e-13
const TOL_Q = 1e-11

type Kernel = (typeof HICCUPS_KERNELS)[number]

interface ConfigGolden {
  config: {
    w: number
    p: number
    max_loci_separation: number
    max_separation_bins: number
    n_lambda_bins: number
    lambda_bin_fdr: number
    clustering_radius: number
  }
  kernels: Record<Kernel, number[]>
  ledges: number[]
  labels: number[]
  histogram: Record<
    Kernel,
    { counts: number[]; columns: number; row: number[]; chunk: number[]; pixels: number[] }
  >
  thresholds: Record<Kernel, number[]>
  tile: {
    chrom: string
    rows: [number, number]
    cols: [number, number]
    bin1: number[]
    bin2: number[]
    count: number[]
  } & Record<Kernel, GoldenNumbers>
  enriched: { chrom: string[]; bin1: number[]; bin2: number[]; count: number[] } & Record<
    `la_${Kernel}` | `q_${Kernel}`,
    GoldenNumbers
  >
  clusters: {
    chrom: string[]
    bin1: number[]
    bin2: number[]
    c_label: number[]
    c_size: number[]
    cstart1: GoldenNumbers
    cstart2: GoldenNumbers
  }
  calls: {
    chrom: string[]
    start1: number[]
    start2: number[]
    count: number[]
    c_label: number[]
    c_size: number[]
  }
  n_centroids: number
}

interface HiccupsGolden {
  binsize: number
  chroms: string[]
  expected: Record<string, { balanced_avg: GoldenNumbers; n_valid: number[] }>
  configs: Record<string, ConfigGolden>
  poisson: Array<{ mu: number; k: number[]; sf: number[] }>
  birch: Array<{
    label: string
    binsize: number
    threshold: number
    bins: number[]
    labels: number[]
    centers: number[]
  }>
}

/** The demo cooler, and each chromosome's raw band and weights, read once. */
class Demo {
  private mc: MetaCooler | null = null
  private weightColumn: Float64Array | null = null
  private readonly squares = new Map<string, Float32Array>()

  async open(): Promise<MetaCooler> {
    if (this.mc === null) this.mc = await MetaCooler.open(COOLER, await LocalFileSource.open(COOLER))
    return this.mc
  }

  async weights(chrom: string): Promise<Float64Array> {
    const mc = await this.open()
    if (this.weightColumn === null) this.weightColumn = mc.handle.readNumeric('bins/weight', 0, mc.nBins)
    const [from, to] = mc.contigExtent(chrom)
    return this.weightColumn.slice(from, to)
  }

  /** The raw counts of a chromosome as a band `0 … hi`, the way a run holds them. */
  async band(chrom: string, hi: number): Promise<RawBand> {
    const mc = await this.open()
    const [from, to] = mc.contigExtent(chrom)
    const n = to - from
    let square = this.squares.get(chrom)
    if (square === undefined) {
      const dense = await mc.matrix({ rows: [from, to], cols: [from, to], balance: false })
      square = Float32Array.from(dense.values)
      this.squares.set(chrom, square)
    }
    const top = Math.min(hi, n - 1)
    const values = new Float32Array((top + 1) * n).fill(Number.NaN)
    for (let off = 0; off <= top; off++) {
      for (let r = 0; r + off < n; r++) values[off * n + r] = square[r * n + r + off]
    }
    return { n, hi: top, values }
  }
}

const demo = new Demo()
const golden = ready ? loadAnalysisGolden<HiccupsGolden>('hiccups') : null

/** Every chromosome through one configuration, as a run takes them. */
async function run(cfg: ConfigGolden): Promise<{ caller: DotCaller; result: DotsResult }> {
  const caller = new DotCaller({
    shape: { w: cfg.config.w, p: cfg.config.p },
    maxSeparation: cfg.config.max_separation_bins,
    lambdaBins: cfg.config.n_lambda_bins,
    fdr: cfg.config.lambda_bin_fdr,
    clusteringRadius: cfg.config.clustering_radius,
    clusterFiltering: true,
  })
  for (const [index, chrom] of golden!.chroms.entries()) {
    const weights = await demo.weights(chrom)
    const band = await demo.band(chrom, cfg.config.max_separation_bins - 1 + 2 * cfg.config.w)
    const { avg } = expectedCis(band, weights)
    await caller.addSequence(index, band, weights, avg)
  }
  return { caller, result: caller.finish(golden!.binsize) }
}

suite('loop calling, against cooltools.dots', () => {
  it('computes the expected dots is handed, diagonal by diagonal', async () => {
    for (const chrom of golden!.chroms) {
      const reference = golden!.expected[chrom]
      const weights = await demo.weights(chrom)
      const band = await demo.band(chrom, reference.n_valid.length - 1)
      const { avg, nValid } = expectedCis(band, weights)
      expect(Array.from(nValid), `${chrom}: n_valid`).toEqual(reference.n_valid)
      expectSeries(avg, numbers(reference.balanced_avg), TOL_LAMBDA, `${chrom}: balanced.avg`)
    }
  })

  for (const [name, cfg] of Object.entries(golden?.configs ?? {})) {
    describe(`${name}: w ${cfg.config.w}, p ${cfg.config.p}, ${cfg.config.n_lambda_bins} chunks at ${cfg.config.lambda_bin_fdr}`, () => {
      let cached: Promise<{ caller: DotCaller; result: DotsResult }> | null = null
      const once = (): Promise<{ caller: DotCaller; result: DotsResult }> => (cached ??= run(cfg))

      it('builds the four kernels get_kernel builds', () => {
        for (const kernel of HICCUPS_KERNELS) {
          expect(Array.from(kernelMatrix({ w: cfg.config.w, p: cfg.config.p }, kernel)), kernel).toEqual(
            cfg.kernels[kernel],
          )
        }
      })

      it('cuts λ at numpy’s edges, bit for bit', () => {
        expect(Array.from(lambdaEdges(cfg.config.n_lambda_bins))).toEqual(cfg.ledges)
      })

      it('labels the chunks as pandas does, rounded — the λ each is tested at', () => {
        expect(Array.from(labelEdges(lambdaEdges(cfg.config.n_lambda_bins)))).toEqual(cfg.labels)
      })

      it('scores the pixels score_tile scores, at its λ', async () => {
        const { chrom, rows, cols } = cfg.tile
        const w = cfg.config.w
        const weights = await demo.weights(chrom)
        const band = await demo.band(chrom, cfg.config.max_separation_bins - 1 + 2 * w)
        const { avg } = expectedCis(band, weights)
        // A tile's pixels are those whose whole footprint the tile holds.
        const ours = new Map<string, number[]>()
        await scoreSequence(
          band,
          weights,
          avg,
          { w, p: cfg.config.p },
          cfg.config.max_separation_bins,
          (i, j, count, ...la) => {
            if (i - w < rows[0] || i + w >= rows[1] || j - w < cols[0] || j + w >= cols[1]) return
            ours.set(`${i}:${j}`, [count, ...la])
          },
        )
        expect(ours.size, 'pixels scored in the tile').toBe(cfg.tile.bin1.length)
        const got: Record<Kernel, number[]> = { donut: [], vertical: [], horizontal: [], lowleft: [] }
        cfg.tile.bin1.forEach((bin1, at) => {
          const pixel = ours.get(`${bin1}:${cfg.tile.bin2[at]}`)
          expect(pixel, `pixel ${bin1}, ${cfg.tile.bin2[at]}`).toBeDefined()
          expect(pixel![0]).toBe(cfg.tile.count[at])
          HICCUPS_KERNELS.forEach((kernel, k) => got[kernel].push(pixel![1 + k]))
        })
        for (const kernel of HICCUPS_KERNELS) {
          expectSeries(got[kernel], numbers(cfg.tile[kernel]), TOL_LAMBDA, `tile λ, ${kernel}`)
        }
      })

      it('builds the genome-wide histograms scoring_and_histogramming_step builds', async () => {
        const { caller } = await once()
        const { counts, cells } = caller.histogram.table()
        HICCUPS_KERNELS.forEach((kernel, k) => {
          const reference = cfg.histogram[kernel]
          expect(Array.from(counts), `${kernel}: counts present`).toEqual(reference.counts)
          const width = caller.histogram.chunks
          const dense = new Float64Array(counts.length * width)
          reference.row.forEach((r, at) => (dense[r * width + reference.chunk[at]] = reference.pixels[at]))
          // cooltools keeps the chunks up to the last non-empty one; past it both are empty.
          expect(Array.from(cells[k]), `${kernel}: pixels per count and chunk`).toEqual(Array.from(dense))
        })
      })

      it('draws the thresholds determine_thresholds draws', async () => {
        const { result } = await once()
        HICCUPS_KERNELS.forEach((kernel, k) => {
          expect(Array.from(result.thresholds[k]), kernel).toEqual(cfg.thresholds[kernel])
        })
      })

      it('extracts the same enriched pixels, with their λ and q-values', async () => {
        const { result } = await once()
        const chroms = golden!.chroms
        expect(result.enriched.map((p) => [chroms[p.sequence], p.bin1, p.bin2, p.count])).toEqual(
          cfg.enriched.bin1.map((bin1, at) => [
            cfg.enriched.chrom[at],
            bin1,
            cfg.enriched.bin2[at],
            cfg.enriched.count[at],
          ]),
        )
        HICCUPS_KERNELS.forEach((kernel, k) => {
          expectSeries(
            result.enriched.map((p) => p.laExp[k]),
            numbers(cfg.enriched[`la_${kernel}`]),
            TOL_LAMBDA,
            `λ, ${kernel}`,
          )
          expectSeries(
            result.enriched.map((p) => p.qval[k]),
            numbers(cfg.enriched[`q_${kernel}`]),
            TOL_Q,
            `q, ${kernel}`,
          )
        })
      })

      it('clusters every pixel as sklearn’s BIRCH does, centroids to the bit', async () => {
        const { result } = await once()
        const chroms = golden!.chroms
        expect(result.clustered.map((p) => [chroms[p.sequence], p.bin1, p.bin2, p.cLabel, p.cSize])).toEqual(
          cfg.clusters.bin1.map((bin1, at) => [
            cfg.clusters.chrom[at],
            bin1,
            cfg.clusters.bin2[at],
            cfg.clusters.c_label[at],
            cfg.clusters.c_size[at],
          ]),
        )
        expect(result.clustered.map((p) => p.cStart1)).toEqual(Array.from(numbers(cfg.clusters.cstart1)))
        expect(result.clustered.map((p) => p.cStart2)).toEqual(Array.from(numbers(cfg.clusters.cstart2)))
      })

      it('keeps the calls the HiCCUPS filter keeps', async () => {
        const { result } = await once()
        const chroms = golden!.chroms
        const binsize = golden!.binsize
        const key = (chrom: string, start1: number, start2: number, count: number, label: number, size: number): string =>
          `${chrom}:${start1}:${start2}:${count}:${label}:${size}`
        const ours = result.calls
          .map((p) => key(chroms[p.sequence], p.bin1 * binsize, p.bin2 * binsize, p.count, p.cLabel, p.cSize))
          .sort()
        const theirs = cfg.calls.start1
          .map((start1, at) =>
            key(cfg.calls.chrom[at], start1, cfg.calls.start2[at], cfg.calls.count[at], cfg.calls.c_label[at], cfg.calls.c_size[at]),
          )
          .sort()
        expect(ours).toEqual(theirs)
      })
    })
  }

  it('calls the same loops through the runner, reading the file as a run reads it', async () => {
    // Banded reads off the file, the weights from it, the expected from the
    // band: the road the worker and `chromosomix loops` both take, held to
    // `dots()`' own calls rather than to the kernel's.
    const cfg = golden!.configs.api
    const notes: string[] = []
    const outputs = await runHiccups({
      mc: await demo.open(),
      params: {
        sequences: golden!.chroms,
        outer: cfg.config.w,
        inner: cfg.config.p,
        maxSeparation: cfg.config.max_separation_bins,
        balance: true,
      },
      framing: { value: '' } as AnalysisFraming,
      inputs: {} as never,
      cancelled: () => false,
      throwIfCancelled: () => {},
      breathe: async () => {},
      progress: () => {},
      note: (text) => notes.push(text),
      toBp: (bins) => bins * golden!.binsize,
      toBins: (bp) => Math.max(1, Math.round(bp / golden!.binsize)),
    })
    const table = outputs.find((output) => output.kind === 'table' && output.id === 'loops-table')
    expect(table?.kind).toBe('table')
    const rows = table!.kind === 'table' ? table!.rows : []
    const ours = rows.map((row) => `${row.sequence}:${row.start1}:${row.start2}:${row.count}`).sort()
    const theirs = cfg.calls.start1
      .map((start1, at) => `${cfg.calls.chrom[at]}:${start1}:${cfg.calls.start2[at]}:${cfg.calls.count[at]}`)
      .sort()
    expect(ours).toEqual(theirs)
    const loops = outputs.find((output) => output.kind === 'intervals')
    expect(loops?.kind === 'intervals' && loops.payload.kind === 'pairs' ? loops.payload.data.length : 0).toBe(
      theirs.length,
    )
    expect(notes.some((note) => note.includes(`${cfg.enriched.bin1.length} reached all four thresholds`))).toBe(true)
  })

  it('takes SciPy’s Poisson tail, to where it underflows', () => {
    for (const { mu, k, sf } of golden!.poisson) {
      const ours = k.map((count) => poissonSf(count, mu))
      // Where SciPy's tail is exactly zero this must be too: that count is a
      // sparse chunk's threshold.
      expect(ours.map((value) => value === 0), `λ ${mu}: zeros`).toEqual(sf.map((value) => value === 0))
      expectSeries(ours, sf, TOL_Q, `λ ${mu}`)
    }
  })

  it('clusters as sklearn’s BIRCH does where nodes split and roundings part', () => {
    for (const set of golden!.birch) {
      const points = Float64Array.from(set.bins, (bin) => bin * set.binsize)
      const { labels, centers } = birch(points, set.threshold)
      expect(Array.from(labels), `${set.label}: labels`).toEqual(set.labels)
      expect(Array.from(centers), `${set.label}: centres`).toEqual(set.centers)
    }
  })
})

describe('a fused multiply-add, emulated', () => {
  /** `a·b + c` rounded once, through exact integers. */
  function exact(a: number, b: number, c: number): number {
    const parts = (x: number): [bigint, number] => {
      // x = m · 2^e with m an integer.
      let e = 0
      let m = x
      while (!Number.isInteger(m)) {
        m *= 2
        e--
      }
      return [BigInt(m), e]
    }
    const [ma, ea] = parts(a)
    const [mb, eb] = parts(b)
    const [mc, ec] = parts(c)
    const ep = ea + eb
    const low = Math.min(ep, ec)
    const sum = ma * mb * 2n ** BigInt(ep - low) + mc * 2n ** BigInt(ec - low)
    // `Number` of a BigInt rounds to nearest, ties to even, and the scaling is exact.
    return Number(sum) * 2 ** low
  }

  it('rounds a·b + c once, as hardware does', () => {
    let seed = 7
    const next = (): number => {
      seed = (seed * 1103515245 + 12345) % 2147483648
      return seed / 2147483648
    }
    for (let i = 0; i < 20_000; i++) {
      const a = (next() * 2.5e8) / (1 + Math.floor(next() * 6))
      const b = (next() * 2.5e8) / (1 + Math.floor(next() * 6))
      const c = (next() - 0.5) * 6e16
      expect(fma(a, b, c), `fma(${a}, ${b}, ${c})`).toBe(exact(a, b, c))
    }
  })
})
