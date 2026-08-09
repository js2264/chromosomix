/**
 * A locus the reader pointed at on the map, for a form that asked them to.
 *
 * All that survives of the virtual 4C **lane** (§8.9), which is gone. That lane
 * was a whole feature: shift-drag on the map created a track, the track lived in
 * a store the panel borrowed because a `.metacool` has none, it renamed itself
 * from the anchor until the reader renamed it, and it drew a profile of whatever
 * block happened to be loaded. Every one of those things the **4C task** now does
 * better — it reads the file rather than the picture, it produces a track that is
 * a track like any other, and its result is a record with a provenance line. A
 * second, dimmer version of the same answer, appearing without being asked for,
 * was the thing worth removing.
 *
 * What was worth keeping is one sentence: *the reader can point at a locus*.
 *
 * ## Arming, and why it is a mode
 *
 * The gesture that used to name an anchor — shift-drag — is now a 1D zoom, so a
 * pick has to be asked for. The 4C task's **Pick on map** button arms this
 * module; while it is armed the next drag on a map names a locus instead of
 * doing whatever it would have done, and then it disarms itself.
 *
 * A mode on a map is a thing to be careful with, and the two rules that make
 * this one safe are both here rather than in the map: it disarms after **one**
 * pick, so a reader cannot leave it on by accident, and it disarms on Escape,
 * because the way out of a mode has to be the way out of every other mode in
 * this app. The map's own job is only to ask {@link isArmed} before it decides
 * what a drag means.
 */

/** A locus, in the shape the map reports and a form reads. */
export interface PickedLocus {
  /** Sequence name, as the file spells it. */
  contig: string
  /** 0-based, half-open — cooler's convention, and the reader's. */
  start: number
  end: number
}

let armed = false
let picked: PickedLocus | null = null
const listeners = new Set<() => void>()

function announce(): void {
  for (const listener of listeners) listener()
}

/**
 * Escape, on the window rather than on the map.
 *
 * The mode is armed from a button in a side panel, so the focus at the moment
 * the reader changes their mind is very often not on the plot — and a way out
 * that only works if you first click the thing you were trying not to click is
 * not a way out.
 *
 * Exported because it is the *rule*, and the rule is worth a test: the wiring
 * below needs a DOM and this does not. It stops nothing — Escape closes menus
 * and cancels drags elsewhere in the app, and one press putting away everything
 * it can is what a reader expects of it.
 */
export function pickKeyDown(event: { key: string }): void {
  if (event.key === 'Escape') disarmPick()
}

/**
 * Listen only while armed, so a session that never picks carries no listener.
 *
 * Capturing, so the press is seen before a focused control can swallow it. The
 * guard is for the workers and the tests, which have no `window`.
 */
/** One instance, module-wide: `removeEventListener` matches by identity. */
const escapeListener = (event: Event): void => pickKeyDown(event as KeyboardEvent)

function watchEscape(on: boolean): void {
  const scope = globalThis as {
    addEventListener?: typeof addEventListener
    removeEventListener?: typeof removeEventListener
  }
  if (scope.addEventListener === undefined || scope.removeEventListener === undefined) return
  if (on) scope.addEventListener('keydown', escapeListener, true)
  else scope.removeEventListener('keydown', escapeListener, true)
}

/** Whether the next drag on a map should name a locus rather than act. */
export function isArmed(): boolean {
  return armed
}

/**
 * Ask for the next drag.
 *
 * Idempotent, so a second press of an already-lit button is not a toggle by
 * accident — {@link disarmPick} is how it is turned off, and the button calls
 * that when it is pressed while lit.
 */
export function armPick(): void {
  if (armed) return
  armed = true
  watchEscape(true)
  announce()
}

export function disarmPick(): void {
  if (!armed) return
  armed = false
  watchEscape(false)
  announce()
}

/**
 * A drag named a locus. Records it and disarms.
 *
 * One pick per arming, deliberately: a reader who armed the button to answer one
 * question should not find the next three drags answering it again.
 */
export function pickLocus(at: PickedLocus): void {
  picked = at
  armed = false
  watchEscape(false)
  announce()
}

/** The last locus picked, or `null`. */
export function lastPick(): PickedLocus | null {
  return picked
}

export function subscribePick(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/**
 * Forget everything, on the way into a different file.
 *
 * A locus names a sequence, and the same name in another file is another place —
 * so carrying one across would hand a task coordinates from somewhere the reader
 * never pointed at. The arming goes too: a mode entered against one file has no
 * meaning against the next.
 */
export function resetPick(): void {
  if (!armed && picked === null) return
  armed = false
  picked = null
  watchEscape(false)
  announce()
}

/**
 * `chrIV:500001-510000` — the format every tool in this field takes.
 *
 * **No thousands separators and a plain hyphen**, which is the difference
 * between a string that pastes into samtools, bedtools, IGV and this app's own
 * locus boxes and one that only looks right. The app's *display* format uses an
 * en dash and grouped digits, and that one is for reading; this one is for
 * pasting, and the two must not be confused.
 *
 * One-based inclusive, because that is what the format means: the interval here
 * is half-open and 0-based, as everything internal is, and the `+1` is the
 * conversion rather than an off-by-one.
 */
export function locusText(at: PickedLocus): string {
  return `${at.contig}:${at.start + 1}-${at.end}`
}
