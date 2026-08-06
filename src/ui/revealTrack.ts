/**
 * "Show me this track's settings" — asked from a picture, answered by a card.
 *
 * A press on a lane is the most direct way a reader has of saying *this one*,
 * and until now it said it to nothing: the settings were behind a fold in a
 * column that may be scrolled somewhere else entirely, and finding the row meant
 * matching a name against a list. Clicking the thing itself is the gesture, so
 * the gesture opens the row.
 *
 * A store rather than a callback threaded through four views, for the reason
 * `ui/readout.ts` is one: the canvas that produces the request and the card that
 * answers it are on opposite sides of the application, and neither should have
 * to know the other exists. There is no *state* here — a reveal is an event, and
 * a subscriber that arrives afterwards has nothing to catch up on.
 */

type RevealListener = (id: string) => void

const listeners = new Set<RevealListener>()

/** Ask whichever card holds this track to open its settings. */
export function revealTrack(id: string): void {
  for (const listener of listeners) listener(id)
}

/** Subscribe; returns the teardown. */
export function subscribeReveal(listener: RevealListener): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}
