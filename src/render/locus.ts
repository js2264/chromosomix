/**
 * The bridge between what a `Scale` speaks and what an annotation speaks.
 *
 * A `Scale` (`render/scale.ts`) maps *matrix coordinates* — fractional cell
 * indices along one axis of the rendered block — to pixels, and the heatmap's
 * own pan and zoom are what write it. An annotation is in (contig, base pair).
 * This is the piece in between, and spec §8.4 makes it the *only* one: nothing
 * else may derive a second mapping, because two mappings are two things that can
 * disagree by a pixel.
 *
 * It is a piecewise-linear map, one piece per contig run of the block, built
 * from the runs the reader already sends with every matrix. That is what makes
 * it work for every view without a special case — one contig, two different
 * contigs, or all sixteen at once — using the same arithmetic and the same two
 * numbers (`unitStart`, the bin size) the hover readout already uses. A tick, a
 * tooltip and a track therefore cannot disagree about where a base pair is.
 *
 * Deliberately structural about its input: {@link AxisRun} is satisfied by the
 * reader's `AxisGroup` without this module importing it, which keeps `render/`
 * free of any dependency on the reader — the same rule `GenomicMapper` follows.
 */

/** One labelled run along an axis, as the reader reports it. */
export interface AxisRun {
  label: string
  /** First cell of the run, block-local. */
  start: number
  /** One past its last cell, block-local. */
  end: number
  /** Absolute bin at which this run's contig itself begins. */
  unitStart?: number
  /** The contig's length in base pairs. */
  unitLength?: number
}

/** One contig's stretch of an axis, and how its cells map to base pairs. */
export interface LocusSegment {
  contig: string
  /** First cell of the stretch, in matrix coordinates. */
  unitStart: number
  /** One past its last cell. */
  unitEnd: number
  /** Base-pair position of the left edge of cell {@link unitStart}. */
  bpStart: number
  /** Base pairs per matrix cell: the bin size, or the whole contig above it. */
  bpPerUnit: number
  /** The contig's length, which is where its coordinates stop. */
  contigLength: number
}

/** A base-pair position on a named contig. */
export interface Locus {
  contig: string
  bp: number
}

/** The part of one contig a window covers, in the shape every query takes. */
export interface LocusWindow {
  contig: string
  start: number
  end: number
  /** Matrix coordinates of the visible part, for placing what comes back. */
  unitFrom: number
  unitTo: number
}

/**
 * One axis of a rendered block, as a sequence of contig stretches.
 *
 * Immutable: a new block means a new axis. That is what stops a stale mapping
 * from being drawn over fresh data, which is the failure the heatmap's own
 * `setMatrix` guards against by clearing `axisCoords` for the same reason.
 */
export class LocusAxis {
  /** Ascending by `unitStart`, contiguous, non-overlapping. */
  readonly segments: readonly LocusSegment[]
  private readonly byContig = new Map<string, LocusSegment>()

  constructor(segments: LocusSegment[]) {
    this.segments = segments
    for (const segment of segments) {
      // First wins. A contig's bins are contiguous in every layout this viewer
      // accepts (§3.3), so a second run for one name would mean the block was
      // built from something this axis cannot describe — and answering with the
      // first stretch is better than answering with whichever came last.
      if (!this.byContig.has(segment.contig)) this.byContig.set(segment.contig, segment)
    }
  }

  get length(): number {
    return this.segments.length
  }

  /** The contig names this axis carries, in axis order. */
  contigs(): string[] {
    return this.segments.map((segment) => segment.contig)
  }

  /** The last cell of the axis, one past the end. */
  get unitEnd(): number {
    return this.segments.length === 0 ? 0 : this.segments[this.segments.length - 1].unitEnd
  }

  /** Base pairs per matrix cell where that is a single number, else `null`. */
  get uniformBpPerUnit(): number | null {
    if (this.segments.length === 0) return null
    const first = this.segments[0].bpPerUnit
    return this.segments.every((segment) => segment.bpPerUnit === first) ? first : null
  }

  /** The stretch a contig occupies on this axis, or `null` if it is not on it. */
  segmentOf(contig: string): LocusSegment | null {
    return this.byContig.get(contig) ?? null
  }

  /** The stretch containing a matrix coordinate, or `null` outside the block. */
  segmentAt(unit: number): LocusSegment | null {
    let low = 0
    let high = this.segments.length - 1
    while (low <= high) {
      const mid = (low + high) >> 1
      const segment = this.segments[mid]
      if (unit < segment.unitStart) high = mid - 1
      else if (unit >= segment.unitEnd) low = mid + 1
      else return segment
    }
    return null
  }

  /**
   * Matrix coordinate → contig and base pair.
   *
   * Linear *within* a stretch and exact at bin level: the position is
   * `bpStart + (unit - unitStart) * binsize`, which is the reader's own
   * arithmetic. It is deliberately **not** computed by interpolating between
   * `bpStart` and a clamped `bpEnd` — a contig's last bin is usually partial, so
   * fitting the run into the contig's true length would shrink every bin by that
   * fraction and displace the far end of chromosome I by ~780 bp.
   */
  unitToLocus(unit: number): Locus | null {
    const segment = this.segmentAt(unit)
    if (segment === null) return null
    const bp = segment.bpStart + (unit - segment.unitStart) * segment.bpPerUnit
    return { contig: segment.contig, bp: clamp(bp, 0, segment.contigLength) }
  }

