/**
 * An open `.hic`, at one resolution, presenting global bin coordinates.
 *
 * The translation this class performs is the whole of what makes a `.hic`
 * indistinguishable from a cooler upstream: the file speaks in
 * *chromosome-local* bins inside per-pair matrices, and everything above speaks
 * in one **global** bin index running over the chromosomes end to end. That
 * index is the same arithmetic §3.3 fixes for a cooler — the running sum of
 * `ceil(length / binsize)` — so the two containers produce the same bin for the
 * same locus and every coordinate model above is untouched.
 *
 * ## The "All" chromosome
 *
 * Every `.hic` written by Juicer carries a synthetic chromosome at index 0,
 * named `All`, holding a whole-genome overview matrix at a coarse grid. It is
 * not a sequence: it has no coordinates anyone can cite, its length is a
 * fabricated round number, and including it in the axis would put a phantom
 * chromosome at the origin of every picture and shift every real bin by its
 * width. It is dropped, and dropped **by name** rather than by index for §7.4's
 * reason — a file that does not carry it must not lose its first real
 * chromosome. {@link fileIndexOf} is what keeps the master index, which is keyed
 * on the file's own numbering, reachable after the drop.
 *
 * ## Caching
 *
 * Two caches, both bounded, both for the same reason the byte source has one:
 * the matrix records (one per chromosome pair, a few KB each, read once and
 * kept, because navigating within a chromosome asks for the same one every
 * time) and the decompressed blocks (LRU by bytes, because a pan re-asks for
 * the blocks it just left). Neither is a tile cache: a block is an index unit,
 * nothing is composited out of them, and dropping the whole lot costs a re-read
 * and not a redraw.
 */

import { ViewerError } from '../errors'
import type { ByteSource, Extent } from '../types'
import {
  normKey,
  readFooter,
  readHeader,
  readNormVector,
  type HicChrom,
  type HicFooter,
  type HicHeader,
  type NormVectorKey,
} from './format'
import {
  blockNumbersFor,
  decodeBlock,
  readMatrixRecord,
  type BlockRecords,
  type MatrixRecord,
  type ZoomData,
} from './blocks'

/** Bytes of decompressed block retained. One order under the source's own LRU. */
const BLOCK_CACHE_BYTES = 48 << 20

/**
 * The normalisations this reader will use as `bins/weight`, best first.
 *
 * `SCALE` is Juicer's balancing from version 9 on and is the same fixed point
 * `cooler balance` reaches; `KR` is the Knight–Ruiz solution it replaced, which
 * converges to the same weights (`render/derive.ts` argues this at length for
 * the derived case); `VC` and `VC_SQRT` are coverage normalisations and are
 * weaker, but a file carrying only those still has an answer to "show me this
 * balanced" and the answer is named rather than implied.
 *
 * Order is a preference and not a ranking of correctness: what the info panel
 * reports is the one that was used, so a reader is never guessing which.
 */
const NORM_PREFERENCE = ['SCALE', 'KR', 'INTER_KR', 'GW_KR', 'VC_SQRT', 'VC'] as const

/** The unit this reader accepts. `FRAG` is excluded — see `hic/format.ts`. */
const BP = 'BP'

export interface HicOpenOptions {
  /** Bin size to open at; the finest available when omitted. */
  binSize?: number
}

export class HicFile {
  readonly header: HicHeader
  readonly footer: HicFooter
  /** Real sequences, `All` removed, in file order. */
  readonly chroms: HicChrom[]
  readonly binSize: number
  /** Bin sizes offered, ascending — the resolution ladder §3.4 makes use of. */
  readonly resolutions: number[]
  /** Cumulative bin offsets, one per chromosome plus a terminator. */
  readonly chromOffset: Float64Array
  readonly nBins: number
  /** Which normalisation `bins/weight` serves, or `null` when none exists. */
  readonly normType: string | null

  private readonly source: ByteSource
  /** Display index → the index the file's own master index is keyed on. */
  private readonly fileIndex: Int32Array
  private readonly matrices = new Map<string, MatrixRecord | null>()
  private readonly blockCache = new Map<string, BlockRecords>()
  private blockCacheBytes = 0
  private readonly normCache = new Map<number, Float64Array | null>()

