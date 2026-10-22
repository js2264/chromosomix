/**
 * The runners behind `tasks/structure.ts` (§25.6).
 *
 * The map is read one square per sequence, at the map's bin size, through
 * the same road every other map task takes (`squareFor`); the model comes
 * in as the feature set the structure row is, with its `model` of places.
 * Everything numeric is `structure/versusMap.ts`, held still by its tests.
 */

import { structureFromBeads, type ModelBead } from '../../annotations/g3d'
import type { FeatureSet, StructureModel } from '../../annotations/types'
import { DEFAULT_COUNT_COLUMN, DEFAULT_WEIGHT_COLUMN } from '../../metacooler/matrix'
import { parseRegionString, splitRegionList } from '../../metacooler/range'
import { logBinCurve, logLogSlope } from '../expected'
import {
  boolParam,
  chosenInput,
  contigIdFor,
  missingInput,
  numParam,
  strParam,
  type JobContext,
  type TaskRunner,
} from '../job'
import type {
  CurveOutput,
  CurveSeries,
  IntervalsOutput,
  MatrixOutput,
  ProfileOutput,
  TableOutput,
  TaskOutput,
} from '../types'
import {
  dispersionAt,
  fitDispersion,
  likelihoodWalk,
  mdsWalk,
  momentsBySeparation,
  randomStart,
  storeWishes,
  type Dispersion,
  type MdsFit,
  type NegBinomFit,
  type SeparationMoments,
} from '../../structure/negbinom'
import { numpyRandom } from '../random'
import { openFitThreads } from '../likelihoodThreads'
import {
  classicalMdsSweeps,
  compactInPlace,
  distancesOverContacts,
  fillDistancesInPlace,
  normaliseCoordinates,
  smacofStep,
  spearman,
  stressOf,
  type Coordinates,
  type DenseMatrix,
  type WeightMode,
} from '../../structure/reconstruct'
import {
  agreement,
  beadsOf,
  binBeads,
  centroid,
  contactsBySeparation,
  distanceBySeparation,
  distanceFrom,
  distanceMatrix,
  inverseDistances,
  localCompaction,
  paintProfile,
} from '../../structure/versusMap'
import { blockCovers, spanOfContig, squareFor, usableBlock, type Span } from './blocks'
import { formatBp } from './labels'
import { regionLabel } from '../../genome/assembly'

/**
 * The bar's share of pastis' MDS start, in the units the likelihood's steps are.
 *
 * The MDS stops on pastis' tolerance rather than on a count, so it has no
 * denominator to walk; it usually stops within a hundred steps, so the first
 * hundred units are its and anything after them waits at the last.
 */
const MDS_SHARE = 100

/** What a run says about why the optimiser stopped. */
const STOP_WORDS: Record<NegBinomFit['stop'], string> = {
  gradient: 'the gradient: a maximum of the likelihood',
  value: 'pastis’ tolerance: a step bought less than a double can hold',
  steps: 'the step budget — raise it for a closer fit',
  search: 'a line search that found nowhere better to go',
}

const NO_STRUCTURE = {
  unchosen: 'No structure was chosen. Load a g3d or bed3d and pick it under Structure.',
  gone: 'The structure that was chosen is no longer in the list.',
}

/** The sequences the model and the map share, with the map's span of each. */
function sharedSequences(job: JobContext, set: FeatureSet): Array<{ name: string; cid: number; span: Span }> {
  const out: Array<{ name: string; cid: number; span: Span }> = []
  for (const name of set.contigs) {
    const cid = job.mc.chromnames.indexOf(name)
    if (cid < 0) continue
    const [from, to] = job.mc.contigExtent(cid)
    if (to > from) out.push({ name, cid, span: { from, to } })
  }
  return out
}

/** The haplotypes to run over: each of a phased file, or the one of a haploid. */
function haplotypesOf(model: StructureModel): Array<{ index: number; label: string }> {
  if (model.haplotypes.length <= 1) return [{ index: -1, label: '' }]
  return model.haplotypes.map((label, index) => ({ index, label }))
}

function structureOf(job: JobContext): { set: FeatureSet; model: StructureModel; label: string } | null {
  const found = chosenInput(job.inputs.features, job.params, 'structure')
  const missing = missingInput(found, NO_STRUCTURE)
  if (missing !== null || found.value === undefined) {
    job.note(missing ?? NO_STRUCTURE.unchosen)
    return null
  }
  const set = found.value
  if (set.model === undefined) {
    job.note('The chosen row is not a structure: it has no coordinates to read.')
    return null
  }
  const id = typeof job.params.structure === 'string' ? job.params.structure : ''
  return { set, model: set.model, label: job.inputs.labels?.[id] ?? 'structure' }
}

export const runStructureMap: TaskRunner = async (job) => {
  const held = structureOf(job)
  if (held === null) return []
  const { set, model, label } = held
  const sequences = sharedSequences(job, set)
  if (sequences.length === 0) {
    job.note('The model and the map share no sequence name. Check the names in the Tracks card.')
    return []
  }
  const balance = boolParam(job.params, 'balance', false)
  const value = job.framing.value === '' ? DEFAULT_COUNT_COLUMN : job.framing.value
  const alpha = numParam(job.params, 'alpha', 3)
  // The first of what the box names: the box is seeded with every sequence
  // on screen (§25.6), and the picture is of one.
  const wanted = (splitRegionList(strParam(job.params, 'region', ''))[0] ?? '').split(':')[0].trim()
  const pictured = sequences.find((sequence) => sequence.name === wanted) ?? sequences[0]
  const haplotypes = haplotypesOf(model)
  const binsize = job.mc.binsize

  const outputs: TaskOutput[] = []
  const rows: TableOutput['rows'] = []
  let done = 0
  for (const sequence of sequences) {
    job.throwIfCancelled()
    job.progress(done++, sequences.length, sequence.name)
    const bins = sequence.span.to - sequence.span.from
    const square = await squareFor(job, sequence.span, {
      block: usableBlock(job, [sequence.span], balance),
      balance,
      value,
    })
    for (const haplotype of haplotypes) {
      const beads = beadsOf(set, sequence.name, haplotype.index)
      if (beads.length === 0) continue
      const points = binBeads(set, model, beads, binsize, bins)
      const distances = distanceMatrix(points)
      const fit = agreement(distances, square.values, bins)
      rows.push({
        sequence: sequence.name,
        haplotype: haplotype.label,
        bins: Array.from(points.present).filter((p) => p === 1).length,
        pairs: fit.pairs,
        rho: fit.rho,
      })
      if (sequence !== pictured) continue
      const suffix = haplotype.label === '' ? '' : ` · ${haplotype.label}`
      const ticks = Array.from({ length: bins }, (_, i) => formatBp(i * binsize))
      outputs.push(
        matrixOf(`structure-distance-${haplotype.index}`, `Model distances · ${sequence.name}${suffix}`, bins, distances, ticks, 'viridis'),
        matrixOf(
          `structure-predicted-${haplotype.index}`,
          `Predicted contacts 1/d^${alpha} · ${sequence.name}${suffix}`,
          bins,
          inverseDistances(distances, alpha),
          ticks,
          'fall',
        ),
      )
      outputs.push(...curvesOf(sequence.name, suffix, haplotype.index, distances, square.values, bins, binsize))
    }
  }
  job.progress(sequences.length, sequences.length)
  const table: TableOutput = {
    kind: 'table',
    id: 'structure-agreement',
    label: `Model versus map · ${label}`,
    columns: [
      { key: 'sequence', label: 'Sequence', kind: 'text' },
      ...(haplotypes.length > 1 ? [{ key: 'haplotype', label: 'Haplotype', kind: 'text' as const }] : []),
      { key: 'bins', label: 'Bins modelled', kind: 'number', digits: 0 },
      { key: 'pairs', label: 'Pairs compared', kind: 'number', digits: 0 },
      {
        key: 'rho',
        label: 'Spearman ρ (1/d vs contacts)',
        kind: 'number',
        digits: 3,
        hint: 'Rank correlation between the inverse model distance and the observed contacts, over pairs at least two bins apart. 1 is a model that orders every pair as the map does.',
      },
    ],
    rows,
  }
  outputs.push(table)
  return outputs
}

