/**
 * The map drawn as two lines (§7.6): a metagenome's genomes split in two by a
 * column of the Genomes table — one level's genomes side by side along a line at
 * the top, the other's along a line at the bottom — the contacts between a
 * genome of one line and a genome of the other as ribbons across the middle,
 * and the tracks as lanes, above the top line and below the bottom one.
 *
 * **The circle cut in two and laid flat**: the same sections — genomes, or
 * contigs under their genome's band — as long as they are in base pairs, the
 * same weights, and only the chords that cross. Each line is as wide as the
 * picture, so a line of five genomes is read as easily as a line of forty; a
 * section's length is its share of its own line. Everything here is arithmetic
 * and drawing over the circle's own model (`render/circle.ts`) and its rings'
 * bins (`render/circleRings.ts`), laid along x rather than round an angle, so
 * the picture goes into a canvas or a vector page alike.
 */

import type { MatrixResult } from '../worker/protocol'
import type { Transform } from '../types'
import { LABEL_MIN_SPAN_BP } from '../constants'
import { colormapCss } from './colormaps'
import { categoryColour } from './meta'
import { formatCount } from './legend'
import { transformValue } from './scale'
import {
  CHORD_CAP,
  chordAlpha,
  chordColour,
  chordStrengths,
  circleUnitsOf,
  emphasisOf,
  fitText,
  fontPixels,
  groupsOf,
  litChords,
  modelOfUnits,
  namePolicy,
  ringThickness,
  type ChordLayout,
  type ChordStyle,
  type CircleCut,
  type CircleFocus,
  type CircleGroup,
  type CircleModel,
  type CircleNames,
  type CirclePalette,
  type CircleResolver,
  type CircleUnit,
  type DropSide,
  type Emphasis,
} from './circle'
import type { CircleBins, RingInk, RingPaint } from './circleRings'

// ---------------------------------------------------------------------------
// The model
// ---------------------------------------------------------------------------

/** The circle's model of the sections on a line, with which line each is on. */
export interface LinesModel {
  /** Only the sections on a line, in the block's order; only the chords between the two lines. */
  model: CircleModel
  /** Each section's line: 0 the top, 1 the bottom. */
  side: Uint8Array
  /** How many genomes in the block have no line — no value in the column — and are left out. */
  leftOut: number
}

/**
 * The sections of a block on two lines: each where `lineOf` puts it, one with
 * no line left out — of the picture, and of every contact it would have added —
 * and a chord only between a section of one line and a section of the other.
 * `null` where the block is no circle, or where either line would be empty:
 * one genome's contigs, a selection all of one level.
 */
export function linesModelOf(
  data: MatrixResult,
  lineOf: (unit: CircleUnit) => -1 | 0 | 1,
  resolver: CircleResolver = {},
  bpPerCell = 1,
  cut: CircleCut = 'genomes',
  cap = CHORD_CAP,
): LinesModel | null {
  const found = circleUnitsOf(data, resolver, bpPerCell, cut)
  if (found === null) return null
  const units: CircleUnit[] = []
  const sides: number[] = []
  const out = new Set<string>()
  for (const unit of found.units) {
    const line = lineOf(unit)
    if (line < 0) {
      out.add(unit.kind === 'genome' ? unit.name : (unit.genome ?? unit.name))
      continue
    }
    units.push(unit)
    sides.push(line)
  }
  if (!sides.includes(0) || !sides.includes(1)) return null
  const side = Uint8Array.from(sides)
  const groups = found.kind === 'contig' && found.groups !== null ? groupsOf(units) : null
  const model = modelOfUnits(data, { units, kind: found.kind, groups }, cap, (a, b) => side[a] !== side[b])
  return { model, side, leftOut: out.size }
}

// ---------------------------------------------------------------------------
// The layout
// ---------------------------------------------------------------------------

/** One line's rows, from the ribbons outwards. */
export interface LineRows {
  sections: { y0: number; y1: number }
  /** The genome band over contig sections, on the far side of them from the ribbons; `null` without one. */
  band: { y0: number; y1: number } | null
  /** Where the line's names start, on the far side of its lanes: upwards from it on the top line, downwards on the bottom. */
  labelAt: number
}

export interface LinesGeometry {
  width: number
  height: number
  /** The lines' two ends; the column of titles, the lanes' names and the key is left of `x0`. */
  x0: number
  x1: number
  /** Each section's `[x0, x1]` along its line, in the model's order: the circle's arcs, laid flat. */
  arcs: Float64Array
  /** The genome band's `[x0, x1]` per group, where contigs are grouped. */
  groupArcs: Float64Array | null
  /** Each section's line. */
  side: Uint8Array
  /** Each line's sections, left to right. */
  members: [Int32Array, Int32Array]
  /** Each group's line, where there are groups. */
  groupSide: Uint8Array | null
  /** The top line's rows, then the bottom's. */
  rows: [LineRows, LineRows]
  /**
   * Each lane on each line, in the Tracks card's order — the first nearest its
   * line, as a lane's first track is nearest its map — `rows[0]` above the top
   * line and `rows[1]` below the bottom one.
   */
  lanes: Array<{ id: string; rows: [{ y0: number; y1: number }, { y0: number; y1: number }] }>
  /** The depth one line's lanes share, which *stretch* fills. */
  laneRoom: number
  /** From the top line's sections down to the bottom line's. */
  ribbons: { y0: number; y1: number }
  /** Whether the picture keeps room for names; see {@link CircleGeometry.names}. */
  names: boolean
  /** Which sections are named at rest; on a banded picture, which groups. */
  labelled: Uint8Array
  groupLabelled: Uint8Array | null
  fontPx: number
}

