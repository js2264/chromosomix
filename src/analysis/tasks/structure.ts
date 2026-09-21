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
import { resolutionLabel } from '../../units'

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
 * No ceiling on the beads, and that is a decision rather than an oversight.
 *
 * There was one, at 2,500 and then at 10,000, on the ground that both the time
 * and the memory are quadratic in the bead count. The reader's answer was that
 * the wait is theirs to spend — so what the estimate does now is *say what it
 * will cost*, in beads, in minutes and in gigabytes, and let them decide. A
 * number chosen here could only ever be a guess about somebody else's machine.
 *
 * What is still refused is the allocation that cannot succeed: the matrices are
 * asked for inside a `try`, and a browser that will not give them says so as a
 * note naming the size rather than as a tab that dies (`run/structure.ts`).
 */

/**
 * Pair visits a second, measured in this tab: a 5,709-bead genome took about a
 * hundred seconds for its classical start and 150 refinement steps, which is
 * some seventeen billion of them. Wrong by a factor of two on a slower machine
 * and the note still says *minutes* where minutes is the answer, which is the
 * decision it is there to inform.
 */
const PAIRS_PER_SECOND = 160e6

/** How long a hundred refinement steps take at that rate: the step and its stress, both a pass over every pair. */
function refineWords(beads: number): string {
  const seconds = (100 * 2 * beads * beads) / PAIRS_PER_SECOND
  if (seconds < 1) return 'well under a second per hundred steps'
  if (seconds < 90) return `about ${Math.round(seconds)} seconds per hundred steps`
  return `about ${Math.round(seconds / 60)} minutes per hundred steps`
}

/**
 * The dense matrices a run holds, in bytes.
 *
 * **Two**, each `n²` singles: the pairs' weights, and the counts turned into
 * the distances they imply over the buffer they already occupy. A third is
 * what the run used to need and is the one the in-place passes removed.
 */
function matrixWords(beads: number): string {
  const bytes = 2 * 4 * beads * beads
  return bytes >= 1e9 ? `${(bytes / 1e9).toFixed(1)} GB of matrices` : `${Math.round(bytes / 1e6)} MB of matrices`
}

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
      'comma-separated (chrIV, chrV). Empty models the whole file — every sequence, cis and ' +
      'trans together. One bin of the resolution you have selected is one bead, whatever the ' +
      'map is drawn at: pick a coarser rung for a coarser model.',
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

/**
 * What the model will cost, for the reader to confirm before pressing run.
 *
 * There is no refusal in here any more. One bin of the selected resolution is
 * one bead, so the bead count is a fact about the file and the box rather than
 * anything this can trade away, and the two things a reader wants to know
 * before committing — how long and how much memory — are what it says.
 */
function reconstructEstimate(context: AnalysisContext, params: Params): CostEstimate {
  const framing = context.framing
  const region = typeof params.region === 'string' ? params.region.trim() : ''
  // Each comma-separated part as the bins it names: a bare sequence is all of
  // it, `IV:1,000,001-1,400,000` is the bins of that stretch. Pricing a locus
  // as its whole sequence is what this used to do, and it reported 1,532 beads
  // for a run that made 400.
  const parts = region === '' ? [] : region.split(',').map((part) => part.trim()).filter((part) => part !== '')
  const named = parts.flatMap((part) => {
    const [name, range] = [part.split(':')[0].trim(), part.split(':')[1]]
    const contig = context.contigs.find((held) => held.name === name)
    if (contig === undefined) return []
    const ends = range === undefined ? null : range.split('-').map((end) => Number(end.replace(/[,_\s]/g, '')))
    if (ends === null || ends.length !== 2 || !ends.every((end) => Number.isFinite(end)) || !(context.binsize > 0)) {
      return [{ contig, bins: contig.bins }]
    }
    const from = Math.max(0, Math.min(ends[0], ends[1]))
    const to = Math.min(contig.length, Math.max(ends[0], ends[1]))
    const bins = Math.max(1, Math.ceil((to - from) / context.binsize))
    return [{ contig, bins: Math.min(contig.bins, bins) }]
  })
  const wholeFile = region === ''
  // **The file's own bins, never the drawn cell's.** What the map pooled into a
  // cell is a decision about pixels — it comes from a raster cap and the size
  // of the window — and a model built at it would be a model at a resolution
  // nobody chose (§25.6). The only case the block is borrowed is the one where
  // borrowing changes nothing, which is a block drawn one bin to the cell.
  const framed = framing === null ? 0 : Math.max(framing.rows[1] - framing.rows[0], framing.cols[1] - framing.cols[0])
  const blocks = wholeFile ? context.contigs.length : Math.max(1, named.length)
  const beads = wholeFile ? context.nBins : named.length === 0 ? framed : named.reduce((sum, at) => sum + at.bins, 0)
  // Borrowed only when the block is at the file's own resolution and holds
  // everything asked for; otherwise every pair of sequences is a read.
  const drawnAsRead = framing !== null && framing.binsPerCell === 1
  const covered =
    drawnAsRead &&
    framing !== null &&
    !wholeFile &&
    named.length > 0 &&
    named.every(
      (at) => at.contig.startBin >= framing.rows[0] && at.contig.startBin + at.contig.bins <= framing.rows[1],
    )
  const reads = !covered && !(drawnAsRead && named.length === 0 && !wholeFile)
  const pairs = beads * beads
  const note =
    beads === 0
      ? 'The block the view holds, at the resolution it is drawn at.'
      : `${beads.toLocaleString()} beads at ${binWords(context.binsize)}, ${pairs.toLocaleString()} pairs a step; ` +
        `${refineWords(beads)}, ${matrixWords(beads)}` +
        (reads ? `; ${plural((blocks * (blocks + 1)) / 2, 'block')} read from the file.` : '.')
  return {
    class: reads ? 'scan' : 'bounded',
    requests: reads ? (blocks * (blocks + 1)) / 2 : context.blockLoaded ? 0 : 1,
    bytes: null,
    note,
  }
}

/**
 * The bead's width: the resolution the reader has selected, which is the file's
 * bin size — so it is spelled by the one formatter for a bin size.
 *
 * It was a private copy of that rule, near enough to `resolutionLabel` to look
 * right and separate enough to drift: this line read "400 beads at 1 kb" under
 * a form title that read "1.0 kb bins", and only one of the two could be
 * corrected while there were two writers. The guard stays, because a context
 * with no map has no bin size and "the file's bin size" is the honest thing to
 * call it.
 */
function binWords(binsize: number): string {
  if (!Number.isFinite(binsize) || binsize <= 0) return 'the file’s bin size'
  return resolutionLabel(binsize)
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
