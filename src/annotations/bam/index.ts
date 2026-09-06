/**
 * BAI and CSI: which bytes hold the reads over a region.
 *
 * ## Why this is not `tabix.ts`
 *
 * It very nearly is. A `.tbi` and a `.bai` are the same binning index with a
 * different header, and `parseTabix` already reads one. What it does with it is
 * the difference, and the difference is the whole of this module.
 *
 * `tabix.ts` collapses every bin of a reference down to **one span per
 * sequence** and throws the low sixteen bits of every virtual offset away. That
 * is the right trade there and its reasoning is written out at
 * `annotations/tabix.ts`: a feature lane holds a whole `FeatureSet` on the main
 * thread and draws whichever part of it is on screen (§8.4), so a finer index
 * would be carried and never asked. A contig's worth of GTF is a few hundred
 * kilobytes.
 *
 * A contig's worth of BAM is not. There is no zoom level to fall back on and no
 * summary layer in the file, so the unit of work has to be the **window**, and
 * a window is what a bin index resolves and a per-sequence span does not. So
 * this keeps what that one discards: bin-level chunks, both halves of every
 * virtual offset, the linear index, and a byte forecast made from all three
 * before a single byte of alignment data is fetched.
 *
 * ## The two formats
 *
 * BAI is the fixed case — 14-bit minimum interval, six levels — and is stored
 * uncompressed. CSI generalises both numbers and is BGZF-compressed like a
 * `.tbi`, which is why {@link parseBamIndex} sniffs rather than trusts the
 * suffix. CSI matters here for one specific reason: **BAI cannot index a
 * reference longer than 2^29 bp**, so any genome with a chromosome past ~512 Mb
 * is CSI or nothing. It is not the metagenomic case — a co-assembly is tens of
 * thousands of *short* contigs and indexes fine under BAI — but it is the human
 * chromosome 1 case, which is a more common thing to point this at.
 *
 * ## The forecast, and why it is the interesting output
 *
 * `chunksFor` answers in compressed byte spans, and their total is knowable
 * before anything is read. That number is what a coverage lane consults to
 * decide whether it can afford a window at all — so a window too deep to draw
 * is refused **from the index**, at zero data cost, rather than by starting a
 * fetch and giving up part-way through it (§12).
 */

import { BGZF_MAX_BLOCK, inflateBgzf, isBgzf } from '../tabix'

/** `BAI\1`. */
const BAI_MAGIC = [0x42, 0x41, 0x49, 0x01]
/** `CSI\1`. */
const CSI_MAGIC = [0x43, 0x53, 0x49, 0x01]

/** BAI's fixed geometry: the smallest bin covers 2^14 bp, over six levels. */
const BAI_MIN_SHIFT = 14
const BAI_DEPTH = 5

/**
 * The bin a BAI reserves for its own statistics rather than for reads.
 *
 * `37450` is one past the last real bin of a six-level index. It holds two
 * "chunks" that are not byte ranges at all — the unmapped-read span, and a pair
 * of counts — so reading it as data would fetch a region of the file chosen by
 * arithmetic on a read count.
 */
const BAI_PSEUDO_BIN = 37450

/** A span of the file, as the index stores it: two virtual offsets. */
export interface Chunk {
  begin: bigint
  end: bigint
}

/** One reference's index. */
export interface RefIndex {
  /** Chunks by bin number. */
  bins: Map<number, Chunk[]>
  /**
   * The linear index: the lowest virtual offset of any record overlapping each
   * 2^`minShift` bp window. BAI only — CSI carries the same information as a
   * `loffset` per bin instead.
   */
  linear: BigUint64Array | null
  /** CSI's per-bin lowest offset, serving the linear index's purpose. */
  loffset: Map<number, bigint> | null
}

export interface BamIndex {
  format: 'bai' | 'csi'
  minShift: number
  depth: number
  refs: RefIndex[]
}

/** `true` when these bytes are a BAI or a (BGZF-wrapped) CSI. */
export function isBamIndex(bytes: Uint8Array): boolean {
  return matches(bytes, BAI_MAGIC) || matches(bytes, CSI_MAGIC) || isBgzf(bytes)
}

function matches(bytes: Uint8Array, magic: number[]): boolean {
  if (bytes.length < magic.length) return false
  return magic.every((byte, index) => bytes[index] === byte)
}

/**
 * Parse a `.bai` or a `.csi`, whichever these bytes are.
 *
 * The index is read whole, which is safe for a CSI and is a real cost for a
 * BAI: one is a bin per populated region, the other is additionally a linear
 * index entry per 16 kb of every reference, so a human WGS `.bai` is single-
 * digit megabytes. That is a one-off on opening the file and it is why §12
 * separates the open cost from the per-window cost rather than holding both to
 * one number.
 */