export interface LinesLayoutOptions {
  width: number
  height: number
  /** Where the lines start: right of the column the view writes its titles, the lanes' names and the key in. */
  left: number
  lanes: readonly { id: string; size: number }[]
  /** The width of a name in the label font. */
  measure(text: string): number
  fontPx: number
  /** Whether sections are named at all: the Map card's `labels`, as for the circle. Absent is on. */
  names?: boolean
}

/** Pixels round the picture's edge. */
const EDGE = 8

/**
 * Lay two lines out in a box. Down the box: the top line's names, its lanes —
 * the last outermost — its genome band and its sections; the ribbons, given at
 * least three tenths of the height and whatever the lanes leave; then the bottom
 * line the other way up, its sections first. Across it, each line from `left`
 * to the right edge, its sections as long as their share of its base pairs,
 * with a gap between two and a wider one between two genomes' contigs.
 */
export function linesGeometry(lines: LinesModel, options: LinesLayoutOptions): LinesGeometry {
  const { model, side } = lines
  const { width, height, fontPx } = options
  const n = model.units.length
  const groups = model.groups
  const x0 = Math.min(Math.max(EDGE, width - 40), Math.max(EDGE, options.left))
  const x1 = Math.max(x0 + 20, width - EDGE - 4)
  const span = x1 - x0

  const members: [Int32Array, Int32Array] = [
    Int32Array.from(model.units.map((_, u) => u).filter((u) => side[u] === 0)),
    Int32Array.from(model.units.map((_, u) => u).filter((u) => side[u] === 1)),
  ]
  const groupSide = groups === null ? null : Uint8Array.from(groups.map((group) => side[group.from]))
  const startsGroup = (unit: number): boolean => groups !== null && groups.some((group) => group.from === unit)

  // --- along the lines ---------------------------------------------------
  const arcs = new Float64Array(2 * n)
  for (const line of [0, 1] as const) {
    const mine = members[line]
    const count = mine.length
    if (count === 0) continue
    const lineGroups = groupSide === null ? 0 : groupSide.reduce((sum, at) => sum + (at === line ? 1 : 0), 0)
    // As the circle's: gaps that shrink with the count, two thousand gaps of a
    // few pixels being the whole line.
    const unitGap =
      model.kind === 'genome'
        ? Math.min(6, (0.15 * span) / count)
        : groups === null
          ? Math.min(3, (0.12 * span) / count)
          : Math.min(1.5, (0.04 * span) / count)
    const groupGap = groups === null ? 0 : Math.min(12, (0.12 * span) / Math.max(1, lineGroups))
    let gaps = 0
    for (let k = 1; k < count; k++) gaps += startsGroup(mine[k]) ? groupGap : unitGap
    const room = Math.max(0, span - gaps)
    let total = 0
    for (const u of mine) total += Math.max(0, model.units[u].bp)
    let x = x0
    mine.forEach((u, k) => {
      if (k > 0) x += startsGroup(u) ? groupGap : unitGap
      const w = total > 0 ? (room * Math.max(0, model.units[u].bp)) / total : room / count
      arcs[2 * u] = x
      arcs[2 * u + 1] = x + w
      x += w
    })
  }
  const groupArcs =
    groups === null ? null : Float64Array.from(groups.flatMap((group) => [arcs[2 * group.from], arcs[2 * group.to - 1]]))

  // --- the names -----------------------------------------------------------
  // The circle's rule (`namePolicy`), each name a vertical line of text beside
  // its section where the section is as wide as a line is tall; room only for
  // the names written at rest, and no more than a fifth of the height each.
  const policy: CircleNames = options.names === false ? 'none' : namePolicy(model)
  const named = (index: number): boolean =>
    policy === 'all' || (policy === 'long' && model.units[index].bp >= LABEL_MIN_SPAN_BP)
  const labelArcs = groupArcs ?? arcs
  const labels = groups === null ? model.units.map((unit) => unit.label) : groups.map((group) => group.name)
  const fits = (index: number): boolean =>
    named(index) && labelArcs[2 * index + 1] - labelArcs[2 * index] >= fontPx * 1.15
  const labelled = new Uint8Array(groups === null ? n : 0)
  const groupLabelled = groups === null ? null : new Uint8Array(groups.length)
  let labelWidth = 0
  labels.forEach((label, index) => {
    if (!fits(index)) return
    if (groupLabelled === null) labelled[index] = 1
    else groupLabelled[index] = 1
    labelWidth = Math.max(labelWidth, options.measure(label))
  })
  labelWidth = Math.min(labelWidth, Math.max(40, height / 5))
  const labelRoom = labelWidth > 0 ? labelWidth + 8 : 0

  // --- down the box ----------------------------------------------------------
  const bar = clamp(height * 0.022, 8, 14)
  const bandWidth = groups === null ? 0 : clamp(height * 0.014, 5, 9)
  const laneGap = 4
  const count = options.lanes.length
  const ribbonMin = Math.max(48, height * 0.3)
  const perLine = labelRoom + (bandWidth > 0 ? bandWidth + 2 : 0) + bar + (count > 0 ? 4 : 0)
  const laneRoom = Math.max(0, (height - 2 * EDGE - 2 * perLine - ribbonMin) / 2 - laneGap * Math.max(0, count - 1))
  const thickness = ringThickness(
    options.lanes.map((lane) => lane.size),
    laneRoom,
  )
  const lanes: LinesGeometry['lanes'] = options.lanes.map((lane) => ({
    id: lane.id,
    rows: [
      { y0: 0, y1: 0 },
      { y0: 0, y1: 0 },
    ],
  }))
  // The top line, from the top edge down: the last lane outermost.
  let y = EDGE + labelRoom
  const topLabelAt = y - 4
  for (let k = count - 1; k >= 0; k--) {
    lanes[k].rows[0] = { y0: y, y1: y + thickness[k] }
    y += thickness[k] + (k > 0 ? laneGap : 4)
  }
  const topBand = bandWidth > 0 ? { y0: y, y1: y + bandWidth } : null
  if (topBand !== null) y = topBand.y1 + 2
  const topSections = { y0: y, y1: y + bar }
  // The bottom line, from the bottom edge up.
  let yb = height - EDGE - labelRoom
  const bottomLabelAt = yb + 4
  for (let k = count - 1; k >= 0; k--) {
    lanes[k].rows[1] = { y0: yb - thickness[k], y1: yb }
    yb -= thickness[k] + (k > 0 ? laneGap : 4)
  }
  const bottomBand = bandWidth > 0 ? { y0: yb - bandWidth, y1: yb } : null
  if (bottomBand !== null) yb = bottomBand.y0 - 2
  const bottomSections = { y0: yb - bar, y1: yb }

  return {
    width,
    height,
    x0,
    x1,
    arcs,
    groupArcs,
    side,
    members,
    groupSide,
    rows: [
      { sections: topSections, band: topBand, labelAt: topLabelAt },
      { sections: bottomSections, band: bottomBand, labelAt: bottomLabelAt },
    ],
    lanes,
    laneRoom,
    ribbons: { y0: topSections.y1, y1: Math.max(topSections.y1 + 1, bottomSections.y0) },
    names: labelRoom > 0,
    labelled,
    groupLabelled,
    fontPx,
  }
}

