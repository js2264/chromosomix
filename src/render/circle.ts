/**
 * The map drawn round (§7.6): its sections, its chords and its rings.
 *
 * A metagenome's contact map is read by genome — the blocks on the diagonal are
 * organisms and what a reader is looking for off it is which of them touch. A
 * square spends almost all of its area on pairs that do not, and draws the ones
 * that do as single cells a few pixels across, so the question "who touches
 * whom" is answered one hover at a time. Drawn round, each genome is an arc of
 * the circle sized by its length, the whole circle is the whole metagenome (or
 * the genomes ticked), and every pair that shares contacts is joined by a chord
 * as wide and as dark as their contacts are many. The same picture one level
 * down — a genome's contigs, or the contig × contig level of the whole file —
 * is a circle of contigs.
 *
 * **It is the block on screen, not another read.** Every number here is the
 * map's own: a section is a run of the axis, a chord is the sum of the cells
 * between two runs, and the units are whatever the axis is divided by — genomes
 * where it is divided by genome, contigs where it is contigs. So a circle and
 * the square beside it can never disagree, every gate and cache the square went
 * through is the one the circle went through, and turning it on costs nothing.
 *
 * Everything below draws into a context that may be a canvas or a vector page
 * (`ui/vector.ts`), so the figure is the screen; and no path relies on
 * `arc` continuing the current subpath, which the page writes as a fresh one —
 * the arcs that bound a filled shape are written as cubics here instead.
 */

import type { AxisGroup, MatrixResult } from '../worker/protocol'
import type { Transform } from '../types'
import { LABEL_MIN_SPAN_BP, MAX_CATEGORICAL_TICKS } from '../constants'
import { colormapCss } from './colormaps'
import { formatCount } from './legend'
import { transformValue } from './scale'

// ---------------------------------------------------------------------------
// The model: what the circle is of
// ---------------------------------------------------------------------------

/** What one section of the circle stands for. */
export type CircleUnitKind = 'genome' | 'contig'

/**
 * How a block divided by genome is cut into sections: its genomes, or its
 * contigs grouped under them. Only that block offers both; see {@link circleCuts}.
 */
export type CircleCut = 'genomes' | 'contigs'

/** One sequence a section is made of, for the rings drawn along it. */
export interface CircleSequence {
  name: string
  length: number
}

/** One section of the circle: a run of the map's axis. */
export interface CircleUnit {
  /** What a click resolves to — a genome's name, or the contig a slot starts at. */
  name: string
  /** What it is labelled with: the axis's own label, `+15` and all on a pooled slot. */
  label: string
  kind: CircleUnitKind
  /** The genome a contig belongs to, where the file has a genome layer. */
  genome?: string
  /** The block-local cells it covers on the (square) axis, half-open. */
  start: number
  end: number
  /** Its length in base pairs — its share of the circle. */
  bp: number
  /**
   * The sequences it is made of, in axis order; empty until they are known.
   *
   * What the rings are drawn against: a track is keyed on contigs, and a
   * genome's arc is its contigs laid end to end.
   */
  sequences: CircleSequence[]
}

/** Two sections that share contacts, and how many. */
export interface CircleChord {
  /** Unit indices, `a < b`. */
  a: number
  b: number
  /** The sum of the map's cells between the two runs. */
  weight: number
}

/** A run of consecutive contig sections that are one genome. */
export interface CircleGroup {
  name: string
  /** Unit indices, half-open. */
  from: number
  to: number
}

export interface CircleModel {
  units: CircleUnit[]
  kind: CircleUnitKind
  /**
   * The genomes over contig sections, where the axis is contigs of several:
   * drawn as a band outside the contigs and named, as the square names its
   * genome blocks. `null` everywhere else.
   */
  groups: CircleGroup[] | null
  /** Strongest first, at most {@link CHORD_CAP} of them. */
  chords: CircleChord[]
  /** How many pairs of sections share any contact at all. */
  pairs: number
  /** Each section's contacts with itself: its block's upper triangle, diagonal included. */
  intra: Float64Array
  /** Each section's contacts with every other section. */
  inter: Float64Array
}

/**
 * What the file can answer about a section that the block cannot.
 *
 * A genome × genome block knows a genome's name and nothing about its contigs,
 * and a pooled contig slot knows the contig it starts at — so the lengths that
 * size the arcs and the sequences the rings are drawn along come from the
 * session's tables. Every member is optional: a block that carries the answer
 * itself (a bin-level axis, whose runs are contigs with their lengths) never
 * asks.
 */
export interface CircleResolver {
  /** A genome's length in base pairs, from `/genomes`. */
  genomeLength?(genome: string): number | undefined
  /** A genome's displayable contigs in file order, or `null` before the table is read. */
  genomeSequences?(genome: string): readonly CircleSequence[] | null
  /**
   * The contigs from `first` up to, not including, `next`, in file order —
   * a pooled slot of the contig × contig level, which holds every displayable
   * contig between the one it starts at and the one the next slot starts at.
   */
  slotSequences?(first: string, next: string | undefined): readonly CircleSequence[] | null
  contigLength?(name: string): number | undefined
}

/**
 * The most chords one circle draws.
 *
 * A circle of 48 genomes has 1,128 pairs and draws all of them; the contig ×
 * contig level of a whole metagenome has millions, and a few thousand of the
 * strongest are already more ink than the eye separates. The rest are counted
 * ({@link CircleModel.pairs}) and the key says so.
 */
export const CHORD_CAP = 3000

/** Half the narrowest a chord's end is drawn, in pixels: a hairline, whatever its arc. */
const HAIRLINE = 0.35

/** Fewer than two sections is not a circle: there is nothing to join. */
export const MIN_SECTIONS = 2

/** Past this many chords drawn, the ramp starts at the median one; see {@link layoutChords}. */
export const CHORD_FLOOR_AT = 100

/** At most this many chords are drawn above the ramp's floor, in ink; see {@link layoutChords}. */
export const CHORD_INKED = 500

/**
 * The sections a block is divided into, or `null` where it is not a circle.
 *
 * **What the axis is divided by**, the rule the square already follows for its
 * separators and labels (`MatrixResult.genomeBoundaries`):
 *
 * - a genome × genome block is genomes;
 * - a contig × contig block is contigs, grouped by genome where it has them;
 * - a bin-level block divided by genome — the whole metagenome, several ticked
 *   genomes — is genomes, each the contigs inside its run, or under the
 *   `contigs` cut its contigs, grouped by genome as the contig level is;
 * - any other bin-level block — one genome, ticked contigs — is contigs.
 *
 * Only a square block whose two axes are one axis: a pair of genomes is a
 * rectangle with no diagonal to fold round, and a circle drawn of it would
 * invent the half it never read.
 */
export function circleUnitsOf(
  data: MatrixResult,
  resolver: CircleResolver = {},
  bpPerCell = 1,
  cut: CircleCut = 'genomes',
): { units: CircleUnit[]; kind: CircleUnitKind; groups: CircleGroup[] | null } | null {
  if (!isSquareBlock(data)) return null
  const cellBp = Math.max(1, bpPerCell)
  if (data.level === 'genome' && data.rowGenomes === undefined) {
    const units = data.rowGroups.map((group) => genomeUnit(group, resolver, cellBp))
    return units.length >= MIN_SECTIONS ? { units, kind: 'genome', groups: null } : null
  }
  if (cut === 'genomes' && dividedByGenome(data)) {
    const units = data.rowGenomes.map((run) => genomeRunUnit(run, data.rowGroups, resolver, cellBp))
    return units.length >= MIN_SECTIONS ? { units, kind: 'genome', groups: null } : null
  }
  // Contigs: each run of the axis, one section, carrying the genome it is in.
  const genomeAt = genomeLookup(data.rowGenomes)
  const units = data.rowGroups.map((group, index) =>
    contigUnit(group, data.rowGroups[index + 1], genomeAt(group.start), resolver, cellBp, data.level),
  )
  if (units.length < MIN_SECTIONS) return null
  return { units, kind: 'contig', groups: groupsOf(units) }
}

