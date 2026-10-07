/**
 * Pattern detection, run.
 *
 * `cmd_detect`'s shape, over one sequence at a time: read the band along its
 * diagonal as deep as the scan reaches (`bandFor`, in tiles — never the square,
 * which put a cap on the sequence length), detrend it, correlate the template
 * across the scan band, take the maximum of each
 * focus, cut a window around it, then — once, over everything found on every
 * sequence — suppress the smears, drop what is too near the diagonal, and
 * correct the p-values for having asked the question a few hundred thousand
 * times.
 *
 * The order of those last three is upstream's and it matters. Suppression comes
 * before the FDR because two pixels of one loop are not two discoveries, and the
 * minimum-distance filter comes before it as well because a call this run was
 * never going to report should not be inflating the correction applied to the
 * ones it does. Both together are the difference between q-values a reader can
 * quote and q-values that merely look like statistics.
 *
 * What comes out is four objects and they are deliberately different in kind: a
 * **loop set** the map draws immediately and the reader can export, a **pileup**
 * of every window it called, the **spectrum** of scores behind that pileup, and
 * a table of the strongest calls. The first is the result; the other three are
 * how somebody decides whether to believe it, which for a caller is not
 * optional — a picture of a hundred windows averaged into a smudge is what tells
 * you the threshold was too low, and no list of coordinates ever will.
 */

import { FeatureBuilder, PairBuilder } from '../../annotations/featureset'
import { DEFAULT_COUNT_COLUMN } from '../../metacooler/matrix'
import { CHROMOSIGHT_SPECTRUM } from '../chromosightSpectrum'
import {
  detectOnSquare,
  detectableFromMarginal,
  detectableFromWeights,
  emptyCorrelation,
  correlateInto,
  keepDistanceFor,
  pileupOf,
  prepareSquare,
  symmetrise,
  templatesOf,
  winnowCalls,
  type ScanSettings,
  type Square,
} from '../chromosight'
import { boolParam, numParam, type JobContext, type TaskRunner } from '../job'
import { loopSpectrum } from '../loopSpectrum'
import {
  MAX_SCAN_CELLS,
  distanceBins,
  presetFor,
  scanCellsFor,
  threshold,
} from '../tasks/chromosight'
import type { ChromosightPreset } from '../chromosightPresets'
import type { CurveOutput, MatrixOutput, TableOutput, TaskOutput } from '../types'
import {
  bandFor,
  cisMarginal,
  displayableContigs,
  spanOfContig,
  usableBlock,
  validBins,
  type Span,
} from './blocks'
import { formatBp, offsetTicks } from './labels'

/** How many rows of a correlation are computed between two chances to cancel. */
const ROWS_PER_BREATH = 64

/** Rows of the pattern table the drawer is given; the full set is the loop set. */
const TABLE_ROWS = 200

/** One sequence to scan. */
interface Unit {
  name: string
  cid: number
  span: Span
  length: number
}

/** A call, in whole-file bins, with the sequence it came from. */
interface Call {
  unit: Unit
  bin1: number
  bin2: number
  score: number
  pvalue: number
  qvalue: number
  kernel: number
  iteration: number
  values: Float64Array
}

