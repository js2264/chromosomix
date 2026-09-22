/**
 * Cis and trans per sequence, as a descriptor.
 *
 * The per-sequence reading of the number every Hi-C paper quotes in its first
 * table, and the one summary in §18.8's map group that `coverage` gets close to
 * without arriving at: a cis fraction *per bin* says which stretches of the
 * assembly behave oddly, and a cis fraction *per sequence* says whether the
 * library worked and whether the karyotype is what the assembly claims.
 *
 * ## Why the matrix belongs to this task and not to the MAG network
 *
 * `magnetwork` is the same accumulation over genomes, and it is offered only on
 * a `.metacool` because that is the only file with genomes in it. The
 * computation was never about genomes, though — it is *contacts, sorted by the
 * group at each end* — and over sequences it answers questions a metagenome
 * never asks: which chromosome pairs touch each other more than indifference
 * would predict. On a human map the answer is a translocation. On a yeast map it
 * is the centromere cluster and the Rabl configuration, drawn as a picture rather
 * than inferred from one.
 *
 * **What this is not** is a translocation caller, and the distinction is §18.9's.
 * A ranked table of contact against a stated null is a *summary of the file*,
 * like the inter-MAG network it borrows its shape from. A call would need a
 * statistic with false-discovery control and a golden built from
 * `hic_breakfinder` or `EagleC`'s own output, which is the bar a second caller
 * has to clear and which nothing here attempts.
 *
 * ## Why the per-sequence fractions get a picture of their own
 *
 * For a while the square was the only picture here and the per-sequence reading
 * — the number in the paper's first table, the reason anybody opens this task —
 * was a column of three-decimal numbers under it. That is the wrong way round.
 * A square answers *which pairs touch*, and a reader who wants *is any sequence
 * behaving unlike the rest* had to read a list of `0.99`s looking for the one
 * that was not, which on a four-thousand-contig metagenome is not a thing a
 * person does. One bar per sequence is that comparison drawn instead of
 * performed, and it is offered as **fractions** because a bar of raw contacts is
 * a picture of how long each sequence is and says nothing else (`run/cistrans.ts`
 * argues both at length).
 */

import type { AnalysisContext, AnalysisTask, CostEstimate, ParamSpec, Params } from '../types'
import { NEEDS_MAP, READY, waitingFor } from '../types'
import { BALANCE_PARAM } from './shared'

/**
 * The largest square worth drawing as a picture.
 *
 * Past this the axis is a grey band and the ranked table is the output. The
 * marginals and the edge list are unaffected, so a four-thousand-contig
 * metagenome still answers every question here except *show me the square*,
 * which at four thousand a side was never going to be legible.
 */
export const MATRIX_SEQUENCE_LIMIT = 512

const PARAMS: readonly ParamSpec[] = [
  {
    kind: 'sequences',
    key: 'sequences',
    label: 'sequences',
  },
  {
    kind: 'choice',
    key: 'bars',
    label: 'bars per sequence',
    hint: 'Fractions of each sequence’s own contact, so a deep sequence and a shallow one compare.',
    // The cis fraction, because it is the number the first table of every Hi-C
    // paper quotes and the one a reader opens this task to see. The stacked
    // pair is the same fact with a legend and a second colour around it — the
    // two fractions sum to one, so the bar it adds is full on every sequence —
    // so it is offered rather than opened on.
    default: 'cis',
    options: [
      { value: 'cis', label: 'cis' },
      { value: 'trans', label: 'trans' },
      {
        value: 'both',
        label: 'both, stacked',
        hint: 'The two sum to one, so every bar is full and the split is the cis fraction.',
      },
    ],
  },
  {
    kind: 'choice',
    key: 'normalise',
    label: 'off-diagonal value',
    default: 'enrichment',
    options: [
      {
        value: 'enrichment',
        label: 'against indifference',
        hint:
          'Contacts over what the two sequences’ own trans coverage predicts. 1 is what any two ' +
          'sequences of that depth would give; a fusion is far above it.',
      },
      { value: 'raw', label: 'raw contacts' },
      { value: 'bins', label: 'per bin pair', hint: 'Divided by the two sequences’ bin counts.' },
    ],
  },
  {
    kind: 'number',
    key: 'minContacts',
    label: 'least contact worth listing',
    hint: 'Raw contacts, before any normalisation, which keeps one stray read out of the table’s top.',
    default: 10,
    min: 0,
    integer: true,
  },
  {
    kind: 'number',
    key: 'maxEdges',
    label: 'pairs to list',
    default: 500,
    min: 10,
    integer: true,
  },
  {
    kind: 'toggle',
    key: 'matrix',
    label: 'draw the square',
    hint: `Skipped above ${MATRIX_SEQUENCE_LIMIT.toLocaleString()} sequences, where it is not a picture.`,
    default: true,
  },
  BALANCE_PARAM,
]

function estimate(context: AnalysisContext, params: Params): CostEstimate {
  const framing = context.framing
  const whole =
    framing !== null &&
    framing.binsPerCell === 1 &&
    framing.balance === (params.balance === true) &&
    framing.rows[0] === 0 &&
    framing.rows[1] === context.nBins &&
    framing.cols[0] === 0 &&
    framing.cols[1] === context.nBins
  if (context.blockLoaded && whole) {
    return {
      class: 'free',
      requests: 0,
      bytes: 0,
      note: 'Computed from the whole-file block already on screen. No reads.',
    }
  }
  return {
    class: 'scan',
    requests: null,
    bytes: null,
    note:
      'One pass over the whole pixel table: like a marginal, this cannot be taken from one ' +
      'sequence’s square.',
  }
}

export const CIS_TRANS_TASK: AnalysisTask = {
  id: 'cistrans',
  title: 'Cis and trans per sequence',
  blurb: 'How much of each sequence’s contact stays on it, and which pairs touch.',
  group: '2d',
  venue: 'analysis',
  version: 1,
  availability: (context) => (context.hasMap ? READY : waitingFor(NEEDS_MAP)),
  params: PARAMS,
  outputs: ['table', 'curve', 'matrix'],
  estimate,
}
