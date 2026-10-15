/**
 * The §18 kernels against oracles that were not produced by this code.
 *
 * `TASKS_PLAN.md` §7 calls this the largest hidden cost in the whole analysis
 * project and the part that decides whether anyone should believe the numbers,
 * and it is right: every other analysis test in this suite proves that a kernel
 * does what its own author thought it should. A self-consistent implementation
 * that is off by one bin, or that counts the diagonal twice, or that normalises
 * against the wrong denominator, passes all of them.
 *
 * These do not come from this code. `scripts/make_analysis_golden.py` builds
 * them from `demo/yeast/Yeast_microC_G2M_1kb.cool` — a real 1 kb micro-C map, the
 * same file a reader can open in the app — with **cooler**, **cooltools**,
 * **coolpuppy**, **pyBigWig** and **numpy**, and writes two oracles per task:
 *
 * - **`direct`**, this repo's own definition recomputed in numpy. Compared to
 *   equality. This is what catches a bug.
 * - **`reference`**, the other tool's number under its own definition. Compared
 *   to whatever relation actually holds between the two — sometimes equality,
 *   sometimes an exact identity with a term on one side, sometimes a measured
 *   correlation. Every one of those relations is written in the golden, so
 *   tightening or loosening it is editing data rather than editing this file.
 *
 * Four of the relations are worth naming here, because each one is a place two
 * defensible implementations could part company, and a test has to assert the
 * relation that actually holds:
 *
 * - **P(s)** — exact. cooltools' `count.avg` is the mean over a diagonal, and so
 *   is a mirrored dense block's; the doubling cancels.
 * - **Coverage** — `cooltools_cis == ours + diagonal`, exactly. cooltools sums
 *   the pixel table by both ends, so a diagonal pixel counts twice; this repo
 *   counts it once, on purpose (`analysis/coverage.ts`).
 * - **APA** — exact. The hand-built pileup reads the map whole, both triangles,
 *   so it is held to coolpuppy on the loops whose windows clear the diagonal;
 *   the task's own runner cuts its windows as coolpuppy does, and is held to it
 *   on every loop, raw, over the expected and on the diagonal.
 * - **Insulation** — exact. The diamond is cooltools' own — the mean of the
 *   valid cells of a window cornered on the bin, over the sequence's median —
 *   and so are the boundaries, strength for strength.
 */

import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'

import { BigWig } from '@gmod/bbi'
import { LocalFile } from 'generic-filehandle2'

import { PileupAccumulator, p2ll } from '@/analysis/apa'
import type { JobContext } from '@/analysis/job'
import { runApa } from '@/analysis/run/apa'
import { MIN_DIAG_DEFAULT } from '@/analysis/tasks/apa'
import type { MatrixOutput, Params } from '@/analysis/types'
import {
  correlationMatrix,
  observedOverExpected,
  singleGroupPlan,
  usableBins,
} from '@/analysis/compartments'
import { CoverageAccumulator } from '@/analysis/coverage'
import {
  ExpectedAccumulator,
  densityCurve,
  logBinCurve,
  logRoundedBreaks,
} from '@/analysis/expected'
import { diamondTotals, insulationBoundaries, insulationScore } from '@/analysis/insulation'
import { leadingEigenpairs } from '@/analysis/linalg'
import { referenceWindows, windowRow } from '@/analysis/metaplot'
import { compareSets } from '@/analysis/overlap'
import { ViewpointAccumulator } from '@/analysis/viewpoint'
import { parseBed } from '@/annotations/parse'
import type { FeatureSet, PairSet, TrackSamples } from '@/annotations/types'
import { MetaCooler } from '@/metacooler/MetaCooler'
import { LocalFileSource } from '@/sources/LocalFileSource'
import type { DenseMatrix } from '@/types'

import {
  analysisGoldensPresent,
  expectSeries,
  loadAnalysisGolden,
  numbers,
  pearsonOf,
  type GoldenNumbers,
} from '../support/analysisGoldens'

const DEMO = new URL('../../demo/yeast/', import.meta.url).pathname
const COOLER = `${DEMO}Yeast_microC_G2M_1kb.cool`

const ready = analysisGoldensPresent() && existsSync(COOLER)
const suite = ready ? describe : describe.skip

/**
 * The dense square for one chromosome, read the way the tasks read it.
 *
 * Cached across the whole file: the four goldened chromosomes are 231, 316, 271
 * and 1,532 bins, and reading `IV` five times is five 9 MB allocations for the
 * same numbers. Opened once, closed once — a `MetaCooler` holds an h5wasm mount.
 */
class Demo {
  private mc: MetaCooler | null = null
  private readonly squares = new Map<string, DenseMatrix>()
  private weightColumn: Float64Array | null = null

  async open(): Promise<MetaCooler> {
    if (this.mc === null) {
      this.mc = await MetaCooler.open(COOLER, await LocalFileSource.open(COOLER))
    }
    return this.mc
  }

  async square(chrom: string, balance: boolean): Promise<DenseMatrix> {
    const key = `${chrom}:${balance ? 'b' : 'r'}`
    const held = this.squares.get(key)
    if (held !== undefined) return held
    const mc = await this.open()
    const extent = mc.contigExtent(chrom)
    const dense = await mc.matrix({ rows: extent, cols: extent, balance })
    this.squares.set(key, dense)
    return dense
  }

  /** `/bins/weight` for the whole file — the only thing that says which bins are gaps. */
  async weights(): Promise<Float64Array> {
    if (this.weightColumn === null) {
      const mc = await this.open()
      this.weightColumn = mc.handle.readNumeric('bins/weight', 0, mc.nBins)
    }
    return this.weightColumn
  }
}

const demo = new Demo()

// ---------------------------------------------------------------------------
// P(s)
// ---------------------------------------------------------------------------