function matrixOf(
  id: string,
  label: string,
  n: number,
  values: Float32Array,
  ticks: string[],
  colormap: string,
): MatrixOutput {
  return {
    kind: 'matrix',
    id,
    label,
    nrows: n,
    ncols: n,
    values,
    xLabel: 'Position',
    yLabel: 'Position',
    xTicks: ticks,
    yTicks: ticks,
    colormap,
  }
}

/** Distance by separation and the map's own P(s) over the same bins, log-binned, with the slope. */
function curvesOf(
  name: string,
  suffix: string,
  haplotype: number,
  distances: Float32Array,
  contacts: Float32Array,
  bins: number,
  binsize: number,
): CurveOutput[] {
  const spatial = distanceBySeparation(distances, bins)
  const observed = contactsBySeparation(contacts, bins)
  const toSeries = (values: Float64Array, seriesName: string): CurveSeries | null => {
    const curve = { maxOffset: bins - 1, sum: new Float64Array(bins), count: new Float64Array(bins), mean: values }
    for (let s = 1; s < bins; s++) {
      if (Number.isNaN(values[s])) continue
      curve.sum[s] = values[s]
      curve.count[s] = 1
    }
    const binned = logBinCurve(curve, binsize, 1.25, 1)
    if (binned.x.length < 2) return null
    return { name: seriesName, x: binned.x, y: binned.y, n: bins }
  }
  const out: CurveOutput[] = []
  const spatialSeries = toSeries(spatial, `${name}${suffix}`)
  if (spatialSeries !== null) {
    const slope = logLogSlope(spatialSeries.x, spatialSeries.y)
    out.push({
      kind: 'curve',
      id: `structure-dvs-${haplotype}`,
      label: `Model distance by separation · ${name}${suffix}`,
      series: [spatialSeries],
      xLabel: 'Genomic separation (bp)',
      yLabel: 'Mean distance (model units)',
      xScale: 'log',
      yScale: 'log',
    })
    if (slope.x.length > 0) {
      out.push({
        kind: 'curve',
        id: `structure-dvs-slope-${haplotype}`,
        label: `Log-log slope of the model’s distance · ${name}${suffix}`,
        series: [{ name: `${name}${suffix}`, x: slope.x, y: slope.y }],
        xLabel: 'Genomic separation (bp)',
        yLabel: 'd log d / d log s',
        xScale: 'log',
        yScale: 'linear',
      })
    }
  }
  const observedSeries = toSeries(observed, `${name} · map`)
  if (observedSeries !== null) {
    out.push({
      kind: 'curve',
      id: `structure-ps-${haplotype}`,
      label: `The map’s P(s) over the same bins · ${name}`,
      series: [observedSeries],
      xLabel: 'Genomic separation (bp)',
      yLabel: 'Mean contact per bin pair',
      xScale: 'log',
      yScale: 'log',
    })
  }
  return out
}

export const runSpatialTracks: TaskRunner = async (job) => {
  const held = structureOf(job)
  if (held === null) return []
  const { set, model, label } = held
  const sequences = sharedSequences(job, set)
  if (sequences.length === 0) {
    job.note('The model and the map share no sequence name. Check the names in the Tracks card.')
    return []
  }
  const binsize = job.mc.binsize
  const nBins = job.mc.nBins
  const window = numParam(job.params, 'window', 5)
  const locusText = strParam(job.params, 'locus', '').trim()
  const haplotypes = haplotypesOf(model)
  const outputs: TaskOutput[] = []

  for (const haplotype of haplotypes) {
    const suffix = haplotype.label === '' ? '' : ` · ${haplotype.label}`
    const all = sequences.flatMap((sequence) => beadsOf(set, sequence.name, haplotype.index))
    const centre = centroid(model, all)
    const radial = new Float32Array(nBins).fill(Number.NaN)
    const compaction = new Float32Array(nBins).fill(Number.NaN)
    const toLocus = new Float32Array(nBins).fill(Number.NaN)
    const anchor = locusText === '' ? null : anchorPoint(set, model, locusText, haplotype.index)
    for (const sequence of sequences) {
      job.throwIfCancelled()
      const beads = beadsOf(set, sequence.name, haplotype.index)
      if (beads.length === 0) continue
      const bins = sequence.span.to - sequence.span.from
      if (centre !== null) {
        paintProfile(set, beads, distanceFrom(model, beads, centre), binsize, sequence.span.from, bins, radial)
      }
      paintProfile(set, beads, localCompaction(model, beads, window), binsize, sequence.span.from, bins, compaction)
      if (anchor !== null) {
        paintProfile(set, beads, distanceFrom(model, beads, anchor), binsize, sequence.span.from, bins, toLocus)
      }
    }
    const profile = (id: string, name: string, values: Float32Array, colour: string): ProfileOutput => ({
      kind: 'profile',
      id: `${id}-${haplotype.index}`,
      label: `${name}${suffix} · ${label}`,
      values,
      extent: [0, nBins],
      binsize,
      unit: 'model units',
      colour,
      group: 'structure',
    })
    if (centre !== null) outputs.push(profile('structure-radial', 'Radial position', radial, '#1f5fa9'))
    outputs.push(profile('structure-compaction', `Local compaction (±${Math.round(window)} beads)`, compaction, '#0f8a5f'))
    if (anchor !== null) {
      // *The centre of*, because the anchor is a centroid: a 400 kb window named
      // bare read as though the distance were to a point.
      outputs.push(
        profile('structure-distance', `Distance to the centre of ${locusName(locusText)}`, toLocus, '#c0392b'),
      )
    }
  }
  if (locusText !== '' && !outputs.some((output) => output.id.startsWith('structure-distance'))) {
    job.note(`No bead of the model lies at ${locusName(locusText)}, so the distance track was not made.`)
  }
  return outputs
}

