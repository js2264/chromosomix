/**
 * The pileup `chromosight quantify` draws, from the APA task.
 *
 * A fourth normalisation rather than a fourth task, because it *is* an aggregate
 * peak analysis — the same anchors, the same averaging, the same corner
 * statistic. What differs is the control, and that difference is the whole
 * reason it is offered: the other three divide the pileup by something computed
 * from the windows themselves (a shifted control, an expected curve), while this
 * one detrends **the map** by its own distance law first and then averages
 * windows that are already ratios. So the number in a cell is
 * *observed / expected at that separation on that sequence*, which is what
 * chromosight's figures are, and a reader can put the two side by side.
 *
 * Three things follow from that and none of them is optional:
 *
 * - **the window is the template's size**, because that is what a quantify
 *   window is — 17 bins for loops — and a 51-bin window detrended the same way
 *   is a different picture with the same name;
 * - **the scan distance is the loop set's own reach**, which is `cmd_quantify`'s
 *   first act. The distance law is computed out to the furthest pair in the file
 *   rather than to the preset's two megabases, so a set of short-range loops is
 *   detrended against a curve fitted to short ranges;
 * - **every anchor comes back**, scored or not. Quantification answers about the
 *   positions it was given; dropping the ones whose window is too empty would
 *   silently reorder somebody's loop table.
 *
 * And it scores as well as piles up. A pileup says what the set looks like on
 * average; the per-anchor Pearson correlation with the template says which
 * members of it look like that at all, which is the difference between a loop
 * set and a list of coordinates.
 */

import { p2ll } from '../apa'
import {
  detectableFromMarginal,
  detectableFromWeights,
  fdrCorrection,
  pileupOf,
  keepDistanceFor,
  prepareSquare,
  quantifyOnSquare,
  symmetrise,
  templatesOf,
  type ScanSettings,
  type Square,
} from '../chromosight'
import { CHROMOSIGHT_PRESETS, type ChromosightPreset } from '../chromosightPresets'
import { CHROMOSIGHT_SPECTRUM } from '../chromosightSpectrum'
import { boolParam, strParam, type JobContext } from '../job'
import { DEFAULT_COUNT_COLUMN } from '../../metacooler/matrix'
import type { CurveOutput, MatrixOutput, TableOutput, TaskOutput } from '../types'
import { bandFor, cisMarginal, usableBlock, validBins, type Span } from './blocks'

/** What the APA runner hands over: an anchor pair in whole-file bins. */
export interface ChromosightAnchor {
  row: number
  col: number
  bounds: Span
  label: string
}

/** The preset an APA run is scoring against. */
export function apaPreset(job: JobContext): ChromosightPreset {
  const name = strParam(job.params, 'csPattern', 'loops')
  return CHROMOSIGHT_PRESETS.find((preset) => preset.name === name) ?? CHROMOSIGHT_PRESETS[0]
}