/** The middle of a section, along its line. */
export function midX(geometry: Pick<LinesGeometry, 'arcs'>, unit: number): number {
  return (geometry.arcs[2 * unit] + geometry.arcs[2 * unit + 1]) / 2
}

// ---------------------------------------------------------------------------
// The ribbons
// ---------------------------------------------------------------------------

/** Half the narrowest a ribbon's end is drawn, in pixels: a hairline, whatever its section. */
const HAIRLINE = 0.35

/**
 * Seat every drawn ribbon's two ends on its sections — {@link layoutChords}'s
 * rule, laid along x: each section's ends side by side, ordered by where the
 * partner is along the other line, so the ribbons leave a section without
 * crossing at its foot; shared evenly, and overlapping, where the section is
 * too short to hold them side by side. `ends` are pixels along the lines, the
 * chord's `a` end then its `b` end, whichever line each is on.
 */
export function layoutRibbons(model: CircleModel, geometry: LinesGeometry, style: ChordStyle): ChordLayout {
  const drawn = Math.max(0, Math.min(model.chords.length, Number.isFinite(style.limit) ? style.limit : model.chords.length))
  const chords = model.chords.slice(0, drawn)
  const order = Int32Array.from({ length: drawn }, (_, i) => drawn - 1 - i)
  const { lo, hi, strengthOf } = chordStrengths(chords, style.transform)
  const widest = clamp((geometry.x1 - geometry.x0) * 0.02, 3, 22)
  const halfOf = (strength: number): number => (0.5 + (widest - 0.5) * strength ** 1.3) / 2

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
  const place = (unit: number, index: number, centre: number, half: number): void => {
    const chord = chords[index]
    const at = (drawn - 1 - index) * 4 + (chord.a === unit ? 0 : 2)
    ends[at] = centre
    ends[at + 1] = half
  }
  for (let unit = 0; unit < n; unit++) {
    const mine = perUnit[unit]
    if (mine.length === 0) continue
    const x0 = geometry.arcs[2 * unit]
    const x1 = geometry.arcs[2 * unit + 1]
    const partnerX = (index: number): number => {
      const chord = chords[index]
      return midX(geometry, chord.a === unit ? chord.b : chord.a)
    }
    mine.sort((a, b) => partnerX(a) - partnerX(b))
    const span = Math.max(0, x1 - x0)
    const inset = Math.min(span * 0.08, 1.5)
    const usable = Math.max(0, span - 2 * inset)
    const halves = mine.map((index) => Math.max(HAIRLINE, Math.min(halfOf(strength[index]), usable / 2)))
    const need = halves.reduce((sum, half) => sum + 2 * half, 0)
    if (need <= usable) {
      const slack = (usable - need) / (mine.length + 1)
      let at = x0 + inset + slack
      mine.forEach((index, k) => {
        place(unit, index, at + halves[k], halves[k])
        at += 2 * halves[k] + slack
      })
    } else {
      mine.forEach((index, k) => place(unit, index, x0 + inset + ((k + 0.5) * usable) / mine.length, halves[k]))
    }
  }
  const ordered = new Float32Array(drawn)
  for (let k = 0; k < drawn; k++) ordered[k] = strength[order[k]]
  return { order, ends, strength: ordered, range: { lo, hi }, drawn }
}

