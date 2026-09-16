/**
 * The model against the map, and the model as tracks (§25.6).
 *
 * Two tasks under *map*, both waiting until a structure row is loaded and a
 * map is open — a menu, not a promise (§18.1): they are listed greyed with
 * the sentence that would make them runnable.
 *
 * **Model versus map** is the validation picture: the model's distances at
 * the map's bins per sequence, as a matrix and as `1/d^α`; the mean distance
 * at each separation beside the map's own P(s) over the same bins; and a
 * table of Spearman correlations between `1/d` and the observed contacts,
 * per sequence and per haplotype. No new output kind.
 *
 * **Spatial tracks** turns the model into three profiles on the map's bins —
 * radial position, distance to a chosen locus, local compaction — which "a
 * synthetic track is a track" (§18.5) makes lanes, colourings of the model
 * itself, and inputs of every track task.
 */

import type { AnalysisContext, AnalysisTask, CostEstimate, ParamSpec, Params } from '../types'
import { NEEDS_MAP, READY, waitingFor } from '../types'
import { BALANCE_PARAM } from './shared'

const NEEDS_STRUCTURE = 'Load a structure — a g3d or bed3d — for this to read the model from.'

function structureReady(context: AnalysisContext): boolean {
  return context.entries.some((entry) => entry.kind === 'structure' && entry.status === 'ready')
}

function availability(context: AnalysisContext) {
  if (!context.hasMap) return waitingFor(NEEDS_MAP)
  if (!structureReady(context)) return waitingFor(NEEDS_STRUCTURE)
  return READY
}

/** The structure row, offered as the feature set it also is. */
const STRUCTURE_PARAM: ParamSpec = {
  kind: 'featureSet',
  key: 'structure',
  label: 'Structure',
  hint: 'The model to read: a structure row of the Tracks card.',
}

const VERSUS_PARAMS: readonly ParamSpec[] = [
  STRUCTURE_PARAM,
  {
    kind: 'region',
    key: 'region',
    label: 'Sequence',
    hint:
      'The sequence to draw the matrices for — one, because a distance matrix is a picture of ' +
      'one sequence. Empty takes the first the model and the map share; the table covers them all.',
  },
  {
    kind: 'number',
    key: 'alpha',
    label: 'Exponent α',
    hint:
      'Contacts fall as 1/dᵅ in the predicted map. The correlation is rank-based and does not ' +
      'depend on it; only the picture does.',
    default: 3,
    min: 0.5,
    max: 6,
  },
  BALANCE_PARAM,
]

function versusEstimate(context: AnalysisContext, params: Params): CostEstimate {
  const structure = context.entries.find((entry) => entry.id === params.structure)
  const sequences = structure?.overlap?.matched ?? context.contigs.length
  return {
    class: 'bounded',
    requests: null,
    bytes: null,
    note: `One square per sequence the model covers, up to ${sequences}, read at the map’s bin size.`,
  }
}

export const STRUCTURE_MAP_TASK: AnalysisTask = {
  id: 'structuremap',
  title: 'Model versus map',
  blurb: 'How well a 3D model’s distances agree with the contacts the map counted.',
  group: 'map',
  venue: 'analysis',
  version: 1,
  availability,
  params: VERSUS_PARAMS,
  outputs: ['matrix', 'curve', 'table'],
  estimate: versusEstimate,
}

const SPATIAL_PARAMS: readonly ParamSpec[] = [
  STRUCTURE_PARAM,
  {
    kind: 'region',
    key: 'locus',
    label: 'Distance to',
    pickable: true,
    hint:
      'A locus to measure every bead’s distance from — the spatial virtual 4C. Type it, pick it ' +
      'on the map, or leave it empty for the two other tracks alone.',
  },
  {
    kind: 'number',
    key: 'window',
    label: 'Compaction window',
    hint: 'How many beads either side a bead is compared with, for the local compaction track.',
    default: 5,
    min: 1,
    max: 100,
    integer: true,
  },
]

function spatialEstimate(): CostEstimate {
  return {
    class: 'free',
    requests: 0,
    bytes: 0,
    note: 'No matrix reads: the model alone, on the map’s bins.',
  }
}

export const SPATIAL_TRACKS_TASK: AnalysisTask = {
  id: 'spatialtracks',
  title: 'Spatial tracks',
  blurb: 'The model as tracks: radial position, distance to a locus, local compaction.',
  group: 'map',
  venue: 'analysis',
  version: 1,
  availability,
  params: SPATIAL_PARAMS,
  outputs: ['profile'],
  estimate: spatialEstimate,
}
