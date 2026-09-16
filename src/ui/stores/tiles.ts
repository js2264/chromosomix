/**
 * The row of stores, as tiles: one square per store, the mark on it, the name
 * and one line under it.
 *
 * Two sizes of the same thing. **Large**, on the landing page, where the row is
 * the second of the two things a reader can do — load files, or connect to a
 * store — and each tile earns a sentence. **Small**, along the drawer's head,
 * where the row is how a reader switches store without closing it, and the
 * name is enough.
 *
 * The last two tiles are always the doors: a **track hub**, and a store file by
 * URL — the second a dashed square with a `+` — so a lab's own shelf and
 * somebody else's hub sit in the same row as the shipped ones and are reached
 * the same way. The hub comes first of the two because far more of the data in
 * the world is behind one.
 */

import { el } from '../dom'
import { storeMark } from './marks'
import { customStore, hubStoreFront, type StoreFront } from './registry'

export interface StoreTilesProps {
  fronts: readonly StoreFront[]
  size: 'large' | 'small'
  /** The store that is open, drawn as such. */
  current?: string | null
  onPick(id: string): void
}

const MARK_SIZE = { large: 72, small: 26 } as const

/** The row. Rebuilt by the caller when the list changes — it is at most a handful. */
export function storeTiles(props: StoreTilesProps): HTMLElement {
  const fronts = [...props.fronts, hubStoreFront(), customStore()]
  return el(
    'div',
    { class: `store-tiles store-tiles-${props.size}`, attrs: { role: 'list' } },
    ...fronts.map((front) => tile(front, props)),
  )
}

function tile(front: StoreFront, props: StoreTilesProps): HTMLElement {
  const on = props.current === front.id
  const node = el(
    'button',
    {
      class: `store-tile${front.id === 'custom' ? ' store-tile-add' : ''}${on ? ' is-on' : ''}`,
      type: 'button',
      title: props.size === 'small' ? front.blurb : '',
      attrs: { role: 'listitem', 'aria-pressed': String(on) },
    },
    storeMark(front.mark, MARK_SIZE[props.size]),
    el('span', { class: 'store-tile-name', text: front.label }),
    props.size === 'large' ? el('span', { class: 'store-tile-blurb', text: front.blurb }) : null,
  )
  node.addEventListener('click', () => props.onPick(front.id))
  return node
}
