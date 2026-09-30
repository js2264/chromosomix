/**
 * What the hand does on the stage, as arithmetic (SPECS §27.4): where the
 * pointer snaps, where a dragged stretch would land, and the step a drop makes.
 *
 * Kept out of the stage so it is tested without a canvas: every question here
 * is about units of the edited axis and base pairs of edited sequences, and the
 * stage only turns pixels into units before it asks.
 */

import type { EditStep, EditedAssembly } from '../genome/edit'
import type { LensGrid } from './grid'

/** A stretch of one edited sequence, half-open, in base pairs. */
export interface Stretch {
  sequence: string
  from: number
  to: number
}

/** Something the pointer snaps to along one axis, in units. */
export interface SnapTarget {
  unit: number
  /**
   * `suggestion`: a point a suggestion names — a breakpoint, or where it would
   * put a stretch (§27.4). `end`: where two parts meet, or a sequence ends — an
   * edit end. `selection`: an end of what is selected, so a stretch can be
   * dropped against its own edge. At equal distance each beats the next.
   */
  kind: 'suggestion' | 'end' | 'selection'
  /** The suggestion it belongs to, for a `suggestion`. */
  key?: string
}

/** Which of two targets at one distance wins: a suggestion, then an edit end, then the selection. */
const PRIORITY: Record<SnapTarget['kind'], number> = { suggestion: 0, end: 1, selection: 2 }

/** Where the pointer came to rest along one axis, and what it snapped to. */
export interface Snapped {
  unit: number
  target: SnapTarget | null
}

/** The gap a join puts between two sequences, in base pairs: AGP's default for an unsized gap. */
export const JOIN_GAP = 100

/** Every edit end on the axis, as snap targets. */
export function endTargets(grid: LensGrid): SnapTarget[] {
  const units = new Set<number>([...grid.boundaries(), ...grid.junctions()])
  return [...units].sort((a, b) => a - b).map((unit) => ({ unit, kind: 'end' as const }))
}

/**
 * Snap a unit to the nearest target within `reach` units; failing that, to the
 * nearest cell edge, which is where the picture can place anything (§4.9's
 * *placed by the map, to one cell*). `free` is ⌥ held: the edge, never a target.
 */
export function snapUnit(unit: number, targets: readonly SnapTarget[], reach: number, free = false): Snapped {
  if (!free) {
    let best: SnapTarget | null = null
    let bestDistance = Number.POSITIVE_INFINITY
    for (const target of targets) {
      const distance = Math.abs(target.unit - unit)
      if (distance > reach) continue
      const better =
        distance < bestDistance ||
        (distance === bestDistance && best !== null && PRIORITY[target.kind] < PRIORITY[best.kind])
      if (better) {
        best = target
        bestDistance = distance
      }
    }
    if (best !== null) return { unit: best.unit, target: best }
  }
  return { unit: Math.round(unit), target: null }
}

/** A stretch of the axis, as units, lowest first; `null` for a sequence the grid lacks. */
export function stretchUnits(grid: LensGrid, stretch: Stretch): [number, number] | null {
  const a = grid.unitOf(stretch.sequence, stretch.from)
  const b = grid.unitOf(stretch.sequence, stretch.to)
  if (a === null || b === null) return null
  return a <= b ? [a, b] : [b, a]
}

/**
 * The stretch between two units of the axis, inside the sequence the first is
 * in: a drag along the diagonal, or a press on a corner off it, which names the
 * stretch between its row and its column (§27.4). `null` where it names nothing.
 */
export function stretchBetween(grid: LensGrid, anchor: number, unit: number): Stretch | null {
  const sequence = grid.sequenceAt(Math.min(Math.max(anchor, 0), grid.n - 1))
  if (sequence === null) return null
  const lo = Math.max(sequence.from, Math.min(anchor, unit))
  const hi = Math.min(sequence.to, Math.max(anchor, unit))
  if (!(hi > lo)) return null
  const bpAt = (u: number): number => {
    if (u <= sequence.from) return 0
    if (u >= sequence.to) return sequence.length
    return Math.round(grid.place(u)?.bp ?? 0)
  }
  const from = bpAt(lo)
  const to = bpAt(hi)
  return to > from ? { sequence: sequence.name, from, to } : null
}

/** The part a unit is in, as a stretch — what a press on the diagonal selects. */
export function partStretch(grid: LensGrid, unit: number): Stretch | null {
  const part = grid.partAt(unit)
  if (part === null || part.length === 0) return null
  return { sequence: part.sequence, from: part.offset, to: part.offset + part.length }
}

