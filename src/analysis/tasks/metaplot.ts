/**
 * The 1D metaplot, as a descriptor.
 *
 * The first task in the catalogue that touches no contact matrix at all: its
 * inputs are tracks and a feature set, both of which already live in the
 * annotations worker, which is why it declares `venue: 'annotations'` and costs
 * no matrix reads whatever (§18.3).
 *
 * It is also the first with a **ranking and subsetting** control, and that
 * control is the reason the task is worth having rather than a convenience. A
 * single averaged line over four thousand features asserts that they behave
 * alike; splitting them by a column and drawing one line per group is what makes
 * that assertion falsifiable, and is what turns *here is the average signal at
 * my peaks* into *the strongest quartile looks like this and the weakest looks
 * like nothing*.
 */

import type { AnalysisContext, AnalysisTask, CostEstimate, ParamSpec, Params } from '../types'
import { READY, waitingFor } from '../types'
import { isIntervalSet } from '../../annotations/types'

const PARAMS: readonly ParamSpec[] = [
  {
    kind: 'track',
    key: 'tracks',
    label: 'tracks',
    hint: 'bigWigs, and anything this panel has already computed.',
    multiple: true,
  },
  {
    kind: 'featureSet',
    key: 'features',
    label: 'features',
    hint: 'The places to average over.',
  },
  {
    kind: 'choice',
    key: 'mode',
    label: 'mode',
    default: 'reference',
    options: [
      { value: 'reference', label: 'reference point', hint: 'A fixed flank around one point.' },
      { value: 'scaled', label: 'scaled region', hint: 'Every feature body resampled to one width.' },
    ],
  },
  {
    kind: 'choice',
    key: 'at',
    label: 'anchor on',
    default: 'start',
    when: (params) => params.mode !== 'scaled',
    options: [
      { value: 'start', label: 'start' },
      { value: 'centre', label: 'centre' },
      { value: 'end', label: 'end' },
    ],
  },
  {
    kind: 'number',
    key: 'flank',
    label: 'flank',
    hint: 'Read this far either side.',
    default: 2000,
    min: 0,
    unit: 'bp',
  },
  {
    kind: 'number',
    key: 'step',
    label: 'resolution',
    hint: 'Base pairs per column of the plot.',
    default: 50,
    min: 1,
    unit: 'bp',
  },
  {
    kind: 'number',
    key: 'body',
    label: 'body columns',
    hint: 'Every feature body is resampled to this many columns.',
    default: 100,
    min: 10,
    integer: true,
    when: (params) => params.mode === 'scaled',
  },
  {
    kind: 'toggle',
    key: 'stranded',
    label: 'respect strand',
    hint: 'A minus-strand feature is read right to left, or an asymmetric signal cancels itself.',
    default: true,
  },
  {
    kind: 'column',
    key: 'rankBy',
    label: 'rank by',
    from: 'features',
    optional: true,
    noneLabel: 'Do not rank',
    hint: 'Sorts the features so they can be subset or split.',
    section: 'Ranking',
  },
  {
    kind: 'choice',
    key: 'subset',
    label: 'then',
    default: 'all',
    when: (params) => typeof params.rankBy === 'string' && params.rankBy !== '',
    options: [
      { value: 'all', label: 'one line', hint: 'Rank only; still one average.' },
      { value: 'top', label: 'top N' },
      { value: 'bottom', label: 'bottom N' },
      { value: 'groups', label: 'K groups', hint: 'One line per equal-sized group.' },
    ],
    section: 'Ranking',
  },
  {
    kind: 'number',
    key: 'count',
    label: 'N',
    default: 500,
    min: 1,
    integer: true,
    when: (params) => params.subset === 'top' || params.subset === 'bottom',
    section: 'Ranking',
  },
  {
    kind: 'number',
    key: 'groups',
    label: 'groups',
    default: 4,
    min: 2,
    max: 10,
    integer: true,
    slider: true,
    when: (params) => params.subset === 'groups',
    section: 'Ranking',
  },
  {
    // Before `average` rather than after it, because that is the order the two
    // are applied in and the order they have to be read in: the rows are
    // standardised, and *then* the summary is taken over the standardised
    // values. Off by default — it changes the numbers of every figure it is on,
    // so a stored recipe that never asked for it must come back unchanged.
    kind: 'toggle',
    key: 'zscore',
    label: 'z-score tracks first',
    hint:
      'Centre and scale each track by its own mean and SD, across every window in ' +
      'this run — so tracks in different units share one axis. Ranking groups are ' +
      'standardised together, keeping their offsets.',
    default: false,
    section: 'Summary',
  },
  {
    kind: 'choice',
    key: 'average',
    label: 'average',
    default: 'mean',
    options: [
      { value: 'mean', label: 'mean' },
      { value: 'median', label: 'median' },
      { value: 'trimmed', label: 'trimmed' },
    ],
    section: 'Summary',
  },
  {
    kind: 'choice',
    key: 'band',
    label: 'band',
    default: 'bootstrap',
    options: [
      { value: 'bootstrap', label: 'bootstrap CI' },
      { value: 'sd', label: 'SD' },
      { value: 'none', label: 'none' },
    ],
    section: 'Summary',
  },
  {
    kind: 'number',
    key: 'iterations',
    label: 'bootstrap draws',
    default: 200,
    min: 20,
    max: 2000,
    integer: true,
    when: (params) => params.band === 'bootstrap',
    section: 'Summary',
  },
  {
    kind: 'seed',
    key: 'seed',
    label: 'seed',
    hint: 'The same seed gives the same band twice.',
    default: 1,
    when: (params) => params.band === 'bootstrap',
    section: 'Summary',
  },
  {
    kind: 'toggle',
    key: 'heatmap',
    label: 'per-feature heatmap',
    hint: 'The mean of a bimodal set is a line that describes nothing.',
    default: true,
    section: 'Summary',
  },
]

