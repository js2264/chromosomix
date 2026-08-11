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
  room(width: number): void
  boxWidth(): number | null
  turned(): boolean
}

function harness(turn = true): Harness {
  let width = 600
  const panel = new MatrixPanel({
    binsize: 1000,
    turn: { on: turn, onChange: () => {}, onAvailable: () => {} },
  })
  built.push(panel)
  document.body.append(panel.el)
  const grid = panel.el.querySelector<HTMLElement>('.panel-grid')
  if (grid === null) throw new Error('the panel has no grid')
  // What `measureRoom` reads: the box the grid is centred in.
  const body = grid.parentElement
  if (body === null) throw new Error('the grid is not mounted')
  Object.defineProperty(body, 'clientWidth', { get: () => width, configurable: true })
  return {
    panel,
    grid,
    room: (next: number) => {
      width = next
    },
    boxWidth: () => {
      const raw = grid.style.getPropertyValue('--turn-width')
      return raw === '' ? null : Number.parseInt(raw, 10)
    },
    turned: () => grid.classList.contains('is-turned'),
  }
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