/**
 * The cuts a block offers, the first its own: a bin-level block divided by
 * genome is either its genomes or its contigs grouped under them, and every
 * other block is the one thing its axis is divided by. Empty where the block
 * is no circle at all.
 */
export function circleCuts(data: MatrixResult): readonly CircleCut[] {
  if (!isSquareBlock(data)) return []
  if (data.level === 'genome' && data.rowGenomes === undefined) return ['genomes']
  return dividedByGenome(data) ? ['genomes', 'contigs'] : ['contigs']
}

/** A bin-level axis with genome runs over its contig runs: the whole metagenome, ticked genomes. */
function dividedByGenome(data: MatrixResult): data is MatrixResult & { rowGenomes: AxisGroup[] } {
  return data.level === 'bin' && data.genomeBoundaries === true && data.rowGenomes !== undefined
}

/** Both axes the same cells: a block with a diagonal to fold round. */
function isSquareBlock(data: MatrixResult): boolean {
  return (
    data.nrows === data.ncols &&
    data.nrows > 0 &&
    data.rowExtent[0] === data.colExtent[0] &&
    data.rowExtent[1] === data.colExtent[1] &&
    data.rowGroups.length === data.colGroups.length &&
    data.wrapped === undefined
  )
}

function genomeUnit(group: AxisGroup, resolver: CircleResolver, cellBp: number): CircleUnit {
  const name = group.name ?? group.label
  const sequences = [...(resolver.genomeSequences?.(name) ?? [])]
  const bp =
    sumLengths(sequences) || resolver.genomeLength?.(name) || Math.max(1, group.end - group.start) * cellBp
  return { name, label: group.label, kind: 'genome', start: group.start, end: group.end, bp, sequences }
}

/** A genome's run of a bin-level axis, made of the contig runs inside it. */
function genomeRunUnit(
  run: AxisGroup,
  contigs: readonly AxisGroup[],
  resolver: CircleResolver,
  cellBp: number,
): CircleUnit {
  const sequences: CircleSequence[] = []
  for (const group of contigs) {
    if (group.start < run.start || group.start >= run.end) continue
    sequences.push(...sequencesOfRun(group, resolver, cellBp))
  }
  const bp =
    sumLengths(sequences) || resolver.genomeLength?.(run.label) || Math.max(1, run.end - run.start) * cellBp
  return { name: run.label, label: run.label, kind: 'genome', start: run.start, end: run.end, bp, sequences }
}

function contigUnit(
  group: AxisGroup,
  next: AxisGroup | undefined,
  genome: string | undefined,
  resolver: CircleResolver,
  cellBp: number,
  level: MatrixResult['level'],
): CircleUnit {
  const name = group.name ?? group.label
  // A pooled slot of the contig × contig level knows only where it starts; the
  // table knows the rest. Anywhere else the run carries its own sequences.
  const slot =
    level !== 'bin' && group.merged === undefined && group.name !== undefined && group.name !== group.label
      ? resolver.slotSequences?.(name, next?.name ?? next?.label)
      : null
  const sequences = slot !== null && slot !== undefined ? [...slot] : sequencesOfRun(group, resolver, cellBp)
  const bp = sumLengths(sequences) || Math.max(1, group.end - group.start) * cellBp
  return {
    name,
    label: group.label,
    kind: 'contig',
    ...(genome === undefined ? {} : { genome }),
    start: group.start,
    end: group.end,
    bp,
    sequences,
  }
}

/** The sequences one run of the axis covers, with their lengths. */
function sequencesOfRun(group: AxisGroup, resolver: CircleResolver, cellBp: number): CircleSequence[] {
  if (group.merged !== undefined && group.merged.length > 0) {
    return group.merged.map((member) => ({
      name: member.label,
      length: member.unitLength > 0 ? member.unitLength : (resolver.contigLength?.(member.label) ?? 0),
    }))
  }
  const name = group.name ?? group.label
  const length =
    group.unitLength ?? resolver.contigLength?.(name) ?? Math.max(1, group.end - group.start) * cellBp
  return [{ name, length }]
}

function sumLengths(sequences: readonly CircleSequence[]): number {
  let total = 0
  for (const sequence of sequences) total += Math.max(0, sequence.length)
  return total
}

/** The genome a cell of the axis is in, from the genome runs over it. */
function genomeLookup(runs: readonly AxisGroup[] | undefined): (cell: number) => string | undefined {
  if (runs === undefined || runs.length === 0) return () => undefined
  return (cell) => runs.find((run) => cell >= run.start && cell < run.end)?.label
}

/** Consecutive contig sections of one genome, where there are several genomes. */
function groupsOf(units: readonly CircleUnit[]): CircleGroup[] | null {
  const groups: CircleGroup[] = []
  for (let i = 0; i < units.length; i++) {
    const genome = units[i].genome
    if (genome === undefined) return null
    const last = groups[groups.length - 1]
    if (last !== undefined && last.name === genome) last.to = i + 1
    else groups.push({ name: genome, from: i, to: i + 1 })
  }
  return groups.length >= 2 ? groups : null
}

/**
 * The circle a block draws: its sections and the chords between them.
 *
 * One pass over the block's upper triangle. A cell between two runs adds to
 * their chord, a cell inside one adds to that section's own contacts, and a
 * `NaN` — a filtered bin — adds nothing. The chords are kept in a heap of the
 * strongest {@link CHORD_CAP}, so a contig circle of four thousand sections
 * costs memory in its sections and not in its eight million pairs.
 */
export function circleModelOf(
  data: MatrixResult,
  resolver: CircleResolver = {},
  bpPerCell = 1,
  cap = CHORD_CAP,
  cut: CircleCut = 'genomes',
): CircleModel | null {
  const found = circleUnitsOf(data, resolver, bpPerCell, cut)
  if (found === null) return null
  const { units, kind, groups } = found
  const n = data.nrows
  const unitOf = new Int32Array(n).fill(-1)
  units.forEach((unit, index) => {
    for (let cell = Math.max(0, unit.start); cell < Math.min(n, unit.end); cell++) unitOf[cell] = index
  })
  const count = units.length
  const intra = new Float64Array(count)
  const inter = new Float64Array(count)
  const heap = new ChordHeap(Math.max(1, cap))
  const row = new Float64Array(count)
  const values = data.values
  let pairs = 0
  // Rows run in axis order and the units are runs of it, so every row of one
  // unit is visited before the next unit's: its partners are summed into one
  // row of the matrix and flushed when the unit changes.
  let current = -1
  const flush = (): void => {
    if (current < 0) return
    for (let other = current + 1; other < count; other++) {
      const weight = row[other]
      if (weight > 0) {
        pairs++
        heap.offer(current, other, weight)
        inter[current] += weight
        inter[other] += weight
      }
      row[other] = 0
    }
  }
  for (let r = 0; r < n; r++) {
    const u = unitOf[r]
    if (u < 0) continue
    if (u !== current) {
      flush()
      current = u
    }
    const base = r * n
    for (let c = r; c < n; c++) {
      const v = unitOf[c]
      if (v < 0) continue
      const value = values[base + c]
      if (!Number.isFinite(value) || value === 0) continue
      if (v === u) intra[u] += value
      else if (v > u) row[v] += value
    }
  }
  flush()
  return { units, kind, groups, chords: heap.sorted(), pairs, intra, inter }
}

/** The strongest `size` chords seen, as a min-heap on weight. */
class ChordHeap {
  private readonly a: Int32Array
  private readonly b: Int32Array
  private readonly w: Float64Array
  private length = 0

