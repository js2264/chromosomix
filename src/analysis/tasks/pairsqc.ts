/**
 * A library's quality, from its records, as a *descriptor* (§18.8).
 *
 * Every other task in the 2D card reads the matrix. This one reads what the
 * matrix was binned **from**: a `.pairs` is a list of read pairs, each with the
 * two places its reads ended and the strands they were on, and the questions a
 * reader asks of a library before trusting any map of it are about those
 * records — how many were mapped, how many were duplicates, how short a
 * separation the four orientations can be believed at, and, for a library made
 * with a restriction enzyme, how many pairs are a fragment ligated to itself
 * rather than a contact. None of that survives binning, which sums the four
 * orientations together and forgets where in a bin a read ended.
 *
 * ## Where the records come from
 *
 * A map **binned from a `.pairs`** on open (§3.7) already had its records
 * counted once: the import's own pass made `pairtools stats` and the four
 * orientation curves, and both reach this task with nothing read again. Only the
 * restriction statistics need the records a second time — which fragment each
 * read ended in is a fact no counter of the import could have kept without the
 * enzyme — and that pass is over the map's own file. A map **opened** as a
 * matrix (an `.mcool`) kept no records at all, so the form asks for the `.pairs`
 * it was made from, in the drop area P(s) used to carry, and the run is refused
 * until one is named.
 *
 * ## The restriction step is a composite
 *
 * The sites of an enzyme are found in the reference, and the reference lives in
 * the annotations worker (`tasks/motif.ts` argues why). So the digest is its own
 * task, `restriction`, which this one `requires`, and the reference and the
 * enzyme this form asks for are that task's questions answered here
 * ({@link AnalysisTask.upstreamParams}). No reference, or no enzyme — a Micro-C
 * library has none — and the step is left out: the run is the pairtools half
 * alone.
 *
 * The half of the task that lives in this file is what it *is*. What it *does*
 * is `analysis/run/pairsqc.ts`.
 */

import { enzymeLabel, enzymesFor } from '../../genome/restriction'
import type {
  AnalysisContext,
  AnalysisTask,
  CostEstimate,
  ParamSpec,
  Params,
} from '../types'
import { NEEDS_MAP, READY, waitingFor } from '../types'
import { ENZYME_PARAM, SITES_PARAM } from './restriction'

// ---------------------------------------------------------------------------
// Reading the form
// ---------------------------------------------------------------------------

/** The `.pairs` named on the form, trimmed; `''` where none is. */
export function namedPairs(params: Params): string {
  const value = params.pairs
  return typeof value === 'string' ? value.trim() : ''
}

/** The reference chosen, as an entry id (or, from a shell, a path); `''` where none is. */
function referenceOf(params: Params): string {
  const value = params.reference
  return typeof value === 'string' ? value : ''
}

/** The enzyme choice, `none` where it is not a string. */
function enzymeOf(params: Params): string {
  const value = params.enzyme
  return typeof value === 'string' && value !== '' ? value : 'none'
}

function sitesOf(params: Params): string {
  const value = params.sites
  return typeof value === 'string' ? value : ''
}

/**
 * The restriction step's parameters as this form answered them, or `null` to
 * run without one — {@link PAIRS_QC_TASK.upstreamParams}, for the one step it
 * requires.
 *
 * `null` for no reference or no enzyme, which are the two ways a reader says
 * *there is no digest to measure against*: a Micro-C library, or a reference not
 * loaded. The three keys are the restriction task's own, so a digest made here
 * and one made on that task's form with the same answers are one recipe, and
 * the cache reuses either for the other (`AnalysisRunner`'s `sameRecipe`).
 */
export function restrictionParams(params: Params): Params | null {
  const reference = referenceOf(params)
  const enzyme = enzymeOf(params)
  if (reference === '' || enzyme === 'none') return null
  return { sequence: reference, enzyme, sites: sitesOf(params) }
}

// ---------------------------------------------------------------------------
// Parameters
// ---------------------------------------------------------------------------

const SECTION_PAIRS = 'From the .pairs file'
const SECTION_ENZYME = 'Restriction enzyme'

const PARAMS: readonly ParamSpec[] = [
  {
    // **P(s)'s drop area, moved** (§18.8): a drop area that is also a button,
    // and an address box under it. Asked only of a map that was opened rather
    // than binned, because a map binned from a `.pairs` is its own answer — the
    // import counted what this task draws, and the run reads that same file
    // for the restriction half.
    kind: 'file',
    key: 'pairs',
    label: '.pairs file',
    accept: ['.pairs', '.pairs.gz'],
    prompt: 'Drop a .pairs here, or click to choose one',
    placeholder: 'or its address: https://… or s3://…',
    hint: 'Read for its records alone: nothing is binned and no map changes.',
    askedOf: (context) => context.binnedFrom === undefined,
    settled: '',
    section: SECTION_PAIRS,
  },
  {
    kind: 'sequence',
    key: 'reference',
    label: 'reference',
    optional: true,
    noneLabel: 'No reference — no restriction statistics',
    hint: 'The FASTA or .2bit the reads were mapped to, where the enzyme’s sites are found.',
    section: SECTION_ENZYME,
  },
  // **The restriction task's own two questions**, with this form's heading laid
  // over them, so the choice offered here and the one offered there cannot
  // drift apart: a digest asked for on either form is one recipe.
  { ...ENZYME_PARAM, section: SECTION_ENZYME },
  { ...SITES_PARAM, section: SECTION_ENZYME },
]

