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
 * **The reader already chooses the grid.** `fitPlan` (`worker/reader.worker.ts`)
 * binary-searches the finest grid whose cell count fits {@link POOLED_CELL_CAP}
 * for whatever bin range a request names, and `snapToGrid` anchors that grid to
 * the *sequence* rather than to the request. So a refine is the same `matrix`
 * request with narrower extents, and two blocks of the same region at the same
 * grid agree cell for cell wherever they overlap. Nothing is composited and
 * there is no seam. Which is also why this module must never send
 * `binsPerCell`: a request carrying an explicit plan bypasses `snapToGrid`, and
 * the cell values would then change as the reader panned.
 *
 * **It terminates.** There is no grid below the file's own bins, so the ladder
 * has a floor and reaches it: `⌈log₂(k₀)⌉` steps, where `k₀` is what the widest
 * view was pooled by. One step for a whole yeast genome at 1 kb, three for a
 * human chromosome at 5 kb, none at all for a MAG — whose block already *is* the
 * finest data in the file, which is why the app's primary case is untouched by
 * any of this.
 *
 * Zooming **out** is served the same way and is usually free: the blocks already
 * read are kept, so leaving the window a fine block covers falls back to a
 * coarser one that is still in hand. Only going wider than anything held costs a
 * read, and it is bounded by the ceiling — the view's own domain — so a zoom can
 * never turn into the whole-file scan §7.3 gates.
 */

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
 * buying four times what the frame needs turns the several reads the rest of the
 * gesture would have asked for into one. It is the same trade `syncTurnDepth`
 * makes when it re-cuts a band twice as deep as the box wants
 * (`ui/MatrixPanel.ts`), and it costs nothing in resolution, because a wider
 * view was going to be coarser anyway.
 */
export const WIDEN_REACH = 4

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
 * Milliseconds of stillness before a refine is issued.
 *
 * There is no gesture-end hook anywhere in the pan/zoom path — the only timers
 * in the panel are the double-tap deferrals — so settling is measured rather
 * than signalled: the window is watched, and a read goes out once it has stopped
 * moving. Long enough that a wheel gesture is one read rather than twenty, short
 * enough that it feels like part of the zoom rather than an afterthought.
 */
export const SETTLE_MS = 120

/** Blocks kept so that zooming back out costs nothing. */
export const HELD_BLOCKS = 3

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
   */
  read(rows: Extent, cols: Extent): Cancellable<MatrixResult>
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
  /** Told when a read is outstanding, for whatever the view shows meanwhile. */
  onBusy?(busy: boolean): void
  /** Told when a read fails, so the view can say so once rather than per frame. */
  onError?(err: unknown): void
  /** Overridable for tests; `Date.now` otherwise. */
  now?(): number
  /** Overridable for tests; `setTimeout` otherwise. */
  defer?(run: () => void, ms: number): () => void
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

