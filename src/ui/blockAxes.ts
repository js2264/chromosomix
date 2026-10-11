/**
 * A block's two axes, as the reader sends them: runs of sequences laid along
 * cells, and the §3.3 arithmetic that turns a cell into base pairs.
 *
 * The map panel asks a block's axes the same few questions on every frame and
 * every pointer move — which run a cell falls in, how many base pairs into its
 * sequence that is, how a ruler is laid along the axis and where the boundaries
 * between sequences go, how far apart a cell's two ends are, which absolute bins
 * a window covers and which cells a pair of loci does — and every answer comes
 * from the same five numbers: the run, where that run's sequence begins, the
 * block's own first bin, the level, and the bin size. `/bins` is never
 * consulted. One module for all of them, because they are one rule read several
 * ways, and the tick under the pointer, the readout beside it and the window a
 * deck locks on must not come to disagree by a bin.
 *
 * With them, the one adapter of the block itself — its values between those
 * extents, as the dense matrix the renderer draws — since the boundaries and the
 * rulers here are the other two things the renderer is handed about a block, and
 * all three are built from the same read.
 *
 * Pure, and out of `ui/MatrixPanel.ts` for that reason: none of it needs a
 * canvas, a DOM or a panel, so the tests that pin the arithmetic import it from
 * here, and the panel keeps only the state the arithmetic is applied to.
 */

import type { AxisCoords, AxisSpan, SeparatorSet } from '../render/heatmap'
import type { LocusAxis } from '../render/locus'
import type { RotatedBlock } from '../render/rotate'
import type { DenseMatrix, Extent, Separator } from '../types'
import type { AxisGroup, MatrixResult } from '../worker/protocol'

/** Which group covers a block-local offset. Absent list, absent answer. */
export function groupAt(
  groups: AxisGroup[] | undefined,
  offset: number,
): AxisGroup | undefined {
  if (groups === undefined) return undefined
  let lo = 0
  let hi = groups.length - 1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    const group = groups[mid]
    if (offset < group.start) hi = mid - 1
    else if (offset >= group.end) lo = mid + 1
    else return group
  }
  return undefined
}

/**
 * Base pairs from the start of the **contig** to the start of a cell.
 *
 * `group.start` is block-local, so `(offset - group.start) * binsize` measures
 * from the left edge of the picture rather than from the contig — the same
 * number only when the block begins on a contig boundary. A region view of
 * `contig:139005-199005` begins at bin 139, and the readout used to call that
 * cell 0 bp when it is 139 kb into the contig. `unitStart` is where the contig
 * itself begins, so the absolute bin `blockStart + offset` resolves correctly
 * (§3.3 arithmetic throughout; `/bins` is never consulted).
 */
export function bpWithin(
  group: AxisGroup,
  offset: number,
  blockStart: number,
  binsize: number,
): number {
  const first = group.unitStart ?? blockStart + group.start
  return (blockStart + offset - first) * binsize
}

/**
 * A cell window on one axis, as absolute bins of the file.
 *
 * Outward on both ends, and **clamped to the block**, because a window naming
 * bins the block does not hold is not a window — at fit zoom the plot is wider
 * than the picture and the raw cell window runs off both sides into the margins.
 *
 * Leaving it unclamped, briefly, was a bug with real teeth: a *fitted* view then
 * reported a window wider than its own block, the ladder read that as "the
 * reader has gone outside what they have", and every view that opened fitted
 * immediately asked for a widening read of its own whole domain. On a small file
 * that is a wasted read nobody notices. On a 660 MB mouse cooler it is minutes
 * of scanning, with the map frozen for the duration, before the reader has
 * touched anything.
 *
 * The signal it was standing in for — *the reader wants to go past this block* —
 * is `BlockLadder.atEdge`'s to give, and it gives it from the block and the
 * ceiling rather than from a window that has been allowed to lie.
 *
 * `binsPerCell` may be fractional — a turned column is half a bin — which is why
 * the rounding is done after the multiply rather than on the cell index.
 */
