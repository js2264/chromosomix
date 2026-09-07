// @vitest-environment jsdom
/**
 * The loading screen an open can talk back to (§3.7, §3.8).
 *
 * A spinner is the right answer for a wait of a moment and the wrong one for a
 * wait of a minute, and this application has exactly two of the latter: a
 * HiC-Pro pair read whole, and an `.scool` fetched over the network. What is
 * asserted here is the part a reader depends on and a refactor can quietly
 * break — that the two phases of one open are counted in **their own units**,
 * that an unmeasurable phase says so rather than claiming to be finished, and
 * that there is a way to stop.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { LoadingView } from '@/app/Session'
import { setUpDom, type DomTeardown } from '../support/dom'

let teardown: DomTeardown

beforeEach(() => {
  teardown = setUpDom()
})
afterEach(() => teardown())

const textOf = (view: LoadingView): string =>
  view.el.querySelector('.loading-text')?.textContent ?? ''
const bar = (view: LoadingView): HTMLProgressElement =>
  view.el.querySelector('progress') as HTMLProgressElement

describe('before the worker has said anything', () => {
  it('is a spinner and the name of the file, with no bar to read', () => {
    const view = new LoadingView('Opening big.matrix')
    expect(textOf(view)).toBe('Opening big.matrix…')
    // Present in the DOM, hidden until there is something to show: a bar that
    // appears at zero and sits there is indistinguishable from a stall.
    expect(view.el.querySelector('.progress-box')?.classList.contains('hidden')).toBe(true)
  })
})

describe('once it is reporting', () => {
  it('counts a download in bytes', () => {
    const view = new LoadingView('Opening big.matrix')
    view.report(1_000_000, 4_000_000, 'downloading the matrix')
    expect(textOf(view)).toContain('downloading the matrix')
    expect(textOf(view)).toBe('downloading the matrix — 976.6 kB of 3.8 MB')
    expect(bar(view).value).toBeCloseTo(0.25, 5)
    expect(view.el.querySelector('.progress-box')?.classList.contains('hidden')).toBe(false)
  })

  it('counts a parse in pixels, which is what the parse is counted in', () => {
    // The failure this exists for: one bar across both phases, with bytes and
    // pixels sharing a denominator. It looks like the read went backwards.
    const view = new LoadingView('Opening big.matrix')
    view.report(5_000_000, 10_000_000, 'reading pixels')
    expect(textOf(view)).toContain('5,000,000 of 10,000,000')
    expect(textOf(view)).not.toMatch(/MB|kB/)
  })

  it('counts cells when cells are what is being counted', () => {
    const view = new LoadingView('Opening cells.scool')
    view.report(120, 300, 'summing cells')
    expect(textOf(view)).toContain('120 of 300')
  })

  it('says only the phase where there is nothing to count it against', () => {
    // The `.scool` listing: one call into HDF5 that returns when it is done, so
    // the total is unknown *and* the bar must not read as finished. `0 B` here
    // would look like a download that had stalled at the starting line.
    const view = new LoadingView('Opening cells.scool')
    view.report(0, 0, 'listing cells')
    expect(textOf(view)).toBe('listing cells…')
    expect(bar(view).hasAttribute('value')).toBe(false)
  })

  it('goes back to a determinate bar when a measurable phase follows', () => {
    const view = new LoadingView('Opening cells.scool')
    view.report(0, 0, 'listing cells')
    view.report(3, 4, 'downloading')
    expect(bar(view).hasAttribute('value')).toBe(true)
    expect(bar(view).value).toBeCloseTo(0.75, 5)
  })

  it('never shows more than a full bar, whatever the host declared', () => {
    const view = new LoadingView('Opening big.matrix')
    view.report(9, 4, 'downloading')
    expect(bar(view).value).toBe(1)
  })
})

describe('the way out', () => {
  it('is offered only when there is something to cancel', () => {
    expect(new LoadingView('Opening x').el.querySelector('button')).toBeNull()
  })

  it('calls back once per press', () => {
    let stops = 0
    const view = new LoadingView('Opening big.matrix', () => stops++)
    const button = view.el.querySelector('button') as HTMLButtonElement
    expect(button.textContent).toBe('cancel')
    button.click()
    expect(stops).toBe(1)
  })
})
