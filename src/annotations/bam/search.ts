/**
 * Reads without an index: a window of a coordinate-sorted BAM, found by search.
 *
 * ## Why this exists
 *
 * §8.13 read a BAM through its index and nothing else, and refused a file
 * without one by name. That was written for a file dropped from a disk, where
 * `samtools index` is a minute away. It is the wrong answer for the two hosts
 * the store drawer offers most: neither 4DN's open-data bucket nor ENCODE's
 * public bucket publishes a `.bai` beside *any* of its BAMs — measured on
 * 2026-09-14, 9,977 BAMs and not one index object on the first, 144,322 BAM
 * rows and not one index row in the manifest of the second — and a reader of
 * the published site cannot run samtools against a bucket they do not own.
 *
 * What an index gives a region query is a starting *byte*. A coordinate-sorted
 * file gives the same thing more slowly: its records are in (reference,
 * position) order, so the first record at or after a position can be found by
 * **binary search over byte offsets**, each probe a ranged read that inflates
 * a block or two and reads the position of the first whole record in them.
 * A handful of probes bracket a window in a six-gigabyte file — the first
 * guesses interpolate from the position's share of the genome, where halving
 * from the middle takes sixteen — a probe is 128 KiB, the whole search costs
 * less than one BAI download does, and its probes are kept, so the next window
 * over the same file starts from them.
 *
 * ## Finding a record in bytes that were not meant to be entered
 *
 * Two boundaries have to be recovered at an arbitrary offset, and both can be,
 * because both formats say enough about themselves. A BGZF block begins with a
 * gzip header whose extra field carries the block's own compressed size, so the
 * first block at or after an offset is the first `1f 8b 08 04` whose `BC`
 * subfield names a length that lands on another such header, or on the end of
 * the file. An alignment record begins with its own length; a reference id and
 * a position that have to be in range; a name that has to be printable and
 * NUL-terminated at exactly the length the record states; and a size that has
 * to hold what its counts say it holds — and the record those bytes say comes
 * next has to pass the same checks. Two consecutive records agreeing by
 * accident is not something this search will see. Where the buffer ends before
 * the second record, the first is taken on its `bin` field, which the format
 * computes from the position and the CIGAR and {@link reg2bin} recomputes.
 *
 * ## What it cannot do
 *
 * A file that is not coordinate-sorted has no order to search, and a search
 * over one would answer with whatever the probes happened to land on. So the
 * probes are checked against each other — each one's position must lie
 * between its neighbours' — and a file that fails that is refused with the two
 * offsets that disagree ({@link UnsortedError}), which is how a Hi-C pipeline's
 * alignment file, written in read-pair order for its pairs step and never
 * sorted, is told apart from a file that merely lacks a `.bai`. And a window is
 * walked from {@link OVERHANG} before its start rather than from the exact floor
 * a linear index would give, so a read that begins further before the window
 * than that and still reaches into it — a long read, or a spliced one, at the
 * window's edge — is not drawn.
 */

import { BGZF_MAX_BLOCK, blockSize, inflateBgzf } from '../tabix'
import { forEachRecord, referenceLength, type BamHeader, type BamRef } from './format'
import type { ByteSpan } from './index'

/** What a search reads through: the shape both file handles share. */
export interface RangeReader {
  read(length: number, position: number): Promise<Uint8Array>
}

/** Told after every read how many bytes the search has cost so far. */
export type SearchProgress = (bytesRead: number) => void

/** Awaited between probes; throws to abandon a search whose window has moved on. */
export type SearchTick = () => Promise<void>

/** Bytes one probe reads: two whole blocks, so a block start and its successor are in hand. */
export const PROBE_BYTES = 2 * BGZF_MAX_BLOCK

/**
 * Probes land on multiples of this. Two searches a few kilobytes apart —
 * the depth row's window and the pile's padded one — then ask for the same
 * probe, and the second finds it kept or in flight rather than reading it.
 */
const PROBE_GRID = BGZF_MAX_BLOCK

