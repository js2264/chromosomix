/**
 * A contact map redrawn to a chosen number of contacts (§6.5).
 *
 * A **subsample** is cooltools' `random-sample --count N --exact`: `N` of the
 * file's `T` contacts, every subset of that size equally likely, so each pixel
 * keeps a hypergeometric share of its own. An **oversample** keeps every contact
 * the file has and adds `N − T` drawn with replacement from a probability map:
 * Boost-HiC's map of each sequence for the contacts within it (`boost.ts`), and
 * the file's own pixels for the contacts between sequences, which Boost-HiC does
 * not model — so each block's share of the new contacts is its share of the old,
 * and within a sequence they go where the boosted map says the library would
 * have put them had it been deeper.
 *
 * Both are **the whole file**, never the window on screen: the total is exact
 * over the map, a pixel is the same wherever it is read from, and every task
 * reads the map it would read from a file that had been resampled on disk.
 *
 * ## How a map this size is drawn without being held
 *
 * cooltools holds the map: it reads every pixel, draws `N` indices out of
 * `range(T)` and writes a new file. A viewer cannot — a map is read a window at
 * a time and the whole of it may be gigabytes — so the draw is split where its
 * distribution splits exactly:
 *
 * 1. **A census**, once per map: one walk over every stored pixel for each
 *    sequence pair's total. It does not depend on `N`, so changing the number
 *    typed costs no second walk.
 * 2. **A split**: each pair's share of `N` (hypergeometric, pair by pair in what
 *    is left) or of `N − T` (binomial likewise). A handful of draws.
 * 3. **A band**, on first read of a sequence: every pixel whose row is in it —
 *    its own block and every block to its right — read once, and each block
 *    drawn to its share, pixel by pixel in `(bin1, bin2)` order from a generator
 *    seeded by the map's seed and the block. Kept while the budget allows and
 *    redrawn identically when it does not.
 *
 * The seed makes it one map rather than a draw per read: two workers, a reload
 * and the command line all arrive at the same pixels, which is what lets a task
 * in the analysis worker read what the view in the reader worker drew.
 *
 * ## What is refused, and why
 *
 * A count that is not a whole number, or is negative (there is no contact to
 * draw); a `square` file, whose every contact is stored twice; an `.scool`,
 * which is a sum of cells rather than a library; and, for an oversample, a
 * sequence with more bins than Boost-HiC can walk ({@link BOOST_MAX_BINS}). Each
 * is refused by name rather than drawn from the file as stored, because a map
 * that says `10,000,000 contacts` over the file's `179,175,551` is the one lie
 * this feature exists not to tell.
 */

import { yieldToEventLoop } from '../async'
import { ViewerError } from '../errors'
import type { Extent, PixelChunk } from '../types'
import { BOOST_ALPHA, BOOST_MAX_BINS, boostHiC } from './boost'
import type { ReadPlan, SpanScanOptions } from './matrix'
import { Rng, binomial, hypergeometric, seedOf } from './sampling'
import type { PixelStore, ScanAllOptions } from './store'

/** What the map is drawn to, as the reader asks for it. */
export interface ResampleSpec {
  /** The total, in contacts. A positive whole number. */
  contacts: number
  /** Every draw's seed; the same seed and total are the same map. */
  seed?: number
  /** Boost-HiC's exponent, when oversampling. */
  alpha?: number
}

/** The seed a map is drawn from when the reader names none. */
export const DEFAULT_RESAMPLE_SEED = 1

/** Which way a map is drawn, once its total is known. */
export type ResampleMode = 'none' | 'sub' | 'over'

/** Which way a total of `total` goes to `contacts`. */
export function resampleMode(total: number, contacts: number): ResampleMode {
  return contacts === total ? 'none' : contacts < total ? 'sub' : 'over'
}

/**
 * Every sequence pair's contacts, from one walk over the map.
 *
 * Plain arrays, so it crosses a worker boundary as it is: the reader takes it
 * once and the analysis worker is handed it rather than walking the file again.
 */
export interface Census {
  /** Contacts in the map — the sum of every stored count. */
  total: number
  /** Stored pixels walked. */
  nnz: number
  /** Sequences the pairs index, and bins, so a census of another map is refused. */
  sequences: number
  nBins: number
  /** Pairs holding any contact, sorted by `(a, b)` with `a ≤ b`. */
  a: Int32Array
  b: Int32Array
  sum: Float64Array
}

