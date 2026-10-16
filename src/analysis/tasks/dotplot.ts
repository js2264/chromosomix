/**
 * Two sequences against each other — a dot plot (SPECS §28), as a descriptor.
 *
 * One set of sequences along the x axis, another along the y, and a mark
 * wherever the two share sequence: a reordering, an inversion or a
 * translocation between two assemblies is the line that jumps, turns or
 * leaves. It needs no contact map and no edit — two FASTA or `.2bit` files
 * the session holds — and it is computed beside their residues, in the
 * annotations worker (`dotplot/dotplot.ts` for how). A **dev feature** (§29)
 * until it is validated.
 */

import type { AnalysisContext, AnalysisTask, CostEstimate, Params, ParamSpec } from '../types'
import { READY, waitingFor } from '../types'

/** Cells along the longer axis of the figure, unless the reader asks for others. */
export const DOTPLOT_CELLS = 400

const PARAMS: readonly ParamSpec[] = [
  {
    kind: 'sequence',
    key: 'x',
    label: 'along x',
    hint: 'The sequences laid along the x axis, in their own order.',
  },
  {
    kind: 'sequence',
    key: 'y',
    label: 'along y',
    hint: 'The sequences laid along the y axis: another assembly, or the same one for its repeats.',
  },
  {
    kind: 'choice',
    key: 'streaks',
    label: 'streaks',
    default: 'one to one',
    options: [
      {
        value: 'one to one',
        label: 'one to one',
        hint: 'Each stretch at its best place on the other axis, the others left out: the lines between two assemblies, without the grid a repeat family draws.',
      },
      {
        value: 'every one',
        label: 'every one',
        hint: 'Every streak, a repeat’s other copies too. Always so for one set against itself, which one to one would leave a diagonal.',
      },
    ],
  },
  {
    kind: 'number',
    key: 'cells',
    label: 'cells',
    hint: 'Along the longer axis of the figure; each cell is square in bases.',
    default: DOTPLOT_CELLS,
    min: 50,
    max: 4000,
    integer: true,
  },
]

function estimate(context: AnalysisContext, params: Params): CostEstimate {
  const free = { class: 'free' as const, requests: 0, bytes: 0, note: 'Nothing to read.' }
  const x = params.x
  const y = params.y
  if (typeof x !== 'string' || x === '' || typeof y !== 'string' || y === '') {
    return { ...free, refusal: 'Choose the two sequence sets: one along x, one along y.' }
  }
  void context
  return {
    class: 'free',
    requests: 0,
    bytes: 0,
    note: 'No file reads: the minimizers of both sets and their merge-join, in the worker that holds the residues — several seconds for two yeast genomes.',
  }
}

export const DOTPLOT_TASK: AnalysisTask = {
  id: 'dotplot',
  title: 'Two sequences against each other',
  blurb: 'A dot plot of two assemblies: where they share sequence, as lines that jump, turn or leave.',
  keywords: ['dot plot', 'synteny', 'alignment', 'assembly'],
  group: '1d',
  venue: 'annotations',
  version: 1,
  dev: 'dotplot',
  mapless: true,
  availability: (context) => {
    const sequences = context.entries.filter((entry) => entry.kind === 'sequence').length
    if (sequences >= 2) return READY
    return waitingFor(sequences === 1 ? 'Load a second FASTA to set against the first.' : 'Load two FASTA or .2bit files.')
  },
  params: PARAMS,
  outputs: ['matrix', 'table', 'intervals'],
  estimate,
}