interface ExpectedGolden {
  chroms: string[]
  tolerance: number
  direct: Record<string, Record<string, { mean: GoldenNumbers; count: number[] }>>
  reference: {
    tolerance: number
    raw: Record<string, { dist: number[]; mean: GoldenNumbers }>
    balanced: Record<string, { dist: number[]; mean: GoldenNumbers }>
  }
}

suite('P(s), against cooltools.expected_cis', () => {
  const golden = ready ? loadAnalysisGolden<ExpectedGolden>('expected') : null

  for (const balance of [false, true]) {
    const key = balance ? 'balanced' : 'raw'

    it(`matches the per-offset mean on every goldened chromosome (${key})`, async () => {
      const g = golden!
      for (const chrom of g.chroms) {
        const dense = await demo.square(chrom, balance)
        const accumulator = new ExpectedAccumulator(dense.nrows - 1)
        accumulator.addBlock(dense)
        const curve = accumulator.finish()
        expectSeries(curve.mean, numbers(g.direct[key][chrom].mean), g.tolerance, `${key} ${chrom}`)
      }
    })

    it(`counts each mirrored pair twice, as the golden says it should (${key})`, async () => {
      // The factor of two the module header and the exporter both warn about. If
      // this ever comes out equal to `n_valid`, somebody has "fixed" the mirror.
      const g = golden!
      const chrom = g.chroms[0]
      const dense = await demo.square(chrom, balance)
      const accumulator = new ExpectedAccumulator(dense.nrows - 1)
      accumulator.addBlock(dense)
      const curve = accumulator.finish()
      const counts = g.direct[key][chrom].count
      expect(Array.from(curve.count.slice(0, 5))).toEqual(counts.slice(0, 5))
      if (balance) {
        // Balancing drops bins, and a dropped bin's cells are NaN and are not
        // counted, so the raw arithmetic below does not apply — what is asserted
        // instead is that the loss is real and bounded.
        expect(counts[1]).toBeLessThan(2 * (dense.nrows - 1))
        expect(counts[1]).toBeGreaterThan(dense.nrows)
      } else {
        expect(counts[1]).toBe(2 * (dense.nrows - 1))
      }
    })
  }

  it('log-bins cooltools\' curve as a weighted mean, which is what the panel plots', async () => {
    // The suite above pins the per-offset means. What the P(s) task actually
    // draws under `quantity: expected` is those means pooled into log bins, and
    // the pooling rule is the part that can be wrong on its own: a bin at long
    // range spans hundreds of offsets whose evidence differs by orders of
    // magnitude, and averaging their means as equals would let the emptiest
    // offset in the bin count as much as the fullest.
    const g = golden!
    for (const chrom of g.chroms) {
      const dense = await demo.square(chrom, false)
      const accumulator = new ExpectedAccumulator(dense.nrows - 1)
      accumulator.addBlock(dense)
      const curve = accumulator.finish()
      const binned = logBinCurve(curve, 1000, 1.1, 0)

      // The same bins, filled with cooltools' means and this repo's counts. The
      // means are goldened equal above, so what is left under test is the
      // weighting — and a mistake in it moves every point at long range.
      const theirs = numbers(g.reference.raw[chrom].mean)
      const edges: number[] = [1]
      while (edges[edges.length - 1] < curve.maxOffset + 1) {
        edges.push(edges[edges.length - 1] * 1.1)
      }
      const wanted: number[] = []
      for (let e = 0; e + 1 < edges.length; e++) {
        const from = Math.max(1, Math.ceil(edges[e]))
        const to = Math.min(curve.maxOffset + 1, Math.ceil(edges[e + 1]))
        let total = 0
        let cells = 0
        for (let k = from; k < to; k++) {
          if (!(curve.count[k] > 0) || !Number.isFinite(theirs[k])) continue
          total += theirs[k] * curve.count[k]
          cells += curve.count[k]
        }
        if (cells > 0) wanted.push(total / cells)
      }
      expectSeries(binned.y, Float64Array.from(wanted), g.reference.tolerance, `binned ${chrom}`)
    }
  })

  it('agrees with cooltools cell for cell, not merely in shape', async () => {
    const g = golden!
    for (const chrom of g.chroms) {
      const dense = await demo.square(chrom, false)
      const accumulator = new ExpectedAccumulator(dense.nrows - 1)
      accumulator.addBlock(dense)
      const ours = accumulator.finish().mean
      const theirs = numbers(g.reference.raw[chrom].mean)
      // cooltools indexes by `dist`, which is the offset in bins and is dense
      // from zero, so the two arrays line up without a lookup. Asserted rather
      // than assumed, because a sparse `dist` would silently shift every value.
      expect(g.reference.raw[chrom].dist[1], chrom).toBe(1)
      expectSeries(ours, theirs, g.reference.tolerance, `cooltools ${chrom}`)
    }
  })
})

// ---------------------------------------------------------------------------
// P(s), the other convention
// ---------------------------------------------------------------------------

interface HiContactsGolden {
  binsize: number
  chroms: string[]
  pooled: string[]
  factor: number
  tolerance: number
  breaks: { pos: number[]; width: number[] }
  max_offset: Record<string, number>
  curves: Record<string, { x: number[]; ninter: GoldenNumbers; norm_p: GoldenNumbers }>
}

/**
 * The curve the panel draws, against the package it is the curve of.
 *
 * The suite above compares the **expected** value — contacts over the pairs of
 * bins that could have held them — against cooltools, and that quantity is still
 * what observed/expected, the compartment chain and the pileups are taken
 * against. It is not what P(s) plots. What P(s) plots is the **probability
 * density** — contacts over all cis contacts, then over the separation the bin
 * covers — and the oracle for it is `HiContacts::distanceLaw()` itself, run as R
 * by `scripts/hicontacts_ps.R`.
 *
 * **What is compared is the numerator, break for break.** That is where every
 * way of getting this wrong shows up: the gap distance being off by one bin, the
 * break table being regenerated wrongly, the mirrored square not being folded so
 * the diagonal is outweighed two to one. The *denominator* is deliberately not
 * HiContacts' — see {@link densityCurve} — and the last test here is why: on a
 * binned map, dividing by the nominal width of a break produces a sawtooth
 * bigger than the biology, and the golden's own numbers are enough to show it.
 */