/**
 * How far a probe grows when nothing it read held a whole record and the one
 * after it — a long-read record can outsize a block — before it gives up.
 */
const PROBE_MAX_BYTES = 1 << 20

/**
 * Below this many bytes between the two records bracketing a target, the rest
 * of the search is one read and a walk rather than more probes. Four blocks:
 * a probe's answer can land up to two blocks past the offset it was asked
 * about, so a tighter bound would not always shrink.
 */
const WALK_BELOW = 4 * BGZF_MAX_BLOCK

/**
 * How far before a window's start its walk begins, standing in for the linear
 * index. The BAI's own resolution: its linear index is per 16 kb.
 */
export const OVERHANG = 16_384

/** The largest record the boundary check believes in. Long reads are megabytes; nothing is sixteen. */
const RECORD_MAX_BYTES = 1 << 24

/** The header read's own sizes, for finding the first record behind it. */
const HEADER_FIRST_READ = 1 << 18
const HEADER_MAX_READ = 1 << 24

/** BGZF's fixed header, and the two-byte magic plus method and flags that open it. */
const BGZF_HEADER_BYTES = 18
const BGZF_MAGIC = [0x1f, 0x8b, 0x08, 0x04]

/** Where the fixed prefix ends and `read_name` begins, from the record's length field. */
const NAME_AT = 36

/** A record's place in the file, and where it sorts. */
export interface Placed {
  /** File offset of the BGZF block holding the record's first byte. */
  block: number
  /** Inflated offset of the record's length field inside that block. */
  within: number
  refId: number
  pos: number
  /** {@link keyOf} — the file's own order. */
  key: number
  /**
   * Not a record: the point past which a probe found none. Its `block` is the
   * offset probed, its `key` infinite, and a walk that ends on it runs to the
   * end of the file.
   */
  tail?: true
}

/**
 * Where a record sorts: reference-major, then position, unplaced reads last.
 *
 * `pos + 1` rather than `pos`, so a placed read at `-1` — which the format
 * allows for an unmapped read carrying its mate's reference — keys above
 * nothing on its reference rather than colliding with it.
 */
export function keyOf(refId: number, pos: number): number {
  return refId < 0 ? Number.POSITIVE_INFINITY : refId * 2 ** 32 + pos + 1
}

/**
 * Two probes whose order disagrees with the file's claimed sort.
 *
 * `before` sits earlier in the file than `after` and sorts later — the one
 * observation that proves a file is not coordinate-sorted, which no `@HD` line
 * can take back.
 */
export class UnsortedError extends Error {
  constructor(
    readonly before: Placed,
    readonly after: Placed,
  ) {
    super('The reads are not in coordinate order.')
    this.name = 'UnsortedError'
  }
}

/** `chr5:100,200`, or `unplaced` for a record with no reference. */
export function placeLabel(placed: Placed, refs: readonly BamRef[]): string {
  if (placed.refId < 0) return 'unplaced'
  const name = refs[placed.refId]?.name ?? `reference ${placed.refId}`
  return `${name}:${(placed.pos + 1).toLocaleString('en-US')}`
}

/** The standard six-level bin of `[beg, end)`, for coordinates below 2^29. */
export function reg2bin(beg: number, end: number): number {
  const last = end - 1
  if (beg >> 14 === last >> 14) return ((1 << 15) - 1) / 7 + (beg >> 14)
  if (beg >> 17 === last >> 17) return ((1 << 12) - 1) / 7 + (beg >> 17)
  if (beg >> 20 === last >> 20) return ((1 << 9) - 1) / 7 + (beg >> 20)
  if (beg >> 23 === last >> 23) return ((1 << 6) - 1) / 7 + (beg >> 23)
  if (beg >> 26 === last >> 26) return ((1 << 3) - 1) / 7 + (beg >> 26)
  return 0
}

