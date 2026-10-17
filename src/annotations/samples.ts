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
import { readFilterKey, type ReadStyle, type TrackSampleSet } from './types'
import type { AnnotationClient } from './worker/client'

/**
 * How much wider than the view a fetch reaches, as a fraction of the view.
 *
 * Half a window on each side, so a pan of up to half a screen is free. Wider
 * costs bytes nobody looks at; narrower and the first pixel of a drag misses.
 */
export const FETCH_PAD = 0.5

/**
 * The narrowest lane the resolution is chosen for, in pixels.
 *
 * Two pictures of one window have to be drawn from one set of numbers, or their
 * value axes disagree and a reader holding a deck's cells against each other is
 * shown a difference that is in the layout rather than in the file. A lane
 * narrower than this asks for the level a lane this wide would ask for: at 1024
 * pixels a 400 kb window comes back in 512-base means, which is finer than a
 * 265-pixel cell can draw and is the same answer the lead gets.
 *
 * A thousand and not ten thousand, because the cost is real — a finer level is
 * more blocks decoded and, over HTTP, more bytes — and this is the width at
 * which every lane the application actually lays out beside a map or in a cell
 * is covered. Past it a lane asks for what it can draw, since there the detail
 * reaches the screen.
 */
const SAMPLE_PIXELS_FLOOR = 1024

/**
 * The filter a held window is marked with once its row's values are replaced
 * ({@link SampleCache.revise}): no request is ever made under it, so the next
 * frame refetches, and until the answer lands the old samples are still drawn.
 */
const STALE = '\u0000stale'

/** A request that is running, and what it was asked under. */
interface Running {
  /** The row it is for, so {@link SampleCache.revise} can find it. */
  entry: string
  cancel: () => void
  /** The filter *this request* carries — not the one already drawn. */
  filter: string
  /**
   * How far the worker's read has got, where it said. Absent until the first
   * report: a request answered from memory never reports, and a lane must
   * not draw a bar for a fetch that is over before the bar could be seen.
   */
  progress?: Progress
}

/** Bytes read so far and bytes expected; `total` is `0` where the host would not say. */
export interface Progress {
  done: number
  total: number
}

interface Held {
  /** The row these are values of, so {@link SampleCache.revise} can find them. */
  entry: string
  /** The power-of-two bases-per-pixel these were fetched at. */
  bucket: number
  /** Genomic span held per contig. */
  /**
   * What was fetched, by contig — a **list**, because one contig can be asked
   * for twice.
   *
   * A circular sequence panned across its own junction is two windows on one
   * name (SPECS §8.15): the tail of the sequence and its head. Keyed by contig
   * alone, the second overwrote the first, `covers` then answered `false` on
   * every frame, and the lane refetched continuously while the reader slid.
   */
  covered: Map<string, Array<[number, number]>>
  /**
   * The read controls these were counted under, for the one kind that has any.
   *
   * `''` for every other kind, which is not a special case so much as the
   * truthful answer: nothing about a bigWig's samples depends on a filter, so
   * every window of one agrees with every other.
   */
  filter: string
  samples: TrackSampleSet
}

export class SampleCache {
  private readonly held = new Map<string, Held>()
  /**
   * The requests in flight, and how to call each of them off.
   *
   * A `Set` of keys until an alignment lane existed, because every other read
   * here is over in milliseconds and the only thing the set was for was not
   * asking twice. A window of alignment records is tens of BGZF blocks to
   * inflate before the first record is decoded, and this worker has no queue —
   * so one that nobody is waiting for any more holds up every other lane's
   * `sample` behind it (§8.13).
   */
  private readonly inflight = new Map<string, Running>()
  /** The {@link AnnotationEntry.revision} each row was last seen at. */
  private readonly revisions = new Map<string, number>()
  private disposed = false

  constructor(
    private readonly client: AnnotationClient,
    /** Ask for a repaint; the caller coalesces it into its own frame. */
    private readonly onChange: () => void,
  ) {}

  destroy(): void {
    this.disposed = true
    // The tab is going, or the panel is. Whatever is still decoding is being
    // decoded for nobody.
    for (const request of this.inflight.values()) request.cancel()
    this.inflight.clear()
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
    // The in-flight map first, and *not* guarded by `held.size`: a track dropped
    // while its first read is still running has nothing held yet, which is
    // exactly the case where the read is worth calling off.
    for (const [key, request] of [...this.inflight]) {
      if (live.has(key.slice(0, key.lastIndexOf(':')))) continue
      request.cancel()
      this.inflight.delete(key)
    }
    for (const entry of [...this.revisions.keys()]) {
      if (!live.has(entry)) this.revisions.delete(entry)
    }
    if (this.held.size === 0) return
    for (const key of [...this.held.keys()]) {
      if (!live.has(key.slice(0, key.lastIndexOf(':')))) this.held.delete(key)
    }
  }

