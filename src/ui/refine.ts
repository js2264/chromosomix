/**
 * The rule that decides when a zoom is worth a read.
 *
 * §2 said pan and zoom perform no I/O, and derived a whole architecture from
 * it: no tiling, no tile cache, no resolution pyramid, no progressive
 * refinement. Three of those four are still true and this module does not touch
 * them. What it changes is the fourth, and it changes it the way the app had
 * already changed it once — for the tracks drawn on this same axis.
 *
 * `annotations/samples.ts` opens by saying how that was done: *"That is not
 * achieved by fetching less; it is achieved by fetching a window wider than the
 * view at a resolution rounded to a power of two, and redrawing from what is in
 * hand until the view leaves either."* A drag of up to half a screen and a zoom
 * inside one power of two cost nothing at all, and a lane never blanks while it
 * waits. This is the same three ideas over the matrix: **pad the window, quantise
 * the resolution, and never take a picture off the screen to wait for a better
 * one.**
 *
 * Two things make it much smaller here than a tile pyramid would be.
 *
 * **The grid is the sequence's.** `snapToGrid` (`worker/reader.worker.ts`)
 * anchors whatever grid a read is asked at to the *sequence* rather than to the
 * request, so a refine is the same `matrix` request with narrower extents, and
 * two blocks of the same region at the same grid agree cell for cell wherever
 * they overlap. Nothing is composited and there is no seam.
 *
 * **And the ladder sizes it to the screen** ({@link screenPlan}): about a cell
 * to each CSS pixel of the view, from the coarsest stored rung that gives it.
 * Every read used to be as large as memory allowed — the reader's own plan,
 * `fitPlan`, fills the device's budget, a window of sixteen thousand bins read a
 * bin to a cell — which made each refine a gigabyte of values and seconds of
 * reading for a picture seven hundred pixels across, and the map held still for
 * all of it. A screen-sized read is a few hundred milliseconds, so the map never
 * holds still: a gesture goes on over the block in hand, the next block is read
 * a little ahead of it, and lands on wherever the gesture has got to (SPECS §2).
 * The reader's own plan is still what a read with no screen gets — a figure's
 * ({@link BlockLadder.sharpen}), and every read with *Refine on zoom* off.
 *
 * This module used to say it must **never** send `binsPerCell`, because a request
 * carrying an explicit plan bypassed `snapToGrid` and the cell values would then
 * change as the reader panned. The reader snaps an explicit plan too now, which
 * is what lets the screen plan exist, and {@link LadderOptions.floor}: a reader
 * who has asked for a resolution the file does not store (§3.4) has committed to
 * a grid, and the refine has to hold it rather than quietly reading past it on
 * the next zoom.
 *
 * **It terminates.** There is no grid below the file's own bins, so the ladder
 * has a floor and reaches it: about `⌈log₂(k₀)⌉` steps, where `k₀` is what the
 * widest view was read at — a step each time the zoom doubles, and the last one
 * onto the file's own bins, which a view that can show them is always given.
 *
 * Zooming **out** is served the same way and is usually free: the blocks already
 * read are kept, so leaving the window a fine block covers falls back to a
 * coarser one that is still in hand. Only going wider than anything held costs a
 * read, and it is bounded by the ceiling — the view's own domain — so a zoom can
 * never turn into the whole-file scan §7.3 gates.
 */

import { denseCellCap } from '../metacooler/matrix'
import { POOLED_CELL_CAP } from '../metacooler/pooling'
import type { Extent } from '../types'
import type { Cancellable } from '../worker/client'
import type { MatrixResult } from '../worker/protocol'

/**
 * How much wider than the view a refine reads, as a fraction of the view.
 *
 * Half a window on each side, which is `FETCH_PAD` in `annotations/samples.ts`
 * and is that number for the same reason: a pan of up to half a screen then
 * costs nothing, and a window with no margin misses on the first pixel of
 * movement. Wider costs bytes nobody looks at — and here it also costs
 * resolution, since the reader fits a fixed cell count to whatever it is asked
 * for, so padding four times the view would read the picture two grids coarser
 * than it could have.
 */
export const REFINE_PAD = 0.5

/**
 * How much wider a *widening* read reaches, as a multiple of the view.
 *
 * Bigger than {@link REFINE_PAD} because zooming out is a gesture rather than a
 * step: a reader who has started pulling back is usually going somewhere, and
 * buying more than the frame needs turns several of the reads the rest of the
 * gesture would have asked for into one. It costs nothing in resolution, because
 * a wider view was going to be coarser anyway.
 *
 * One view each side, so three across. It was four each side, nine across, when
 * every read was as large as memory allowed and the point was to read rarely. A
 * screen-sized read puts a cell on each pixel of the view (§2), so it reads the
 * window it is given at the view's grid, and nine views across would be nine
 * times the cells on each axis for a gesture that read-ahead now keeps up with
 * ({@link READ_AHEAD_EDGE}).
 */
export const WIDEN_REACH = 1

/**
 * A grid this much coarser than the picture could show is worth replacing.
 *
 * §8.4's rule for the tracks, applied to the map: refetch when *"the required
 * resolution crosses a factor of two — not once per frame, and never during a
 * drag"*. Below two, a slow zoom would re-read continuously for a difference the
 * eye cannot find; at two, the ladder is the `k₀ → ⌊k₀/2⌋ → … → 1` staircase and
 * every step is a visible sharpening.
 */
export const REFINE_FACTOR = 2

/**
 * The factor of {@link REFINE_FACTOR}, while the reader is zooming **in**.
 *
 * A read the reader waits for is a read that started too late. A zoom that is
 * still going inward will cross the factor of two in a moment, so the read for
 * it starts here, at about the square root of two, and is usually in by the time
 * the cells would have been big enough to see (§2). Standing still, or zooming
 * out, keeps the factor of two: a reader who stopped half way has nothing more
 * to read.
 */
export const READ_AHEAD_FACTOR = 1.4

/**
 * How close, as a fraction of the view, the view may come to an edge of its
 * block before the block is read again around it.
 *
 * The pan's read-ahead. A block is padded half a view on each side, so a reader
 * panning towards its edge used to meet a wall there — the view cannot be
 * dragged past the data it has — and wait at it for the next block. Reading
 * when the margin falls below a quarter of a view starts that read while there
 * is still ground to cover, so the next block is usually in before the edge is.
 */
export const READ_AHEAD_EDGE = 0.25

/**
 * How many screen widths of cells any screen-sized read may carry across its
 * wider axis.
 *
 * A zoom's read is two views across, a widening one three; this is above both,
 * so it bites only on a read much wider than the view it is for, and coarsens
 * that one rather than letting it grow with its window.
 */
export const SCREEN_READ_CAP = 3.2

/**
 * Blocks kept so that zooming back out costs nothing.
 *
 * Eight now that a block is about the size of the screen: a zoom from a whole
 * chromosome to its own bins is about that many steps, and every one of them is
 * then a step back out that reads nothing. {@link HELD_BYTES} still bounds the
 * memory, which is what bounded it when there were three of them.
 */
export const HELD_BLOCKS = 8

/**
 * Bytes of held blocks above which the oldest are dropped.
 *
 * Two blocks at the cap is 134 MB, which is the same order as the compare path
 * already holds (`MatrixPanel.derive` keeps up to five block-sized arrays for a
 * split-diagonal map with a derivation on). The third is kept when it is small,
 * which is the common case: a block is `⌈span/k⌉²` cells, and only the widest
 * view of a large cooler is anywhere near the cap.
 */
export const HELD_BYTES = 160 << 20

