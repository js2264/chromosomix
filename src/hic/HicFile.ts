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
 * each chromosome pair's block index at this resolution (read once and kept,
 * because navigating within a chromosome asks for the same one every time) and
 * the decompressed blocks (LRU by bytes, because a pan re-asks for the blocks it
 * just left). Neither is a tile cache: a block is an index unit, nothing is
 * composited out of them, and dropping the whole lot costs a re-read and not a
 * redraw.
 *
 * ## Reading one pair, and reading every pair
 *
 * A pair's block index is read out of its matrix record only as far as this
 * resolution (`hic/blocks.ts`, `readZoom`), because the record holds every
 * resolution's and a large file's run to hundreds of kilobytes a pair.
 *
 * And a read is told whether it is one of many. A window inside a chromosome
 * reads its pair through the byte source's chunk cache, where the blocks around
 * the ones asked for arrive with them and a pan finds them there. A walk across
 * the genome — every pair, one after another, as the census of §6.5 and a
 * whole-genome picture make — lands a few hundred bytes at a time in places
 * megabytes apart and never comes back, so it reads exactly those bytes
 * (`ByteSource.readExact`) and leaves the cache to the reads that will use it.
 * On the 5 GB 4DN map of mouse granule neurons (4DNFI916JQ1Y) that is the
 * difference between counting its contacts from 500 MiB of chunks and from
 * about 1 MB.
 *
 * What is left of a walk's cost is round trips, and a walk is planned so that
 * there are few of them ({@link prefetchWalk}). Every place it will read is
 * known before it reads: the master index gives each record's, and in a file
 * Juicer wrote, each pair's coarse blocks lie just past its record. So the
 * heads of many records, and the bytes past each, are fetched together as a
 * few stretches of the file, and the blocks they did not bring are fetched
 * together after them. Read pair by pair — a record's head, then its blocks —
 * the whole genome of a 4DN chicken map at 2.5 Mb was 1,258 requests, a minute
 * and a half from a bucket; planned, it is 427, read six at a time. Reads are
 * exact and do not hold the worker; a picture's walk has six out at once, every
 * connection a browser opens to one host, and the census, behind the views, four.
 */

import { ViewerError } from '../errors'
import { landingRung } from '../metacooler/detect'
import { declaredSpan, inflateCapped, inflationCap } from '../sources/untrusted'
import type { ByteSource, Extent } from '../types'
import {
  HIC,
  Truncated,
  normKey,
  readFooter,
  readHeader,
  readNormVector,
  type HicChrom,
  type HicFooter,
  type HicHeader,
  type MasterIndexEntry,
  type NormVectorKey,
} from './format'
import {
  HIC_BLOCK_INFLATION,
  RECORD_HEAD_BYTES,
  blockNumbersFor,
  blockRuns,
  decodeBlock,
  findZoom,
  readZoom,
  readZoomAsync,
  wholeRecord,
  type BlockRecords,
  type BlockRef,
  type ZoomData,
} from './blocks'

/**
 * Bytes of decompressed block retained. One order under the source's own LRU.
 *
 * A block larger than the whole budget is handed back and not kept: holding it
 * would mean evicting everything else to make room for one block, and it used
 * to mean worse — the eviction skipped the block just stored, so one oversize
 * block stayed in the cache, over budget, until the next was decoded.
 */
const BLOCK_CACHE_BYTES = 48 << 20

/**
 * The most chromosome pairs a walk reads at once — see {@link HicFile.walkAhead}.
 *
 * Four, not the six connections a browser opens to one host: a walk runs behind
 * the views (the census starts on every open), and the two left over are what a
 * pan's own reads get without queueing behind it.
 */
const WALK_AHEAD = 4

/**
 * The most reads a walk a view is waiting on — a whole-genome picture — may
 * have out at once: every connection a browser opens to one host.
 *
 * {@link WALK_AHEAD} is the census's, which runs behind the views; it stands
 * aside while one reads, so the two do not want the connections at once, and a
 * picture made of a few hundred round trips gets them all.
 */
const VIEW_WALK_AHEAD = 6

/**
 * The memory a walk's pairs in flight may hold between them, at most.
 *
 * A pair is decoded whole (`HicStore.scanAll` says why), about 28 bytes a
 * stored pixel, so what bounds a pair is its square at the rung.
 */
const WALK_AHEAD_BYTES = 64 << 20