// ---------------------------------------------------------------------------
// Cost
// ---------------------------------------------------------------------------

/**
 * The run's price: a pass over the records where one is needed, and nothing
 * where the import counted everything.
 *
 * A pass is needed for two reasons and only two. The restriction statistics
 * read every record against the digest, whichever file they are in; and a map
 * opened as a matrix kept no records, so everything is read from the `.pairs`
 * named. Otherwise the figures are drawn from what the import counted (§3.7),
 * and the run reads nothing at all.
 *
 * The refusals come first, in the order a reader would fix them: a typed site
 * the digest cannot read, then a matrix with no `.pairs` behind it — both said
 * here, with **Run** greyed, rather than in the drawer after a press.
 */
function estimate(context: AnalysisContext, params: Params): CostEstimate {
  const free = { class: 'free' as const, requests: 0, bytes: 0 }
  const enzyme = enzymeOf(params)
  // The digest's own sentence, from the function its runner calls.
  if (enzyme !== 'none') {
    const chosen = enzymesFor(enzyme, sitesOf(params))
    if ('refusal' in chosen) return { ...free, note: 'Nothing to read.', refusal: chosen.refusal }
  }

  const named = namedPairs(params)
  const binned = context.binnedFrom
  if (named === '' && binned === undefined) {
    return {
      ...free,
      note: 'Nothing to read.',
      refusal:
        'This map was opened as a matrix, which keeps no records. Name the .pairs it was binned ' +
        'from above.',
    }
  }

  const restriction = restrictionParams(params)
  // An enzyme with nothing to find its sites in is not a refusal — the pairtools
  // half runs on its own — and the sentence says what will be left out.
  const missing =
    enzyme !== 'none' && referenceOf(params) === ''
      ? ' No reference is chosen, so there are no restriction statistics.'
      : ''
  // The digest first, as the chain runs it: the reference cut, and then the
  // records read against it and the pixels against the cuts.
  const digest =
    restriction === null
      ? null
      : `${context.entries.find((entry) => entry.id === restriction.sequence)?.label ?? 'The reference'} ` +
        `cut with ${digestLabel(enzyme, sitesOf(params))}, then`

  if (named !== '') {
    return {
      class: 'scan',
      requests: null,
      bytes: null,
      note:
        digest === null
          ? `One pass over the whole of ${named}, for its statistics and its four orientations — a ` +
            `contact list has no index to reach into.${missing}`
          : `${digest} one pass over the whole of ${named} and one over the pixel table.`,
    }
  }
  // Binned from a `.pairs`, so `binned` is set: the import's counts, and the
  // file again only where the digest needs its records.
  const name = binned?.name ?? 'the .pairs'
  const strands =
    binned?.orientation === false
      ? ` ${name} has no strand columns, so there is no P(s) by orientation.`
      : ''
  if (digest !== null) {
    return {
      class: 'scan',
      requests: null,
      bytes: null,
      note: `${digest} one pass over ${name}'s records again and one over the pixel table.${strands}`,
    }
  }
  return {
    ...free,
    note: `Drawn from what was counted as ${name} was binned. No reads.${strands}${missing}`,
  }
}

/** The enzymes as one word, `DpnII` or `DpnII+HinfI`, or the choice itself where it is a kit. */
function digestLabel(choice: string, sites: string): string {
  const chosen = enzymesFor(choice, sites)
  if (!Array.isArray(chosen) || chosen.length === 0) return choice
  return choice === 'custom' ? enzymeLabel(chosen) : choice
}

// ---------------------------------------------------------------------------
// The task
// ---------------------------------------------------------------------------

export const PAIRS_QC_TASK: AnalysisTask = {
  id: 'pairsqc',
  title: 'Pairs QC',
  blurb: 'A library’s records: pairtools stats, P(s) by orientation, and restriction fragments.',
  keywords: [
    'pairtools',
    'stats',
    'QC',
    'orientation',
    'strand',
    'convergence',
    'restriction',
    'enzyme',
    'fragment',
    'dangling',
    'self-circle',
    'duplicates',
    'pair types',
  ],
  group: '2d',
  venue: 'analysis',
  version: 1,
  // On any map: one binned from a `.pairs` answers from its import, and one
  // opened as a matrix asks for the file in its form and is refused until it
  // gets one (`estimate`) — listed, so an `.mcool` reader finds the four
  // orientations where P(s) used to draw them.
  availability: (context) => (context.hasMap ? READY : waitingFor(NEEDS_MAP)),
  params: PARAMS,
  outputs: ['curve', 'table'],
  requires: ['restriction'],
  upstreamParams: (id, params) => (id === 'restriction' ? restrictionParams(params) : {}),
  estimate,
}
