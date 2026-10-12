/**
 * The `.hic` byte format, read.
 *
 * This is the only module in the repo that knows what a `.hic` looks like on
 * disk, in the same sense that `h5/` is the only one that knows what HDF5 looks
 * like (spec §6.1). Everything above it is handed chromosomes, resolutions and
 * pixel records, and cannot tell which container they came out of — which is
 * the whole point of adding the format at all, and the property `hic/handle.ts`
 * exists to preserve.
 *
 * ## Why this is written here rather than depended on
 *
 * `hic-straw` is the reference reader and is genuinely good, and it is a
 * **devDependency** of this repo for exactly that reason: every fixture written
 * by `test/support/hicWriter.ts` is read back by somebody else's implementation
 * before a golden is trusted, which is the discipline `analysis/write/bigwig.ts`
 * already applies to the bigWig writer.
 *
 * It is not a runtime dependency, and the reason is the byte layer rather than
 * the parsing. Every read in this application goes through a {@link ByteSource}
 * — an LRU over 1 MiB chunks, a request counter the §12 budget tests assert on,
 * and an S3 signature where one is needed. A parser that does its own fetching
 * sits outside all three: its requests are uncounted, its cache is a second
 * cache, and a private bucket is unreachable to it. So the format is read
 * through the source this app already has, and the source is the reason.
 *
 * ## What is deliberately not read
 *
 * **Fragment-resolution matrices** (`unit = "FRAG"`). §3.3 excludes variable
 * bins from the whole application, and a fragment grid is variable bins under
 * another name: its coordinate model is a lookup table rather than arithmetic,
 * which is the thing §3.3 exists to delete. A `.hic` carrying both is opened at
 * its BP resolutions and the fragment ones are not offered.
 *
 * **Expected-value vectors.** The file carries Juicer's, and §18 computes its
 * own from the pixels it is already reading — against a golden, per sequence,
 * with the near-diagonal trim the reader chose. Two expectations with one name
 * would be a quantity that changes depending on which code path produced it.
 *
 * ## Every count is the file's claim, and is checked as one
 *
 * The header, the footer and the vectors are sized by numbers read out of the
 * same bytes, so each goes through `sources/untrusted.ts` before it sizes a
 * read, an allocation or a walk: a count must be a count, below the most any
 * real file declares, and small enough for the bytes left in the *file* to
 * hold (§10). And a window too small is said by {@link Truncated} and by nothing
 * else — a `RangeError` is also what an allocation sized by a corrupt count
 * throws, and reading that as "grow the window" is how one negative `nValues`
 * became six reads and 341 MiB of a 256 MiB file.
 */

import { ViewerError } from '../errors'
import { declaredCount, declaredSpan, plausibleCount } from '../sources/untrusted'
import type { ByteSource } from '../types'

/** `HIC` followed by a NUL. The first four bytes of every version. */
export const HIC_MAGIC = 'HIC\0'

/** Versions this reader accepts. 7 and 8 share a layout; 9 differs in five places. */
export const SUPPORTED_VERSIONS = [7, 8, 9] as const

/**
 * The format as a refusal names it, for `sources/untrusted.ts`.
 */
export const HIC = '.hic'

/**
 * The most bins one chromosome holds at one rung, as a vector's length.
 *
 * v8's `int32` width. v9 widened the expected- and normalisation-vector counts
 * to `int64`, and nothing has needed the room: the longest vector any file
 * carries is its longest chromosome at its finest rung, which is 2.5 × 10⁸ bins
 * for human chr1 at 1 bp — a rung nobody balances at. What bounds an
 * allocation is not this but the bytes behind it, which a vector's length is
 * also checked against.
 */
export const HIC_MAX_VECTOR_VALUES = 2 ** 31 - 1

/**
 * The longest chromosome a header may declare: 2^40 bp, a terabase.
 *
 * The largest genomes sequenced are under 200 Gbp in total and their longest
 * chromosomes a few gigabases — which is why v9 widened the field past 2^31 —
 * so this refuses only a length no assembly has, and keeps every bin count
 * derived from one far inside a safe integer.
 */
export const HIC_MAX_CHROM_LENGTH = 2 ** 40

