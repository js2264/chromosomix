/**
 * The navigation lock: what makes N maps one navigation (§16.3).
 *
 * The tension this resolves is that two panels showing the same region are not
 * showing the same *grid*. A 1 kb file and a 5 kb file both answer
 * `chrI:20,000-80,000`, and the answers are 60 cells wide and 12 cells wide.
 * A lock whose currency is the cell — origin and zoom, which is what
 * {@link HeatmapView} actually holds — would move the coarse panel five times
 * too far and would have to be refused between files of different resolution,
 * which is exactly the refusal `compareRefusal` makes for the blended square
 * and exactly the one side-by-side panels do not need. So **the currency is
 * base pairs**, measured from each block's own start, and each panel converts
 * on the way in and on the way out. That is one division and one multiplication
 * per axis, and it is what lets panels of unequal resolution follow each other
 * honestly.
 *
 * The conversion is not lossless in the coarse direction and must not pretend
 * to be. A window of 60 fine cells lands between two coarse cells; the coarse
 * panel is given the smallest cell window that **contains** the request, so it
 * shows at least what was asked for and never less. Round-tripping through it
 * therefore widens the window slightly, which is the second thing this module
 * has to survive.
 *
 * **The feedback loop.** A panel that is moved programmatically redraws, and
 * redrawing is how a panel reports where it is — so every push comes back as a
 * report one frame later, and a lock that acted on it would broadcast the
 * widened window, which would come back wider still. Three guards, and each
 * catches a different shape of echo:
 *
 * 1. {@link ViewportLock.driving} swallows the reports a push provokes
 *    synchronously;
 * 2. a pushed panel is owed exactly **one** report and it is ignored, which is
 *    what stops a panel that *clamped* the window from becoming the driver —
 *    without it, panning the lead past the end of a shorter companion's contig
 *    drags the lead back to where the companion stopped;
 * 3. {@link windowsAgree} swallows anything that arrives later at what is, to
 *    within half a cell of the reporting panel, the window already broadcast —
 *    a resize, a re-fit, a second frame of the same gesture.
 *
 * Without (3) a two-panel deck at two resolutions drifts one coarse cell per
 * frame until it hits a wall. With them the round trip converges in one
 * exchange, which is what `test/unit/panel-lock.test.ts` pins down.
 */

/** A window on one axis, in base pairs from the block's own first cell. */
export interface AxisWindow {
  lo: number
  hi: number
}

/** What every panel in a locked deck is showing, in base pairs. */
export interface LockWindow {
  rows: AxisWindow
  cols: AxisWindow
}

/** A half-open cell interval `[lo, hi)` on one axis of one panel's grid. */
export type CellSpan = [number, number]

/**
 * A panel's cell window turned into base pairs.
 *
 * Exact: a cell is `bpPerCell` base pairs wide by construction (§3.3's uniform
 * bin size, times whatever pooling the read chose), and the window's bounds are
 * cell offsets from the block's start.
 */
export function cellsToBp(span: CellSpan, bpPerCell: number): AxisWindow {
  const k = bpPerCell > 0 ? bpPerCell : 1
  return { lo: span[0] * k, hi: span[1] * k }
}

/**
 * A base-pair window turned into this panel's cells — outward, then slid inside
 * the block.
 *
 * `floor` on the low bound and `ceil` on the high one, so the cells handed back
 * cover the whole of what was asked for. A coarse panel asked for a window
 * narrower than one of its cells is given that one cell, which is the finest
 * thing it can say; giving it an empty span instead would be a division by zero
 * one frame later.
 *
 * The window is then **slid**, not truncated. Two files agree about a
 * coordinate and not about how much of it they hold: a contig that is 400 kb in
 * one assembly and 380 kb in another is the same contig, and a window at its far
 * end runs off the shorter one. Truncating it to whatever overlaps would answer
 * a 40 kb view with a one-bin view — a wildly different zoom, in a deck whose
 * whole promise is that the panels are showing the same thing. Sliding keeps the
 * span and puts it at the block's own end, which is what `HeatmapView.clampView`
 * does for exactly this reason, and is the answer a reader can read.
 *
 * A window wider than the whole block is the whole block, which is the same rule
 * seen from the other side.
 */
