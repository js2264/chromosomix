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
  attachRefine,
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
  openPick,
  pickedRead,
  recentre,
  refineEnabled,
  rungsOf,
  screenPlan,
  setRefineEnabled,
  subscribeRefine,
  type ReadPlan,
  type RefineView,
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
  options: {
    ceiling?: Extent
    reads?: Array<Extent>
    budget?: number
    now?: () => number
    /** The ladder's floor, in bins of the open map; see `LadderOptions.floor`. */
    floor?: number
    /** `false` reads as memory allows at the floor: *Refine on zoom* off. */
    screenSized?: boolean
    /** A laddered file: its rungs, and the open one's bin size. */
    file?: { rungs: string[]; binsize: number }
    /** The window on screen now; see `LadderOptions.view`. */
    view?: () => ReturnType<typeof seen> | null
    /** What a read as memory allows comes back on; see `LadderOptions.memoryGrid`. */
    memoryGrid?: (window: { rows: Extent; cols: Extent }) => number | undefined
  } = {},
) {
  const ceiling: Extent = options.ceiling ?? [0, 50_000]
  const asked: Array<{ rows: Extent; cols: Extent; plan?: ReadPlan }> = []
  const given: MatrixResult[] = []
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
    onBlock: (result) => {
      given.push(result)
      return true
    },
    onBusy: (on) => busy.push(on),
    ...(options.budget === undefined ? {} : { budget: () => options.budget }),
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.floor === undefined ? {} : { floor: () => options.floor as number }),
    ...(options.screenSized === undefined ? {} : { screenSized: () => options.screenSized as boolean }),
    ...(options.view === undefined ? {} : { view: options.view }),
    ...(options.memoryGrid === undefined ? {} : { memoryGrid: options.memoryGrid }),
    ...(options.file === undefined
      ? {}
      : {
          // As `attachRefine` plans and measures for a laddered file.
          planFor: (window: { rows: Extent; cols: Extent }, view: { rows: Extent; cols: Extent; screen?: number }) =>
            screenPlan({
              rungs: rungsOf(options.file?.rungs ?? []),
              binsize: options.file?.binsize ?? 1,
              view: Math.max(view.rows[1] - view.rows[0], view.cols[1] - view.cols[0]),
              read: Math.max(window.rows[1] - window.rows[0], window.cols[1] - window.cols[0]),
              screen: view.screen ?? 1,
              floor: options.floor ?? 1,
            }),
          gridOf: (result: MatrixResult) =>
            ((result.binsize ?? options.file?.binsize ?? 1) * (result.binsPerCell ?? 1)) /
            (options.file?.binsize ?? 1),
        }),
  })

  return {
    it,
    asked,
    given,
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
    // A window the dense read takes is read at the file's own bins: up to
    // 8,192 a side, whatever the device would allow above it (§2).
    const dense = denseCellCap()
    expect(dense).toBe(8_192)
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

  it('takes the finest stored rung whose bins fit a block read bin for bin', () => {
    // 40 Mb at 1 kb: 40,000 bins is past the 8,192 read bin for bin, and so is
    // 20,000 at 2 kb; 8,000 of the 5 kb level's bins fit.
    expect(chooseRung(YEAST, 40_000, 1000)).toBe('5000')
    // Three times as much genome: no rung fits, so the coarsest, pooled.
    expect(chooseRung(YEAST, 121_000, 1000)).toBe('10000')
    // A whole 12.1 Mb yeast genome is past 8,192 bins at 1 kb, and 6,050 at 2 kb.
    expect(chooseRung(YEAST, 12_100, 1000)).toBe('2000')
    // …and a window that fits is read at the open 1 kb.
    expect(chooseRung(YEAST, 8_000, 1000)).toBeUndefined()
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
    // reads bin for bin only as wide as that share affords. 6,000 bins on half
    // a gigabyte is pooled two to a cell — and a ladder that judged it against
    // the whole device would want one bin to a cell, get two, and ask again.
    const budget = 5e8
    expect(denseCellCap(budget)).toBeLessThan(6_000)
    expect(denseCellCap()).toBeGreaterThanOrEqual(6_000)
    const l = ladder({ ceiling: [0, 6_000], budget })
    l.it.adopt(block([0, 6_000], 2))
    l.it.consider({ rows: [0, 6_000], cols: [0, 6_000], binsPerCell: 2 })
    expect(l.asked).toHaveLength(0)
    // The same block on the device's own budget is not good enough.
    const whole = ladder({ ceiling: [0, 6_000] })
    whole.it.adopt(block([0, 6_000], 2))
    whole.it.consider({ rows: [0, 6_000], cols: [0, 6_000], binsPerCell: 2 })
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

describe('a ladder armed after the reader has moved', () => {
  it('considers the window already on screen when it adopts its block', () => {
    // A view arms its ladder once it knows its sequence's extent, a round trip
    // a reader can zoom through; nothing asks again until the map moves.
    let shown: ReturnType<typeof seen> | null = seen([10_000, 12_000], { screen: 700, fit: 25 })
    const l = ladder({ view: () => shown })
    l.it.adopt(block(WHOLE, 72))
    expect(l.asked).toHaveLength(1)
    // Fitted, there is nothing to read.
    shown = seen(WHOLE, { screen: 700, fit: 1 })
    const again = ladder({ view: () => shown })
    again.it.adopt(block(WHOLE, 72))
    expect(again.asked).toHaveLength(0)
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

  it('reads the stored rung nearest a pixel as it is, and never pools a ladder into a resolution it does not store', () => {
    // A cell of 280 kb, and the ladder stops at 100 kb: the 100 kb rung, read
    // bin for bin. It used to be summed three by three into 300 kb cells — the
    // same pixels downloaded, to draw a resolution the file does not have.
    const rungs = rungsOf(['25000', '100000'])
    const plan = screenPlan({ rungs, binsize: 25_000, view: 7_849, read: 7_849, screen: 700 })
    expect(plan).toEqual({ rung: '100000', grid: 4 })
  })

  it('takes the coarser rung where it is the nearer, rather than pooling the finer', () => {
    // chr6 of a 4DN `.mcool` opened at 1 Mb, 171 Mb over 690 pixels: 248 kb a
    // pixel. The 250 kb rung, not the 100 kb one summed two by two into 200 kb.
    const rungs = rungsOf(['1000', '5000', '10000', '25000', '50000', '100000', '250000', '500000', '1000000'])
    const plan = screenPlan({ rungs, binsize: 1_000_000, view: 171, read: 171, screen: 690, floor: 0.001 })
    expect(plan.rung).toBe('250000')
    expect(plan.binsPerCell).toBeUndefined()
    expect(plan.grid).toBeCloseTo(0.25, 9)
  })

  it('pools a ladder only where even its coarsest rung is too fine for the read', () => {
    // A whole human genome opened at 1 kb, on 690 pixels: within 3.2 screens a
    // cell can be no smaller than about 1.4 Mb, and the coarsest rung is 1 Mb.
    const rungs = rungsOf(['1000', '10000', '100000', '1000000'])
    const plan = screenPlan({ rungs, binsize: 1_000, view: 3_088_270, read: 3_088_270, screen: 690, floor: 1 })
    expect(plan.rung).toBe('1000000')
    expect(plan.binsPerCell).toBe(2)
    expect(plan.grid).toBe(2_000)
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

describe('down to the finest rung the file stores (§2)', () => {
  // Chicken's `.hic`, opened at 10 kb, stores 1, 2 and 5 kb as well.
  const CHICKEN = ['1000', '2000', '5000', '10000', '25000', '50000', '100000', '250000']

  it('reads a rung finer than the one that is open, as it is', () => {
    // 400 kb over 700 pixels is a cell of about 570 bp: the 1 kb rung.
    const plan = screenPlan({ rungs: rungsOf(CHICKEN), binsize: 10_000, view: 40, read: 80, screen: 700, floor: 0.1 })
    expect(plan.rung).toBe('1000')
    expect(plan.binsPerCell).toBeUndefined()
    expect(plan.grid).toBeCloseTo(0.1, 9)
  })

  it('reads the finer rung that is the cell, not the open one', () => {
    // 2 Mb over 700 pixels is a cell of about 2.9 kb: the 2 kb rung.
    const plan = screenPlan({ rungs: rungsOf(CHICKEN), binsize: 10_000, view: 200, read: 400, screen: 700, floor: 0.1 })
    expect(plan.rung).toBe('2000')
    expect(plan.grid).toBeCloseTo(0.2, 9)
  })

  it('stops at the open rung where the floor is the open rung', () => {
    // *Refine on zoom* off, the picked resolution is the floor: nothing finer.
    const plan = screenPlan({ rungs: rungsOf(CHICKEN), binsize: 10_000, view: 40, read: 80, screen: 700, floor: 1 })
    expect(plan.rung).toBeUndefined()
    expect(plan.grid).toBe(1)
  })

  it('comes to rest on the finest rung, and reads no more', async () => {
    const l = ladder({ floor: 0.1, file: { rungs: CHICKEN, binsize: 10_000 } })
    l.it.adopt(block(WHOLE, 25))
    const view = seen([20_000, 20_040], { screen: 700, fit: 600 })
    l.it.consider(view)
    expect(l.asked).toHaveLength(1)
    expect(l.asked[0].plan?.rung).toBe('1000')
    // The 1 kb rung's block: ten of its cells to a bin of the open map.
    const rows = l.asked[0].rows
    const fine = { ...block(rows, 1), nrows: (rows[1] - rows[0]) * 10, ncols: (rows[1] - rows[0]) * 10, binsize: 1_000 }
    await l.land(fine as MatrixResult)
    expect(l.given.at(-1)).toBe(fine)
    for (let frame = 0; frame < 3; frame++) l.it.consider(view)
    expect(l.asked).toHaveLength(1)
  })
})

describe('the picked resolution, with *Refine on zoom* off (§3.4)', () => {
  it('reads it as memory allows, around the view, as soon as the view fits', () => {
    // A view of 12,000 bins fits a block at the picked grid; twice it, which a
    // read padded half a view each side asks for, would not, and was pooled.
    const budget = 600 << 20
    const cap = denseCellCap(budget)
    const l = ladder({ screenSized: false, ceiling: [0, 100_000], budget })
    l.it.adopt(block([0, 100_000], 25))
    const at: Extent = [40_000, 40_000 + Math.floor(cap * 0.75)]
    l.it.consider(seen(at, { screen: 700, fit: 8 }))
    expect(l.asked).toHaveLength(1)
    const read = l.asked[0]
    expect(read.plan, 'as memory allows').toBeUndefined()
    expect(read.rows[1] - read.rows[0]).toBeLessThanOrEqual(cap)
    expect(read.rows[0]).toBeLessThanOrEqual(at[0])
    expect(read.rows[1]).toBeGreaterThanOrEqual(at[1])
  })

  it('reads a rung finer than the open map’s, which a read in its bins can reach', () => {
    // 1 kb picked over a file opened at 10 kb: the floor is a tenth of an open
    // bin. Counted in open bins a read is never finer than one, so the 10 kb
    // block passed for as fine as memory allows and the pick was never read.
    const file = { rungs: ['1000', '10000'], binsize: 10_000 }
    const l = ladder({
      screenSized: false,
      floor: 0.1,
      file,
      ceiling: [0, 20_000],
      // As `attachRefine` answers it from the picked read: a 600-bin window is
      // 6,000 of the 1 kb rung's bins, which fit a block unpooled.
      memoryGrid: () => 0.1,
    })
    l.it.adopt({ ...block([0, 20_000], 1), binsize: 10_000 })
    const view = seen([5_000, 5_600], { fit: 30 })
    l.it.consider(view)
    expect(l.asked).toHaveLength(1)
    expect(l.asked[0].plan, 'as memory allows').toBeUndefined()
    // Landed, the pick is the picture, and nothing more is read for it.
    void l.land({ ...block(l.asked[0].rows, 1, l.asked[0].cols), binsize: 1_000 })
    return Promise.resolve().then(() => {
      l.it.consider(view)
      expect(l.asked).toHaveLength(1)
    })
  })

  it('leaves the open map’s block alone where no read could be finer', () => {
    // The same block, the same view, no pick: the open map's bins are the
    // finest a read of it comes back on.
    const l = ladder({ screenSized: false, ceiling: [0, 20_000] })
    l.it.adopt(block([0, 20_000], 1))
    l.it.consider(seen([5_000, 5_600], { fit: 30 }))
    expect(l.asked).toHaveLength(0)
  })

  it('reads a view too wide for it pooled, as it was asked', () => {
    const budget = 600 << 20
    const cap = denseCellCap(budget)
    const l = ladder({ screenSized: false, ceiling: [0, 100_000], budget })
    l.it.adopt(block([0, 100_000], 40))
    const at: Extent = [20_000, 20_000 + cap * 2]
    l.it.consider(seen(at, { screen: 700, fit: 1.5 }))
    expect(l.asked).toHaveLength(1)
    expect(l.asked[0].rows[1] - l.asked[0].rows[0]).toBeGreaterThan(cap)
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

describe('the first read of a window too wide for its resolution (§2, §3.4)', () => {
  /** A 4DN `.hic`'s ladder, opened at 25 kb. */
  const HIC = rungsOf(['2500000', '1000000', '500000', '250000', '100000', '50000', '25000', '10000', '5000'])
  /** Mouse chr1 at 10 kb: 19,547 bins, past the 8,192 a block is read bin for bin. */
  const CHR1: Extent = [0, 19_547]

  it('comes from the finest stored rung that fits, not the open map summed', () => {
    // 195 Mb: 7,819 of the 25 kb rung's bins, which fit. The open map summed
    // three by three into 30 kb cells would be a resolution nobody stored.
    expect(pickedRead(openPick(10_000), HIC, 10_000, CHR1[1])).toEqual({ rung: '25000' })
  })

  it('reads the open map wherever the window fits it', () => {
    expect(pickedRead(openPick(25_000), HIC, 25_000, 7_849)).toEqual({})
  })

  it('crosses a gap in the ladder to the next stored rung, rather than pooling into it', () => {
    // 130 Mb of a `10 / 100 kb` file: the 100 kb rung, 1,300 bins — where the
    // open map used to be summed four by four into 40 kb.
    expect(pickedRead(openPick(10_000), rungsOf(['10000', '100000']), 10_000, 13_000)).toEqual({ rung: '100000' })
  })

  it('leaves a file with no ladder to the reader, which pools it', () => {
    expect(pickedRead(openPick(10_000), [], 10_000, CHR1[1])).toEqual({})
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

describe('attachRefine, with a resolution picked (§3.4)', () => {
  /** A ladder joined to a stand-in panel, *Refine on zoom* off, recording its reads. */
  function picked(pick: { binsize: number; rung: { name: string; binsize: number }; factor: number }) {
    let listener: ((view: RefineView) => void) | null = null
    const reads: Array<{ rows: Extent; rung: string | undefined; binsPerCell: number | undefined }> = []
    const ladder = attachRefine({
      panel: {
        setRefineListener: (fn) => {
          listener = fn
        },
        regrid: () => true,
        setWaiting: () => {},
      },
      read: (rows, _cols, rung, binsPerCell) => {
        reads.push({ rows, rung, binsPerCell })
        return { promise: new Promise(() => {}), cancel: () => {} }
      },
      ceiling: { rows: [0, 20_000], cols: [0, 20_000] },
      // Opened at 10 kb, beside a 1 kb rung.
      binsize: 10_000,
      rungs: [
        { name: '1000', binsize: 1_000 },
        { name: '10000', binsize: 10_000 },
      ],
      picked: () => pick,
    })
    // The open map's block, from its own entry.
    ladder.adopt(block([0, 20_000], 1))
    return { ladder, reads, look: (view: RefineView) => listener?.(view) }
  }

  it('reads a rung finer than the one the file was opened at, once the window fits it', () => {
    const was = refineEnabled()
    setRefineEnabled(false)
    try {
      const { ladder, reads, look } = picked({ binsize: 1_000, rung: { name: '1000', binsize: 1_000 }, factor: 1 })
      // Six megabases: 600 bins of the open map, 6,000 of the 1 kb rung's.
      look(seen([5_000, 5_600], { fit: 30 }))
      expect(reads).toHaveLength(1)
      expect(reads[0].rung).toBe('1000')
      expect(reads[0].binsPerCell).toBeUndefined()
      ladder.destroy()
    } finally {
      setRefineEnabled(was)
    }
  })

  it('reads nothing for a pick the block on screen already is', () => {
    const was = refineEnabled()
    setRefineEnabled(false)
    try {
      const { ladder, reads, look } = picked({ binsize: 10_000, rung: { name: '10000', binsize: 10_000 }, factor: 1 })
      look(seen([5_000, 5_600], { fit: 30 }))
      expect(reads).toHaveLength(0)
      ladder.destroy()
    } finally {
      setRefineEnabled(was)
    }
  })
})
