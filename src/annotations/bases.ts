/**
 * The residues a view is drawing, kept between frames.
 *
 * {@link SampleCache}'s sibling, and it exists for exactly the same reason: §2
 * says a pan performs no read, so what is fetched has to be wider than the view
 * and has to be re-used until the view leaves it. What it does *not* need is the
 * other half of that machinery — a resolution ladder. Bases have one resolution.
 * A window is either drawn base by base or it is not drawn as bases at all, and
 * the second case is the GC line, which goes through `SampleCache` like every
 * other value track.
 *
 * That is the whole difference between the two, and it is why this is thirty
 * lines rather than a parameter on the other one.
 */

import type { LocusAxis } from '../render/locus'
import type { BaseRegion } from './types'
import type { AnnotationClient } from './worker/client'

/**
 * How much wider than the view the residues are fetched.
 *
 * A whole view on each side rather than the half `SampleCache` uses. Letters are
 * only ever drawn a few thousand at a time — three screens of them is a few
 * kilobytes — and at this zoom a reader pans by dragging across the window
 * repeatedly, which is precisely the gesture a narrow margin makes stutter.
 */
const FETCH_PAD = 1

interface Held {
  covered: Map<string, [number, number]>
  regions: BaseRegion[]
}

export class BaseCache {
  private readonly held = new Map<string, Held>()
  /** The window on its way per key, with how far its read has got. */
  private readonly inflight = new Map<string, { done: number; total: number } | null>()
  private disposed = false

  constructor(
    private readonly client: AnnotationClient,
    /** Ask for a repaint; the caller coalesces it into its own frame. */
    private readonly onChange: () => void,
  ) {}

  destroy(): void {
    this.disposed = true
    this.held.clear()
  }

  /** Drop what belongs to entries that are no longer loaded. */
  prune(live: ReadonlySet<string>): void {
    if (this.held.size === 0) return
    for (const key of [...this.held.keys()]) {
      if (!live.has(key.slice(0, key.lastIndexOf(':')))) this.held.delete(key)
    }
  }

  /**
   * The residues to draw, and a fetch if the ones in hand do not reach.
   *
   * Returns whatever is held and never waits, exactly as the samples do: a lane
   * drawing slightly stale letters for one frame is invisible, and a lane that
   * blanks while it waits is a flicker on every drag.
   */
  basesFor(options: {
    entry: string
    scope: string
    axis: LocusAxis
    domain: readonly [number, number]
  }): BaseRegion[] | null {
    const key = `${options.entry}:${options.scope}`
    const cached = this.held.get(key) ?? null
    const view = options.axis.windows(options.domain)
    if (view.length === 0) return cached?.regions ?? null
    if (cached !== null && covers(cached.covered, view)) return cached.regions
    if (this.inflight.has(key)) return cached?.regions ?? null

    const wanted = options.axis.windows(options.domain, FETCH_PAD)
    this.inflight.set(key, null)
    void this.client
      .request<'bases'>(
        {
          kind: 'bases',
          entry: options.entry,
          regions: wanted.map((window) => ({
            contig: window.contig,
            start: window.start,
            end: window.end,
          })),
        },
        (done, total) => {
          if (this.disposed || !this.inflight.has(key)) return
          this.inflight.set(key, { done, total })
          this.onChange()
        },
      )
      .then((result) => {
        if (this.disposed) return
        const covered = new Map<string, [number, number]>()
        // What was *asked for*, not what came back — and deliberately, though it
        // is the weaker-looking of the two. A reply carries nothing for a contig
        // the file has never heard of, so believing the reply would leave this
        // window permanently uncovered and refetch it on every frame for as long
        // as the reader looked at it. The other failure this trades against is a
        // reply truncated by the worker's cap, which would then be drawn short
        // and silently: that cap is four hundred thousand residues and a request
        // from here is a few thousand, since letters are only ever asked for at
        // a zoom where one fills a pixel.
        for (const window of wanted) covered.set(window.contig, [window.start, window.end])
        this.held.set(key, { covered, regions: result.regions })
        this.onChange()
      })
      .catch(() => {
        // The card already reports a load failure; the lane keeps what it had
        // and the next view change tries again.
      })
      .finally(() => this.inflight.delete(key))

    return cached?.regions ?? null
  }

  /**
   * The read in flight for this entry and scope, or `null`: the letters' half
   * of `SampleCache.pendingOf`, for the same bar under the same name.
   */
  pendingOf(entry: string, scope: string): { done: number; total: number } | null {
    const key = `${entry}:${scope}`
    if (!this.inflight.has(key)) return null
    return this.inflight.get(key) ?? { done: 0, total: 0 }
  }
}

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
