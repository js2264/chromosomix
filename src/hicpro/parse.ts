/**
 * Reading a HiC-Pro contact map, which is two text files and no index.
 *
 * The format is documented in HiC-Pro's own `RESULTS.md` and is as small as a
 * contact map format gets:
 *
 * - **`<prefix>_<res>_abs.bed`** — `chrom  start  end  binID`, one row per bin
 *   of the whole genome, where `binID` is **1-based and global**: it runs
 *   continuously across chromosomes rather than restarting at each.
 * - **`<prefix>_<res>.matrix`** — `binA  binB  count`, one row per non-zero
 *   pixel, referring to those ids. `MATRIX_FORMAT` decides whether the stored
 *   half is `upper` (the default), `lower`, `complete`, or `asis`.
 *
 * The BED *is* a `/bins` table, and run-length encoding its first column gives
 * the `/chroms` table and `indexes/chrom_offset` that everything above the
 * reader is written against. The matrix *is* `/pixels`. What the format does
 * not have is `indexes/bin1_offset` — and that absence is the whole of what
 * makes this container different, so it is worth being exact about it.
 *
 * ## Why the whole file is read, and why that is the end of the cost
 *
 * There is no index, and there is no index that could be *derived* without
 * reading everything: the rows are text of variable width, so byte offset and
 * bin id have no relation, and the rows need not even be sorted (`asis` says so
 * outright). So a region cannot be a bounded read the way a cooler's or a
 * `.hic`'s is, and pretending otherwise would mean scanning the file per view
 * instead of once.
 *
 * The answer is to pay it once, at open, and hand the rest of the application
 * exactly what it already knows how to use: sorted triplets and a CSR index. A
 * counting sort by `bin1` gives both in one pass, and after it every read is
 * bounded, in memory, and instant — pan and zoom cost nothing at all. Measured
 * at **6.8 M pixels/s (≈100 MB/s)** parsing, and **~300 ms per 10 M pixels** to
 * build the index; a pixel occupies 12 bytes here against about 15 as text.
 *
 * ## Why it is parsed byte by byte
 *
 * `split('\n')` on a gigabyte allocates a string per line and a string per
 * field, three of them, all garbage. The scan below never makes a string at
 * all: it walks the bytes accumulating digits, which is where the throughput
 * above comes from and why a 1 GB file is a wait rather than a crash.
 */

import { ViewerError } from '../errors'
import type { StorageMode } from '../constants'

/** Byte values the scanners compare against, named so the loops read. */
const TAB = 9
const NEWLINE = 10
const RETURN = 13
const HASH = 35
const MINUS = 45
const DOT = 46
const ZERO = 48
const NINE = 57

/** The `/bins` half of the pair, as the reader's coordinate model wants it. */
export interface HicProBins {
  /** Sequence names, in the order the file lists them. */
  names: string[]
  /** Sequence lengths in bp — the last bin's `end`, which is the sequence end. */
  lengths: Float64Array
  /** `indexes/chrom_offset`: first bin of each sequence, plus a terminator. */
  chromOffset: Float64Array
  /** Bins in the file, which is `chromOffset`'s last entry. */
  nBins: number
  /**
   * The bin size in bp, or `null` where the rows are not a fixed grid.
   *
   * Taken from the **widest** interval rather than the first: every sequence's
   * last bin is short wherever its length is not a multiple of the resolution,
   * and on a genome whose first sequence is shorter than one bin the first row
   * *is* that short bin. The mode of the widths would be the same answer at
   * more cost; the maximum is exact for a fixed grid and is what makes a
   * variable one detectable, since there every width disagrees with it.
   */
  binsize: number | null
  /**
   * `true` when every interval is the bin size except the last of a sequence.
   *
   * §3.3 excludes variable-bin files from the whole application, and a
   * fragment-level HiC-Pro map — which is what `GENOME_FRAGMENT` produces — is
   * exactly one. Detected here because this is the only place the intervals are
   * read, and refused by the caller with the file's own numbers.
   */
  fixed: boolean
}