export function binsOf(
  window: readonly [number, number],
  extent: Extent,
  binsPerCell: number,
): Extent {
  const lo = extent[0] + Math.floor(window[0] * binsPerCell)
  const hi = extent[0] + Math.ceil(window[1] * binsPerCell)
  return [
    Math.max(extent[0], Math.min(lo, extent[1])),
    Math.min(extent[1], Math.max(hi, extent[0])),
  ]
}

/**
 * Two loci, as a cell interval on a given axis — the second half of a regrid.
 *
 * `null` where the axis cannot answer: no locus at all, a contig it does not
 * cover, or an interval that came back inverted. Every one of those is a reason
 * to leave the picture alone rather than to place it approximately, because a
 * map drawn over the wrong stretch of genome looks exactly like a map drawn over
 * the right one.
 *
 * Clamped to the block, since the incoming window is padded beyond the view and
 * its edges can fall outside a block that stopped at a sequence end.
 *
 * **Every landing of each end, not the first**, and that is what makes a
 * circular slide work at all. A block read across a sequence's own junction
 * carries that sequence *twice* — the tail of it, then the head (SPECS §8.15) —
 * so a window running from 2.95 Mb to 50 kb is a perfectly ordinary window whose
 * two ends are on different stretches of the same name. Resolved by name alone,
 * the second end came back on the first stretch, landed before the first end,
 * and the regrid was refused: the ladder had read the block the reader was
 * sliding towards and the panel declined to install it, leaving them against a
 * wall with the way past it already in memory.
 *
 * The pair chosen is the **narrowest ordered one**, which on every axis that
 * carries a contig once is the only one there is.
 */
export function spanOnAxis(
  axis: LocusAxis | null,
  want: { from: { contig: string; bp: number }; to: { contig: string; bp: number } } | null,
  cells: number,
): readonly [number, number] | null {
  if (axis === null || want === null) return null
  // `locusToUnits` answers only where the position genuinely falls on a stretch,
  // which is what a mark wants and is one case short of what this wants: a
  // *padded* window runs past the end of the sequence on purpose, and the old
  // behaviour — extrapolate off the one stretch, then clamp to the block — is
  // right for it. So the strict answer first, and the extrapolation as the
  // fallback where there is no stretch to land on.
  const landings = (contig: string, bp: number): number[] => {
    const inside = axis.locusToUnits(contig, bp)
    if (inside.length > 0) return inside
    const outside = axis.locusToUnit(contig, bp)
    return outside === null ? [] : [outside]
  }
  const lows = landings(want.from.contig, want.from.bp)
  const highs = landings(want.to.contig, want.to.bp)
  if (lows.length === 0 || highs.length === 0) return null
  let best: readonly [number, number] | null = null
  for (const lo of lows) {
    for (const hi of highs) {
      const from = Math.max(0, Math.min(lo, cells))
      const to = Math.min(cells, Math.max(hi, from))
      if (!(to > from)) continue
      if (best === null || to - from < best[1] - best[0]) best = [from, to]
    }
  }
  return best
}

/**
 * What one axis measures in base pairs, or `null` when it measures nothing a
 * position could be expressed in.
 *
 * Both refusals are the ones `_bin_axis` makes in `ops/show.py`. Above bin
 * level a cell *is* a contig or a genome, so a position inside one would be an
 * invention. Across more than one contig there is no single coordinate system:
 * the ticks are the contig names there, and they already are.
 *
 * The line itself is {@link bpWithin} at offset 0, from the same `unitStart`,
 * so a tick and the readout under the pointer cannot disagree.
 *
 * @param fraction How much of a bin one **cell** spans — a half under a turn,
 * where the rotated lattice counts in half bins (`render/rotate.ts`), and one
 * everywhere else. It scales the ruler's step and nothing else: where the block
 * *starts* is a distance from the contig's first bin, measured in whole bins by
 * everything that reads it, and folding the cell size into that offset put the
 * turned map's ruler half of the way into the block behind the picture on it.
 */