suite('P(s) as a density, against HiContacts::distanceLaw', () => {
  const golden = ready ? loadAnalysisGolden<HiContactsGolden>('hicontacts_ps') : null

  /** One unit's per-offset curve, from mirrored dense squares as the runner reads them. */
  async function curveOf(chroms: string[], maxOffset: number) {
    const accumulator = new ExpectedAccumulator(maxOffset)
    for (const chrom of chroms) accumulator.addBlock(await demo.square(chrom, false))
    return accumulator.finish()
  }

  /**
   * How many bin separations each break holds, which is what the density divides
   * by. Recomputed here from the golden's own break positions rather than taken
   * from the kernel, so the two have to agree rather than being the same line
   * read twice.
   */
  function offsetsPerBreak(g: HiContactsGolden, maxOffset: number): Map<number, number> {
    const out = new Map<number, number>()
    for (let k = 0; k <= maxOffset; k++) {
      const gap = (k - 1) * g.binsize
      let at = 0
      for (let i = 0; i < g.breaks.pos.length - 1; i++) {
        if (g.breaks.pos[i] <= gap) at = i
      }
      out.set(g.breaks.pos[at], (out.get(g.breaks.pos[at]) ?? 0) + 1)
    }
    return out
  }

  /** Mean absolute change in log-log slope between neighbouring points. */
  function roughness(x: readonly number[], y: readonly number[], from: number, to: number): number {
    const slopes: number[] = []
    for (let i = 1; i + 1 < x.length; i++) {
      if (x[i] < from || x[i] > to) continue
      if (!(y[i - 1] > 0) || !(y[i + 1] > 0)) continue
      slopes.push(
        (Math.log10(y[i + 1]) - Math.log10(y[i - 1])) /
          (Math.log10(x[i + 1]) - Math.log10(x[i - 1])),
      )
    }
    let sum = 0
    for (let i = 1; i < slopes.length; i++) sum += Math.abs(slopes[i] - slopes[i - 1])
    return slopes.length < 2 ? Number.NaN : sum / (slopes.length - 1)
  }

  it("regenerates HiContacts' break table, position by position", () => {
    const g = golden!
    // Far enough to reach the table's own last entry; `logRoundedBreaks` stops
    // one step past what it is asked for, so the last width is the one HiContacts
    // has no successor for and is not compared.
    const ours = logRoundedBreaks(g.factor, g.breaks.pos[g.breaks.pos.length - 1] - 1)
    expect(Array.from(ours.pos)).toEqual(g.breaks.pos)
    expect(Array.from(ours.width)).toEqual(g.breaks.width.slice(0, ours.width.length))
    // The head is where the rounding collapses distinct powers onto one integer,
    // and where an off-by-one would be least visible in a log-log plot.
    expect(Array.from(ours.pos.slice(0, 16))).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 16, 17,
    ])
  })

  it('puts the same contacts in the same breaks as HiContacts, on every chromosome', async () => {
    const g = golden!
    for (const chrom of [...g.chroms, 'pooled']) {
      const spans = chrom === 'pooled' ? g.pooled : [chrom]
      const curve = await curveOf(spans, g.max_offset[chrom])
      const ours = densityCurve(curve, g.binsize, g.factor, 0, true)
      // Exactly, not to a tolerance: the abscissa is a break position, and a
      // curve drawn one break to the left of HiContacts' would still pass a
      // relative comparison on y at every point.
      expect(Array.from(ours.x), chrom).toEqual(g.curves[chrom].x)

      // The numerator, recovered from the density by multiplying the width back
      // in, against HiContacts' own `ninter` — both as a share of their own
      // total, since ours is normalised and theirs is a count.
      const held = offsetsPerBreak(g, g.max_offset[chrom])
      const theirs = numbers(g.curves[chrom].ninter)
      let sum = 0
      for (const value of theirs) sum += value
      const mine = new Float64Array(ours.x.length)
      const yours = new Float64Array(ours.x.length)
      for (let i = 0; i < ours.x.length; i++) {
        mine[i] = ours.y[i] * (held.get(ours.x[i]) ?? 0) * g.binsize
        yours[i] = theirs[i] / sum
      }
      expectSeries(mine, yours, g.tolerance, `share of contacts ${chrom}`)
    }
  })

  it('divides by the separation a break covers, not by the width of the break', async () => {
    const g = golden!
    const chrom = g.chroms[0]
    const curve = await curveOf([chrom], g.max_offset[chrom])
    const ours = densityCurve(curve, g.binsize, g.factor, 0, true)
    const held = offsetsPerBreak(g, g.max_offset[chrom])
    // Somewhere in the aliased decade, where a break is about as wide as a bin
    // of the file and the two denominators are furthest apart.
    const at = ours.x.findIndex((value) => value >= 10_000 && (held.get(value) ?? 0) >= 2)
    expect(at).toBeGreaterThanOrEqual(0)
    const covered = (held.get(ours.x[at]) ?? 0) * g.binsize
    const nominal = g.breaks.width[g.breaks.pos.indexOf(ours.x[at])]
    expect(covered).not.toBe(nominal)
    // The share of contacts in that break, over the separation it covers.
    expect(ours.y[at] * covered).toBeGreaterThan(0)
  })

  it('is smooth where the nominal width would saw', async () => {
    const g = golden!
    const curve = await curveOf(g.pooled, g.max_offset.pooled)
    const ours = densityCurve(curve, g.binsize, g.factor, 0, true)
    const x = Array.from(ours.x)
    const y = Array.from(ours.y)
    // What HiContacts' own denominator would have produced, from the same
    // numerator: multiply the covered width back in and divide by the break's.
    const held = offsetsPerBreak(g, g.max_offset.pooled)
    const nominal = x.map((position, i) => {
      const covered = (held.get(position) ?? 0) * g.binsize
      const width = g.breaks.width[g.breaks.pos.indexOf(position)]
      return (y[i] * covered) / width
    })
    const window: [number, number] = [4_000, 200_000]
    const mine = roughness(x, y, ...window)
    const theirs = roughness(x, nominal, ...window)
    // The shoulder this decade is read for is a change of about 0.26 in slope.
    // The sawtooth is an order of magnitude larger than the feature, which is
    // the whole argument for the other denominator.
    expect(mine).toBeLessThan(0.2)
    expect(theirs).toBeGreaterThan(0.5)
  })

  it('folds the mirrored square, and is visibly wrong without it', async () => {
    const g = golden!
    const chrom = g.chroms[0]
    const curve = await curveOf([chrom], g.max_offset[chrom])
    // Not folding leaves the diagonal counted once among off-diagonals counted
    // twice, so the first break — which holds the diagonal and offset 1 — loses
    // weight against everything else and every other point gains it. A quiet
    // error: the curve still looks like a P(s).
    const folded = densityCurve(curve, g.binsize, g.factor, 0, true)
    const unfolded = densityCurve(curve, g.binsize, g.factor, 0, false)
    expect(unfolded.x.length).toBe(folded.x.length)
    expect(Math.abs(unfolded.y[0] / folded.y[0] - 1)).toBeGreaterThan(0.1)
  })
})

