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
 * to each CSS pixel of the view, from the stored rung nearest that.
 * Every read used to be as large as memory allowed — the reader's own plan,
 * `fitPlan`, fills the device's budget, a window of sixteen thousand bins read a
 * bin to a cell — which made each refine a gigabyte of values and seconds of
 * reading for a picture seven hundred pixels across, and the map held still for
 * all of it. A screen-sized read is a few hundred milliseconds, so the map never
 * holds still: a gesture goes on over the block in hand, the next block is read
 * a little ahead of it, and lands on wherever the gesture has got to (SPECS §2).
 * A read with no screen, and every read of a resolution the reader picked
 * (§3.4) or of the open map with *Refine on zoom* off, is planned as memory
 * allows ({@link memoryPlan}): the pick wherever a block at it holds the
 * window, from the finest stored rung no finer than it where that does not.
 * Both plans are made here and sent whole, so what the ladder expects of a read
 * is what the read is asked for, never a guess at what the reader would choose.
 *
 * This module used to say it must **never** send `binsPerCell`, because a request
 * carrying an explicit plan bypassed `snapToGrid` and the cell values would then
 * change as the reader panned. The reader snaps an explicit plan too now, which
 * is what lets the screen plan exist, and {@link LadderOptions.floor}: a reader
 * who has asked for a resolution the file does not store (§3.4) has committed to
 * a grid, and the refine has to hold it rather than quietly reading past it on
 * the next zoom.
 *
 * **It terminates.** There is no grid below the finest rung the file stores, so
 * the ladder has a floor and reaches it: a step each time the zoom crosses a
 * rung, and the last one onto that rung's bins, which a view that can show them
 * is always given.
 *
 * Zooming **out** is served the same way and is usually free: the blocks already
 * read are kept, so leaving the window a fine block covers falls back to a
 * coarser one that is still in hand. Only going wider than anything held costs a
 * read, and it is bounded by the ceiling — the view's own domain — so a zoom can
 * never turn into the whole-file scan §7.3 gates.
 */

import { coarsenTo, type Rung } from '../metacooler/coarsen'
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
 * to read. It is judged where the zoom pauses ({@link ZOOM_PAUSE_MS}): a read
 * started between two notches of a spin is one the next ones outrun.
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
 * then a step back out that reads nothing. {@link HELD_BYTES} bounds the memory
 * whatever their number.
 */
export const HELD_BLOCKS = 8

/**
 * Bytes of held blocks above which the oldest are dropped.
 *
 * The same order as the compare path already holds (`MatrixPanel.derive` keeps
 * up to five block-sized arrays for a split-diagonal map with a derivation on).
 * A screen-sized block is a few megabytes, so it is a block read as memory
 * allows — up to 8,192 cells a side, 268 MB of values — that this bounds, and
 * one of those is kept however large.
 */
export const HELD_BYTES = 160 << 20

