/**
 * Per-cell contact QC and cell-cycle phasing, as a descriptor.
 *
 * The one task in the catalogue whose unit is a **cell** rather than a bin, a
 * sequence or a feature, and it exists because the `.scool` interaction is built
 * around a decision nothing in the app was helping anybody make. A container
 * opens as its Cells table, the reader ticks some, and the ticked ones are
 * summed (§3.8). What the table can rank them by is `nnz` and `sum` — *what the
 * writer recorded*, which is a statement about the sequencing and not about the
 * contacts. Depth is also the least interesting axis a single-cell Hi-C library
 * varies along: cells differ mostly by **where in the cell cycle they were
 * fixed**, and a pseudo-bulk summed across phases smears exactly the structure
 * somebody opened the file to see.
 *
 * ## The measurement, and whose it is
 *
 * Nagano et al. (2017)'s, and it is two numbers per cell: the share of its
 * contacts at a *near* separation and the share at a *mitotic* one. Plotted
 * against each other the cells fall on a horseshoe, and position along it is
 * position in the cycle — post-M cells carry an enormous mitotic band and almost
 * no near signal, G1 the reverse, and S and G2 in between. Nothing about it is
 * an inference this app makes; it is a histogram of separations, per cell, with
 * the edges the paper used.
 *
 * ## Why the edges are parameters and not constants
 *
 * 23 kb, 2 Mb and 12 Mb are the paper's, and the paper is about mouse. A yeast
 * chromosome is 1.5 Mb at its longest, so the mitotic band on a yeast `.scool` is
 * empty by construction and the phasing plot is a column of points on the axis —
 * which is a true picture of a measurement that does not apply rather than a
 * result. So the edges are typed in base pairs, the defaults are the paper's,
 * and the run says when the assembly cannot reach the band it was asked about.
 *
 * ## What it does not do
 *
 * It does not **cluster** the cells and it does not assign a phase label. The
 * bands are a measurement with a citation; a cut through the horseshoe is a
 * method with choices, and §18.9's rule about a half-good caller inside a viewer
 * applies to a phase call exactly as it applies to a loop call. What the reader
 * gets is the scatter, the table, and the ability to tick a region of it — the
 * judgement stays theirs, which is also what they would be doing in the paper's
 * own figure.
 */

import type { AnalysisContext, AnalysisTask, CostEstimate, ParamSpec, Params } from '../types'
import { READY } from '../types'
import { BALANCE_PARAM } from './shared'

/** The paper's separation edges, in base pairs. */
export const NEAR_FROM = 23_000
export const NEAR_TO = 2_000_000
export const MITOTIC_TO = 12_000_000

const PARAMS: readonly ParamSpec[] = [
  {
    kind: 'choice',
    key: 'cells',
    label: 'cells',
    default: 'all',
    options: [
      {
        value: 'all',
        label: 'every cell in the file',
        hint: 'What the choice is made from, so this is the answer that helps make it.',
      },
      { value: 'selected', label: 'the ticked ones only' },
    ],
  },
  {
    kind: 'number',
    key: 'nearFrom',
    label: 'near band, from',
    unit: 'bp',
    hint: 'Below this a contact is mostly self-ligation and unligated ends rather than structure.',
    default: NEAR_FROM,
    min: 0,
    integer: true,
    section: 'Bands',
  },
  {
    kind: 'number',
    key: 'nearTo',
    label: 'near band, to',
    unit: 'bp',
    default: NEAR_TO,
    min: 1,
    integer: true,
    section: 'Bands',
  },
  {
    kind: 'number',
    key: 'mitoticTo',
    label: 'mitotic band, to',
    unit: 'bp',
    hint: 'The near band’s upper edge is this band’s lower one; beyond it is the far band.',
    default: MITOTIC_TO,
    min: 1,
    integer: true,
    section: 'Bands',
  },
  BALANCE_PARAM,
]

function estimate(context: AnalysisContext, params: Params): CostEstimate {
  const cells = context.cells ?? 0
  if (cells === 0) {
    return {
      class: 'free',
      requests: 0,
      bytes: 0,
      note: 'Nothing to read.',
      refusal: 'This file has no cells.',
    }
  }
  const counted = params.cells === 'selected' ? (context.activeCells ?? cells) : cells
  return {
    class: 'scan',
    requests: null,
    bytes: null,
    note:
      `One pass over each of ${counted.toLocaleString()} cells’ own pixels — the same reads a ` +
      'pseudo-bulk of them costs, with one accumulator per cell instead of one shared.',
  }
}

export const CELL_QC_TASK: AnalysisTask = {
  id: 'cellqc',
  title: 'Per-cell contact QC',
  blurb: 'What each cell’s contacts look like, and where in the cycle that puts it.',
  group: 'map',
  venue: 'analysis',
  version: 1,
  // Absent rather than waiting on every other container, which is §8.5's rule
  // applied exactly: a `.cool` has no cells and nothing the reader does here
  // gives it any.
  availability: (context) =>
    (context.cells ?? 0) > 0 ? READY : { state: 'absent' },
  params: PARAMS,
  outputs: ['table', 'curve'],
  estimate,
}
