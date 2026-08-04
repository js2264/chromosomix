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

    // Bounded generously rather than tightly, and the bound is not the point.
    // In a worker — the environment that matters — a channel message and a 0 ms
    // timer share one task queue and are delivered in insertion order, so one
    // turn always suffices. Node runs channel messages in the check phase and
    // timers in the timers phase, and clamps a 0 ms timer to 1 ms: on a fast
    // machine several channel round trips fit inside that millisecond, so a
    // small bound is a race against the clock rather than a statement about the
    // yield. Five failed here about once in twenty runs, and once in CI.
    //
    // What is being asserted is that the timer is delivered *at all* while this
    // loop yields, which the microtask spelling above never manages however many
    // turns it is given — 1,000 of them, right up there. 500 is the same bound
    // the chunked-loop test below uses, for the same reason.
    for (let i = 0; i < 500 && !delivered; i++) await yieldToEventLoop()
    expect(delivered).toBe(true)
  })

  it('stops a chunked loop at the next chunk once a task sets the flag', async () => {
    // The shape of `scanPixels`: work, check, yield.
    let cancelled = false
    let chunks = 0
    let chunksWhenCancelled = -1
    setTimeout(() => {
      cancelled = true
      chunksWhenCancelled = chunks
    }, 0)

    for (let i = 0; i < 500; i++) {
      if (cancelled) break
      chunks += 1
      await yieldToEventLoop()
    }

    expect(cancelled).toBe(true)
    // Measured from where the flag was actually set, not against a round
    // number of chunks. How many yields a 0 ms timer takes to fire is a Node
    // scheduling detail — timers phase against the check phase a channel
    // message is delivered in — and under a loaded machine running the whole
    // suite it is tens, which failed a `< 10` bound that passed on an idle one.
    // What the loop owes is that it stops at the *next* chunk boundary after
    // the flag becomes visible, which is this, and it holds at any timer delay.
    expect(chunks - chunksWhenCancelled).toBeLessThanOrEqual(1)
    // And that it stopped rather than ran out: the microtask spelling never
    // delivers the timer at all, so it would reach 500 with `cancelled` false.
    expect(chunks).toBeLessThan(500)
  })

  it('resolves even when nothing else is queued', async () => {
    await expect(yieldToEventLoop()).resolves.toBeUndefined()
  })
})
