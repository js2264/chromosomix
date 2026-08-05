/**
 * The overlay toggles in the view card (`HeatmapView.setPlotOptions`).
 *
 * Two of the three are pure paint and are left to the eye. The two things that
 * are *not* obvious, and so are pinned here:
 *
 * 1. Hiding the labels must give their gutters back. The margin exists for the
 *    labels; leaving a 150 px band beside a plot with no names in it would be
 *    the same dead space `measureMargin` was written to remove.
 * 2. The crosshair must cost nothing while it is off. It is the only overlay
 *    that redraws on pointer movement, so a stray repaint per `mousemove` would
 *    be paid by every user, including the ones who never turned it on.
 *
 * `draw()` is never called: it needs `OffscreenCanvas`, which Node does not
 * have. Everything asserted here is state the view computes before painting.
 */

import { describe, expect, it } from 'vitest'

import { DEFAULT_PLOT_OPTIONS, HeatmapView } from '@/render/heatmap'
import type { DenseMatrix, Separator } from '@/types'

const CHAR_W = 7
const LABEL_GAP = 8
const EDGE_PAD = 6

/** As in `heatmap-margins.test.ts`, plus the hooks a pointer test needs. */
function fakeCanvas(cssWidth: number, cssHeight: number): {
  canvas: HTMLCanvasElement
  fire(type: string, event: Record<string, unknown>): void
} {
  const ctx = {
    font: '',
    fillStyle: '',
    strokeStyle: '',
    lineWidth: 0,
    lineJoin: '',
    textAlign: '',
    textBaseline: '',
    imageSmoothingEnabled: false,
    measureText: (text: string) => ({ width: text.length * CHAR_W }),
    save: () => {},
    restore: () => {},
    translate: () => {},
    rotate: () => {},
    scale: () => {},
    clearRect: () => {},
    fillRect: () => {},
    beginPath: () => {},
    moveTo: () => {},
    lineTo: () => {},
    stroke: () => {},
    fillText: () => {},
    strokeText: () => {},
    clip: () => {},
    rect: () => {},
    setTransform: () => {},
    drawImage: () => {},
  }
  const listeners = new Map<string, (event: unknown) => void>()
  const canvas = {
    width: 0,
    height: 0,
    clientWidth: cssWidth,
    clientHeight: cssHeight,
    tabIndex: 0,
    getContext: () => ctx,
    getBoundingClientRect: () => ({ left: 0, top: 0, width: cssWidth, height: cssHeight }),
    // The pointer handler flags a would-be pan on the element itself, so the
    // fake needs somewhere for that class to go.
    classList: { toggle: () => {} },
    addEventListener: (type: string, fn: (event: unknown) => void) => listeners.set(type, fn),
    removeEventListener: (type: string) => listeners.delete(type),
    focus: () => {},
    style: {},
  } as unknown as HTMLCanvasElement
  return {
    canvas,
    fire: (type, event) => listeners.get(type)?.(event),
  }
}

function block(nrows: number, ncols: number): DenseMatrix {
  return {
    nrows,
    ncols,
    values: new Float32Array(nrows * ncols),
    rowExtent: [0, nrows],
    colExtent: [0, ncols],
  }
}

function separators(count: number, n: number, prefix: string): Separator[] {
  const step = Math.floor(n / count)
  return Array.from({ length: count }, (_, i) => ({ at: i * step, label: `${prefix}_${i}` }))
}

describe('overlay toggles', () => {
  it('starts with every mark but the crosshair on', () => {
    const view = new HeatmapView(fakeCanvas(800, 800).canvas, { devicePixelRatio: 1 })
    expect(view.plotOptions).toEqual(DEFAULT_PLOT_OPTIONS)
    expect(view.plotOptions).toEqual({
      text: true,
      fills: true,
      baseline: true,
      gutter: false,
      dividers: true,
      breaks: true,
      labels: true,
      crosshair: false,
      ticks: true,
    })
  })

  it('hands the gutters back when the labels are hidden, and returns them', () => {
    const view = new HeatmapView(fakeCanvas(800, 800).canvas, {
      autoMargin: true,
      devicePixelRatio: 1,
      maxLabels: 50,
    })
    view.setMatrix(block(120, 120), separators(6, 120, 'contig'))
    const withLabels = 'contig_0'.length * CHAR_W + LABEL_GAP
    expect(view.margin.left).toBeCloseTo(withLabels, 5)

    view.setPlotOptions({ labels: false })
    expect(view.margin.left).toBe(EDGE_PAD)
    expect(view.margin.top).toBe(EDGE_PAD)
    expect(view.labelBlocks('rows')).toEqual([])
    // The plot is wider by exactly the band that is no longer reserved.
    expect(view.plotRect.width).toBeCloseTo(800 - 2 * EDGE_PAD, 5)

    view.setPlotOptions({ labels: true })
    expect(view.margin.left).toBeCloseTo(withLabels, 5)
    expect(view.labelBlocks('rows')).toHaveLength(6)
  })

  it('leaves the other overlays alone when one is toggled', () => {
    const view = new HeatmapView(fakeCanvas(400, 400).canvas, { devicePixelRatio: 1 })
    view.setPlotOptions({ crosshair: true })
    expect(view.plotOptions).toEqual({
      text: true,
      fills: true,
      baseline: true,
      gutter: false,
      dividers: true,
      breaks: true,
      labels: true,
      crosshair: true,
      ticks: true,
    })
    view.setPlotOptions({ dividers: false })
    expect(view.plotOptions).toEqual({
      text: true,
      fills: true,
      baseline: true,
      gutter: false,
      dividers: false,
      breaks: true,
      labels: true,
      crosshair: true,
      ticks: true,
    })
  })

  it('cannot be mutated through the getter', () => {
    const view = new HeatmapView(fakeCanvas(400, 400).canvas, { devicePixelRatio: 1 })
    view.plotOptions.crosshair = true
    expect(view.plotOptions.crosshair).toBe(false)
  })

  it('repaints on hover only when the crosshair is on', () => {
    const quiet = fakeCanvas(400, 400)
    let quietRedraws = 0
    const off = new HeatmapView(quiet.canvas, {
      devicePixelRatio: 1,
      onChange: () => {
        quietRedraws++
      },
    })
    off.setMatrix(block(40, 40), [])
    off.attach()
    quietRedraws = 0
    quiet.fire('mousemove', { clientX: 100, clientY: 100 })
    quiet.fire('mousemove', { clientX: 220, clientY: 240 })
    expect(quietRedraws).toBe(0)

    const live = fakeCanvas(400, 400)
    let liveRedraws = 0
    const on = new HeatmapView(live.canvas, {
      devicePixelRatio: 1,
      plotOptions: { crosshair: true },
      onChange: () => {
        liveRedraws++
      },
    })
    on.setMatrix(block(40, 40), [])
    on.attach()
    liveRedraws = 0
    live.fire('mousemove', { clientX: 100, clientY: 100 })
    expect(liveRedraws).toBe(1)
    // Same cell, no new information, no frame.
    live.fire('mousemove', { clientX: 101, clientY: 101 })
    expect(liveRedraws).toBe(1)
    // Leaving clears the mark, which is itself a repaint.
    live.fire('mouseleave', {})
    expect(liveRedraws).toBe(2)
  })
})