  /**
   * Let go of the values of a row that was given new ones under the same id.
   *
   * A computed track run again keeps its id ({@link AnnotationEntry.revision}),
   * so nothing here would otherwise notice: its window and resolution are the
   * same, and a lane would redraw the last run's numbers until a pan or a zoom
   * happened to refetch. Reconciled against the store once a frame, like
   * {@link prune}, and for the same reason — an event that is not sent leaves a
   * lane wrong, and a comparison made every frame cannot.
   *
   * What is in flight is called off, since it was asked of the old values; what
   * is held is marked stale rather than dropped, so the lane keeps drawing it
   * for the moment the new values take to arrive instead of blanking — the rule
   * a filter change already follows. A row seen for the first time has nothing
   * held to be stale.
   */
  revise(entries: Iterable<{ id: string; revision?: number }>): void {
    for (const { id, revision } of entries) {
      if (revision === undefined) continue
      const seen = this.revisions.get(id)
      if (seen === revision) continue
      this.revisions.set(id, revision)
      if (seen === undefined) continue
      for (const [key, request] of [...this.inflight]) {
        if (request.entry !== id) continue
        request.cancel()
        this.inflight.delete(key)
      }
      for (const [key, held] of this.held) {
        if (held.entry === id) this.held.set(key, { ...held, filter: STALE })
      }
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
    /**
     * An alignment lane's read controls (§8.13), where the lane is one.
     *
     * Only the counting half of them reaches the key — see {@link readFilterKey}
     * — but the whole style goes on the wire, so the worker builds its filter
     * from one place rather than from a projection this cache chose.
     */
    reads?: ReadStyle
    /**
     * Which reference sequences are open, for a lane whose answer depends on
     * them (§8.13).
     *
     * A token, not an address: this cache does not fetch residues and the
     * worker looks up its own. What it is for is *invalidation* — an alignment
     * lane's depth carries the share of each bin that disagrees with the
     * reference, and a FASTA dropped after the BAM changes that answer without
     * changing the entry, the window or the resolution. Without this the marks
     * would appear on the next pan and not before it, which reads as the file
     * not having worked.
     */
    reference?: string
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
    const filter =
      options.reads === undefined
        ? ''
        : `${readFilterKey(options.reads)}|${options.reference ?? ''}`
    const cached = this.held.get(key) ?? null
    const view = options.axis.windows(options.domain)
    if (view.length === 0) return cached?.samples ?? null

    // **A floor under the width, so two pictures of one window read the same
    // data.** The bucket used to come off the lane's own pixel count alone, and
    // a lane's pixel count is a fact about the layout rather than about the
    // genome: a tracks cell three across asked for one summary level and the
    // same track beside the lead map asked for a finer one, so the two lanes
    // were drawn from different numbers and autoscaled to different ceilings —
    // the same ATAC track over the same 400 kb reading `0 – 111` in one and
    // `0 – 36.9` in the other, which a reader comparing two cells of a deck can
    // only read as the data differing (§8.8, §16.2).
    //
    // Every lane narrower than {@link SAMPLE_PIXELS_FLOOR} therefore samples as
    // though it were that wide. It costs a narrow lane a finer level than it can
    // draw — at most three buckets, so a few thousand intervals rather than a
    // few hundred — and it buys the one thing a deck is for, which is two
    // pictures that can be held against each other. A wider lane still asks for
    // what it can draw, because there the detail is on screen.
    const pixels = Math.max(SAMPLE_PIXELS_FLOOR, options.pixels)
    const bases = view.reduce((sum, window) => sum + (window.end - window.start), 0)
    // Rounded to a power of two so a slow zoom does not refetch every frame: the
    // file's zoom levels are powers of two apart anyway, so anything finer would
    // ask for the same level under a different name.
    const bucket = 2 ** Math.round(Math.log2(Math.max(1, bases / pixels)))

    if (
      cached !== null &&
      cached.bucket === bucket &&
      cached.filter === filter &&
      covers(cached.covered, view)
    ) {
      return cached.samples
    }
    // A filter change mid-flight replaces the request rather than waiting
    // behind it: what is decoding counted the wrong records, so its answer will
    // be thrown away the moment it lands. Every other reason to be in flight
    // still waits — a pan's answer is right, only late.
    //
    // Against the *running request's* filter, never against the held samples'.
    // The held one records what last landed, so between a control change and
    // the first landing it is permanently the old filter, and a test written
    // that way cancels the request it just issued on every frame — of which a
    // pointer moving over the canvas schedules one each time.
    const running = this.inflight.get(key)
    if (running !== undefined) {
      if (running.filter === filter) return cached?.samples ?? null
      running.cancel()
      this.inflight.delete(key)
    }

    const wanted = options.axis.windows(options.domain, FETCH_PAD)
    const request = this.client.cancellable<'sample'>(
      {
        kind: 'sample',
        entry: options.entry,
        regions: wanted.map((window) => ({
          contig: window.contig,
          start: window.start,
          end: window.end,
        })),
        basesPerPixel: bucket,
        ...(options.reads === undefined ? {} : { reads: options.reads }),
      },
      (done, total) => {
        // On the slot that is running, and only while it is the one running:
        // a report from a request already replaced would move a bar that is
        // about another read.
        if (this.disposed || this.inflight.get(key) !== slot) return
        slot.progress = { done, total }
        this.onChange()
      },
    )
    const slot: Running = { entry: options.entry, cancel: request.cancel, filter }
    this.inflight.set(key, slot)
    void request.promise
      .then((samples) => {
        // Superseded while in flight: a cancel rejects, but a reply already on
        // the wire when the cancel was sent resolves anyway, and storing it
        // would file the old filter's numbers under the new key.
        if (this.disposed || this.inflight.get(key) !== slot) return
        const covered = new Map<string, Array<[number, number]>>()
        for (const window of wanted) {
          const held = covered.get(window.contig)
          if (held === undefined) covered.set(window.contig, [[window.start, window.end]])
          else held.push([window.start, window.end])
        }
        this.held.set(key, { entry: options.entry, bucket, covered, filter, samples })
        this.onChange()
      })
      .catch(() => {
        // A failed sample is not an error screen: the track keeps whatever it
        // had, the card already reports a load failure, and the next view change
        // tries again. A *cancelled* one lands here too and wants exactly the
        // same nothing — it was called off because the answer stopped mattering.
      })
      .finally(() => {
        // Only if this promise still owns the slot — two requests share a key
        // for as long as it takes a cancelled one to reject, and deleting
        // unconditionally would remove the replacement's entry.
        if (this.inflight.get(key) !== slot) return
        this.inflight.delete(key)
        // A read that ended without an answer asked for no frame of its own,
        // and the lane is no longer waiting on it; one more frame lets whoever
        // counts the lane's waits see so (`perf/rendered.ts`). After an answer
        // the frame it asked for is already coming, and this joins it.
        if (!this.disposed) this.onChange()
      })

    return cached?.samples ?? null
  }

  /**
   * What a lane is waiting for, if it is waiting: the progress of the read in
   * flight for this entry and scope, or `null` when nothing is on its way.
   *
   * `{ done: 0, total: 0 }` for a request that has not reported yet — it is
   * in flight, and a lane may say so — and the worker's numbers once it has.
   */
  pendingOf(entry: string, scope: string): Progress | null {
    const running = this.inflight.get(`${entry}:${scope}`)
    if (running === undefined) return null
    return running.progress ?? { done: 0, total: 0 }
  }

  /**
   * Whether a read is on its way for any lane this cache serves: what a lane
   * stack says it is waiting for, for the page's report of a finished picture
   * (`perf/rendered.ts`).
   */
  get busy(): boolean {
    return this.inflight.size > 0
  }

  /** What is cached for one track in one scope, without asking for more. */
  peek(entry: string, scope: string): TrackSampleSet | null {
    return this.held.get(`${entry}:${scope}`)?.samples ?? null
  }
}

/** `true` when every visible window is inside what was fetched. */
function covers(
  covered: Map<string, Array<[number, number]>>,
  windows: Array<{ contig: string; start: number; end: number }>,
): boolean {
  for (const window of windows) {
    const spans = covered.get(window.contig)
    // Inside **any** of them, not inside their union: two fetched windows on one
    // contig are the two ends of a circle and the gap between them is the part
    // of the sequence nobody asked for, so a union would claim to cover it.
    if (spans === undefined) return false
    if (!spans.some((span) => span[0] <= window.start && span[1] >= window.end)) return false
  }
  return true
}
