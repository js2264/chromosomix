/**
 * The ideogram's switch (§5.10), one button in two Tracks cards: the
 * browser's, where it is lit while the ideogram is drawn, and a map's, where a
 * press puts the map down to draw it, as `v` puts it down. One mark and one
 * sentence in both, so the switch is one control wherever the tracks are — as
 * the overlays are one list (`ui/plotOptions.ts`).
 *
 * In each card's `picture` row, at the top, where the Map card keeps its own
 * pictures: which picture the tracks are drawn as is the first thing the card
 * says, and the rows under it are about that picture.
 */

import { el } from './dom'
import { KEYS, withKey } from './commands'
import { iconButton } from './icons'

/** What the switch says, in either card. */
export const IDEOGRAM_HINT =
  'Ideogram — every chromosome whole, side by side, with the tracks beside each. ' +
  'Off, or a click on a chromosome, brings back the picture it replaced'

/** The switch, unlit: the standing chromosomes are the picture a press gives. */
export function ideogramSwitch(onPress: () => void): HTMLButtonElement {
  return iconButton('align-start-horizontal', withKey(IDEOGRAM_HINT, KEYS.ideogram), onPress, {
    class: 'btn btn-icon btn-toggle',
    size: 15,
    pressed: false,
  })
}

/** A Tracks card's `picture` row: the switch, and what stands beside it. */
export function pictureRow(...controls: HTMLElement[]): HTMLElement {
  return el(
    'div',
    { class: 'field field-block' },
    el('span', { class: 'field-label', text: 'picture' }),
    el('div', { class: 'plot-icon-row' }, ...controls),
  )
}