  constructor(private readonly size: number) {
    this.a = new Int32Array(size)
    this.b = new Int32Array(size)
    this.w = new Float64Array(size)
  }

  offer(a: number, b: number, weight: number): void {
    if (this.length < this.size) {
      let at = this.length++
      while (at > 0) {
        const parent = (at - 1) >> 1
        if (this.w[parent] <= weight) break
        this.move(parent, at)
        at = parent
      }
      this.put(at, a, b, weight)
      return
    }
    if (weight <= this.w[0]) return
    // Replace the weakest and sift it down.
    let at = 0
    for (;;) {
      const left = 2 * at + 1
      if (left >= this.length) break
      const right = left + 1
      const child = right < this.length && this.w[right] < this.w[left] ? right : left
      if (this.w[child] >= weight) break
      this.move(child, at)
      at = child
    }
    this.put(at, a, b, weight)
  }

  sorted(): CircleChord[] {
    const out: CircleChord[] = []
    for (let i = 0; i < this.length; i++) out.push({ a: this.a[i], b: this.b[i], weight: this.w[i] })
    // Strongest first; ties by position, so two draws of one block agree.
    out.sort((x, y) => y.weight - x.weight || x.a - y.a || x.b - y.b)
    return out
  }

  private move(from: number, to: number): void {
    this.put(to, this.a[from], this.b[from], this.w[from])
  }

  private put(at: number, a: number, b: number, weight: number): void {
    this.a[at] = a
    this.b[at] = b
    this.w[at] = weight
  }
}

// ---------------------------------------------------------------------------
// Geometry: where everything goes
// ---------------------------------------------------------------------------

/** One ring's claim on the radius, before it is fitted. */
export interface CircleRingSpec {
  id: string
  /** Relative thickness — the lane's own height beside a map. */
  size: number
}

export interface CircleGeometry {
  cx: number
  cy: number
  /** The radius the labels end at: the edge of the picture. */
  outer: number
  /** Where the section labels start. */
  labelAt: number
  /** The genome band over contig sections, where there is one. */
  band: { inner: number; outer: number } | null
  sections: { inner: number; outer: number }
  /** In draw order, from the chords outwards: the first track is nearest the chords. */
  rings: Array<{ id: string; inner: number; outer: number }>
  /**
   * The depth the rings share, between the sections and a chord disc kept to a
   * third of the radius, their gaps taken out: what a ring as thick as its lane
   * is tall is fitted into, and what *stretch* fills.
   */
  ringRoom: number
  /** The disc the chords are drawn in. */
  chord: number
  /** `[start, end]` angle of each section, canvas radians (0 is three o'clock, clockwise). */
  arcs: Float64Array
  /** The genome band's arcs, one per group, where there is a band. */
  groupArcs: Float64Array | null
  /** The angle left open at twelve o'clock, where the rings are named. */
  topGap: number
  /**
   * Whether the picture keeps room for names at all. Where it does not — the
   * names turned off, or none a name can be given at rest ({@link namePolicy}) —
   * the circle takes that room, and no name is written even on hover: the
   * tooltip says what is under the pointer.
   */
  names: boolean
  /** Which sections are labelled at rest: named by the policy, and an arc that holds a line. */
  labelled: Uint8Array
  /** Which genome-band groups are labelled. */
  groupLabelled: Uint8Array | null
  /** The label font's size in pixels, which the room for one label is measured in. */
  fontPx: number
}

/** Twelve o'clock, in canvas radians. */
export const TOP = -Math.PI / 2
const TAU = Math.PI * 2

export interface CircleLayoutOptions {
  width: number
  height: number
  rings: readonly CircleRingSpec[]
  /** The width of a label in the label font. */
  measure(text: string): number
  fontPx: number
  /** A box in the top-right corner the circle must leave clear — the key. */
  corner?: { width: number; height: number }
  /**
   * Whether sections are named at all: the Map card's `labels` overlay, which
   * names the square's blocks in its gutters. Absent is on.
   */
  names?: boolean
}

/** Which names a circle writes at rest; see {@link namePolicy}. */
export type CircleNames = 'all' | 'long' | 'none'

/**
 * Which of a circle's names are written at rest: the square's rule for its
 * gutters (`HeatmapView.labelPolicy`), with no zoom to bring more of them out.
 *
 * Every name where there are no more than {@link MAX_CATEGORICAL_TICKS} to
 * give. Past that, a circle of contigs — one genome's, or ticked ones — names
 * those of {@link LABEL_MIN_SPAN_BP} or more, the few a reader is looking for;
 * and a circle of genomes names none. A thousand MAGs round a circle are read
 * by its shape, and a name every few degrees, or the names of the largest few,
 * are noise over the rings — which genome is under the pointer is the
 * tooltip's to say. Where a band names the genomes over contig sections, the
 * genomes are what is counted, and a contig is named only once it is lit.
 */
export function namePolicy(model: CircleModel): CircleNames {
  const count = model.groups?.length ?? model.units.length
  if (count <= MAX_CATEGORICAL_TICKS) return 'all'
  return model.groups === null && model.kind === 'contig' ? 'long' : 'none'
}

/**
 * Lay a circle out in a box: angles for the sections, radii for everything.
 *
 * Outside in: the section labels, the genome band where contigs are grouped,
 * the sections themselves, the rings, and the disc the chords cross. The
 * sections are next to their labels on purpose — a name is read against the
 * arc it names, and twenty rings between the two would make every label a
 * guess — and the rings stand between the sections and the chords so that a
 * chord's two ends land under the values it is read against.
 */
