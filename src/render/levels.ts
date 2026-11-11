/**
 * The picture of a large block at the size it is looked at, made straight from
 * its values — and the colour range that picture is drawn on, made the same way.
 *
 * The raster used to be made in one order for every block: every cell
 * transformed and coloured into an image at matrix resolution, that image put
 * onto a canvas, and the canvas halved until a level was small enough to draw.
 * On a block of a few thousand cells a side that is a few hundred milliseconds,
 * and it is what the first frame of every view waited for. On the blocks a
 * whole chromosome is read as (§7.2) it was the wait: mouse chr1 at 20 kb is
 * 9,774 cells a side, and its first frame spent 7.5 s on the main thread making
 * a 382 MB image and three halvings of it, to draw about seven hundred pixels;
 * yeast chrIV at 100 bp spent 23 s. The worker had finished reading in under
 * three.
 *
 * Everything in that order but the last level was work for a picture nobody had
 * asked for yet. So a large block is drawn the other way round:
 *
 * - **The level the frame needs is made first, and directly.** One pass over the
 *   cells, each coloured exactly as {@link colorize} would colour it and
 *   averaged into the pixel of that level it falls in — the same average of
 *   colours the halvings made, transparency included, without the full image the
 *   halvings were made from. That is the first frame: a pass over the values,
 *   not five.
 * - **A finer level is made when a zoom needs it** (`HeatmapView`), in slices
 *   between frames, while the level in hand is drawn in its place.
 * - **The colour range is the same number**, to the bit — §7.1 ties it to numpy —
 *   but read as order statistics of the raw values rather than of a transformed
 *   copy of the block ({@link autoRangeOfValues}).
 *
 * Neither half reads a value through a transform per cell. Every transform here
 * is monotone over positive values, so a cell's colour is a step function of
 * its raw value: the raw value where each step starts is found once, by
 * bisecting the float's own bit pattern through the very arithmetic `colorize`
 * applies, and a cell is then placed by its bits alone (`ColourSteps`). It is the
 * same colour `colorize` gives it, not an approximation of one, which is what
 * lets a test hold the two to equality.
 */

import type { ColorScale, Transform } from '../types'
import { COLORMAP_SIZE, applyColormap, colormapIndex } from './colormaps'
import { AUTO_VMAX_PERCENTILE, AUTO_VMIN_PERCENTILE, displayValue, selectNth, type ValueRange } from './scale'

/**
 * How many halvings of the raster a view will draw from; see
 * `HeatmapView.rasterFor`.
 *
 * Four is a sixteen-fold reduction, which is a whole yeast genome at 500 bp in a
 * thumbnail. Past it the level is smaller than the plot's own margins and there
 * is nothing left to filter.
 */
export const MAX_RASTER_LEVELS = 4

/** Below this many pixels on an axis, a level is not halved again. */
export const MIN_RASTER_LEVEL = 8

/**
 * Cells from which a block is drawn level by level rather than whole.
 *
 * About 2,048 a side. Below it the whole-image order costs a few hundred
 * milliseconds at most and keeps the halvings it has always drawn; above it
 * that order is the wait the first frame of a chromosome used to be.
 */
export const LEVEL_MIN_CELLS = 1 << 22

/**
 * Which level a draw samples, where `scale` is destination pixels per raster
 * pixel on the axis shrunk least: `0` for the raster itself while it is
 * magnified, else the level whose pixels land between a half and one
 * destination pixel — no deeper than {@link MAX_RASTER_LEVELS}, and never
 * below {@link MIN_RASTER_LEVEL} pixels on a side. The rule
 * `HeatmapView.rasterFor` applies to the halvings it makes.
 */
export function levelFor(scale: number, width: number, height: number): number {
  if (!(scale > 0) || scale >= 1) return 0
  const wanted = Math.min(MAX_RASTER_LEVELS, Math.floor(Math.log2(1 / scale)))
  let level = 0
  let w = width
  let h = height
  while (level < wanted && w > MIN_RASTER_LEVEL && h > MIN_RASTER_LEVEL) {
    w = Math.ceil(w / 2)
    h = Math.ceil(h / 2)
    level++
  }
  return level
}

/** The size of a level: each halving rounds up, as the canvas halvings did. */
export function levelSize(level: number, width: number, height: number): { width: number; height: number } {
  const factor = 2 ** level
  return { width: Math.ceil(width / factor), height: Math.ceil(height / factor) }
}

// ---------------------------------------------------------------------------
// The bits of a float
// ---------------------------------------------------------------------------

/**
 * The bit pattern of `+Infinity`. Every positive float32, from the smallest
 * subnormal (`1`) up to infinity, has a pattern at or below it, and the patterns
 * of positive floats sort exactly as the floats do — the one fact both halves of
 * this module stand on.
 */
const INFINITY_BITS = 0x7f800000

/** The pattern of the largest finite float32. */
const MAX_FINITE_BITS = 0x7f7fffff

/** The pattern of `1`. */
const ONE_BITS = 0x3f800000