export async function chromosightPileup(
  job: JobContext,
  anchors: readonly ChromosightAnchor[],
): Promise<TaskOutput[]> {
  const preset = apaPreset(job)
  const kernel = templatesOf(preset)[0]
  const balance = boolParam(job.params, 'balance', false)
  const value = job.framing.value === '' ? DEFAULT_COUNT_COLUMN : job.framing.value
  const binsize = job.mc.binsize

  // `cmd_quantify`'s first act: the scan distance becomes the furthest pair in
  // the set, so the distance law is fitted over the separations that are
  // actually being asked about.
  const furthest = anchors.reduce((most, anchor) => Math.max(most, anchor.col - anchor.row), 0)
  const maxDist = Math.max(Math.min(furthest, job.mc.nBins), 1)
  const settings: ScanSettings = {
    maxDist,
    pearson: preset.pearson,
    missingTol: preset.maxPercUndetected / 100,
    zeroTol: preset.maxPercZero / 100,
    onDiagonal: preset.onDiagonal,
  }

  // Every anchor, with no cap: which anchors were scored is part of what the
  // score means, and a subset chosen by whichever sorted first is not a subset
  // anybody asked for.
  const used = anchors

  // One square per sequence rather than one read per window, and this is the one
  // normalisation where that is required rather than merely cheaper: the
  // distance law is a property of the whole sequence, and no set of windows —
  // however many — can be detrended against a curve taken from itself.
  const bySequence = new Map<number, ChromosightAnchor[]>()
  for (const anchor of used) {
    const held = bySequence.get(anchor.bounds.from)
    if (held === undefined) bySequence.set(anchor.bounds.from, [anchor])
    else held.push(anchor)
  }

  const weights = validBins(job.mc, balance)
  // The one quantity a band cannot answer for itself, counted once and only
  // where there are no weights. See `run/chromosight.ts`.
  let detectableFor: (from: number, to: number) => Uint8Array
  if (weights !== null) {
    detectableFor = (from, to) => detectableFromWeights(weights, from, to)
  } else {
    const marginal = await cisMarginal(job)
    detectableFor = (from, to) => detectableFromMarginal(marginal.subarray(from, to), 5)
  }
  const spans = [...bySequence.values()].map((group) => group[0].bounds)
  const block = usableBlock(job, spans, balance)
  const rows: Array<{ anchor: ChromosightAnchor; score: number; pvalue: number; qvalue: number }> = []
  const windows: Float64Array[] = []
  let done = 0

  for (const [, group] of bySequence) {
    await job.breathe()
    job.progress(done, used.length, `${group.length.toLocaleString()} anchors`)
    const span = group[0].bounds
    const n = span.to - span.from
    if (n <= kernel.size) {
      done += group.length
      continue
    }
    // The band the scan reaches, not the square around it — the same change
    // `run/chromosight.ts` makes and for the same reason: `prepareSquare` reads
    // `0 … keepDistance` and nothing else, and the square was a ceiling on the
    // sequence length rather than a requirement of the arithmetic.
    const contacts = await bandFor(job, span, {
      hi: keepDistanceFor(n, maxDist, kernel.size),
      block,
      balance,
      value,
      onTile: async () => {
        await job.breathe()
      },
    })
    const square: Square = {
      contacts,
      n,
      detectable: detectableFor(span.from, span.to),
    }
    const matrix = prepareSquare(square, { maxDist, largestKernel: kernel.size })
    const scored = quantifyOnSquare(
      square,
      matrix,
      kernel,
      settings,
      group.map((anchor) => ({ bin1: anchor.row - span.from, bin2: anchor.col - span.from })),
    )
    for (let i = 0; i < scored.length; i++) {
      rows.push({
        anchor: group[i],
        score: scored[i].pattern.score,
        pvalue: scored[i].pattern.pvalue,
        qvalue: Number.NaN,
      })
      windows.push(scored[i].values)
    }
    done += group.length
  }
  job.progress(used.length, used.length, 'Done')
  job.throwIfCancelled()

  if (windows.length === 0) {
    job.note('No anchor landed on a sequence long enough to score against this template.')
    return []
  }

  const qvalues = fdrCorrection(rows.map((row) => row.pvalue))
  for (let i = 0; i < rows.length; i++) rows[i].qvalue = qvalues[i]
  const scored = rows.filter((row) => Number.isFinite(row.score)).length
  if (scored < rows.length) {
    job.note(
      `${(rows.length - scored).toLocaleString()} of ${rows.length.toLocaleString()} anchors could ` +
        'not be scored: their window holds too many undetectable or empty pixels. They are in the ' +
        'table with no score, and they contribute nothing to the pileup.',
    )
  }

  const size = kernel.size
  const raw = pileupOf(windows, size)
  const values = preset.onDiagonal ? symmetrise(raw, size) : raw
  return [
    pileupOutput(values, size, { preset, n: scored }),
    spectrumOf(rows, preset),
    tableOf(rows, binsize),
  ]
}