/** Bytes a decoded pixel holds while its pair is read: the block's and the pair's copies. */
const BYTES_PER_PIXEL = 28

/**
 * How far apart two blocks may lie and still be fetched in one exact read.
 *
 * The bytes between them are carried for nothing, and a round trip costs more
 * than 64 KiB does on any connection a reader would open a 5 GB file over.
 */
const RUN_GAP_BYTES = 64 << 10

/** The most one exact read of blocks asks for at once. */
const RUN_CAP_BYTES = 16 << 20

/**
 * Bytes read past the end of each matrix record, in the request for its head.
 *
 * Juicer writes each pair's blocks straight after its record, coarsest rung
 * first, so the blocks a whole-genome picture or a census reads lie just past
 * it — on the 4DN chicken map, within these bytes for all but a handful of its
 * 630 pairs — and the request that read the record's head read them too. A
 * file laid out otherwise (the yeast map of the app's demo store keeps every
 * record after every block) loses only these bytes, and its blocks are read
 * with the rest.
 *
 * Little, and the gap a walk reads through is a window's ({@link
 * RUN_GAP_BYTES}), on purpose. Each byte a walk carries for nothing saves it
 * round trips only on a link whose round trips cost more than its bytes: read
 * through a quarter of a megabyte, the mouse map's whole genome was 17 MB for
 * 369 requests, which a fast link far from the bucket would read sooner than its
 * 453 at 64 KiB, and a home connection at 5 MB/s later than the 460 pair by
 * pair. At these sizes it is faster than pair by pair on every link.
 */
const RECORD_TAIL_BYTES = 4 << 10

/**
 * The decoded pixels one plan of a walk may hold — half the block cache, so the
 * plan read next fits beside the one being handed over ({@link HicFile.walkPlans}).
 */
const WALK_PLAN_BYTES = BLOCK_CACHE_BYTES / 2

/** The most pairs one plan of a walk reads together. */
const WALK_PLAN_PAIRS = 1024

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

/** One chromosome pair of a walk, and the rectangle of it the walk reads, in global bins. */
export interface WalkPair {
  a: number
  b: number
  rows: Extent
  cols: Extent
}

/** What a walk is told between its reads: to stand aside a while, or to stop. */
export interface WalkReadOptions {
  pause?: () => Promise<void>
  cancelled?: () => boolean
}

/** The part of one stored pair a rectangle covers, on each axis, in each chromosome's own bins. */
interface PairWindow {
  low: number
  high: number
  intra: boolean
  lowSpan: [number, number]
  highSpan: [number, number]
}

/**
 * At most `size` reads at a time, the rest waiting in the order they asked.
 *
 * A walk asks for reads from two places — a plan reading its pairs together
 * ({@link HicFile.prefetchWalk}) and a pair reading what no plan brought — and
 * the limit is the file's, not either's, so that together they hold no more
 * connections than {@link HicFile.walkAhead} allows.
 */
class Slots {
  private free: number
  private readonly waiting: Array<() => void> = []

  constructor(size: number) {
    this.free = Math.max(1, size)
  }

  async run<T>(task: () => Promise<T>): Promise<T> {
    if (this.free > 0) this.free -= 1
    else await new Promise<void>((resolve) => this.waiting.push(resolve))
    try {
      return await task()
    } finally {
      const next = this.waiting.shift()
      if (next === undefined) this.free += 1
      else next()
    }
  }
}

export interface HicOpenOptions {
  /** Bin size to open at; the landing rung when omitted (`metacooler/detect.ts`, `landingRung`). */
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
  /**
   * Which normalisation `bins/weight` serves, or `null` when none exists.
   *
   * The file's best offer, by name; what a chromosome's vector actually comes
   * from is decided when it is read ({@link normVector}), because a name in
   * the index is not a promise of numbers behind it.
   */
  readonly normType: string | null