export function bpToCells(window: AxisWindow, bpPerCell: number, cells: number): CellSpan {
  const k = bpPerCell > 0 ? bpPerCell : 1
  const limit = Math.max(1, Math.floor(cells))
  const lo = Math.floor(Math.min(window.lo, window.hi) / k)
  const hi = Math.ceil(Math.max(window.lo, window.hi) / k)
  const span = Math.max(1, hi - lo)
  if (span >= limit) return [0, limit]
  const start = Math.max(0, Math.min(limit - span, lo))
  return [start, start + span]
}

/**
 * Whether two windows are the same window within one panel's ability to say so.
 *
 * `tolBp` is half a cell of whichever panel is being asked, so this answers
 * "did this report come back from something I pushed" rather than "are these
 * numbers equal". See the module header: it is the guard that closes the loop.
 */
export function windowsAgree(a: LockWindow, b: LockWindow, tolBp: number): boolean {
  const tol = Math.max(0, tolBp)
  return (
    Math.abs(a.rows.lo - b.rows.lo) <= tol &&
    Math.abs(a.rows.hi - b.rows.hi) <= tol &&
    Math.abs(a.cols.lo - b.cols.lo) <= tol &&
    Math.abs(a.cols.hi - b.cols.hi) <= tol
  )
}

/**
 * Whether two blocks describe the same stretch of genome, and may therefore be
 * locked to each other.
 *
 * The whole compatibility gate for a locked deck, and it is deliberately much
 * weaker than {@link compareRefusal}'s (§16.4). That gate refuses two files
 * that differ in bin size or in chromosome list, because one *grid* cannot be
 * two resolutions and one coordinate cannot index two lists. Neither objection
 * survives being drawn in two panels: two grids may be two resolutions, and
 * each panel indexes its own list.
 *
 * What is left is the one claim side-by-side panels actually make — *these two
 * pictures are of the same place* — and it is checked against the blocks that
 * came back rather than against the files, because that is the claim. Two
 * panels that resolved the same name to spans of different length resolved it
 * against different sequences, whatever the name says.
 *
 * The tolerance is one cell of the coarser panel: the last bin of a contig may
 * be short (§3.3), so two files at two resolutions round the same length to
 * spans that differ by less than one of the coarser cells, and refusing that
 * would refuse every honest pair with a bin size that does not divide the
 * contig.
 */
export function spansAgree(
  a: { spanBp: number; bpPerCell: number },
  b: { spanBp: number; bpPerCell: number },
): boolean {
  const tol = Math.max(a.bpPerCell, b.bpPerCell)
  return Math.abs(a.spanBp - b.spanBp) <= tol
}

/**
 * One panel, as the lock sees it.
 *
 * Read through functions rather than as fields because every one of them
 * changes under the lock: a block arrives at a coarser resolution than the last
 * one, a panel is unlocked mid-drag, a panel is removed. Snapshotting them at
 * join time is how a lock ends up driving a panel that is showing something
 * else.
 */
export interface LockMember {
  readonly id: string
  /** Base pairs one matrix cell covers, on this panel's current block. */
  bpPerCell(): number
  /** Cells per axis in the block this panel is showing. */
  cells(): { rows: number; cols: number }
  /** Whether this panel is following the deck, or has been let off the lead. */
  locked(): boolean
  /**
   * Show this cell window. Implementations must not report back synchronously;
   * the frame-later echo is expected and is handled by {@link windowsAgree}.
   *
   * @returns `false` where the panel could not move — it has no block yet — so
   * that no report is recorded as owed for a report that will never come.
   */
  show(rows: CellSpan, cols: CellSpan): boolean
}

/**
 * The one owner of where every locked panel is looking.
 *
 * Single owner by construction: panels never speak to each other, they report
 * here and are told. That is what makes the loop analysable at all — with N
 * panels each echoing to N−1 others there are N² conversations and no frame in
 * which the deck is in one state.
 */