export const runChromosight: TaskRunner = async (job) => {
  const preset = presetFor(job.params)
  const balance = boolParam(job.params, 'balance', false)
  const value = job.framing.value === '' ? DEFAULT_COUNT_COLUMN : job.framing.value
  const binsize = job.mc.binsize

  // **Bins, all three of them.** The form asks in bins and the presets are
  // upstream's base pairs, so `distanceBins` is the one place either is divided
  // by a bin size — and what it divides is the *preset's* number. Everything
  // below is a count of the file's own cells, which is what the kernels have
  // always wanted.
  const maxDistBins = distanceBins(job.params, 'maxDist', preset.maxDist, binsize)
  const minDistBins = distanceBins(job.params, 'minDist', preset.minDist, binsize)
  const separationBins = distanceBins(job.params, 'minSeparation', preset.minSeparation, binsize)
  const settings: ScanSettings = {
    // `max(max_dist // binsize, 1)` upstream, and the floor of 1 is what makes a
    // diagonal pattern — whose `max_dist` is zero — scan one diagonal rather
    // than none.
    maxDist: Math.max(maxDistBins, 1),
    pearson: threshold(job.params, 'pearson', preset.pearson),
    missingTol: threshold(job.params, 'maxPercUndetected', preset.maxPercUndetected) / 100,
    zeroTol: threshold(job.params, 'maxPercZero', preset.maxPercZero) / 100,
    // Upstream reads this off the *config*, not off the preset, so a reader who
    // sets the scan distance to zero gets a diagonal pattern — which is what
    // `--max-dist 0` does there too.
    onDiagonal: maxDistBins === 0,
  }
  const onDiagonal = maxDistBins === 0
  // What the band came to in base pairs on the file actually open, since that is
  // the number a reader carries between papers and the one the form no longer
  // shows. Said once, like the diamond's window and the HiC score's reach.
  job.note(
    `A ${settings.maxDist.toLocaleString()}-diagonal scan band reaches ` +
      `${formatBp(settings.maxDist * binsize)} from the diagonal at this file’s ` +
      `${binsize.toLocaleString()} bp resolution.`,
  )
  const iterations = Math.max(1, Math.round(numParam(job.params, 'iterations', 1)))
  const kernels = templatesOf(preset)
  const largestKernel = kernels.reduce((most, kernel) => Math.max(most, kernel.size), 0)

  const { units, skipped } = planUnits(job, settings.maxDist, largestKernel)
  // **Named, not dropped.** The gate's own doc has always said a sequence past
  // the limit is "skipped and named"; only the first half was true, so a run
  // over a mammalian genome scanned whichever chromosomes happened to fit and
  // reported a clean number for the rest. Worse, the empty case said *not long
  // enough* when the truth is the opposite.
  if (skipped.length > 0) {
    job.note(
      `${skipped.length} sequence${skipped.length === 1 ? '' : 's'} would need a band bigger ` +
        `than a scan can hold, and ${skipped.length === 1 ? 'was' : 'were'} skipped: ` +
        `${namesOf(skipped)}. The band is the scan distance times the sequence — bring ` +
        '“furthest from the diagonal” down, or open the file at a coarser resolution.',
    )
  }
  if (units.length === 0) {
    job.note(
      skipped.length === 0
        ? 'No sequence in this file is long enough for this template.'
        : 'Every sequence in this file would need a band bigger than a scan can hold. Bring ' +
          '“furthest from the diagonal” down, or open the file at a coarser resolution.',
    )
    return []
  }

  const weights = validBins(job.mc, balance)
  if (weights === null) {
    job.note(
      'This file carries no balancing weights, so detectable bins are found from the coverage of ' +
        `the raw counts (${numParam(job.params, 'nMads', 5)} MADs below the median). chromosight ` +
        'balances the file first and this app does not write to the file it opened, so the two ' +
        'do not start from the same matrix — the scores are comparable in kind, not to the digit.',
    )
  }

  const block = usableBlock(job, units.map((unit) => unit.span), balance)
  const calls: Call[] = []
  let rejected = 0
  const total = units.length * kernels.length * iterations
  let done = 0

  // **How a bin is judged detectable, decided once for the whole run.** With
  // weights it is a column and no matrix at all; without them it is a count of
  // non-zero pixels over a whole *row* — the one quantity a band cannot answer
  // for itself — so it is counted from the pixel table instead of falling out of
  // a square that is no longer read. Bound here rather than per sequence so the
  // scan happens once.
  let detectableFor: (from: number, to: number) => Uint8Array
  if (weights !== null) {
    detectableFor = (from, to) => detectableFromWeights(weights, from, to)
  } else {
    const nMads = numParam(job.params, 'nMads', 5)
    const marginal = await cisMarginal(job)
    detectableFor = (from, to) => detectableFromMarginal(marginal.subarray(from, to), nMads)
  }

  for (const unit of units) {
    await job.breathe()
    const size = unit.span.to - unit.span.from
    // **The band, not the square.** Everything below this line was already
    // banded — the detrended map keeps `0 … keepDistance`, the correlation map
    // `0 … maxDist` — and the square was read only to build them from. Reading
    // the band instead is what took the cap off the sequence length.
    const keep = keepDistanceFor(size, settings.maxDist, largestKernel)
    const contacts = await bandFor(job, unit.span, {
      hi: keep,
      block,
      balance,
      value,
      onTile: async (at, of) => {
        await job.breathe()
        job.progress(done, total, of === 1 ? `${unit.name} · reading` : `${unit.name} · reading ${at + 1} of ${of}`)
      },
    })
    const square: Square = {
      contacts,
      n: size,
      detectable: detectableFor(unit.span.from, unit.span.to),
    }
    const matrix = prepareSquare(square, { maxDist: settings.maxDist, largestKernel })

    for (let k = 0; k < kernels.length; k++) {
      let kernel = kernels[k]
      for (let iteration = 0; iteration < iterations; iteration++) {
        job.progress(
          done,
          total,
          `${unit.name}${kernels.length > 1 ? ` · template ${k + 1}` : ''}` +
            `${iterations > 1 ? ` · pass ${iteration + 1}` : ''}`,
        )
        // Upstream skips a sub-matrix smaller than its template rather than
        // padding it into one, and so does this: a correlation over a window
        // that is mostly frame is a correlation with the frame.
        if (size <= kernel.size) break

        const corr = emptyCorrelation(size, settings.maxDist)
        for (let row = 0; row < size; row += ROWS_PER_BREATH) {
          await job.breathe()
          correlateInto(
            corr,
            matrix,
            size,
            square.detectable,
            kernel,
            settings,
            row,
            row + ROWS_PER_BREATH,
          )
        }
        const result = detectOnSquare(square, matrix, corr, kernel, settings)
        rejected += result.rejected
        for (const found of result.found) {
          calls.push({
            unit,
            bin1: unit.span.from + found.pattern.bin1,
            bin2: unit.span.from + found.pattern.bin2,
            score: found.pattern.score,
            pvalue: found.pattern.pvalue,
            qvalue: Number.NaN,
            kernel: k,
            iteration,
            values: found.values,
          })
        }
        done++
        // The next pass matches what this one found rather than what it was
        // given. A template with holes in it cannot be correlated against
        // anything, so a pileup that has any is the end of the refinement.
        if (iteration + 1 < iterations) {
          const refined = pileupOf(result.found.map((found) => found.values), kernel.size)
          if (result.found.length === 0 || refined.some((cell) => !Number.isFinite(cell))) {
            job.note(
              `Refinement stopped after pass ${iteration + 1} on ${unit.name}: the pileup of what ` +
                'it found has gaps in it, and a template with gaps cannot be correlated.',
            )
            break
          }
          kernel = { size: kernel.size, values: refined }
        }
      }
    }
  }
  job.progress(total, total, 'done')
  job.throwIfCancelled()

  if (calls.length === 0) {
    job.note(
      `Nothing reached a score of ${settings.pearson} on ${units.length.toLocaleString()} ` +
        `${units.length === 1 ? 'sequence' : 'sequences'}` +
        `${rejected > 0 ? `; ${rejected.toLocaleString()} candidates were found and then dropped for sitting in missing data` : ''}. ` +
        'Lower the score threshold, or check that the pattern suits this map.',
    )
    return []
  }

  const kept = winnow(job, calls, {
    separationBins: Math.max(1, separationBins),
    minDistBins: onDiagonal ? 0 : minDistBins,
    maxQvalue: numParam(job.params, 'maxQvalue', 1),
  })
  if (kept.length === 0) {
    job.note('Every call was suppressed by the separation, distance or q-value filters.')
    return []
  }
  if (rejected > 0) {
    job.note(
      `${rejected.toLocaleString()} candidate ${rejected === 1 ? 'pixel was' : 'pixels were'} ` +
        'dropped for sitting in too much missing or empty data.',
    )
  }

  return outputsFor(job, preset, kept, {
    onDiagonal,
    size: kernels[0].size,
    sequences: units.length,
  })
}