/**
 * A coordinate-sorted BAM, read by region without an index.
 *
 * One per open file, shared by the two rows a BAM imports as (§8.13), because
 * what it accumulates — the probes — is what makes the second window cheaper
 * than the first.
 */
export class BamSearch {
  /** Every probe so far, by file offset; their keys are non-decreasing or the file is not sorted. */
  private readonly probes: Placed[] = []
  /**
   * Keys already located, exactly. The two rows a BAM imports as ask for the
   * same window one after the other, and a window's end is asked for right
   * after its start — so most locates are repeats, and a repeat costs nothing.
   */
  private readonly answers = new Map<number, Promise<Placed | null>>()
  /** Probes in flight, by offset: the two rows bracket the same targets at the same moment. */
  private readonly probing = new Map<number, Promise<Placed>>()
  /** The last walk's bytes, kept for the locate that lands in the same stretch. */
  private lastWalk: { from: number; to: number; bytes: Uint8Array; blocks: InflatedBlock[] } | null = null
  /** Walks in flight, by stretch, for the same reason the probes are. */
  private readonly walking = new Map<string, Promise<{ from: number; to: number; bytes: Uint8Array; blocks: InflatedBlock[] }>>()
  private bytesRead = 0
  /** The first record of the file, or `null` for a file with none. */
  private first: Placed | null = null
  /** Where each reference begins on one line laid end to end, for guessing where a position is in the file. */
  private readonly lineStart: number[]
  private readonly lineLength: number

  private constructor(
    private readonly handle: RangeReader,
    private readonly size: number,
    private readonly refs: readonly BamRef[],
    private readonly progress: SearchProgress | undefined,
  ) {
    this.lineStart = []
    let at = 0
    for (const ref of refs) {
      this.lineStart.push(at)
      at += Math.max(0, ref.length)
    }
    this.lineLength = at
  }

  /**
   * Open a search over a file whose header has been read.
   *
   * A header that does not claim `SO:coordinate` is not trusted to be sorted
   * and not assumed to be unsorted either: four probes spread over the file
   * are taken at once, and a file whose reads are in any other order — a Hi-C
   * pipeline's, in read-pair order — nearly always fails the check on those
   * alone, before a window is asked for. A header that does claim it is still
   * checked, on every probe the windows themselves make.
   */
  static async open(
    handle: RangeReader,
    size: number,
    header: BamHeader,
    progress?: SearchProgress,
    tick?: SearchTick,
  ): Promise<BamSearch> {
    const search = new BamSearch(handle, size, header.refs, progress)
    search.first = await search.firstRecord(header.recordsFrom)
    if (search.first !== null && header.sortOrder !== 'coordinate') {
      for (const fraction of [0.125, 0.375, 0.625, 0.875]) {
        if (tick !== undefined) await tick()
        await search.probeAt(Math.floor(size * fraction))
      }
    }
    return search
  }

  /** Compressed bytes read by every probe and walk so far. */
  get bytes(): number {
    return this.bytesRead
  }

  /** How many probes are kept. */
  get probeCount(): number {
    return this.probes.length
  }

  /**
   * The one byte span holding every read that overlaps `[start, end)` on
   * `refId` and begins no more than {@link OVERHANG} before it.
   *
   * The same shape `chunksFor` answers from an index, so the two roads out of
   * an open BAM read and walk the answer identically. Empty for a window past
   * the file's last read on that reference, or before its first.
   */
  async spansFor(
    refId: number,
    start: number,
    end: number,
    tick?: SearchTick,
    /**
     * The most compressed bytes the caller will read for this window. Given,
     * a window that is already over it after one probe is answered as *at
     * least that much* rather than located to its end — the caller declines
     * it either way, and the second locate was the dearer half.
     */
    byteCap?: number,
  ): Promise<ByteSpan[]> {
    if (this.first === null || end <= start) return []
    const from = await this.locate(refId, Math.max(0, start - OVERHANG), tick)
    if (from === null || from.key >= keyOf(refId, end)) return []
    if (byteCap !== undefined && from.block + byteCap < this.size) {
      if (tick !== undefined) await tick()
      const gate = await this.probeAt(snapped(from.block + byteCap, from.block))
      if (gate.key < keyOf(refId, end)) {
        const lastBlock = gate.block
        return [{ from: from.block, to: Math.min(this.size, lastBlock + BGZF_MAX_BLOCK), lastBlock, dataFrom: from.within }]
      }
    }
    const to = await this.locate(refId, end, tick)
    const lastBlock = to === null || to.tail === true ? this.size : to.block
    return [
      {
        from: from.block,
        to: Math.min(this.size, lastBlock + BGZF_MAX_BLOCK),
        lastBlock,
        dataFrom: from.within,
      },
    ]
  }

