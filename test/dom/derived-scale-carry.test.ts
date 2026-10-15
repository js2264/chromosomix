// @vitest-environment jsdom
/**
 * The scale a derivation takes over, and gives back, across a rebuild of the
 * map (§7.5).
 *
 * A ratio or an O/E takes the transform, the ramp and the clip and gives all
 * three back when it is switched off. A change of comparison rebuilds the
 * panel, so the give-back has to outlive the panel that took them: the split
 * after a ratio was drawn on the ratio's `log2` and diverging ramp, because the
 * new panel was seeded from the hash — which holds what the ratio drew with —
 * and had nothing to give back. What is asserted here is the panel's half: a
 * scale carried in (`initial.restore`) is given back where nothing is derived
 * and kept where something is, and a seed that already is the borrowed scale
 * gives back the map's defaults rather than itself.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { MatrixPanel, type BorrowedScale, type MatrixPanelOptions } from '@/ui/MatrixPanel'
import type { MatrixResult } from '@/worker/protocol'
import { setUpDom, type DomTeardown } from '../support/dom'

let teardown: DomTeardown
const built: MatrixPanel[] = []

beforeEach(() => {
  teardown = setUpDom({ canvas: 'stub' })
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(400)
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(400)
})

afterEach(() => {
  for (const panel of built.splice(0, built.length)) panel.destroy()
  vi.restoreAllMocks()
  teardown()
})

const N = 16

/** One sequence's counts, falling off with distance. */
function block(): MatrixResult {
  const values = new Float32Array(N * N)
  for (let r = 0; r < N; r++) {
    for (let c = 0; c < N; c++) values[r * N + c] = 40 / (1 + Math.abs(r - c))
  }
  return {
    nrows: N,
    ncols: N,
    values,
    rowExtent: [0, N],
    colExtent: [0, N],
    rowGroups: [{ label: 'IV', start: 0, end: N, unitStart: 0 }],
    colGroups: [{ label: 'IV', start: 0, end: N, unitStart: 0 }],
    level: 'bin',
    binsPerCell: 1,
  } as unknown as MatrixResult
}

const DEFAULTS = { transform: 'log10', colormap: 'default' } as const

/** A panel on a block, with every scale it announced. */
function mapOf(
  initial: MatrixPanelOptions['initial'],
  options: { expected?: boolean } = {},
): { panel: MatrixPanel; announced: BorrowedScale[] } {
  const announced: BorrowedScale[] = []
  const panel = new MatrixPanel({
    binsize: 1000,
    detachedControls: true,
    hideTitle: true,
    initial,
    derive: { expected: options.expected === true, smooth: '0', correlate: false, baseline: false },
    onScaleChange: (scale) => announced.push(scale),
  })
  built.push(panel)
  document.body.append(panel.el)
  panel.setData(block(), 'IV')
  return { panel, announced }
}

describe('a derivation’s scale across a rebuild', () => {
  it('is taken over by an O/E, and named as what to carry', () => {
    const { panel, announced } = mapOf({ transform: 'log10', colormap: 'default', defaults: DEFAULTS }, { expected: true })
    expect(announced.at(-1)).toMatchObject({ transform: 'log2', colormap: 'RdBu_r' })
    expect(panel.borrowedFrom()).toEqual({ transform: 'log10', colormap: 'default' })
  })

  it('carries nothing where nothing is derived', () => {
    const { panel, announced } = mapOf({ transform: 'log10', colormap: 'default', defaults: DEFAULTS })
    expect(announced).toEqual([])
    expect(panel.borrowedFrom()).toBeNull()
  })

  it('is given back by the rebuilt map when it no longer derives anything', () => {
    // The split after a ratio: seeded from the hash, which holds the ratio's
    // scale, and carried what the ratio had taken over.
    const { panel, announced } = mapOf({
      transform: 'log2',
      colormap: 'RdBu_r',
      restore: { transform: 'log10', colormap: 'default', vmin: -4, vmax: -1 },
      defaults: DEFAULTS,
    })
    expect(announced.at(-1)).toEqual({ transform: 'log10', colormap: 'default', vmin: -4, vmax: -1 })
    expect(panel.baseScale()).toEqual({ transform: 'log10', colormap: 'default', vmin: -4, vmax: -1 })
    expect(panel.borrowedFrom()).toBeNull()
  })

  it('stays taken over by a rebuilt map that still derives, and stays carried', () => {
    const restore = { transform: 'log10', colormap: 'default' } as const
    const { panel, announced } = mapOf(
      { transform: 'log2', colormap: 'RdBu_r', restore, defaults: DEFAULTS },
      { expected: true },
    )
    expect(announced).toEqual([])
    expect(panel.borrowedFrom()).toEqual(restore)
  })

  it('keeps a ramp the reader chose under the derivation, and what it took over', () => {
    // A difference seeded on `none` and a chosen ramp, rebuilt as an O/E, which
    // wants `log2`: the transform moves, the reader's ramp stays, and what goes
    // back afterwards is still the count map's scale.
    const restore = { transform: 'log10', colormap: 'default' } as const
    const { panel, announced } = mapOf(
      { transform: 'none', colormap: 'seismic', restore, defaults: DEFAULTS },
      { expected: true },
    )
    expect(announced.at(-1)).toMatchObject({ transform: 'log2', colormap: 'seismic' })
    expect(panel.borrowedFrom()).toEqual(restore)
  })

  it('gives back the defaults where it arrived already drawn, by a link or Back', () => {
    // Nothing carried, and a seed that is the borrowed scale: it never saw the
    // one before it.
    const { panel } = mapOf({ transform: 'log2', colormap: 'RdBu_r', defaults: DEFAULTS }, { expected: true })
    expect(panel.borrowedFrom()).toEqual({ transform: 'log10', colormap: 'default' })
    expect(panel.baseScale()).toEqual({ transform: 'log10', colormap: 'default' })
  })

  it('gives back a seed that was not the borrowed scale, as it always has', () => {
    const { panel } = mapOf({ transform: 'log1p', colormap: 'viridis', defaults: DEFAULTS }, { expected: true })
    expect(panel.borrowedFrom()).toEqual({ transform: 'log1p', colormap: 'viridis' })
  })
})