export async function parseBamIndex(raw: Uint8Array): Promise<BamIndex> {
  // A CSI is BGZF like a `.tbi`; a BAI is stored flat. Deciding by the bytes
  // rather than the suffix costs one comparison and means a `.csi` named `.bai`
  // still opens — which happens, because the two are handed around together.
  const bytes = isBgzf(raw) ? await inflateBgzf(raw) : raw
  if (matches(bytes, CSI_MAGIC)) return parseCsi(bytes)
  if (matches(bytes, BAI_MAGIC)) return parseBai(bytes)
  throw new Error('This is not a BAM index: the magic bytes are neither BAI\\1 nor CSI\\1.')
}

function parseBai(bytes: Uint8Array): BamIndex {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const refCount = view.getInt32(4, true)
  let at = 8
  const refs: RefIndex[] = []
  for (let ref = 0; ref < refCount; ref++) {
    const bins = new Map<number, Chunk[]>()
    const binCount = view.getInt32(at, true)
    at += 4
    for (let b = 0; b < binCount; b++) {
      const bin = view.getUint32(at, true)
      at += 4
      const chunkCount = view.getInt32(at, true)
      at += 4
      const chunks: Chunk[] = []
      for (let c = 0; c < chunkCount; c++) {
        chunks.push({
          begin: view.getBigUint64(at, true),
          end: view.getBigUint64(at + 8, true),
        })
        at += 16
      }
      // Read past it, then drop it: the pseudo-bin's "chunks" are counts.
      if (bin !== BAI_PSEUDO_BIN) bins.set(bin, chunks)
    }
    const intervalCount = view.getInt32(at, true)
    at += 4
    const linear = new BigUint64Array(Math.max(0, intervalCount))
    for (let i = 0; i < intervalCount; i++) {
      linear[i] = view.getBigUint64(at, true)
      at += 8
    }
    refs.push({ bins, linear, loffset: null })
  }
  return { format: 'bai', minShift: BAI_MIN_SHIFT, depth: BAI_DEPTH, refs }
}

function parseCsi(bytes: Uint8Array): BamIndex {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const minShift = view.getInt32(4, true)
  const depth = view.getInt32(8, true)
  const auxBytes = view.getInt32(12, true)
  let at = 16 + auxBytes
  const refCount = view.getInt32(at, true)
  at += 4
  const refs: RefIndex[] = []
  for (let ref = 0; ref < refCount; ref++) {
    const bins = new Map<number, Chunk[]>()
    const loffset = new Map<number, bigint>()
    const binCount = view.getInt32(at, true)
    at += 4
    for (let b = 0; b < binCount; b++) {
      const bin = view.getUint32(at, true)
      at += 4
      loffset.set(bin, view.getBigUint64(at, true))
      at += 8
      const chunkCount = view.getInt32(at, true)
      at += 4
      const chunks: Chunk[] = []
      for (let c = 0; c < chunkCount; c++) {
        chunks.push({
          begin: view.getBigUint64(at, true),
          end: view.getBigUint64(at + 8, true),
        })
        at += 16
      }
      bins.set(bin, chunks)
    }
    refs.push({ bins, linear: null, loffset })
  }
  return { format: 'csi', minShift, depth, refs }
}

/**
 * `value >> bits`, for a `bits` that may reach 32.
 *
 * JavaScript takes a shift count **modulo 32**, so `x >> 32` is `x >> 0` —
 * which is `x`, not zero. That is not a corner case here: htslib chooses a
 * CSI's depth by `for (n_lvls = 0, s = 1 << min_shift; max_len > s; ++n_lvls,
 * s <<= 3)`, so a reference longer than 2^29 bp gets `min_shift 14, depth 6`
 * and the top level's shift is exactly 32 — on precisely the genomes CSI exists
 * for, and the ones this module's own header names.
 *
 * Division rather than a special case, because it is right for every width and
 * a coordinate here is far below 2^53.
 */
function shiftRight(value: number, bits: number): number {
  return Math.floor(value / 2 ** bits)
}

/**
 * Every bin that can hold a record overlapping `[start, end)`.
 *
 * The generalised form, which BAI is the `minShift: 14, depth: 5` case of. Each
 * level of the tree is a contiguous run of bin numbers starting at `offset`,
 * and a region touches a run at every level — so the answer is `depth + 1`
 * ranges rather than a search.
 */
