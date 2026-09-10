/**
 * The chromosight port against chromosight itself.
 *
 * This is the golden that matters most in the whole §18.10 set, because it is
 * the only task whose output is a **claim about the data** rather than a
 * summary of it. A P(s) that is off by a factor is a curve somebody will
 * eventually notice; a loop set that is off by a threshold is a list of
 * coordinates that looks exactly like a correct one, gets exported, gets
 * plotted, and is wrong in a way nothing downstream can see.
 *
 * So the oracle is not a re-derivation in numpy — there is no second definition
 * of "what chromosight detects" to re-derive. `scripts/make_analysis_golden.py`
 * runs the **actual package** over `demo/yeast/Yeast_microC_G2M_1kb.cool` and
 * records what came out at each stage: the detrended map it scans, the
 * correlation map it thresholds, every call that survives its filters with its
 * score, p-value and q-value, and the pileup it plots. Each of those is a place
 * the two implementations could part company, and each is compared here.
 *
 * The stages are separate tests on purpose. A single end-to-end comparison that
 * failed would say only "different loops"; these say whether the disagreement is
 * in the distance law, in the convolution, in the focus picking, in the window
 * filters or in the multiple-testing correction — which are five different bugs
 * with nothing in common but their symptom.
 *
 * Two chromosomes and two patterns, and both halves of that are load-bearing.
 * Neighbour suppression and the FDR are **global**, so the golden's chromosome
 * list is part of its answer rather than a sample of it; and `borders` exercises
 * a three-template preset, a one-diagonal scan band and the symmetrised pileup,
 * none of which `loops` touches.
 */

import { existsSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

import {
  correlate,
  denseContacts,
  detectOnSquare,
  detectableFromWeights,
  pileupOf,
  prepareSquare,
  quantifyOnSquare,
  symmetrise,
  templatesOf,
  winnowCalls,
  type Kernel,
  type ScanSettings,
  type Square,
} from '@/analysis/chromosight'
import { CHROMOSIGHT_PRESETS } from '@/analysis/chromosightPresets'
import { p2ll } from '@/analysis/apa'
import { MetaCooler } from '@/metacooler/MetaCooler'
import { LocalFileSource } from '@/sources/LocalFileSource'
import type { DenseMatrix } from '@/types'

import {
  analysisGoldensPresent,
  expectSeries,
  loadAnalysisGolden,
  numbers,
  type GoldenNumbers,
} from '../support/analysisGoldens'

const DEMO = new URL('../../demo/yeast/', import.meta.url).pathname
const COOLER = `${DEMO}Yeast_microC_G2M_1kb.cool`

const ready = analysisGoldensPresent() && existsSync(COOLER)
const suite = ready ? describe : describe.skip

interface Corner {
  rows: number[]
  values: GoldenNumbers
}

interface PatternGolden {
  config: {
    pearson: number
    max_dist: number
    min_dist: number
    min_separation: number
    max_perc_zero: number
    max_perc_undetected: number
    kernel_size: number
    n_kernels: number
    max_dist_bins: number
    on_diagonal: boolean
  }
  detrended: Record<string, Corner>
  correlation: Record<string, Corner>
  detectable: Record<string, { n: number; missing: number[] }>
  calls: Array<{
    chrom: string
    bin1: number
    bin2: number
    score: number
    pvalue: number
    qvalue: number
    kernel_id: number
  }>
  n_calls: number
  pileup: GoldenNumbers
  pileup_shape: number[]
  separation_bins: number
}

interface DetectGolden {
  binsize: number
  chroms: string[]
  corner: number
  tolerance: number
  patterns: Record<string, PatternGolden>
}

interface QuantifyGolden {
  binsize: number
  chroms: string[]
  tolerance: number
  config: {
    max_dist: number
    max_dist_bins: number
    kernel_size: number
    max_perc_zero: number
    max_perc_undetected: number
  }
  pairs: Array<{ chrom: string; start1: number; start2: number }>
  scores: GoldenNumbers
  pvalues: GoldenNumbers
  n_windows: number
  n_scored: number
  pileup: GoldenNumbers
  pileup_shape: number[]
  p2ll: number | null
}

/** The demo cooler, opened once for the file. */
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

  async square(chrom: string): Promise<DenseMatrix> {
    const held = this.squares.get(chrom)
    if (held !== undefined) return held
    const mc = await this.open()
    const extent = mc.contigExtent(chrom)
    const dense = await mc.matrix({ rows: extent, cols: extent, balance: true })
    this.squares.set(chrom, dense)
    return dense
  }

  async weights(): Promise<Float64Array> {
    if (this.weightColumn === null) {
      const mc = await this.open()
      this.weightColumn = mc.handle.readNumeric('bins/weight', 0, mc.nBins)
    }
    return this.weightColumn
  }

  /** The square and its detectable bins, as a runner assembles them. */
  async contact(chrom: string): Promise<{ square: Square; from: number }> {
    const mc = await this.open()
    const [from, to] = mc.contigExtent(chrom)
    const dense = await this.square(chrom)
    return {
      square: {
        // The golden hands over a whole dense square; a runner hands over a
        // band off the file. Both are a `ContactSource`, and `prepareSquare`
        // reads the same cells from either.
        contacts: denseContacts(dense.values, to - from),
        n: to - from,
        detectable: detectableFromWeights(await this.weights(), from, to),
      },
      from,
    }
  }
}

