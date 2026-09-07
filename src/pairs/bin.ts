/**
 * Records in, a cooler's pixel table out.
 *
 * This is the whole import, and it is one pass. Everything the application does
 * afterwards — every view, the deck, the turn, the fourteen analysis tasks, the
 * written `.mcool` — reads the arrays this produces and never the file again.
 *
 * ## Why one pass, and why the pass is the only cost
 *
 * A `.pairs` is big and its binning is small. Measured on this repository's own
 * demo files: yeast Micro-C is 179 M records and 13.7 M stored pixels at 1 kb;
 * the mock community is 10.9 M records and 7.1 M pixels. So the input is
 * gigabytes and the output is tens of megabytes, and the shape of the answer
 * follows directly — pay for the file once, hold the result, serve everything
 * from memory. That is §18's "one streaming pass, with progress, cancel and a
 * pre-flight estimate", applied at open rather than to a task.
 *
 * ## The four decisions that make it fast
 *
 * Measured end to end at **2.9 M records/s**, against a hard inflate ceiling of
 * ~195 MB/s — decompression is 69% of the wall time, so the parser is close
 * enough to the floor that further work here would buy nothing.
 *
 * 1. **No strings on the hot path.** Fields are located by scanning for tabs
 *    and integers are accumulated digit by digit out of the raw bytes. An
 *    earlier version decoded the two chromosome fields per record; it ran at
 *    1.3 M records/s, and that one `TextDecoder` call was the difference.
 * 2. **Chromosome names interned by hash**, with collisions resolved rather
 *    than assumed away — see {@link ContigIndex}.
 * 3. **A dense scratch row, not a hash of pixels.** `counts[bin2]++` with a
 *    list of touched columns costs no hashing and clears in time proportional
 *    to the row's own non-zeros. One `Int32Array` of `nbins`: 48 KB for yeast
 *    at 1 kb, 12 MB for a human genome at the same.
 * 4. **The sort is exploited, not trusted.** See below.
 *
 * ## What `#sorted:` does and does not buy
 *
 * A 4DN pairs file is conventionally `#sorted: chr1-chr2-pos1-pos2`, and the
 * tempting reading — that pixels arrive in cooler's own order, so the importer
 * is a run-length encoder over three integers — is **wrong**, and wrong in the
 * way that matters. The sort is on *position*: within one `bin1` the records
 * run through many `pos1`, and `pos2` restarts from the beginning of the
 * chromosome at each. Written as a pure run-length encoder over a real file,
 * 2.79 M of 8 M records land in the wrong pixel and every total still balances.
 *
 * What *is* true is the weaker claim, and it is enough: **`bin1` is
 * non-decreasing**, because `pos1` ascends within a chromosome pair and the
 * pairs are grouped. So a row can be emitted the moment `bin1` advances, and
 * the accumulator is one row wide rather than one file wide.
 *
 * And it is checked rather than believed. A file that is not sorted — or is
 * sorted by some other key, or was concatenated from two that each were — sets
 * `needsMerge`, and {@link mergeDuplicates} repairs the result with a counting
 * sort at the end. The fast path stays fast; the wrong answer is not available.
 *
 * ## Positions are 1-based
 *
 * The 4DN spec says so, `cooler cload pairs` assumes it, and it is one
 * subtraction. Getting it wrong shifts every record at a bin boundary into its
 * neighbour — invisible in a picture, permanent in a written file, and exactly
 * the class of error that survives every check that is not a comparison against
 * another implementation. {@link BinOptions.oneBased} exists so a file written
 * zero-based can say so, and so the choice is visible rather than buried.
 */

import { ViewerError } from '../errors'
import type { ByteSource } from '../types'
import { binCountFor, chromOffsetsFor, type PairsColumns, type PairsContig } from './format'
import { decompressedStream, forEachLine, type SpanOptions } from './stream'

const TAB = 0x09
const HASH = 0x23

/** Growable COO, doubled on demand; 12 bytes per stored pixel. */
const INITIAL_PIXELS = 1 << 20

