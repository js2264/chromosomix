// @vitest-environment jsdom
/**
 * The dot plot as a view of its own, in a DOM (SPECS §28.2): the streak under
 * the pointer named on both axes, a press keeping it named, the wheel zooming
 * and the button back to the whole, and the picture an export draws — the
 * streaks as lines, whatever the zoom on screen.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { DotplotStreaks } from '@/analysis/types'
import { OTHER_WAY, SAME_WAY, dotplotFigure, plotRectOf } from '@/ui/dotplotFigure'
import { setUpDom, type DomTeardown } from '../support/dom'

let teardown: DomTeardown
beforeEach(() => {
  teardown = setUpDom({ canvas: 'stub' })
})
afterEach(() => teardown())

/** Two sets of two sequences: one streak down I's diagonal, one the other way round in II. */
function streaks(): DotplotStreaks {
  return {
    x: { label: 'assembly.fa', names: ['I', 'II'], lengths: [6000, 2000] },
    y: { label: 'theory.fa', names: ['chrI', 'chrII'], lengths: [6000, 2000] },
    x0: Float64Array.from([0, 6000]),
    x1: Float64Array.from([6000, 8000]),
    y0: Float64Array.from([0, 6000]),
    y1: Float64Array.from([6000, 8000]),
    strand: Int8Array.from([1, -1]),
    anchors: Int32Array.from([410, 96]),
  }
}

describe('the dot plot’s view of its own', () => {
  it('names the streak under the pointer on both axes, and keeps it named on a press', () => {
    const figure = dotplotFigure(streaks())
    document.body.append(figure.el)
    const canvas = figure.el.querySelector('canvas') as HTMLCanvasElement
    const readout = figure.el.querySelector('.dotplot-readout') as HTMLElement
    expect(readout.textContent).toMatch(/^2 streaks · scroll to zoom/)
    // The figure before anything measured it: 240 wide, its plot the rest of the margins.
    const rect = plotRectOf({ width: 240, height: 296 })
    const scale = 8000 / Math.min(rect.width, rect.height)
    const on = { x: rect.x + 3000 / scale, y: rect.y + (rect.height - 8000 / scale) / 2 + 3000 / scale }
    canvas.dispatchEvent(new MouseEvent('pointermove', { clientX: on.x, clientY: on.y, bubbles: true }))
    expect(readout.textContent).toBe('I:1-6,000 × chrI:1-6,000 · the same way round · 410 anchors')
    canvas.dispatchEvent(new MouseEvent('pointerdown', { button: 0, clientX: on.x, clientY: on.y, bubbles: true }))
    canvas.dispatchEvent(new MouseEvent('pointerup', { clientX: on.x, clientY: on.y, bubbles: true }))
    canvas.dispatchEvent(new MouseEvent('pointermove', { clientX: rect.x + 2, clientY: rect.y + rect.height - 2, bubbles: true }))
    expect(readout.textContent).toBe('I:1-6,000 × chrI:1-6,000 · the same way round · 410 anchors')
    figure.destroy()
  })

  it('zooms on the wheel, and goes back to the whole from its button', () => {
    const figure = dotplotFigure(streaks())
    document.body.append(figure.el)
    const canvas = figure.el.querySelector('canvas') as HTMLCanvasElement
    const whole = figure.el.querySelector('.dotplot-whole') as HTMLButtonElement
    expect(whole.classList.contains('hidden')).toBe(true)
    canvas.dispatchEvent(new WheelEvent('wheel', { deltaY: -400, clientX: 150, clientY: 120, bubbles: true, cancelable: true }))
    return new Promise<void>((resolve) => {
      requestAnimationFrame(() => {
        expect(whole.classList.contains('hidden')).toBe(false)
        whole.click()
        requestAnimationFrame(() => {
          expect(whole.classList.contains('hidden')).toBe(true)
          figure.destroy()
          resolve()
        })
      })
    })
  })

  it('draws the streaks as lines for an export, each in the colour of its way round, and the sets’ names', () => {
    const figure = dotplotFigure(streaks())
    const strokes: string[] = []
    const texts: string[] = []
    const recording = {
      strokeStyle: '',
      fillStyle: '',
      lineWidth: 1,
      lineCap: 'butt',
      font: '',
      textAlign: 'left',
      textBaseline: 'alphabetic',
      save() {},
      restore() {},
      fillRect() {},
      strokeRect() {},
      beginPath() {},
      rect() {},
      clip() {},
      moveTo() {},
      lineTo() {},
      translate() {},
      rotate() {},
      setTransform() {},
      stroke() {
        strokes.push(recording.strokeStyle)
      },
      fillText(text: string) {
        texts.push(text)
      },
      measureText: (text: string) => ({ width: text.length * 6 }),
    }
    figure.draw(recording as unknown as CanvasRenderingContext2D, { width: 500, height: 400 })
    expect(strokes).toContain(SAME_WAY)
    expect(strokes).toContain(OTHER_WAY)
    expect(texts).toEqual(expect.arrayContaining(['I', 'II', 'chrI', 'chrII', 'assembly.fa', 'theory.fa']))
    figure.destroy()
  })
})
