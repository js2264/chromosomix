// @vitest-environment jsdom
/**
 * The one picture in this app whose size is a number rather than a stylesheet.
 *
 * A square map is sized by CSS and `HeatmapView.resize` reads that, so it follows
 * the window, the columns and the lane stacks without anybody arranging it. A
 * **turned** map does not: its box is a rectangle this panel computes from the
 * room it measures, and every road into it from a change of space has to say so.
 *
 * There are four such roads — the shell folding a column, the view's own
 * `ResizeObserver` for a window resize or a lane appearing, a turn arriving or
 * leaving, and a deck relaying out — and they used to end in different places.
 * Only some of them redrew the box, so a band kept the width of the window it was
 * first drawn in: folding two columns handed the map three hundred pixels it
 * never took, and pressing the turn toggle drew the band to a room measured
 * before the last fold. What is asserted below is that the box follows the room
 * *in both directions*, and through a turn.
 *
 * jsdom has no layout, so the room is stubbed: `clientWidth` on the box the panel
 * measures against is the one input, and the assertions are about what the panel
 * did with it. That is the honest shape for this bug — the arithmetic of fitting a
 * box into a room is `test/unit/turn-box.test.ts`'s, and what was wrong here was
 * never the arithmetic but who ran it and when.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { MatrixPanel } from '@/ui/MatrixPanel'
import { getMapSize, resetMapSize, setMapSize } from '@/ui/mapSize'
import { MIN_TURN_WIDTH, getTurnBox, setTurnBox } from '@/ui/turnBox'
import type { MatrixResult } from '@/worker/protocol'
import { setUpDom, type DomTeardown } from '../support/dom'

let teardown: DomTeardown
/** Every panel built by {@link harness}, so each one is put down again. */
const built: MatrixPanel[] = []

beforeEach(() => {
  teardown = setUpDom({ canvas: 'stub' })
  // The box is shared by every map on screen and held in a module (`ui/turnBox.ts`),
  // so it outlives a test as it outlives a navigation. Cleared through its own
  // setter rather than through storage, which the module reads once and caches:
  // two nulls is "as the panel finds it", which is what these tests are about.
  window.localStorage.clear()
  setTurnBox({ width: null, height: null })
  resetMapSize()
})

afterEach(() => {
  // Before the stub goes: a panel holds a scheduled frame, and a frame that runs
  // after the teardown draws into jsdom's own canvas — whose context is `null`,
  // which the rasteriser is right to treat as fatal.
  for (const panel of built.splice(0, built.length)) panel.destroy()
  teardown()
  window.localStorage.clear()
})

/** One sequence against itself, which is the only block that can be turned. */
function block(bins: number): MatrixResult {
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
  } as unknown as MatrixResult
}

interface Harness {
  panel: MatrixPanel
  grid: HTMLElement
  /** Pretend the shell gave the panel this much width, as a fold or a resize does. */
  room(width: number, height?: number): void
  /**
   * Place the handles, which the panel does before every draw.
   *
   * `remeasure` rather than a frame, because it is the same call and it is
   * synchronous: the shell makes it on mount and on every fold, and a test that
   * waited for `requestAnimationFrame` would be asserting on jsdom's timer.
   */
  paint(): void
  boxWidth(): number | null
  turned(): boolean
}

function harness(turn = true): Harness {
  let width = 600
  let height = 900
  const panel = new MatrixPanel({
    binsize: 1000,
    turn: { on: turn, onChange: () => {}, onAvailable: () => {} },
  })
  built.push(panel)
  document.body.append(panel.el)
  const grid = panel.el.querySelector<HTMLElement>('.panel-grid')
  if (grid === null) throw new Error('the panel has no grid')
  // What `measureRoom` reads: the box the grid is centred in for the width, and —
  // jsdom resolving no `max-height` — the grid itself for the height a square map
  // is bounded by.
  const body = grid.parentElement
  if (body === null) throw new Error('the grid is not mounted')
  Object.defineProperty(body, 'clientWidth', { get: () => width, configurable: true })
  Object.defineProperty(grid, 'clientHeight', { get: () => height, configurable: true })
  // The shell's first measure, which is where the panel's idea of its own room
  // comes from; without it every room below reads as zero.
  panel.remeasure()
  return {
    panel,
    grid,
    room: (nextWidth: number, nextHeight?: number) => {
      width = nextWidth
      if (nextHeight !== undefined) height = nextHeight
    },
    paint: () => panel.remeasure(),
    boxWidth: () => {
      const raw = grid.style.getPropertyValue('--turn-width')
      return raw === '' ? null : Number.parseInt(raw, 10)
    },
    turned: () => grid.classList.contains('is-turned'),
  }
}