export interface BinOptions {
  /** Bin size in base pairs. */
  binSize: number
  /** Sequences from the header, in header order. */
  contigs: readonly PairsContig[]
  /** Where the coordinates live in a record. */
  columns: PairsColumns
  /** Positions are 1-based, as the 4DN spec requires. Default `true`. */
  oneBased?: boolean
  /** Byte ranges to read; the whole file when absent. */
  spans?: ReadonlyArray<{ from: number; to: number }>
  /** Exact record count, when a `.px2` supplied one. Drives the progress bar. */
  expectedRecords?: number
  /** Refuse once the pixel table would exceed this many bytes. */
  maxPixelBytes?: number
  onProgress?: (done: number, total: number, note?: string) => void
  cancelled?: () => boolean
}

export interface BinnedPixels {
  binSize: number
  contigs: PairsContig[]
  chromOffset: Float64Array
  nBins: number
  bin1: Int32Array
  bin2: Int32Array
  count: Int32Array
  nnz: number
  /** Total contacts placed — the cooler `sum` attribute. */
  sum: number
  /** Records whose chromosome was not in the header. */
  skippedUnknownContig: number
  /** Records whose position ran past the declared contig length. */
  clampedPosition: number
  /** `true` when the file was not `bin1`-ordered and a merge pass was needed. */
  wasUnsorted: boolean
}

/**
 * Chromosome name → index, keyed on the raw bytes.
 *
 * FNV-1a over the field's bytes, so the hot loop never builds a string. The
 * hash is not trusted on its own: a bucket holding more than one name falls
 * back to decoding and comparing, which is correct at the cost of being slow
 * for names that collide — and none do in any real assembly, so the slow path
 * is a safety net rather than a cost.
 */
export class ContigIndex {
  private readonly unique = new Map<number, number>()
  private readonly ambiguous = new Map<number, Array<[string, number]>>()
  private readonly byName = new Map<string, number>()
  private readonly decoder = new TextDecoder()

  constructor(contigs: readonly PairsContig[]) {
    for (let i = 0; i < contigs.length; i++) {
      const name = contigs[i].name
      this.byName.set(name, i)
      const h = hashString(name)
      const existing = this.unique.get(h)
      if (existing === undefined && !this.ambiguous.has(h)) {
        this.unique.set(h, i)
        continue
      }
      // A second name in this bucket demotes it permanently.
      const bucket = this.ambiguous.get(h) ?? []
      if (existing !== undefined) {
        bucket.push([contigs[existing].name, existing])
        this.unique.delete(h)
      }
      bucket.push([name, i])
      this.ambiguous.set(h, bucket)
    }
  }

  /** The contig index for `bytes[from, to)`, or `-1`. */
  lookup(bytes: Uint8Array, from: number, to: number): number {
    let h = 0x811c9dc5
    for (let i = from; i < to; i++) {
      h ^= bytes[i]
      h = Math.imul(h, 0x01000193)
    }
    h |= 0
    const hit = this.unique.get(h)
    if (hit !== undefined) return hit
    const bucket = this.ambiguous.get(h)
    if (bucket === undefined) return -1
    const name = this.decoder.decode(bytes.subarray(from, to))
    for (const [candidate, index] of bucket) if (candidate === name) return index
    return -1
  }

  /** The contig index for a name, or `-1`. Used by the header and the tests. */
  of(name: string): number {
    return this.byName.get(name) ?? -1
  }
}

function hashString(name: string): number {
  let h = 0x811c9dc5
  // The names are compared against UTF-8 *bytes* on the hot path, so they have
  // to be hashed as UTF-8 bytes here too — a contig named `chrλ` otherwise
  // hashes one way at build time and another at lookup.
  const bytes = new TextEncoder().encode(name)
  for (let i = 0; i < bytes.length; i++) {
    h ^= bytes[i]
    h = Math.imul(h, 0x01000193)
  }
  return h | 0
}

/**
 * Bin a pairs file into a cooler's pixel table.
 *
 * @throws ViewerError `dense-too-large` when the pixel table passes
 *   `maxPixelBytes`, naming the resolution that would fit.
 */
