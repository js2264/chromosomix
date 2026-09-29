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
 * Where a stretch dropped at `unit` lands: an edited sequence and a base pair
 * in it, in the coordinates before the step. At the edge between two sequences
 * the side the pointer came from decides — the end of the one on its left, or
 * the start of the one on its right.
 */
export function dropPlace(grid: LensGrid, unit: number, pointer: number): { sequence: string; at: number } | null {
  const inside = Math.min(Math.max(unit, 0), grid.n)
  const left = grid.sequenceAt(inside - 0.5)
  const right = grid.sequenceAt(inside)
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
 * - `copy` (⌥ held) duplicates it there, the original staying where it was.
 * - Dropped on itself, it is left as it was — or turned, if it was flipped on
 *   the way.
 * - A **whole sequence** dropped on another's start or end is **joined** to it,
 *   with an `N` gap between, and takes the other's place.
 * - Anything else **moves**, with the place re-measured as the step records it:
 *   after the stretch has been taken out.
 */
export function dropStep(
  assembly: EditedAssembly,
  stretch: Stretch,
  place: { sequence: string; at: number },
  strand: 1 | -1,
  copy: boolean,
): EditStep | null {
  const { sequence, from, to } = stretch
  if (!(to > from)) return null
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
