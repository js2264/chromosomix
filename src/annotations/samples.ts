/**
 * The rule that keeps pan and zoom free of I/O, in one place.
 *
 * §2 says a pan performs no read, and §8.4 says the same of a track. That is not
 * achieved by fetching less; it is achieved by fetching a *window wider than the
 * view* at a resolution *rounded to a power of two*, and redrawing from what is
 * in hand until the view leaves either. A drag of up to half a screen and a zoom
 * inside one power of two therefore cost nothing at all.
 *
 * Two widgets need exactly that — the lanes beside a heatmap and the lanes of
 * the genome browser — and the arithmetic behind it is fiddly enough that two
 * copies would drift: the bucket, the padding, the "keep the old data on screen
 * until the new data lands" rule, and the reconciliation against a store that
 * may have dropped the track. So it lives here and both call it.
 */

import type { LocusAxis } from '../render/locus'
import { combineSamples, type TrackOp } from './derived'
import type { TrackSampleSet } from './types'
import type { AnnotationClient } from './worker/client'

/**
 * How much wider than the view a fetch reaches, as a fraction of the view.
 *
 * Half a window on each side, so a pan of up to half a screen is free. Wider
 * costs bytes nobody looks at; narrower and the first pixel of a drag misses.
 */
export const FETCH_PAD = 0.5

interface Held {
  /** The power-of-two bases-per-pixel these were fetched at. */
  bucket: number
  /** Genomic span held per contig. */
  covered: Map<string, [number, number]>
  samples: TrackSampleSet
}

export class SampleCache {
  private readonly held = new Map<string, Held>()
  private readonly inflight = new Set<string>()
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

  /**
   * Drop what belongs to tracks that are no longer loaded.
   *
   * Reconciled against the store rather than driven by a removal event, because
   * the cache is a *derived* thing and the store is the truth: doing it once per
   * frame cannot go stale, whereas an event that is not sent leaks a track's
   * worth of typed arrays for as long as the file is open.
   */
  prune(live: ReadonlySet<string>): void {
    if (this.held.size === 0) return
    for (const key of [...this.held.keys()]) {
      if (!live.has(key.slice(0, key.lastIndexOf(':')))) this.held.delete(key)
    }
  }

  /**
   * The samples to draw, and a fetch if the ones in hand will not do.
   *
   * Returns whatever is cached — possibly at the wrong resolution, possibly
   * nothing — and never waits. A lane showing slightly coarse data for one frame
   * is invisible; a lane that blanks while it waits is not.
   *
   * `scope` separates two views of one track, which is what the heatmap's two
   * edges are: the same bigWig drawn along rows and along columns is two windows
   * at two resolutions and cannot share one slot.
   */
  samplesFor(options: {
    entry: string
    scope: string
    axis: LocusAxis
    domain: readonly [number, number]
    /** Pixels the view spans, which is what the resolution is chosen against. */
    pixels: number
    /**
     * The two rows this one is computed from, where it is computed from any.
     *
     * Handed in rather than looked up, because this cache deliberately knows
     * nothing about the store: it is keyed on ids and windows and holds no
     * opinion about what a row *is*. The caller reads `derivedFrom` off the
     * entry it is about to draw and passes it through.
     */
    derived?: { a: string; b: string; op: TrackOp }
  }): TrackSampleSet | null {
    // A derived lane fetches nothing of its own. Both operands are asked for the
    // same window at the same resolution — through this same method, so they are
    // cached, padded and rounded exactly as any other lane's are — and combined
    // per frame. The combination is one pass over a few thousand intervals and
    // is deliberately not cached: it would need invalidating whenever either
    // operand moved, and the two of them already own that question.
    const derived = options.derived
    if (derived !== undefined) {
      const a = this.samplesFor({ ...options, entry: derived.a, derived: undefined })
      const b = this.samplesFor({ ...options, entry: derived.b, derived: undefined })
      return combineSamples(a, b, derived.op)
    }

    const key = `${options.entry}:${options.scope}`
    const cached = this.held.get(key) ?? null
    const view = options.axis.windows(options.domain)
    if (view.length === 0) return cached?.samples ?? null

    const pixels = Math.max(1, options.pixels)
    const bases = view.reduce((sum, window) => sum + (window.end - window.start), 0)
    // Rounded to a power of two so a slow zoom does not refetch every frame: the
    // file's zoom levels are powers of two apart anyway, so anything finer would
    // ask for the same level under a different name.
    const bucket = 2 ** Math.round(Math.log2(Math.max(1, bases / pixels)))

    if (cached !== null && cached.bucket === bucket && covers(cached.covered, view)) {
      return cached.samples
    }
    if (this.inflight.has(key)) return cached?.samples ?? null

    const wanted = options.axis.windows(options.domain, FETCH_PAD)
    this.inflight.add(key)
    void this.client
      .request<'sample'>({
        kind: 'sample',
        entry: options.entry,
        regions: wanted.map((window) => ({
          contig: window.contig,
          start: window.start,
          end: window.end,
        })),
        basesPerPixel: bucket,
      })
      .then((samples) => {
        if (this.disposed) return
        const covered = new Map<string, [number, number]>()
        for (const window of wanted) covered.set(window.contig, [window.start, window.end])
        this.held.set(key, { bucket, covered, samples })
        this.onChange()
      })
      .catch(() => {
        // A failed sample is not an error screen: the track keeps whatever it
        // had, the card already reports a load failure, and the next view change
        // tries again.
      })
      .finally(() => this.inflight.delete(key))

    return cached?.samples ?? null
  }

  /** What is cached for one track in one scope, without asking for more. */
  peek(entry: string, scope: string): TrackSampleSet | null {
    return this.held.get(`${entry}:${scope}`)?.samples ?? null
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