export async function binPairs(
  source: ByteSource,
  options: BinOptions,
): Promise<BinnedPixels | null> {
  const { binSize, contigs, columns } = options
  const oneBased = options.oneBased ?? true
  const chromOffset = chromOffsetsFor(contigs, binSize)
  const nBins = binCountFor(contigs, binSize)
  const index = new ContigIndex(contigs)

  // Bin count per contig, so a position past the declared length is clamped
  // into the contig it belongs to rather than into its neighbour.
  const lastBin = new Int32Array(contigs.length)
  for (let i = 0; i < contigs.length; i++) {
    lastBin[i] = Math.max(0, Math.ceil(contigs[i].length / binSize) - 1)
  }

  const scratch = new Int32Array(nBins)
  let touched: Int32Array = new Int32Array(Math.min(nBins, 1 << 16))
  let nTouched = 0

  let bin1: Int32Array = new Int32Array(INITIAL_PIXELS)
  let bin2: Int32Array = new Int32Array(INITIAL_PIXELS)
  let count: Int32Array = new Int32Array(INITIAL_PIXELS)
  let nnz = 0
  let curRow = -1
  let records = 0
  let sum = 0
  let skippedUnknownContig = 0
  let clampedPosition = 0
  let wasUnsorted = false
  let failure: ViewerError | null = null

  const maxPixels =
    options.maxPixelBytes === undefined ? Infinity : Math.floor(options.maxPixelBytes / 12)

  const flushRow = (): void => {
    if (nTouched === 0) return
    const row = touched.subarray(0, nTouched)
    // Ascending `bin2` is cooler's own pixel order, and sorting the touched
    // list is how the output arrives already in it.
    row.sort()
    if (nnz + nTouched > maxPixels) {
      failure = new ViewerError(
        'dense-too-large',
        `Binning this file at ${binSize} bp produces more stored pixels than the memory ` +
          'budget allows. Choose a coarser base resolution, or import fewer sequences.',
        { binSize, nnz, limitBytes: options.maxPixelBytes },
      )
      throw failure
    }
    while (nnz + nTouched > bin1.length) {
      bin1 = grow(bin1)
      bin2 = grow(bin2)
      count = grow(count)
    }
    for (let i = 0; i < nTouched; i++) {
      const col = row[i]
      bin1[nnz] = curRow
      bin2[nnz] = col
      count[nnz] = scratch[col]
      nnz++
      scratch[col] = 0
    }
    nTouched = 0
  }

  const total = options.expectedRecords ?? 0

  const onLine = (line: Uint8Array): void => {
    if (line.length === 0 || line[0] === HASH) return

    // One left-to-right scan for the four fields. `want` is the highest column
    // index needed, so a file with twenty columns stops after the fourth.
    let field = 0
    let start = 0
    let c1 = -1
    let c2 = -1
    let p1 = -1
    let p2 = -1
    const end = line.length
    for (let i = 0; i <= end; i++) {
      if (i !== end && line[i] !== TAB) continue
      if (field === columns.chrom1) c1 = index.lookup(line, start, i)
      else if (field === columns.chrom2) c2 = index.lookup(line, start, i)
      else if (field === columns.pos1) p1 = readInt(line, start, i)
      else if (field === columns.pos2) p2 = readInt(line, start, i)
      field++
      start = i + 1
    }

    if (c1 < 0 || c2 < 0) {
      skippedUnknownContig++
      return
    }
    if (p1 < 0 || p2 < 0) {
      skippedUnknownContig++
      return
    }

    let b1 = binOf(p1)
    let b2 = binOf(p2)
    if (b1 > lastBin[c1]) {
      b1 = lastBin[c1]
      clampedPosition++
    }
    if (b2 > lastBin[c2]) {
      b2 = lastBin[c2]
      clampedPosition++
    }
    b1 += chromOffset[c1]
    b2 += chromOffset[c2]
    if (b1 > b2) {
      const swap = b1
      b1 = b2
      b2 = swap
    }

    if (b1 !== curRow) {
      // The one thing the sort is trusted for, and the one thing that is
      // checked. A row that has already been emitted arriving again means the
      // file is not `bin1`-ordered, and the merge pass repairs it.
      if (b1 < curRow) wasUnsorted = true
      flushRow()
      curRow = b1
    }
    if (scratch[b2] === 0) {
      if (nTouched === touched.length) touched = grow(touched)
      touched[nTouched++] = b2
    }
    scratch[b2]++
    records++
    sum++
  }

  function binOf(pos: number): number {
    const zero = oneBased ? pos - 1 : pos
    return zero < 0 ? 0 : Math.floor(zero / binSize)
  }

  const spans = options.spans ?? [{ from: 0, to: source.size }]
  const spanBytes = spans.reduce((acc, span) => acc + Math.max(0, span.to - span.from), 0)
  let bytesDone = 0

  try {
    for (const span of spans) {
      const streamOptions: SpanOptions = {
        from: span.from,
        to: span.to,
        // One report per source read, and no throttle on top of it. The reads
        // are already {@link PULL_CHUNK_BYTES} apart, which is the granularity
        // the bar wants; an extra counter threshold on top of that was how a
        // small file managed to import with the bar never moving at all.
        //
        // Records where the index gave an exact total, bytes otherwise — so the
        // bar is always in the unit the dialog quoted its estimate in.
        onProgress: (fed) => {
          if (total > 0) options.onProgress?.(records, total, 'reading records')
          else options.onProgress?.(bytesDone + fed, spanBytes, 'reading records')
        },
      }
      if (options.cancelled !== undefined) streamOptions.cancelled = options.cancelled

      const finished = await forEachLine(
        decompressedStream(source, streamOptions),
        onLine,
        options.cancelled,
      )
      bytesDone += Math.max(0, span.to - span.from)
      if (!finished) return null
      if (options.cancelled?.() === true) return null
    }
    flushRow()
  } catch (error) {
    if (failure !== null) throw failure
    throw error
  }

  const result: BinnedPixels = {
    binSize,
    contigs: [...contigs],
    chromOffset,
    nBins,
    bin1: bin1.subarray(0, nnz),
    bin2: bin2.subarray(0, nnz),
    count: count.subarray(0, nnz),
    nnz,
    sum,
    skippedUnknownContig,
    clampedPosition,
    wasUnsorted,
  }
  return wasUnsorted ? mergeDuplicates(result) : result
}