/**
 * Thrown when a read runs past the bytes in hand — the one signal that a
 * larger window would answer.
 *
 * A `RangeError`, because that is what the `DataView` beneath the cursor would
 * have thrown and what a caller written against the platform expects. But the
 * readers that grow a window catch *this* and nothing else: a `RangeError` is
 * also what `new Float64Array(-1)` throws, and taking that for "read further"
 * is the mistake this class exists to make impossible.
 */
export class Truncated extends RangeError {
  /** Bytes from the start of the buffer the read needed. */
  readonly needed: number

  constructor(needed: number) {
    super(`a read needs ${needed} bytes of a shorter buffer`)
    this.name = 'Truncated'
    this.needed = needed
  }
}

/**
 * A cursor over a byte range, **little-endian throughout**.
 *
 * This is the single most common way to get `.hic` wrong, and it is worth
 * stating rather than leaving in the `false` arguments below. The format is
 * written by Java, whose `DataOutputStream` is big-endian and whose network
 * conventions are big-endian, so big-endian is the expectation a reader arrives
 * with — but Juicer writes through a `LittleEndianOutputStream`, and every
 * fixed-width field in the file is little-endian.
 *
 * Getting it wrong does not produce an error. It produces a chromosome count in
 * the hundreds of millions and a footer offset past the end of the file, which
 * looks like a corrupt file rather than a misread one. The header's sanity
 * checks below exist to turn that into a sentence, and `hic-straw-oracle.test.ts`
 * exists so that a reader and a writer cannot agree on the wrong answer — which
 * is exactly what they did until that test was written.
 *
 * Every read past the end throws {@link Truncated}, including a string whose
 * terminator is not in the buffer: what is in hand is the front of something
 * longer, and only a larger window can say what.
 */
export class Cursor {
  private readonly view: DataView
  private at = 0

  constructor(private readonly bytes: Uint8Array) {
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  }

  /** Bytes consumed so far — the caller's own offset bookkeeping. */
  get position(): number {
    return this.at
  }

  set position(to: number) {
    this.at = to
  }

  get remaining(): number {
    return this.bytes.byteLength - this.at
  }

  /** Throw {@link Truncated} unless `width` bytes from here are in the buffer. */
  private need(width: number): void {
    if (this.at + width > this.bytes.byteLength) throw new Truncated(this.at + width)
  }

  int8(): number {
    this.need(1)
    const value = this.view.getInt8(this.at)
    this.at += 1
    return value
  }

  int16(): number {
    this.need(2)
    const value = this.view.getInt16(this.at, true)
    this.at += 2
    return value
  }

  int32(): number {
    this.need(4)
    const value = this.view.getInt32(this.at, true)
    this.at += 4
    return value
  }

  /**
   * A 64-bit field, narrowed to a Number.
   *
   * Every one of them here is a file offset or a count, and a `.hic` past 2^53
   * bytes does not exist; narrowing once at the edge is what keeps BigInt out of
   * the arithmetic downstream, exactly as `h5/api.ts` does for int64 columns.
   */
  int64(): number {
    this.need(8)
    const value = this.view.getBigInt64(this.at, true)
    this.at += 8
    // Past 2^53 the narrowing rounds, and a rounded offset is a wrong one; such
    // a value is made a NaN instead, which every count check downstream refuses.
    return value > BigInt(Number.MAX_SAFE_INTEGER) || value < BigInt(Number.MIN_SAFE_INTEGER)
      ? Number.NaN
      : Number(value)
  }

  float32(): number {
    this.need(4)
    const value = this.view.getFloat32(this.at, true)
    this.at += 4
    return value
  }

  float64(): number {
    this.need(8)
    const value = this.view.getFloat64(this.at, true)
    this.at += 8
    return value
  }

  /** A NUL-terminated string. The format's only string encoding. */
  string(): string {
    const start = this.at
    const end = this.bytes.indexOf(0, start)
    // Its terminator is somewhere past the window, and the window has to reach
    // at least one byte further than the string's start to find it.
    if (end < 0) throw new Truncated(Math.max(start, this.bytes.byteLength) + 1)
    const text = new TextDecoder().decode(this.bytes.subarray(start, end))
    this.at = end + 1
    return text
  }

