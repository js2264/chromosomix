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
 * **The one exception is above bin level**, where a cell is a whole sequence
 * and therefore has no width in base pairs to convert through — see
 * {@link LockUnit}. There the currency is the cell index itself, which is the
 * same statement arrived at from the other side: carry the thing the two grids
 * genuinely share.
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
 * widened window, which would come back wider still. Four guards, and each
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
 *    a resize, a re-fit, a second frame of the same gesture;
 * 4. a report of the window a push would give this panel *now* — the deck's
 *    window clamped or slid into its block — is swallowed however late it
 *    comes, because (2) forgives a clamp once and a panel redraws more often
 *    than that: a zoom landing a sharper block on it is a redraw, not a move.
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

/**
 * What the deck's window is counted in, for one panel.
 *
 * `'bp'` is the module header's currency and the one almost every deck uses.
 * `'cell'` is the exception the header did not foresee: **above bin level a
 * cell is a whole sequence**, so it has no width in base pairs at all — the
 * number {@link LockMember.bpPerCell} answers there is the file's bin size,
 * which is a fact about the file and not a length of anything on screen.
 * Multiplying by it turned a window on chromosomes 10–14 of a 1 kb roll-up into
 * chromosomes 2–3 of the 5 kb roll-up beside it.
 *
 * The honest currency there is the **cell index itself**: at contig level cell
 * `i` is sequence `i`, and two panels over the same sequence list share that
 * index however they bin. So a contig-level deck locks in cells and, for the
 * first time, genuinely navigates at chromosome level. That is only true while
 * the two lists *are* the same list, which is the deck's own gate to check
 * ({@link spansAgree} and an equal cell count — see `panels/PanelDeck.ts`).
 *
 * Two panels in different currencies are never moved to one another's window.
 * The deck's gate refuses that pairing and says why, so this is the second
 * belt: a mixed deck stands still rather than moving somebody to a number that
 * means something else in their grid.
 */
export type LockUnit = 'bp' | 'cell'

/** What every panel in a locked deck is showing, in {@link LockWindow.unit}s. */
export interface LockWindow {
  rows: AxisWindow
  cols: AxisWindow
  /** What `lo` and `hi` count — see {@link LockUnit}. */
  unit: LockUnit
}

/** A half-open cell interval `[lo, hi)` on one axis of one panel's grid. */
export type CellSpan = [number, number]

/**
 * A panel's cell window turned into base pairs.
 *
 * Exact: a cell is `bpPerCell` base pairs wide by construction (§3.3's uniform
 * bin size, times whatever pooling the read chose), and the window's bounds are
 * cell offsets from the block's start. A step of one is the cell index itself,
 * which is what a panel above bin level carries ({@link LockUnit}).
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
 * The tolerance is one cell of the coarser panel **per sequence on the axis**:
 * the last bin of a contig may be short (§3.3), so two files at two resolutions
 * round the same length to spans that differ by less than one of the coarser
 * cells, and refusing that would refuse every honest pair with a bin size that
 * does not divide the contig.
 *
 * Per sequence, because a cell never straddles one (`metacooler/pooling.ts`):
 * an axis of sixteen chromosomes rounds sixteen last cells up, not one, and a
 * single-cell allowance there refused two roll-ups of the same genome — the
 * false accusation §16.4 calls worse than saying nothing. `sequences` defaults
 * to one, which is the single-contig region view the old allowance was written
 * for and the only case it was ever right for.
 */
