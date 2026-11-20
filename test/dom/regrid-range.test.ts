// @vitest-environment jsdom
/**
 * The colour range across a refine (§2, `MatrixPanel.gaugeFor`).
 *
 * The widest block wins: a finer block of a window already on screen keeps the
 * range the wider one was measured to, so a zoom changes the sharpness and not
 * the brightness. Only a block that is *wider* re-measures — a reader pulling
 * back past what was read.
 *
 * "Wider" is by more than a cell of either grid. The same window read on two
 * grids ends at two cell edges, since a sequence's last bin is short by a
 * different amount on each: a 100 kb block of a whole chromosome is a few
 * kilobases longer than the 250 kb block it refines. Taking that for a wider
 * block re-measured the range on every first refine of a chromosome, and the
 * order statistics of its millions of cells were the longest stall of a zoom.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { HeatmapView } from '@/render/heatmap'
import { MatrixPanel } from '@/ui/MatrixPanel'
import type { MatrixResult } from '@/worker/protocol'
import { setUpDom, type DomTeardown } from '../support/dom'

let teardown: DomTeardown
const built: MatrixPanel[] = []

beforeEach(() => {
  teardown = setUpDom({ canvas: 'stub' })
})

afterEach(() => {
  for (const panel of built.splice(0)) panel.destroy()
  teardown()
})

/** chr1, `bins` cells of `binsize` from its start, every cell holding `value`. */
function block(bins: number, binsize: number, value: number): MatrixResult {
  const values = new Float32Array(bins * bins)
  for (let i = 0; i < values.length; i++) values[i] = value * (1 + (i % 7))
  return {
    nrows: bins,
    ncols: bins,
    values,
    rowExtent: [0, bins],
    colExtent: [0, bins],
    rowGroups: [{ label: 'chr1', start: 0, end: bins, unitStart: 0 }],
    colGroups: [{ label: 'chr1', start: 0, end: bins, unitStart: 0 }],
    level: 'bin',
    binsPerCell: 1,
    binsize,
  } as unknown as MatrixResult
}

function panel(): MatrixPanel {
  const it = new MatrixPanel({ binsize: 250_000 })
  built.push(it)
  document.body.append(it.el)
  return it
}

/**
 * What the panel hands its view to measure the range from, block by block: the
 * `gauge` of each `HeatmapView.regrid`. `null` measures the incoming block
 * itself; the widest block's square is handed over once, and `undefined` then
 * keeps the range the view already holds.
 *
 * Said in a word rather than kept as the square: a failed assertion prints what
 * it received, and printing fifteen million cells ran the test process out of
 * memory instead of failing it.
 */
function gauges(it: MatrixPanel): string[] {
  const view = (it as unknown as { heatmap: HeatmapView }).heatmap
  const seen: string[] = []
  const regrid = view.regrid.bind(view)
  vi.spyOn(view, 'regrid').mockImplementation((matrix, window, options) => {
    const gauge = options?.gauge
    seen.push(gauge === null ? 'measured' : gauge === undefined ? 'kept' : `square of ${gauge.nrows}`)
    return regrid(matrix, window, options)
  })
  return seen
}

describe('the colour range across a refine', () => {
  it('is kept when the finer block is longer only by where its last cell ends', () => {
    const it = panel()
    // 785 cells of 250 kb is 196.25 Mb; 1,963 of 100 kb is 196.3 Mb.
    it.setData(block(785, 250_000, 100), 'chr1')
    const seen = gauges(it)
    it.setResolution(100_000)
    expect(it.regrid(block(1_963, 100_000, 1), 100_000)).toBe(true)
    // The 250 kb block's own square, not the incoming one measured afresh.
    expect(seen[0]).toBe('square of 785')
    it.setResolution(20_000)
    expect(it.regrid(block(2_000, 20_000, 1), 20_000)).toBe(true)
    expect(seen[1]).toBe('kept')
  })

  it('is measured again on a block coarser than the one it came from', () => {
    // Back to auto on a zoomed 100 kb view measures 100 kb cells. A coarser
    // block of no wider a window holds numbers several times larger, and kept,
    // that range saturates it.
    const it = panel()
    it.setData(block(785, 250_000, 100), 'chr1')
    it.setResolution(100_000)
    it.regrid(block(1_963, 100_000, 4), 100_000)
    it.controlsEl.querySelector<HTMLButtonElement>('.clip-auto')?.click()
    const seen = gauges(it)
    it.setResolution(250_000)
    expect(it.regrid(block(785, 250_000, 8), 250_000)).toBe(true)
    expect(seen[0]).toBe('measured')
    // And finer from there is a zoom again: the range is kept.
    it.setResolution(100_000)
    expect(it.regrid(block(1_963, 100_000, 1), 100_000)).toBe(true)
    expect(seen[1]).toBe('square of 785')
  })

  it('is measured again on the block of a resolution picked, finer or not, and only once', () => {
    // A pick is the reader changing the resolution rather than the
    // magnification (§3.4): read in place, its block is measured as a map
    // opened at that rung was — kept, a 250 kb range left a picked 25 kb
    // map pale but for its diagonal.
    const it = panel()
    it.setData(block(785, 250_000, 100), 'chr1')
    const seen = gauges(it)
    it.refineNow({ measureAt: 25_000 })
    it.setResolution(25_000)
    expect(it.regrid(block(7_850, 25_000, 1), 25_000)).toBe(true)
    expect(seen[0]).toBe('measured')
    // The next refine is a zoom again, and keeps it.
    it.setResolution(10_000)
    expect(it.regrid(block(2_000, 10_000, 1), 10_000)).toBe(true)
    expect(seen[1]).not.toBe('measured')
  })

  it('is measured on the cells in view when the reader asks for auto, and kept', () => {
    // Kept across a refine, the range is a range for wherever the reader was
    // when it was measured; auto is a range for where they are now.
    const it = panel()
    it.setData(block(785, 250_000, 100), 'chr1')
    const view = (it as unknown as { heatmap: HeatmapView }).heatmap
    const measured: Array<{ nrows: number; ncols: number } | null> = []
    const setGauge = view.setGauge.bind(view)
    vi.spyOn(view, 'setGauge').mockImplementation((gauge) => {
      measured.push(gauge === null ? null : { nrows: gauge.nrows, ncols: gauge.ncols })
      setGauge(gauge)
    })
    view.showCellWindow([100, 200], [100, 200])
    const shown = view.cellWindow()
    it.controlsEl.querySelector<HTMLButtonElement>('.clip-auto')?.click()
    expect(measured).toHaveLength(1)
    // The window's cells, and not the block's 785.
    const across = Math.ceil(shown.cols[1]) - Math.floor(shown.cols[0])
    expect(measured[0]?.ncols).toBe(across)
    expect(measured[0]?.nrows).toBeLessThan(785)
    // A refine of that window keeps it, as it keeps any range.
    const seen = gauges(it)
    it.setResolution(100_000)
    expect(it.regrid(block(1_963, 100_000, 1), 100_000)).toBe(true)
    expect(seen[0]).toBe('kept')
  })

  it('is measured again on a block wider by more than a cell', () => {
    const it = panel()
    it.setData(block(400, 250_000, 100), 'chr1')
    const seen = gauges(it)
    // Twice the window, at the same grid: a reader pulling back.
    expect(it.regrid(block(800, 250_000, 1), 250_000)).toBe(true)
    expect(seen[0]).toBe('measured')
  })
})