// ---------------------------------------------------------------------------
// Planning
// ---------------------------------------------------------------------------

/**
 * The sequences to scan.
 *
 * Ticked ones, or every displayable one where nothing is ticked — the
 * convention `SequencesParam` sets out, where *unanswered* means the whole file
 * and an empty list is a reader who pressed **None**. Sequences past the size
 * gate are left out here and counted by the estimate, which is the one place
 * that can say so before the run starts.
 */
function planUnits(
  job: JobContext,
  maxDistBins: number,
  largestKernel: number,
): { units: Unit[]; skipped: string[] } {
  const mc = job.mc
  const lengths = mc.chromsizes
  const value = job.params.sequences
  const ticked = Array.isArray(value)
    ? new Set(value.filter((name): name is string => typeof name === 'string'))
    : null
  const units: Unit[] = []
  const skipped: string[] = []
  for (const cid of displayableContigs(mc)) {
    const name = mc.chromnames[cid]
    if (ticked !== null && !ticked.has(name)) continue
    const span = spanOfContig(mc, cid)
    if (span === null) continue
    // Kept apart from the empty-span case above, because they are two different
    // answers: a sequence with no bins is not in this file, and one past the cap
    // is one the reader asked for and did not get.
    if (scanCellsFor(span.to - span.from, maxDistBins, largestKernel) > MAX_SCAN_CELLS) {
      skipped.push(name)
      continue
    }
    units.push({
      name,
      cid,
      span,
      length: lengths.get(name) ?? (span.to - span.from) * mc.binsize,
    })
  }
  return { units, skipped }
}

