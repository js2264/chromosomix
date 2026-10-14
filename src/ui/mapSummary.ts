/**
 * The line under a map, in words: how large the block is, what one cell of it
 * is worth, whether the picture is pooled, and which window is on screen.
 *
 * Several views print this line under their heading — the genome, pair, region,
 * whole-file and overview pictures each give the block's size and resolution —
 * and the panel writes its window half on every frame that moves the window.
 * Five wordings of one fact is how they drift, so the words are made here, once,
 * and every one of them asks.
 *
 * Out of `ui/MatrixPanel.ts` because none of it is the panel's: the panel is one
 * caller among several. The phrases are pure but for the `<strong>` that marks
 * the resolution, and the refine preference that decides what the pooling note
 * promises a zoom will do.
 */

import { formatLocus } from '../genome/assembly'
import { rasterStride } from '../render/heatmap'
import type { LocusWindow } from '../render/locus'
import { resolutionLabel } from '../units'
import type { MatrixResult } from '../worker/protocol'
import { el, fmt } from './dom'
import { refineEnabled } from './refine'

/**
 * The window one axis currently shows, in the grammar the region box takes.
 *
 * `formatLocus` rather than a fourth hand-rolled `contig:start-end`: what the
 * line shows has to be what the box would accept, or copying a coordinate out of
 * the subtitle and into the box moves the picture by a base.
 *
 * A whole-genome axis is several sequences at once and naming sixteen of them is
 * a paragraph, so past two they are counted instead — the same choice
 * `BrowserView.zoomPhrase` makes with "4 of 16 sequences", and for the same
 * reason: the line has to stay a line.
 */
export function windowPhrase(windows: readonly LocusWindow[]): string {
  if (windows.length === 0) return ''
  const span = windows.reduce((total, window) => total + (window.end - window.start), 0)
  const where =
    windows.length === 1
      ? formatLocus(windows[0])
      : windows.length === 2
        ? `${formatLocus(windows[0])} + ${formatLocus(windows[1])}`
        : `${fmt.int(windows.length)} sequences`
  return `${where} · ${fmt.bp(span)}`
}

/**
 * Both axes of what is on screen, said once when they agree.
 *
 * On the diagonal the two windows are one window, and printing it twice says the
 * picture is of two things when it is of one. Off it — a genome pair, a
 * `contig × contig` block, a region against a second region — they are genuinely
 * different and both are named.
 */
export function framedPhrase(
  rows: readonly LocusWindow[],
  cols: readonly LocusWindow[],
): string {
  const rowText = windowPhrase(rows)
  const colText = windowPhrase(cols)
  if (rowText === '') return colText
  if (colText === '' || rowText === colText) return rowText
  return `${rowText} × ${colText}`
}

/**
 * What to say when the picture is coarser than the data.
 *
 * A block wider than {@link RASTER_MAX_DIM} is drawn through a pooled raster:
 * one pixel per `stride x stride` block of cells, carrying the strongest value
 * under it. That is the right trade — a 12,975-bin genome at one pixel per bin
 * is 585 MB of RGBA for an image no screen can show, and the *maximum* is what
 * keeps a sparse map's bright cell from being averaged into its empty
 * neighbours — but until now nothing said it was happening. The summary claimed
 * "12,975 x 12,975 cells rendered", the crosshair then reported four different
 * coordinates and four different values inside one visible square, and there
 * was no way to tell which of the two was lying.
 *
 * Two things a reader needs and cannot deduce: that the picture is pooled, and
 * what that means for zooming into it.
 *
 * The second half used to be flat — *zooming does not sharpen it, so the answer
 * is to open a smaller block* — and for a long time that was the truth. It is
 * now a question about a setting: with refinement on (`ui/refine.ts`) a settled
 * zoom reads the window again at a finer grid and the picture does sharpen, down
 * to the file's own bins; with it off, the old sentence holds exactly. So the
 * note says which, rather than asserting one of them at a reader who is looking
 * at the other.
 *
 * `null` when every cell has its own pixel, which is every region and nearly
 * every MAG.
 */
