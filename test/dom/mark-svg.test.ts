// @vitest-environment jsdom
/**
 * The landing page's two inline marks (`ui/markSvg.ts`), drawn from the data
 * `scripts/make-app-icons.py` writes (`ui/mark.generated.ts`).
 *
 * What is held here is what the stylesheet and the page's policy lean on: the
 * anti-diagonal's cells carry their step on the X, counted from the corners
 * in, and the diagonal it crosses carries its own class, so the hover can
 * draw the cross; two marks never share a gradient id; nothing is written as
 * an inline `style`, which the page's Content-Security-Policy refuses; and the
 * map the data describes is symmetric, as a contact map is.
 */

import { describe, expect, it } from 'vitest'

import { MARK_CELLS, MARK_LANES } from '@/ui/mark.generated'
import { armStep, markWatermark, mastheadMark } from '@/ui/markSvg'

describe('the mark’s data', () => {
  it('is a symmetric map, with the X lit from corner to corner', () => {
    const at = new Map(MARK_CELLS.map(([i, j, a]) => [`${i},${j}`, a]))
    for (const [i, j, a] of MARK_CELLS) expect(at.get(`${j},${i}`)).toBe(a)
    // Every cell of the anti-diagonal is drawn, and none is fainter than the
    // longest-range contact at its corners.
    for (let i = 0; i < 7; i++) expect(at.get(`${i},${6 - i}`) ?? 0).toBeGreaterThanOrEqual(0.55)
  })

  it('draws the red track on all four sides, the same levels on each', () => {
    const red = MARK_LANES.filter((lane) => lane.track.startsWith('red-'))
    expect(red.map((lane) => lane.track).sort()).toEqual(['red-bottom', 'red-left', 'red-right', 'red-top'])
    const levels = red.map((lane) => lane.rects.map((rect) => rect[4]).join(','))
    expect(new Set(levels).size).toBe(1)
  })
})

describe('mastheadMark', () => {
  it('steps the X from the corners in, and marks the diagonal it crosses', () => {
    expect([armStep(0, 6), armStep(6, 0), armStep(1, 5), armStep(4, 2), armStep(3, 3)]).toEqual([0, 0, 1, 2, 3])
    expect(armStep(0, 0)).toBeNull()

    const svg = mastheadMark()
    const rects = [...svg.querySelectorAll('rect.cx-arm')]
    expect(rects).toHaveLength(7)
    expect(svg.querySelectorAll('.cx-arm-0')).toHaveLength(2)
    expect(svg.querySelectorAll('.cx-arm-3')).toHaveLength(1)
    // The centre is on both diagonals and lights with the arms; the other six
    // of the diagonal step back.
    expect(svg.querySelectorAll('rect.cx-diag')).toHaveLength(6)
  })

  it('is decorative, and gives every mark gradients of its own', () => {
    const one = mastheadMark()
    const two = mastheadMark()
    expect(one.getAttribute('aria-hidden')).toBe('true')
    const ids = (svg: SVGSVGElement): string[] => [...svg.querySelectorAll('[id]')].map((n) => n.id)
    expect(ids(one)).toHaveLength(2)
    expect(ids(one).filter((id) => ids(two).includes(id))).toEqual([])
    for (const id of ids(one)) expect(one.querySelector(`[fill="url(#${id})"], [stroke="url(#${id})"]`)).not.toBeNull()
  })

  it('writes no inline style, which the page’s policy would refuse', () => {
    for (const root of [mastheadMark(), markWatermark()]) {
      expect(root.hasAttribute('style')).toBe(false)
      expect(root.querySelectorAll('[style]')).toHaveLength(0)
    }
  })
})

describe('markWatermark', () => {
  it('carries the map in both plates’ colours, for the theme to choose, and no animation', () => {
    const box = markWatermark()
    expect(box.className).toBe('picker-watermark')
    expect(box.getAttribute('aria-hidden')).toBe('true')
    expect(box.querySelectorAll('.cx-ink-light')).toHaveLength(1)
    expect(box.querySelectorAll('.cx-ink-dark')).toHaveLength(1)
    expect(box.querySelectorAll('.cx-arm, .cx-diag')).toHaveLength(0)
    // No plate: only the cells and the lanes.
    expect(box.querySelectorAll('path')).toHaveLength(0)
  })
})