  /**
   * Step over `width` bytes without reading them.
   *
   * May land past the end, since what is stepped over need not be in hand —
   * only the next read has to be, and it throws {@link Truncated} if it is not.
   * A negative width is the one thing that cannot be a skip: it walks the
   * cursor backwards over bytes already read, and a loop doing that need never
   * end.
   */
  skip(width: number): void {
    if (!(width >= 0)) throw new RangeError(`a cursor cannot skip ${width} bytes`)
    this.at += width
  }
}

/** One sequence, as the header names it. */
export interface HicChrom {
  name: string
  length: number
}

/** Everything the header says, which is everything needed to describe the file. */
export interface HicHeader {
  version: number
  /** Byte offset of the footer, which holds the master index. */
  footerPosition: number
  genomeId: string
  attributes: Record<string, string>
  chroms: HicChrom[]
  /** Bin sizes present, largest first is *not* assumed — file order is kept. */
  bpResolutions: number[]
  /** Present only in v9; `null` elsewhere. Not read, recorded for provenance. */
  normVectorIndexPosition: number | null
  normVectorIndexLength: number | null
  /** Bytes the header itself occupied, so the caller knows what it has consumed. */
  headerBytes: number
}

/**
 * How much of the front of the file to pull in one go to parse the header.
 *
 * The header is a few hundred bytes plus one row per chromosome, and a mammalian
 * assembly with every scaffold runs to a few thousand rows. 512 KiB covers every
 * file anyone has, in one chunk of the source's own size, and the retry below
 * covers the one that does not rather than assuming it away.
 */
const HEADER_PROBE_BYTES = 512 * 1024

/**
 * Whether these bytes begin a `.hic`.
 *
 * Four bytes, and the detection order in §3.1 asks this before HDF5's own
 * signature for the same reason it asks anything before opening: a file that is
 * not this format must be refused without a single table read.
 */
export function isHicMagic(bytes: Uint8Array): boolean {
  return (
    bytes.length >= 4 &&
    bytes[0] === 0x48 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x43 &&
    bytes[3] === 0x00
  )
}

/**
 * Parse the header, growing the probe if a very large chromosome list needs it.
 *
 * Two passes at worst, and the second only for a file whose scaffold list is
 * bigger than the first probe — which is honest about the cost rather than
 * reading a megabyte to be safe. The probe grows only on {@link Truncated}, to
 * at least what the read that ran out needed, and never past the file: every
 * count in the header has been checked against the bytes the file has left, so
 * a header that still runs out at the end of the file is a truncated one, and
 * is refused as that.
 */
export function readHeader(source: ByteSource): HicHeader {
  let probe = Math.min(HEADER_PROBE_BYTES, source.size)
  for (;;) {
    const bytes = source.readBytes(0, probe)
    try {
      return parseHeader(bytes, source.size)
    } catch (err) {
      if (!(err instanceof Truncated)) throw err
      if (probe >= source.size) {
        throw new ViewerError(
          'format',
          `This .hic ends inside its header, ${source.size.toLocaleString('en-US')} bytes in. ` +
            'The file is truncated, or is not the format its first four bytes claim.',
          { size: source.size },
        )
      }
      probe = Math.min(source.size, Math.max(probe * 4, err.needed))
    }
  }
}

/**
 * Parse a header out of `bytes`, the front of a file of `fileSize` bytes.
 *
 * `fileSize` is what a count is checked against: a header cannot declare more
 * chromosomes than the file has bytes for, whatever the probe in hand holds.
 * Omitted, the bytes are taken to be the whole file.
 */
