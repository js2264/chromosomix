/**
 * When a zoom is worth a read, and when it is not.
 *
 * `BlockLadder` is the whole of the zoom-to-refine policy, and every one of its
 * rules exists to answer a specific way of getting this wrong:
 *
 * - reading during a gesture, so a wheel spin is twenty reads;
 * - reading for a difference the eye cannot find, so a slow zoom never stops;
 * - not terminating, so a reader who keeps zooming keeps paying;
 * - taking the picture away while a better one is fetched;
 * - re-reading a block that is still in hand, which is what zooming back out
 *   would otherwise cost;
 * - asking for more than the view was ever allowed to read, which turns a zoom
 *   into the full-file scan §7.3 gates;
 * - and retrying a refusal once per frame.
 *
 * The clock and the timer are injected, so these are assertions about the rule
 * rather than about how long a test is willing to wait.
 */

import { describe, expect, it } from 'vitest'

import { POOLED_CELL_CAP } from '@/metacooler/pooling'
import { BlockLadder, SETTLE_MS, clip, covers, gridFor, pad } from '@/ui/refine'
import type { Extent } from '@/types'
import type { MatrixResult } from '@/worker/protocol'

/** A block as the reader would return it for `rows` at `binsPerCell`. */
function block(rows: Extent, binsPerCell: number, cols: Extent = rows): MatrixResult {
  const nrows = Math.max(1, Math.ceil((rows[1] - rows[0]) / binsPerCell))
  const ncols = Math.max(1, Math.ceil((cols[1] - cols[0]) / binsPerCell))
  return {
    nrows,
    ncols,
    values: new Float32Array(1),
    rowExtent: rows,
    colExtent: cols,
    rowGroups: [],
    colGroups: [],
    level: 'bin',
    binsPerCell,
  }
}

/** A ladder with a fake clock, a fake timer and a recording reader. */
function ladder(options: { ceiling?: Extent; reads?: Array<Extent> } = {}) {
  const ceiling: Extent = options.ceiling ?? [0, 50_000]
  const asked: Array<{ rows: Extent; cols: Extent }> = []
  const given: MatrixResult[] = []
  let time = 1000
  let timer: { run: () => void; at: number } | null = null
  let settle: ((result: MatrixResult) => void) | null = null
  let refuse: ((err: unknown) => void) | null = null
  let cancels = 0

  const it = new BlockLadder({
    ceiling: { rows: ceiling, cols: ceiling },
    read: (rows, cols) => {
      asked.push({ rows, cols })
      return {
        promise: new Promise<MatrixResult>((resolve, reject) => {
          settle = resolve
          refuse = reject
        }),
        cancel: () => {
          cancels += 1
        },
      }
    },
    onBlock: (result) => {
      given.push(result)
      return true
    },
    now: () => time,
    defer: (run, ms) => {
      timer = { run, at: time + ms }
      return () => {
        timer = null
      }
    },
  })

  return {
    it,
    asked,
    given,
    get cancels() {
      return cancels
    },
    /** Move the fake clock on and run the timer if it is due. */
    tick(ms: number): void {
      time += ms
      while (timer !== null && timer.at <= time) {
        const due = timer
        timer = null
        due.run()
      }
    },
    /** Land the outstanding read. */
    land(result: MatrixResult): Promise<void> {
      settle?.(result)
      settle = null
      return Promise.resolve()
    },
    fail(err: unknown): Promise<void> {
      refuse?.(err)
      refuse = null
      return Promise.resolve().then(() => undefined)
    },
    get armed(): boolean {
      return timer !== null
    },
  }
}

const WHOLE: Extent = [0, 50_000]

describe('the coverage and padding arithmetic', () => {
  it('covers only what it contains', () => {
    expect(covers([0, 100], [10, 90])).toBe(true)
    expect(covers([0, 100], [0, 100])).toBe(true)
    expect(covers([0, 100], [0, 101])).toBe(false)
    expect(covers([10, 100], [9, 50])).toBe(false)
  })

  it('pads by a fraction of the span, outward on both sides', () => {
    expect(pad([100, 200], 0.5)).toEqual([50, 250])
    expect(pad([100, 200], 4)).toEqual([-300, 600])
    expect(pad([100, 200], 0)).toEqual([100, 200])
  })

  it('clips to the bounds rather than refusing', () => {
    expect(clip([-300, 700], [0, 500])).toEqual([0, 500])
    expect(clip([100, 200], [0, 500])).toEqual([100, 200])
  })

  it('restates the reader’s grid choice, and never finer than it', () => {
    // A window that fits the cap is read at the file's own bins.
    expect(gridFor([0, POOLED_CELL_CAP], [0, POOLED_CELL_CAP])).toBe(1)
    // One bin past it needs two bins to a cell.
    expect(gridFor([0, POOLED_CELL_CAP + 1], [0, POOLED_CELL_CAP + 1])).toBe(2)
    // Human chr1 at 5 kb: 49,792 bins is thirteen to a cell.
    expect(gridFor([0, 49_792], [0, 49_792])).toBe(13)
    // The widest axis decides, because the reader shares one grid across both.
    expect(gridFor([0, 100], [0, 49_792])).toBe(13)
  })
})

