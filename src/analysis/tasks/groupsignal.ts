/**
 * A track's values compared between groups of the genome, as a descriptor.
 *
 * The question behind every *is this compartment GC-rich*, *is B transcribed
 * less*, *is the signal higher at these peaks than at those*: one quantity, read
 * over sets of places, and the sets compared. Every piece of it was already
 * here — a compartment call leaves its A and B as intervals, any lane is a
 * track — and what was missing was the comparison itself, which a reader did by
 * exporting both and writing a script.
 *
 * ## Where the groups come from
 *
 * **A feature set**, split by what is written on its features — the name,
 * which is A and B on a compartment call and a class on a peak set; the strand;
 * the score, in quantiles; or nothing, one group — with what the set does not
 * cover as a group of its own. Or **a track**, its bins cut by sign — an
 * eigenvector's two compartments without calling them first — or into
 * quantiles, the stratification a saddle plot makes of the same numbers. A
 * grouping made from a track is written out as intervals, named by group, so the
 * next task can read them as a set.
 *
 * ## What is compared
 *
 * One value per entry, by default: each run of a group's features, merged where
 * they overlap or touch, each stretch of the rest between them, and each run of
 * bins in one group of a track — so a 30 kb compartment is one observation, as
 * a 300 bp peak is. Neighbouring bins of one compartment share their GC, their
 * expression and their place in the nucleus, and a test that counted each as
 * independent gave a P that followed the bin size rather than the data. A bin
 * size compares stretches of at most one bin instead: a group's merged
 * intervals cut on the bin grid, a stretch shorter than half a bin joined to its
 * neighbour, and a feature shorter than a bin kept whole. Either way each is the
 * track's mean over the bases it has a value for. A track is cut on the open
 * map's resolution, and on 10 kb with no map open, unless a bin size is given.
 *
 * The groups are summarised, drawn as violins, and tested pairwise and together
 * by ranks (`analysis/groupstats.ts`), with the q-values of every test in the
 * run adjusted together.
 */

import type { AnalysisContext, AnalysisTask, CostEstimate, Params, ParamSpec } from '../types'
import { READY, waitingFor } from '../types'

/** The bins a track is cut on with no map open, in base pairs — base composition's too. */
export const GROUP_BINSIZE = 10_000

/** The bins a context gives a track: the open map's resolution, else 10 kb. */
function gridOf(context: AnalysisContext): number {
  return context.hasMap && context.binsize > 0 ? context.binsize : GROUP_BINSIZE
}

const byTrack = (params: Params): boolean => params.groupBy === 'track'
const byFeatures = (params: Params): boolean => !byTrack(params)

