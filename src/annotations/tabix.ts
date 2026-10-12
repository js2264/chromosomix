/**
 * BGZF and tabix: reading part of a feature file instead of all of it.
 *
 * ## The gap this closes
 *
 * Every other read in this application is bounded. HDF5 is read through range
 * requests, a bigWig picks a zoom level and fetches the blocks under the window,
 * a `.hic` fetches the blocks its rectangle covers — and then a GTF is
 * downloaded whole and parsed. The demo file is 9.5 MB over 41,566 lines and
 * that is tolerable; GENCODE is five times that and RefSeq more, and on a hotel
 * connection the difference between "the app supports GTF" and "the app is
 * usable with a human annotation" is entirely this module.
 *
 * A `.gz` with a `.tbi` beside it is the standard answer and has been for
 * fifteen years, so nothing new is being invented or asked of anybody. It is
 * **opportunistic in exactly §3.4's sense**: a plain GTF still works, a
 * bgzipped one with no index still works, and the index only ever makes the
 * same file cheaper.
 *
 * ## What is read, and what is deliberately over-read
 *
 * Tabix indexes to a *region*, and this reads to a **contig**. That is a
 * deliberate simplification and it is the right one here: the app's feature
 * lanes hold a whole `FeatureSet` on the main thread and draw whichever part of
 * it is on screen (§8.4), so a region-served track would need a second
 * lifecycle — a fetch per pan — for a saving that only appears on a file large
 * enough that the whole-contig slice is still small. What the index buys, and
 * what actually matters, is *not reading the other twenty-three chromosomes*.
 *
 * So the unit is: the byte span holding one sequence's records, found from the
 * index without reading anything else, and inflated. On GENCODE against a map of
 * one chromosome that is about a twentieth of the file.
 *
 * ## Why this is written here
 *
 * `@gmod/tabix` exists and is good. The argument against depending on it is the
 * one `hic/format.ts` makes at length and will not repeat: every read in this
 * app goes through a source that counts its requests, caches its chunks and
 * signs them where a bucket needs it, and a parser that fetches for itself sits
 * outside all three. The format is two structures and three hundred lines.
 */

import { NameIndex } from '../genome/naming'
import { inflateMember } from '../pairs/stream'
import { TEXT_INFLATE_MAX, inflatedPast } from '../sources/untrusted'

/** A BGZF member header is always at least this long. */
const BGZF_HEADER_BYTES = 12

/** No BGZF block exceeds 64 KiB compressed; the format guarantees it. */
export const BGZF_MAX_BLOCK = 1 << 16

/**
 * Whether these bytes begin a BGZF member rather than a plain gzip one.
 *
 * gzip magic, then the `FEXTRA` flag, then a `BC` subfield in the extra field.
 * A plain `.gz` has the first and not the others, and must keep working — which
 * is why this is a *test* and not an assumption: a file that fails it goes down
 * the whole-file path it always did.
 */
export function isBgzf(bytes: Uint8Array): boolean {
  if (bytes.length < BGZF_HEADER_BYTES) return false
  if (bytes[0] !== 0x1f || bytes[1] !== 0x8b || bytes[2] !== 8) return false
  if ((bytes[3] & 4) === 0) return false
  return blockSize(bytes) !== null
}

/**
 * The total size of the BGZF block starting at `bytes[0]`, or `null`.
 *
 * `BSIZE` is stored as *total block size minus one*, which is the single most
 * common off-by-one in the format.
 */
export function blockSize(bytes: Uint8Array): number | null {
  if (bytes.length < BGZF_HEADER_BYTES) return null
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const extraLength = view.getUint16(10, true)
  let at = 12
  const end = Math.min(12 + extraLength, bytes.length)
  while (at + 4 <= end) {
    const si1 = bytes[at]
    const si2 = bytes[at + 1]
    const length = view.getUint16(at + 2, true)
    if (si1 === 66 && si2 === 67 && length === 2) {
      return view.getUint16(at + 4, true) + 1
    }
    at += 4 + length
  }
  return null
}

/**
 * Inflate one BGZF block's deflate payload.
 *
 * Delegated to `pairs/stream.ts`, which takes the writer and reader off the
 * `DecompressionStream` directly instead of going through a `Blob` and a
 * `Response`. That is not a tidy-up: measured in Chromium over 433 members, the
 * `Blob` spelling this used to be runs at **34 MB/s** and the delegate at
 * **260 MB/s**. Three objects per 64 KiB block is most of what a GTF span costs
 * to inflate.
 */
const inflateRaw = inflateMember