/** What a spec resolves to over a census. */
export interface ResamplePlan {
  mode: ResampleMode
  contacts: number
  total: number
  seed: number
  alpha: number
  /**
   * Per pair (`a · sequences + b`): the contacts it keeps (`sub`) or gains
   * (`over`). Absent is none.
   */
  shares: Map<number, number>
  /** Balanced values' factor — see {@link ResampledStore.weightScale}. */
  weightScale: number
}

/** Tags for the generators, so no two draws of one map share a stream. */
const SPLIT = 0x51
const SUB = 0x5b
const OVER = 0x0e

/** Materialised bands kept per map, in bytes; beyond it the oldest is redrawn when next read. */
const BAND_BUDGET_BYTES = 192 * 1024 * 1024

/** A band read with others is batched with them up to this many bins. */
const BATCH_BINS = 4096

/** Below this a pixel's contacts are drawn one by one; above, in one hypergeometric draw. */
const CONTACT_BY_CONTACT = 32

/** Pixels per chunk handed on by a census scan. */
const CENSUS_CHUNK = 1_000_000

/** The refusal every resampling error is. */
function refused(message: string, detail: Record<string, unknown> = {}): ViewerError {
  return new ViewerError('unsupported', message, { ...detail, resample: true })
}

/** Whether a count is a number of contacts. */
function isContactCount(value: number): boolean {
  return value >= 0 && Number.isInteger(value)
}

// ---------------------------------------------------------------------------
// Sequences
// ---------------------------------------------------------------------------

/** Which sequence a bin is in, remembering the last answer (reads are in bin order). */
class SequenceIndex {
  private last = 0
  constructor(readonly starts: ArrayLike<number>) {}

  get count(): number {
    return this.starts.length - 1
  }

  of(bin: number): number {
    const starts = this.starts
    const last = this.last
    if (bin >= starts[last] && bin < starts[last + 1]) return last
    let lo = 0
    let hi = starts.length - 2
    while (lo < hi) {
      const mid = (lo + hi + 1) >>> 1
      if (starts[mid] <= bin) lo = mid
      else hi = mid - 1
    }
    this.last = lo
    return lo
  }

  /** The sequences a half-open bin range touches, in order. */
  touching(lo: number, hi: number): number[] {
    const out: number[] = []
    if (hi <= lo) return out
    const first = this.of(Math.max(0, lo))
    for (let s = first; s < this.count && this.starts[s] < hi; s++) {
      if (this.starts[s + 1] > this.starts[s]) out.push(s)
    }
    return out
  }
}

// ---------------------------------------------------------------------------
// The census
// ---------------------------------------------------------------------------

/**
 * Walk every stored pixel once, for each sequence pair's contacts.
 *
 * Refuses on the first count that is not a whole number of contacts, or a pixel
 * below the diagonal — both are files there is no contact to draw from.
 */