  private constructor(source: ByteSource, header: HicHeader, footer: HicFooter, binSize: number) {
    this.source = source
    this.header = header
    this.footer = footer

    const kept: HicChrom[] = []
    const indices: number[] = []
    header.chroms.forEach((chrom, at) => {
      if (chrom.name.toLowerCase() === 'all') return
      kept.push(chrom)
      indices.push(at)
    })
    this.chroms = kept
    this.fileIndex = Int32Array.from(indices)

    this.resolutions = [...header.bpResolutions].sort((a, b) => a - b)
    this.binSize = binSize
    this.chromOffset = new Float64Array(kept.length + 1)
    for (let i = 0; i < kept.length; i++) {
      this.chromOffset[i + 1] = this.chromOffset[i] + Math.ceil(kept[i].length / binSize)
    }
    this.nBins = this.chromOffset[kept.length]

    this.normType =
      NORM_PREFERENCE.find((type) =>
        kept.some((_, at) =>
          footer.normVectors.has(normKey(type, this.fileIndex[at], BP, binSize)),
        ),
      ) ?? null
  }

  /**
   * Open a `.hic` at one resolution.
   *
   * The header and the footer are two bounded reads and nothing else is touched
   * — no matrix record, no block, no normalisation vector — so a file is
   * classified, accepted and described before a byte of data is fetched, which
   * is the same promise `metacooler/detect.ts` makes for HDF5 and the reason a
   * remote refusal stays inside the §12 budget.
   */
  static open(source: ByteSource, options: HicOpenOptions = {}): HicFile {
    const header = readHeader(source)
    const footer = readFooter(source, header)
    const available = [...header.bpResolutions].sort((a, b) => a - b)
    if (available.length === 0) {
      throw new ViewerError(
        'unsupported',
        'This .hic carries no base-pair resolutions. Fragment-resolution matrices are ' +
          'variable-bin and are excluded from this viewer for the reasons in SPECS §3.3.',
        {},
      )
    }
    const binSize = options.binSize ?? available[0]
    if (!available.includes(binSize)) {
      throw new ViewerError(
        'unsupported',
        `This .hic has no ${binSize} bp resolution. It offers ${available.join(', ')}.`,
        { binSize, available },
      )
    }
    return new HicFile(source, header, footer, binSize)
  }

  /** Bytes and requests spent so far, for the §12 budgets. */
  stats(): { requests: number; bytes: number } {
    return this.source.stats()
  }

  /** The file's own index for a display chromosome. */
  fileIndexOf(display: number): number {
    return this.fileIndex[display]
  }

  /** Bins occupied by one chromosome, in global coordinates. */
  chromExtent(display: number): Extent {
    return [this.chromOffset[display], this.chromOffset[display + 1]]
  }