/**
 * Inflate every whole BGZF block in `bytes`, concatenated.
 *
 * A trailing partial block is ignored rather than fatal: the caller reads a byte
 * span sized from the index plus a block's worth of slack, so the last thing in
 * the buffer is routinely half a block that belongs to the next sequence.
 *
 * `lastBlockStart` is where that slack stops being wanted, and it is the
 * difference between a bounded read and a bounded *request*. A span ends at the
 * start of the last block holding a record, and the block's own length is not
 * knowable without reading its header — so the fetch has to over-ask by up to
 * 64 KiB. Decoding all of that too is what makes a one-sequence read hand back
 * the four sequences that happened to follow it: cheap on a file whose blocks
 * are large, and on a densely packed one it is most of the rest of the file.
 * Given the offset, inflation stops after the block that begins at it.
 *
 * Each member is held to BGZF's own 64 KiB, and the whole to `maxBytes` (§10):
 * a member is at most 64 KiB inflated but can be as little as ninety bytes
 * compressed, so a span of them can stand for seven hundred times its size.
 * The default is the text ceiling — every caller that decodes a span to text
 * cannot use more, and an index or a window of a BAM is far less — and a
 * caller keeping bytes it can use more of passes its own.
 */
export async function inflateBgzf(
  bytes: Uint8Array,
  lastBlockStart = Number.POSITIVE_INFINITY,
  maxBytes = TEXT_INFLATE_MAX,
): Promise<Uint8Array> {
  const parts: Uint8Array[] = []
  let total = 0
  let at = 0
  while (at + BGZF_HEADER_BYTES <= bytes.length) {
    const beganAt = at
    const size = blockSize(bytes.subarray(at, Math.min(at + 64, bytes.length)))
    if (size === null || at + size > bytes.length) break
    const view = new DataView(bytes.buffer, bytes.byteOffset + at, size)
    const extraLength = view.getUint16(10, true)
    const dataFrom = at + 12 + extraLength
    // The deflate payload sits between the header and the eight-byte trailer
    // (CRC32 then ISIZE). An empty block — which is how a bgzipped file marks
    // its end — has a payload of two bytes and inflates to nothing.
    const dataTo = at + size - 8
    if (dataTo > dataFrom) {
      const inflated = await inflateRaw(bytes.subarray(dataFrom, dataTo))
      if (inflated.length > 0) {
        if (total + inflated.length > maxBytes) {
          throw inflatedPast({ format: 'BGZF file', field: 'span read' }, maxBytes, bytes.length)
        }
        parts.push(inflated)
        total += inflated.length
      }
    }
    at += size
    if (beganAt >= lastBlockStart) break
  }
  const out = new Uint8Array(total)
  let offset = 0
  for (const part of parts) {
    out.set(part, offset)
    offset += part.length
  }
  return out
}

/** Where one sequence's records live, as compressed byte offsets. */
export interface RefSpan {
  /** First BGZF block holding a record for this sequence. */
  from: number
  /** Byte offset of the last block holding one; the block itself extends past it. */
  to: number
}

export interface TabixIndex {
  /** Sequence names, in the index's own order. */
  names: string[]
  /** Byte span per sequence, keyed by name. Absent for a sequence with no records. */
  spans: Map<string, RefSpan>
  /** The column layout the index was built for; `2` is SAM, `0` generic. */
  format: number
  /** The comment character records are skipped by. */
  meta: string
  /** Header lines to skip. */
  skip: number
}

/**
 * Parse a `.tbi`.
 *
 * The file is itself BGZF, so it is inflated whole first — which is safe
 * because a tabix index is small by construction: it is one entry per populated
 * bin, and GENCODE's is under a megabyte.
 *
 * What is kept is deliberately less than what is read. The bin index gives
 * chunk-level resolution and this collapses it to one span per sequence, for the
 * reason in the module head: the unit of work above is a contig, so a finer
 * index would be carried and never asked.
 */
