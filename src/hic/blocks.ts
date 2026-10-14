/**
 * The block layer: which blocks a window touches, and what is inside one.
 *
 * A `.hic` is not a sorted pixel table. It is one matrix per chromosome pair,
 * per resolution, cut into square blocks of `blockBinCount` bins a side, and
 * the index gives a byte offset per block. That is a **2-D index**, where a
 * cooler's `indexes/bin1_offset` is a 1-D one — which is why a rectangular read
 * off this format is, if anything, tighter than the same read off a cooler: a
 * cooler must fetch a whole row band and discard the columns outside the
 * window, and this can ask for the rectangle.
 *
 * None of that changes the promise in §2. A block is not a tile: nothing here
 * assembles a picture out of parts, nothing is cached to be composited, and the
 * result of a read is one whole bounded matrix handed up in COO exactly as
 * `metacooler/matrix.ts` hands one up. The blocks are how the *file* is indexed,
 * not how the picture is built.
 *
 * ## The two block-numbering schemes
 *
 * Versions 7 and 8 number blocks in a plain row-major grid. Version 9 numbers
 * *intra*-chromosomal blocks along the diagonal instead — position along the
 * diagonal, and depth away from it — because a Hi-C matrix is dense near the
 * diagonal and empty far from it, and a square grid spends most of its index on
 * blocks that hold nothing. Both are implemented, and the choice is made by
 * version and by whether the pair is intra, never by guessing.
 *
 * Over-generating candidates is safe and deliberate: a block number the index
 * does not hold is skipped, so the arithmetic may be generous at the edges
 * without reading a byte it should not. Under-generating is not safe, and is
 * invisible — it produces a picture with rectangular holes in it — which is why
 * the depth range below is widened by one at both ends exactly as the reference
 * implementation widens it.
 *
 * ## What a block may claim
 *
 * Every count here is the file's own, and is checked before it sizes anything
 * (`sources/untrusted.ts`, §10): a record's resolutions and blocks against the
 * bytes the record has, a block's records against the bytes it inflated to,
 * at the fewest bytes its encoding spends on one, and the inflate itself
 * against a cap proportional to what went in ({@link HIC_BLOCK_INFLATION}). A
 * sixteen-byte block that declares fifty million records is refused as that,
 * where it used to allocate 572 MiB to find out.
 */

import { ViewerError } from '../errors'
import { declaredCount, type InflationPolicy } from '../sources/untrusted'
import { Cursor, HIC, Truncated, type MasterIndexEntry } from './format'

/**
 * How far one block may inflate: 64 times its compressed size, never under
 * 16 MiB nor over 1 GiB (`sources/untrusted.ts`'s {@link InflationPolicy}).
 *
 * The ratio is set from the reference reader. `straw`, the C++ reader
 * `hicstraw` is built on, inflates a block into a buffer ten times its
 * compressed length and records that three is the most it has seen — so a
 * file whose blocks went past ten would read wrong there, and sixty-four
 * leaves room six times over. The floor is a dense block of two thousand bins
 * a side in floats, which a block of uniform counts could reach at any ratio;
 * the ceiling is twice what {@link HIC_BLOCK_MAX_RECORDS} records take at
 * eight bytes a record, and some five times the fullest block that argument
 * finds a writer could emit.
 */
export const HIC_BLOCK_INFLATION: InflationPolicy = {
  ratio: 64,
  floor: 16 << 20,
  ceiling: 1 << 30,
}

/**
 * The most records one block holds in any real file: 2^26, sixty-seven million.
 *
 * A block is a square cut of one matrix, and Juicer (and `hictk`, which copies
 * its arithmetic) sizes the square: about a thousand bins a side above a cutoff
 * of 500 bp within a chromosome and 5 kb between two, and below it a fixed
 * 500 kb or 5 Mb of genome whatever the rung. So a mammalian block holds a
 * million records or so at any resolution — the contacts of one 500 kb stretch
 * of the diagonal, even on a library of four billion. Tens of millions are
 * reachable only where a small genome is sequenced to saturation at a rung of
 * 100 bp or finer: yeast's 500 kb diagonal block at 50 bp is 10^8 cells, and a
 * billion-contact library puts some twenty-five million contacts in it. 2^26 is
 * more than twice that, and is 768 MiB of typed arrays already.
 */