  /**
   * The first record whose key is at or above `key`, or `null` when the file
   * ends before one — a search on the file's order, then a walk.
   *
   * `lo` is always a record known to sort below the target and `hi` one known
   * to sort at or above it (or the end of the file), so the target's first
   * record lies after `lo` and no later than `hi`. The probes already kept
   * narrow that bracket before a byte is read; each new probe halves what is
   * left; and once the bracket is a few blocks wide, one read from `lo` walks
   * to the answer exactly, since `lo` is a record and a walk from a record
   * stays on records.
   */
  private locate(refId: number, pos: number, tick?: SearchTick): Promise<Placed | null> {
    if (this.first === null) return Promise.resolve(null)
    const key = keyOf(refId, pos)
    if (this.first.key >= key) return Promise.resolve(this.first)
    const held = this.answers.get(key)
    if (held !== undefined) return held
    // The promise is what is shared, not the answer: the two rows a BAM
    // imports as ask for one window within a frame of each other, and the
    // second must join the first's search rather than run its own.
    const pending = this.search(refId, pos, tick).then((found) => {
      // A located record is the best probe there is — exact, and at the one
      // place the next window is likeliest to ask about — so it is kept as one.
      if (found !== null && found.tail !== true) this.remember(found, true)
      return found
    })
    this.answers.set(key, pending)
    pending.catch(() => this.answers.delete(key))
    return pending
  }

  /**
   * Narrow the bracket around the target by probing, then walk the rest.
   *
   * The first guesses interpolate: a position's share of the genome laid end
   * to end is, for a file whose reads are spread over it, about its share of
   * the file's bytes, and that lands within a few blocks of the target where
   * halving from the middle takes fifteen probes. Interpolation is kept only
   * while it pays — a guess that left more than half the bracket standing
   * hands the next step to the bisection, which is what bounds a file whose
   * reads are all on one chromosome.
   */
  private async search(refId: number, pos: number, tick?: SearchTick): Promise<Placed | null> {
    if (this.first === null) return null
    const key = keyOf(refId, pos)
    let lo: Placed = this.first
    let hi: Placed | null = null
    for (const probe of this.probes) {
      if (probe.key < key) lo = probe
      else {
        hi = probe
        break
      }
    }
    let interpolate = true
    for (;;) {
      const hiBlock = hi === null ? this.size : hi.block
      const span = hiBlock - lo.block
      if (span <= WALK_BELOW) break
      if (tick !== undefined) await tick()
      const guess = interpolate ? this.guess(lo, hi, refId, pos) : null
      const probe = await this.probeAt(snapped(guess ?? Math.floor((lo.block + hiBlock) / 2), lo.block))
      // A probe that had to grow past the bracket — a record longer than the
      // gap — cannot narrow it; the walk from `lo` covers the rest.
      if (probe.block >= hiBlock) break
      if (probe.key >= key) hi = probe
      else lo = probe
      interpolate = (hi === null ? this.size : hi.block) - lo.block <= span / 2
    }
    const walkTo = hi === null || hi.tail === true ? this.size : Math.min(this.size, hi.block + BGZF_MAX_BLOCK)
    return this.walk(lo, walkTo, key)
  }