/**
 * A locus as a reader's own coordinates, for a name that will be read.
 *
 * What a runner is handed is cooler's grammar — `IV:1000000-1400000`, which
 * `runnerParams` made of what was typed or picked — and naming a structure row
 * and three lanes with it put the one string on the Structures card that had no
 * separators directly under a framing line that did, a base away from it. So
 * the name is §26.1's display form, `IV:1,000,001-1,400,000`, through the
 * helper every locus box uses; a box that takes several names each part, in
 * the order given; a bare sequence or genome name has no coordinates and comes
 * back as itself.
 */
function locusName(machine: string): string {
  return splitRegionList(machine).map(regionLabel).join(', ')
}

/**
 * The model's point at a locus — 0-based and half-open, as a runner is handed
 * one (`runnerParams`) — the centroid of every bead the locus covers, which is
 * what the tracks below call its centre.
 */
function anchorPoint(
  set: FeatureSet,
  model: StructureModel,
  text: string,
  haplotype: number,
): [number, number, number] | null {
  const [name, rest] = text.split(':')
  const contig = name?.trim() ?? ''
  const beads = beadsOf(set, contig, haplotype)
  if (beads.length === 0) return null
  const range = (rest ?? '').replace(/,/g, '').split(/[-–]/)
  const start = Number(range[0])
  const end = range.length > 1 ? Number(range[1]) : start
  if (!Number.isFinite(start)) return centroid(model, beads)
  const from = Math.min(start, end)
  const to = Math.max(start, end)
  const hit = beads.filter((i) => set.end[i] > from && set.start[i] < to)
  return centroid(model, hit.length > 0 ? hit : beads.filter((i) => set.start[i] <= from && set.end[i] > from))
}

// ---------------------------------------------------------------------------
// A model from the map
// ---------------------------------------------------------------------------

/**
 * The contacts a model is solved over: one cell per bead, each one bin, with
 * the square of contacts between every two.
 *
 * `binFrom`/`binTo` name each cell's bins, since the cells need not be one
 * contiguous run — several sequences named leave the ones between them out,
 * and the whole file is every sequence's run one after the other. A cell is
 * always exactly one bin of the selected resolution, whichever way the
 * contacts arrive; the pair is kept rather than an index because the bins are
 * not contiguous.
 */
interface Cells {
  n: number
  binFrom: Int32Array
  binTo: Int32Array
  values: Float32Array
}

/** The sequences of the file as bin runs, for placing a cell on one. */
function contigRuns(job: JobContext): Array<{ cid: number; from: number; to: number }> {
  const out: Array<{ cid: number; from: number; to: number }> = []
  for (let cid = 0; cid < job.mc.nContigs; cid++) {
    const [from, to] = job.mc.contigExtent(cid)
    if (to > from) out.push({ cid, from, to })
  }
  return out
}

/**
 * Where the contacts come from: the view's block as drawn, or the file read
 * and pooled.
 *
 * The block is what the reader is looking at, and it is taken as it is —
 * pooled cells included, which is the one place `binsPerCell > 1` is
 * honoured rather than refused — whenever it can honestly answer: it is
 * square, balanced the way the run asks, and covers every span asked for.
 * Otherwise the file is **read span by span**, one rectangle per pair of
 * spans (so two sequences far apart in the file cost their two squares and
 * the rectangle between them, never the sequences in between), and pooled
 * `k` bins to a bead as it is read — which is how a whole genome at 1 kb
 * becomes a model at 5 kb without a 12,000² block ever existing. The mean
 * of the counted bins, so a balanced matrix pools as a balanced one.
 */
async function contactCells(
  job: JobContext,
  spans: Span[] | null,
  balance: boolean,
  value: string,
  /** The `n²` matrices the method will hold, for the note if the first will not fit. */
  matrices: number,
): Promise<{ cells: Cells; how: string } | { refusal: string }> {
  const block = job.inputs.block
  // **Never a pooled block**, which is `usableBlock`'s rule and every other
  // task's (`run/blocks.ts`): a block drawn four bins to the cell is coarser
  // than the file, and `binsPerCell` exists precisely so a task can decline to
  // pretend otherwise. This one used to accept it, and so was the only task in
  // the app whose answer came at the resolution of the *window* — a number out
  // of a raster cap — rather than at the resolution the reader selected. A
  // block at one bin to the cell is the file, so borrowing that one is free
  // and changes nothing.
  const square =
    block !== undefined &&
    block.binsPerCell === 1 &&
    block.rowExtent[0] === block.colExtent[0] &&
    block.rowExtent[1] === block.colExtent[1] &&
    block.nrows === block.ncols &&
    job.framing.balance === balance
  const wholeFile = spans === null
  const wanted: Span[] = wholeFile ? contigRuns(job).map((run) => ({ from: run.from, to: run.to })) : spans
  if (wanted.length === 0) return { refusal: 'The file has no sequence to model.' }

  // The block, where it covers what was asked for. The whole file is the
  // block only where the block *is* the whole file.
  if (square && block !== undefined && wanted.every((span) => blockCovers(block, span))) {
    const rows: number[] = []
    const binFrom: number[] = []
    const binTo: number[] = []
    for (let r = 0; r < block.nrows; r++) {
      const from = block.rowExtent[0] + r
      if (!wanted.some((span) => from < span.to && from + 1 > span.from)) continue
      rows.push(r)
      binFrom.push(from)
      binTo.push(from + 1)
    }
    const n = rows.length
    const values = allocate(n)
    if (values === null) return { refusal: tooBig(n, matrices) }
    for (let a = 0; a < n; a++) {
      const at = rows[a] * block.ncols
      for (let b = 0; b < n; b++) values[a * n + b] = block.values[at + rows[b]]
    }
    return {
      cells: { n, binFrom: Int32Array.from(binFrom), binTo: Int32Array.from(binTo), values },
      how: 'the block as drawn, one bin to a bead',
    }
  }

  // The file, read and pooled.
  const binFrom: number[] = []
  const binTo: number[] = []
  const cellsOfSpan: number[][] = []
  for (const span of wanted) {
    const own: number[] = []
    for (let from = span.from; from < span.to; from++) {
      own.push(binFrom.length)
      binFrom.push(from)
      binTo.push(from + 1)
    }
    cellsOfSpan.push(own)
  }
  const n = binFrom.length
  if (n === 0) return { refusal: 'The framing holds no bins to model.' }
  const values = allocate(n)
  const counts = values === null ? null : allocate(n)
  if (values === null || counts === null) return { refusal: tooBig(n, matrices) }
  const total = (wanted.length * (wanted.length + 1)) / 2
  let done = 0
  for (let a = 0; a < wanted.length; a++) {
    for (let b = a; b < wanted.length; b++) {
      await job.breathe()
      job.progress(done++, total + 2, `reading ${done} of ${total} blocks`)
      const rowSpan = wanted[a]
      const colSpan = wanted[b]
      const dense = await job.mc.matrix({
        rows: [rowSpan.from, rowSpan.to],
        cols: [colSpan.from, colSpan.to],
        balance,
        value,
      })
      const rowCells = cellsOfSpan[a]
      const colCells = cellsOfSpan[b]
      for (let r = 0; r < dense.nrows; r++) {
        const rc = rowCells[r]
        if (rc === undefined) continue
        const rowAt = r * dense.ncols
        for (let c = 0; c < dense.ncols; c++) {
          const v = dense.values[rowAt + c]
          if (!Number.isFinite(v)) continue
          const cc = colCells[c]
          if (cc === undefined) continue
          values[rc * n + cc] += v
          counts[rc * n + cc] += 1
          if (rc !== cc) {
            values[cc * n + rc] += v
            counts[cc * n + rc] += 1
          }
        }
      }
    }
  }
  for (let at = 0; at < values.length; at++) values[at] = counts[at] > 0 ? values[at] / counts[at] : Number.NaN
  return {
    cells: { n, binFrom: Int32Array.from(binFrom), binTo: Int32Array.from(binTo), values },
    how: 'read from the file, one bin to a bead',
  }
}

