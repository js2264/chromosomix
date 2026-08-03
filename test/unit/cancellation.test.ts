/**
 * The yield that makes the full pixel scan cancellable (spec §7.3).
 *
 * `MetaCooler.scanPixels` used to yield with `await Promise.resolve()`, which
 * is a *microtask*: the microtask queue is drained inside the task that
 * scheduled it, so the worker's `onmessage` never ran and the `cancel` message
 * arrived only after the scan it was meant to stop had finished — taking the
 * whole file with it and then painting the overview the user had called off.
 *
 * These tests are the regression, and the first one fails against the old
 * implementation for exactly the right reason.
 */

import { describe, expect, it } from 'vitest'

import { yieldToEventLoop } from '@/async'

describe('yieldToEventLoop', () => {
  it('lets a queued task run — which `Promise.resolve()` does not', async () => {
    let delivered = false
    // Stands in for the `cancel` message: a task, not a microtask.
    setTimeout(() => {
      delivered = true
    }, 0)

    // The old spelling. Drains the microtask queue and nothing else, however
    // many times it is repeated.
    for (let i = 0; i < 1000; i++) await Promise.resolve()
    expect(delivered).toBe(false)

    // Bounded rather than exactly one turn. In a worker — the environment that
    // matters — a channel message and a 0 ms timer share one task queue and are
    // delivered in insertion order, so one turn always suffices. Node runs
    // channel messages in the check phase and timers in the timers phase, so
    // which comes first depends on where in the loop the yield lands, and
    // asserting one turn made this test fail about once in three runs. The
    // regression is intact: the microtask spelling above never delivers, however
    // many turns it is given.
    for (let i = 0; i < 5 && !delivered; i++) await yieldToEventLoop()
    expect(delivered).toBe(true)
  })

  it('stops a chunked loop at the next chunk once a task sets the flag', async () => {
    // The shape of `scanPixels`: work, check, yield.
    let cancelled = false
    setTimeout(() => {
      cancelled = true
    }, 0)

    let chunks = 0
    for (let i = 0; i < 500; i++) {
      if (cancelled) break
      chunks += 1
      await yieldToEventLoop()
    }

    expect(cancelled).toBe(true)
    // Stopped early rather than running all 500 chunks to the end.
    expect(chunks).toBeLessThan(10)
  })

  it('resolves even when nothing else is queued', async () => {
    await expect(yieldToEventLoop()).resolves.toBeUndefined()
  })
})