/** The window on screen, in absolute bins of the open map. */
export interface RefineView {
  rows: Extent
  cols: Extent
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
 *
 * Always sent whole ({@link readPlan}): the grid is what the ladder expects the
 * read to come back on, and asking for it rather than leaving the reader to
 * choose is what keeps the two the same. The reader may still coarsen a pooled
 * read past it where a sequence's cells would not fit its accumulator, which
 * can only make the block coarser than expected — and a block coarser than
 * expected is one the ladder keeps rather than one it reads again for.
 */
export interface ReadPlan {
  rung?: string
  binsPerCell?: number
  grid: number
}

/** What a ladder needs of the world. */
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
   * `plan` is {@link LadderOptions.plan}'s answer for the window, sent whole.
   */
  read(rows: Extent, cols: Extent, plan: ReadPlan): Cancellable<MatrixResult>
  /**
   * How a read of `window` is asked for while `view` is on screen: screen-sized
   * while the zoom picks the resolution, as memory allows at the pick otherwise
   * ({@link readPlan}, which knows the file's rungs and the pick). Its `grid` is
   * what the ladder takes the read to come back on.
   */
  plan(window: { rows: Extent; cols: Extent }, view: RefineView): ReadPlan
  /** The clock read-ahead times a zoom by; `performance.now` when absent. */
  now?(): number
  /**
   * Run `then` in `ms`, for a read held until the zoom pauses
   * ({@link ZOOM_PAUSE_MS}), and return what calls it off; `setTimeout` when
   * absent. Injected beside {@link now} so a test can say when the pause came.
   */
  after?(ms: number, then: () => void): () => void
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
   */
  onBlock(result: MatrixResult): boolean
  /**
   * The finest grid this ladder may refine **to**, in bins of the open map.
   *
   * While the zoom picks, the finest rung the file stores: a fraction of one
   * where that is finer than the rung that is open, so a zoom does not stop at
   * whichever resolution the file happened to be opened at (§2). Otherwise the
   * resolution picked (§3.4), as a number of the open map's bins per drawn cell
   * — a 10 kb rung over a 2 kb map is `5`: a block finer than it is not the
   * picture, and without it the ladder would read finer on the next zoom under
   * an axis *labelled* 10 kb — a caption that lies.
   *
   * A function rather than a number because it changes under a mounted ladder:
   * the reader ticks the preference or steps from 10 kb to 3 kb without the view
   * being rebuilt.
   *
   * Absent, or 1, is the open map's own bins.
   */
  floor?(): number
  /**
   * How many bins of the open map one cell of `result` holds: its pooling,
   * times how much coarser — or finer — the rung it was read from is. Absent,
   * it is worked out from the block's extent and size, which is exact for a
   * whole number of bins and for a whole fraction of one.
   */
  gridOf?(result: MatrixResult): number
  /**
   * Whether reads are sized to the **screen** (*Refine on zoom*, §2) rather
   * than read as memory allows at the {@link floor}: absent is on. Off, a read
   * is the picked resolution over as much of the window as fits, coarser only
   * where the window does not (§3.4).
   */
  screenSized?(): boolean
  /**
   * The window on screen now, or `null` where there is none to speak of — for
   * a block {@link BlockLadder.adopt}ed after the reader has already moved.
   */
  view?(): RefineView | null
  /**
   * As memory allows: the most bins of the open map a read may span around the
   * view — one block's width at the {@link floor}'s grid, so the pick is read
   * as soon as the view itself fits rather than once twice the view does.
   * Absent, a read is the padded window, however wide.
   */
  reach?(): number
  /**
   * Told when a read is outstanding, for whatever the view shows meanwhile —
   * the spinner in the map's top right corner, over a view that still takes
   * every gesture (`MatrixPanel.setWaiting`).
   */
  onBusy?(busy: boolean): void
  /** Told when a read fails, so the view can say so once rather than per frame. */
  onError?(err: unknown): void
  /**
   * Told the grid this ladder is reading at — the read in flight, else the block
   * it draws — whenever that changes, in bins of the open map; `null` before it
   * holds anything.
   *
   * What a deck's other maps follow (§16.2): the resolution the zoom has chosen
   * for the window **from the moment it chooses it**, so their reads go out
   * beside this one rather than after it has landed.
   */
  onTarget?(grid: number | null): void
  /**
   * Told when a read {@link BlockLadder.whole} made for the whole domain has
   * gone in, and the reader has not moved since: fit the view to it.
   */
  onWhole?(): void
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
 * How long a zoom going inward must stop shrinking before the ladder starts a
 * read for it.
 *
 * A read is synchronous in the worker, and a cancel lands only between its
 * windows (`DENSE_WINDOW`), so a read the zoom outruns is not free: its first
 * window walks the rung's chunk index from cold. A wheel spun from the whole of
 * K562 chr5 to 20 Mb fired the 100 kb rung's read a fifth of a second into the
 * gesture and called it off half a second later, and the 25 kb read the zoom
 * ended on queued behind its first window: thirteen requests, three seconds
 * from S3. The notches of one spin come tens of milliseconds apart and a
 * trackpad's frames sixteen, so this is a gap no gesture has inside it and
 * every reader who stops to look does. The block on screen covers the view
 * throughout — a zoom inward only ever shows less of it — so nothing goes
 * missing while it waits; it is only coarser for longer.
 */
export const ZOOM_PAUSE_MS = 150

/**
 * How far from `1` a view's {@link RefineView.fit} may be and still be fitted:
 * the zoom is a float, and a fit recomputed after a resize lands a hair off it.
 */
const FIT_SLACK = 0.02

export class BlockLadder {
  private readonly options: LadderOptions
  private held: Held[] = []
  private current: MatrixResult | null = null
  private inflight: {
    key: string
    rows: Extent
    cols: Extent
    grid: number
    cancel(): void
    /** A read of the whole domain, which the view is fitted to when it lands ({@link whole}). */
    whole?: boolean
  } | null = null
  private pending: { rows: Extent; cols: Extent; key: string; whole?: boolean } | null = null
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
  /** The view on the last frame, to consider again when the preference changes. */
  private lastView: RefineView | null = null
  /** The view's span on the last frame, for whether a zoom is going inward. */
  private lastSpan = 0
  /** When the last frame was considered. */
  private lastAt = Number.NEGATIVE_INFINITY
  /** When the view last shrank between two frames of one gesture; see {@link INWARD_MS}. */
  private inwardAt = Number.NEGATIVE_INFINITY
  /** Calls off the wait for a zoom's pause ({@link ZOOM_PAUSE_MS}), while one is set. */
  private paused: (() => void) | null = null
  /** The grid last told to {@link LadderOptions.onTarget}. */
  private reported: number | null = null
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
    this.report()
    // And the window on screen now, rather than at the reader's next gesture:
    // a ladder is armed only once the view knows its sequence's extent, a
    // round trip that can come after a reader has already zoomed — and nothing
    // asks again until the map moves.
    const view = this.options.view?.() ?? null
    if (view !== null) this.consider(view)
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
    if (this.disposed) return
    this.lastView = view
    const inward = this.zoomingIn(view)
    const wanted = this.windowFor(view)
    const key = keyOf(wanted.rows, wanted.cols)

    // Something already in hand may be a better answer than what is drawn —
    // which is the whole of what makes zooming back out free.
    const best = this.handOver(view, inward)
    if (best !== null && best.result !== this.current) {
      if (this.options.onBlock(best.result)) this.current = best.result
      else this.drop(best.result)
      this.report()
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
      // The whole domain, read for a view that has been put back and has not
      // moved since, is what that view is waiting for ({@link whole}).
      if (flight.whole === true && (view.fit === undefined || Math.abs(view.fit - 1) <= FIT_SLACK)) return
      flight.cancel()
      this.inflight = null
      this.options.onBusy?.(false)
      this.report()
    }

