/**
 * The 4C viewpoint: whether the lane is shown, and what it is anchored on.
 *
 * A store rather than fields on `MatrixPanel`, for the reason `ui/plotOptions.ts`
 * is one and then some. The panel is rebuilt on every navigation, so an anchor
 * held there would be lost the moment the reader zoomed — which is the one
 * gesture they are certain to make after setting one, because the whole point of
 * a viewpoint is to look at what it touches. And the anchor has to outlive the
 * *surface*: on a cooler the lane becomes a track in the 1D browser, so the map
 * and the browser have to be looking at the same viewpoint or the two pictures
 * are of different experiments.
 *
 * The anchor is kept in **base pairs on a named sequence**, not in bins and not
 * in block-local rows. Bins are a property of the file's resolution and rows are
 * a property of whatever block happens to be loaded; a locus is a property of the
 * genome, and it is the only one of the three that still means the same thing
 * after a pan, a zoom, a change of resolution, or a switch to the browser.
 */

/** Where the reader pointed: a half-open span on one sequence. */
export interface Viewpoint {
  /** Sequence name, as the file spells it. */
  contig: string
  /** 0-based, half-open — cooler's convention, and the reader's. */
  start: number
  end: number
}

interface State {
  /** Whether the lane is on screen at all. Off until asked for. */
  shown: boolean
  /** `null` until the reader has drawn one; the lane then prompts for it. */
  anchor: Viewpoint | null
}

let state: State = { shown: false, anchor: null }
const listeners = new Set<(state: State) => void>()

export function getViewpoint(): State {
  return state
}

/** Show or hide the lane. Showing it without an anchor is deliberate. */
export function setViewpointShown(shown: boolean): void {
  if (shown === state.shown) return
  state = { ...state, shown }
  announce()
}

/**
 * Record an anchor, and show the lane if it was hidden.
 *
 * Showing it is not overreach: the gesture that sets an anchor is a deliberate
 * one on the picture, and drawing nothing in response would leave a reader who
 * had just dragged over a locus with no evidence anything had happened.
 */
export function setViewpointAnchor(anchor: Viewpoint | null): void {
  state = { shown: anchor === null ? state.shown : true, anchor }
  announce()
}

export function subscribeViewpoint(listener: (state: State) => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/**
 * Forget everything, on the way into a different file.
 *
 * An anchor names a sequence, and the same name in another file is another
 * place; carrying one across would draw a profile of somewhere the reader never
 * pointed at.
 */
export function resetViewpoint(): void {
  if (!state.shown && state.anchor === null) return
  state = { shown: false, anchor: null }
  announce()
}

function announce(): void {
  for (const listener of listeners) listener(state)
}

/** `chrIV:1,200,000–1,210,000` — what the lane writes above its line. */
export function viewpointLabel(anchor: Viewpoint, fmtInt: (n: number) => string): string {
  return `${anchor.contig}:${fmtInt(anchor.start + 1)}–${fmtInt(anchor.end)}`
}
