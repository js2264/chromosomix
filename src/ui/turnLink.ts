/**
 * The turn of a model, shared between the cells that asked to be turned
 * together (§25.3).
 *
 * A store rather than a wire through the deck, for `ui/hoverLocus.ts`'s
 * reason: the cell that is being dragged and the cells that follow it are
 * peers, and neither should have to know the other exists. The deck holds
 * them, but a deck is an arrangement of cells and not a bus between them —
 * and the cells that follow are chosen by the reader, one toggle at a time,
 * rather than by where they sit.
 *
 * **Only the two angles travel.** A camera is also a target, a distance and a
 * projection, and none of those is *the turn*: two cells looking at one model
 * from one angle at two zooms are still the same view of it, and two cells
 * each centred on their own bead had a reason for that. Sending the whole
 * camera would make *turn together* mean *be the same cell*, which is a thing
 * a reader can already have by not opening the second one.
 *
 * Every subscriber ignores its own, which is what stops a pair of synced cells
 * chasing each other round the sphere.
 */

/** Where a model is turned to: the camera's two angles, in radians. */
export interface Turn {
  azimuth: number
  elevation: number
  /** The cell that turned, so the cells that follow can ignore their own. */
  source: string
}

const listeners = new Set<(turn: Turn) => void>()

/** Say this cell has turned, for whoever is turning with it. */
export function publishTurn(turn: Turn): void {
  for (const listener of listeners) listener(turn)
}

/** Follow the cells that publish a turn. Returns the teardown. */
export function subscribeTurn(listener: (turn: Turn) => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}