export const HIC_BLOCK_MAX_RECORDS = 2 ** 26

/** The fewest bytes a resolution's header takes in a matrix record: an empty unit, nine words. */
const ZOOM_HEADER_MIN_BYTES = 1 + 9 * 4

/** Bytes per block in a resolution's block list: a number, an offset, a size. */
const BLOCK_ENTRY_BYTES = 4 + 8 + 4

/** An `int32` field's own bound, for a count the format limits by nothing tighter than its bytes. */
const INT32_MAX = 2 ** 31 - 1

/** Where one block lives, and how big it is. */
export interface BlockRef {
  number: number
  position: number
  size: number
}

/** One resolution of one chromosome pair. */
export interface ZoomData {
  unit: string
  binSize: number
  blockBinCount: number
  blockColumnCount: number
  /** Keyed by block number, because the lookup is always by computed number. */
  blocks: Map<number, BlockRef>
  /** The file's own total for this matrix, used for `sum` and for progress. */
  sumCounts: number
}

/**
 * Bytes of a matrix record read first, in the hope that the resolution asked
 * for is inside them — see {@link readZoom}.
 *
 * A zoom's header is 39 bytes and each of its blocks another 16, so this holds
 * every coarse rung of a mammalian file with room to spare: on a 4DN mouse map
 * the eight rungs from 10 Mb down to 50 kb take under 700 bytes of chr1 × chr1's
 * record. A finer rung is further in than any head worth reading, and costs the
 * whole record whatever this is.
 */
export const RECORD_HEAD_BYTES = 4 << 10

/**
 * One resolution of one chromosome pair, out of the leading bytes of its matrix
 * record — or `null` when the pair has no matrix at that resolution.
 *
 * A record is the block index of **every** resolution the pair was written at,
 * one after another, and only the one asked for is decoded: the others are
 * skipped by their block count, 16 bytes a block, without a map being built for
 * blocks nobody will read.
 *
 * `bytes` may stop short of the record's end, and that is the point of taking
 * them rather than an entry: a header or a block list that runs past the last
 * byte throws {@link Truncated} — a `RangeError`, as the `DataView` beneath
 * would — which is what tells {@link readZoom} that the answer is further in.
 * No wrong answer can come out of a short read instead — a unit string cut off
 * mid-name is followed by a field read past the end, and a resolution is only
 * reported absent once every header in the record has been read.
 *
 * `recordSize` is the whole record's length, where the caller knows it, and is
 * what the record's counts are checked against: a block count the *record*
 * cannot hold is refused, where one the head in hand cannot is only a reason to
 * read further. A block count read negative used to step the cursor backwards,
 * over headers already read, for as long as the resolution count said to.
 */
