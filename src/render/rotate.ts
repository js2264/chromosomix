/**
 * The map turned 45°: position along the bottom, distance from the diagonal up
 * the side.
 *
 * A contact map is symmetric about its diagonal, and the diagonal is where all
 * the signal is — so a square map spends most of its area on the far corners,
 * which are empty, and draws the part anybody is reading as a thin bright band
 * across the middle. Turning it puts that band along the bottom of a rectangle
 * and gives the whole picture to it. Two things follow, and the second is the
 * real reason to do it:
 *
 * 1. A domain becomes a **triangle standing on the axis**, and a loop becomes a
 *    **dot at the height of its own span** — both far easier to see than a
 *    square-cornered block and a dot off the diagonal.
 * 2. The x axis is now *genomic position*, the same axis a track is drawn
 *    against. A coverage profile under a square map lines up with one edge of
 *    it; under a turned map it lines up with the picture. That is what every
 *    published Hi-C figure is doing, and it is what §8.4's one coordinate model
 *    was already built for.
 *
 * ---
 *
 * **The transform is a true rotation, and that decides the units.** A cell
 * `(b1, b2)` goes to `x = (b1 + b2) / 2` and `y = (b2 - b1) / 2`, both in bins,
 * both drawn at the same bases per pixel. Isometric: nothing is stretched, a
 * domain's two edges meet at a right angle over its midpoint, and a base pair
 * measured up the side is the same length as a base pair measured along the
 * bottom.
 *
 * The consequence to hold on to is that **height is half of separation**. A
 * contact between two bins 100 kb apart sits 50 kb above the axis. The y axis is
 * therefore *labelled* in separation — which is the question a reader is asking,
 * and the number this module takes and returns — while the coordinate underneath
 * it is half that. Stretching the picture to make the two agree is the
 * alternative and it is worse: it would put a domain's edges at 63° and make a
 * base pair up the side shorter than one along the bottom, so nothing could be
 * measured off the plot with one ruler.
 *
 * **The lattice is half-bin.** `b1 + b2` and `b2 - b1` always share parity, so
 * the rotated grid is a checkerboard: half its positions have no cell. Filling
 * only those and interpolating the rest is one option and it blurs; drawing each
 * source cell as a diamond is another and it costs a path per cell. Instead each
 * source cell fills **two adjacent columns**, which makes the output dense,
 * uniform, square-celled and exact to within the half bin it is drawn at. The
 * output cell is `binsize / 2` on both axes, so the block the renderer receives
 * is an ordinary uniform matrix and every part of it — pooling, colouring, pan,
 * zoom, clip, colourbar, export — is the same code it always was.
 *
 * **The corners are empty, and that is honest.** A cell at the far left of the
 * window and high up needs a partner off the left-hand end of the block, which
 * was never read. Those two corner triangles come back `NaN` and draw as paper.
 * Reading wider than the window would fill them and is the obvious later
 * improvement; nothing here pretends they are zeros.
 */

import { LocusAxis } from './locus'

/** The part of a read this module needs. */
export interface RotatableBlock {
  nrows: number
  ncols: number
  values: Float32Array
  rowExtent: readonly [number, number]
  colExtent: readonly [number, number]
}

/**
 * Which way separation grows on screen.
 *
 * `up` is the ordinary turned map: the diagonal along the bottom, distance
 * increasing towards the top of the panel. `down` is its mirror, and exists for
 * exactly one thing — the two-file comparison, whose lower-left triangle has
 * nowhere to go once the square is turned. Drawn `down` beneath a first map
 * drawn `up`, the pair becomes two rectangles meeting at one shared genomic
 * axis, which is a better presentation of that comparison than the square was:
 * the two are read against each other at every position without the eye having
 * to reflect one of them through a diagonal first.
 */
export type RotateDirection = 'up' | 'down'

export interface RotateOptions {
  /**
   * Largest separation to keep, **in bins**, counted as `|b2 - b1|`.
   *
   * The reader's "how far from the diagonal am I looking", and the thing that
   * makes this cheaper than the square it replaces rather than dearer: nobody
   * wants the whole triangle, and a band is a fraction of the block.
   */
  maxSeparation: number
  direction?: RotateDirection
}