  /** Where a position on one line of the genome is. */
  private lineOf(refId: number, pos: number): number {
    return (this.lineStart[refId] ?? this.lineLength) + Math.max(0, pos)
  }

  /**
   * The offset to probe for the target, by its share of the bracket's stretch
   * of genome — or `null` where the bracket gives nothing to go on.
   */
  private guess(lo: Placed, hi: Placed | null, refId: number, pos: number): number | null {
    const target = this.lineOf(refId, pos)
    const loLine = this.lineOf(lo.refId, lo.pos)
    const hiLine = hi === null || hi.tail === true || hi.refId < 0 ? this.lineLength : this.lineOf(hi.refId, hi.pos)
    if (hiLine <= loLine) return null
    const fraction = (target - loLine) / (hiLine - loLine)
    if (!(fraction > 0 && fraction < 1)) return null
    const hiBlock = hi === null ? this.size : hi.block
    const mid = lo.block + Math.floor(fraction * (hiBlock - lo.block))
    // Inside the bracket with room to land: a probe answers from the first
    // block at or after it, and one answering from `hi`'s own block says nothing.
    return Math.min(Math.max(mid, lo.block + 1), hiBlock - 2 * BGZF_MAX_BLOCK)
  }

  /** Read from a known record to `to`, and hand back the first record keyed at or above `key`. */
  private async walk(from: Placed, to: number, key: number): Promise<Placed | null> {
    if (to <= from.block) return null
    let held = this.lastWalk
    if (held === null || from.block < held.from || to > held.to) {
      const stretch = `${from.block}-${to}`
      let pending = this.walking.get(stretch)
      if (pending === undefined) {
        pending = this.read(to - from.block, from.block).then(async (buffer) => {
          const { bytes, blocks } = await inflateWithTable(buffer, from.block)
          return { from: from.block, to, bytes, blocks }
        })
        this.walking.set(stretch, pending)
        const done = (): void => {
          this.walking.delete(stretch)
        }
        pending.then(done, done)
      }
      held = await pending
      this.lastWalk = held
    }
    const { bytes, blocks } = held
    const start = blocks.find((block) => block.fileAt === from.block)
    // A record's block is always a block the walk inflated whole, since a walk
    // begins at a record's own block; a stretch this cache does not hold from
    // that block on is read afresh above.
    if (start === undefined) {
      this.lastWalk = null
      return this.walk(from, to, key)
    }
    let found: Placed | null = null
    forEachRecord(bytes, start.from + from.within, (cursor) => {
      const k = keyOf(cursor.refId, cursor.pos)
      if (k < key) return true
      found = placedAt(blocks, cursor.at - 4, cursor.refId, cursor.pos)
      return false
    })
    return found
  }

  /**
   * The first whole record at or after byte `at`, remembered; a
   * {@link Placed.tail} when there is none between `at` and the end.
   *
   * Grows its read when what it fetched holds no record it can confirm — a
   * record needs its successor's prefix in hand, or its own CIGAR for the bin
   * check — and gives up at {@link PROBE_MAX_BYTES}, which no alignment record
   * this side of a chromosome-length read approaches.
   */
  private probeAt(at: number): Promise<Placed> {
    const held = this.probing.get(at)
    if (held !== undefined) return held
    const pending = this.probe(at)
    this.probing.set(at, pending)
    const done = (): void => {
      this.probing.delete(at)
    }
    pending.then(done, done)
    return pending
  }

  private async probe(at: number): Promise<Placed> {
    let length = PROBE_BYTES
    for (;;) {
      const to = Math.min(this.size, at + length)
      if (to <= at) return this.remember({ block: at, within: 0, refId: -1, pos: -1, key: Number.POSITIVE_INFINITY, tail: true })
      const buffer = await this.read(to - at, at)
      const found = await recordIn(buffer, at, this.refs, this.size)
      if (found.kind === 'record') return this.remember(found.placed)
      if (found.kind === 'end' || to >= this.size) {
        return this.remember({ block: at, within: 0, refId: -1, pos: -1, key: Number.POSITIVE_INFINITY, tail: true })
      }
      if (length >= PROBE_MAX_BYTES) {
        throw new Error(
          `no alignment record could be made out within ${PROBE_MAX_BYTES >> 20} MB of byte ${at.toLocaleString('en-US')}`,
        )
      }
      length *= 4
    }
  }