/** A handful of names, then how many more — a note is a sentence, not a list. */
function namesOf(names: readonly string[]): string {
  const shown = names.slice(0, 6).join(', ')
  return names.length > 6 ? `${shown} and ${names.length - 6} more` : shown
}

// ---------------------------------------------------------------------------
// Whole-file filtering
// ---------------------------------------------------------------------------

/**
 * The whole-file tail, and what the reader is told about it.
 *
 * The arithmetic is {@link winnowCalls} — shared with the golden test, because
 * the order of its three steps is the part that is easy to get wrong and
 * impossible to see. What is here is the counting and the sentences: a run that
 * drops two thirds of what it found and reports a clean number is the failure
 * `analysis/types.ts` keeps a `notes` array for.
 */
function winnow(
  job: JobContext,
  calls: Call[],
  options: { separationBins: number; minDistBins: number; maxQvalue: number },
): Call[] {
  const { kept, qvalues } = winnowCalls(calls, {
    separationBins: options.separationBins,
    minDistBins: options.minDistBins,
  })
  for (let i = 0; i < kept.length; i++) kept[i].qvalue = qvalues[i]
  const suppressed = calls.length - kept.length
  if (suppressed > 0) {
    job.note(
      `${suppressed.toLocaleString()} of ${calls.length.toLocaleString()} calls were dropped as ` +
        'overlapping neighbours or as too close to the diagonal.',
    )
  }
  if (options.maxQvalue >= 1) return kept
  const significant = kept.filter((call) => call.qvalue <= options.maxQvalue)
  job.note(
    `${significant.length.toLocaleString()} of ${kept.length.toLocaleString()} calls are at ` +
      `q ≤ ${options.maxQvalue}.`,
  )
  return significant
}

// ---------------------------------------------------------------------------
// Outputs
// ---------------------------------------------------------------------------

