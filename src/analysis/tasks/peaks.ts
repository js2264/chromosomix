/**
 * Calling peaks on a coverage track, as a descriptor.
 *
 * The 1D card could read a peak set — FRiP measures a track inside one, the
 * metaplot averages over one, the overlap test compares two — and could not
 * make one, so every one of those tasks opened with a file from somewhere else.
 * This makes one out of what the browser already holds, which is a **track**:
 * a bigWig of an ATAC, DNase or ChIP experiment rather than its reads.
 *
 * ## Why yapc
 *
 * Most peak callers take reads — MACS, Genrich, HMMRATAC — and cannot be pointed
 * at a bigWig at all. Of the ones that read coverage, MACS's `bdgpeakcall`
 * thresholds a score track at a cutoff the reader supplies, which on a
 * normalised coverage track is a number with no meaning; SEACR assumes the sparse
 * background of CUT&RUN; LanceOtron is a trained network. **yapc** (Jänes et al.
 * 2018) was written for this input and is small enough to port exactly: a peak
 * is a stretch where the smoothed signal curves down, found by its shape rather
 * than its height, and two replicates settle which of those are real through
 * IDR, the reproducibility test ENCODE uses. `analysis/yapc.ts` and
 * `analysis/idr.ts` are the port; §18.9 is the rule it keeps.
 *
 * ## One track or two
 *
 * With a **replicate**, this is yapc's pipeline for one condition: the concave
 * regions of the two tracks' mean, each track's score for every one, IDR over
 * the two rankings, and the peaks below the threshold. With **one track** there
 * is nothing to reproduce a ranking against, so what comes out is the concave
 * regions ranked by curvature — yapc's candidates — and the run says, in a note
 * and in the lane's name, that no test of significance was made. The histogram
 * it draws is how a reader tells the two populations apart: on a real ATAC track
 * the scores are plainly bimodal, and the cut is the reader's to make.
 */

import { tickedContigs } from '../context'
import type { AnalysisContext, AnalysisTask, CostEstimate, ParamSpec, Params } from '../types'
import { READY, waitingFor } from '../types'
import { YAPC_DEFAULTS, YAPC_IDR_THRESHOLDS } from '../yapc'

/** The IDR cut the form starts at: ENCODE's, and the middle of yapc's six. */
export const DEFAULT_IDR_THRESHOLD = '0.05'

/** Whether a replicate was chosen, which is what decides whether IDR runs. */
export function hasReplicate(params: Params): boolean {
  return typeof params.replicate === 'string' && params.replicate !== ''
}

