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
import { parseRegionString } from '../../metacooler/range'
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
import { RECONSTRUCT_MAX_BEADS } from '../tasks/structure'
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
  classicalMds,
  constrainedBeads,
  distancesFromContacts,
  fillDistances,
  normaliseCoordinates,
  smacofStep,
  spearman,
  stressOf,
  subMatrix,
  weightsFromContacts,
  type Coordinates,
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
  const wanted = strParam(job.params, 'region', '').split(':')[0].trim()
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
    if (anchor !== null) outputs.push(profile('structure-distance', `Distance to ${locusText}`, toLocus, '#c0392b'))
  }
  if (locusText !== '' && !outputs.some((output) => output.id.startsWith('structure-distance'))) {
    job.note(`No bead of the model lies at ${locusText}, so the distance track was not made.`)
  }
  return outputs
}

/** The model's point at a typed locus: the mean of the beads its middle lands on. */
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
 * The contacts a model is solved over: one cell per bead, in absolute bins.
 *
 * `k` bins to a cell, which is the block's own pooling when the view's block
 * is taken as it is — the resolution the reader is looking at — and 1 when the
 * square was read for this run.
 */
interface Cells {
  from: number
  k: number
  n: number
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
 * Where the contacts come from: the view's block as drawn, or a square read.
 *
 * The block is what the reader is looking at and what the task is *about* —
 * the loaded locus at its drawn resolution, pooled cells included, which is
 * the one place `binsPerCell > 1` is honoured rather than refused. It is
 * declined only where it cannot honestly answer: a rectangle whose rows are
 * not its columns has no diagonal to model, and a block balanced the other
 * way is a different matrix. Then the square over the framing is read at the
 * file's own bin size, within the cap.
 */
async function contactCells(
  job: JobContext,
  span: Span | null,
  balance: boolean,
  value: string,
): Promise<{ cells: Cells; how: string } | { refusal: string }> {
  const block = job.inputs.block
  const square =
    block !== undefined &&
    block.rowExtent[0] === block.colExtent[0] &&
    block.rowExtent[1] === block.colExtent[1] &&
    block.nrows === block.ncols &&
    job.framing.balance === balance
  if (square && block !== undefined) {
    const k = Math.max(1, block.binsPerCell)
    const wanted: Span = span ?? { from: block.rowExtent[0], to: block.rowExtent[1] }
    if (blockCovers(block, wanted) || span === null) {
      const first = Math.floor((wanted.from - block.rowExtent[0]) / k)
      const last = Math.min(block.nrows, Math.ceil((wanted.to - block.rowExtent[0]) / k))
      const n = last - first
      if (n > RECONSTRUCT_MAX_BEADS) return { refusal: tooMany(n) }
      const values = new Float32Array(n * n)
      for (let r = 0; r < n; r++) {
        const at = (first + r) * block.ncols + first
        values.set(block.values.subarray(at, at + n), r * n)
      }
      return {
        cells: { from: block.rowExtent[0] + first * k, k, n, values },
        how: k > 1 ? `the block as drawn, ${k} bins to a cell` : 'the block as drawn',
      }
    }
  }
  const wanted: Span = span ?? {
    from: Math.min(job.framing.rows[0], job.framing.cols[0]),
    to: Math.max(job.framing.rows[1], job.framing.cols[1]),
  }
  const n = wanted.to - wanted.from
  if (n <= 0) return { refusal: 'The framing holds no bins to model.' }
  if (n > RECONSTRUCT_MAX_BEADS) return { refusal: tooMany(n) }
  const read = await squareFor(job, wanted, { block: null, balance, value })
  return { cells: { from: wanted.from, k: 1, n: read.nrows, values: read.values }, how: 'read at the file’s bin size' }
}

function tooMany(n: number): string {
  return (
    `${n.toLocaleString()} beads is more than the ${RECONSTRUCT_MAX_BEADS.toLocaleString()} this ` +
    'solves in a tab. Zoom out so the block is drawn coarser, or name one sequence.'
  )
}

/** The span a typed region names, or `null` for everything; `undefined` for a name the file lacks. */
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
  const span = regionSpan(job, regionText)
  if (span === undefined) {
    job.note(
      `This file has no sequence called ${parseRegionString(regionText)[0]}, under that spelling or ` +
        `any this viewer knows of (§5.9). It has ` +
        `${job.mc.chromnames.slice(0, 6).join(', ')}${job.mc.chromnames.length > 6 ? ', …' : ''}.`,
    )
    return []
  }
  const source = await contactCells(job, span, balance, value)
  if ('refusal' in source) {
    job.note(source.refusal)
    return []
  }
  const { cells, how } = source
  if (job.framing.normalise !== null) {
    job.note(
      `The view is drawn ${job.framing.normalise}-normalised and the model is solved on the counts ` +
        'underneath: no read can ask for that normalisation (§18.4).',
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
    const binFrom = cells.from + i * cells.k
    const run = runs.find((r) => r.from <= binFrom && binFrom < r.to)
    if (run === undefined) continue
    const name = job.mc.chromnames[run.cid]
    const length = job.mc.chromsizes.get(name) ?? (run.to - run.from) * binsize
    const start = (binFrom - run.from) * binsize
    const end = Math.min(length, (Math.min(run.to, binFrom + cells.k) - run.from) * binsize)
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
  const placedValues = subMatrixOf(cells.values, cells.n, cellOf)
  const m = cellOf.length
  const placedGroup = Int32Array.from(cellOf, (i) => group[i])
  const placedIndex = Int32Array.from(cellOf, (i) => index[i])

  job.progress(0, iterations + 2, 'contacts to distances')
  await job.breathe()
  const distances = distancesFromContacts(placedValues, m, alpha)
  const keep = constrainedBeads(distances, m)
  const dropped = m - keep.length
  if (keep.length < 4) {
    job.note('Fewer than four beads have any counted pair; nothing to model.')
    return []
  }
  const kept = subMatrix(distances, m, keep)
  // The weights from the same counts the distances came from, over the same
  // beads: how often the map saw a pair is how hard the pair holds its beads.
  const weights = subMatrix(weightsFromContacts(placedValues, m, weightMode), m, keep)
  const keptGroup = Int32Array.from(keep, (i) => placedGroup[i])
  const keptIndex = Int32Array.from(keep, (i) => placedIndex[i])
  const n = keep.length
  job.progress(1, iterations + 2, 'classical scaling')
  await job.breathe()
  const coords = classicalMds(fillDistances(kept, n, keptGroup, keptIndex), n)
  let stress = stressOf(kept, n, coords, weights)
  let steps = 0
  for (; steps < iterations; steps++) {
    // Between every step, not inside: the cancel lands here (`job.breathe`).
    await job.breathe()
    const before = smacofStep(kept, n, coords, weights)
    const after = stressOf(kept, n, coords, weights)
    stress = after
    job.progress(2 + steps, iterations + 2, `refining · stress ${after.toExponential(2)}`)
    if (before - after < 1e-6 * before) {
      steps++
      break
    }
  }
  normaliseCoordinates(coords)
  job.progress(iterations + 2, iterations + 2)

  const placed: ModelBead[] = []
  for (let b = 0; b < n; b++) {
    const bead = beads[keep[b]]
    placed.push({ ...bead, x: coords.x[b], y: coords.y[b], z: coords.z[b] })
  }
  const set = structureFromBeads(placed, cells.k * binsize)
  const sequences = new Set(placed.map((bead) => bead.contig))
  const subject =
    span === null
      ? sequences.size === 1
        ? [...sequences][0]
        : `${sequences.size} sequences`
      : regionText
  const fit = fitOf(kept, n, coords)

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
      { key: 'what', label: '', kind: 'text' },
      { key: 'value', label: 'Value', kind: 'text' },
    ],
    rows: [
      { what: 'Contacts', value: how },
      { what: 'Beads', value: `${n.toLocaleString()} of ${cells.n.toLocaleString()} cells, ${formatBp(cells.k * binsize)} each` },
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
      { what: 'Weighted stress', value: stress.toExponential(3) },
      { what: 'Spearman ρ (1/d vs contacts)', value: Number.isNaN(fit.rho) ? '—' : fit.rho.toFixed(3) },
    ],
  }
  return [model, table]
}

