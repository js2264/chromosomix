/**
 * `.2bit`: UCSC's packed sequence format, read by byte range.
 *
 * ## Why it is worth a reader when `.fai` already exists
 *
 * §8.8 already reads a FASTA by range, given a `.fai` beside it, so the claim
 * here is not "random access" — the app has that. It is three other things.
 *
 * **It is one file.** A ranged FASTA is two, and the second one is the one
 * people forget to publish. Every failure mode of §8.8 — no index, an index at
 * an address the guesser did not try, an index that does not match the FASTA it
 * sits beside — cannot arise here, because the index *is* the file's first
 * kilobyte.
 *
 * **It is four times smaller.** Two bits a base against a FASTA's eight, before
 * the line endings. hg38 is 3.1 GB of FASTA and 800 MB of 2bit, and the
 * difference decides whether a lab puts a genome on a bucket at all.
 *
 * **It is what the assemblies are published as.** Every UCSC assembly ships a
 * `.2bit`, and — the reason this module exists at the same time as
 * `state/hub.ts` — **an assembly hub's genome is a `twoBitPath` and nothing
 * else**. A hub that carries its own sequence carries it this way, so without
 * this reader the whole class of hubs that describe a genome UCSC has never
 * heard of opens as tracks over coordinates nothing can draw. The two features
 * are one feature.
 *
 * ## The layout
 *
 * A 16-byte header (magic, version, sequence count, reserved), then an index of
 * `name → file offset`, then one record per sequence:
 *
 * ```
 * dnaSize  nBlockCount  nBlockStarts[]  nBlockSizes[]
 *          maskBlockCount  maskBlockStarts[]  maskBlockSizes[]  reserved  packedDna
 * ```
 *
 * `packedDna` is four bases a byte, two bits each, most significant first, and
 * the code is `T C A G` for `0 1 2 3` — which is the whole of the decode.
 *
 * ## What is read, and the one thing that is skipped
 *
 * The **N blocks are read** and applied: a run of `N` is a gap in the assembly,
 * it is data, and a reader who cannot see where the gaps are is being shown a
 * chromosome that does not exist.
 *
 * The **mask blocks are skipped** — walked over by arithmetic, never fetched.
 * They record soft-masking, which is the lowercase in a RepeatMasked FASTA, and
 * they are enormous: hg38's chr1 has on the order of a million of them, eight
 * megabytes of offsets, for a distinction this viewer discards twice over —
 * `render/sequence.ts` upper-cases every residue before drawing it, and
 * `gcBins` counts a lowercase `c` as a `C`. Reading eight megabytes per
 * chromosome to compute something nothing looks at is the kind of cost §8.8
 * exists to refuse. The offset arithmetic still has to step over them, which is
 * why `maskBlockCount` is read and the array behind it is not.
 *
 * ## What is refused
 *
 * A **long 2bit** — `version` 1, the variant with 64-bit offsets for files past
 * 4 GB — is refused by name rather than misread. Nothing in the wild that this
 * viewer is likely to meet is one (hg38 is 800 MB), and a reader that guessed
 * at 64-bit fields it had never seen would fail somewhere far from here, in the
 * middle of a chromosome, as wrong residues.
 *
 * Nothing in this module touches a file: it reads `Uint8Array`s and does sums,
 * exactly as `annotations/fai.ts` does, so every case in it is pinned by a test
 * that never leaves memory.
 */

import type { Contig } from '../genome/assembly'

/** `0x1A412743`, the file's first four bytes in whichever order it was written. */
export const TWOBIT_MAGIC = 0x1a412743

/** The fixed part: magic, version, sequence count, reserved. */
const HEADER_BYTES = 16

/** `T C A G` for the two-bit codes `0 1 2 3`, as ASCII. */
const BASES = new Uint8Array([0x54, 0x43, 0x41, 0x47])

const N_BASE = 0x4e

/** What the 16-byte header says. */
export interface TwoBitHeader {
  littleEndian: boolean
  version: number
  /** How many sequences the index holds. */
  count: number
}

/** One row of the index: a name, and where its record starts. */
export interface TwoBitEntry {
  name: string
  offset: number
}

/** One sequence's record header, with the mask blocks stepped over. */
export interface TwoBitRecord {
  name: string
  /** Bases in the sequence. */
  length: number
  /** Gap runs, as absolute half-open spans, in file order (which is ascending). */
  nStarts: Int32Array
  nEnds: Int32Array
  /** File offset of the first packed byte. */
  dnaAt: number
}

/**
 * `true` when these bytes begin a `.2bit`.
 *
 * Both byte orders, because the format is defined as "written in the
 * architecture's order and read by whoever can tell" — which in 2026 means
 * every file is little-endian and the other branch is one comparison.
 */