export async function takeCensus(
  store: PixelStore,
  starts: ArrayLike<number>,
  options: { onProgress?(done: number, total: number): void; cancelled?(): boolean } = {},
): Promise<Census> {
  const index = new SequenceIndex(starts)
  const sequences = index.count
  const nBins = starts[sequences]
  // A small genome's pairs fit a square; a metagenome's are sparse.
  const dense = sequences <= 512 ? new Float64Array(sequences * sequences) : null
  const sparse = dense === null ? new Map<number, number>() : null
  let nnz = 0
  let failure: ViewerError | null = null
  let stopped = false
  await store.scanAll({
    chunkSize: CENSUS_CHUNK,
    onChunk: (chunk) => {
      if (options.cancelled?.() === true) {
        stopped = true
        return false
      }
      const { bin1, bin2, count, length } = chunk
      for (let i = 0; i < length; i++) {
        const value = count[i]
        if (!isContactCount(value)) {
          failure = refused(
            `This map stores ${value} where a number of contacts would be, so there are no contacts ` +
              'to draw from it. Resampling reads raw counts — whole numbers, one per contact.',
            { value },
          )
          return false
        }
        if (value === 0) continue
        const b1 = bin1[i]
        const b2 = bin2[i]
        if (b2 < b1) {
          failure = refused(
            'This map stores pixels below its diagonal, so each contact would be drawn twice. ' +
              'Resampling reads upper-triangular files — cooler’s default.',
          )
          return false
        }
        const a = index.of(b1)
        const b = b2 < starts[a + 1] ? a : index.of(b2)
        nnz++
        if (dense !== null) dense[a * sequences + b] += value
        else sparse!.set(a * sequences + b, (sparse!.get(a * sequences + b) ?? 0) + value)
      }
      return true
    },
    onProgress: options.onProgress,
  })
  if (failure !== null) throw failure
  if (stopped) throw new DOMException('The census was cancelled.', 'AbortError')

  const keys: number[] = []
  if (dense !== null) {
    for (let key = 0; key < dense.length; key++) if (dense[key] > 0) keys.push(key)
  } else {
    for (const key of sparse!.keys()) keys.push(key)
    keys.sort((x, y) => x - y)
  }
  const a = new Int32Array(keys.length)
  const b = new Int32Array(keys.length)
  const sum = new Float64Array(keys.length)
  let total = 0
  for (let i = 0; i < keys.length; i++) {
    const key = keys[i]
    a[i] = Math.floor(key / sequences)
    b[i] = key - a[i] * sequences
    sum[i] = dense !== null ? dense[key] : sparse!.get(key)!
    total += sum[i]
  }
  return { total, nnz, sequences, nBins, a, b, sum }
}

// ---------------------------------------------------------------------------
// The plan
// ---------------------------------------------------------------------------

/** A total the reader typed, checked: a positive whole number of contacts. */
export function checkContacts(contacts: number): number {
  if (!Number.isFinite(contacts) || !Number.isInteger(contacts) || contacts <= 0) {
    throw refused(`${contacts} is not a number of contacts: it must be a positive whole number.`, {
      contacts,
    })
  }
  if (contacts > Number.MAX_SAFE_INTEGER) {
    throw refused(`${contacts} contacts is past what can be counted exactly here (2⁵³).`, {
      contacts,
    })
  }
  return contacts
}

/**
 * Resolve a spec over a census: which way, and each pair's share.
 *
 * `starts` is only asked for an oversample, to refuse a sequence Boost-HiC
 * cannot walk before anything is read for it.
 */
export function planResample(
  census: Census,
  spec: ResampleSpec,
  starts: ArrayLike<number>,
  names?: readonly string[],
): ResamplePlan {
  const contacts = checkContacts(spec.contacts)
  const total = census.total
  if (!(total > 0)) {
    throw refused('This map holds no contacts, so there is nothing to draw from it.', { total })
  }
  const seed = spec.seed ?? DEFAULT_RESAMPLE_SEED
  const alpha = spec.alpha ?? BOOST_ALPHA
  const mode = resampleMode(total, contacts)
  const shares = new Map<number, number>()
  const plan: ResamplePlan = {
    mode,
    contacts,
    total,
    seed,
    alpha,
    shares,
    weightScale: Math.sqrt(total / contacts),
  }
  if (mode === 'none') return plan
  const rng = new Rng(seedOf(seed, SPLIT, mode === 'sub' ? SUB : OVER))
  const pairs = census.sum.length
  if (mode === 'sub') {
    // A uniform subset of N contacts, pair by pair: each pair's share is
    // hypergeometric in the contacts and the draws still left.
    let left = contacts
    let pool = total
    for (let i = 0; i < pairs && left > 0; i++) {
      const size = census.sum[i]
      const drawn = hypergeometric(rng, size, pool - size, left)
      if (drawn > 0) shares.set(census.a[i] * census.sequences + census.b[i], drawn)
      left -= drawn
      pool -= size
    }
    return plan
  }
  if (!(alpha > 0)) {
    throw refused(`Boost-HiC’s alpha must be above zero; ${alpha} was given.`, { alpha })
  }
  // Boost-HiC is cubic in a sequence's bins; say so before reading any of them.
  for (let i = 0; i < pairs; i++) {
    const a = census.a[i]
    if (census.b[i] !== a) continue
    const bins = starts[a + 1] - starts[a]
    if (bins > BOOST_MAX_BINS) {
      const name = names?.[a] ?? `sequence ${a + 1}`
      throw refused(
        `${name} is ${bins.toLocaleString('en-US')} bins at this resolution, and Boost-HiC — which ` +
          `oversamples it — walks every path between them: at most ` +
          `${BOOST_MAX_BINS.toLocaleString('en-US')}. Open a coarser resolution to oversample this map.`,
        { sequence: name, bins, limit: BOOST_MAX_BINS },
      )
    }
  }
  // N − T contacts with replacement, each pair's share binomial in its weight
  // and what is left — a multinomial over the pairs, weighted by their contacts.
  let left = contacts - total
  let weight = total
  for (let i = 0; i < pairs && left > 0; i++) {
    const size = census.sum[i]
    const drawn = i === pairs - 1 ? left : binomial(rng, left, Math.min(1, size / weight))
    if (drawn > 0) shares.set(census.a[i] * census.sequences + census.b[i], drawn)
    left -= drawn
    weight -= size
  }
  return plan
}