/** The `/pixels` half, sorted and indexed. */
export interface HicProPixels {
  /** Row bin of each stored pixel, 0-based, ascending. */
  bin1: Int32Array
  /** Column bin, 0-based. Upper-triangular against `bin1` after normalisation. */
  bin2: Int32Array
  /** The value column. Float32 because `iced/` matrices are not integers. */
  count: Float32Array
  /** `indexes/bin1_offset`: one cumulative entry per bin, plus a terminator. */
  binOffset: Float64Array
  /** Stored pixels, after any collapsing the normalisation did. */
  nnz: number
  /** Sum of every value, which the info panel reports as a cooler's does. */
  sum: number
  /**
   * What the file turned out to hold, before this reader normalised it.
   *
   * Reported rather than acted on: everything downstream is handed
   * `symmetric-upper` whatever came in, because the normalisation below swaps
   * the ends of any pixel stored the other way round. It is on the info panel
   * so a reader can see that a `lower` or `complete` file was understood as one.
   */
  observed: 'upper' | 'lower' | 'mixed' | 'complete'
}

// ---------------------------------------------------------------------------
// The bins
// ---------------------------------------------------------------------------

/**
 * Parse `<prefix>_<res>_abs.bed` into a coordinate system.
 *
 * The fourth column is deliberately **not** read. It is the bin id, it is
 * 1-based, and it is by construction the row number — so trusting the row
 * number costs nothing and trusting the column would mean deciding what to do
 * about a file whose ids skip, restart or disagree with their order. The one
 * thing worth checking is that the two agree, and {@link parseBins} does that
 * on the first and last rows, where a disagreement means the file is not what
 * it says it is rather than that one row is odd.
 */
export function parseBins(bytes: Uint8Array, label: string): HicProBins {
  const names: string[] = []
  const lengths: number[] = []
  const offsets: number[] = [0]
  let widest = 0
  let rows = 0
  let firstId: number | null = null
  let lastId = 0
  let sawAnyId = false

  const decoder = new TextDecoder()
  const n = bytes.length
  let at = 0
  while (at < n) {
    // Skip blank lines and the comment/track headers a BED may carry.
    if (bytes[at] === NEWLINE || bytes[at] === RETURN) {
      at++
      continue
    }
    if (bytes[at] === HASH || isTrackLine(bytes, at)) {
      while (at < n && bytes[at] !== NEWLINE) at++
      continue
    }
    // chrom
    const nameFrom = at
    while (at < n && bytes[at] !== TAB && bytes[at] !== NEWLINE) at++
    const name = decoder.decode(bytes.subarray(nameFrom, at))
    if (at < n && bytes[at] === NEWLINE) {
      throw badBed(label, rows + 1, 'a row with one column')
    }
    at++
    const start = readInt(bytes, at)
    at = start.at
    if (bytes[at] !== TAB) throw badBed(label, rows + 1, 'a row with two columns')
    at++
    const end = readInt(bytes, at)
    at = end.at
    // The fourth column is optional here for the reason above: a plain BED3 of
    // the same grid is the same coordinate system, and a reader who has one
    // should not be turned away over a column this never reads.
    let id: number | null = null
    if (bytes[at] === TAB) {
      at++
      const fourth = readInt(bytes, at)
      at = fourth.at
      // Present but not a number is the signal that separates a bin file from
      // an ordinary BED, whose fourth column is a feature *name*. Both are
      // valid BED4; only one is a coordinate system, and the difference is
      // visible here and nowhere else.
      if (!fourth.saw) {
        throw new ViewerError(
          'format',
          `${label} is a BED whose fourth column holds names rather than bin ids, so it ` +
            'describes features rather than a bin grid — drop it as a track instead. A ' +
            "HiC-Pro bin file numbers its bins 1…n, and is written as `<prefix>_<res>_abs.bed`.",
          { label, row: rows + 1 },
        )
      }
      id = fourth.value
    }
    while (at < n && bytes[at] !== NEWLINE) at++
    at++

    const width = end.value - start.value
    if (width <= 0) throw badBed(label, rows + 1, `an interval of width ${width}`)
    if (width > widest) widest = width
    rows++
    if (id !== null) {
      if (!sawAnyId) firstId = id
      sawAnyId = true
      lastId = id
    }

    // A new sequence starts wherever the name changes. The file is in bin
    // order by construction — that is what makes the ids global — so a name
    // that comes back later is a file this cannot read as a coordinate system,
    // and it is caught below rather than silently producing two runs.
    if (names.length === 0 || names[names.length - 1] !== name) {
      if (names.includes(name)) {
        throw badBed(label, rows, `${JSON.stringify(name)} in two separate runs of rows`)
      }
      names.push(name)
      lengths.push(end.value)
      offsets.push(rows - 1)
    } else {
      lengths[lengths.length - 1] = end.value
    }
  }

  if (rows === 0) throw badBed(label, 0, 'no rows at all')
  // `offsets` collected each run's *start*; the array the reader wants is those
  // starts plus a terminator at the total.
  const chromOffset = Float64Array.from([...offsets.slice(1), rows])
  if (chromOffset.length !== names.length + 1) {
    throw badBed(label, rows, `${names.length} sequences but ${chromOffset.length} offsets`)
  }

  // Every interval is the grid width except a sequence's last, which is short
  // wherever the sequence does not divide by it. Anything else is variable bins.
  const fixed = isFixedGrid(names.length, chromOffset, lengths, widest)

  // `null` is a BED3, which carries no ids to disagree with the row order.
  if (firstId !== null && (firstId !== 1 || lastId !== rows)) {
    throw new ViewerError(
      'format',
      `${label} is not a HiC-Pro bin file: its bin ids run ${firstId}…${lastId} over ${rows} ` +
        `rows, and HiC-Pro numbers them 1…n in row order. If this is an ordinary BED, it ` +
        `describes features rather than a bin grid — drop it as a track instead.`,
      { label, firstId, lastId, rows },
    )
  }

  return {
    names,
    lengths: Float64Array.from(lengths),
    chromOffset,
    nBins: rows,
    binsize: fixed ? widest : null,
    fixed,
  }
}