  /** Contig and base pair → matrix coordinate, or `null` for a contig off-axis. */
  locusToUnit(contig: string, bp: number): number | null {
    const segment = this.byContig.get(contig)
    if (segment === undefined || segment.bpPerUnit <= 0) return null
    return segment.unitStart + (bp - segment.bpStart) / segment.bpPerUnit
  }

  /**
   * The windows a visible domain covers, one per contig it touches.
   *
   * This is what a track query is built from, and it is why a whole-genome view
   * costs one request rather than sixteen: every stretch the domain overlaps
   * comes back at once, already clipped to what is on screen and already
   * carrying the matrix coordinates its answer will be drawn at.
   *
   * `pad` widens each window by that fraction of its own span, so a small pan
   * lands inside data that has already arrived (§8.4) — the cache exists to keep
   * pan and zoom free of I/O, and a window with no margin misses on the first
   * pixel of movement.
   */
  windows(domain: readonly [number, number], pad = 0): LocusWindow[] {
    const out: LocusWindow[] = []
    const [d0, d1] = domain
    for (const segment of this.segments) {
      const from = Math.max(segment.unitStart, d0)
      const to = Math.min(segment.unitEnd, d1)
      if (!(to > from)) continue
      const bpFrom = segment.bpStart + (from - segment.unitStart) * segment.bpPerUnit
      const bpTo = segment.bpStart + (to - segment.unitStart) * segment.bpPerUnit
      const margin = (bpTo - bpFrom) * pad
      out.push({
        contig: segment.contig,
        start: Math.max(0, Math.floor(bpFrom - margin)),
        end: Math.min(segment.contigLength, Math.ceil(bpTo + margin)),
        unitFrom: from,
        unitTo: to,
      })
    }
    return out
  }

  /** Every stretch, as a whole-contig window. The widest a query can be. */
  fullWindows(): LocusWindow[] {
    return this.segments.map((segment) => ({
      contig: segment.contig,
      start: 0,
      end: segment.contigLength,
      unitFrom: segment.unitStart,
      unitTo: segment.unitEnd,
    }))
  }
}

function clamp(value: number, low: number, high: number): number {
  return value < low ? low : value > high ? high : value
}

/**
 * Build an axis from a rendered block's runs.
 *
 * `blockStart` is the absolute bin the block begins at (`rowExtent[0]` or
 * `colExtent[0]`); it is what turns a block-local offset into a bin id, and it
 * is the difference between "139 kb into this contig" and "0 bp", which is what
 * a `contig:139005-199005` view says without it.
 *
 * `contigLength` is consulted because the reader does not always send one: an
 * *aggregated* axis has one cell per contig and carries only the name, so the
 * length has to come from the contigs table the app has already read. Passing it
 * as a lookup rather than a table keeps this module free of the reader's shapes.
 *
 * Returns `null` at genome level, where a cell is a whole genome and a base-pair
 * position inside one would be an invention — the same refusal `axisCoordsFor`
 * makes for the position ticks, and §8.4's "hidden at genome level".
 */
export function locusAxisFrom(options: {
  runs: readonly AxisRun[]
  blockStart: number
  level: 'bin' | 'contig' | 'genome'
  binsize: number
  contigLength(name: string): number | undefined
}): LocusAxis | null {
  const { runs, blockStart, level, binsize, contigLength } = options
  if (level === 'genome' || runs.length === 0) return null

  const segments: LocusSegment[] = []
  for (const run of runs) {
    if (!(run.end > run.start)) continue
    const known = contigLength(run.label)
    if (level === 'contig') {
      // One cell is the whole contig. Without a length there is no coordinate
      // system for it at all, so the run is dropped rather than drawn at a
      // guessed scale — a track stretched over an invented length is worse than
      // a track that is absent.
      if (known === undefined || !(known > 0)) continue
      segments.push({
        contig: run.label,
        unitStart: run.start,
        unitEnd: run.end,
        bpStart: 0,
        bpPerUnit: known / (run.end - run.start),
        contigLength: known,
      })
      continue
    }
    if (!(binsize > 0)) continue
    // Where the *contig* begins in absolute bin space. Falls back to the block's
    // own start, which is right exactly when the block begins on a boundary.
    const firstBin = run.unitStart ?? blockStart + run.start
    const length = run.unitLength ?? known ?? (run.end - run.start) * binsize
    segments.push({
      contig: run.label,
      unitStart: run.start,
      unitEnd: run.end,
      bpStart: (blockStart + run.start - firstBin) * binsize,
      bpPerUnit: binsize,
      contigLength: length,
    })
  }

  return segments.length === 0 ? null : new LocusAxis(segments)
}
