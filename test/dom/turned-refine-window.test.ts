// @vitest-environment jsdom
/**
 * What a turned map tells the zoom it is showing (§2, §17).
 *
 * Its drawn columns are half-cells of the rotation and its rows distance from
 * the diagonal, so its window is the on-diagonal square of its columns. A block
 * read from a sibling rung — every block after the first, with *Refine on zoom*
 * on — was asked for its window as a square map's is: the band's rows read as
 * loci and its half-cells as cells, a window the view was not showing, which
 * the ladder read for, landed and read again on the next notch.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { MatrixPanel } from '@/ui/MatrixPanel'
import type { MatrixResult } from '@/worker/protocol'
import { setUpDom, type DomTeardown } from '../support/dom'

let teardown: DomTeardown
const panels: MatrixPanel[] = []

beforeEach(() => {
  teardown = setUpDom({ canvas: 'stub' })
})

afterEach(() => {
  for (const panel of panels.splice(0)) panel.destroy()
  teardown()
  vi.restoreAllMocks()
})

/**
 * A turned map of a 1 Mb window, opened at 1 kb — bins 1,000 to 2,000 — whose
 * block came from the 5 kb rung: 200 cells, counted on that rung's own grid.
 */
function turnedFromRung(): MatrixPanel {
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(600)
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(300)
  const panel = new MatrixPanel({ binsize: 1000, detachedControls: true, hideTitle: true, turn: { on: true } })
  panels.push(panel)
  document.body.append(panel.el)
  const n = 200
  panel.setResolution(5000)
  panel.setData(
    {
      nrows: n,
      ncols: n,
      values: new Float32Array(n * n).fill(1),
      rowExtent: [200, 400],
      colExtent: [200, 400],
      rowGroups: [{ label: 'IV', start: 0, end: n, unitStart: 200 }],
      colGroups: [{ label: 'IV', start: 0, end: n, unitStart: 200 }],
      level: 'bin',
      binsPerCell: 1,
      binsize: 5000,
      source: { rows: [1000, 2000], cols: [1000, 2000] },
    } as unknown as MatrixResult,
    'IV',
  )
  return panel
}

describe('a turned map read from a sibling rung', () => {
  it('reports the on-diagonal square of its columns, in the open map’s bins', () => {
    const panel = turnedFromRung()
    const view = panel.refineWindowNow()
    expect(view).not.toBeNull()
    // One stretch of genome on both axes — not the band's rows read as a place.
    expect(view?.rows).toEqual(view?.cols)
    // Inside the window it was read for, and the whole of it at a fitted view.
    const [lo, hi] = view?.cols ?? [0, 0]
    expect(lo).toBeGreaterThanOrEqual(1000)
    expect(hi).toBeLessThanOrEqual(2000)
    expect(hi - lo).toBeGreaterThan(900)
  })
})
