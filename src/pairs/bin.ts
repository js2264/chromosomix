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
 * Measured on the real 4DN file `demo/ecoli/SRR19500734.pairs.gz` — 17.7 M
 * records, 238 MB — and on the same records re-framed, because **the dominant
 * cost is not this code**:
 *
 * | framing | throughput |
 * |---|---|
 * | 64 KiB BGZF members, which is what `bgzip` writes | 0.69 M records/s |
 * | ~1.4 KB members, which is what that file actually has | 0.12 M records/s |
 *
 * The 5.7× is entirely decompression. A deflate stream has a fixed cost per
 * member, and a file framed in 1.4 KB pieces pays it 165,000 times: inflate
 * alone runs at 260 MB/s in Chromium at 64 KiB and 78 MB/s at 1.4 KB. That
 * ceiling is the platform's rather than the browser API's — `fflate`'s pure-JS
 * inflate measures 76 MB/s on the same members, so a dependency would buy
 * nothing and none is taken.
 *
 * So the parser is not the thing to optimise; it is already a minority of the
 * wall time on any normally framed file. What *would* make a finely framed file
 * fast is re-blocking it (`bgzip -d < f.pairs.gz | bgzip > g.pairs.gz`), and
 * that is worth knowing rather than worth working around.
 *
 * 1. **No strings on the hot path.** Fields are located by scanning for tabs
 *    and integers are accumulated digit by digit out of the raw bytes. An
 *    earlier version decoded the two chromosome fields per record; on the same
 *    data it was 2.2× slower, and that one `TextDecoder` call was the whole of
 *    the difference.
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
 * non-decreasing within one `(chrom1, chrom2)` block**, because `pos1` ascends
 * inside a block and the blocks are contiguous. So a row can be emitted the
 * moment `bin1` advances, and the accumulator stays one row wide rather than
 * one file wide. That — and not any global order — is the property that buys
 * the speed, and it holds on every file that is sorted at all.
 *
 * Across blocks the same claim is **false**, and an earlier version of this
 * comment asserted it anyway. The key is `chr1-chr2-pos1-pos2`, so `chrom2`
 * turns over faster than `chrom1`: for a fixed `chrom1` the entire `pos1` run
 * restarts at every new `chrom2`, and `bin1` steps back to the start of that
 * chromosome at each block boundary. A global reorder is therefore the *norm*
 * for any file naming more than one sequence, not the exception — and the
 * check below, written to the old comment, read a correctly sorted
 * two-chromosome file as corrupt because of it.
 *
 * So {@link mergeDuplicates} runs at the end whenever `bin1` fell back at all,
 * and it is not optional: the CSR row pointer in `pairs/store.ts` scans
 * forward once and would silently index a table whose rows were interleaved.
 * The wrong answer is not available. What *is* reported — see
 * {@link BinnedPixels.wasUnsorted} — is the narrower and much rarer thing:
 * disorder the declared sort does not account for.
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
  /**
   * The four orientation curves, or `null` where the file carries no strands.
   *
   * Accumulated in the same pass and costing two more fields off each record —
   * which is why it is here rather than being a second read of the file.
   */
  orientation?: OrientationCurves | null
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
  /**
   * Records whose position column did not hold a number.
   *
   * Counted apart from the unknown-contig tally, and the distinction is the
   * whole reason it exists: the two have completely different causes and
   * completely different fixes. An unknown contig is a file about another
   * assembly; an unparsable position is a `#columns:` line that does not match
   * the records, and reporting it as a missing `#chromsize:` entry would send a
   * reader to fix the header that is already right.
   */
  skippedBadPosition: number
  /** Records whose position ran past the declared contig length. */
  clampedPosition: number
  /**
   * `true` when the *file* was out of its own declared order.
   *
   * Deliberately not the same question as "did the table have to be
   * reordered", which this used to conflate it with. A
   * `#sorted: chr1-chr2-pos1-pos2` file restarts `pos1` at every new `chrom2`,
   * so `bin1` falls back at every block boundary and the reorder runs on
   * essentially every multi-chromosome import; a flag raised there is raised
   * on every real file and carries no information at all.
   *
   * This one is raised only for disorder the declared sort cannot explain:
   * `bin1` going backwards *inside* one `(chrom1, chrom2)` block, or a block
   * reappearing after it was closed — which is what a concatenation of two
   * separately sorted files looks like.
   *
   * It matters that it is right rather than merely conservative, because it
   * does not stay in the importer: it reaches the info panel and the written
   * `.mcool`'s `metadata`, where it is a durable claim about somebody else's
   * file that will outlive the window that made it.
   */
  wasUnsorted: boolean
  /**
   * The file ended without being finished: a partial final member, or no BGZF
   * end-of-file marker.
   *
   * A whole map can be drawn from a truncated file and every number in it is
   * true of the records that arrived — which is exactly why this has to be
   * carried and said. A reader looking at a genome whose last four chromosomes
   * are empty needs to be told the difference between *this library has no
   * contacts there* and *this file stops before it gets there*, and nothing in
   * the picture can tell them.
   *
   * `false` for a plain gzip or an uncompressed file, which carry no framing
   * this side can check — absence of evidence, and not reported as more.
   */
  truncated: boolean
  /**
   * Declared sequences with nothing on their own diagonal.
   *
   * The other half of the same question, and phrased this way because it is the
   * thing a reader can *see*: a contact map's diagonal is its most populated
   * feature, and a sequence missing one is missing from the data.
   *
   * "Named by no record at all" would be the obvious test and is the wrong one.
   * A contact list sorted by first chromosome and then cut still mentions the
   * sequences it never reaches — as the *second* chromosome of a trans contact
   * — so on the file this was written for it reported nothing at all while four
   * chromosomes were plainly empty.
   */
  contigsWithoutCisContacts: string[]
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
/**
 * The four orientation-resolved decay curves a pairs file can answer for.
 *
 * The standard QC on a contact list, and the one reading that is **only**
 * available before binning: two reads ligated in each of the four relative
 * orientations decay identically at long range and wildly differently at short
 * range, because below a few kilobases the counts are dominated by
 * self-circles, dangling ends and undigested fragments rather than by contacts.
 * Where the four curves converge is the **minimum separation a library can be
 * believed at** — the number `pairtools` and `distiller` plot to decide what to
 * throw away, and a number no matrix can produce because binning has already
 * summed the four together.
 *
 * Counted in **log-spaced base-pair bins rather than in the map's bins**, which
 * is what makes the measurement worth having at all: the grid a reader chose is
 * usually 1 kb or coarser and the convergence is usually below it, so a curve
 * on the map's grid would answer the question with one point.
 *
 * Cis only. Two reads on different sequences have no separation, and counting
 * them anywhere on this axis would put a flat floor under all four curves at
 * whatever the trans rate happens to be.
 */