const PARAMS: readonly ParamSpec[] = [
  {
    kind: 'track',
    key: 'signal',
    label: 'track',
    hint: 'The coverage to call on, as normalised; a bigWig, a bedGraph or a wig.',
  },
  {
    kind: 'track',
    key: 'replicate',
    label: 'replicate',
    optional: true,
    // Empty rather than the next track along: a second bigWig in a session is
    // usually a different experiment, and IDR run on two experiments reports
    // their disagreement as if it were the peaks' irreproducibility.
    startsEmpty: true,
    noneLabel: 'None — no IDR',
    hint: 'A second replicate of the same experiment; with one, IDR tests every peak.',
  },
  {
    kind: 'choice',
    key: 'idr',
    label: 'IDR threshold',
    default: DEFAULT_IDR_THRESHOLD,
    // yapc's six, which are the six BED files it writes — a threshold it never
    // offers is not one of its answers.
    options: YAPC_IDR_THRESHOLDS.map((value) => ({ value: String(value), label: String(value) })),
    hint: 'Keep peaks whose global IDR is at most this.',
    when: hasReplicate,
  },
  { kind: 'sequences', key: 'sequences', label: 'sequences' },
  {
    kind: 'toggle',
    key: 'perPeak',
    label: 'list every peak',
    hint: 'One row per peak, with its summit, its scores and its IDR; long on a large genome.',
    default: false,
  },
  {
    kind: 'number',
    key: 'width',
    label: 'smoothing window',
    unit: 'bp',
    hint: 'yapc’s default; 75 to 200 bp suits most narrow peaks.',
    default: YAPC_DEFAULTS.width,
    min: 1,
    max: 2000,
    integer: true,
    section: 'Smoothing',
  },
  {
    kind: 'number',
    key: 'times',
    label: 'smoothing passes',
    hint: 'Rolling means applied to the second derivative.',
    default: YAPC_DEFAULTS.times,
    min: 0,
    max: 10,
    integer: true,
    section: 'Smoothing',
  },
  {
    kind: 'number',
    key: 'minWidth',
    label: 'narrowest peak',
    unit: 'bp',
    hint: 'Concave stretches narrower than this are dropped.',
    default: YAPC_DEFAULTS.minWidth,
    min: 1,
    integer: true,
    section: 'Peaks',
  },
  {
    kind: 'number',
    key: 'halfWidth',
    label: 'fixed half-width',
    unit: 'bp',
    hint: '0 keeps each peak’s concave bounds; otherwise this many bases each side of its summit.',
    default: 0,
    min: 0,
    integer: true,
    section: 'Peaks',
  },
  {
    kind: 'number',
    key: 'truncate',
    label: 'keep the strongest',
    hint: 'By each track’s curvature rank, before IDR; with one track, the only cut.',
    default: YAPC_DEFAULTS.truncate,
    min: 1,
    integer: true,
    section: 'Peaks',
  },
]

/**
 * Priced as the scan it is, and refused where the form cannot be answered.
 *
 * **A scan**, because every base of every ticked sequence is read at the file's
 * own resolution — a peak is a shape a few hundred bases wide and a zoom level
 * would average it away. On a bigWig that is the base level of the file, which
 * is most of its bytes; the note says how many bases, since the file's size is
 * not something the form knows.
 */
function estimate(context: AnalysisContext, params: Params): CostEstimate {
  const free = { class: 'free' as const, requests: 0, bytes: 0, note: 'Nothing to read.' }
  const signal = params.signal
  if (typeof signal !== 'string' || signal === '') {
    return { ...free, refusal: 'Choose the track to call peaks on.' }
  }
  const replicate = hasReplicate(params)
  if (replicate && params.replicate === signal) {
    return { ...free, refusal: 'A replicate is a second track; this is the same one twice.' }
  }
  const chosen = tickedContigs(context, params, 'sequences')
  if (chosen.length === 0) return { ...free, refusal: 'Tick at least one sequence.' }
  const bases = chosen.reduce((sum, contig) => sum + contig.length, 0)
  return {
    class: 'scan',
    requests: null,
    bytes: null,
    note:
      `Every base of ${(bases / 1e6).toFixed(1)} Mb of ${replicate ? 'both tracks' : 'the track'}, ` +
      `read at the file’s own resolution${replicate ? ', then an IDR fit over the two' : ''}`,
  }
}

export const PEAKS_TASK: AnalysisTask = {
  id: 'peaks',
  title: 'Peak calling',
  blurb: 'Narrow peaks from a coverage track, where its smoothed signal curves down (yapc).',
  keywords: ['peaks', 'yapc', 'narrowPeak', 'ChIP', 'ATAC'],
  group: '1d',
  // The bigWig handles are in the annotations worker, and a peak caller reads
  // every base of one: shipping a genome's coverage to another thread to find
  // its peaks is the move `analysis/job.ts` argues against.
  venue: 'annotations',
  version: 1,
  // No map required, for the reason `overlap.ts` gives, and a peak set is most
  // often wanted in the 1D browser.
  availability: (context) =>
    context.entries.some((entry) => entry.kind === 'track')
      ? READY
      : waitingFor('Load a bigWig — the coverage to call peaks on.'),
  params: PARAMS,
  outputs: ['intervals', 'table', 'curve'],
  estimate,
}