export function spansAgree(
  a: { spanBp: number; bpPerCell: number },
  b: { spanBp: number; bpPerCell: number },
  sequences = 1,
): boolean {
  const tol = Math.max(a.bpPerCell, b.bpPerCell) * Math.max(1, sequences)
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
  /**
   * What this panel's window is counted in — see {@link LockUnit}.
   *
   * Asked per call like everything else here: a level toggle changes it under a
   * live deck, and a panel snapshotted as positional while it was reading bins
   * is one the lock would drive in the wrong currency a frame later.
   */
  unit(): LockUnit
  /**
   * Base pairs one matrix cell covers, on this panel's current block. Read only
   * where {@link LockMember.unit} is `'bp'`; above bin level a cell has no
   * width in base pairs and the index is carried instead.
   */
  bpPerCell(): number
  /** Cells per axis in the block this panel is showing. */
  cells(): { rows: number; cols: number }
  /**
   * Where the first cell of this panel's block sits in its sequence, in base
   * pairs, per axis — read only where {@link LockMember.unit} is `'bp'`.
   *
   * What makes the currency a **place** rather than an offset into a block. A
   * block read whole begins its sequence and answers zero, which is the lock as
   * it always was; a block a zoom refined is a window read from somewhere inside
   * it (§2), and two maps whose zooms read different windows — one map's at
   * 87.7 Mb, the other's at 88.0 — were put at the same offset into each, which
   * is two places 300 kb apart. Absent is zero.
   */
  origin?(): { rows: number; cols: number }
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
  /**
   * What this panel is showing now, in its own cells — which after {@link show}
   * can be more than it was told on one axis, where the window's shape is not
   * its box's. Optional: absent, the lock takes the panel to show exactly what
   * it was told.
   */
  viewport?(): { rows: CellSpan; cols: CellSpan } | null
  /**
   * Read what this panel holds too little of to show: the deck's window, in its
   * own cells, where it reaches past the block on screen (§16.3) — a zoom read a
   * stretch of the region and the deck went wider, or went on past its end.
   * Optional: a panel that cannot read more is shown the window clamped, as
   * every panel was before.
   *
   * Counted from the block's first cell as {@link show}'s spans are, and **not**
   * clamped to it: below zero and past the last cell is what is being asked
   * for. The panel may put a block it already holds on screen before it
   * returns, which the lock then shows the window on; or start a read and
   * return at once, and say when its block lands ({@link ViewportLock.landed}),
   * when the lock shows the window again on that.
   */
  reach?(rows: CellSpan, cols: CellSpan): void
}

/**
 * How wide one of this panel's cells is, in the currency it locks in.
 *
 * One for a panel counting cells, which makes every conversion below the
 * identity rather than a second code path: `cellsToBp` at a step of one is the
 * cell index, and `bpToCells` at a step of one is that index slid back inside
 * the block, which is exactly the rule a shorter sequence list needs anyway.
 */
function stepOf(member: LockMember): number {
  return member.unit() === 'cell' ? 1 : member.bpPerCell()
}

/** Where a member's block begins, in the currency it locks in: zero counting cells. */
function originOf(member: LockMember): { rows: number; cols: number } {
  return member.unit() === 'cell' ? { rows: 0, cols: 0 } : (member.origin?.() ?? { rows: 0, cols: 0 })
}

/**
 * Which block a member holds, as far as the lock can tell: its currency, its
 * grid, its size and where it begins. A block a read landed differs in one of
 * them from the block before it.
 */
function blockOf(member: LockMember): string {
  const extent = member.cells()
  const origin = originOf(member)
  return `${member.unit()}|${stepOf(member)}|${extent.rows}×${extent.cols}|${origin.rows},${origin.cols}`
}

/**
 * The deck's window in a member's own cells, unclamped, where it reaches more
 * than half a cell past the member's block on either axis; `null` where the
 * block holds all of it, and above bin level, where a cell is a whole sequence
 * and there is nothing finer or further to read.
 */
function beyondBlock(member: LockMember, window: LockWindow): { rows: CellSpan; cols: CellSpan } | null {
  if (window.unit !== 'bp' || member.unit() !== 'bp') return null
  const step = stepOf(member)
  const extent = member.cells()
  const origin = originOf(member)
  const raw = (axis: AxisWindow, at: number): CellSpan => [
    (Math.min(axis.lo, axis.hi) - at) / step,
    (Math.max(axis.lo, axis.hi) - at) / step,
  ]
  const rows = raw(window.rows, origin.rows)
  const cols = raw(window.cols, origin.cols)
  const past = (span: CellSpan, cells: number): boolean => span[0] < -0.5 || span[1] > cells + 0.5
  return past(rows, extent.rows) || past(cols, extent.cols) ? { rows, cols } : null
}

/** A window moved along its axis by `by`. */
function shifted(window: AxisWindow, by: number): AxisWindow {
  return by === 0 ? window : { lo: window.lo + by, hi: window.hi + by }
}