/** A drawn ribbon's two ends, the top line's first: `[top centre, top half, bottom centre, bottom half]`. */
function ribbonEnds(lines: LinesModel, ribbons: ChordLayout, slot: number): [number, number, number, number] {
  const chord = lines.model.chords[ribbons.order[slot]]
  const at = slot * 4
  const e = ribbons.ends
  return lines.side[chord.a] === 0
    ? [e[at], e[at + 1], e[at + 2], e[at + 3]]
    : [e[at + 2], e[at + 3], e[at], e[at + 1]]
}

/**
 * A ribbon as one closed shape: its end on the top line, a curve down each side
 * to its end on the bottom line — each side a cubic leaving its line straight
 * down and arriving straight down, so a ribbon between two sections one above
 * the other is a band, and one across the picture an S.
 */
export function ribbonPathFlat(
  ctx: CanvasRenderingContext2D,
  y0: number,
  y1: number,
  ends: readonly [number, number, number, number],
): void {
  const [top, topHalf, bottom, bottomHalf] = ends
  const ym = (y0 + y1) / 2
  ctx.moveTo(top - topHalf, y0)
  ctx.lineTo(top + topHalf, y0)
  ctx.bezierCurveTo(top + topHalf, ym, bottom + bottomHalf, ym, bottom + bottomHalf, y1)
  ctx.lineTo(bottom - bottomHalf, y1)
  ctx.bezierCurveTo(bottom - bottomHalf, ym, top - topHalf, ym, top - topHalf, y0)
  ctx.closePath()
}

/**
 * Whether a point is inside one drawn ribbon. Both sides share their curve's
 * height, so one `t` gives the height's two edges: the ribbon's width there.
 */
export function insideRibbonFlat(
  geometry: LinesGeometry,
  ends: readonly [number, number, number, number],
  x: number,
  y: number,
): boolean {
  const { y0, y1 } = geometry.ribbons
  if (!(y > y0 && y < y1)) return false
  const ym = (y0 + y1) / 2
  // y(t) is monotonic between y0 and y1: halve until it is found.
  let lo = 0
  let hi = 1
  for (let k = 0; k < 24; k++) {
    const t = (lo + hi) / 2
    if (cubic(y0, ym, ym, y1, t) < y) lo = t
    else hi = t
  }
  const t = (lo + hi) / 2
  const [top, topHalf, bottom, bottomHalf] = ends
  const left = cubic(top - topHalf, top - topHalf, bottom - bottomHalf, bottom - bottomHalf, t)
  const right = cubic(top + topHalf, top + topHalf, bottom + bottomHalf, bottom + bottomHalf, t)
  // A hairline ribbon is still a pixel to point at.
  const slack = Math.max(0, 0.75 - (right - left) / 2)
  return x >= left - slack && x <= right + slack
}

function cubic(p0: number, p1: number, p2: number, p3: number, t: number): number {
  const u = 1 - t
  return u * u * u * p0 + 3 * u * u * t * p1 + 3 * u * t * t * p2 + t * t * t * p3
}

// ---------------------------------------------------------------------------
// Painting
// ---------------------------------------------------------------------------

export interface LinesPaint {
  lines: LinesModel
  geometry: LinesGeometry
  ribbons: ChordLayout
  palette: CirclePalette
  focus: CircleFocus
  colormap: string
  /** The transform the partners are tinted through. */
  transform: Transform
}

/**
 * The ribbons, weakest first so the strongest stay on top — and, with
 * something lit, the rest a breath of ink under the ones that touch it, as the
 * circle's chords are (`paintChords`).
 */
