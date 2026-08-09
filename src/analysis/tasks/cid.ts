/**
 * Chromosome interaction domains, as a descriptor — and as a *composite*.
 *
 * Not a new algorithm, and that is the point (§18.8). A CID is what insulation
 * already finds, and the reason this exists as a task of its own is the fourth
 * step rather than the first three: it pileups the boundaries it called, on the
 * very map they were called from, so the call set is **falsifiable**. A real
 * boundary set produces a visible corner in its own aggregate; a spurious one
 * produces a smear, and until something draws that picture there is no way for a
 * reader to tell which they have.
 *
 * It is offered on **both** coolers and metacools, unlike compartments. A
 * bacterial chromosome has no compartments to speak of and does have domains,
 * and on a metagenome each MAG is its own chromosome — so this is the domain
 * concept that actually applies to the app's primary format.
 *
 * The composite is genuine: it declares `requires: ['insulation']`, so the
 * runner runs that task first, reuses a cached result whose parameters and
 * framing match, and reports the chain as it goes. Contrast `analysis/tasks/apa.ts`,
 * which deliberately is *not* a composite — the difference is that insulation is
 * the whole input here, and unconditionally, while APA's expected curve is
 * needed by one of three normalisations and is narrower than the task that
 * produces it.
 */

import type { AnalysisContext, AnalysisTask, CostEstimate, ParamSpec, Params } from '../types'
import { windowLadder } from './insulation'

const PARAMS: readonly ParamSpec[] = [
  {
    kind: 'number',
    key: 'window',
    label: 'Window',
    hint: 'The insulation diamond this run calls its boundaries from.',
    default: 10_000,
    min: 1,
    unit: 'bp',
  },
  {
    kind: 'region',
    key: 'region',
    label: 'Sequence',
    hint: 'Leave empty for every sequence in the file.',
  },
  {
    kind: 'number',
    key: 'prominence',
    label: 'Minimum prominence',
    hint: 'How far the insulation track must climb either side of a minimum.',
    default: 0.2,
    min: 0,
    max: 3,
    step: 0.05,
    slider: true,
  },
  {
    kind: 'number',
    key: 'minSize',
    label: 'Smallest domain',
    hint: 'Two boundaries closer than this make one domain, not two.',
    default: 20_000,
    min: 0,
    unit: 'bp',
  },
  {
    kind: 'toggle',
    key: 'aggregate',
    label: 'Aggregate the boundaries that were called',
    hint:
      'Piles up the map at the calls, which is the check: a real set makes a corner and a ' +
      'spurious one makes a smear.',
    default: true,
  },
  {
    kind: 'number',
    key: 'apaWindow',
    label: 'Pileup half-width',
    default: 20,
    min: 5,
    max: 100,
    integer: true,
    unit: 'bins',
    when: (params) => params.aggregate !== false,
  },
  {
    kind: 'number',
    key: 'strata',
    label: 'Strength groups',
    hint: 'One pileup per group, strongest first — the top look like this, the bottom like that.',
    default: 2,
    min: 1,
    max: 4,
    integer: true,
    slider: true,
    when: (params) => params.aggregate !== false,
  },
  {
    kind: 'toggle',
    key: 'balance',
    label: 'Use balancing weights',
    default: false,
  },
]

function estimate(context: AnalysisContext, params: Params): CostEstimate {
  const widest = windowLadder({ ...params, scales: 1 }, context.binsize)[0]
  const usable = context.contigs.filter((contig) => contig.bins > widest * 2).length
  if (usable === 0) {
    return {
      class: 'free',
      requests: 0,
      bytes: 0,
      note: 'Nothing to read.',
      refusal:
        'No sequence in this file is long enough for a whole diamond of this width either side ' +
        'of any bin. Use a narrower window.',
    }
  }
  return {
    class: 'scan',
    requests: null,
    bytes: null,
    note:
      `Insulation over ${usable.toLocaleString()} sequences, then a pileup at whatever it calls. ` +
      'Both steps report progress and either can be cancelled.',
  }
}

export const CID_TASK: AnalysisTask = {
  id: 'cid',
  title: 'Domains (CIDs)',
  blurb: 'Call domains from insulation, then check the calls against the map.',
  group: 'map',
  venue: 'analysis',
  version: 1,
  requires: ['insulation'],
  appliesTo: (context) => context.nBins > 0,
  params: PARAMS,
  outputs: ['intervals', 'matrix', 'table'],
  estimate,
}