/**
 * An `n × n` matrix of singles, or `null` where the browser will not give one.
 *
 * The replacement for the bead ceiling. A ceiling was a number this file
 * guessed about somebody else's machine; asking and being refused is the same
 * machine answering for itself. A `RangeError` — the length is past what a
 * typed array may be — and an out-of-memory both arrive here as a throw.
 */
function allocate(n: number): Float32Array | null {
  try {
    // On memory other threads can read, where this one may share it — the
    // command line; a page is not served with the headers that allow it — so
    // that pastis-NB's helpers read the counts rather than copies of them
    // (`analysis/likelihoodThreads.ts`). A refusal falls back to a buffer of
    // this thread's own, which is the same matrix to everything but a helper.
    const isolated = (globalThis as { crossOriginIsolated?: boolean }).crossOriginIsolated
    if (typeof SharedArrayBuffer === 'function' && isolated !== false) {
      try {
        return new Float32Array(new SharedArrayBuffer(4 * n * n))
      } catch {
        // An ordinary buffer, then.
      }
    }
    return new Float32Array(n * n)
  } catch {
    return null
  }
}

/**
 * The note for a browser that would not give the run its matrices: `matrices`
 * of them, `n²` singles each — two under ShRec3D, one under pastis-NB.
 */
function tooBig(n: number, matrices: number): string {
  const gb = (matrices * 4 * n * n) / 1e9
  return (
    `${n.toLocaleString()} beads needs about ${gb.toFixed(1)} GB ${matrices === 1 ? 'for its matrix' : 'of matrices'}, and this browser ` +
    'would not give it. Select a coarser resolution, or name fewer sequences.'
  )
}

/**
 * The spans a typed region names — one per comma-separated part, a sequence
 * or a locus — or `null` for everything; the missing name where the file
 * lacks one.
 */
function regionSpans(job: JobContext, text: string): Span[] | null | { missing: string } {
  if (text === '') return null
  const out: Span[] = []
  for (const trimmed of splitRegionList(text)) {
    const span = regionSpan(job, trimmed)
    if (span === undefined) return { missing: parseRegionString(trimmed)[0] }
    if (span !== null) out.push(span)
  }
  return out.length === 0 ? null : out
}

/** The span one typed part names, or `null` for everything; `undefined` for a name the file lacks. */
function regionSpan(job: JobContext, text: string): Span | null | undefined {
  if (text === '') return null
  const [name, start, end] = parseRegionString(text)
  const cid = contigIdFor(job.mc, name)
  if (cid < 0) return undefined
  const whole = spanOfContig(job.mc, cid)
  if (whole === null) return undefined
  if (start === null) return whole
  const binsize = job.mc.binsize
  const from = Math.max(whole.from, whole.from + Math.floor(start / binsize))
  const to = end === null ? whole.to : Math.min(whole.to, whole.from + Math.ceil(end / binsize))
  return to > from ? { from, to } : undefined
}

