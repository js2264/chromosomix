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

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { MatrixPanel } from '@/ui/MatrixPanel'
import { setMapSize } from '@/ui/mapSize'
import { MIN_TURN_WIDTH, setTurnBox } from '@/ui/turnBox'
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
  setMapSize(null)
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
 * …and the square map, which has handles of its own now.
 *
 * The same fitting, one number instead of two: a square block has no shape to
 * choose, so every edge sets the side and a box of another shape would be paper
 * down two sides of the picture. What is worth pinning here is that the panel
 * *writes* it — the stylesheet's own default is what an unset size falls back to,
 * so a panel that wrote nothing would leave the property to the budget and the
 * handles would move a number nobody read.
 */
describe('a square map', () => {
  const sizeOf = (fit: Harness): number | null => {
    const raw = fit.grid.style.getPropertyValue('--map-size')
    return raw === '' ? null : Number.parseInt(raw, 10)
  }

  it('is drawn at all the room there is, until somebody says otherwise', () => {
    const fit = harness(false)
    fit.panel.setData(block(64), 'IV')
    expect(fit.turned()).toBe(false)
    // The room is 600 wide in this harness and jsdom gives no height, so the
    // floor is what bounds it — what matters is that the side is *written*.
    expect(sizeOf(fit)).not.toBeNull()
    expect(fit.boxWidth()).toBeNull()
  })

  it('keeps a size the reader dragged, clamped to the room it now has', () => {
    setMapSize(420)
    const fit = harness(false)
    fit.panel.setData(block(64), 'IV')
    expect(sizeOf(fit)).toBe(420)
    fit.room(300)
    fit.panel.remeasure()
    expect(sizeOf(fit)).toBe(300)
    // …and gives it back when the room does, because the ask was stored whole.
    fit.room(900)
    fit.panel.remeasure()
    expect(sizeOf(fit)).toBe(420)
  })

  it('goes back to all the room on a double-click, which is what null means', () => {
    setMapSize(300)
    const fit = harness(false)
    fit.panel.setData(block(64), 'IV')
    expect(sizeOf(fit)).toBe(300)
    setMapSize(null)
    // The store tells every panel, so nothing else has to be called here — the
    // one in the reader's hand and the others of a deck all redraw.
    expect(sizeOf(fit)).toBeGreaterThan(300)
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
    for (const grip of fit.panel.el.querySelectorAll<HTMLElement>('.plot-grip')) {
      expect(grip.title).toContain('how big this map is drawn')
      expect(grip.title).toContain('Double-click')
    }
    fit.panel.rederive(undefined, undefined, {
      on: true,
      onChange: () => {},
      onAvailable: () => {},
    })
    fit.paint()
    const titles = [...fit.panel.el.querySelectorAll<HTMLElement>('.plot-grip')].map((g) => g.title)
    expect(titles.some((title) => title.includes('how tall this band is drawn'))).toBe(true)
    expect(titles.some((title) => title.includes('how wide this band is drawn'))).toBe(true)
  })
})