/** The window on screen, in absolute bins of the open map. */
export interface RefineView {
  rows: Extent
  cols: Extent
  /** Bins summed into one drawn cell — `MatrixResult.binsPerCell`, or 1. */
  binsPerCell: number
  /**
   * CSS pixels across the plot's wider side: what a **screen-sized** read is
   * sized to (§2). Absent is a view with no screen to measure, read as memory
   * allows — the plan every read had before reads were sized to the screen.
   */
  screen?: number
  /**
   * The zoom, as a multiple of the zoom that fits the block: `1` showing the
   * whole block, above it zoomed in, below it zoomed out past the block into
   * the paper round it. What tells a fitted view, which is pressed against
   * every edge of its block because it shows all of it, from a reader pushing
   * against one. Absent is read as zoomed in.
   */
  fit?: number
}

/**
 * How a read is asked for: the rung it comes from, the bins of that rung each
 * cell sums, and the grid that comes to in bins of the open map — the unit
 * every block the ladder holds is compared in.
 */
export interface ReadPlan {
  rung?: string
  binsPerCell?: number
  grid: number
}

/** What a ladder needs of the world. */
/** How a block is handed over; see {@link LadderOptions.onBlock}. */
export interface BlockHandover {
  /** Measure the colour range on this block, as a window read once always was. */
  measure?: boolean
}

export interface LadderOptions {
  /**
   * Read a block. The ladder never builds a request itself, so each view keeps
   * its own — a `matrix`, an `aggregate`, a balanced one, a scored one — and the
   * ladder stays ignorant of the protocol.
   *
   * It must be a `Cancellable`, because a read superseded mid-gesture has to be
   * called off rather than raced: the worker checks between pixel windows
   * (`worker/reader.worker.ts`), so a cancel that is never sent is a scan that
   * runs to the end for a picture nobody is waiting for.
   *
   * `plan` is a screen-sized read's rung and grid ({@link planFor}). Absent,
   * the read is planned as memory allows: the reader fits the finest grid the
   * device's budget affords, which is every read of a view with no screen, and
   * the read a figure is drawn from ({@link BlockLadder.sharpen}).
   */
  read(rows: Extent, cols: Extent, plan?: ReadPlan): Cancellable<MatrixResult>
  /**
   * The screen-sized plan for reading `window` while `view` is on screen
   * ({@link screenPlan}, which knows the file's rungs and the declared grid).
   * Absent, a plan with no rungs: the open map, pooled to the view's grid.
   */
  planFor?(window: { rows: Extent; cols: Extent }, view: RefineView): ReadPlan
  /** The clock read-ahead times a zoom by; `performance.now` when absent. */
  now?(): number
  /**
   * The widest this ladder may ever ask for, per axis: the view's own domain.
   *
   * A region view's contig, a genome view's genome, a whole view's file. It is
   * what stops a zoom-out from becoming the full pixel scan §7.3 exists to gate,
   * and it is the reason this needs no size guard of its own — every request is
   * inside one the view has already been allowed to make.
   */
  ceiling: { rows: Extent; cols: Extent }
  /**
   * Hand a block over, and say whether it went in.
   *
   * `false` where the panel could not place it — a window it cannot convert on
   * the incoming grid ({@link MatrixPanel.regrid}) — and the ladder then forgets
   * the block rather than believing a picture that is not on screen. Which is
   * also why it is a return value rather than a `void` callback: a ladder whose
   * idea of what is drawn is wrong stops reading, and stops for a reason nobody
   * can see.
   *
   * `how.measure` is a block {@link BlockLadder.sharpen} puts on screen: the
   * window already there, on a finer grid, whose colour range is measured on
   * the block itself rather than kept from the one it replaces (§7.1).
   */
  onBlock(result: MatrixResult, how?: BlockHandover): boolean
  /**
   * The memory budget the view's reads carry, where it is not the device's own.
   *
   * The reader reads a window bin for bin up to what that budget affords
   * (`denseCellCap`), so the grid this ladder expects must be computed from the
   * same number: a deck's panel reads with a share (§16.7), and a ladder judging
   * its blocks against the whole device would expect one bin to a cell, be handed
   * a pooled block every time, and read again forever. Absent or `undefined` is
   * the device's budget, which is what the reader assumes too.
   */
  budget?: () => number | undefined
  /**
   * The coarsest grid this ladder may refine **to**, in bins of the open map.
   *
   * The reader's declared resolution (§3.4), as a number of the open map's bins
   * per drawn cell: a 10 kb rung derived from a 2 kb one is `5`. Without it the
   * ladder would do exactly what it is for and read finer on the next zoom —
   * which is right when nobody has said otherwise and wrong the moment somebody
   * has, because the axis has been *labelled* 10 kb and a 2 kb block under that
   * label is a caption that lies.
   *
   * A function rather than a number because the declaration changes under a
   * mounted ladder: a reader stepping from 10 kb to 3 kb does not rebuild the
   * view, and a value captured at construction would hold the ladder at whatever
   * was showing when the map opened.
   *
   * Absent, or 1, is every view of every file until somebody presses `+`.
   */
  floor?(): number
  /**
   * Told when a read is outstanding, for whatever the view shows meanwhile —
   * the spinner in the plot's corner, over a view that still takes every
   * gesture (`HeatmapView.setWaiting`).
   */
  onBusy?(busy: boolean): void
  /** Told when a read fails, so the view can say so once rather than per frame. */
  onError?(err: unknown): void
  /** Told when the ladder is destroyed, for whatever its wiring must let go of. */
  dispose?(): void
}

interface Held {
  result: MatrixResult
  /**
   * The window that was **asked for**, in bins of the open map.
   *
   * Not `result.rowExtent`, which describes the block on whatever grid answered
   * — and on a sibling rung that is a different bin space entirely. The ladder
   * compares windows to decide what to do next, so every window it holds has to
   * be in the space it asks in, and the only one that always is is the request's
   * own.
   */
  rows: Extent
  cols: Extent
  /** Bins of the open map per drawn cell — the grid, in the ladder's own unit. */
  grid: number
  bytes: number
}

/**
 * How long after the view last shrank a zoom still counts as going inward, for
 * {@link READ_AHEAD_FACTOR}. A wheel's notches arrive tens of milliseconds
 * apart and a trackpad's more often, so this spans the gaps of one gesture and
 * not a reader who has stopped to look.
 */
export const INWARD_MS = 400

/**
 * How much wider than the framed window a figure's block is read, each side, as
 * a fraction of it ({@link BlockLadder.sharpen}).
 */
const SHARPEN_PAD = 0.05

/**
 * How far from `1` a view's {@link RefineView.fit} may be and still be fitted:
 * the zoom is a float, and a fit recomputed after a resize lands a hair off it.
 */
const FIT_SLACK = 0.02

export class BlockLadder {
  private readonly options: LadderOptions
  private held: Held[] = []
  private current: MatrixResult | null = null
  private inflight: { key: string; rows: Extent; cols: Extent; grid: number; cancel(): void } | null = null
  private pending: { rows: Extent; cols: Extent; key: string } | null = null
  /**
   * Reads that failed, by key.
   *
   * Kept rather than cleared, on `MapPanel`'s rule: a refusal is deterministic —
   * a block this share of the budget will not lend, a name this file has not got
   * — so retrying it costs one refused read per frame of a drag and produces the
   * same sentence every time. Moving the window changes the key, which is what
   * retries.
   */
  private readonly refused = new Set<string>()
  /**
   * The read a figure is waiting on ({@link sharpen}). Nothing else is read
   * while it runs: every other read would be for a picture it is about to
   * replace, and one that landed after it would take the figure's block away.
   */
  private sharpening: Promise<boolean> | null = null
  /**
   * A figure's block ({@link sharpen}), and the view it was first drawn for.
   *
   * It stays on screen until the reader moves, whatever the rules would read
   * instead. It is finer than the screen needs and only a twentieth wider than
   * the frame, so the next frame would otherwise read a screen-sized block around
   * the view at once: a second read for a reader who has not moved, and the line
   * above the map naming a grid other than the one the figure was drawn on.
   */
  private standing: { result: MatrixResult; view: RefineView | null } | null = null
  /** The view's span on the last frame, for whether a zoom is going inward. */
  private lastSpan = 0
  /** When the last frame was considered. */
  private lastAt = Number.NEGATIVE_INFINITY
  /** When the view last shrank between two frames of one gesture; see {@link INWARD_MS}. */
  private inwardAt = Number.NEGATIVE_INFINITY
  private disposed = false

