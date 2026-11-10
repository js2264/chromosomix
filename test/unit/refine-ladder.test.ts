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

import { denseCellCap } from '@/metacooler/matrix'
import { POOLED_CELL_CAP } from '@/metacooler/pooling'
import {
  BlockLadder,
  INWARD_MS,
  READ_AHEAD_EDGE,
  REFINE_DEFAULT,
  SCREEN_READ_CAP,
  chooseRung,
  clip,
  covers,
  gridFor,
  pad,
  poolingRung,
  recentre,
  refineEnabled,
  rungsOf,
  screenPlan,
  setRefineEnabled,
  subscribeRefine,
  type BlockHandover,
  type ReadPlan,
} from '@/ui/refine'
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

/** A ladder with a fake clock and a recording reader. */
function ladder(
  options: { ceiling?: Extent; reads?: Array<Extent>; budget?: number; now?: () => number } = {},
) {
  const ceiling: Extent = options.ceiling ?? [0, 50_000]
  const asked: Array<{ rows: Extent; cols: Extent; plan?: ReadPlan }> = []
  const given: MatrixResult[] = []
  const hows: Array<BlockHandover | undefined> = []
  const busy: boolean[] = []
  let settle: ((result: MatrixResult) => void) | null = null
  let refuse: ((err: unknown) => void) | null = null
  let cancels = 0

  const it = new BlockLadder({
    ceiling: { rows: ceiling, cols: ceiling },
    read: (rows, cols, plan) => {
      asked.push({ rows, cols, ...(plan === undefined ? {} : { plan }) })
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
    onBlock: (result, how) => {
      given.push(result)
      hows.push(how)
      return true
    },
    onBusy: (on) => busy.push(on),
    ...(options.budget === undefined ? {} : { budget: () => options.budget }),
    ...(options.now === undefined ? {} : { now: options.now }),
  })

  return {
    it,
    asked,
    given,
    hows,
    busy,
    get cancels() {
      return cancels
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
  }
}

const WHOLE: Extent = [0, 50_000]

describe('the preference', () => {
  it('is on until somebody turns it off', () => {
    // It was off while a zoom that read was a zoom that waited, the map held
    // still for a read as large as memory allowed. Reads are sized to the
    // screen now and the map never holds still (§2), so the map opens at the
    // screen's resolution and sharpens as the reader zooms. Off keeps the old
    // promise — one read, and no I/O while panning and zooming.
    expect(REFINE_DEFAULT).toBe(true)
  })

  it('answers the default where there is no storage to read', () => {
    // Node has no `localStorage`, and neither does a browser in some private
    // modes or a strict embedding. Losing a preference must never mean losing
    // the picture, so the read is wrapped and the default stands.
    expect(refineEnabled()).toBe(REFINE_DEFAULT)
  })

  it('tells every panel at once', () => {
    // One preference, several maps: a deck of five that disagreed about whether
    // the zoom reads would be five answers to one question.
    const heard: boolean[] = []
    const stop = subscribeRefine((on) => heard.push(on))
    setRefineEnabled(true)
    setRefineEnabled(false)
    stop()
    setRefineEnabled(true)
    setRefineEnabled(REFINE_DEFAULT)
    expect(heard, 'and stops telling one that has gone').toEqual([true, false])
  })
})

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
    // A window the dense read takes is read at the file's own bins — a whole
    // yeast chromosome IV at 100 bp among them.
    const dense = denseCellCap()
    expect(dense).toBeGreaterThanOrEqual(15_320)
    expect(gridFor([0, dense], [0, dense])).toBe(1)
    // One bin past it is pooled, to the pooled read's grid.
    expect(gridFor([0, dense + 1], [0, dense + 1])).toBe(Math.ceil((dense + 1) / POOLED_CELL_CAP))
    // Human chr1 at 5 kb: 49,792 bins is thirteen to a cell.
    expect(gridFor([0, 49_792], [0, 49_792])).toBe(13)
    // The widest axis decides, because the reader shares one grid across both.
    expect(gridFor([0, 100], [0, 49_792])).toBe(13)
  })
})