/**
 * The edited sequence a unit is in, whole, as a stretch — what a press on its
 * name selects, or a second press on a piece of it (§27.4).
 */
export function sequenceStretch(grid: LensGrid, unit: number): Stretch | null {
  const sequence = grid.sequenceAt(Math.min(Math.max(unit, 0), grid.n - 1e-9))
  if (sequence === null || !(sequence.length > 0)) return null
  return { sequence: sequence.name, from: 0, to: sequence.length }
}

/** Whether a stretch is the whole of its sequence. */
export function isWholeSequence(assembly: EditedAssembly, stretch: Stretch): boolean {
  return stretch.from === 0 && stretch.to === assembly.lengthOf(stretch.sequence)
}

/**
 * Where a dropped stretch lands: inside an edited sequence, at a base pair in
 * the coordinates before the step; or **between two sequences**, as a sequence
 * of its own before one of them — or after the last.
 */
export type DropPlace = { sequence: string; at: number } | { before: string | null }

/**
 * Where a stretch dropped at `unit` lands. At the edge between two sequences —
 * or before the first, or after the last — it is set there as a sequence of its
 * own, and nothing is joined (§27.4). With `fuse` (⇧ held) it goes into the
 * sequence the pointer came from instead: the end of the one on its left, or the
 * start of the one on its right.
 */
export function dropPlace(grid: LensGrid, unit: number, pointer: number, fuse = false): DropPlace | null {
  const inside = Math.min(Math.max(unit, 0), grid.n)
  const left = grid.sequenceAt(inside - 0.5)
  const right = grid.sequenceAt(inside)
  if (!fuse && (right === null ? left !== null : inside <= right.from)) return { before: right?.name ?? null }
  const boundary = left !== null && right !== null && left !== right
  const atEnd = (right === null && left !== null) || (boundary && pointer < inside)
  if (atEnd && left !== null) return { sequence: left.name, at: left.length }
  if (right === null) return null
  if (inside <= right.from) return { sequence: right.name, at: 0 }
  const place = grid.place(inside)
  return place === null ? null : { sequence: place.sequence, at: Math.round(place.bp) }
}

/**
 * The step a stretch dropped at `place` makes, or `null` for a drop that
 * changes nothing.
 *
 * - **Between two sequences**, it is **placed** there as a sequence of its own —
 *   a whole sequence moved in the order, a stretch taken out of its own — and
 *   nothing is joined; a whole sequence dropped where it already is is left
 *   as it was, or turned if it was flipped on the way.
 * - `copy` (⌥ held) duplicates it there, the original staying where it was.
 * - Dropped on itself, it is left as it was — or turned, if it was flipped on
 *   the way.
 * - A **whole sequence** dropped on another's start or end, with ⇧ held, is
 *   **joined** to it, with an `N` gap between, and takes the other's place.
 * - Anything else **moves**, with the place re-measured as the step records it:
 *   after the stretch has been taken out.
 */
export function dropStep(assembly: EditedAssembly, stretch: Stretch, place: DropPlace, strand: 1 | -1, copy: boolean): EditStep | null {
  const { sequence, from, to } = stretch
  if (!(to > from)) return null
  if ('before' in place) {
    // A copy has no place of its own to go: it goes into a sequence.
    if (copy) return null
    if (!isWholeSequence(assembly, stretch)) return { op: 'place', sequence, from, to, before: place.before, strand }
    const names = assembly.sequences.map((edited) => edited.name)
    const at = names.indexOf(sequence)
    const target = place.before === null ? names.length : names.indexOf(place.before)
    if (target === at || target === at + 1) return strand === 1 ? null : { op: 'invert', sequence, from, to }
    return { op: 'place', sequence, from, to, before: place.before, strand, whole: true }
  }
  if (copy) {
    return { op: 'duplicate', sequence, from, to, into: place.sequence, at: place.at, strand }
  }
  if (place.sequence === sequence && place.at >= from && place.at <= to) {
    return strand === 1 ? null : { op: 'invert', sequence, from, to }
  }
  const whole = from === 0 && to === assembly.lengthOf(sequence)
  const intoLength = assembly.lengthOf(place.sequence) ?? 0
  if (whole && place.sequence !== sequence && (place.at === 0 || place.at === intoLength)) {
    return place.at === intoLength
      ? { op: 'join', a: place.sequence, aEnd: 'end', b: sequence, bEnd: strand === 1 ? 'start' : 'end', gap: JOIN_GAP }
      : {
          op: 'join',
          a: sequence,
          aEnd: strand === 1 ? 'end' : 'start',
          b: place.sequence,
          bEnd: 'start',
          gap: JOIN_GAP,
          place: 'b',
        }
  }
  const at = place.sequence === sequence && place.at > to ? place.at - (to - from) : place.at
  return { op: 'move', sequence, from, to, into: place.sequence, at, strand }
}

