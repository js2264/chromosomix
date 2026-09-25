// @vitest-environment jsdom
/**
 * One crosshair, over the map and over its tracks.
 *
 * The toggle is offered as *the* crosshair, beside the map and beside the
 * tracks, and it used to be the map's alone: a lane's own hairline under the
 * pointer ignored it, and a lane showed no pointer whatever it said. So a reader
 * who turned the crosshair off watched the line leave the map and stay on every
 * track. The stacks follow the preference now — the line, and the pointer that
 * stands in for it when it is off.
 *
 * And the pointers themselves, which are stylesheet rules and are read here as
 * text, as `toggle-look.test.ts` reads the lit look: over the map a ring large
 * enough to leave the cell under the hand and its neighbours visible, centred on
 * the hand; over a lane or the 1D browser nothing, since the hairline there is
 * the pointer.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { MatrixPanel } from '@/ui/MatrixPanel'
import { DEFAULT_UI_PLOT_OPTIONS, setPlotOptions } from '@/ui/plotOptions'
import { setUpDom, type DomTeardown } from '../support/dom'

let teardown: DomTeardown
const built: MatrixPanel[] = []

beforeEach(() => {
  teardown = setUpDom({ canvas: 'stub' })
  setPlotOptions({ ...DEFAULT_UI_PLOT_OPTIONS })
})

afterEach(() => {
  for (const panel of built.splice(0, built.length)) panel.destroy()
  setPlotOptions({ ...DEFAULT_UI_PLOT_OPTIONS })
  teardown()
})

function lanes(): HTMLCanvasElement[] {
  const panel = new MatrixPanel({ binsize: 1000, detachedControls: true, hideTitle: true })
  built.push(panel)
  document.body.append(panel.el)
  return Array.from(panel.el.querySelectorAll<HTMLCanvasElement>('.lane-canvas'))
}

describe('a lane stack beside the map', () => {
  it('shows no pointer while the crosshair is on, since its hairline is the pointer', () => {
    const stacks = lanes()
    expect(stacks.length).toBeGreaterThan(0)
    for (const canvas of stacks) expect(canvas.classList.contains('is-guided')).toBe(true)
  })

  it('takes the arrowhead back when the crosshair is turned off, and gives it up again', () => {
    const stacks = lanes()
    setPlotOptions({ crosshair: false })
    for (const canvas of stacks) expect(canvas.classList.contains('is-guided')).toBe(false)
    setPlotOptions({ crosshair: true })
    for (const canvas of stacks) expect(canvas.classList.contains('is-guided')).toBe(true)
  })
})

describe('the pointers', () => {
  const CSS = readFileSync(join(import.meta.dirname, '..', '..', 'src', 'ui', 'styles.css'), 'utf8')
    // Comments first: a selector quoted inside one is prose, not a rule.
    .replace(/\/\*[\s\S]*?\*\//g, '')

  /** The body of the rule whose selector list is exactly `selectors`. */
  function rule(selectors: string): string {
    for (const match of CSS.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      const head = match[1].split(',').map((one) => one.trim()).join(', ')
      if (head === selectors) return match[2]
    }
    throw new Error(`no rule for ${selectors}`)
  }

  it('is Lucide’s locate over the map, large, and centred on the hand', () => {
    const body = decodeURIComponent(rule('.heatmap-canvas.is-guided'))
    // The ring and its four ticks, as the icon draws them.
    expect(body).toContain("circle cx='12' cy='12' r='7'")
    expect(body).toContain('M2 12H5M19 12H22M12 2V5M12 19V22')
    const size = Number(/width='(\d+)'/.exec(body)?.[1])
    expect(size).toBeGreaterThanOrEqual(32)
    // The hotspot is the middle of the ring, which is where the cell is.
    expect(body).toMatch(new RegExp(`\\)\\s*${size / 2} ${size / 2},`))
  })

  it('is nothing over a lane or the 1D browser while they are guided', () => {
    expect(rule('.lane-canvas.is-guided, .browser-canvas.is-guided')).toMatch(/cursor:\s*none/)
  })
})