describe('choosing a rung of a laddered file', () => {
  const YEAST = rungsOf(['1000', '2000', '5000', '10000'])

  it('reads a ladder as bin sizes, finest first', () => {
    expect(YEAST).toEqual([
      { name: '1000', binsize: 1000 },
      { name: '2000', binsize: 2000 },
      { name: '5000', binsize: 5000 },
      { name: '10000', binsize: 10000 },
    ])
    // HDF5 group order is alphabetical, which puts 10000 before 2000. §3.4's
    // rule is that the names *are* the bin sizes, so the sort is numeric.
    expect(rungsOf(['10000', '1000', '2000']).map((r) => r.binsize)).toEqual([1000, 2000, 10000])
  })

  it('is empty for anything that is not a ladder', () => {
    // A sample collection: names with no order to exploit (§3.4).
    expect(rungsOf(['rep1', 'rep2'])).toEqual([])
    // A plain file, which is most of them.
    expect(rungsOf([])).toEqual([])
    // Not every name an integer is not a ladder either.
    expect(rungsOf(['1000', 'raw'])).toEqual([])
    expect(rungsOf(['0', '1000'])).toEqual([])
  })

  it('takes the coarsest rung whose bins still fill a cell', () => {
    // 40 Mb at 1 kb: 40,000 bins is past what is read bin for bin, and into
    // 4,096 cells is about 9,766 bp a cell, so the 5 kb level fits and the 10 kb
    // one would put more than one of its bins in a cell — the pooling this avoids.
    expect(chooseRung(YEAST, 40_000, 1000)).toBe('5000')
    // Three times as much genome, three times coarser a cell.
    expect(chooseRung(YEAST, 121_000, 1000)).toBe('10000')
    // A whole 12.1 Mb yeast genome is read bin for bin, so at the open 1 kb.
    expect(chooseRung(YEAST, 12_100, 1000)).toBeUndefined()
  })

  it('names no rung once the window is small enough for the open map', () => {
    // Inside the cap, a cell is one bin and the finest level is the open one.
    expect(chooseRung(YEAST, 2_000, 1000)).toBeUndefined()
    expect(chooseRung(YEAST, POOLED_CELL_CAP, 1000)).toBeUndefined()
  })

  it('names nothing at all for a file with no ladder', () => {
    expect(chooseRung([], 100_000, 1000)).toBeUndefined()
  })

  it('never names the rung that is already open', () => {
    // The session opened at 2 kb; a window that wants 2 kb cells wants what is
    // already in hand, and a request naming it would be a re-open for nothing.
    expect(chooseRung(YEAST, 8_000, 2000)).toBeUndefined()
    expect(chooseRung(YEAST, 40_000, 2000)).toBe('10000')
  })

  it('treats the open rung as the finest it may use', () => {
    // The reader picked 2 kb out of a six-level file. Zooming in may coarsen
    // and may come back, and must never reach past what they asked for: a zoom
    // that fetched the 100 bp level would be overruling the picker with the
    // reader's own file.
    const six = rungsOf(['100', '200', '500', '1000', '2000', '5000'])
    for (const span of [POOLED_CELL_CAP, 1000, 100, 10, 1]) {
      const at = chooseRung(six, span, 2000)
      expect(at, `span=${span}`).toBeUndefined()
    }
    // Coarser is still allowed — that is the direction the picker did not rule on.
    expect(chooseRung(six, 40_000, 2000)).toBe('5000')
    // And a reader who opened the finest level gets the whole ladder above it:
    // 40,000 × 100 bp is 4 Mb, which is 977 bp a cell, so 500 fits and 1,000
    // would put more than one of its bins in a cell.
    expect(chooseRung(six, 40_000, 100)).toBe('500')
  })

  it('names nothing when every rung is finer than the open one', () => {
    // A hand-made file whose picker landed on the coarsest level: there is
    // nothing above it, so there is nothing to fetch however far out you go.
    const two = rungsOf(['100', '200'])
    expect(chooseRung(two, 1_000_000, 200)).toBeUndefined()
  })
})

describe('when the ladder reads', () => {
  it('does nothing at all while the block on screen is good enough', () => {
    const l = ladder()
    l.it.adopt(block(WHOLE, 13))
    // The whole domain, drawn at the grid the whole domain gets.
    l.it.consider({ rows: WHOLE, cols: WHOLE, binsPerCell: 13 })
    expect(l.asked).toHaveLength(0)
    expect(l.busy, 'and never shows the spinner').toHaveLength(0)
  })

  it('does not read for less than a factor of two', () => {
    const l = ladder()
    l.it.adopt(block(WHOLE, 13))
    // Zoomed to two thirds of the domain: that window would be read at k=9,
    // which is finer — but not twice as fine, so the picture stays.
    const view: Extent = [0, 33_000]
    expect(gridFor(pad(view, 0.5), pad(view, 0.5))).toBeGreaterThan(13 / 2)
    l.it.consider({ rows: view, cols: view, binsPerCell: 13 })
    expect(l.asked).toHaveLength(0)
    expect(l.busy).toHaveLength(0)
  })

  it('reads on the frame that crosses, and says so while it does', () => {
    const l = ladder()
    l.it.adopt(block(WHOLE, 13))
    const view: Extent = [10_000, 22_000]
    l.it.consider({ rows: view, cols: view, binsPerCell: 13 })
    // Immediately, not after a settle: the sooner it starts the sooner it is
    // in, and one read for the frames that follow is the in-flight guard's job.
    // `busy` turns the spinner, over a view that holds nothing still.
    expect(l.asked).toHaveLength(1)
    expect(l.busy).toEqual([true])
    // Padded by half a window on each side, and inside the ceiling.
    expect(l.asked[0].rows).toEqual([4_000, 28_000])
  })

  it('stops the spinner when the block lands', async () => {
    const l = ladder()
    l.it.adopt(block(WHOLE, 13))
    l.it.consider({ rows: [10_000, 22_000], cols: [10_000, 22_000], binsPerCell: 13 })
    expect(l.busy).toEqual([true])
    await l.land(block([4_000, 28_000], 6))
    expect(l.busy, 'turning, then stopped').toEqual([true, false])
  })

  it('stops the spinner when the read is refused', async () => {
    const l = ladder()
    l.it.adopt(block(WHOLE, 13))
    l.it.consider({ rows: [10_000, 22_000], cols: [10_000, 22_000], binsPerCell: 13 })
    await l.fail(new Error('too large'))
    // A refusal that left the spinner turning would be a read that never ends,
    // which is the worst way to report one.
    expect(l.busy).toEqual([true, false])
  })

  it('issues one read for a gesture, however many frames it lasts', () => {
    const l = ladder()
    l.it.adopt(block(WHOLE, 13))
    // A wheel spin, which goes on while its read is in flight: nothing holds
    // the view still. The frames keep coming and must not turn a gesture into
    // a burst of reads — the read in flight still covers each window, on a grid
    // the zoom has not outrun, so it is the read every one of them wants.
    for (let i = 0; i < 8; i++) {
      const half = 20_000 - i * 2_000
      l.it.consider({
        rows: [25_000 - half, 25_000 + half],
        cols: [25_000 - half, 25_000 + half],
        binsPerCell: 13,
      })
    }
    expect(l.asked, 'the in-flight guard, not the timing').toHaveLength(1)
    expect(l.busy).toEqual([true])
  })

  it('terminates at the file’s own bins', () => {
    const l = ladder()
    l.it.adopt(block([20_000, 22_000], 1))
    // However far in the reader goes, a block already at one bin per cell can
    // never be bettered, so nothing is ever asked for again. Kept off the
    // block's own edges, which are a separate reason to read — see the
    // pressed-against-the-edge cases below.
    for (const span of [800, 400, 100, 20, 4]) {
      const at = 21_000
      l.it.consider({ rows: [at - span / 2, at + span / 2], cols: [at - span / 2, at + span / 2], binsPerCell: 1 })
    }
    expect(l.asked).toHaveLength(0)
    expect(l.busy, 'and the spinner never turns for a read it will not make').toHaveLength(0)
  })

  it('never asks for more than the view’s own domain', () => {
    const l = ladder({ ceiling: [0, 50_000] })
    l.it.adopt(block([24_000, 26_000], 1))
    // Zooming out hard, past a block that is not the whole domain: the reach
    // is a window on each side, every one of them clipped to what this view was
    // allowed to read.
    l.it.consider({ rows: [24_000, 26_000], cols: [24_000, 26_000], binsPerCell: 1, fit: 0.5 })
    l.it.consider({ rows: [0, 50_000], cols: [0, 50_000], binsPerCell: 1 })
    for (const read of l.asked) {
      expect(read.rows[0]).toBeGreaterThanOrEqual(0)
      expect(read.rows[1]).toBeLessThanOrEqual(50_000)
    }
    expect(l.asked[0].rows).toEqual([22_000, 28_000])
  })
})