export function circleGeometry(model: CircleModel, options: CircleLayoutOptions): CircleGeometry {
  const size = Math.max(0, Math.min(options.width, options.height))
  const cx = options.width / 2
  const cy = options.height / 2
  // Clear of the key in the top-right corner, where the square keeps its own:
  // the circle shrinks until its outermost name misses the key's box.
  const corner = options.corner
  const clearOfKey =
    corner === undefined
      ? Number.POSITIVE_INFINITY
      : Math.hypot(cx - (options.width - corner.width), cy - corner.height) - 4
  const outer = Math.max(24, Math.min(size / 2 - 6, clearOfKey))
  const fontPx = options.fontPx
  const n = model.units.length

  // --- angles ------------------------------------------------------------
  const groups = model.groups
  // A gap between sections of one genome, and a wider one between genomes, so
  // the eye reads a genome's contigs as one arc. Both shrink with the count:
  // two thousand gaps of a degree would be the whole circle.
  const unitGap =
    model.kind === 'genome'
      ? Math.min(0.016, (0.14 * TAU) / n)
      : groups === null
        ? Math.min(0.012, (0.12 * TAU) / n)
        : Math.min(0.0035, (0.03 * TAU) / n)
  const groupGap = groups === null ? 0 : Math.min(0.02, (0.12 * TAU) / groups.length)
  // Wider where there are rings, whose names are written across it.
  const topGap = Math.max(options.rings.length > 0 ? 0.08 : 0.05, unitGap * 3, groupGap * 2)
  let gaps = topGap
  for (let i = 1; i < n; i++) gaps += isGroupStart(groups, i) ? groupGap : unitGap
  const room = Math.max(0, TAU - gaps)
  let total = 0
  for (const unit of model.units) total += Math.max(0, unit.bp)
  const arcs = new Float64Array(n * 2)
  let angle = TOP + topGap / 2
  for (let i = 0; i < n; i++) {
    if (i > 0) angle += isGroupStart(groups, i) ? groupGap : unitGap
    const span = total > 0 ? (room * Math.max(0, model.units[i].bp)) / total : room / n
    arcs[2 * i] = angle
    arcs[2 * i + 1] = angle + span
    angle += span
  }
  const groupArcs =
    groups === null
      ? null
      : Float64Array.from(groups.flatMap((group) => [arcs[2 * group.from], arcs[2 * group.to - 1]]))

  // --- radii -------------------------------------------------------------
  // Labels first, because they decide how much circle there is: as long as the
  // longest label that will be drawn, and never more than two fifths of the
  // radius — past that a name is cut, rather than the circle shrunk for it.
  const labelCap = outer * 0.4
  const labels = groups === null ? model.units.map((unit) => unit.label) : groups.map((group) => group.name)
  const labelArcs = groupArcs ?? arcs
  const policy: CircleNames = options.names === false ? 'none' : namePolicy(model)
  const named = (index: number): boolean =>
    policy === 'all' || (policy === 'long' && model.units[index].bp >= LABEL_MIN_SPAN_BP)
  const fits = (at: number, index: number): boolean =>
    named(index) && (labelArcs[2 * index + 1] - labelArcs[2 * index]) * at >= fontPx * 1.15
  // Room only for names that are written at rest. A circle with none — the
  // overlay off, a thousand genomes — keeps none, and is that much larger.
  let labelWidth = 0
  const guessAt = outer - labelCap
  labels.forEach((label, index) => {
    if (fits(guessAt, index)) labelWidth = Math.max(labelWidth, options.measure(label))
  })
  labelWidth = Math.min(labelCap, labelWidth)
  const labelAt = outer - (labelWidth > 0 ? labelWidth + 6 : 0)

  const sectionWidth = clamp(outer * 0.045, 7, 16)
  const bandWidth = groups === null ? 0 : clamp(outer * 0.03, 5, 10)
  const band = groups === null ? null : { outer: labelAt - 2, inner: labelAt - 2 - bandWidth }
  const sectionsOuter = band === null ? labelAt - 2 : band.inner - 2
  const sections = { outer: sectionsOuter, inner: sectionsOuter - sectionWidth }

  // The rings share what is left between the sections and a chord disc kept to
  // at least a third of the radius: each as thick as its lane is tall, where
  // they all fit, and in proportion to it where they do not.
  const ringGap = 4
  const rings: CircleGeometry['rings'] = []
  const ringRoom = Math.max(0, sections.inner - 6 - outer * 0.34 - ringGap * options.rings.length)
  if (options.rings.length > 0) {
    const room = ringRoom
    const asked = options.rings.reduce((sum, ring) => sum + Math.max(1, ring.size), 0)
    const scale = Math.min(1, room / Math.max(1, asked))
    let at = sections.inner - 6
    // Drawn from the sections inwards, so the *last* ring of the order is the
    // outermost: the first track is nearest the chords, as a lane's first track
    // is nearest the map.
    const thickness = options.rings.map((ring) => clamp(Math.max(1, ring.size) * scale, 6, outer * 0.16))
    for (let k = options.rings.length - 1; k >= 0; k--) {
      const inner = at - thickness[k]
      rings.unshift({ id: options.rings[k].id, inner, outer: at })
      at = inner - ringGap
    }
  }
  const chord = Math.max(8, (rings.length > 0 ? rings[0].inner : sections.inner) - 6)

  // Which labels fit, at the radius they are drawn at.
  const labelled = new Uint8Array(n)
  let groupLabelled: Uint8Array | null = null
  if (groups === null) {
    for (let i = 0; i < n; i++) labelled[i] = fits(labelAt, i) ? 1 : 0
  } else {
    groupLabelled = new Uint8Array(groups.length)
    for (let g = 0; g < groups.length; g++) groupLabelled[g] = fits(labelAt, g) ? 1 : 0
  }

  return {
    cx,
    cy,
    outer,
    labelAt,
    band,
    sections,
    rings,
    ringRoom,
    chord,
    arcs,
    groupArcs,
    topGap,
    names: labelWidth > 0,
    labelled,
    groupLabelled,
    fontPx,
  }
}

function isGroupStart(groups: readonly CircleGroup[] | null, unit: number): boolean {
  return groups !== null && groups.some((group) => group.from === unit)
}

function clamp(value: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, value))
}

/** The middle of a section, in canvas radians. */
export function midAngle(geometry: CircleGeometry, unit: number): number {
  return (geometry.arcs[2 * unit] + geometry.arcs[2 * unit + 1]) / 2
}

// ---------------------------------------------------------------------------
// Chords: where each one lands
// ---------------------------------------------------------------------------

/**
 * How the chords are drawn: how many, and how a weight becomes ink.
 *
 * The map's own transform and ramp — the chords are its off-diagonal cells, so
 * they are coloured as the square colours them — over the range of the chords
 * actually drawn, since the diagonal the square's clip is set against is not
 * on the circle at all.
 */
export interface ChordStyle {
  /** The strongest this many; `Infinity` for every chord the model kept. */
  limit: number
  transform: Transform
  colormap: string
}

/** Each drawn chord's two ends: centre and half-width of each, in radians. */
export interface ChordLayout {
  /** Indices into {@link CircleModel.chords}, weakest first — the draw order. */
  order: Int32Array
  /** `[aMid, aHalf, bMid, bHalf]` per drawn chord, in {@link order}'s order. */
  ends: Float64Array
  /** The chord's strength on `[0, 1]` after the transform, per drawn chord. */
  strength: Float32Array
  /** The range the strengths were measured over, in transformed units. */
  range: { lo: number; hi: number }
  /** How many of the model's chords are drawn. */
  drawn: number
}

/**
 * Seat every drawn chord on the rim of the disc.
 *
 * Each section's chord ends are laid side by side along its arc, ordered by
 * where the partner sits round the circle — a partner just clockwise attaches
 * at the clockwise end — so the ribbons fan out from a section instead of
 * crossing one another at its foot. Where an arc cannot hold its ends side by
 * side they share the arc evenly, and overlap; the strongest is drawn last and
 * so stays on top.
 */
