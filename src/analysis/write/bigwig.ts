/**
 * A bigWig, written here, in this tab, with nothing installed.
 *
 * A bigWig is what a reader actually wants at the end of the day. It is what a
 * genome browser opens, it is what a colleague expects to be sent, and it is the
 * one file an analysis can produce that keeps working long after the app that
 * made it is closed. Every alternative to writing it here ends in the same
 * sentence — *now convert it with `bedGraphToBigWig`* — and that sentence is a
 * command-line dependency in an application whose whole claim is that it has
 * none (§18.7). So the writer is native, it adds no npm dependency, and it is
 * read back through this repo's own `@gmod/bbi` in the test suite, because a
 * writer nobody reads back is a writer that is wrong.
 *
 * **What makes it affordable is that the input is never arbitrary.** One value
 * per bin, over an assembly whose contigs and lengths are already known, at a
 * fixed bin size. There is no sorting to do, no interval arithmetic to get
 * wrong, no variable-span sections to reason about, and a whole genome's worth
 * of bins is kilobytes — so the file is assembled in memory and the header is
 * written last, against offsets that are known by then. This is deliberately
 * *not* a general BBI writer, and building one would have cost more and bought
 * nothing this app can use.
 *
 * The six decisions of §18.7, each stated where it is taken below:
 *
 * 1. **bedGraph-typed sections (`type = 1`), never fixedStep.** Twelve bytes per
 *    item instead of four, which over a yeast genome is 145 kB against 48 kB
 *    before compression — irrelevant. What it buys is two correctness problems
 *    deleted rather than handled: a bin with no value is *omitted* instead of
 *    written as a `NaN` that every downstream tool would report as a value, and
 *    the last bin of a contig — partial, because a sequence length is not a
 *    multiple of the bin size — is written with its true end rather than
 *    overrunning the sequence. One code path and no clamping bug.
 * 2. **zlib through the platform's own `CompressionStream`**, by way of
 *    `deflateBytes` in `ui/export.ts`, which already produces exactly the RFC
 *    1950 framing BBI sections use for the PDF writer. Where it is absent the
 *    file goes out uncompressed with `uncompressBufSize = 0`, which is a legal
 *    bigWig and beats refusing to export.
 * 3. **One bottom-up tree builder for both trees** — see `tree.ts`.
 * 4. **Offsets by a push-and-running-length accumulator**, the same one
 *    `ui/export.ts` uses to place PDF objects.
 * 5. **A zoom ladder from the base vector**: first reduction at ten times the bin
 *    size, then four times per level, ten levels at most, stopping at the level
 *    that holds fewer records than a tree node holds items. Every level is an
 *    aggregation of the base intervals, never a re-reading of a coarser one.
 * 6. **Little-endian throughout**, which is what UCSC writes on x86 and what
 *    every reader detects from the magic number rather than being told.
 *
 * **Two header fields were settled by measurement rather than by reading a
 * table**, since they are where writers most commonly disagree, and both were
 * checked against the six real bigWigs in `demo/yeast/`:
 *
 * - The u64 at `fullDataOffset` is the number of **sections**, not the number of
 *   data items. In `Yeast_ChIP_Pol2-vs-input.bw` it reads 658, which is exactly
 *   the R-tree's leaf count, against 1,771,581 items actually on disk.
 * - `itemsPerSlot` in an R-tree header is how many indexed things one leaf slot
 *   accounts for, which for the unzoomed index is **one section per slot** and
 *   therefore `1` — not the 1024 items a section happens to hold. The zoom
 *   indexes carry 1024 there, which is their records per block. Both are written
 *   that way below.
 *
 * Two further things the same measurement settled, because they are not
 * obvious either: the total-summary `validCount` counts **bases covered** and
 * not items, with `sumData` and `sumSquares` likewise weighted by each
 * interval's span; and the count in front of a zoom level's data is a u32
 * holding that level's **block** count, not its record count — the asymmetry
 * with the u64 at `fullDataOffset` is real.
 */

import { deflateBytes } from '../../ui/export'
import { planTree, TREE_NODE_HEADER_BYTES } from './tree'

/** One sequence of the assembly. */
export interface BigWigContig {
  name: string
  length: number
}

/**
 * One sequence's data as the intervals it actually is, for data on no grid.
 *
 * Ascending and non-overlapping, in the sequence's own coordinates. Values that
 * are not finite are dropped, exactly as a `NaN` bin is on the other road — see
 * {@link intervalsFor}.
 */
export interface BigWigSpans {
  contig: string
  starts: ArrayLike<number>
  ends: ArrayLike<number>
  values: ArrayLike<number>
}

/**
 * Everything the writer needs, and nothing it does not — in one of two shapes.
 *
 * **A bin vector** is what a task produces: one value per bin over the whole
 * assembly, on a grid the caller states. Every analysis output is this, because
 * every analysis output is a measurement *per bin*.
 *
 * **Spans** are what a comparison of two loaded tracks is, and they are here
 * because forcing that onto a grid was silently destroying data. A ratio of two
 * base-resolution bigWigs is exact at every base — the lane draws it that way,
 * cut at every boundary of either operand — and the export read both operands
 * onto the contact map's bins first, so a reader who divided two 10 bp tracks
 * on a 20 kb map got a 20 kb bigWig back and nothing said so. Nothing about the
 * file format required it: a bedGraph section holds arbitrary intervals, which
 * is decision 1 above, and the grid was an assumption in the *caller*.
 *
 * Everything past {@link intervalsFor} is identical for the two: sections, both
 * trees, the summary and the zoom ladder all work on intervals and never learn
 * which road produced them.
 */