export function axisCoordsFor(
  groups: AxisGroup[],
  extent: readonly [number, number],
  level: 'bin' | 'contig' | 'genome',
  binsize: number,
  fraction = 1,
): AxisCoords | null {
  if (level !== 'bin' || groups.length !== 1 || !(binsize > 0)) return null
  const group = groups[0]
  const first = group.unitStart ?? extent[0] + group.start
  return { bpPerCell: binsize * fraction, bpAtOrigin: (extent[0] - first) * binsize }
}

/**
 * A ruler per sequence, for an axis that has no single one.
 *
 * {@link axisCoordsFor}'s complement, and its refusals inverted: it answers for
 * an axis of *one* contig at bin level, this answers for an axis of several,
 * and above bin level neither answers at all — a cell there *is* a contig or a
 * genome, and a position inside one would be an invention.
 *
 * Each stretch's line is stated in the **block's** coordinate frame, which is
 * `axisCoordsFor`'s own arithmetic applied per group: `bpAtOrigin` is what this
 * contig's ruler would read at cell zero of the block, negative for every
 * contig but the first, so a tick's `unit` needs no offsetting to be a matrix
 * coordinate like any other.
 *
 * A cell that several short sequences share is skipped, on {@link describeAxis}'s
 * rule: the pixel is all of them, and a coordinate inside one of them names a
 * place the picture does not show.
 *
 * And nothing at all past {@link MAX_RULED_SPANS}. A metagenome's axis is
 * thousands of contigs, each a pixel or less: there is no room for a position on
 * any of them, the names are already elided for the same reason, and building
 * the list would cost more than the ruler it cannot draw.
 */
export function axisSpansFor(
  groups: AxisGroup[],
  extent: readonly [number, number],
  level: 'bin' | 'contig' | 'genome',
  binsize: number,
): AxisSpan[] {
  if (level !== 'bin' || !(binsize > 0)) return []
  if (groups.length < 2 || groups.length > MAX_RULED_SPANS) return []
  const out: AxisSpan[] = []
  for (const group of groups) {
    if ((group.merged?.length ?? 1) > 1) continue
    if (!(group.end > group.start)) continue
    const first = group.unitStart ?? extent[0] + group.start
    out.push({
      from: group.start,
      to: group.end,
      coords: { bpPerCell: binsize, bpAtOrigin: (extent[0] - first) * binsize },
    })
  }
  return out
}

/**
 * How many sequences an axis may carry and still be ruled one at a time.
 *
 * A genome's worth, generously: sixteen chromosomes, or a few hundred scaffolds.
 * Past that the stretches are narrower than a label and the answer is the same
 * one the block names give — none — so the list is not built at all.
 */
const MAX_RULED_SPANS = 512

/**
 * One axis of the cell under the pointer, as {@link separationOf} needs it.
 *
 * The block's own origin is in it because a *coarsened* axis is measured in
 * cells while its extent is measured in bins, and the only arithmetic that gets
 * both right is {@link bpWithin}'s — which needs the origin. Subtracting the two
 * absolute indices instead is exact on a dense block and wrong by the pooling
 * factor on every other, which is how the line went quiet on the views that are
 * always pooled: anything larger than the picture.
 */
export interface AxisSide {
  group: AxisGroup | undefined
  /** Block-local offset of the cell on this axis — `cell.row` or `cell.col`. */
  offset: number
  /** Where the block starts on this axis — `rowExtent[0]` or `colExtent[0]`. */
  blockStart: number
  /** The genome this sequence belongs to, where the axis names one. */
  genome?: string | undefined
}

