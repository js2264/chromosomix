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
import { fmt, resolutionLabel } from '../../units'
import { splitRegionList } from '../../metacooler/range'
import { typedLocusToRegion } from '../../genome/assembly'

/**
 * What both structure tasks say when no model is loaded.
 *
 * `<Verb> a <thing> (<formats>).` — the shape §18.1 asks every waiting row to
 * take, and the reason this one changed twice over. It used to read *a g3d or
 * bed3d — for this to read the model from*: two formats where the Structures
 * card offers three, so a Dip-C reader holding a `.3dg` was told their file
 * would not do, and a trailing clause that is not a sentence and explains what
 * the blurb above it already says. The card reads a fourth now, the PDB it
 * writes, and so this names it.
 */
const NEEDS_STRUCTURE = 'Load a structure (g3d, .3dg, bed3d or PDB).'

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

/**
 * Pairs a second one evaluation of the negative binomial visits.
 *
 * Measured against {@link PAIRS_PER_SECOND} on the same map and the same
 * machine — the validation's yeast Micro-C at 12.8 kb, 905 beads: a likelihood
 * evaluation costs about twenty SMACOF passes. pastis' likelihood is the whole
 * negative binomial, its dispersion a power of the model's own mean, so every
 * pair is a logarithm and an exponential for that power, a logarithm for the
 * spread and one more for the gamma functions, where a pass is a square root.
 * The ratio is what is stable across machines, so it is the ratio that is
 * written down and this constant is derived from it.
 */
const NB_PAIRS_PER_SECOND = PAIRS_PER_SECOND / 20

/**
 * Evaluations of the likelihood one pastis-NB step costs.
 *
 * An L-BFGS iteration is one line search, and a line search is a value and a
 * gradient at each step length it tries — almost always one: 152, 155 and 155
 * evaluations for 150 steps on the three seeds the validation runs, which is
 * what a quasi-Newton direction scaled to a unit step is supposed to give.
 */
const NB_EVALUATIONS_PER_STEP = 1.03

/**
 * The threads pastis-NB's likelihood will be shared among, this one included.
 *
 * The analysis worker's rule (`worker/analysis.worker.ts`: one helper fewer
 * than the cores, seven at most) and `likelihoodThreads.ts`'s (one thread under
 * 256 beads), written here rather than imported: the panel's half of the tree
 * does not load the likelihood to read two numbers off it.
 */
function likelihoodThreads(beads: number): number {
  if (beads < 256) return 1
  const cores = typeof navigator === 'undefined' ? 1 : navigator.hardwareConcurrency || 1
  return 1 + Math.max(0, Math.min(7, cores - 1))
}

/**
 * What the threads buy: each one past the first about six-tenths of a core.
 * Measured in Chromium on four cores, where the page draws on the same cores
 * the helpers compute on: a likelihood evaluation 2.7 times as fast on four
 * threads as on one (`likelihoodThreads.ts`).
 */
const THREAD_WORTH = 0.6

/**
 * How long a hundred refinement steps take at that rate.
 *
 * A ShRec3D step is the move and its stress, both a pass over every pair; a
 * pastis-NB step is a line search over a function that costs ten times as much
 * per pair, shared among the threads it will have, and the reader is told
 * which before pressing run rather than after. pastis' MDS start is left out:
 * it is a cheap function, stops at a part in five thousand, and costs about
 * what one likelihood step does.
 */
function refineWords(beads: number, nb: boolean): string {
  const threads = nb ? likelihoodThreads(beads) : 1
  const seconds = nb
    ? (100 * NB_EVALUATIONS_PER_STEP * beads * beads) / NB_PAIRS_PER_SECOND / (1 + THREAD_WORTH * (threads - 1))
    : (100 * 2 * beads * beads) / PAIRS_PER_SECOND
  const on = threads > 1 ? ` on ${threads} threads` : ''
  if (seconds < 1) return `well under a second per hundred steps${on}`
  if (seconds < 90) return `about ${Math.round(seconds)} seconds per hundred steps${on}`
  return `about ${Math.round(seconds / 60)} minutes per hundred steps${on}`
}

/**
 * The dense matrices a run holds, in bytes, `n²` singles each.
 *
 * **Two** under ShRec3D: the pairs' weights, and the counts turned into the
 * distances they imply over the buffer they already occupy. **One** under
 * pastis-NB: the counts, compacted over the buffer they were read into, the
 * likelihood reading them above the diagonal and the MDS start its wishes below
 * it — no distance is ever filled in, so there is nothing else to hold.
 */
