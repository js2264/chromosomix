/**
 * Loop calling, run.
 *
 * `dots()`' shape over one sequence at a time: read the band of **raw** counts
 * along its diagonal as deep as the scan reaches plus the kernel's own reach
 * (`bandFor`, in strips — never the square), take the expected `expected_cis`
 * would have handed `dots` from that same band and the file's weights, and
 * score every pixel into the run's λ-chunk histograms, keeping the few that
 * could pass. Then, once, over everything every sequence added: the thresholds,
 * the pixels that reach all four, their q-values, the clusters and the filter.
 *
 * The counts are read raw and balanced here, in `Float64`, rather than read
 * balanced: `dots` tests raw counts with a Poisson tail, multiplies each by the
 * product of its two weights to build the local expected, and divides that
 * product back out — and a balanced block reaches a task as `Float32`, which
 * would move a pixel across a λ-chunk's edge one time in a few million. The raw
 * column is integers, which `Float32` holds exactly.
 *
 * Three outputs beside the loop set, each a way to decide whether to believe
 * it: the calls as a table, their enrichment against separation (the loop
 * spectrum, `analysis/loopSpectrum.ts`), and the count each λ-chunk asked of a
 * pixel — the multiple-testing correction as a curve, which is where a reader
 * sees that a sparse map was held to thresholds nothing could reach.
 */

import { PairBuilder } from '../../annotations/featureset'
import { ViewerError } from '../../errors'
import { DEFAULT_COUNT_COLUMN } from '../../metacooler/matrix'
import {
  DotCaller,
  HICCUPS_KERNELS,
  expectedCis,
  labelEdges,
  recommendedKernel,
  type ClusteredPixel,
  type DotsResult,
} from '../hiccups'
import { boolParam, numParam, type JobContext, type TaskRunner } from '../job'
import { loopSpectrum } from '../loopSpectrum'
import {
  DOTS_FDR,
  DOTS_LAMBDA_BINS,
  MAX_BAND_CELLS,
  clusteringRadiusOf,
  kernelShapeOf,
  maxSeparationOf,
  readReachOf,
} from '../tasks/hiccups'
import type { CurveOutput, TableOutput, TaskOutput } from '../types'
import { bandFor, displayableContigs, spanOfContig, usableBlock, validBins, type Span } from './blocks'
import { formatBp } from './labels'

/** One sequence to scan. */
interface Unit {
  name: string
  span: Span
  length: number
}

/** The kernels' names as a reader reads them, in `HICCUPS_KERNELS`' order. */
const KERNEL_LABELS = ['donut', 'vertical', 'horizontal', 'lower-left'] as const