/** Whether every sequence's bins are the grid width, bar a short last one. */
function isFixedGrid(
  nSeq: number,
  chromOffset: Float64Array,
  lengths: readonly number[],
  width: number,
): boolean {
  if (width <= 0) return false
  for (let i = 0; i < nSeq; i++) {
    const bins = chromOffset[i + 1] - chromOffset[i]
    // A sequence of `bins` bins at this width covers `(bins - 1) * width` fully
    // and ends inside the last one, so its length must land in that final bin.
    const floor = (bins - 1) * width
    if (lengths[i] <= floor || lengths[i] > bins * width) return false
  }
  return true
}

function isTrackLine(bytes: Uint8Array, at: number): boolean {
  const word = 'track'
  if (at + word.length > bytes.length) return false
  for (let i = 0; i < word.length; i++) {
    if (bytes[at + i] !== word.charCodeAt(i)) return false
  }
  return true
}

function badBed(label: string, row: number, what: string): ViewerError {
  return new ViewerError(
    'format',
    `${label} is not a HiC-Pro bin file: ${what}${row > 0 ? ` at row ${row}` : ''}. ` +
      'The file beside a `.matrix` is `chrom  start  end  binID`, one row per bin of the ' +
      'whole genome, and HiC-Pro writes it as `<prefix>_<res>_abs.bed`.',
    { label, row },
  )
}

// ---------------------------------------------------------------------------
// The pixels
// ---------------------------------------------------------------------------

/** Progress, since this is the one read in the application worth reporting. */
export interface ParseProgress {
  onProgress?(done: number, total: number): void
  cancelled?(): boolean
}