describe('panning against the edge of the block in hand', () => {
  /**
   * The reported bug, as a test. A reader on a whole chromosome zooms into its
   * first stretch, gets a finer grid for it — and can then no longer reach the
   * rest of the chromosome, because `clampView` makes the block they were given
   * the whole world. Coverage alone cannot see it: the view is always *inside*
   * the block, because it is not allowed anywhere else.
   */
  it('reads again when the view is pressed against a block edge', async () => {
    const l = ladder({ ceiling: [0, 15_300] })
    l.it.adopt(block([0, 15_300], 4))

    // In, to the first stretch. One refine, to the file's own bins.
    l.it.consider({ rows: [0, 350], cols: [0, 350], binsPerCell: 4 })
    expect(l.asked).toHaveLength(1)
    const fine = block(l.asked[0].rows, 1, l.asked[0].cols)
    await l.land(fine)
    const wall = fine.rowExtent[1]
    expect(wall).toBeLessThan(15_300)

    // Now pan to that block's far edge — which is as far as the view can go.
    const asked = l.asked.length
    l.it.consider({ rows: [wall - 350, wall], cols: [wall - 350, wall], binsPerCell: 1 })
    expect(l.asked, 'the wall is a reason to read, not a place to stop').toHaveLength(asked + 1)
    // Recentred on where the reader is, with a whole window of room ahead.
    const next = l.asked[asked]
    expect(next.rows[0]).toBeLessThan(wall - 350)
    expect(next.rows[1]).toBeGreaterThan(wall)
  })

  it('travels without changing the resolution', async () => {
    // The defect this replaced: a reader who had zoomed a chromosome down to its
    // finest grid, panned to the edge of what they had, and got the next block
    // back four times coarser — because the travel read padded the way a zoom
    // does. Panning is a change of place, not of scale.
    const l = ladder({ ceiling: [0, 15_300] })
    l.it.adopt(block([0, 15_300], 4))
    l.it.consider({ rows: [0, 350], cols: [0, 350], binsPerCell: 4 })
    const first = l.asked[0]
    await l.land(block(first.rows, 1, first.cols))

    const wall = first.rows[1]
    l.it.consider({ rows: [wall - 350, wall], cols: [wall - 350, wall], binsPerCell: 1 })
    const next = l.asked[1]
    expect(next.rows[1] - next.rows[0], 'the same span, somewhere else').toBe(
      first.rows[1] - first.rows[0],
    )
    // …and real ground in the direction of travel.
    expect(next.rows[1]).toBeGreaterThan(wall)
  })

  it('recentres a span on where the reader is', () => {
    expect(recentre([0, 100], [90, 110])).toEqual([50, 150])
    expect(recentre([0, 100], [0, 100])).toEqual([0, 100])
    // A jump and a nudge produce the same shape of request.
    expect(recentre([0, 100], [500, 520])).toEqual([460, 560])
  })

  it('judges a block by the budget its reads carry, so a deck panel does not read forever', () => {
    // A deck's panel reads with a share of the device (§16.7), and the reader
    // reads bin for bin only as wide as that share affords. 15,300 bins on half
    // a gigabyte is pooled four to a cell — and a ladder that judged it against
    // the whole device would want one bin to a cell, get four, and ask again.
    const budget = 5e8
    expect(denseCellCap(budget)).toBeLessThan(15_300)
    const l = ladder({ ceiling: [0, 15_300], budget })
    l.it.adopt(block([0, 15_300], 4))
    l.it.consider({ rows: [0, 15_300], cols: [0, 15_300], binsPerCell: 4 })
    expect(l.asked).toHaveLength(0)
    // The same block on the device's own budget is not good enough.
    const whole = ladder({ ceiling: [0, 15_300] })
    whole.it.adopt(block([0, 15_300], 4))
    whole.it.consider({ rows: [0, 15_300], cols: [0, 15_300], binsPerCell: 4 })
    expect(whole.asked).toHaveLength(1)
  })

  it('does not read at the edge of the world', () => {
    // The block is the whole domain: its edges are the ceiling's, so pressing
    // against them is not a request for anything, it is the end of the sequence.
    // Read bin for bin, which is how the reader answers a domain this narrow.
    const l = ladder({ ceiling: [0, 15_300] })
    l.it.adopt(block([0, 15_300], 1))
    l.it.consider({ rows: [0, 4000], cols: [0, 4000], binsPerCell: 1 })
    expect(l.asked).toHaveLength(0)
    l.it.consider({ rows: [11_300, 15_300], cols: [11_300, 15_300], binsPerCell: 1 })
    expect(l.asked).toHaveLength(0)
  })

  it('settles rather than reading again once it has recentred', async () => {
    const l = ladder({ ceiling: [0, 15_300] })
    l.it.adopt(block([0, 15_300], 4))
    l.it.consider({ rows: [0, 350], cols: [0, 350], binsPerCell: 4 })
    await l.land(block(l.asked[0].rows, 1, l.asked[0].cols))
    const wall = l.asked[0].rows[1]
    l.it.consider({ rows: [wall - 350, wall], cols: [wall - 350, wall], binsPerCell: 1 })
    const next = l.asked[1]
    await l.land(block(next.rows, 1, next.cols))

    // The reader has not moved. Sitting still where a read just landed must not
    // ask for another — that is the loop this whole rule could have become.
    const asked = l.asked.length
    for (let i = 0; i < 5; i++) {
      l.it.consider({ rows: [wall - 350, wall], cols: [wall - 350, wall], binsPerCell: 1 })
    }
    expect(l.asked).toHaveLength(asked)
  })
})

