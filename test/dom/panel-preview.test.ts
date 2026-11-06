// @vitest-environment jsdom
/**
 * A coarse stand-in on screen while the asked block reads (§7.2,
 * `MatrixPanel.setPreview`).
 *
 * The preview is drawn as any block is, and then held still with the spinner
 * turning — the refine ladder's freeze — until the block it stands in for is
 * drawn. It is not the first picture the session waits for: the tracks, the
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

/** One sequence against itself, at `bins` cells a side. */
function block(bins: number, binsize: number): MatrixResult {
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

describe('a preview', () => {
  it('is drawn and held, and is not the first picture the session waits for', async () => {
    const it = panel()
    it.setResolution(4000)
    it.setPreview(block(64, 4000), 'IV')
    expect(frozen(it)).toBe(true)
    expect(await settled(it.firstData)).toBe(false)
  })

  it('gives way to the block it stood in for, which lets everything go', async () => {
    const it = panel()
    it.setResolution(4000)
    it.setPreview(block(64, 4000), 'IV')
    it.setResolution(1000)
    it.setData(block(256, 1000), 'IV')
    expect(frozen(it)).toBe(false)
    expect(await settled(it.firstData)).toBe(true)
  })

  it('takes gestures again when the read it waited for fails', async () => {
    const it = panel()
    it.setPreview(block(64, 4000), 'IV')
    it.endPreview()
    expect(frozen(it)).toBe(false)
    // Still not the picture asked for: the session's cap, or the panel going
    // away, lets the held work go.
    expect(await settled(it.firstData)).toBe(false)
  })

  it('leaves a picture with no preview as it was', async () => {
    const it = panel()
    it.setData(block(256, 1000), 'IV')
    expect(frozen(it)).toBe(false)
    expect(await settled(it.firstData)).toBe(true)
    it.endPreview()
    expect(frozen(it)).toBe(false)
  })
})