// ---------------------------------------------------------------------------
// Drawing one block
// ---------------------------------------------------------------------------

/** Pixels, grown as they arrive. */
class PixelBuffer {
  bin1: Int32Array
  bin2: Int32Array
  count: Float64Array
  length = 0

  constructor(capacity = 1024) {
    this.bin1 = new Int32Array(capacity)
    this.bin2 = new Int32Array(capacity)
    this.count = new Float64Array(capacity)
  }

  push(b1: number, b2: number, value: number): void {
    if (this.length === this.bin1.length) this.grow(this.length * 2)
    this.bin1[this.length] = b1
    this.bin2[this.length] = b2
    this.count[this.length] = value
    this.length++
  }

  private grow(capacity: number): void {
    const bin1 = new Int32Array(capacity)
    const bin2 = new Int32Array(capacity)
    const count = new Float64Array(capacity)
    bin1.set(this.bin1.subarray(0, this.length))
    bin2.set(this.bin2.subarray(0, this.length))
    count.set(this.count.subarray(0, this.length))
    this.bin1 = bin1
    this.bin2 = bin2
    this.count = count
  }
}

/** One block's pixels, in `(bin1, bin2)` order. */
interface BlockPixels {
  bin1: Int32Array
  bin2: Int32Array
  count: Float64Array
}

/**
 * Keep `share` of a block's `size` contacts, every subset equally likely.
 *
 * Selection sampling (Knuth's algorithm S) contact by contact for a small pixel —
 * keep each with probability *wanted left / contacts left* — and the same step as
 * one hypergeometric draw for a large one. Both are exact; the second is what
 * keeps a diagonal pixel of a hundred thousand contacts one draw.
 */
export function subsampleBlock(
  pixels: BlockPixels,
  share: number,
  size: number,
  rng: Rng,
  out: PixelBuffer,
): void {
  let wanted = share
  let pool = size
  const { bin1, bin2, count } = pixels
  for (let i = 0; i < count.length && wanted > 0; i++) {
    const c = count[i]
    if (c === 0) continue
    let kept: number
    if (wanted === pool) {
      kept = c
      pool -= c
    } else if (c <= CONTACT_BY_CONTACT) {
      kept = 0
      for (let k = 0; k < c; k++) {
        if (rng.nextDouble() * pool < wanted - kept) kept++
        pool--
      }
    } else {
      kept = hypergeometric(rng, c, pool - c, wanted)
      pool -= c
    }
    wanted -= kept
    if (kept > 0) out.push(bin1[i], bin2[i], kept)
  }
}

/**
 * `extra` contacts with replacement over `weights`: a multinomial, drawn as a
 * binomial per cell in what is left. The remainders are summed from the far end
 * so the last cells' probabilities are not the rounding error of the first.
 */
export function multinomial(weights: Float64Array, extra: number, rng: Rng): Float64Array {
  const n = weights.length
  const out = new Float64Array(n)
  if (extra <= 0 || n === 0) return out
  const remaining = new Float64Array(n + 1)
  let lastPositive = -1
  for (let i = n - 1; i >= 0; i--) {
    const w = weights[i] > 0 ? weights[i] : 0
    remaining[i] = remaining[i + 1] + w
    if (w > 0 && lastPositive < 0) lastPositive = i
  }
  if (lastPositive < 0) return out
  let left = extra
  for (let i = 0; i < n && left > 0; i++) {
    const w = weights[i]
    if (!(w > 0)) continue
    const drawn = i === lastPositive ? left : binomial(rng, left, Math.min(1, w / remaining[i]))
    out[i] = drawn
    left -= drawn
  }
  return out
}