describe('what the ladder holds', () => {
  it('hands back a block it already has instead of reading it again', async () => {
    const l = ladder()
    const coarse = block(WHOLE, 13)
    l.it.adopt(coarse)

    // In: a read, and the fine block is drawn.
    l.it.consider({ rows: [10_000, 22_000], cols: [10_000, 22_000], binsPerCell: 13 })
    const fine = block([4_000, 28_000], 6)
    await l.land(fine)
    expect(l.given.at(-1)).toBe(fine)

    // Out again, past what the fine block covers. The coarse one is still here.
    const asked = l.asked.length
    l.it.consider({ rows: WHOLE, cols: WHOLE, binsPerCell: 6 })
    expect(l.given.at(-1), 'zooming out is free').toBe(coarse)
    expect(l.asked, 'and costs no read').toHaveLength(asked)
  })

  it('prefers the finest block that covers the window', async () => {
    const l = ladder()
    l.it.adopt(block(WHOLE, 13))
    l.it.consider({ rows: [10_000, 22_000], cols: [10_000, 22_000], binsPerCell: 13 })
    const fine = block([4_000, 28_000], 6)
    await l.land(fine)

    // A window inside both: the finer one wins.
    l.it.consider({ rows: [12_000, 14_000], cols: [12_000, 14_000], binsPerCell: 6 })
    expect(l.given.at(-1)).toBe(fine)
  })
})

/** A view as `MatrixPanel.refineWindow` reports it: square, on a screen `screen` pixels wide. */
function seen(at: Extent, options: { screen?: number; fit?: number; binsPerCell?: number } = {}) {
  return {
    rows: at,
    cols: at,
    binsPerCell: options.binsPerCell ?? 1,
    ...(options.screen === undefined ? {} : { screen: options.screen }),
    ...(options.fit === undefined ? {} : { fit: options.fit }),
  }
}

