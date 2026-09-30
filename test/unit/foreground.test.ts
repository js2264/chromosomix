/**
 * The reader's background work waits for the views' (§12).
 *
 * A census or a circularity read that steps in while a view is reading makes
 * the view wait for its round trips as well as its own: on a 1 GB `.hic` from
 * S3, a chromosome clicked during the census took 10 s where it took 4 alone.
 */

import { describe, expect, it } from 'vitest'

import { Foreground, SETTLE_MS } from '@/worker/foreground'

/** A clock the test moves, and a sleep that moves it. */
function clock(): { now: () => number; sleep: (ms: number) => Promise<void>; at: { t: number } } {
  const at = { t: 1_000 }
  return {
    at,
    now: () => at.t,
    // A real turn of the loop, so the test's own timers run between polls.
    sleep: (ms) =>
      new Promise((resolve) => {
        at.t += ms
        setTimeout(resolve, 0)
      }),
  }
}

describe('the background, behind the views', () => {
  it('goes straight on when no view has read', async () => {
    const c = clock()
    const gate = new Foreground(c.now, c.sleep)
    await gate.quiet()
    expect(c.at.t).toBe(1_000)
  })

  it('waits while a view reads, and for a settle after it, so the next request of the same view goes first', async () => {
    const c = clock()
    const gate = new Foreground(c.now, c.sleep)
    const end = gate.begin()
    let done = false
    const waiting = gate.quiet().then(() => (done = true))
    await new Promise((resolve) => setTimeout(resolve, 5))
    expect(done).toBe(false)
    const endedAt = c.at.t
    end()
    await waiting
    expect(c.at.t - endedAt).toBeGreaterThanOrEqual(SETTLE_MS)
  })

  it('counts views, so the wait lasts until the last one ends', async () => {
    const c = clock()
    const gate = new Foreground(c.now, c.sleep)
    const first = gate.begin()
    const second = gate.begin()
    first()
    first()
    let done = false
    const waiting = gate.quiet().then(() => (done = true))
    await new Promise((resolve) => setTimeout(resolve, 5))
    expect(done).toBe(false)
    second()
    await waiting
    expect(done).toBe(true)
  })

  it('ends the wait when told to, whatever the views are doing', async () => {
    const c = clock()
    const gate = new Foreground(c.now, c.sleep)
    gate.begin()
    let wanted = false
    const waiting = gate.quiet(() => wanted)
    await new Promise((resolve) => setTimeout(resolve, 5))
    wanted = true
    await waiting
  })
})
