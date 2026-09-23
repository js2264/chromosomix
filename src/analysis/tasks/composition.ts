/**
 * Base composition along the reference, as a descriptor.
 *
 * The FASTA's own lane already draws GC content, but as a *picture*: it is
 * sampled at whatever width the lane is being drawn at, is not a row any other
 * task can read, and cannot leave the app. The quantities a bacterial genome is
 * read by are three, not one — GC content, and the **GC and AT skews** that
 * change sign at the origin and the terminus of replication — and a reader who
 * wants them beside the map, correlated against an eigenvector or written out
 * as a bigWig had to compute them elsewhere. This task makes them synthetic
 * tracks on the map's own bins, which is what makes them all three of those
 * things at once (§18.5).
 *
 * **The window is in base pairs**, because it is a length of sequence rather
 * than a setting about the matrix (§18.2): each bin is read over that many
 * bases centred on it — its own bases alone at `0` — so a skew too noisy at the
 * map's resolution can be smoothed without changing the grid it is drawn on. A
 * declared-circular sequence (§8.15) is windowed round its origin, which is
 * where a skew changes sign and where a window clipped at the end of the array
 * would lie.
 */

import { binsForLength } from '../context'
import type { AnalysisTask, CostEstimate, Params, ParamSpec } from '../types'
import { NEEDS_MAP, READY, waitingFor } from '../types'

const PARAMS: readonly ParamSpec[] = [
  {
    kind: 'sequence',
    key: 'sequence',
    label: 'reference',
    hint: 'The FASTA to read — the map’s sequences, under the map’s names.',
  },
  {
    kind: 'number',
    key: 'window',
    label: 'window',
    unit: 'bp',
    hint: '0 reads each bin alone; wider reads that many bases centred on it.',
    default: 0,
    min: 0,
    integer: true,
  },
  { kind: 'toggle', key: 'gc', label: 'GC content', default: true, section: 'Tracks' },
  {
    kind: 'toggle',
    key: 'gcSkew',
    label: 'GC skew',
    hint: '(G − C) / (G + C), which changes sign at the origin and the terminus.',
    default: true,
    section: 'Tracks',
  },
  {
    kind: 'toggle',
    key: 'atSkew',
    label: 'AT skew',
    hint: '(A − T) / (A + T).',
    default: true,
    section: 'Tracks',
  },
  {
    kind: 'toggle',
    key: 'cumulative',
    label: 'cumulative GC skew',
    hint: 'Its minimum is the origin and its maximum the terminus.',
    default: true,
    section: 'Tracks',
  },
]

/** Which of the four lanes a run makes, in the order they are listed. */
export function compositionLanes(params: Params): Array<'gc' | 'gcSkew' | 'atSkew' | 'cumulative'> {
  return (['gc', 'gcSkew', 'atSkew', 'cumulative'] as const).filter(
    (key) => params[key] !== false,
  )
}

function estimate(context: Parameters<AnalysisTask['estimate']>[0], params: Params): CostEstimate {
  const free = { class: 'free' as const, requests: 0, bytes: 0, note: 'Nothing to read.' }
  const entry = params.sequence
  if (typeof entry !== 'string' || entry === '') {
    return {
      ...free,
      refusal: 'Choose a reference to read. A FASTA dropped on the Annotations panel is one.',
    }
  }
  if (compositionLanes(params).length === 0) {
    return { ...free, refusal: 'Tick at least one track to make.' }
  }
  let bins = 0
  let bases = 0
  for (const contig of context.contigs) {
    bins += binsForLength(contig.length, context.binsize)
    bases += contig.length
  }
  return {
    class: 'free',
    requests: 0,
    bytes: 0,
    note:
      `No file reads: one pass over ${(bases / 1e6).toFixed(1)} Mb of residues in the worker ` +
      `that holds them, into ${bins.toLocaleString()} bins at the map’s resolution`,
  }
}

export const COMPOSITION_TASK: AnalysisTask = {
  id: 'composition',
  title: 'Base composition',
  blurb: 'GC content, GC skew and AT skew per bin, as tracks.',
  group: '1d',
  // The residues are in the annotations worker and are never shipped out whole
  // (`analysis/job.ts`'s `SequenceReader`), so the counting goes to them.
  venue: 'annotations',
  version: 1,
  // Waiting rather than absent on both counts: a FASTA is one drop away, and so
  // is a map — whose bins are what every lane is laid out on.
  availability: (context) => {
    if (!context.entries.some((entry) => entry.kind === 'sequence')) {
      return waitingFor('Load a FASTA to read.')
    }
    return context.hasMap ? READY : waitingFor(NEEDS_MAP)
  },
  params: PARAMS,
  outputs: ['profile'],
  estimate,
}
