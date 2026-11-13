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
  ZOOM_PAUSE_MS,
  REFINE_DEFAULT,
  SCREEN_READ_CAP,
  chooseRung,
  clip,
  covers,
  memoryPlan,
  pad,
  openPick,
  planFields,
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
    /** What a read as memory allows comes back on, where the harness's own sum is not it. */
    memoryGrid?: (window: { rows: Extent; cols: Extent }) => number | undefined
  } = {},
) {
  const ceiling: Extent = options.ceiling ?? [0, 50_000]
  const asked: Array<{ rows: Extent; cols: Extent; plan: ReadPlan }> = []
  const given: MatrixResult[] = []
  const busy: boolean[] = []
  let settle: ((result: MatrixResult) => void) | null = null
  let refuse: ((err: unknown) => void) | null = null
  let cancels = 0
  // The clock where the test brings none: still unless a pause moves it, which
  // is what frames a few microseconds apart are.
  let clockAt = 0
  let waiting: (() => void) | null = null
  // What the ladder said it reads at, each time that changed (`onTarget`).
  const targets: Array<number | null> = []
  // How many times the ladder asked for the view to be fitted (`onWhole`).
  let wholes = 0

  const it = new BlockLadder({
    ceiling: { rows: ceiling, cols: ceiling },
    read: (rows, cols, plan) => {
      asked.push({ rows, cols, plan })
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
    onTarget: (grid) => targets.push(grid),
    onWhole: () => {
      wholes += 1
    },
    now: options.now ?? (() => clockAt),
    after: (_ms, then) => {
      waiting = then
      return () => {
        if (waiting === then) waiting = null
      }
    },
    ...(options.floor === undefined ? {} : { floor: () => options.floor as number }),
    ...(options.screenSized === undefined ? {} : { screenSized: () => options.screenSized as boolean }),
    ...(options.view === undefined ? {} : { view: options.view }),
    // As memory allows: one block's width at the floor, around the view.
    reach: () => {
      const floor = options.floor ?? 1
      return (floor > 1 ? POOLED_CELL_CAP : denseCellCap(options.budget)) * floor
    },
    // As `attachRefine` plans: screen-sized where the view has a screen and the
    // zoom picks, as memory allows at the floor otherwise.
    plan: (window, view) => {
      const viewSpan = Math.max(view.rows[1] - view.rows[0], view.cols[1] - view.cols[0])
      const read = Math.max(window.rows[1] - window.rows[0], window.cols[1] - window.cols[0])
      const floor = options.floor ?? 1
      if (options.screenSized !== false && view.screen !== undefined && view.screen > 0) {
        return screenPlan({
          rungs: rungsOf(options.file?.rungs ?? []),
          binsize: options.file?.binsize ?? 1,
          view: viewSpan,
          read,
          screen: view.screen,
          floor: Math.min(1, floor),
        })
      }
      const own = options.memoryGrid?.(window)
      if (own !== undefined) return { grid: own }
      const grid = Math.max(floor, read <= denseCellCap(options.budget) ? 1 : Math.ceil(read / POOLED_CELL_CAP))
      return { ...(grid > 1 ? { binsPerCell: grid } : {}), grid }
    },
    ...(options.file === undefined
      ? {}
      : {
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
    targets,
    get cancels() {
      return cancels
    },
    /** How many times a whole read landed on a view still fitted. */
    get wholes() {
      return wholes
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
    /** Whether a read is held for the zoom to pause. */
    get holding() {
      return waiting !== null
    },
    /**
     * The zoom pauses: {@link ZOOM_PAUSE_MS} pass on the harness's clock, and
     * the read held for it is considered. A test with a clock of its own moves
     * that one first.
     */
    pause(): void {
      clockAt += ZOOM_PAUSE_MS
      const then = waiting
      waiting = null
      then?.()
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

  it('plans the open map of a file with no ladder bin for bin up to the dense cap, and pooled past it', () => {
    // A window the dense read takes is read at the file's own bins: up to
    // 8,192 a side, whatever the device would allow above it (§2).
    const dense = denseCellCap()
    expect(dense).toBe(8_192)
    expect(memoryPlan(openPick(1), [], 1, dense)).toEqual({ grid: 1 })
    // One bin past it is pooled, to the pooled read's grid — asked for, so the
    // grid the ladder expects is the one the read is asked at.
    const k = Math.ceil((dense + 1) / POOLED_CELL_CAP)
    expect(memoryPlan(openPick(1), [], 1, dense + 1)).toEqual({ binsPerCell: k, grid: k })
    // Human chr1 at 5 kb: 49,792 bins is thirteen to a cell.
    expect(memoryPlan(openPick(5_000), [], 5_000, 49_792).grid).toBe(13)
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
    l.it.consider({ rows: WHOLE, cols: WHOLE })
    expect(l.asked).toHaveLength(0)
    expect(l.busy, 'and never shows the spinner').toHaveLength(0)
  })

  it('does not read for less than a factor of two', () => {
    const l = ladder()
    l.it.adopt(block(WHOLE, 13))
    // Zoomed to two thirds of the domain: that window would be read at k=9,
    // which is finer — but not twice as fine, so the picture stays.
    const view: Extent = [0, 33_000]
    expect(Math.ceil((view[1] - view[0]) * 2 / POOLED_CELL_CAP)).toBeGreaterThan(13 / 2)
    l.it.consider({ rows: view, cols: view })
    expect(l.asked).toHaveLength(0)
    expect(l.busy).toHaveLength(0)
  })

  it('reads on the frame that crosses, and says so while it does', () => {
    const l = ladder()
    l.it.adopt(block(WHOLE, 13))
    const view: Extent = [10_000, 22_000]
    l.it.consider({ rows: view, cols: view })
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
    l.it.consider({ rows: [10_000, 22_000], cols: [10_000, 22_000] })
    expect(l.busy).toEqual([true])
    await l.land(block([4_000, 28_000], 6))
    expect(l.busy, 'turning, then stopped').toEqual([true, false])
  })

  it('stops the spinner when the read is refused', async () => {
    const l = ladder()
    l.it.adopt(block(WHOLE, 13))
    l.it.consider({ rows: [10_000, 22_000], cols: [10_000, 22_000] })
    await l.fail(new Error('too large'))
    // A refusal that left the spinner turning would be a read that never ends,
    // which is the worst way to report one.
    expect(l.busy).toEqual([true, false])
  })

  it('issues one read for a gesture, however many frames it lasts', () => {
    const l = ladder()
    l.it.adopt(block(WHOLE, 13))
    // A wheel spin: nothing holds the view still, and the frames keep coming.
    // None of them reads while the zoom goes on — the next notches would outrun
    // the read (`ZOOM_PAUSE_MS`) — and the pause reads the window it came on.
    const spin = (i: number): { rows: Extent; cols: Extent } => {
      const half = 20_000 - i * 2_000
      return { rows: [25_000 - half, 25_000 + half], cols: [25_000 - half, 25_000 + half] }
    }
    for (let i = 0; i < 8; i++) l.it.consider(spin(i))
    expect(l.asked, 'nothing while the spin goes on').toHaveLength(0)
    l.pause()
    expect(l.asked).toHaveLength(1)
    expect(covers(l.asked[0].rows, spin(7).rows)).toBe(true)
    // Frames after it, inside the read in flight on a grid they have not
    // outrun, want that read and add none: the in-flight guard.
    for (let i = 0; i < 3; i++) l.it.consider(spin(7))
    expect(l.asked).toHaveLength(1)
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
      l.it.consider({ rows: [at - span / 2, at + span / 2], cols: [at - span / 2, at + span / 2] })
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
    l.it.consider({ rows: [24_000, 26_000], cols: [24_000, 26_000], fit: 0.5 })
    l.it.consider({ rows: [0, 50_000], cols: [0, 50_000] })
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
    l.it.consider({ rows: [0, 350], cols: [0, 350] })
    expect(l.asked).toHaveLength(1)
    const fine = block(l.asked[0].rows, 1, l.asked[0].cols)
    await l.land(fine)
    const wall = fine.rowExtent[1]
    expect(wall).toBeLessThan(15_300)

    // Now pan to that block's far edge — which is as far as the view can go.
    const asked = l.asked.length
    l.it.consider({ rows: [wall - 350, wall], cols: [wall - 350, wall] })
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
    l.it.consider({ rows: [0, 350], cols: [0, 350] })
    const first = l.asked[0]
    await l.land(block(first.rows, 1, first.cols))

    const wall = first.rows[1]
    l.it.consider({ rows: [wall - 350, wall], cols: [wall - 350, wall] })
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
    l.it.consider({ rows: [0, 6_000], cols: [0, 6_000] })
    expect(l.asked).toHaveLength(0)
    // The same block on the device's own budget is not good enough.
    const whole = ladder({ ceiling: [0, 6_000] })
    whole.it.adopt(block([0, 6_000], 2))
    whole.it.consider({ rows: [0, 6_000], cols: [0, 6_000] })
    expect(whole.asked).toHaveLength(1)
  })

  it('does not read at the edge of the world', () => {
    // The block is the whole domain: its edges are the ceiling's, so pressing
    // against them is not a request for anything, it is the end of the sequence.
    // Read bin for bin, which is how the reader answers a domain this narrow.
    const l = ladder({ ceiling: [0, 15_300] })
    l.it.adopt(block([0, 15_300], 1))
    l.it.consider({ rows: [0, 4000], cols: [0, 4000] })
    expect(l.asked).toHaveLength(0)
    l.it.consider({ rows: [11_300, 15_300], cols: [11_300, 15_300] })
    expect(l.asked).toHaveLength(0)
  })

  it('settles rather than reading again once it has recentred', async () => {
    const l = ladder({ ceiling: [0, 15_300] })
    l.it.adopt(block([0, 15_300], 4))
    l.it.consider({ rows: [0, 350], cols: [0, 350] })
    await l.land(block(l.asked[0].rows, 1, l.asked[0].cols))
    const wall = l.asked[0].rows[1]
    l.it.consider({ rows: [wall - 350, wall], cols: [wall - 350, wall] })
    const next = l.asked[1]
    await l.land(block(next.rows, 1, next.cols))

    // The reader has not moved. Sitting still where a read just landed must not
    // ask for another — that is the loop this whole rule could have become.
    const asked = l.asked.length
    for (let i = 0; i < 5; i++) {
      l.it.consider({ rows: [wall - 350, wall], cols: [wall - 350, wall] })
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
    l.it.consider({ rows: [10_000, 22_000], cols: [10_000, 22_000] })
    const fine = block([4_000, 28_000], 6)
    await l.land(fine)
    expect(l.given.at(-1)).toBe(fine)

    // Out again, past what the fine block covers. The coarse one is still here.
    const asked = l.asked.length
    l.it.consider({ rows: WHOLE, cols: WHOLE })
    expect(l.given.at(-1), 'zooming out is free').toBe(coarse)
    expect(l.asked, 'and costs no read').toHaveLength(asked)
  })

  it('prefers the finest block that covers the window', async () => {
    const l = ladder()
    l.it.adopt(block(WHOLE, 13))
    l.it.consider({ rows: [10_000, 22_000], cols: [10_000, 22_000] })
    const fine = block([4_000, 28_000], 6)
    await l.land(fine)

    // A window inside both: the finer one wins.
    l.it.consider({ rows: [12_000, 14_000], cols: [12_000, 14_000] })
    expect(l.given.at(-1)).toBe(fine)
  })
})

describe('putting the whole domain back (a double click)', () => {
  /**
   * Zoomed to the end of a chromosome at its finest bins, a double click fitted
   * the block in hand: the 160 kb read around the view, at 100 bp, a tenth of
   * the chromosome — and a fitted view asks for nothing wider.
   */
  it('hands back a block of the whole domain it still holds, and reads nothing', async () => {
    const l = ladder()
    const whole = block(WHOLE, 13)
    l.it.adopt(whole)
    l.it.consider({ rows: [40_000, 46_000], cols: [40_000, 46_000] })
    const fine = block([37_000, 49_000], 1)
    await l.land(fine)
    expect(l.given.at(-1)).toBe(fine)

    const asked = l.asked.length
    l.it.whole()
    expect(l.given.at(-1), 'the whole domain is on screen for the fit').toBe(whole)
    expect(l.asked).toHaveLength(asked)
  })

  it('does nothing where the block on screen is already the whole domain', () => {
    const l = ladder()
    const whole = block(WHOLE, 13)
    l.it.adopt(whole)
    const given = l.given.length
    l.it.whole()
    expect(l.given).toHaveLength(given)
    expect(l.asked).toHaveLength(0)
  })

  it('reads the whole domain where none is held, and fits the view to it when it lands', async () => {
    const view = seen([37_000, 49_000], { screen: 500, fit: 1 })
    const l = ladder({ view: () => view })
    // A block of part of the domain only: what a region opened inside it, or a
    // ladder that has let its first block go, holds.
    l.it.adopt(block([37_000, 49_000], 1))
    l.it.whole()
    expect(l.asked.at(-1)?.rows).toEqual(WHOLE)
    expect(l.asked.at(-1)?.cols).toEqual(WHOLE)
    expect(l.busy.at(-1), 'with the spinner up').toBe(true)

    // The view is fitted to the block it has meanwhile, and stays so: the read
    // is what it is waiting for, and is not called off.
    l.it.consider(view)
    expect(l.cancels).toBe(0)

    const whole = block(WHOLE, 100)
    await l.land(whole)
    await Promise.resolve()
    expect(l.given.at(-1)).toBe(whole)
    expect(l.wholes).toBe(1)
  })

  it('lands where the reader is, unfitted, when they have moved since', async () => {
    const view = seen([37_000, 49_000], { screen: 500, fit: 1 })
    const l = ladder({ view: () => view })
    l.it.adopt(block([37_000, 49_000], 1))
    l.it.whole()
    // Zoomed in again before it landed.
    view.fit = 1.04
    const whole = block(WHOLE, 100)
    await l.land(whole)
    await Promise.resolve()
    expect(l.wholes).toBe(0)
  })
})

/** A view as `MatrixPanel.refineWindow` reports it: square, on a screen `screen` pixels wide. */
function seen(at: Extent, options: { screen?: number; fit?: number } = {}) {
  return {
    rows: at,
    cols: at,
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

  it('caps a pooled read at the cells the reader’s accumulator holds, on however wide a plot', () => {
    // 3.2 screens of a 2,000-pixel plot is 6,400 cells; the reader pools no
    // read past 4,096 a side, and was pooling this one coarser than asked.
    const plan = screenPlan({ rungs: [], binsize: 1, view: 100_000, read: 300_000, screen: 2_000 })
    expect(300_000 / plan.grid).toBeLessThanOrEqual(POOLED_CELL_CAP)
  })

  it('coarsens a read much wider than its view rather than letting it grow with it', () => {
    const plan = screenPlan({ rungs: [], binsize: 1, view: 1_000, read: 20_000, screen: 500 })
    // A cell per pixel of the view would be 20,000 / 2 = 10,000 cells across.
    expect(20_000 / plan.grid).toBeLessThanOrEqual(SCREEN_READ_CAP * 500)
  })

  it('is what the ladder asks for once the view says how wide its screen is', () => {
    const l = ladder()
    l.it.adopt(block(WHOLE, 72))
    l.it.consider(seen([10_000, 22_000], { screen: 690, fit: 4 }))
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
    l.it.consider(seen([21_000, 22_000], { screen: 690, fit: 4 }))
    expect(l.asked).toHaveLength(1)
    expect(l.asked[0].plan).toEqual({ grid: 1 })
  })

  it('reads nothing while the view still has a cell to each pixel or two', () => {
    const l = ladder()
    l.it.adopt(block(WHOLE, 72))
    // The whole domain on 690 pixels wants 72 bins a cell — what it has.
    l.it.consider(seen(WHOLE, { screen: 690, fit: 1 }))
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
    expect(read.plan.rung, 'as memory allows, from the open map').toBeUndefined()
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
    expect(l.asked[0].plan.grid, 'as memory allows, at the pick').toBe(0.1)
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
    l.it.consider(seen([10_000, 22_000], { screen: 690, fit: 4 }))
    expect(l.asked).toHaveLength(1)
    // Still zooming, inside the window being read: a grid it has not outrun.
    l.it.consider(seen([12_000, 20_000], { screen: 690, fit: 6 }))
    expect(l.cancels).toBe(0)
    // Zoomed on, to a window the read in flight would land three times too
    // coarse for: called off at once, and the latest window read once the zoom
    // pauses on it.
    l.it.consider(seen([15_000, 17_000], { screen: 690, fit: 24 }))
    expect(l.cancels).toBe(1)
    expect(l.asked).toHaveLength(1)
    l.pause()
    expect(l.asked).toHaveLength(2)
    expect(l.asked[1].plan?.grid).toBeLessThan(l.asked[0].plan!.grid / 2)
  })

  it('never holds the view: the spinner turns, and nothing else is asked of it', () => {
    const l = ladder()
    l.it.adopt(block(WHOLE, 72))
    l.it.consider(seen([10_000, 22_000], { screen: 690, fit: 4 }))
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
    l.it.consider(seen([6_000, 18_000], { screen: 460, fit: 2 }))
    expect(l.asked).toHaveLength(0)
  })

  it('reads sooner while the zoom is going inward', () => {
    let now = 0
    const l = ladder({ now: () => now })
    l.it.adopt(block([0, 24_000], 40))
    l.it.consider(seen([5_000, 19_000], { screen: 460, fit: 1.7 }))
    expect(l.asked).toHaveLength(0)
    now += 30
    l.it.consider(seen([6_000, 18_000], { screen: 460, fit: 2 }))
    expect(l.holding, 'held for the pause').toBe(true)
    now += ZOOM_PAUSE_MS
    l.pause()
    expect(l.asked, 'read before the factor of two').toHaveLength(1)
  })

  it('holds a zoom’s read until the zoom pauses, and reads where it paused', () => {
    // A spin from the whole of a chromosome inward fired a read a fifth of a
    // second in, which the next notches outran: a read is synchronous in the
    // worker, so the one the zoom ended on queued behind its first window.
    let now = 0
    const l = ladder({ now: () => now })
    l.it.adopt(block(WHOLE, 72))
    const views: Array<ReturnType<typeof seen>> = []
    // From a view the block on screen is good for, inward to one it is six
    // times too coarse for.
    for (let i = 0; i < 10; i++) {
      const half = 20_000 - i * 1_800
      views.push(seen([25_000 - half, 25_000 + half], { screen: 690, fit: WHOLE[1] / (2 * half) }))
    }
    for (const view of views) {
      l.it.consider(view)
      now += 30
    }
    expect(l.asked, 'nothing read while the notches come').toHaveLength(0)
    expect(l.busy).toEqual([])
    // A pause short of the threshold is a gap between notches.
    now += ZOOM_PAUSE_MS - 60
    l.it.consider(views[9])
    expect(l.asked).toHaveLength(0)
    now += 60
    l.pause()
    expect(l.asked).toHaveLength(1)
    expect(covers(l.asked[0].rows, views[9].rows)).toBe(true)
    // For the window the zoom stopped on: no wider than the view padded by
    // half a view each side.
    const span = views[9].rows[1] - views[9].rows[0]
    expect(l.asked[0].rows[1] - l.asked[0].rows[0]).toBeLessThanOrEqual(2 * span + 2)
  })

  it('reads at once for a narrower view after a still moment: a jump, not a zoom', () => {
    let now = 0
    const l = ladder({ now: () => now })
    l.it.adopt(block(WHOLE, 72))
    l.it.consider(seen([10_000, 40_000], { screen: 690, fit: 50 / 30 }))
    now += INWARD_MS + 1
    l.it.consider(seen([20_000, 22_000], { screen: 690, fit: 25 }))
    expect(l.holding).toBe(false)
    expect(l.asked).toHaveLength(1)
  })

  it('says what it reads at from the moment it reads, and the block once it lands', async () => {
    // What a deck's other maps follow (§16.2): the read going out, not the one
    // that has landed, so theirs go out beside it.
    const l = ladder()
    l.it.adopt(block(WHOLE, 72))
    expect(l.targets).toEqual([72])
    l.it.consider(seen([10_000, 22_000], { screen: 690, fit: 4 }))
    expect(l.asked).toHaveLength(1)
    const reading = l.asked[0].plan.grid
    expect(reading).toBeLessThan(72)
    expect(l.targets).toEqual([72, reading])
    // Landed on the grid it was read at: nothing new to say.
    await l.land(block(l.asked[0].rows, reading))
    await Promise.resolve()
    expect(l.targets).toEqual([72, reading])
  })

  it('goes back to the block on screen when its read is called off', () => {
    const l = ladder()
    l.it.adopt(block(WHOLE, 72))
    l.it.consider(seen([10_000, 22_000], { screen: 690, fit: 4 }))
    const first = l.asked[0].plan.grid
    // Zoomed on past it: called off, and the block drawn is what is read at
    // until the read that replaces it goes out — after the pause.
    l.it.consider(seen([15_000, 17_000], { screen: 690, fit: 24 }))
    expect(l.cancels).toBe(1)
    expect(l.targets).toEqual([72, first, 72])
    l.pause()
    expect(l.targets.at(-1)).toBe(l.asked[1].plan.grid)
  })

  it('reads nothing it held once the ladder is gone', () => {
    let now = 0
    const l = ladder({ now: () => now })
    l.it.adopt(block(WHOLE, 72))
    l.it.consider(seen([5_000, 45_000], { screen: 690, fit: 1.25 }))
    now += 30
    l.it.consider(seen([20_000, 22_000], { screen: 690, fit: 25 }))
    expect(l.holding).toBe(true)
    l.it.destroy()
    expect(l.holding, 'the wait is called off with it').toBe(false)
    now += ZOOM_PAUSE_MS
    l.pause()
    expect(l.asked).toHaveLength(0)
  })

  it('takes a narrower view after a pause for a jump, not a zoom', () => {
    let now = 0
    const l = ladder({ now: () => now })
    l.it.adopt(block([0, 24_000], 40))
    l.it.consider(seen([5_000, 19_000], { screen: 460, fit: 1.7 }))
    now += INWARD_MS + 1
    l.it.consider(seen([6_000, 18_000], { screen: 460, fit: 2 }))
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
    l.it.consider({ rows: [10_000, 22_000], cols: [10_000, 22_000] })
    expect(l.asked).toHaveLength(1)
    expect(l.cancels).toBe(0)

    // Somewhere else entirely, and still nothing has landed: called off at
    // once, and the new window read when the gesture that went there pauses.
    l.it.consider({ rows: [40_000, 44_000], cols: [40_000, 44_000] })
    expect(l.cancels, 'the stale read is called off').toBe(1)
    l.pause()
    expect(l.asked).toHaveLength(2)
  })

  it('lets a read finish when the reader is still inside it', () => {
    const l = ladder()
    l.it.adopt(block(WHOLE, 13))
    l.it.consider({ rows: [10_000, 22_000], cols: [10_000, 22_000] })
    // A nudge, still well inside the padded window that is being read.
    l.it.consider({ rows: [11_000, 21_000], cols: [11_000, 21_000] })
    expect(l.cancels).toBe(0)
    expect(l.asked).toHaveLength(1)
  })

  it('does not retry a refusal once per frame', async () => {
    const l = ladder()
    l.it.adopt(block(WHOLE, 13))
    const view: Extent = [10_000, 22_000]
    l.it.consider({ rows: view, cols: view })
    await l.fail(new Error('too large'))

    for (let i = 0; i < 5; i++) {
      l.it.consider({ rows: view, cols: view })
    }
    expect(l.asked, 'the same refused read, once').toHaveLength(1)
  })

  it('treats a cancellation as no answer rather than as a refusal', async () => {
    const l = ladder()
    l.it.adopt(block(WHOLE, 13))
    const view: Extent = [10_000, 22_000]
    l.it.consider({ rows: view, cols: view })
    const abort = new Error('cancelled')
    abort.name = 'AbortError'
    await l.fail(abort)

    l.it.consider({ rows: view, cols: view })
    expect(l.asked, 'the window is still worth reading').toHaveLength(2)
  })

  it('stops everything on destroy', () => {
    const l = ladder()
    l.it.adopt(block(WHOLE, 13))
    l.it.consider({ rows: [10_000, 22_000], cols: [10_000, 22_000] })
    l.it.destroy()
    expect(l.cancels).toBe(1)
    l.it.consider({ rows: [10_000, 12_000], cols: [10_000, 12_000] })
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
    l.it.consider({ rows: [LAP - 500, LAP + 500], cols: [LAP - 500, LAP + 500] })
    expect(l.asked).toHaveLength(1)
    const [lo, hi] = l.asked[0].rows
    expect(lo).toBeLessThan(LAP)
    expect(hi).toBeGreaterThan(LAP)
  })

  it('never reads outside the frame, however far the reader pulls back', () => {
    const l = frame()
    l.it.adopt(block([LAP - 1_000, LAP + 1_000], 1))
    l.it.consider({ rows: [LAP - 4_000, LAP + 4_000], cols: [LAP - 4_000, LAP + 4_000] })
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
    expect(planFields(memoryPlan(openPick(10_000), HIC, 10_000, CHR1[1]))).toEqual({ rung: '25000' })
  })

  it('reads the open map wherever the window fits it', () => {
    expect(planFields(memoryPlan(openPick(25_000), HIC, 25_000, 7_849))).toEqual({})
  })

  it('crosses a gap in the ladder to the next stored rung, rather than pooling into it', () => {
    // 130 Mb of a `10 / 100 kb` file: the 100 kb rung, 1,300 bins — where the
    // open map used to be summed four by four into 40 kb.
    expect(planFields(memoryPlan(openPick(10_000), rungsOf(['10000', '100000']), 10_000, 13_000))).toEqual({
      rung: '100000',
    })
  })

  it('pools a file with no ladder, and says by how much', () => {
    // 19,547 bins into the reader's 4,096 cells: five to a cell.
    expect(memoryPlan(openPick(10_000), [], 10_000, CHR1[1])).toEqual({ binsPerCell: 5, grid: 5 })
  })

  it('sums an added resolution by whole cells of it, never by a part of one', () => {
    // 10 kb* over a 2 kb map is five of its bins; a window too wide for those
    // is summed by a whole number of them — ten, not six.
    const pick = { binsize: 10_000, rung: { name: '2000', binsize: 2_000 }, factor: 5 }
    const rungs = rungsOf(['2000', '50000'])
    expect(memoryPlan(pick, rungs, 2_000, 4_000)).toEqual({ binsPerCell: 5, grid: 5 })
    const wide = memoryPlan(pick, rungs, 2_000, 30_000)
    expect(wide.rung).toBeUndefined()
    expect((wide.binsPerCell ?? 1) % 5).toBe(0)
    expect(30_000 / wide.grid).toBeLessThanOrEqual(POOLED_CELL_CAP)
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
    l.it.consider({ rows: CHR1, cols: CHR1 })
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

describe('attachRefine, beside a second file (§5.7)', () => {
  it('reads the open rung only, whatever rungs the first file has', () => {
    const was = refineEnabled()
    setRefineEnabled(true)
    try {
      let listener: ((view: RefineView) => void) | null = null
      const reads: Array<{ rung: string | undefined; binsPerCell: number | undefined }> = []
      const ladder = attachRefine({
        panel: {
          setRefineListener: (fn) => {
            listener = fn
          },
          regrid: () => true,
          setWaiting: () => {},
        },
        read: (_rows, _cols, rung, binsPerCell) => {
          reads.push({ rung, binsPerCell })
          return { promise: new Promise(() => {}), cancel: () => {} }
        },
        ceiling: { rows: [0, 20_000], cols: [0, 20_000] },
        binsize: 10_000,
        rungs: rungsOf(['1000', '10000', '100000', '1000000']),
        // Another rung of the first file need not be one of the second's, and a
        // reader asked for an entry it has not got answers from its open map.
        second: true,
      })
      ladder.adopt(block([0, 20_000], 25))
      const look = listener as ((view: RefineView) => void) | null
      look?.(seen([5_000, 6_000], { screen: 700, fit: 20 }))
      expect(reads).toHaveLength(1)
      expect(reads[0].rung).toBeUndefined()
      ladder.destroy()
    } finally {
      setRefineEnabled(was)
    }
  })
})

describe('a ladder whose finest rung carries no weights', () => {
  // The lab's E. coli micro-C `.mcool`: opened at 200 bp, stored down to 10 bp,
  // balanced at every rung but the 10 bp one (§2).
  function ecoli() {
    let listener: ((view: RefineView) => void) | null = null
    const reads: Array<{ rows: Extent; rung: string | undefined; land(result: MatrixResult): void }> = []
    const ladder = attachRefine({
      panel: {
        setRefineListener: (fn) => {
          listener = fn
        },
        regrid: () => true,
        setWaiting: () => {},
      },
      read: (rows, _cols, rung) => {
        let land: (result: MatrixResult) => void = () => {}
        const promise = new Promise<{ result: MatrixResult }>((resolve) => {
          land = (result) => resolve({ result })
        })
        reads.push({ rows, rung, land })
        return { promise, cancel: () => {} }
      },
      ceiling: { rows: [0, 23_209], cols: [0, 23_209] },
      binsize: 200,
      rungs: rungsOf(['10', '100', '200', '500', '1000', '2000', '5000', '10000']),
    })
    // The whole chromosome at 5 kb, from its own rung.
    ladder.adopt({ ...block([0, 1_000], 1), binsize: 5_000, source: { rows: [0, 23_209], cols: [0, 23_209] } })
    return { ladder, reads, look: (view: RefineView) => listener?.(view) }
  }

  it('comes to rest on the rung that answered, and asks nothing more of the one it went round', async () => {
    const was = refineEnabled()
    setRefineEnabled(true)
    try {
      const { ladder, reads, look } = ecoli()
      // 4 kb on a 700-pixel plot: 6 bp a pixel, nearest the 10 bp rung.
      const view = seen([5_000, 5_020], { screen: 700, fit: 300 })
      look(view)
      expect(reads).toHaveLength(1)
      expect(reads[0].rung).toBe('10')
      // The reader answered from 100 bp, and said which rung it went round.
      const [lo, hi] = reads[0].rows
      reads[0].land({
        ...block([0, ((hi - lo) * 200) / 100], 1),
        binsize: 100,
        source: { rows: reads[0].rows, cols: reads[0].rows },
        unweighted: ['10'],
      })
      await Promise.resolve()
      await Promise.resolve()
      look(view)
      look(seen([5_002, 5_020], { screen: 700, fit: 330 }))
      expect(reads).toHaveLength(1)
      ladder.destroy()
    } finally {
      setRefineEnabled(was)
    }
  })

  it('reads the 10 bp rung for a view that has not met a refusal', () => {
    const was = refineEnabled()
    setRefineEnabled(true)
    try {
      // A ladder of its own — the view rebuilt on raw counts — knows nothing of
      // what a balanced one learnt.
      const { ladder, reads, look } = ecoli()
      look(seen([5_000, 5_020], { screen: 700, fit: 300 }))
      expect(reads.map((read) => read.rung)).toEqual(['10'])
      ladder.destroy()
    } finally {
      setRefineEnabled(was)
    }
  })
})