/** The edges a panel is offering a handle on, in the order they are built. */
function shownGrips(fit: Harness): string[] {
  return [...fit.panel.el.querySelectorAll<HTMLElement>('.plot-grip')]
    .filter((grip) => !grip.classList.contains('hidden'))
    .map((grip) => grip.className.match(/plot-grip-(top|bottom|left|right)/)?.[1] ?? '?')
}

describe('a turned map', () => {
  it('is drawn in the room it has when the block arrives', () => {
    const fit = harness()
    fit.panel.setData(block(64), 'IV')
    expect(fit.turned()).toBe(true)
    expect(fit.boxWidth()).toBe(600)
  })

  it('grows into room the shell hands it, which is what folding a column does', () => {
    const fit = harness()
    fit.panel.setData(block(64), 'IV')
    fit.room(1400)
    // `Session.relayout` calls exactly this, for exactly this reason.
    fit.panel.remeasure()
    expect(fit.boxWidth()).toBe(1400)
  })

  it('gives room back when there is less of it', () => {
    const fit = harness()
    fit.panel.setData(block(64), 'IV')
    fit.room(1400)
    fit.panel.remeasure()
    fit.room(420)
    fit.panel.remeasure()
    expect(fit.boxWidth()).toBe(420)
  })

  it('never goes below the smallest box worth drawing in', () => {
    const fit = harness()
    fit.panel.setData(block(64), 'IV')
    fit.room(10)
    fit.panel.remeasure()
    expect(fit.boxWidth()).toBe(MIN_TURN_WIDTH)
  })

  it('takes the room it has *now* when the turn is pressed, not the room it had', () => {
    // The alternation the reader asked about: square, then turned again. A turn
    // re-runs the derivation from the top, and that path used to write the box
    // from the cached room — so a band turned back on after two columns were
    // folded came up the width of the window before the fold.
    const fit = harness()
    fit.panel.setData(block(64), 'IV')
    expect(fit.boxWidth()).toBe(600)

    fit.panel.rederive(undefined, undefined, {
      on: false,
      onChange: () => {},
      onAvailable: () => {},
    })
    expect(fit.turned()).toBe(false)
    // Square: the stylesheet sizes it, so the panel writes no box at all.
    expect(fit.boxWidth()).toBeNull()

    fit.room(1200)
    fit.panel.rederive(undefined, undefined, {
      on: true,
      onChange: () => {},
      onAvailable: () => {},
    })
    expect(fit.turned()).toBe(true)
    expect(fit.boxWidth()).toBe(1200)
  })

  it('keeps a width the reader dragged, clamped to the room it now has', () => {
    // The one case that must *not* follow the room upwards: a dragged box is a
    // stated preference, and a double-click on the handle is how it is given
    // back. Downwards it is clamped, because a box wider than the window is not
    // a box.
    setTurnBox({ width: 500 })
    const fit = harness()
    fit.panel.setData(block(64), 'IV')
    expect(fit.boxWidth()).toBe(500)
    fit.room(1400)
    fit.panel.remeasure()
    expect(fit.boxWidth()).toBe(500)
    fit.room(300)
    fit.panel.remeasure()
    expect(fit.boxWidth()).toBe(300)
  })
})

/**
 * …and the square map, which has handles of its own.
 *
 * The same fitting, with a width and a height (§7.2): the two ends set the
 * width, the top and bottom the height, and a side nobody has set is the side
 * of the square the map opens as — so a box of any shape can be drawn, and one
 * zoom keeps every cell square inside it. What is worth pinning here is that the
 * panel *writes* it — the stylesheet's own default is what an unset box falls
 * back to, so a panel that wrote nothing would leave the property to the budget
 * and the handles would move a number nobody read — and that it writes a height
 * only for a rectangle, leaving a square to the aspect ratio that keeps it one.
 */