export class BlockLadder {
  private readonly options: LadderOptions
  private held: Held[] = []
  private current: MatrixResult | null = null
  private inflight: { key: string; rows: Extent; cols: Extent; cancel(): void } | null = null
  private cancelTimer: (() => void) | null = null
  private pending: { rows: Extent; cols: Extent; key: string } | null = null
  private movedAt = 0
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
    this.keep(result, rows ?? result.rowExtent, cols ?? result.colExtent)
  }

  /** The finest block held that covers `view`, or `null`. */
  private bestFor(view: RefineView): Held | null {
    let best: Held | null = null
    for (const held of this.held) {
      if (!covers(held.rows, view.rows) || !covers(held.cols, view.cols)) continue
      if (best === null || held.grid < best.grid) best = held
    }
    return best
  }

  /** What the ladder is holding for the block it last handed over. */
  private held0(): Held | null {
    return this.held.find((entry) => entry.result === this.current) ?? null
  }

  /**
   * Consider the window on screen: hand over a better block if one is already
   * held, and start a read if none is good enough.
   *
   * Called once per frame from the panel's own rAF, so it must be cheap when
   * nothing has moved — which is every frame of a pan inside what was fetched.
   * It never waits and never takes the picture away: the worst it does is leave
   * the coarse block up for another 120 ms.
   */
  consider(view: RefineView): void {
    if (this.disposed) return
    const wanted = this.plan(view)
    const key = keyOf(wanted.rows, wanted.cols)

    // Something already in hand may be a better answer than what is drawn —
    // which is the whole of what makes zooming back out free.
    const best = this.bestFor(view)
    if (best !== null && best.result !== this.current) {
      if (this.options.onBlock(best.result)) this.current = best.result
      else this.drop(best.result)
    }

    if (this.satisfied(view)) {
      this.disarm()
      return
    }
    if (this.refused.has(key)) return

    // A read already going for this window, or for one that still contains what
    // is on screen, is the read this frame wants. One that no longer contains it
    // is finishing a picture of somewhere else, and is called off.
    const flight = this.inflight
    if (flight !== null) {
      if (covers(flight.rows, view.rows) && covers(flight.cols, view.cols)) return
      flight.cancel()
      this.inflight = null
      this.options.onBusy?.(false)
    }

    if (this.pending === null || this.pending.key !== key) {
      this.pending = { ...wanted, key }
      this.movedAt = this.clock()
    }
    this.arm()
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
    const inside = block !== null && covers(block.rows, view.rows) && covers(block.cols, view.cols)
    const reach = inside ? REFINE_PAD : WIDEN_REACH
    return {
      rows: clip(pad(view.rows, reach), this.options.ceiling.rows),
      cols: clip(pad(view.cols, reach), this.options.ceiling.cols),
    }
  }

  /**
   * Whether the block on screen is good enough to leave alone.
   *
   * Two questions, and both have to be yes: does it *cover* what is being
   * looked at, and is its grid within a factor of {@link REFINE_FACTOR} of the
   * one this window could be read at. The second is what stops a slow zoom from
   * reading continuously, and it is what makes the ladder terminate — once the
   * block is at the file's own bins, `wanted` can never be finer, so the answer
   * is yes forever.
   */
  private satisfied(view: RefineView): boolean {
    const block = this.held0()
    if (block === null) return false
    if (!covers(block.rows, view.rows) || !covers(block.cols, view.cols)) return false
    const wanted = this.plan(view)
    return block.grid <= gridFor(wanted.rows, wanted.cols) * REFINE_FACTOR
  }

  private clock(): number {
    return (this.options.now ?? Date.now)()
  }

  private arm(): void {
    if (this.cancelTimer !== null) return
    const defer = this.options.defer ?? defaultDefer
    this.cancelTimer = defer(() => {
      this.cancelTimer = null
      this.fire()
    }, SETTLE_MS)
  }

  private disarm(): void {
    this.cancelTimer?.()
    this.cancelTimer = null
    this.pending = null
  }

  /**
   * Issue the pending read, unless the window is still moving.
   *
   * A trailing edge rather than a leading one: the read that matters is the one
   * for where the reader stopped, not for the first frame of the gesture that
   * got them there.
   */
  private fire(): void {
    if (this.disposed) return
    const pending = this.pending
    if (pending === null) return
    if (this.clock() - this.movedAt < SETTLE_MS) {
      this.arm()
      return
    }
    this.pending = null
    if (this.inflight !== null || this.refused.has(pending.key)) return

    const { promise, cancel } = this.options.read(pending.rows, pending.cols)
    this.inflight = { key: pending.key, rows: pending.rows, cols: pending.cols, cancel }
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
    this.disarm()
    this.inflight?.cancel()
    this.inflight = null
    this.held = []
    this.current = null
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
export function gridFor(rows: Extent, cols: Extent): number {
  const widest = Math.max(rows[1] - rows[0], cols[1] - cols[0])
  return Math.max(1, Math.ceil(widest / POOLED_CELL_CAP))
}

function keyOf(rows: Extent, cols: Extent): string {
  return `${rows[0]}:${rows[1]}|${cols[0]}:${cols[1]}`
}

function isAbort(err: unknown): boolean {
  return err instanceof Error && err.name === 'AbortError'
}

function defaultDefer(run: () => void, ms: number): () => void {
  const handle = setTimeout(run, ms)
  return () => {
    clearTimeout(handle)
  }
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
const REFINE_KEY = 'metacooler-viewer:refine'

/**
 * On.
 *
 * The alternative — off, with a toggle — ships a feature nobody finds, and the
 * honest note under a pooled map would go on telling readers to open a smaller
 * block while the app could have done it for them. Off is still one click away,
 * and it restores today's behaviour exactly: a block read once, and a zoom that
 * magnifies it.
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
 */
export function chooseRung(
  rungs: ReadonlyArray<{ name: string; binsize: number }>,
  spanBins: number,
  binsize: number,
  cap = POOLED_CELL_CAP,
): string | undefined {
  if (rungs.length === 0 || !(binsize > 0) || !(spanBins > 0)) return undefined
  const target = (spanBins * binsize) / Math.max(1, cap)
  let best: { name: string; binsize: number } | null = null
  for (const rung of rungs) {
    if (rung.binsize > target) continue
    if (best === null || rung.binsize > best.binsize) best = rung
  }
  // Nothing coarse enough means the window is small: the finest level is the
  // right one, and if that is the open map there is no rung to name.
  best ??= rungs[0]
  return best.binsize === binsize ? undefined : best.name
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
  /** `false` disables refinement without tearing the wiring down. */
  enabled?: () => boolean
  onBusy?: (busy: boolean) => void
  onError?: (err: unknown) => void
}): BlockLadder {
  const seconds = new WeakMap<MatrixResult, MatrixResult>()
  const ladder = new BlockLadder({
    ceiling: options.ceiling,
    read: (rows, cols) => {
      const rung = chooseRung(
        options.rungs ?? [],
        Math.max(rows[1] - rows[0], cols[1] - cols[0]),
        options.binsize,
      )
      const { promise, cancel } = options.read(rows, cols, rung)
      return {
        cancel,
        promise: promise.then(({ result, second }) => {
          if (second !== undefined) seconds.set(result, second)
          return result
        }),
      }
    },
    onBlock: (result) =>
      options.panel.regrid(
        result,
        // The bin size of the map that answered, which is the open one unless a
        // rung was read — `MatrixResult.binsize` is present only then, and a
        // caller that assumed otherwise would caption a 5 kb picture as 1 kb.
        Math.max(1, result.binsize ?? options.binsize) * Math.max(1, result.binsPerCell ?? 1),
        seconds.get(result),
      ),
    ...(options.onBusy === undefined ? {} : { onBusy: options.onBusy }),
    ...(options.onError === undefined ? {} : { onError: options.onError }),
  })
  const enabled = options.enabled ?? refineEnabled
  options.panel.setRefineListener((view) => {
    if (enabled()) ladder.consider(view)
  })
  return ladder
}