/**
 * Parse `<prefix>_<res>.matrix` into sorted triplets and a CSR index.
 *
 * Three passes, and each is there for a reason worth stating:
 *
 * 1. **count the rows**, so the arrays are allocated exactly once at the right
 *    size. Growing them instead means repeated reallocation and copying of
 *    hundreds of megabytes, which costs more than this pass does;
 * 2. **read the values**, normalising 1-based ids to 0-based and swapping the
 *    ends of any pixel stored below the diagonal, so what comes out is
 *    upper-triangular whatever `MATRIX_FORMAT` the file was written with;
 * 3. **counting-sort by `bin1`**, which produces the sorted order and the
 *    cumulative `bin1_offset` together, because the offsets *are* the sort's
 *    bucket boundaries.
 *
 * A `complete` matrix stores both triangles, so normalising it would fold each
 * pixel onto its mirror and double every off-diagonal cell. That case is
 * detected — a file holding both `(a, b)` and `(b, a)` — and the lower half is
 * dropped rather than added, which is what makes the counts right.
 */
export function parseMatrix(
  bytes: Uint8Array,
  nBins: number,
  label: string,
  hooks: ParseProgress = {},
): HicProPixels {
  const n = bytes.length
  let rows = 0
  for (let i = 0; i < n; i++) if (bytes[i] === NEWLINE) rows++
  // A file whose last line has no terminator still holds that pixel.
  if (n > 0 && bytes[n - 1] !== NEWLINE) rows++
  if (rows === 0) {
    throw new ViewerError(
      'format',
      `${label} holds no pixels. A HiC-Pro matrix is \`binA  binB  count\`, one row per ` +
        'non-zero pixel.',
      { label },
    )
  }

  const bin1 = new Int32Array(rows)
  const bin2 = new Int32Array(rows)
  const count = new Float32Array(rows)
  // Which side of the diagonal each row was *stored* on, before the swap below
  // put it on the upper one. It is the only thing that separates a `complete`
  // file's mirror from a genuine repeat once both are upper-triangular, and
  // those two want opposite treatment — see {@link collapse}.
  const swapped = new Uint8Array(rows)
  let out = 0
  let sum = 0
  let sawUpper = false
  let sawLower = false
  let at = 0
  let line = 0
  const report = Math.max(1, Math.floor(rows / 100))

  while (at < n) {
    if (bytes[at] === NEWLINE || bytes[at] === RETURN) {
      at++
      continue
    }
    if (bytes[at] === HASH) {
      while (at < n && bytes[at] !== NEWLINE) at++
      continue
    }
    line++
    const a = readInt(bytes, at)
    at = a.at
    if (!a.saw || bytes[at] !== TAB) throw badMatrix(label, line, nBins)
    at++
    const b = readInt(bytes, at)
    at = b.at
    if (!b.saw || bytes[at] !== TAB) throw badMatrix(label, line, nBins)
    at++
    const v = readFloat(bytes, at)
    at = v.at
    if (!v.saw) throw badMatrix(label, line, nBins)
    while (at < n && bytes[at] !== NEWLINE) at++
    at++

    // 1-based to 0-based. A `0` in either column means the file is already
    // 0-based, which HiC-Pro does not write but a hand-made one might; it is
    // caught by the bounds check rather than silently shifting every pixel.
    const i = a.value - 1
    const j = b.value - 1
    if (i < 0 || j < 0 || i >= nBins || j >= nBins) {
      throw new ViewerError(
        'format',
        `${label} names bin ${a.value} × ${b.value} on line ${line}, and the bin file has ` +
          `${nBins} bins numbered 1…${nBins}. The two halves of the pair are for different ` +
          'resolutions, or for different genomes.',
        { label, line, bin1: a.value, bin2: b.value, nBins },
      )
    }
    if (i <= j) sawUpper = true
    if (i >= j) sawLower = true
    // Stored upper whichever way it arrived; `complete` is folded below.
    bin1[out] = i <= j ? i : j
    bin2[out] = i <= j ? j : i
    count[out] = v.value
    swapped[out] = i <= j ? 0 : 1
    out++

    if (out % report === 0) {
      if (hooks.cancelled?.() === true) throw cancelled()
      hooks.onProgress?.(out, rows)
    }
  }

  const observed: HicProPixels['observed'] =
    sawUpper && sawLower ? 'mixed' : sawUpper ? 'upper' : 'lower'

  // Two stable counting sorts — by `bin2`, then by `bin1` — which together put
  // the pixels in the (row, column) order a cooler stores them in, and leave
  // the second pass's bucket boundaries as `bin1_offset` exactly.
  //
  // A radix sort rather than a sort per row band, and the difference is not
  // academic. Sorting each band on its own is quadratic in the band's width,
  // and bands are *wide*: a row of a 100 kb human matrix has thousands of
  // non-zero columns. Measured on a 211 MB file with wide bands, the per-band
  // insertion sort took 59 s where this takes about two — the parse itself runs
  // at 100 MB/s and the sort must not be what decides the wait.
  const byColumn = countingSort(bin2, out, nBins)
  const { order, offsets: binOffset } = countingSortBy(bin1, byColumn, out, nBins)

  const sorted1 = new Int32Array(out)
  const sorted2 = new Int32Array(out)
  const sortedV = new Float32Array(out)
  const sortedSide = new Uint8Array(out)
  for (let k = 0; k < out; k++) {
    const from = order[k]
    sorted1[k] = bin1[from]
    sorted2[k] = bin2[from]
    sortedV[k] = count[from]
    sortedSide[k] = swapped[from]
  }

  const folded = collapse(sorted1, sorted2, sortedV, sortedSide, binOffset, nBins)
  for (let k = 0; k < folded.nnz; k++) sum += sortedV[k]

  return {
    bin1: sorted1.subarray(0, folded.nnz),
    bin2: sorted2.subarray(0, folded.nnz),
    count: sortedV.subarray(0, folded.nnz),
    binOffset: folded.binOffset,
    nnz: folded.nnz,
    sum,
    observed: observed === 'mixed' && folded.mirrored > 0 ? 'complete' : observed,
  }
}