/** Bins of the bit-pattern histograms: the top sixteen bits of a positive pattern. */
const BIN_SHIFT = 16
const BINS = (INFINITY_BITS >>> BIN_SHIFT) + 1

/** A `Uint32Array` over the same bytes as `values`: each cell's bit pattern. */
function bitsOf(values: Float32Array): Uint32Array {
  return new Uint32Array(values.buffer, values.byteOffset, values.length)
}

// ---------------------------------------------------------------------------
// The colour range
// ---------------------------------------------------------------------------

/**
 * `autoRangeOfDisplay` of a block drawn a cell to a pixel — the same two
 * numbers, from the raw values, with no transformed copy of the block.
 *
 * The rule is §7.1's: for counts, `vmin = 0` and `vmax` at the 99th percentile
 * of the cells whose transformed value is positive; for balanced values, or a
 * count block with none positive, the 1st and 99th percentiles of the cells that
 * carry a contact. Both selections are of order statistics, and every transform
 * is monotone over positive values — which are the only values either rule
 * keeps: a positive transformed value is a raw value above `0` (`log1p`, `none`)
 * or above `1` (`log10`, `log2`), and a contact is a finite raw value above `0`,
 * or above `1` under the count rule's `log10`. So the order statistics are taken
 * of the raw values and only the two each percentile straddles are transformed —
 * rounded to float32 as the pooled raster stored them, and interpolated with
 * `percentileOf`'s own arithmetic, so the answer is the same to the last bit.
 *
 * And the order statistics are found without a sort or a copy of the kept
 * values: a histogram of the top sixteen bits of each kept value's pattern finds
 * the bin each rank falls in, and only that bin's values are gathered and
 * selected from. Two passes over the block, each a load, two comparisons and an
 * increment per cell.
 */
export function autoRangeOfValues(
  values: Float32Array,
  transform: Transform,
  balanced = false,
  listed: ListedCells | null = null,
): ValueRange {
  // A NaN is kept by neither rule, so the rows and columns of them a list sets
  // apart change nothing here: the listed cells are all there is to read, and
  // they are read as a block of their own — their patterns, and the values those
  // patterns are.
  const bits = listed === null ? bitsOf(values) : listed.bits
  if (listed !== null) values = new Float32Array(bits.buffer, bits.byteOffset, bits.length)
  const aboveOne = transform === 'log10' || transform === 'log2'
  if (!balanced) {
    // Positive after the transform; `+Infinity` included, as `x > 0` keeps it.
    const vmax = percentilesOf(values, bits, aboveOne ? ONE_BITS : 0, INFINITY_BITS, transform, balanced, [
      AUTO_VMAX_PERCENTILE,
    ])
    if (vmax !== null) return { vmin: 0, vmax: vmax[0] }
  }
  // A contact: a finite transformed value above the transform of zero. That
  // floor is `0` under `log1p`, `none` and the count rule's `log10`, where it
  // keeps raw values above `0`, `0` and `1`; under `log2` and a balanced `log10`
  // it is `-Infinity`, and every finite positive raw value is above it.
  const floorAtOne = transform === 'log10' && !balanced
  const both = percentilesOf(values, bits, floorAtOne ? ONE_BITS : 0, MAX_FINITE_BITS, transform, balanced, [
    AUTO_VMIN_PERCENTILE,
    AUTO_VMAX_PERCENTILE,
  ])
  if (both === null) return { vmin: 0, vmax: 1.0 }
  const [vmin, vmax] = both
  return vmax > vmin ? { vmin, vmax } : { vmin, vmax: vmin + 1 }
}

/**
 * The cells of a block that carry something, listed — where there are few
 * enough of them to be worth it — or `null` for a block read whole.
 *
 * Both rules of the colour range keep only values above zero, and a level
 * colours every zero alike: so once the rest of a block is listed, neither reads
 * its zeros again. At the bin sizes a block is largest at they are most of it —
 * of mouse chr1's 95 million cells at 20 kb, 8.4 million hold a contact — and
 * reading past them three times was most of what its first frame cost.
 *
 * A balanced block has a second kind of cell that is not zero: NaN, along the
 * whole row and the whole column of every bin the balancing left out — 3.8% of
 * those rows, which is 7.4% of the cells, and on yeast chrIV at 100 bp a fifth
 * of them. Listed one by one they would outnumber the contacts, so whole rows and
 * columns of NaN are found first and kept as two short lists of their own
 * (`nanRows`, `nanCols`), and only what is left is listed: every cell that is
 * not `±0` outside them, a NaN that is not part of one included. A column is
 * taken for one from the NaNs of the first and last rows that are not NaN
 * themselves, and confirmed in every other row as the list is made; a block in
 * which that fails, or that is denser than one listed cell in
 * {@link LISTED_SHARE}, is read whole.
 */