export function findZoom(
  bytes: Uint8Array,
  unit: string,
  binSize: number,
  recordSize?: number,
): ZoomData | null {
  const cursor = new Cursor(bytes)
  const left = (): number | undefined =>
    recordSize === undefined ? undefined : recordSize - cursor.position
  cursor.int32() // chr1, which the master-index key already says
  cursor.int32() // chr2
  // The header's own ceiling on rungs: a record lists each once at most.
  const nResolutions = declaredCount(cursor.int32(), {
    format: HIC,
    field: 'resolution count of a matrix record',
    ceiling: 1e4,
    available: left(),
    bytesPerItem: ZOOM_HEADER_MIN_BYTES,
  })
  for (let i = 0; i < nResolutions; i++) {
    const zoomUnit = cursor.string()
    cursor.int32() // zoom index, which is the position in this list
    const sumCounts = cursor.float32()
    // Three reserved statistics — occupied cells, standard deviation, 95th
    // percentile. Twelve bytes, never populated by Juicer, never read here, and
    // skipped by width rather than by name so a file that does populate them
    // still lands the cursor in the right place.
    cursor.float32()
    cursor.float32()
    cursor.float32()
    const zoomBinSize = cursor.int32()
    const blockBinCount = cursor.int32()
    const blockColumnCount = cursor.int32()
    // Bounded by the bytes behind it and nothing tighter: Juicer caps a grid at
    // 46,339 columns, whose square is the whole `int32` range.
    const blockCount = declaredCount(cursor.int32(), {
      format: HIC,
      field: 'block count of a matrix record',
      ceiling: INT32_MAX,
      available: left(),
      bytesPerItem: BLOCK_ENTRY_BYTES,
    })
    if (zoomUnit !== unit || zoomBinSize !== binSize) {
      cursor.skip(blockCount * BLOCK_ENTRY_BYTES)
      continue
    }
    // Both are divisors in the block arithmetic. Nought makes every window
    // touch an infinite run of blocks, and a loop over them never ends.
    if (!(blockBinCount >= 1) || !(blockColumnCount >= 1)) {
      throw new ViewerError(
        'format',
        `This .hic's ${zoomBinSize} bp matrix declares blocks of ${blockBinCount} bins in ` +
          `${blockColumnCount} columns, which no block grid has. The file is truncated, corrupt, ` +
          'or not the format its first bytes claim.',
        { binSize: zoomBinSize, blockBinCount, blockColumnCount },
      )
    }
    const blocks = new Map<number, BlockRef>()
    for (let b = 0; b < blockCount; b++) {
      const number = cursor.int32()
      const position = cursor.int64()
      const size = cursor.int32()
      blocks.set(number, { number, position, size })
    }
    return { unit: zoomUnit, binSize: zoomBinSize, blockBinCount, blockColumnCount, blocks, sumCounts }
  }
  return null
}

/**
 * One resolution of one master-index entry, reading the record only as far as it.
 *
 * Reading a whole record to use one resolution of it is the cost this exists to
 * avoid, and on a large file it is most of what a whole-genome read costs: a
 * 4DN map written at thirteen resolutions holds 70 MB of block index across its
 * 231 chromosome pairs — 725 KB for chr1 × chr2 alone — where the coarsest rung
 * needs the first 67 bytes of each. Juicer writes a pair's resolutions in the
 * header's order, which is coarsest first, so the rungs a whole-genome read is
 * made at are the ones at the front.
 *
 * So `head` bytes are read first and the rest only when the resolution lies
 * past them; a `head` of zero, or one past the record's end, reads the record
 * whole in one go. `beyondHead` reports the first case, so the caller can stop
 * paying a head read that cannot succeed: every record lists its resolutions in
 * the same order, and a rung past the head of one is at the far end of all of
 * them.
 *
 * Only {@link Truncated} sends the read on to the whole record. Any other
 * error is the record's answer, and a whole record that still runs out is a
 * truncated one, refused as that.
 */
export function readZoom(
  read: (position: number, length: number) => Uint8Array,
  entry: MasterIndexEntry,
  unit: string,
  binSize: number,
  head: number,
): { zoom: ZoomData | null; beyondHead: boolean } {
  if (head > 0 && head < entry.size) {
    try {
      return { zoom: findZoom(read(entry.position, head), unit, binSize, entry.size), beyondHead: false }
    } catch (err) {
      if (!(err instanceof Truncated)) throw err
    }
    return { zoom: wholeRecord(read(entry.position, entry.size), entry, unit, binSize), beyondHead: true }
  }
  return { zoom: wholeRecord(read(entry.position, entry.size), entry, unit, binSize), beyondHead: false }
}

