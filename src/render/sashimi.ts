/**
 * A coverage lane's own arcs: the sashimi plot, from the reads (§8.23).
 *
 * A BAM's depth lane is counted from its reads per window (§8.13), and the
 * reads that skip an intron say so in their CIGAR — so the introns they skip,
 * and how many reads skip each, come from the same pass for nothing
 * (`bam/pile.ts`'s `eachIntron`). Drawn over the depth they are Katz et al.'s
 * sashimi plot: the curve says how much of each exon was read, the arcs say how
 * the exons were joined, and the count on an arc is the reads behind it. No
 * junction file is needed; any spliced alignment file draws them.
 *
 * The arcs are the junction lane's (`render/junctions.ts`), stood on the
 * depth's baseline rather than split by strand, and in the plot's ink rather
 * than the lane's colour, which is the colour of the filled curve under them.
 * Their ceiling is the strongest junction **in view**: the depth under them is
 * autoscaled to the window, so an arc whose height meant something the depth
 * does not would be the one number in the lane read on another scale — and
 * every arc carries its count.
 */

import type { FeatureSet, TrackSampleSet } from '../annotations/types'
import { FeatureBuilder } from '../annotations/featureset'
import { layoutFeatures, type FeaturePaint } from './features'
import { drawJunctions } from './junctions'
import type { LaneFrame } from './lane'
import type { LocusAxis } from './locus'

/** One set per sample set, so a frame that did not refetch does not rebuild it. */
const built = new WeakMap<TrackSampleSet, FeatureSet | null>()

/**
 * The introns a window's reads skipped, as a set of junctions, or `null` for a
 * window with none — a DNA library's, or one not yet answered.
 */
export function junctionsOfSamples(samples: TrackSampleSet | null): FeatureSet | null {
  if (samples === null) return null
  const held = built.get(samples)
  if (held !== undefined) return held
  const builder = new FeatureBuilder()
  // A junction reaching into two padded windows of one view is one junction,
  // counted once in each: keep the larger count, which is the whole of it.
  const seen = new Map<string, number>()
  for (const region of samples.regions) {
    const junctions = region.junctions
    if (junctions === undefined) continue
    for (let i = 0; i < junctions.starts.length; i++) {
      const key = `${region.contig}:${junctions.starts[i]}:${junctions.ends[i]}:${junctions.strands[i]}`
      const count = junctions.counts[i]
      const before = seen.get(key)
      if (before !== undefined && before >= count) continue
      seen.set(key, count)
    }
  }
  for (const [key, count] of seen) {
    const parts = key.split(':')
    const strand = Number(parts.pop())
    const end = Number(parts.pop())
    const start = Number(parts.pop())
    builder.add(parts.join(':'), start, end, { strand, score: count })
  }
  const set = builder.length === 0 ? null : builder.finish()
  built.set(samples, set)
  return set
}

/** What the arcs need of the lane's own paint. */
export interface SashimiPaint {
  guideColour: string
  haloColour: string
  font: string
  opacity: number
  labels: boolean
  labelBand?: number
}

/**
 * Draw a coverage lane's arcs over its depth: every intron in view that at
 * least `floor` reads skipped, as tall as its count against the strongest one
 * in view, labelled with that count.
 */
export function drawSashimi(
  ctx: CanvasRenderingContext2D,
  frame: LaneFrame,
  axis: LocusAxis,
  set: FeatureSet,
  paint: SashimiPaint,
  options: { floor: number; flip: boolean },
): void {
  const layout = layoutFeatures(frame, axis, set, 1, 0, false)
  let top = 0
  for (const placement of layout.placements) {
    const count = set.score[placement.index]
    if (count > top) top = count
  }
  if (top < options.floor) return
  const arcs: FeaturePaint = {
    colour: paint.guideColour,
    guideColour: paint.guideColour,
    haloColour: paint.haloColour,
    font: paint.font,
    opacity: paint.opacity,
    outline: false,
    labels: paint.labels,
    ...(paint.labelBand === undefined ? {} : { labelBand: paint.labelBand }),
    axisLimits: { min: options.floor, max: Math.max(top, options.floor + 1) },
  }
  drawJunctions(ctx, frame, set, layout, arcs, { split: false, flip: options.flip })
}