// ---------------------------------------------------------------------------
// Insulation
// ---------------------------------------------------------------------------

interface InsulationGolden {
  chroms: string[]
  windows_bins: number[]
  ignore_diags: number
  min_valid: number
  threshold: number
  tolerance: number
  tolerance_absolute_score: number
  direct: Record<
    string,
    Record<string, { sums: GoldenNumbers; counts: number[]; score: GoldenNumbers }>
  >
  reference: Record<
    string,
    Record<
      string,
      {
        score: GoldenNumbers
        n_valid_pixels: number[]
        boundary_strength: GoldenNumbers
        is_boundary: number[]
      }
    >
  > & { relation: string; max_valid_pixels: Record<string, number> }
}

suite('diamond insulation, against numpy and cooltools.insulation', () => {
  const golden = ready ? loadAnalysisGolden<InsulationGolden>('insulation') : null

  async function totalsOf(chrom: string, window: number) {
    const g = golden!
    const dense = await demo.square(chrom, true)
    return diamondTotals({ size: dense.nrows, values: dense.values }, { window, ignoreDiags: g.ignore_diags })
  }

  it('reproduces the diamond exactly, at every window', async () => {
    const g = golden!
    for (const chrom of g.chroms) {
      for (const window of g.windows_bins) {
        const totals = await totalsOf(chrom, window)
        const direct = g.direct[chrom][String(window)]
        expect(Array.from(totals.counts), `counts ${chrom} w${window}`).toEqual(direct.counts)
        expectSeries(totals.sums, numbers(direct.sums), g.tolerance, `sums ${chrom} w${window}`)
      }
    }
  })

  it('is cooltools’ log2 insulation score, bin for bin', async () => {
    const g = golden!
    expect(g.reference.relation).toBe('equal')
    for (const chrom of g.chroms) {
      for (const window of g.windows_bins) {
        const totals = await totalsOf(chrom, window)
        const theirs = g.reference[chrom][String(window)]
        expect(Array.from(totals.counts), `cells ${chrom} w${window}`).toEqual(theirs.n_valid_pixels)
        expectSeries(
          insulationScore(totals),
          numbers(theirs.score),
          g.tolerance,
          `score ${chrom} w${window}`,
          g.tolerance_absolute_score,
        )
      }
    }
  })

  it('calls cooltools’ boundaries, with its strengths', async () => {
    // cooltools reads which bins take part against the fullest diamond of the
    // whole table, every chromosome of it — so the golden carries that number
    // rather than this test taking it from the four chromosomes it reads.
    const g = golden!
    for (const chrom of g.chroms) {
      for (const window of g.windows_bins) {
        const totals = await totalsOf(chrom, window)
        const theirs = g.reference[chrom][String(window)]
        const minCells = g.reference.max_valid_pixels[String(window)] * g.min_valid
        const all = insulationBoundaries(insulationScore(totals), totals.counts, {
          minCells,
          threshold: Number.NEGATIVE_INFINITY,
          spacing: 0,
        })
        const strength = new Float64Array(totals.counts.length).fill(Number.NaN)
        for (const call of all) strength[call.bin] = call.prominence
        expectSeries(
          strength,
          numbers(theirs.boundary_strength),
          g.tolerance,
          `strength ${chrom} w${window}`,
          g.tolerance_absolute_score,
        )
        const called = insulationBoundaries(insulationScore(totals), totals.counts, {
          minCells,
          threshold: g.threshold,
          spacing: 0,
        })
        expect(called.map((call) => call.bin), `calls ${chrom} w${window}`).toEqual(theirs.is_boundary)
      }
    }
  })
})

// ---------------------------------------------------------------------------
// Coverage
// ---------------------------------------------------------------------------

interface CoverageGolden {
  chroms: string[]
  tolerance: number
  direct: Record<
    string,
    {
      dropped_bins: number
      cis_raw: GoldenNumbers
      cis_balanced: GoldenNumbers
      diagonal_raw: GoldenNumbers
    }
  >
  reference: { tolerance: number; relation: string } & Record<
    string,
    { cis: GoldenNumbers } | unknown
  >
}