  constructor(options: LadderOptions) {
    this.options = options
  }

  /**
   * Seed the ladder with a block the view read for itself.
   *
   * Every view still makes its own first read — the ladder is not in the path
   * that puts a picture on screen, which is what keeps a failure here from being
   * a blank map — and hands the result over so that zooming out lands back on it
   * for free.
   */
  adopt(result: MatrixResult, rows?: Extent, cols?: Extent): void {
    this.current = result
    // A block read from a sibling rung describes itself on that rung's grid;
    // `source` is the window it was asked for, in the open map's bins.
    this.keep(
      result,
      rows ?? result.source?.rows ?? result.rowExtent,
      cols ?? result.source?.cols ?? result.colExtent,
    )
  }

  /** The finest block held that covers `window`, or `null`. */
  private bestFor(window: { rows: Extent; cols: Extent }): Held | null {
    let best: Held | null = null
    for (const held of this.held) {
      if (!covers(held.rows, window.rows) || !covers(held.cols, window.cols)) continue
      if (best === null || held.grid < best.grid) best = held
    }
    return best
  }

  /** What the ladder is holding for the block it last handed over. */
  private held0(): Held | null {
    return this.held.find((entry) => entry.result === this.current) ?? null
  }

  /**
   * The block in hand to put on screen for `view`: the finest one good enough to
   * stay there ({@link fits}) — and, where none is, the finest that covers the
   * view at all, to look at while the read it wants is made.
   *
   * Good enough *to stay* is the point. A finer block whose edge the view is
   * within reach of would be handed over, read around at the screen's grid,
   * handed back for being finer than what that read brought, and read around
   * again, for as long as the reader stood there: a block that a zoom has left
   * behind is finer than the screen needs, which is exactly what made it look
   * like the better answer.
   *
   * The block on screen gives way only to a finer one while it is still a whole
   * picture of the view — nothing pressed against, nothing past its edge, a grid
   * still fine enough. A reader nearing its edge is read ahead of; handing them
   * a coarser block that happens to reach further would coarsen the picture of
   * where they already are.
   */
  private handOver(view: RefineView, inward: boolean): Held | null {
    const wanted = this.gridWanted(view)
    let good: Held | null = null
    let covering: Held | null = null
    for (const held of this.held) {
      if (!covers(held.rows, view.rows) || !covers(held.cols, view.cols)) continue
      if (covering === null || held.grid < covering.grid) covering = held
      if ((good === null || held.grid < good.grid) && this.fits(held, view, inward, wanted)) good = held
    }
    const shown = this.held0()
    const finer = good !== null && shown !== null && good.grid < shown.grid
    if (shown !== null && !finer && this.fits(shown, view, inward, wanted, false)) return shown
    return good ?? covering
  }

  /**
   * Whether a figure's block is to stay on screen this frame
   * ({@link standing}): it is the block on screen, and the view is the one it
   * was first drawn for. The first frame after it lands says which view that
   * is, since the panel carries the window onto the block as it puts it there.
   */
  private stands(view: RefineView): boolean {
    const standing = this.standing
    if (standing === null) return false
    if (standing.result === this.current) {
      if (standing.view === null) {
        standing.view = view
        return true
      }
      if (sameWindow(standing.view, view)) return true
    }
    this.standing = null
    return false
  }

  /**
   * Consider the window on screen: hand over a better block if one is already
   * held, and start a read if none is good enough.
   *
   * Called once per frame from the panel's own rAF, so it must be cheap when
   * nothing has moved — which is every frame of a pan inside what was fetched.
   * It never waits, never takes the picture away and never holds the view
   * still: the block on screen stays up and takes every gesture while a better
   * one is read, and the better one lands on wherever the reader has got to
   * (`MatrixPanel.regrid`).
   */
  consider(view: RefineView): void {
    if (this.disposed || this.sharpening !== null) return
    const inward = this.zoomingIn(view)
    if (this.stands(view)) return
    const wanted = this.plan(view)
    const key = keyOf(wanted.rows, wanted.cols)

    // Something already in hand may be a better answer than what is drawn —
    // which is the whole of what makes zooming back out free.
    const best = this.handOver(view, inward)
    if (best !== null && best.result !== this.current) {
      if (this.options.onBlock(best.result)) this.current = best.result
      else this.drop(best.result)
    }

    if (this.satisfied(view, inward)) {
      this.pending = null
      return
    }
    if (this.refused.has(key)) return

    // A read already going for a window that still contains what is on screen,
    // on a grid the screen is still within a factor of two of, is the read this
    // frame wants. One that no longer contains it is finishing a picture of
    // somewhere else, and one the zoom has outrun would land already too coarse
    // to keep: either is called off for the read the view wants now. That is
    // what replaces the freeze that used to make a gesture wait for its read —
    // the gesture goes on, and only its latest window is read.
    const flight = this.inflight
    if (flight !== null) {
      const inside = covers(flight.rows, view.rows) && covers(flight.cols, view.cols)
      if (inside && flight.grid <= this.gridWanted(view) * REFINE_FACTOR) return
      flight.cancel()
      this.inflight = null
      this.options.onBusy?.(false)
    }

    this.pending = { ...wanted, key }
    this.fire(view)
  }

  /**
   * Read `window` as memory allows and put it on screen — unless a block held
   * is already that fine — and say whether that is what is on screen now.
   *
   * What a figure is drawn from. A screen-sized block is about as fine as the
   * screen, and a figure is a page at 300 dpi: so saving one reads the framed
   * window as the view would have read it before reads were sized to the screen,
   * and the figure keeps the grid the reader chose (§19.2). It is also what
   * turning *Refine on zoom* off asks for, with the view's whole domain: the one
   * large block that reading once and zooming freely has always meant.
   *
   * Every read in flight is called off and no other starts until this lands:
   * each would be for a picture this is about to replace. `onReading` is told
   * when a read is actually made, so a figure that is already fine enough says
   * nothing about reading.
   */
  sharpen(window: { rows: Extent; cols: Extent }, onReading?: () => void): Promise<boolean> {
    if (this.disposed) return Promise.resolve(false)
    if (this.sharpening !== null) return this.sharpening
    // A little wider than the framed window, so the view carried onto the block
    // stays inside it: a view that came out a bin wider than its block would
    // be put back on a coarser one that covers it, on the very next frame.
    const rows = clip(pad(window.rows, SHARPEN_PAD), this.options.ceiling.rows)
    const cols = clip(pad(window.cols, SHARPEN_PAD), this.options.ceiling.cols)
    const grid = this.memoryGrid({ rows, cols })
    const held = this.bestFor({ rows, cols })
    if (held !== null && held.grid <= grid) {
      // A block in hand already that fine. The one on screen stays as it is, its
      // colours the ones the reader framed; another is handed over to be
      // measured, as the figure's own read would be.
      if (held.result === this.current || this.options.onBlock(held.result, { measure: true })) {
        this.current = held.result
        this.standing = { result: held.result, view: null }
        return Promise.resolve(true)
      }
      this.drop(held.result)
    }
    if (this.inflight !== null) {
      this.inflight.cancel()
      this.inflight = null
      this.options.onBusy?.(false)
    }
    this.pending = null
    onReading?.()
    const key = keyOf(rows, cols)
    const { promise, cancel } = this.options.read(rows, cols)
    this.inflight = { key, rows, cols, grid, cancel }
    this.options.onBusy?.(true)
    const run: Promise<boolean> = promise
      .then(
        (result) => {
          if (this.disposed || this.inflight?.key !== key) return false
          this.inflight = null
          this.options.onBusy?.(false)
          this.keep(result, rows, cols)
          if (this.options.onBlock(result, { measure: true })) {
            this.current = result
            this.standing = { result, view: null }
            return true
          }
          this.drop(result)
          return false
        },
        (err: unknown) => {
          if (this.disposed || this.inflight?.key !== key) return false
          this.inflight = null
          this.options.onBusy?.(false)
          if (!isAbort(err)) this.options.onError?.(err)
          return false
        },
      )
      .finally(() => {
        if (this.sharpening === run) this.sharpening = null
      })
    this.sharpening = run
    return run
  }