describe('a square map', () => {
  /** What the panel wrote: the width, the height where it wrote one, and the class a rectangle wears. */
  const drawn = (fit: Harness): { width: number | null; height: number | null; shaped: boolean } => {
    const read = (name: string): number | null => {
      const raw = fit.grid.style.getPropertyValue(name)
      return raw === '' ? null : Number.parseInt(raw, 10)
    }
    return {
      width: read('--map-width'),
      height: read('--map-height'),
      shaped: fit.grid.classList.contains('is-shaped'),
    }
  }

  /**
   * The height a square map may have, as the stylesheet resolves it: the wrap's
   * `max-height`, which is `--map-budget` less the stacks over and under the map.
   * jsdom resolves no `clamp()`, so the test says the number outright.
   */
  const budget = (fit: Harness, px: number): void => {
    const wrap = fit.grid.querySelector<HTMLElement>('.heatmap-wrap')
    if (wrap === null) throw new Error('no wrap')
    wrap.style.maxHeight = `${px}px`
  }

  /** The handle on one edge. */
  const grip = (fit: Harness, edge: 'top' | 'bottom' | 'left' | 'right'): HTMLElement => {
    const node = fit.panel.el.querySelector<HTMLElement>(`.plot-grip-${edge}`)
    if (node === null) throw new Error(`no ${edge} handle`)
    // jsdom has no pointer capture, which the handle takes so a fast hand does
    // not drop the drag on the map; nothing here depends on what it does.
    node.setPointerCapture = () => {}
    node.releasePointerCapture = () => {}
    return node
  }

  /** A drag on a handle from one point to another, with Shift held if asked. */
  const drag = (
    node: HTMLElement,
    from: { x: number; y: number },
    to: { x: number; y: number },
    shiftKey = false,
  ): void => {
    const fire = (type: string, at: { x: number; y: number }): void => {
      node.dispatchEvent(
        new MouseEvent(type, { bubbles: true, cancelable: true, button: 0, clientX: at.x, clientY: at.y, shiftKey }),
      )
    }
    fire('pointerdown', from)
    fire('pointermove', to)
    fire('pointerup', to)
  }

  it('opens square, at all the room there is, and writes no height for a square', () => {
    const fit = harness(false)
    fit.panel.setData(block(64), 'IV')
    expect(fit.turned()).toBe(false)
    budget(fit, 700)
    fit.paint()
    // 600 wide and 700 tall: the square of the narrower.
    expect(drawn(fit)).toEqual({ width: 600, height: null, shaped: false })
    expect(fit.boxWidth()).toBeNull()
  })

  it('keeps a box the reader dragged, each side clamped to its own room', () => {
    setMapSize({ width: 420, height: 300 })
    const fit = harness(false)
    fit.panel.setData(block(64), 'IV')
    budget(fit, 700)
    fit.paint()
    expect(drawn(fit)).toEqual({ width: 420, height: 300, shaped: true })
    fit.room(250)
    fit.paint()
    // Clamped to the floor rather than to nothing; the height keeps its own.
    expect(drawn(fit)).toEqual({ width: 250, height: 300, shaped: true })
    // …and gives it back when the room does, because the ask was stored whole.
    fit.room(900)
    fit.paint()
    expect(drawn(fit)).toEqual({ width: 420, height: 300, shaped: true })
  })

  it('draws a side nobody set at the square’s side, which follows the room', () => {
    setMapSize({ width: 560 })
    const fit = harness(false)
    fit.panel.setData(block(64), 'IV')
    budget(fit, 450)
    fit.paint()
    expect(drawn(fit)).toEqual({ width: 560, height: 450, shaped: true })
  })

  it('gives a track grown under it the height, not a rectangle it does not know it is', () => {
    // The reported case. The stacks over and under the map come out of its
    // height budget, and the grid's own box does not move when the map gives up
    // the height a lane took — so the box was never fitted again: the old width
    // stood under a ceiling that had come down, and the next touch of a handle
    // snapped it to the square it should have been all along.
    const fit = harness(false)
    fit.panel.setData(block(64), 'IV')
    budget(fit, 700)
    fit.paint()
    expect(drawn(fit)).toEqual({ width: 600, height: null, shaped: false })
    // A stack under the map thickens, and the budget comes down with it. What a
    // deck's floor does, and what a lane's own height does, go through one place.
    budget(fit, 450)
    fit.panel.setLaneFloor({ top: 0, right: 0, bottom: 250, left: 0 })
    expect(drawn(fit)).toEqual({ width: 450, height: null, shaped: false })

    // A width the reader set keeps its length: the height alone gives way.
    setMapSize({ width: 560 })
    budget(fit, 380)
    fit.panel.setLaneFloor({ top: 0, right: 0, bottom: 320, left: 0 })
    expect(drawn(fit)).toEqual({ width: 560, height: 380, shaped: true })
  })

  it('takes the width from an end and the height from a side, each alone', () => {
    const fit = harness(false)
    fit.panel.setData(block(64), 'IV')
    budget(fit, 700)
    fit.paint()
    // The right end in by 50: both ends move, so the box narrows by 100.
    drag(grip(fit, 'right'), { x: 400, y: 300 }, { x: 350, y: 300 })
    expect(getMapSize()).toEqual({ width: 500, height: null })
    expect(drawn(fit)).toEqual({ width: 500, height: 600, shaped: true })
    // The bottom up by 120: the height alone, at the hand's own rate.
    drag(grip(fit, 'bottom'), { x: 300, y: 600 }, { x: 300, y: 480 })
    expect(getMapSize()).toEqual({ width: 500, height: 480 })
    // The top up by 40 is *out*, so taller — an edge handle means out is bigger.
    drag(grip(fit, 'top'), { x: 300, y: 0 }, { x: 300, y: -40 })
    expect(getMapSize()).toEqual({ width: 500, height: 520 })
  })

  it('keeps its shape under Shift, and stops as a whole at the first wall', () => {
    setMapSize({ width: 400, height: 200 })
    const fit = harness(false)
    fit.panel.setData(block(64), 'IV')
    budget(fit, 700)
    fit.paint()
    // The bottom down by 50: a quarter taller, so a quarter wider too.
    drag(grip(fit, 'bottom'), { x: 300, y: 200 }, { x: 300, y: 250 }, true)
    expect(getMapSize()).toEqual({ width: 500, height: 250 })
    // Far further than the room: the width reaches 600 first, and the height
    // stops where the shape puts it rather than going on alone.
    drag(grip(fit, 'bottom'), { x: 300, y: 250 }, { x: 300, y: 650 }, true)
    expect(getMapSize()).toEqual({ width: 600, height: 300 })
  })

  it('puts one side back to the square’s on a double-click of its handle', () => {
    setMapSize({ width: 500, height: 250 })
    const fit = harness(false)
    fit.panel.setData(block(64), 'IV')
    budget(fit, 700)
    fit.paint()
    grip(fit, 'left').dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
    expect(getMapSize()).toEqual({ width: null, height: 250 })
    expect(drawn(fit)).toEqual({ width: 600, height: 250, shaped: true })
  })

  it('goes back to the square on Fit the view, which a double click on the plot also is', () => {
    setMapSize({ width: 500, height: 250 })
    const fit = harness(false)
    fit.panel.setData(block(64), 'IV')
    budget(fit, 700)
    fit.paint()
    fit.panel.fit()
    expect(getMapSize()).toEqual({ width: null, height: null })
    // The store tells every panel, so nothing else has to be called here — the
    // one in the reader's hand and the others of a deck all redraw.
    expect(drawn(fit)).toEqual({ width: 600, height: null, shaped: false })
  })

  it('leaves both boxes as they were when Fit the view is pressed on a band', () => {
    // A band's box is the shape of a figure, and the square's is not on screen.
    setTurnBox({ width: 500 })
    setMapSize({ width: 420, height: 300 })
    const fit = harness(true)
    fit.panel.setData(block(64), 'IV')
    fit.panel.fit()
    expect(getTurnBox()).toEqual({ width: 500, height: null })
    expect(getMapSize()).toEqual({ width: 420, height: 300 })
  })

  it('offers four handles, where a band offers three', () => {
    // The band's fourth edge is the diagonal it stands on: there is nothing to
    // drag there, so it is hidden rather than inert.
    const square = harness(false)
    square.panel.setData(block(64), 'IV')
    square.paint()
    expect(shownGrips(square)).toEqual(['top', 'bottom', 'left', 'right'])

    const band = harness(true)
    band.panel.setData(block(64), 'IV')
    band.paint()
    expect(shownGrips(band)).toEqual(['top', 'left', 'right'])
  })

  it('says what its handles do, in the words of the picture on screen', () => {
    const fit = harness(false)
    fit.panel.setData(block(64), 'IV')
    fit.paint()
    const titles = (): string[] =>
      [...fit.panel.el.querySelectorAll<HTMLElement>('.plot-grip')].map((g) => g.title)
    for (const title of titles()) {
      expect(title).toContain('keep its shape')
      expect(title).toContain('Double-click')
    }
    expect(titles().some((title) => title.includes('how wide this map is drawn'))).toBe(true)
    expect(titles().some((title) => title.includes('how tall this map is drawn'))).toBe(true)
    fit.panel.rederive(undefined, undefined, {
      on: true,
      onChange: () => {},
      onAvailable: () => {},
    })
    fit.paint()
    expect(titles().some((title) => title.includes('how tall this band is drawn'))).toBe(true)
    expect(titles().some((title) => title.includes('how wide this band is drawn'))).toBe(true)
  })
})

/**
 * What an earlier version kept: one number, the side of a square, under the same
 * key. Read as that square rather than dropped, so a reader who sized their map
 * before the box had two sides opens it at the size they chose.
 */
describe('a size kept by an earlier version', () => {
  it('is read as the square it was', async () => {
    window.localStorage.setItem('chromosomix:map-size', '520')
    vi.resetModules()
    const fresh = await import('@/ui/mapSize')
    expect(fresh.getMapSize()).toEqual({ width: 520, height: 520 })
    // …and written back in the new shape the first time it changes.
    fresh.setMapSize({ height: 300 })
    expect(JSON.parse(window.localStorage.getItem('chromosomix:map-size') ?? 'null')).toEqual({
      width: 520,
      height: 300,
    })
    // The square again is nothing to keep.
    fresh.resetMapSize()
    expect(window.localStorage.getItem('chromosomix:map-size')).toBeNull()
  })
})
