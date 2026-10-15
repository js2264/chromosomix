/**
 * Pairwise correlation between loaded tracks, as a descriptor.
 *
 * The 1D counterpart of the compartment correlation, and the cheapest way to
 * answer *do these two experiments agree*. Two units are offered and they are
 * different questions: fixed windows asks whether the tracks agree
 * **everywhere**, which is dominated by the empty majority of a genome; a
 * feature set asks whether they agree **where something is happening**, which is
 * usually what was meant. Neither is a default worth hiding, so both are offered and the choice
 * is the first control.
 *
 * Spearman is offered beside Pearson for the reason it usually is: coverage is
 * heavy-tailed, and one very deep locus can carry a Pearson correlation on its
 * own.
 */

import type { AnalysisContext, AnalysisTask, CostEstimate, ParamSpec, Params } from '../types'
import { READY, waitingFor } from '../types'

const PARAMS: readonly ParamSpec[] = [
  { kind: 'track', key: 'tracks', label: 'tracks', multiple: true },
  {
    kind: 'choice',
    key: 'over',
    label: 'compare over',
    default: 'bins',
    options: [
      {
        value: 'bins',
        label: 'fixed windows',
        hint: 'Everywhere, including the empty majority.',
      },
      { value: 'features', label: 'a feature set', hint: 'Only where something is happening.' },
    ],
  },
  {
    kind: 'number',
    key: 'binsize',
    label: 'window',
    /**
     * 100 base pairs, and **not a count of bins** — not in the label, not in the
     * unit, and not in a caption underneath.
     *
     * This task has no contact map behind it. It correlates loaded bigWigs and a
     * 1D browser session can run it with no matrix open at all, so a matrix's
     * bins are not a unit it has: the control was called *bin size* and carried
     * the form's old "`n` bins at `x` bp" caption, which measured against a
     * resolution that has nothing to do with what this reads and said `1 bin at
     * 10.0 kb` beside a box already reading 10,000. A 1D quantity stays the
     * quantity it is (§18.2), so this is a **window in base pairs** and the box
     * says `bp` beside it.
     *
     * 100 bp because a correlation between two coverage tracks is a question
     * about where the signal is, and 10 kb windows smear a promoter-width peak
     * into its neighbourhood before the arithmetic starts. It is the resolution
     * a bigWig usually has something to say at.
     */
    default: 100,
    min: 1,
    integer: true,
    unit: 'bp',
    when: (params) => params.over !== 'features',
  },
  {
    kind: 'featureSet',
    key: 'features',
    label: 'features',
    when: (params) => params.over === 'features',
  },
  {
    kind: 'choice',
    key: 'method',
    label: 'method',
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
  // **Every track read whole, at its own resolution**, because a window's value
  // is the mean over the bases it covers and a zoom level's records are means
  // over spans of their own (`run/trackcorr.ts`). What that costs depends on the
  // files rather than on the windows, so it is said rather than counted.
  return {
    class: 'scan',
    requests: null,
    bytes: null,
    note:
      `No matrix reads: ${tracks} tracks, each read at its own resolution a megabase at a time, ` +
      (params.over === 'features' ? 'over every feature' : 'for the exact mean of every window'),
  }
}

export const TRACK_CORRELATION_TASK: AnalysisTask = {
  id: 'trackcorr',
  title: 'Track correlation',
  blurb: 'How much every pair of loaded tracks agrees.',
  keywords: ['Pearson', 'Spearman', 'compare tracks'],
  group: '1d',
  venue: 'annotations',
  // 2: a window's value is the exact mean over the bases it covers, where it was
  // a zoom level's records weighted by their whole width; and a window any track
  // lacks is left out of every pair, where it was left out of that pair alone.
  version: 2,
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