function matricesFor(nb: boolean): number {
  return nb ? 1 : 2
}

function matrixWords(beads: number, nb: boolean): string {
  // `fmt.bytes` and not a GB/MB branch of its own: §26.2 has one spelling of a
  // byte count, in thousands, and a second one here would report a different
  // size for the same allocation than the status bar does.
  const count = matricesFor(nb)
  const matrices = `${fmt.bytes(count * 4 * beads * beads)} ${count === 1 ? 'matrix' : 'of matrices'}`
  // A page shares no memory with its workers, so each likelihood helper is sent
  // its rows of the triangle: the helpers' share of half a matrix, this thread
  // keeping 0.9 of a helper's (`likelihoodThreads.ts`).
  const helpers = nb ? likelihoodThreads(beads) - 1 : 0
  if (helpers === 0) return matrices
  const copies = 2 * beads * beads * (helpers / (helpers + 0.9))
  return `${matrices}, ${fmt.bytes(copies)} more copied to ${plural(helpers, 'helper')}`
}

/** The structure row, offered as the feature set it also is. */
const STRUCTURE_PARAM: ParamSpec = {
  kind: 'featureSet',
  key: 'structure',
  label: 'structure',
  hint: 'The model to read: a row of the Structures card.',
}

const VERSUS_PARAMS: readonly ParamSpec[] = [
  STRUCTURE_PARAM,
  {
    kind: 'region',
    key: 'region',
    // Plural, like *Model from the map*'s. The box takes several either way —
    // `many: true` — and two tasks one row apart in the column that named one
    // control in the singular and the other in the plural read as two different
    // controls.
    label: 'sequences',
    many: true,
    hint: 'The matrices are drawn for the first named; the table covers them all.',
  },
  {
    kind: 'number',
    key: 'alpha',
    label: 'exponent α',
    hint: 'Contacts fall as 1/dᵅ in the predicted map; only the picture depends on it.',
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
  keywords: ['3D', 'structure', 'distances'],
  group: '3d',
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
    label: 'distance to',
    pickable: true,
    hint:
      'A locus to measure every bead’s distance from — the spatial virtual 4C — and empty leaves ' +
      'the other two tracks alone.',
  },
  {
    kind: 'number',
    key: 'window',
    label: 'compaction window',
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
  keywords: ['3D', 'structure', 'radial position', 'compaction'],
  group: '3d',
  venue: 'analysis',
  version: 1,
  availability,
  params: SPATIAL_PARAMS,
  outputs: ['profile'],
  estimate: spatialEstimate,
}

const RECONSTRUCT_PARAMS: readonly ParamSpec[] = [
  {
    kind: 'choice',
    key: 'method',
    label: 'method',
    default: 'nb',
    // Not two settings of one algorithm: the fact the control cannot show is
    // that the answer changes the model rather than the speed. What each
    // position *means* is on the options, where `ParamForm` puts an option's
    // own hint, and the argument between them is §25.6's to make.
    hint: 'The two published readings of a contact count, which give different models of the same map.',
    options: [
      {
        value: 'nb',
        label: 'pastis-NB · a count is a count',
        hint: 'Fits the model the counts are likeliest under, so a pair counted zero times is evidence rather than a distance to invent.',
      },
      {
        value: 'shrec3d',
        label: 'ShRec3D · a count is a distance',
        hint: 'Faster, and what most published models were made with, but it has to invent a distance for every pair the map never counted.',
      },
    ],
  },
  {
    kind: 'region',
    key: 'region',
    label: 'sequences',
    many: true,
    // One line, and no example. It read *several comma-separated (chrIV, chrV)*
    // on a file whose sequences are `I`…`XVI`, so a reader who copied the
    // example got a refusal naming a sequence the file does not have; the box's
    // own `<datalist>` offers the real names, which is a better example than any
    // written here can be.
    hint: 'A locus or comma-separated sequences, empty for the whole file, one bead per bin.',
  },
  {
    kind: 'number',
    key: 'alpha',
    label: 'exponent α',
    // One sentence, and no formula: the exponent means one thing to each method
    // — a mean falling as d^(−α), a distance read back as c^(−1/α) — and a
    // hint that printed both would be teaching §25.6 on a number box. What a
    // reader setting it needs is which way it leans and where to start.
    hint: 'How steeply contacts fall off with distance: 3 is the fractal-globule value, 1 flattens the near diagonal, 6 stretches it.',
    default: 3,
    min: 0.5,
    max: 6,
  },
  {
    kind: 'choice',
    key: 'weights',
    label: 'weight pairs by',
    default: 'contacts',
    // pastis-NB has no weighting to set: the likelihood *is* the weighting, and
    // offering a control that does nothing under the default method would be a
    // question whose answer is never read.
    when: (params) => params.method === 'shrec3d',
    // The three cases are on the options, which is where `ParamForm` puts an
    // option's own `hint` — in its `title` — rather than in a four-line
    // paragraph beside the control. A hint says what the control wants; what
    // each answer means is a property of the answer.
    hint: 'How strongly a pair’s count holds its beads at the distance it implies.',
    options: [
      {
        value: 'contacts',
        label: 'the contact count',
        hint: 'A pair seen a thousand times is a thousand times as sure as one seen once.',
      },
      {
        value: 'sqrt',
        label: 'its square root',
        hint: 'A weak pair is still heard on a deep map.',
      },
      {
        value: 'equal',
        label: 'nothing: every counted pair alike',
        hint: 'One vote each, which lets the far, weak pairs outvote the near diagonal.',
      },
    ],
  },
  {
    kind: 'seed',
    key: 'seed',
    label: 'seed',
    // pastis' `random_state`, and the same draws: numpy's generator, so seed 0
    // here places the beads where pastis' seed 0 does before either moves them.
    hint: 'Where pastis’ MDS places the beads before the fit; another seed can settle in another optimum.',
    default: 0,
    when: (params) => params.method !== 'shrec3d',
  },
  {
    kind: 'number',
    key: 'iterations',
    label: 'refinement steps',
    hint:
      'How many steps refine the beads after the start, stopping earlier once a step stops ' +
      'buying anything.',
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
  // for a run that made 400. Read 1-based, as the box is and as the runner is
  // handed it (`runnerParams`), so the price is of the bins that will be read.
  const parts = splitRegionList(region).map(typedLocusToRegion)
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
  // Borrowed only when the block is at the file's own resolution, holds
  // everything asked for, **and is the counts this method wants**; otherwise
  // every pair of sequences is a read. pastis-NB wants raw counts, so a
  // balanced view is a view it cannot borrow (§25.6).
  const drawnAsRead =
    framing !== null && framing.binsPerCell === 1 && !(params.method !== 'shrec3d' && framing.balance)
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
  const nb = params.method !== 'shrec3d'
  const note =
    beads === 0
      ? 'The block the view holds, at the resolution it is drawn at.'
      : `${beads.toLocaleString()} beads at ${binWords(context.binsize)}, ${pairs.toLocaleString()} pairs a step; ` +
        `${refineWords(beads, nb)}, ${matrixWords(beads, nb)}` +
        (reads ? `; ${plural((blocks * (blocks + 1)) / 2, 'block')} read from the file` : '')
  return {
    class: reads ? 'scan' : 'bounded',
    requests: reads ? (blocks * (blocks + 1)) / 2 : context.blockLoaded ? 0 : 1,
    bytes: null,
    note,
  }
}

/**
 * The bead's width: the resolution the reader has selected, which is the file's
 * bin size — so it is spelled by the one formatter for a bin size (§26.2).
 *
 * It was a private copy of that rule, near enough to `resolutionLabel` to look
 * right and separate enough to drift: it rounded to one decimal of a kilobase
 * itself, which is the same answer for every rung anyone ships and a different
 * one for a `12.5 kb` ladder — a price quoting a resolution the rung picker does
 * not offer — and this line read "400 beads at 1 kb" under a form title reading
 * "1.0 kb bins". Only one of the two could be corrected while there were two
 * writers. The guard stays, because a context with no map has no bin size and
 * "the file's bin size" is the honest thing to call it.
 */
function binWords(binsize: number): string {
  return Number.isFinite(binsize) && binsize > 0 ? resolutionLabel(binsize) : 'the file’s bin size'
}

export const RECONSTRUCT_TASK: AnalysisTask = {
  id: 'reconstruct3d',
  title: 'Model from the map',
  blurb: 'A 3D model of what is loaded: contacts read as distances, beads placed to honour them.',
  keywords: ['3D', 'structure', 'reconstruction', 'ShRec3D', 'negative binomial'],
  group: '3d',
  venue: 'analysis',
  version: 1,
  availability: (context) => (context.hasMap ? READY : waitingFor(NEEDS_MAP)),
  params: RECONSTRUCT_PARAMS,
  outputs: ['intervals', 'table'],
  estimate: reconstructEstimate,
}