  /**
   * Keep a probe, in file order, and hold it to the order the file claims.
   *
   * The check is against both neighbours because a probe can land between two
   * earlier ones. A tail sorts above everything, and only tails can follow one.
   */
  private remember(placed: Placed, quiet = false): Placed {
    let index = this.probes.length
    while (index > 0 && this.probes[index - 1].block > placed.block) index--
    const twin = this.probes[index - 1]
    if (twin !== undefined && twin.block === placed.block && twin.within === placed.within) return twin
    if (quiet) {
      this.probes.splice(index, 0, placed)
      return placed
    }
    const before = index === 0 ? this.first : this.probes[index - 1]
    const after = index < this.probes.length ? this.probes[index] : null
    if (before !== null && before.key > placed.key) throw new UnsortedError(before, placed)
    if (after !== null && placed.key > after.key) throw new UnsortedError(placed, after)
    this.probes.splice(index, 0, placed)
    return placed
  }

  /**
   * Where the first record is, from where the header said it begins.
   *
   * The header parse answers in inflated bytes; a probe needs a block and an
   * offset inside it. So the header's blocks are walked again, by their stated
   * sizes, until the one holding that offset — growing the read the way the
   * header read grows, for the same reference table that made it grow.
   */
  private async firstRecord(recordsFrom: number): Promise<Placed | null> {
    let length = HEADER_FIRST_READ
    for (;;) {
      const buffer = await this.read(Math.min(length, this.size), 0)
      let at = 0
      let inflated = 0
      while (at + BGZF_HEADER_BYTES <= buffer.length) {
        const size = blockSize(buffer.subarray(at, Math.min(at + 64, buffer.length)))
        if (size === null || at + size > buffer.length) break
        const isize = readUint32(buffer, at + size - 4)
        if (recordsFrom < inflated + isize) {
          // The record begins in this block. Its first bytes may run into the
          // next, so inflate what is in hand from here and read it whole.
          const { bytes, blocks } = await inflateWithTable(buffer.subarray(at), at)
          const within = recordsFrom - inflated
          if (within + NAME_AT > bytes.length) {
            // The record's prefix is not in hand: a file that ends here has no
            // records, and one that goes on needs a longer read.
            if (buffer.length >= this.size) return null
            break
          }
          if (!plausibleAt(bytes, within, this.refs)) {
            throw new Error('the first alignment record is not where the header says it begins')
          }
          const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
          return placedAt(blocks, within, view.getInt32(within + 4, true), view.getInt32(within + 8, true))
        }
        inflated += isize
        at += size
      }
      if (buffer.length >= this.size) return null
      if (length >= HEADER_MAX_READ) {
        throw new Error('the header does not end within the first 16 MB')
      }
      length *= 4
    }
  }

  private async read(length: number, position: number): Promise<Uint8Array> {
    const bytes = await this.handle.read(length, position)
    this.bytesRead += bytes.length
    if (this.progress !== undefined) this.progress(this.bytesRead)
    return bytes
  }
}

// ---------------------------------------------------------------------------
// Blocks
// ---------------------------------------------------------------------------

/** One inflated block: where it came from, and where its bytes sit in the inflated whole. */
interface InflatedBlock {
  fileAt: number
  from: number
  to: number
}

/**
 * Inflate every whole block in `buffer`, keeping the table `inflateBgzf`
 * throws away — because a record found in the inflated bytes has to be named
 * by the block it started in and its offset inside it, which is the pair a
 * virtual offset is made of.
 */