/** A block between two sequences, oversampled: its own pixels, weighted by their counts. */
export function oversampleTransBlock(pixels: BlockPixels, extra: number, rng: Rng, out: PixelBuffer): void {
  const added = multinomial(pixels.count, extra, rng)
  const { bin1, bin2, count } = pixels
  for (let i = 0; i < count.length; i++) {
    const value = count[i] + added[i]
    if (value > 0) out.push(bin1[i], bin2[i], value)
  }
}

/**
 * A sequence's own block, oversampled through Boost-HiC.
 *
 * The weights are the boosted map in counts over every pair of bins the outlier
 * filter kept, scaled to the contacts those bins hold, and the stored counts
 * wherever a filtered bin is involved — which Boost-HiC leaves out and this
 * cannot, or a bin the filter dropped would come out of an oversample *less*
 * deep than everything around it.
 */
export function oversampleCisBlock(
  pixels: BlockPixels,
  from: number,
  n: number,
  extra: number,
  alpha: number,
  rng: Rng,
  out: PixelBuffer,
): void {
  const observed = new Float64Array(n * n)
  const { bin1, bin2, count } = pixels
  for (let i = 0; i < count.length; i++) {
    const r = bin1[i] - from
    const c = bin2[i] - from
    observed[r * n + c] += count[i]
    if (r !== c) observed[c * n + r] += count[i]
  }
  const boosted = boostHiC(new Float64Array(observed), n, alpha)
  const cells = (n * (n + 1)) / 2
  const weights = new Float64Array(cells)
  let at = 0
  for (let r = 0; r < n; r++) {
    for (let c = r; c < n; c++) weights[at++] = observed[r * n + c]
  }
  if (boosted !== null) {
    const { kept, counts } = boosted
    const size = kept.length
    let stored = 0
    let drawn = 0
    for (let i = 0; i < size; i++) {
      for (let j = i; j < size; j++) {
        stored += observed[kept[i] * n + kept[j]]
        drawn += counts[i * size + j]
      }
    }
    const scale = drawn > 0 ? stored / drawn : 0
    for (let i = 0; i < size; i++) {
      const r = kept[i]
      const rowAt = r * n - (r * (r - 1)) / 2 - r
      for (let j = i; j < size; j++) {
        weights[rowAt + kept[j]] = counts[i * size + j] * scale
      }
    }
  }
  const added = multinomial(weights, extra, rng)
  at = 0
  for (let r = 0; r < n; r++) {
    for (let c = r; c < n; c++, at++) {
      const value = observed[r * n + c] + added[at]
      if (value > 0) out.push(from + r, from + c, value)
    }
  }
}

// ---------------------------------------------------------------------------
// The store
// ---------------------------------------------------------------------------

/** One sequence's row band, drawn: sorted by `bin1`, with each row's first index. */
interface Band {
  sequence: number
  from: number
  bin1: Int32Array
  bin2: Int32Array
  count: Float64Array
  /** `rows[r]` is the first pixel of bin `from + r`; one entry past the last row. */
  rows: Int32Array
  bytes: number
}

/** Everything the store needs of the map besides its pixels. */
export interface ResampleGeometry {
  /** Each sequence's first bin, then the bin count: `indexes/chrom_offset`. */
  starts: ArrayLike<number>
  /** Sequence names, for what a refusal says. */
  names?: readonly string[]
}

/**
 * The map's pixels, redrawn to `spec.contacts` (§6.5).
 *
 * A {@link PixelStore} over the one it resamples, so every reader — the views,
 * the pooled and aggregated reads, the scans, the tasks — gets the resampled map
 * through the seam it already reads through, and nothing above it knows.
 */
export class ResampledStore implements PixelStore {
  readonly countKind = 'i' as const
  private readonly index: SequenceIndex
  private readonly census: Promise<Census>
  private planned: Promise<ResamplePlan> | null = null
  private plan: ResamplePlan | null = null
  private readonly bands = new Map<number, Band>()
  private bytes = 0

