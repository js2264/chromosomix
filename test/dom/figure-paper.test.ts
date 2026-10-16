// @vitest-environment jsdom
/**
 * A figure leaves the app on white, whatever the theme it was looked at in
 * (§7.2).
 *
 * On screen a figure borrows its colours from where it is mounted: light in
 * the drawer and the centre column, dark elsewhere — a plot enlarged into the
 * stage dialog follows the dark theme there. Its PNG, PDF and copy are redrawn
 * from the figure paper instead (`ui/canvasPalette.ts`), and every map, deck
 * and lane picture is laid on {@link FIGURE_BACKGROUND}, which is white and not
 * the page's `--bg`: in the dark theme those came out on near-black, under ink
 * chosen for white.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { FIGURE_BACKGROUND, figurePaper } from '@/ui/canvasPalette'
import { matrixFigure, plotTheme } from '@/ui/analysisPlots'
import { setUpDom, type DomTeardown } from '../support/dom'

let teardown: DomTeardown

beforeEach(() => {
  teardown = setUpDom()
})

afterEach(() => {
  document.documentElement.removeAttribute('style')
  teardown()
})

/** A context that remembers the colour every rectangle was filled with. */
function recording(): { ctx: CanvasRenderingContext2D; fills: string[] } {
  const fills: string[] = []
  let fillStyle = ''
  const ctx = new Proxy({} as Record<string | symbol, unknown>, {
    get(target, key) {
      if (key === 'fillStyle') return fillStyle
      if (key === 'fillRect') return () => fills.push(fillStyle)
      if (key === 'measureText') return (text: string) => ({ width: text.length * 6 })
      if (key in target) return target[key]
      return () => undefined
    },
    set(target, key, value) {
      if (key === 'fillStyle') fillStyle = String(value)
      else target[key] = value
      return true
    },
  })
  return { ctx: ctx as unknown as CanvasRenderingContext2D, fills }
}

describe('the paper a figure is exported on', () => {
  it('is white, which is not the dark page’s ground', () => {
    expect(FIGURE_BACKGROUND).toBe('#ffffff')
  })

  it('is one node, kept in the document, out of sight', () => {
    const paper = figurePaper()
    expect(paper.isConnected).toBe(true)
    expect(paper.classList.contains('figure-paper')).toBe(true)
    expect(figurePaper()).toBe(paper)
    expect(paper.getAttribute('aria-hidden')).toBe('true')
  })

  it('carries a figure mounted in the dark onto white', () => {
    const figure = matrixFigure({
      kind: 'matrix',
      id: 'm',
      label: 'pileup',
      nrows: 2,
      ncols: 2,
      values: new Float32Array([1, 2, 3, 4]),
      xLabel: '',
      yLabel: '',
      xTicks: [],
      yTicks: [],
      colormap: 'viridis',
    })
    // Mounted somewhere that follows the dark theme, as the stage dialog does.
    const dark = document.createElement('div')
    dark.style.setProperty('--bg', '#191a1c')
    dark.style.setProperty('--text', '#eeeff1')
    dark.append(figure.el)
    document.body.append(dark)
    expect(plotTheme(figure.el).background).toBe('#191a1c')
    const { ctx, fills } = recording()
    figure.draw(ctx, { width: 300, height: 300 })
    // The first thing painted is the ground, and it is the paper's.
    expect(fills[0]).toBe('#ffffff')
    figure.destroy()
  })
})