async function inflateWithTable(
  buffer: Uint8Array,
  fileAt: number,
): Promise<{ bytes: Uint8Array; blocks: InflatedBlock[]; sawEnd: boolean }> {
  const parts: Uint8Array[] = []
  const blocks: InflatedBlock[] = []
  let total = 0
  let at = 0
  let sawEnd = false
  while (at + BGZF_HEADER_BYTES <= buffer.length) {
    const size = blockSize(buffer.subarray(at, Math.min(at + 64, buffer.length)))
    if (size === null || at + size > buffer.length) break
    const inflated = await inflateBgzf(buffer.subarray(at, at + size), 0)
    if (inflated.length === 0) sawEnd = true
    blocks.push({ fileAt: fileAt + at, from: total, to: total + inflated.length })
    parts.push(inflated)
    total += inflated.length
    at += size
  }
  const bytes = new Uint8Array(total)
  let offset = 0
  for (const part of parts) {
    bytes.set(part, offset)
    offset += part.length
  }
  return { bytes, blocks, sawEnd }
}

/** The block an inflated offset falls in, and the record's place from it. */
function placedAt(blocks: readonly InflatedBlock[], offset: number, refId: number, pos: number): Placed {
  for (const block of blocks) {
    if (offset >= block.from && offset < block.to) {
      return { block: block.fileAt, within: offset - block.from, refId, pos, key: keyOf(refId, pos) }
    }
  }
  // Only an offset at the very end of the inflated bytes, which no whole
  // record occupies; the last block claims it so the caller has an answer.
  const last = blocks[blocks.length - 1]
  return { block: last.fileAt, within: offset - last.from, refId, pos, key: keyOf(refId, pos) }
}

/**
 * The first BGZF block that begins at or after the start of `buffer`.
 *
 * A header is believed when its `BC` size lands on another header, or on the
 * end of the file: the four magic bytes recur inside compressed data often
 * enough that a length check alone would be fooled a few times a gigabyte.
 * `'more'` when a candidate's successor lies past the buffer.
 */
function blockStartIn(buffer: Uint8Array, fileAt: number, fileSize: number): number | 'more' {
  for (let i = 0; i + BGZF_HEADER_BYTES <= buffer.length; i++) {
    if (
      buffer[i] !== BGZF_MAGIC[0] ||
      buffer[i + 1] !== BGZF_MAGIC[1] ||
      buffer[i + 2] !== BGZF_MAGIC[2] ||
      buffer[i + 3] !== BGZF_MAGIC[3]
    ) {
      continue
    }
    const size = blockSize(buffer.subarray(i, Math.min(i + 64, buffer.length)))
    if (size === null || size > BGZF_MAX_BLOCK || size < BGZF_HEADER_BYTES + 8) continue
    const next = i + size
    if (next > buffer.length) {
      if (fileAt + next === fileSize) return i
      return 'more'
    }
    if (readUint32(buffer, next - 4) > BGZF_MAX_BLOCK) continue
    if (fileAt + next === fileSize) return i
    if (next + 3 <= buffer.length) {
      if (buffer[next] === BGZF_MAGIC[0] && buffer[next + 1] === BGZF_MAGIC[1] && buffer[next + 2] === BGZF_MAGIC[2]) return i
      continue
    }
    return 'more'
  }
  return 'more'
}

// ---------------------------------------------------------------------------
// Records
// ---------------------------------------------------------------------------

type Found = { kind: 'record'; placed: Placed } | { kind: 'more' } | { kind: 'end' }

/** The first confirmable record in the blocks at or after `fileAt`. */
async function recordIn(
  buffer: Uint8Array,
  fileAt: number,
  refs: readonly BamRef[],
  fileSize: number,
): Promise<Found> {
  const start = blockStartIn(buffer, fileAt, fileSize)
  if (start === 'more') return fileAt + buffer.length >= fileSize ? { kind: 'end' } : { kind: 'more' }
  const { bytes, blocks, sawEnd } = await inflateWithTable(buffer.subarray(start), fileAt + start)
  if (bytes.length === 0) return sawEnd || fileAt + buffer.length >= fileSize ? { kind: 'end' } : { kind: 'more' }
  const at = boundaryIn(bytes, refs)
  if (at >= 0) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    return { kind: 'record', placed: placedAt(blocks, at, view.getInt32(at + 4, true), view.getInt32(at + 8, true)) }
  }
  return sawEnd || fileAt + buffer.length >= fileSize ? { kind: 'end' } : { kind: 'more' }
}