export interface ListedCells {
  /** Cells that are not `±0` and not in a NaN row or column, by index, ascending. */
  readonly cells: Uint32Array
  /**
   * Their bit patterns, in the same order — so the colour range and a level read
   * the list from start to end rather than going back into the block by index,
   * a cache miss a cell on a block of hundreds of megabytes.
   */
  readonly bits: Uint32Array
  /** Rows every cell of which is NaN, ascending. */
  readonly nanRows: Uint32Array
  /** Columns every cell of which is NaN, ascending. */
  readonly nanCols: Uint32Array
}

export function listCells(values: Float32Array, nrows: number, ncols: number): ListedCells | null {
  const bits = bitsOf(values)
  if (nrows * ncols !== bits.length || nrows === 0 || ncols === 0) return null
  // A first look, from one cell in `SAMPLE_STRIDE`: a block whose cells that are
  // neither zero nor NaN are past the share already is dense whatever its NaN
  // rows and columns are, and is read whole without looking for them.
  let looked = 0
  let carrying = 0
  for (let i = 0; i < bits.length; i += SAMPLE_STRIDE) {
    looked++
    const a = bits[i] & 0x7fffffff
    if (a !== 0 && a <= INFINITY_BITS) carrying++
  }
  if (carrying * LISTED_SHARE > looked) return null
  const nan = (p: number): boolean => (p & 0x7fffffff) > INFINITY_BITS
  // Rows of NaN: a row whose first cell is not NaN cannot be one.
  const nanRow = new Uint8Array(nrows)
  for (let r = 0; r < nrows; r++) {
    const base = r * ncols
    if (!nan(bits[base])) continue
    let whole = true
    for (let c = 1; c < ncols && whole; c++) whole = nan(bits[base + c])
    if (whole) nanRow[r] = 1
  }
  let first = 0
  while (first < nrows && nanRow[first] === 1) first++
  let last = nrows - 1
  while (last >= 0 && nanRow[last] === 1) last--
  // Columns of NaN, as far as two rows can tell; confirmed below in every row.
  const nanCol = new Uint8Array(ncols)
  const odd: number[] = []
  if (first < nrows) {
    for (let c = 0; c < ncols; c++) {
      if (nan(bits[first * ncols + c]) && nan(bits[last * ncols + c])) {
        nanCol[c] = 1
        odd.push(c)
      }
    }
  }
  // The runs of columns between them.
  const runs: number[] = []
  let from = 0
  for (const c of odd) {
    if (c > from) runs.push(from, c)
    from = c + 1
  }
  if (from < ncols) runs.push(from, ncols)
  // How many cells will be listed: the first look's count of the ones that carry
  // something, with room for a quarter more; a NaN that is not part of a row or
  // a column of them is listed too, and grows the list if there are many.
  const cap = Math.floor((nrows * ncols) / LISTED_SHARE)
  const estimate = Math.ceil((carrying / looked) * nrows * ncols * 1.25)
  let room = Math.min(cap, Math.max(KEPT_START, estimate))
  let list = new Uint32Array(room)
  let patterns = new Uint32Array(room)
  let m = 0
  for (let r = 0; r < nrows; r++) {
    if (nanRow[r] === 1) continue
    const base = r * ncols
    for (let k = 0; k < runs.length; k += 2) {
      const end = base + runs[k + 1]
      for (let i = base + runs[k]; i < end; i++) {
        const p = bits[i]
        if ((p & 0x7fffffff) === 0) continue
        if (m === room) {
          // Denser than the sample said, and past the share: read whole after all.
          if (room >= cap) return null
          room = Math.min(cap, room * 2)
          const next = new Uint32Array(room)
          next.set(list)
          list = next
          const nextPatterns = new Uint32Array(room)
          nextPatterns.set(patterns)
          patterns = nextPatterns
        }
        list[m] = i
        patterns[m++] = p
      }
    }
    // Each NaN column confirmed in this row, now that the row is in the cache:
    // asked before reading it, each was a miss of its own.
    for (let k = 0; k < odd.length; k++) {
      if ((bits[base + odd[k]] & 0x7fffffff) <= INFINITY_BITS) return null
    }
  }
  const nanRows: number[] = []
  for (let r = 0; r < nrows; r++) if (nanRow[r] === 1) nanRows.push(r)
  return {
    cells: list.subarray(0, m),
    bits: patterns.subarray(0, m),
    nanRows: Uint32Array.from(nanRows),
    nanCols: Uint32Array.from(odd),
  }
}

/**
 * One cell in how many may be listed by {@link listCells}. A listed cell is
 * eight bytes — its index and its value — so a list at the share is half the
 * block's own four bytes a cell again, and below it everything read from the
 * list is read in a quarter of the cells or fewer.
 */
const LISTED_SHARE = 4

/**
 * `percentileOf` at each of `qs`, over the transformed values of the cells whose
 * pattern is in `(low, high]` — or `null` when there are none.
 */
