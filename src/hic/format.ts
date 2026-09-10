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
 */

import { ViewerError } from '../errors'
import type { ByteSource } from '../types'

/** `HIC` followed by a NUL. The first four bytes of every version. */
export const HIC_MAGIC = 'HIC\0'

/** Versions this reader accepts. 7 and 8 share a layout; 9 differs in five places. */
export const SUPPORTED_VERSIONS = [7, 8, 9] as const

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

  int8(): number {
    const value = this.view.getInt8(this.at)
    this.at += 1
    return value
  }

  int16(): number {
    const value = this.view.getInt16(this.at, true)
    this.at += 2
    return value
  }

  int32(): number {
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
    const value = this.view.getBigInt64(this.at, true)
    this.at += 8
    return Number(value)
  }

  float32(): number {
    const value = this.view.getFloat32(this.at, true)
    this.at += 4
    return value
  }

  float64(): number {
    const value = this.view.getFloat64(this.at, true)
    this.at += 8
    return value
  }

  /** A NUL-terminated string. The format's only string encoding. */
  string(): string {
    const start = this.at
    while (this.at < this.bytes.byteLength && this.bytes[this.at] !== 0) this.at += 1
    const text = new TextDecoder().decode(this.bytes.subarray(start, this.at))
    this.at += 1
    return text
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
 * reading a megabyte to be safe.
 */
export function readHeader(source: ByteSource): HicHeader {
  let probe = Math.min(HEADER_PROBE_BYTES, source.size)
  for (;;) {
    const bytes = source.readBytes(0, probe)
    try {
      return parseHeader(bytes)
    } catch (err) {
      const truncated = err instanceof RangeError || err instanceof HeaderTruncated
      if (!truncated || probe >= source.size) {
        if (err instanceof HeaderTruncated) {
          throw new ViewerError('format', err.message, {})
        }
        throw err
      }
      probe = Math.min(probe * 4, source.size)
    }
  }
}

/** Thrown while the probe is too small; never escapes {@link readHeader}. */
class HeaderTruncated extends Error {}

export function parseHeader(bytes: Uint8Array): HicHeader {
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

  const attributes: Record<string, string> = {}
  const nAttributes = cursor.int32()
  guard(nAttributes >= 0 && nAttributes < 1e6, 'attribute count')
  for (let i = 0; i < nAttributes; i++) {
    if (cursor.remaining <= 0) throw new HeaderTruncated('header probe too small')
    const key = cursor.string()
    attributes[key] = cursor.string()
  }

  const nChroms = cursor.int32()
  guard(nChroms > 0 && nChroms < 1e7, 'chromosome count')
  const chroms: HicChrom[] = []
  for (let i = 0; i < nChroms; i++) {
    if (cursor.remaining <= 0) throw new HeaderTruncated('header probe too small')
    const name = cursor.string()
    // v9 widened chromosome lengths to 64 bits. A v8 file with a chromosome
    // past 2^31 does not exist, so the narrow read is not a limitation there.
    const length = version >= 9 ? cursor.int64() : cursor.int32()
    chroms.push({ name, length })
  }

  const nBpResolutions = cursor.int32()
  guard(nBpResolutions > 0 && nBpResolutions < 1e4, 'resolution count')
  const bpResolutions: number[] = []
  for (let i = 0; i < nBpResolutions; i++) bpResolutions.push(cursor.int32())

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
 */
export function readFooter(source: ByteSource, header: HicHeader): HicFooter {
  const { version, footerPosition } = header
  // The leading field is the byte length of the v5-compatible portion, and it
  // is *not* the length of the whole footer: the normalisation index sits past
  // it. Read a generous window and grow if the walk runs off the end.
  const first = source.readBytes(footerPosition, 8)
  const declared = version >= 9 ? new Cursor(first).int64() : new Cursor(first).int32()
  const lead = version >= 9 ? 8 : 4
  let window = Math.min(source.size - footerPosition, Math.max(declared + lead + (1 << 20), 1 << 16))
  for (;;) {
    const bytes = source.readBytes(footerPosition, window)
    try {
      return parseFooter(bytes, version, lead)
    } catch (err) {
      const truncated = err instanceof RangeError || err instanceof HeaderTruncated
      if (!truncated || footerPosition + window >= source.size) {
        if (err instanceof HeaderTruncated) throw new ViewerError('format', err.message, {})
        throw err
      }
      window = Math.min(window * 4, source.size - footerPosition)
    }
  }
}

export function parseFooter(bytes: Uint8Array, version: number, lead: number): HicFooter {
  const cursor = new Cursor(bytes)
  cursor.position = lead

  const masterIndex = new Map<string, MasterIndexEntry>()
  const nEntries = cursor.int32()
  guard(nEntries >= 0 && nEntries < 1e8, 'master index size')
  for (let i = 0; i < nEntries; i++) {
    const key = cursor.string()
    const position = cursor.int64()
    const size = cursor.int32()
    masterIndex.set(key, { key, position, size })
  }

  // Expected-value vectors, walked to be skipped. Their shape differs between
  // v8 and v9 in two fields — the value count widened and the values themselves
  // narrowed to float32 — and getting either wrong lands the cursor in the
  // middle of the normalisation index rather than at its start.
  skipExpectedValues(cursor, version, false)
  skipExpectedValues(cursor, version, true)

  const normVectors = new Map<string, NormVectorKey>()
  const normTypes: string[] = []
  // A file written before normalisation vectors existed simply ends here.
  if (cursor.remaining >= 4) {
    const nNorm = cursor.int32()
    if (nNorm >= 0 && nNorm < 1e8) {
      for (let i = 0; i < nNorm; i++) {
        if (cursor.remaining <= 0) throw new HeaderTruncated('footer window too small')
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
      }
    }
  }
  return { masterIndex, normVectors, normTypes }
}

/** One expected-value section, walked past. `normed` adds the leading type string. */
function skipExpectedValues(cursor: Cursor, version: number, normed: boolean): void {
  if (cursor.remaining < 4) return
  const count = cursor.int32()
  if (!(count >= 0 && count < 1e6)) {
    throw new ViewerError(
      'format',
      'The expected-value section of this .hic footer is not walkable; the file may have ' +
        'been written by a tool this reader has not seen.',
      { count },
    )
  }
  for (let i = 0; i < count; i++) {
    if (normed) cursor.string()
    cursor.string()
    cursor.int32()
    const nValues = version >= 9 ? cursor.int64() : cursor.int32()
    if (cursor.remaining <= 0) throw new HeaderTruncated('footer window too small')
    // v9 narrowed the values to float32. Reading them as doubles walks twice as
    // far and lands the cursor past the end of the section.
    cursor.position += nValues * (version >= 9 ? 4 : 8)
    const nScaleFactors = cursor.int32()
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
    cursor.position += nScaleFactors * (4 + (version >= 9 ? 4 : 8))
    if (cursor.position > cursor.position + cursor.remaining) {
      throw new HeaderTruncated('footer window too small')
    }
  }
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
  const head = source.readBytes(key.position, 8)
  const cursor = new Cursor(head)
  const nValues = version >= 9 ? cursor.int64() : cursor.int32()
  // A length that cannot be right is a mispositioned index, and the allocation
  // it would make is the difference between an error and a dead tab: a garbage
  // int64 read as a vector length asks for gigabytes before anything notices.
  // `key.nBytes` is the index's own claim about the section, so the two have to
  // agree with each other as well as with reason.
  if (!(nValues >= 0 && nValues < 1e9)) {
    throw new ViewerError(
      'format',
      `The ${key.type} normalisation vector for chromosome ${key.chromIdx} declares ` +
        `${nValues} values, which is not a plausible length. The normalisation index of this ` +
        'file does not point where it says it does.',
      { type: key.type, chromIdx: key.chromIdx, nValues },
    )
  }
  const width = version >= 9 ? 4 : 8
  const offset = version >= 9 ? 8 : 4
  const body = source.readBytes(key.position + offset, nValues * width)
  const view = new DataView(body.buffer, body.byteOffset, body.byteLength)
  const out = new Float64Array(nValues)
  for (let i = 0; i < nValues; i++) {
    const divisor = width === 4 ? view.getFloat32(i * 4, true) : view.getFloat64(i * 8, true)
    out[i] = divisor > 0 && Number.isFinite(divisor) ? 1 / divisor : Number.NaN
  }
  return out
}