describe('a screen-sized read', () => {
  it('puts a cell on each pixel of the view, from the coarsest rung that does', () => {
    // A whole chromosome of 7,849 bins at 25 kb on a 700-pixel plot: a cell of
    // 280 kb, which the 250 kb rung stores — read as it is, not pooled out of
    // the 25 kb map's seven thousand rows.
    const rungs = rungsOf(['25000', '50000', '100000', '250000', '500000'])
    const plan = screenPlan({ rungs, binsize: 25_000, view: 7_849, read: 7_849, screen: 700 })
    expect(plan.rung).toBe('250000')
    expect(plan.binsPerCell).toBeUndefined()
    expect(plan.grid).toBe(10)
  })

  it('pools within the rung to the cell where the rung is finer', () => {
    const rungs = rungsOf(['25000', '100000'])
    // A cell of 280 kb out of 100 kb bins: three of them, the nearest whole
    // number, a 300 kb grid — not two, which would put nearly one and a half
    // cells on each pixel and colour twice what the screen can show.
    const plan = screenPlan({ rungs, binsize: 25_000, view: 7_849, read: 7_849, screen: 700 })
    expect(plan.rung).toBe('100000')
    expect(plan.binsPerCell).toBe(3)
    expect(plan.grid).toBe(12)
  })

  it('reads the stored rung that is the cell, rather than pooling a finer one into it', () => {
    // A mouse chr1 of 19,547 bins at 10 kb on 690 pixels: a cell of 283 kb is
    // two of the 160 kb rung's bins — which is the 320 kb rung's own bin,
    // stored in a quarter of the pixels.
    const rungs = rungsOf(['10000', '20000', '40000', '80000', '160000', '320000', '640000'])
    const plan = screenPlan({ rungs, binsize: 10_000, view: 19_547, read: 19_547, screen: 690 })
    expect(plan).toEqual({ rung: '320000', grid: 32 })
  })

  it('reads the open map itself, a bin to a cell, once the view is narrower than the screen', () => {
    const rungs = rungsOf(['25000', '100000'])
    const plan = screenPlan({ rungs, binsize: 25_000, view: 400, read: 800, screen: 700 })
    expect(plan).toEqual({ grid: 1 })
  })

  it('pools the open map where there is no ladder', () => {
    const plan = screenPlan({ rungs: [], binsize: 1_000, view: 15_300, read: 15_300, screen: 690 })
    expect(plan.rung).toBeUndefined()
    expect(plan.binsPerCell).toBe(22)
    expect(plan.grid).toBe(22)
  })

  it('holds the grid the reader declared, and names no rung under it', () => {
    // A 10 kb* resolution added over a 2 kb map is five of its bins (§3.4): the
    // screen's grid is a whole number of those, never a rung's.
    const rungs = rungsOf(['2000', '10000', '50000'])
    const wide = screenPlan({ rungs, binsize: 2_000, view: 60_000, read: 60_000, screen: 600, floor: 5 })
    expect(wide.rung).toBeUndefined()
    expect(wide.binsPerCell).toBe(100)
    const close = screenPlan({ rungs, binsize: 2_000, view: 300, read: 600, screen: 600, floor: 5 })
    expect(close).toEqual({ binsPerCell: 5, grid: 5 })
  })

  it('coarsens a read much wider than its view rather than letting it grow with it', () => {
    const plan = screenPlan({ rungs: [], binsize: 1, view: 1_000, read: 20_000, screen: 500 })
    // A cell per pixel of the view would be 20,000 / 2 = 10,000 cells across.
    expect(20_000 / plan.grid).toBeLessThanOrEqual(SCREEN_READ_CAP * 500)
  })

  it('is what the ladder asks for once the view says how wide its screen is', () => {
    const l = ladder()
    l.it.adopt(block(WHOLE, 72))
    l.it.consider(seen([10_000, 22_000], { screen: 690, fit: 4, binsPerCell: 72 }))
    expect(l.asked).toHaveLength(1)
    const read = l.asked[0]
    // Padded half a window each side, at a cell to a pixel of the view: 12,000
    // bins over 690 pixels is 17 bins a cell.
    expect(read.rows).toEqual([4_000, 28_000])
    expect(read.plan).toEqual({ binsPerCell: 17, grid: 17 })
  })

  it('takes the last step to the file’s own bins, factor of two or not', () => {
    // A block of two bins a cell under a view narrow enough to show every bin:
    // the factor of two is there to stop a slow zoom reading at every step, and
    // at the file's own bins there is no step after this one.
    const l = ladder()
    l.it.adopt(block([20_000, 24_000], 2))
    l.it.consider(seen([21_000, 22_000], { screen: 690, fit: 4, binsPerCell: 2 }))
    expect(l.asked).toHaveLength(1)
    expect(l.asked[0].plan).toEqual({ grid: 1 })
  })

  it('reads nothing while the view still has a cell to each pixel or two', () => {
    const l = ladder()
    l.it.adopt(block(WHOLE, 72))
    // The whole domain on 690 pixels wants 72 bins a cell — what it has.
    l.it.consider(seen(WHOLE, { screen: 690, fit: 1, binsPerCell: 72 }))
    expect(l.asked).toHaveLength(0)
  })
})

describe('a gesture that outruns its read', () => {
  it('calls the read off for a finer one once the zoom is twice past it', () => {
    const l = ladder()
    l.it.adopt(block(WHOLE, 72))
    l.it.consider(seen([10_000, 22_000], { screen: 690, fit: 4, binsPerCell: 72 }))
    expect(l.asked).toHaveLength(1)
    // Still zooming, inside the window being read: a grid it has not outrun.
    l.it.consider(seen([12_000, 20_000], { screen: 690, fit: 6, binsPerCell: 72 }))
    expect(l.cancels).toBe(0)
    // Zoomed on, to a window the read in flight would land three times too
    // coarse for: the latest window wins.
    l.it.consider(seen([15_000, 17_000], { screen: 690, fit: 24, binsPerCell: 72 }))
    expect(l.cancels).toBe(1)
    expect(l.asked).toHaveLength(2)
    expect(l.asked[1].plan?.grid).toBeLessThan(l.asked[0].plan!.grid / 2)
  })

  it('never holds the view: the spinner turns, and nothing else is asked of it', () => {
    const l = ladder()
    l.it.adopt(block(WHOLE, 72))
    l.it.consider(seen([10_000, 22_000], { screen: 690, fit: 4, binsPerCell: 72 }))
    // `busy` is the whole of what a read in flight says to the panel.
    expect(l.busy).toEqual([true])
  })
})

