// @vitest-environment jsdom
/**
 * An automatic colour range follows a view off the diagonal (§7.1).
 *
 * Kept, the range measured round the diagonal is a floor most of the field
 * away from it is under — contacts fall by orders of magnitude with distance —
 * so a map dragged off the line drew white though every block had been read.
 * Measured on the view once it stands still, and the line's own range put
 * back on the way back onto it; never over a bound the reader typed.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { HeatmapView } from '@/render/heatmap'
import { resetDiagonalLock, setDiagonalLocked } from '@/ui/diagonalLock'
import { MatrixPanel } from '@/ui/MatrixPanel'
import type { MatrixResult } from '@/worker/protocol'
import { setUpDom, type DomTeardown } from '../support/dom'

let teardown: DomTeardown
const panels: MatrixPanel[] = []

beforeEach(() => {
  teardown = setUpDom({ canvas: 'stub' })
  // Let go, as a reader who wants to look off the line has.
  setDiagonalLocked(false)
})

afterEach(() => {
  for (const panel of panels.splice(0)) panel.destroy()
  teardown()
  vi.restoreAllMocks()
  resetDiagonalLock()
})

/** A 400-bin map whose contacts fall with distance from the diagonal, as Hi-C's do. */
function decaying(): MatrixPanel {
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(400)
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(400)
  const panel = new MatrixPanel({ binsize: 1000, detachedControls: true, hideTitle: true })
  panels.push(panel)
  document.body.append(panel.el)
  const n = 400
  const values = new Float32Array(n * n)
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) values[i * n + j] = 1 / (1 + Math.abs(i - j)) ** 1.5
  panel.setData(
    {
      nrows: n,
      ncols: n,
      values,
      rowExtent: [0, n],
      colExtent: [0, n],
      rowGroups: [{ label: 'IV', start: 0, end: n, unitStart: 0 }],
      colGroups: [{ label: 'IV', start: 0, end: n, unitStart: 0 }],
      level: 'bin',
      binsPerCell: 1,
    } as unknown as MatrixResult,
    'IV',
  )
  return panel
}

/** Long enough for a frame and the 250 ms the view must stand still. */
const stand = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 450))

/** The gauges handed over, as the cells they were measured on. */
function gauges(): Array<{ nrows: number; ncols: number }> {
  const handed: Array<{ nrows: number; ncols: number }> = []
  vi.spyOn(HeatmapView.prototype, 'setGauge').mockImplementation(function (this: HeatmapView, gauge) {
    if (gauge !== null) handed.push({ nrows: gauge.nrows, ncols: gauge.ncols })
  })
  return handed
}

describe('a view dragged off the diagonal', () => {
  it('is measured on what is in view once it stands still, and given the line’s range back on the way back', async () => {
    const panel = decaying()
    const handed = gauges()
    // A hundred bins against a hundred two hundred bins away: off the line.
    panel.showViewport([0, 100], [250, 350])
    await stand()
    expect(handed.length).toBe(1)
    expect(handed[0].nrows).toBeLessThanOrEqual(101)
    expect(handed[0].ncols).toBeLessThanOrEqual(101)
    // Back on the line: the range it had there, measured on the whole block,
    // put back — once.
    panel.showViewport([150, 250], [150, 250])
    await stand()
    expect(handed.length).toBe(2)
    expect(handed[1]).toEqual({ nrows: 400, ncols: 400 })
    panel.showViewport([160, 260], [160, 260])
    await stand()
    expect(handed.length).toBe(2)
  })

  it('leaves a range alone along the diagonal', async () => {
    const panel = decaying()
    const handed = gauges()
    panel.showViewport([100, 200], [100, 200])
    await stand()
    expect(handed).toHaveLength(0)
  })

  it('never moves a bound the reader typed', async () => {
    const panel = decaying()
    panel.applyScale({ vmin: 0, vmax: 0.5 })
    const handed = gauges()
    panel.showViewport([0, 100], [250, 350])
    await stand()
    expect(handed).toHaveLength(0)
  })
})