/**
 * A turned block, and everything needed to read a position back out of it.
 *
 * Shaped so the values half can be handed to the renderer as an ordinary dense
 * matrix while the geometry half answers the questions only this module can:
 * where a column sits on the genome, and which pair of bins a cell came from.
 */
export interface RotatedBlock {
  nrows: number
  ncols: number
  /** Row-major, `nrows * ncols`, `NaN` where no cell of the square reaches. */
  values: Float32Array
  /**
   * Absolute bin position of the **left edge of column 0**, in bins.
   *
   * The block's own first bin: column 0 is the cell where both ends are that
   * bin. Columns advance by half a bin from there, which is what
   * {@link BIN_FRACTION} names.
   */
  originBin: number
  /** Separation, in bins, of the row furthest from the axis. */
  maxSeparation: number
  direction: RotateDirection
}

/**
 * How much of a bin one output cell spans, on both axes.
 *
 * A half, and not a tuning knob: it is what the rotated lattice *is*. `b1 + b2`
 * advances by one when either end moves by one bin, so the natural column width
 * is half the bin size, and the same is true up the side.
 */
export const BIN_FRACTION = 0.5

/**
 * Turn a square on-diagonal block into a band above its own diagonal.
 *
 * The caller has already established that this block *has* a diagonal — see
 * {@link isTurnable}, which is the gate the toggle is greyed by. Handing an
 * off-diagonal block here would produce a picture of the distance between two
 * sequences that do not have one.
 */
export function rotateBlock(block: RotatableBlock, options: RotateOptions): RotatedBlock {
  const n = Math.min(block.nrows, block.ncols)
  const direction = options.direction ?? 'up'
  // At most the block itself: a separation wider than the window has no cells
  // to draw, and asking for one would allocate rows that could only be NaN.
  const maxSeparation = Math.max(0, Math.min(Math.trunc(options.maxSeparation), Math.max(0, n - 1)))
  const width = Math.max(1, 2 * n - 1)
  const height = maxSeparation + 1
  const values = new Float32Array(width * height).fill(Number.NaN)

  for (let separation = 0; separation <= maxSeparation; separation++) {
    // Rows are emitted in the order they are drawn, so the renderer needs no
    // notion of which way up this is: `up` puts the widest separation in row 0,
    // which a top-to-bottom raster then draws as an apex over an axis along the
    // bottom edge.
    const row = direction === 'up' ? maxSeparation - separation : separation
    const base = row * width
    for (let i = 0; i + separation < n; i++) {
      const j = i + separation
      const value = block.values[i * block.ncols + j]
      // Two columns per cell, which is what makes the output dense rather than
      // a checkerboard: `i + j` and `i + j + 1` are the two half-bin columns the
      // cell covers, and the second is where the parity gap would otherwise be.
      const x = 2 * i + separation
      values[base + x] = value
      if (x + 1 < width) values[base + x + 1] = value
    }
  }

  return {
    nrows: height,
    ncols: width,
    values,
    originBin: block.rowExtent[0],
    maxSeparation,
    direction,
  }
}

/**
 * The pair of bins a turned cell came from, or `null` off the end of the band.
 *
 * What the readout needs, and the reason the two-columns-per-cell rule above is
 * worth stating precisely: a column is half a bin, so two adjacent columns can
 * name the same pair, and which of them a pointer is over is not a fact about
 * the data. The parity of `column + separation` is what picks the pair back out
 * — one of the two columns hits the lattice exactly and the other is the filled
 * neighbour, so the answer is the same cell either way.
 */
export function cellAt(
  rotated: Pick<RotatedBlock, 'nrows' | 'ncols' | 'maxSeparation' | 'direction' | 'originBin'>,
  row: number,
  column: number,
): { row: number; col: number; separation: number } | null {
  if (row < 0 || row >= rotated.nrows || column < 0 || column >= rotated.ncols) return null
  const separation = separationAt(rotated, row)
  // `i + j` for this cell: the lattice point at or just left of the column.
  const sum = (column + separation) % 2 === 0 ? column : column - 1
  const i = (sum - separation) / 2
  const j = i + separation
  if (!Number.isInteger(i) || i < 0) return null
  return { row: i, col: j, separation }
}