suite('coverage marginals, against numpy and cooltools.coverage', () => {
  const golden = ready ? loadAnalysisGolden<CoverageGolden>('coverage') : null

  /**
   * One chromosome's cis marginal, through the accumulator the task uses.
   *
   * `gaps` supplies the `covered` predicate from the file's own weight column,
   * which is the only thing that knows a bin was *dropped* rather than empty
   * (§18.5). The golden writes `NaN` at exactly those bins, so a run without the
   * predicate reports a real zero where the golden has a gap — which is not a
   * disagreement about the arithmetic but about which question was asked.
   */
  async function marginal(chrom: string, balance: boolean, gaps: boolean): Promise<Float64Array> {
    const mc = await demo.open()
    const dense = await demo.square(chrom, balance)
    const [from, to] = mc.contigExtent(chrom)
    const n = to - from
    const weights = gaps ? await demo.weights() : null
    // One contig, so the whole square is cis and the contig map is a constant.
    const accumulator = new CoverageAccumulator(
      n,
      new Int32Array(n),
      weights === null ? null : (bin) => Number.isFinite(weights[from + bin]),
    )
    accumulator.addBlock({
      nrows: dense.nrows,
      ncols: dense.ncols,
      values: dense.values,
      rowExtent: [0, n],
      colExtent: [0, n],
    })
    return accumulator.finish().cis
  }

  it('matches the numpy row sum, raw and balanced', async () => {
    const g = golden!
    for (const chrom of g.chroms) {
      expectSeries(
        await marginal(chrom, false, true),
        numbers(g.direct[chrom].cis_raw),
        g.tolerance,
        `raw ${chrom}`,
      )
      expectSeries(
        await marginal(chrom, true, true),
        numbers(g.direct[chrom].cis_balanced),
        g.tolerance,
        `balanced ${chrom}`,
      )
    }
  })

  it('counts the diagonal once where cooltools counts it twice', async () => {
    // The identity in the golden's `relation`, asserted. This is the only place
    // in the suite that pins the decision `CoverageAccumulator.add` documents —
    // and it pins it against an outside implementation, which is the difference
    // between a decision and an assumption.
    //
    // No `covered` predicate here: cooltools has no notion of a dropped bin on
    // the raw path, so the comparison is over the counts as stored.
    const g = golden!
    expect(g.reference.relation).toBe('cooltools_cis == direct_cis + diagonal')
    for (const chrom of g.chroms) {
      const ours = await marginal(chrom, false, false)
      const diagonal = numbers(g.direct[chrom].diagonal_raw)
      const theirs = numbers((g.reference[chrom] as { cis: GoldenNumbers }).cis)
      const summed = new Float64Array(ours.length)
      for (let i = 0; i < summed.length; i++) summed[i] = ours[i] + diagonal[i]
      expectSeries(summed, theirs, g.reference.tolerance, `cooltools cis ${chrom}`)
    }
  })

  it('calls a balancer-dropped bin a gap and an empty bin a zero', async () => {
    // §18.5's rule, against the file's own weight column. Both cases have to
    // occur for this to be worth asserting, so both are asserted to occur.
    const g = golden!
    const mc = await demo.open()
    const chrom = g.chroms[0]
    const [from, to] = mc.contigExtent(chrom)
    const n = to - from
    const weights = await demo.weights()
    const dense = await demo.square(chrom, false)
    const accumulator = new CoverageAccumulator(n, new Int32Array(n), (bin) =>
      Number.isFinite(weights[from + bin]),
    )
    accumulator.addBlock({
      nrows: dense.nrows,
      ncols: dense.ncols,
      values: dense.values,
      rowExtent: [0, n],
      colExtent: [0, n],
    })
    const cis = accumulator.finish().cis
    expect(g.direct[chrom].dropped_bins).toBeGreaterThan(0)
    let gaps = 0
    for (let bin = 0; bin < n; bin++) {
      if (Number.isFinite(weights[from + bin])) continue
      expect(Number.isNaN(cis[bin]), `${chrom} bin ${bin} was dropped, so it is a gap`).toBe(true)
      gaps++
    }
    expect(gaps).toBe(g.direct[chrom].dropped_bins)
  })
})

// ---------------------------------------------------------------------------
// Virtual 4C
// ---------------------------------------------------------------------------

interface ViewpointGolden {
  chroms: string[]
  anchor_bins: number
  tolerance: number
  direct: Record<
    string,
    { anchor_start_bin: number; anchor_end_bin: number; profile: GoldenNumbers }
  >
}

suite('the 4C profile, against a numpy band sum', () => {
  const golden = ready ? loadAnalysisGolden<ViewpointGolden>('viewpoint') : null

  it('sums the anchor band and counts the diagonal exactly once', async () => {
    // The accumulator walks *stored* pairs — the upper triangle — and has to
    // reproduce a band sum over the mirrored square. A pixel with both ends
    // inside the anchor is the case where the obvious loop counts twice, and it
    // shows up as a spike at the viewpoint, which is the one place a reader
    // expects a spike and so would never question.
    const g = golden!
    const mc = await demo.open()
    const weights = await demo.weights()
    for (const chrom of Object.keys(g.direct)) {
      const dense = await demo.square(chrom, true)
      const n = dense.nrows
      const base = mc.contigExtent(chrom)[0]
      const { anchor_start_bin: from, anchor_end_bin: to } = g.direct[chrom]
      const accumulator = new ViewpointAccumulator(n, { from, to })
      // Fed the *stored* pairs — the upper triangle, diagonal included — which
      // is what a scan over `/pixels` hands it. Walking the mirrored square
      // whole would hide the very bug this asserts against.
      for (let r = 0; r < n; r++) {
        for (let c = r; c < n; c++) accumulator.add(r, c, dense.values[r * n + c])
      }
      const profile = accumulator.finish((bin) => Number.isFinite(weights[base + bin]))
      expectSeries(profile, numbers(g.direct[chrom].profile), g.tolerance, `4C ${chrom}`)
    }
  })
})

// ---------------------------------------------------------------------------
// Compartments
// ---------------------------------------------------------------------------