export const runReconstruct: TaskRunner = async (job) => {
  const balance = boolParam(job.params, 'balance', false)
  const value = job.framing.value === '' ? DEFAULT_COUNT_COLUMN : job.framing.value
  const alpha = Math.max(0.5, numParam(job.params, 'alpha', 3))
  const iterations = Math.max(0, Math.round(numParam(job.params, 'iterations', 150)))
  const weightText = strParam(job.params, 'weights', 'contacts')
  const weightMode: WeightMode = weightText === 'sqrt' || weightText === 'equal' ? weightText : 'contacts'
  // The runner settles the method itself rather than trusting the control, for
  // the reason every other one does: a job can reach the worker without passing
  // through a form, and a stored session may name a method a later version
  // dropped. Anything that is not ShRec3D is the default, which is pastis-NB.
  const nb = strParam(job.params, 'method', 'nb') !== 'shrec3d'
  // pastis' `random_state`: where its MDS places the beads before it starts.
  const seed = Math.max(0, Math.round(numParam(job.params, 'seed', 0)))
  const regionText = strParam(job.params, 'region', '').trim()
  const spans = regionSpans(job, regionText)
  if (spans !== null && !Array.isArray(spans)) {
    job.note(
      `This file has no sequence called ${spans.missing}, under that spelling or ` +
        `any this viewer knows of. It has ` +
        `${job.mc.chromnames.slice(0, 6).join(', ')}${job.mc.chromnames.length > 6 ? ', …' : ''}.`,
    )
    return []
  }
  // **pastis-NB reads the raw counts**, whatever the view is balanced with, and
  // folds the weights into the mean instead (`biasForCells`). A balanced value
  // is a count times two weights: not an integer, scaled by an arbitrary
  // constant, and — the part that matters — not something `variance > mean` can
  // be asked of, so a balanced map is never found overdispersed and the
  // negative binomial quietly becomes a Poisson. ShRec3D is unaffected: a
  // distance from `c^(−1/α)` is a ratio, and balancing is what makes those
  // ratios comparable between bins.
  const readBalanced = nb ? false : balance
  const source = await contactCells(job, spans, readBalanced, value, nb ? 1 : 2)
  if ('refusal' in source) {
    job.note(source.refusal)
    return []
  }
  const { cells, how } = source
  if (job.framing.normalise !== null) {
    job.note(
      `The view is drawn ${job.framing.normalise}-normalised and the model is solved on the counts ` +
        'underneath: no read can ask for that normalisation.',
    )
  }
  if (nb && balance) {
    job.note(
      'The view is drawn balanced and pastis-NB is solved on the raw counts underneath, with the ' +
        'file’s weights folded into each pair’s expected count instead (μ = bᵢ·bⱼ·d^(−α), ' +
        'bᵢ = 1/wᵢ scaled to a mean of 1, as pastis scales them). A balanced value is a count times two weights, and overdispersion is a ' +
        'statement about a count: handed one, the negative binomial would find none and become a ' +
        'Poisson. The coverage is still corrected — it is corrected in the mean rather than in ' +
        'the data (§25.6).',
    )
  }

  // Each cell to its sequence: the one holding its first bin. A pooled cell
  // that straddles two sequences is filed under the first and cut at its end,
  // which is the honest reading of a cell the block itself drew across them.
  const runs = contigRuns(job)
  const binsize = job.mc.binsize
  const group = new Int32Array(cells.n).fill(-1)
  const index = new Int32Array(cells.n)
  const beads: ModelBead[] = []
  const perRun = new Map<number, number>()
  for (let i = 0; i < cells.n; i++) {
    const binFrom = cells.binFrom[i]
    const run = runs.find((r) => r.from <= binFrom && binFrom < r.to)
    if (run === undefined) continue
    const name = job.mc.chromnames[run.cid]
    const length = job.mc.chromsizes.get(name) ?? (run.to - run.from) * binsize
    const start = (binFrom - run.from) * binsize
    const end = Math.min(length, (Math.min(run.to, cells.binTo[i]) - run.from) * binsize)
    group[i] = run.cid
    const ordinal = perRun.get(run.cid) ?? 0
    index[i] = ordinal
    perRun.set(run.cid, ordinal + 1)
    beads.push({ contig: name, start, end: Math.max(start + 1, end), x: 0, y: 0, z: 0 })
  }
  // The coverage bias, per cell, from the weights the file was balanced with.
  // `null` on a file that has none, where every bead is equally well read as
  // far as anything here can tell.
  const bias = nb ? biasForCells(job, cells) : null
  if (bias !== null) {
    // A bin the balancer **rejected** — a `NaN` weight, from low mappability or
    // no coverage — is one the balanced view of this map does not draw at all,
    // because `applyWeights` makes its every cell `NaN`. Reading raw counts
    // would put it back, and a model would gain beads that the same map
    // balanced does not have. So it is blanked here and falls out through the
    // same door a gap does, counted in the same note.
    for (let i = 0; i < cells.n; i++) {
      if (Number.isFinite(bias[i])) continue
      for (let j = 0; j < cells.n; j++) {
        cells.values[i * cells.n + j] = Number.NaN
        cells.values[j * cells.n + i] = Number.NaN
      }
    }
  }
  // Beads the walk placed, in cell order — `beads[b]` is cell `cellOf[b]`.
  const cellOf = Int32Array.from({ length: cells.n }, (_, i) => i).filter((i) => group[i] >= 0)
  if (cellOf.length < 4) {
    job.note('Fewer than four cells of the block lie on a sequence of this file; nothing to model.')
    return []
  }
  const m = cellOf.length
  // Which bead a cell became, for reading the walk's beads back by cell.
  const beadOfCell = new Int32Array(cells.n).fill(-1)
  for (let b = 0; b < cellOf.length; b++) beadOfCell[cellOf[b]] = b

  job.progress(0, 1, nb ? 'the counts' : 'contacts to distances')
  await job.breathe()
  // The cells that are on a sequence **and** have a counted pair, in one list,
  // and every matrix built once at that size.
  //
  // It used to take two subsets in turn — the counts over the placed cells,
  // the distances over those, then the constrained ones out of *both* — which
  // is six dense matrices for a job that needs two. Each is `n²`, so at ten
  // thousand beads each is four hundred megabytes, and the difference is the
  // difference between a model and a tab that dies making one.
  const pick = constrainedIn(cells.values, cells.n, cellOf)
  const dropped = m - pick.length
  if (pick.length < 4) {
    job.note('Fewer than four beads have any counted pair; nothing to model.')
    return []
  }
  const n = pick.length
  const keptGroup = Int32Array.from(pick, (i) => group[i])
  const keptIndex = Int32Array.from(pick, (i) => index[i])

  let coords: Coordinates
  let methodRows: Array<Record<string, string>>
  let fit: { rho: number; pairs: number }
  if (nb) {
    // **One matrix**: the counts, compacted onto the kept beads over the buffer
    // they were read into. The likelihood reads them above the diagonal and
    // pastis' MDS start reads its wishes below it, so neither needs a matrix of
    // its own and no distance is ever filled in.
    const counts = countsInPlace(cells.values, cells.n, pick)
    // pastis scales the biases to a mean of one, which is what lets `β` be one:
    // a distance of 1 is then where a pair of average coverage expects one
    // contact, and the model's size is fitted rather than chosen.
    const keptBias = bias === null ? null : meanOne(Float64Array.from(pick, (i) => bias[i]))
    const moments = momentsBySeparation(counts, n, keptGroup, keptIndex, keptBias)
    const dispersion = fitDispersion(moments)
    const evidence = zerosOf(counts, n)
    storeWishes(counts, n, keptBias, alpha)

    // The helpers are started now, and lent to the MDS start and then to the
    // likelihood; each evaluation of either is shared among them and this
    // thread, and awaited: the walk asks, and is answered when every band is
    // in. The same bits on any number of threads, so the thread count is said
    // in the bar and nowhere a result is written.
    const threads = openFitThreads(n, counts)
    try {
      // pastis' start: beads uniform in a cube, numpy's draws from the reader's
      // seed, then its MDS to its own loose tolerance. Between every evaluation,
      // not inside one: the cancel lands here (`job.breathe`).
      const total = MDS_SHARE + iterations
      const mds = threads.mds(counts)
      const mdsThreads = mds.threads === 1 ? '' : ` · ${mds.threads} threads`
      const mdsSteps = mdsWalk(n, randomStart(n, numpyRandom(seed)))
      let stress = Number.POSITIVE_INFINITY
      let mdsAsk = mdsSteps.next()
      while (mdsAsk.done !== true) {
        await job.breathe()
        const { point, gradient, iteration, current } = mdsAsk.value
        const value = await mds.evaluate(point, gradient)
        stress = Math.min(stress, current, value)
        job.progress(
          Math.min(MDS_SHARE - 1, iteration),
          total,
          `MDS start · step ${iteration}${mdsThreads} · stress ${stress.toPrecision(3)}`,
        )
        mdsAsk = mdsSteps.next(value)
      }
      const start: MdsFit = mdsAsk.value

      // The likelihood, on top of the model the MDS just made and at its scale:
      // the wishes and the mean are in the same units, so nothing is rescaled
      // between the two.
      let likelihood: NegBinomFit | null = null
      coords = start.coords
      if (iterations > 0) {
        const negBinom = threads.likelihood({ counts, n, bias: keptBias, dispersion, alpha })
        const nbThreads = negBinom.threads === 1 ? '' : ` · ${negBinom.threads} threads`
        const walk = likelihoodWalk(n, start.coords, { iterations })
        let best = Number.POSITIVE_INFINITY
        let ask = walk.next()
        while (ask.done !== true) {
          // Between every *evaluation*, not every iteration: a line search can
          // be several passes over the pairs.
          await job.breathe()
          const { point, gradient, iteration, current } = ask.value
          const value = await negBinom.evaluate(point, gradient)
          best = Math.min(best, current, value)
          const at = Math.min(iterations, iteration)
          job.progress(
            MDS_SHARE + at,
            total,
            `pastis-NB · step ${at} of at most ${iterations}${nbThreads} · −log L ${best.toExponential(3)}`,
          )
          ask = walk.next(value)
        }
        likelihood = ask.value
        coords = likelihood.coords
      }
      job.progress(total, total)
      fit = fitOfCounts(counts, n, coords, keptBias)
      methodRows = nbRows(evidence, alpha, dispersion, moments, keptBias !== null, seed, start, likelihood, iterations)
    } finally {
      threads.close()
    }
  } else {
    // ShRec3D wants a *weight* per pair, and a pair the map counted nothing for
    // has no weight because it has no distance. The weights are taken while the
    // counts are still counts, and the counts are then turned into the
    // distances where they already lie — compacted onto the kept beads and put
    // through the law, both over the buffer they are read from. At twelve
    // thousand beads a matrix is half a gigabyte, so a third one is the
    // difference between a model and a tab that dies making one.
    const pairs = weightsOf(cells.values, cells.n, pick, weightMode)
    if (pairs === null) return refuse(job, n)
    compactInPlace(cells.values, cells.n, pick)
    const kept = cells.values.subarray(0, n * n)
    distancesOverContacts(kept, n, alpha)
    // The whole of the work, as one scale the bar can walk: the sweeps of the
    // classical start, then the refinement.
    const sweeps = 80
    const total = sweeps + iterations + 1
    job.progress(0, total, 'classical scaling')
    await job.breathe()
    // Filled over itself: which pairs the map counted is what the `NaN`s said,
    // and the weights say it too — zero for a pair it never saw — so the copy
    // that kept them was a second matrix holding a fact already held.
    fillDistancesInPlace(kept, n, keptGroup, keptIndex)
    const scaling = classicalMdsSweeps(kept, n, sweeps)
    let sweep = scaling.next()
    while (sweep.done !== true) {
      // Between every sweep, for the same two reasons the refinement breathes
      // between steps: the bar moves, and a cancel has somewhere to land.
      await job.breathe()
      job.progress(sweep.value.sweep, total, `classical scaling · sweep ${sweep.value.sweep} of ${sweep.value.sweeps}`)
      sweep = scaling.next()
    }
    coords = sweep.value
    let stress = stressOf(kept, n, coords, pairs)
    let steps = 0
    for (; steps < iterations; steps++) {
      // Between every step, not inside: the cancel lands here (`job.breathe`).
      await job.breathe()
      const before = stress
      smacofStep(kept, n, coords, pairs, before)
      const after = stressOf(kept, n, coords, pairs)
      stress = after
      job.progress(sweeps + steps + 1, total, `refining · step ${steps + 1} of ${iterations} · stress ${after.toPrecision(3)}`)
      if (before - after < 1e-6 * before) {
        steps++
        break
      }
    }
    job.progress(total, total)
    fit = fitOf(kept, n, coords, pairs)
    methodRows = [
      { what: 'Distance law', value: `d = c^(−1/${alpha})` },
      {
        what: 'Pairs weighted by',
        value:
          weightMode === 'contacts'
            ? 'the contact count'
            : weightMode === 'sqrt'
              ? 'the square root of the contact count'
              : 'nothing: every counted pair alike',
      },
      { what: 'Refinement steps', value: `${steps.toLocaleString()}` },
      // Three significant digits rather than an exponent: `3.994e-2` beside
      // `0.881` reads as a number on a different scale, and a stress is read
      // as the fraction it is. `toPrecision` keeps the exponent only for the
      // magnitudes where a fixed point would be all zeros.
      { what: 'Weighted stress', value: stress.toPrecision(3) },
    ]
  }

  normaliseCoordinates(coords)

  const placed: ModelBead[] = []
  for (let b = 0; b < n; b++) {
    const bead = beads[beadOfCell[pick[b]]]
    placed.push({ ...bead, x: coords.x[b], y: coords.y[b], z: coords.z[b] })
  }
  const set = structureFromBeads(placed, binsize)
  const sequences = new Set(placed.map((bead) => bead.contig))
  const subject =
    spans === null
      ? sequences.size === 1
        ? [...sequences][0]
        : `${sequences.size} sequences`
      : locusName(regionText)

  if (dropped > 0) {
    job.note(
      `${dropped.toLocaleString()} of ${m.toLocaleString()} cells had no counted pair at all — ` +
        'filtered bins, gaps — and are not in the model.',
    )
  }
  const model: IntervalsOutput = {
    kind: 'intervals',
    id: 'reconstructed-model',
    label: `3D model · ${subject}`,
    payload: { kind: 'features', data: set },
    entryKind: 'structure',
    noun: { one: 'bead', many: 'beads' },
  }
  const table: TableOutput = {
    kind: 'table',
    id: 'reconstructed-fit',
    label: `Model from the map · ${subject}`,
    columns: [
      { key: 'what', label: 'Quantity', kind: 'text' },
      { key: 'value', label: 'Value', kind: 'text' },
    ],
    rows: [
      { what: 'Method', value: nb ? 'pastis-NB · negative binomial likelihood' : 'ShRec3D · MDS with SMACOF' },
      { what: 'Contacts', value: how },
      { what: 'Beads', value: `${n.toLocaleString()} of ${cells.n.toLocaleString()} cells, ${formatBp(binsize)} each` },
      { what: 'Sequences', value: `${sequences.size.toLocaleString()}` },
      { what: 'Pairs counted', value: `${fit.pairs.toLocaleString()} of ${((n * (n - 1)) / 2).toLocaleString()}` },
      ...methodRows,
      { what: 'Spearman ρ (1/d vs contacts)', value: Number.isNaN(fit.rho) ? '—' : fit.rho.toFixed(3) },
    ],
  }
  return [model, table]
}

