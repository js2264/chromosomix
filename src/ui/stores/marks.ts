/**
 * A store's mark: a square with a short word in it, in the store's colour, and
 * an image over the word for the store that has one.
 *
 * Type rather than a logo for three of the four shipped stores, because their
 * logos are not ours to ship (`ui/stores/registry.ts` on `StoreMark.image`).
 * What a mark has to do is be recognised in a row of five and again, smaller,
 * in the drawer's head — and a coloured square with *4DN* in it does that as
 * well as anything. RSG is the exception, the lab's own mark being the lab's
 * to use: it is a Hi-C map with its letters down the diagonal.
 *
 * The word is scaled by its length so *ENCODE* and *IGV* fill the same square:
 * six letters at the size three would take spill over the edge.
 */

import { el } from '../dom'
import type { StoreMark } from './registry'

/** How large the letters are, as a fraction of the square's edge, by length. */
function scale(text: string): number {
  if (text.length <= 1) return 0.62
  if (text.length <= 3) return 0.42
  if (text.length <= 4) return 0.32
  if (text.length <= 5) return 0.26
  return 0.22
}

/** Below this edge the short form is drawn, where there is one. */
const SHORT_BELOW = 40

/**
 * The mark, at `size` CSS pixels a side.
 *
 * `aria-hidden`: every mark stands beside its store's name, and a screen reader
 * announcing "RSG, RSG lab data" would be reading it twice.
 */
export function storeMark(mark: StoreMark, size: number): HTMLElement {
  const text = size < SHORT_BELOW && mark.short !== undefined ? mark.short : mark.text
  const node = el('span', {
    class: 'store-mark',
    attrs: { 'aria-hidden': 'true' },
    style: {
      width: `${size}px`,
      height: `${size}px`,
      background: mark.colour,
      fontSize: `${Math.round(size * scale(text))}px`,
    },
  })
  node.textContent = text
  if (mark.image !== undefined) {
    const image = el('img', { class: 'store-mark-image', attrs: { src: mark.image, alt: '' } })
    // The letters stay underneath; an image that will not load leaves them.
    image.addEventListener('error', () => image.remove())
    node.appendChild(image)
  }
  return node
}