function estimate(_context: AnalysisContext, params: Params): CostEstimate {
  const tracks = Array.isArray(params.tracks) ? params.tracks.length : params.tracks === null ? 0 : 1
  if (tracks === 0) {
    return {
      class: 'free',
      requests: 0,
      bytes: 0,
      note: 'Nothing to read.',
      refusal: 'Choose at least one track to average.',
    }
  }
  if (typeof params.features !== 'string' || params.features === '') {
    return {
      class: 'free',
      requests: 0,
      bytes: 0,
      note: 'Nothing to read.',
      refusal: 'Choose a feature set to average over.',
    }
  }
  return {
    class: 'bounded',
    requests: null,
    bytes: null,
    note:
      `No matrix reads at all: ${tracks} track${tracks === 1 ? '' : 's'} sampled in the ` +
      'annotations worker, one batch per sequence.',
  }
}

export const METAPLOT_TASK: AnalysisTask = {
  id: 'metaplot',
  title: 'Metaplot over a feature set',
  blurb: 'Average track signal at a set of places, with a band and a heatmap.',
  group: 'tracks',
  venue: 'annotations',
  version: 1,
  // Something to average, and somewhere to average it. **No map required** —
  // this runs entirely on loaded tracks, so it is offered in a 1D browser
  // session exactly as it is beside a map.
  availability: (context) => {
    const tracks = context.entries.some((entry) => entry.kind === 'track')
    const sets = context.entries.some((entry) => isIntervalSet(entry.kind))
    if (tracks && sets) return READY
    if (!tracks && !sets) {
      return waitingFor('Load a bigWig to average, and a BED or GTF of positions to average it at.')
    }
    return waitingFor(
      tracks
        ? 'Load a BED or a GTF — the positions to average the track at.'
        : 'Load a bigWig — the track to average.',
    )
  },
  params: PARAMS,
  outputs: ['curve', 'matrix'],
  estimate,
}