export type BigWigInput = BigWigBins | BigWigIntervals

/** Values on a grid the caller states — every analysis output. */
export interface BigWigBins {
  /** Sequences of the assembly, in the order the file lists them. */
  contigs: readonly BigWigContig[]
  /** One value per bin over the WHOLE assembly, NaN where there is none. */
  values: Float32Array
  /** Absolute bin index values[0] corresponds to. */
  firstBin: number
  binsize: number
  spans?: undefined
}

/** Values on no grid at all — a comparison of two loaded tracks. */
export interface BigWigIntervals {
  /** Sequences of the assembly, in the order the file lists them. */
  contigs: readonly BigWigContig[]
  /** The data, per sequence. A sequence with none may be left out. */
  spans: readonly BigWigSpans[]
  values?: undefined
}

const BIGWIG_MAGIC = 0x888ffc26
const BPT_MAGIC = 0x78ca8c91
const RTREE_MAGIC = 0x2468ace0

/** Version 4 is what every reader in circulation expects of a bigWig. */
const BBI_VERSION = 4

const HEADER_BYTES = 64
const ZOOM_HEADER_BYTES = 24
const TOTAL_SUMMARY_BYTES = 40
const BPT_HEADER_BYTES = 32
/** `chromId` u32 plus `chromSize` u32, which is what `valSize` announces. */
const BPT_VALUE_BYTES = 8
const RTREE_HEADER_BYTES = 48
const RTREE_LEAF_ITEM_BYTES = 32
const RTREE_INTERNAL_ITEM_BYTES = 24
const SECTION_HEADER_BYTES = 24
const BEDGRAPH_ITEM_BYTES = 12
const ZOOM_RECORD_BYTES = 32

/** Decision 1: bedGraph, so that a gap is a gap and a short final bin is short. */
const SECTION_TYPE_BEDGRAPH = 1

/**
 * Items per node in both trees. 256 is what UCSC writes; the number matters
 * only in that it is what makes the chromosome tree multi-level once an assembly
 * passes it, which a metagenome does and a yeast genome does not.
 */
const TREE_FAN_OUT = 256

/** Items per section, and records per zoom block — UCSC's figure for both. */
const ITEMS_PER_SECTION = 1024
const ZOOM_RECORDS_PER_BLOCK = 1024

/** Decision 5, the whole ladder. */
const FIRST_REDUCTION_FACTOR = 10
const REDUCTION_STEP = 4
const MAX_ZOOM_LEVELS = 10

/**
 * `reductionLevel` is a u32 in a zoom header, so a ladder that walked past this
 * would wrap silently and advertise a level coarser than the genome as a level
 * finer than a gene. The coarsest rung of a full ladder is 4^9 × 10 × the bin
 * size, which passes 2^32 at any bin size over about 1,600 bases — well inside
 * the range this app hands out.
 */
const MAX_REDUCTION = 0xffffffff

/**
 * A rough compression ratio for {@link bigWigBytesEstimate} only, measured on
 * the demo bigWigs. Never used to size anything the file depends on.
 */
const ASSUMED_COMPRESSION = 0.4

/** A contig, with the two things the writer needs that the caller did not give. */
interface PlannedContig {
  name: string
  length: number
  /**
   * The contig's id in the file, which is its rank in **name** order rather than
   * its position in the caller's list. Every UCSC-written bigWig numbers contigs
   * that way, the B+ tree has to be in collating order for a binary-searching
   * reader to find anything in it, and the R-tree is sorted on the same key — so
   * one order serves all three. The caller's order is preserved where it
   * actually means something, which is the bin grid: {@link binOffset} below.
   */
  id: number
  /** Absolute index, in the caller's grid, of this contig's first bin. */
  binOffset: number
  binCount: number
}

/** One bin that had a value: exactly what goes into a bedGraph item. */
interface Interval {
  start: number
  end: number
  value: number
}

/** Where a block sits and what it spans, which is all the R-tree indexes. */
interface IndexedBlock {
  startChromId: number
  startBase: number
  endChromId: number
  endBase: number
  offset: number
  size: number
}

/** The four bounds of an R-tree item, before it has a place in the file. */
interface Bounds {
  startChromId: number
  startBase: number
  endChromId: number
  endBase: number
}

/** One aggregated window at one reduction level. */
interface ZoomRecord {
  chromId: number
  start: number
  end: number
  validCount: number
  min: number
  max: number
  sum: number
  sumSquares: number
}

/** What the 40-byte total summary says about the whole file. */
interface Summary {
  validCount: number
  min: number
  max: number
  sum: number
  sumSquares: number
}

// ---------------------------------------------------------------------------
// The assembly
// ---------------------------------------------------------------------------

/**
 * Contigs in file order, each knowing where its bins are in the caller's vector.
 *
 * The two orders are separated here once and never again: the caller's order
 * defines the bin grid, because `firstBin` counts bins along the contigs as the
 * caller listed them, and name order defines the ids, because that is what the
 * two indexes are sorted on. Conflating them would put every value on the wrong
 * sequence in a file that still opens cleanly, which is the failure mode worth
 * spending a paragraph to avoid.
 */