  /**
   * Whether the zoom is going inward: the view narrower than on a frame just
   * before it, now or within the last {@link INWARD_MS}. A wider one ends it at
   * once, and so does a narrower one after a pause — that is a jump, a
   * bookmark or a typed window, not a zoom that is still going.
   */
  private zoomingIn(view: RefineView): boolean {
    const span = Math.max(view.rows[1] - view.rows[0], view.cols[1] - view.cols[0])
    const now = this.options.now?.() ?? clock()
    if (span < this.lastSpan && now - this.lastAt < INWARD_MS) this.inwardAt = now
    else if (span !== this.lastSpan) this.inwardAt = Number.NEGATIVE_INFINITY
    this.lastSpan = span
    this.lastAt = now
    return now - this.inwardAt < INWARD_MS
  }

  /**
   * What to ask for: the window, padded, clipped to the ceiling.
   *
   * Padded outward when the picture is leaving what is held, because that is a
   * reader on their way somewhere; padded by half a screen otherwise, because
   * that is a reader looking around. Both are then clipped, so no request is
   * wider than the view was ever entitled to read.
   */
  private plan(view: RefineView): { rows: Extent; cols: Extent } {
    const block = this.held0()
    return {
      rows: this.axisPlan(view.rows, block?.rows ?? null, this.options.ceiling.rows),
      cols: this.axisPlan(view.cols, block?.cols ?? null, this.options.ceiling.cols),
    }
  }

  /**
   * What to ask for on **one axis**, from where the view sits inside its block.
   *
   * Three situations, and they want three different shapes of request. They are
   * told apart by *which* of the block's edges the view is up against, which is
   * the only thing the view can say once `clampView` has confined it:
   *
   * - **Neither edge** — the reader is looking around inside what they have, so
   *   this is a zoom, or a pan read ahead of its edge. Pad by half a window and
   *   let the grid fall where it may.
   * - **One edge** — they are *travelling*, and have run out of block in the
   *   direction they are going. Same span, recentred: panning changes place, not
   *   scale, and padding it the way a zoom does was what handed a reader back a
   *   4× coarser map for the crime of dragging left.
   * - **Both edges** — the block is entirely on screen and they are still
   *   pulling back, which is the only way an axis can be pressed at both ends at
   *   once. That is a zoom *out*, so buy more than one window at a stroke rather
   *   than stopping again on the next notch.
   */
  private axisPlan(view: Extent, block: Extent | null, bound: Extent): Extent {
    // A circle is not special here (SPECS §8.15). A window across its origin is
    // a *frame* the view hands over as the ceiling — the reads are resolved
    // modulo the sequence by the worker, and every one of them stays inside the
    // frame — so the ladder refines within it as within any other and never
    // reads past it. It used to slide: an axis with no ends, recentred round
    // the circle whenever the reader ran out of block, which read a new block
    // per stretch of drag and was the part of the circle a reader got lost in.
    if (block === null || !covers(block, view)) return clip(pad(view, WIDEN_REACH), bound)
    const low = view[0] <= block[0] && block[0] > bound[0]
    const high = view[1] >= block[1] && block[1] < bound[1]
    if (low && high) return clip(pad(view, WIDEN_REACH), bound)
    if (low || high) return clip(recentre(block, view), bound)
    return clip(pad(view, REFINE_PAD), bound)
  }

  /**
   * Whether the block on screen is good enough to leave alone.
   *
   * Two questions, and both have to be yes: does it *cover* what is being
   * looked at, and is its grid within a factor of {@link REFINE_FACTOR} of the
   * one this window could be read at — {@link READ_AHEAD_FACTOR} while a zoom
   * is still going inward. The factor is what stops a slow zoom from reading
   * continuously, and it is what makes the ladder terminate — once the block is
   * at the file's own bins, `wanted` can never be finer, so the answer is yes
   * forever.
   */
  private satisfied(view: RefineView, inward = false): boolean {
    const block = this.held0()
    return block !== null && this.fits(block, view, inward)
  }

  /**
   * {@link satisfied}, for any block in hand: whether it would be. Without
   * `ahead`, whether it is a whole picture of the view as it stands, with no
   * thought for where the reader is heading ({@link edgeWanted}).
   */
  private fits(
    block: Held,
    view: RefineView,
    inward: boolean,
    wanted = this.gridWanted(view),
    ahead = true,
  ): boolean {
    if (!covers(block.rows, view.rows) || !covers(block.cols, view.cols)) return false
    if (this.edgeWanted(view, block, ahead)) return false
    // At the floor the factor is one. It is there to stop a slow zoom reading
    // for every small step, and at the file's own bins there is no step after
    // this one: a view that can show them is shown them, rather than left a
    // factor of two short of the resolution the reader opened the file at.
    const factor = wanted <= this.floor() ? 1 : inward ? READ_AHEAD_FACTOR : REFINE_FACTOR
    return block.grid <= wanted * factor
  }

  /**
   * The plan for reading `window` while `view` is on screen: screen-sized where
   * the view says how big its screen is, and `undefined` — read as memory
   * allows — where it does not.
   */
  private planned(window: { rows: Extent; cols: Extent }, view: RefineView): ReadPlan | undefined {
    if (view.screen === undefined || !(view.screen > 0)) return undefined
    if (this.options.planFor !== undefined) return this.options.planFor(window, view)
    return screenPlan({
      rungs: [],
      binsize: 1,
      view: spanOf(view),
      read: spanOf(window),
      screen: view.screen,
      floor: this.floor(),
    })
  }

  /**
   * The grid a read of `window` would come back on, in bins of the open map.
   *
   * One place, so *what is good enough* and *what to ask for* cannot disagree:
   * without the floor here a declared 10 kb view would be permanently
   * unsatisfied — the ladder would compare a 5-bin block against a 1-bin target,
   * read, get 5 bins back because the floor bound the reader, and ask again on
   * the next frame forever.
   */
  private gridOf(window: { rows: Extent; cols: Extent }, view: RefineView): number {
    return this.planned(window, view)?.grid ?? this.memoryGrid(window)
  }

  /** The grid the view's own next read would come back on. */
  private gridWanted(view: RefineView): number {
    return this.gridOf(this.plan(view), view)
  }

  /** The grid the reader fits a window to as memory allows, the floor applied. */
  private memoryGrid(window: { rows: Extent; cols: Extent }): number {
    return Math.max(this.floor(), gridFor(window.rows, window.cols, this.options.budget?.()))
  }

  /** The declared grid, as a whole number of the open map's bins per cell. */
  private floor(): number {
    const asked = this.options.floor?.() ?? 1
    return Number.isFinite(asked) && asked >= 1 ? Math.floor(asked) : 1
  }