function outputsFor(
  job: JobContext,
  preset: ChromosightPreset,
  calls: Call[],
  shape: { onDiagonal: boolean; size: number; sequences: number },
): TaskOutput[] {
  const binsize = job.mc.binsize
  const label = preset.name.replace(/_/g, ' ')
  const outputs: TaskOutput[] = []

  outputs.push(shape.onDiagonal ? featureOutput(calls, label, binsize) : pairOutput(calls, label, binsize))

  const pileup = pileupOf(calls.map((call) => call.values), shape.size)
  outputs.push({
    kind: 'matrix',
    id: 'chromosight-pileup',
    label: `Pileup of ${calls.length.toLocaleString()} ${label}`,
    nrows: shape.size,
    ncols: shape.size,
    // A diagonal pattern's window is half gaps, so the picture is a triangle
    // until its own transpose is added back — `cmd_detect`'s last step.
    values: Float32Array.from(shape.onDiagonal ? symmetrise(pileup, shape.size) : pileup),
    // Base pairs, not bins: what a reader asks of a pileup is how far from the
    // anchor a thing lies, and a count of bins answers that only for somebody
    // holding the resolution in their head (`run/labels.offsetTicks`).
    xLabel: 'Distance from the centre',
    yLabel: 'Distance from the centre',
    xTicks: offsetTicks(shape.size, binsize),
    yTicks: offsetTicks(shape.size, binsize),
    ...CHROMOSIGHT_SPECTRUM,
    stats: [
      { label: 'patterns', value: calls.length, digits: 0, hint: 'Calls that entered the pileup.' },
      {
        label: 'median score',
        value: median(calls.map((call) => call.score)),
        digits: 3,
        hint: 'Pearson correlation with the template.',
      },
    ],
  } satisfies MatrixOutput)

  outputs.push(spectrumOf(calls, preset))
  // The same scores against the one axis a loop set has and a histogram throws
  // away (`analysis/loopSpectrum.ts`). Only off the diagonal, where there is a
  // separation to plot against: a border's two anchors are one bin apart by
  // construction, and a scatter over a single x is not a plot.
  if (!shape.onDiagonal) {
    const spectrum = loopSpectrum(
      calls.map((call) => ({
        separation: Math.abs(call.bin2 - call.bin1) * binsize,
        score: call.score,
      })),
      {
        id: 'chromosight-loop-spectrum',
        label: `Loop spectrum · ${label}`,
        noun: 'calls',
        yLabel: 'Pearson correlation with the template',
      },
    )
    if (spectrum !== null) outputs.push(spectrum)
  }
  outputs.push(tableOf(calls, binsize))
  job.note(
    `${calls.length.toLocaleString()} ${label} across ${shape.sequences.toLocaleString()} ` +
      `${shape.sequences === 1 ? 'sequence' : 'sequences'}.`,
  )
  return outputs
}

/**
 * The calls as a loop set: two anchors a row, which is what a bedpe is.
 *
 * Offered to the Annotations panel, so it lands on the map as an overlay in the
 * same instant the run finishes and over the picture it was called from. A
 * called loop the reader cannot see on the matrix is a called loop nobody will
 * check, which for a detector is the whole of the review.
 */
function pairOutput(calls: Call[], label: string, binsize: number): TaskOutput {
  const builder = new PairBuilder()
  for (const call of calls) {
    const start1 = (call.bin1 - call.unit.span.from) * binsize
    const start2 = (call.bin2 - call.unit.span.from) * binsize
    builder.add(
      call.unit.name,
      start1,
      Math.min(call.unit.length, start1 + binsize),
      call.unit.name,
      start2,
      Math.min(call.unit.length, start2 + binsize),
      {
        score: call.score,
        name: '',
        detail: detailOf(call),
      },
    )
  }
  return {
    kind: 'intervals',
    id: 'chromosight-patterns',
    label: `Detected ${label}`,
    payload: { kind: 'pairs', data: builder.finish() },
    // The payload's word rather than the preset's, and chosen rather than
    // defaulted: the preset names are plural phrases (`loops_small`) with no
    // singular to derive, the row above already says which pattern was looked
    // for, and *pairs* is the half a reader needs that the label does not give
    // — it is why the button beside it writes BEDPE.
    noun: { one: 'pair', many: 'pairs' },
    // A loop is a pixel of the map, so the set opens on it as rings; its
    // anchors as a 1D track are a reading a reader may ask for and not the
    // picture a loop is (§18.7).
    display: 'overlay',
  }
}

/** The same, for a pattern that lives on the diagonal: one interval a call. */
function featureOutput(calls: Call[], label: string, binsize: number): TaskOutput {
  const builder = new FeatureBuilder()
  for (const call of calls) {
    const start = (call.bin2 - call.unit.span.from) * binsize
    builder.add(call.unit.name, start, Math.min(call.unit.length, start + binsize), {
      score: call.score,
      name: '',
      detail: detailOf(call),
    })
  }
  return {
    kind: 'intervals',
    id: 'chromosight-patterns',
    label: `Detected ${label}`,
    payload: { kind: 'features', data: builder.finish() },
    noun: { one: 'interval', many: 'intervals' },
    // A pattern found on the map's own picture, so on the map: one bin on the
    // diagonal each, a place, drawn as the short marker a border is.
    display: 'overlay',
    look: 'border',
  }
}