  /** The chromosome a global bin belongs to, by binary search over the offsets. */
  chromAt(bin: number): number {
    let lo = 0
    let hi = this.chroms.length - 1
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1
      if (this.chromOffset[mid] <= bin) lo = mid
      else hi = mid - 1
    }
    return lo
  }

  /** Every chromosome a global bin range touches, in ascending display order. */
  chromsSpanning(extent: Extent): number[] {
    const out: number[] = []
    if (extent[1] <= extent[0]) return out
    const first = this.chromAt(extent[0])
    const last = this.chromAt(Math.min(extent[1] - 1, this.nBins - 1))
    for (let c = first; c <= last; c++) out.push(c)
    return out
  }

  /**
   * The total the file claims, summed over every stored chromosome pair.
   *
   * The `sumCounts` per matrix is a float the writer computed, so this is the
   * file's own answer rather than one derived by reading it — the same
   * relationship `attrs['sum']` has to a cooler's pixel table.
   */
  totalCount(): number {
    let sum = 0
    for (const key of this.footer.masterIndex.keys()) {
      const record = this.matrixFor(key)
      const zoom = record?.zooms.find((z) => z.unit === BP && z.binSize === this.binSize)
      if (zoom !== undefined) sum += zoom.sumCounts
    }
    return sum
  }

  /**
   * Weights for global bins `[lo, hi)`, in cooler's multiply-by convention.
   *
   * Assembled from the per-chromosome normalisation vectors the range touches,
   * which is a bounded read of exactly those and not of the genome. A
   * chromosome with no vector — which happens, since Juicer skips the ones its
   * balancer could not converge on — contributes `NaN`, and `NaN` is cooler's
   * own spelling for a bin balancing threw out, so the picture is identical to
   * the one a partially balanced cooler draws.
   */
  weights(lo: number, hi: number): Float64Array {
    const out = new Float64Array(Math.max(0, hi - lo)).fill(Number.NaN)
    if (this.normType === null || hi <= lo) return out
    for (const chrom of this.chromsSpanning([lo, hi])) {
      const vector = this.normVector(chrom)
      if (vector === null) continue
      const base = this.chromOffset[chrom]
      const from = Math.max(lo, base)
      const to = Math.min(hi, this.chromOffset[chrom + 1])
      for (let bin = from; bin < to; bin++) {
        const at = bin - base
        out[bin - lo] = at < vector.length ? vector[at] : Number.NaN
      }
    }
    return out
  }

  private normVector(chrom: number): Float64Array | null {
    if (this.normCache.has(chrom)) return this.normCache.get(chrom) ?? null
    let vector: Float64Array | null = null
    if (this.normType !== null) {
      const key: NormVectorKey | undefined = this.footer.normVectors.get(
        normKey(this.normType, this.fileIndex[chrom], BP, this.binSize),
      )
      if (key !== undefined) vector = readNormVector(this.source, this.header.version, key)
    }
    this.normCache.set(chrom, vector)
    return vector
  }

  /** The matrix record for a `"a_b"` key, read once and kept. */
  private matrixFor(key: string): MatrixRecord | null {
    if (this.matrices.has(key)) return this.matrices.get(key) ?? null
    const entry = this.footer.masterIndex.get(key)
    const record =
      entry === undefined
        ? null
        : readMatrixRecord(
            (position, length) => this.source.readBytes(position, length),
            entry,
            this.header.version,
          )
    this.matrices.set(key, record)
    return record
  }

  /** The zoom for one display chromosome pair at this file's bin size. */
  private zoomFor(a: number, b: number): ZoomData | null {
    const key = `${this.fileIndex[a]}_${this.fileIndex[b]}`
    const record = this.matrixFor(key)
    if (record === null) return null
    return record.zooms.find((z) => z.unit === BP && z.binSize === this.binSize) ?? null
  }

  /** Whether any matrix exists at this bin size — the acceptance gate's question. */
  hasAnyMatrix(): boolean {
    for (let c = 0; c < this.chroms.length; c++) {
      if (this.zoomFor(c, c) !== null) return true
    }
    return false
  }

  /**
   * Every chromosome pair stored at this resolution, as display indices.
   *
   * Derived from the master index rather than from the cross product, because a
   * file written with `-d` holds only the intra matrices and walking the
   * absent pairs would be a request each to learn nothing.
   */
  storedPairs(): Array<[number, number]> {
    const byFileIndex = new Map<number, number>()
    this.fileIndex.forEach((file, display) => byFileIndex.set(file, display))
    const pairs: Array<[number, number]> = []
    for (const key of this.footer.masterIndex.keys()) {
      const [rawA, rawB] = key.split('_').map((part) => Number.parseInt(part, 10))
      const a = byFileIndex.get(rawA)
      const b = byFileIndex.get(rawB)
      if (a === undefined || b === undefined) continue
      if (this.zoomFor(a, b) === null) continue
      pairs.push(a <= b ? [a, b] : [b, a])
    }
    pairs.sort((x, y) => x[0] - y[0] || x[1] - y[1])
    return pairs
  }

  /**
   * The stored pixels of one chromosome pair inside a global bin rectangle.
   *
   * `rows` and `cols` are global and are intersected with each chromosome's own
   * span here, so a caller passes the window it wants and never the chromosome
   * arithmetic. What comes back is in **global** bins and is upper-triangular:
   * `bin1 <= bin2`, which is the `symmetric-upper` storage mode the whole reader
   * is written against, so `planRead` and `scatterDense` need no case for this
   * container.
   */
  async pairRecords(
    a: number,
    b: number,
    rows: Extent,
    cols: Extent,
  ): Promise<{ bin1: Int32Array; bin2: Int32Array; count: Float64Array; length: number } | null> {
    const [lowChrom, highChrom] = a <= b ? [a, b] : [b, a]
    const zoom = this.zoomFor(lowChrom, highChrom)
    if (zoom === null) return null
    const intra = lowChrom === highChrom

    // The window each axis of the *stored* pair covers. The stored first axis is
    // the lower chromosome, which is not necessarily the caller's row axis, so
    // both windows are unioned onto both axes for an intra pair and assigned by
    // chromosome for an inter one.
    const lowSpan = this.localSpan(lowChrom, rows, cols)
    const highSpan = this.localSpan(highChrom, rows, cols)
    if (lowSpan === null || highSpan === null) return null

    const numbers = blockNumbersFor(zoom, this.header.version, intra, lowSpan, highSpan)
    const lowBase = this.chromOffset[lowChrom]
    const highBase = this.chromOffset[highChrom]

    let total = 0
    const parts: Array<{ x: Int32Array; y: Int32Array; value: Float32Array; length: number }> = []
    for (const number of numbers) {
      const records = await this.block(zoom, number)
      if (records === null) continue
      parts.push(records)
      total += records.length
    }
    if (total === 0) return null

    const bin1 = new Int32Array(total)
    const bin2 = new Int32Array(total)
    const count = new Float64Array(total)
    let n = 0
    for (const part of parts) {
      for (let i = 0; i < part.length; i++) {
        const g1 = lowBase + part.x[i]
        const g2 = highBase + part.y[i]
        // Upper-triangular by construction for an inter pair, because the lower
        // chromosome's bins precede the higher one's. An intra block can hold a
        // record either way round, and the swap costs one comparison against a
        // whole class of silently mirrored pictures.
        if (g1 <= g2) {
          bin1[n] = g1
          bin2[n] = g2
        } else {
          bin1[n] = g2
          bin2[n] = g1
        }
        count[n] = part.value[i]
        n += 1
      }
    }
    return { bin1, bin2, count, length: n }
  }

  /**
   * A chromosome's local bin window, from whichever of the two global ranges
   * overlaps it — or `null` when neither does.
   *
   * Both are consulted because a read is a rectangle and a chromosome may be on
   * either of its axes. Where both overlap, the union is taken: narrowing to one
   * would drop the half of an on-diagonal block the other axis was asking for.
   */
  private localSpan(chrom: number, rows: Extent, cols: Extent): [number, number] | null {
    const base = this.chromOffset[chrom]
    const end = this.chromOffset[chrom + 1]
    let lo = Number.POSITIVE_INFINITY
    let hi = Number.NEGATIVE_INFINITY
    for (const extent of [rows, cols]) {
      const from = Math.max(extent[0], base)
      const to = Math.min(extent[1], end)
      if (to <= from) continue
      lo = Math.min(lo, from - base)
      hi = Math.max(hi, to - base)
    }
    return Number.isFinite(lo) ? [lo, hi] : null
  }

  /** One block, decompressed, through the LRU. */
  private async block(zoom: ZoomData, number: number): Promise<BlockRecords | null> {
    const ref = zoom.blocks.get(number)
    if (ref === undefined || ref.size <= 0) return null
    const key = `${this.binSize}/${ref.position}`
    const held = this.blockCache.get(key)
    if (held !== undefined) {
      // Reinsert at the back: `Map` keeps insertion order, so the first key is
      // the least recently used.
      this.blockCache.delete(key)
      this.blockCache.set(key, held)
      return held
    }
    const compressed = this.source.readBytes(ref.position, ref.size)
    const records = decodeBlock(await inflate(compressed), this.header.version)
    this.remember(key, records)
    return records
  }

  private remember(key: string, records: BlockRecords): void {
    const bytes = records.x.byteLength + records.y.byteLength + records.value.byteLength
    this.blockCache.set(key, records)
    this.blockCacheBytes += bytes
    for (const held of this.blockCache.keys()) {
      if (this.blockCacheBytes <= BLOCK_CACHE_BYTES) break
      if (held === key) continue
      const evicted = this.blockCache.get(held)
      if (evicted !== undefined) {
        this.blockCacheBytes -=
          evicted.x.byteLength + evicted.y.byteLength + evicted.value.byteLength
      }
      this.blockCache.delete(held)
    }
  }

  close(): void {
    this.matrices.clear()
    this.blockCache.clear()
    this.normCache.clear()
    this.blockCacheBytes = 0
  }
}

/**
 * zlib-inflate one block, through the platform's own decompressor.
 *
 * `DecompressionStream` costs no bundle and is present in every worker this app
 * runs in and in the Node the CLI runs on, which is the same argument
 * `annotations/parse.ts` makes for un-gzipping there. `'deflate'` and not
 * `'deflate-raw'`: Juicer writes through `java.util.zip.Deflater` at its
 * defaults, which emits the two-byte zlib header, and asking for raw produces a
 * decode error on the first block rather than a wrong number later.
 */
async function inflate(bytes: Uint8Array): Promise<Uint8Array> {
  if (typeof DecompressionStream === 'undefined') {
    throw new ViewerError(
      'unsupported',
      'Reading a .hic needs DecompressionStream, which this runtime does not have. ' +
        'Every browser since 2023 has it; a very old one does not.',
      {},
    )
  }
  const stream = new Blob([bytes as BlobPart])
    .stream()
    .pipeThrough(new DecompressionStream('deflate'))
  return new Uint8Array(await new Response(stream).arrayBuffer())
}