  /**
   * Whether where the view sits in its block is itself a reason to read.
   *
   * **Zoomed in**, it is when the view comes within {@link READ_AHEAD_EDGE} of a
   * view of an edge of its block that is not an edge of the world — the read
   * then starts before the reader arrives. `HeatmapView.clampView` treats the
   * block in hand as the whole world, which is right, and is what keeps a map
   * from being panned off into nothing; but it makes a block covering 0–52 kb
   * of a chromosome a wall at 52 kb. The view can never report a window past
   * it, so {@link covers} is always satisfied, and without this the reader
   * would be *stuck*: they zoomed into the start of a sequence, got a finer
   * grid for it, and thereby lost the ability to pan to the rest of it.
   *
   * **Fitted**, never: a view showing its whole block is pressed against every
   * edge of it because it shows all of it, and reading on that alone read nine
   * times the window the moment a region opened. **Zoomed out** past the block,
   * when any of its edges is not the world's, which is a reader pulling back.
   *
   * A view that does not say how it is zoomed is read as zoomed in, with no
   * reach: pressed against the edge, as before there was read-ahead. So is any
   * view when `ahead` is false, which asks what the view needs now rather than
   * where it is going.
   *
   * It terminates for the same reason the rest does: an edge that *is* the
   * ceiling's edge is not pressed, so a block spanning the whole domain never
   * asks for anything, and a block read around the view has the reader in its
   * middle rather than at its rim.
   */
  private edgeWanted(view: RefineView, block: Held, ahead = true): boolean {
    const { ceiling } = this.options
    // The view's fit is to the block on screen. Another block in hand covers
    // the view, and the view would be fitted to it by how much wider it is.
    const fit = view.fit === undefined || block.result === this.current ? view.fit : fitTo(view, block)
    if (fit !== undefined && fit <= 1 + FIT_SLACK) {
      if (fit >= 1 - FIT_SLACK) return false
      return near(view.rows, block.rows, ceiling.rows, 0) || near(view.cols, block.cols, ceiling.cols, 0)
    }
    const reach = (axis: Extent): number =>
      fit === undefined || !ahead ? 0 : READ_AHEAD_EDGE * (axis[1] - axis[0])
    return (
      near(view.rows, block.rows, ceiling.rows, reach(view.rows)) ||
      near(view.cols, block.cols, ceiling.cols, reach(view.cols))
    )
  }

  /** Issue the pending read. */
  private fire(view: RefineView): void {
    if (this.disposed) return
    const pending = this.pending
    if (pending === null) return
    this.pending = null
    if (this.inflight !== null || this.refused.has(pending.key)) return

    const plan = this.planned(pending, view)
    const grid = plan?.grid ?? this.memoryGrid(pending)
    const { promise, cancel } = this.options.read(pending.rows, pending.cols, plan)
    this.inflight = { key: pending.key, rows: pending.rows, cols: pending.cols, grid, cancel }
    this.options.onBusy?.(true)
    void promise
      .then((result) => {
        if (this.disposed || this.inflight?.key !== pending.key) return
        this.inflight = null
        this.options.onBusy?.(false)
        this.keep(result, pending.rows, pending.cols)
        if (this.options.onBlock(result)) this.current = result
        else {
          this.drop(result)
          this.refused.add(pending.key)
        }
      })
      .catch((err: unknown) => {
        if (this.disposed || this.inflight?.key !== pending.key) return
        this.inflight = null
        this.options.onBusy?.(false)
        // A cancellation is not a failure and leaves no mark: the window it was
        // for is gone, and the read that replaces it is already on its way.
        if (!isAbort(err)) {
          this.refused.add(pending.key)
          this.options.onError?.(err)
        }
      })
  }

  /** Forget a block the panel would not take. */
  private drop(result: MatrixResult): void {
    this.held = this.held.filter((held) => held.result !== result)
    if (this.current === result) this.current = null
  }

  private keep(result: MatrixResult, rows: Extent, cols: Extent): void {
    const bytes = result.values.byteLength
    // The grid in the ladder's own unit: how many bins **of the open map** one
    // drawn cell holds. For an ordinary read that is `binsPerCell`; for a rung
    // it is that times how much coarser the rung's bins are, which is what makes
    // "is this worth replacing" one comparison rather than two cases.
    const grid = Math.max(
      1,
      Math.round((Math.max(1, rows[1] - rows[0]) / Math.max(1, result.nrows))),
    )
    this.held = [
      { result, rows, cols, grid, bytes },
      ...this.held.filter((held) => held.result !== result),
    ]
    let total = this.held.reduce((sum, held) => sum + held.bytes, 0)
    while (this.held.length > 1 && (this.held.length > HELD_BLOCKS || total > HELD_BYTES)) {
      total -= this.held[this.held.length - 1].bytes
      this.held.pop()
    }
  }

  destroy(): void {
    this.disposed = true
    this.pending = null
    // The spinner belongs to the read, so it has to be given back with it. It
    // matters only when the panel outlives the ladder, because a panel torn
    // down in the same breath clears its own wait in `detach`; but that is
    // exactly the case a caller reaching for `destroy` rather than for the
    // view's own teardown is in.
    //
    // Conditional on there having *been* a read, so the number of
    // `onBusy(false)` calls matches the number of `onBusy(true)` calls and a
    // listener counting them is not driven negative.
    const wasReading = this.inflight !== null
    this.inflight?.cancel()
    this.inflight = null
    this.held = []
    this.current = null
    this.sharpening = null
    this.standing = null
    if (wasReading) this.options.onBusy?.(false)
    this.options.dispose?.()
  }
}

/**
 * Whether `at` is within `margin` of an edge of `held` that is not an edge of
 * `bound` — pressed against it, with no margin.
 */
function near(at: Extent, held: Extent, bound: Extent, margin: number): boolean {
  return (at[0] - held[0] <= margin && held[0] > bound[0]) || (held[1] - at[1] <= margin && held[1] < bound[1])
}

/**
 * How far `view` is zoomed into a block that covers it, as `RefineView.fit` says
 * of the block on screen: the zoom over the one that fits the block, which is
 * how many times the view goes into the block along the axis that fits.
 */
function fitTo(view: RefineView, block: { rows: Extent; cols: Extent }): number {
  return Math.max(
    (block.rows[1] - block.rows[0]) / Math.max(Number.EPSILON, view.rows[1] - view.rows[0]),
    (block.cols[1] - block.cols[0]) / Math.max(Number.EPSILON, view.cols[1] - view.cols[0]),
  )
}

/** Whether two views show the same window, to a millionth of it. */
function sameWindow(a: RefineView, b: RefineView): boolean {
  const close = (x: Extent, y: Extent): boolean => {
    const slack = 1e-6 * Math.max(1, x[1] - x[0])
    return Math.abs(x[0] - y[0]) <= slack && Math.abs(x[1] - y[1]) <= slack
  }
  return close(a.rows, b.rows) && close(a.cols, b.cols)
}

/** The wider of a window's two spans, in bins. */
function spanOf(window: { rows: Extent; cols: Extent }): number {
  return Math.max(window.rows[1] - window.rows[0], window.cols[1] - window.cols[0])
}

/** `performance.now` where there is one. */
function clock(): number {
  return typeof performance === 'undefined' ? Date.now() : performance.now()
}

/**
 * A **screen-sized** read of a window (§2): the stored rung, and the pooling
 * within it, that puts about one cell on each CSS pixel of the view.
 *
 * The grid is the view's span over the screen's width, so the block a read
 * brings back is about as fine as the picture can show and no finer — which is
 * what makes a read of a whole chromosome a few hundred milliseconds rather
 * than seconds, and a refine a step rather than a wait. It is the coarsest
 * stored rung whose bins are no bigger than that cell, because a rung is the
 * fewest stored pixels for the picture and its balanced values are balanced at
 * its own resolution ({@link chooseRung}), pooled within that rung to the cell.
 *
 * - **Never finer than the open rung**, nor than the grid the reader declared
 *   (`floor`, §3.4), which also takes the rung choice away, for the reason
 *   {@link attachRefine} gives: a declared grid is a whole number of the open
 *   map's bins, and a rung's bins do not divide it in general.
 * - **Never more than {@link SCREEN_READ_CAP} screens across**, whatever window
 *   it is for, so a read much wider than its view is coarsened rather than
 *   allowed to grow with it.
 *
 * `view` and `read` are the wider spans of the view and of the window to read,
 * in bins of the open map; `screen` is the plot's wider side in CSS pixels.
 */