describe('reading ahead', () => {
  // A block of 40 bins a cell; on a 460-pixel screen a 12,000-bin view wants
  // 26 — between a factor of 1.4 and of 2 of what is on screen.
  it('waits for the factor of two while the view stands still', () => {
    const l = ladder({ now: () => 0 })
    l.it.adopt(block([0, 24_000], 40))
    l.it.consider(seen([6_000, 18_000], { screen: 460, fit: 2, binsPerCell: 40 }))
    expect(l.asked).toHaveLength(0)
  })

  it('reads sooner while the zoom is going inward', () => {
    let now = 0
    const l = ladder({ now: () => now })
    l.it.adopt(block([0, 24_000], 40))
    l.it.consider(seen([5_000, 19_000], { screen: 460, fit: 1.7, binsPerCell: 40 }))
    expect(l.asked).toHaveLength(0)
    now += 30
    l.it.consider(seen([6_000, 18_000], { screen: 460, fit: 2, binsPerCell: 40 }))
    expect(l.asked, 'read before the factor of two').toHaveLength(1)
  })

  it('takes a narrower view after a pause for a jump, not a zoom', () => {
    let now = 0
    const l = ladder({ now: () => now })
    l.it.adopt(block([0, 24_000], 40))
    l.it.consider(seen([5_000, 19_000], { screen: 460, fit: 1.7, binsPerCell: 40 }))
    now += INWARD_MS + 1
    l.it.consider(seen([6_000, 18_000], { screen: 460, fit: 2, binsPerCell: 40 }))
    expect(l.asked).toHaveLength(0)
  })

  it('reads around the view before a pan reaches the edge of its block', () => {
    const l = ladder()
    l.it.adopt(block([10_000, 20_000], 1))
    // Zoomed in, a whole view from the right edge: nothing.
    l.it.consider(seen([13_000, 15_000], { screen: 2_000, fit: 5 }))
    expect(l.asked).toHaveLength(0)
    // Within a quarter of a view of it, still not touching it: read.
    const margin = READ_AHEAD_EDGE * 2_000
    l.it.consider(seen([18_000 - margin + 100, 20_000 - margin + 100], { screen: 2_000, fit: 5 }))
    expect(l.asked).toHaveLength(1)
    const read = l.asked[0]
    expect(read.rows[0]).toBeLessThan(18_000)
    expect(read.rows[1]).toBeGreaterThan(20_000)
  })

  it('does not hand back a finer block whose edge the reader stands near', async () => {
    // A block a zoom has left behind is finer than the screen needs, which is
    // what made it look like the better answer: handed back, it was read around
    // at the screen's grid, handed back again for being finer than that read,
    // and read around again — frame after frame, for a reader standing still.
    const l = ladder()
    l.it.adopt(block([10_000, 20_000], 1))
    const view = seen([11_000, 16_000], { screen: 1_000, fit: 2 })
    l.it.consider(view)
    expect(l.asked).toHaveLength(1)
    const around = block(l.asked[0].rows, l.asked[0].plan?.grid ?? 1)
    await l.land(around)
    for (let frame = 0; frame < 5; frame++) l.it.consider(view)
    expect(l.asked).toHaveLength(1)
    expect(l.given.at(-1)).toBe(around)
  })

  it('keeps a finer block near whose edge the reader is, and reads ahead of it', () => {
    // A coarser block in hand reaches further, and is within a factor of two
    // of what the screen wants: but handing it over would coarsen the picture
    // of where the reader already is, for want of where they are going.
    const l = ladder()
    l.it.adopt(block([0, 40_000], 4))
    l.it.adopt(block([10_000, 14_000], 1))
    l.it.consider(seen([11_700, 13_700], { screen: 1_000, fit: 2 }))
    expect(l.given, 'nothing handed over').toHaveLength(0)
    expect(l.asked, 'read ahead').toHaveLength(1)
  })

  it('still hands back a finer block that is good enough to stay', async () => {
    const l = ladder()
    const fine = block([10_000, 20_000], 1)
    l.it.adopt(fine)
    l.it.consider(seen([11_000, 16_000], { screen: 1_000, fit: 2 }))
    await l.land(block(l.asked[0].rows, l.asked[0].plan?.grid ?? 1))
    // Back in, to the middle of the finer block: it is the picture, for free.
    l.it.consider(seen([14_000, 16_000], { screen: 1_000, fit: 2.5 }))
    expect(l.given.at(-1)).toBe(fine)
    expect(l.asked).toHaveLength(1)
  })
})

describe('a view showing its whole block', () => {
  it('reads nothing for the block’s edges while it is fitted', () => {
    // A region opened on part of a sequence: the block is the region, and the
    // fitted view is pressed against every edge of it because it shows all of
    // it. That used to read nine times the window the moment the region opened.
    const l = ladder()
    l.it.adopt(block([20_000, 22_000], 1))
    l.it.consider(seen([20_000, 22_000], { screen: 4_000, fit: 1 }))
    expect(l.asked).toHaveLength(0)
  })

  it('widens once the reader pulls back past the block', () => {
    const l = ladder()
    l.it.adopt(block([20_000, 22_000], 1))
    l.it.consider(seen([20_000, 22_000], { screen: 4_000, fit: 0.6 }))
    expect(l.asked).toHaveLength(1)
    expect(l.asked[0].rows).toEqual([18_000, 24_000])
  })
})