function percentilesOf(
  values: Float32Array,
  bits: Uint32Array,
  low: number,
  high: number,
  transform: Transform,
  balanced: boolean,
  qs: readonly number[],
): number[] | null {
  const hist = new Uint32Array(BINS)
  // The kept values themselves are gathered as they are counted where there are
  // few enough to hold — which at a fine bin size is most blocks, a contact map
  // being mostly empty there — so the ranks are selected from them and the block
  // is read once. How many there will be is estimated from one cell in
  // `SAMPLE_STRIDE` first, so a dense block does not gather only to give up.
  let sampled = 0
  for (let i = 0; i < bits.length; i += SAMPLE_STRIDE) {
    const p = bits[i]
    if (p > low && p <= high) sampled++
  }
  const estimate = sampled * SAMPLE_STRIDE
  const room = estimate * 2 <= KEPT_MAX ? Math.max(KEPT_START, estimate * 2) : 0
  let kept: Float32Array | null = room > 0 ? new Float32Array(Math.min(room, bits.length)) : null
  let n = 0
  if (kept !== null) {
    const held = kept.length
    for (let i = 0; i < bits.length; i++) {
      const p = bits[i]
      if (p > low && p <= high) {
        hist[p >>> BIN_SHIFT]++
        if (n < held) kept[n] = values[i]
        n++
      }
    }
    // More than the estimate made room for: read the block a second time instead.
    if (n > held) kept = null
  } else {
    for (let i = 0; i < bits.length; i++) {
      const p = bits[i]
      if (p > low && p <= high) {
        hist[p >>> BIN_SHIFT]++
        n++
      }
    }
  }
  if (n === 0) return null
  const gathered = kept === null ? null : kept.subarray(0, n)
  if (gathered !== null) return interpolated(n, qs, transform, balanced, (rank) => selectNth(gathered, rank))
  const ranks: number[] = []
  for (const q of qs) {
    const pos = ((n - 1) * q) / 100
    ranks.push(Math.floor(pos), Math.ceil(pos))
  }
  const raw = orderStatistics(values, bits, low, high, hist, ranks)
  const byRank = new Map(ranks.map((rank, k) => [rank, raw[k]]))
  return interpolated(n, qs, transform, balanced, (rank) => byRank.get(rank) as number)
}

/**
 * Each of `qs` as `percentileOf` interpolates it among `n` kept values, given
 * the raw value at any rank: the two order statistics a percentile straddles are
 * transformed — rounded to float32, as the pooled raster stored them — and the
 * interpolation is `percentileOf`'s, character for character.
 */
function interpolated(
  n: number,
  qs: readonly number[],
  transform: Transform,
  balanced: boolean,
  at: (rank: number) => number,
): number[] {
  return qs.map((q) => {
    const pos = ((n - 1) * q) / 100
    const lo = Math.floor(pos)
    const hi = Math.ceil(pos)
    const a = Math.fround(displayValue(at(lo), transform, balanced))
    if (lo === hi) return a
    const b = Math.fround(displayValue(at(hi), transform, balanced))
    const t = pos - lo
    const diff = b - a
    return t < 0.5 ? a + diff * t : b - diff * (1 - t)
  })
}

/**
 * The least room made for gathering kept values, the most — 64 MB of them —
 * and the one cell in how many the estimate of their number is taken from.
 */
const KEPT_START = 1 << 16
const KEPT_MAX = 1 << 24
const SAMPLE_STRIDE = 61

/** The kept values at each of `ranks`, by way of the bins they fall in. */
function orderStatistics(
  values: Float32Array,
  bits: Uint32Array,
  low: number,
  high: number,
  hist: Uint32Array,
  ranks: readonly number[],
): number[] {
  // The bin of each rank, and the rank within it.
  const binOf: number[] = []
  const within: number[] = []
  for (const rank of ranks) {
    let seen = 0
    let bin = 0
    while (bin < BINS && seen + hist[bin] <= rank) seen += hist[bin++]
    binOf.push(bin)
    within.push(rank - seen)
  }
  // Each bin asked for, gathered once.
  const slot = new Int8Array(BINS).fill(-1)
  const gathered: Float32Array[] = []
  const filled: number[] = []
  for (const bin of binOf) {
    if (slot[bin] !== -1) continue
    slot[bin] = gathered.length
    gathered.push(new Float32Array(hist[bin]))
    filled.push(0)
  }
  for (let i = 0; i < bits.length; i++) {
    const p = bits[i]
    if (p <= low || p > high) continue
    const s = slot[p >>> BIN_SHIFT]
    if (s === -1) continue
    gathered[s][filled[s]++] = values[i]
  }
  // `selectNth` places the k-th smallest whatever order it is handed, so a bin
  // two ranks fall in is selected from twice rather than sorted.
  return ranks.map((_, k) => selectNth(gathered[slot[binOf[k]]], within[k]))
}

// ---------------------------------------------------------------------------
// The colour of a cell
// ---------------------------------------------------------------------------

/** What `colorize` draws a cell with no colour as. */
const NO_COLOUR = -1

/** The place value of green in a level's summed red and green; see `paintAverages`. */
const CHANNEL = 2 ** 26