export function screenPlan(options: {
  rungs: ReadonlyArray<{ name: string; binsize: number }>
  binsize: number
  view: number
  read: number
  screen: number
  floor?: number
}): ReadPlan {
  const floor = Math.max(1, Math.floor(options.floor ?? 1))
  const screen = Math.max(1, options.screen)
  // Two bounds on the cell, in bins of the open map: about a pixel of the
  // view, *rounded* to a whole number of the bins it is pooled from, so the
  // block has between three quarters of a cell and a cell and a half to each
  // pixel — floored, a rung just finer than the pixel came back with nearly
  // two, and every landing coloured twice the cells the screen could show; and
  // no smaller than the cap allows, rounded *up* so the cap holds.
  const sharp = Math.max(options.view / screen, floor)
  const capped = options.read / (SCREEN_READ_CAP * screen)
  const target = Math.max(sharp, capped)
  if (floor > 1) {
    const k = floor * Math.max(1, Math.round(sharp / floor), Math.ceil(capped / floor))
    return k > 1 ? { binsPerCell: k, grid: k } : { grid: 1 }
  }
  const binsize = options.binsize > 0 ? options.binsize : 1
  const most = target * binsize
  let best: { name: string; binsize: number } | null = null
  for (const rung of options.rungs) {
    if (rung.binsize < binsize || rung.binsize > most) continue
    if (best === null || rung.binsize > best.binsize) best = rung
  }
  const from = best?.binsize ?? binsize
  const pooled = Math.max(1, Math.round((sharp * binsize) / from), Math.ceil((capped * binsize) / from))
  // The cell those bins make, read from the coarsest rung that divides it: a
  // `zoomify` ladder doubles, so the cell two 160 kb bins make is the 320 kb
  // rung's own bin, stored, in a quarter of the pixels the 160 kb rung pools
  // it from.
  const cell = pooled * from
  let read = best ?? { name: '', binsize }
  for (const rung of options.rungs) {
    if (rung.binsize <= read.binsize || rung.binsize > cell || cell % rung.binsize !== 0) continue
    read = rung
  }
  const k = Math.round(cell / read.binsize)
  return {
    ...(read.binsize === binsize || read.name === '' ? {} : { rung: read.name }),
    ...(k > 1 ? { binsPerCell: k } : {}),
    grid: cell / binsize,
  }
}

/** `true` when `outer` contains `inner` — the coverage test, per axis. */
export function covers(outer: Extent, inner: Extent): boolean {
  return outer[0] <= inner[0] && outer[1] >= inner[1]
}

/** An extent widened by `fraction` of its own span on each side. */
export function pad(extent: Extent, fraction: number): Extent {
  const margin = (extent[1] - extent[0]) * fraction
  return [Math.floor(extent[0] - margin), Math.ceil(extent[1] + margin)]
}

/**
 * `held`'s own span, moved to sit around the middle of `at`.
 *
 * The travel read: **same width, new place**, and the width is the point. The
 * first version of this padded the way a zoom does, and it was wrong in a way
 * that only showed up in the app — a reader who had zoomed a chromosome down to
 * 100 bp, panned to the edge of what they had, and got their next block back at
 * 400 bp. Panning is not a change of scale, and any rule that makes it one takes
 * away the thing the reader just asked for. `fitPlan` fits a fixed cell count to
 * whatever it is given, so an identical span returns an identical grid.
 *
 * Written as a span rather than as a shift so that it does not matter how far
 * the reader has gone: a jump and a nudge produce the same shape of request,
 * centred where they now are. Near the ends of a sequence the caller's clip
 * makes it *shorter*, and they get a finer grid — which is the same rule as
 * everywhere else here, not a special case.
 */
export function recentre(held: Extent, at: Extent): Extent {
  const width = Math.max(1, held[1] - held[0])
  const middle = (at[0] + at[1]) / 2
  const lo = Math.round(middle - width / 2)
  return [lo, lo + width]
}

/** An extent held inside `bounds`. */
export function clip(extent: Extent, bounds: Extent): Extent {
  const lo = Math.max(bounds[0], Math.min(extent[0], bounds[1]))
  const hi = Math.min(bounds[1], Math.max(extent[1], lo))
  return [lo, hi]
}

/**
 * The grid `fitPlan` would choose for these extents.
 *
 * A restatement, and deliberately a loose one: the reader's own version walks
 * the contig extents so that a cell never straddles a sequence, which can only
 * make it *coarser* than this. Used to decide whether a read is worth making,
 * never to ask for one — the plan is the reader's to choose, and a client that
 * sent its own would anchor the grid to the pan position (`reader.worker.ts`).
 */
export function gridFor(rows: Extent, cols: Extent, budgetBytes?: number): number {
  return gridForSpan(Math.max(rows[1] - rows[0], cols[1] - cols[0]), POOLED_CELL_CAP, budgetBytes)
}

/**
 * {@link gridFor} for the widest axis alone: `1` up to what the reader reads
 * unpooled ({@link denseCellCap}), and the pooled read's grid past it.
 */
export function gridForSpan(widest: number, cap = POOLED_CELL_CAP, budgetBytes?: number): number {
  if (widest <= denseCellCap(budgetBytes)) return 1
  return Math.max(1, Math.ceil(widest / cap))
}

function keyOf(rows: Extent, cols: Extent): string {
  return `${rows[0]}:${rows[1]}|${cols[0]}:${cols[1]}`
}

function isAbort(err: unknown): boolean {
  return err instanceof Error && err.name === 'AbortError'
}

// ---------------------------------------------------------------------------
// The preference
// ---------------------------------------------------------------------------

/**
 * Its own key rather than an entry in `plotOptions.ts`.
 *
 * Those are preferences about *drawing* — what marks go over the picture — and
 * the renderer consumes them as a `PlotOptions`. This is a preference about
 * *reading*, and putting it in that record would put a read policy into a render
 * type and into the session config's list of overlays. Same storage, same shape,
 * different question.
 *
 * `localStorage` and not the hash, for the reason §5.5 gives: a link shares what
 * is being looked at, and whether the recipient likes their zoom to fetch is not
 * that. Two people following one link see the same data; one of them may see it
 * sharpen.
 */
const REFINE_KEY = 'chromosomix:refine'

/**
 * On.
 *
 * It was off, and for a reason that no longer holds: a zoom that read was a zoom
 * that *waited*. Each read was as large as memory allowed — a window of sixteen
 * thousand bins read a bin to a cell, a gigabyte of values for a picture seven
 * hundred pixels across — and the map held still, refusing every gesture, until
 * it came. Reads are now sized to the screen and the map never holds still (§2):
 * a block is a few hundred milliseconds of reading, the picture on screen keeps
 * every gesture meanwhile, and the next block is read ahead of the zoom. So the
 * map opens at the screen's resolution and sharpens as the reader zooms, down to
 * the file's own bins.
 *
 * Off is still one command away — the palette's *Refine on zoom*, a palette
 * command because it is one preference across a whole deck rather than a switch
 * on one map — and it is the old promise, kept: the window read once, as finely
 * as memory allows, and every pan and zoom after it free of reads.
 */
export const REFINE_DEFAULT = true

let refining: boolean | null = null
const refineListeners = new Set<(on: boolean) => void>()