export function parseHeader(bytes: Uint8Array, fileSize = bytes.byteLength): HicHeader {
  if (!isHicMagic(bytes)) {
    throw new ViewerError(
      'format',
      'This file does not begin with the `.hic` magic bytes.',
      {},
    )
  }
  const cursor = new Cursor(bytes)
  cursor.position = 4
  const version = cursor.int32()
  if (!(SUPPORTED_VERSIONS as readonly number[]).includes(version)) {
    throw new ViewerError(
      'unsupported',
      `This is a version ${version} .hic file, and this reader accepts versions ` +
        `${SUPPORTED_VERSIONS.join(', ')}. Versions below 7 predate the block index this ` +
        'reader navigates by, and a version above the list is a format this build has not ' +
        'seen. Convert it with `hic2cool` or re-run Juicer Tools `pre`.',
      { version },
    )
  }
  const footerPosition = cursor.int64()
  const genomeId = cursor.string()

  let normVectorIndexPosition: number | null = null
  let normVectorIndexLength: number | null = null
  if (version >= 9) {
    normVectorIndexPosition = cursor.int64()
    normVectorIndexLength = cursor.int64()
  }

  // The bytes the file has after the cursor: what every count below must fit.
  const left = (): number => fileSize - cursor.position

  const attributes: Record<string, string> = {}
  // Two terminators an attribute, at the least. A million is far past what any
  // writer records — Juicer writes a handful, `hictk` a few more.
  const nAttributes = declaredCount(cursor.int32(), {
    format: HIC,
    field: 'header attribute count',
    ceiling: 1e6,
    available: left(),
    bytesPerItem: 2,
  })
  for (let i = 0; i < nAttributes; i++) {
    const key = cursor.string()
    attributes[key] = cursor.string()
  }

  // A terminator and a length a chromosome. Ten million is past every
  // assembly, the scaffold-level metagenomes this viewer exists for included.
  const nChroms = declaredCount(cursor.int32(), {
    format: HIC,
    field: 'chromosome count',
    ceiling: 1e7,
    available: left(),
    bytesPerItem: 1 + (version >= 9 ? 8 : 4),
  })
  guard(nChroms > 0, 'chromosome count')
  const chroms: HicChrom[] = []
  for (let i = 0; i < nChroms; i++) {
    const name = cursor.string()
    // v9 widened chromosome lengths to 64 bits. A v8 file with a chromosome
    // past 2^31 does not exist, so the narrow read is not a limitation there.
    const length = declaredCount(version >= 9 ? cursor.int64() : cursor.int32(), {
      format: HIC,
      field: `length of chromosome ${name}`,
      ceiling: HIC_MAX_CHROM_LENGTH,
    })
    chroms.push({ name, length })
  }

  // Juicer offers ten base-pair rungs and `hictk` as many as it is asked for;
  // ten thousand is past both.
  const nBpResolutions = declaredCount(cursor.int32(), {
    format: HIC,
    field: 'resolution count',
    ceiling: 1e4,
    available: left(),
    bytesPerItem: 4,
  })
  guard(nBpResolutions > 0, 'resolution count')
  const bpResolutions: number[] = []
  for (let i = 0; i < nBpResolutions; i++) {
    // A bin size is a divisor everywhere above this, so nought is the one value
    // that cannot be let through: it makes every chromosome infinitely long.
    const binSize = cursor.int32()
    guard(binSize > 0, 'bin size')
    bpResolutions.push(binSize)
  }

  return {
    version,
    footerPosition,
    genomeId,
    attributes,
    chroms,
    bpResolutions,
    normVectorIndexPosition,
    normVectorIndexLength,
    headerBytes: cursor.position,
  }
}

/**
 * A sanity check on a count read out of the header.
 *
 * Byte order is the failure this catches. Read little-endian, a chromosome
 * count of 24 comes back as 402,653,184 — which allocates rather than throwing,
 * and produces a file that appears to open and holds nothing. A bound that no
 * real file approaches turns that into an error at the point of the mistake.
 */
function guard(ok: boolean, what: string): void {
  if (ok) return
  throw new ViewerError(
    'format',
    `The ${what} in this .hic header is not a plausible number. The file is either ` +
      'truncated or is not the format its first four bytes claim.',
    { what },
  )
}

/** One chromosome pair's entry in the master index. */
export interface MasterIndexEntry {
  /** `"<chr1Idx>_<chr2Idx>"`, exactly as the file spells it. */
  key: string
  position: number
  size: number
}

/** A normalisation vector, located but not read. */
export interface NormVectorKey {
  type: string
  chromIdx: number
  unit: string
  binSize: number
  position: number
  nBytes: number
}

export interface HicFooter {
  masterIndex: Map<string, MasterIndexEntry>
  /** Normalisation vectors, keyed `type/chromIdx/unit/binSize`. */
  normVectors: Map<string, NormVectorKey>
  /** Normalisation names offered, in file order, deduplicated. */
  normTypes: string[]
}

/** The footer key for one normalisation vector. */
export function normKey(type: string, chromIdx: number, unit: string, binSize: number): string {
  return `${type}/${chromIdx}/${unit}/${binSize}`
}