/**
 * The colour-table index `colorize` gives a cell of `raw`, or {@link NO_COLOUR}.
 *
 * Literally its arithmetic: the transformed value rounded to float32, which is
 * what the pooled raster held, then normalised, scaled and truncated onto the
 * table. The fast path below is only ever this function, precomputed.
 */
function exactIndex(
  raw: number,
  transform: Transform,
  balanced: boolean,
  vmin: number,
  span: number,
  size: number,
): number {
  const best = Math.fround(displayValue(raw, transform, balanced))
  if (Number.isNaN(best)) return NO_COLOUR
  const x = (span > 0 ? (best - vmin) / span : 0) * size
  return x >= size ? size - 1 : x > 0 ? x | 0 : 0
}

/**
 * A cell's colour index from its bit pattern, for every positive value.
 *
 * `start[bin]` is the index of the smallest pattern in a bin of the top sixteen
 * bits, and `steps[j]` the smallest pattern whose index is `j` or more — so a
 * cell starts at its bin's index and steps up past each threshold it is at or
 * above, which is no step at all for almost every cell: a bin is under one per
 * cent of its value wide, a colour of a log scale several per cent.
 */
interface ColourSteps {
  start: Uint8Array
  steps: Uint32Array
}

function colourSteps(transform: Transform, balanced: boolean, vmin: number, span: number): ColourSteps {
  const size = COLORMAP_SIZE
  const last = size - 1
  const scratch = new Float32Array(1)
  const pattern = new Uint32Array(scratch.buffer)
  const at = (p: number): number => {
    pattern[0] = p
    return exactIndex(scratch[0], transform, balanced, vmin, span, size)
  }
  // `steps[0]` is the first positive pattern, below which nothing is asked.
  const steps = new Uint32Array(size + 1)
  steps[0] = 1
  const top = at(INFINITY_BITS)
  for (let j = 1; j <= last; j++) {
    if (top < j) {
      // Never reached: the highest positive value is coloured below `j`.
      steps[j] = INFINITY_BITS + 1
      continue
    }
    // The index rises with the pattern, so the first pattern at `j` or above is
    // a bisection — from the previous step, which every later one is at or past.
    let lo = steps[j - 1]
    let hi = INFINITY_BITS
    while (lo < hi) {
      const mid = lo + Math.floor((hi - lo) / 2)
      if (at(mid) >= j) hi = mid
      else lo = mid + 1
    }
    steps[j] = lo
  }
  steps[size] = INFINITY_BITS + 1
  const start = new Uint8Array(BINS)
  let j = 0
  for (let bin = 0; bin < BINS; bin++) {
    const smallest = bin === 0 ? 1 : bin << BIN_SHIFT
    while (j < last && steps[j + 1] <= smallest) j++
    start[bin] = j
  }
  return { start, steps }
}

// ---------------------------------------------------------------------------
// A level
// ---------------------------------------------------------------------------

/**
 * Paints the levels of one block on one resolved scale.
 *
 * Built once per colouring — a new block, a new scale, a new colormap — and
 * asked for rows of whichever level a frame needs, so a level can be made in
 * one call for the first frame or in slices between frames for a later one.
 * Holds nothing per level: what a level costs is the canvas it is put on.
 */
export class LevelPainter {
  readonly width: number
  readonly height: number
  private readonly values: Float32Array
  private readonly bits: Uint32Array
  private readonly transform: Transform
  private readonly balanced: boolean
  private readonly vmin: number
  private readonly span: number
  private readonly steps: ColourSteps
  /** The table, one opaque word per colour, for a level drawn a cell to a pixel. */
  private readonly words: Uint32Array
  /** And by channel, for the levels that average. */
  private readonly red: Uint8Array
  private readonly green: Uint8Array
  private readonly blue: Uint8Array
  /** The colour of a cell with none: transparent, or the ramp's middle. */
  private readonly missingWord: number
  private readonly missingOpaque: boolean
  private readonly missingRgb: readonly [number, number, number]
  /** The index of a zero cell, and of a NaN one — neither is ever on the fast path. */
  private readonly zeroIndex: number
  private readonly nanIndex: number
  /** The word a zero cell is drawn as, and a NaN one. */
  private readonly zeroWord: number
  private readonly nanWord: number
  /** The listed cells, where the block lists them ({@link listCells}). */
  private readonly cells: Uint32Array | null
  private readonly listed: ListedCells | null
  /**
   * NaN rows and columns before each row and column, where the block is listed:
   * how many cells of a level's pixel they cover, by subtraction.
   */
  private readonly nanRowsBefore: Uint32Array | null
  private readonly nanColsBefore: Uint32Array | null

