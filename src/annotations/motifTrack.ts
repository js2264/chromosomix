/**
 * Turning a motif's coordinates into the two things a reader can look at.
 *
 * `motif.ts` finds the sites and `analysis/run/motif.ts` walks a whole reference
 * with it, gathering three typed arrays per sequence ({@link MotifScanResult}).
 * Neither of those is a lane. This module is the last step, and it is
 * deliberately two steps rather than one, because a set of sites answers two
 * different questions and no single picture answers both:
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
 * Both builders are pure functions over the scan's result. They are here rather
 * than in the runner so they can be tested without a worker, and they are two
 * functions rather than one object because the two lanes they make are adopted
 * by different halves of `analysis/workspace.ts` — a `FeatureSet` goes straight
 * onto an entry, while a vector has to be registered before anything can sample
 * it.
 */

import type { Contig } from '../genome/assembly'
import { FeatureBuilder } from './featureset'
import type { FeatureSet } from './types'
import type { BinVector, BinVectorContig } from './worker/binVector'

/**
 * Where a motif occurs on one sequence: three parallel arrays, not objects.
 *
 * A yeast genome asked for `GATC` answers with about forty thousand sites and a
 * human one with millions, and forty thousand `{start, end, strand}` objects is
 * forty thousand allocations to build and then walk again to bin. Three typed
 * arrays are three buffers. That is the same argument `TrackSampleSet` and
 * `FeatureSet` already make, and the reason this does not simply reuse
 * `MotifHit[]` from `annotations/motif.ts`, which is the shape the matcher finds
 * convenient rather than the shape the consumers below want.
 *
 * It lived in the worker protocol while a `motif` *request* existed to carry it
 * across a thread. Nothing carries it now — the scan and both builders below run
 * in the annotations worker, inside the analysis task (`analysis/run/motif.ts`),
 * and what leaves that thread is a `FeatureSet` and a vector — so it belongs
 * beside the functions that read it rather than in a vocabulary of messages it
 * is no longer one of.
 */
export interface MotifHits {
  contig: string
  /** 0-based, half-open, ascending. */
  starts: Int32Array
  ends: Int32Array
  /** `1` forward, `-1` reverse, `0` for a palindrome searched on both. */
  strands: Int8Array
  /**
   * Positions of each site the pattern does not permit, where the search
   * allowed any; absent for an exact search, whose every site has none.
   */
  mismatches?: Uint8Array
}

/**
 * Every occurrence of a motif in one loaded reference.
 *
 * `truncated` is the half of this that is easy to leave out and must not be: a
 * search stopped by its budget has to say so, or a reader counts the sites in a
 * lane and gets the cap rather than the answer.
 *
 * There is no member for a pattern that would not compile, and that is a
 * decision rather than an omission. "`X` is not a IUPAC base" is a sentence
 * about what the reader typed, and it is said where a reader is looking: by the
 * task's estimate, in front of a greyed-out **Run**, and by the runner as a note
 * on a run that produced nothing (`analysis/run/motif.ts`). Carrying it in the
 * *result* would mean every consumer of one had to check a field that is null on
 * every scan that ever happened.
 */
export interface MotifScanResult {
  hits: MotifHits[]
  /** Sites found, summed over `hits` — the number a reader is told. */
  total: number
  truncated: boolean
}

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
 * The `score` column is left `NaN` rather than filled with a 1 for an exact
 * search. A score is a measurement, and an exact match has none — writing a
 * constant there would put a meaningless column into every export and give the
 * lane a numeric axis that says nothing. A search that **allowed mismatches**
 * has one, and it is the number of them: the column a reader filters on to keep
 * the sites that match the consensus exactly, and the one a BED carries out.
 */
export function motifFeatures(result: MotifScanResult, pattern: string): FeatureSet {
  const build = new FeatureBuilder()
  const label = pattern.replace(/\s+/g, '').toUpperCase()
  for (const hit of result.hits) {
    for (let at = 0; at < hit.starts.length; at++) {
      const strand = hit.strands[at]
      const wrong = hit.mismatches?.[at]
      build.add(hit.contig, hit.starts[at], hit.ends[at], {
        strand,
        name: `${label} ${strandMark(strand)}`,
        ...(wrong === undefined
          ? {}
          : { score: wrong, detail: `${wrong} ${wrong === 1 ? 'mismatch' : 'mismatches'}` }),
      })
    }
  }
  return build.finish()
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
export function motifLabel(pattern: string, bothStrands: boolean, mismatches = 0): string {
  const clean = pattern.replace(/\s+/g, '').toUpperCase()
  const notes = [
    ...(bothStrands ? ['both strands'] : []),
    ...(mismatches > 0 ? [`≤ ${mismatches} ${mismatches === 1 ? 'mismatch' : 'mismatches'}`] : []),
  ]
  return notes.length === 0 ? clean : `${clean} (${notes.join(', ')})`
}