/**
 * Read the master index and the normalisation-vector index.
 *
 * One read, sized by the footer's own leading length field, so a file with
 * twenty normalisations over a thousand scaffolds costs one request and not a
 * walk. The expected-value blocks in the middle are *skipped over* rather than
 * decoded — see the module head for why this reader does not use them — but
 * they have to be walked to reach the normalisation index behind them, which is
 * why their layout appears here at all.
 *
 * The window grows only on {@link Truncated}, to at least what the read that
 * ran out needed and never past the end of the file. Every count the walk is
 * sized by has been checked against the bytes the file has left, so the walk
 * cannot ask for more than the file holds; one that still runs out at its end
 * is a truncated footer and is refused as one.
 */
export function readFooter(source: ByteSource, header: HicHeader): HicFooter {
  const { version, footerPosition } = header
  const lead = version >= 9 ? 8 : 4
  // Room for the length field and a master-index count, at the least: a footer
  // position that leaves less is not where the footer is.
  declaredSpan(footerPosition, lead + 4, { format: HIC, field: 'footer position', size: source.size })
  const remaining = source.size - footerPosition
  // The leading field is the byte length of the v5-compatible portion, and it
  // is *not* the length of the whole footer: the normalisation index sits past
  // it. Read a generous window and grow if the walk runs off the end.
  const first = new Cursor(source.readBytes(footerPosition, lead))
  const declared = declaredCount(version >= 9 ? first.int64() : first.int32(), {
    format: HIC,
    field: 'footer length',
    // A byte length, which the format bounds by nothing tighter than the file.
    ceiling: Number.MAX_SAFE_INTEGER,
    available: remaining - lead,
  })
  const place: FooterPlace = { fileSize: source.size, footerPosition }
  let window = Math.min(remaining, Math.max(declared + lead + (1 << 20), 1 << 16))
  for (;;) {
    const bytes = source.readBytes(footerPosition, window)
    try {
      return parseFooter(bytes, version, lead, place)
    } catch (err) {
      if (!(err instanceof Truncated)) throw err
      if (window >= remaining) {
        throw new ViewerError(
          'format',
          `This .hic ends inside its footer, which begins ${footerPosition.toLocaleString('en-US')} ` +
            'bytes in. The file is truncated, or its header does not point at its footer.',
          { footerPosition, size: source.size },
        )
      }
      window = Math.min(remaining, Math.max(window * 4, err.needed))
    }
  }
}

/** Where a footer buffer sits in its file — what a count in it is checked against. */
export interface FooterPlace {
  fileSize: number
  footerPosition: number
}

/** The fewest bytes a master-index entry takes: an empty key, an offset and a size. */
const MASTER_ENTRY_MIN_BYTES = 1 + 8 + 4

/**
 * Parse a footer out of `bytes`, which begin at its length field.
 *
 * `place` says where the bytes sit in their file, so a count is checked against
 * what the *file* has left rather than against the window in hand: the first
 * says whether a count is possible at all, the second only whether to read
 * further. Omitted, the bytes are taken to run to the end of the file, and the
 * master index's offsets, which point outside them, go unchecked.
 */