/** {@link readZoom}, for a read that answers later — the exact reads a walk makes. */
export async function readZoomAsync(
  read: (position: number, length: number) => Promise<Uint8Array>,
  entry: MasterIndexEntry,
  unit: string,
  binSize: number,
  head: number,
): Promise<{ zoom: ZoomData | null; beyondHead: boolean }> {
  if (head > 0 && head < entry.size) {
    try {
      return { zoom: findZoom(await read(entry.position, head), unit, binSize, entry.size), beyondHead: false }
    } catch (err) {
      if (!(err instanceof Truncated)) throw err
    }
    return { zoom: wholeRecord(await read(entry.position, entry.size), entry, unit, binSize), beyondHead: true }
  }
  return { zoom: wholeRecord(await read(entry.position, entry.size), entry, unit, binSize), beyondHead: false }
}

/** {@link findZoom} over a whole record, where running out of bytes is the record's fault. */
function wholeRecord(bytes: Uint8Array, entry: MasterIndexEntry, unit: string, binSize: number): ZoomData | null {
  try {
    return findZoom(bytes, unit, binSize, entry.size)
  } catch (err) {
    if (!(err instanceof Truncated)) throw err
    throw new ViewerError(
      'format',
      `The matrix record for ${entry.key} in this .hic ends inside its block index, ` +
        `${bytes.byteLength.toLocaleString('en-US')} bytes in. The file is truncated, or its ` +
        'master index does not point at its records.',
      { key: entry.key, position: entry.position, size: entry.size },
    )
  }
}

/**
 * The blocks in `refs` grouped into stretches that sit end to end in the file,
 * so each stretch is one read.
 *
 * Juicer writes a resolution's blocks in block-number order, one after another,
 * so the blocks a pair needs are mostly contiguous and a walk that read them one
 * request apiece would spend a round trip on each. A gap of up to `gap` bytes is
 * read through rather than split on — it costs less to carry than a second
 * request does — and a stretch stops growing at `cap`, so no one read holds
 * more than that in flight.
 */
export function blockRuns(
  refs: readonly BlockRef[],
  gap: number,
  cap: number,
): Array<{ position: number; length: number; refs: BlockRef[] }> {
  const sorted = [...refs].sort((p, q) => p.position - q.position)
  const runs: Array<{ position: number; length: number; refs: BlockRef[] }> = []
  for (const ref of sorted) {
    const last = runs[runs.length - 1]
    const end = ref.position + ref.size
    if (
      last !== undefined &&
      ref.position - (last.position + last.length) <= gap &&
      end - last.position <= cap
    ) {
      last.length = Math.max(last.length, end - last.position)
      last.refs.push(ref)
      continue
    }
    runs.push({ position: ref.position, length: ref.size, refs: [ref] })
  }
  return runs
}

/**
 * The blocks a bin rectangle can touch.
 *
 * `x` is the first chromosome's bin range and `y` the second's, both
 * chromosome-local and half-open, both already clamped by the caller.
 *
 * Both schemes name their candidates as rectangles of `(row, column)` — grid
 * rows and columns, or depths and positions along the diagonal — and number
 * them `row × blockColumnCount + column`. Enumerated, a rectangle costs its
 * area, and the area is set by the file: a block of one bin over a whole
 * chromosome names its square in candidates, which for a header claiming a
 * terabase chromosome is a loop that does not end. So where the rectangles
 * would name more candidates than both {@link ENUMERATION_LIMIT} and the
 * index's own block count, the index is filtered instead, which costs its size
 * — and its size is bounded by the bytes its record holds. A real file never
 * gets there: a window of a mammalian chromosome at its finest rung names a few
 * tens of thousands, and its enumeration and its order are as they always were.
 */
export function blockNumbersFor(
  zoom: ZoomData,
  version: number,
  intra: boolean,
  x: readonly [number, number],
  y: readonly [number, number],
): number[] {
  const rects = intra && version >= 9 ? diagonalRects(zoom, x, y) : gridRects(zoom, intra, x, y)
  let candidates = 0
  for (const rect of rects) {
    candidates += Math.max(0, rect.r2 - rect.r1 + 1) * Math.max(0, rect.c2 - rect.c1 + 1)
  }
  if (candidates > Math.max(ENUMERATION_LIMIT, zoom.blocks.size)) return indexedIn(zoom, rects)
  const out = new Set<number>()
  for (const { r1, r2, c1, c2 } of rects) {
    for (let r = r1; r <= r2; r++) {
      for (let c = c1; c <= c2; c++) out.add(r * zoom.blockColumnCount + c)
    }
  }
  return [...out]
}

