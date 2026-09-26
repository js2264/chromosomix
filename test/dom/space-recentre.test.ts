// @vitest-environment jsdom
/**
 * Space puts the map back on its diagonal (§7.2), and stands down wherever
 * Space already has a job.
 *
 * The key is bound once, in `KEYS`, and read three ways: the command list
 * dispatches it, the shortcuts dialog prints it, and the recentre button's own
 * tooltip names it. What it does is the button's press, gated exactly as the
 * button is — nothing on a block with no diagonal, nothing under a turn. And
 * because Space is the one key the page itself already uses — it presses a
 * focused button, ticks a focused box, opens a focused menu row — the command
 * yields to any of those rather than taking the gesture from under them.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { HeatmapView } from '@/render/heatmap'
import { KEYS, keyLabel, matchesKeys, wantsSpace } from '@/ui/commands'
import { MatrixPanel } from '@/ui/MatrixPanel'
import type { MatrixResult } from '@/worker/protocol'
import { setUpDom, type DomTeardown } from '../support/dom'

let teardown: DomTeardown
const built: MatrixPanel[] = []

beforeEach(() => {
  teardown = setUpDom({ canvas: 'stub' })
})

afterEach(() => {
  for (const panel of built.splice(0, built.length)) panel.destroy()
  teardown()
  vi.restoreAllMocks()
})

const press = (init: Partial<KeyboardEvent>): KeyboardEvent =>
  ({ ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...init }) as KeyboardEvent

describe('the key', () => {
  it('is Space, and is printed as the word', () => {
    expect(KEYS.diagonal).toBe(' ')
    // A `<kbd>` with a space in it is an empty badge.
    expect(keyLabel(KEYS.diagonal)).toBe('Space')
  })

  it('answers a bare Space, and not one under a modifier', () => {
    expect(matchesKeys(press({ key: ' ' }), KEYS.diagonal)).toBe(true)
    expect(matchesKeys(press({ key: ' ', ctrlKey: true }), KEYS.diagonal)).toBe(false)
    expect(matchesKeys(press({ key: ' ', altKey: true }), KEYS.diagonal)).toBe(false)
    expect(matchesKeys(press({ key: 'Enter' }), KEYS.diagonal)).toBe(false)
  })
})

describe('whose Space it is', () => {
  function node(html: string): Element {
    const host = document.createElement('div')
    host.innerHTML = html
    document.body.append(host)
    const found = host.querySelector('[data-at]')
    if (found === null) throw new Error('nothing marked')
    return found
  }

  it('is a focused control’s: a button, a link, a box, a menu row, a field', () => {
    expect(wantsSpace(node('<button data-at>go</button>'))).toBe(true)
    // The icon inside a button is where a click lands and where focus reads from.
    expect(wantsSpace(node('<button><svg data-at></svg></button>'))).toBe(true)
    expect(wantsSpace(node('<a href="#x" data-at>there</a>'))).toBe(true)
    expect(wantsSpace(node('<span role="checkbox" tabindex="0" data-at></span>'))).toBe(true)
    expect(wantsSpace(node('<div role="button" tabindex="0" data-at>drop here</div>'))).toBe(true)
    expect(wantsSpace(node('<div role="menuitem" data-at>Copy this</div>'))).toBe(true)
    expect(wantsSpace(node('<input data-at>'))).toBe(true)
    expect(wantsSpace(node('<select data-at></select>'))).toBe(true)
    expect(wantsSpace(node('<textarea data-at></textarea>'))).toBe(true)
  })

  it('is the app’s over the map, over a plain element, or with nothing focused', () => {
    expect(wantsSpace(node('<canvas class="heatmap-canvas" tabindex="0" data-at></canvas>'))).toBe(false)
    expect(wantsSpace(node('<div data-at>a heading</div>'))).toBe(false)
    // A link with nowhere to go is text, and Space does nothing on it.
    expect(wantsSpace(node('<a data-at>a name</a>'))).toBe(false)
    expect(wantsSpace(document.body)).toBe(false)
    expect(wantsSpace(null)).toBe(false)
  })
})

describe('what it does', () => {
  /** A map drawn in a box of `size` pixels, since jsdom lays nothing out. */
  function map(rows: [number, number], cols: [number, number]): MatrixPanel {
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(400)
    vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(400)
    const panel = new MatrixPanel({ binsize: 1000, detachedControls: true, hideTitle: true })
    built.push(panel)
    document.body.append(panel.el)
    const nrows = rows[1] - rows[0]
    const ncols = cols[1] - cols[0]
    panel.setData(
      {
        nrows,
        ncols,
        values: new Float32Array(nrows * ncols).fill(1),
        rowExtent: rows,
        colExtent: cols,
        rowGroups: [{ label: 'IV', start: 0, end: nrows, unitStart: rows[0] }],
        colGroups: [{ label: 'IV', start: 0, end: ncols, unitStart: cols[0] }],
        level: 'bin',
        binsPerCell: 1,
      } as unknown as MatrixResult,
      'IV',
    )
    return panel
  }

  it('is the recentre button’s press, on a block with a diagonal', () => {
    const centre = vi.spyOn(HeatmapView.prototype, 'centreOnDiagonal')
    const panel = map([0, 40], [0, 40])
    expect(panel.canCentreOnDiagonal).toBe(true)
    panel.centreOnDiagonal()
    expect(centre).toHaveBeenCalledTimes(1)
  })

  it('does nothing where the button is greyed: a block the diagonal does not cross', () => {
    const centre = vi.spyOn(HeatmapView.prototype, 'centreOnDiagonal')
    // Rows 0–40 against columns 100–140: two stretches that never meet.
    const panel = map([0, 40], [100, 140])
    expect(panel.canCentreOnDiagonal).toBe(false)
    panel.centreOnDiagonal()
    expect(centre).not.toHaveBeenCalled()
  })
})