export const runHiccups: TaskRunner = async (job) => {
  const binsize = job.mc.binsize
  if (!boolParam(job.params, 'balance', true)) {
    throw new ViewerError(
      'unsupported',
      'Loop calling needs a balanced map: its local expected is built from the balanced map and ' +
        'scaled back to raw counts for the Poisson test. Run it with the weights on.',
    )
  }
  const shape = kernelShapeOf(job.params, binsize)
  if (shape === null) {
    throw new ViewerError(
      'unsupported',
      `There are kernels for bins of 4 to 28 kb only, and this map’s are ` +
        `${binsize.toLocaleString()} bp. Give the kernel’s two half-widths (--outer and --inner): ` +
        'w 7, p 4 is the kernel for 5 kb bins, and w 5, p 2 the one for 10 kb.',
    )
  }
  if (shape.p >= shape.w) {
    throw new ViewerError('unsupported', 'The inner half-width must be smaller than the outer one.')
  }
  const separation = maxSeparationOf(job.params, binsize)
  const radius = clusteringRadiusOf(job.params, binsize)
  const settings = {
    shape,
    maxSeparation: separation,
    lambdaBins: Math.round(numParam(job.params, 'lambdaBins', DOTS_LAMBDA_BINS)),
    fdr: numParam(job.params, 'fdr', DOTS_FDR),
    clusteringRadius: radius,
    clusterFiltering: boolParam(job.params, 'filter', true),
  }

  const recommended = recommendedKernel(binsize)
  job.note(
    recommended !== null && recommended.w === shape.w && recommended.p === shape.p
      ? `Kernels w ${shape.w}, p ${shape.p}: the ones for ${formatBp(binsize)} bins.`
      : `Kernels w ${shape.w}, p ${shape.p}` +
          (recommended === null
            ? `, given for ${formatBp(binsize)} bins, which have none of their own.`
            : `; the ones for ${formatBp(binsize)} bins are w ${recommended.w}, p ${recommended.p}.`),
  )
  job.note(
    `A ${separation.toLocaleString()}-bin scan reaches ${formatBp(separation * binsize)} from the ` +
      `diagonal at this file’s ${binsize.toLocaleString()} bp resolution, and the nearest pixel a ` +
      `kernel can be read around is ${(2 * shape.w + 2).toLocaleString()} bins out.`,
  )

  const { units, skipped } = planUnits(job, separation, shape.w)
  if (skipped.length > 0) {
    job.note(
      `${skipped.length} sequence${skipped.length === 1 ? '' : 's'} would need a band bigger than a ` +
        `scan can hold, and ${skipped.length === 1 ? 'was' : 'were'} skipped: ${namesOf(skipped)}. ` +
        'Bring “furthest from the diagonal” down, or open the file at a coarser resolution.',
    )
  }
  if (units.length === 0) {
    job.note('No sequence to scan.')
    return []
  }

  // `validBins` refuses a file with no weights, in its own words.
  const weights = validBins(job.mc, true)!
  const block = usableBlock(
    job,
    units.map((unit) => unit.span),
    false,
  )
  const caller = new DotCaller(settings)
  for (const [index, unit] of units.entries()) {
    await job.breathe()
    const n = unit.span.to - unit.span.from
    const band = await bandFor(job, unit.span, {
      hi: readReachOf(n, separation, shape.w),
      block,
      balance: false,
      value: DEFAULT_COUNT_COLUMN,
      onTile: async (at, of) => {
        await job.breathe()
        const reading = of === 1 ? `${unit.name} · reading` : `${unit.name} · reading ${at + 1} of ${of}`
        job.progress(index, units.length, reading)
      },
    })
    const own = weights.subarray(unit.span.from, unit.span.to)
    const { avg } = expectedCis(band, own)
    await caller.addSequence(index, band, own, avg, async (row) => {
      await job.breathe()
      job.progress(index + row / Math.max(1, n), units.length, `${unit.name} · scoring`)
    })
  }
  job.progress(units.length, units.length, 'thresholds')
  job.throwIfCancelled()
  const result = caller.finish(binsize)

  if (result.overflow > 0) {
    const edges = caller.edges
    job.note(
      `${result.overflow.toLocaleString()} ${result.overflow === 1 ? 'pixel has' : 'pixels have'} a ` +
        `local expected past the last λ-chunk’s edge, ${edges[edges.length - 1].toFixed(0)} contacts, and ` +
        'loop calling stops there rather than test them. Raise the λ-chunks: 50 reach 82,570.',
    )
    return []
  }
  if (result.scored === 0) {
    job.note(
      'No pixel could be scored: every one either sits within the kernel’s reach of the diagonal, ' +
        'of a sequence’s end or of a bin the balancer dropped. Narrow the kernel, or open a finer resolution.',
    )
    return []
  }
  job.note(
    `${result.scored.toLocaleString()} pixels scored over ${units.length.toLocaleString()} ` +
      `${units.length === 1 ? 'sequence' : 'sequences'}; ${result.enriched.length.toLocaleString()} ` +
      `reached all four thresholds at an FDR of ${settings.fdr}.`,
  )
  if (result.unlabelled > 0) {
    job.note(
      `${result.unlabelled.toLocaleString()} of them ${result.unlabelled === 1 ? 'was' : 'were'} left out ` +
        'for sitting a hair past the rounded label of the last λ-chunk their kernel had.',
    )
  }
  if (result.enriched.length === 0) {
    job.note('Nothing passed: no loop is called.')
    return thresholdOutputs(caller, result)
  }
  if (radius > 0) {
    const clusters = new Set(result.clustered.map((pixel) => `${pixel.sequence}:${pixel.cLabel}`)).size
    job.note(
      `${clusters.toLocaleString()} ${clusters === 1 ? 'cluster' : 'clusters'} at a ` +
        `${formatBp(radius)} radius` +
        (settings.clusterFiltering
          ? `; ${result.calls.length.toLocaleString()} passed the enrichment filter.`
          : ', each reported at its brightest pixel, unfiltered.'),
    )
  } else {
    job.note('Unclustered: every enriched pixel is a call, and none is filtered.')
  }

  const outputs: TaskOutput[] = []
  if (result.calls.length > 0) outputs.push(pairOutput(units, result.calls, binsize))
  outputs.push(tableOf(units, result.calls, binsize))
  const spectrum = loopSpectrum(
    result.calls.map((call) => ({
      separation: (call.bin2 - call.bin1) * binsize,
      score: call.count / call.laExp[0],
    })),
    {
      id: 'loops-spectrum',
      label: 'Loop spectrum',
      noun: 'loops',
      yLabel: 'Observed over the donut’s expected',
    },
  )
  if (spectrum !== null) outputs.push(spectrum)
  outputs.push(...thresholdOutputs(caller, result))
  return outputs
}