/** Whether a zoom is allowed to ask for finer data. */
export function refineEnabled(): boolean {
  if (refining === null) {
    try {
      const raw = window.localStorage.getItem(REFINE_KEY)
      refining = raw === null ? REFINE_DEFAULT : raw === 'on'
    } catch {
      refining = REFINE_DEFAULT
    }
  }
  return refining
}

/** Set it, store it, and tell every mounted view. */
export function setRefineEnabled(on: boolean): void {
  refining = on
  try {
    window.localStorage.setItem(REFINE_KEY, on ? 'on' : 'off')
  } catch {
    /* a browser that refuses storage still honours the choice for this session */
  }
  for (const listener of refineListeners) listener(on)
}

export function toggleRefine(): boolean {
  const next = !refineEnabled()
  setRefineEnabled(next)
  return next
}

/** Subscribe to the preference; returns the unsubscribe function. */
export function subscribeRefine(listener: (on: boolean) => void): () => void {
  refineListeners.add(listener)
  return () => refineListeners.delete(listener)
}

// ---------------------------------------------------------------------------
// The ladder of a laddered file
// ---------------------------------------------------------------------------

/**
 * The rungs of a `zoomify` ladder, as bin sizes, finest first.
 *
 * The rule is §3.4's and it is the one the app already applies to decide whether
 * a collection is a ladder or a set of samples: *"all entry names parse as
 * positive integers → a `zoomify` resolution ladder"*. Anything else — a
 * replicate collection, a plain file with no siblings — comes back empty, and
 * the zoom then reads from the map that is open, which is what it does on every
 * `.metacool` and every `.cool` in existence. §3.4's other half is the reason
 * that is acceptable: the ladder *"is a pure optimisation: a plain `.metacool`
 * must behave identically, minus the extra zoom levels"*.
 */
export function rungsOf(entries: readonly string[]): Array<{ name: string; binsize: number }> {
  if (entries.length === 0) return []
  if (!entries.every((name) => /^\d+$/.test(name) && Number(name) > 0)) return []
  return entries
    .map((name) => ({ name, binsize: Number(name) }))
    .sort((a, b) => a.binsize - b.binsize)
}

/**
 * Which rung to read a window from, or `undefined` for the map that is open.
 *
 * **The coarsest rung whose bins are no bigger than a cell will be.** That is
 * the rung whose stored pixels are closest to one per drawn cell, so it is the
 * one that walks the fewest of them for the same picture — reading a whole
 * chromosome from a 10 kb level costs a tenth of what pooling it out of the
 * 1 kb level does, and produces the same map.
 *
 * It is also the answer to a correctness problem rather than only a speed one.
 * Summing balanced values is not balancing at a coarser resolution — the
 * reader says so at length (`worker/reader.worker.ts`), and names taking a
 * coarser rung as one of *"the real answers"*. A `zoomify --balance` level is
 * balanced from raw counts at its own resolution, so reading it is that answer.
 *
 * Never coarser than the picture can show, so nothing is lost: a rung above the
 * target would put more than one of its bins in a cell, which is the pooling
 * this is avoiding. And never the open map's own bin size, which is spelled as
 * `undefined` so an ordinary read carries no rung at all.
 *
 * **And never finer than the rung that is open.** The entry picker is a
 * statement about what the reader wants to look at (§16.2), not a starting
 * guess for something else to improve on: somebody who opened the 2 kb level of
 * a `100/200/500/1000/2000/5000` file has said *2 kb*, and a zoom that quietly
 * fetched the 100 bp level would be overruling them with their own file. So the
 * open rung is the **floor**, and a `.cool` — which has no ladder at all — is
 * the same rule with one rung in it.
 */
export function chooseRung(
  rungs: ReadonlyArray<{ name: string; binsize: number }>,
  spanBins: number,
  binsize: number,
  cap = POOLED_CELL_CAP,
  budgetBytes?: number,
): string | undefined {
  if (rungs.length === 0 || !(binsize > 0) || !(spanBins > 0)) return undefined
  // The floor, applied before anything is chosen rather than after: a rung
  // finer than the open one is not a candidate that loses, it is not a
  // candidate.
  const above = rungs.filter((rung) => rung.binsize >= binsize)
  if (above.length === 0) return undefined
  // The cell the open map would be read at, so a window narrow enough to be read
  // unpooled stays on the open rung rather than being swapped for a coarser one
  // the picture had room to avoid.
  const target =
    spanBins <= denseCellCap(budgetBytes) ? binsize : (spanBins * binsize) / Math.max(1, cap)
  let best: { name: string; binsize: number } | null = null
  for (const rung of above) {
    if (rung.binsize > target) continue
    if (best === null || rung.binsize > best.binsize) best = rung
  }
  // Nothing coarse enough means the window is small, and the finest thing this
  // zoom may use is the level that is open — which needs no rung named.
  best ??= above[0]
  return best.binsize === binsize ? undefined : best.name
}

/**
 * The rung a view's **first** read of a window can come from with nothing lost.
 *
 * A window wider than {@link POOLED_CELL_CAP} bins is pooled by the reader into
 * cells of {@link gridFor} bins each, so the picture of a whole chromosome at
 * 25 kb is a picture at 50 kb, summed out of every 25 kb pixel. A ladder that
 * stores the 50 kb rung already holds that picture, balanced at its own
 * resolution, in about a quarter of the pixels: on a 1 GB `.hic`, chr1's first
 * read took 1.6 s from the rung where it took 4.3 s from the open map, for the
 * same 3,925 cells.
 *
 * Only a rung whose bins divide that cell, so the grid on screen is the one the
 * reader would have drawn, and the ladder takes it as it is: the same cell
 * size is what {@link BlockLadder}'s *good enough* compares against, so no
 * refine follows until the reader zooms. `undefined` — read the open map —
 * where the window is not pooled at all, or no rung fits.
 */
export function poolingRung(
  rungs: ReadonlyArray<{ name: string; binsize: number }>,
  rows: Extent,
  cols: Extent,
  binsize: number,
): string | undefined {
  if (!(binsize > 0)) return undefined
  const cell = binsize * gridFor(rows, cols)
  let best: { name: string; binsize: number } | null = null
  for (const rung of rungs) {
    if (rung.binsize <= binsize || rung.binsize > cell || cell % rung.binsize !== 0) continue
    if (best === null || rung.binsize > best.binsize) best = rung
  }
  return best?.name
}

/**
 * The fewest cells a preview may have across its wider axis (§7.2).
 *
 * A stand-in has to be recognisably the picture that replaces it: at 256 cells
 * a whole chromosome on a laptop's map is three pixels a cell — soft, and every
 * compartment and the larger domains already in place.
 */
export const PREVIEW_MIN_CELLS = 256

/**
 * How many times finer than its preview the asked block must be, along its
 * wider axis, for the preview to be worth a read of its own.
 *
 * Below it the asked block is close enough to the preview's size that it reads
 * about as fast, and drawing two pictures of one window in a second would be a
 * flicker rather than a head start — which is what a reader who has already
 * chosen a coarse rung is owed: the picture they asked for, once.
 */
export const PREVIEW_FACTOR = 4

/**
 * The rung to draw a block from first, while the block itself is read — or
 * `undefined`, to draw only the block (§7.2).
 *
 * The **coarsest** stored rung that still gives {@link PREVIEW_MIN_CELLS}
 * across the window, so the stand-in is the cheapest read that is still a
 * picture; and only where the block the reader asked for is at least
 * {@link PREVIEW_FACTOR} times finer than it. "Finer" is measured against what
 * will actually be read: a block too large to read a bin to a cell is pooled
 * to the grid {@link gridFor} gives, and a preview has to beat that grid, not
 * the file's bins. A file with no coarser rung, a window already as coarse as
 * a preview would be, and a reader who chose a coarse rung all get none.
 */
