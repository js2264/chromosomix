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

import { contigNamed, framingCovers } from '../context'
import type {
  AnalysisContext,
  AnalysisTask,
  ContextContig,
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

function regionOf(params: Params): string {
  return typeof params.region === 'string' ? params.region.trim() : ''
}

function balanceOf(params: Params): boolean {
  return params.balance === true
}

/**
 * The contig a region string names, or `undefined`.
 *
 * Splits on the first colon exactly as `metacooler/range.ts`'s
 * `parseRegionString` does, and unlike that function it **cannot throw**: an
 * estimate is recomputed on every keystroke in the region box, a half-typed
 * locus is the normal state of that box rather than an error, and a refusal
 * flashing under the **Run** button while somebody types `chr` is noise.
 * Resolving the coordinates is the runner's job, where throwing is the right
 * answer.
 */
function regionContig(context: AnalysisContext, region: string): ContextContig | undefined {
  const name = region.split(':')[0].trim()
  return name === '' ? undefined : contigNamed(context, name)
}

// ---------------------------------------------------------------------------
// Parameters
// ---------------------------------------------------------------------------

const PARAMS: readonly ParamSpec[] = [
  {
    kind: 'choice',
    key: 'scope',
    label: 'Scope',
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
        label: 'Contig',
        coolLabel: 'Chromosome',
        hint: 'One curve per sequence.',
      },
      {
        value: 'genome',
        label: 'Genome',
        needsGenomes: true,
        hint: 'One curve per MAG, over its own contigs.',
      },
      {
        value: 'file',
        label: 'Whole file',
        coolLabel: 'Whole genome',
        hint: 'Every sequence pooled into one curve.',
      },
    ],
  },
  {
    kind: 'region',
    key: 'region',
    label: 'Sequence',
    sequences: true,
    hint: 'Leave empty for every sequence in the file.',
    // Meaningless under the other two scopes, where the sequences are decided by
    // the genome table or by the file itself.
    when: (params) => scopeOf(params) === 'contig',
  },
  {
    kind: 'choice',
    key: 'norm',
    label: 'Normalisation',
    default: 'perPair',
    /**
     * Two quantities, both called P(s), and they are not interchangeable.
     *
     * The default divides the contacts at a separation by **the number of bin
     * pairs that could have held one**. That is the *expected* value — what
     * cooltools' `expected-cis` reports, and what the three tasks downstream of
     * this one consume — and it is the only one of the two that has an obvious
     * meaning cell by cell.
     *
     * The other two divide instead by **the total number of cis contacts in the
     * map**, and then by the width of the separation bin in base pairs: the
     * share of all contacts that fall at this distance, per base pair. That is
     * what `HiContacts::distanceLaw()` returns as `norm_p` and `norm_p_unity`,
     * and choosing it also switches the separation to HiContacts' gap distance
     * and the bins to its break table, so the numbers line up point for point
     * rather than merely resembling each other.
     *
     * The two agree in shape at short range and part company as the separation
     * approaches the length of a sequence, where the pair count is heading for
     * zero and the contact total is not. Neither is wrong; a figure that mixes
     * them is.
     */
    options: [
      {
        value: 'perPair',
        label: 'Mean per bin pair',
        hint: 'The expected curve. What cooltools reports, and what O/E is taken against.',
      },
      {
        value: 'density',
        label: 'Probability density',
        hint: "Share of all cis contacts per base pair. HiContacts' norm_p.",
      },
      {
        value: 'unity',
        label: 'Density, 1 at 100 kb',
        hint: "The same curve through 1 at 100 kb, for comparing samples. HiContacts' norm_p_unity.",
      },
    ],
  },
  {
    kind: 'number',
    key: 'factor',
    label: 'Log bins per step',
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
    label: 'Minimum separation',
    hint: 'Drops the near-diagonal, where unligated fragments dominate.',
    // Under the two HiContacts normalisations it also floors the *total* every
    // point is a share of, and its default of zero keeps the diagonal — which
    // HiContacts puts in the first break rather than dropping. Under the default
    // normalisation the floor is one bin whatever this says, because offset zero
    // has no place on a log axis.

    default: 0,
    min: 0,
    integer: true,
    unit: 'bins',
  },
  {
    kind: 'toggle',
    key: 'derivative',
    label: 'Also plot the log-log slope',
    hint: 'The shoulder and the plateau are visible there and not on the curve.',
    default: true,
  },
  BALANCE_PARAM,
]

// ---------------------------------------------------------------------------
// Cost
// ---------------------------------------------------------------------------

/**
 * The bin range a scope covers, for the *is the block enough* question.
 *
 * A region that narrows a contig still resolves to the whole contig here,
 * because that is what the runner measures: P(s) is a property of a sequence,
 * and a curve computed from whichever window happened to be on screen but
 * labelled `chrIV` is a different quantity wearing the same name. The region box
 * says which sequence, not how much of it.
 */
function scopeExtent(context: AnalysisContext, params: Params): [number, number] {
  const whole: [number, number] = [0, context.nBins]
  if (scopeOf(params) !== 'contig') return whole
  const contig = regionContig(context, regionOf(params))
  return contig === undefined ? whole : [contig.startBin, contig.startBin + contig.bins]
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

function estimate(context: AnalysisContext, params: Params): CostEstimate {
  const scope = scopeOf(params)
  const balance = balanceOf(params)

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
        ? 'Every genome in this file is unassigned, and __unbinned__ is not a genome (§7.4), ' +
          'so there is nothing for a per-genome P(s) to be per. Use the contig or whole-file ' +
          'scope.'
        : 'This file is a plain cooler: it has no /genomes table, so there is nothing for a ' +
          'per-genome P(s) to be per. Use the contig scope, which is the same curve over the ' +
          'sequences this file does have, or the whole-file scope.',
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
    const contig = regionContig(context, regionOf(params))
    if (contig !== undefined) {
      const requests = boundedRequests(balance)
      return {
        class: 'bounded',
        requests,
        bytes: null,
        note:
          `About ${requests} range requests: one dense square over ${contig.name} ` +
          `(${contig.bins.toLocaleString()} bins).`,
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
      'Walks the whole pixel table once, accumulating every cis contact by its separation. ' +
      'Progress is reported as it goes and it can be cancelled at any point.',
  }
}

// ---------------------------------------------------------------------------
// The task
// ---------------------------------------------------------------------------

export const EXPECTED_TASK: AnalysisTask = {
  id: 'expected',
  title: 'Contact probability P(s)',
  blurb: 'How contact frequency falls with genomic separation.',
  group: 'map',
  venue: 'analysis',
  version: 1,
  // Every contact map has a diagonal, so this is the one row that is offered on
  // everything — a cooler, a metacool, a file with nothing else loaded beside
  // it. The guard is against a mount with no bins at all, which is a file the
  // panel should be empty for.
  availability: (context) => (context.hasMap ? READY : waitingFor(NEEDS_MAP)),
  params: PARAMS,
  outputs: ['curve'],
  estimate,
}