export function looksLikeTwoBit(bytes: Uint8Array): boolean {
  if (bytes.length < 4) return false
  const view = new DataView(bytes.buffer, bytes.byteOffset, 4)
  return view.getUint32(0, true) === TWOBIT_MAGIC || view.getUint32(0, false) === TWOBIT_MAGIC
}

/**
 * The header, or a thrown refusal naming what this file is instead.
 *
 * Refuses rather than returns `null`, unlike the two readers below: a file that
 * reached here has already answered {@link looksLikeTwoBit}, so anything wrong
 * with it is a fact about the file worth telling a reader, not a "try something
 * else" for the caller.
 */
export function readTwoBitHeader(bytes: Uint8Array): TwoBitHeader {
  if (bytes.length < HEADER_BYTES) {
    throw new Error('This file starts like a .2bit and is too short to hold one.')
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const littleEndian = view.getUint32(0, true) === TWOBIT_MAGIC
  if (!littleEndian && view.getUint32(0, false) !== TWOBIT_MAGIC) {
    throw new Error('This is not a .2bit: its first four bytes are not the format’s signature.')
  }
  const version = view.getUint32(4, littleEndian)
  if (version !== 0) {
    throw new Error(
      `This is a .2bit of version ${version}. This viewer reads version 0 — the ordinary one, ` +
        'with 32-bit offsets. Version 1 is the “long” variant for files past 4 GB, whose offsets ' +
        'and sizes are 64-bit, and reading one as though it were version 0 would return wrong ' +
        'residues rather than fail. Convert it with `twoBitToFa` and `faToTwoBit`.',
    )
  }
  const count = view.getUint32(8, littleEndian)
  if (count === 0) throw new Error('This .2bit declares no sequences.')
  return { littleEndian, version, count }
}

/**
 * As much of the index as `bytes` holds, starting at byte 16.
 *
 * Partial by design. An index row is a length-prefixed name and a 4-byte
 * offset, so its total size cannot be computed in advance — a thousand
 * scaffolds might be 20 KB or 200 — and the caller reads a slab, parses what
 * arrived, and reads more if {@link TwoBitIndex.complete} is `false`. That is
 * the same shape `tryIndexedText` uses for a tabix sidecar and it is here for
 * the same reason: guessing a size means either a wasted read or a second one.
 */
export interface TwoBitIndex {
  entries: TwoBitEntry[]
  /** `true` once every declared sequence has been read. */
  complete: boolean
  /** How many bytes of `bytes` were consumed, so a caller can read on from here. */
  consumed: number
}

export function readTwoBitIndex(bytes: Uint8Array, header: TwoBitHeader, from = HEADER_BYTES): TwoBitIndex {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const entries: TwoBitEntry[] = []
  let at = from
  const decoder = new TextDecoder()
  while (entries.length < header.count) {
    if (at + 1 > bytes.length) break
    const nameSize = bytes[at]
    if (at + 1 + nameSize + 4 > bytes.length) break
    const name = decoder.decode(bytes.subarray(at + 1, at + 1 + nameSize))
    const offset = view.getUint32(at + 1 + nameSize, header.littleEndian)
    entries.push({ name, offset })
    at += 1 + nameSize + 4
  }
  return { entries, complete: entries.length === header.count, consumed: at }
}

/**
 * How many bytes of a record header are needed, given what has been read so far.
 *
 * `null` once every field the record is read for is in hand: the size, the gap
 * list, and the **mask-block count** — the count and not the blocks, which
 * {@link readTwoBitRecord} steps over by arithmetic. Otherwise the smallest
 * number of bytes that would answer the next question — which is two steps at
 * most: the N-block count is at a fixed place, and once it is known the
 * mask-block count's place is known too. The caller therefore reads at most
 * twice per sequence and usually once, because {@link RECORD_GUESS} is chosen
 * to cover the common case.
 *
 * It used to ask for the mask blocks as well — through to the reserved word
 * behind them — which undid the economy the module header describes: the
 * arithmetic stepped over arrays that had just been fetched, and on a
 * soft-masked hg38 opening the genome was the tens of megabytes of offsets this
 * reader exists never to read.
 */
export function recordHeaderBytes(bytes: Uint8Array, at: number, littleEndian: boolean): number | null {
  if (at + 8 > bytes.length) return 8
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const nBlockCount = view.getUint32(at + 4, littleEndian)
  const afterN = at + 8 + nBlockCount * 8
  return afterN + 4 > bytes.length ? afterN + 4 - at : null
}

/**
 * One sequence's record header, read out of a buffer that holds it as far as
 * the mask-block count — which is where {@link recordHeaderBytes} stops asking.
 *
 * The mask blocks are stepped over rather than decoded, and need not be in
 * `bytes` at all; see the module header for why. Nor does `reserved`, which
 * would only be read to be ignored — the format says it is zero, and nothing is
 * gained by refusing a file whose writer put something there.
 */
export function readTwoBitRecord(
  name: string,
  bytes: Uint8Array,
  at: number,
  littleEndian: boolean,
  /**
   * The file offset `bytes[0]` was read from, so `dnaAt` comes out absolute.
   *
   * Zero when the whole file is in hand — which is what a test does, reading
   * the record at its index offset — and the slab's own offset when the caller
   * read just that record, which is what the worker does. Without it the two
   * callers would disagree about what `dnaAt` is measured from, and the
   * disagreement would show up as residues from the wrong part of the file.
   */
  base = 0,
): TwoBitRecord {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const length = view.getUint32(at, littleEndian)
  const nBlockCount = view.getUint32(at + 4, littleEndian)
  const starts = new Int32Array(nBlockCount)
  const ends = new Int32Array(nBlockCount)
  const startsAt = at + 8
  const sizesAt = startsAt + nBlockCount * 4
  for (let i = 0; i < nBlockCount; i++) {
    const start = view.getUint32(startsAt + i * 4, littleEndian)
    starts[i] = start
    ends[i] = start + view.getUint32(sizesAt + i * 4, littleEndian)
  }
  const afterN = sizesAt + nBlockCount * 4
  const maskBlockCount = view.getUint32(afterN, littleEndian)
  // …and this is the step-over: `8` a block for the two parallel arrays, then
  // the reserved word, and the packed DNA begins.
  const dnaAt = base + afterN + 4 + maskBlockCount * 8 + 4
  return { name, length, nStarts: starts, nEnds: ends, dnaAt }
}

/**
 * How many bytes to read for a record header before asking again.
 *
 * Covers a sequence with up to about a thousand gap runs in one request, which
 * is every chromosome of every assembly this viewer is likely to meet — hg38's
 * gappiest has a few hundred — and is a fifth of the handle's own 256 KiB chunk,
 * so on a remote file it is usually not a request at all.
 */
export const RECORD_GUESS = 8192

/**
 * The byte range holding bases `[from, to)`, and which base the range starts on.
 *
 * Four bases a byte, so the range is rounded out to byte boundaries and
 * `firstBase` says how far into the first byte the wanted run begins. This is
 * `annotations/fai.ts`'s `byteRange` for a packed format: sums, no I/O, and the
 * one piece of arithmetic every window of every sequence goes through.
 */
export function dnaByteRange(
  record: TwoBitRecord,
  from: number,
  to: number,
): { from: number; to: number; firstBase: number } {
  const lo = Math.max(0, Math.min(from, record.length))
  const hi = Math.max(lo, Math.min(to, record.length))
  const firstByte = Math.floor(lo / 4)
  const lastByte = Math.ceil(hi / 4)
  return { from: record.dnaAt + firstByte, to: record.dnaAt + lastByte, firstBase: firstByte * 4 }
}

/**
 * Bases `[from, to)` as ASCII, out of the packed bytes {@link dnaByteRange}
 * asked for.
 *
 * `firstBase` is that range's first base, so this can be handed a slab that
 * begins before the window — which is what the caller's cache does.
 *
 * The N blocks are applied **after** unpacking, not instead of it: a gap's
 * packed bits are not blank, they are whatever the writer left there (`T`, in
 * every file kent wrote), so a reader that skipped this step would draw a
 * convincing run of thymine across every centromere in the genome.
 */
export function unpackDna(
  packed: Uint8Array,
  firstBase: number,
  record: TwoBitRecord,
  from: number,
  to: number,
): Uint8Array {
  const lo = Math.max(0, Math.min(from, record.length))
  const hi = Math.max(lo, Math.min(to, record.length))
  const out = new Uint8Array(hi - lo)
  for (let base = lo; base < hi; base++) {
    const offset = base - firstBase
    const byte = packed[offset >> 2]
    if (byte === undefined) break
    // Most significant pair first: base `4k` is bits 7–6 of byte `k`.
    const shift = 6 - ((offset & 3) << 1)
    out[base - lo] = BASES[(byte >> shift) & 3]
  }
  // The gaps, over the top. Walked rather than searched because the blocks are
  // in ascending order and the window is one pass either way.
  for (let block = 0; block < record.nStarts.length; block++) {
    const start = record.nStarts[block]
    if (start >= hi) break
    const end = record.nEnds[block]
    if (end <= lo) continue
    out.fill(N_BASE, Math.max(lo, start) - lo, Math.min(hi, end) - lo)
  }
  return out
}

/** The index as an assembly: the first two columns of a `chrom.sizes`. */
export function contigsOfRecords(records: readonly TwoBitRecord[]): Contig[] {
  return records.map((record) => ({ name: record.name, length: record.length }))
}

// ---------------------------------------------------------------------------
// Opening one
// ---------------------------------------------------------------------------

/**
 * How this module asks for bytes.
 *
 * A function rather than a handle, so that the two callers — the annotations
 * worker, whose handle wants a progress reporter, and the CLI, whose handle is a
 * `LocalFile` — each supply their own and neither has to be described here. It
 * is the same reason `annotations/fai.ts` does arithmetic and lets the worker do
 * the reading: a reader that fetches for itself is one no test can pin.
 */
export type ReadRange = (length: number, position: number) => Promise<Uint8Array>

/** A `.2bit` opened: every record, and nothing read from the packed DNA. */
export interface TwoBitFile {
  /** By the name the file spells, in file order. */
  ordered: TwoBitRecord[]
  records: Map<string, TwoBitRecord>
  /** Bases across every sequence. */
  total: number
}

/**
 * The first read: header, and with luck the whole index.
 *
 * 64 KiB covers a header plus about four thousand index rows, which is every
 * chromosome-level assembly and most draft ones. A file with more sequences
 * than that simply goes round the loop again.
 */
const INDEX_GUESS = 1 << 16

/**
 * Where a `.2bit` with an implausible sequence count is refused.
 *
 * Opening one costs a record-header read per sequence, so a file claiming a
 * million of them is a million reads — and a `count` that large is much more
 * likely to be a truncated file being read as a good one. A hundred thousand is
 * far above any real assembly, the scaffold-level ones included.
 */
export const TWOBIT_MAX_SEQUENCES = 100_000

/**
 * Open a `.2bit`: read its index, then one record header per sequence.
 *
 * The two loops are the format's own shape. The index is length-prefixed names,
 * so its size is not knowable in advance and the first read is a guess grown
 * until it covers; a record header is a gap list whose length is stated inside
 * itself, so it is read, measured, and re-read at most once.
 *
 * What comes back is an assembly and a way to reach any window of it, having
 * touched no packed DNA at all. On hg38 that is a few hundred kilobytes against
 * a file of 800 MB — the point of the format, and the reason an assembly hub
 * opens about as fast as a `chrom.sizes` does.
 */
export async function openTwoBit(read: ReadRange): Promise<TwoBitFile> {
  let slab = await read(INDEX_GUESS, 0)
  const header = readTwoBitHeader(slab)
  if (header.count > TWOBIT_MAX_SEQUENCES) {
    throw new Error(
      `This .2bit declares ${header.count.toLocaleString()} sequences, which is past the ` +
        `${TWOBIT_MAX_SEQUENCES.toLocaleString()} this viewer will open one record at a time. A ` +
        'file that says this is far more likely to be truncated than to be an assembly.',
    )
  }
  let index = readTwoBitIndex(slab, header)
  while (!index.complete) {
    const more = await read(INDEX_GUESS, slab.length)
    if (more.length === 0) {
      throw new Error(
        `This .2bit ends part-way through its index: it declares ${header.count.toLocaleString()} ` +
          `sequences and names ${index.entries.length.toLocaleString()}. The file is truncated.`,
      )
    }
    const grown = new Uint8Array(slab.length + more.length)
    grown.set(slab)
    grown.set(more, slab.length)
    slab = grown
    index = readTwoBitIndex(slab, header)
  }

  const records = new Map<string, TwoBitRecord>()
  const ordered: TwoBitRecord[] = []
  let total = 0
  for (const entry of index.entries) {
    let bytes = await read(RECORD_GUESS, entry.offset)
    let wanted = recordHeaderBytes(bytes, 0, header.littleEndian)
    // At most once round: the first answer is how many bytes the gap list needs,
    // and once that has been read the mask count is in hand too.
    while (wanted !== null) {
      const grown = await read(wanted, entry.offset)
      if (grown.length <= bytes.length) {
        throw new Error(`This .2bit ends part-way through the record for ${entry.name}.`)
      }
      bytes = grown
      wanted = recordHeaderBytes(bytes, 0, header.littleEndian)
    }
    const record = readTwoBitRecord(entry.name, bytes, 0, header.littleEndian, entry.offset)
    records.set(record.name, record)
    ordered.push(record)
    total += record.length
  }
  return { ordered, records, total }
}