function planContigs(input: BigWigInput): PlannedContig[] {
  const { contigs } = input
  // A bin size only where there are bins. The grid checks below are about a
  // *vector* — how long it is, and where its first element sits — and there is
  // no vector on the spans road; the contig checks are about the assembly and
  // apply to both.
  const binsize = input.values === undefined ? 1 : input.binsize
  if (!Number.isInteger(binsize) || binsize < 1) {
    throw new Error(`A bigWig needs a whole bin size of at least one base; got ${binsize}.`)
  }
  if (contigs.length === 0) throw new Error('A bigWig needs at least one contig.')

  const seen = new Set<string>()
  const planned: PlannedContig[] = []
  let binOffset = 0
  for (const contig of contigs) {
    if (contig.name === '') throw new Error('A contig with an empty name cannot be written.')
    if (seen.has(contig.name)) throw new Error(`Two contigs are called ${contig.name}.`)
    seen.add(contig.name)
    if (!Number.isInteger(contig.length) || contig.length < 1) {
      throw new Error(`${contig.name} has length ${contig.length}, which is not a sequence.`)
    }
    const binCount = input.values === undefined ? 0 : Math.ceil(contig.length / binsize)
    planned.push({ name: contig.name, length: contig.length, id: 0, binOffset, binCount })
    binOffset += binCount
  }

  if (input.values !== undefined) {
    const { firstBin, values } = input
    if (!Number.isInteger(firstBin) || firstBin < 0) {
      throw new Error(`firstBin must be a whole, non-negative bin index; got ${firstBin}.`)
    }
    // A vector that runs past the last bin of the assembly means the caller's
    // grid and this one disagree, and every value would then be attributed to
    // the wrong place quietly. Cheaper to refuse than to explain later.
    if (firstBin + values.length > binOffset) {
      throw new Error(
        `The value vector covers bins ${firstBin}–${firstBin + values.length} but the assembly ` +
          `only has ${binOffset} bins at this bin size.`,
      )
    }
  } else {
    // The same class of disagreement on the other road: a span naming a sequence
    // the assembly does not list has nowhere to go, and dropping it silently
    // would write a file missing data the caller believes is in it.
    const known = new Set(contigs.map((contig) => contig.name))
    for (const span of input.spans) {
      if (!known.has(span.contig)) {
        throw new Error(`There are spans on ${span.contig}, which is not in the assembly.`)
      }
      if (span.starts.length !== span.ends.length || span.starts.length !== span.values.length) {
        throw new Error(`${span.contig}'s starts, ends and values are of different lengths.`)
      }
    }
  }

  // Collated by UTF-8 bytes rather than by JavaScript's UTF-16 comparison,
  // because the B+ tree stores keys as bytes and a reader binary-searches them
  // as bytes. The two agree on ASCII contig names and part company above it.
  const encoder = new TextEncoder()
  const keys = new Map<string, Uint8Array>()
  for (const contig of planned) keys.set(contig.name, encoder.encode(contig.name))
  planned.sort((a, b) => compareBytes(keys.get(a.name)!, keys.get(b.name)!))
  planned.forEach((contig, id) => {
    contig.id = id
  })
  return planned
}

/** `memcmp`, with the shorter key first when one is a prefix of the other. */
function compareBytes(a: Uint8Array, b: Uint8Array): number {
  const shared = Math.min(a.length, b.length)
  for (let i = 0; i < shared; i += 1) {
    if (a[i] !== b[i]) return a[i] - b[i]
  }
  return a.length - b.length
}

/**
 * The bins of one contig that carry a value, as bedGraph intervals.
 *
 * Both halves of decision 1 are here and nowhere else. A `NaN` bin produces no
 * interval at all, so a downstream tool asking about that range is told there is
 * no data rather than handed a number that is not one; and the final interval's
 * end is clamped to the sequence length, so a 7,500-base contig at a 1 kb bin
 * size ends at 7,500 and not at 8,000. A fixedStep section could express neither
 * without a second code path for each.
 *
 * **`±Infinity` is dropped here too, and not only `NaN`.** BBI has no way to
 * write one: it would go into the total summary and into every zoom record over
 * it, where `sumData` becomes `NaN` and the bounds become infinite — a file that
 * opens cleanly in every reader with its autoscale and its mean destroyed, and
 * which with only `+Infinity` present is not even visibly broken because `min`
 * is still finite. That is strictly worse than the interval being absent, which
 * is a state every reader already understands. A task that produces an infinity
 * — a ratio with a zero denominator is the obvious way — has a bug of its own,
 * and the honest place to fix it is the task; this is the backstop that keeps
 * the bug out of the file.
 */
function intervalsFor(contig: PlannedContig, input: BigWigInput): Interval[] {
  return input.values === undefined
    ? spansOf(contig, input.spans)
    : binsOf(contig, input.values, input.firstBin, input.binsize)
}

function binsOf(
  contig: PlannedContig,
  values: Float32Array,
  firstBin: number,
  binsize: number,
): Interval[] {
  const out: Interval[] = []
  for (let bin = 0; bin < contig.binCount; bin += 1) {
    const index = contig.binOffset + bin - firstBin
    if (index < 0 || index >= values.length) continue
    const value = values[index]
    if (!Number.isFinite(value)) continue
    const start = bin * binsize
    out.push({ start, end: Math.min(start + binsize, contig.length), value })
  }
  return out
}