export function layoutChords(model: CircleModel, geometry: CircleGeometry, style: ChordStyle): ChordLayout {
  const drawn = Math.max(0, Math.min(model.chords.length, Number.isFinite(style.limit) ? style.limit : model.chords.length))
  const chords = model.chords.slice(0, drawn)
  const order = Int32Array.from({ length: drawn }, (_, i) => drawn - 1 - i)
  // The range is the drawn chords', in the map's own units, and its floor is
  // where the chords stop being the background. Every pair of genomes in a
  // metagenome shares *some* contacts — spurious ligations between cells that
  // shared a tube — so a ramp from the weakest drawn spends its colours on that
  // noise, and a thousand mid-tone ribbons fill the disc. Past a hundred chords
  // the floor is the median chord — half of them are the faint background they
  // are, and the ramp is spent on the half that differ from it — or higher,
  // where half would still be more than {@link CHORD_INKED} ribbons: a genome's
  // contigs share contacts nearly pair by pair, and fifteen hundred ribbons in
  // ink are a red disc whatever their colours. Fewer than a hundred and every
  // chord is one the reader asked to see, from the weakest up.
  const levels: number[] = []
  for (const chord of chords) {
    const t = transformValue(chord.weight, style.transform)
    if (Number.isFinite(t)) levels.push(t)
  }
  levels.sort((x, y) => x - y)
  const floorAt = Math.max(Math.floor(levels.length / 2), levels.length - CHORD_INKED)
  let lo = levels.length === 0 ? 0 : levels.length > CHORD_FLOOR_AT ? levels[floorAt] : levels[0]
  let hi = levels.length === 0 ? 1 : levels[levels.length - 1]
  if (!(hi > lo)) {
    lo = Math.min(lo, 0)
    hi = lo + 1
  }
  const span = hi - lo || 1
  const strengthOf = (weight: number): number => {
    const t = (transformValue(weight, style.transform) - lo) / span
    return Number.isFinite(t) ? clamp(t, 0, 1) : 0
  }

  const r = geometry.chord
  const widest = clamp(r * 0.09, 3, 22)
  // Wider faster at the strong end: a chord's width is read as its weight, and
  // the eye should land on the few that matter before the many that do not.
  const halfOf = (strength: number): number => (0.5 + (widest - 0.5) * strength ** 1.3) / (2 * r)

  // Each section's ends, then the order along its arc.
  const n = model.units.length
  const perUnit: number[][] = Array.from({ length: n }, () => [])
  chords.forEach((chord, index) => {
    perUnit[chord.a].push(index)
    perUnit[chord.b].push(index)
  })
  const ends = new Float64Array(drawn * 4)
  const strength = new Float32Array(drawn)
  chords.forEach((chord, index) => {
    strength[index] = strengthOf(chord.weight)
  })
  for (let unit = 0; unit < n; unit++) {
    const mine = perUnit[unit]
    if (mine.length === 0) continue
    const a0 = geometry.arcs[2 * unit]
    const a1 = geometry.arcs[2 * unit + 1]
    const mid = (a0 + a1) / 2
    const partnerOf = (index: number): number => {
      const chord = chords[index]
      return chord.a === unit ? chord.b : chord.a
    }
    // Clockwise distance to the partner, largest first: the partner furthest
    // round the circle lands at the anticlockwise end.
    const away = (index: number): number => {
      const delta = midAngle(geometry, partnerOf(index)) - mid
      return ((delta % TAU) + TAU) % TAU
    }
    mine.sort((x, y) => away(y) - away(x))
    const span = Math.max(0, a1 - a0)
    const inset = Math.min(span * 0.08, 0.004)
    const usable = Math.max(0, span - 2 * inset)
    // No wider than the arc it leaves from, and never narrower than a hairline:
    // a contig slot of a whole metagenome is a fraction of a pixel, and a chord
    // held to that is no chord at all — there, ends overlap their neighbours'.
    const halves = mine.map((index) => Math.max(HAIRLINE / r, Math.min(halfOf(strength[index]), usable / 2)))
    const need = halves.reduce((sum, half) => sum + 2 * half, 0)
    if (need <= usable) {
      // Side by side, the slack shared out between them.
      const slack = (usable - need) / (mine.length + 1)
      let at = a0 + inset + slack
      mine.forEach((index, k) => {
        const half = halves[k]
        place(index, at + half, half)
        at += 2 * half + slack
      })
    } else {
      // Spread evenly, overlapping.
      mine.forEach((index, k) => {
        const centre = a0 + inset + ((k + 0.5) * usable) / mine.length
        place(index, centre, halves[k])
      })
    }
    function place(index: number, centre: number, half: number): void {
      const chord = chords[index]
      const slot = chord.a === unit ? 0 : 2
      // `drawn - 1 - index` is where this chord stands in the draw order.
      const at = (drawn - 1 - index) * 4 + slot
      ends[at] = centre
      ends[at + 1] = half
    }
  }
  // `ends` is written in draw order already; strengths follow it too.
  const ordered = new Float32Array(drawn)
  for (let k = 0; k < drawn; k++) ordered[k] = strength[order[k]]
  return { order, ends, strength: ordered, range: { lo, hi }, drawn }
}

// ---------------------------------------------------------------------------
// Painting
// ---------------------------------------------------------------------------

/** What the pointer is over, as the picture answers it. */
export type CircleHit =
  | { kind: 'section'; unit: number }
  | { kind: 'group'; group: number }
  /** An index into the drawn order of {@link ChordLayout}. */
  | { kind: 'chord'; slot: number }
  | { kind: 'ring'; ring: number; unit: number; angle: number }

/** The colours the circle is drawn in; the figure's, not the page's. */
export interface CirclePalette {
  text: string
  dim: string
  halo: string
  accent: string
  /** The faint wash a ring's band and the sections' track are laid on. */
  wash: string
  /** The two inks sections alternate between. */
  sections: readonly [string, string]
}

export const LIGHT_CIRCLE_PALETTE: CirclePalette = {
  text: '#16181d',
  dim: '#5b6169',
  halo: '#ffffff',
  accent: '#2563eb',
  wash: '#f1f3f5',
  sections: ['#4b5563', '#9aa3ad'],
}

/**
 * A section, or a ring's band, as one closed shape.
 *
 * The outer arc clockwise and the inner arc back, both as cubics so the shape
 * is one subpath on a vector page as it is on a canvas.
 */
export function annulusPath(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  inner: number,
  outer: number,
  a0: number,
  a1: number,
): void {
  ctx.moveTo(cx + Math.cos(a0) * outer, cy + Math.sin(a0) * outer)
  arcCurve(ctx, cx, cy, outer, a0, a1)
  ctx.lineTo(cx + Math.cos(a1) * inner, cy + Math.sin(a1) * inner)
  arcCurve(ctx, cx, cy, inner, a1, a0)
  ctx.closePath()
}

/**
 * An arc from the current point, as cubic Béziers of at most a quarter turn.
 *
 * The current point must already be the arc's start. Written out rather than
 * through `arc`, which a vector page always starts as a fresh subpath — and a
 * ribbon whose two ends are arcs would come out of the PDF as two shapes
 * closed by a line across their middle.
 */
export function arcCurve(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  r: number,
  a0: number,
  a1: number,
): void {
  const sweep = a1 - a0
  if (sweep === 0) return
  const steps = Math.max(1, Math.ceil(Math.abs(sweep) / (Math.PI / 2) - 1e-9))
  const piece = sweep / steps
  const reach = (4 / 3) * Math.tan(piece / 4) * r
  for (let i = 0; i < steps; i++) {
    const from = a0 + piece * i
    const to = from + piece
    const x0 = cx + Math.cos(from) * r
    const y0 = cy + Math.sin(from) * r
    const x1 = cx + Math.cos(to) * r
    const y1 = cy + Math.sin(to) * r
    ctx.bezierCurveTo(
      x0 - Math.sin(from) * reach,
      y0 + Math.cos(from) * reach,
      x1 + Math.sin(to) * reach,
      y1 - Math.cos(to) * reach,
      x1,
      y1,
    )
  }
}

/**
 * Where a chord between two angles bends: on the line to the middle of the
 * shorter way between them, as far in as they are far apart.
 *
 * Through the centre, every chord between two neighbours reached half way in —
 * a contig circle became a fan of spikes, and the middle of the disc, which is
 * where the long links are read, was filled by the shortest. Bent this way a
 * link between neighbours is a shallow loop under the rim and one across the
 * circle still passes through its middle (Circos's own `bezier_radius`).
 */
export function chordBend(
  cx: number,
  cy: number,
  r: number,
  a: number,
  b: number,
): { x: number; y: number } {
  let delta = (((b - a) % TAU) + TAU) % TAU
  let mid = a + delta / 2
  if (delta > Math.PI) {
    delta = TAU - delta
    mid = a - delta / 2
  }
  const depth = (1 - delta / Math.PI) ** 2 * 0.92
  return { x: cx + Math.cos(mid) * r * depth, y: cy + Math.sin(mid) * r * depth }
}

/** A chord as one closed ribbon: its two ends on the rim, bent towards the middle. */
export function ribbonPath(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  r: number,
  aMid: number,
  aHalf: number,
  bMid: number,
  bHalf: number,
): void {
  const a0 = aMid - aHalf
  const a1 = aMid + aHalf
  const b0 = bMid - bHalf
  const b1 = bMid + bHalf
  const bend = chordBend(cx, cy, r, aMid, bMid)
  ctx.moveTo(cx + Math.cos(a0) * r, cy + Math.sin(a0) * r)
  arcCurve(ctx, cx, cy, r, a0, a1)
  ctx.quadraticCurveTo(bend.x, bend.y, cx + Math.cos(b0) * r, cy + Math.sin(b0) * r)
  arcCurve(ctx, cx, cy, r, b0, b1)
  ctx.quadraticCurveTo(bend.x, bend.y, cx + Math.cos(a0) * r, cy + Math.sin(a0) * r)
  ctx.closePath()
}