/**
 * Where a turned cell's two anchors stand on the column axis, in matrix units.
 *
 * The pair of positions a contact is *between*, said in the coordinate a track
 * under the map is drawn in — which is what lets a stack answer a pointer on the
 * map with two hairlines rather than one. A bin fills two columns, so its middle
 * is `2b + 1`; on the diagonal the two anchors are one place and the answer is
 * one line.
 */
export function anchorColumns(
  rotated: Pick<RotatedBlock, 'nrows' | 'ncols' | 'maxSeparation' | 'direction' | 'originBin'>,
  row: number,
  column: number,
): number[] | null {
  const cell = cellAt(rotated, row, column)
  if (cell === null) return null
  return cell.separation === 0 ? [2 * cell.row + 1] : [2 * cell.row + 1, 2 * cell.col + 1]
}

/**
 * The bins a run of turned columns covers, as a half-open range into the block.
 *
 * The inverse of the rotation for a *band* rather than for a cell, and what
 * turns a drag across a turned map into a window on the genome. A column is half
 * a bin, so the arithmetic is one multiplication — but the rounding is the whole
 * of it, and it goes outward at both ends: a reader who drags across a feature
 * means the bins their band touched, not the bins it wholly contained, and a
 * band narrower than one bin is still a band. Hence the floor, the ceiling, and
 * the guarantee of at least one bin in the answer.
 *
 * Clamped to the block, because a drag is clamped to the *plot* and the plot is
 * larger than the data whenever the view is zoomed out.
 *
 * @param bins How many bins the square block this band was turned out of has.
 */
export function binsForColumns(columns: readonly [number, number], bins: number): [number, number] {
  const n = Math.max(1, Math.trunc(bins))
  const lo = Math.max(0, Math.min(n - 1, Math.floor(columns[0] * BIN_FRACTION)))
  const hi = Math.max(lo + 1, Math.min(n, Math.ceil(columns[1] * BIN_FRACTION)))
  return [lo, hi]
}

/**
 * A point on a turned map, in the matrix units the renderer draws in.
 *
 * Fractional on both axes: a contact's true centre falls on the boundary
 * between the two columns it fills, and a row's is half way down it.
 */
export interface TurnedPoint {
  col: number
  row: number
}

/**
 * Where the contact under a turned cell truly sits, in matrix units.
 *
 * Not the centre of the cell the pointer is over, and the difference is the
 * half-bin lattice: a contact fills *two* columns, so its own middle is the
 * line between them — `i + j + 1` — while the cell under the pointer is one or
 * the other of the two. Half a column is a quarter of a bin and invisible as a
 * position, but it is the difference between a guide that meets the axis
 * exactly on the bin its contact is with and one that meets it a quarter of a
 * bin to the side, which at bin zoom is a line pointing next to the answer.
 */
export function turnedCentre(
  rotated: Pick<RotatedBlock, 'maxSeparation' | 'direction'>,
  row: number,
  column: number,
): TurnedPoint {
  const separation = separationAt(rotated, row)
  const sum = (column + separation) % 2 === 0 ? column : column - 1
  return { col: sum + 1, row: row + 0.5 }
}

/**
 * The rays a guide follows from a point on a turned map, in matrix units.
 *
 * **A turned map's two directions are not its two axes**, and this is the whole
 * of what that means for anything drawn through a point. A cell of the square
 * is a contact between two places; turned, the set of cells sharing one of those
 * places is not a column of the picture but a **45° ray**, because holding `i`
 * fixed and letting the separation grow moves the contact half a bin along for
 * every bin further from the diagonal. In matrix units that is exactly slope
 * one: `col + row` is constant along one anchor and `col - row` along the other.
 *
 * So the honest guide on a turned map is a pair of rays rather than a cross —
 * two lines that say *these two places*, meeting at the contact between them.
 * Where they end is the caller's: a pointer on the map is between two anchors
 * and reaches both edges of the band (an X, which near the axis is a V and near
 * the top a ∧, because the rest is off the picture); a pointer on a track names
 * one place on the axis and its rays only go outwards from it (a V).
 *
 * @param rows Matrix rows the rays reach — one row for a V, both edges for an X.
 */