export function parseTabix(inflated: Uint8Array): TabixIndex {
  const view = new DataView(inflated.buffer, inflated.byteOffset, inflated.byteLength)
  if (
    inflated.length < 36 ||
    inflated[0] !== 0x54 ||
    inflated[1] !== 0x42 ||
    inflated[2] !== 0x49 ||
    inflated[3] !== 1
  ) {
    throw new Error('This is not a tabix index: the magic bytes are not TBI\\1.')
  }
  const nRef = view.getInt32(4, true)
  const format = view.getInt32(8, true)
  const meta = String.fromCharCode(view.getInt32(24, true))
  const skip = view.getInt32(28, true)
  const nameBytes = view.getInt32(32, true)

  const names: string[] = []
  const raw = new TextDecoder().decode(inflated.subarray(36, 36 + nameBytes))
  for (const name of raw.split('\0')) if (name !== '') names.push(name)

  let at = 36 + nameBytes
  const spans = new Map<string, RefSpan>()
  for (let ref = 0; ref < nRef; ref++) {
    const nBin = view.getInt32(at, true)
    at += 4
    let from = Number.POSITIVE_INFINITY
    let to = Number.NEGATIVE_INFINITY
    for (let b = 0; b < nBin; b++) {
      // The bin number itself is not needed: every chunk of every bin belongs to
      // this sequence, and the span is their union.
      at += 4
      const nChunk = view.getInt32(at, true)
      at += 4
      for (let c = 0; c < nChunk; c++) {
        // A virtual offset is `(block start << 16) | offset within block`. The
        // high 48 bits are the only part that matters here, and they must be
        // read as a BigInt: the block offset alone exceeds 2^32 on any file past
        // four gigabytes, and `getUint32` pairs would silently wrap.
        const begin = Number(view.getBigUint64(at, true) >> 16n)
        const end = Number(view.getBigUint64(at + 8, true) >> 16n)
        at += 16
        if (begin < from) from = begin
        if (end > to) to = end
      }
    }
    const nIntv = view.getInt32(at, true)
    at += 4
    for (let i = 0; i < nIntv; i++) {
      const offset = Number(view.getBigUint64(at, true) >> 16n)
      at += 8
      // The linear index only ever *lowers* the start: it points at the first
      // block that can hold a record overlapping each 16 kb window, and a bin's
      // chunks may begin later than the earliest of those.
      if (offset > 0 && offset < from) from = offset
    }
    if (Number.isFinite(from) && Number.isFinite(to) && ref < names.length) {
      spans.set(names[ref], { from, to })
    }
  }
  return { names, spans, format, meta, skip }
}

/** A byte range to read, merged across the sequences asked for. */
export interface ByteSpan {
  from: number
  to: number
  /**
   * Where the last block holding a wanted record begins.
   *
   * Between this and {@link to} is slack the fetch could not avoid and the
   * decode should not pay for — see {@link inflateBgzf}.
   */
  lastBlock: number
}

/**
 * The byte spans covering `wanted`, merged where they touch.
 *
 * Merged because the sequences of a sorted file are contiguous, so asking for
 * ten of them is one range request rather than ten — and because the sources
 * read in 1 MiB chunks, so a gap smaller than that costs more to skip than to
 * read across. The same argument `CoolerStore.pixelBandsOf` makes about pixel
 * bands, for the same reason.
 */
export function spansFor(
  index: TabixIndex,
  wanted: readonly string[],
  fileSize: number,
): ByteSpan[] {
  const spans: ByteSpan[] = []
  for (const name of wanted) {
    const span = index.spans.get(name)
    if (span === undefined) continue
    // `to` names the *start* of the last block holding a record, so the block
    // itself has to be read past it. A block is at most 64 KiB.
    spans.push({
      from: span.from,
      to: Math.min(fileSize, span.to + BGZF_MAX_BLOCK),
      lastBlock: span.to,
    })
  }
  spans.sort((a, b) => a.from - b.from)
  const merged: ByteSpan[] = []
  for (const span of spans) {
    const last = merged[merged.length - 1]
    if (last !== undefined && span.from <= last.to + (1 << 20)) {
      last.to = Math.max(last.to, span.to)
      last.lastBlock = Math.max(last.lastBlock, span.lastBlock)
    } else {
      merged.push({ ...span })
    }
  }
  return merged
}

/**
 * The names in `index` that also appear in `wanted`, under any convention.
 *
 * This used to strip a `chr` prefix and compare, which covered the commonest
 * disagreement and none of the others — a UCSC-indexed GTF against a yeast
 * cooler numbering its chromosomes `01`…`16` matched nothing and fell through
 * to reading the whole file. {@link NameIndex} is the same question asked
 * properly (§5.9), and getting it right here is worth more than elsewhere: the
 * answer decides *which bytes are fetched*, so a name that fails to match costs
 * a whole-file read of a file the sidecar existed to avoid reading.
 */
export function matchNames(index: TabixIndex, wanted: readonly string[]): string[] {
  if (wanted.length === 0) return index.names
  const held = NameIndex.ofNames(index.names)
  const out = new Set<string>()
  for (const name of wanted) {
    const match = held.find(name)
    if (match !== null) out.add(match.name)
  }
  // Nothing in common is not "read nothing" — it is a file about another
  // assembly, and the caller's overlap report is what should say so. Reading it
  // whole is what would have happened without an index at all.
  return out.size === 0 ? index.names : [...out]
}