/** What is lit: a section and its partners, one chord, or nothing. */
export interface CircleFocus {
  /** The section the pointer is on, or `-1`. */
  unit: number
  /** The chord (drawn-order slot) the pointer is on, or `-1`. */
  slot: number
  /** A genome band's group, or `-1`. */
  group: number
}

export const NO_FOCUS: CircleFocus = { unit: -1, slot: -1, group: -1 }

/** The colour a chord of this strength is drawn in. */
export function chordColour(colormap: string, strength: number): string {
  // The bottom of most ramps is paper, and a chord in paper is no chord: the
  // weakest drawn starts a sixth of the way up, where every ramp has some ink.
  return colormapCss(colormap, 0.16 + 0.84 * clamp(strength, 0, 1))
}

/**
 * How opaque a chord of this strength is drawn, with nothing lit.
 *
 * Steeper than the colour: ribbons overlap, and a thousand at half opacity add
 * up to a solid disc whatever their colours. The faint ones are there to be
 * seen as a texture, the strong ones as lines.
 */
export function chordAlpha(strength: number): number {
  return 0.05 + 0.85 * clamp(strength, 0, 1) ** 1.6
}

export interface ChordPaint {
  model: CircleModel
  geometry: CircleGeometry
  chords: ChordLayout
  colormap: string
  focus: CircleFocus
}

/** Which drawn chords touch a section: a partner set, read off the draw order. */
export function chordsOfUnit(model: CircleModel, chords: ChordLayout, unit: number): number[] {
  const out: number[] = []
  for (let slot = 0; slot < chords.drawn; slot++) {
    const chord = model.chords[chords.order[slot]]
    if (chord.a === unit || chord.b === unit) out.push(slot)
  }
  return out
}

/** Which drawn chords touch any section of a genome band group. */
function chordsOfGroup(model: CircleModel, chords: ChordLayout, group: CircleGroup): number[] {
  const out: number[] = []
  for (let slot = 0; slot < chords.drawn; slot++) {
    const chord = model.chords[chords.order[slot]]
    const a = chord.a >= group.from && chord.a < group.to
    const b = chord.b >= group.from && chord.b < group.to
    if (a !== b) out.push(slot)
  }
  return out
}

/**
 * The chords, weakest first so the strongest stay on top.
 *
 * With something lit, the chords that do not touch it fall back to a breath of
 * ink — still there, so the shape of the whole is not lost under the hand —
 * and the ones that do are drawn at full strength over them.
 */
export function paintChords(ctx: CanvasRenderingContext2D, paint: ChordPaint): void {
  const { model, geometry, chords, focus } = paint
  const { cx, cy } = geometry
  const r = geometry.chord
  const lit = litChords(model, chords, focus)
  const draw = (slot: number, alpha: number): void => {
    const at = slot * 4
    ctx.beginPath()
    ribbonPath(ctx, cx, cy, r, chords.ends[at], chords.ends[at + 1], chords.ends[at + 2], chords.ends[at + 3])
    ctx.globalAlpha = alpha
    ctx.fillStyle = chordColour(paint.colormap, chords.strength[slot])
    ctx.fill()
  }
  for (let slot = 0; slot < chords.drawn; slot++) {
    const strength = chords.strength[slot]
    if (lit === null) draw(slot, chordAlpha(strength))
    else if (!lit.has(slot)) draw(slot, 0.035)
  }
  if (lit !== null) {
    for (let slot = 0; slot < chords.drawn; slot++) {
      if (lit.has(slot)) draw(slot, 0.3 + 0.65 * chords.strength[slot])
    }
  }
  ctx.globalAlpha = 1
}

/** The drawn-order slots a focus lights, or `null` for no focus at all. */
export function litChords(model: CircleModel, chords: ChordLayout, focus: CircleFocus): Set<number> | null {
  if (focus.slot >= 0) return new Set([focus.slot])
  if (focus.unit >= 0) return new Set(chordsOfUnit(model, chords, focus.unit))
  if (focus.group >= 0 && model.groups !== null) {
    const group = model.groups[focus.group]
    return group === undefined ? null : new Set(chordsOfGroup(model, chords, group))
  }
  return null
}

/**
 * Each section's weight against the focus: its contacts with the lit section,
 * on `[0, 1]` against the strongest of them — what the partners are tinted by.
 *
 * Read off the model's chords rather than off the drawn ones, so a partner
 * whose chord fell below the drawing limit is still lit for what it is.
 */
export function partnerWeights(model: CircleModel, focus: CircleFocus): Float64Array | null {
  const n = model.units.length
  if (focus.unit < 0 && focus.group < 0) return null
  const weights = new Float64Array(n)
  const inGroup = (unit: number): boolean => {
    if (focus.group < 0 || model.groups === null) return unit === focus.unit
    const group = model.groups[focus.group]
    return group !== undefined && unit >= group.from && unit < group.to
  }
  for (const chord of model.chords) {
    const a = inGroup(chord.a)
    const b = inGroup(chord.b)
    if (a === b) continue
    weights[a ? chord.b : chord.a] += chord.weight
  }
  return weights
}

export interface SectionPaint {
  model: CircleModel
  geometry: CircleGeometry
  palette: CirclePalette
  focus: CircleFocus
  /** The drawn chords, which is how a lit chord names its two sections. */
  chords: ChordLayout | null
  colormap: string
  /** The transform the partner weights are tinted through. */
  transform: Transform
}

/** At most this many partners of a lit section are named, with their contacts. */
export const NAMED_PARTNERS = 12

/**
 * What a focus makes prominent: the sections it lights, and the partners strong
 * enough to be named — those with a tenth or more of the strongest partner's
 * contacts, a dozen at most.
 *
 * A tenth, because every genome of a metagenome shares *some* contacts with
 * every other: lit by that alone, a hover painted the whole ring and named
 * forty-seven genomes beside numbers too small to mean anything, which is the
 * question the hover exists to answer drowned by its own answer.
 */
export interface Emphasis {
  /** Whether anything is lit at all. */
  active: boolean
  /** The sections in the accent: the one hovered, a genome's contigs, a chord's two ends. */
  lit: ReadonlySet<number>
  /** The partners worth naming, with their contacts with the lit sections. */
  partners: ReadonlyMap<number, number>
  /** The strongest partner's contacts, which the tint is measured against. */
  strongest: number
}

export function emphasisOf(model: CircleModel, chords: ChordLayout | null, focus: CircleFocus): Emphasis {
  const lit = new Set<number>()
  if (focus.slot >= 0 && chords !== null) {
    const chord = model.chords[chords.order[focus.slot] ?? -1]
    if (chord !== undefined) {
      lit.add(chord.a)
      lit.add(chord.b)
    }
    return { active: lit.size > 0, lit, partners: new Map(), strongest: 0 }
  }
  if (focus.unit >= 0) lit.add(focus.unit)
  if (focus.group >= 0 && model.groups !== null) {
    const group = model.groups[focus.group]
    if (group !== undefined) for (let unit = group.from; unit < group.to; unit++) lit.add(unit)
  }
  const weights = partnerWeights(model, focus)
  const partners = new Map<number, number>()
  let strongest = 0
  if (weights !== null) {
    for (const weight of weights) strongest = Math.max(strongest, weight)
    const ranked = [...weights.keys()]
      .filter((unit) => weights[unit] > 0 && weights[unit] >= strongest / 10)
      .sort((x, y) => weights[y] - weights[x])
      .slice(0, NAMED_PARTNERS)
    for (const unit of ranked) partners.set(unit, weights[unit])
  }
  return { active: lit.size > 0, lit, partners, strongest }
}

