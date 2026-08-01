/**
 * The coordinate readout, hoisted out of the plot and into the status bar.
 *
 * It used to sit under the canvas, where it cost a line of vertical space in
 * every view and moved as the plot resized. It is instrumentation — the same
 * kind of thing as the byte counter next to it — so it belongs in the one line
 * that is always on screen and never moves.
 *
 * A store rather than a callback threaded through four views: the panel that
 * produces the text and the bar that shows it are on opposite sides of the app,
 * and neither should have to know the other exists.
 */

let current = ''
const listeners = new Set<(text: string) => void>()

/** Publish the text under the pointer. Empty clears the slot. */
export function setReadout(text: string): void {
  if (text === current) return
  current = text
  for (const listener of listeners) listener(current)
}

/** Subscribe, receiving the current value immediately. Returns the teardown. */
export function subscribeReadout(listener: (text: string) => void): () => void {
  listeners.add(listener)
  listener(current)
  return () => listeners.delete(listener)
}