interface CompartmentsGolden {
  chroms: string[]
  tolerance: number
  direct: Record<
    string,
    { usable: number[]; n_usable: number; eigenvector: GoldenNumbers; eigenvalue: number | null }
  >
  reference: Record<string, { measured_abs_pearson: number | null } | unknown> & {
    caveat?: string
  }
}

suite('compartments, against numpy.linalg.eigh and cooltools.eigs_cis', () => {
  const golden = ready ? loadAnalysisGolden<CompartmentsGolden>('compartments') : null

  /** O/E → correlation → leading eigenvector, the chain the task runs. */
  async function eigenvector(chrom: string): Promise<{ index: Int32Array; vector: Float64Array }> {
    const dense = await demo.square(chrom, true)
    const n = dense.nrows
    const index = usableBins(dense.values, n)
    const accumulator = new ExpectedAccumulator(n - 1)
    accumulator.addBlock(dense)
    const oe = observedOverExpected(dense.values, n, index, singleGroupPlan(n, accumulator.finish()))
    const correlation = await correlationMatrix(oe, index.length)
    const pairs = leadingEigenpairs(correlation, index.length, 1)
    return { index, vector: pairs.length > 0 ? pairs[0].vector : new Float64Array() }
  }

  it('finds the same leading eigenvector as a full eigendecomposition, up to a flip', async () => {
    // Power iteration with deflation against `numpy.linalg.eigh`, which is a
    // completely different algorithm on the same matrix. Up to a flip, because
    // the sign of an eigenvector is arbitrary until something phases it (§18.6)
    // — so this is the *pre-phasing* comparison the plan asks for.
    const g = golden!
    for (const chrom of g.chroms) {
      const { index, vector } = await eigenvector(chrom)
      const theirs = numbers(g.direct[chrom].eigenvector)
      expect(index.length, `${chrom}: usable bins`).toBe(g.direct[chrom].n_usable)
      expect(Array.from(index), `${chrom}: which bins are usable`).toEqual(g.direct[chrom].usable)
      const agreement = Math.abs(pearsonOf(vector, theirs))
      expect(agreement, `${chrom}: |correlation| with numpy's eigenvector`).toBeGreaterThan(0.999)
    }
  })

  it('is compared against cooltools only where the golden says that means something', async () => {
    // Budding yeast at 1 kb has no compartments worth the name, and the golden
    // says so in its own `caveat`. What is asserted is the recorded number, not
    // a number somebody hoped for — on chromosome III the two eigenvectors are
    // essentially uncorrelated, and pretending otherwise would mean either a
    // failing test or a floor so low it passes on anything.
    const g = golden!
    expect(g.reference.caveat).toBeTruthy()
    for (const chrom of g.chroms) {
      const recorded = (g.reference[chrom] as { measured_abs_pearson: number | null })
        .measured_abs_pearson
      if (recorded === null) continue
      expect(recorded, `${chrom}: recorded agreement with cooltools`).toBeGreaterThanOrEqual(0)
    }
    // At least one chromosome must actually agree, or this golden is proving
    // nothing at all about the compartment chain.
    const best = Math.max(
      ...g.chroms.map(
        (chrom) =>
          (g.reference[chrom] as { measured_abs_pearson: number | null }).measured_abs_pearson ?? 0,
      ),
    )
    expect(best).toBeGreaterThan(0.8)
  })
})

// ---------------------------------------------------------------------------
// APA
// ---------------------------------------------------------------------------

interface ApaGolden {
  binsize: number
  flank_bins: number
  width: number
  tolerance: number
  pairs: Array<{ chrom: string; start1: number; start2: number }>
  direct: { n_pairs_used: number; pileup: GoldenNumbers; p2ll: number | null }
  reference: { relation?: string; tolerance?: number; n_agg?: number; pileup?: GoldenNumbers }
}

suite('APA, against numpy and coolpuppy', () => {
  const golden = ready ? loadAnalysisGolden<ApaGolden>('apa') : null

  /** The pileup over the golden's own pair list, through `PileupAccumulator`. */
  async function pileup(g: ApaGolden): Promise<{ values: Float32Array; n: number }> {
    const accumulator = new PileupAccumulator(g.width, g.width)
    for (const pair of g.pairs) {
      const dense = await demo.square(pair.chrom, true)
      const n = dense.nrows
      const r0 = Math.floor(pair.start1 / g.binsize) - g.flank_bins
      const c0 = Math.floor(pair.start2 / g.binsize) - g.flank_bins
      if (r0 < 0 || c0 < 0 || r0 + g.width > n || c0 + g.width > n) continue
      const window = new Float32Array(g.width * g.width)
      for (let r = 0; r < g.width; r++) {
        for (let c = 0; c < g.width; c++) {
          window[r * g.width + c] = dense.values[(r0 + r) * n + (c0 + c)]
        }
      }
      accumulator.add(window)
    }
    return accumulator.finish()
  }

  it('matches the numpy pileup cell for cell, and uses the same windows', async () => {
    const g = golden!
    const { values, n } = await pileup(g)
    expect(n).toBe(g.direct.n_pairs_used)
    expectSeries(values, numbers(g.direct.pileup), g.tolerance, 'pileup')
  })

  it('matches coolpuppy exactly, which is what the diagonal-clear pair set buys', async () => {
    const g = golden!
    expect(g.reference.relation).toBe('equal')
    expect(g.reference.n_agg).toBe(g.direct.n_pairs_used)
    const { values } = await pileup(g)
    expectSeries(values, numbers(g.reference.pileup!), g.reference.tolerance!, 'coolpuppy')
  })

  it('computes the same peak-to-lower-left ratio', async () => {
    const g = golden!
    const { values } = await pileup(g)
    expect(g.direct.p2ll).not.toBeNull()
    expect(p2ll(values, g.width, g.width)).toBeCloseTo(g.direct.p2ll!, 6)
  })
})

