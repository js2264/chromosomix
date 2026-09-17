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
 *
 * **Model from the map** is the third and the one that needs no structure: it
 * makes one, from the contacts the view is holding — the whole loaded block,
 * at the resolution it is drawn at, cis and trans together — by
 * `structure/reconstruct.ts`, and lands it as a row of the Structures card
 * that the cell shows and a bed3d can carry away.
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

/**
 * The most beads a model is solved over in the tab.
 *
 * Every step of the refinement is a pass over every pair, and 2,500 beads is
 * six million pairs — a few seconds per hundred steps — where 10,000 would be
 * a hundred million and a minute a step. The way out is the one the note
 * names: zoom out so the block is drawn coarser, or name a sequence.
 */
export const RECONSTRUCT_MAX_BEADS = 2500

/** The structure row, offered as the feature set it also is. */
const STRUCTURE_PARAM: ParamSpec = {
  kind: 'featureSet',
  key: 'structure',
  label: 'Structure',
  hint: 'The model to read: a row of the Structures card.',
}

const VERSUS_PARAMS: readonly ParamSpec[] = [
  STRUCTURE_PARAM,
  {
    kind: 'region',
    key: 'region',
    label: 'Sequence',
    many: true,
    hint:
      'The sequence to draw the matrices for — the first named, because a distance matrix is a ' +
      'picture of one sequence. Seeded from what the map shows; empty takes the first the model ' +
      'and the map share. The table covers them all.',
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

const RECONSTRUCT_PARAMS: readonly ParamSpec[] = [
  {
    kind: 'region',
    key: 'region',
    label: 'Sequences',
    many: true,
    hint:
      'What to model, seeded from what the map shows: a locus, one sequence, or several ' +
      'comma-separated (chrIV, chrV). Empty models everything the view has loaded — every ' +
      'sequence in the block, cis and trans together — at the resolution it is drawn at.',
  },
  {
    kind: 'number',
    key: 'binsPerBead',
    label: 'Bins per bead',
    hint:
      'How many of the file’s bins one bead stands for when the file is read for this run — a ' +
      'whole genome at 1 kb becomes a model at 5 kb with 5. Ignored when the block on screen is ' +
      'taken as drawn, which is pooled the way the map is.',
    default: 1,
    min: 1,
    max: 1000,
    integer: true,
  },
  {
    kind: 'number',
    key: 'alpha',
    label: 'Exponent α',
    hint:
      'A contact count c is read as a distance c^(−1/α): the same law Model versus map assumes, ' +
      'the other way round. 3 is the fractal-globule value most solvers start from; 1 flattens ' +
      'the near diagonal, 6 stretches it.',
    default: 3,
    min: 0.5,
    max: 6,
  },
  {
    kind: 'choice',
    key: 'weights',
    label: 'Weight pairs by',
    default: 'contacts',
    hint:
      'How much each counted pair holds its beads at the distance its count implies. By the ' +
      'count, a pair seen a thousand times is a thousand times as sure as one seen once; by its ' +
      'square root, a weak pair is still heard on a deep map; equally, every counted pair is one ' +
      'vote, which lets the far, weak pairs outvote the near diagonal.',
    options: [
      { value: 'contacts', label: 'the contact count' },
      { value: 'sqrt', label: 'its square root' },
      { value: 'equal', label: 'nothing: every counted pair alike' },
    ],
  },
  {
    kind: 'number',
    key: 'iterations',
    label: 'Refinement steps',
    hint:
      'How many SMACOF steps move the beads after the classical start. Stops earlier once a ' +
      'step improves the fit by less than a millionth.',
    default: 150,
    min: 0,
    max: 2000,
    integer: true,
  },
  BALANCE_PARAM,
]

const plural = (n: number, noun: string): string => `${n.toLocaleString()} ${noun}${n === 1 ? '' : 's'}`

function reconstructEstimate(context: AnalysisContext, params: Params): CostEstimate {
  const framing = context.framing
  const region = typeof params.region === 'string' ? params.region.trim() : ''
  const perBead = Math.max(1, Math.round(typeof params.binsPerBead === 'number' ? params.binsPerBead : 1))
  const names = region === '' ? [] : region.split(',').map((part) => part.split(':')[0].trim())
  const named = context.contigs.filter((contig) => names.includes(contig.name))
  const k = Math.max(1, framing?.binsPerCell ?? 1)
  // The block as drawn answers for what it covers; the file, read and pooled,
  // answers for the rest — the whole file when the box is empty.
  const framed =
    framing === null
      ? 0
      : Math.ceil(Math.max(framing.rows[1] - framing.rows[0], framing.cols[1] - framing.cols[0]) / k)
  const wholeFile = region === ''
  const covered =
    framing !== null &&
    !wholeFile &&
    named.every((contig) => contig.startBin >= framing.rows[0] && contig.startBin + contig.bins <= framing.rows[1])
  const blocks = wholeFile ? context.contigs.length : Math.max(1, named.length)
  const beads = wholeFile
    ? Math.ceil(context.nBins / perBead)
    : named.length === 0
      ? framed
      : covered
        ? named.reduce((sum, contig) => sum + Math.ceil(contig.bins / k), 0)
        : named.reduce((sum, contig) => sum + Math.ceil(contig.bins / perBead), 0)
  const reads = wholeFile || (named.length > 0 && !covered)
  const pairs = beads * beads
  const note =
    beads === 0
      ? 'The block the view holds, at the resolution it is drawn at.'
      : `${beads.toLocaleString()} beads, ${pairs.toLocaleString()} pairs a step; ` +
        (beads > 1200 ? 'a few seconds per hundred steps' : 'well under a second per hundred steps') +
        (reads ? `; ${plural((blocks * (blocks + 1)) / 2, 'block')} read from the file and pooled ${perBead} to a bead.` : '.')
  return {
    class: reads ? 'scan' : 'bounded',
    requests: reads ? (blocks * (blocks + 1)) / 2 : context.blockLoaded ? 0 : 1,
    bytes: null,
    note,
    ...(beads > RECONSTRUCT_MAX_BEADS
      ? {
          refusal:
            `${beads.toLocaleString()} beads is more than the ${RECONSTRUCT_MAX_BEADS.toLocaleString()} ` +
            `this solves in a tab. Pool more bins to a bead (${Math.ceil((beads * perBead) / RECONSTRUCT_MAX_BEADS).toLocaleString()} would do), or name fewer sequences.`,
        }
      : {}),
  }
}

export const RECONSTRUCT_TASK: AnalysisTask = {
  id: 'reconstruct3d',
  title: 'Model from the map',
  blurb: 'A 3D model of what is loaded: contacts read as distances, beads placed to honour them.',
  group: 'map',
  venue: 'analysis',
  version: 1,
  availability: (context) => (context.hasMap ? READY : waitingFor(NEEDS_MAP)),
  params: RECONSTRUCT_PARAMS,
  outputs: ['intervals', 'table'],
  estimate: reconstructEstimate,
}