/**
 * The same, for data that was never on a grid.
 *
 * Both halves of the rule above hold unchanged and for the same reasons: a value
 * that is not finite produces no interval, and an end past the sequence is
 * clamped to it. What is gone is the arithmetic — the caller's intervals are
 * written as the caller's intervals, which is the whole point of this road.
 *
 * Sorted, and empty spans dropped. The R-tree is built over these in order and a
 * bedGraph section header carries the first and last coordinate of its items, so
 * an out-of-order interval is a file that opens and indexes wrongly. The caller
 * that produced these has them in order already (a common refinement is a walk
 * up the axis), which makes this a cheap check rather than a real sort.
 */
function spansOf(contig: PlannedContig, spans: readonly BigWigSpans[]): Interval[] {
  const out: Interval[] = []
  for (const span of spans) {
    if (span.contig !== contig.name) continue
    for (let at = 0; at < span.starts.length; at += 1) {
      const value = span.values[at]
      if (!Number.isFinite(value)) continue
      const start = Math.max(0, span.starts[at])
      const end = Math.min(contig.length, span.ends[at])
      if (!(end > start)) continue
      out.push({ start, end, value })
    }
  }
  out.sort((one, two) => one.start - two.start)
  return out
}

// ---------------------------------------------------------------------------
// Sections, summaries and zoom levels
// ---------------------------------------------------------------------------

/** The total summary, over every interval in the file. */
function summarise(perContig: Interval[][]): Summary {
  let validCount = 0
  let min = Infinity
  let max = -Infinity
  let sum = 0
  let sumSquares = 0
  for (const intervals of perContig) {
    for (const item of intervals) {
      // Weighted by the span, not counted per item: `validCount` in a BBI
      // summary is bases covered, which the demo files confirm to the byte.
      const span = item.end - item.start
      validCount += span
      sum += item.value * span
      sumSquares += item.value * item.value * span
      if (item.value < min) min = item.value
      if (item.value > max) max = item.value
    }
  }
  // An all-`NaN` vector is a legitimate input — a metacool contig nothing mapped
  // to — and zeros are what a reader shows for it. `Infinity` in the header
  // would be read as a real bound and would wreck an autoscale.
  if (validCount === 0) return { validCount: 0, min: 0, max: 0, sum: 0, sumSquares: 0 }
  return { validCount, min, max, sum, sumSquares }
}

/** One bedGraph section: header, then twelve bytes an item. */
function sectionBytes(chromId: number, items: Interval[]): Uint8Array {
  const bytes = new Uint8Array(SECTION_HEADER_BYTES + items.length * BEDGRAPH_ITEM_BYTES)
  const view = new DataView(bytes.buffer)
  view.setUint32(0, chromId, true)
  view.setUint32(4, items[0].start, true)
  view.setUint32(8, items[items.length - 1].end, true)
  // `itemStep` and `itemSpan` describe a regular grid and a bedGraph section has
  // none — every item states its own bounds — so both are zero, which is what
  // every reader takes them to mean for `type = 1`.
  view.setUint32(12, 0, true)
  view.setUint32(16, 0, true)
  view.setUint8(20, SECTION_TYPE_BEDGRAPH)
  view.setUint8(21, 0)
  view.setUint16(22, items.length, true)
  let p = SECTION_HEADER_BYTES
  for (const item of items) {
    view.setUint32(p, item.start, true)
    view.setUint32(p + 4, item.end, true)
    view.setFloat32(p + 8, item.value, true)
    p += BEDGRAPH_ITEM_BYTES
  }
  return bytes
}

/**
 * Every interval, cut into sections.
 *
 * A section never spans a contig, because its header carries a single
 * `chromId`; beyond that the only rule is a cap on the item count, which is
 * what keeps a reader's fetch for one window from dragging in a chromosome.
 */
function buildSections(
  contigs: PlannedContig[],
  perContig: Interval[][],
): { raw: Uint8Array[]; bounds: Bounds[] } {
  const raw: Uint8Array[] = []
  const bounds: Bounds[] = []
  for (const contig of contigs) {
    const intervals = perContig[contig.id]
    for (let first = 0; first < intervals.length; first += ITEMS_PER_SECTION) {
      const items = intervals.slice(first, first + ITEMS_PER_SECTION)
      raw.push(sectionBytes(contig.id, items))
      bounds.push({
        startChromId: contig.id,
        startBase: items[0].start,
        endChromId: contig.id,
        endBase: items[items.length - 1].end,
      })
    }
  }
  return { raw, bounds }
}

/**
 * The whole zoom ladder, records and all, in ascending order of reduction.
 *
 * Decision 5. Ten times the bin size for the first level, because anything finer
 * is a level a reader would never choose over the real data, then four times per
 * level so that consecutive levels are far enough apart to be worth storing
 * separately, and ten levels at the outside.
 *
 * Two things stop it early, and the second was put here by a metagenome. The
 * first is the stated rule: a level holding fewer records than a tree node holds
 * items is the last one worth having, since below that the index costs more than
 * the records it points at and a reader drawing the whole genome reads one block
 * either way. The second is that **a level which reduces nothing is not a
 * level**. A zoom window never spans two contigs, so on an assembly of twenty
 * thousand short contigs every reduction past the contig length yields exactly
 * one record per contig for ever — the first rule never fires, and the file ends
 * up with nine identical copies of the same 20,000 records and a `reductionLevel`
 * that has wrapped past 2^32. Refusing a level that is no smaller than the one
 * below it deletes both problems with one comparison.
 */