describe('when the ladder reads', () => {
  it('does nothing at all while the block on screen is good enough', () => {
    const l = ladder()
    l.it.adopt(block(WHOLE, 13))
    // The whole domain, drawn at the grid the whole domain gets.
    l.it.consider({ rows: WHOLE, cols: WHOLE, binsPerCell: 13 })
    l.tick(SETTLE_MS * 4)
    expect(l.asked).toHaveLength(0)
    expect(l.armed).toBe(false)
  })

  it('does not read for less than a factor of two', () => {
    const l = ladder()
    l.it.adopt(block(WHOLE, 13))
    // Zoomed to two thirds of the domain: that window would be read at k=9,
    // which is finer — but not twice as fine, so the picture stays.
    const view: Extent = [0, 33_000]
    expect(gridFor(pad(view, 0.5), pad(view, 0.5))).toBeGreaterThan(13 / 2)
    l.it.consider({ rows: view, cols: view, binsPerCell: 13 })
    l.tick(SETTLE_MS * 4)
    expect(l.asked).toHaveLength(0)
  })

  it('reads once the window would be read twice as fine', () => {
    const l = ladder()
    l.it.adopt(block(WHOLE, 13))
    const view: Extent = [10_000, 22_000]
    l.it.consider({ rows: view, cols: view, binsPerCell: 13 })
    expect(l.asked, 'not during the gesture').toHaveLength(0)
    l.tick(SETTLE_MS)
    expect(l.asked).toHaveLength(1)
    // Padded by half a window on each side, and inside the ceiling.
    expect(l.asked[0].rows).toEqual([4_000, 28_000])
  })

  it('waits for the gesture to stop rather than reading through it', () => {
    const l = ladder()
    l.it.adopt(block(WHOLE, 13))
    // A wheel spin: the window changes every frame for half a second.
    for (let i = 0; i < 8; i++) {
      const half = 20_000 - i * 2_000
      l.it.consider({ rows: [25_000 - half, 25_000 + half], cols: [25_000 - half, 25_000 + half], binsPerCell: 13 })
      l.tick(60)
    }
    expect(l.asked, 'a gesture is not a sequence of reads').toHaveLength(0)
    // …and one read when it settles.
    l.tick(SETTLE_MS * 2)
    expect(l.asked).toHaveLength(1)
  })

  it('terminates at the file’s own bins', () => {
    const l = ladder()
    l.it.adopt(block([20_000, 22_000], 1))
    // However far in the reader goes, a block already at one bin per cell can
    // never be bettered, so nothing is ever asked for again.
    for (const span of [1000, 400, 100, 20, 4]) {
      l.it.consider({ rows: [21_000, 21_000 + span], cols: [21_000, 21_000 + span], binsPerCell: 1 })
      l.tick(SETTLE_MS * 2)
    }
    expect(l.asked).toHaveLength(0)
  })

  it('never asks for more than the view’s own domain', () => {
    const l = ladder({ ceiling: [0, 50_000] })
    l.it.adopt(block([24_000, 26_000], 1))
    // Zooming out hard: the reach is four windows on each side, which would run
    // to [-6000, 56000] and is clipped to what this view was allowed to read.
    l.it.consider({ rows: [22_000, 28_000], cols: [22_000, 28_000], binsPerCell: 1 })
    l.tick(SETTLE_MS)
    expect(l.asked).toHaveLength(1)
    expect(l.asked[0].rows).toEqual([0, 50_000])
  })
})

