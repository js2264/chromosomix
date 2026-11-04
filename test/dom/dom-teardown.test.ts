// @vitest-environment jsdom
/**
 * What {@link setUpDom}'s teardown has to stop: every timer the app arms that
 * would outlive the document.
 *
 * The rendered report (`src/perf/rendered.ts`, §12) looks again 250 ms after a
 * change while anything on screen still waits — a panel's read, a lane opening.
 * A test file that ends while a panel waits leaves that look armed, and when it
 * fires the document is gone: it finds nothing waiting, asks for a frame to
 * confirm in, and `requestAnimationFrame` is not defined any more. Vitest counts
 * the throw against whichever file was running — `contact-maps-order` on one CI
 * run, nothing on the next — and fails the suite with every test passed. The
 * status bar's tick was the same leak once, and the teardown stops it; this
 * asks the same of the report.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'

import { begin, Surface } from '@/perf/rendered'
import { setUpDom } from '../support/dom'

afterEach(() => {
  vi.useRealTimers()
})

describe('the DOM’s teardown', () => {
  it('stops the rendered report’s look again, so none fires after the document is gone', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'requestAnimationFrame', 'cancelAnimationFrame'] })
    const teardown = setUpDom()
    const node = document.createElement('div')
    document.body.append(node)
    // A panel still reading when its file's last test ends.
    new Surface(node, () => ({})).wait('read', true)
    begin()()
    expect(vi.getTimerCount()).toBeGreaterThan(0)
    teardown()
    expect(vi.getTimerCount()).toBe(0)
  })
})