/**
 * The span the ladder's first rung is ten times, which on a grid is the bin.
 *
 * Off the grid there is no one span, so it is the **mean** of what was actually
 * written — the same figure `bedGraphToBigWig` reduces from, and the right one:
 * the ladder exists so that a reader zoomed out fetches a summary instead of a
 * million items, and how far out that starts mattering is decided by how big the
 * items are on average rather than by the smallest or the largest of them.
 *
 * Never below one. A file of single-base intervals has a mean span of exactly
 * one, and a reduction of zero would make the first rung the same resolution as
 * the data and every rung after it identical.
 */
function baseSpanOf(input: BigWigInput, perContig: Interval[][]): number {
  if (input.values !== undefined) return input.binsize
  let bases = 0
  let items = 0
  for (const intervals of perContig) {
    for (const item of intervals) {
      bases += item.end - item.start
      items += 1
    }
  }
  return items === 0 ? 1 : Math.max(1, Math.round(bases / items))
}

function zoomLadder(
  contigs: PlannedContig[],
  perContig: Interval[][],
  binsize: number,
): { reduction: number; records: ZoomRecord[] }[] {
  const out: { reduction: number; records: ZoomRecord[] }[] = []
  let previous = Infinity
  let reduction = binsize * FIRST_REDUCTION_FACTOR
  for (let level = 0; level < MAX_ZOOM_LEVELS && reduction <= MAX_REDUCTION; level += 1) {
    const records = zoomRecords(contigs, perContig, reduction)
    if (records.length === 0 || records.length >= previous) break
    out.push({ reduction, records })
    previous = records.length
    if (records.length < TREE_FAN_OUT) break
    reduction *= REDUCTION_STEP
  }
  return out
}

/**
 * One zoom level, aggregated straight from the base intervals.
 *
 * Never from the level below: an aggregation of an aggregation carries the
 * rounding of every level it passed through, and since `sumData` and
 * `sumSquares` are stored as float32 in a zoom record that error is real and
 * compounds. Recomputing from the base vector costs one pass over a few thousand
 * intervals per level, which is nothing.
 *
 * Every reduction is a whole multiple of the bin size by construction, so a bin
 * lies entirely inside one window and the windows are visited in order — which
 * is why one open record is enough and no sorting happens here.
 */
function zoomRecords(
  contigs: PlannedContig[],
  perContig: Interval[][],
  reduction: number,
): ZoomRecord[] {
  const out: ZoomRecord[] = []
  for (const contig of contigs) {
    let open: ZoomRecord | null = null
    for (const item of perContig[contig.id]) {
      const window = Math.floor(item.start / reduction)
      const start = window * reduction
      if (open === null || open.start !== start) {
        if (open !== null) out.push(open)
        open = {
          chromId: contig.id,
          start,
          // Clamped for the same reason the last bin of a contig is: a summary
          // that claims bases the sequence does not have is a summary a browser
          // draws past the end of the chromosome.
          end: Math.min(start + reduction, contig.length),
          validCount: 0,
          min: Infinity,
          max: -Infinity,
          sum: 0,
          sumSquares: 0,
        }
      }
      const span = item.end - item.start
      open.validCount += span
      open.sum += item.value * span
      open.sumSquares += item.value * item.value * span
      if (item.value < open.min) open.min = item.value
      if (item.value > open.max) open.max = item.value
    }
    if (open !== null) out.push(open)
  }
  return out
}

/** Zoom records packed into blocks of at most {@link ZOOM_RECORDS_PER_BLOCK}. */
function buildZoomBlocks(records: ZoomRecord[]): { raw: Uint8Array[]; bounds: Bounds[] } {
  const raw: Uint8Array[] = []
  const bounds: Bounds[] = []
  for (let first = 0; first < records.length; first += ZOOM_RECORDS_PER_BLOCK) {
    const slice = records.slice(first, first + ZOOM_RECORDS_PER_BLOCK)
    const bytes = new Uint8Array(slice.length * ZOOM_RECORD_BYTES)
    const view = new DataView(bytes.buffer)
    let p = 0
    for (const record of slice) {
      view.setUint32(p, record.chromId, true)
      view.setUint32(p + 4, record.start, true)
      view.setUint32(p + 8, record.end, true)
      view.setUint32(p + 12, record.validCount, true)
      view.setFloat32(p + 16, record.min, true)
      view.setFloat32(p + 20, record.max, true)
      view.setFloat32(p + 24, record.sum, true)
      view.setFloat32(p + 28, record.sumSquares, true)
      p += ZOOM_RECORD_BYTES
    }
    raw.push(bytes)
    // Unlike a section, a zoom block may straddle contigs — each record carries
    // its own `chromId`, so nothing in the format forbids it, and forbidding it
    // anyway would cost a metagenome one block per contig per level.
    bounds.push({
      startChromId: slice[0].chromId,
      startBase: slice[0].start,
      endChromId: slice[slice.length - 1].chromId,
      endBase: slice[slice.length - 1].end,
    })
  }
  return { raw, bounds }
}

// ---------------------------------------------------------------------------
// The two indexes
// ---------------------------------------------------------------------------