export class ViewportLock {
  private members: LockMember[] = []
  /** Where the deck is looking, in base pairs; `null` until anybody has moved. */
  private current: LockWindow | null = null
  /** Set while a broadcast is in progress, so its synchronous echo is ignored. */
  private driving = false
  /**
   * Panels that have been pushed and have not answered yet.
   *
   * Each is owed one report and that report is thrown away. A panel that
   * *clamped* what it was given — its block is shorter, so it stopped at its own
   * last row — otherwise reports a window that genuinely differs from the
   * broadcast, becomes the driver, and drags every other panel back to where it
   * ran out. Which turns "pan past the end of the short one" into "you cannot
   * pan past the end of the short one", in a deck the reader assembled precisely
   * because the files are not identical.
   */
  private pending = new Set<string>()

  join(member: LockMember): void {
    this.leave(member.id)
    this.members.push(member)
  }

  leave(id: string): void {
    this.members = this.members.filter((member) => member.id !== id)
    this.pending.delete(id)
  }

  /** Where the deck is looking, for a panel that has just finished loading. */
  get window(): LockWindow | null {
    return this.current
  }

  /**
   * Forget where the deck was looking, because it is no longer a place.
   *
   * The currency is base pairs **from each block's own first cell**, which makes
   * a window a statement about one block rather than about the genome. Navigate
   * from a 100 kb contig to a 3 Mb one and `20,000–60,000` still parses, still
   * pushes, and means somewhere else entirely — so a companion that finished
   * reading before the lead would be scrolled to a window nobody asked for, and
   * with a table mounted there is no lead report to correct it.
   *
   * Called by the deck when the state selects a different block. Deliberately
   * not inferred from a panel's own extent changing: the first panel to settle
   * would then reset a window the others are already following.
   */
  reset(): void {
    this.current = null
    this.pending.clear()
  }

  /**
   * A panel moved. Adopt it as the deck's window and put every other locked
   * panel there, unless this is the echo of a move the deck itself made.
   */
  report(id: string, rows: CellSpan, cols: CellSpan): void {
    if (this.driving) return
    if (this.pending.delete(id)) return
    const source = this.members.find((member) => member.id === id)
    if (source === undefined || !source.locked()) return
    const bpPerCell = source.bpPerCell()
    const window: LockWindow = {
      rows: cellsToBp(rows, bpPerCell),
      cols: cellsToBp(cols, bpPerCell),
    }
    // Half a cell of the *reporting* panel: the report is quantised to this
    // panel's grid, so anything finer than that is not a movement it could have
    // expressed deliberately.
    if (this.current !== null && windowsAgree(this.current, window, bpPerCell / 2)) return
    this.current = window
    this.pushTo(this.members.filter((member) => member.id !== id))
  }

  /**
   * Put one panel where the deck is looking — a panel that has just arrived, or
   * one whose lock was just switched back on.
   *
   * Nothing happens where the deck has no window yet: the first panel to move
   * is what establishes one, and forcing a newcomer to a window nobody chose
   * would move it away from its own fitted view for no reason.
   */
  catchUp(id: string): void {
    if (this.current === null) return
    this.pushTo(this.members.filter((member) => member.id === id))
  }

  private pushTo(targets: readonly LockMember[]): void {
    const window = this.current
    if (window === null) return
    this.driving = true
    try {
      for (const member of targets) {
        if (!member.locked()) continue
        const bpPerCell = member.bpPerCell()
        const extent = member.cells()
        // A report is owed only where the panel actually moved. A panel whose
        // block has not arrived cannot, and never reports — so recording the
        // debt anyway left it owed forever and threw away that panel's first
        // real gesture once its block landed.
        const moved = member.show(
          bpToCells(window.rows, bpPerCell, extent.rows),
          bpToCells(window.cols, bpPerCell, extent.cols),
        )
        if (moved) this.pending.add(member.id)
      }
    } finally {
      this.driving = false
    }
  }
}