  /**
   * @param scale Resolved: both bounds finite, as `colorize` resolves them.
   * @param listed The block's listed cells and its NaN rows and columns, where it
   * is sparse enough to list ({@link listCells}): a level is then painted from
   * them, the zero colour and the colour of NaN, in time with the cells that
   * carry something rather than with all of them. `null` reads the block whole.
   */
  constructor(values: Float32Array, nrows: number, ncols: number, scale: ColorScale, listed: ListedCells | null = null) {
    this.values = values
    this.bits = bitsOf(values)
    this.listed = listed
    this.cells = listed === null ? null : listed.cells
    this.nanRowsBefore = listed === null ? null : before(listed.nanRows, nrows)
    this.nanColsBefore = listed === null ? null : before(listed.nanCols, ncols)
    this.width = ncols
    this.height = nrows
    this.transform = scale.transform
    this.balanced = scale.balanced === true
    this.vmin = scale.vmin
    this.span = scale.vmax - scale.vmin
    this.steps = colourSteps(this.transform, this.balanced, this.vmin, this.span)
    const lut = applyColormap(scale.colormap)
    this.words = new Uint32Array(lut.buffer, lut.byteOffset, lut.length / 4)
    this.red = new Uint8Array(COLORMAP_SIZE)
    this.green = new Uint8Array(COLORMAP_SIZE)
    this.blue = new Uint8Array(COLORMAP_SIZE)
    for (let i = 0; i < COLORMAP_SIZE; i++) {
      this.red[i] = lut[i * 4]
      this.green[i] = lut[i * 4 + 1]
      this.blue[i] = lut[i * 4 + 2]
    }
    const middle = colormapIndex(0.5)
    this.missingOpaque = scale.missing === 'middle'
    this.missingWord = this.missingOpaque ? this.words[middle] : 0
    this.missingRgb = this.missingOpaque ? [lut[middle * 4], lut[middle * 4 + 1], lut[middle * 4 + 2]] : [0, 0, 0]
    this.zeroIndex = this.exact(0)
    this.nanIndex = this.exact(Number.NaN)
    this.zeroWord = this.zeroIndex === NO_COLOUR ? this.missingWord : this.words[this.zeroIndex]
    this.nanWord = this.nanIndex === NO_COLOUR ? this.missingWord : this.words[this.nanIndex]
  }

  /** The size of `level`. */
  size(level: number): { width: number; height: number } {
    return levelSize(level, this.width, this.height)
  }

  private exact(raw: number): number {
    return exactIndex(raw, this.transform, this.balanced, this.vmin, this.span, COLORMAP_SIZE)
  }

  /**
   * The index of a cell that is neither zero nor positive: a NaN, or a negative
   * value. Rare in a contact map, so it pays for the transform.
   */
  private slowIndex(i: number): number {
    const raw = this.values[i]
    return raw !== raw ? this.nanIndex : this.exact(raw)
  }

  /**
   * Paint rows `[from, to)` of `level` into `out`, which holds exactly those rows:
   * `level`'s width times `to - from` pixels of RGBA.
   *
   * Level `0` is the block a cell to a pixel, coloured as `colorize` colours it.
   * Every level above it is the average of the colours of the `2^level` square of
   * cells under each pixel — the cells the edge of the block leaves out
   * included as nothing rather than as paper — averaged as a canvas averages:
   * the colour over the cells that have one, and an alpha that is the share of
   * them that do. So a level is what the halvings of level 0 used to make,
   * without level 0.
   */
  paintRows(level: number, from: number, to: number, out: Uint8ClampedArray): void {
    if (level !== 0) this.paintAverages(level, from, to, out)
    else if (this.cells !== null) this.paintListedCells(this.cells, from, to, out)
    else this.paintCells(from, to, out)
  }

  /**
   * {@link paintCells} from the listed cells: the rows filled with the zero
   * colour, the NaN columns and rows laid over them, and the listed cells set.
   */
  private paintListedCells(cells: Uint32Array, from: number, to: number, out: Uint8ClampedArray): void {
    const { width, words, missingWord, nanWord } = this
    const listed = this.listed as ListedCells
    const pixels = new Uint32Array(out.buffer, out.byteOffset, (to - from) * width)
    pixels.fill(this.zeroWord)
    for (let y = from; y < to; y++) {
      const row = (y - from) * width
      for (let k = 0; k < listed.nanCols.length; k++) pixels[row + listed.nanCols[k]] = nanWord
    }
    for (let k = firstAtOrAfter(listed.nanRows, from); k < listed.nanRows.length && listed.nanRows[k] < to; k++) {
      const row = (listed.nanRows[k] - from) * width
      pixels.fill(nanWord, row, row + width)
    }
    const base = from * width
    const end = to * width
    const patterns = listed.bits
    const { start, steps } = this.steps
    const last = COLORMAP_SIZE - 1
    for (let k = firstAtOrAfter(cells, base); k < cells.length; k++) {
      const i = cells[k]
      if (i >= end) break
      const p = patterns[k]
      let index: number
      if (p <= INFINITY_BITS) {
        index = start[p >>> BIN_SHIFT]
        while (index < last && p >= steps[index + 1]) index++
      } else {
        index = this.slowIndex(i)
      }
      pixels[i - base] = index === NO_COLOUR ? missingWord : words[index]
    }
  }

