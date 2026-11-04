/**
 * The controls at the end of a deck cell's heading, as one group (§16.9).
 *
 * Every cell's heading is the same sentence — a grip, a name, then what the
 * reader does to the cell: its sequence, its rung, its own window, its star,
 * its chain and its × — and in a narrow cell it was wider than the cell. The
 * name gave way to its floor and then the controls ran on past the cell's
 * right edge, the chain of one cell drawn over the grip and the name of the
 * next. Gathered here they **wrap as one**: where the name cannot keep its
 * width beside them, they go to a line of their own under it, at the cell's
 * right, and the name has the whole first line (`.deck-tools` in
 * `ui/styles.css`). Split one by one they would leave a star above and a chain
 * and a × below, which reads as two headings.
 */

import { el } from '../ui/dom'

export function deckTools(...controls: HTMLElement[]): HTMLElement {
  return el('span', { class: 'deck-tools' }, ...controls)
}
