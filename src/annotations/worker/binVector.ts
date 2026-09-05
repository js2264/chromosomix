/**
 * A lane whose values were computed rather than read from a file.
 *
 * This is the half of §18.5 that makes the claim true. An analysis that produces
 * one value per bin has produced a *track*, and the whole design says it should
 * then be indistinguishable from a loaded bigWig — same colour chip, same
 * limits, same four edges, same tooltip, same 1D browser, same exported figure —
 * because it is the same implementation and not a second one.
 *
 * What actually decides that is where the *values* come from. Every lane in the
 * app is drawn from a {@link TrackSampleSet} that this worker answered, so the
 * cheapest possible way to make a computed vector a real lane is to let it
 * answer the same request. The vector is registered here once; from that moment
 * `sample` finds it beside the bigWig handles and the FASTA stores, and nothing
 * downstream of the reply learns that a file was never involved. Zero renderer
 * changes, and no second path to keep in step.
 *
 * The alternative — a fourth kind of lane, fed from the main thread on every
 * frame — was what the first sketch of the 4C profile did, and §8.9 records why
 * it was thrown away.
 */

import { contigIndexOf } from '../../genome/naming'
import type { Region, TrackSampleSet, TrackSamples } from '../types'

/** One sequence of the assembly a vector is laid out over. */
export interface BinVectorContig {
  name: string
  /** Absolute bin this contig starts at. */
  startBin: number
  bins: number
  /** Base pairs, so the last — partial — bin can be clamped to the sequence. */
  length: number
}

/**
 * A computed per-bin vector, and the grid it is on.
 *
 * `values[i]` is the absolute bin `firstBin + i`. `NaN` is *no value here* and
 * comes back as a gap, exactly as it does from a bigWig with nothing in that
 * interval — which is why a task must never write a zero where it meant a
 * missing bin.
 */
export interface BinVector {
  binsize: number
  firstBin: number
  values: Float32Array
  contigs: BinVectorContig[]
}

/**
 * Above this many intervals in one region, the answer is summarised.
 *
 * A bigWig answers a wide window from a pre-computed zoom level and says so with
 * `summary: true`; a computed vector has no zoom levels, so it builds one for
 * the window it was asked about. Without this a whole-metagenome view would ship
 * several million single-bin intervals to the main thread for a lane a few
 * hundred pixels wide, which is both slow and — because `profileOf` would then
 * area-weight millions of intervals per frame — the thing that makes a pan
 * stutter.
 *
 * Four thousand is comfortably more than the widest lane any screen draws, so a
 * summarised answer never costs visible detail.
 */
const MAX_INTERVALS = 4096

/**
 * The contig of that name, or `undefined`.
 *
 * Through {@link contigIndexOf} rather than by name, and this is the whole of
 * why a synthetic track works in a deck at all (§5.9). A vector is laid out over
 * the grid of the map it was **computed on** — `AnalysisWorkspace.grid` — and a
 * deck then draws it beside every panel, each of which samples through its own
 * block's axis and therefore asks by the name *its* file writes. A diamond
 * insulation profile computed on a UCSC lead and drawn beside an Ensembl
 * companion was asked for `1` against a grid holding `chr1`, matched nothing,
 * and the companion's lane stayed empty with nothing on screen to say why.
 */
function contigOf(vector: BinVector, name: string): BinVectorContig | undefined {
  const at = contigIndexOf(vector.contigs, name)
  return at < 0 ? undefined : vector.contigs[at]
}

/**
 * One region's worth of intervals.
 *
 * Two shapes, decided by how many bins the window covers. At bin resolution each
 * interval *is* a bin, clamped at both ends to the contig — the last bin of a
 * sequence is partial, and reporting it as a whole bin would draw signal past
 * the end of the chromosome. Above the cap, consecutive bins are folded into
 * buckets carrying a mean with the min and max around it, which is exactly the
 * shape `TrackSamples` already defines for a bigWig's summary level.
 *
 * Bins whose value is `NaN` contribute to neither: they are skipped in a bucket
 * and omitted entirely at bin resolution, so a gap stays a gap rather than
 * becoming a zero or dragging a bucket's mean down.
 */
function samplesFor(vector: BinVector, region: Region): TrackSamples | null {
  const contig = contigOf(vector, region.contig)
  if (contig === undefined || contig.bins === 0) return null

  const start = Math.max(0, Math.floor(region.start))
  const end = Math.min(contig.length, Math.ceil(region.end))
  if (!(end > start)) return null

  // Bin indices local to the contig, then absolute, then into `values`.
  const firstLocal = Math.floor(start / vector.binsize)
  const lastLocal = Math.min(contig.bins - 1, Math.floor((end - 1) / vector.binsize))
  if (lastLocal < firstLocal) return null
  const covered = lastLocal - firstLocal + 1
  const stride = Math.max(1, Math.ceil(covered / MAX_INTERVALS))
  const slots = Math.ceil(covered / stride)

  const starts = new Int32Array(slots)
  const ends = new Int32Array(slots)
  const values = new Float32Array(slots)
  const mins = stride > 1 ? new Float32Array(slots) : null
  const maxs = stride > 1 ? new Float32Array(slots) : null

  let kept = 0
  for (let slot = 0; slot < slots; slot++) {
    const from = firstLocal + slot * stride
    const to = Math.min(lastLocal + 1, from + stride)
    let total = 0
    let seen = 0
    let min = Number.POSITIVE_INFINITY
    let max = Number.NEGATIVE_INFINITY
    for (let local = from; local < to; local++) {
      const index = contig.startBin + local - vector.firstBin
      if (index < 0 || index >= vector.values.length) continue
      const value = vector.values[index]
      if (Number.isNaN(value)) continue
      total += value
      seen++
      if (value < min) min = value
      if (value > max) max = value
    }
    // A slot with nothing in it is dropped rather than emitted as NaN. The
    // renderer draws a gap wherever an interval is absent, and an explicit NaN
    // interval would additionally claim the window was measured and found empty.
    if (seen === 0) continue
    starts[kept] = from * vector.binsize
    ends[kept] = Math.min(contig.length, to * vector.binsize)
    values[kept] = total / seen
    if (mins !== null && maxs !== null) {
      mins[kept] = min
      maxs[kept] = max
    }
    kept++
  }
  if (kept === 0) return null

  return {
    contig: region.contig,
    start,
    end,
    // `slice`, not `subarray`, and for the reason `sample` gives: each region's
    // arrays are transferred separately, and views over one buffer would detach
    // each other on the way across.
    starts: starts.slice(0, kept),
    ends: ends.slice(0, kept),
    values: values.slice(0, kept),
    min: mins === null ? null : mins.slice(0, kept),
    max: maxs === null ? null : maxs.slice(0, kept),
    variant: null,
    summary: stride > 1,
  }
}

/** Answer a `sample` request from a registered vector. */
export function binVectorSamples(
  vector: BinVector,
  regions: Region[],
  basesPerPixel: number,
): TrackSampleSet {
  const out: TrackSamples[] = []
  let min = Number.POSITIVE_INFINITY
  let max = Number.NEGATIVE_INFINITY
  for (const region of regions) {
    const samples = samplesFor(vector, region)
    if (samples === null) continue
    for (const value of samples.values) {
      if (!Number.isFinite(value)) continue
      if (value < min) min = value
      if (value > max) max = value
    }
    out.push(samples)
  }
  return { basesPerPixel, regions: out, extent: min <= max ? { min, max } : null }
}