const demo = new Demo()

function presetNamed(name: string): (typeof CHROMOSIGHT_PRESETS)[number] {
  const preset = CHROMOSIGHT_PRESETS.find((entry) => entry.name === name)
  if (preset === undefined) throw new Error(`no preset called ${name}`)
  return preset
}

function kernelsOf(name: string): Kernel[] {
  return templatesOf(presetNamed(name))
}

function settingsOf(golden: PatternGolden): ScanSettings {
  return {
    maxDist: golden.config.max_dist_bins,
    pearson: golden.config.pearson,
    missingTol: golden.config.max_perc_undetected / 100,
    zeroTol: golden.config.max_perc_zero / 100,
    onDiagonal: golden.config.on_diagonal,
  }
}

/** The corner of a banded object the golden recorded, flattened row-major. */
function cornerOf(read: (row: number, col: number) => number, side: number): Float64Array {
  const out = new Float64Array(side * side)
  for (let r = 0; r < side; r++) {
    for (let c = 0; c < side; c++) out[r * side + c] = read(r, c)
  }
  return out
}

suite('chromosight, against chromosight', () => {
  const golden = ready ? loadAnalysisGolden<DetectGolden>('chromosight') : null

  it('ships the same kernel matrices the package does', () => {
    // The kernels *are* the algorithm — every score is a correlation against
    // them — so a transcription error here is a detector that quietly answers a
    // different question. The golden carries the sizes and the call scores that
    // follow from the values; this asserts the shape upstream and the shape here
    // have not drifted apart.
    const g = golden!
    for (const [name, pattern] of Object.entries(g.patterns)) {
      const preset = presetNamed(name)
      expect(preset.sizes.length, `${name}: template count`).toBe(pattern.config.n_kernels)
      expect(preset.sizes[0], `${name}: template size`).toBe(pattern.config.kernel_size)
      expect(preset.pearson, `${name}: threshold`).toBe(pattern.config.pearson)
      expect(preset.maxDist, `${name}: scan distance`).toBe(pattern.config.max_dist)
      expect(preset.minSeparation, `${name}: separation`).toBe(pattern.config.min_separation)
      expect(preset.onDiagonal, `${name}: diagonal`).toBe(pattern.config.on_diagonal)
      for (const template of templatesOf(preset)) {
        expect(template.values.length, `${name}: template is square`).toBe(
          template.size * template.size,
        )
      }
    }
  })

  it('finds the same undetectable bins', async () => {
    // Everything downstream is conditioned on this set: the distance law skips
    // them, the mask excludes them, the window filters count them. A port that
    // agreed about the arithmetic and disagreed about the gaps would be wrong
    // everywhere and look right in the middle of a chromosome.
    const g = golden!
    for (const chrom of g.chroms) {
      const { square } = await demo.contact(chrom)
      const expected = g.patterns.loops.detectable[chrom]
      expect(square.n, `${chrom}: bins`).toBe(expected.n)
      const missing: number[] = []
      for (let i = 0; i < square.n; i++) if (square.detectable[i] === 0) missing.push(i)
      expect(missing, `${chrom}: undetectable bins`).toEqual(expected.missing)
    }
  })

  it('detrends the map to the same values', async () => {
    // `ContactMap.detrend` then `remove_diags`. If this fails, nothing below it
    // can be believed: the correlation, the calls and the pileup are all taken
    // from this matrix rather than from the contact counts.
    const g = golden!
    for (const [name, pattern] of Object.entries(g.patterns)) {
      const kernels = kernelsOf(name)
      const largest = kernels.reduce((most, kernel) => Math.max(most, kernel.size), 0)
      for (const chrom of g.chroms) {
        const { square } = await demo.contact(chrom)
        const matrix = prepareSquare(square, {
          maxDist: pattern.config.max_dist_bins,
          largestKernel: largest,
        })
        const side = pattern.detrended[chrom].rows[0]
        expectSeries(
          cornerOf((r, c) => matrix.at(r, c), side),
          numbers(pattern.detrended[chrom].values),
          g.tolerance,
          `${name} ${chrom} detrended`,
          1e-12,
        )
      }
    }
  })

  it('computes the same correlation map', async () => {
    // The dense reformulation of `normxcorr2` in full mode with a missing mask,
    // including the frame rules that decide whether a pixel off the end of a
    // chromosome is a zero or an absence. Those rules are asymmetric upstream
    // and this corner contains three of the four of them.
    //
    // The tolerance is what the app's own reads cost, and it is worth stating
    // rather than tightening. A dense block crosses into a task as a
    // `Float32Array` while chromosight works in float64 from the same pixels,
    // and the difference does not stay where it started: the distance law is a
    // mean of those values, so every cell of a diagonal is divided by a slightly
    // different number, and a Pearson correlation subtracts two nearly equal
    // quantities on top of that. Measured worst over both patterns and both
    // chromosomes: 1.4e-6 relative, 5.4e-9 absolute, on coefficients of a few
    // thousandths — four orders below the 0.15–0.3 a call has to reach, which is
    // why the calls, the scores and the pileup below still compare at 1e-6.
    const g = golden!
    for (const [name, pattern] of Object.entries(g.patterns)) {
      const kernel = kernelsOf(name)[0]
      const settings = settingsOf(pattern)
      const largest = kernelsOf(name).reduce((most, entry) => Math.max(most, entry.size), 0)
      for (const chrom of g.chroms) {
        const { square } = await demo.contact(chrom)
        const matrix = prepareSquare(square, {
          maxDist: settings.maxDist,
          largestKernel: largest,
        })
        const corr = correlate(matrix, square.n, square.detectable, kernel, settings)
        const side = pattern.correlation[chrom].rows[0]
        expectSeries(
          cornerOf((r, c) => corr.at(r, c), side),
          numbers(pattern.correlation[chrom].values),
          g.tolerance,
          `${name} ${chrom} correlation`,
          1e-7,
        )
      }
    }
  })

  for (const name of ['loops', 'borders']) {
    it(`calls the same ${name}, with the same scores, p-values and q-values`, async () => {
      const g = golden!
      const pattern = g.patterns[name]
      const settings = settingsOf(pattern)
      const kernels = kernelsOf(name)
      const largest = kernels.reduce((most, kernel) => Math.max(most, kernel.size), 0)
      const found: Array<{
        chrom: string
        bin1: number
        bin2: number
        score: number
        pvalue: number
        qvalue: number
        kernel_id: number
        values: Float64Array
      }> = []

      for (const chrom of g.chroms) {
        const { square, from } = await demo.contact(chrom)
        const matrix = prepareSquare(square, {
          maxDist: settings.maxDist,
          largestKernel: largest,
        })
        for (let k = 0; k < kernels.length; k++) {
          const corr = correlate(matrix, square.n, square.detectable, kernels[k], settings)
          const result = detectOnSquare(square, matrix, corr, kernels[k], settings)
          for (const call of result.found) {
            found.push({
              chrom,
              bin1: from + call.pattern.bin1,
              bin2: from + call.pattern.bin2,
              score: call.pattern.score,
              pvalue: call.pattern.pvalue,
              qvalue: Number.NaN,
              kernel_id: k,
              values: call.values,
            })
          }
        }
      }

      const { kept, qvalues } = winnowCalls(found, {
        separationBins: pattern.separation_bins,
        minDistBp: pattern.config.on_diagonal ? 0 : pattern.config.min_dist,
        binsize: g.binsize,
      })
      for (let i = 0; i < kept.length; i++) kept[i].qvalue = qvalues[i]

      expect(kept.length, `${name}: number of calls`).toBe(pattern.n_calls)
      // Sorted, because the two implementations reach the same set by different
      // routes — upstream concatenates per chromosome and per template, this
      // does too, but neither order is part of the result.
      const key = (call: { bin1: number; bin2: number }): number => call.bin1 * 1e6 + call.bin2
      const mine = [...kept].sort((a, b) => key(a) - key(b))
      const theirs = [...pattern.calls].sort((a, b) => key(a) - key(b))
      expect(mine.map((call) => [call.bin1, call.bin2]), `${name}: coordinates`).toEqual(
        theirs.map((call) => [call.bin1, call.bin2]),
      )
      expectSeries(
        mine.map((call) => call.score),
        theirs.map((call) => call.score),
        g.tolerance,
        `${name} scores`,
        1e-10,
      )
      expectSeries(
        mine.map((call) => call.pvalue),
        theirs.map((call) => call.pvalue),
        1e-5,
        `${name} p-values`,
        1e-12,
      )
      expectSeries(
        mine.map((call) => call.qvalue),
        theirs.map((call) => call.qvalue),
        1e-5,
        `${name} q-values`,
        1e-12,
      )

      // And the pileup those windows make, which is the picture the task draws.
      const size = pattern.pileup_shape[0]
      const raw = pileupOf(kept.map((call) => call.values), size)
      const pileup = pattern.config.on_diagonal ? symmetrise(raw, size) : raw
      expectSeries(pileup, numbers(pattern.pileup), g.tolerance, `${name} pileup`, 1e-10)
    })
  }
})

