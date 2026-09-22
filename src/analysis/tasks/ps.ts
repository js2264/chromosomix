/**
 * Contact probability against genomic separation, as a *descriptor*.
 *
 * This is the first task in the catalogue (§18.8) and the first one written, and
 * both of those are the same fact: P(s) is the one analysis that applies to
 * every contact map there is. A cooler has a diagonal, a metacool has a
 * diagonal, a file with no genomes and no tracks and no annotations loaded still
 * has a diagonal — so {@link EXPECTED_TASK.availability} is the only predicate in
 * the registry that is very nearly `true`, and the panel is never empty. It also
 * has a second job that decides how carefully the rest of this has to be
 * written: three later tasks consume the **expected** curve it produces, so a
 * mistake here is a mistake in four results and it looks plausible in all four.
 *
 * The half of the task that lives in this file is what it *is* — its parameters,
 * the files it applies to, and what it will cost before anything is read. What
 * it *does* is `analysis/run/expected.ts`, and `analysis/job.ts` explains why the
 * two are different modules: this one is imported by the panel, the form and the
 * registry on the main thread, and it must therefore never reach `MetaCooler`,
 * the analysis worker or anything under `analysis/run/`.
 */

import { extentOf, framingCovers, tickedContigs } from '../context'
import type {
  AnalysisContext,
  AnalysisTask,
  CostEstimate,
  ParamSpec,
  Params,
} from '../types'
import { NEEDS_MAP, READY, waitingFor } from '../types'
import { BALANCE_PARAM } from './shared'

// ---------------------------------------------------------------------------
// Reading the form
// ---------------------------------------------------------------------------

/**
 * The scope, normalised.
 *
 * `strParam` in `analysis/job.ts` is these same three lines, and it is
 * deliberately not reached for: that module is the runner's half of the split
 * and names `MetaCooler`, so a descriptor importing it is a descriptor that has
 * stopped being safe to load on the main thread the first time somebody adds a
 * value import to it.
 *
 * An unrecognised value falls back to `contig` rather than being trusted. A
 * stored session written by a later build can carry a scope this one has never
 * heard of, and the honest reading of that is the narrowest scope rather than a
 * whole-file scan nobody asked for.
 */
function scopeOf(params: Params): 'contig' | 'genome' | 'file' {
  const value = params.scope
  return value === 'genome' || value === 'file' ? value : 'contig'
}

function balanceOf(params: Params): boolean {
  return params.balance === true
}

// ---------------------------------------------------------------------------
// Parameters
// ---------------------------------------------------------------------------

