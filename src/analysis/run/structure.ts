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
import { DEFAULT_COUNT_COLUMN } from '../../metacooler/matrix'
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
import { regionLabel, typedLocusToRegion } from '../../genome/assembly'

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
 * The parameter holds what was typed or picked — 1-based inclusive, ungrouped,
 * `IV:1000001-1400000` — and naming a structure row and three lanes with it put
 * the one string on the Structures card that had no separators directly under a
 * framing line that did: `3D model · IV:1000001-1400000` over
 * `IV:1,000,000-1,400,000 · 1.0 kb bins`, two spellings of one window. Through
 * the round trip §26.1 defines, so the display form comes out of the same two
 * helpers every locus box uses; a bare sequence or genome name has no
 * coordinates and comes back as itself.
 */
function locusName(typed: string): string {
  return regionLabel(typedLocusToRegion(typed))
}

/**
 * The model's point at a typed locus: the centroid of every bead the locus
 * covers, which is what the tracks below call its centre.
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
    if (values === null) return { refusal: tooBig(n) }
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
  if (values === null || counts === null) return { refusal: tooBig(n) }
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
    return new Float32Array(n * n)
  } catch {
    return null
  }
}

function tooBig(n: number): string {
  const gb = (2 * 4 * n * n) / 1e9
  return (
    `${n.toLocaleString()} beads needs about ${gb.toFixed(1)} GB of matrices, and this browser ` +
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
  const source = await contactCells(job, spans, balance, value)
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

  job.progress(0, iterations + 2, 'contacts to distances')
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
  // The counts are wanted twice and never again: as the weight each pair
  // carries in the fit, and as the distance its count implies. **Two matrices
  // and not three**: the weights are taken first, and the counts are then
  // turned into the distances where they already lie — compacted onto the kept
  // beads and put through the law, both over the buffer they are read from. At
  // twelve thousand beads a matrix is half a gigabyte, so the third one is the
  // difference between a model and a tab that dies making one.
  const weights = weightsOf(cells.values, cells.n, pick, weightMode)
  if (weights === null) return refuse(job, n)
  compactInPlace(cells.values, cells.n, pick)
  const kept = cells.values.subarray(0, n * n)
  distancesOverContacts(kept, n, alpha)
  // The whole of the work, as one scale the bar can walk: the sweeps of the
  // classical start and then the refinement steps.
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
  const coords = sweep.value
  let stress = stressOf(kept, n, coords, weights)
  let steps = 0
  for (; steps < iterations; steps++) {
    // Between every step, not inside: the cancel lands here (`job.breathe`).
    await job.breathe()
    const before = stress
    smacofStep(kept, n, coords, weights, before)
    const after = stressOf(kept, n, coords, weights)
    stress = after
    job.progress(sweeps + steps + 1, total, `refining · step ${steps + 1} of ${iterations} · stress ${after.toPrecision(3)}`)
    if (before - after < 1e-6 * before) {
      steps++
      break
    }
  }
  normaliseCoordinates(coords)
  job.progress(total, total)

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
  const fit = fitOf(kept, n, coords, weights)

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
      { what: 'Contacts', value: how },
      { what: 'Beads', value: `${n.toLocaleString()} of ${cells.n.toLocaleString()} cells, ${formatBp(binsize)} each` },
      { what: 'Sequences', value: `${sequences.size.toLocaleString()}` },
      { what: 'Pairs counted', value: `${fit.pairs.toLocaleString()} of ${((n * (n - 1)) / 2).toLocaleString()}` },
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
      // `0.881` reads as a number on a different scale, and a stress is read as
      // the fraction it is. `toPrecision` keeps the exponent only for the
      // magnitudes where a fixed point would be all zeros.
      { what: 'Weighted stress', value: stress.toPrecision(3) },
      { what: 'Spearman ρ (1/d vs contacts)', value: Number.isNaN(fit.rho) ? '—' : fit.rho.toFixed(3) },
    ],
  }
  return [model, table]
}

/** The rows and columns of a square at `keep`, as a smaller square of counts. */
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
  job.note(tooBig(n))
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
 * taken at an even stride so a big block does not sort millions.
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
      const d = Math.hypot(coords.x[i] - coords.x[j], coords.y[i] - coords.y[j], coords.z[i] - coords.z[j])
      a.push(d > 0 ? 1 / d : Number.POSITIVE_INFINITY)
      // The count is the distance undone; its rank is the count's rank.
      b.push(-delta)
    }
  }
  return { rho: spearman(a, b), pairs }
}
