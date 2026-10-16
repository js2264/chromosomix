// @vitest-environment jsdom
/**
 * The circle's name column, kept apart from the 1D browser's (§7.6): on until
 * the reader turns it off, stored on a key of its own, and the one `u` and the
 * palette's *Name column* turn while a circle is on screen — so turning a map
 * round, and back to square, leaves the browser's column as the reader set it.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { App } from '@/app/App'
import { resetMounting } from '@/embed'
import {
  RING_COLUMN_HINT,
  circleOnScreen,
  registerCircle,
  ringColumn,
  setRingColumn,
  subscribeRingColumn,
} from '@/ui/circlePrefs'
import type { Command } from '@/ui/commands'
import { PLOT_OPTION_LABELS, getPlotOptions, setPlotOption } from '@/ui/plotOptions'
import { setUpDom, type DomTeardown } from '../support/dom'

let teardown: DomTeardown

beforeEach(() => {
  teardown = setUpDom()
  window.sessionStorage.clear()
  window.history.replaceState(null, '', '/')
  resetMounting()
  // Both settings as a reader who has never touched either finds them.
  setRingColumn(true)
  setPlotOption('gutter', false)
  window.localStorage.clear()
})

afterEach(() => {
  vi.useRealTimers()
  teardown()
  window.history.replaceState(null, '', '/')
  resetMounting()
})

/** A circle's element as the page answers for it: drawn, hidden with its host, or gone. */
function circleElement(state: { connected: boolean; boxes: number }): Pick<Element, 'isConnected' | 'getClientRects'> {
  return {
    get isConnected() {
      return state.connected
    },
    getClientRects: () => ({ length: state.boxes }) as DOMRectList,
  }
}

function press(target: EventTarget, key: string): void {
  target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }))
}

describe('the circle’s name column', () => {
  it('is on until the reader turns it off, on a key of its own', async () => {
    expect(ringColumn()).toBe(true)
    const heard: boolean[] = []
    const off = subscribeRingColumn((on) => heard.push(on))
    setRingColumn(false)
    expect(ringColumn()).toBe(false)
    expect(window.localStorage.getItem('chromosomix:circle-column')).toBe('off')
    setRingColumn(true)
    expect(window.localStorage.getItem('chromosomix:circle-column')).toBeNull()
    expect(heard).toEqual([false, true])
    off()

    // Read back by the next page, which is a fresh module.
    window.localStorage.setItem('chromosomix:circle-column', 'off')
    vi.resetModules()
    const fresh = await import('@/ui/circlePrefs')
    expect(fresh.ringColumn()).toBe(false)
    window.localStorage.clear()
    vi.resetModules()
    expect((await import('@/ui/circlePrefs')).ringColumn()).toBe(true)
  })

  it('leaves the 1D browser’s column as the reader set it, either way round', () => {
    setPlotOption('gutter', true)
    setRingColumn(false)
    expect(getPlotOptions().gutter).toBe(true)
    setRingColumn(true)
    expect(getPlotOptions().gutter).toBe(true)
    setPlotOption('gutter', false)
    expect(ringColumn()).toBe(true)
  })

  it('knows a circle is on screen only while one is drawn', () => {
    expect(circleOnScreen()).toBe(false)
    const state = { connected: true, boxes: 1 }
    const release = registerCircle(circleElement(state))
    expect(circleOnScreen()).toBe(true)
    // The map turned back to square, or its session's tab put away: the host
    // is hidden, and the circle with it.
    state.boxes = 0
    expect(circleOnScreen()).toBe(false)
    state.boxes = 1
    state.connected = false
    expect(circleOnScreen()).toBe(false)
    state.connected = true
    release()
    expect(circleOnScreen()).toBe(false)
  })

  it('is what `u` and the palette turn while a circle is on screen, and the browser’s while none is', () => {
    // The status bar's once-a-second tick, which an App starts and nothing in a
    // test stops, faked: a real one outlives the file's DOM on a loaded machine
    // and fires into a document that is no longer there.
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    const root = document.createElement('div')
    document.body.appendChild(root)
    const app = new App(root)
    const command = (): Command | undefined =>
      (app as unknown as { commands(): Command[] }).commands().find((entry) => entry.id === 'overlay-gutter')

    // No circle: the browser's, as it always was.
    expect(command()?.hint).toBe(PLOT_OPTION_LABELS.gutter.hint)
    press(window, 'u')
    expect(getPlotOptions().gutter).toBe(true)
    expect(ringColumn()).toBe(true)
    press(window, 'u')
    expect(getPlotOptions().gutter).toBe(false)

    // A circle drawn: its own, and the browser's left alone.
    const state = { connected: true, boxes: 1 }
    const release = registerCircle(circleElement(state))
    expect(command()?.hint).toBe(RING_COLUMN_HINT)
    expect(command()?.state).toBe('on')
    press(window, 'u')
    expect(ringColumn()).toBe(false)
    expect(getPlotOptions().gutter).toBe(false)
    expect(command()?.state).toBe('off')
    press(window, 'u')
    expect(ringColumn()).toBe(true)

    // Turned back to square: the browser's again, as the reader left it.
    state.boxes = 0
    press(window, 'u')
    expect(getPlotOptions().gutter).toBe(true)
    expect(ringColumn()).toBe(true)
    release()
  })
})