export function parseFooter(
  bytes: Uint8Array,
  version: number,
  lead: number,
  place?: FooterPlace,
): HicFooter {
  const cursor = new Cursor(bytes)
  cursor.position = lead
  const fileSize = place?.fileSize ?? bytes.byteLength
  const footerPosition = place?.footerPosition ?? 0
  const fileLeft = (): number => fileSize - (footerPosition + cursor.position)

  const masterIndex = new Map<string, MasterIndexEntry>()
  // One entry a chromosome pair that holds a contact. A hundred million is
  // every pair of ten thousand chromosomes populated, far past any file whose
  // pairs a walk could visit.
  const nEntries = declaredCount(cursor.int32(), {
    format: HIC,
    field: 'master index size',
    ceiling: 1e8,
    available: fileLeft(),
    bytesPerItem: MASTER_ENTRY_MIN_BYTES,
  })
  let recorded = 0
  for (let i = 0; i < nEntries; i++) {
    const key = cursor.string()
    const position = cursor.int64()
    const size = cursor.int32()
    // A record is read whole when the rung asked for is past its head, so a
    // size running past the end of the file would read the rest of the file —
    // once per pair, on a walk across all of them. And the records are written
    // one after another, never over each other, so between them they cannot
    // hold more than the file: an index of a thousand entries each naming the
    // whole file is in the file, and would read it a thousand times.
    if (place !== undefined) {
      declaredSpan(position, size, { format: HIC, field: `matrix record for ${key}`, size: place.fileSize })
      recorded += size
      if (recorded > place.fileSize) {
        throw new ViewerError(
          'format',
          `The master index of this .hic gives its matrix records ${recorded.toLocaleString('en-US')} ` +
            `bytes between them by entry ${i + 1}, more than the whole file's ` +
            `${place.fileSize.toLocaleString('en-US')}. The file is corrupt, or not the format its first bytes claim.`,
          { entries: i + 1, bytes: recorded, size: place.fileSize },
        )
      }
    }
    masterIndex.set(key, { key, position, size })
  }

  // Expected-value vectors, walked to be skipped. Their shape differs between
  // v8 and v9 in two fields — the value count widened and the values themselves
  // narrowed to float32 — and getting either wrong lands the cursor in the
  // middle of the normalisation index rather than at its start.
  skipExpectedValues(cursor, version, false, fileLeft)
  skipExpectedValues(cursor, version, true, fileLeft)

  const normVectors = new Map<string, NormVectorKey>()
  const normTypes: string[] = []
  // A file written before normalisation vectors existed simply ends here — the
  // *file*, not the window: a window that happens to stop at this point says
  // nothing about whether an index follows, and reading `cursor.remaining`
  // here used to open such a file with no weights at all.
  if (fileLeft() >= 4) {
    const nNorm = cursor.int32()
    // A type and a unit, a chromosome, a bin size, an offset and a length.
    const entryBytes = 1 + 4 + 1 + 4 + 8 + (version >= 9 ? 8 : 4)
    // Lenient where the rest of the footer is not, as it always has been: what
    // follows the expected values may be no normalisation index at all, and a
    // count no file could hold says so — the file opens, with no weights.
    const limits = { format: HIC, field: 'normalisation index size', ceiling: 1e8, available: fileLeft(), bytesPerItem: entryBytes }
    if (plausibleCount(nNorm, limits)) {
      let held = 0
      for (let i = 0; i < nNorm; i++) {
        const type = cursor.string()
        const chromIdx = cursor.int32()
        const unit = cursor.string()
        const binSize = cursor.int32()
        const position = cursor.int64()
        const nBytes = version >= 9 ? cursor.int64() : cursor.int32()
        normVectors.set(normKey(type, chromIdx, unit, binSize), {
          type,
          chromIdx,
          unit,
          binSize,
          position,
          nBytes,
        })
        if (!normTypes.includes(type)) normTypes.push(type)
        held += nBytes
      }
      // The vectors are written one after another too. An index whose vectors
      // need more bytes than the file has is not the index — the same reading,
      // as leniently, as a count no file could hold.
      if (place !== undefined && !(held <= place.fileSize)) {
        normVectors.clear()
        normTypes.length = 0
      }
    }
  }
  return { masterIndex, normVectors, normTypes }
}

