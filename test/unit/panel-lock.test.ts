/**
 * The navigation lock's arithmetic (§16.3).
 *
 * Three properties, and the last two are the ones that would otherwise fail
 * quietly and be blamed on the renderer:
 *
 * 1. **Translation is by base pair, not by cell.** A 1 kb panel and a 5 kb
 *    panel showing one region show the same genome and different numbers of
 *    cells, so a lock in cells would move the coarse panel five times too far.
 * 2. **The round trip converges.** A push comes back as a report one frame
 *    later, quantised to the receiving panel's grid; a lock that acted on it
 *    would broadcast a slightly wider window, which would come back wider
 *    still. The tests drive a two-resolution deck a hundred frames and require
 *    it to stand still.
 * 3. **A panel that clamped does not become the driver.** Its report differs
 *    from the broadcast for a reason that is not a gesture, and acting on it
 *    turns "pan past the end of the short one" into "you cannot pan past the
 *    end of the short one".
 *
 * The fake panel below behaves the way a real one does in the one respect that
 * matters: what it reports is what it is *currently showing*, which after a push
 * is the push as its own grid could express it.
 */

import { describe, expect, it } from 'vitest'
import {
  ViewportLock,
  bpToCells,
  cellsToBp,
  spansAgree,
  windowsAgree,
  type CellSpan,
  type LockMember,
} from '../../src/panels/lock'

describe('cell ↔ base-pair translation', () => {
  it('is exact in the fine direction', () => {
    expect(cellsToBp([10, 70], 1000)).toEqual({ lo: 10_000, hi: 70_000 })
    expect(bpToCells({ lo: 10_000, hi: 70_000 }, 1000, 400)).toEqual([10, 70])
  })

  it('rounds outward, so a coarse panel shows at least what was asked for', () => {
    // 12,300–58,700 bp on a 5 kb grid: cells 2.46 to 11.74, which is cells
    // [2, 12) — the smallest window that contains the request.
    expect(bpToCells({ lo: 12_300, hi: 58_700 }, 5000, 100)).toEqual([2, 12])
  })

  it('never produces an empty span, however narrow the window', () => {
    // A window inside a single coarse cell. One cell is the finest thing this
    // panel can say; zero cells is a division by zero one frame later.
    expect(bpToCells({ lo: 5100, hi: 5200 }, 5000, 100)).toEqual([1, 2])
  })

  it('slides a window off the end back inside, keeping its span', () => {
    // The same coordinate in a shorter assembly. Truncating to the overlap would
    // answer a 40-cell view with a one-cell view, which is a different zoom in a
    // deck whose whole promise is that the panels show the same thing.
    expect(bpToCells({ lo: 380_000, hi: 420_000 }, 1000, 390)).toEqual([350, 390])
    expect(bpToCells({ lo: 500_000, hi: 520_000 }, 1000, 390)).toEqual([370, 390])
    expect(bpToCells({ lo: -50_000, hi: 10_000 }, 1000, 390)).toEqual([0, 60])
  })

  it('answers a window wider than the block with the whole block', () => {
    expect(bpToCells({ lo: 0, hi: 900_000 }, 1000, 390)).toEqual([0, 390])
  })

  it('survives a reversed window, which a drag can produce', () => {
    expect(bpToCells({ lo: 70_000, hi: 10_000 }, 1000, 400)).toEqual([10, 70])
  })

  it('widens through a coarse panel and never narrows', () => {
    const fine = { lo: 12_300, hi: 58_700 }
    const coarse = cellsToBp(bpToCells(fine, 5000, 100), 5000)
    expect(coarse.lo).toBeLessThanOrEqual(fine.lo)
    expect(coarse.hi).toBeGreaterThanOrEqual(fine.hi)
  })
})

describe('windowsAgree', () => {
  const window = { rows: { lo: 0, hi: 1000 }, cols: { lo: 0, hi: 1000 } }

  it('accepts a difference under the tolerance', () => {
    const nudged = { rows: { lo: 40, hi: 1040 }, cols: { lo: 0, hi: 1000 } }
    expect(windowsAgree(window, nudged, 50)).toBe(true)
    expect(windowsAgree(window, nudged, 10)).toBe(false)
  })
})