/** Whether two spans of one panel's cells are the same within half a cell. */
function cellsAgree(a: CellSpan, b: CellSpan): boolean {
  return Math.abs(a[0] - b[0]) <= 0.5 && Math.abs(a[1] - b[1]) <= 0.5
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
  /**
   * Where the deck is looking, in the currency of whichever panel established
   * it ({@link LockUnit}); `null` until anybody has moved.
   */
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
  /**
   * Where the lock last put each panel, in base pairs — as it then showed it,
   * {@link LockMember.viewport} — and on which block; forgotten when the panel
   * moves itself.
   *
   * A panel still where it was put, on the block it had, is redrawing rather
   * than moving ({@link report}); one a block has gone in under since is shown
   * the deck's window again on that block ({@link landed}).
   */
  private placed = new Map<string, { window: LockWindow; block: string }>()

  join(member: LockMember): void {
    this.leave(member.id)
    this.members.push(member)
  }

  leave(id: string): void {
    this.members = this.members.filter((member) => member.id !== id)
    this.pending.delete(id)
    this.placed.delete(id)
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
    this.placed.clear()
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
    const step = stepOf(source)
    const origin = originOf(source)
    // **The deck's window as this panel can show it is not a movement**, however
    // often it is reported. A block narrower than the deck's window holds it
    // clamped or slid (`bpToCells`), and guard (2) forgives one report of that
    // and no more — so the panel's next redraw of the same clamp, a zoom's
    // sharper block landing on it, was taken for a gesture and dragged every
    // other map onto the stretch this one happened to hold. Asked in this
    // panel's own cells, half a cell either way, exactly as a push would put it.
    if (this.current !== null && this.current.unit === source.unit()) {
      const extent = source.cells()
      const pushed = {
        rows: bpToCells(shifted(this.current.rows, -origin.rows), step, extent.rows),
        cols: bpToCells(shifted(this.current.cols, -origin.cols), step, extent.cols),
      }
      if (cellsAgree(pushed.rows, rows) && cellsAgree(pushed.cols, cols)) return
    }
    const window = this.windowOf(source, rows, cols)
    // **Still where the deck put it** (`placed`), on the block it was put there
    // on: a redraw, not a movement — and one that can differ from the deck's
    // window by more than the clamp above, where the box is not the window's
    // shape and the panel shows paper beside a block narrower than it.
    if (this.stillPut(source, window)) return
    // Half a cell of the *reporting* panel: the report is quantised to this
    // panel's grid, so anything finer than that is not a movement it could have
    // expressed deliberately. Compared only against a window in the same
    // currency — the numbers are not otherwise about the same thing, and a
    // level toggle would look like a nudge under the tolerance.
    if (
      this.current !== null &&
      this.current.unit === window.unit &&
      windowsAgree(this.current, window, step / 2)
    ) {
      return
    }
    // The panel is the deck's window now, rather than somewhere it was put.
    this.placed.delete(id)
    this.current = window
    this.pushTo(this.members.filter((member) => member.id !== id))
  }

  /** A report in base pairs, from where the reporting panel's block sits. */
  private windowOf(source: LockMember, rows: CellSpan, cols: CellSpan): LockWindow {
    const step = stepOf(source)
    const origin = originOf(source)
    return {
      rows: shifted(cellsToBp(rows, step), origin.rows),
      cols: shifted(cellsToBp(cols, step), origin.cols),
      unit: source.unit(),
    }
  }

  /**
   * Whether a panel reporting `window` is still where the lock last put it
   * ({@link placed}), on the block it was put there on, half a cell of its
   * grid either way. Asked in the same currency only: a level toggle is a move.
   */
  private stillPut(source: LockMember, window: LockWindow): boolean {
    const placed = this.placed.get(source.id)
    if (this.current === null || placed === undefined || placed.window.unit !== window.unit) return false
    return placed.block === blockOf(source) && windowsAgree(placed.window, window, stepOf(source) / 2)
  }

  /**
   * A block went in under a panel: a read it was asked for landing
   * ({@link LockMember.reach}), or one its own zoom read.
   *
   * A panel still where the lock last put it ({@link placed}) is shown the
   * deck's window again, on a block that may hold more of it — now, before the
   * redraw the block makes, so that redraw is the echo of the push and not a
   * report. It used to be the report: the place the panel had been clamped to,
   * on a block that could show more, differing from the deck's window and so
   * taken for a gesture that dragged every other map back onto the clamp. Not
   * found by comparing windows, since the block going in can move the window
   * itself — a box the window's shape is not, showing paper beside the old
   * block, has the paper taken away by the new one.
   *
   * A panel that has moved itself since is the deck's window, or will be with
   * its next report, and is left alone; so is one inside a push, which shows
   * the window on whatever block it ends with ({@link pushTo}).
   */
  landed(id: string): void {
    if (this.driving || this.current === null) return
    const member = this.members.find((candidate) => candidate.id === id)
    const placed = this.placed.get(id)
    if (member === undefined || placed === undefined || !member.locked()) return
    if (placed.block === blockOf(member)) return
    this.pushTo([member])
  }

  /**
   * Adopt a window as the deck's **without moving anybody to it**.
   *
   * The gap {@link catchUp} leaves. A window is established by a panel
   * *reporting*, and a panel reports when it draws — so a deck whose lead has
   * not redrawn since the lock was built has no window, and a companion that
   * arrives into that gap is left at its own fitted view. Which is the one
   * thing a deck must not do: two maps side by side under a bar saying they are
   * one navigation, one of them zoomed into a locus and the other showing its
   * whole block.
   *
   * The gap is not hypothetical and it is not a race in the renderer. A deck is
   * built the moment a reader adds a second map, and the lead they added it
   * beside was drawn — and reported nothing, because nothing was listening —
   * before the lock existed. Every window the reader had chosen up to that point
   * is therefore invisible to the deck until they touch the map again.
   *
   * So the deck seeds it from the lead's *present* window, which is a thing the
   * lead can be asked for at any time. Deliberately **not** a
   * {@link ViewportLock.report}: a report is a gesture and would push every
   * member, recording a debt against panels that are already where they should
   * be and swallowing their next real move. Seeding sets the window and moves
   * nothing; whoever needs to catch up says so.
   *
   * Only where there is no window — an established one is a reader's choice and
   * outranks whatever the lead happens to be showing.
   */
  seed(
    rows: CellSpan,
    cols: CellSpan,
    step: number,
    unit: LockUnit,
    origin: { rows: number; cols: number } = { rows: 0, cols: 0 },
  ): void {
    if (this.current !== null) return
    const at = unit === 'cell' ? { rows: 0, cols: 0 } : origin
    this.current = {
      rows: shifted(cellsToBp(rows, step), at.rows),
      cols: shifted(cellsToBp(cols, step), at.cols),
      unit,
    }
  }

  /**
   * Put one panel where the deck is looking — a panel that has just arrived, or
   * one whose lock was just switched back on.
   *
   * Nothing happens where the deck has no window yet: the first panel to move
   * is what establishes one, and forcing a newcomer to a window nobody chose
   * would move it away from its own fitted view for no reason. {@link seed} is
   * how the deck says what that window is when it knows and nobody has moved.
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
        // A window counted in sequences is not a window this panel can read as
        // base pairs, nor the other way about. The deck's gate refuses such a
        // pairing and prints why, so reaching here at all is a panel mid-read
        // between two levels — and standing still is the only honest thing to
        // do with a number that means something else in its grid.
        if (member.unit() !== window.unit) continue
        // A report is owed only where the panel actually moved. A panel whose
        // block has not arrived cannot, and never reports — so recording the
        // debt anyway left it owed forever and threw away that panel's first
        // real gesture once its block landed.
        let moved = this.place(member, window)
        // **What the panel holds too little of, it is asked to read.** Every
        // block was once read whole, and the clamp was the honest answer for a
        // file that was shorter; since a zoom reads a window inside the region
        // (§2) the block is usually a stretch of it, and the clamp left a map
        // that had been zoomed showing that stretch beside one showing the whole
        // chromosome — after Fit the view on the other map, or a zoom out past
        // the stretch — with nothing ever reading the rest: a view showing its
        // whole block asks the ladder for nothing (`ui/refine.ts`, `edgeWanted`).
        // After the clamp is shown, so a read is planned against the window on
        // screen; a block the panel already held can go in at once, and the
        // window is shown again on that.
        const asked = member.reach === undefined ? null : beyondBlock(member, window)
        if (asked !== null) {
          const before = blockOf(member)
          member.reach?.(asked.rows, asked.cols)
          if (blockOf(member) !== before) moved = this.place(member, window) || moved
        }
        if (moved) this.pending.add(member.id)
      }
    } finally {
      this.driving = false
    }
  }

  /**
   * Show one panel the deck's window, as its block can — clamped or slid where
   * the block is shorter (`bpToCells`) — and remember where it was put, as what
   * it then shows ({@link LockMember.viewport}).
   */
  private place(member: LockMember, window: LockWindow): boolean {
    const step = stepOf(member)
    const extent = member.cells()
    const origin = originOf(member)
    const rows = bpToCells(shifted(window.rows, -origin.rows), step, extent.rows)
    const cols = bpToCells(shifted(window.cols, -origin.cols), step, extent.cols)
    if (!member.show(rows, cols)) return false
    const shown = member.viewport?.() ?? { rows, cols }
    this.placed.set(member.id, {
      window: {
        rows: shifted(cellsToBp(shown.rows, step), origin.rows),
        cols: shifted(cellsToBp(shown.cols, step), origin.cols),
        unit: window.unit,
      },
      block: blockOf(member),
    })
    return true
  }
}