/** One expected-value section, walked past. `normed` adds the leading type string. */
function skipExpectedValues(
  cursor: Cursor,
  version: number,
  normed: boolean,
  fileLeft: () => number,
): void {
  if (fileLeft() < 4) return
  const valueWidth = version >= 9 ? 4 : 8
  // A type (when normalised), a unit, a bin size, a value count and a scale
  // factor count: the least a vector takes. One vector per rung, and one per
  // rung per normalisation, comes to dozens; a million is past every writer.
  const count = declaredCount(cursor.int32(), {
    format: HIC,
    field: `${normed ? 'normalised ' : ''}expected-value vector count`,
    ceiling: 1e6,
    available: fileLeft(),
    bytesPerItem: (normed ? 1 : 0) + 1 + 4 + (version >= 9 ? 8 : 4) + 4,
  })
  for (let i = 0; i < count; i++) {
    if (normed) cursor.string()
    cursor.string()
    cursor.int32()
    // v9 narrowed the values to float32. Reading them as doubles walks twice as
    // far and lands the cursor past the end of the section.
    const nValues = declaredCount(version >= 9 ? cursor.int64() : cursor.int32(), {
      format: HIC,
      field: 'expected-value vector length',
      ceiling: HIC_MAX_VECTOR_VALUES,
      available: fileLeft(),
      bytesPerItem: valueWidth,
    })
    cursor.skip(nValues * valueWidth)
    // The same narrowing applies to the per-chromosome scale factors, and this
    // walked all three versions at the v8 width until a v9 file showed what
    // that costs: a pair is `int32 chrIdx + float64 factor` in v7/v8 and
    // `int32 + float32` in v9, so v9 was overshooting by 4 B per chromosome per
    // vector — a hundred bytes on a human genome, times one vector per
    // resolution — which lands the cursor inside the normalised expected-value
    // section instead of at its end. From there the walk reads a nonsense count
    // and the normalisation index is never reached, so a v9 file with SCALE
    // weights either fails to open or opens with no weights at all.
    // `hic-straw` states the same widths: `INT + nChrScaleFactors * (INT +
    // (version < 9 ? DOUBLE : FLOAT))`.
    const nScaleFactors = declaredCount(cursor.int32(), {
      format: HIC,
      field: 'expected-value scale factor count',
      // One a chromosome, and the header allows ten million chromosomes.
      ceiling: 1e7,
      available: fileLeft(),
      bytesPerItem: 4 + valueWidth,
    })
    cursor.skip(nScaleFactors * (4 + valueWidth))
  }
  // A walk that stepped past the window is not finished: the next section
  // begins out of reach, and only a larger window says where it ends.
  if (cursor.remaining < 0) throw new Truncated(cursor.position)
}

/**
 * A normalisation vector, read and inverted into cooler's convention.
 *
 * The two formats divide and multiply respectively — `.hic` stores a divisor
 * per bin and cooler's `/bins/weight` is a multiplier — so the reciprocal here
 * is what lets `MetaCooler.weightSlices` and every balanced read above it stay
 * exactly as they are. A zero or non-finite divisor becomes `NaN`, which is
 * cooler's own spelling for a bin that was dropped by balancing, so a masked
 * bin masks identically whichever container it came from.
 */
export function readNormVector(
  source: ByteSource,
  version: number,
  key: NormVectorKey,
): Float64Array {
  const field = `${key.type} normalisation vector of chromosome ${key.chromIdx}`
  const lead = version >= 9 ? 8 : 4
  const width = version >= 9 ? 4 : 8
  // The section the index names has to be in the file before anything in it is
  // believed — a position past the end is a mispositioned index, and a length
  // past it would read the rest of the file to find out.
  declaredSpan(key.position, key.nBytes, { format: HIC, field, size: source.size })
  const head = source.readBytes(key.position, lead)
  if (head.byteLength < lead) {
    throw new ViewerError(
      'format',
      `The ${field} begins in the last ${head.byteLength} bytes of this .hic, too few for its ` +
        'length. The file is truncated, or its normalisation index does not point at its vectors.',
      { type: key.type, chromIdx: key.chromIdx, position: key.position },
    )
  }
  const cursor = new Cursor(head)
  // A length that cannot be right is a mispositioned index, and the allocation
  // it would make is the difference between an error and a dead tab: a garbage
  // int64 read as a vector length asks for gigabytes before anything notices.
  // `key.nBytes` is the index's own claim about the section, so the two have to
  // agree — the values must fit in the bytes the index gave them, which is what
  // Juicebox reads (`idx.size` of them, exactly) and what Juicer writes.
  const nValues = declaredCount(version >= 9 ? cursor.int64() : cursor.int32(), {
    format: HIC,
    field: `length of the ${field}`,
    ceiling: HIC_MAX_VECTOR_VALUES,
    available: key.nBytes - lead,
    bytesPerItem: width,
  })
  const body = source.readBytes(key.position + lead, nValues * width)
  const view = new DataView(body.buffer, body.byteOffset, body.byteLength)
  const out = new Float64Array(nValues)
  for (let i = 0; i < nValues; i++) {
    const divisor = width === 4 ? view.getFloat32(i * 4, true) : view.getFloat64(i * 8, true)
    out[i] = divisor > 0 && Number.isFinite(divisor) ? 1 / divisor : Number.NaN
  }
  return out
}