  private paintCells(from: number, to: number, out: Uint8ClampedArray): void {
    const { width, bits, words, missingWord, zeroIndex } = this
    const { start, steps } = this.steps
    const last = COLORMAP_SIZE - 1
    const pixels = new Uint32Array(out.buffer, out.byteOffset, (to - from) * width)
    const zeroWord = zeroIndex === NO_COLOUR ? missingWord : words[zeroIndex]
    let o = 0
    for (let y = from; y < to; y++) {
      const row = y * width
      for (let x = 0; x < width; x++) {
        const p = bits[row + x]
        let index: number
        if ((p & 0x7fffffff) === 0) {
          pixels[o++] = zeroWord
          continue
        } else if (p <= INFINITY_BITS) {
          index = start[p >>> BIN_SHIFT]
          while (index < last && p >= steps[index + 1]) index++
        } else {
          index = this.slowIndex(row + x)
        }
        pixels[o++] = index === NO_COLOUR ? missingWord : words[index]
      }
    }
  }

  private paintAverages(level: number, from: number, to: number, out: Uint8ClampedArray): void {
    const { width: ncols, height: nrows, bits, red, green, blue, zeroIndex, missingOpaque, missingRgb } = this
    const { start, steps } = this.steps
    const last = COLORMAP_SIZE - 1
    const factor = 2 ** level
    const width = Math.ceil(ncols / factor)
    // A colour's red and green are added as one number, `red + green × 2^26`, and
    // its blue as another: a pixel of any level drawn sums at most 2^26 / 255
    // cells' worth of a channel, and both sums stay integers a double holds
    // exactly. Two additions a cell rather than three — the cells that are
    // neither empty nor zero are the whole of this loop's cost.
    const redGreen = new Float64Array(COLORMAP_SIZE)
    for (let i = 0; i < COLORMAP_SIZE; i++) redGreen[i] = red[i] + green[i] * CHANNEL
    const missingRedGreen = missingRgb[0] + missingRgb[1] * CHANNEL
    const missingBlue = missingRgb[2]
    // One output row's sums at a time, over the cells that are neither zero nor
    // empty: in a sparse block a small share of them. A zero cell costs a
    // comparison, and its colour is added once per pixel at the end.
    const rg = new Float64Array(width)
    const bl = new Float64Array(width)
    const counted = new Uint32Array(width)
    const clear = new Uint32Array(width)
    const zeroOpaque = zeroIndex !== NO_COLOUR || missingOpaque
    const zeroRedGreen = zeroIndex === NO_COLOUR ? missingRedGreen : redGreen[zeroIndex]
    const zeroBlue = zeroIndex === NO_COLOUR ? missingBlue : blue[zeroIndex]
    // The cells of a listed block's NaN rows and columns, coloured as one NaN is.
    const nanIndex = this.nanIndex
    const nanOpaque = nanIndex !== NO_COLOUR || missingOpaque
    const nanRedGreen = nanIndex === NO_COLOUR ? missingRedGreen : redGreen[nanIndex]
    const nanBlue = nanIndex === NO_COLOUR ? missingBlue : blue[nanIndex]
    const rowsBefore = this.nanRowsBefore
    const colsBefore = this.nanColsBefore
    // What `sumListed` adds to, and how it colours the rare cell that is neither
    // zero nor positive.
    const sums: RowSums = { rg, bl, counted, clear, redGreen, blue, missingOpaque, missingRedGreen, missingBlue }
    const slow = (i: number): number => this.slowIndex(i)
    // A pixel of nothing but zeros is written whole, as the word `colorize`
    // writes for one zero cell.
    const pixels = new Uint32Array(out.buffer, out.byteOffset, out.length / 4)
    const zeroWord = this.zeroWord
    const cells = this.cells
    const patterns = this.listed === null ? bits : this.listed.bits
    let k = cells === null ? 0 : firstAtOrAfter(cells, from * factor * ncols)
    let o = 0
    for (let ry = from; ry < to; ry++) {
      // The sums start at zero: fresh for the first row, and handed back at zero
      // by the loop that reads them out at the end of every row.
      const y0 = ry * factor
      const y1 = Math.min(y0 + factor, nrows)
      if (cells !== null) {
        // The listed cells of these rows, which are the next ones in the list:
        // its order is the block's.
        k = sumListed(cells, patterns, k, y0, y1, ncols, level, start, steps, sums, slow)
      } else {
        for (let y = y0; y < y1; y++) {
          const row = y * ncols
          for (let x = 0; x < ncols; x++) {
            const p = bits[row + x]
            if ((p & 0x7fffffff) === 0) continue
            const ox = x >> level
            counted[ox]++
            let index: number
            if (p <= INFINITY_BITS) {
              index = start[p >>> BIN_SHIFT]
              while (index < last && p >= steps[index + 1]) index++
            } else {
              index = this.slowIndex(row + x)
            }
            if (index !== NO_COLOUR) {
              rg[ox] += redGreen[index]
              bl[ox] += blue[index]
            } else if (missingOpaque) {
              rg[ox] += missingRedGreen
              bl[ox] += missingBlue
            } else {
              clear[ox]++
            }
          }
        }
      }
      const rows = y1 - y0
      const nanRowsIn = rowsBefore === null ? 0 : rowsBefore[y1] - rowsBefore[y0]
      for (let ox = 0; ox < width; ox++) {
        const c = counted[ox]
        // The NaN cells under this pixel that the list sets apart: its NaN rows'
        // cells, its NaN columns', and the cells both count once.
        let masked = 0
        if (colsBefore !== null) {
          const x0 = ox * factor
          const x1 = Math.min(x0 + factor, ncols)
          const nanColsIn = colsBefore[x1] - colsBefore[x0]
          masked = nanRowsIn * (x1 - x0) + nanColsIn * rows - nanRowsIn * nanColsIn
        }
        if (c === 0 && masked === 0) {
          // Nothing but zeros under this pixel, which is most pixels of a sparse
          // block: the zero colour itself — or nothing, where a zero has none —
          // and no sums to read or hand back.
          pixels[o >> 2] = zeroWord
          o += 4
          continue
        }
        const cols = Math.min(factor, ncols - ox * factor)
        const covered = rows * cols
        const zeros = covered - c - masked
        let n = c - clear[ox]
        let sumRedGreen = rg[ox]
        let sumBlue = bl[ox]
        rg[ox] = bl[ox] = 0
        counted[ox] = clear[ox] = 0
        if (zeroOpaque && zeros > 0) {
          sumRedGreen += zeros * zeroRedGreen
          sumBlue += zeros * zeroBlue
          n += zeros
        }
        if (nanOpaque && masked > 0) {
          sumRedGreen += masked * nanRedGreen
          sumBlue += masked * nanBlue
          n += masked
        }
        if (n === 0) {
          pixels[o >> 2] = 0
        } else {
          const sumGreen = Math.floor(sumRedGreen / CHANNEL)
          out[o] = Math.round((sumRedGreen - sumGreen * CHANNEL) / n)
          out[o + 1] = Math.round(sumGreen / n)
          out[o + 2] = Math.round(sumBlue / n)
          out[o + 3] = Math.round((255 * n) / covered)
        }
        o += 4
      }
    }
  }
}