/**
 * Each cell's coverage bias, `1/w`, from the weights the file was balanced
 * with — or `null` where it carries none.
 *
 * This is where the balancing goes under pastis-NB, and it has to go *somewhere*
 * because the counts themselves must stay raw ({@link NegBinomModel.bias}): the
 * mean of a pair becomes `b_i·b_j·d^(−α)`, which is pastis' own handling of
 * ICE biases and leaves the counts as counts. The runner scales them to a mean
 * of one, as pastis' pipeline does, once the kept beads are known.
 *
 * A pooled cell is several bins, so its bias is the **mean of its bins'**, over
 * the bins the balancer kept. A cell it kept none of gets `NaN`, which the
 * caller reads as *this bead is not in the model* — the same answer the balanced
 * road gives by turning the bin's every cell into a `NaN`.
 *
 * One column read, bounded to the bins in play, and no failure a run should die
 * of: a file with no `/bins/weight` is an unbalanced file, and an unbalanced
 * file's beads are as well read as each other as far as anything here can tell.
 */
function biasForCells(job: JobContext, cells: Cells): Float64Array | null {
  if (cells.n === 0) return null
  let lo = cells.binFrom[0]
  let hi = cells.binTo[0]
  for (let i = 1; i < cells.n; i++) {
    if (cells.binFrom[i] < lo) lo = cells.binFrom[i]
    if (cells.binTo[i] > hi) hi = cells.binTo[i]
  }
  if (!(hi > lo)) return null
  let weights: Float64Array
  try {
    const column = job.mc.binColumn(DEFAULT_WEIGHT_COLUMN, lo, hi)
    if (typeof column[0] === 'string') return null
    weights = column as Float64Array
  } catch {
    return null
  }
  const out = new Float64Array(cells.n)
  for (let i = 0; i < cells.n; i++) {
    let sum = 0
    let seen = 0
    for (let bin = cells.binFrom[i]; bin < cells.binTo[i]; bin++) {
      const w = weights[bin - lo]
      if (!Number.isFinite(w) || !(w > 0)) continue
      sum += 1 / w
      seen++
    }
    out[i] = seen > 0 ? sum / seen : Number.NaN
  }
  return out
}