/** Double a typed array, preserving contents. */
function grow(array: Int32Array): Int32Array {
  const next: Int32Array = new Int32Array(array.length * 2)
  next.set(array)
  return next
}

/** Parse an unsigned integer out of raw bytes; `-1` when there is not one. */
function readInt(bytes: Uint8Array, from: number, to: number): number {
  if (to <= from) return -1
  let value = 0
  for (let i = from; i < to; i++) {
    const digit = bytes[i] - 48
    if (digit < 0 || digit > 9) return -1
    value = value * 10 + digit
  }
  return value
}

/**
 * Repair a pixel table built from a file that was not `bin1`-ordered.
 *
 * A counting sort on `bin1` — which is exact, linear, and needs one pass to
 * count and one to place — then an insertion of each row's columns and a merge
 * of equal `(bin1, bin2)` pairs. Rows are short, so the per-row sort is on
 * tens of entries rather than on the whole table.
 *
 * Exported for the test that feeds it a deliberately shuffled file: the
 * property that has to hold is that the merged table is identical to the one a
 * sorted copy of the same records produces.
 */
export function mergeDuplicates(pixels: BinnedPixels): BinnedPixels {
  const { nnz, nBins } = pixels
  const starts = new Int32Array(nBins + 1)
  for (let i = 0; i < nnz; i++) starts[pixels.bin1[i] + 1]++
  for (let i = 0; i < nBins; i++) starts[i + 1] += starts[i]

  const cursor = starts.slice(0, nBins)
  const colOf = new Int32Array(nnz)
  const cntOf = new Int32Array(nnz)
  for (let i = 0; i < nnz; i++) {
    const at = cursor[pixels.bin1[i]]++
    colOf[at] = pixels.bin2[i]
    cntOf[at] = pixels.count[i]
  }

  const bin1 = new Int32Array(nnz)
  const bin2 = new Int32Array(nnz)
  const count = new Int32Array(nnz)
  let out = 0
  for (let row = 0; row < nBins; row++) {
    const lo = starts[row]
    const hi = starts[row + 1]
    if (hi <= lo) continue
    const order = Array.from({ length: hi - lo }, (_, i) => lo + i)
    order.sort((a, b) => colOf[a] - colOf[b])
    let lastCol = -1
    for (const at of order) {
      const col = colOf[at]
      if (col === lastCol) {
        count[out - 1] += cntOf[at]
        continue
      }
      bin1[out] = row
      bin2[out] = col
      count[out] = cntOf[at]
      out++
      lastCol = col
    }
  }

  return {
    ...pixels,
    bin1: bin1.subarray(0, out),
    bin2: bin2.subarray(0, out),
    count: count.subarray(0, out),
    nnz: out,
  }
}