    this.pending = { ...wanted, key }
    // **Read when the zoom pauses** (§2). The block on screen covers the view,
    // so the reader loses nothing but sharpness while a spin goes on — and the
    // read it would have started is one the next notches outrun.
    const since = (this.options.now?.() ?? clock()) - this.inwardAt
    const shown = this.held0()
    const covered = shown !== null && covers(shown.rows, view.rows) && covers(shown.cols, view.cols)
    if (inward && since < ZOOM_PAUSE_MS && covered) {
      this.holdFor(ZOOM_PAUSE_MS - since)
      return
    }
    this.fire(view)
  }

  /**
   * Put the view's **whole domain** in hand, for a view about to be fitted —
   * what a double click asks for (SPECS §7.2).
   *
   * A fitted view fits the block on screen, and once a zoom has read its own
   * blocks that is the window last read around the view: 160 kb of a 1.5 Mb
   * chromosome, at the 100 bp the zoom had got to. Fitting it was a zoom out to
   * that stretch and no further, and a fitted view asks for nothing wider
   * ({@link edgeWanted}) — so the double click that means "the whole thing"
   * stopped a tenth of the way there, at the finest grid, on whatever part of
   * the sequence the reader had panned to.
   *
   * The finest block in hand that spans the domain goes on screen now, for the
   * caller to fit — the view's first read always did, so this is usually free.
   * Where none is held any longer, the domain is read, the block on screen
   * stays up meanwhile, and {@link LadderOptions.onWhole} is told when it lands
   * so the view is fitted to it — unless the reader has moved since, when the
   * block lands where they are, as any other does.
   */
  whole(): void {
    if (this.disposed) return
    const { ceiling } = this.options
    const spans = (held: Held): boolean => covers(held.rows, ceiling.rows) && covers(held.cols, ceiling.cols)
    const shown = this.held0()
    if (shown !== null && spans(shown)) return
    let best: Held | null = null
    for (const held of this.held) {
      if (spans(held) && (best === null || held.grid < best.grid)) best = held
    }
    if (best !== null) {
      if (this.options.onBlock(best.result)) {
        this.current = best.result
        this.report()
        return
      }
      this.drop(best.result)
    }
    const key = keyOf(ceiling.rows, ceiling.cols)
    if (this.refused.has(key)) return
    if (this.inflight?.whole === true) return
    if (this.inflight !== null) {
      this.inflight.cancel()
      this.inflight = null
      this.options.onBusy?.(false)
    }
    this.paused?.()
    this.paused = null
    const screen = this.options.view?.()?.screen
    const view: RefineView = {
      rows: ceiling.rows,
      cols: ceiling.cols,
      fit: 1,
      ...(screen === undefined ? {} : { screen }),
    }
    this.pending = { rows: ceiling.rows, cols: ceiling.cols, key, whole: true }
    this.fire(view)
  }

  /** Whether the view on screen is fitted to the block it shows, as a view just put back is. */
  private fitted(): boolean {
    const fit = this.options.view?.()?.fit
    return fit === undefined || Math.abs(fit - 1) <= FIT_SLACK
  }

  /** Consider the last view again once the zoom has paused, in `ms`. */
  private holdFor(ms: number): void {
    this.paused?.()
    const then = (): void => {
      this.paused = null
      this.reconsider()
    }
    const wait = Math.max(1, Math.ceil(ms))
    if (this.options.after !== undefined) {
      this.paused = this.options.after(wait, then)
      return
    }
    const timer = setTimeout(then, wait)
    this.paused = () => clearTimeout(timer)
  }