  constructor(
    readonly inner: PixelStore,
    private readonly geometry: ResampleGeometry,
    readonly spec: ResampleSpec,
    census: Promise<Census>,
  ) {
    this.index = new SequenceIndex(geometry.starts)
    this.census = census
  }

  /** Stored pixels of the file underneath: what a read costs, not what it returns. */
  get nnz(): number | null {
    return this.inner.nnz
  }

  /**
   * The factor balanced values take, once the plan is known; `1` before.
   *
   * `√(T/N)` on each bin's weight, so a balanced cell is divided by `N/T`: the
   * resampled map is `N/T` times the file in expectation, and ICE run on it
   * converges to the file's weights over `√(N/T)` — up to the noise the draw
   * added. Without it a subsample balanced with the file's weights reads `N/T`
   * times fainter, and two maps drawn to one depth would not be on one scale.
   */
  get weightScale(): number {
    return this.plan?.weightScale ?? 1
  }

  /** The census and the plan, once; every read waits on this. */
  ready(): Promise<ResamplePlan> {
    this.planned ??= this.census.then((census) => {
      if (census.nBins !== this.geometry.starts[this.index.count]) {
        throw refused('This census was taken over another map.', {
          bins: census.nBins,
          nBins: this.geometry.starts[this.index.count],
        })
      }
      const plan = planResample(census, this.spec, this.geometry.starts, this.geometry.names)
      this.plan = plan
      return plan
    })
    return this.planned
  }

  scoreColumns(): string[] {
    return ['count']
  }

  binOffsets(): Float64Array {
    return this.inner.binOffsets()
  }

  async forEachWindow(
    rows: Extent,
    cols: Extent,
    plan: ReadPlan,
    onChunk: (chunk: PixelChunk) => void,
    options: SpanScanOptions = {},
  ): Promise<boolean> {
    // A map already at the total asked for is the file as stored.
    if ((await this.ready()).mode === 'none') return this.inner.forEachWindow(rows, cols, plan, onChunk, options)
    return this.walk([[plan.span[0], plan.span[1]]], onChunk, options)
  }

  async forEachBands(
    bands: readonly Extent[],
    onChunk: (chunk: PixelChunk) => void,
    options: SpanScanOptions = {},
  ): Promise<boolean> {
    if ((await this.ready()).mode === 'none') return this.inner.forEachBands(bands, onChunk, options)
    return this.walk(bands, onChunk, options)
  }

  async scanAll(options: ScanAllOptions): Promise<void> {
    if ((await this.ready()).mode === 'none') return this.inner.scanAll(options)
    const nBins = this.geometry.starts[this.index.count]
    let stopped = false
    await this.walk(
      [[0, nBins]],
      (chunk) => {
        if (stopped) return
        if (options.onChunk(chunk) === false) stopped = true
      },
      {
        cancelled: () => stopped,
        onProgress: (done, total) => options.onProgress?.(done, total),
      },
    )
  }

  /** Emit every drawn pixel whose row is in one of `ranges`. */
  private async walk(
    ranges: readonly Extent[],
    onChunk: (chunk: PixelChunk) => void,
    options: SpanScanOptions,
  ): Promise<boolean> {
    if (options.value !== undefined && options.value !== 'count') {
      throw refused(
        `A resampled map is drawn from its contacts, and “${options.value}” is not a count of ` +
          'them. Read the counts, or balance them, while the map is resampled.',
        { value: options.value },
      )
    }
    const plan = await this.ready()
    const merged = mergeRanges(ranges)
    const wanted: number[] = []
    for (const [lo, hi] of merged) {
      for (const s of this.index.touching(lo, hi)) if (wanted[wanted.length - 1] !== s) wanted.push(s)
    }
    const unique = [...new Set(wanted)].sort((x, y) => x - y)
    let done = 0
    for (let at = 0; at < unique.length; ) {
      if (options.cancelled?.() === true) return false
      // The next run of sequences, as one read where they are small.
      const batch: number[] = []
      let bins = 0
      while (at < unique.length) {
        const s = unique[at]
        const width = this.geometry.starts[s + 1] - this.geometry.starts[s]
        if (batch.length > 0 && bins + width > BATCH_BINS) break
        batch.push(s)
        bins += width
        at++
      }
      const missing = batch.filter((s) => !this.bands.has(s))
      if (missing.length > 0) {
        const drawn = await this.draw(missing, plan, options)
        if (drawn === null) return false
      }
      for (const s of batch) {
        const band = this.bands.get(s)!
        this.touch(s)
        for (const [lo, hi] of merged) {
          const from = Math.max(lo, band.from) - band.from
          const to = Math.min(hi, band.from + band.rows.length - 1) - band.from
          if (to <= from) continue
          const start = band.rows[from]
          const end = band.rows[to]
          if (end > start) {
            onChunk({
              bin1: band.bin1.subarray(start, end),
              bin2: band.bin2.subarray(start, end),
              count: band.count.subarray(start, end),
              length: end - start,
            })
          }
        }
        done++
        options.onProgress?.(done, unique.length)
      }
      this.evict(new Set(batch))
      await yieldToEventLoop()
    }
    return true
  }

