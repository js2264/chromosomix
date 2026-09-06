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
  consumesQuery,
  consumesReference,
  DEFAULT_EXCLUDE,
  forEachRecord,
  longCigarOf,
  SEQ_ALPHABET,
  type RecordCursor,
} from './format'
import { BASE_CODE } from '../fasta'

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
  /**
   * The part of {@link depth} that disagrees with the reference, or `null`.
   *
   * Same units and same bins, so `variant[i] / depth[i]` is the non-reference
   * fraction of that bin however wide the bins are. `null` whenever no
   * reference was handed in — which is not the same claim as an array of zeros,
   * and must not draw like one: "nothing disagrees here" and "there is nothing
   * to disagree with" are different sentences (§8.13).
   */
  variant: Float32Array | null
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
  /**
   * Reference residues covering the region, where some FASTA in this session
   * holds them — see {@link eachMismatch}.
   *
   * Absent is the normal case and costs nothing. Present turns on a walk over
   * every *aligned base* rather than over the CIGAR's blocks, which is the one
   * thing in this function that scales with depth × read length, so the caller
   * hands one in only where a bin is narrow enough for "there is a variant
   * here" to name a place (§8.13).
   */
  reference?: { start: number; bases: Uint8Array },
): CoverageResult {
  const span = end - start
  if (bins <= 0 || span <= 0) {
    return { depth: new Float32Array(0), variant: null, total: 0, kept: 0, max: 0 }
  }
  const binWidth = span / bins
  // `partial` takes the fractional ends of every interval; `whole` is a
  // difference array for the bins an interval covers completely, so a read
  // across a thousand bins costs two writes instead of a thousand.
  const partial = new Float64Array(bins)
  const whole = new Float64Array(bins + 1)
  // The disagreeing part, through the same two accumulators — which is what
  // keeps it in the same units as the depth at every bin width. A mismatching
  // base is the interval `[p, p + 1)`, so a bin narrower than a base gets the
  // whole of it and a bin wider than one gets its share.
  const varPartial = reference === undefined ? null : new Float64Array(bins)
  const varWhole = reference === undefined ? null : new Float64Array(bins + 1)
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
    if (reference === undefined || varPartial === null || varWhole === null) return
    eachMismatch(bytes, cursor, reference, (at) => {
      if (at < start || at >= end) return
      addInterval(varPartial, varWhole, (at - start) / binWidth, (at + 1 - start) / binWidth, bins)
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
  let variant: Float32Array | null = null
  if (varPartial !== null && varWhole !== null) {
    variant = new Float32Array(bins)
    let carried = 0
    for (let i = 0; i < bins; i++) {
      carried += varWhole[i]
      variant[i] = carried + varPartial[i]
    }
  }
  return { depth, variant, total, kept, max }
}

/**
 * Every reference position where one record disagrees with the reference.
 *
 * A substitution and a deletion, and nothing else. An insertion has no
 * reference position to be *at* — it sits between two of them — and a soft clip
 * is not aligned, so neither is a disagreement about a base; they are drawn in
 * the pile, where a mark can sit between two columns, and they are silent here.
 * The result is therefore a claim about substitutions and short deletions and
 * is not a variant call (SPECS §8.13's non-features).
 *
 * The CIGAR is walked with a reference cursor *and* a query cursor, because the
 * two only line up between indels: comparing the read's bases against the
 * reference by offset from the start is the standard way to get this wrong, and
 * it is wrong silently — the mismatches simply land a few bases off after the
 * first insertion.
 *
 * `N` advances the reference and emits nothing: the read is aligned across it
 * and asserts nothing about what it skipped, so counting it would report every
 * intron as a variant in every RNA-seq file.
 */
export function eachMismatch(
  bytes: Uint8Array,
  cursor: RecordCursor,
  reference: { start: number; bases: Uint8Array },
  emit: (position: number) => void,
): void {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const long = longCigarOf(bytes, cursor)
  const ops = long === null ? cursor.cigarOps : long.length
  const opAt = (i: number): number =>
    long === null ? view.getUint32(cursor.cigarAt + i * 4, true) : long[i]

  let refPos = cursor.pos
  let queryPos = 0
  for (let i = 0; i < ops; i++) {
    const packed = opAt(i)
    const op = packed & 0xf
    const length = packed >>> 4
    if (op === 2) {
      // `D`: the read spans these and says they are not there, which is the
      // disagreement itself — there is no base to compare.
      for (let k = 0; k < length; k++) emit(refPos + k)
      refPos += length
      continue
    }
    if (consumesReference(op) && consumesQuery(op)) {
      for (let k = 0; k < length; k++) {
        const at = refPos + k - reference.start
        if (at < 0 || at >= reference.bases.length) continue
        const want = BASE_CODE[reference.bases[at]]
        // `N` in either the read or the reference is an absence of information
        // rather than a disagreement, so neither is reported.
        if (want === 4) continue
        const got = baseAt(bytes, cursor.seqAt, queryPos + k)
        if (got !== 4 && got !== want) emit(refPos + k)
      }
      refPos += length
      queryPos += length
      continue
    }
    if (consumesReference(op)) refPos += length
    if (consumesQuery(op)) queryPos += length
  }
}

/** The `BASE_CODE` value of the read's base at `index`, from the packed nibbles. */
function baseAt(bytes: Uint8Array, seqAt: number, index: number): number {
  const byte = bytes[seqAt + (index >> 1)]
  const nibble = index % 2 === 0 ? byte >> 4 : byte & 0xf
  return BASE_CODE[SEQ_ALPHABET.charCodeAt(nibble)]
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
