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

/** One chromosome pair's matrix, at every resolution it was written at. */
export interface MatrixRecord {
  chr1: number
  chr2: number
  zooms: ZoomData[]
}

/**
 * Parse one chromosome pair's matrix record.
 *
 * `entry.size` is the record's own length, so this is one bounded read and the
 * block index for a pair costs exactly one request however many blocks it holds.
 */
export function parseMatrixRecord(bytes: Uint8Array, _version: number): MatrixRecord {
  const cursor = new Cursor(bytes)
  const chr1 = cursor.int32()
  const chr2 = cursor.int32()
  const nResolutions = cursor.int32()
  const zooms: ZoomData[] = []
  for (let i = 0; i < nResolutions; i++) {
    const unit = cursor.string()
    cursor.int32() // zoom index, which is the position in this list
    const sumCounts = cursor.float32()
    // Three reserved statistics — occupied cells, standard deviation, 95th
    // percentile. Twelve bytes, never populated by Juicer, never read here, and
    // skipped by width rather than by name so a file that does populate them
    // still lands the cursor in the right place.
    cursor.float32()
    cursor.float32()
    cursor.float32()
    const binSize = cursor.int32()
    const blockBinCount = cursor.int32()
    const blockColumnCount = cursor.int32()
    const blockCount = cursor.int32()
    const blocks = new Map<number, BlockRef>()
    for (let b = 0; b < blockCount; b++) {
      const number = cursor.int32()
      const position = cursor.int64()
      const size = cursor.int32()
      blocks.set(number, { number, position, size })
    }
    zooms.push({ unit, binSize, blockBinCount, blockColumnCount, blocks, sumCounts })
  }
  return { chr1, chr2, zooms }
}

/** Read and parse one master-index entry. */
export function readMatrixRecord(
  read: (position: number, length: number) => Uint8Array,
  entry: MasterIndexEntry,
  version: number,
): MatrixRecord {
  return parseMatrixRecord(read(entry.position, entry.size), version)
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