interface ApaDiagonalGolden {
  binsize: number
  flank_bins: number
  width: number
  min_diag: number
  crossing: number
  pairs: Array<{ chrom: string; start1: number; end1: number; start2: number; end2: number }>
  reference: {
    tolerance: number
    anchors: Array<{ chrom: string; start: number; end: number }>
  } & Record<
    'raw_default' | 'oe_default' | 'raw' | 'raw_min_diag_0' | 'oe' | 'local_raw' | 'local_oe',
    { n: number; pileup: GoldenNumbers }
  >
}

/**
 * The task's own runner over the demo file, where the golden above checks a
 * pileup built by hand: windows that reach the diagonal are exactly where the
 * two used to part company, and the runner is where the rule now lives.
 */
suite('APA reaching the diagonal, through the runner, against coolpuppy', () => {
  const golden = ready ? loadAnalysisGolden<ApaDiagonalGolden>('apa_diagonal') : null

  async function run(params: Params, inputs: Record<string, unknown>): Promise<MatrixOutput> {
    const g = golden!
    const mc = await demo.open()
    const job: JobContext = {
      mc,
      params: { mode: 'fixed', window: g.flank_bins, balance: true, ...params },
      framing: {
        uri: COOLER,
        label: 'demo',
        binsize: g.binsize,
        binsPerCell: 1,
        rows: [0, mc.nBins],
        cols: [0, mc.nBins],
        balance: true,
        value: '',
        normalise: null,
        level: 'bin',
      },
      inputs: inputs as never,
      cancelled: () => false,
      throwIfCancelled: () => {},
      breathe: async () => {},
      progress: () => {},
      note: () => {},
      toBp: (bins: number) => bins * g.binsize,
      toBins: (bp: number) => Math.max(1, Math.round(bp / g.binsize)),
    }
    const matrix = (await runApa(job)).find((out): out is MatrixOutput => out.kind === 'matrix')
    if (matrix === undefined) throw new Error('no pileup')
    return matrix
  }

  function loopSet(g: ApaDiagonalGolden): PairSet {
    const n = g.pairs.length
    const contigs = [...new Set(g.pairs.map((pair) => pair.chrom))]
    const contig = Int32Array.from(g.pairs.map((pair) => contigs.indexOf(pair.chrom)))
    return {
      contigs,
      length: n,
      contig1: contig,
      start1: Int32Array.from(g.pairs.map((pair) => pair.start1)),
      end1: Int32Array.from(g.pairs.map((pair) => pair.end1)),
      contig2: contig,
      start2: Int32Array.from(g.pairs.map((pair) => pair.start2)),
      end2: Int32Array.from(g.pairs.map((pair) => pair.end2)),
      score: new Float32Array(n).fill(Number.NaN),
      name: g.pairs.map((_, i) => `l${i}`),
      detail: g.pairs.map(() => ''),
    }
  }

  function anchorSet(g: ApaDiagonalGolden): FeatureSet {
    const anchors = g.reference.anchors
    const n = anchors.length
    const contigs = [...new Set(anchors.map((anchor) => anchor.chrom))]
    return {
      contigs,
      length: n,
      contig: Int32Array.from(anchors.map((anchor) => contigs.indexOf(anchor.chrom))),
      start: Int32Array.from(anchors.map((anchor) => anchor.start)),
      end: Int32Array.from(anchors.map((anchor) => anchor.end)),
      strand: new Int8Array(n),
      score: new Float32Array(n).fill(Number.NaN),
      name: anchors.map((_, i) => `a${i}`),
      id: anchors.map(() => ''),
      detail: anchors.map(() => ''),
    } as unknown as FeatureSet
  }

  const loops = (g: ApaDiagonalGolden) => ({ pairs: { pairs: loopSet(g) } })
  const anchors = (g: ApaDiagonalGolden) => ({ features: { features: anchorSet(g) } })

  it('keeps loops whose windows reach the diagonal, which is what this golden is for', () => {
    const g = golden!
    expect(g.crossing).toBeGreaterThan(20)
    expect(g.min_diag).toBe(MIN_DIAG_DEFAULT)
  })

  it('leaves out the loops coolpuppy leaves out at its defaults, and piles up the same rest', async () => {
    // `mindist='auto'`: twice the flank and two bins, measured between centres.
    const g = golden!
    for (const [norm, which] of [
      ['none', 'raw_default'],
      ['oe', 'oe_default'],
    ] as const) {
      const matrix = await run({ anchors: 'pairs', pairs: 'loops', norm }, loops(g))
      expect(matrix.stats?.[0]?.value, which).toBe(g.reference[which].n)
      expectSeries(matrix.values, numbers(g.reference[which].pileup), g.reference.tolerance, which)
    }
    expect(g.reference.raw_default.n).toBeLessThan(g.reference.raw.n)
  })

  it('piles up every loop as coolpuppy does with mindist 0, gap for gap', async () => {
    const g = golden!
    const matrix = await run({ anchors: 'pairs', pairs: 'loops', norm: 'none', minDist: 0 }, loops(g))
    expect(matrix.stats?.[0]?.value).toBe(g.reference.raw.n)
    expectSeries(matrix.values, numbers(g.reference.raw.pileup), g.reference.tolerance, 'raw')
  })

  it('takes nothing from below the diagonal with no diagonal left out, as coolpuppy', async () => {
    const g = golden!
    const matrix = await run(
      { anchors: 'pairs', pairs: 'loops', norm: 'none', minDiag: 0, minDist: 0 },
      loops(g),
    )
    expectSeries(
      matrix.values,
      numbers(g.reference.raw_min_diag_0.pileup),
      g.reference.tolerance,
      'min_diag 0',
    )
  })

  it('divides every window by its sequence’s expected, as coolpuppy’s ooe does', async () => {
    const g = golden!
    const matrix = await run({ anchors: 'pairs', pairs: 'loops', norm: 'oe', minDist: 0 }, loops(g))
    expect(matrix.stats?.[0]?.value).toBe(g.reference.oe.n)
    expectSeries(matrix.values, numbers(g.reference.oe.pileup), g.reference.tolerance, 'oe')
  })

  it('is coolpuppy’s local pileup on the diagonal, raw and over the expected', async () => {
    const g = golden!
    for (const [norm, which] of [
      ['none', 'local_raw'],
      ['oe', 'local_oe'],
    ] as const) {
      const matrix = await run({ anchors: 'features', features: 'anchors', norm }, anchors(g))
      expect(matrix.stats?.[0]?.value, which).toBe(g.reference[which].n)
      expectSeries(matrix.values, numbers(g.reference[which].pileup), g.reference.tolerance, which)
    }
  })
})