// ---------------------------------------------------------------------------
// Planning
// ---------------------------------------------------------------------------

/**
 * The sequences to scan: the ticked ones, or every displayable one where nothing
 * is — and a sequence whose band would not fit named rather than dropped.
 */
function planUnits(job: JobContext, separation: number, w: number): { units: Unit[]; skipped: string[] } {
  const mc = job.mc
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
    const n = span.to - span.from
    if ((readReachOf(n, separation, w) + 1) * n > MAX_BAND_CELLS) {
      skipped.push(name)
      continue
    }
    units.push({ name, span, length: mc.chromsizes.get(name) ?? n * mc.binsize })
  }
  return { units, skipped }
}

/** A handful of names, then how many more — a note is a sentence, not a list. */
function namesOf(names: readonly string[]): string {
  const shown = names.slice(0, 6).join(', ')
  return names.length > 6 ? `${shown} and ${names.length - 6} more` : shown
}

// ---------------------------------------------------------------------------
// Outputs
// ---------------------------------------------------------------------------

/**
 * The calls as a loop set: two anchors a row, the bin of each — which is the
 * BEDPE `dots` writes — scored by how far the pixel stands over its donut.
 *
 * Offered to the Annotations panel and drawn on the map it was called from the
 * moment the run finishes: a called loop nobody can see on the matrix is a
 * called loop nobody will check.
 */
function pairOutput(units: readonly Unit[], calls: readonly ClusteredPixel[], binsize: number): TaskOutput {
  const builder = new PairBuilder()
  for (const call of calls) {
    const unit = units[call.sequence]
    const start1 = call.bin1 * binsize
    const start2 = call.bin2 * binsize
    builder.add(
      unit.name,
      start1,
      Math.min(unit.length, start1 + binsize),
      unit.name,
      start2,
      Math.min(unit.length, start2 + binsize),
      { score: call.count / call.laExp[0], name: '', detail: detailOf(call) },
    )
  }
  return {
    kind: 'intervals',
    id: 'loops-calls',
    label: 'Called loops',
    payload: { kind: 'pairs', data: builder.finish() },
    noun: { one: 'loop', many: 'loops' },
    // A loop is a pixel of the map, so the set opens on it as rings (§18.7).
    display: 'overlay',
  }
}

function detailOf(call: ClusteredPixel): string {
  return (
    `observed ${call.count} · ` +
    KERNEL_LABELS.map((label, k) => `${label} ${call.laExp[k].toFixed(2)} (q ${format(call.qval[k])})`).join(' · ') +
    (call.cLabel >= 0 ? ` · cluster of ${call.cSize}` : '')
  )
}