export interface OrientationCurves {
  /** Bin edges in base pairs, `bins + 1` of them, log-spaced. */
  edges: Float64Array
  /**
   * Counts per bin, in the order `++`, `+-`, `-+`, `--`.
   *
   * `+-` is the *inward* pair — the two reads facing each other — which is the
   * one self-circles and undigested fragments inflate, and `-+` the outward one
   * dangling ends inflate. Naming them by the strands rather than by the
   * artefact is deliberate: the file says the strands, and which artefact
   * inflates which orientation is a fact about the protocol.
   */
  counts: [Float64Array, Float64Array, Float64Array, Float64Array]
  /** Records counted, so a curve can be read as a share of the library. */
  total: number
}

/** Names in the order {@link OrientationCurves.counts} holds them. */
export const ORIENTATION_NAMES = ['++', '+-', '-+', '--'] as const

/**
 * The separation axis the orientation curves are counted on.
 *
 * One base pair to the longest sequence, at a **fine** factor: the curves are
 * re-binned for drawing and never drawn at this resolution, so the accumulator's
 * job is to lose as little as possible on the way in. 1.05 is about 47 bins per
 * decade and a few hundred bins over any assembly, which is nothing to hold and
 * nothing to sum.
 */
const ORIENTATION_FACTOR = 1.05

function orientationEdges(longest: number): Float64Array {
  const edges: number[] = [0, 1]
  let at = 1
  while (at < longest) {
    // `+ 1` as well as the factor, so the first decade advances by whole base
    // pairs rather than stalling where `at * 1.05` rounds back to `at`.
    at = Math.max(at + 1, Math.round(at * ORIENTATION_FACTOR))
    edges.push(at)
  }
  return Float64Array.from(edges)
}

/** Which of the four a pair of strand bytes is, or `-1` for anything else. */
function orientationOf(s1: number, s2: number): number {
  if (s1 === PLUS) return s2 === PLUS ? 0 : s2 === MINUS ? 1 : -1
  if (s1 === MINUS) return s2 === PLUS ? 2 : s2 === MINUS ? 3 : -1
  return -1
}

const PLUS = 0x2b
const MINUS = 0x2d