/** The chromosome B+ tree: name to id and size, collated, multi-level. */
function chromosomeTreeBytes(contigs: PlannedContig[], treeOffset: number): Uint8Array {
  const encoder = new TextEncoder()
  const keys = contigs.map((contig) => encoder.encode(contig.name))
  // One key width for the whole tree, so a node is a fixed stride. Zero-padded,
  // and a reader stops at the first NUL.
  const keySize = keys.reduce((widest, key) => Math.max(widest, key.length), 1)
  const itemBytes = keySize + BPT_VALUE_BYTES

  const plan = planTree(contigs.length, {
    fanOut: TREE_FAN_OUT,
    leafItemBytes: itemBytes,
    // An internal item is a key and an eight-byte child offset, which happens to
    // be the same width as a leaf item here; they are still named separately
    // because nothing in the format requires them to agree.
    internalItemBytes: keySize + 8,
    rootOffset: treeOffset + BPT_HEADER_BYTES,
  })

  const bytes = new Uint8Array(BPT_HEADER_BYTES + plan.bytes)
  const view = new DataView(bytes.buffer)
  view.setUint32(0, BPT_MAGIC, true)
  view.setUint32(4, TREE_FAN_OUT, true)
  view.setUint32(8, keySize, true)
  view.setUint32(12, BPT_VALUE_BYTES, true)
  view.setBigUint64(16, BigInt(contigs.length), true)
  view.setBigUint64(24, 0n, true)

  for (const node of plan.nodes) {
    let p = node.offset - treeOffset
    view.setUint8(p, node.isLeaf ? 1 : 0)
    view.setUint8(p + 1, 0)
    view.setUint16(p + 2, node.isLeaf ? node.leafCount : node.children.length, true)
    p += TREE_NODE_HEADER_BYTES
    if (node.isLeaf) {
      for (let i = 0; i < node.leafCount; i += 1) {
        const contig = contigs[node.leafFirst + i]
        bytes.set(keys[node.leafFirst + i], p)
        view.setUint32(p + keySize, contig.id, true)
        view.setUint32(p + keySize + 4, contig.length, true)
        p += itemBytes
      }
    } else {
      for (const childIndex of node.children) {
        const child = plan.nodes[childIndex]
        // The key an internal item carries is the first key in the subtree it
        // points at, which is what makes the descent a comparison rather than a
        // scan.
        bytes.set(keys[child.leafFirst], p)
        view.setBigUint64(p + keySize, BigInt(child.offset), true)
        p += keySize + 8
      }
    }
  }
  return bytes
}

/** The bounding box of a run of blocks, folded rather than argued about. */
function boundsOver(blocks: IndexedBlock[], first: number, count: number): Bounds {
  const box: Bounds = {
    startChromId: blocks[first].startChromId,
    startBase: blocks[first].startBase,
    endChromId: blocks[first].endChromId,
    endBase: blocks[first].endBase,
  }
  for (let i = 1; i < count; i += 1) {
    const block = blocks[first + i]
    if (
      block.startChromId < box.startChromId ||
      (block.startChromId === box.startChromId && block.startBase < box.startBase)
    ) {
      box.startChromId = block.startChromId
      box.startBase = block.startBase
    }
    if (
      block.endChromId > box.endChromId ||
      (block.endChromId === box.endChromId && block.endBase > box.endBase)
    ) {
      box.endChromId = block.endChromId
      box.endBase = block.endBase
    }
  }
  return box
}

/**
 * The R-tree over a list of blocks, which must already be in `(chromId, start)`
 * order — they are, because the sections are generated contig by contig in id
 * order and the zoom records follow the same walk.
 *
 * `endFileOffset` is written as the offset one past the last indexed block,
 * which is where this index itself begins. The field is advisory and nothing in
 * this repo's reader consults it — `Yeast_ATAC.bw` carries a value there that
 * cannot possibly be right, which is a reason to write a truthful one and no
 * reason to depend on anyone else's.
 */
function rTreeBytes(blocks: IndexedBlock[], treeOffset: number, itemsPerSlot: number): Uint8Array {
  const plan = planTree(blocks.length, {
    fanOut: TREE_FAN_OUT,
    leafItemBytes: RTREE_LEAF_ITEM_BYTES,
    internalItemBytes: RTREE_INTERNAL_ITEM_BYTES,
    rootOffset: treeOffset + RTREE_HEADER_BYTES,
  })

  const bytes = new Uint8Array(RTREE_HEADER_BYTES + plan.bytes)
  const view = new DataView(bytes.buffer)
  const whole =
    blocks.length === 0
      ? { startChromId: 0, startBase: 0, endChromId: 0, endBase: 0 }
      : boundsOver(blocks, 0, blocks.length)
  view.setUint32(0, RTREE_MAGIC, true)
  view.setUint32(4, TREE_FAN_OUT, true)
  view.setBigUint64(8, BigInt(blocks.length), true)
  view.setUint32(16, whole.startChromId, true)
  view.setUint32(20, whole.startBase, true)
  view.setUint32(24, whole.endChromId, true)
  view.setUint32(28, whole.endBase, true)
  view.setBigUint64(32, BigInt(treeOffset), true)
  view.setUint32(40, itemsPerSlot, true)
  // The reserved tail of an R-tree header is a u32, not a u64: the header is 48
  // bytes and the root node starts immediately after it, which is where
  // `@gmod/bbi` looks for it.
  view.setUint32(44, 0, true)

  for (const node of plan.nodes) {
    let p = node.offset - treeOffset
    view.setUint8(p, node.isLeaf ? 1 : 0)
    view.setUint8(p + 1, 0)
    view.setUint16(p + 2, node.isLeaf ? node.leafCount : node.children.length, true)
    p += TREE_NODE_HEADER_BYTES
    if (node.isLeaf) {
      for (let i = 0; i < node.leafCount; i += 1) {
        const block = blocks[node.leafFirst + i]
        view.setUint32(p, block.startChromId, true)
        view.setUint32(p + 4, block.startBase, true)
        view.setUint32(p + 8, block.endChromId, true)
        view.setUint32(p + 12, block.endBase, true)
        view.setBigUint64(p + 16, BigInt(block.offset), true)
        view.setBigUint64(p + 24, BigInt(block.size), true)
        p += RTREE_LEAF_ITEM_BYTES
      }
    } else {
      for (const childIndex of node.children) {
        const child = plan.nodes[childIndex]
        const box = boundsOver(blocks, child.leafFirst, child.leafCount)
        view.setUint32(p, box.startChromId, true)
        view.setUint32(p + 4, box.startBase, true)
        view.setUint32(p + 8, box.endChromId, true)
        view.setUint32(p + 12, box.endBase, true)
        view.setBigUint64(p + 16, BigInt(child.offset), true)
        p += RTREE_INTERNAL_ITEM_BYTES
      }
    }
  }
  return bytes
}

