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
  type LockUnit,
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
  const window = { rows: { lo: 0, hi: 1000 }, cols: { lo: 0, hi: 1000 }, unit: 'bp' as const }

  it('accepts a difference under the tolerance', () => {
    const nudged = { rows: { lo: 40, hi: 1040 }, cols: { lo: 0, hi: 1000 }, unit: 'bp' as const }
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

  /**
   * The allowance is per **sequence**, not per axis, and getting that wrong is
   * how two roll-ups of one genome came to accuse each other.
   *
   * A cell never straddles a sequence, so an axis of sixteen chromosomes rounds
   * sixteen last cells up. A 12.16 Mb genome is 12,168 kb of grid at 1 kb and
   * 12,200 kb at 5 kb — 32 kb apart, which is six of the coarse panel's cells
   * and well inside sixteen of them. Refused at a one-cell allowance, which is
   * the false claim §16.4 calls worse than saying nothing at all.
   */
  it('allows one short last cell per sequence on the axis', () => {
    const fine = { spanBp: 12_168_000, bpPerCell: 1000 }
    const coarse = { spanBp: 12_200_000, bpPerCell: 5000 }
    expect(spansAgree(fine, coarse, 16)).toBe(true)
    expect(spansAgree(fine, coarse)).toBe(false)
  })

  it('still refuses a genuinely different assembly of the same many sequences', () => {
    // Sixteen sequences either side, so the allowance is at its widest — and a
    // genome half the length of the other is still not the same genome.
    expect(
      spansAgree({ spanBp: 12_200_000, bpPerCell: 5000 }, { spanBp: 6_000_000, bpPerCell: 5000 }, 16),
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
function panel(id: string, bpPerCell: number, cells: number, unit: LockUnit = 'bp') {
  const state = {
    rows: [0, cells] as CellSpan,
    cols: [0, cells] as CellSpan,
    locked: true,
    shown: 0,
    /** `false` stands in for a panel whose block has not arrived. */
    loaded: true,
    /** What this panel counts its window in — `'cell'` above bin level. */
    unit,
  }
  const member: LockMember = {
    id,
    unit: () => state.unit,
    bpPerCell: () => bpPerCell,
    cells: () => ({ rows: cells, cols: cells }),
    locked: () => state.locked,
    show: (rows, cols) => {
      if (!state.loaded) return false
      state.rows = rows
      state.cols = cols
      state.shown += 1
      return true
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

  /**
   * The gap `catchUp` leaves, and the one a deck falls into every time it is
   * built.
   *
   * A window exists because a panel *reported* one, and a panel reports when it
   * draws. The first map of a deck was drawn — and reported nothing, because
   * until the reader pressed "add a map" there was no lock listening — before
   * the deck existed, so every pan and zoom they had made was invisible to it.
   * A companion arriving into that gap is left at its own fitted view, which is
   * two maps side by side at two zooms under a bar saying they are one
   * navigation.
   */
  describe('seeding a window nobody has reported', () => {
    it('brings a newcomer to where the lead already was', () => {
      const lock = new ViewportLock()
      const lead = panel('lead', 1000, 400)
      // The reader zoomed in before there was a deck: the panel is showing
      // 100–200 kb and has never reported it.
      lead.state.rows = [100, 200]
      lead.state.cols = [100, 200]
      lock.join(lead.member)

      const late = panel('late', 2000, 200)
      lock.join(late.member)
      lock.seed(lead.state.rows, lead.state.cols, 1000, 'bp')
      lock.catchUp('late')

      expect(late.state.rows).toEqual([50, 100])
      // …and the lead was not moved to make it happen.
      expect(lead.state.shown).toBe(0)
    })

    it('moves nobody by itself', () => {
      const lock = new ViewportLock()
      const a = panel('a', 1000, 400)
      const b = panel('b', 1000, 400)
      lock.join(a.member)
      lock.join(b.member)
      lock.seed([10, 60], [10, 60], 1000, 'bp')
      expect(a.state.shown).toBe(0)
      expect(b.state.shown).toBe(0)
      expect(lock.window).toEqual({
        rows: { lo: 10_000, hi: 60_000 },
        cols: { lo: 10_000, hi: 60_000 },
        unit: 'bp',
      })
    })

    /**
     * A window that a panel reported is a reader's choice; the lead's present
     * view is a guess at one, and the guess must not overwrite the choice. The
     * deck seeds on every arrival, so without this each newly settled companion
     * would drag the whole deck back to wherever the first map happened to be.
     */
    it('does not overwrite a window a panel established', () => {
      const lock = new ViewportLock()
      const a = panel('a', 1000, 400)
      const b = panel('b', 1000, 400)
      lock.join(a.member)
      lock.join(b.member)
      drag(lock, b, [300, 340], [300, 340])
      lock.seed([0, 400], [0, 400], 1000, 'bp')
      expect(lock.window).toEqual({
        rows: { lo: 300_000, hi: 340_000 },
        cols: { lo: 300_000, hi: 340_000 },
        unit: 'bp',
      })
    })

    it('is forgotten with the rest of the window when the deck navigates', () => {
      const lock = new ViewportLock()
      const a = panel('a', 1000, 400)
      lock.join(a.member)
      lock.seed([10, 60], [10, 60], 1000, 'bp')
      lock.reset()
      expect(lock.window).toBeNull()
    })

    it('records no debt, so the first panel to move still drives the deck', () => {
      // `pushTo` owes itself one report per panel it moved and throws that report
      // away. Seeding pushes nobody, so nothing is owed — and a seed followed
      // immediately by a genuine gesture must not have the gesture swallowed.
      const lock = new ViewportLock()
      const a = panel('a', 1000, 400)
      const b = panel('b', 1000, 400)
      lock.join(a.member)
      lock.join(b.member)
      lock.seed([0, 400], [0, 400], 1000, 'bp')
      drag(lock, a, [10, 60], [10, 60])
      expect(b.state.rows).toEqual([10, 60])
    })
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

describe('a panel that could not be moved', () => {
  it('is not owed a report it will never send', () => {
    // `pushTo` records one report as owed per pushed panel and throws it away,
    // which is what stops a panel that clamped the window from becoming the
    // driver. A panel whose block has not arrived cannot move and never reports,
    // so recording the debt left it owed for the life of the deck — and the
    // panel's first *real* gesture, once its block landed, was swallowed as the
    // answer to a push that never happened.
    const lock = new ViewportLock()
    const lead = panel('lead', 1000, 100)
    const late = panel('late', 1000, 100)
    late.state.loaded = false
    lock.join(lead.member)
    lock.join(late.member)

    drag(lock, lead, [10, 30], [10, 30])
    expect(late.state.shown).toBe(0)

    // Its block arrives, and the reader pans *it*. The deck must follow.
    late.state.loaded = true
    drag(lock, late, [50, 70], [50, 70])
    expect(lead.state.rows).toEqual([50, 70])
  })
})

describe('navigating to a different block', () => {
  it('forgets a window that is no longer a place', () => {
    // The currency is base pairs from each block's own first cell, so a window
    // is a statement about one block. Carried across a navigation it still
    // parses and means somewhere else, and a companion that finishes reading
    // before the lead would be scrolled to a window nobody asked for.
    const lock = new ViewportLock()
    const lead = panel('lead', 1000, 100)
    const other = panel('other', 1000, 100)
    lock.join(lead.member)
    lock.join(other.member)
    drag(lock, lead, [10, 30], [10, 30])
    expect(lock.window).not.toBeNull()

    lock.reset()
    expect(lock.window).toBeNull()
    const before = other.state.shown
    lock.catchUp('other')
    expect(other.state.shown).toBe(before)
  })
})

/**
 * Above bin level, where a cell is a whole sequence (§16.3).
 *
 * The module's currency is base pairs *because* a cell has a width in them, and
 * at contig level it has not: one cell is a whole chromosome, and the number a
 * panel answers for `bpPerCell` there is the file's bin size — a fact about the
 * file and not a length of anything drawn. Converting through it took a window
 * on chromosomes 10–14 of a 1 kb roll-up and handed the 5 kb roll-up beside it
 * chromosomes 2–3, with the bar still saying one navigation. What the two grids
 * genuinely share is the **index**: cell `i` is sequence `i` in both.
 */
describe('a deck above bin level', () => {
  it('carries the cell index between two roll-ups of one genome', () => {
    const lock = new ViewportLock()
    // The same sixteen chromosomes, one file binned at 1 kb and one at 5 kb.
    const fine = panel('fine', 1000, 16, 'cell')
    const coarse = panel('coarse', 5000, 16, 'cell')
    lock.join(fine.member)
    lock.join(coarse.member)

    drag(lock, fine, [10, 14], [10, 14])
    // Chromosomes 10–14, not the 2–3 that dividing 10,000 bp by 5,000 gives.
    expect(coarse.state.rows).toEqual([10, 14])
    expect(coarse.state.cols).toEqual([10, 14])
  })

  it('seeds and catches a newcomer up in the same currency', () => {
    const lock = new ViewportLock()
    const lead = panel('lead', 1000, 16, 'cell')
    lead.state.rows = [4, 9]
    lead.state.cols = [4, 9]
    lock.join(lead.member)
    const late = panel('late', 5000, 16, 'cell')
    lock.join(late.member)

    lock.seed(lead.state.rows, lead.state.cols, 1, 'cell')
    lock.catchUp('late')
    expect(late.state.rows).toEqual([4, 9])
  })

  /**
   * A companion mid-read between two levels is the one way the two currencies
   * meet, and the deck's own gate prints a sentence about it. Here the lock
   * makes the same refusal for itself: a window counted in sequences is not a
   * window a bin-level panel can read as base pairs, and standing still is the
   * only honest thing to do with a number that means something else.
   */
  it('does not move a panel that is counting the other currency', () => {
    const lock = new ViewportLock()
    const rolled = panel('rolled', 1000, 16, 'cell')
    const binned = panel('binned', 1000, 400, 'bp')
    lock.join(rolled.member)
    lock.join(binned.member)

    drag(lock, rolled, [2, 6], [2, 6])
    expect(binned.state.shown).toBe(0)
    expect(binned.state.rows).toEqual([0, 400])
  })

  it('takes the level toggle as a move rather than as a nudge under the tolerance', () => {
    // Both windows read `[0, 16)`, and the second means something else. A
    // tolerance comparison across currencies would swallow it and leave the
    // deck driving in sequences from a window stated in base pairs.
    const lock = new ViewportLock()
    const map = panel('map', 1000, 16, 'bp')
    lock.join(map.member)
    lock.report('map', [0, 16], [0, 16])
    expect(lock.window?.unit).toBe('bp')
    map.state.unit = 'cell'
    lock.report('map', [0, 16], [0, 16])
    expect(lock.window?.unit).toBe('cell')
    expect(lock.window?.rows).toEqual({ lo: 0, hi: 16 })
  })
})