  /** Read the stored rows of `sequences`, and draw each into a band. `null` if cancelled. */
  private async draw(
    sequences: readonly number[],
    plan: ResamplePlan,
    options: SpanScanOptions,
  ): Promise<true | null> {
    const starts = this.geometry.starts
    const raw = new Map<number, PixelBuffer>()
    for (const s of sequences) raw.set(s, new PixelBuffer())
    const index = new SequenceIndex(starts)
    // Rows arrive a band at a time, so the buffer is looked up only when the
    // sequence changes rather than once a pixel.
    let lastSequence = -1
    let buffer: PixelBuffer | undefined
    const ok = await this.inner.forEachBands(
      sequences.map((s): Extent => [starts[s], starts[s + 1]]),
      (chunk) => {
        const { bin1, bin2, count, length } = chunk
        for (let i = 0; i < length; i++) {
          if (count[i] === 0) continue
          const s = index.of(bin1[i])
          if (s !== lastSequence) {
            lastSequence = s
            buffer = raw.get(s)
          }
          buffer?.push(bin1[i], bin2[i], count[i])
        }
      },
      ...(options.cancelled === undefined ? [] : [{ cancelled: options.cancelled }]),
    )
    if (!ok) return null
    for (const s of sequences) {
      this.store(this.drawBand(s, raw.get(s)!, plan))
      raw.delete(s)
      if (options.cancelled?.() === true) return null
      await yieldToEventLoop()
    }
    return true
  }

  /** One sequence's stored rows, each block drawn to its share. */
  private drawBand(sequence: number, pixels: PixelBuffer, plan: ResamplePlan): Band {
    const starts = this.geometry.starts
    const from = starts[sequence]
    const to = starts[sequence + 1]
    const sequences = this.index.count
    const n = pixels.length
    const order = canonicalOrder(pixels)
    // Which block each pixel is in — the sequence of its `bin2` — numbered in
    // the order the blocks are met. Within a row `bin2` only grows, so the
    // lookup runs once per block per row rather than once per pixel.
    const index = new SequenceIndex(starts)
    const blockOf = new Int32Array(n)
    const localOf = new Map<number, number>()
    const blockSequence: number[] = []
    let lastSequence = -1
    let lastLocal = -1
    for (let k = 0; k < n; k++) {
      const s = index.of(pixels.bin2[order[k]])
      if (s !== lastSequence) {
        let local = localOf.get(s)
        if (local === undefined) {
          local = blockSequence.length
          localOf.set(s, local)
          blockSequence.push(s)
        }
        lastSequence = s
        lastLocal = local
      }
      blockOf[k] = lastLocal
    }
    // Each block contiguous, in `(bin1, bin2)` order within it: a stable
    // counting sort on the block number.
    const offsets = new Int32Array(blockSequence.length + 1)
    for (let k = 0; k < n; k++) offsets[blockOf[k] + 1]++
    for (let b = 0; b < blockSequence.length; b++) offsets[b + 1] += offsets[b]
    const next = offsets.slice(0, blockSequence.length)
    const bin1 = new Int32Array(n)
    const bin2 = new Int32Array(n)
    const count = new Float64Array(n)
    for (let k = 0; k < n; k++) {
      const i = order[k]
      const at = next[blockOf[k]]++
      bin1[at] = pixels.bin1[i]
      bin2[at] = pixels.bin2[i]
      count[at] = pixels.count[i]
    }

    const out = new PixelBuffer(Math.max(1024, plan.mode === 'sub' ? Math.ceil(n / 2) : n))
    const blocks = blockSequence.map((b, local) => ({ b, local })).sort((x, y) => x.b - y.b)
    for (const { b, local } of blocks) {
      const lo = offsets[local]
      const hi = offsets[local + 1]
      const block: BlockPixels = {
        bin1: bin1.subarray(lo, hi),
        bin2: bin2.subarray(lo, hi),
        count: count.subarray(lo, hi),
      }
      if (plan.mode === 'none') {
        for (let i = 0; i < block.count.length; i++) out.push(block.bin1[i], block.bin2[i], block.count[i])
        continue
      }
      const share = plan.shares.get(sequence * sequences + b) ?? 0
      const rng = new Rng(seedOf(plan.seed, plan.mode === 'sub' ? SUB : OVER, sequence, b))
      if (plan.mode === 'sub') {
        let size = 0
        for (let i = 0; i < block.count.length; i++) size += block.count[i]
        subsampleBlock(block, share, size, rng, out)
      } else if (b === sequence) {
        oversampleCisBlock(block, from, to - from, share, plan.alpha, rng, out)
      } else {
        oversampleTransBlock(block, share, rng, out)
      }
    }
    return toBand(sequence, from, to, out)
  }

