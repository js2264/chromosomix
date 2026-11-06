/**
 * Which rung a block is drawn from first, while the block itself is read (§7.2,
 * `ui/refine.ts`, `previewRung`).
 *
 * The coarsest stored rung that still puts {@link PREVIEW_MIN_CELLS} across the
 * window, and only where the block asked for is {@link PREVIEW_FACTOR} times
 * finer than that — measured against the grid the reader will actually read,
 * so a pooled read is not "previewed" by a picture as coarse as itself.
 */

import { describe, expect, it } from 'vitest'

import { POOLED_CELL_CAP } from '@/metacooler/pooling'
import { PREVIEW_FACTOR, PREVIEW_MIN_CELLS, gridFor, previewRung, rungsOf } from '@/ui/refine'
import type { Extent } from '@/types'

/** The 4DN chicken map's ladder (4DNFIRKUYKP4), a `.hic` opened at 25 kb. */
const CHICKEN = rungsOf(['1000', '2000', '5000', '10000', '25000', '50000', '100000', '250000', '500000', '1000000', '2500000', '5000000', '10000000'])
/** The lab's mouse `progenitors.mcool`, which lands on 80 kb. */
const MOUSE = rungsOf(['10000', '20000', '40000', '80000', '160000', '320000', '640000', '1280000', '2560000'])

/** A whole sequence of `bp` at `binsize`, as its bin extent. */
function whole(bp: number, binsize: number): Extent {
  return [0, Math.ceil(bp / binsize)]
}

describe('the rung a block is previewed from', () => {
  it('is the coarsest that still gives a picture, for a whole chromosome at the landing rung', () => {
    // Chicken chr1, 196 Mb, at 25 kb: 7,849 bins. 1 Mb is 196 cells — too few
    // to be the picture — and 500 kb is 393.
    const chr1 = whole(196_202_544, 25_000)
    expect(chr1[1]).toBe(7849)
    expect(previewRung(CHICKEN, chr1, chr1, 25_000)).toBe('500000')
    // Mouse chr1, 195 Mb, at 80 kb: 2,444 bins. 1.28 Mb is 153 cells, 640 kb is 306.
    const mouse = whole(195_471_971, 80_000)
    expect(previewRung(MOUSE, mouse, mouse, 80_000)).toBe('640000')
  })

  it('is none where the window is already about as coarse as a preview would be', () => {
    // The Human Hi-C example: chr8:126.8–130.2 Mb at 10 kb, 340 bins. A preview
    // of at least 256 cells cannot be four times coarser than 340.
    const myc: Extent = [12_680, 13_020]
    expect(previewRung(MOUSE, myc, myc, 10_000)).toBeUndefined()
    // Chicken chr1 at 250 kb, a reader who chose a coarse rung: 785 bins, and
    // the only coarser rung with 256 cells is 500 kb, half as fine — not a
    // quarter.
    const coarse = whole(196_202_544, 250_000)
    expect(previewRung(CHICKEN, coarse, coarse, 250_000)).toBeUndefined()
  })

  it('needs the asked block to be four times finer than the preview', () => {
    // 1,024 bins against a rung four times coarser is exactly 256 cells: drawn.
    const just: Extent = [0, PREVIEW_FACTOR * PREVIEW_MIN_CELLS]
    expect(previewRung(rungsOf(['1000', '4000']), just, just, 1000)).toBe('4000')
    // One bin fewer, and the rung that is four times coarser gives 255.75 cells.
    const short: Extent = [0, PREVIEW_FACTOR * PREVIEW_MIN_CELLS - 1]
    expect(previewRung(rungsOf(['1000', '4000']), short, short, 1000)).toBeUndefined()
  })

  it('is measured against the grid the reader will pool to, not the file’s bins', () => {
    // Mouse chr1 at 10 kb, 19,547 bins: past what is read bin for bin, so the
    // first read is pooled to a grid of five bins a cell — 3,910 cells, a 50 kb
    // picture. The preview must be a quarter of *that*: 640 kb is 306 cells.
    const chr1 = whole(195_471_971, 10_000)
    expect(gridFor(chr1, chr1)).toBe(5)
    expect(previewRung(MOUSE, chr1, chr1, 10_000)).toBe('640000')
    // A window wider than any raster is pooled on every device: 81,920 bins of
    // 1 kb into twenty a cell, 4,096 cells. A 40 kb rung is 2,048 cells — half
    // the asked grid, not a quarter — so it is no preview; 160 kb's 512 is.
    const pooled: Extent = [0, 20 * POOLED_CELL_CAP]
    expect(gridFor(pooled, pooled)).toBe(20)
    expect(previewRung(rungsOf(['1000', '20000', '40000']), pooled, pooled, 1000)).toBeUndefined()
    expect(previewRung(rungsOf(['1000', '40000', '160000']), pooled, pooled, 1000)).toBe('160000')
  })

  it('takes the wider axis of a block between two windows', () => {
    const rows: Extent = [0, 2000]
    const cols: Extent = [10_000, 10_400]
    // 2,000 bins of 1 kb against 4 kb: 500 cells across the wider axis.
    expect(previewRung(rungsOf(['1000', '4000', '8000']), rows, cols, 1000)).toBe('4000')
  })

  it('is none on a file with nothing coarser, or with nothing to read', () => {
    const chr1 = whole(196_202_544, 25_000)
    expect(previewRung([], chr1, chr1, 25_000)).toBeUndefined()
    expect(previewRung(rungsOf(['10000', '25000']), chr1, chr1, 25_000)).toBeUndefined()
    expect(previewRung(CHICKEN, [5, 5], [5, 5], 25_000)).toBeUndefined()
    expect(previewRung(CHICKEN, chr1, chr1, 0)).toBeUndefined()
  })
})