/**
 * Candidates past which {@link blockNumbersFor} filters the index rather than
 * naming them: a million, a hundred milliseconds of `Set` at the most, and
 * thirty times the blocks the widest real window names.
 */
const ENUMERATION_LIMIT = 1 << 20

/** Rows `r1..r2` by columns `c1..c2`, inclusive, of a block numbering. */
interface Rect {
  r1: number
  r2: number
  c1: number
  c2: number
}

/** Versions 7 and 8, and every inter-chromosomal matrix at any version. */
function gridRects(
  zoom: ZoomData,
  intra: boolean,
  x: readonly [number, number],
  y: readonly [number, number],
): Rect[] {
  const { blockBinCount } = zoom
  const col1 = Math.floor(x[0] / blockBinCount)
  const col2 = Math.floor(Math.max(x[0], x[1] - 1) / blockBinCount)
  const row1 = Math.floor(y[0] / blockBinCount)
  const row2 = Math.floor(Math.max(y[0], y[1] - 1) / blockBinCount)
  const rects: Rect[] = [{ r1: row1, r2: row2, c1: col1, c2: col2 }]
  // The stored matrix is upper-triangular within a chromosome, so the block
  // holding a cell may be the transposed one. Adding both and letting the
  // index drop the absent half is cheaper than deciding which, and is what
  // makes a window that straddles the diagonal come back whole.
  if (intra) rects.push({ r1: col1, r2: col2, c1: row1, c2: row2 })
  return rects
}

/**
 * Version 9's intra-chromosomal scheme: position along the diagonal, and depth.
 *
 * Depth is logarithmic — block rows get taller as they get further from the
 * diagonal — which is why the two ends are computed with `log2` rather than by
 * division, and why the range is widened by one: the transform is not linear,
 * so a rectangle's corners do not bound its depth range the way they bound a
 * grid's row range.
 */
function diagonalRects(
  zoom: ZoomData,
  x: readonly [number, number],
  y: readonly [number, number],
): Rect[] {
  const { blockBinCount } = zoom
  const [x1, x2] = [x[0], Math.max(x[0], x[1] - 1)]
  const [y1, y2] = [y[0], Math.max(y[0], y[1] - 1)]

  const lowerPad = Math.floor((x1 + y1) / 2 / blockBinCount)
  const higherPad = Math.floor((x2 + y2) / 2 / blockBinCount) + 1
  const nearerDepthRaw = Math.floor(
    Math.log2(1 + Math.abs(x1 - y2) / Math.SQRT2 / blockBinCount),
  )
  const furtherDepthRaw = Math.floor(
    Math.log2(1 + Math.abs(x2 - y1) / Math.SQRT2 / blockBinCount),
  )
  // A window that straddles the diagonal reaches depth zero whatever its
  // corners say, because the diagonal itself is inside it. Both clauses are
  // needed and they are not symmetric: the first catches a window entirely
  // below the diagonal that wraps back over it, the second a window whose x
  // range overruns the start of its y range — which is *every on-diagonal
  // window*, and is the clause whose absence loses the near-diagonal blocks of
  // the picture while leaving the distant ones correct.
  const straddles = (x1 > y2 && x2 < y1) || (x2 > y1 && x1 < y2)
  const nearer = straddles ? 0 : Math.min(nearerDepthRaw, furtherDepthRaw)
  const further = Math.max(nearerDepthRaw, furtherDepthRaw) + 1
  return [{ r1: Math.max(0, nearer), r2: further, c1: Math.max(0, lowerPad), c2: higherPad }]
}

