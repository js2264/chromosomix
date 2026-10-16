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
 * **The bin size and the window are in base pairs**, because both are lengths
 * of sequence rather than settings about the matrix (§18.2). The bin size is
 * the open map's resolution unless the reader says otherwise, so the lanes sit
 * on the map's own bins, and 10 kb where no map is open — a 1D browser with a
 * FASTA in it is a session this task is for as much as one with a map. The
 * window reads each bin over that many bases centred on it — its own bases
 * alone at `0` — so a skew too noisy at the bin size can be smoothed without
 * changing the grid it is drawn on. A declared-circular sequence (§8.15) is
 * windowed round its origin, which is where a skew changes sign and where a
 * window clipped at the end of the array would lie.
 */

import { binsForLength } from '../context'
import type { AnalysisContext, AnalysisTask, CostEstimate, Params, ParamSpec } from '../types'
import { READY, waitingFor } from '../types'

/** The bin size with no map open, in base pairs. */
export const COMPOSITION_BINSIZE = 10_000

/** The bin size a context gives: the open map's resolution, else 10 kb. */
function seededBinsize(context: AnalysisContext): number {
  return context.hasMap && context.binsize > 0 ? context.binsize : COMPOSITION_BINSIZE
}

/** The bin size a run reads at: the one asked for, else the context's. */
export function compositionBinsize(params: Params, context: AnalysisContext): number {
  const asked = params.resolution
  return typeof asked === 'number' && asked > 0 ? Math.round(asked) : seededBinsize(context)
}

const PARAMS: readonly ParamSpec[] = [
  {
    kind: 'sequence',
    key: 'sequence',
    label: 'reference',
    hint: 'The FASTA to read, under the names of the sequences open.',
  },
  {
    kind: 'number',
    key: 'resolution',
    label: 'bin size',
    unit: 'bp',
    hint: 'The open map’s resolution unless changed, and 10 kb with no map open.',
    default: COMPOSITION_BINSIZE,
    min: 1,
    integer: true,
    seed: seededBinsize,
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
  const binsize = compositionBinsize(params, context)
  let bins = 0
  let bases = 0
  for (const contig of context.contigs) {
    bins += binsForLength(contig.length, binsize)
    bases += contig.length
  }
  return {
    class: 'free',
    requests: 0,
    bytes: 0,
    note:
      `No file reads: one pass over ${(bases / 1e6).toFixed(1)} Mb of residues in the worker ` +
      `that holds them, into ${bins.toLocaleString()} bins of ${binsize.toLocaleString()} bp`,
  }
}

export const COMPOSITION_TASK: AnalysisTask = {
  id: 'composition',
  title: 'Base composition',
  blurb: 'GC content, GC skew and AT skew per bin, as tracks.',
  keywords: ['GC', 'GC skew', 'AT skew'],
  group: '1d',
  // The residues are in the annotations worker and are never shipped out whole
  // (`analysis/job.ts`'s `SequenceReader`), so the counting goes to them.
  venue: 'annotations',
  version: 1,
  // Waiting rather than absent: a FASTA is one drop away. A map is not needed —
  // with none the lanes are laid out on bins of their own (§5.8).
  availability: (context) =>
    context.entries.some((entry) => entry.kind === 'sequence')
      ? READY
      : waitingFor('Load a FASTA to read.'),
  params: PARAMS,
  outputs: ['profile'],
  estimate,
}
