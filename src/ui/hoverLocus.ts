/**
 * The place the pointer is on, wherever it is (§25).
 *
 * A store rather than a callback threaded through the panels, for the reason
 * `ui/readout.ts` is one: the surface that produces the place and the surfaces
 * that light it are on opposite sides of the app, and neither should have to
 * know the other exists. A map cell names *two* places — a contact is a pair —
 * and a track, a bead or the 1D browser's axis names one, so the store carries
 * one or two loci and says which surface they came from, and every subscriber
 * ignores its own.
 *
 * The deck's own cell-to-cell echo (`panels/PanelDeck.ts`) is untouched by
 * this and deliberately so: it carries a pointer between maps in cells,
 * converted through base pairs, and a structure has no cells to convert into.
 * What a structure needs is the place itself, which is what this carries — the
 * same decision the deck took, one level up.
 */

import type { Locus } from '../render/locus'

export interface HoverPlace {
  /** One place, or the two ends of a contact. */
  loci: readonly [Locus] | readonly [Locus, Locus]
  /**
   * Who is pointing: `map` for any contact map (the deck already echoes
   * between maps), `browser` for the 1D browser, or a structure cell's own id.
   */
  source: string
}

let current: HoverPlace | null = null
const listeners = new Set<(place: HoverPlace | null) => void>()

/** Publish where the pointer is, or `null` for nowhere. */
export function setHoverPlace(place: HoverPlace | null): void {
  if (place === null && current === null) return
  if (place !== null && current !== null && samePlace(place, current)) return
  current = place
  for (const listener of listeners) listener(current)
}

/** Where the pointer is now. */
export function getHoverPlace(): HoverPlace | null {
  return current
}

/** Subscribe, receiving the current value immediately. Returns the teardown. */
export function subscribeHoverPlace(listener: (place: HoverPlace | null) => void): () => void {
  listeners.add(listener)
  listener(current)
  return () => listeners.delete(listener)
}

function samePlace(a: HoverPlace, b: HoverPlace): boolean {
  if (a.source !== b.source || a.loci.length !== b.loci.length) return false
  return a.loci.every((locus, at) => {
    const other = b.loci[at]
    return other !== undefined && other.contig === locus.contig && other.bp === locus.bp
  })
}
