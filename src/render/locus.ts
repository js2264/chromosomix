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

import { contigIndexOf } from '../genome/naming'

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
  /**
   * Base-pair position of the left edge of cell {@link unitStart}. On a
   * reversed stretch that edge is the stretch's **high** end.
   */
  bpStart: number
  /** Base pairs per matrix cell: the bin size, or the whole contig above it. Always positive. */
  bpPerUnit: number
  /** The contig's length, which is where its coordinates stop. */
  contigLength: number
  /**
   * Which way the stretch reads along the axis (SPECS §27.2). `-1` is a piece
   * of an edited sequence read backwards: base pairs *fall* as the unit rises.
   * Absent is `1`, which is every axis there is without an edit — so no caller
   * that never meets an edit has to know this exists. Read it through
   * {@link bpAt} and {@link unitAt}, never by hand.
   */
  strand?: 1 | -1
  /**
   * The stretch of {@link contig} this segment may draw, half-open — the piece
   * of an edited sequence it is. Absent is the whole contig. A query is clipped
   * to it: a window padded past a piece's end would fetch the next stretch of
   * the original and draw it inside whatever piece comes next on the axis.
   */
  bpFrom?: number
  bpTo?: number
}

/** The strand a segment reads in. */
export function strandOf(segment: LocusSegment): 1 | -1 {
  return segment.strand ?? 1
}

/**
 * Matrix coordinate → base pair within one stretch, either way round.
 *
 * The one place the arithmetic is written. It was written inline at a dozen
 * call sites, each assuming a forward stretch — which was true until an edit
 * could turn a piece round (§27.2), and then would have been true nowhere that
 * mattered.
 */
export function bpAt(segment: LocusSegment, unit: number): number {
  const offset = (unit - segment.unitStart) * segment.bpPerUnit
  return strandOf(segment) === 1 ? segment.bpStart + offset : segment.bpStart - offset
}

/** Base pair → matrix coordinate within one stretch, either way round. */
export function unitAt(segment: LocusSegment, bp: number): number {
  const offset = (strandOf(segment) === 1 ? bp - segment.bpStart : segment.bpStart - bp) / segment.bpPerUnit
  return segment.unitStart + offset
}

/** The stretch of its contig a segment may draw: its piece, or the whole contig. */
export function stretchOf(segment: LocusSegment): [number, number] {
  return [segment.bpFrom ?? 0, segment.bpTo ?? segment.contigLength]
}

/**
 * A feature `[start, end)` placed on a stretch: its two unit edges, lowest
 * first — a reversed stretch draws a feature's end on its left.
 */