// ---------------------------------------------------------------------------
// Compression
// ---------------------------------------------------------------------------

/**
 * Every block of the file, deflated as a unit — decision 2.
 *
 * `deflateBytes` is `ui/export.ts`'s, unchanged: it wraps the platform's
 * `CompressionStream('deflate')`, whose output is RFC 1950 zlib framing, which
 * is exactly what a BBI section is. It reports a `null` filter where the
 * platform has no `CompressionStream`, and that verdict has to be the same for
 * every block in the file, because `uncompressBufSize` is one file-wide switch
 * rather than a per-block flag — hence one pass over everything here and one
 * answer out.
 */
async function packBlocks(
  groups: Uint8Array[][],
): Promise<{ packed: Uint8Array[][]; compressed: boolean; largest: number }> {
  const packed: Uint8Array[][] = []
  let compressed = true
  let largest = 0
  for (const group of groups) {
    const out: Uint8Array[] = []
    for (const bytes of group) {
      largest = Math.max(largest, bytes.length)
      const { data, filter } = await deflateBytes(bytes)
      if (filter === null) compressed = false
      out.push(data)
    }
    packed.push(out)
  }
  return { packed, compressed, largest }
}

// ---------------------------------------------------------------------------
// The file
// ---------------------------------------------------------------------------

/**
 * The whole bigWig, as a blob ready to be saved.
 *
 * Assembled by decision 4's accumulator: chunks are pushed into a list with a
 * running length, so the length *is* the offset of whatever goes next, and the
 * header and zoom headers are pushed first as blank slots and filled in at the
 * end against offsets that are known by then. A genome's worth of bins is
 * kilobytes, so there is nothing to stream and nothing to be clever about.
 */
export async function writeBigWig(input: BigWigInput): Promise<Blob> {
  const contigs = planContigs(input)
  const perContig: Interval[][] = new Array<Interval[]>(contigs.length)
  for (const contig of contigs) perContig[contig.id] = intervalsFor(contig, input)

  const summary = summarise(perContig)
  const sections = buildSections(contigs, perContig)

  const zooms = zoomLadder(contigs, perContig, baseSpanOf(input, perContig)).map((level) => ({
    reduction: level.reduction,
    ...buildZoomBlocks(level.records),
  }))

  const { packed, compressed, largest } = await packBlocks([
    sections.raw,
    ...zooms.map((zoom) => zoom.raw),
  ])
  const sectionBlocks = packed[0]
  const zoomBlocks = packed.slice(1)

  const chunks: Uint8Array[] = []
  let length = 0
  const push = (bytes: Uint8Array): void => {
    chunks.push(bytes)
    length += bytes.length
  }

  const header = new Uint8Array(HEADER_BYTES)
  const headerView = new DataView(header.buffer)
  push(header)
  const zoomHeaders = new Uint8Array(ZOOM_HEADER_BYTES * zooms.length)
  const zoomHeaderView = new DataView(zoomHeaders.buffer)
  push(zoomHeaders)

  const totalSummaryOffset = length
  push(summaryBytes(summary))

  const chromosomeTreeOffset = length
  push(chromosomeTreeBytes(contigs, chromosomeTreeOffset))

  // The u64 here is the **section** count, verified against the demo bigWigs;
  // the blocks themselves start eight bytes later.
  const fullDataOffset = length
  push(u64(sectionBlocks.length))
  const sectionIndex = placeBlocks(sectionBlocks, sections.bounds, push, () => length)
  const fullIndexOffset = length
  // One section per leaf slot, which is what `itemsPerSlot = 1` means in an
  // unzoomed index — not the 1024 items a section holds.
  push(rTreeBytes(sectionIndex, fullIndexOffset, 1))

  const placed = zooms.map((zoom, level) => {
    // A zoom level's count is a u32 and holds the level's **block** count, not
    // its record count — the asymmetry with the u64 above is what the demo files
    // actually carry.
    const dataOffset = length
    push(u32(zoomBlocks[level].length))
    const index = placeBlocks(zoomBlocks[level], zoom.bounds, push, () => length)
    const indexOffset = length
    push(rTreeBytes(index, indexOffset, ZOOM_RECORDS_PER_BLOCK))
    return { reduction: zoom.reduction, dataOffset, indexOffset }
  })

  // The magic again, so that a reader can tell a complete file from a download
  // that stopped early.
  push(u32(BIGWIG_MAGIC))

  headerView.setUint32(0, BIGWIG_MAGIC, true)
  headerView.setUint16(4, BBI_VERSION, true)
  headerView.setUint16(6, zooms.length, true)
  headerView.setBigUint64(8, BigInt(chromosomeTreeOffset), true)
  headerView.setBigUint64(16, BigInt(fullDataOffset), true)
  headerView.setBigUint64(24, BigInt(fullIndexOffset), true)
  // A bigWig has no BED columns and no autoSql schema; all three fields are the
  // zero that says so.
  headerView.setUint16(32, 0, true)
  headerView.setUint16(34, 0, true)
  headerView.setBigUint64(36, 0n, true)
  headerView.setBigUint64(44, BigInt(totalSummaryOffset), true)
  // The largest **uncompressed** block, which is the buffer a reader allocates
  // before inflating one. Zero is the signal that nothing was compressed.
  headerView.setUint32(52, compressed ? largest : 0, true)
  headerView.setBigUint64(56, 0n, true)

  placed.forEach((zoom, level) => {
    const p = level * ZOOM_HEADER_BYTES
    zoomHeaderView.setUint32(p, zoom.reduction, true)
    zoomHeaderView.setUint32(p + 4, 0, true)
    zoomHeaderView.setBigUint64(p + 8, BigInt(zoom.dataOffset), true)
    zoomHeaderView.setBigUint64(p + 16, BigInt(zoom.indexOffset), true)
  })

  return new Blob(chunks as BlobPart[], { type: 'application/octet-stream' })
}