describe('a figure’s block', () => {
  it('reads the framed window as memory allows, and nothing else meanwhile', async () => {
    const l = ladder()
    l.it.adopt(block(WHOLE, 72))
    let reading = 0
    const done = l.it.sharpen({ rows: [10_000, 14_000], cols: [10_000, 14_000] }, () => (reading += 1))
    expect(reading).toBe(1)
    expect(l.asked).toHaveLength(1)
    expect(l.asked[0].plan, 'no screen plan: as memory allows').toBeUndefined()
    // The framed window and a twentieth of it each side, so the view carried
    // onto the block stays inside it.
    expect(l.asked[0].rows).toEqual([9_800, 14_200])
    // A frame meanwhile asks for nothing: a read now would be for a picture the
    // figure's block is about to replace.
    l.it.consider(seen([11_000, 12_000], { screen: 600, fit: 10, binsPerCell: 72 }))
    expect(l.asked).toHaveLength(1)
    await l.land(block([9_800, 14_200], 1))
    expect(await done).toBe(true)
    expect(l.given.at(-1)?.binsPerCell).toBe(1)
    // The same window on a finer grid, not a zoom: its colours are measured on
    // itself, where a zoom's are kept from the block it replaces.
    expect(l.hows.at(-1)).toEqual({ measure: true })
  })

  it('stays on screen until the reader moves', async () => {
    // Finer than the screen needs and only a twentieth wider than the frame:
    // left to the rules for a view, the next frame would read a screen-sized
    // block around it, for a reader who has not moved.
    const l = ladder()
    l.it.adopt(block(WHOLE, 72))
    const done = l.it.sharpen({ rows: [10_000, 14_000], cols: [10_000, 14_000] })
    const figure = block([9_800, 14_200], 1)
    await l.land(figure)
    expect(await done).toBe(true)
    const framed = seen([10_000, 14_000], { screen: 600, fit: 1.1 })
    for (let frame = 0; frame < 3; frame++) l.it.consider(framed)
    expect(l.asked).toHaveLength(1)
    expect(l.given.at(-1)).toBe(figure)
    // A pan: the view's own rules again, which read around where it went.
    l.it.consider(seen([10_100, 14_100], { screen: 600, fit: 1.1 }))
    expect(l.asked).toHaveLength(2)
    expect(l.asked[1].plan).toBeDefined()
  })

  it('reads nothing where the block on screen is already that fine', async () => {
    const l = ladder()
    l.it.adopt(block([10_000, 14_000], 1))
    let reading = 0
    expect(await l.it.sharpen({ rows: [11_000, 12_000], cols: [11_000, 12_000] }, () => (reading += 1))).toBe(true)
    expect(reading).toBe(0)
    expect(l.asked).toHaveLength(0)
    // Nor handed over again: the figure is the picture the reader framed.
    expect(l.given).toHaveLength(0)
  })

  it('says so when its read fails, and leaves the picture as it was', async () => {
    const l = ladder()
    l.it.adopt(block(WHOLE, 72))
    const done = l.it.sharpen({ rows: [10_000, 14_000], cols: [10_000, 14_000] })
    await l.fail(new Error('too large'))
    expect(await done).toBe(false)
    expect(l.given).toHaveLength(0)
  })
})

describe('reads in flight', () => {
  it('calls off a read whose window the reader has already left', () => {
    const l = ladder()
    l.it.adopt(block(WHOLE, 13))
    l.it.consider({ rows: [10_000, 22_000], cols: [10_000, 22_000], binsPerCell: 13 })
    expect(l.asked).toHaveLength(1)
    expect(l.cancels).toBe(0)

    // Somewhere else entirely, and still nothing has landed.
    l.it.consider({ rows: [40_000, 44_000], cols: [40_000, 44_000], binsPerCell: 13 })
    expect(l.cancels, 'the stale read is called off').toBe(1)
    expect(l.asked).toHaveLength(2)
  })

  it('lets a read finish when the reader is still inside it', () => {
    const l = ladder()
    l.it.adopt(block(WHOLE, 13))
    l.it.consider({ rows: [10_000, 22_000], cols: [10_000, 22_000], binsPerCell: 13 })
    // A nudge, still well inside the padded window that is being read.
    l.it.consider({ rows: [11_000, 21_000], cols: [11_000, 21_000], binsPerCell: 13 })
    expect(l.cancels).toBe(0)
    expect(l.asked).toHaveLength(1)
  })

  it('does not retry a refusal once per frame', async () => {
    const l = ladder()
    l.it.adopt(block(WHOLE, 13))
    const view: Extent = [10_000, 22_000]
    l.it.consider({ rows: view, cols: view, binsPerCell: 13 })
    await l.fail(new Error('too large'))

    for (let i = 0; i < 5; i++) {
      l.it.consider({ rows: view, cols: view, binsPerCell: 13 })
    }
    expect(l.asked, 'the same refused read, once').toHaveLength(1)
  })

  it('treats a cancellation as no answer rather than as a refusal', async () => {
    const l = ladder()
    l.it.adopt(block(WHOLE, 13))
    const view: Extent = [10_000, 22_000]
    l.it.consider({ rows: view, cols: view, binsPerCell: 13 })
    const abort = new Error('cancelled')
    abort.name = 'AbortError'
    await l.fail(abort)

    l.it.consider({ rows: view, cols: view, binsPerCell: 13 })
    expect(l.asked, 'the window is still worth reading').toHaveLength(2)
  })

  it('stops everything on destroy', () => {
    const l = ladder()
    l.it.adopt(block(WHOLE, 13))
    l.it.consider({ rows: [10_000, 22_000], cols: [10_000, 22_000], binsPerCell: 13 })
    l.it.destroy()
    expect(l.cancels).toBe(1)
    l.it.consider({ rows: [10_000, 12_000], cols: [10_000, 12_000], binsPerCell: 13 })
    expect(l.asked).toHaveLength(1)
  })
})