export function previewRung(
  rungs: ReadonlyArray<{ name: string; binsize: number }>,
  rows: Extent,
  cols: Extent,
  binsize: number,
): string | undefined {
  if (!(binsize > 0)) return undefined
  const widest = Math.max(rows[1] - rows[0], cols[1] - cols[0])
  if (!(widest > 0)) return undefined
  const asked = Math.ceil(widest / gridFor(rows, cols))
  const spanBp = widest * binsize
  let best: { name: string; binsize: number } | null = null
  for (const rung of rungs) {
    if (!(rung.binsize > binsize)) continue
    const cells = spanBp / rung.binsize
    if (cells < PREVIEW_MIN_CELLS || asked < PREVIEW_FACTOR * cells) continue
    if (best === null || rung.binsize > best.binsize) best = rung
  }
  return best?.name
}

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

/**
 * What a ladder needs of a panel — structural, so this module never imports
 * `MatrixPanel` and the two cannot form a cycle.
 */
export interface RefinablePanel {
  setRefineListener(listener: ((view: RefineView) => void) | null): void
  regrid(data: MatrixResult, binsize: number, second?: MatrixResult, how?: BlockHandover): boolean
  /**
   * Say a read is outstanding for the window on screen — the spinner in the
   * plot's corner, over a view that still takes every gesture (§2).
   */
  setWaiting(on: boolean): void
  /**
   * What a figure waits for before it is drawn ({@link BlockLadder.sharpen}),
   * or `null` to take it back. Optional so a panel with no figure need not
   * implement it.
   */
  setFigurePrep?(prep: ((view: RefineView, onReading: () => void) => Promise<boolean>) | null): void
}

/**
 * Join a panel to a ladder: the window goes up, the block comes back down.
 *
 * Every view still makes its own first read and calls `setData` with it — the
 * ladder is deliberately not in the path that puts a picture on screen, so a
 * failure in any of this is a map that does not sharpen rather than a map that
 * is not there. What it adds is what happens *after*: the panel reports where it
 * is looking once a frame, and a better block arrives through `regrid` when one
 * is worth reading.
 *
 * The second file, where there is one, is carried beside the primary rather than
 * through the ladder, which knows about one block: both are read for the same
 * extents in one call, and the compare gate has already established that the two
 * files share a grid (§5.7). That is what lets a blended pair refine — the
 * alternative was refusing to refine whenever `uri2` is set, which is a strange
 * thing to tell somebody who opened two files precisely to look closely at them.
 */
export function attachRefine(options: {
  panel: RefinablePanel
  /** The view's own read, for arbitrary extents, with its own balance and score. */
  read(
    rows: Extent,
    cols: Extent,
    rung: string | undefined,
    binsPerCell: number | undefined,
  ): Cancellable<{ result: MatrixResult; second?: MatrixResult }>
  ceiling: { rows: Extent; cols: Extent }
  /** The file's own bin size; the effective one is this times `binsPerCell`. */
  binsize: number
  /**
   * Sibling rungs of a laddered file, from {@link rungsOf}.
   *
   * Absent or empty is every plain file, and the zoom then reads the open map at
   * whatever grid the reader plans for the window — which is the whole feature,
   * working, with no ladder anywhere. A ladder makes the coarse end of it
   * cheaper and its balanced values honest; it is never what makes it work.
   */
  rungs?: ReadonlyArray<{ name: string; binsize: number }>
  /**
   * The grid the reader has **declared**, in bins of the open map per cell.
   *
   * See {@link LadderOptions.floor}, which this is handed to. It also takes the
   * rung choice out of the ladder's hands: a declared 3 kb grid over a 1 kb map
   * is three of *these* bins, and a zoom that helpfully read the 2 kb rung
   * instead would be asking for one and a half of those — which is not a bin
   * anybody has. So while a floor is in force every read names no rung and
   * carries the floor as its `binsPerCell`; the base rung was already chosen
   * when the resolution was added, and it is the map that is open.
   */
  floor?: () => number
  /** The budget the view's reads carry; see {@link LadderOptions.budget}. */
  budget?: () => number | undefined
  onBusy?: (busy: boolean) => void
  onError?: (err: unknown) => void
  /**
   * A block went in — re-say whatever the view says about it.
   *
   * The line above a map names its size and its resolution, and both change
   * under a refine. Written once at load it becomes a caption for a picture that
   * is no longer there, which is worse than no caption: a reader checking what
   * they are looking at is exactly the reader who would believe it.
   */
  onInstalled?: (result: MatrixResult) => void
}): BlockLadder {
  const seconds = new WeakMap<MatrixResult, MatrixResult>()
  const ladder = new BlockLadder({
    ceiling: options.ceiling,
    ...(options.floor === undefined ? {} : { floor: options.floor }),
    ...(options.budget === undefined ? {} : { budget: options.budget }),
    read: (rows, cols, plan) => {
      // A screen-sized read says its own rung and grid (`screenPlan`, below). A
      // read with no plan is read as memory allows, as every read was before.
      const held = Math.max(1, Math.floor(options.floor?.() ?? 1))
      // A declared grid takes the rung choice with it, for the reason
      // {@link attachRefine}'s `floor` gives: the cell the reader was promised is
      // a whole number of the *open* map's bins, and a coarser rung's bins do
      // not divide it in general.
      const rung =
        plan !== undefined
          ? plan.rung
          : held > 1
            ? undefined
            : chooseRung(
                options.rungs ?? [],
                Math.max(rows[1] - rows[0], cols[1] - cols[0]),
                options.binsize,
                undefined,
                options.budget?.(),
              )
      const binsPerCell = plan !== undefined ? plan.binsPerCell : held > 1 ? held : undefined
      const { promise, cancel } = options.read(rows, cols, rung, binsPerCell)
      return {
        cancel,
        promise: promise.then(({ result, second }) => {
          if (second !== undefined) seconds.set(result, second)
          return result
        }),
      }
    },
    onBlock: (result, how) => {
      const placed = options.panel.regrid(
        result,
        // The bin size of the map that answered, which is the open one unless a
        // rung was read — `MatrixResult.binsize` is present only then, and a
        // caller that assumed otherwise would caption a 5 kb picture as 1 kb.
        Math.max(1, result.binsize ?? options.binsize) * Math.max(1, result.binsPerCell ?? 1),
        seconds.get(result),
        how,
      )
      if (placed) options.onInstalled?.(result)
      return placed
    },
    planFor: (window, view) =>
      screenPlan({
        rungs: options.rungs ?? [],
        binsize: options.binsize,
        view: Math.max(view.rows[1] - view.rows[0], view.cols[1] - view.cols[0]),
        read: Math.max(window.rows[1] - window.rows[0], window.cols[1] - window.cols[0]),
        screen: view.screen ?? 1,
        floor: options.floor?.() ?? 1,
      }),
    // The spinner, and the caller's own hook after it. Wired here rather than
    // left to each view because it is not a view's decision: a read is in
    // flight for the window on screen, and the picture says so — without
    // holding the view, which goes on taking every gesture (§2).
    onBusy: (busy) => {
      options.panel.setWaiting(busy)
      options.onBusy?.(busy)
    },
    ...(options.onError === undefined ? {} : { onError: options.onError }),
    dispose: () => {
      stopRefine()
      options.panel.setFigurePrep?.(null)
    },
  })
  options.panel.setRefineListener((view) => {
    if (refineEnabled()) ladder.consider(view)
  })
  // A figure is drawn from the block it sharpens to: the framed window at the
  // grid the reader chose, as memory allows (§19.2).
  options.panel.setFigurePrep?.((view, onReading) => ladder.sharpen(view, onReading))
  // Turning *Refine on zoom* off is asking to read once and zoom freely: the
  // view's whole domain, read as memory allows, as every view was read before
  // reads were sized to the screen (§2).
  const stopRefine = subscribeRefine((on) => {
    if (!on) void ladder.sharpen(options.ceiling)
  })
  return ladder
}
