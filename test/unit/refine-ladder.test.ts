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
import {
  BlockLadder,
  REFINE_DEFAULT,
  chooseRung,
  clip,
  covers,
  gridFor,
  pad,
  recentre,
  refineEnabled,
  rungsOf,
  setRefineEnabled,
  subscribeRefine,
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

/** A ladder with a fake clock, a fake timer and a recording reader. */
function ladder(options: { ceiling?: Extent; reads?: Array<Extent> } = {}) {
  const ceiling: Extent = options.ceiling ?? [0, 50_000]
  const asked: Array<{ rows: Extent; cols: Extent }> = []
  const given: MatrixResult[] = []
  const busy: boolean[] = []
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
    onBusy: (on) => busy.push(on),
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
  it('is off until somebody asks for it', () => {
    // §2's promise is that pan and zoom perform no I/O, and that is the promise
    // the app has always made. A zoom that reads is a zoom that can wait, and on
    // a large cooler the wait is real — a good trade when it is asked for and a
    // surprising one when it is not. So the default is the behaviour that keeps
    // the promise, and the switch is on the map's own controls.
    expect(REFINE_DEFAULT).toBe(false)
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
    // A whole 12.1 Mb yeast genome at 1 kb: 12,100 bins into 4,096 cells is
    // about 2,954 bp a cell, so the 2 kb level fits and the 5 kb one would put
    // more than one of its bins in a cell — which is the pooling this avoids.
    expect(chooseRung(YEAST, 12_100, 1000)).toBe('2000')
    // Ten times as much genome, ten times coarser a cell.
    expect(chooseRung(YEAST, 121_000, 1000)).toBe('10000')
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
    expect(chooseRung(six, 12_000, 2000)).toBe('5000')
    // And a reader who opened the finest level gets the whole ladder above it:
    // 12,000 × 100 bp is 1.2 Mb, which is 293 bp a cell, so 200 fits and 500
    // would put more than one of its bins in a cell.
    expect(chooseRung(six, 12_000, 100)).toBe('200')
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
    expect(l.busy, 'and never freezes the map').toHaveLength(0)
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

  it('reads on the frame that crosses, and freezes the map while it does', () => {
    const l = ladder()
    l.it.adopt(block(WHOLE, 13))
    const view: Extent = [10_000, 22_000]
    l.it.consider({ rows: view, cols: view, binsPerCell: 13 })
    // Immediately, not after a settle: the freeze is what ends the gesture, so
    // there is no second frame to debounce and the reader sees the hold at the
    // moment they crossed the edge.
    expect(l.asked).toHaveLength(1)
    expect(l.busy).toEqual([true])
    // Padded by half a window on each side, and inside the ceiling.
    expect(l.asked[0].rows).toEqual([4_000, 28_000])
  })

  it('releases the map when the block lands', async () => {
    const l = ladder()
    l.it.adopt(block(WHOLE, 13))
    l.it.consider({ rows: [10_000, 22_000], cols: [10_000, 22_000], binsPerCell: 13 })
    expect(l.busy).toEqual([true])
    await l.land(block([4_000, 28_000], 6))
    expect(l.busy, 'held, then released').toEqual([true, false])
  })

  it('releases the map when the read is refused', async () => {
    const l = ladder()
    l.it.adopt(block(WHOLE, 13))
    l.it.consider({ rows: [10_000, 22_000], cols: [10_000, 22_000], binsPerCell: 13 })
    await l.fail(new Error('too large'))
    // A refusal that left the view frozen would be an app that had stopped
    // responding, which is the worst way to report one.
    expect(l.busy).toEqual([true, false])
  })

  it('issues one read for a gesture, however many frames it lasts', () => {
    const l = ladder()
    l.it.adopt(block(WHOLE, 13))
    // A wheel spin. In the app the freeze stops this after the first crossing
    // frame; here the frames keep coming, which is the harder case and the one
    // that has to stay bounded — a view that somehow did not freeze must still
    // not turn a gesture into a burst of reads.
    for (let i = 0; i < 8; i++) {
      const half = 20_000 - i * 2_000
      l.it.consider({
        rows: [25_000 - half, 25_000 + half],
        cols: [25_000 - half, 25_000 + half],
        binsPerCell: 13,
      })
    }
    expect(l.asked, 'the inflight guard, not the timing').toHaveLength(1)
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
    expect(l.busy, 'and the map is never held for a read it will not make').toHaveLength(0)
  })

  it('never asks for more than the view’s own domain', () => {
    const l = ladder({ ceiling: [0, 50_000] })
    l.it.adopt(block([24_000, 26_000], 1))
    // Zooming out hard: the reach is four windows on each side, which would run
    // to [-6000, 56000] and is clipped to what this view was allowed to read.
    l.it.consider({ rows: [22_000, 28_000], cols: [22_000, 28_000], binsPerCell: 1 })
    expect(l.asked).toHaveLength(1)
    expect(l.asked[0].rows).toEqual([0, 50_000])
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

  it('does not read at the edge of the world', () => {
    // The block is the whole domain: its edges are the ceiling's, so pressing
    // against them is not a request for anything, it is the end of the sequence.
    const l = ladder({ ceiling: [0, 15_300] })
    l.it.adopt(block([0, 15_300], 4))
    l.it.consider({ rows: [0, 4000], cols: [0, 4000], binsPerCell: 4 })
    expect(l.asked).toHaveLength(0)
    l.it.consider({ rows: [11_300, 15_300], cols: [11_300, 15_300], binsPerCell: 4 })
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

describe('the way out of a freeze', () => {
  it('gives the map back and does not immediately ask again', () => {
    const l = ladder()
    l.it.adopt(block(WHOLE, 13))
    const view = { rows: [10_000, 22_000] as Extent, cols: [10_000, 22_000] as Extent, binsPerCell: 13 }
    l.it.consider(view)
    expect(l.busy).toEqual([true])

    l.it.abort()
    expect(l.cancels).toBe(1)
    expect(l.busy, 'released').toEqual([true, false])

    // The window they abandoned it at is the window they are still looking at,
    // so without a memory of the abort the very next frame would re-freeze.
    const asked = l.asked.length
    for (let i = 0; i < 5; i++) l.it.consider(view)
    expect(l.asked).toHaveLength(asked)
    expect(l.busy).toEqual([true, false])
  })

  it('asks again once the reader moves', () => {
    const l = ladder()
    l.it.adopt(block(WHOLE, 13))
    l.it.consider({ rows: [10_000, 22_000], cols: [10_000, 22_000], binsPerCell: 13 })
    l.it.abort()
    const asked = l.asked.length
    // Moving is asking again.
    l.it.consider({ rows: [30_000, 42_000], cols: [30_000, 42_000], binsPerCell: 13 })
    expect(l.asked).toHaveLength(asked + 1)
  })

  it('is a no-op when nothing is in flight', () => {
    const l = ladder()
    l.it.adopt(block(WHOLE, 13))
    l.it.abort()
    expect(l.cancels).toBe(0)
    expect(l.busy).toHaveLength(0)
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