/**
 * The sections, the genome band and their labels.
 *
 * Two inks in alternation, as an ideogram alternates its bands: a section is
 * told from its neighbour by the step, and nothing in the ring is spending a
 * hue on identity that the chords and the rings need for value. Lit, a section
 * takes the accent and its strong partners the chord ramp at their weight — the
 * strongest partner the darkest — and every other section steps back.
 */
export function paintSections(ctx: CanvasRenderingContext2D, paint: SectionPaint): void {
  const { model, geometry, palette } = paint
  const { cx, cy } = geometry
  const emphasis = emphasisOf(model, paint.chords, paint.focus)
  const tint = (weight: number): number => {
    if (!(emphasis.strongest > 0) || !(weight > 0)) return 0
    const t = transformValue(weight, paint.transform) / transformValue(emphasis.strongest, paint.transform)
    return Number.isFinite(t) ? clamp(t, 0, 1) : 0
  }
  const n = model.units.length
  for (let i = 0; i < n; i++) {
    const a0 = geometry.arcs[2 * i]
    const a1 = geometry.arcs[2 * i + 1]
    if (!(a1 > a0)) continue
    ctx.beginPath()
    annulusPath(ctx, cx, cy, geometry.sections.inner, geometry.sections.outer, a0, a1)
    let colour: string = palette.sections[i % 2]
    let alpha = 1
    if (emphasis.active) {
      const partner = emphasis.partners.get(i)
      if (emphasis.lit.has(i)) colour = palette.accent
      else if (partner !== undefined) colour = chordColour(paint.colormap, 0.3 + 0.7 * tint(partner))
      else alpha = 0.3
    }
    ctx.globalAlpha = alpha
    ctx.fillStyle = colour
    ctx.fill()
  }
  ctx.globalAlpha = 1

  // The genome band: one arc per genome over its contigs, in the same two inks.
  const band = geometry.band
  const groupArcs = geometry.groupArcs
  if (band !== null && groupArcs !== null && model.groups !== null) {
    model.groups.forEach((group, g) => {
      ctx.beginPath()
      annulusPath(ctx, cx, cy, band.inner, band.outer, groupArcs[2 * g], groupArcs[2 * g + 1])
      const lit = groupLit(group, emphasis)
      ctx.globalAlpha = emphasis.active && !lit ? 0.35 : 1
      ctx.fillStyle = lit ? palette.accent : palette.sections[g % 2]
      ctx.fill()
    })
    ctx.globalAlpha = 1
  }
}

/** Whether any section of a genome band group is lit. */
function groupLit(group: CircleGroup, emphasis: Emphasis): boolean {
  for (let unit = group.from; unit < group.to; unit++) if (emphasis.lit.has(unit)) return true
  return false
}

/**
 * The names round the outside, radially, reading outwards — turned over on the
 * left half so no name is ever upside down — and cut with an ellipsis where a
 * name is longer than the room the picture keeps for names.
 *
 * Only where an arc is wide enough to hold a line of text, which on a circle of
 * a few dozen genomes is all of them and on a contig circle is the genome band's
 * names instead. Lit, the focus and its strong partners are named whatever
 * their width, each partner with its contacts — the weights the hover is for —
 * and the rest step back.
 */
export function paintLabels(
  ctx: CanvasRenderingContext2D,
  paint: SectionPaint & { font: string; boldFont: string },
): void {
  const { model, geometry, palette } = paint
  const emphasis = emphasisOf(model, paint.chords, paint.focus)
  const room = Math.max(24, geometry.outer - geometry.labelAt)
  const fontPx = fontPixels(paint.font)
  ctx.textBaseline = 'middle'
  // A name too long for the room loses its middle, so the two ends that tell
  // `metator_00002_00004` from its siblings both stay.
  const drawLabel = (angle: number, name: string, colour: string, font: string): void => {
    const flip = isLeftHalf(angle)
    ctx.save()
    ctx.translate(geometry.cx, geometry.cy)
    ctx.rotate(flip ? angle + Math.PI : angle)
    ctx.font = font
    ctx.textAlign = flip ? 'right' : 'left'
    const x = flip ? -geometry.labelAt : geometry.labelAt
    const shown = fitText(ctx, name, room)
    ctx.lineWidth = 3
    ctx.lineJoin = 'round'
    ctx.strokeStyle = palette.halo
    ctx.strokeText(shown, x, 0)
    ctx.fillStyle = colour
    ctx.fillText(shown, x, 0)
    ctx.restore()
  }

  // Each name covers the angle its line of text spans where the names start,
  // and one that would land on a name already placed is left out — what is lit
  // first, with its genome, then its partners from the strongest, then the
  // names drawn at rest. On a circle of contigs a section's partners are mostly
  // the contigs beside it, and named all at once they were one smudge; now the
  // strongest is named and the tooltip lists the others. At rest the names are
  // the ones whose arcs hold a line, which are already that far apart.
  const taken: number[] = []
  const gap = (fontPx * 1.1) / Math.max(1, geometry.labelAt)
  const place = (angle: number): boolean => {
    for (const other of taken) if (angularDistance(angle, other) < gap) return false
    taken.push(angle)
    return true
  }
  // No room kept, no names — not even on hover (see `CircleGeometry.names`).
  const name = (angle: number, text: string, colour: string, font: string): void => {
    if (geometry.names && place(angle)) drawLabel(angle, text, colour, font)
  }

  // What is lit first: a section by its own name — a group's lit contigs are
  // named by the band, and their own names would be a second ring of labels
  // over the first — and the genome it is in by the band's.
  const groupArcs = model.groups === null ? null : geometry.groupArcs
  const groupAngle = (g: number): number => (groupArcs === null ? 0 : (groupArcs[2 * g] + groupArcs[2 * g + 1]) / 2)
  if (model.groups === null || paint.focus.group < 0) {
    for (const unit of emphasis.lit) name(midAngle(geometry, unit), model.units[unit].label, palette.text, paint.boldFont)
  }
  const litGroups = new Set<number>()
  if (model.groups !== null && groupArcs !== null) {
    model.groups.forEach((group, g) => {
      if (!groupLit(group, emphasis)) return
      litGroups.add(g)
      name(groupAngle(g), group.name, palette.text, paint.boldFont)
    })
  }
  // Then its partners, from the strongest.
  const partners = [...emphasis.partners].sort((a, b) => b[1] - a[1])
  for (const [unit] of partners) name(midAngle(geometry, unit), model.units[unit].label, palette.text, paint.font)

  // Then whatever is named at rest.
  if (model.groups !== null && groupArcs !== null) {
    model.groups.forEach((group, g) => {
      if (litGroups.has(g) || geometry.groupLabelled?.[g] !== 1) return
      name(groupAngle(g), group.name, emphasis.active ? palette.dim : palette.text, paint.font)
    })
  } else {
    // Sections are named where there is no band and their arcs hold a line.
    for (let i = 0; i < model.units.length; i++) {
      if (geometry.labelled[i] !== 1 || emphasis.lit.has(i) || emphasis.partners.has(i)) continue
      name(midAngle(geometry, i), model.units[i].label, emphasis.active ? palette.dim : palette.text, paint.font)
    }
  }

  // Each strong partner's contacts with the lit section, where its chord lands:
  // the eye follows a chord to its end and finds the number there, and the
  // names round the outside keep their whole width. Strongest first, and none
  // over another, for the names' reason.
  if (partners.length > 0) {
    ctx.save()
    ctx.font = paint.boldFont
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.lineJoin = 'round'
    const r = Math.max(0, geometry.chord - 14)
    const boxes: Array<{ x0: number; y0: number; x1: number; y1: number }> = []
    for (const [unit, weight] of partners) {
      const angle = midAngle(geometry, unit)
      const x = geometry.cx + Math.cos(angle) * r
      const y = geometry.cy + Math.sin(angle) * r
      const text = formatCount(weight)
      const half = ctx.measureText(text).width / 2 + 2
      const box = { x0: x - half, y0: y - fontPx / 2 - 1, x1: x + half, y1: y + fontPx / 2 + 1 }
      if (boxes.some((other) => box.x0 < other.x1 && other.x0 < box.x1 && box.y0 < other.y1 && other.y0 < box.y1)) continue
      boxes.push(box)
      ctx.lineWidth = 4
      ctx.strokeStyle = palette.halo
      ctx.strokeText(text, x, y)
      ctx.fillStyle = palette.text
      ctx.fillText(text, x, y)
    }
    ctx.restore()
  }
}