function pileupOutput(
  values: Float64Array,
  size: number,
  about: { preset: ChromosightPreset; n: number },
): MatrixOutput {
  return {
    kind: 'matrix',
    id: 'apa-chromosight',
    label: `Pileup of ${about.n.toLocaleString()} ${about.preset.name.replace(/_/g, ' ')} · chromosight`,
    nrows: size,
    ncols: size,
    values: Float32Array.from(values),
    xLabel: 'Bins from the centre',
    yLabel: 'Bins from the centre',
    xTicks: [],
    yTicks: [],
    // Drawn as `pileup_plot` draws it — the fixed 0–2 seismic scale — so this
    // picture and the one in a chromosight PDF are the same picture.
    ...CHROMOSIGHT_SPECTRUM,
    stats: [
      { label: 'windows', value: about.n, digits: 0, hint: 'Anchors that could be scored.' },
      {
        label: 'P2LL',
        value: p2ll(values, size, size),
        digits: 2,
        hint: 'Centre against the lower-left corner. Above 1 is enrichment.',
      },
    ],
  }
}

/**
 * The distribution of per-anchor scores.
 *
 * The half of the answer a pileup cannot carry. Two sets with the same mean
 * window are the same picture, and one of them can be a hundred good loops while
 * the other is four hundred coordinates of which fifty are loops — which is
 * exactly the distinction anybody piling up a called set is trying to make. The
 * preset's own calling threshold is marked, because that is where chromosight
 * would have stopped believing the score.
 */
function spectrumOf(
  rows: ReadonlyArray<{ score: number }>,
  preset: ChromosightPreset,
): CurveOutput {
  const scores = rows.map((row) => row.score).filter((score) => Number.isFinite(score))
  const lo = scores.length > 0 ? Math.min(...scores) : 0
  const hi = scores.length > 0 ? Math.max(...scores) : 1
  const bins = Math.max(10, Math.min(50, Math.round(Math.sqrt(scores.length) * 2)))
  const width = hi > lo ? (hi - lo) / bins : 1
  const x = new Float64Array(bins)
  const y = new Float64Array(bins)
  for (let i = 0; i < bins; i++) x[i] = lo + width * (i + 0.5)
  for (const score of scores) y[Math.min(bins - 1, Math.max(0, Math.floor((score - lo) / width)))]++
  const above = scores.filter((score) => score >= preset.pearson).length
  return {
    kind: 'curve',
    id: 'apa-chromosight-spectrum',
    label:
      `Score spectrum · ${above.toLocaleString()} of ${scores.length.toLocaleString()} at or above ` +
      `${preset.pearson}`,
    series: [{ name: 'Anchors', x, y, n: scores.length }],
    xLabel: 'Pearson correlation with the template',
    yLabel: 'Anchors',
    xScale: 'linear',
    yScale: 'linear',
  }
}

function tableOf(
  rows: ReadonlyArray<{ anchor: ChromosightAnchor; score: number; pvalue: number; qvalue: number }>,
  binsize: number,
): TableOutput {
  return {
    kind: 'table',
    id: 'apa-chromosight-anchors',
    label: 'Per anchor',
    columns: [
      { key: 'anchor', label: 'Anchor', kind: 'text' },
      { key: 'separation', label: 'Separation (bp)', kind: 'number', digits: 0 },
      { key: 'score', label: 'Score', kind: 'number', digits: 4, hint: 'Pearson r with the template.' },
      { key: 'pvalue', label: 'p', kind: 'number', digits: 6 },
      { key: 'qvalue', label: 'q', kind: 'number', digits: 6, hint: 'Benjamini-Hochberg.' },
    ],
    rows: rows.map((row) => ({
      anchor: row.anchor.label,
      separation: (row.anchor.col - row.anchor.row) * binsize,
      score: row.score,
      pvalue: row.pvalue,
      qvalue: row.qvalue,
    })),
  }
}
