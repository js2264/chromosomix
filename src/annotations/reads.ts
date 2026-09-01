/**
 * The reads a view is drawing, kept between frames.
 *
 * {@link BaseCache}'s sibling and {@link SampleCache}'s cousin, and it exists
 * for the reason both do: §2 says a pan performs no read, so what is fetched
 * has to be wider than the view and re-used until the view leaves it.
 *
 * What it needs that neither of the others does is a **row budget**. A pile is
 * thinned to what the lane can draw (`bam/reads.ts`), so the answer depends on
 * the lane's height as well as on the window — and a reader dragging a lane
 * taller is asking for more reads, not for the same reads redrawn. So the
 * budget is part of the key, and it is quantised: a lane resized by a pixel
 * must not refetch, and a resize is a continuous gesture that would otherwise
 * issue a request per frame.
 *
 * Requests go out **cancellable**. A window of alignments is tens of BGZF
 * blocks to inflate before the first record is decoded, and this worker has no
 * queue — so one that nobody is waiting for any more holds up every other
 * lane's `sample` behind it (§8.13).
 */

import type { LocusAxis } from '../render/locus'
import type { ReadWindow } from './types'
import type { AnnotationClient } from './worker/client'

/**
 * How much wider than the view the reads are fetched.
 *
 * A whole view on each side, as the residues are and for the same reason: at
 * this zoom a reader pans by dragging across the window repeatedly, and a
 * narrow margin makes exactly that gesture stutter. Wider is not free here —
 * unlike letters, reads are the largest thing the worker sends — so one view
 * is the compromise rather than the two the letters could afford.
 */
const FETCH_PAD = 1

/**
 * Row budgets are rounded to a multiple of this before they reach the worker.
 *
 * A resize is a continuous gesture. Without quantising, dragging a lane from
 * forty rows to sixty issues twenty fetches, each of which thins the pile
 * differently — so the reader watches the reads reshuffle while they drag.
 */
const ROW_STEP = 8

interface Held {
  covered: Map<string, [number, number]>
  rows: number
  window: ReadWindow
}

export class ReadCache {
  private readonly held = new Map<string, Held>()
  private readonly inflight = new Map<string, { cancel: () => void }>()
  private disposed = false

  constructor(
    private readonly client: AnnotationClient,
    /** Ask for a repaint; the caller coalesces it into its own frame. */
    private readonly onChange: () => void,
  ) {}

  destroy(): void {
    this.disposed = true
    for (const request of this.inflight.values()) request.cancel()
    this.inflight.clear()
    this.held.clear()
  }

  /** Drop what belongs to entries that are no longer loaded, and stop their reads. */
  prune(live: ReadonlySet<string>): void {
    for (const [key, request] of [...this.inflight]) {
      if (live.has(key.slice(0, key.lastIndexOf(':')))) continue
      request.cancel()
      this.inflight.delete(key)
    }
    if (this.held.size === 0) return
    for (const key of [...this.held.keys()]) {
      if (!live.has(key.slice(0, key.lastIndexOf(':')))) this.held.delete(key)
    }
  }

  /**
   * The reads to draw, and a fetch if the ones in hand do not reach.
   *
   * Returns whatever is held and never waits — the same contract the samples
   * and the residues keep, and for the same reason: a pile one frame stale is
   * invisible, a lane that blanks while it waits is a flicker on every drag.
   */
  readsFor(options: {
    entry: string
    scope: string
    axis: LocusAxis
    domain: readonly [number, number]
    /** Rows the lane can draw, which the worker thins against. */
    rows: number
    basesPerPixel: number
  }): ReadWindow | null {
    const rows = Math.max(ROW_STEP, Math.ceil(options.rows / ROW_STEP) * ROW_STEP)
    const key = `${options.entry}:${options.scope}`
    const cached = this.held.get(key) ?? null
    const view = options.axis.windows(options.domain)
    if (view.length === 0) return cached?.window ?? null
    // A budget that has only *shrunk* is answered from what is held: the pile
    // already has more rows than the lane can show, and the extra ones are
    // simply not drawn. Refetching would thin it harder for no visible gain.
    if (cached !== null && cached.rows >= rows && covers(cached.covered, view)) {
      return cached.window
    }
    if (this.inflight.has(key)) return cached?.window ?? null

    const wanted = options.axis.windows(options.domain, FETCH_PAD)
    const request = this.client.cancellable<'reads'>({
      kind: 'reads',
      entry: options.entry,
      regions: wanted.map((window) => ({
        contig: window.contig,
        start: window.start,
        end: window.end,
      })),
      maxRows: rows,
      basesPerPixel: options.basesPerPixel,
    })
    this.inflight.set(key, request)
    void request.promise
      .then((window) => {
        if (this.disposed) return
        const covered = new Map<string, [number, number]>()
        // What was asked for rather than what came back, for the reason
        // `BaseCache` gives at its own copy of this: a reply carries nothing
        // for a contig the file has never heard of, and believing the reply
        // would leave that window permanently uncovered and refetch it on
        // every frame for as long as a reader looked at it.
        for (const at of wanted) covered.set(at.contig, [at.start, at.end])
        this.held.set(key, { covered, rows, window })
        this.onChange()
      })
      .catch(() => {
        // A failure is not an error screen and a cancellation is not a failure:
        // the lane keeps what it had, the card reports a load failure if there
        // was one, and the next view change tries again.
      })
      .finally(() => this.inflight.delete(key))

    return cached?.window ?? null
  }

  /** What is held for one lane, without asking for more. */
  peek(entry: string, scope: string): ReadWindow | null {
    return this.held.get(`${entry}:${scope}`)?.window ?? null
  }
}

/** `true` when every visible window is inside what was fetched. */
function covers(
  covered: Map<string, [number, number]>,
  windows: Array<{ contig: string; start: number; end: number }>,
): boolean {
  for (const window of windows) {
    const span = covered.get(window.contig)
    if (span === undefined || span[0] > window.start || span[1] < window.end) return false
  }
  return true
}