/**
 * How far apart the two ends of a cell are along the sequence, in base pairs.
 *
 * The genomic distance is what a cis contact *means* — a Hi-C map is read by
 * how the signal falls off with separation, and without this the tooltip makes
 * you subtract two coordinates to get it. `null` where the question has no
 * answer, and each of those is a refusal rather than a gap:
 *
 * - **above bin level**, where a cell is a whole contig or genome and its two
 *   ends have no positions to subtract;
 * - **across two sequences**, where the contact is trans and a distance along
 *   the sequence does not exist — not a large one, none;
 * - **on a cell several sequences share**, which has no position in any one of
 *   them; the readout says so in words there and must not say it in numbers
 *   here;
 * - **on the diagonal**, where it is zero and saying so is noise on the line
 *   that matters least.
 *
 * The two positions come from {@link bpWithin}, the same function the tooltip's
 * own coordinates come from, so the difference on screen and the difference
 * quoted here cannot disagree — and both are right whether the block is the
 * file's own grid or a coarsened one.
 */
export function separationOf(
  row: AxisSide,
  col: AxisSide,
  level: 'bin' | 'contig' | 'genome',
  binsize: number,
): number | null {
  if (level !== 'bin' || !(binsize > 0)) return null
  const { group: rowGroup } = row
  const { group: colGroup } = col
  if (rowGroup === undefined || colGroup === undefined) return null
  if ((rowGroup.merged?.length ?? 1) > 1 || (colGroup.merged?.length ?? 1) > 1) return null
  if (!sameSequence(row, col)) return null
  const apart = Math.abs(
    bpWithin(rowGroup, row.offset, row.blockStart, binsize) -
      bpWithin(colGroup, col.offset, col.blockStart, binsize),
  )
  return apart === 0 ? null : apart
}

/**
 * Whether two axis runs are the same sequence.
 *
 * `unitBin` first, because it is the only member that is an *identity*: the
 * absolute bin the sequence itself begins at, the same number on both axes
 * however each axis's block opens. It tells two windows of one contig apart
 * from two contigs without trusting a string, which matters on a metagenome
 * where two MAGs may each have a `contig_1`.
 *
 * `unitStart` is an arithmetic *origin* and only coincides with the identity on
 * a dense block: a coarsened axis is anchored to the contig, so its origin
 * depends on where that axis's own window starts, and `contig × the same contig`
 * over two different windows gets two different numbers for one sequence. It is
 * kept as the second test for a block that carries no identity — an older
 * worker answering a newer page.
 *
 * The name, the length and the genome together are the last resort, and as
 * close to identity as a run with neither number can get.
 */
function sameSequence(row: AxisSide, col: AxisSide): boolean {
  const a = row.group
  const b = col.group
  if (a === undefined || b === undefined) return false
  if (a.unitBin !== undefined && b.unitBin !== undefined) return a.unitBin === b.unitBin
  if (a.unitStart !== undefined && b.unitStart !== undefined) return a.unitStart === b.unitStart
  return a.label === b.label && a.unitLength === b.unitLength && row.genome === col.genome
}

/**
 * Whether a sideways scroll over a block slides along its diagonal while the
 * view is held on it (see `HeatmapView.setDiagonalSlide` and the diagonal
 * lock): wherever the block is **cis** and square, not turned into a band whose
 * diagonal already runs across the screen.
 *
 * Cis is two things, and both slide. The diagonal is in the picture where the
 * rows and the columns share a stretch of bins. And a block of **two stretches
 * of one sequence** — `chrI:1-100,000 × chrI:400,001-500,000`, what an
 * Option-drag off the diagonal opens — has its diagonal off the picture but is
 * read the same way, by separation: moving rows and columns together keeps
 * every band parallel to the diagonal, one distance apart, where it is under
 * the pointer, where a slide of the columns alone carried the reader across
 * separations they had not asked to leave. It used to take the columns alone,
 * as a trans block does.
 *
 * Trans stays as it was — two sequences, two genomes, where there is no
 * separation to keep — and so does every picture above bin level, whose cells
 * are whole sequences or genomes and slide along the diagonal exactly where
 * their axes share cells.
 */