/** The rows and columns of a square at `keep`, as a smaller square of counts. */
function subMatrixOf(values: Float32Array, n: number, keep: Int32Array): Float32Array {
  const m = keep.length
  const out = new Float32Array(m * m)
  for (let a = 0; a < m; a++) {
    const row = keep[a] * n
    for (let b = 0; b < m; b++) out[a * m + b] = values[row + keep[b]]
  }
  return out
}

/**
 * How the model orders the counted pairs against the map: Spearman's ρ between
 * `1/d` in the model and the contact each pair had, over at most 200,000 pairs
 * taken at an even stride so a big block does not sort millions.
 */
function fitOf(target: Float64Array, n: number, coords: Coordinates): { rho: number; pairs: number } {
  let pairs = 0
  for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) if (!Number.isNaN(target[i * n + j])) pairs++
  const stride = Math.max(1, Math.ceil(pairs / 200000))
  const a: number[] = []
  const b: number[] = []
  let seen = 0
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const delta = target[i * n + j]
      if (Number.isNaN(delta)) continue
      if (seen++ % stride !== 0) continue
      const d = Math.hypot(coords.x[i] - coords.x[j], coords.y[i] - coords.y[j], coords.z[i] - coords.z[j])
      a.push(d > 0 ? 1 / d : Number.POSITIVE_INFINITY)
      // The count is the distance undone; its rank is the count's rank.
      b.push(-delta)
    }
  }
  return { rho: spearman(a, b), pairs }
}