export async function binPairs(
  source: ByteSource,
  options: BinOptions,
): Promise<BinnedPixels | null> {
  const { binSize, contigs, columns } = options
  const oneBased = options.oneBased ?? true
  const chromOffset = chromOffsetsFor(contigs, binSize)
  const nBins = binCountFor(contigs, binSize)
  const index = new ContigIndex(contigs)
  const contigCount = contigs.length
  // The highest column index the four coordinate fields live at, so the record
  // scan can stop there rather than walking the trailing columns — `pair_type`,
  // the two mapqs, and the `sam1`/`sam2` fields, which are hundreds of bytes a
  // record on a pairtools file and are read by nothing here. `Math.max` because
  // `#columns:` fixes no order: `chrom1 chrom2 pos1 pos2 readID` stops at 3 and
  // the pairtools default at 4.
  // The strands are read where the file has them, so the scan has to reach them
  // — which is the whole cost of the orientation curves: two more fields off a
  // record the loop is already walking, and a record whose strands sit past its
  // coordinates is scanned a little further along the line.
  const withStrands = columns.strand1 >= 0 && columns.strand2 >= 0
  const want = withStrands
    ? Math.max(
        columns.chrom1,
        columns.chrom2,
        columns.pos1,
        columns.pos2,
        columns.strand1,
        columns.strand2,
      )
    : Math.max(columns.chrom1, columns.chrom2, columns.pos1, columns.pos2)

  let longestContig = 0
  for (const contig of contigs) longestContig = Math.max(longestContig, contig.length)
  const orientEdges = withStrands ? orientationEdges(longestContig) : null
  const orientCounts: [Float64Array, Float64Array, Float64Array, Float64Array] | null =
    orientEdges === null
      ? null
      : [
          new Float64Array(orientEdges.length - 1),
          new Float64Array(orientEdges.length - 1),
          new Float64Array(orientEdges.length - 1),
          new Float64Array(orientEdges.length - 1),
        ]
  let orientTotal = 0

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
  let skippedBadPosition = 0
  let clampedPosition = 0
  // Two questions, and one boolean used to answer both. `needsReorder` is the
  // mechanical one — did `bin1` ever fall back, so must {@link mergeDuplicates}
  // run — and it is true of almost every file with more than one sequence,
  // because `pos1` restarts at each new `chrom2`. `wasUnsorted` is the one
  // worth reporting: disorder the declared sort does not account for. See
  // {@link BinnedPixels.wasUnsorted}.
  let needsReorder = false
  let wasUnsorted = false
  // The `(chrom1, chrom2)` block being read, normalised to the upper triangle
  // exactly as `b1`/`b2` are below so the two agree, and the blocks already
  // left behind. Tracking stops the moment `wasUnsorted` is set: the answer
  // cannot change back, and the set would otherwise grow with every transition
  // of a thoroughly shuffled file.
  let curPair = -1
  const closedPairs = new Set<number>()
  let truncated = false
  let framingSeen = false
  // One byte per declared sequence, set when a record lands on that sequence's
  // own diagonal. One store per cis record, which is most of them.
  const cisContig = new Uint8Array(contigs.length)
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

    // One left-to-right scan for the four fields, stopped at `want` — the
    // highest column index needed — so a file with twenty columns stops after
    // the fourth. A record with fewer fields than `want` never reaches the
    // bound, runs to end of line as before, and falls out below with its
    // coordinates still `-1`.
    let field = 0
    let start = 0
    let c1 = -1
    let c2 = -1
    let p1 = -1
    let p2 = -1
    let s1 = -1
    let s2 = -1
    const end = line.length
    for (let i = 0; i <= end; i++) {
      if (i !== end && line[i] !== TAB) continue
      if (field === columns.chrom1) c1 = index.lookup(line, start, i)
      else if (field === columns.chrom2) c2 = index.lookup(line, start, i)
      else if (field === columns.pos1) p1 = readInt(line, start, i)
      else if (field === columns.pos2) p2 = readInt(line, start, i)
      // One byte each, and only the first: a strand field is `+` or `-` in
      // every file that has one, and decoding it would allocate a string per
      // record for a character.
      else if (withStrands && field === columns.strand1) s1 = i > start ? line[start] : -1
      else if (withStrands && field === columns.strand2) s2 = i > start ? line[start] : -1
      field++
      if (field > want) break
      start = i + 1
    }

    if (c1 < 0 || c2 < 0) {
      skippedUnknownContig++
      return
    }
    if (p1 < 0 || p2 < 0) {
      skippedBadPosition++
      return
    }

    if (orientCounts !== null && orientEdges !== null && c1 === c2) {
      const which = orientationOf(s1, s2)
      if (which >= 0) {
        // The **record's own** separation, not the bins': the whole point of
        // this axis is that it is finer than the grid the reader chose.
        const separation = Math.abs(p2 - p1)
        let lo = 0
        let hi = orientEdges.length - 1
        while (lo + 1 < hi) {
          const mid = (lo + hi) >> 1
          if (orientEdges[mid] <= separation) lo = mid
          else hi = mid
        }
        orientCounts[which][lo]++
        orientTotal++
      }
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

    if (c1 === c2) cisContig[c1] = 1

    // A new block is the one place the declared sort permits `bin1` to fall
    // back. A block that has been here before is not: the file left it and
    // came back, which is what a concatenation of two sorted halves looks
    // like, and no single `chr1-chr2-pos1-pos2` sort produces it.
    //
    // The *order* the blocks come in is deliberately not checked. A sorter
    // ranks chromosomes however its chromsizes file did, which need not be the
    // order this header lists them in — `chr10` before `chr2` is a perfectly
    // sorted file — so block order carries no signal and testing it would put
    // back exactly the kind of false accusation this replaced.
    let pairChanged = false
    if (!wasUnsorted) {
      const pair = c1 <= c2 ? c1 * contigCount + c2 : c2 * contigCount + c1
      if (pair !== curPair) {
        pairChanged = true
        if (curPair >= 0) closedPairs.add(curPair)
        if (closedPairs.has(pair)) {
          wasUnsorted = true
          closedPairs.clear()
        }
        curPair = pair
      }
    }

    if (b1 !== curRow) {
      // The one thing the sort is trusted for, and the one thing that is
      // checked. `bin1` arriving below the open row means the rows are being
      // emitted out of order and the merge pass has to repair them, whatever
      // the cause — that is `needsReorder`, and on a multi-chromosome file it
      // fires at every block boundary and means nothing is wrong. Falling back
      // *within* a block has no such innocent reading: there the file is not
      // in the order it declares.
      if (b1 < curRow) {
        needsReorder = true
        if (!pairChanged) wasUnsorted = true
      }
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
      // Only a *whole-file* read can conclude anything from the framing: a span
      // ends where the index pointed, which is mid-member by construction.
      if (options.spans === undefined) {
        streamOptions.onFraming = (info) => {
          framingSeen = true
          if (info.partialMember || !info.endedOnEofMarker) truncated = true
        }
      }

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
    skippedBadPosition,
    clampedPosition,
    wasUnsorted,
    truncated: framingSeen && truncated,
    contigsWithoutCisContacts: contigs
      .filter((_, index) => cisContig[index] === 0)
      .map((contig) => contig.name),
    orientation:
      orientEdges === null || orientCounts === null
        ? null
        : { edges: orientEdges, counts: orientCounts, total: orientTotal },
  }
  return needsReorder ? mergeDuplicates(result) : result
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
 * Put a pixel table whose `bin1` fell back into cooler's own order.
 *
 * A counting sort on `bin1` — which is exact, linear, and needs one pass to
 * count and one to place — then each row's columns put in order and equal
 * `(bin1, bin2)` pairs merged. Rows are short, so the per-row work is on tens
 * of entries rather than on the whole table.
 *
 * The name undersells what this mostly does. On a correctly sorted
 * multi-chromosome file it merges *nothing* — distinct `chrom2` blocks occupy
 * disjoint `bin2` ranges, so no cell is ever emitted twice — and every one of
 * its passes is spent reordering the blocks `chr1-chr2-pos1-pos2` interleaved.
 * That is the common case, not the broken one, which is why the row sort is
 * skipped when the row does not need it.
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
    // Whether this row actually needs sorting, asked rather than assumed. The
    // gather above is stable, so a row's columns arrive in file order — and
    // that is already ascending on a well-formed file, because `flushRow`
    // emitted each block's `touched` list sorted and successive blocks for one
    // `bin1` fall in disjoint, ascending `bin2` ranges. Since the reorder now
    // runs on nearly every multi-chromosome import rather than on the rare
    // broken file, the sort it used to pay unconditionally is nearly always
    // pure cost: one boxed `Array` and one comparator sort *per row*, which is
    // one JS array per row of a 3 M-row human grid. The check is a linear scan
    // of the row and allocates nothing.
    let ordered = true
    for (let at = lo + 1; at < hi; at++) {
      if (colOf[at] < colOf[at - 1]) {
        ordered = false
        break
      }
    }
    const order = ordered ? null : Array.from({ length: hi - lo }, (_, i) => lo + i)
    order?.sort((a, b) => colOf[a] - colOf[b])
    let lastCol = -1
    for (let k = 0; k < hi - lo; k++) {
      const at = order === null ? lo + k : order[k]
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