  private readonly source: ByteSource
  /** Display index → the index the file's own master index is keyed on. */
  private readonly fileIndex: Int32Array
  /** Each pair's block index at {@link binSize}, by master-index key; `null` for none. */
  private readonly zooms = new Map<string, ZoomData | null>()
  /** Block indexes a walk is fetching now, so two reads of one pair fetch it once. */
  private readonly zoomsInFlight = new Map<string, Promise<ZoomData | null>>()
  /**
   * Set once a record's head has not reached {@link binSize}, after which every
   * record is read whole — see `readZoom`, whose `beyondHead` this is.
   */
  private beyondHead = false
  private readonly blockCache = new Map<string, BlockRecords>()
  private blockCacheBytes = 0
  private readonly normCache = new Map<number, Float64Array | null>()
  /**
   * Chromosomes whose vector came from a normalisation other than
   * {@link normType}, and which one — see {@link normVector}.
   */
  private readonly normFallbacks = new Map<number, string>()
  /**
   * The exact reads a walk may have out at once: {@link VIEW_WALK_AHEAD} at a
   * rung where pairs are small, {@link walkAhead} where they are not.
   */
  private readonly exactSlots: Slots
  /** The fewer a walk behind the views may have — the census's ({@link walkAhead}). */
  private readonly backgroundSlots: Slots

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
    const ahead = this.walkAhead()
    this.exactSlots = new Slots(ahead === WALK_AHEAD ? VIEW_WALK_AHEAD : ahead)
    this.backgroundSlots = new Slots(ahead)

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
          'variable-bin and are excluded from this viewer.',
        {},
      )
    }
    const binSize = options.binSize ?? landingRung(available)
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
   * relationship `attrs['sum']` has to a cooler's pixel table. It is not the
   * number of contacts (§6.5 says why), and it costs a read of every record,
   * so nothing on the open path asks for it.
   */
  totalCount(): number {
    let sum = 0
    for (const key of this.footer.masterIndex.keys()) {
      const zoom = this.zoomAt(key)
      if (zoom !== null) sum += zoom.sumCounts
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

  /**
   * The weights for one chromosome, from the first normalisation that has any.
   *
   * {@link normType} is chosen by *name*, per file: the best of the preference
   * list that the index carries an entry for. That is not enough, because
   * Juicer writes an entry for a balancing that did not converge and fills it
   * with `NaN` — the 4DN files at 1 kb and 2 kb carry a `KR` vector for every
   * chromosome and finite values in none of them, while the `VC_SQRT` and `VC`
   * beside it are whole. Chosen by name, `balanced` drew nothing at those
   * resolutions and everything at 5 kb, which no reader could account for.
   *
   * So the preferred type is tried first and the rest of the list after it,
   * and the vector a chromosome gets is the first with a finite value in it.
   * A vector that is all `NaN` is the same as no vector, which is what it is.
   * The cost is one extra read of a vector nobody can use, on exactly the
   * chromosomes where the alternative was a blank picture.
   */
  private normVector(chrom: number): Float64Array | null {
    if (this.normCache.has(chrom)) return this.normCache.get(chrom) ?? null
    let vector: Float64Array | null = null
    if (this.normType !== null) {
      const preferred = this.normType
      const candidates = [preferred, ...NORM_PREFERENCE.filter((type) => type !== preferred)]
      for (const type of candidates) {
        const key: NormVectorKey | undefined = this.footer.normVectors.get(
          normKey(type, this.fileIndex[chrom], BP, this.binSize),
        )
        if (key === undefined) continue
        const read = readNormVector(this.source, this.header.version, key)
        if (!read.some((weight) => Number.isFinite(weight))) continue
        vector = read
        if (type !== preferred) this.normFallbacks.set(chrom, type)
        break
      }
    }
    this.normCache.set(chrom, vector)
    return vector
  }

  /**
   * Which normalisation a chromosome's weights came from, once read.
   *
   * {@link normType} until {@link weights} has been asked for that chromosome
   * and found the preferred vector empty; `null` where there is none at all.
   */
  normTypeFor(chrom: number): string | null {
    if (this.normType === null) return null
    if (!this.normCache.has(chrom)) this.normVector(chrom)
    if ((this.normCache.get(chrom) ?? null) === null) return null
    return this.normFallbacks.get(chrom) ?? this.normType
  }

  /**
   * The block index for a `"a_b"` key at this file's bin size, read once and kept.
   *
   * Out of the head of the pair's matrix record where the resolution is there,
   * and out of the whole record where it is not (`readZoom`), through the
   * source's chunks — the read a window makes.
   */
  private zoomAt(key: string): ZoomData | null {
    if (this.zooms.has(key)) return this.zooms.get(key) ?? null
    const entry = this.footer.masterIndex.get(key)
    let zoom: ZoomData | null = null
    if (entry !== undefined) {
      const found = readZoom(
        (position, length) => this.source.readBytes(position, length),
        entry,
        BP,
        this.binSize,
        this.beyondHead ? 0 : RECORD_HEAD_BYTES,
      )
      zoom = this.fitted(key, found.zoom)
      if (found.beyondHead) this.beyondHead = true
    }
    this.zooms.set(key, zoom)
    return zoom
  }

  /**
   * A pair's block index, refused if its blocks claim more bytes than the file.
   *
   * Each block's own place is checked when it is read ({@link blocks}); this is
   * the check on all of them together, once, when the index is first in hand.
   * A writer puts a resolution's blocks one after another, so between them they
   * hold less than the file — and an index whose blocks each sit inside the
   * file but overlap, every one naming the same megabytes, would read the file
   * once per block on a walk across the pair.
   */
  private fitted(key: string, zoom: ZoomData | null): ZoomData | null {
    if (zoom === null) return null
    let total = 0
    for (const ref of zoom.blocks.values()) total += Math.max(0, ref.size)
    if (!(total <= this.source.size)) {
      throw new ViewerError(
        'format',
        `The ${this.binSize} bp blocks of this .hic's ${key} matrix claim ` +
          `${total.toLocaleString('en-US')} bytes between them, more than the whole file's ` +
          `${this.source.size.toLocaleString('en-US')}. The file is corrupt, or not the format ` +
          'its first bytes claim.',
        { key, binSize: this.binSize, bytes: total, size: this.source.size },
      )
    }
    return zoom
  }

  /**
   * {@link zoomAt} for a walk: the same index, kept in the same place, read in
   * exact ranges and without holding the worker — see the module head. A source
   * with no exact read is read the ordinary way.
   */
  private zoomAtSparse(key: string): Promise<ZoomData | null> {
    if (this.zooms.has(key)) return Promise.resolve(this.zooms.get(key) ?? null)
    const flying = this.zoomsInFlight.get(key)
    if (flying !== undefined) return flying
    const entry = this.footer.masterIndex.get(key)
    if (entry === undefined || this.source.readExact === undefined) return Promise.resolve(this.zoomAt(key))
    const reading = readZoomAsync(
      (position, length) => this.exactRead(position, length),
      entry,
      BP,
      this.binSize,
      this.beyondHead ? 0 : RECORD_HEAD_BYTES,
    )
      .then((found) => {
        if (found.beyondHead) this.beyondHead = true
        const zoom = this.fitted(key, found.zoom)
        this.zooms.set(key, zoom)
        return zoom
      })
      .finally(() => this.zoomsInFlight.delete(key))
    this.zoomsInFlight.set(key, reading)
    return reading
  }

  /** The zoom for one display chromosome pair at this file's bin size. */
  private zoomFor(a: number, b: number): ZoomData | null {
    return this.zoomAt(this.pairKey(a, b))
  }

  private pairKey(a: number, b: number): string {
    return `${this.fileIndex[a]}_${this.fileIndex[b]}`
  }

  /**
   * How many chromosome pairs a walk at this rung may read at once.
   *
   * Enough to overlap round trips, which are nearly all a coarse walk costs;
   * few enough that the pairs held at once stay small, since each is decoded
   * whole. At the rungs a census or a whole-genome picture uses — a chromosome
   * a few hundred bins long — that is {@link WALK_AHEAD}; at a rung where one
   * pair could fill the budget alone, it is one pair at a time, as before.
   */
  walkAhead(): number {
    let widest = 0
    for (let c = 0; c < this.chroms.length; c++) {
      widest = Math.max(widest, this.chromOffset[c + 1] - this.chromOffset[c])
    }
    const pair = Math.max(1, widest * widest * BYTES_PER_PIXEL)
    return Math.max(1, Math.min(WALK_AHEAD, Math.floor(WALK_AHEAD_BYTES / pair)))
  }

  /**
   * A walk's pairs, in its order, cut into the plans {@link prefetchWalk} reads
   * together.
   *
   * A plan is read before the first of its pairs is handed over, and its blocks
   * are held, decoded, until the last of them is, so it ends where its pairs'
   * rectangles at this rung — the most pixels a pair can hold — would pass
   * {@link WALK_PLAN_BYTES}. At the rung a whole genome is drawn at, that is
   * every pair of it; at a rung where one pair could fill the budget alone, each
   * is a plan of its own.
   */
  walkPlans<T extends readonly [number, number]>(pairs: readonly T[]): T[][] {
    const plans: T[][] = []
    let plan: T[] = []
    let held = 0
    for (const pair of pairs) {
      const pixels = this.binsOf(pair[0]) * this.binsOf(pair[1]) * BYTES_PER_PIXEL
      if (plan.length > 0 && (held + pixels > WALK_PLAN_BYTES || plan.length >= WALK_PLAN_PAIRS)) {
        plans.push(plan)
        plan = []
        held = 0
      }
      plan.push(pair)
      held += pixels
    }
    if (plan.length > 0) plans.push(plan)
    return plans
  }

  /**
   * Read what a walk will read of `pairs` — each record as far as this rung, and
   * the blocks each pair's rectangle touches — in as few requests as the file
   * allows, and keep it, so that {@link pairRecords} reads nothing for them.
   *
   * Everything it reads is placed before a byte is read. The master index gives
   * each record's place, so the records' heads are read together, as the few
   * stretches of the file {@link blockRuns} makes of them, and with each head the
   * bytes past its record's end ({@link RECORD_TAIL_BYTES}), where Juicer put the
   * pair's coarse blocks. A record whose rung lies past its head is then read
   * whole, as {@link readZoom} would read it. The blocks are decoded from the
   * bytes that brought them, and those still missing are read together last.
   *
   * A source without exact reads is left to {@link pairRecords}, which reads it
   * as it always has. Answers `false` when `cancelled` stopped it between reads;
   * a read that fails fails the walk, as it did pair by pair.
   */
  async prefetchWalk(pairs: readonly WalkPair[], options: WalkReadOptions = {}): Promise<boolean> {
    if (this.source.readExact === undefined) return true

    // The records not yet read, each once.
    const records: MasterIndexEntry[] = []
    const asked = new Set<string>()
    for (const pair of pairs) {
      const key = this.pairKey(Math.min(pair.a, pair.b), Math.max(pair.a, pair.b))
      if (asked.has(key) || this.zooms.has(key)) continue
      asked.add(key)
      const entry = this.footer.masterIndex.get(key)
      if (entry === undefined) this.zooms.set(key, null)
      else records.push(entry)
    }

    // Their heads, and the bytes past each one's end.
    const spans: Array<{ position: number; size: number; entry: MasterIndexEntry; head: boolean }> = []
    for (const entry of records) {
      const head = this.beyondHead ? entry.size : Math.min(entry.size, RECORD_HEAD_BYTES)
      spans.push({ position: entry.position, size: head, entry, head: true })
      const end = entry.position + entry.size
      const tail = Math.min(RECORD_TAIL_BYTES, this.source.size - end)
      if (tail > 0) spans.push({ position: end, size: tail, entry, head: false })
    }
    const tails = new Map<string, { position: number; bytes: Uint8Array }>()
    const whole: Array<{ position: number; size: number; entry: MasterIndexEntry }> = []
    const headsRead = await this.fetchRuns(blockRuns(spans, RUN_GAP_BYTES, RUN_CAP_BYTES), options, (run, bytes) => {
      for (const span of run.refs) {
        const at = span.position - run.position
        const piece = bytes.subarray(at, at + span.size)
        if (!span.head) {
          // Copied, so the stretch it came in is not kept alive by it.
          tails.set(span.entry.key, { position: span.position, bytes: piece.slice() })
          continue
        }
        const { entry } = span
        try {
          const zoom =
            span.size === entry.size
              ? wholeRecord(piece, entry, BP, this.binSize)
              : findZoom(piece, BP, this.binSize, entry.size)
          this.zooms.set(entry.key, this.fitted(entry.key, zoom))
        } catch (err) {
          if (!(err instanceof Truncated)) throw err
          // Every record lists its rungs in one order: past this head, past all of them.
          this.beyondHead = true
          whole.push({ position: entry.position, size: entry.size, entry })
        }
      }
    })
    if (!headsRead) return false
    if (whole.length > 0) {
      const wholeRead = await this.fetchRuns(blockRuns(whole, RUN_GAP_BYTES, RUN_CAP_BYTES), options, (run, bytes) => {
        for (const record of run.refs) {
          const at = record.position - run.position
          const zoom = wholeRecord(bytes.subarray(at, at + record.size), record.entry, BP, this.binSize)
          this.zooms.set(record.entry.key, this.fitted(record.entry.key, zoom))
        }
      })
      if (!wholeRead) return false
    }

    // The blocks: from the bytes past their record where they were, the rest together.
    const missing: BlockRef[] = []
    const named = new Set<string>()
    for (const pair of pairs) {
      const window = this.windowOf(pair.a, pair.b, pair.rows, pair.cols)
      if (window === null) continue
      const key = this.pairKey(window.low, window.high)
      const zoom = this.zooms.get(key)
      if (zoom === undefined || zoom === null) continue
      const tail = tails.get(key)
      for (const number of blockNumbersFor(zoom, this.header.version, window.intra, window.lowSpan, window.highSpan)) {
        const ref = zoom.blocks.get(number)
        if (ref === undefined || ref.size <= 0) continue
        const held = this.blockKey(ref)
        if (named.has(held) || this.blockCache.has(held)) continue
        named.add(held)
        this.checkBlock(ref)
        const at = tail === undefined ? -1 : ref.position - tail.position
        if (tail !== undefined && at >= 0 && at + ref.size <= tail.bytes.byteLength) {
          await this.decode(ref, tail.bytes.subarray(at, at + ref.size))
        } else {
          missing.push(ref)
        }
      }
    }
    return this.fetchRuns(blockRuns(missing, RUN_GAP_BYTES, RUN_CAP_BYTES), options, async (run, bytes) => {
      for (const ref of run.refs) {
        const at = ref.position - run.position
        await this.decode(ref, bytes.subarray(at, at + ref.size))
      }
    })
  }

  /**
   * Read each stretch, no more at once than {@link exactSlots} lets out — and a
   * walk behind the views, one told to stand aside, no more than
   * {@link backgroundSlots} — and hand each to `use` as it arrives. A walk told
   * to stand aside does so before each read; one cancelled stops between them,
   * and the answer is then `false`.
   */
  private async fetchRuns<T>(
    runs: ReadonlyArray<{ position: number; length: number; refs: T[] }>,
    options: WalkReadOptions,
    use: (run: { position: number; length: number; refs: T[] }, bytes: Uint8Array) => void | Promise<void>,
  ): Promise<boolean> {
    let stopped = false
    await Promise.all(
      runs.map(async (run) => {
        // Standing aside before a slot is taken, never while one is held: a
        // census waiting on a view that walks the same file would otherwise
        // hold the very slots the view waits for, and neither would finish.
        await options.pause?.()
        const read = (): Promise<Uint8Array | null> =>
          this.exactSlots.run(async () => {
            if (stopped || options.cancelled?.() === true) {
              stopped = true
              return null
            }
            return this.readExactNow(run.position, run.length)
          })
        // A walk told to stand aside is one behind the views, and keeps to fewer.
        const bytes = options.pause === undefined ? await read() : await this.backgroundSlots.run(read)
        if (bytes !== null) await use(run, bytes)
      }),
    )
    return !stopped
  }

  /** One exact read, once a slot is free. */
  private exactRead(position: number, length: number): Promise<Uint8Array> {
    return this.exactSlots.run(() => this.readExactNow(position, length))
  }

  /** One exact read, now; the ordinary read on a source without exact ones. */
  private readExactNow(position: number, length: number): Promise<Uint8Array> {
    const source = this.source
    const exact = source.readExact
    if (exact === undefined) return Promise.resolve(source.readBytes(position, length))
    return exact.call(source, position, length)
  }

  private binsOf(display: number): number {
    return this.chromOffset[display + 1] - this.chromOffset[display]
  }

  /** Whether any matrix exists at this bin size — the acceptance gate's question. */
  hasAnyMatrix(): boolean {
    for (let c = 0; c < this.chroms.length; c++) {
      if (this.zoomFor(c, c) !== null) return true
    }
    return false
  }

  /**
   * Every chromosome pair the master index lists, as display indices, each once.
   *
   * Derived from the master index rather than from the cross product, because a
   * file written with `-d` holds only the intra matrices and walking the
   * absent pairs would be a request each to learn nothing.
   *
   * **Reads nothing.** Whether a listed pair has a matrix at *this* resolution
   * is in its record, and {@link pairRecords} answers `null` for one that has
   * not — so a walk finds out as it reaches each pair rather than all at once
   * before it starts. Finding out up front was the walk's own cost paid twice,
   * synchronously: every record read whole before the first pixel, a minute and
   * a half of blocked worker on a 4DN map before its contacts could be counted
   * (§6.5), and every other request to the reader queued behind it — the one
   * the loading screen was waiting for included.
   */
  indexedPairs(): Array<[number, number]> {
    const byFileIndex = new Map<number, number>()
    this.fileIndex.forEach((file, display) => byFileIndex.set(file, display))
    const seen = new Set<string>()
    const pairs: Array<[number, number]> = []
    for (const key of this.footer.masterIndex.keys()) {
      const [rawA, rawB] = key.split('_').map((part) => Number.parseInt(part, 10))
      const a = byFileIndex.get(rawA)
      const b = byFileIndex.get(rawB)
      if (a === undefined || b === undefined) continue
      const pair: [number, number] = a <= b ? [a, b] : [b, a]
      // One matrix per unordered pair is what `zoomFor` reads, so a file that
      // listed a pair both ways round would otherwise have it walked twice —
      // and every accumulator above is additive.
      const id = `${pair[0]}_${pair[1]}`
      if (seen.has(id)) continue
      seen.add(id)
      pairs.push(pair)
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
   *
   * `sparse` says this pair is one of a walk across many, and changes how the
   * bytes are fetched and nothing else — see the module head.
   */
  async pairRecords(
    a: number,
    b: number,
    rows: Extent,
    cols: Extent,
    sparse = false,
  ): Promise<{ bin1: Int32Array; bin2: Int32Array; count: Float64Array; length: number } | null> {
    const [lowChrom, highChrom] = a <= b ? [a, b] : [b, a]
    const zoom = sparse
      ? await this.zoomAtSparse(this.pairKey(lowChrom, highChrom))
      : this.zoomFor(lowChrom, highChrom)
    if (zoom === null) return null
    const window = this.windowOf(a, b, rows, cols)
    if (window === null) return null
    const { intra, lowSpan, highSpan } = window

    const numbers = blockNumbersFor(zoom, this.header.version, intra, lowSpan, highSpan)
    const lowBase = this.chromOffset[lowChrom]
    const highBase = this.chromOffset[highChrom]

    let total = 0
    const parts = await this.blocks(zoom, numbers, sparse)
    for (const part of parts) total += part.length
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
   * The part of the stored pair `a × b` the rectangle `rows × cols` covers, on
   * each of its axes in its own chromosome's bins — or `null` where it misses.
   *
   * For an inter pair the stored first axis is the lower chromosome, which is
   * not necessarily the caller's row axis, so each axis takes whichever window
   * covers its chromosome. For an intra pair each keeps its own: the block
   * arithmetic adds every block's transpose, which is where the half of a window
   * below the diagonal is stored. Unioning the two instead read the bounding
   * square — a corner of a chromosome, six bins by six, read every block of it:
   * a whole chromosome's 15 MB at 25 kb for each of the circularity check's
   * corner reads (§8.15).
   */
  private windowOf(a: number, b: number, rows: Extent, cols: Extent): PairWindow | null {
    const [low, high] = a <= b ? [a, b] : [b, a]
    const intra = low === high
    const [lowSpan, highSpan] = intra
      ? [this.clipSpan(low, rows), this.clipSpan(low, cols)]
      : [this.localSpan(low, rows, cols), this.localSpan(high, rows, cols)]
    if (lowSpan === null || highSpan === null) return null
    return { low, high, intra, lowSpan, highSpan }
  }

  /**
   * A chromosome's local bin window, from whichever of the two global ranges
   * overlaps it — or `null` when neither does.
   *
   * Both are consulted because a read is a rectangle and a chromosome may be on
   * either of its axes. Where both overlap, the union is taken: narrowing to one
   * would drop the half of an on-diagonal block the other axis was asking for.
   */
  /** `extent`'s part on one chromosome, in its own bins, or `null` where it misses it. */
  private clipSpan(chrom: number, extent: Extent): [number, number] | null {
    const base = this.chromOffset[chrom]
    const from = Math.max(extent[0], base)
    const to = Math.min(extent[1], this.chromOffset[chrom + 1])
    return to > from ? [from - base, to - base] : null
  }

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

  /**
   * The blocks `numbers` names that the index holds, decompressed, through the
   * LRU, in the order they were named.
   *
   * One read a block for a window, through the source's chunks as it always
   * was. For a `sparse` walk, the blocks not already held are fetched in exact
   * reads of the stretches they sit in end to end (`blockRuns`) — on a coarse
   * rung, one block of about a kilobyte per pair, which a chunk would have
   * rounded out to a megabyte.
   *
   * Every block's place is checked before a byte of it is fetched: a size in
   * the index that runs past the end of the file reads the rest of the file,
   * and a walk does that once per block, so the check is what keeps a corrupt
   * index from reading a file many times over (§10).
   */
  private async blocks(zoom: ZoomData, numbers: readonly number[], sparse: boolean): Promise<BlockRecords[]> {
    const got = new Map<number, BlockRecords>()
    const missing: BlockRef[] = []
    for (const number of numbers) {
      const ref = zoom.blocks.get(number)
      if (ref === undefined || ref.size <= 0) continue
      const held = this.held(ref)
      if (held !== undefined) {
        got.set(number, held)
        continue
      }
      this.checkBlock(ref)
      missing.push(ref)
    }
    if (sparse && this.source.readExact !== undefined) {
      for (const run of blockRuns(missing, RUN_GAP_BYTES, RUN_CAP_BYTES)) {
        const bytes = await this.exactRead(run.position, run.length)
        for (const ref of run.refs) {
          const at = ref.position - run.position
          got.set(ref.number, await this.decode(ref, bytes.subarray(at, at + ref.size)))
        }
      }
    } else {
      for (const ref of missing) {
        got.set(ref.number, await this.decode(ref, this.source.readBytes(ref.position, ref.size)))
      }
    }
    const out: BlockRecords[] = []
    for (const number of numbers) {
      const records = got.get(number)
      if (records !== undefined) out.push(records)
    }
    return out
  }

  /** Refuse a block whose place in the index runs past the file, before a byte of it is read. */
  private checkBlock(ref: BlockRef): void {
    declaredSpan(ref.position, ref.size, {
      format: HIC,
      field: `block ${ref.number} of the ${this.binSize} bp matrix`,
      size: this.source.size,
      // Compressed, a block is never larger than it inflates to.
      ceiling: HIC_BLOCK_INFLATION.ceiling,
    })
  }

  /** A block already decompressed, marked most recently used; `undefined` when it is not held. */
  private held(ref: BlockRef): BlockRecords | undefined {
    const key = this.blockKey(ref)
    const held = this.blockCache.get(key)
    if (held === undefined) return undefined
    // Reinsert at the back: `Map` keeps insertion order, so the first key is
    // the least recently used.
    this.blockCache.delete(key)
    this.blockCache.set(key, held)
    return held
  }

  /**
   * Decompress one block's bytes and keep the result.
   *
   * zlib-inflated, `'deflate'` and not `'deflate-raw'`: Juicer writes through
   * `java.util.zip.Deflater` at its defaults, which emits the two-byte zlib
   * header, and asking for raw produces a decode error on the first block rather
   * than a wrong number later. Through `sources/untrusted.ts`, whose cap is
   * {@link HIC_BLOCK_INFLATION}'s proportion of what went in, so a block of a
   * megabyte cannot become the gigabyte deflate allows on its way to being
   * refused.
   */
  private async decode(ref: BlockRef, compressed: Uint8Array): Promise<BlockRecords> {
    const inflated = await inflateCapped(compressed, {
      format: HIC,
      field: `block ${ref.number} of the ${this.binSize} bp matrix`,
      encoding: 'deflate',
      maxBytes: inflationCap(compressed.byteLength, HIC_BLOCK_INFLATION),
    })
    const records = decodeBlock(inflated, this.header.version)
    this.remember(this.blockKey(ref), records)
    return records
  }

  private blockKey(ref: BlockRef): string {
    return `${this.binSize}/${ref.position}`
  }

  private remember(key: string, records: BlockRecords): void {
    const bytes = records.x.byteLength + records.y.byteLength + records.value.byteLength
    if (bytes > BLOCK_CACHE_BYTES) return
    this.blockCache.set(key, records)
    this.blockCacheBytes += bytes
    // Oldest first, and never the block just stored, which is the newest and
    // fits the budget alone — so the loop always stops before reaching it.
    for (const held of this.blockCache.keys()) {
      if (this.blockCacheBytes <= BLOCK_CACHE_BYTES) break
      const evicted = this.blockCache.get(held)
      if (evicted !== undefined) {
        this.blockCacheBytes -=
          evicted.x.byteLength + evicted.y.byteLength + evicted.value.byteLength
      }
      this.blockCache.delete(held)
    }
  }

  close(): void {
    this.zooms.clear()
    this.blockCache.clear()
    this.normCache.clear()
    this.blockCacheBytes = 0
  }
}