export function reg2bins(
  start: number,
  end: number,
  minShift: number,
  depth: number,
): number[] {
  const out: number[] = []
  const last = Math.max(start, end - 1)
  let shift = minShift + depth * 3
  let offset = 0
  for (let level = 0; level <= depth; level++) {
    const from = offset + shiftRight(start, shift)
    const to = offset + shiftRight(last, shift)
    for (let bin = from; bin <= to; bin++) out.push(bin)
    offset += 1 << (level * 3)
    shift -= 3
  }
  return out
}

/**
 * The lowest virtual offset any record overlapping `start` can be at.
 *
 * This is the whole value of the linear index, and it is what makes a query
 * over a deep file bounded: a bin near the root of the tree holds chunks
 * spanning a whole chromosome, and without this floor a 2 kb window would fetch
 * every one of them. Chunks ending below the floor cannot contain an
 * overlapping record and are dropped.
 *
 * CSI has no linear index, and its `loffset` per bin is the same fact stored
 * per node instead: the lowest offset in the smallest bin containing `start`.
 */
function lowestOffset(ref: RefIndex, start: number, index: BamIndex): bigint {
  if (ref.linear !== null) {
    const slot = shiftRight(start, index.minShift)
    if (ref.linear.length === 0) return 0n
    return ref.linear[Math.min(slot, ref.linear.length - 1)]
  }
  if (ref.loffset === null) return 0n
  // Walk the containing bins from the deepest level up, and take the first that
  // is populated: the deepest is the tightest floor available.
  let shift = index.minShift
  let offset = 0
  for (let level = index.depth; level >= 0; level--) {
    offset = binOffsetOfLevel(level)
    const held = ref.loffset.get(offset + shiftRight(start, shift))
    if (held !== undefined) return held
    shift += 3
  }
  return 0n
}

function binOffsetOfLevel(level: number): number {
  let offset = 0
  for (let l = 0; l < level; l++) offset += 1 << (l * 3)
  return offset
}

/**
 * The offset of the first record that starts at or after `end` — the ceiling.
 *
 * The counterpart to {@link lowestOffset}, and leaving it out is a mistake that
 * is invisible in every content assertion and enormous in the forecast. The
 * linear index prunes chunks *before* a window. Nothing prunes chunks *after*
 * it, and a coarse bin holds records from anywhere in the reference — so a bin
 * one level from the root, holding a handful of reads scattered the length of a
 * chromosome, drags the span for a 10 kb window out to the end of the file.
 * Measured on a small fixture: 1.4 kB of actual records, and a forecast of
 * 371 kB. Every read is correct; the *gate* is not, and a gate that refuses
 * windows it could draw is the whole feature failing quietly.
 *
 * The bound is available because a record goes in the smallest bin that wholly
 * contains it, so every record in a bin starts within that bin's range. A bin
 * whose range begins at or after `end` therefore holds only records that start
 * at or after `end`, none of which can overlap — and since the file is
 * coordinate-sorted, the earliest offset among them is where our records must
 * already have finished.
 *
 * The walk is up to eight bins per level, coarsening as it goes, and it is
 * **best-effort by design**. A record lives in exactly one bin, so a short read
 * far past the query sits in a deep bin no coarse scan will reach, and the walk
 * may find nothing — in which case there is no ceiling and every chunk is a
 * candidate, which is exactly the behaviour before this existed. That is the
 * safe direction: a ceiling that is too *high* costs bytes, and one that is too
 * *low* silently drops reads. Bounded at ~8 × (depth + 1) probes rather than a
 * pass over every populated bin, which on a human chromosome is a hundred
 * thousand of them, per frame.
 */
function highestOffset(ref: RefIndex, end: number, index: BamIndex): bigint {
  let best: bigint | null = null
  let shift = index.minShift
  for (let level = index.depth; level >= 0; level--) {
    const offset = binOffsetOfLevel(level)
    // Bins are numbered consecutively *within* a level and the levels run on
    // from one another, so a scan that walks off the end of one level walks
    // into the next — where bin numbers mean something else entirely. Level 1
    // holds eight bins, 1 to 8, and bin 9 is the first of level 2: reading it
    // as "the ninth bin of level 1" produces a ceiling from a bin that is not
    // after the query at all, and every chunk beyond it is then dropped. That
    // loses reads, silently, and only on a query near the end of a reference.
    const levelBins = 1 << (level * 3)
    const after = shiftRight(Math.max(0, end - 1), shift) + 1
    for (let i = 0; i < 8 && after + i < levelBins; i++) {
      const chunks = ref.bins.get(offset + after + i)
      if (chunks === undefined) continue
      for (const chunk of chunks) {
        if (best === null || chunk.begin < best) best = chunk.begin
      }
    }
    shift += 3
  }
  // Nothing after the query: every chunk found is a candidate, which is what
  // the absence of a ceiling has always meant.
  return best ?? BigInt(Number.MAX_SAFE_INTEGER) << 16n
}

