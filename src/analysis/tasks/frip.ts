/**
 * Fraction of signal in a feature set, as a descriptor.
 *
 * ChIP-seq's FRiP, on whatever the reader has loaded: of everything a track
 * carries, how much of it is inside the intervals they chose. It is the oldest
 * signal-to-noise number in the field and it is the one thing a browser is
 * better placed to answer than a pipeline, because the two inputs — the track
 * and the peak set — are already both on screen and already both in the reader's
 * own vocabulary (§5.9).
 *
 * ## Why it is an area and not a mean
 *
 * The quantity is `Σ value × width`, over the features and over the assembly,
 * and the ratio of the two. A mean of the per-feature means is a different
 * number and a worse one: it weights a 200 bp peak and a 20 kb domain equally,
 * so a set with a long tail of wide features reports a FRiP that moves with the
 * width distribution rather than with the signal. Every published FRiP is a
 * ratio of sums.
 *
 * ## Why the two halves are read at different resolutions, and why that is said
 *
 * A bigWig answers at whatever zoom level the request implies, and a span-weighted
 * sum estimates the same area at any of them — except at a **boundary**, where a
 * summary bin straddling the edge of a feature attributes signal to the wrong
 * side of it. The genome-wide total has almost no boundaries and can be read
 * coarsely; a set of 300 bp peaks is nothing but boundaries and cannot. So the
 * features are sampled fine and the assembly coarse, and the run reports both
 * resolutions rather than presenting one number as though it had no scale.
 *
 * ## What makes the number readable
 *
 * A FRiP alone says nothing without knowing how much of the genome the set
 * covers: 30 % of the signal in 30 % of the assembly is a track with no
 * preference at all. So the covered fraction is reported beside it and the ratio
 * of the two — the enrichment — is the column to read. This is the same argument
 * `overlap`'s shuffle null makes one level up, and for the same reason.
 */

import type { AnalysisContext, AnalysisTask, CostEstimate, ParamSpec, Params } from '../types'
import { READY, waitingFor } from '../types'
import { isIntervalSet } from '../../annotations/types'

/** Samples to aim for across the whole assembly, when the resolution is auto. */
export const GENOME_SAMPLE_TARGET = 200_000

/** Samples to aim for across one feature, when the resolution is auto. */
export const FEATURE_SAMPLES = 50

const PARAMS: readonly ParamSpec[] = [
  { kind: 'track', key: 'tracks', label: 'tracks', multiple: true },
  { kind: 'featureSet', key: 'features', label: 'features' },
  {
    kind: 'number',
    key: 'resolution',
    label: 'read features at',
    // Base pairs, and no bin count beneath it: a FRiP reads tracks, and a
    // track's sampling step is not a count of a contact map's bins (§18.2).
    unit: 'bp',
    hint: `0 is auto: about ${FEATURE_SAMPLES} samples across a feature of the set’s median width.`,
    default: 0,
    min: 0,
    integer: true,
  },
  {
    kind: 'toggle',
    key: 'perFeature',
    label: 'score every feature',
    hint: 'One row per feature, so a FRiP carried by a handful of them can be seen to be.',
    default: false,
  },
]

function estimate(context: AnalysisContext, params: Params): CostEstimate {
  const tracks = Array.isArray(params.tracks) ? params.tracks.length : 0
  const chosen = typeof params.features === 'string' && params.features !== ''
  if (tracks === 0 || !chosen) {
    return {
      class: 'free',
      requests: 0,
      bytes: 0,
      note: 'Nothing to read.',
      refusal:
        tracks === 0 ? 'Choose at least one track.' : 'Choose the feature set to measure inside.',
    }
  }
  void context
  return {
    class: 'bounded',
    requests: null,
    bytes: null,
    note:
      `${tracks.toLocaleString()} track${tracks === 1 ? '' : 's'}, each read twice: once over the ` +
      'features and once over the assembly, both through the bigWig’s own zoom levels.',
  }
}

export const FRIP_TASK: AnalysisTask = {
  id: 'frip',
  title: 'Fraction of signal in features',
  blurb: 'How much of each track sits inside a feature set, against how much of the genome it is.',
  keywords: ['FRiP', 'reads in peaks', 'enrichment'],
  group: '1d',
  venue: 'annotations',
  version: 1,
  // No map required, for the reason `overlap.ts` gives: a track and a peak set
  // say nothing about a matrix, and the 1D browser is where a reader most often
  // has both.
  availability: (context) => {
    const tracks = context.entries.some((entry) => entry.kind === 'track')
    const sets = context.entries.some((entry) => isIntervalSet(entry.kind))
    if (tracks && sets) return READY
    if (!tracks && !sets) {
      return waitingFor('Load a bigWig, and a BED or GTF of the places to measure it inside.')
    }
    return waitingFor(
      tracks
        ? 'Load a BED or a GTF — the features to measure the signal inside.'
        : 'Load a bigWig — the track to measure.',
    )
  },
  params: PARAMS,
  outputs: ['table'],
  estimate,
}
