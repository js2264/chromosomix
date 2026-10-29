/**
 * Base composition, run — in the annotations worker, beside the residues.
 *
 * One pass per sequence counts each base per bin of the map's own grid, and
 * every lane is arithmetic over those counts: the window is a sum of whole
 * bins, and the four ratios are one division each. The grid is the session's,
 * rebuilt from `inputs.contigLengths` exactly as the motif density is
 * (`run/motif.ts`), because a lane on a private grid is a lane that lands in
 * the wrong places the moment it is registered.
 *
 * A sequence the reference does not have is a gap on every lane rather than a
 * zero, and it is named: a skew of zero is a measurement, and a sequence
 * nobody could read is not one.
 */

import {
  atSkewOf,
  baseCounts,
  cumulativeOf,
  gcContentOf,
  gcSkewOf,
  readBaseCounts,
  windowCounts,
  type BaseCounts,
} from '../../annotations/composition'
import { idParam, numParam, type TrackTaskRunner } from '../job'
import { COMPOSITION_BINSIZE, compositionLanes } from '../tasks/composition'
import { coversNoMatrix } from '../cliCommand'
import type { ProfileOutput, TaskOutput } from '../types'
import { gridContigs } from './motif'

/**
 * Whether this run has no map behind it — a 1D browser, or a shell with no map
 * named — whose framing's bin size is a browsing grid rather than a resolution
 * anybody picked.
 */
function mapless(job: Parameters<TrackTaskRunner>[0]): boolean {
  return coversNoMatrix(job.framing)
}

/** What each lane is called and how it draws. */
const LANES = {
  gc: { name: 'GC content', unit: '' },
  gcSkew: { name: 'GC skew', unit: '' },
  atSkew: { name: 'AT skew', unit: '' },
  cumulative: { name: 'Cumulative GC skew', unit: '' },
} as const

export const runComposition: TrackTaskRunner = async (job) => {
  const entry = idParam(job.params, 'sequence')
  if (job.residues === undefined) {
    job.note('This session cannot read residues, so there is no reference to read.')
    return []
  }
  if (entry === null) {
    job.note('No reference was chosen. Load a FASTA and pick it under Reference.')
    return []
  }
  const reader = job.residues(entry)
  if (reader === undefined) {
    job.note('The reference chosen is no longer loaded. Drop the FASTA again, or pick another.')
    return []
  }
  if (reader.refusal !== undefined) {
    job.note(reader.refusal)
    return []
  }
  const lanes = compositionLanes(job.params)
  if (lanes.length === 0) {
    job.note('No track was ticked, so there is nothing to make.')
    return []
  }

  // The bin size asked for; unanswered, the map's own resolution where there is
  // a map, and 10 kb where there is not — which is what a shell run gets, the
  // form having already answered it for a run from the drawer.
  const asked = numParam(job.params, 'resolution', 0)
  const binsize =
    asked > 0 ? Math.round(asked) : job.framing.binsize > 0 && !mapless(job) ? job.framing.binsize : COMPOSITION_BINSIZE
  const grid = gridContigs(job)
  if (grid.length === 0) {
    job.note('There are no sequences to lay the bins out on. Open a map, or load the FASTA itself.')
    return []
  }

  const windowBp = Math.max(0, Math.round(numParam(job.params, 'window', 0)))
  // An odd number of bins, centred: the window asked for, rounded to the grid
  // and then up to the next odd count — which is the width `windowCounts`
  // reads, so it is the width the note and the lane's name say.
  const rounded = Math.max(1, Math.round(windowBp / binsize))
  const span = rounded % 2 === 1 ? rounded : rounded + 1
  const circular = new Set(job.framing.circular ?? [])
  const total = grid.reduce((sum, contig) => sum + Math.max(1, Math.ceil(contig.length / binsize)), 0)
  const values: Record<(typeof lanes)[number], Float32Array> = {
    gc: new Float32Array(total).fill(Number.NaN),
    gcSkew: new Float32Array(total).fill(Number.NaN),
    atSkew: new Float32Array(total).fill(Number.NaN),
    cumulative: new Float32Array(total).fill(Number.NaN),
  }

  // A reference read by range is read a few megabases at a time, none of them
  // kept, as the motif search reads one: a sequence asked for whole is a
  // chromosome held for nothing, and the pages under it cost more to find than
  // its bases cost to count. A reference held is counted where it is held.
  const { read } = reader
  const unread: string[] = []
  const resized: string[] = []
  let startBin = 0
  for (let i = 0; i < grid.length; i++) {
    const contig = grid[i]
    const bins = Math.max(1, Math.ceil(contig.length / binsize))
    job.progress(i, grid.length, contig.name)
    let counted: { counts: BaseCounts; length: number } | undefined
    if (read !== undefined) {
      counted = await readBaseCounts((start, end) => read(contig.name, start, end), binsize)
    } else {
      const seq = reader.bases(contig.name)
      counted = seq === undefined ? undefined : { counts: baseCounts(seq, binsize), length: seq.length }
    }
    if (counted === undefined) {
      unread.push(contig.name)
      startBin += bins
      continue
    }
    // A reference of another assembly version is read for what it has: its bins
    // go where the map's are, and a length disagreement is said out loud.
    if (counted.length !== contig.length) resized.push(contig.name)
    const { counts } = counted
    const windowed = span > 1 ? windowCounts(counts, span, circular.has(contig.name)) : counts
    const per = {
      gc: gcContentOf(windowed),
      gcSkew: gcSkewOf(windowed),
      atSkew: atSkewOf(windowed),
      // Summed from each bin's own skew, not from the windowed one: a running
      // sum of overlapping windows counts every base `span` times.
      cumulative: cumulativeOf(gcSkewOf(counts)),
    }
    const kept = Math.min(bins, counts.steps)
    for (const lane of lanes) values[lane].set(per[lane].subarray(0, kept), startBin)
    startBin += bins
  }
  job.progress(grid.length, grid.length, 'done')

  if (unread.length === grid.length) {
    job.note(
      'The reference has none of the map’s sequences under any name this viewer knows, so ' +
        'nothing could be measured.',
    )
    return []
  }
  if (unread.length > 0) {
    job.note(
      `${unread.length.toLocaleString()} of the map’s sequences are not in this reference and ` +
        `are gaps on every track: ${unread.slice(0, 6).join(', ')}${unread.length > 6 ? ', …' : ''}.`,
    )
  }
  if (resized.length > 0) {
    job.note(
      `${resized.slice(0, 6).join(', ')}${resized.length > 6 ? ', …' : ''} ` +
        `${resized.length === 1 ? 'is' : 'are'} not the length the map says — the reference may ` +
        'be another assembly version. Bins were read from its start.',
    )
  }
  if (span > 1) {
    job.note(
      `Each bin was read over ${span} bins (${(span * binsize).toLocaleString()} bp) centred on ` +
        'it; the cumulative skew sums each bin’s own.',
    )
  }

  const reference = job.inputs.labels?.[entry] ?? 'reference'
  const suffix = span > 1 ? ` · ${(span * binsize).toLocaleString()} bp window` : ''
  const outputs: TaskOutput[] = lanes.map(
    (lane) =>
      ({
        kind: 'profile',
        id: `composition-${lane.toLowerCase()}`,
        label: `${LANES[lane].name} · ${reference}${lane === 'cumulative' ? '' : suffix}`,
        values: values[lane],
        extent: [0, total],
        binsize,
        unit: LANES[lane].unit,
      }) satisfies ProfileOutput,
  )
  return outputs
}