/**
 * The index's own blocks that fall in `rects`, ascending — {@link blockNumbersFor}'s
 * road when naming the candidates would cost more than looking at every block.
 *
 * A block number is read back as `(row, column)` by division, which is exact
 * wherever the rectangles keep inside the grid's columns. The enumeration
 * above also names numbers past a row's last column, which alias into the next
 * row; this does not, and only a window wider than the grid it is read from —
 * which no real file has — could tell the two apart.
 */
function indexedIn(zoom: ZoomData, rects: readonly Rect[]): number[] {
  const columns = zoom.blockColumnCount
  const out: number[] = []
  for (const number of zoom.blocks.keys()) {
    const row = Math.floor(number / columns)
    const column = number - row * columns
    if (rects.some((rect) => row >= rect.r1 && row <= rect.r2 && column >= rect.c1 && column <= rect.c2)) {
      out.push(number)
    }
  }
  return out.sort((a, b) => a - b)
}

/** The records inside one block, in chromosome-local bin coordinates. */
export interface BlockRecords {
  /** First chromosome's bin index. */
  x: Int32Array
  /** Second chromosome's bin index. */
  y: Int32Array
  value: Float32Array
  length: number
}

/**
 * Decode one decompressed block.
 *
 * Two encodings, and the file says which per block: a **list of rows**, which is
 * what a sparse block is written as, and a **dense rectangle**, which is what a
 * block near the diagonal is written as once it is more full than empty. Both
 * appear in the same file, and a reader that assumes one draws a map with
 * missing squares in it.
 *
 * The three width flags are the v9 addition and the place this is most easily
 * got wrong: they are stored as *negatives* — `useFloatContact`, `useIntXPos`,
 * `useIntYPos` — so a zero byte means the narrow encoding, and reading them the
 * intuitive way round shifts every subsequent field by a byte.
 *
 * Nothing is allocated before the record count has been checked against the
 * bytes behind it, at the fewest bytes this block's encoding spends on one
 * record — a column and a value in a row, or a value in a rectangle — so the
 * arrays can never be larger than what the block could hold (§10). The count
 * sizes them and does not bound them: Juicer counts only the records above a
 * `-m` threshold while a dense block still writes every cell, so a block may
 * hold more than it declares, and the arrays grow to take them rather than
 * dropping them past the end, which is what typed arrays do silently.
 */
export function decodeBlock(bytes: Uint8Array, version: number): BlockRecords {
  try {
    return decodeRecords(bytes, version)
  } catch (err) {
    if (!(err instanceof Truncated)) throw err
    throw new ViewerError(
      'format',
      `A block of this .hic ends before its records do, ${bytes.byteLength.toLocaleString('en-US')} ` +
        'bytes in. The file is truncated, corrupt, or not the format its first bytes claim.',
      { bytes: bytes.byteLength },
    )
  }
}

