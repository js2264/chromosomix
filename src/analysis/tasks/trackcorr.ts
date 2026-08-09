/**
 * Pairwise correlation between loaded tracks, as a descriptor.
 *
 * The 1D counterpart of the compartment correlation, and the cheapest way to
 * answer *do these two experiments agree*. Two units are offered and they are
 * different questions: fixed bins asks whether the tracks agree **everywhere**,
 * which is dominated by the empty majority of a genome; a feature set asks
 * whether they agree **where something is happening**, which is usually what was
 * meant. Neither is a default worth hiding, so both are offered and the choice
 * is the first control.
 *
 * Spearman is offered beside Pearson for the reason it usually is: coverage is
 * heavy-tailed, and one very deep locus can carry a Pearson correlation on its
 * own.
 */

import type { AnalysisContext, AnalysisTask, CostEstimate, ParamSpec, Params } from '../types'
import { READY, waitingFor } from '../types'

const PARAMS: readonly ParamSpec[] = [
  { kind: 'track', key: 'tracks', label: 'Tracks', multiple: true },
  {
    kind: 'choice',
    key: 'over',
    label: 'Compare over',
    default: 'bins',
    options: [
      { value: 'bins', label: 'Fixed bins', hint: 'Everywhere, including the empty majority.' },
      { value: 'features', label: 'A feature set', hint: 'Only where something is happening.' },
    ],
  },
  {
    kind: 'number',
    key: 'binsize',
    label: 'Bin size',
    default: 10_000,
    min: 1,
    unit: 'bp',
    when: (params) => params.over !== 'features',
  },
  {
    kind: 'featureSet',
    key: 'features',
    label: 'Features',
    when: (params) => params.over === 'features',
  },
  {
    kind: 'choice',
    key: 'method',
    label: 'Method',
    default: 'spearman',
    options: [
      { value: 'spearman', label: 'Spearman', hint: 'Rank-based; robust to one very deep locus.' },
      { value: 'pearson', label: 'Pearson' },
    ],
  },
]

function estimate(_context: AnalysisContext, params: Params): CostEstimate {
  const tracks = Array.isArray(params.tracks) ? params.tracks.length : 0
  if (tracks < 2) {
    return {
      class: 'free',
      requests: 0,
      bytes: 0,
      note: 'Nothing to read.',
      refusal: 'Choose at least two tracks to correlate.',
    }
  }
  return {
    class: 'bounded',
    requests: null,
    bytes: null,
    note: `No matrix reads: ${tracks} tracks sampled in the annotations worker, one batch each.`,
  }
}

export const TRACK_CORRELATION_TASK: AnalysisTask = {
  id: 'trackcorr',
  title: 'Track correlation',
  blurb: 'How much every pair of loaded tracks agrees.',
  group: 'tracks',
  venue: 'annotations',
  version: 1,
  // No map required, for the reason `overlap.ts` gives.
  availability: (context) => {
    const tracks = context.entries.filter((entry) => entry.kind === 'track').length
    if (tracks >= 2) return READY
    return waitingFor(
      tracks === 0
        ? 'Load two or more bigWigs to correlate.'
        : 'Load a second bigWig; a correlation needs two.',
    )
  },
  params: PARAMS,
  outputs: ['matrix', 'table'],
  estimate,
}