/** A byte range to fetch, in the shape `inflateBgzf` and the sources want. */
export interface ByteSpan {
  from: number
  to: number
  /**
   * Where the last block holding a wanted record begins.
   *
   * The same field, for the same reason, as `tabix.ts`'s `ByteSpan`: a fetch
   * has to over-ask by up to a block because a block's length is not knowable
   * without reading its header, and the decode should not pay for the slack.
   */
  lastBlock: number
  /**
   * Where the first wanted record begins *inside* the first inflated block.
   *
   * The other half of a virtual offset, and the half `tabix.ts` throws away —
   * which is safe there and is not safe here. A BGZF block boundary is not a
   * record boundary: `bgzf_write` copies bytes into a 64 KiB buffer and flushes
   * it when full, so `samtools` splits records across blocks routinely, and any
   * read longer than a block must be split. Starting the walk at inflated
   * offset 0 then begins in the middle of whatever record the previous block
   * ran out on, reads its bytes as a record length, and yields either nothing
   * or garbage — silently, since a nonsense record fails the position filter
   * like any other.
   *
   * Merged spans take the *first* chunk's offset, which is all that is needed:
   * once the walk is aligned to a record it stays aligned, and the extra
   * records between merged chunks are filtered by position like any others.
   */
  dataFrom: number
}

/** How far apart two spans may be before reading across the gap costs more than skipping it. */
const COALESCE_GAP = 1 << 20

/**
 * The byte spans holding every read overlapping `[start, end)` on `refId`.
 *
 * Chunks are pruned against the linear index, sorted, and merged where they
 * touch or come within a megabyte — the same policy, and the same constant, as
 * `tabix.ts`'s `spansFor`, because the sources below read in 1 MiB chunks and a
 * smaller gap costs more to skip than to read across.
 *
 * Returns an empty array for a reference the index does not cover, which is the
 * honest answer for a contig with no reads on it — not an error.
 */
export function chunksFor(
  index: BamIndex,
  refId: number,
  start: number,
  end: number,
  fileSize: number,
): ByteSpan[] {
  const ref = index.refs[refId]
  if (ref === undefined) return []
  const floor = lowestOffset(ref, Math.max(0, start), index)
  const ceiling = highestOffset(ref, Math.max(1, end), index)

  const wanted: Chunk[] = []
  for (const bin of reg2bins(Math.max(0, start), Math.max(1, end), index.minShift, index.depth)) {
    const chunks = ref.bins.get(bin)
    if (chunks === undefined) continue
    // Both ends. A chunk ending before the floor holds nothing that reaches the
    // window; one beginning at or after the ceiling holds nothing that starts
    // before the window ends.
    for (const chunk of chunks) {
      if (chunk.end > floor && chunk.begin < ceiling) wanted.push(chunk)
    }
  }
  if (wanted.length === 0) return []

  wanted.sort((a, b) => (a.begin < b.begin ? -1 : a.begin > b.begin ? 1 : 0))
  const spans: ByteSpan[] = []
  for (const chunk of wanted) {
    // A virtual offset is `(block offset << 16) | offset within the block`.
    // The high 48 bits say which bytes to fetch; the low 16 say where the
    // record actually starts once they are inflated, and both are needed —
    // see {@link ByteSpan.dataFrom}.
    const from = Number(chunk.begin >> 16n)
    const dataFrom = Number(chunk.begin & 0xffffn)
    const lastBlock = Number(chunk.end >> 16n)
    const to = Math.min(fileSize, lastBlock + BGZF_MAX_BLOCK)
    const previous = spans[spans.length - 1]
    if (previous !== undefined && from <= previous.to + COALESCE_GAP) {
      previous.to = Math.max(previous.to, to)
      previous.lastBlock = Math.max(previous.lastBlock, lastBlock)
      // `dataFrom` is *not* widened: it belongs to the span's first block, and
      // the walk from there runs continuously through everything merged in.
    } else {
      spans.push({ from, to, lastBlock, dataFrom })
    }
  }
  return spans
}

/** Compressed bytes these spans would fetch — the forecast §12's gate is spent against. */
export function forecastBytes(spans: readonly ByteSpan[]): number {
  let total = 0
  for (const span of spans) total += span.to - span.from
  return total
}