export function poolingNote(
  nrows: number,
  ncols: number,
  refining = refineEnabled(),
): { phrase: string } | null {
  const strideY = rasterStride(nrows)
  const strideX = rasterStride(ncols)
  if (strideX === 1 && strideY === 1) return null
  return {
    phrase: `aggregated ${strideX} × ${strideY} bins to a pixel${
      refining ? ' · zoom in to sharpen' : ' · open a smaller block to sharpen'
    }`,
  }
}

/**
 * What one cell of the picture is worth, in the reader's units.
 *
 * The grid a block is read on is rarely the file's own — anything larger than a
 * picture is summed into coarser cells on the way through — and "30 bins each"
 * asks the reader to do the multiplication. The resolution is the number they
 * would quote in a methods section, so it is the number said here, and the bin
 * count is left to the summary that already gives it.
 *
 * There are two ways for a cell to stop being a bin, and neither has a width to
 * quote. Above one sequence per cell the sequences in it have different lengths
 * and the cell is their sum. Above bin *level* a cell is a whole sequence by
 * construction, and `1 contig per cell` is not news — the axis already says so.
 * Both come back empty and the caller says nothing rather than something false.
 */
export function resolutionNote(
  binsize: number,
  result: {
    binsPerCell?: number
    contigsPerCell?: number
    level?: MatrixResult['level']
    /**
     * The bin size of the map that actually answered, where a read came from a
     * sibling rung (`worker/protocol.ts`). It wins over the caller's, which is
     * the *open* map's — a caller passing its own would caption a block read at
     * 2 kb with the 1 kb the session was opened at, and this is the one number
     * on the line that changes what the picture means.
     */
    binsize?: number
  },
  noun = 'sequence',
): string {
  binsize = result.binsize ?? binsize
  if ((result.level ?? 'bin') !== 'bin') {
    const per = result.contigsPerCell ?? 1
    return per > 1 ? `${fmt.int(per)} ${noun}s per cell, summed` : ''
  }
  // A cell is a capacity of bins, so it has a width even where several small
  // sequences share it — the cell spans that many base pairs of sequence, in
  // more than one piece. Which sequences those are is the readout's to say, and
  // the list beside the map's; it is not a second resolution.
  return `effective resolution: ${resolutionLabel(binsize * (result.binsPerCell ?? 1))}`
}

/**
 * The line under a map: how large the picture is, and what one cell of it is
 * worth.
 *
 * Two facts and no third, in one place, because four views draw this line and
 * four wordings of one fact is how they drift. Which sequences are on the axes
 * is the title's job; whether the values are balanced is the colourbar's, which
 * is titled in the units it is drawn in and sits beside the numbers it applies
 * to.
 *
 * **The count is the cells, and they are called bins.** That is the honest
 * pairing: a cell of the picture *is* a bin of the effective resolution, so
 * `4,046 × 4,046 bins` at `3.0 kb` multiplies out to the 12.1 Mb that is on
 * screen. Counting the file's own bins instead would put `5,769 bins` beside
 * `200 bp` for a 577 kb chromosome, and the two numbers on one line would
 * describe something twice its size. Above one sequence per cell there is no bin
 * to speak of and they are cells again.
 */
export function blockSummary(
  binsize: number,
  result: MatrixResult,
  noun = 'sequence',
): Array<string | HTMLElement> {
  // What the cells *are*. At bin level they are bins of the effective
  // resolution, which is the pairing that multiplies out to what is on screen.
  // Above it they are the unit the axis is already drawn in, and a roll-up that
  // had to merge them is cells.
  const unit =
    result.level === 'bin'
      ? 'bins'
      : (result.contigsPerCell ?? 1) > 1
      ? 'cells'
      : `${noun}s`
  const resolution = resolutionNote(binsize, result, noun)
  const parts: Array<string | HTMLElement> = [
    `${fmt.int(result.nrows)} × ${fmt.int(result.ncols)} ${unit}`,
  ]
  if (resolution !== '') {
    parts.push(' · ')
    // Bold because it is the one number here that changes what the picture
    // *means*: the same map at 200 bp and at 3 kb are different figures, and a
    // reader scanning the line is looking for that.
    parts.push(el('strong', { text: resolution }))
  }
  return parts
}