/** The first position in ascending `cells` whose index is `value` or more. */
function firstAtOrAfter(cells: Uint32Array, value: number): number {
  let lo = 0
  let hi = cells.length
  while (lo < hi) {
    const mid = (lo + hi) >>> 1
    if (cells[mid] < value) lo = mid + 1
    else hi = mid
  }
  return lo
}

/** For ascending `indices` below `n`: how many come before each of `0 … n`. */
function before(indices: Uint32Array, n: number): Uint32Array {
  const out = new Uint32Array(n + 1)
  let k = 0
  for (let i = 0; i < n; i++) {
    out[i] = k
    while (k < indices.length && indices[k] === i) k++
  }
  out[n] = k
  return out
}

/** The sums of one output row of a level, and the colours they add. */
interface RowSums {
  rg: Float64Array
  bl: Float64Array
  counted: Uint32Array
  clear: Uint32Array
  redGreen: Float64Array
  blue: Uint8Array
  missingOpaque: boolean
  missingRedGreen: number
  missingBlue: number
}

/**
 * Add the listed cells of input rows `[y0, y1)` to one output row's sums, from
 * position `k` of the list, and return the position after them. A function of
 * its own, out of `paintAverages`, because it is the whole of a sparse level's
 * cost and is compiled best alone.
 */
function sumListed(
  cells: Uint32Array,
  patterns: Uint32Array,
  k: number,
  y0: number,
  y1: number,
  ncols: number,
  level: number,
  start: Uint8Array,
  steps: Uint32Array,
  sums: RowSums,
  slow: (i: number) => number,
): number {
  const { rg, bl, counted, clear, redGreen, blue, missingOpaque, missingRedGreen, missingBlue } = sums
  const last = COLORMAP_SIZE - 1
  const end = y1 * ncols
  let rowStart = y0 * ncols
  const n = cells.length
  for (; k < n; k++) {
    const i = cells[k]
    if (i >= end) break
    while (i >= rowStart + ncols) rowStart += ncols
    const ox = (i - rowStart) >> level
    counted[ox]++
    const p = patterns[k]
    let index: number
    if (p <= INFINITY_BITS) {
      index = start[p >>> BIN_SHIFT]
      while (index < last && p >= steps[index + 1]) index++
    } else {
      index = slow(i)
    }
    if (index !== NO_COLOUR) {
      rg[ox] += redGreen[index]
      bl[ox] += blue[index]
    } else if (missingOpaque) {
      rg[ox] += missingRedGreen
      bl[ox] += missingBlue
    } else {
      clear[ox]++
    }
  }
  return k
}
