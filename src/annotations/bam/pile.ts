/**
 * Depth, from the records a window's byte spans turned out to hold.
 *
 * ## What "coverage" is made to mean here
 *
 * Three decisions, and all three are places a viewer can quietly disagree with
 * `samtools depth` and never say so.
 *
 * **`N` is not covered.** A CIGAR `N` is a reference span the read is aligned
 * *across* rather than *over* — an intron, in every file that has one. Counting
 * it as depth draws an RNA-seq gene as a solid block and erases the only thing
 * the picture was for. `D` is counted, because a deletion is a base the read
 * asserts something about.
 *
 * **Secondary and supplementary alignments are excluded by default**, because
 * they are one molecule reported twice and they cluster at repeats and
 * breakpoints — the loci where somebody is reading the number most carefully.
 * Duplicates are *not* excluded by default: marking them is a pipeline's
 * decision, and hiding them silently would make this app disagree with every
 * other reading of the same file. It is a filter, offered rather than assumed.
 *
 * **A bin holds mean depth, not a read count.** The obvious implementation —
 * increment every bin a read touches — reports a 300 bp read as depth 1 across
 * a 10 kb bin, so a lane zoomed out reads an order of magnitude high and does
 * it worst where the data is sparsest. What is accumulated instead is *covered
 * bases per bin divided by bin width*, which is depth at base resolution and
 * stays depth at every other.
 *
 * ## Cost
 *
 * One pass, no allocation per record: the reference intervals of a CIGAR are
 * walked straight out of the buffer, and the whole-bin part of a long interval
 * goes through a difference array rather than a loop, so a read spanning two
 * thousand bins costs two writes rather than two thousand.
 */

import {
  consumesReference,
  DEFAULT_EXCLUDE,
  forEachRecord,
  longCigarOf,
  type RecordCursor,
} from './format'

/** Which records a pass counts. */
export interface PileFilter {
  /** Flag bits that disqualify a record. Defaults to {@link DEFAULT_EXCLUDE}. */
  exclude: number
  /** Records below this mapping quality are skipped. `0` keeps everything. */
  minMapq: number
}

export const DEFAULT_FILTER: PileFilter = { exclude: DEFAULT_EXCLUDE, minMapq: 0 }

export interface CoverageResult {
  /** Mean depth per bin, over the region the caller asked about. */
  depth: Float32Array
  /** Records the pass looked at, whether or not they were counted. */
  total: number
  /** Records that passed the filter and overlapped the region. */
  kept: number
  /** The largest value in {@link depth}; `0` for an empty window. */
  max: number
}

/**
 * Mean depth per bin across `[start, end)` of `refId`.
 *
 * `bytes` is the inflated content of the window's byte spans, which routinely
 * begins part-way through a record and holds reads from before and after the
 * region — the index resolves to blocks, not to coordinates. Everything outside
 * is skipped here rather than in the fetch, because trimming a BGZF block is
 * not a thing a byte range can do.
 */
export function coverageOf(
  bytes: Uint8Array,
  from: number,
  refId: number,
  start: number,
  end: number,
  bins: number,
  filter: PileFilter = DEFAULT_FILTER,
): CoverageResult {
  const span = end - start
  if (bins <= 0 || span <= 0) {
    return { depth: new Float32Array(0), total: 0, kept: 0, max: 0 }
  }
  const binWidth = span / bins
  // `partial` takes the fractional ends of every interval; `whole` is a
  // difference array for the bins an interval covers completely, so a read
  // across a thousand bins costs two writes instead of a thousand.
  const partial = new Float64Array(bins)
  const whole = new Float64Array(bins + 1)
  let total = 0
  let kept = 0

  forEachRecord(bytes, from, (cursor: RecordCursor) => {
    total++
    if (cursor.refId !== refId) return
    if ((cursor.flag & filter.exclude) !== 0) return
    if (cursor.mapq < filter.minMapq) return
    if (cursor.pos < 0 || cursor.end <= start || cursor.pos >= end) return
    kept++
    eachAlignedBlock(bytes, cursor, (blockStart, blockEnd) => {
      const a = Math.max(blockStart, start)
      const b = Math.min(blockEnd, end)
      if (b <= a) return
      addInterval(partial, whole, (a - start) / binWidth, (b - start) / binWidth, bins)
    })
  })

  let running = 0
  let max = 0
  const depth = new Float32Array(bins)
  for (let i = 0; i < bins; i++) {
    running += whole[i]
    const value = running + partial[i]
    depth[i] = value
    if (value > max) max = value
  }
  return { depth, total, kept, max }
}

/**
 * Add `[fa, fb)`, in fractional bin units, to the two accumulators.
 *
 * The value added to a bin is the fraction of that bin the interval covers, so
 * a bin fully spanned gains exactly 1 — which is what makes the prefix sum come
 * out as mean depth rather than as a count of anything.
 */
function addInterval(
  partial: Float64Array,
  whole: Float64Array,
  fa: number,
  fb: number,
  bins: number,
): void {
  const first = Math.min(bins - 1, Math.max(0, Math.floor(fa)))
  const last = Math.min(bins - 1, Math.max(0, Math.ceil(fb) - 1))
  if (last < first) return
  if (first === last) {
    partial[first] += Math.min(fb, first + 1) - Math.max(fa, first)
    return
  }
  partial[first] += first + 1 - Math.max(fa, first)
  partial[last] += Math.min(fb, last + 1) - last
  // Everything strictly between the two ends is covered whole.
  if (last > first + 1) {
    whole[first + 1] += 1
    whole[last] -= 1
  }
}

/**
 * The reference intervals a record actually covers, `N` gaps excluded.
 *
 * Reads the packed CIGAR out of the buffer directly — this runs once per kept
 * record and a typed-array view per record is an allocation per record.
 */
export function eachAlignedBlock(
  bytes: Uint8Array,
  cursor: RecordCursor,
  emit: (start: number, end: number) => void,
): void {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  // A record with more than 65,535 ops keeps `<l_seq>S<ref_len>N` in the record
  // and the truth in a `CG` tag. Measuring the span works either way, because
  // the `N` carries the reference length — but *walking* it does not: the `S`
  // consumes no reference and the `N` is a skip, so a spliced-aware pass emits
  // nothing at all and the read contributes no depth while still being counted.
  const long = longCigarOf(bytes, cursor)
  const ops = long === null ? cursor.cigarOps : long.length
  const opAt = (i: number): number =>
    long === null ? view.getUint32(cursor.cigarAt + i * 4, true) : long[i]

  let at = cursor.pos
  let blockStart = cursor.pos
  let open = false
  for (let i = 0; i < ops; i++) {
    const packed = opAt(i)
    const op = packed & 0xf
    const length = packed >>> 4
    if (op === 3) {
      // `N`: close whatever was open and skip. The one op that makes this a
      // walk rather than a subtraction of the two ends.
      if (open && at > blockStart) emit(blockStart, at)
      open = false
      at += length
      blockStart = at
      continue
    }
    if (consumesReference(op)) {
      if (!open) {
        blockStart = at
        open = true
      }
      at += length
    }
  }
  if (open && at > blockStart) emit(blockStart, at)
}