function detailOf(call: Call): string {
  return (
    `score ${call.score.toFixed(4)} · p ${format(call.pvalue)} · q ${format(call.qvalue)}` +
    `${call.kernel > 0 ? ` · template ${call.kernel + 1}` : ''}`
  )
}

/**
 * The distribution of scores behind the pileup.
 *
 * The picture a pileup cannot give. A pileup is a mean, and a mean over a
 * bimodal set describes neither half of it — so a smooth shoulder running down
 * to the threshold says the threshold is where the calling stopped rather than
 * where the pattern did, and a peak clear of it says the opposite. It is
 * truncated at the threshold by construction, and the threshold is drawn as the
 * first point rather than left for the reader to infer.
 */
function spectrumOf(calls: Call[], preset: ChromosightPreset): CurveOutput {
  const scores = calls.map((call) => call.score).filter((score) => Number.isFinite(score))
  const lo = Math.min(...scores)
  const hi = Math.max(...scores)
  const bins = Math.max(10, Math.min(50, Math.round(Math.sqrt(scores.length) * 2)))
  const width = hi > lo ? (hi - lo) / bins : 1
  const counts = new Float64Array(bins)
  for (const score of scores) {
    const at = width > 0 ? Math.min(bins - 1, Math.floor((score - lo) / width)) : 0
    counts[at]++
  }
  const x = new Float64Array(bins)
  for (let i = 0; i < bins; i++) x[i] = lo + width * (i + 0.5)
  return {
    kind: 'curve',
    id: 'chromosight-spectrum',
    label: `Score spectrum · ${preset.name.replace(/_/g, ' ')}`,
    series: [{ name: 'Calls', x, y: counts, n: scores.length }],
    xLabel: 'Pearson correlation with the template',
    yLabel: 'Calls',
    xScale: 'linear',
    yScale: 'linear',
  }
}

/** The strongest calls, for reading. The loop set carries all of them. */
function tableOf(calls: Call[], binsize: number): TableOutput {
  const rows = [...calls]
    .sort((a, b) => b.score - a.score)
    .slice(0, TABLE_ROWS)
    .map((call) => ({
      sequence: call.unit.name,
      start1: (call.bin1 - call.unit.span.from) * binsize,
      start2: (call.bin2 - call.unit.span.from) * binsize,
      separation: Math.abs(call.bin2 - call.bin1) * binsize,
      score: call.score,
      pvalue: call.pvalue,
      qvalue: call.qvalue,
    }))
  return {
    kind: 'table',
    id: 'chromosight-table',
    label: rows.length < calls.length ? `Strongest ${rows.length} of ${calls.length}` : 'Patterns',
    columns: [
      { key: 'sequence', label: 'Sequence', kind: 'text' },
      { key: 'start1', label: 'Start 1', kind: 'number', coordinate: 'start' },
      { key: 'start2', label: 'Start 2', kind: 'number', coordinate: 'start' },
      { key: 'separation', label: 'Separation (bp)', kind: 'number', digits: 0 },
      { key: 'score', label: 'Score', kind: 'number', digits: 4, hint: 'Pearson r with the template.' },
      { key: 'pvalue', label: 'p', kind: 'number', digits: 6 },
      { key: 'qvalue', label: 'q', kind: 'number', digits: 6, hint: 'Benjamini-Hochberg.' },
    ],
    rows,
  }
}

function median(values: number[]): number {
  const sorted = values.filter((value) => Number.isFinite(value)).sort((a, b) => a - b)
  if (sorted.length === 0) return Number.NaN
  const half = sorted.length >> 1
  return sorted.length % 2 === 1 ? sorted[half] : (sorted[half - 1] + sorted[half]) / 2
}

function format(value: number): string {
  if (!Number.isFinite(value)) return 'n/a'
  if (value === 0) return '0'
  return value < 1e-4 ? value.toExponential(2) : value.toFixed(6)
}