export function paintRibbons(ctx: CanvasRenderingContext2D, paint: LinesPaint): void {
  const { lines, geometry, ribbons } = paint
  const { y0, y1 } = geometry.ribbons
  const lit = litChords(lines.model, ribbons, paint.focus)
  const draw = (slot: number, alpha: number): void => {
    ctx.beginPath()
    ribbonPathFlat(ctx, y0, y1, ribbonEnds(lines, ribbons, slot))
    ctx.globalAlpha = alpha
    ctx.fillStyle = chordColour(paint.colormap, ribbons.strength[slot])
    ctx.fill()
  }
  for (let slot = 0; slot < ribbons.drawn; slot++) {
    if (lit === null) draw(slot, chordAlpha(ribbons.strength[slot]))
    else if (!lit.has(slot)) draw(slot, 0.035)
  }
  if (lit !== null) {
    for (let slot = 0; slot < ribbons.drawn; slot++) {
      if (lit.has(slot)) draw(slot, 0.3 + 0.65 * ribbons.strength[slot])
    }
  }
  ctx.globalAlpha = 1
}

/**
 * The sections and the genome band, in the circle's two inks and its emphasis
 * (`paintSections`): lit, the accent; a strong partner, the ribbons' ramp at
 * its weight; the rest stepped back.
 */
export function paintLineSections(ctx: CanvasRenderingContext2D, paint: LinesPaint): void {
  const { lines, geometry, palette } = paint
  const model = lines.model
  const emphasis = emphasisOf(model, paint.ribbons, paint.focus)
  const tint = (weight: number): number => {
    if (!(emphasis.strongest > 0) || !(weight > 0)) return 0
    const t = transformValue(weight, paint.transform) / transformValue(emphasis.strongest, paint.transform)
    return Number.isFinite(t) ? clamp(t, 0, 1) : 0
  }
  for (const line of [0, 1] as const) {
    const row = geometry.rows[line].sections
    geometry.members[line].forEach((u, k) => {
      const x0 = geometry.arcs[2 * u]
      const x1 = geometry.arcs[2 * u + 1]
      if (!(x1 > x0)) return
      let colour: string = palette.sections[k % 2]
      let alpha = 1
      if (emphasis.active) {
        const partner = emphasis.partners.get(u)
        if (emphasis.lit.has(u)) colour = palette.accent
        else if (partner !== undefined) colour = chordColour(paint.colormap, 0.3 + 0.7 * tint(partner))
        else alpha = 0.3
      }
      ctx.globalAlpha = alpha
      ctx.fillStyle = colour
      ctx.fillRect(x0, row.y0, x1 - x0, row.y1 - row.y0)
    })
  }
  ctx.globalAlpha = 1
  const groups = model.groups
  const groupArcs = geometry.groupArcs
  const groupSide = geometry.groupSide
  if (groups === null || groupArcs === null || groupSide === null) return
  const index = [0, 0]
  groups.forEach((group, g) => {
    const line = groupSide[g] as 0 | 1
    const band = geometry.rows[line].band
    if (band === null) return
    const lit = groupLit(group, emphasis)
    ctx.globalAlpha = emphasis.active && !lit ? 0.35 : 1
    ctx.fillStyle = lit ? palette.accent : palette.sections[index[line]++ % 2]
    ctx.fillRect(groupArcs[2 * g], band.y0, groupArcs[2 * g + 1] - groupArcs[2 * g], band.y1 - band.y0)
  })
  ctx.globalAlpha = 1
}

function groupLit(group: CircleGroup, emphasis: Emphasis): boolean {
  for (let unit = group.from; unit < group.to; unit++) if (emphasis.lit.has(unit)) return true
  return false
}

/**
 * The names beside each line, on the far side of its lanes: a vertical line of
 * text each, reading upwards, from the line out — and none over another. What
 * is lit first, then its partners from the strongest, each partner's contacts
 * written where its ribbons land; then the names written at rest. The circle's
 * order and its reasons (`paintLabels`).
 */