/** The angle between two directions, the short way round: `[0, π]`. */
function angularDistance(a: number, b: number): number {
  const d = (((a - b) % TAU) + TAU) % TAU
  return d > Math.PI ? TAU - d : d
}

/** A canvas font's size in pixels: `600 13.5px system-ui` → 13.5. */
export function fontPixels(font: string): number {
  const match = /(\d+(?:\.\d+)?)px/.exec(font)
  return match === null ? 11 : Number(match[1])
}

/**
 * A name cut to `room` pixels: its middle replaced by an ellipsis, as many
 * characters kept at each end as fit.
 */
export function fitText(ctx: Pick<CanvasRenderingContext2D, 'measureText'>, text: string, room: number): string {
  if (ctx.measureText(text).width <= room) return text
  const cut = (keep: number): string => {
    const head = Math.ceil(keep / 2)
    return `${text.slice(0, head)}…${text.slice(text.length - (keep - head))}`
  }
  let low = 0
  let high = text.length - 1
  while (low < high) {
    const mid = (low + high + 1) >> 1
    if (ctx.measureText(cut(mid)).width <= room) low = mid
    else high = mid - 1
  }
  return low === 0 ? '…' : cut(low)
}

function isLeftHalf(angle: number): boolean {
  const a = ((angle % TAU) + TAU) % TAU
  return a > Math.PI / 2 && a < (3 * Math.PI) / 2
}

// ---------------------------------------------------------------------------
// Hit testing
// ---------------------------------------------------------------------------

/** The section an angle falls in, or `-1` in a gap. */
export function unitAtAngle(geometry: CircleGeometry, angle: number): number {
  const arcs = geometry.arcs
  const n = arcs.length / 2
  if (n === 0) return -1
  // Into the turn the arcs are laid out in, which starts just past twelve.
  let a = angle
  const start = arcs[0]
  while (a < start) a += TAU
  while (a >= start + TAU) a -= TAU
  let low = 0
  let high = n - 1
  while (low <= high) {
    const mid = (low + high) >> 1
    if (a < arcs[2 * mid]) high = mid - 1
    else if (a > arcs[2 * mid + 1]) low = mid + 1
    else return mid
  }
  return -1
}

/** The genome band group an angle falls in, or `-1`. */
export function groupAtAngle(geometry: CircleGeometry, model: CircleModel, angle: number): number {
  if (model.groups === null || geometry.groupArcs === null) return -1
  const unit = unitAtAngle(geometry, angle)
  if (unit >= 0) return model.groups.findIndex((group) => unit >= group.from && unit < group.to)
  // In a gap between two contigs of one genome, the band is still that genome.
  const arcs = geometry.groupArcs
  let a = angle
  while (a < geometry.arcs[0]) a += TAU
  for (let g = 0; g < arcs.length / 2; g++) if (a >= arcs[2 * g] && a <= arcs[2 * g + 1]) return g
  return -1
}

/**
 * What is under a point of the picture.
 *
 * By radius first — a band of the picture is one kind of thing all the way
 * round — then by angle. A label is its section: pointing at a name is
 * pointing at what it names, as an axis label of the square is.
 */
export function hitCircle(
  geometry: CircleGeometry,
  model: CircleModel,
  chords: ChordLayout | null,
  x: number,
  y: number,
): CircleHit | null {
  const dx = x - geometry.cx
  const dy = y - geometry.cy
  const r = Math.hypot(dx, dy)
  const angle = Math.atan2(dy, dx)
  if (r > geometry.outer + 4) return null
  if (geometry.band !== null && r >= geometry.band.inner - 1 && r <= geometry.labelAt + 1) {
    const group = groupAtAngle(geometry, model, angle)
    return group < 0 ? null : { kind: 'group', group }
  }
  if (r >= geometry.sections.inner - 1) {
    if (r > geometry.labelAt && model.groups !== null) {
      const group = groupAtAngle(geometry, model, angle)
      return group < 0 ? null : { kind: 'group', group }
    }
    const unit = unitAtAngle(geometry, angle)
    return unit < 0 ? null : { kind: 'section', unit }
  }
  for (let k = 0; k < geometry.rings.length; k++) {
    const ring = geometry.rings[k]
    if (r >= ring.inner - 2 && r <= ring.outer + 2) {
      const unit = unitAtAngle(geometry, angle)
      return unit < 0 ? null : { kind: 'ring', ring: k, unit, angle }
    }
  }
  if (chords !== null && r <= geometry.chord) {
    // The strongest first: it is the one drawn on top.
    for (let slot = chords.drawn - 1; slot >= 0; slot--) {
      if (insideRibbon(geometry, chords, slot, x, y)) return { kind: 'chord', slot }
    }
  }
  return null
}

/**
 * Whether a point is inside one drawn ribbon.
 *
 * The ribbon flattened to a polygon — its two rim arcs and the two quadratics
 * through the middle, sixteen points a side — and the even-odd rule. Exact to
 * well under a pixel at any size the picture is drawn at, and needs no canvas,
 * so the same test runs in the suite.
 */
export function insideRibbon(
  geometry: CircleGeometry,
  chords: ChordLayout,
  slot: number,
  x: number,
  y: number,
): boolean {
  const { cx, cy } = geometry
  const r = geometry.chord
  const at = slot * 4
  const aMid = chords.ends[at]
  const aHalf = chords.ends[at + 1]
  const bMid = chords.ends[at + 2]
  const bHalf = chords.ends[at + 3]
  const points: number[] = []
  const bend = chordBend(cx, cy, r, aMid, bMid)
  const rim = (from: number, to: number): void => {
    for (let k = 0; k <= 4; k++) {
      const a = from + ((to - from) * k) / 4
      points.push(cx + Math.cos(a) * r, cy + Math.sin(a) * r)
    }
  }
  const through = (from: number, to: number): void => {
    const x0 = cx + Math.cos(from) * r
    const y0 = cy + Math.sin(from) * r
    const x1 = cx + Math.cos(to) * r
    const y1 = cy + Math.sin(to) * r
    for (let k = 1; k < 16; k++) {
      const t = k / 16
      const u = 1 - t
      points.push(u * u * x0 + 2 * u * t * bend.x + t * t * x1, u * u * y0 + 2 * u * t * bend.y + t * t * y1)
    }
  }
  rim(aMid - aHalf, aMid + aHalf)
  through(aMid + aHalf, bMid - bHalf)
  rim(bMid - bHalf, bMid + bHalf)
  through(bMid + bHalf, aMid - aHalf)
  let inside = false
  const m = points.length / 2
  for (let i = 0, j = m - 1; i < m; j = i++) {
    const xi = points[2 * i]
    const yi = points[2 * i + 1]
    const xj = points[2 * j]
    const yj = points[2 * j + 1]
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside
  }
  return inside
}