/**
 * The counts over the kept beads, **with a zero and a gap still distinct**,
 * compacted over the buffer they were read into.
 *
 * {@link weightsOf}'s question asked differently: whether a cell is finite,
 * where that one asks whether it is positive. The difference is the whole of
 * what pastis-NB reads a map for. A cell holding `0` is a pair the map looked
 * at and counted nothing on — under a likelihood that is *evidence*, and the
 * pair pushes its beads apart — while a `NaN` is a pair a filtered bin or a gap
 * made unobservable, which says nothing and is skipped. ShRec3D cannot tell
 * them apart because neither is a distance; that is why it has to fill.
 *
 * In place, so the method holds one `n²` matrix and not two: the read was
 * already a private copy (`contactCells`), and nothing else wants it.
 */
function countsInPlace(values: Float32Array, n: number, keep: Int32Array): Float32Array {
  compactInPlace(values, n, keep)
  const m = keep.length
  const out = values.subarray(0, m * m)
  for (let a = 0; a < m; a++) {
    out[a * m + a] = 0
    for (let b = a + 1; b < m; b++) {
      const p = out[a * m + b]
      const q = out[b * m + a]
      const okP = Number.isFinite(p)
      const okQ = Number.isFinite(q)
      const c = !okP && !okQ ? Number.NaN : okP && okQ ? (p + q) / 2 : okP ? p : q
      // A balanced cell is a count times two positive weights and cannot be
      // negative; a rounding at the bottom of one can be, and a negative count
      // is not a thing the likelihood has a value for.
      const kept = Number.isNaN(c) ? c : c > 0 ? c : 0
      out[a * m + b] = kept
      out[b * m + a] = kept
    }
  }
  return out
}

/** The biases over their mean, as pastis' pipeline scales them (`bias /= bias.mean()`). */
function meanOne(bias: Float64Array): Float64Array {
  let sum = 0
  for (const b of bias) sum += b
  const mean = sum / bias.length
  if (mean > 0) for (let i = 0; i < bias.length; i++) bias[i] /= mean
  return bias
}

/** The pairs the map could see, and how many of them it counted nothing on. */
function zerosOf(counts: DenseMatrix, n: number): { observed: number; zeros: number } {
  let observed = 0
  let zeros = 0
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const c = counts[i * n + j]
      if (!Number.isFinite(c)) continue
      observed++
      if (c === 0) zeros++
    }
  }
  return { observed, zeros }
}

/** A number as a reader should see it in a sentence: three figures, no exponent where none is needed. */
function figure(value: number): string {
  return value >= 100 ? value.toFixed(0) : value >= 10 ? value.toFixed(1) : value.toPrecision(3)
}

/**
 * What a pastis-NB run has to say for itself, as rows of the fit table.
 *
 * Three of these are here because they are the only way a reader can tell
 * whether the method did anything a Poisson would not have. **Zeros used as
 * evidence** is the count of pairs ShRec3D would have had to invent a distance
 * for. **Overdispersion** is the one curve pastis-NB adds over pastis-PM2,
 * written out with the `r` it gives near the diagonal and far from it; where it
 * reports *none* the two methods have converged and the reader should read the
 * model as a Poisson's. **Stopped on** is whether the fit finished or ran out
 * of steps, which on a big model is the difference between a maximum and a
 * waypoint.
 */