const PARAMS: readonly ParamSpec[] = [
  {
    kind: 'track',
    key: 'tracks',
    label: 'tracks',
    multiple: true,
    hint: 'The values compared between the groups.',
  },
  {
    kind: 'choice',
    key: 'groupBy',
    label: 'groups from',
    default: 'features',
    options: [
      {
        value: 'features',
        label: 'a feature set',
        hint: 'Its intervals, split by what is written on them: A and B on a compartment call.',
      },
      {
        value: 'track',
        label: 'a track',
        hint: 'Its bins, cut by sign or into quantiles: an eigenvector’s two compartments.',
      },
    ],
  },
  { kind: 'featureSet', key: 'features', label: 'features', when: byFeatures },
  {
    kind: 'choice',
    key: 'split',
    label: 'split the set by',
    default: 'name',
    options: [
      { value: 'name', label: 'name', hint: 'One group per name the features carry.' },
      { value: 'strand', label: 'strand' },
      { value: 'score', label: 'score, in quantiles' },
      { value: 'none', label: 'nothing: one group' },
    ],
    when: byFeatures,
  },
  {
    kind: 'toggle',
    key: 'outside',
    label: 'the rest as a group',
    hint: 'Every base the set does not cover, as one more group.',
    default: true,
    when: byFeatures,
  },
  {
    kind: 'track',
    key: 'groupTrack',
    label: 'grouping track',
    optional: true,
    startsEmpty: true,
    noneLabel: 'choose one',
    when: byTrack,
  },
  {
    kind: 'choice',
    key: 'cut',
    label: 'cut it by',
    default: 'sign',
    options: [
      { value: 'sign', label: 'sign', hint: 'Above zero and below it.' },
      { value: 'quantiles', label: 'quantiles', hint: 'Equal numbers of bins, lowest to highest.' },
    ],
    when: byTrack,
  },
  {
    kind: 'number',
    key: 'quantiles',
    label: 'quantiles',
    default: 4,
    min: 2,
    max: 10,
    integer: true,
    when: (params) =>
      (byTrack(params) && params.cut === 'quantiles') || (byFeatures(params) && params.split === 'score'),
  },
  {
    kind: 'number',
    key: 'resolution',
    label: 'bin size',
    unit: 'bp',
    hint:
      '0 compares one value per entry — a run of features, the stretch between two, a run of bins ' +
      'in one group — and any other size compares stretches of at most that many bases.',
    default: 0,
    min: 0,
    integer: true,
  },
  {
    kind: 'toggle',
    key: 'perFeature',
    label: 'score every feature',
    hint: 'A row per feature of the set, its mean on every track.',
    default: false,
    when: byFeatures,
  },
]

function estimate(context: AnalysisContext, params: Params): CostEstimate {
  const tracks = Array.isArray(params.tracks) ? params.tracks.length : 0
  const free = { class: 'free' as const, requests: 0, bytes: 0, note: 'Nothing to read.' }
  if (tracks === 0) return { ...free, refusal: 'Choose at least one track to compare.' }
  const chosen = (key: string): boolean => typeof params[key] === 'string' && params[key] !== ''
  if (byFeatures(params) && !chosen('features')) {
    return { ...free, refusal: 'Choose the feature set whose groups to compare.' }
  }
  if (byTrack(params) && !chosen('groupTrack')) {
    return { ...free, refusal: 'Choose the track to group the bins by.' }
  }
  const read = `${tracks.toLocaleString()} track${tracks === 1 ? '' : 's'} read`
  const perEntry = !(typeof params.resolution === 'number' && params.resolution > 0)
  if (perEntry && byFeatures(params)) {
    return { class: 'bounded', requests: null, bytes: null, note: `${read} once over each entry of the groups` }
  }
  const binsize = perEntry ? gridOf(context) : (params.resolution as number)
  let bases = 0
  for (const contig of context.contigs) bases += contig.length
  const stretches = bases > 0 ? Math.ceil(bases / binsize) : 0
  return {
    class: 'bounded',
    requests: null,
    bytes: null,
    note:
      `${read} over up to ${stretches.toLocaleString()} ${perEntry ? 'bins' : 'stretches'} of ` +
      `${binsize.toLocaleString()} bp${perEntry ? ', compared a run of one group at a time' : ''}`,
  }
}

export const GROUP_SIGNAL_TASK: AnalysisTask = {
  id: 'groupsignal',
  title: 'Signal by group',
  blurb: 'A track’s values in each group of the genome — A against B — compared and tested.',
  keywords: ['A versus B', 'compartment signal', 'box plot', 'test'],
  group: '1d',
  // Tracks and interval sets, which live in the annotations worker; no map is
  // needed, so a 1D browser runs it as well as a map does.
  venue: 'annotations',
  // 2: a bin size of 0, the default, is one value per entry, where it was the
  // map's resolution.
  version: 2,
  // A track is all it needs: a second track, or the same one, can do the
  // grouping, so a feature set is one way in rather than a requirement.
  availability: (context) =>
    context.entries.some((entry) => entry.kind === 'track')
      ? READY
      : waitingFor('Load a bigWig, or run a task that makes a track: the values to compare.'),
  params: PARAMS,
  outputs: ['curve', 'table', 'intervals'],
  estimate,
}