export function anchorRays(
  at: TurnedPoint,
  rows: readonly number[],
): Array<{ from: TurnedPoint; to: TurnedPoint }> {
  const out: Array<{ from: TurnedPoint; to: TurnedPoint }> = []
  for (const row of rows) {
    for (const way of [-1, 1]) {
      out.push({ from: at, to: { col: at.col + way * (row - at.row), row } })
    }
  }
  return out
}

/** The separation, in bins, that a row of the turned block stands for. */
export function separationAt(
  rotated: Pick<RotatedBlock, 'maxSeparation' | 'direction'>,
  row: number,
): number {
  return rotated.direction === 'up' ? rotated.maxSeparation - row : row
}

/** The row that draws a given separation. Inverse of {@link separationAt}. */
export function rowForSeparation(
  rotated: Pick<RotatedBlock, 'maxSeparation' | 'direction'>,
  separation: number,
): number {
  return rotated.direction === 'up' ? rotated.maxSeparation - separation : separation
}

/**
 * The absolute bin position at the centre of a turned column.
 *
 * Fractional by construction — a column is half a bin — and returned that way
 * rather than rounded, because the axis under a turned map is a genomic ruler
 * and rounding it would make every second tick land on the wrong side of a bin
 * boundary.
 */
export function positionAt(rotated: Pick<RotatedBlock, 'originBin'>, column: number): number {
  return rotated.originBin + (column + 0.5) * BIN_FRACTION
}

/**
 * The separation a band of `rows` pixels can show, given how tall a cell is.
 *
 * The arithmetic behind "the box keeps its height and the distance follows the
 * zoom": the panel's height in cells is fixed by the layout, a cell is half a
 * bin *of height* and therefore a whole bin *of separation*, and so the deepest
 * contact on screen is the row count in bins.
 */
export function separationForRows(rows: number): number {
  return Math.max(0, Math.trunc(rows))
}

/**
 * Whether a block can be turned at all.
 *
 * Three conditions, and each of them is the same condition looked at from a
 * different side: **the block must have a diagonal**. Distance from it is the
 * whole of the y axis, so a block that does not have one has no picture to make.
 *
 * - the two axes must cover the same bins, or the block is a rectangle between
 *   two different stretches of the genome;
 * - it must be one sequence, because a boundary between two of them is a
 *   discontinuity in the x axis and the "distance" across it is not a distance;
 * - it must be at bin level, because above that a cell is a whole sequence and
 *   the separation between two of them is a count of sequences, not a length.
 *
 * The toggle is greyed rather than hidden where this is false, so that a reader
 * looking at a whole metagenome can see the control exists and learn what it
 * wants from them.
 */
export function isTurnable(block: {
  level: 'bin' | 'contig' | 'genome'
  rowExtent: readonly [number, number]
  colExtent: readonly [number, number]
  rowGroups?: ReadonlyArray<unknown>
}): boolean {
  if (block.level !== 'bin') return false
  if (block.rowExtent[0] !== block.colExtent[0]) return false
  if (block.rowExtent[1] !== block.colExtent[1]) return false
  // One run, or none at all — a plain cooler read as a single span has no runs
  // and is one sequence by construction.
  return (block.rowGroups?.length ?? 1) <= 1
}

/**
 * The genomic axis under a turned block.
 *
 * Built here rather than by `locusAxisFrom` because the turned block's columns
 * are half a bin, and that helper takes its scale from a bin size shared with
 * the rest of the read. One segment always: {@link isTurnable} has already
 * refused anything spanning more than one sequence, which is the condition that
 * would need more.
 *
 * This is what makes a turned map worth having. §8.4 gives the heatmap and the
 * lanes *one* coordinate model, so the moment the x axis becomes an ordinary
 * genomic axis every track already lines up with the picture — nothing in
 * `AnnotationLanes` has to learn that the map was turned.
 */