export function unitSpan(segment: LocusSegment, start: number, end: number): [number, number] {
  const a = unitAt(segment, start)
  const b = unitAt(segment, end)
  return a <= b ? [a, b] : [b, a]
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
  /**
   * The stretch this window was cut from — what places its answer on the axis.
   *
   * Carried rather than looked up again by name, and that is not only an economy.
   * An axis may hold the **same contig twice**: a circular sequence panned across
   * its own junction is one stretch ending at the sequence's last bin and another
   * beginning at its first (SPECS §8.15), and `windows` returns one window for
   * each. A caller that answered `segmentOf(window.contig)` would get the first
   * of them both times and draw everything on the far side of the join a whole
   * sequence out of place.
   */
  segment: LocusSegment
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
  /** Every name the axis carries, once each — the list a foreign spelling is matched against. */
  private readonly names: string[]
  /** A foreign spelling's answer, held: `null` for one this axis does not carry. */
  private readonly spelled = new Map<string, string | null>()

  constructor(segments: LocusSegment[]) {
    this.segments = segments
    for (const segment of segments) {
      // First wins. A contig's bins are contiguous in every layout this viewer
      // accepts (§3.3), so a second run for one name would mean the block was
      // built from something this axis cannot describe — and answering with the
      // first stretch is better than answering with whichever came last.
      if (!this.byContig.has(segment.contig)) this.byContig.set(segment.contig, segment)
    }
    this.names = [...this.byContig.keys()]
  }

  /**
   * This axis's own name for a sequence a file spells another way (§5.9) — `XIV`
   * for a loop set's `chrXIV` — or `null` where the axis does not carry it.
   *
   * A track is read through `contigIndexOf` on its own side, so a deck's second
   * map, which spells its sequences differently from the first, finds the
   * track's values all the same. Everything drawn *at a place* — a loop set's
   * rings, a mark, a rectangle — comes here instead, and asked by the exact
   * name it went on finding nothing on that map. Exact first, which is every
   * place on the map a set was loaded against and costs one probe.
   */
  ownName(contig: string): string | null {
    if (this.byContig.has(contig)) return contig
    const held = this.spelled.get(contig)
    if (held !== undefined) return held
    const at = contigIndexOf(this.names, contig)
    const name = at < 0 ? null : this.names[at]
    this.spelled.set(contig, name)
    return name
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
    const own = this.ownName(contig)
    return own === null ? null : (this.byContig.get(own) ?? null)
  }

  /**
   * **Every** stretch of a contig on this axis, in axis order.
   *
   * One on most axes. Two where a circular sequence is panned across its own
   * junction (§8.15), and as many as there are pieces of it where the axis is
   * of an edited sequence (§27.2) — each drawing only its own stretch, which is
   * why a renderer that places data asks this rather than {@link segmentOf}.
   */
  segmentsOf(contig: string): LocusSegment[] {
    const own = this.ownName(contig)
    return own === null ? [] : this.segments.filter((segment) => segment.contig === own)
  }

  /**
   * This axis's copy of a stretch that came from **another** axis.
   *
   * Both axes of a symmetric block carry the same sequences, and on a circular
   * one they carry the same sequence twice (SPECS §8.15) — so a mark whose
   * column was placed against the second stretch has to have its row placed
   * against the second stretch too, or the box is drawn at a place where nothing
   * is. Matched on the contig and on where the stretch *starts in the sequence*,
   * which is what distinguishes two laps of the same name.
   *
   * `null` where this axis does not carry it, which is every off-diagonal view.
   */
  like(segment: LocusSegment): LocusSegment | null {
    let fallback: LocusSegment | null = null
    for (const candidate of this.segments) {
      if (candidate.contig !== segment.contig) continue
      if (candidate.bpStart === segment.bpStart && strandOf(candidate) === strandOf(segment)) return candidate
      if (fallback === null) fallback = candidate
    }
    // A block whose two axes are windows on *different* parts of one sequence is
    // an ordinary off-diagonal view, and there the only copy is the right one.
    return fallback
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
    const [from, to] = stretchOf(segment)
    return { contig: segment.contig, bp: clamp(bpAt(segment, unit), from, to) }
  }

  /**
   * Contig and base pair → matrix coordinate, or `null` for a contig off-axis.
   *
   * **The first stretch**, where the axis holds a contig more than once — see
   * {@link locusToUnits}, which is the answer for a caller that draws a mark
   * rather than one that resolves a place.
   */
  locusToUnit(contig: string, bp: number): number | null {
    const own = this.ownName(contig)
    if (own === null) return null
    const segment = this.holding(own, bp) ?? this.byContig.get(own)
    if (segment === undefined || segment.bpPerUnit <= 0) return null
    return unitAt(segment, bp)
  }

  /**
   * The first stretch of a contig whose piece holds `bp`, or `undefined`.
   *
   * On an axis with no edit every stretch of a contig may draw the whole of
   * it, so this is the first stretch, as it always was; on an edited one the
   * pieces of one original are disjoint, and a place belongs to the piece
   * that holds it — or, set aside, to none.
   */
  private holding(contig: string, bp: number): LocusSegment | undefined {
    for (const segment of this.segments) {
      if (segment.contig !== contig) continue
      const [from, to] = stretchOf(segment)
      if (bp >= from && bp <= to) return segment
    }
    return undefined
  }

  /**
   * Every matrix coordinate a locus lands at, which on most axes is one.
   *
   * A circular sequence panned across its own junction has the same base pair on
   * the axis **twice** — once near the left edge and once near the right — and a
   * mark drawn at only one of them is a mark that vanishes and reappears as the
   * reader slides (SPECS §8.15). Every caller that draws *at* a locus wants this;
   * a caller that resolves a locus to a place — a search, a minimap — wants
   * {@link locusToUnit}, because there is one place and the picture shows it
   * twice.
   */
  locusToUnits(contig: string, bp: number): number[] {
    const out: number[] = []
    const own = this.ownName(contig)
    if (own === null) return out
    for (const segment of this.segments) {
      if (segment.contig !== own || !(segment.bpPerUnit > 0)) continue
      const [from, to] = stretchOf(segment)
      if (bp < from || bp > to) continue
      const unit = unitAt(segment, bp)
      // Only where it actually falls inside this stretch: a lap's worth of axis
      // is a window on the sequence, and a position outside it is drawn by the
      // stretch that does hold it — or by none, which is right.
      if (unit >= segment.unitStart - 0.5 && unit <= segment.unitEnd + 0.5) out.push(unit)
    }
    return out
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
      // Low and high, whichever way the stretch reads.
      const a = bpAt(segment, from)
      const b = bpAt(segment, to)
      const bpLow = Math.min(a, b)
      const bpHigh = Math.max(a, b)
      const margin = (bpHigh - bpLow) * pad
      const [low, high] = stretchOf(segment)
      out.push({
        contig: segment.contig,
        start: Math.max(low, Math.floor(bpLow - margin)),
        end: Math.min(high, Math.ceil(bpHigh + margin)),
        unitFrom: from,
        unitTo: to,
        segment,
      })
    }
    return out
  }

  /** Every stretch, as a whole-contig window. The widest a query can be. */
  fullWindows(): LocusWindow[] {
    return this.segments.map((segment) => {
      const [start, end] = stretchOf(segment)
      return { contig: segment.contig, start, end, unitFrom: segment.unitStart, unitTo: segment.unitEnd, segment }
    })
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
