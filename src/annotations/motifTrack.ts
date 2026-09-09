/**
 * Turning a motif's coordinates into the two things a reader can look at.
 *
 * `motif.ts` finds the sites and `annotations/worker/annotations.worker.ts`
 * ships them back as three typed arrays per sequence. Neither of those is a
 * lane. This module is the last step, and it is deliberately two steps rather
 * than one, because a set of sites answers two different questions and no single
 * picture answers both:
 *
 * - **Where exactly is it?** A `FeatureSet` — one interval per site, strand
 *   kept, clickable, exportable as BED, and eligible as an input to overlap, to
 *   the metaplot and to APA, because those tasks take any interval set (§18.3).
 *   Drawn at a whole chromosome it is a picket fence and tells you nothing.
 * - **How dense is it here?** A `BinVector` — sites per bin, which is the
 *   picture that means something at genome scale: where a restriction enzyme has
 *   no sites, where a repeat family lives, where GC-rich motifs pile up. Drawn
 *   at base resolution it is a bar chart of ones and tells you nothing.
 *
 * So both are built, from one scan, and the reader is given both. That is the
 * same answer §18.5 gives for an analysis result — the shape a number wants to
 * be looked at in is a property of the zoom, not of the number.
 *
 * Both builders are pure functions over the wire result. They are here rather
 * than in the card so they can be tested without a DOM, and rather than in the
 * worker because a `FeatureSet` lives on the main thread anyway (a pan must
 * redraw with no round trip) and because the worker should ship coordinates, not
 * a rendering decision about how to bin them.
 */

import type { Contig } from '../genome/assembly'
import { FeatureBuilder } from './featureset'
import type { FeatureSet } from './types'
import type { BinVector, BinVectorContig } from './worker/binVector'
import type { MotifScanResult } from './worker/protocol'

/** How a strand code is spelled in a feature's name and in an exported BED. */
function strandMark(strand: number): string {
  return strand > 0 ? '+' : strand < 0 ? '−' : '±'
}

/**
 * One interval per site.
 *
 * Every site is given a name — the pattern and the strand — rather than left
 * blank, for two reasons that are both about what happens next. A feature with a
 * name is findable by the search box (`annotations/search.ts` scans `name` and
 * `id`), so a reader can jump between sites by typing; and a feature with a name
 * is legible in an exported BED, where a column of empty fourth fields is a file
 * nobody can tell apart from the last one they exported.
 *
 * The `score` column is left `NaN` rather than filled with a 1. A score is a
 * measurement, and an exact match has none — writing a constant there would put
 * a meaningless column into every export and give the lane a numeric axis that
 * says nothing.
 */
export function motifFeatures(result: MotifScanResult, pattern: string): FeatureSet {
  const build = new FeatureBuilder()
  const label = pattern.replace(/\s+/g, '').toUpperCase()
  for (const hit of result.hits) {
    for (let at = 0; at < hit.starts.length; at++) {
      const strand = hit.strands[at]
      build.add(hit.contig, hit.starts[at], hit.ends[at], {
        strand,
        name: `${label} ${strandMark(strand)}`,
      })
    }
  }
  return build.finish()
}

/**
 * A bin size that makes the density picture legible for this genome.
 *
 * Not a fixed number, because the genomes this viewer opens span four orders of
 * magnitude: 1 kb bins are right for yeast and give three million bins for a
 * human assembly, which is a vector nobody can draw and several megabytes to
 * hold. So the target is a bin *count* — enough that a whole-genome lane has
 * more bins than a wide screen has pixels, and not so many that the vector costs
 * more than the scan that filled it — snapped down to a round number a reader
 * can recognise in the lane's tooltip.
 *
 * Exported so the card can show the number it chose. A density track whose bin
 * size is invisible is a track whose values cannot be compared with anything.
 */
export function motifBinsize(total: number): number {
  const TARGET_BINS = 20_000
  const MIN = 100
  const wanted = Math.max(MIN, total / TARGET_BINS)
  // Snap up to 1, 2 or 5 times a power of ten, which is the same ladder the
  // rulers step by — a bin of 2 kb reads as a decision and one of 1,732 bp reads
  // as an accident, even when they are equally arbitrary.
  const decade = 10 ** Math.floor(Math.log10(wanted))
  for (const step of [1, 2, 5, 10]) {
    if (decade * step >= wanted) return decade * step
  }
  return decade * 10
}

/**
 * Sites per bin, over the whole assembly.
 *
 * The grid is laid out from the assembly rather than from the hits, and that is
 * the load-bearing part: a bin with no site in it must come back as **zero**,
 * not as a gap. `NaN` in a `BinVector` means *nothing is known here* and draws
 * as a hole (`worker/binVector.ts`), which for a count is precisely the wrong
 * claim — a stretch with no sites in it is the most informative thing a
 * restriction map has to say, and drawing it as missing data would hide it.
 *
 * A site is counted at its **start**. Counting every bin it touches would double
 * a site that straddles a boundary, and for a motif of a few bases against a bin
 * of a few kilobases the choice is invisible except in that it keeps the total
 * of the vector equal to the number of sites — which is what makes the lane's
 * numbers add up to the count the card reports.
 *
 * Contigs shorter than one bin still get a bin: a metagenome's short contigs are
 * most of its contigs, and a grid that skipped them would shift every later
 * sequence's bins and put the whole genome's sites in the wrong places.
 */
export function motifDensity(
  result: MotifScanResult,
  contigs: readonly Contig[],
  binsize: number,
): BinVector {
  const grid: BinVectorContig[] = []
  let startBin = 0
  for (const contig of contigs) {
    const bins = Math.max(1, Math.ceil(contig.length / binsize))
    grid.push({ name: contig.name, startBin, bins, length: contig.length })
    startBin += bins
  }

  const values = new Float32Array(startBin)
  const at = new Map(grid.map((entry) => [entry.name, entry]))
  for (const hit of result.hits) {
    const home = at.get(hit.contig)
    // A sequence the assembly does not list. It cannot be placed on this grid
    // and is dropped rather than guessed at — the features above still carry it,
    // so nothing is lost that the reader cannot see.
    if (home === undefined) continue
    for (let i = 0; i < hit.starts.length; i++) {
      const bin = Math.min(home.bins - 1, Math.floor(hit.starts[i] / binsize))
      values[home.startBin + bin] += 1
    }
  }
  return { binsize, firstBin: 0, values, contigs: grid }
}

/**
 * What the lane is called.
 *
 * The pattern itself, because that is the one thing the reader will want to
 * check against what they typed, and because two searches in one session are
 * told apart by nothing else. The strand note is there for the same reason: the
 * same pattern searched one way and both ways produces two different answers,
 * and two lanes labelled identically is the state in which somebody draws the
 * wrong conclusion.
 */
export function motifLabel(pattern: string, bothStrands: boolean): string {
  const clean = pattern.replace(/\s+/g, '').toUpperCase()
  return bothStrands ? `${clean} (both strands)` : clean
}