export function paintLineLabels(
  ctx: CanvasRenderingContext2D,
  paint: LinesPaint & { font: string; boldFont: string; room: number },
): void {
  const { lines, geometry, palette } = paint
  const model = lines.model
  if (!geometry.names) return
  const emphasis = emphasisOf(model, paint.ribbons, paint.focus)
  const fontPx = fontPixels(paint.font)
  const taken: [number[], number[]] = [[], []]
  const name = (line: 0 | 1, x: number, text: string, colour: string, font: string): void => {
    for (const other of taken[line]) if (Math.abs(other - x) < fontPx * 1.1) return
    taken[line].push(x)
    const at = geometry.rows[line].labelAt
    ctx.save()
    ctx.translate(x, at)
    ctx.rotate(-Math.PI / 2)
    ctx.font = font
    // Upwards from the top line, and on the bottom line ending at it: both read
    // from below, as the square's column names do.
    ctx.textAlign = line === 0 ? 'left' : 'right'
    ctx.textBaseline = 'middle'
    const shown = fitText(ctx, text, paint.room)
    ctx.lineWidth = 3
    ctx.lineJoin = 'round'
    ctx.strokeStyle = palette.halo
    ctx.strokeText(shown, 0, 0)
    ctx.fillStyle = colour
    ctx.fillText(shown, 0, 0)
    ctx.restore()
  }
  const lineOf = (unit: number): 0 | 1 => lines.side[unit] as 0 | 1
  const groups = model.groups
  const groupArcs = geometry.groupArcs
  const groupX = (g: number): number => (groupArcs === null ? 0 : (groupArcs[2 * g] + groupArcs[2 * g + 1]) / 2)
  if (groups === null || paint.focus.group < 0) {
    for (const unit of emphasis.lit) name(lineOf(unit), midX(geometry, unit), model.units[unit].label, palette.text, paint.boldFont)
  }
  const litGroups = new Set<number>()
  if (groups !== null) {
    groups.forEach((group, g) => {
      if (!groupLit(group, emphasis)) return
      litGroups.add(g)
      name(lineOf(group.from), groupX(g), group.name, palette.text, paint.boldFont)
    })
  }
  const partners = [...emphasis.partners].sort((a, b) => b[1] - a[1])
  for (const [unit] of partners) name(lineOf(unit), midX(geometry, unit), model.units[unit].label, palette.text, paint.font)
  if (groups !== null) {
    groups.forEach((group, g) => {
      if (litGroups.has(g) || geometry.groupLabelled?.[g] !== 1) return
      name(lineOf(group.from), groupX(g), group.name, emphasis.active ? palette.dim : palette.text, paint.font)
    })
  }
  for (let unit = 0; unit < model.units.length; unit++) {
    if (geometry.labelled[unit] !== 1 || emphasis.lit.has(unit) || emphasis.partners.has(unit)) continue
    name(lineOf(unit), midX(geometry, unit), model.units[unit].label, emphasis.active ? palette.dim : palette.text, paint.font)
  }

  // Each strong partner's contacts, just inside the ribbons where they land.
  if (partners.length === 0) return
  ctx.save()
  ctx.font = paint.boldFont
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.lineJoin = 'round'
  const boxes: Array<{ x0: number; y0: number; x1: number; y1: number }> = []
  for (const [unit, weight] of partners) {
    const x = midX(geometry, unit)
    const y = lineOf(unit) === 0 ? geometry.ribbons.y0 + fontPx : geometry.ribbons.y1 - fontPx
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

/** The lanes' own hairline, which an outline and a floor are drawn at — the rings'. */
const LANE_HAIRLINE = 0.75

/**
 * One track along one line, as its lane draws it beside a map: the wash under
 * each section, then its values in its own colour and mode — bars and areas
 * rising from the lane's floor (from its top, flipped), a line a line, a
 * heatmap filling the lane — categories as runs of their colours, features as
 * boxes at their own coordinates. `paintRing` laid flat, over the same bins.
 */
export function paintLane(
  ctx: CanvasRenderingContext2D,
  lane: RingPaint,
  rect: { y0: number; y1: number },
  line: 0 | 1,
  geometry: LinesGeometry,
  bins: CircleBins,
  wash: string | null,
  ink: RingInk,
  dim = false,
): void {
  const { y0, y1 } = rect
  const thick = y1 - y0
  if (!(thick > 0)) return
  const on = (unit: number): boolean => geometry.side[unit] === line
  const members = geometry.members[line]
  if (wash !== null) {
    ctx.globalAlpha = 1
    ctx.fillStyle = wash
    for (const u of members) ctx.fillRect(geometry.arcs[2 * u], y0, geometry.arcs[2 * u + 1] - geometry.arcs[2 * u], thick)
  }
  ctx.globalAlpha = Math.max(0.05, Math.min(1, lane.opacity)) * (dim ? 0.3 : 1)
  const content = lane.content
  const rule = (y: number, opacity: number, width: number): void => {
    ctx.save()
    ctx.globalAlpha = opacity * (dim ? 0.3 : 1)
    ctx.strokeStyle = ink.guide
    ctx.lineWidth = width
    ctx.beginPath()
    for (const u of members) {
      ctx.moveTo(geometry.arcs[2 * u], y)
      ctx.lineTo(geometry.arcs[2 * u + 1], y)
    }
    ctx.stroke()
    ctx.restore()
  }
  if (content.kind === 'values') {
    const { values, limits, mode, flip } = content
    const range = limits.max - limits.min
    const norm = (value: number): number => (range > 0 ? clamp((value - limits.min) / range, 0, 1) : 0)
    const zero = norm(clamp(0, limits.min, limits.max))
    const yOf = (t: number): number => (flip ? y0 + t * thick : y1 - t * thick)
    const drawn = (bin: number): boolean => on(bins.unit[bin]) && Number.isFinite(values.values[bin])
    const stroke = (): void => {
      ctx.strokeStyle = ink.outline ? ink.guide : lane.colour
      ctx.lineWidth = ink.outline ? LANE_HAIRLINE : mode === 'line' ? 1.25 : 1
      ctx.lineJoin = 'round'
    }
    const runs = (visit: (from: number, to: number) => void): void => {
      let bin = 0
      while (bin < bins.count) {
        if (!drawn(bin)) {
          bin++
          continue
        }
        let end = bin + 1
        while (end < bins.count && drawn(end) && bins.unit[end] === bins.unit[bin]) end++
        visit(bin, end)
        bin = end
      }
    }
    if (mode === 'heatmap') {
      for (let bin = 0; bin < bins.count; bin++) {
        if (!drawn(bin)) continue
        ctx.fillStyle = colormapCss(content.colormap, norm(values.values[bin]))
        ctx.fillRect(bins.a0[bin], y0, Math.max(0.5, bins.a1[bin] - bins.a0[bin]), thick)
      }
    } else if (mode === 'line') {
      stroke()
      runs((from, to) => {
        ctx.beginPath()
        for (let bin = from; bin < to; bin++) {
          const x = (bins.a0[bin] + bins.a1[bin]) / 2
          const y = yOf(norm(values.values[bin]))
          if (bin === from) ctx.moveTo(x, y)
          else ctx.lineTo(x, y)
        }
        ctx.stroke()
      })
    } else if (mode === 'points') {
      ctx.fillStyle = lane.colour
      for (let bin = 0; bin < bins.count; bin++) {
        if (!drawn(bin)) continue
        ctx.beginPath()
        ctx.arc((bins.a0[bin] + bins.a1[bin]) / 2, yOf(norm(values.values[bin])), 1.5, 0, Math.PI * 2)
        ctx.fill()
      }
    } else if (mode === 'bar') {
      ctx.fillStyle = lane.colour
      for (let bin = 0; bin < bins.count; bin++) {
        if (!drawn(bin)) continue
        const t = norm(values.values[bin])
        const ya = yOf(Math.min(zero, t))
        const yb = yOf(Math.max(zero, t))
        if (Math.abs(yb - ya) < 0.25) continue
        ctx.fillRect(bins.a0[bin], Math.min(ya, yb), Math.max(0.5, bins.a1[bin] - bins.a0[bin]), Math.abs(yb - ya))
      }
      if (ink.outline) {
        stroke()
        runs((from, to) => {
          ctx.beginPath()
          for (let bin = from; bin < to; bin++) {
            const y = yOf(norm(values.values[bin]))
            if (bin === from) ctx.moveTo(bins.a0[bin], y)
            else ctx.lineTo(bins.a0[bin], y)
            ctx.lineTo(bins.a1[bin], y)
          }
          ctx.stroke()
        })
      }
    } else {
      const base = yOf(zero)
      const profile = (from: number, to: number): void => {
        for (let bin = from; bin < to; bin++) {
          const y = yOf(norm(values.values[bin]))
          ctx.lineTo(bins.a0[bin], y)
          ctx.lineTo(bins.a1[bin], y)
        }
      }
      if (ink.fills) {
        ctx.fillStyle = lane.colour
        runs((from, to) => {
          ctx.beginPath()
          ctx.moveTo(bins.a0[from], base)
          profile(from, to)
          ctx.lineTo(bins.a1[to - 1], base)
          ctx.closePath()
          ctx.fill()
        })
      }
      stroke()
      runs((from, to) => {
        ctx.beginPath()
        ctx.moveTo(bins.a0[from], yOf(norm(values.values[from])))
        profile(from, to)
        ctx.stroke()
      })
    }
    if (mode !== 'heatmap') {
      if (limits.min < 0 && limits.max > 0) rule(yOf(zero), 0.45, 0.5)
      if (ink.baseline) rule(yOf(0), 0.75, LANE_HAIRLINE)
    }
  } else if (content.kind === 'classes') {
    const { codes } = content.classes
    let bin = 0
    while (bin < bins.count) {
      const code = codes[bin]
      let end = bin + 1
      while (end < bins.count && codes[end] === code && bins.unit[end] === bins.unit[bin]) end++
      if (code >= 0 && on(bins.unit[bin])) {
        ctx.fillStyle = categoryColour(code)
        ctx.fillRect(bins.a0[bin], y0, bins.a1[end - 1] - bins.a0[bin], thick)
      }
      bin = end
    }
  } else if (content.kind === 'features') {
    ctx.fillStyle = lane.colour
    const inset = thick * 0.15
    for (const arc of content.arcs) {
      if (!on(arc.unit)) continue
      const w = Math.max(0.6, arc.a1 - arc.a0)
      ctx.beginPath()
      ctx.rect(arc.a0, y0 + inset, w, thick - 2 * inset)
      ctx.fill()
      if (ink.outline) {
        ctx.strokeStyle = ink.guide
        ctx.lineWidth = LANE_HAIRLINE
        ctx.stroke()
      }
    }
  }
  ctx.globalAlpha = 1
}

// ---------------------------------------------------------------------------
// What is under the pointer, and where a carried section lands
// ---------------------------------------------------------------------------

/** What the pointer is over, on the two lines. */
export type LinesHit =
  | { kind: 'section'; unit: number }
  | { kind: 'group'; group: number }
  /** An index into the drawn order of the ribbons' {@link ChordLayout}. */
  | { kind: 'chord'; slot: number }
  | { kind: 'lane'; lane: number; line: 0 | 1; unit: number; x: number }

/** The section of a line under an x, or `-1` — in a gap, or past either end. */
export function unitAtX(geometry: LinesGeometry, line: 0 | 1, x: number): number {
  const mine = geometry.members[line]
  let low = 0
  let high = mine.length - 1
  while (low <= high) {
    const mid = (low + high) >> 1
    const u = mine[mid]
    if (x < geometry.arcs[2 * u]) high = mid - 1
    else if (x > geometry.arcs[2 * u + 1]) low = mid + 1
    else return u
  }
  return -1
}

/** The genome band's group of a line under an x, the gaps between its contigs included, or `-1`. */
export function groupAtX(geometry: LinesGeometry, line: 0 | 1, x: number): number {
  const arcs = geometry.groupArcs
  const sides = geometry.groupSide
  if (arcs === null || sides === null) return -1
  for (let g = 0; g < sides.length; g++) {
    if (sides[g] === line && x >= arcs[2 * g] && x <= arcs[2 * g + 1]) return g
  }
  return -1
}

/**
 * What is under a point: by height first — a row of the picture is one kind of
 * thing all the way along — then along it. A name is its section, or its
 * genome over contig sections, as a name round the circle is.
 */
export function hitLines(
  lines: LinesModel,
  geometry: LinesGeometry,
  ribbons: ChordLayout | null,
  x: number,
  y: number,
): LinesHit | null {
  const model = lines.model
  for (const line of [0, 1] as const) {
    const rows = geometry.rows[line]
    const section = (): LinesHit | null => {
      const unit = unitAtX(geometry, line, x)
      return unit < 0 ? null : { kind: 'section', unit }
    }
    const group = (): LinesHit | null => {
      const g = groupAtX(geometry, line, x)
      return g < 0 ? null : { kind: 'group', group: g }
    }
    if (y >= rows.sections.y0 - 1 && y <= rows.sections.y1 + 1) return section()
    if (rows.band !== null && y >= rows.band.y0 - 1 && y <= rows.band.y1 + 1) return group()
    for (let k = 0; k < geometry.lanes.length; k++) {
      const rect = geometry.lanes[k].rows[line]
      if (y >= rect.y0 - 1.5 && y <= rect.y1 + 1.5) {
        const unit = unitAtX(geometry, line, x)
        return unit < 0 ? null : { kind: 'lane', lane: k, line, unit, x }
      }
    }
    // The names, beyond everything of the line.
    const beyond = line === 0 ? y < rows.labelAt + 4 : y > rows.labelAt - 4
    if (beyond && geometry.names) {
      if (model.groups === null) return section()
      const unit = unitAtX(geometry, line, x)
      return unit >= 0 && geometry.labelled[unit] === 1 ? { kind: 'section', unit } : group()
    }
  }
  if (ribbons !== null && y > geometry.ribbons.y0 && y < geometry.ribbons.y1) {
    // The strongest first: it is the one drawn on top.
    for (let slot = ribbons.drawn - 1; slot >= 0; slot--) {
      if (insideRibbonFlat(geometry, ribbonEnds(lines, ribbons, slot), x, y)) return { kind: 'chord', slot }
    }
  }
  return null
}

/** The section-local base pair an x of a section stands for. */
export function bpAtX(geometry: LinesGeometry, model: CircleModel, unit: number, x: number): number {
  const x0 = geometry.arcs[2 * unit]
  const x1 = geometry.arcs[2 * unit + 1]
  if (!(x1 > x0)) return 0
  return clamp((x - x0) / (x1 - x0), 0, 1) * Math.max(0, model.units[unit].bp)
}

/** The bin of a section an x falls in, or `-1`. */
export function binAtX(bins: CircleBins, unit: number, x: number): number {
  const from = bins.first[unit]
  const to = bins.first[unit + 1]
  for (let bin = from; bin < to; bin++) if (x >= bins.a0[bin] && x <= bins.a1[bin]) return bin
  if (to > from) return x < bins.a0[from] ? from : to - 1
  return -1
}

/**
 * Where a section carried along its line lands (§7.6): beside the one whose edge
 * is nearest the pointer's x, among `allowed` only — the sections it may land
 * among, left to right: its line's genomes for a genome, its genome's contigs
 * for a contig. `null` where it would not move. {@link sectionDrop}, laid flat.
 */
export function lineDrop(
  arcs: ArrayLike<number>,
  allowed: readonly number[],
  from: number,
  x: number,
): { index: number; side: DropSide; at: number } | null {
  const position = allowed.indexOf(from)
  if (position < 0 || allowed.length < 2) return null
  let gap = 0
  let best = Number.POSITIVE_INFINITY
  allowed.forEach((index, k) => {
    for (const [edge, landing] of [
      [arcs[2 * index], k],
      [arcs[2 * index + 1], k + 1],
    ] as const) {
      const away = Math.abs(x - edge)
      if (away < best) {
        best = away
        gap = landing
      }
    }
  })
  if (gap === position || gap === position + 1) return null
  const before = gap - 1 >= 0 ? arcs[2 * allowed[gap - 1] + 1] : undefined
  const after = gap < allowed.length ? arcs[2 * allowed[gap]] : undefined
  const at = before !== undefined && after !== undefined ? (before + after) / 2 : (after ?? before ?? x)
  return gap < allowed.length
    ? { index: allowed[gap], side: 'before', at }
    : { index: allowed[allowed.length - 1], side: 'after', at }
}

function clamp(value: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, value))
}