/**
 * Collapse pixels that landed on the same cell, in place.
 *
 * One row band at a time, sorting each by column — the bands are short (a row
 * of a contact map) so an insertion sort over each beats one comparison sort
 * over the whole array, and the CSR order is preserved by construction.
 *
 * ## Mirrors are dropped; repeats are summed
 *
 * Two rows can land on one cell, and they mean opposite things:
 *
 * - a **mirror**, which is what `MATRIX_FORMAT=complete` writes: `(a, b)` and
 *   `(b, a)` are one contact stated twice, so **adding** them would double
 *   every off-diagonal cell of the map and leave the diagonal alone — a picture
 *   that still looks entirely like a contact map;
 * - a **repeat**, two rows for the same pair on the same side, which is what a
 *   file concatenated from two runs holds. Here the second is more evidence,
 *   and **dropping** it silently loses contacts.
 *
 * Once both have been swapped onto the upper triangle they are indistinguishable
 * — which is why the side each row was *stored* on is carried this far. It is
 * the only place the difference is still visible, and it is one byte per pixel
 * to keep it.
 */
function collapse(
  bin1: Int32Array,
  bin2: Int32Array,
  count: Float32Array,
  side: Uint8Array,
  binOffset: Float64Array,
  nBins: number,
): { nnz: number; binOffset: Float64Array; mirrored: number } {
  let write = 0
  let mirrored = 0
  const out = new Float64Array(nBins + 1)
  for (let row = 0; row < nBins; row++) {
    const lo = binOffset[row]
    const hi = binOffset[row + 1]
    out[row] = write
    // The band is already in column order, so equal cells are adjacent and one
    // linear pass settles them.
    let seenSide = -1
    for (let i = lo; i < hi; i++) {
      if (i > lo && bin2[i] === bin2[i - 1]) {
        if (side[i] !== seenSide) {
          // The mirror of one already written: one contact, stated twice.
          mirrored++
          seenSide = -2
          continue
        }
        // The same pair on the same side again: more of the same contact.
        count[write - 1] += count[i]
        continue
      }
      seenSide = side[i]
      bin1[write] = row
      bin2[write] = bin2[i]
      count[write] = count[i]
      write++
    }
  }
  out[nBins] = write
  return { nnz: write, binOffset: out, mirrored }
}