  /** {@link consider} the last window seen again — the rules changed under it. */
  reconsider(): void {
    if (this.lastView !== null) this.consider(this.lastView)
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
  private windowFor(view: RefineView): { rows: Extent; cols: Extent } {
    const block = this.held0()
    const window = {
      rows: this.axisPlan(view.rows, block?.rows ?? null, this.options.ceiling.rows),
      cols: this.axisPlan(view.cols, block?.cols ?? null, this.options.ceiling.cols),
    }
    const most = this.options.screenSized?.() === false ? this.options.reach?.() : undefined
    if (most === undefined || !(most > 0)) return window
    // **As memory allows, at the picked resolution** (§3.4): no wider than one
    // block at that grid can be, around the view, so the picked resolution is
    // what is read as soon as the view itself fits — rather than once twice
    // the view does, which is what padding it by half a view each side asked.
    return { rows: around(window.rows, view.rows, most), cols: around(window.cols, view.cols, most) }
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
    // Where the zoom does not pick — a pick in the link, or *Refine on zoom*
    // off — the picked resolution is the picture (§3.4): a block finer than it
    // is not one, however good it looks.
    if (this.options.screenSized?.() === false && block.grid < this.floor() * (1 - 1e-6)) return false
    // At the floor the factor is one. It is there to stop a slow zoom reading
    // for every small step, and at the file's own bins there is no step after
    // this one: a view that can show them is shown them, rather than left a
    // factor of two short of the resolution the reader opened the file at.
    const factor = wanted <= this.floor() ? 1 : inward ? READ_AHEAD_FACTOR : REFINE_FACTOR
    return block.grid <= wanted * factor
  }

  /**
   * The grid a read of `window` would come back on, in bins of the open map:
   * the plan's own, so *what is good enough* and *what to ask for* cannot
   * disagree — the read is asked for exactly that plan ({@link fire}).
   */
  private gridOf(window: { rows: Extent; cols: Extent }, view: RefineView): number {
    return this.options.plan(window, view).grid
  }

  /** The grid the view's own next read would come back on. */
  private gridWanted(view: RefineView): number {
    return this.gridOf(this.windowFor(view), view)
  }

  /** The finest grid a read may come back on, in bins of the open map ({@link LadderOptions.floor}). */
  private floor(): number {
    const asked = this.options.floor?.() ?? 1
    return Number.isFinite(asked) && asked > 0 ? asked : 1
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
    // **Nothing to read ahead for where a read would bring nothing new.** A
    // block read around the view puts the reader in its middle — unless the
    // read was clipped to the widest block allowed (the cap, as memory allows),
    // when the view sits nearer its rims than the read-ahead margin, and every
    // landing would ask for the same block again, for ever.
    if (ahead) {
      const next = this.windowFor(view)
      if (covers(block.rows, next.rows) && covers(block.cols, next.cols)) return false
    }
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

    const plan = this.options.plan(pending, view)
    const { promise, cancel } = this.options.read(pending.rows, pending.cols, plan)
    const whole = pending.whole === true
    this.inflight = {
      key: pending.key,
      rows: pending.rows,
      cols: pending.cols,
      grid: plan.grid,
      cancel,
      ...(whole ? { whole } : {}),
    }
    this.options.onBusy?.(true)
    this.report()
    void promise
      .then((result) => {
        if (this.disposed || this.inflight?.key !== pending.key) return
        this.inflight = null
        this.options.onBusy?.(false)
        this.keep(result, pending.rows, pending.cols)
        // Asked before the block goes in, which carries the window across and
        // so changes how the view is zoomed against its block.
        const refit = whole && this.fitted()
        if (this.options.onBlock(result)) {
          this.current = result
          if (refit) this.options.onWhole?.()
        } else {
          this.drop(result)
          this.refused.add(pending.key)
        }
        this.report()
      })
      .catch((err: unknown) => {
        if (this.disposed || this.inflight?.key !== pending.key) return
        this.inflight = null
        this.options.onBusy?.(false)
        this.report()
        // A cancellation is not a failure and leaves no mark: the window it was
        // for is gone, and the read that replaces it is already on its way.
        if (!isAbort(err)) {
          this.refused.add(pending.key)
          this.options.onError?.(err)
        }
      })
  }

  /**
   * Tell {@link LadderOptions.onTarget} the grid this ladder is reading at now,
   * where that has changed: the read in flight, else the block on screen.
   */
  private report(): void {
    const grid = this.inflight?.grid ?? this.held0()?.grid ?? null
    if (grid === this.reported) return
    this.reported = grid
    this.options.onTarget?.(grid)
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
    // it is that times how much coarser — or finer — the rung's bins are, which
    // is what makes "is this worth replacing" one comparison rather than cases.
    const grid = this.options.gridOf?.(result) ?? gridOfSpan(rows[1] - rows[0], result.nrows)
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
    this.paused?.()
    this.paused = null
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

/**
 * `window` cut to at most `most` bins, around the middle of `view` and inside
 * `window` — unless `view` is itself wider than that, when no block at that
 * grid can show it and the window is read pooled, as it was asked.
 */
function around(window: Extent, view: Extent, most: number): Extent {
  if (window[1] - window[0] <= most || view[1] - view[0] > most) return window
  const span = Math.floor(most)
  const middle = (view[0] + view[1]) / 2
  const lo = Math.max(window[0], Math.min(Math.floor(middle - span / 2), window[1] - span))
  return [lo, lo + span]
}

/**
 * How many bins of the open map one of `cells` cells holds over `span` bins: a
 * whole number for a pooled block or one read from a coarser rung, a whole
 * fraction of one for a block read from a finer rung.
 */
function gridOfSpan(span: number, cells: number): number {
  const ratio = Math.max(1, span) / Math.max(1, cells)
  return ratio >= 1 ? Math.max(1, Math.round(ratio)) : 1 / Math.max(1, Math.round(1 / ratio))
}

/** `performance.now` where there is one. */
function clock(): number {
  return typeof performance === 'undefined' ? Date.now() : performance.now()
}

/**
 * A **screen-sized** read of a window (§2): the stored rung that puts about one
 * cell on each CSS pixel of the view.
 *
 * The grid is the view's span over the screen's width, so the block a read
 * brings back is about as fine as the picture can show and no finer — which is
 * what makes a read of a whole chromosome a fraction of a second rather than
 * seconds, and a refine a step rather than a wait.
 *
 * - **A stored resolution, never one made up** where the file has a ladder: the
 *   rung **nearest** a pixel, on a log scale, so its cells are between about
 *   two thirds of a pixel and one and a half on a `zoomify` or 4DN ladder. It
 *   used to be the coarsest rung no bigger than a pixel, *pooled* within it to
 *   the pixel — chr6 of a 4DN `.mcool`, 250 kb a pixel, was its 100 kb rung
 *   summed two by two into 200 kb cells: every 100 kb pixel downloaded to draw
 *   a resolution the file does not have, 56 MB where the 250 kb rung's own is
 *   35, and balanced values that were sums of the finer rung's rather than
 *   balanced at their own resolution.
 * - **Pooled only where nothing stored will do**: a file with one resolution
 *   (and a map under a second file, whose ladder need not match — the caller
 *   passes none), and a read too wide for even the coarsest rung within
 *   {@link SCREEN_READ_CAP} screens. A pooled read is never more cells than the
 *   reader's accumulator holds ({@link POOLED_CELL_CAP}): on a plot wider than
 *   about 1,280 pixels the cap in screens was more, and the reader then pooled
 *   the block coarser than it had been asked for.
 * - **Down to the finest rung the file stores**, which `floor` names in bins
 *   of the open map — a fraction of one where the file stores a finer rung
 *   than the one that is open — so a zoom does not stop at whichever
 *   resolution the file happened to be opened at (§2).
 *
 * `view` and `read` are the wider spans of the view and of the window to read,
 * in bins of the open map; `screen` is the plot's wider side in CSS pixels.
 */
export function screenPlan(options: {
  rungs: ReadonlyArray<Rung>
  binsize: number
  view: number
  read: number
  screen: number
  floor?: number
}): ReadPlan {
  const asked = options.floor ?? 1
  const floor = Number.isFinite(asked) && asked > 0 ? Math.min(1, asked) : 1
  const screen = Math.max(1, options.screen)
  // Bounds on the cell, in bins of the open map: about a pixel of the view
  // (`sharp`), no smaller than the read cap allows (`capped`), and for a pooled
  // read no more cells than the reader's accumulator holds (`pooledCap`).
  const sharp = Math.max(options.view / screen, floor)
  const capped = options.read / (SCREEN_READ_CAP * screen)
  const pooledCap = options.read / Math.min(SCREEN_READ_CAP * screen, POOLED_CELL_CAP)
  const binsize = options.binsize > 0 ? options.binsize : 1
  // The rungs a read may come from: the open map's own, and every stored rung
  // no finer than the floor — in base pairs, so a rung finer than the open one
  // is a candidate like any other.
  const finest = floor * binsize * (1 - 1e-9)
  const candidates: Rung[] = []
  for (const rung of [{ name: '', binsize }, ...options.rungs]) {
    if (rung.binsize < finest || candidates.some((held) => held.binsize === rung.binsize)) continue
    candidates.push(rung)
  }
  candidates.sort((a, b) => a.binsize - b.binsize)
  const spelled = (rung: Rung): { rung?: string } =>
    rung.binsize === binsize || rung.name === '' ? {} : { rung: rung.name }

  if (candidates.length > 1) {
    // **A ladder: the stored rung nearest a pixel**, among those whose bins do
    // not make the read wider than the cap allows.
    const pixel = sharp * binsize
    const allowed = candidates.filter((rung) => rung.binsize >= capped * binsize * (1 - 1e-9))
    let best: Rung | null = null
    for (const rung of allowed) {
      if (best === null || Math.abs(Math.log(rung.binsize / pixel)) < Math.abs(Math.log(best.binsize / pixel))) {
        best = rung
      }
    }
    if (best !== null) return { ...spelled(best), grid: best.binsize / binsize }
    // Even the coarsest rung is too fine for a read this wide: it, pooled to
    // the cap — the one place a ladder is pooled.
    const coarsest = candidates[candidates.length - 1]
    const k = Math.max(1, Math.ceil((pooledCap * binsize) / coarsest.binsize))
    return { ...spelled(coarsest), ...(k > 1 ? { binsPerCell: k } : {}), grid: (k * coarsest.binsize) / binsize }
  }

  // **One resolution**: its bins pooled to the cell — *rounded* to a whole
  // number of them, so the block has between three quarters of a cell and a
  // cell and a half to each pixel (floored, a rung just finer than the pixel
  // came back with nearly two, and every landing coloured twice the cells the
  // screen could show) — and never fewer than the cap allows, rounded *up* so
  // the cap holds.
  const only = candidates[0] ?? { name: '', binsize }
  const k = Math.max(1, Math.round((sharp * binsize) / only.binsize), Math.ceil((pooledCap * binsize) / only.binsize))
  return { ...spelled(only), ...(k > 1 ? { binsPerCell: k } : {}), grid: (k * only.binsize) / binsize }
}

/**
 * The resolution the reader picked (§3.4): what a map draws wherever the window
 * allows, whatever *Refine on zoom* says — a pick in the link wins.
 */
export interface PickedResolution {
  /** The resolution, in base pairs. */
  binsize: number
  /** The stored rung it is read from: itself, or the rung one the reader added sums. */
  rung: Rung
  /** How many of that rung's bins one cell sums: 1, or the added resolution's factor. */
  factor: number
}

/**
 * How a window is read at a picked resolution **as memory allows** (§3.4).
 *
 * - **A stored rung**: itself where the window fits a block read bin for bin at
 *   it ({@link denseCellCap}, 8,192 a side), else the finest stored rung no finer
 *   than it that fits ({@link chooseRung}) — never a resolution the file does
 *   not store — and where even the coarsest does not, the coarsest summed to fit
 *   the reader's pooled cap. A file with no ladder sums its own bins the same
 *   way. So the picture is never blank and never finer than was picked.
 * - **One the reader added**: its stored rung's bins summed `factor` to a cell,
 *   and summed further by a whole number of those cells where the window is too
 *   wide for them, so a cell is always a whole number of the added bins.
 *
 * The plan is sent whole, so the grid it names is the one the read comes back
 * on: the ladder compares blocks with it rather than with a guess at what the
 * reader would have chosen for itself.
 *
 * `span` is the window's wider side in bins of the open map.
 */
export function memoryPlan(
  pick: PickedResolution,
  rungs: ReadonlyArray<Rung>,
  binsize: number,
  span: number,
  budget?: number,
): ReadPlan {
  const open = Math.max(1, binsize)
  const spelled = (rung: Rung): { rung?: string } => (rung.binsize === open ? {} : { rung: rung.name })
  const spanBp = Math.max(1, span) * open
  if (pick.factor > 1) {
    const bins = spanBp / Math.max(1, pick.rung.binsize)
    const k = pick.factor * Math.max(1, Math.ceil(Math.ceil(bins / POOLED_CELL_CAP) / pick.factor))
    return { ...spelled(pick.rung), binsPerCell: k, grid: (k * pick.rung.binsize) / open }
  }
  const ladder = rungs.some((rung) => rung.binsize === pick.rung.binsize) ? rungs : [pick.rung, ...rungs]
  const name = chooseRung(ladder, spanBp / Math.max(1, pick.binsize), pick.binsize, budget)
  const rung = name === undefined ? pick.rung : (ladder.find((each) => each.name === name) ?? pick.rung)
  const bins = spanBp / Math.max(1, rung.binsize)
  const k = bins <= denseCellCap(budget) ? 1 : Math.max(1, Math.ceil(bins / POOLED_CELL_CAP))
  return { ...spelled(rung), ...(k > 1 ? { binsPerCell: k } : {}), grid: (k * rung.binsize) / open }
}

/**
 * How a view reads a window — its first read and every read after (§2, §3.4).
 *
 * **Screen-sized** ({@link screenPlan}) while the zoom picks the resolution: the
 * preference ticked and nothing picked in the link, and a screen to size it to.
 * **As memory allows** ({@link memoryPlan}) otherwise: at the resolution picked,
 * or at the open map's where none is.
 *
 * One function for every view and for the ladder each arms, so the first read
 * and the refines after it cannot disagree about a window — they used to be
 * five copies, one per view, and the copies had drifted: one read the second
 * reading of a whole-genome map on a grid of its own (§5.10), and the ladders
 * asked a second file for rungs it need not have.
 *
 * `rungs` is the file's ladder, and empty beside a second file (§5.7), whose
 * ladder need not match: a map under one is read from the open rung, pooled.
 * `view` and `read` are the wider spans of the view and of the window, in bins
 * of the open map.
 */
export function readPlan(options: {
  rungs: ReadonlyArray<Rung>
  binsize: number
  view: number
  read: number
  /** The plot's wider side in CSS pixels; absent is a view with no screen to size to. */
  screen?: number
  /** The resolution picked, or `null`. */
  pick: PickedResolution | null
  /** *Refine on zoom*, as the reader left it. */
  refining: boolean
  budget?: number
}): ReadPlan {
  const { rungs, binsize, pick } = options
  if (pick === null && options.refining && options.screen !== undefined && options.screen > 0) {
    return screenPlan({
      rungs,
      binsize,
      view: options.view,
      read: options.read,
      screen: options.screen,
      floor: finestFloor(rungs, binsize),
    })
  }
  return memoryPlan(pick ?? openPick(binsize), rungs, binsize, options.read, options.budget)
}

/** A plan's rung and pooling as a request spells them, the identity left off. */
export function planFields(plan: ReadPlan): { rung?: string; binsPerCell?: number } {
  return {
    ...(plan.rung === undefined ? {} : { rung: plan.rung }),
    ...(plan.binsPerCell === undefined || plan.binsPerCell <= 1 ? {} : { binsPerCell: plan.binsPerCell }),
  }
}

/**
 * The open map as a pick (§3.4): what a map with *Refine on zoom* off and
 * nothing picked is read at, by the rule any pick is — so a window too wide for
 * it is drawn from a coarser stored rung ({@link chooseRung}) rather than summed
 * out of the open map's own bins into a grid the file does not store.
 */
export function openPick(binsize: number): PickedResolution {
  const open = Math.max(1, binsize)
  return { binsize: open, rung: { name: String(open), binsize: open }, factor: 1 }
}

/**
 * Another map's resolution as a pick on this file's ladder — how a deck's
 * companion is read at the first map's (§16.2).
 *
 * The stored rung of that bin size; else, where `pooled` — a resolution the
 * reader picked, which the first map itself sums where it must (§3.4) — the
 * coarsest stored rung that divides it, summed to it; else the stored rung
 * nearest it on a log scale, the coarser of two as near, which is the one case
 * where the two maps are not at one resolution and `exact` is `false` for the
 * panel to say so. Never pooled for the zoom's own choice, which is a stored
 * rung by the rule every screen-sized read keeps (§2). `null` for a ladder with
 * no rung at all.
 */
export function pickOnLadder(
  binsize: number,
  rungs: ReadonlyArray<Rung>,
  pooled: boolean,
): { pick: PickedResolution; exact: boolean } | null {
  if (!(binsize > 0) || rungs.length === 0) return null
  const stored = rungs.find((rung) => rung.binsize === binsize)
  if (stored !== undefined) return { pick: { binsize, rung: stored, factor: 1 }, exact: true }
  if (pooled) {
    const derived = coarsenTo(binsize, rungs)
    if (derived !== null) return { pick: { binsize, rung: derived.from, factor: derived.factor }, exact: true }
  }
  const distance = (rung: Rung): number => Math.abs(Math.log(rung.binsize / binsize))
  let nearest = rungs[0]
  for (const rung of rungs) {
    const d = distance(rung)
    const best = distance(nearest)
    if (d < best - 1e-12 || (Math.abs(d - best) <= 1e-12 && rung.binsize > nearest.binsize)) nearest = rung
  }
  return { pick: { binsize: nearest.binsize, rung: nearest, factor: 1 }, exact: false }
}

/**
 * The finest rung a file stores, in bins of its open map: where a zoom with
 * *Refine on zoom* on comes to rest (§2), whichever rung the file was opened at.
 * A fraction of one where a finer rung than the open one is stored; 1 for a
 * file with no ladder.
 */
export function finestFloor(rungs: ReadonlyArray<{ binsize: number }>, binsize: number): number {
  const open = Math.max(1, binsize)
  return Math.min(open, ...rungs.map((rung) => rung.binsize).filter((size) => size > 0)) / open
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
 * that. What a link does carry is a resolution picked (`resolution=`), and a
 * pick wins over this: a map whose link names one is drawn at it, and this
 * decides only what a map whose link names none is read at (§3.4).
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
 * Off is one tick away — the tick at the head of the resolution row, or the
 * palette's *Refine on zoom* — and it is the old promise, kept: the window read
 * once, as finely as memory allows, and every pan and zoom after it free of
 * reads.
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
 * Which rung to read a window from **as memory allows**, or `undefined` for the
 * map that is open (§2, §3.4).
 *
 * **The finest stored rung, no finer than `binsize`, whose bins over the window
 * fit a block read bin for bin** ({@link denseCellCap}, 8,192 a side): the
 * resolution asked for wherever the window fits it, and the stored one nearest
 * to it where it does not — never a resolution the file does not store. A
 * `zoomify --balance` level is balanced from raw counts at its own resolution,
 * where summing a finer level's balanced values is an estimate of it (the
 * reader says so at length, `worker/reader.worker.ts`, and names taking a
 * coarser rung as one of *"the real answers"*); and it walks a fraction of the
 * pixels. It used to aim at the cell a *pooled* read of the window would have,
 * the coarsest rung no bigger than it, and where the ladder had a gap there —
 * a `10 / 100 kb` file, a window of 130 Mb — it fell back on the open map, which
 * the reader then summed four by four into 40 kb cells nobody had stored.
 *
 * **Pooled only where no stored rung fits**: the coarsest is named, and the
 * reader sums it to fit — a window too wide for the whole ladder. A file with
 * no ladder names nothing, and is pooled as it always was.
 *
 * **And never finer than `binsize`.** That is the resolution picked, or the
 * open map's where none is (§3.4): somebody who picked the 2 kb level of a
 * `100/200/500/1000/2000/5000` file has said *2 kb*, and a read that quietly
 * fetched the 100 bp level would be overruling them with their own file. The
 * open map's own bin size is spelled `undefined`, so an ordinary read carries
 * no rung at all.
 */
export function chooseRung(
  rungs: ReadonlyArray<{ name: string; binsize: number }>,
  spanBins: number,
  binsize: number,
  budgetBytes?: number,
): string | undefined {
  if (rungs.length === 0 || !(binsize > 0) || !(spanBins > 0)) return undefined
  // The floor, applied before anything is chosen rather than after: a rung
  // finer than it is not a candidate that loses, it is not a candidate.
  const above = rungs.filter((rung) => rung.binsize >= binsize).sort((a, b) => a.binsize - b.binsize)
  if (above.length === 0) return undefined
  const dense = denseCellCap(budgetBytes)
  const spanBp = spanBins * binsize
  const best = above.find((rung) => spanBp / rung.binsize <= dense) ?? above[above.length - 1]
  return best.binsize === binsize ? undefined : best.name
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
 * will actually be read: `grid`, in bins of the open map, is the grid of the
 * block's own plan ({@link memoryPlan}) — a coarser stored rung, or the open
 * map pooled, where the window is too wide to read a bin to a cell — and a
 * preview has to beat that, not the file's bins. A file with no coarser rung, a
 * window already as coarse as a preview would be, and a reader who chose a
 * coarse rung all get none.
 */
export function previewRung(
  rungs: ReadonlyArray<{ name: string; binsize: number }>,
  rows: Extent,
  cols: Extent,
  binsize: number,
  grid = 1,
): string | undefined {
  if (!(binsize > 0)) return undefined
  const widest = Math.max(rows[1] - rows[0], cols[1] - cols[0])
  if (!(widest > 0)) return undefined
  const asked = Math.ceil(widest / Math.max(1e-9, grid))
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
  regrid(data: MatrixResult, binsize: number, second?: MatrixResult): boolean
  /**
   * Say a read is outstanding for the window on screen — the spinner in the
   * plot's corner, over a view that still takes every gesture (§2).
   */
  setWaiting(on: boolean): void
  /** The window on screen now ({@link LadderOptions.view}); optional. */
  refineWindowNow?(): RefineView | null
  /**
   * Who to ask for the whole domain before the view is fitted
   * ({@link BlockLadder.whole}); `null` lets go. Optional.
   */
  setWholeListener?(listener: (() => void) | null): void
  /** Fit the view to the block it holds, as a whole read lands; optional. */
  fitBlock?(): void
}

/**
 * Join a panel to a ladder: the window goes up, the block comes back down.
 *
 * Every view still makes its own first read and calls `setData` with it — the
 * ladder is deliberately not in the path that puts a picture on screen, so a
 * failure in any of this is a map that does not sharpen rather than a map that
 * is not there. What it adds is what happens *after*: the panel reports where it
 * is looking once a frame, and a better block arrives through `regrid` when one
 * is worth reading. Every read, the view's first and the ladder's, is planned
 * by {@link readPlan}, so the two cannot disagree about a window.
 *
 * The second file, where there is one, is carried beside the primary rather than
 * through the ladder, which knows about one block: both are read for the same
 * extents and the same plan in one call, and the compare gate has already
 * established that the two files share the open rung's grid (§5.7) — which is
 * why the ladder is handed no rungs beside one: another rung of the first file
 * need not be a rung of the second, and a reader asked for an entry its file
 * has not got answers from its open map, on a grid the pair cannot be drawn on.
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
   * whatever grid the plan names for the window — which is the whole feature,
   * working, with no ladder anywhere. A ladder makes the coarse end of it
   * cheaper and its balanced values honest; it is never what makes it work.
   */
  rungs?: ReadonlyArray<Rung>
  /**
   * A second file is read beside the first (§5.7): the ladder reads the open
   * rung only, pooled where it must, whatever {@link rungs} says.
   */
  second?: boolean
  /**
   * The resolution the reader picked, asked live (§3.4): a rung the file stores
   * or one the reader added, read in place when the pick changes rather than by
   * rebuilding the view. `null` is no pick: the screen's resolution while the
   * preference is ticked, the open map as memory allows while it is not.
   */
  picked?: () => PickedResolution | null
  /**
   * The memory budget the view's reads carry, where it is not the device's own.
   *
   * A block is read bin for bin up to what that budget affords
   * (`denseCellCap`), so a plan as memory allows has to be made from the same
   * number: a deck's panel reads with a share (§16.7).
   */
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
  /**
   * Told the bin size, in base pairs, this view's zoom is reading at — its read
   * in flight, else the block it draws — whenever that changes. What the other
   * maps of a deck are read at while the zoom picks (§16.2).
   */
  onTarget?: (binsize: number | null) => void
}): BlockLadder {
  const seconds = new WeakMap<MatrixResult, MatrixResult>()
  const rungs = options.second === true ? [] : (options.rungs ?? [])
  const open = Math.max(1, options.binsize)
  // **The finest rung the file stores**, in bins of the open map: where a zoom
  // with *Refine on zoom* on comes to rest, whichever rung the file was opened
  // at (§2). A fraction of one where a finer rung than the open one is stored.
  const finest = finestFloor(rungs, open)
  const pick = (): PickedResolution | null => options.picked?.() ?? null
  // The zoom picks while the preference is ticked and nothing is picked: a pick
  // in the link wins (§3.4).
  const refining = (): boolean => refineEnabled() && pick() === null
  const target = (): PickedResolution => pick() ?? openPick(open)
  const ladder = new BlockLadder({
    ceiling: options.ceiling,
    floor: () => (refining() ? finest : target().binsize / open),
    view: () => options.panel.refineWindowNow?.() ?? null,
    screenSized: refining,
    // A block's width at the pick: bin for bin up to the dense cap for a stored
    // rung, the pooled cap for one the reader added (§3.4).
    reach: () => {
      const at = target()
      return ((at.factor > 1 ? POOLED_CELL_CAP : denseCellCap(options.budget?.())) * at.binsize) / open
    },
    plan: (window, view) =>
      readPlan({
        rungs,
        binsize: open,
        view: Math.max(view.rows[1] - view.rows[0], view.cols[1] - view.cols[0]),
        read: Math.max(window.rows[1] - window.rows[0], window.cols[1] - window.cols[0]),
        ...(view.screen === undefined ? {} : { screen: view.screen }),
        pick: pick(),
        refining: refineEnabled(),
        ...(options.budget?.() === undefined ? {} : { budget: options.budget?.() }),
      }),
    gridOf: (result) =>
      (Math.max(1, result.binsize ?? open) * Math.max(1, result.binsPerCell ?? 1)) / open,
    read: (rows, cols, plan) => {
      const read = options.read(rows, cols, plan.rung, plan.binsPerCell)
      return {
        cancel: read.cancel,
        promise: read.promise.then(({ result, second }) => {
          if (second !== undefined) seconds.set(result, second)
          return result
        }),
      }
    },
    onBlock: (result) => {
      const placed = options.panel.regrid(
        result,
        // The bin size of the map that answered, which is the open one unless a
        // rung was read — `MatrixResult.binsize` is present only then, and a
        // caller that assumed otherwise would caption a 5 kb picture as 1 kb.
        Math.max(1, result.binsize ?? open) * Math.max(1, result.binsPerCell ?? 1),
        seconds.get(result),
      )
      if (placed) options.onInstalled?.(result)
      return placed
    },
    // The spinner, and the caller's own hook after it. Wired here rather than
    // left to each view because it is not a view's decision: a read is in
    // flight for the window on screen, and the picture says so — without
    // holding the view, which goes on taking every gesture (§2).
    onBusy: (busy) => {
      options.panel.setWaiting(busy)
      options.onBusy?.(busy)
    },
    ...(options.onError === undefined ? {} : { onError: options.onError }),
    // In base pairs, rounded: a grid is a fraction of one where a finer rung than
    // the open one is read, and its product with the open bin size is that rung's.
    ...(options.onTarget === undefined
      ? {}
      : { onTarget: (grid: number | null) => options.onTarget?.(grid === null ? null : Math.round(grid * open)) }),
    onWhole: () => options.panel.fitBlock?.(),
    dispose: () => {
      stopRefine()
      options.panel.setWholeListener?.(null)
    },
  })
  // Every frame, on or off: on, the screen's resolution down to the finest
  // rung; off, the picked resolution, coarser only where the window is too
  // wide for it — and its own resolution again as soon as it is not (§3.4).
  options.panel.setRefineListener((view) => ladder.consider(view))
  // A double click puts back the view's domain, not the block the zoom last
  // read around it (SPECS §7.2).
  options.panel.setWholeListener?.(() => ladder.whole())
  // The preference changes what the window on screen wants, so it is asked
  // again at once rather than at the reader's next gesture.
  const stopRefine = subscribeRefine(() => ladder.reconsider())
  return ladder
}
