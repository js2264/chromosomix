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
 * URL — so a lab's own catalogue and somebody else's hub sit in the same row as
 * the shipped ones and are reached the same way. The hub comes first of the two
 * because far more of the data in the world is behind one.
 *
 * **Both doors are dashed** (`.store-tile-add`), which is the one cue in the row
 * that a tile asks for an address rather than opening a catalogue that is
 * already there. Only the custom one was, and the hub door — wearing UCSC's own
 * mark, as every remembered hub does — was a solid tile a reader could
 * reasonably expect to browse.
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

const MARK_SIZE = { large: 52, small: 26 } as const

/** The row. Rebuilt by the caller when the list changes — it is at most a handful. */
export function storeTiles(props: StoreTilesProps): HTMLElement {
  const fronts = [...props.fronts, hubStoreFront(), customStore()]
  return el(
    'div',
    { class: `store-tiles store-tiles-${props.size}`, attrs: { role: 'list' } },
    ...fronts.map((front) => tile(front, props)),
  )
}

/**
 * The line under a tile's name: short enough for the two lines it is given.
 *
 * A shipped store writes its own (`registry.ts`), because the first fifty
 * characters of a sentence are a truncation rather than a shorter sentence. A
 * store the reader remembered has no such line — its blurb is the URL it came
 * from — and a URL is the one string here that can be arbitrarily long, so what
 * the tile shows is the **host**, which is the part of it that says whose shelf
 * this is. The whole URL is on the tile's `title` either way.
 */
function tagline(front: StoreFront): string {
  if (front.tagline !== undefined) return front.tagline
  try {
    return new URL(front.blurb).host
  } catch {
    // Not a URL: a blurb written somewhere this module does not know about.
    // Shown as it is, and the row grows a line rather than losing a word.
    return front.blurb
  }
}

/** The two tiles that take an address rather than opening a catalogue. */
const DOORS = new Set(['custom', 'hub'])

function tile(front: StoreFront, props: StoreTilesProps): HTMLElement {
  const on = props.current === front.id
  const node = el(
    'button',
    {
      class: `store-tile${DOORS.has(front.id) ? ' store-tile-add' : ''}${on ? ' is-on' : ''}`,
      type: 'button',
      title: front.blurb,
      // The store's id, so the tutorial can point at one tile (§30) without
      // reading a label that a later build is free to reword.
      attrs: { role: 'listitem', 'aria-pressed': String(on), 'data-store': front.id },
    },
    storeMark(front.mark, MARK_SIZE[props.size]),
    el('span', { class: 'store-tile-name', text: front.label }),
    props.size === 'large' ? el('span', { class: 'store-tile-blurb', text: tagline(front) }) : null,
  )
  node.addEventListener('click', () => props.onPick(front.id))
  return node
}
