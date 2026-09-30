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
 */

import { Cursor, type MasterIndexEntry } from './format'

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
 * byte throws the `RangeError` a `DataView` throws, which is what tells
 * {@link readZoom} that the answer is further in. No wrong answer can come out
 * of a short read instead — a unit string cut off mid-name is followed by a
 * field read past the end, and a resolution is only reported absent once every
 * header in the record has been read.
 */
export function findZoom(bytes: Uint8Array, unit: string, binSize: number): ZoomData | null {
  const cursor = new Cursor(bytes)
  cursor.int32() // chr1, which the master-index key already says
  cursor.int32() // chr2
  const nResolutions = cursor.int32()
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
    const blockCount = cursor.int32()
    if (zoomUnit !== unit || zoomBinSize !== binSize) {
      cursor.position += blockCount * 16
      continue
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
      return { zoom: findZoom(read(entry.position, head), unit, binSize), beyondHead: false }
    } catch (err) {
      if (!(err instanceof RangeError)) throw err
    }
    return { zoom: findZoom(read(entry.position, entry.size), unit, binSize), beyondHead: true }
  }
  return { zoom: findZoom(read(entry.position, entry.size), unit, binSize), beyondHead: false }
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
      return { zoom: findZoom(await read(entry.position, head), unit, binSize), beyondHead: false }
    } catch (err) {
      if (!(err instanceof RangeError)) throw err
    }
    return { zoom: findZoom(await read(entry.position, entry.size), unit, binSize), beyondHead: true }
  }
  return { zoom: findZoom(await read(entry.position, entry.size), unit, binSize), beyondHead: false }
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
 */
export function blockNumbersFor(
  zoom: ZoomData,
  version: number,
  intra: boolean,
  x: readonly [number, number],
  y: readonly [number, number],
): number[] {
  return intra && version >= 9
    ? diagonalBlockNumbers(zoom, x, y)
    : gridBlockNumbers(zoom, intra, x, y)
}

/** Versions 7 and 8, and every inter-chromosomal matrix at any version. */
function gridBlockNumbers(
  zoom: ZoomData,
  intra: boolean,
  x: readonly [number, number],
  y: readonly [number, number],
): number[] {
  const { blockBinCount, blockColumnCount } = zoom
  const col1 = Math.floor(x[0] / blockBinCount)
  const col2 = Math.floor(Math.max(x[0], x[1] - 1) / blockBinCount)
  const row1 = Math.floor(y[0] / blockBinCount)
  const row2 = Math.floor(Math.max(y[0], y[1] - 1) / blockBinCount)
  const out = new Set<number>()
  for (let r = row1; r <= row2; r++) {
    for (let c = col1; c <= col2; c++) out.add(r * blockColumnCount + c)
  }
  if (intra) {
    // The stored matrix is upper-triangular within a chromosome, so the block
    // holding a cell may be the transposed one. Adding both and letting the
    // index drop the absent half is cheaper than deciding which, and is what
    // makes a window that straddles the diagonal come back whole.
    for (let r = col1; r <= col2; r++) {
      for (let c = row1; c <= row2; c++) out.add(r * blockColumnCount + c)
    }
  }
  return [...out]
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
function diagonalBlockNumbers(
  zoom: ZoomData,
  x: readonly [number, number],
  y: readonly [number, number],
): number[] {
  const { blockBinCount, blockColumnCount } = zoom
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

  const out = new Set<number>()
  for (let depth = Math.max(0, nearer); depth <= further; depth++) {
    for (let pad = Math.max(0, lowerPad); pad <= higherPad; pad++) {
      out.add(depth * blockColumnCount + pad)
    }
  }
  return [...out]
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
 */
export function decodeBlock(bytes: Uint8Array, version: number): BlockRecords {
  const cursor = new Cursor(bytes)
  const nRecords = cursor.int32()
  const x = new Int32Array(nRecords)
  const y = new Int32Array(nRecords)
  const value = new Float32Array(nRecords)
  let n = 0
  if (nRecords === 0) return { x, y, value, length: 0 }

  const binXOffset = cursor.int32()
  const binYOffset = cursor.int32()
  const shortValue = cursor.int8() === 0
  const shortX = version > 8 ? cursor.int8() === 0 : true
  const shortY = version > 8 ? cursor.int8() === 0 : true
  const type = cursor.int8()

  const readValue = (): number => (shortValue ? cursor.int16() : cursor.float32())

  if (type === 1) {
    const rowCount = shortY ? cursor.int16() : cursor.int32()
    for (let r = 0; r < rowCount; r++) {
      const binY = binYOffset + (shortY ? cursor.int16() : cursor.int32())
      const colCount = shortX ? cursor.int16() : cursor.int32()
      for (let c = 0; c < colCount; c++) {
        const binX = binXOffset + (shortX ? cursor.int16() : cursor.int32())
        const v = readValue()
        // The two spellings of "no value here". A short block writes the
        // int16 minimum; a float block writes NaN. Keeping either as a
        // number puts -32768 contacts in a cell.
        if (shortValue ? v === -32768 : !Number.isFinite(v)) continue
        x[n] = binX
        y[n] = binY
        value[n] = v
        n += 1
      }
    }
    return { x, y, value, length: n }
  }

  if (type === 2) {
    const nPts = cursor.int32()
    const w = cursor.int16()
    for (let i = 0; i < nPts; i++) {
      const v = readValue()
      if (shortValue ? v === -32768 : !Number.isFinite(v)) continue
      const row = Math.floor(i / w)
      x[n] = binXOffset + (i - row * w)
      y[n] = binYOffset + row
      value[n] = v
      n += 1
    }
    return { x, y, value, length: n }
  }

  throw new Error(`unknown .hic block encoding ${type}`)
}
