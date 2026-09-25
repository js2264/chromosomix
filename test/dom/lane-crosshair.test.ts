// @vitest-environment jsdom
/**
 * One crosshair, over the map and over its tracks.
 *
 * The toggle is offered as *the* crosshair, beside the map and beside the
 * tracks, and it used to be the map's alone: a lane's own hairline under the
 * pointer ignored it. So a reader who turned the crosshair off watched the line
 * leave the map and stay on every track. The stacks follow the preference now
 * (`ui/AnnotationLanes.ts` draws the line), and the pointer over them is the
 * arrowhead either way.
 *
 * And the pointers themselves, which are stylesheet rules and are read here as
 * text, as `toggle-look.test.ts` reads the lit look: over the map a ring the
 * arrowhead's size, centred on the hand, whose ticks end exactly where the guide
 * lines stop (`LOCATE_REACH`, and `crosshair-gap.test.ts` for the lines); over a
 * lane or the 1D browser the arrowhead, hairline or not — a stack with the line
 * and no pointer could not say which line was the hand's, since another
 * surface's pointer is echoed there as the same line.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { LOCATE_REACH, LOCATE_SIZE } from '@/render/heatmap'
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
  it('keeps the arrowhead with the crosshair on, and off, and on again', () => {
    const stacks = lanes()
    expect(stacks.length).toBeGreaterThan(0)
    // Nothing marks a stack as guided: the one rule that swaps the pointer for
    // a guide's is the map's (below), and a stack wearing the class would be a
    // stack a later rule could take the pointer from again.
    for (const crosshair of [true, false, true]) {
      setPlotOptions({ crosshair })
      for (const canvas of stacks) expect(canvas.classList.contains('is-guided')).toBe(false)
    }
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

  it('is Lucide’s locate over the map, the arrowhead’s size, and centred on the hand', () => {
    const body = decodeURIComponent(rule('.heatmap-canvas.is-guided'))
    // The ring and its four ticks, as the icon draws them.
    expect(body).toContain("circle cx='12' cy='12' r='7'")
    expect(body).toContain('M2 12H5M19 12H22M12 2V5M12 19V22')
    const size = Number(/width='(\d+)'/.exec(body)?.[1])
    expect(size).toBe(LOCATE_SIZE)
    // No bigger than the arrowhead it stands in for.
    const arrow = decodeURIComponent(rule('.heatmap-canvas, .lane-canvas, .browser-canvas'))
    expect(size).toBeLessThanOrEqual(Number(/width='(\d+)'/.exec(arrow)?.[1]))
    // The hotspot is the middle of the ring, which is where the cell is.
    expect(body).toMatch(new RegExp(`\\)\\s*${size / 2} ${size / 2},`))
  })

  it('ends its ticks exactly where the guide lines stop', () => {
    const body = decodeURIComponent(rule('.heatmap-canvas.is-guided'))
    const size = Number(/width='(\d+)'/.exec(body)?.[1])
    const grid = Number(/viewBox='0 0 (\d+) \d+'/.exec(body)?.[1])
    // The first tick starts at the icon's edge and runs in towards the ring, so
    // where it starts is how far out from the middle the icon reaches.
    const start = Number(/d='M([\d.]+) /.exec(body)?.[1])
    expect(LOCATE_REACH).toBeCloseTo(((grid / 2 - start) * size) / grid, 9)
  })

  it('is the arrowhead over a lane and the 1D browser, and nothing takes it away', () => {
    // The map's resting pointer is theirs too, tip first on the base pair.
    const arrow = decodeURIComponent(rule('.heatmap-canvas, .lane-canvas, .browser-canvas'))
    expect(arrow).toMatch(/\)\s*2 2,/)
    // …and no rule anywhere hides it over either of them.
    for (const match of CSS.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      if (!/\.(lane|browser)-canvas/.test(match[1])) continue
      expect(match[2], match[1].trim()).not.toMatch(/cursor:\s*none/)
    }
  })
})

/**
 * What the session holds a file's tracks behind (§8.6): the panel says when it
 * has its first block, and says so on the way out too, so a hold on a map that
 * never drew does not last for ever.
 */
describe('a panel’s first block', () => {
  function block(bins: number): import('@/worker/protocol').MatrixResult {
    return {
      nrows: bins,
      ncols: bins,
      values: new Float32Array(bins * bins),
      rowExtent: [0, bins],
      colExtent: [0, bins],
      rowGroups: [{ label: 'IV', start: 0, end: bins, unitStart: 0 }],
      colGroups: [{ label: 'IV', start: 0, end: bins, unitStart: 0 }],
      level: 'bin',
      binsPerCell: 1,
    } as unknown as import('@/worker/protocol').MatrixResult
  }

  async function settled(promise: Promise<void>): Promise<boolean> {
    let done = false
    void promise.then(() => (done = true))
    for (let turn = 0; turn < 4; turn++) await Promise.resolve()
    return done
  }

  it('settles when the panel is handed its first block, and not before', async () => {
    const panel = new MatrixPanel({ binsize: 1000, detachedControls: true, hideTitle: true })
    built.push(panel)
    document.body.append(panel.el)
    expect(await settled(panel.firstData)).toBe(false)
    panel.setData(block(8), 'IV')
    expect(await settled(panel.firstData)).toBe(true)
  })

  it('settles when the panel goes away without one', async () => {
    const panel = new MatrixPanel({ binsize: 1000, detachedControls: true, hideTitle: true })
    const first = panel.firstData
    panel.destroy()
    expect(await settled(first)).toBe(true)
  })
})