function decodeRecords(bytes: Uint8Array, version: number): BlockRecords {
  const cursor = new Cursor(bytes)
  const declared = cursor.int32()
  if (declared === 0) {
    return { x: new Int32Array(0), y: new Int32Array(0), value: new Float32Array(0), length: 0 }
  }

  const binXOffset = cursor.int32()
  const binYOffset = cursor.int32()
  const shortValue = cursor.int8() === 0
  const shortX = version > 8 ? cursor.int8() === 0 : true
  const shortY = version > 8 ? cursor.int8() === 0 : true
  const type = cursor.int8()
  if (type !== 1 && type !== 2) {
    throw new ViewerError(
      'format',
      `A block of this .hic is in encoding ${type}, and the format has two: 1, a list of rows, ` +
        'and 2, a dense rectangle. The file is corrupt, or was written by a tool this reader has ' +
        'not seen.',
      { type },
    )
  }

  const valueBytes = shortValue ? 2 : 4
  const recordBytes = type === 1 ? (shortX ? 2 : 4) + valueBytes : valueBytes
  const nRecords = declaredCount(declared, {
    format: HIC,
    field: 'record count of a block',
    ceiling: HIC_BLOCK_MAX_RECORDS,
    available: cursor.remaining,
    bytesPerItem: recordBytes,
  })
  let x: Int32Array = new Int32Array(nRecords)
  let y: Int32Array = new Int32Array(nRecords)
  let value: Float32Array = new Float32Array(nRecords)
  let n = 0

  const readValue = (): number => (shortValue ? cursor.int16() : cursor.float32())

  if (type === 1) {
    const rowCount = declaredCount(shortY ? cursor.int16() : cursor.int32(), {
      format: HIC,
      field: 'row count of a block',
      ceiling: INT32_MAX,
      available: cursor.remaining,
      bytesPerItem: (shortY ? 2 : 4) + (shortX ? 2 : 4),
    })
    for (let r = 0; r < rowCount; r++) {
      const binY = binYOffset + (shortY ? cursor.int16() : cursor.int32())
      const colCount = declaredCount(shortX ? cursor.int16() : cursor.int32(), {
        format: HIC,
        field: 'column count of a block row',
        ceiling: INT32_MAX,
        available: cursor.remaining,
        bytesPerItem: recordBytes,
      })
      for (let c = 0; c < colCount; c++) {
        const binX = binXOffset + (shortX ? cursor.int16() : cursor.int32())
        const v = readValue()
        // The two spellings of "no value here". A short block writes the
        // int16 minimum; a float block writes NaN. Keeping either as a
        // number puts -32768 contacts in a cell.
        if (shortValue ? v === -32768 : !Number.isFinite(v)) continue
        if (n === x.length) [x, y, value] = grown(x, y, value, cursor.remaining, recordBytes)
        x[n] = binX
        y[n] = binY
        value[n] = v
        n += 1
      }
    }
    return { x, y, value, length: n }
  }

  // The width is read after the count, so the count's room leaves two bytes for it.
  const nPts = declaredCount(cursor.int32(), {
    format: HIC,
    field: 'cell count of a dense block',
    ceiling: INT32_MAX,
    available: cursor.remaining - 2,
    bytesPerItem: valueBytes,
  })
  const w = cursor.int16()
  if (nPts > 0 && !(w >= 1)) {
    throw new ViewerError(
      'format',
      `A dense block of this .hic is ${w} bins wide, which no rectangle is. The file is ` +
        'truncated, corrupt, or not the format its first bytes claim.',
      { width: w },
    )
  }
  for (let i = 0; i < nPts; i++) {
    const v = readValue()
    if (shortValue ? v === -32768 : !Number.isFinite(v)) continue
    const row = Math.floor(i / w)
    if (n === x.length) [x, y, value] = grown(x, y, value, cursor.remaining, recordBytes)
    x[n] = binXOffset + (i - row * w)
    y[n] = binYOffset + row
    value[n] = v
    n += 1
  }
  return { x, y, value, length: n }
}

/**
 * The three arrays with room for more records than the block declared.
 *
 * Doubled, but never past what the bytes left could still hold, so a block
 * that lies about its count low cannot grow its arrays further than one that
 * lies high could have made them; and never past {@link HIC_BLOCK_MAX_RECORDS}.
 */
function grown(
  x: Int32Array,
  y: Int32Array,
  value: Float32Array,
  remaining: number,
  recordBytes: number,
): [Int32Array, Int32Array, Float32Array] {
  const held = x.length
  const room = Math.floor(Math.max(0, remaining) / recordBytes) + 1
  const size = held + Math.min(Math.max(held, 1024), room)
  if (size > HIC_BLOCK_MAX_RECORDS) {
    throw new ViewerError(
      'format',
      `A block of this .hic holds more than ${HIC_BLOCK_MAX_RECORDS.toLocaleString('en-US')} ` +
        'records, more than any real one. The file is corrupt, or not the format its first ' +
        'bytes claim.',
      { records: size },
    )
  }
  const nextX = new Int32Array(size)
  const nextY = new Int32Array(size)
  const nextValue = new Float32Array(size)
  nextX.set(x)
  nextY.set(y)
  nextValue.set(value)
  return [nextX, nextY, nextValue]
}