/**
 * The step ↑ or ↓ makes of what is selected (§27.4): a whole sequence one
 * place earlier or later in the order; a piece of a sequence of several, one
 * place earlier or later among its pieces. Nothing is joined and nothing taken
 * out: `null` where it is first or last already, or is neither.
 */
export function shiftStep(assembly: EditedAssembly, stretch: Stretch, delta: -1 | 1): EditStep | null {
  const { sequence, from, to } = stretch
  const length = assembly.lengthOf(sequence)
  if (length === null || !(to > from)) return null
  if (isWholeSequence(assembly, stretch)) {
    const names = assembly.sequences.map((edited) => edited.name)
    const at = names.indexOf(sequence)
    if (delta < 0) return at <= 0 ? null : { op: 'place', sequence, from, to, before: names[at - 1], strand: 1, whole: true }
    return at >= names.length - 1 ? null : { op: 'place', sequence, from, to, before: names[at + 2] ?? null, strand: 1, whole: true }
  }
  const pieces = assembly.piecesIn(sequence, 0, length)
  const index = pieces.findIndex(({ offset, piece }) => offset === from && offset + (piece.end - piece.start) === to)
  if (index < 0) return null
  if (delta < 0) {
    const previous = pieces[index - 1]
    return previous === undefined ? null : { op: 'move', sequence, from, to, into: sequence, at: previous.offset, strand: 1 }
  }
  const next = pieces[index + 1]
  if (next === undefined) return null
  // After the piece is out, the next one ends that much sooner.
  const end = next.offset + (next.piece.end - next.piece.start)
  return { op: 'move', sequence, from, to, into: sequence, at: end - (to - from), strand: 1 }
}

/**
 * Where a stretch is after the step that moved, copied or turned it — so the
 * selection follows the stretch the reader is holding. `null` where the step
 * leaves nothing to follow.
 *
 * Found by the sequence's **place in the order**, not by its name: a step
 * renames what it changes (`IV` becomes `IV_e1`), and the order is what a move
 * leaves alone — but for the sequence it emptied, which leaves the list.
 */
export function landed(before: EditedAssembly, after: EditedAssembly, step: EditStep): Stretch | null {
  const index = (name: string): number => before.sequences.findIndex((sequence) => sequence.name === name)
  switch (step.op) {
    case 'invert': {
      const at = index(step.sequence)
      const name = after.sequences[at]?.name
      return name === undefined ? null : { sequence: name, from: step.from, to: step.to }
    }
    case 'move':
    case 'duplicate': {
      let at = index(step.into)
      const source = index(step.sequence)
      if (step.op === 'move' && after.sequences.length < before.sequences.length && source < at) at -= 1
      const name = after.sequences[at]?.name
      if (name === undefined) return null
      const length = step.to - step.from
      return { sequence: name, from: step.at, to: step.at + length }
    }
    case 'restore': {
      // Put back last, whole: selected, to be moved into place.
      const last = after.sequences[after.sequences.length - 1]
      return last === undefined ? null : { sequence: last.name, from: 0, to: after.lengthOf(last.name) ?? 0 }
    }
    case 'place': {
      // Before the sequence it was put before, in the order the step left.
      const at = index(step.sequence)
      const target = step.before === null ? before.sequences.length : index(step.before)
      const whole = after.sequences.length === before.sequences.length
      const k = !whole ? target : target > at ? target - 1 : target
      const name = after.sequences[k]?.name
      return name === undefined ? null : { sequence: name, from: 0, to: after.lengthOf(name) ?? 0 }
    }
    case 'join': {
      const keeps = step.place === 'b' ? step.b : step.a
      let at = index(keeps)
      if (step.place !== 'b' && index(step.b) < at) at -= 1
      if (step.place === 'b' && index(step.a) < at) at -= 1
      const joined = after.sequences[at]
      if (joined === undefined) return null
      return { sequence: joined.name, from: 0, to: after.lengthOf(joined.name) ?? 0 }
    }
    default:
      return null
  }
}
