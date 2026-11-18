// @vitest-environment jsdom
/**
 * The region a map names, as the deck's gate compares it (§16.4,
 * `MatrixPanel.frameSpan`) — across a turn.
 *
 * Pressing the turn re-runs the derivation from the top on the block in hand,
 * and that used to frame the region again from whatever that block was. After a
 * zoom it is a window a refine read inside the region (§2), so two copies of
 * one yeast file in a deck were framed on their own refines' windows, 800 bp
 * apart, and the second was told the same name had resolved against different
 * sequences. And a turned frame was the band — rows cut at the zoom of the
 * moment — so a first map stepped on to chrV from deep inside IV was framed as
 * reaching 800 bp from the diagonal, and its companion refused on that.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

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

/** IV's bins `[from, from + bins)` against themselves, one cell per bin. */
function block(from: number, bins: number): MatrixResult {
  return {
    nrows: bins,
    ncols: bins,
    values: new Float32Array(bins * bins).fill(1),
    rowExtent: [from, from + bins],
    colExtent: [from, from + bins],
    rowGroups: [{ label: 'IV', start: 0, end: bins, unitStart: from }],
    colGroups: [{ label: 'IV', start: 0, end: bins, unitStart: from }],
    level: 'bin',
    binsPerCell: 1,
  } as unknown as MatrixResult
}

function panel(turned: boolean): MatrixPanel {
  const it = new MatrixPanel({
    binsize: 1600,
    turn: { on: turned, onChange: () => {}, onAvailable: () => {} },
  })
  built.push(it)
  document.body.append(it.el)
  return it
}

/** The frame, without the tolerance's sequence counts. */
function frame(it: MatrixPanel): { rows: number; cols: number; bpPerCell: number } | null {
  const span = it.frameSpan()
  return span === null ? null : { rows: span.rows, cols: span.cols, bpPerCell: span.bpPerCell }
}

describe('the region a map names, across a turn', () => {
  it('is the square the turn rotates, not the depth the band was cut to', () => {
    const it = panel(true)
    it.setData(block(0, 958), 'IV')
    expect(it.isTurned()).toBe(true)
    // 958 bins of 1.6 kb along both axes; the band itself is cut to the box.
    expect(frame(it)).toEqual({ rows: 958 * 1600, cols: 958 * 1600, bpPerCell: 1600 })
    expect(it.blockSpan().rows).not.toBe(958 * 1600)
  })

  it('is not framed again on the window a refine read when the turn is pressed', () => {
    const it = panel(false)
    it.setData(block(0, 958), 'IV')
    const whole = frame(it)
    // A zoom refines: 800 bp bins over a window inside IV.
    it.setResolution(800)
    expect(it.regrid(block(223, 1469), 800)).toBe(true)
    expect(frame(it)).toEqual(whole)
    // The turn, and back: the block in hand is the refine's, and the region
    // the view names is still the whole of IV at the grid it was first drawn on.
    it.rederive(undefined, undefined, { on: true, onChange: () => {} })
    expect(it.isTurned()).toBe(true)
    expect(frame(it)).toEqual(whole)
    it.rederive(undefined, undefined, { on: false, onChange: () => {} })
    expect(it.isTurned()).toBe(false)
    expect(frame(it)).toEqual(whole)
  })

  it('is framed again by a block a navigation brings', () => {
    const it = panel(true)
    it.setData(block(0, 958), 'IV')
    it.setData(block(0, 361), 'V')
    expect(frame(it)).toEqual({ rows: 361 * 1600, cols: 361 * 1600, bpPerCell: 1600 })
  })
})