suite('chromosight quantify, against chromosight', () => {
  const golden = ready ? loadAnalysisGolden<QuantifyGolden>('chromosight_quantify') : null

  it('scores a given loop set the way `chromosight quantify` does', async () => {
    // The APA task's chromosight mode, and a different code path from detection:
    // the coordinates are given, every one of them comes back whether or not it
    // could be scored, and the scan distance is the loop set's own reach rather
    // than the preset's.
    const g = golden!
    const kernel = kernelsOf('loops')[0]
    const settings: ScanSettings = {
      maxDist: g.config.max_dist_bins,
      pearson: presetNamed('loops').pearson,
      missingTol: g.config.max_perc_undetected / 100,
      zeroTol: g.config.max_perc_zero / 100,
    }

    const scores: number[] = []
    const pvalues: number[] = []
    const windows: Float64Array[] = []
    for (const chrom of g.chroms) {
      const rows = g.pairs
        .map((pair, index) => ({ pair, index }))
        .filter((entry) => entry.pair.chrom === chrom)
      if (rows.length === 0) continue
      const { square } = await demo.contact(chrom)
      const matrix = prepareSquare(square, { maxDist: settings.maxDist, largestKernel: kernel.size })
      const scored = quantifyOnSquare(
        square,
        matrix,
        kernel,
        settings,
        rows.map((entry) => ({
          bin1: Math.floor(entry.pair.start1 / g.binsize),
          bin2: Math.floor(entry.pair.start2 / g.binsize),
        })),
      )
      for (const entry of scored) {
        scores.push(entry.pattern.score)
        pvalues.push(entry.pattern.pvalue)
        windows.push(entry.values)
      }
    }

    expect(windows.length, 'windows').toBe(g.n_windows)
    expectSeries(scores, numbers(g.scores), g.tolerance, 'quantify scores', 1e-10)
    expectSeries(pvalues, numbers(g.pvalues), 1e-5, 'quantify p-values', 1e-12)

    const size = g.pileup_shape[0]
    const pileup = pileupOf(windows, size)
    expectSeries(pileup, numbers(g.pileup), g.tolerance, 'quantify pileup', 1e-10)
    // The enrichment statistic the app prints under the picture, over the same
    // cells — so a pileup that agreed and a number that did not would be caught.
    expect(g.p2ll).not.toBeNull()
    expect(p2ll(pileup, size, size)).toBeCloseTo(g.p2ll!, 6)
  })
})
