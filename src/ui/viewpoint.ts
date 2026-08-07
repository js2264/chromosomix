/**
 * The 4C viewpoint: what the profile is anchored on, and the lane that draws it.
 *
 * The anchor is a store rather than a field on `MatrixPanel`, for the reason
 * `ui/plotOptions.ts` is one and then some. The panel is rebuilt on every
 * navigation, so an anchor held there would be lost the moment the reader
 * zoomed — which is the one gesture they are certain to make after setting one,
 * because the whole point of a viewpoint is to look at what it touches.
 *
 * The anchor is kept in **base pairs on a named sequence**, not in bins and not
 * in block-local rows. Bins are a property of the file's resolution and rows are
 * a property of whatever block happens to be loaded; a locus is a property of the
 * genome, and it is the only one of the three that still means the same thing
 * after a pan, a zoom, a change of resolution, or a switch to the browser.
 *
 * **The lane itself is an ordinary annotation entry**, and that is the whole
 * design. Every gesture a lane has — rename it, type its limits, hand its axis
 * back to the data, drag its ceiling, drag its floor to resize, drag its handle
 * to reorder it or to move it to another edge, right-click it, read it in the
 * tooltip, export it — exists exactly once, in `AnnotationLanes` and the two
 * modules beside it, keyed off entries in an `AnnotationStore`. A second copy of
 * all of that written against a canvas of its own is precisely the drift §5.8
 * exists to prevent, and the first cut of this feature was one. So the profile
 * joins the store as an entry whose `kind` and `card` are both `viewpoint`: not
 * on the Tracks card, not in the 1D browser, never persisted — and in every
 * other respect a lane.
 */

import type { AnnotationStore } from '../annotations/store'
import type { AnnotationEntry, LaneEdge } from '../annotations/types'
import { placementOn } from '../annotations/types'

/** Where the reader pointed: a half-open span on one sequence. */
export interface Viewpoint {
  /** Sequence name, as the file spells it. */
  contig: string
  /** 0-based, half-open — cooler's convention, and the reader's. */
  start: number
  end: number
}

/**
 * The id the profile's entry always has.
 *
 * A constant rather than a minted one, because there is exactly one 4C lane per
 * file and every surface has to be able to find it without having been told.
 * Not of the `a<n>` shape `mintAnnotationId` produces, so it can never collide
 * with a loaded track's (`annotations/store.ts`).
 */
export const VIEWPOINT_ID = '4c'

/** The edge the profile opens on: above the map, where a reading of it belongs. */
export const VIEWPOINT_EDGE: LaneEdge = 'top'

let anchor: Viewpoint | null = null
/**
 * The name the lane was last given *by us*.
 *
 * A renameable lane whose name is also derived from the anchor has to answer
 * one question: has the reader taken it over? Comparing the label on the entry
 * against the last one this module wrote answers it without a flag — while they
 * are equal the name is still ours and follows the anchor, and the first time a
 * reader types their own it stops, for good.
 */
let derived = ''
const listeners = new Set<(anchor: Viewpoint | null) => void>()

export function getViewpointAnchor(): Viewpoint | null {
  return anchor
}

/**
 * Record an anchor.
 *
 * The lane it belongs to is shown by the caller, and showing it is not
 * overreach: the gesture that sets an anchor is a deliberate one on the
 * picture, and drawing nothing in response would leave a reader who had just
 * dragged over a locus with no evidence anything had happened.
 */
export function setViewpointAnchor(next: Viewpoint | null): void {
  anchor = next
  announce()
}

export function subscribeViewpoint(listener: (anchor: Viewpoint | null) => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/**
 * Forget everything, on the way into a different file.
 *
 * An anchor names a sequence, and the same name in another file is another
 * place; carrying one across would draw a profile of somewhere the reader never
 * pointed at. The lane goes with it — a new file gets a new store, so there is
 * no entry to take away, only the name this module remembers writing.
 */
export function resetViewpoint(): void {
  derived = ''
  if (anchor === null) return
  anchor = null
  announce()
}

function announce(): void {
  for (const listener of listeners) listener(anchor)
}

/** `chrIV:1,200,000–1,210,000` — the stretch the profile is a reading of. */
export function viewpointLabel(at: Viewpoint, fmtInt: (n: number) => string): string {
  return `${at.contig}:${fmtInt(at.start + 1)}–${fmtInt(at.end)}`
}

/** What the lane is called while the reader has not renamed it. */
export function derivedViewpointLabel(
  at: Viewpoint | null,
  fmtInt: (n: number) => string,
): string {
  return at === null ? '4C' : `4C · ${viewpointLabel(at, fmtInt)}`
}

/** The profile's entry in one store, if it has ever been switched on. */
export function viewpointEntry(store: AnnotationStore): AnnotationEntry | undefined {
  return store.byId(VIEWPOINT_ID)
}

/** Whether the profile is currently a lane on the map. */
export function isViewpointShown(store: AnnotationStore): boolean {
  return viewpointEntry(store)?.visible === true
}

/**
 * Show or hide the profile's lane.
 *
 * Hiding is `visible: false` rather than a removal, and that is what makes the
 * toggle safe to press twice: the colour, the height, the value axis and the
 * edge a reader chose are decisions about *their* 4C lane, and a lane that came
 * back in the factory's colours every time would be one nobody bothered to
 * style.
 */
export function showViewpoint(
  store: AnnotationStore,
  shown: boolean,
  fmtInt: (n: number) => string,
): void {
  const held = viewpointEntry(store)
  if (held !== undefined) {
    if (held.visible !== shown) store.update(VIEWPOINT_ID, { visible: shown })
    return
  }
  if (!shown) return
  derived = derivedViewpointLabel(anchor, fmtInt)
  store.begin({
    id: VIEWPOINT_ID,
    card: 'viewpoint',
    kind: 'viewpoint',
    // Nothing to name and nothing to re-read: the profile is computed from the
    // block already on screen, which is what "virtual" is doing in the name.
    source: { kind: 'derived', name: '4C' },
    label: derived,
    placement: placementOn(VIEWPOINT_EDGE),
  })
  // A lane is drawn when it is `ready`, and this one is ready the moment it
  // exists — there is no file behind it to wait for.
  store.update(VIEWPOINT_ID, { status: 'ready' })
}

/**
 * Keep the lane's name in step with the anchor, until the reader takes it over.
 *
 * Called whenever either could have changed. The comparison against
 * {@link derived} is the whole of it: a name this module wrote is still this
 * module's to update, and anything else is the reader's.
 */
export function syncViewpointLabel(store: AnnotationStore, fmtInt: (n: number) => string): void {
  const held = viewpointEntry(store)
  if (held === undefined) return
  const next = derivedViewpointLabel(anchor, fmtInt)
  if (next === held.label) {
    derived = next
    return
  }
  if (held.label !== derived) return
  derived = next
  store.update(VIEWPOINT_ID, { label: next })
}