const PARAMS: readonly ParamSpec[] = [
  {
    kind: 'choice',
    key: 'scope',
    label: 'scope',
    default: 'contig',
    /**
     * Three on a metagenome, two on a cooler, and the words differ.
     *
     * This used to offer all three on every file, on the argument that a
     * `ParamSpec` is static data shared by every open file while "does this file
     * have genomes" is a property of the file — so filtering per file would mean
     * building the descriptor per file, which §18.2's *a task is a descriptor,
     * never a screen* refuses.
     *
     * The premise was right and the conclusion was not. The descriptor stays
     * static; what it gained is a *rule* — `needsGenomes` — that the form reads.
     * A cooler is offered "Chromosome" and "Whole genome" and nothing else,
     * which is the honest list: it has no MAGs, and a reader shown "Genome"
     * beside "Whole file" on a yeast cooler reasonably reads the first as the
     * second. The case the old argument was really about — a stored session
     * naming `genome` and reopened against a cooler — is still handled by
     * {@link estimate} refusing it, and the form keeps showing it so the reader
     * can see what the stored run was.
     */
    options: [
      {
        value: 'contig',
        label: 'contig',
        coolLabel: 'chromosome',
        hint: 'One curve per sequence.',
      },
      {
        value: 'genome',
        label: 'genome',
        needsGenomes: true,
        hint: 'One curve per MAG, over its own contigs.',
      },
      {
        value: 'file',
        label: 'whole file',
        coolLabel: 'whole genome',
        hint: 'Every sequence pooled into one curve.',
      },
    ],
  },
  {
    kind: 'sequences',
    key: 'sequences',
    label: 'sequences',
    // No hint: a column of tick boxes that opens with every one ticked says
    // what any sentence here would say.
    // Meaningless under the other two scopes, where the sequences are decided by
    // the genome table or by the file itself.
    when: (params) => scopeOf(params) === 'contig',
  },
  {
    kind: 'choice',
    key: 'quantity',
    label: 'quantity',
    default: 'density',
    /**
     * Two things are called P(s) and the difference is one denominator.
     *
     * Both divide the contacts at a separation by something. The **density**
     * divides by the contacts in the whole map and then by the separation the
     * bin covers — the share of all cis contacts that fall at this distance, per
     * base pair, which is `HiContacts::distanceLaw()`'s `norm_p`. The
     * **expected** divides by the number of bin pairs that could have held a
     * contact — `cooltools expected-cis`, the probability that two loci that far
     * apart touch, and the reading a scaling exponent is compared against −1 or
     * −1.5 as.
     *
     * So `density / expected = pairs(s) / constant`, and the pair count is flat
     * while the separation is short against the sequences and falls to zero at
     * the longest one. On the yeast demo the two are within 1 % below 10 kb,
     * 13 % apart at 100 kb and a factor of fifty apart at 1.2 Mb — and on a
     * mammalian map, where the chromosomes are two orders of magnitude longer,
     * they agree over everything anybody fits. Which is why this is a choice
     * rather than a correction: at the separations most figures are read at they
     * are the same picture, and past that they answer different questions.
     */
    options: [
      {
        value: 'density',
        label: 'probability density',
        hint: "Share of all cis contacts, per base pair. HiContacts' norm_p.",
      },
      {
        value: 'expected',
        label: 'expected (cooltools)',
        hint: 'Mean contact per pair of bins that far apart. What cooltools expected-cis reports.',
      },
    ],
  },
  {
    kind: 'number',
    key: 'factor',
    label: 'log bins per step',
    hint: 'Each separation bin is this many times wider than the last.',
    default: 1.1,
    min: 1.01,
    max: 2,
    step: 0.01,
    // A bounded range whose only sensible use is sweeping it: the reader is
    // trading the smoothness of the tail against the resolution of the shoulder,
    // and that is a judgement made by watching the curve move.
    slider: true,
  },
  {
    kind: 'number',
    key: 'minSeparation',
    /**
     * In **bins**, not base pairs.
     *
     * The near-diagonal is what this drops, and the near-diagonal is a fact
     * about the *grid*: the first bin of separation is the one that holds every
     * self-ligation and every unligated fragment, whatever resolution the file
     * is at. A reader who wants "skip the first two bins" had to work out what
     * two bins were in base pairs, type that, and get it back rounded — and the
     * same typed number meant three bins at one resolution and one at the next.
     * Bins are also what the curve's own x axis is quantised to, so this is now
     * the same unit as the thing it is trimming.
     */
    label: 'minimum separation',
    hint: 'Drops the near-diagonal, where unligated fragments dominate.',
    // Under the density it also floors the *total* every point is a share of,
    // since the curve is a share of the contacts it was built from, and its
    // default of zero keeps the diagonal — which HiContacts puts in the first
    // break rather than dropping. Under the expected the floor is one offset
    // whatever this says: the diagonal is not a contact between two loci and has
    // no place on a log axis.
    default: 0,
    min: 0,
    integer: true,
    unit: 'bins',
  },
  {
    kind: 'toggle',
    key: 'derivative',
    label: 'log-log slope',
    hint: 'The shoulder and the plateau are visible there and not on the curve.',
    default: true,
  },
  {
    kind: 'toggle',
    key: 'stranded',
    label: 'four orientations',
    hint: 'Where ++, +−, −+ and −− converge is the shortest separation this library can be believed at.',
    default: false,
    // **The .pairs file, not "the records".** *Records* is the parser's word for
    // the rows of a pairs file, and a heading reading FROM THE RECORDS named
    // nothing the reader had seen on screen — the second control, which is the
    // one that says `.pairs` out loud, only appears once the toggle is on. The
    // heading now names the file, and the box under it names an address.
    section: 'From the .pairs file',
  },
  {
    kind: 'text',
    key: 'pairsUri',
    label: '.pairs URL',
    placeholder: 'https://… or s3://…',
    hint: 'Empty reads the file this map was imported from; drop a local .pairs on the app instead.',
    when: (params) => params.stranded === true,
    section: 'From the .pairs file',
  },
  BALANCE_PARAM,
]

// ---------------------------------------------------------------------------
// Cost
// ---------------------------------------------------------------------------

/**
 * The bin range a scope covers, for the *is the block enough* question.
 *
 * Whole sequences, always: P(s) is a property of a sequence, and a curve
 * computed from whichever window happened to be on screen but labelled `chrIV`
 * is a different quantity wearing the same name. The tick boxes say which
 * sequences, never how much of one.
 */
function scopeExtent(context: AnalysisContext, params: Params): [number, number] {
  const whole: [number, number] = [0, context.nBins]
  if (scopeOf(params) !== 'contig') return whole
  const chosen = tickedContigs(context, params, 'sequences')
  return chosen.length === 0 ? whole : extentOf(chosen)
}

/**
 * Range requests for one contig's dense square.
 *
 * `MetaCooler.matrix` is "four slices and no scan" — the `bin1_offset` window,
 * `bin1_id`, `bin2_id` and the value column — plus one more for the weight
 * slice when balancing is on. On a local file these are `slice()` calls and cost
 * nothing, which is what `requests` being a count rather than a duration is for.
 */
function boundedRequests(balance: boolean): number {
  return balance ? 5 : 4
}

/**
 * Ticked sequences read as their own squares, before a scan is the cheaper story.
 *
 * Four is where the two shapes cross in the only way that matters to a reader:
 * a handful of bounded reads is a run they can start without a warning, and a
 * list longer than that is on its way to being every sequence in the file —
 * which the runner reads in one streaming pass whatever this says. The number
 * decides which sentence is printed, never what is read.
 */
