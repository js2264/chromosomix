/**
 * The two switches a called set carries: **on the map** and **as a lane**
 * (§18.7).
 *
 * Each is the `visible` of one of the set's two rows (`analysis/surfaces.ts`),
 * so a switch here and the eye on that row are one setting seen from two
 * places, and a session remembers it as it remembers any row being hidden
 * (§8.6). Offered in the drawer under the run that called the set and in the
 * settings of either row, which is where a reader looking at one surface asks
 * for the other.
 */

import type { AnnotationStore } from '../annotations/store'
import type { AnnotationEntry } from '../annotations/types'
import { surfacesOf } from '../analysis/surfaces'
import { button, el } from './dom'

/** The pair of chips, or `null` for a row that is not half of a called set. */
export function surfaceToggles(store: AnnotationStore, entry: AnnotationEntry): HTMLElement | null {
  const pair = surfacesOf(store, entry)
  if (pair === null) return null
  const chip = (text: string, id: string, title: string): HTMLButtonElement => {
    const paint = (on: boolean): void => {
      chip.classList.toggle('is-on', on)
      chip.setAttribute('aria-pressed', String(on))
    }
    const chip = button(
      text,
      () => {
        const live = store.byId(id)
        if (live === undefined) return
        store.update(id, { visible: !live.visible })
        paint(!live.visible)
      },
      { class: 'btn btn-chip', title },
    )
    paint(store.byId(id)?.visible ?? false)
    return chip
  }
  return el(
    'div',
    { class: 'ann-chips ann-surfaces' },
    el('span', { class: 'field-label', text: 'drawn' }),
    chip(
      'on the map',
      pair.overlay.id,
      'On the contact map it was called from, as an overlay — the row with the shape, the opacity and the maps.',
    ),
    chip(
      'as a lane',
      pair.lane.id,
      'As a lane of segments beside the map and in the 1D browser, under the track it was read against — coloured, exported and searched like a loaded BED.',
    ),
  )
}