// ---------------------------------------------------------------------------
// Metaplot
// ---------------------------------------------------------------------------

interface MetaplotGolden {
  flank: number
  columns: number
  step: number
  tolerance: number
  windows: Array<{ contig: string; start: number; end: number }>
  direct: Record<string, { n_windows: number; counts: number[]; mean: GoldenNumbers }>
}

suite('the metaplot, against pyBigWig', () => {
  const golden = ready ? loadAnalysisGolden<MetaplotGolden>('metaplot') : null

  it('averages the same windows of the same bigWigs to the same numbers', async () => {
    // Two things at once: that `windowRow` places and area-weights its columns
    // the way a bigWig summary does, and that `@gmod/bbi` and pyBigWig agree on
    // the values underneath. The windows come from the golden rather than from
    // `referenceWindows`, because the two sides round a midpoint differently and
    // that is not what is under test here — the columns are.
    const g = golden!
    for (const [track, expectedRow] of Object.entries(g.direct)) {
      const file = new BigWig({ filehandle: new LocalFile(`${DEMO}${track}`) })
      const total = new Float64Array(g.columns)
      const seen = new Float64Array(g.columns)
      for (const window of g.windows) {
        const features = await file.getFeatures(window.contig, window.start, window.end)
        const samples = toSamples(features, window)
        const row = windowRow(samples, { ...window, strand: 1, slotFrom: 0, slotTo: g.columns }, g.columns)
        for (let i = 0; i < g.columns; i++) {
          if (!Number.isFinite(row[i])) continue
          total[i] += row[i]
          seen[i] += 1
        }
      }
      const mean = new Float64Array(g.columns)
      for (let i = 0; i < g.columns; i++) mean[i] = seen[i] > 0 ? total[i] / seen[i] : Number.NaN
      expect(Array.from(seen), `${track}: columns with a value`).toEqual(expectedRow.counts)
      expectSeries(mean, numbers(expectedRow.mean), g.tolerance, track)
    }
  })

  it('places a window the same way `referenceWindows` does', async () => {
    // The golden carries its own window list so the comparison above is about
    // the columns; this is the other half — that the module which *derives* the
    // windows lands on the same coordinates for a feature that is nowhere near
    // a sequence end.
    const g = golden!
    const middle = g.windows[Math.floor(g.windows.length / 2)]
    const centre = (middle.start + middle.end) / 2
    const { windows, layout } = referenceWindows(
      [{ contig: middle.contig, start: centre - 1, end: centre + 1, strand: 0 }],
      { at: 'centre', flank: g.flank, step: g.step, lengthOf: () => 1e9 },
    )
    expect(layout.slots).toBe(g.columns)
    expect(windows[0].start).toBe(middle.start)
    expect(windows[0].end).toBe(middle.end)
    expect([windows[0].slotFrom, windows[0].slotTo]).toEqual([0, g.columns])
  })
})

/** bbi's features for one window, as the `TrackSamples` the kernels consume. */
function toSamples(
  features: Array<{ start: number; end: number; score?: number }>,
  window: { contig: string; start: number; end: number },
): TrackSamples {
  const starts = new Int32Array(features.length)
  const ends = new Int32Array(features.length)
  const values = new Float32Array(features.length)
  for (let i = 0; i < features.length; i++) {
    starts[i] = features[i].start
    ends[i] = features[i].end
    values[i] = features[i].score ?? Number.NaN
  }
  return {
    contig: window.contig,
    start: window.start,
    end: window.end,
    starts,
    ends,
    values,
    min: null,
    max: null,
    variant: null,
    summary: false,
  }
}

// ---------------------------------------------------------------------------
// Interval overlap
// ---------------------------------------------------------------------------

interface OverlapGolden {
  a: string
  b: string
  direct: {
    intersection_bp: number
    union_bp: number
    jaccard: number
    a_with_hit: number
    b_with_hit: number
    n_a: number
    n_b: number
  }
}

suite('interval overlap, against a per-base boolean mask', () => {
  const golden = ready ? loadAnalysisGolden<OverlapGolden>('overlap') : null

  it('agrees exactly on covered bases, Jaccard and hit counts', async () => {
    // A merge join against a mask over every base of the genome. Half-open ends,
    // touching intervals and duplicated intervals all occur in these two real
    // peak files, and each of them is a place the two algorithms would part
    // company by one base if either had its bounds wrong.
    const g = golden!
    const a = parseBed(await readFile(`${DEMO}${g.a}`, 'utf8'), g.a)
    const b = parseBed(await readFile(`${DEMO}${g.b}`, 'utf8'), g.b)
    expect(a.length).toBe(g.direct.n_a)
    expect(b.length).toBe(g.direct.n_b)

    const result = compareSets(a, b, { minFraction: 0 })
    expect(result.intersection).toBe(g.direct.intersection_bp)
    expect(result.union).toBe(g.direct.union_bp)
    expect(result.jaccard).toBeCloseTo(g.direct.jaccard, 12)
    expect(result.featuresAHit).toBe(g.direct.a_with_hit)
    expect(result.featuresBHit).toBe(g.direct.b_with_hit)
  })
})