export function turnedAxis(
  rotated: Pick<RotatedBlock, 'ncols' | 'originBin'>,
  contig: { label: string; firstBin: number; length: number },
  binsize: number,
): LocusAxis | null {
  if (!(binsize > 0) || rotated.ncols <= 0) return null
  return new LocusAxis([
    {
      contig: contig.label,
      unitStart: 0,
      unitEnd: rotated.ncols,
      // Where column 0's left edge sits inside the sequence. The block may begin
      // part-way into it, and the turned block inherits that offset unchanged.
      bpStart: (rotated.originBin - contig.firstBin) * binsize,
      bpPerUnit: binsize * BIN_FRACTION,
      contigLength: contig.length,
    },
  ])
}

/**
 * The fraction of a block a turned map shows before anybody says otherwise.
 *
 * A whole triangle is always twice as wide as it is tall — that is what the
 * half-bin lattice makes it — so turning a map and fitting it produces a
 * triangle that fills the panel and touches nothing. Which is a fine picture and
 * is not the one the turn is for: the reading is the band near the diagonal, and
 * the far apex is the part of a contact map that has least in it.
 */
export const DEFAULT_TURN_FRACTION = 0.25

/**
 * How far from the diagonal to reach, in bins, given a block and a request.
 *
 * `asked` is `null` until the reader drags the band's top edge, and then it is
 * whatever they dragged it to — clamped here rather than at the gesture, so the
 * one place that decides is the one place that knows how big the block is. A
 * band cannot be deeper than the block has cells to fill, and cannot be nothing:
 * zero rows is a picture with no picture in it, and a reader who drags the edge
 * onto the diagonal means "as shallow as it goes", not "gone".
 *
 * A *fraction* rather than a distance in base pairs, deliberately: a default of
 * "500 kb" is most of a bacterial chromosome and a rounding error on a human
 * one, and this viewer opens on both.
 */
export function turnDepthFor(block: { nrows: number; ncols: number }, asked: number | null): number {
  const span = Math.max(1, Math.min(block.nrows, block.ncols))
  const wanted = asked ?? Math.ceil(span * DEFAULT_TURN_FRACTION)
  return Math.max(1, Math.min(span - 1, wanted))
}

/**
 * The vertical ruler of a turned map, as the same line every other ruler is.
 *
 * A turned map's y axis answers "how far apart", not "where", so the number
 * beside a row is a *distance*: labelling it with coordinates would name places
 * that are not on the picture. But it is still an affine function of the row
 * index, which is all `AxisCoords` has ever been — so the turned ruler needs no
 * machinery of its own, only the right two numbers.
 *
 * The gradient is **negative** for an ordinary turned map, and that is the whole
 * of what is unusual here: separation grows towards the top of the picture while
 * a row index grows towards the bottom. It is positive on the mirrored half of a
 * comparison, where the two grow together.
 *
 * The half is the cell centre. Row `r` covers `[r, r + 1)`, and the separation
 * it stands for is the one at its middle — without it every label would be off
 * by half a bin, which at whole-genome zoom is invisible and at bin zoom is the
 * difference between a tick on a cell and a tick between two.
 */
export function separationCoords(
  rotated: Pick<RotatedBlock, 'maxSeparation' | 'direction'>,
  binsize: number,
): { bpPerCell: number; bpAtOrigin: number; tickGapPx: number } {
  const gap = { tickGapPx: SEPARATION_TICK_GAP_PX }
  return rotated.direction === 'up'
    ? { ...gap, bpPerCell: -binsize, bpAtOrigin: (rotated.maxSeparation + 0.5) * binsize }
    : { ...gap, bpPerCell: binsize, bpAtOrigin: -0.5 * binsize }
}

/**
 * How much room a distance label wants above the next one, in CSS pixels.
 *
 * A turned band is a hundred pixels tall against a square map's five hundred,
 * and the default spacing — which is the *width* of a base-pair label, because
 * a horizontal ruler is what it was chosen for — fits one tick in it. A label
 * read bottom to top needs its own height and some air, and this is that.
 */
const SEPARATION_TICK_GAP_PX = 26

/**
 * How far from the diagonal a band of `rows` rows reaches, in base pairs.
 *
 * The reader's number, and the one the y axis is labelled with: a row is one bin
 * of *separation* even though it is half a bin of height, which is the whole of
 * what {@link rotateBlock}'s header means by height being half of distance.
 */
export function separationBp(rows: number, binsize: number): number {
  return Math.max(0, rows) * binsize
}
