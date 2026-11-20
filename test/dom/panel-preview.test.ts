// @vitest-environment jsdom
/**
 * A coarse stand-in on screen while the asked block reads (§7.2,
 * `MatrixPanel.setPreview`).
 *
 * The preview is drawn as any block is, and it is **live**: it takes the
 * reader's gestures at once, with the spinner turning in its corner and no
 * freeze. The block it stands in for lands on the window the reader arrived at,
 * or fitted where they did not move, and what has no business acting on a
 * stand-in waits for the block: the Export card's buttons, and every analysis,
 * whose framing and borrowed block would otherwise be in another rung's bins.
 *
 * It is not the first picture the session waits for either: the tracks, the
 * census and the circularity check (`app/pictureGate.ts`) are let go by the
 * block the reader asked for, as they were before there was a preview.
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
  for (const panel of built.splice(0, built.length)) panel.destroy()
  teardown()
})

/** Chromosome IV, its first 256 kb, at `binsize`: one sequence against itself. */
function block(binsize: number): MatrixResult {
  const bins = 256_000 / binsize
  return {
    nrows: bins,
    ncols: bins,
    values: new Float32Array(bins * bins).fill(1),
    rowExtent: [0, bins],
    colExtent: [0, bins],
    rowGroups: [{ label: 'IV', start: 0, end: bins, unitStart: 0 }],
    colGroups: [{ label: 'IV', start: 0, end: bins, unitStart: 0 }],
    level: 'bin',
    binsPerCell: 1,
    binsize,
  } as unknown as MatrixResult
}

function panel(): MatrixPanel {
  const it = new MatrixPanel({ binsize: 1000 })
  built.push(it)
  document.body.append(it.el)
  return it
}

/** The stand-in at 4 kb, drawn as `RegionView.preview` draws it. */
function previewed(): MatrixPanel {
  const it = panel()
  it.setResolution(4000)
  it.setPreview(block(4000), 'IV')
  return it
}

/** The asked block at 1 kb, landed as `RegionView.load` lands it. */
function land(it: MatrixPanel): void {
  it.setResolution(1000)
  it.setData(block(1000), 'IV')
}

/** Whether `firstData` has settled, after the microtasks a settle takes. */
async function settled(promise: Promise<void>): Promise<boolean> {
  let done = false
  void promise.then(() => (done = true))
  for (let turn = 0; turn < 4; turn++) await Promise.resolve()
  return done
}

function frozen(it: MatrixPanel): boolean {
  return it.el.querySelector('canvas.is-frozen') !== null
}

/** The Export card's two buttons: save, then copy. */
function exportButtons(it: MatrixPanel): HTMLButtonElement[] {
  return [...it.exportEl.querySelectorAll<HTMLButtonElement>('.export-acts button')]
}

function exportNote(it: MatrixPanel): string {
  return it.exportEl.querySelector('.export-note')?.textContent ?? ''
}

describe('a preview', () => {
  it('is drawn live, and is not the first picture the session waits for', async () => {
    const it = previewed()
    expect(frozen(it)).toBe(false)
    expect(await settled(it.firstData)).toBe(false)
    // It takes a window as the reader's gestures and a locked deck give one.
    expect(it.previewMoved).toBe(false)
    expect(it.showLocus({ contig: 'IV', start: 100_000, end: 140_000 })).toBe(true)
    expect(it.previewMoved).toBe(true)
  })

  it('gives way to the block it stood in for, which lets everything go', async () => {
    const it = previewed()
    land(it)
    expect(frozen(it)).toBe(false)
    expect(it.previewMoved).toBe(false)
    expect(await settled(it.firstData)).toBe(true)
  })

  it('lets its block land fitted where the reader did not move it', () => {
    const it = previewed()
    land(it)
    const shown = it.framedRegion()
    expect(shown?.start).toBe(0)
    expect(shown?.end).toBe(256_000)
  })

  it('lands its block on the window the reader moved it to', () => {
    const it = previewed()
    it.showLocus({ contig: 'IV', start: 100_000, end: 140_000 })
    // Read on the stand-in's 4 kb grid, rounded out to its cells.
    const before = it.framedRegion()
    expect(before).not.toBeNull()
    expect((before?.end ?? 0) - (before?.start ?? 0)).toBeLessThan(200_000)
    land(it)
    const after = it.framedRegion()
    // The same stretch of genome on the 1 kb grid: inside the stand-in's
    // rounded window, by less than one of its cells at each edge.
    expect(after).not.toBeNull()
    expect(Math.abs((after?.start ?? 0) - (before?.start ?? 0))).toBeLessThan(4000)
    expect(Math.abs((after?.end ?? 0) - (before?.end ?? 0))).toBeLessThan(4000)
  })

  it('holds the Export card back until the block is in', () => {
    const it = previewed()
    const buttons = exportButtons(it)
    expect(buttons.length).toBe(2)
    for (const button of buttons) expect(button.disabled).toBe(true)
    expect(exportNote(it)).toMatch(/stand-in/)
    // The key says the same rather than saving the stand-in.
    it.savePlot()
    expect(exportNote(it)).toMatch(/stand-in/)
    land(it)
    for (const button of exportButtons(it)) expect(button.disabled).toBe(false)
    expect(exportNote(it)).toBe('')
  })

  it('frames no analysis on the stand-in, and lends it to none', () => {
    const it = previewed()
    expect(it.analysisFraming('IV.cool::/resolutions/1000')).toBeNull()
    expect(it.analysisBlock()).toBeNull()
    land(it)
    const framing = it.analysisFraming('IV.cool::/resolutions/1000')
    expect(framing?.binsize).toBe(1000)
    expect(framing?.cols).toEqual([0, 256])
    expect(it.analysisBlock()).not.toBeNull()
  })

  it('takes nothing back when the read it waited for fails', async () => {
    const it = previewed()
    it.endPreview()
    expect(frozen(it)).toBe(false)
    expect(it.previewMoved).toBe(false)
    // The stand-in is the picture there is: exported as one, labelled at its
    // own resolution, but still no framing for an analysis, whose extents
    // would be in the stand-in's bins under the view's file.
    for (const button of exportButtons(it)) expect(button.disabled).toBe(false)
    expect(it.analysisFraming('IV.cool::/resolutions/1000')).toBeNull()
    // Still not the picture asked for: the session's cap, or the panel going
    // away, lets the held work go.
    expect(await settled(it.firstData)).toBe(false)
  })

  it('leaves a picture with no preview as it was', async () => {
    const it = panel()
    it.setData(block(1000), 'IV')
    expect(frozen(it)).toBe(false)
    expect(await settled(it.firstData)).toBe(true)
    it.endPreview()
    expect(frozen(it)).toBe(false)
    for (const button of exportButtons(it)) expect(button.disabled).toBe(false)
    expect(it.analysisFraming('IV.cool::/resolutions/1000')).not.toBeNull()
  })
})