/**
 * A stable counting sort of `0…n` by `key`, returning the new order.
 *
 * `key` values are bin ids, so they are bounded by the bin count and a counting
 * sort is exact and linear — no comparisons, and no allocation beyond the
 * buckets and the order itself.
 */
function countingSort(key: Int32Array, n: number, buckets: number): Int32Array {
  const counts = new Int32Array(buckets + 1)
  for (let i = 0; i < n; i++) counts[key[i] + 1]++
  for (let b = 0; b < buckets; b++) counts[b + 1] += counts[b]
  const order = new Int32Array(n)
  for (let i = 0; i < n; i++) order[counts[key[i]]++] = i
  return order
}

/**
 * The same sort applied to an existing order, keeping it as the tie-break.
 *
 * Stability is the whole point: run over an order already sorted by column, it
 * produces (row, column) order — and its bucket boundaries, handed back, *are*
 * the cumulative `bin1_offset` a cooler stores.
 */
function countingSortBy(
  key: Int32Array,
  order: Int32Array,
  n: number,
  buckets: number,
): { order: Int32Array; offsets: Float64Array } {
  const offsets = new Float64Array(buckets + 1)
  for (let i = 0; i < n; i++) offsets[key[i] + 1]++
  for (let b = 0; b < buckets; b++) offsets[b + 1] += offsets[b]
  const cursor = Float64Array.from(offsets)
  const out = new Int32Array(n)
  for (let i = 0; i < n; i++) {
    const at = order[i]
    out[cursor[key[at]]++] = at
  }
  return { order: out, offsets }
}

/** The storage mode the rest of the reader is told about — always this one. */
export const HICPRO_STORAGE_MODE: StorageMode = 'symmetric-upper'

// ---------------------------------------------------------------------------
// Scanners
// ---------------------------------------------------------------------------

function readInt(bytes: Uint8Array, at: number): { value: number; at: number; saw: boolean } {
  let value = 0
  let saw = false
  let sign = 1
  if (bytes[at] === MINUS) {
    sign = -1
    at++
  }
  while (at < bytes.length) {
    const c = bytes[at]
    if (c < ZERO || c > NINE) break
    value = value * 10 + (c - ZERO)
    saw = true
    at++
  }
  return { value: value * sign, at, saw }
}

/** The value column, which is an integer in `raw/` and a float in `iced/`. */
function readFloat(bytes: Uint8Array, at: number): { value: number; at: number; saw: boolean } {
  const whole = readInt(bytes, at)
  at = whole.at
  let value = whole.value
  let saw = whole.saw
  if (bytes[at] === DOT) {
    at++
    let scale = 0.1
    while (at < bytes.length) {
      const c = bytes[at]
      if (c < ZERO || c > NINE) break
      value += (c - ZERO) * scale * (whole.value < 0 ? -1 : 1)
      scale /= 10
      saw = true
      at++
    }
  }
  // An exponent, which `iced/` writes for very small biases-scaled values.
  if (at < bytes.length && (bytes[at] === 101 || bytes[at] === 69)) {
    at++
    const exp = readInt(bytes, at)
    if (exp.saw) {
      at = exp.at
      value *= 10 ** exp.value
    }
  }
  return { value, at, saw }
}

function badMatrix(label: string, line: number, nBins: number): ViewerError {
  return new ViewerError(
    'format',
    `${label} is not a HiC-Pro matrix: line ${line} is not \`binA  binB  count\`. ` +
      `The bin file beside it has ${nBins} bins, and the matrix names pairs of them, ` +
      'tab-separated, one pixel per line.',
    { label, line, nBins },
  )
}

function cancelled(): Error {
  const err = new Error('cancelled')
  err.name = 'AbortError'
  return err
}