const SQUARES_WORTH_READING = 4

function estimate(context: AnalysisContext, params: Params): CostEstimate {
  const scope = scopeOf(params)
  const balance = balanceOf(params)

  // **A named `.pairs` dominates every other cost here**, so it is priced first
  // and the matrix's own road is described inside the same note rather than
  // beside it. Reading somebody else's contact list is a pass over gigabytes of
  // text; the curve it produces is a few hundred points.
  const named =
    params.stranded === true && typeof params.pairsUri === 'string'
      ? params.pairsUri.trim()
      : ''
  if (named !== '') {
    return {
      class: 'scan',
      requests: null,
      bytes: null,
      note:
        `The matrix’s own curve as below, and then one pass over the whole of ${named} for the ` +
        'four orientations — a contact list has no index to reach into.',
    }
  }

  const genomes = context.hasGenomes ? context.genomes : null
  if (scope === 'genome' && (genomes === null || genomes.length === 0)) {
    return {
      class: 'free',
      requests: 0,
      bytes: 0,
      // Costed as free because nothing is going to be read; the refusal below is
      // what the drawer actually shows, and **Run** is disabled beside it.
      note: 'Nothing to read.',
      refusal: context.hasGenomes
        ? 'Every genome in this file is unassigned, and __unbinned__ is not a genome, ' +
          'so there is nothing for a per-genome P(s) to be per. Use the contig or whole-file ' +
          'scope.'
        : 'This file is a plain cooler: it has no /genomes table, so there is nothing for a ' +
          'per-genome P(s) to be per. Use the contig scope, which is the same curve over the ' +
          'sequences this file does have, or the whole-file scope.',
    }
  }

  // **Before the block is offered as free**, because nothing ticked is nothing to
  // read even when the block is already on screen: a "no reads" price with no
  // refusal beside it is a Run button that produces an empty figure.
  if (scope === 'contig' && tickedContigs(context, params, 'sequences').length === 0) {
    return {
      class: 'free',
      requests: 0,
      bytes: 0,
      note: 'Nothing to read.',
      refusal: 'Tick at least one sequence.',
    }
  }

  // The view's block is only an honest input when it covers the whole of what
  // was asked for, was read at the file's own resolution, and was balanced the
  // way this run wants. A pooled block is coarser than the file and a P(s) taken
  // from it would be plotted against separations it cannot resolve — the framing
  // records `binsPerCell` precisely so a task can decline to pretend otherwise.
  const framing = context.framing
  const free =
    context.blockLoaded &&
    framing !== null &&
    framing.binsPerCell === 1 &&
    framing.balance === balance &&
    framingCovers(framing, scopeExtent(context, params))
  if (free) {
    return {
      class: 'free',
      requests: 0,
      bytes: 0,
      note: 'Computed from the block already on screen. No reads.',
    }
  }

  if (scope === 'contig') {
    const chosen = tickedContigs(context, params, 'sequences')
    // **One square each, up to a handful.** A square per sequence is four
    // requests per sequence, which is the cheap shape while the reader has
    // ticked a few of them and is 154 k requests on a metagenome with every box
    // ticked — so past a handful the streaming pass below is priced instead,
    // which is the shape the runner takes there anyway.
    if (chosen.length <= SQUARES_WORTH_READING) {
      const requests = boundedRequests(balance) * chosen.length
      const names = chosen.map((contig) => contig.name).join(', ')
      const bins = chosen.reduce((sum, contig) => sum + contig.bins, 0)
      return {
        class: 'bounded',
        requests,
        bytes: null,
        note:
          `About ${requests} range requests: one dense square over ${names} ` +
          `(${bins.toLocaleString()} bins).`,
      }
    }
  }

  // Everything left is more than one square, and reading it a square at a time
  // would be one request per contig — 154 k of them on a real metagenome. One
  // streaming pass over the pixel table is the cheaper shape as well as the
  // honest one, and §18.6 says what that costs the reader in exchange: an
  // explicit action, a progress bar and a cancel.
  return {
    class: 'scan',
    requests: null,
    bytes: null,
    note:
      'One pass over the whole pixel table, accumulating every cis contact by its separation.',
  }
}

// ---------------------------------------------------------------------------
// The task
// ---------------------------------------------------------------------------

export const EXPECTED_TASK: AnalysisTask = {
  id: 'expected',
  title: 'Contact probability P(s)',
  blurb: 'How contact frequency falls with genomic separation.',
  group: '2d',
  venue: 'analysis',
  version: 2,
  // Every contact map has a diagonal, so this is the one row that is offered on
  // everything — a cooler, a metacool, a file with nothing else loaded beside
  // it. The guard is against a mount with no bins at all, which is a file the
  // panel should be empty for.
  availability: (context) => (context.hasMap ? READY : waitingFor(NEEDS_MAP)),
  params: PARAMS,
  outputs: ['curve'],
  estimate,
}