/**
 * The offset of the first record in `bytes` that can be confirmed.
 *
 * Confirmed by its successor where the successor's prefix is in hand, and by
 * its own `bin` field where it is not — the last record of a file, or one that
 * runs off the buffer.
 */
export function boundaryIn(bytes: Uint8Array, refs: readonly BamRef[]): number {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  for (let at = 0; at + NAME_AT <= bytes.length; at++) {
    if (!plausibleAt(bytes, at, refs, view)) continue
    const next = at + 4 + view.getInt32(at, true)
    if (next + NAME_AT <= bytes.length) {
      if (plausibleAt(bytes, next, refs, view)) return at
      continue
    }
    if (binMatches(bytes, at, view)) return at
  }
  return -1
}

/**
 * Whether the bytes at `at` could be the start of an alignment record.
 *
 * Every fixed field is held to its range and the name to its length and its
 * alphabet, which is what the format itself guarantees about a record and
 * nothing more; the pairing of two of these in a row is what makes the answer
 * certain.
 */
export function plausibleAt(
  bytes: Uint8Array,
  at: number,
  refs: readonly BamRef[],
  view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength),
): boolean {
  if (at + NAME_AT > bytes.length) return false
  const size = view.getInt32(at, true)
  if (size < 32 || size > RECORD_MAX_BYTES) return false
  const refId = view.getInt32(at + 4, true)
  if (refId < -1 || refId >= refs.length) return false
  const pos = view.getInt32(at + 8, true)
  if (pos < -1) return false
  if (refId >= 0 && pos > refs[refId].length) return false
  const nameBytes = bytes[at + 12]
  if (nameBytes < 1) return false
  const cigarOps = view.getUint16(at + 16, true)
  const seqLength = view.getInt32(at + 20, true)
  if (seqLength < 0) return false
  const nextRefId = view.getInt32(at + 24, true)
  if (nextRefId < -1 || nextRefId >= refs.length) return false
  if (view.getInt32(at + 28, true) < -1) return false
  if (32 + nameBytes + cigarOps * 4 + ((seqLength + 1) >> 1) + seqLength > size) return false
  const nameFrom = at + NAME_AT
  const nameTo = nameFrom + nameBytes
  if (nameTo > bytes.length) return false
  if (bytes[nameTo - 1] !== 0) return false
  for (let i = nameFrom; i < nameTo - 1; i++) {
    const byte = bytes[i]
    if (byte < 0x21 || byte > 0x7e) return false
  }
  return true
}

/** Whether a plausible record's `bin` is the bin its position and CIGAR give it. */
function binMatches(bytes: Uint8Array, at: number, view: DataView): boolean {
  const pos = view.getInt32(at + 8, true)
  if (pos < 0 || pos >= 1 << 29) return false
  const cigarAt = at + NAME_AT + bytes[at + 12]
  const cigarOps = view.getUint16(at + 16, true)
  if (cigarAt + cigarOps * 4 > bytes.length) return false
  const end = pos + referenceLength(view, cigarAt, cigarOps)
  return view.getUint16(at + 14, true) === reg2bin(pos, Math.max(end, pos + 1))
}

/** `at` on the probe grid, unless that would put it at or before `floor`. */
function snapped(at: number, floor: number): number {
  const down = at - (at % PROBE_GRID)
  return down > floor ? down : at
}

function readUint32(bytes: Uint8Array, at: number): number {
  return (bytes[at] | (bytes[at + 1] << 8) | (bytes[at + 2] << 16) | (bytes[at + 3] << 24)) >>> 0
}