  private store(band: Band): void {
    this.bands.set(band.sequence, band)
    this.bytes += band.bytes
  }

  /** Most recently read last, so eviction takes the oldest first. */
  private touch(sequence: number): void {
    const band = this.bands.get(sequence)
    if (band === undefined) return
    this.bands.delete(sequence)
    this.bands.set(sequence, band)
  }

  private evict(keep: ReadonlySet<number>): void {
    for (const [sequence, band] of this.bands) {
      if (this.bytes <= BAND_BUDGET_BYTES) return
      if (keep.has(sequence)) continue
      this.bands.delete(sequence)
      this.bytes -= band.bytes
    }
  }
}

/** Sorted, merged, non-empty ranges. */
function mergeRanges(ranges: readonly Extent[]): Extent[] {
  const sorted = ranges.filter(([lo, hi]) => hi > lo).map(([lo, hi]): Extent => [lo, hi])
  sorted.sort((x, y) => x[0] - y[0])
  const out: Extent[] = []
  for (const range of sorted) {
    const last = out[out.length - 1]
    if (last !== undefined && range[0] <= last[1]) last[1] = Math.max(last[1], range[1])
    else out.push(range)
  }
  return out
}

/** The pixels' indices in `(bin1, bin2)` order; the identity when they already are. */
function canonicalOrder(pixels: PixelBuffer): Int32Array {
  const n = pixels.length
  const order = new Int32Array(n)
  let sorted = true
  for (let i = 0; i < n; i++) {
    order[i] = i
    if (
      i > 0 &&
      (pixels.bin1[i] < pixels.bin1[i - 1] ||
        (pixels.bin1[i] === pixels.bin1[i - 1] && pixels.bin2[i] < pixels.bin2[i - 1]))
    ) {
      sorted = false
    }
  }
  if (sorted) return order
  const { bin1, bin2 } = pixels
  return order.sort((x, y) => bin1[x] - bin1[y] || bin2[x] - bin2[y])
}

/** A drawn band, sorted by row with each row's first index. */
function toBand(sequence: number, from: number, to: number, pixels: PixelBuffer): Band {
  const rows = to - from
  const counts = new Int32Array(rows + 1)
  for (let i = 0; i < pixels.length; i++) counts[pixels.bin1[i] - from + 1]++
  for (let r = 0; r < rows; r++) counts[r + 1] += counts[r]
  const next = counts.slice(0, rows)
  const bin1 = new Int32Array(pixels.length)
  const bin2 = new Int32Array(pixels.length)
  const count = new Float64Array(pixels.length)
  for (let i = 0; i < pixels.length; i++) {
    const at = next[pixels.bin1[i] - from]++
    bin1[at] = pixels.bin1[i]
    bin2[at] = pixels.bin2[i]
    count[at] = pixels.count[i]
  }
  return { sequence, from, bin1, bin2, count, rows: counts, bytes: pixels.length * 16 + counts.length * 4 }
}