/** Every call, with what it was tested against; the loop set carries the same rows. */
function tableOf(units: readonly Unit[], calls: readonly ClusteredPixel[], binsize: number): TableOutput {
  const rows = calls.map((call) => ({
    sequence: units[call.sequence].name,
    start1: call.bin1 * binsize,
    start2: call.bin2 * binsize,
    separation: (call.bin2 - call.bin1) * binsize,
    count: call.count,
    enrichment: call.count / call.laExp[0],
    donut: call.laExp[0],
    vertical: call.laExp[1],
    horizontal: call.laExp[2],
    lowleft: call.laExp[3],
    qDonut: call.qval[0],
    qVertical: call.qval[1],
    qHorizontal: call.qval[2],
    qLowleft: call.qval[3],
    cluster: call.cLabel >= 0 ? call.cSize : 1,
  }))
  const expected = (key: string, label: string): TableOutput['columns'][number] => ({
    key,
    label: `λ ${label}`,
    kind: 'number',
    digits: 4,
    hint: `Locally adjusted expected, ${label} kernel, in raw counts.`,
  })
  const q = (key: string, label: string): TableOutput['columns'][number] => ({
    key,
    label: `q ${label}`,
    kind: 'number',
    digits: 4,
    scientific: true,
    hint: `Benjamini–Hochberg within its λ-chunk, ${label} kernel.`,
  })
  return {
    kind: 'table',
    id: 'loops-table',
    label: `${calls.length.toLocaleString()} ${calls.length === 1 ? 'loop' : 'loops'}`,
    columns: [
      { key: 'sequence', label: 'Sequence', kind: 'text' },
      { key: 'start1', label: 'Start 1', kind: 'number', coordinate: 'start' },
      { key: 'start2', label: 'Start 2', kind: 'number', coordinate: 'start' },
      { key: 'separation', label: 'Separation (bp)', kind: 'number', digits: 0 },
      { key: 'count', label: 'Observed', kind: 'number', digits: 0, hint: 'Raw contacts in the pixel.' },
      {
        key: 'enrichment',
        label: 'Enrichment',
        kind: 'number',
        digits: 4,
        hint: 'Observed over the donut’s locally adjusted expected.',
      },
      expected('donut', 'donut'),
      expected('vertical', 'vertical'),
      expected('horizontal', 'horizontal'),
      expected('lowleft', 'lower-left'),
      q('qDonut', 'donut'),
      q('qVertical', 'vertical'),
      q('qHorizontal', 'horizontal'),
      q('qLowleft', 'lower-left'),
      { key: 'cluster', label: 'Cluster', kind: 'number', digits: 0, hint: 'Enriched pixels in its cluster.' },
    ],
    rows,
  }
}

/**
 * What each λ-chunk asked of a pixel: the count it had to reach, against the
 * chunk's own λ, kernel by kernel, on log axes with the line where a pixel
 * merely meets its expected.
 *
 * Drawn for the chunks that hold a pixel bright enough to be tested at all: a
 * chunk whose threshold no pixel of it reaches is one where the correction
 * gave up, which `dots` writes as the count where the Poisson tail runs out,
 * and plotted it is a spike that says nothing about the map.
 */
function thresholdOutputs(caller: DotCaller, result: DotsResult): TaskOutput[] {
  const { counts, cells } = caller.histogram.table()
  const chunks = caller.histogram.chunks
  const labels = labelEdges(caller.edges)
  const series: CurveOutput['series'] = []
  HICCUPS_KERNELS.forEach((_, k) => {
    const thresholds = result.thresholds[k]
    const x: number[] = []
    const y: number[] = []
    for (let chunk = 0; chunk < thresholds.length; chunk++) {
      let brightest = Number.NEGATIVE_INFINITY
      for (let r = counts.length - 1; r >= 0; r--) {
        if (cells[k][r * chunks + chunk] > 0) {
          brightest = counts[r]
          break
        }
      }
      if (!(brightest >= thresholds[chunk])) continue
      x.push(labels[chunk])
      y.push(thresholds[chunk])
    }
    series.push({ name: KERNEL_LABELS[k], x: Float64Array.from(x), y: Float64Array.from(y), mark: 'points' })
  })
  const top = Math.max(1, ...series.flatMap((s) => Array.from(s.x)))
  series.push({ name: 'observed = λ', x: Float64Array.from([1, top]), y: Float64Array.from([1, top]), mark: 'line' })
  return [
    {
      kind: 'curve',
      id: 'loops-thresholds',
      label: 'Contacts needed, by λ-chunk',
      series,
      xLabel: 'Locally adjusted expected (λ), raw counts',
      yLabel: 'Contacts a pixel must reach',
      xScale: 'log',
      yScale: 'log',
    } satisfies CurveOutput,
  ]
}

function format(value: number): string {
  if (!Number.isFinite(value)) return 'n/a'
  if (value === 0) return '0'
  return value < 1e-4 ? value.toExponential(2) : value.toFixed(4)
}