export function slidesAlongDiagonal(
  data: Pick<MatrixResult, 'rowExtent' | 'colExtent' | 'level' | 'rowGroups' | 'colGroups'> &
    Partial<Pick<MatrixResult, 'rowGenomes' | 'colGenomes'>>,
  turned: RotatedBlock | null,
): boolean {
  if (turned !== null) return false
  const [r0, r1] = data.rowExtent
  const [c0, c1] = data.colExtent
  if (Math.max(r0, c0) < Math.min(r1, c1)) return true
  return data.level === 'bin' && oneSequence(data)
}

/**
 * Whether every run on both axes of a block is one and the same sequence.
 *
 * By {@link sameSequence}, the test the readout's distance already makes —
 * `unitBin` first, the identity that tells two windows of one contig from two
 * contigs that share a name in two MAGs — so the slide and the separation the
 * tooltip prints cannot disagree about whether a block is cis. A run holding
 * several small sequences is none of them.
 */
function oneSequence(
  data: Pick<MatrixResult, 'rowGroups' | 'colGroups'> & Partial<Pick<MatrixResult, 'rowGenomes' | 'colGenomes'>>,
): boolean {
  const sides = [
    ...data.rowGroups.map((group) => ({ group, genomes: data.rowGenomes })),
    ...data.colGroups.map((group) => ({ group, genomes: data.colGenomes })),
  ].map(({ group, genomes }): AxisSide => ({
    group,
    offset: group.start,
    blockStart: 0,
    genome: groupAt(genomes, group.start)?.label,
  }))
  const first = sides[0]
  if (first === undefined || data.rowGroups.length === 0 || data.colGroups.length === 0) return false
  return sides.every((side) => (side.group?.merged?.length ?? 1) <= 1 && sameSequence(first, side))
}

/**
 * Separator positions: the first row/column of every group after the first.
 *
 * The genome runs become the drawn boundaries only where the reader says so
 * (`genomeBoundaries`): the whole-metagenome overview, and a selection of
 * several genomes, which are the two pictures whose subject *is* genomes.
 * Elsewhere they are a fact the tooltip reports and not a line — a whole-genome
 * view of a metacool is still read contig by contig, and so is a handful of
 * ticked contigs, and moving those separators out to the genomes would coarsen
 * a picture nobody asked to have coarsened.
 */
export function separatorsFor(data: MatrixResult): SeparatorSet {
  const toSeparators = (groups: AxisGroup[]): Separator[] =>
    groups.map((group) => ({ at: group.start, label: group.label }))

  // A whole-metagenome view — or a map of several ticked MAGs — is a picture of
  // *genomes*. Where the reader marks its genome runs as the boundaries, those
  // are the only ones drawn: 20,000 contig hairlines over 4,000 genome blocks
  // is a grey wash, and it hides the block structure the view exists to show.
  // They go in both sets so the axis is also *labelled* by genome — the fine
  // set is what `labelBlocks` reads — while the heavier stroke, drawn at the
  // same coordinates, is what the eye lands on.
  const draw = data.genomeBoundaries === true
  const rowUnits = (draw ? data.rowGenomes : undefined) ?? data.rowGroups
  const colUnits = (draw ? data.colGenomes : undefined) ?? data.colGroups
  const set: SeparatorSet = {
    rows: toSeparators(rowUnits),
    cols: toSeparators(colUnits),
  }
  // The *same array*, not a second copy of it. Where the genome runs are the
  // boundaries they are both sets, and the renderer skips the fine pass when it
  // recognises the identity — otherwise it stroked several thousand hairlines
  // and then stroked the heavier line over exactly the same coordinates.
  if (draw && data.rowGenomes !== undefined) set.groupRows = set.rows
  if (draw && data.colGenomes !== undefined) set.groupCols = set.cols
  return set
}

/** Adapt a worker result to the renderer's {@link DenseMatrix}. */
export function toDense(data: MatrixResult): DenseMatrix {
  return {
    nrows: data.nrows,
    ncols: data.ncols,
    values: data.values,
    rowExtent: data.rowExtent,
    colExtent: data.colExtent,
  }
}