function nbRows(
  evidence: { observed: number; zeros: number },
  alpha: number,
  dispersion: Dispersion | null,
  moments: SeparationMoments,
  balanced: boolean,
  seed: number,
  start: MdsFit,
  fit: NegBinomFit | null,
  iterations: number,
): Array<Record<string, string>> {
  const last = moments.mean.length - 1
  const rows: Array<Record<string, string>> = [
    {
      what: 'Mean of a pair',
      value: balanced ? `μ = bᵢ · bⱼ · d^(−${alpha})` : `μ = d^(−${alpha})`,
    },
    {
      what: 'Counts',
      value: balanced
        ? 'raw, with the file’s balancing weights folded into the mean as bᵢ = 1/wᵢ, scaled to a mean of 1'
        : 'raw: this file carries no balancing weights',
    },
    {
      what: 'Zeros used as evidence',
      value: `${evidence.zeros.toLocaleString()} of the ${evidence.observed.toLocaleString()} pairs the map could see`,
    },
    {
      what: 'Overdispersion (r)',
      value:
        dispersion === null
          ? 'none: these counts are Poisson, so this is pastis-PM2'
          : `r = ${figure(Math.exp(dispersion.c0))} · λ^${dispersion.c1.toFixed(3)}, λ the mean, fitted over ` +
            `${moments.mean.length.toLocaleString()} separations: ` +
            `${figure(dispersionAt(dispersion, moments.mean[0]))} near the diagonal, ` +
            `${figure(dispersionAt(dispersion, moments.mean[last]))} at ${moments.separation[last].toLocaleString()} bins ` +
            '— a smaller r is more overdispersed',
    },
    {
      what: 'MDS start',
      value:
        `pastis’ MDS from random positions, seed ${seed}: ${start.iterations.toLocaleString()} steps, ` +
        `${start.evaluations.toLocaleString()} evaluations`,
    },
  ]
  if (fit === null) return rows
  rows.push(
    {
      what: 'Likelihood steps',
      value: `${fit.iterations.toLocaleString()} of at most ${iterations.toLocaleString()}, over ${fit.evaluations.toLocaleString()} evaluations`,
    },
    { what: 'Stopped on', value: STOP_WORDS[fit.stop] },
    // Less `Σ log c!`, which no structure can change and pastis leaves out too,
    // so this is the very number its objective returns and can be negative.
    { what: '−log L (less Σ log c!, as pastis gives it)', value: fit.value.toExponential(4) },
  )
  return rows
}

/**
 * The pairs' weights over the kept beads, or `null` where the matrix will not fit.
 *
 * Read out of the counts at their *own* indices, because this is what has to
 * happen before the counts are compacted and turned into distances over
 * themselves.
 */
function weightsOf(values: Float32Array, n: number, keep: Int32Array, mode: WeightMode): Float32Array | null {
  const m = keep.length
  const out = allocate(m)
  if (out === null) return null
  for (let a = 0; a < m; a++) {
    const row = keep[a] * n
    for (let b = a + 1; b < m; b++) {
      const p = values[row + keep[b]]
      const q = values[keep[b] * n + keep[a]]
      const okP = Number.isFinite(p) && p > 0
      const okQ = Number.isFinite(q) && q > 0
      if (!okP && !okQ) continue
      const count = okP && okQ ? (p + q) / 2 : okP ? p : q
      const w = mode === 'contacts' ? count : mode === 'sqrt' ? Math.sqrt(count) : 1
      out[a * m + b] = w
      out[b * m + a] = w
    }
  }
  return out
}

/** The note a run leaves when the browser will not give it the matrices it needs. */
function refuse(job: JobContext, n: number): TaskOutput[] {
  job.note(tooBig(n, 2))
  return []
}

/**
 * The cells of `within` that have a counted pair with another of them.
 *
 * Asked of the counts rather than of the distances, which is what lets the
 * distance matrix be built once at its final size: the power law turns a
 * positive count into a distance and everything else into `NaN`, so "has a
 * counted pair" is a question about the counts and needs no matrix to answer.
 */
function constrainedIn(values: Float32Array, n: number, within: Int32Array): Int32Array {
  const out: number[] = []
  for (const i of within) {
    let any = false
    for (const j of within) {
      if (j === i) continue
      const a = values[i * n + j]
      const b = values[j * n + i]
      if ((Number.isFinite(a) && a > 0) || (Number.isFinite(b) && b > 0)) {
        any = true
        break
      }
    }
    if (any) out.push(i)
  }
  return Int32Array.from(out)
}

/**
 * How the model orders the counted pairs against the map: Spearman's ρ between
 * `1/d` in the model and the contact each pair had, over at most 200,000 pairs
 * taken at an even stride so a big block does not sort millions. ShRec3D's
 * reading, over the distances its counts became.
 */
function fitOf(
  target: DenseMatrix,
  n: number,
  coords: Coordinates,
  /** Which pairs the map counted: non-zero where it did. The filled matrix no longer says. */
  weights: DenseMatrix,
): { rho: number; pairs: number } {
  let pairs = 0
  for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) if (weights[i * n + j] > 0) pairs++
  const stride = Math.max(1, Math.ceil(pairs / 200000))
  const a: number[] = []
  const b: number[] = []
  let seen = 0
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const delta = target[i * n + j]
      if (!(weights[i * n + j] > 0)) continue
      if (seen++ % stride !== 0) continue
      a.push(inverseDistance(coords, i, j))
      // The count is the distance undone; its rank is the count's rank, so
      // `−delta` ranks as the count does and costs no `pow`.
      b.push(-delta)
    }
  }
  return { rho: spearman(a, b), pairs }
}

/**
 * The same ρ under pastis-NB, read off the counts above the diagonal.
 *
 * **Against `raw/(bᵢbⱼ)`**, which is what makes the number comparable across
 * the two methods. pastis-NB read raw counts and put the balancing weights into
 * the mean, so the quantity its model is fitted against is `raw/(bᵢbⱼ)` —
 * precisely the *balanced* value, since balancing is `raw·wᵢwⱼ` and `b = 1/w`,
 * up to the one constant the biases were scaled by, which no rank sees.
 * Ranking against the raw counts instead would score the model on coverage it
 * was right to have divided out, and would report a worse fit the more uneven
 * the file is. Given the bias, this is the same number *Model versus map*
 * computes for a loaded model on a balanced map.
 */
function fitOfCounts(
  counts: DenseMatrix,
  n: number,
  coords: Coordinates,
  bias: Float64Array | null,
): { rho: number; pairs: number } {
  let pairs = 0
  for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) if (counts[i * n + j] > 0) pairs++
  const stride = Math.max(1, Math.ceil(pairs / 200000))
  const a: number[] = []
  const b: number[] = []
  let seen = 0
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const c = counts[i * n + j]
      if (!(c > 0)) continue
      if (seen++ % stride !== 0) continue
      a.push(inverseDistance(coords, i, j))
      b.push(bias === null ? c : c / (bias[i] * bias[j]))
    }
  }
  return { rho: spearman(a, b), pairs }
}

function inverseDistance(coords: Coordinates, i: number, j: number): number {
  const d = Math.hypot(coords.x[i] - coords.x[j], coords.y[i] - coords.y[j], coords.z[i] - coords.z[j])
  return d > 0 ? 1 / d : Number.POSITIVE_INFINITY
}