describe('what the ladder holds', () => {
  it('hands back a block it already has instead of reading it again', async () => {
    const l = ladder()
    const coarse = block(WHOLE, 13)
    l.it.adopt(coarse)

    // In: a read, and the fine block is drawn.
    l.it.consider({ rows: [10_000, 22_000], cols: [10_000, 22_000], binsPerCell: 13 })
    l.tick(SETTLE_MS)
    const fine = block([4_000, 28_000], 6)
    await l.land(fine)
    expect(l.given.at(-1)).toBe(fine)

    // Out again, past what the fine block covers. The coarse one is still here.
    const asked = l.asked.length
    l.it.consider({ rows: WHOLE, cols: WHOLE, binsPerCell: 6 })
    expect(l.given.at(-1), 'zooming out is free').toBe(coarse)
    l.tick(SETTLE_MS * 2)
    expect(l.asked, 'and costs no read').toHaveLength(asked)
  })

  it('prefers the finest block that covers the window', async () => {
    const l = ladder()
    l.it.adopt(block(WHOLE, 13))
    l.it.consider({ rows: [10_000, 22_000], cols: [10_000, 22_000], binsPerCell: 13 })
    l.tick(SETTLE_MS)
    const fine = block([4_000, 28_000], 6)
    await l.land(fine)

    // A window inside both: the finer one wins.
    l.it.consider({ rows: [12_000, 14_000], cols: [12_000, 14_000], binsPerCell: 6 })
    expect(l.given.at(-1)).toBe(fine)
  })
})

describe('reads in flight', () => {
  it('calls off a read whose window the reader has already left', () => {
    const l = ladder()
    l.it.adopt(block(WHOLE, 13))
    l.it.consider({ rows: [10_000, 22_000], cols: [10_000, 22_000], binsPerCell: 13 })
    l.tick(SETTLE_MS)
    expect(l.asked).toHaveLength(1)
    expect(l.cancels).toBe(0)

    // Somewhere else entirely, and still nothing has landed.
    l.it.consider({ rows: [40_000, 44_000], cols: [40_000, 44_000], binsPerCell: 13 })
    expect(l.cancels, 'the stale read is called off').toBe(1)
    l.tick(SETTLE_MS)
    expect(l.asked).toHaveLength(2)
  })

  it('lets a read finish when the reader is still inside it', () => {
    const l = ladder()
    l.it.adopt(block(WHOLE, 13))
    l.it.consider({ rows: [10_000, 22_000], cols: [10_000, 22_000], binsPerCell: 13 })
    l.tick(SETTLE_MS)
    // A nudge, still well inside the padded window that is being read.
    l.it.consider({ rows: [11_000, 21_000], cols: [11_000, 21_000], binsPerCell: 13 })
    l.tick(SETTLE_MS * 2)
    expect(l.cancels).toBe(0)
    expect(l.asked).toHaveLength(1)
  })

  it('does not retry a refusal once per frame', async () => {
    const l = ladder()
    l.it.adopt(block(WHOLE, 13))
    const view: Extent = [10_000, 22_000]
    l.it.consider({ rows: view, cols: view, binsPerCell: 13 })
    l.tick(SETTLE_MS)
    await l.fail(new Error('too large'))

    for (let i = 0; i < 5; i++) {
      l.it.consider({ rows: view, cols: view, binsPerCell: 13 })
      l.tick(SETTLE_MS * 2)
    }
    expect(l.asked, 'the same refused read, once').toHaveLength(1)
  })

  it('treats a cancellation as no answer rather than as a refusal', async () => {
    const l = ladder()
    l.it.adopt(block(WHOLE, 13))
    const view: Extent = [10_000, 22_000]
    l.it.consider({ rows: view, cols: view, binsPerCell: 13 })
    l.tick(SETTLE_MS)
    const abort = new Error('cancelled')
    abort.name = 'AbortError'
    await l.fail(abort)

    l.it.consider({ rows: view, cols: view, binsPerCell: 13 })
    l.tick(SETTLE_MS * 2)
    expect(l.asked, 'the window is still worth reading').toHaveLength(2)
  })

  it('stops everything on destroy', () => {
    const l = ladder()
    l.it.adopt(block(WHOLE, 13))
    l.it.consider({ rows: [10_000, 22_000], cols: [10_000, 22_000], binsPerCell: 13 })
    l.tick(SETTLE_MS)
    l.it.destroy()
    expect(l.cancels).toBe(1)
    l.it.consider({ rows: [10_000, 12_000], cols: [10_000, 12_000], binsPerCell: 13 })
    l.tick(SETTLE_MS * 4)
    expect(l.asked).toHaveLength(1)
  })
})
