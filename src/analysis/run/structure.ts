/**
 * The runners behind `tasks/structure.ts` (§25.6).
 *
 * The map is read one square per sequence, at the map's bin size, through
 * the same road every other map task takes (`squareFor`); the model comes
 * in as the feature set the structure row is, with its `model` of places.
 * Everything numeric is `structure/versusMap.ts`, held still by its tests.
 */

import type { FeatureSet, StructureModel } from '../../annotations/types'
import { DEFAULT_COUNT_COLUMN } from '../../metacooler/matrix'
import { logBinCurve, logLogSlope } from '../expected'
import { boolParam, chosenInput, missingInput, numParam, strParam, type JobContext, type TaskRunner } from '../job'
import type { CurveOutput, CurveSeries, MatrixOutput, ProfileOutput, TableOutput, TaskOutput } from '../types'
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
import { squareFor, usableBlock, type Span } from './blocks'
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
