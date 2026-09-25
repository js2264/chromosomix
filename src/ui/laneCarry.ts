/**
 * A lane carried by its grip past the map it is drawn on (§16.9).
 *
 * The grip drag is a **pointer** drag, captured on the lane canvas it began on
 * (`MatrixPanel.watchLane`): every event goes to that canvas whatever is under
 * it, which is what stops the map below reading the drag as a pan — and what
 * stops anything else on the page hearing about it at all. A `dragover` never
 * fires. So the places a lane can be let go on say so here instead: each
 * *surface* — a map's edge rectangles, the deck's `+` edges and its cells —
 * answers what is under a point on the page, and the carrying panel asks, move
 * by move, and hands the lane to whatever answered when the hand lets go.
 *
 * What a landing does is its own business; what every one of them does is
 * **move** the lane: it is drawn where it landed and taken off the map it came
 * from. A lane dragged to another cell is a reader saying *there, not here*,
 * and the Tracks card is where a track is put somewhere *as well*.
 */

import type { MapId } from '../annotations/placement'

/** The lane in the hand: its tracks — an overlay group moves as one — and the map they are on. */
export interface LaneCarry {
  ids: readonly string[]
  from: MapId
}

/** One place a carried lane can land. */
export interface LaneLanding {
  /** Lit while the carried lane would land here if let go. */
  light(on: boolean): void
  /** Take the lane: draw it here, and off the map it came from. */
  take(carry: LaneCarry): void
}

/** Something on the page with places a lane can land on. */
export interface LaneSurface {
  /** The landing under a point in viewport coordinates, if any. */
  landingAt(x: number, y: number, carry: LaneCarry): LaneLanding | null
  /** A lane was taken up, or put down: show the places, or stop. */
  carrying?(carry: LaneCarry | null): void
}

const surfaces = new Set<LaneSurface>()
let held: LaneCarry | null = null

/** Put a surface's landings on offer; the returned function takes them off. */
export function offerLanding(surface: LaneSurface): () => void {
  surfaces.add(surface)
  // A surface built while a lane is in the air — a cell the drop is about to
  // open, say — shows its places like every other.
  if (held !== null) surface.carrying?.(held)
  return () => {
    surfaces.delete(surface)
  }
}

/** A lane was taken up by its grip: every surface shows where it can go. */
export function startCarry(carry: LaneCarry): void {
  held = carry
  for (const surface of surfaces) surface.carrying?.(carry)
}

/** The lane was put down, wherever that was. */
export function endCarry(): void {
  held = null
  for (const surface of surfaces) surface.carrying?.(null)
}

/** The lane in the hand, or `null`. */
export function carried(): LaneCarry | null {
  return held
}

/**
 * The landing under a point, from any surface but `except` — the panel the lane
 * came from answers its own edges itself.
 */
export function landingAt(x: number, y: number, carry: LaneCarry, except?: LaneSurface): LaneLanding | null {
  for (const surface of surfaces) {
    if (surface === except) continue
    const landing = surface.landingAt(x, y, carry)
    if (landing !== null) return landing
  }
  return null
}

/** Whether a point in viewport coordinates is inside an element's box. */
export function within(node: Element, x: number, y: number): boolean {
  const box = node.getBoundingClientRect()
  if (box.width <= 0 || box.height <= 0) return false
  return x >= box.left && x <= box.right && y >= box.top && y <= box.bottom
}