describe('spansAgree', () => {
  it('accepts two resolutions of one sequence', () => {
    // 400 fine cells of 1 kb against 80 coarse cells of 5 kb.
    expect(
      spansAgree({ spanBp: 400_000, bpPerCell: 1000 }, { spanBp: 400_000, bpPerCell: 5000 }),
    ).toBe(true)
  })

  it('tolerates the short last bin of a contig', () => {
    // A 398 kb contig is 398 cells at 1 kb and 80 at 5 kb — 400 kb of grid, one
    // coarse cell over. Refusing that would refuse every honest pair whose bin
    // size does not divide the contig (§3.3).
    expect(
      spansAgree({ spanBp: 398_000, bpPerCell: 1000 }, { spanBp: 400_000, bpPerCell: 5000 }),
    ).toBe(true)
  })

  it('refuses two sequences that merely share a name', () => {
    expect(
      spansAgree({ spanBp: 400_000, bpPerCell: 1000 }, { spanBp: 250_000, bpPerCell: 1000 }),
    ).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// The lock itself
// ---------------------------------------------------------------------------

/**
 * A panel that behaves the way a real one does: it is *told* a window, it
 * clamps it to its own block, and it reports back what it actually shows —
 * which is the echo the lock has to recognise.
 */
function panel(id: string, bpPerCell: number, cells: number) {
  const state = { rows: [0, cells] as CellSpan, cols: [0, cells] as CellSpan, locked: true, shown: 0 }
  const member: LockMember = {
    id,
    bpPerCell: () => bpPerCell,
    cells: () => ({ rows: cells, cols: cells }),
    locked: () => state.locked,
    show: (rows, cols) => {
      state.rows = rows
      state.cols = cols
      state.shown += 1
    },
  }
  return { member, state }
}

/**
 * A gesture on one panel: it moves itself, then reports — which is what a real
 * one does, since its report is read off the transform it has just written.
 */
function drag(
  lock: ViewportLock,
  p: ReturnType<typeof panel>,
  rows: CellSpan,
  cols: CellSpan,
): void {
  p.state.rows = rows
  p.state.cols = cols
  lock.report(p.member.id, rows, cols)
}

/** One frame: every panel reports what it is currently showing. */
function frame(lock: ViewportLock, ...panels: Array<ReturnType<typeof panel>>): void {
  for (const p of panels) lock.report(p.member.id, p.state.rows, p.state.cols)
}

describe('ViewportLock', () => {
  it('translates a window between panels of different resolution', () => {
    const lock = new ViewportLock()
    const fine = panel('fine', 1000, 400)
    const coarse = panel('coarse', 5000, 80)
    lock.join(fine.member)
    lock.join(coarse.member)

    // The fine panel is dragged to 100–200 kb.
    lock.report('fine', [100, 200], [100, 200])

    // Which is cells 20–40 on a 5 kb grid, not cells 100–200.
    expect(coarse.state.rows).toEqual([20, 40])
    expect(coarse.state.cols).toEqual([20, 40])
  })

  it('does not move the panel that reported', () => {
    const lock = new ViewportLock()
    const a = panel('a', 1000, 400)
    const b = panel('b', 1000, 400)
    lock.join(a.member)
    lock.join(b.member)
    lock.report('a', [10, 60], [10, 60])
    expect(a.state.shown).toBe(0)
    expect(b.state.shown).toBe(1)
  })

  it('swallows the echo of its own broadcast', () => {
    const lock = new ViewportLock()
    const fine = panel('fine', 1000, 400)
    const coarse = panel('coarse', 5000, 80)
    lock.join(fine.member)
    lock.join(coarse.member)

    lock.report('fine', [12, 58], [12, 58])
    const first = { ...coarse.state }
    // The next frame: the coarse panel reports what it now shows, which is the
    // broadcast seen through its own quantisation.
    lock.report('coarse', coarse.state.rows, coarse.state.cols)
    expect(coarse.state.rows).toEqual(first.rows)
    // …and the fine panel was not dragged out to the coarse panel's rounding.
    expect(fine.state.shown).toBe(0)
  })

  /**
   * The guard that stops "pan past the end of the short one" from becoming "you
   * cannot pan past the end of the short one" — in a deck the reader assembled
   * precisely because the files are not identical.
   */
  it('lets the deck pass the end of a shorter block without being dragged back', () => {
    const lock = new ViewportLock()
    const long = panel('long', 1000, 400)
    const short = panel('short', 1000, 300)
    lock.join(long.member)
    lock.join(short.member)

    drag(lock, long, [350, 390], [350, 390])
    // The short block stops at its own last row, which is the honest answer.
    expect(short.state.rows).toEqual([260, 300])
    // …and the next frame, in which it reports that, must not move the long one.
    frame(lock, short, long)
    expect(long.state.shown).toBe(0)
    expect(long.state.rows).toEqual([350, 390])
    expect(short.state.rows).toEqual([260, 300])
  })

  it('takes a genuine gesture from a panel that was clamped a frame earlier', () => {
    const lock = new ViewportLock()
    const long = panel('long', 1000, 400)
    const short = panel('short', 1000, 300)
    lock.join(long.member)
    lock.join(short.member)

    drag(lock, long, [350, 390], [350, 390])
    frame(lock, short, long)
    // The reader now drags the short panel itself.
    drag(lock, short, [10, 50], [10, 50])
    expect(long.state.rows).toEqual([10, 50])
  })

  it('stands still under a hundred echo exchanges', () => {
    const lock = new ViewportLock()
    const fine = panel('fine', 1000, 4000)
    const coarse = panel('coarse', 5000, 800)
    lock.join(fine.member)
    lock.join(coarse.member)

    drag(lock, fine, [1234, 1789], [1234, 1789])
    // Two frames for the exchange to settle: the coarse panel's own rounding is
    // wider than half of one of its cells, so it is entitled to one correction —
    // "the narrowest grid wins", applied once.
    frame(lock, coarse, fine)
    frame(lock, coarse, fine)
    const settled = { rows: [...coarse.state.rows], cols: [...fine.state.rows] }
    for (let i = 0; i < 100; i++) frame(lock, coarse, fine)
    expect(coarse.state.rows).toEqual(settled.rows)
    expect(fine.state.rows).toEqual(settled.cols)
  })

  it('leaves an unlocked panel where it is', () => {
    const lock = new ViewportLock()
    const a = panel('a', 1000, 400)
    const b = panel('b', 1000, 400)
    b.state.locked = false
    lock.join(a.member)
    lock.join(b.member)
    lock.report('a', [10, 60], [10, 60])
    expect(b.state.shown).toBe(0)
  })

  it('ignores a report from a panel that has been let off the lead', () => {
    const lock = new ViewportLock()
    const a = panel('a', 1000, 400)
    const b = panel('b', 1000, 400)
    b.state.locked = false
    lock.join(a.member)
    lock.join(b.member)
    lock.report('b', [10, 60], [10, 60])
    expect(a.state.shown).toBe(0)
    expect(lock.window).toBeNull()
  })

  it('brings a newcomer to where the deck is looking', () => {
    const lock = new ViewportLock()
    const a = panel('a', 1000, 400)
    lock.join(a.member)
    lock.report('a', [100, 200], [100, 200])

    const late = panel('late', 2000, 200)
    lock.join(late.member)
    lock.catchUp('late')
    expect(late.state.rows).toEqual([50, 100])
  })

  it('leaves a newcomer alone where nobody has moved yet', () => {
    const lock = new ViewportLock()
    const a = panel('a', 1000, 400)
    lock.join(a.member)
    lock.catchUp('a')
    expect(a.state.shown).toBe(0)
  })

  it('stops driving a panel that has left', () => {
    const lock = new ViewportLock()
    const a = panel('a', 1000, 400)
    const b = panel('b', 1000, 400)
    lock.join(a.member)
    lock.join(b.member)
    lock.leave('b')
    lock.report('a', [10, 60], [10, 60])
    expect(b.state.shown).toBe(0)
  })

  it('re-joining under one id replaces rather than doubles', () => {
    const lock = new ViewportLock()
    const a = panel('a', 1000, 400)
    const first = panel('b', 1000, 400)
    const second = panel('b', 1000, 400)
    lock.join(a.member)
    lock.join(first.member)
    lock.join(second.member)
    lock.report('a', [10, 60], [10, 60])
    expect(first.state.shown).toBe(0)
    expect(second.state.shown).toBe(1)
  })
})
