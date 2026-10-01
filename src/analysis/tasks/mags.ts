/**
 * The four metagenome tasks, as descriptors.
 *
 * Together in one module rather than four, because they are one idea seen from
 * four distances — the file, the MAG, the contig, the pair — and because three
 * of them are priced identically: one walk over the pixel table. Splitting them
 * across four files would put four copies of the same estimate in four places.
 *
 * They are the answer to §18.3's problem: annotations are absent on a
 * `.metacool` (§8.5), so every task that consumes a track or a feature set is
 * absent there too — and without these the Analysis panel on this app's primary
 * format would offer P(s), coverage, insulation and 4C and nothing that knows
 * what a MAG is.
 */

import { READY, waitingFor } from '../types'
import type {
  AnalysisContext,
  AnalysisTask,
  CostEstimate,
  TaskAvailability,
} from '../types'
import { BALANCE_PARAM } from './shared'

/**
 * Every one of these needs a genome layer, and a metacool is the only thing with
 * one — so on a cooler they are **absent** and stay absent however many files
 * the reader drops, which is what §18.1's doctrine is actually about.
 *
 * With *nothing* open the answer is different: a metagenome is one file away, so
 * the row is listed and says so. The distinction is not "can it run now" but
 * "can what the reader does next make it run".
 */
function metagenomeOnly(context: AnalysisContext): TaskAvailability {
  if (!context.hasMap) return waitingFor('Open a metagenome (.metacool with a genome layer).')
  return context.hasGenomes && (context.genomes?.length ?? 0) > 1 ? READY : { state: 'absent' }
}

function scanCost(note: string): CostEstimate {
  return {
    class: 'scan',
    requests: null,
    bytes: null,
    note,
  }
}


export const MAG_QC_TASK: AnalysisTask = {
  id: 'magqc',
  dev: 'metacool',
  title: 'MAG contact QC',
  blurb: 'Per genome: how much contact it has, and how much of it stays inside.',
  group: 'metagenome',
  venue: 'analysis',
  version: 1,
  availability: metagenomeOnly,
  params: [
    BALANCE_PARAM,
    {
      kind: 'toggle',
      key: 'network',
      label: 'inter-MAG matrix',
      hint: 'Costs nGenomes² doubles held while it runs; needed by the network task.',
      default: true,
    },
  ],
  outputs: ['table', 'matrix'],
  estimate: (context) =>
    scanCost(
      `Walks the whole pixel table once, sorting every contact by the genomes of its two ends ` +
        `across ${(context.genomes?.length ?? 0).toLocaleString()} MAGs.`,
    ),
}

export const MAG_NETWORK_TASK: AnalysisTask = {
  id: 'magnetwork',
  dev: 'metacool',
  title: 'Inter-MAG network',
  blurb: 'Which MAGs touch which, as a ranked edge list.',
  group: 'metagenome',
  venue: 'analysis',
  version: 1,
  // A genuine composite: the edge list *is* the QC pass's genome-by-genome
  // matrix, ranked and normalised. Declaring the dependency means the runner
  // reuses a cached QC result whose parameters and framing match rather than
  // walking the pixel table a second time for numbers it already has.
  requires: ['magqc'],
  availability: metagenomeOnly,
  params: [
    {
      kind: 'choice',
      key: 'normalise',
      label: 'edge weight',
      default: 'coverage',
      options: [
        { value: 'raw', label: 'raw contacts' },
        { value: 'bins', label: 'per bin pair', hint: 'Divided by the two MAGs’ bin counts.' },
        {
          value: 'coverage',
          label: 'per coverage',
          hint:
            'Divided by the geometric mean of the two MAGs’ intra-MAG contacts, so a deep pair ' +
            'and a shallow one rank on one scale.',
        },
      ],
    },
    {
      kind: 'number',
      key: 'minWeight',
      label: 'least edge worth listing',
      default: 0,
      min: 0,
    },
    {
      kind: 'number',
      key: 'maxEdges',
      label: 'edges to list',
      default: 500,
      min: 10,
      integer: true,
    },
  ],
  outputs: ['table', 'matrix'],
  estimate: () => ({
    class: 'free',
    requests: 0,
    bytes: 0,
    note: 'Built from the MAG QC pass, which runs first and is reused if it has already run.',
  }),
}

export const MAG_PURITY_TASK: AnalysisTask = {
  id: 'magpurity',
  dev: 'metacool',
  title: 'MAG purity and contamination',
  blurb: 'Per contig: how much of its contact leaves its MAG, and where it goes.',
  group: 'metagenome',
  venue: 'analysis',
  version: 1,
  availability: metagenomeOnly,
  params: [
    BALANCE_PARAM,
    {
      kind: 'number',
      key: 'minContacts',
      label: 'least contact before judging a contig',
      hint: 'A contig with almost no contact has no evidence either way.',
      default: 10,
      min: 0,
    },
    {
      kind: 'number',
      key: 'flagAbove',
      label: 'flag above this outside fraction',
      hint: 'A contig sending more than this share of its contact elsewhere is called out.',
      default: 0.5,
      min: 0,
      max: 1,
      step: 0.05,
      slider: true,
    },
  ],
  outputs: ['table', 'intervals', 'profile'],
  estimate: (context) =>
    scanCost(
      `Walks the whole pixel table once, sorting every contact by the contigs of its two ends ` +
        `across ${context.contigs.length.toLocaleString()} sequences.`,
    ),
}

export const MAG_SPLIT_TASK: AnalysisTask = {
  id: 'magsplit',
  dev: 'metacool',
  title: 'Split-MAG detection',
  blurb: 'MAGs whose own contigs fall into two blocks that barely touch.',
  group: 'metagenome',
  venue: 'analysis',
  version: 1,
  availability: metagenomeOnly,
  params: [
    BALANCE_PARAM,
    {
      kind: 'number',
      key: 'minContigs',
      label: 'least contigs before judging a MAG',
      hint: 'A two-contig MAG splits into two trivially and says nothing.',
      default: 4,
      min: 2,
      integer: true,
    },
    {
      kind: 'number',
      key: 'flagBelow',
      label: 'flag below this cross-block ratio',
      hint: 'How much of a MAG’s contact crosses the split, against what stays inside a block.',
      default: 0.1,
      min: 0,
      max: 1,
      step: 0.01,
      slider: true,
    },
  ],
  outputs: ['table', 'intervals'],
  estimate: (context) => {
    const genomes = context.genomes?.length ?? 0
    return {
      class: 'scan',
      requests: genomes * 4,
      bytes: null,
      note:
        `One contig-level square per MAG, ${genomes.toLocaleString()} of them, each a bounded ` +
        'read.',
    }
  },
}
