/**
 * A store's mark: a square with a short word in it, in the store's colour, and
 * an image over the word for the stores that have one.
 *
 * All four shipped stores have one — RSG's drawn, the other three their own
 * projects' (`ui/stores/registry.ts` on `StoreMark.image`) — so on those the
 * word is what shows while the image loads and what is left if it fails. A
 * store connected by URL has no image and is the coloured square with its
 * initials in it, which is all a mark has to do anyway: be recognised in a row
 * of five, and again smaller in the drawer's head.
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
    // And the colour goes once one has, because otherwise it shows *through*
    // the image. Both boxes are rounded by the same radius and both corners
    // are antialiased, so along each of the four arcs the image covers its
    // pixel only partly and the square underneath is what fills the rest — a
    // thin band of the store's colour round every corner, which on the three
    // marks with pale corners reads as a border the tile does not have. The
    // colour is the fallback, so nothing is lost by dropping it the moment
    // there is something in front of it.
    image.addEventListener('load', () => {
      node.style.background = 'transparent'
    })
    node.appendChild(image)
  }
  return node
}
