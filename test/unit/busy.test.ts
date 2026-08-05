/**
 * The busy probe, and the registry the status bar reads it through.
 *
 * Timed code tested against fake timers rather than against the clock: the
 * quantity under test is the *arithmetic* — lateness over a window — and a real
 * three-second wait would be three seconds of the suite spent measuring the
 * machine it happens to be running on.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { BUSY_WINDOW_MS, PROBE_PERIOD_MS, startBusyProbe } from '@/perf/busy'
import { clearThreads, registerThread, threadReports } from '@/perf/threads'

/**
 * The clock the probe reads, under this test's control.
 *
 * Fake timers alone cannot express the thing being measured: they fire every
 * interval exactly when it is due, so a thread under them is never late. What
 * being blocked *looks like* is the clock having moved further than the timer
 * did, so the two are driven separately — `clock` says what time the callback
 * thinks it is, and `advanceTimersByTime` says that one tick has run.
 */
let clock = 0

function tick(elapsed: number): void {
  clock += elapsed
  vi.advanceTimersByTime(PROBE_PERIOD_MS)
}

describe('the busy probe', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    clock = 0
    vi.spyOn(performance, 'now').mockImplementation(() => clock)
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('reads zero on a thread that answers on time', () => {
    const probe = startBusyProbe()
    for (let i = 0; i < 10; i++) tick(PROBE_PERIOD_MS)
    expect(probe.busy()).toBe(0)
    probe.stop()
  })

  it('says nothing until it has samples enough to mean something', () => {
    const probe = startBusyProbe()
    // One late sample out of two is a coin toss, not a measurement.
    tick(PROBE_PERIOD_MS)
    tick(PROBE_PERIOD_MS * 3)
    expect(probe.busy()).toBe(0)
    probe.stop()
  })

  it('counts the time a thread could not answer in', () => {
    const probe = startBusyProbe()
    for (let i = 0; i < 10; i++) tick(PROBE_PERIOD_MS)
    expect(probe.busy()).toBe(0)
    // The eleventh tick was due after one period and ran after three: two
    // periods of this thread went somewhere else.
    tick(PROBE_PERIOD_MS * 3)
    // 400 ms late out of 2,600 ms of history.
    expect(probe.busy()).toBeCloseTo(400 / 2600, 5)
    probe.stop()
  })

  it('pins a thread that never answers at one, not above it', () => {
    const probe = startBusyProbe()
    for (let i = 0; i < 5; i++) tick(PROBE_PERIOD_MS * 1.9)
    const busy = probe.busy()
    expect(busy).toBeGreaterThan(0.4)
    expect(busy).toBeLessThanOrEqual(1)
    probe.stop()
  })

  // A gap this long is a throttled background tab or a machine that slept, and
  // reading either as "pinned for a minute" is the opposite of what happened.
  it('throws its history away rather than call a suspension busy', () => {
    const probe = startBusyProbe()
    for (let i = 0; i < 10; i++) tick(PROBE_PERIOD_MS)
    tick(60_000)
    expect(probe.busy()).toBe(0)
    probe.stop()
  })

  it('forgets everything on a reset', () => {
    const probe = startBusyProbe()
    for (let i = 0; i < 10; i++) tick(PROBE_PERIOD_MS * 1.5)
    expect(probe.busy()).toBeGreaterThan(0)
    probe.reset()
    expect(probe.busy()).toBe(0)
    probe.stop()
  })

  it('stops when told to', () => {
    const probe = startBusyProbe()
    for (let i = 0; i < 5; i++) tick(PROBE_PERIOD_MS * 1.5)
    const before = probe.busy()
    probe.stop()
    for (let i = 0; i < 5; i++) tick(PROBE_PERIOD_MS * 1.5)
    // Nothing accumulated after the stop, so nothing changed.
    expect(probe.busy()).toBe(before)
  })

  it('only counts back as far as its window', () => {
    const probe = startBusyProbe()
    // A busy stretch, then a quiet one longer than the window: the busy part is
    // out of history and the reading is what the thread is doing *now*.
    for (let i = 0; i < 5; i++) tick(PROBE_PERIOD_MS * 1.8)
    expect(probe.busy()).toBeGreaterThan(0)
    for (let i = 0; i < BUSY_WINDOW_MS / PROBE_PERIOD_MS + 2; i++) tick(PROBE_PERIOD_MS)
    expect(probe.busy()).toBe(0)
    probe.stop()
  })
})

describe('the thread registry', () => {
  beforeEach(() => {
    clearThreads()
  })

  it('carries a thread from registration to release', () => {
    const handle = registerThread('reader')
    expect(threadReports()).toEqual([{ label: 'reader', busy: null, at: null }])

    handle.report(0.4)
    const [report] = threadReports()
    expect(report.busy).toBe(0.4)
    expect(report.at).not.toBeNull()

    handle.release()
    expect(threadReports()).toEqual([])
  })

  it('keeps two threads apart, and releases them independently', () => {
    const reader = registerThread('reader')
    const annotations = registerThread('annotations')
    reader.report(1)
    annotations.report(0)
    expect(threadReports().map((report) => [report.label, report.busy])).toEqual([
      ['reader', 1],
      ['annotations', 0],
    ])

    reader.release()
    expect(threadReports().map((report) => report.label)).toEqual(['annotations'])
    annotations.release()
  })

  // A released handle that keeps reporting is a client with a bug; it must not
  // be able to resurrect its row.
  it('ignores a report from a released thread', () => {
    const handle = registerThread('reader')
    handle.release()
    handle.report(1)
    expect(threadReports()).toEqual([])
  })
})