/** Push a run of blocks, recording where each one landed for the index. */
function placeBlocks(
  blocks: Uint8Array[],
  bounds: Bounds[],
  push: (bytes: Uint8Array) => void,
  here: () => number,
): IndexedBlock[] {
  const indexed: IndexedBlock[] = []
  blocks.forEach((block, i) => {
    const offset = here()
    push(block)
    indexed.push({ ...bounds[i], offset, size: block.length })
  })
  return indexed
}

/** The 40-byte total summary. */
function summaryBytes(summary: Summary): Uint8Array {
  const bytes = new Uint8Array(TOTAL_SUMMARY_BYTES)
  const view = new DataView(bytes.buffer)
  view.setBigUint64(0, BigInt(summary.validCount), true)
  view.setFloat64(8, summary.min, true)
  view.setFloat64(16, summary.max, true)
  view.setFloat64(24, summary.sum, true)
  view.setFloat64(32, summary.sumSquares, true)
  return bytes
}

function u32(value: number): Uint8Array {
  const bytes = new Uint8Array(4)
  new DataView(bytes.buffer).setUint32(0, value, true)
  return bytes
}

function u64(value: number): Uint8Array {
  const bytes = new Uint8Array(8)
  new DataView(bytes.buffer).setBigUint64(0, BigInt(value), true)
  return bytes
}

// ---------------------------------------------------------------------------
// The estimate
// ---------------------------------------------------------------------------

/**
 * Roughly how many bytes {@link writeBigWig} would produce, for a UI hint.
 *
 * Rough on purpose, and stated as such wherever it is shown: the parts that can
 * be counted exactly are counted, and the one thing that cannot — how well the
 * values deflate — is a single measured constant. A track of smooth coverage
 * beats it and a track of noise misses it, in both cases by less than the order
 * of magnitude the hint exists to convey. Cheap enough to call while a slider
 * moves: one pass over the vector and no allocation per bin.
 */
export function bigWigBytesEstimate(input: BigWigInput): number {
  const contigs = planContigs(input)

  // Counted the way the writer counts, on whichever road the caller took, so an
  // estimate and a file can never disagree about how many items there are.
  let items = 0
  if (input.values === undefined) {
    for (const span of input.spans) {
      for (let at = 0; at < span.values.length; at += 1) {
        if (Number.isFinite(span.values[at])) items += 1
      }
    }
  } else {
    for (const contig of contigs) {
      for (let bin = 0; bin < contig.binCount; bin += 1) {
        const index = contig.binOffset + bin - input.firstBin
        if (index < 0 || index >= input.values.length) continue
        if (!Number.isNaN(input.values[index])) items += 1
      }
    }
  }
  if (items === 0) return HEADER_BYTES + TOTAL_SUMMARY_BYTES + BPT_HEADER_BYTES + RTREE_HEADER_BYTES

  const sections = Math.ceil(items / ITEMS_PER_SECTION)
  const data = sections * SECTION_HEADER_BYTES + items * BEDGRAPH_ITEM_BYTES
  // The ladder reduces by ten and then by four, so its records are a geometric
  // series summing to about a third of a tenth of the base items.
  const zoomRecordCount = Math.ceil(items / FIRST_REDUCTION_FACTOR) * (REDUCTION_STEP / 3)
  const zoomData = zoomRecordCount * ZOOM_RECORD_BYTES
  const indexes =
    (sections + Math.ceil(zoomRecordCount / ZOOM_RECORDS_PER_BLOCK)) * RTREE_LEAF_ITEM_BYTES * 1.1
  const chromTree = contigs.length * 40

  return Math.round(
    HEADER_BYTES +
      MAX_ZOOM_LEVELS * ZOOM_HEADER_BYTES +
      TOTAL_SUMMARY_BYTES +
      chromTree +
      indexes +
      (data + zoomData) * ASSUMED_COMPRESSION,
  )
}