/**
 * A window across a circle's origin is a **frame** (SPECS §8.15).
 *
 * The `ori` framing and a window typed backwards both run off the end of the
 * sequence, in the unwrapped bins they are read in, and the view hands that
 * extent to the ladder as its ceiling. What is pinned is the whole of the rule:
 * a zoom inside it refines, every read stays inside it — past the sequence's
 * own end, which is the point of the frame — and nothing reads past it, which
 * is what the ladder used to do when it slid a view round the circle.
 */
describe('BlockLadder, inside a frame across a circle’s origin', () => {
  const LAP = 10_000
  // The `ori` frame of a sequence whose origin is its first base: half a lap
  // either side of the join, in bins that run past the sequence's end.
  const FRAME: Extent = [LAP / 2, LAP * 1.5]
  const frame = (): ReturnType<typeof ladder> => ladder({ ceiling: FRAME })

  it('refines a window across the join, as a read past the sequence’s end', () => {
    const l = frame()
    l.it.adopt(block(FRAME, 25))
    // A zoom on the join itself, which is the middle of the frame.
    l.it.consider({ rows: [LAP - 500, LAP + 500], cols: [LAP - 500, LAP + 500], binsPerCell: 25 })
    expect(l.asked).toHaveLength(1)
    const [lo, hi] = l.asked[0].rows
    expect(lo).toBeLessThan(LAP)
    expect(hi).toBeGreaterThan(LAP)
  })

  it('never reads outside the frame, however far the reader pulls back', () => {
    const l = frame()
    l.it.adopt(block([LAP - 1_000, LAP + 1_000], 1))
    l.it.consider({ rows: [LAP - 4_000, LAP + 4_000], cols: [LAP - 4_000, LAP + 4_000], binsPerCell: 1 })
    expect(l.asked.length).toBeGreaterThan(0)
    for (const ask of l.asked) {
      expect(ask.rows[0]).toBeGreaterThanOrEqual(FRAME[0])
      expect(ask.rows[1]).toBeLessThanOrEqual(FRAME[1])
    }
  })

  it('does not slide round the circle at the frame’s edge', () => {
    const l = frame()
    // A block that runs to the frame's own far edge, with the reader pressed
    // up against it: on a circle that used to read the next stretch round.
    l.it.adopt(block([FRAME[1] - 2_000, FRAME[1]], 1))
    l.it.consider({
      rows: [FRAME[1] - 500, FRAME[1]],
      cols: [FRAME[1] - 500, FRAME[1]],
      binsPerCell: 1,
    })
    expect(l.asked).toHaveLength(0)
  })
})

describe('the first read of a pooled window (§12)', () => {
  /** A 4DN `.hic`'s ladder, opened at 25 kb. */
  const HIC = rungsOf(['2500000', '1000000', '500000', '250000', '100000', '50000', '25000', '10000', '5000'])
  /**
   * Mouse chr1 at 10 kb — 19,547 bins, past what is read bin for bin. At 25 kb
   * (7,849 bins) it no longer is: that window is now read at the open map.
   */
  const CHR1: Extent = [0, 19_547]

  it('comes from the rung that is the grid the reader would pool the open map into', () => {
    // 19,547 bins into 4,096 cells is five bins a cell: a 50 kb picture, which
    // the 50 kb rung holds in a twenty-fifth of the pixels.
    expect(gridFor(CHR1, CHR1)).toBe(5)
    expect(poolingRung(HIC, CHR1, CHR1, 10_000)).toBe('50000')
    // The same chromosome at 25 kb is read whole, so no rung is named.
    expect(poolingRung(HIC, [0, 7849], [0, 7849], 25_000)).toBeUndefined()
  })

  it('never reads coarser than that grid, so the picture is the one it was', () => {
    // Six bins a cell is 150 kb: the 50 kb rung divides it, the 100 kb one does
    // not, and 250 kb would be a coarser picture.
    const wide: Extent = [0, 6 * POOLED_CELL_CAP]
    expect(poolingRung(HIC, wide, wide, 25_000)).toBe('50000')
    const wider: Extent = [0, 10 * POOLED_CELL_CAP]
    expect(poolingRung(HIC, wider, wider, 25_000)).toBe('250000')
  })

  it('reads the open map where nothing is pooled, or no rung is the grid', () => {
    const window: Extent = [0, 400]
    expect(poolingRung(HIC, window, window, 25_000)).toBeUndefined()
    expect(poolingRung(rungsOf(['10000', '100000']), CHR1, CHR1, 10_000)).toBeUndefined()
    expect(poolingRung([], CHR1, CHR1, 10_000)).toBeUndefined()
  })

  it('is taken by the ladder as it is, so no refine follows until the reader zooms', () => {
    const l = ladder({ ceiling: CHR1 })
    // The rung's block describes itself in its own bins; `source` is the window
    // in the open map's, which is what the ladder plans against.
    const rung: MatrixResult = {
      ...block([0, 3910], 1),
      binsize: 50_000,
      source: { rows: CHR1, cols: CHR1 },
    }
    l.it.adopt(rung)
    l.it.consider({ rows: CHR1, cols: CHR1, binsPerCell: 5 })
    expect(l.asked).toEqual([])
  })
})
