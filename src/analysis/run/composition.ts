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
  windowCounts,
} from '../../annotations/composition'
import { idParam, numParam, type TrackTaskRunner } from '../job'
import { compositionLanes } from '../tasks/composition'
import type { ProfileOutput, TaskOutput } from '../types'
import { gridContigs } from './motif'

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

  const binsize = job.framing.binsize
  const grid = gridContigs(job)
  if (!(binsize > 0) || grid.length === 0) {
    job.note(
      'These are per-bin tracks, and there is no bin grid without an open contact map. Open the ' +
        'map and run it again.',
    )
    return []
  }

  const windowBp = Math.max(0, Math.round(numParam(job.params, 'window', 0)))
  // An odd number of bins, centred: the window asked for, rounded to the grid.
  const span = Math.max(1, Math.round(windowBp / binsize))
  const circular = new Set(job.framing.circular ?? [])
  const total = grid.reduce((sum, contig) => sum + Math.max(1, Math.ceil(contig.length / binsize)), 0)
  const values: Record<(typeof lanes)[number], Float32Array> = {
    gc: new Float32Array(total).fill(Number.NaN),
    gcSkew: new Float32Array(total).fill(Number.NaN),
    atSkew: new Float32Array(total).fill(Number.NaN),
    cumulative: new Float32Array(total).fill(Number.NaN),
  }

  const unread: string[] = []
  const resized: string[] = []
  let startBin = 0
  for (let i = 0; i < grid.length; i++) {
    const contig = grid[i]
    const bins = Math.max(1, Math.ceil(contig.length / binsize))
    job.progress(i, grid.length, contig.name)
    const seq = reader.bases(contig.name)
    if (seq === undefined) {
      unread.push(contig.name)
      startBin += bins
      continue
    }
    // A reference of another assembly version is read for what it has: its bins
    // go where the map's are, and a length disagreement is said out loud.
    if (seq.length !== contig.length) resized.push(contig.name)
    const counts = baseCounts(seq, binsize)
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
