/**
 * The two verbs every file row carries: **add it here**, or **open it in a new
 * session**.
 *
 * One pair of marks for every place a file is offered — a store row, a folder
 * row in the Files column, the tray under a portal — so that a reader who has
 * learnt them once has learnt them everywhere. Both are icons and nothing
 * else: a `+` for joining what is on screen, which is the mark the tab strip
 * and the Tracks card already use for *more of this*, and a window with a `+`
 * where its corner was for a session of its own. The words are in the
 * tooltips, which is also where they say what *add* means for this kind of
 * file: a map goes beside the map in front as a panel of the deck, anything
 * else is drawn on it as a track (§20.5, §24.2).
 *
 * Both are offered whatever the tab holds. On an empty tab the two land in the
 * same place — there is nothing to join and nothing to leave alone — and the
 * tooltips say so rather than one of the buttons vanishing: a row that has two
 * marks in one store and one mark in the next is a row a reader has to think
 * about. A workspace is the one exception, because it is tabs and not a file:
 * it opens, and there is nothing it could be *added* to.
 */

import { icon, iconButton } from './icons'

export interface RowVerbs {
  /** What the row names, for the two tooltips. */
  label: string
  /** How the file is drawn once opened, which is what *add* has to describe. */
  kind: 'map' | 'genome' | 'workspace' | 'unknown'
  /** Whether the tab in front holds nothing, which is when the two verbs meet. */
  tabEmpty: boolean
  onAdd: () => void
  onNew: () => void
}

/** The two buttons, in the order they stand on a row: add, then new. */
export function rowVerbs(verbs: RowVerbs): HTMLButtonElement[] {
  const fresh = iconButton('new-session', newTitle(verbs), verbs.onNew, {
    class: 'btn btn-icon row-verb row-verb-new',
    size: 14,
  })
  if (verbs.kind === 'workspace') return [fresh]
  const add = iconButton('plus', addTitle(verbs), verbs.onAdd, {
    class: 'btn btn-icon row-verb row-verb-add',
    size: 14,
  })
  return [add, fresh]
}

/**
 * The new-session mark on a button that has words as well: a gallery card's
 * *open*, a group's *open with its tracks*. The same glyph as the row's second
 * verb, so a labelled button and an icon-only one read as one gesture.
 */
export function withNewMark(node: HTMLButtonElement): HTMLButtonElement {
  node.prepend(icon('new-session', { size: 13 }))
  node.classList.add('btn-marked')
  return node
}

function addTitle(verbs: RowVerbs): string {
  if (verbs.tabEmpty) return `Open ${verbs.label} in this session, which is empty.`
  return verbs.kind === 'map'
    ? `Add ${verbs.label} to this session, beside the map in front as a panel of the deck.`
    : `Add ${verbs.label} to this session, as a track.`
}

function newTitle(verbs: RowVerbs): string {
  if (verbs.kind === 'workspace') return `Open ${verbs.label} — a saved session — as its own tab.`
  if (verbs.tabEmpty) return `Open ${verbs.label} in a new session — this one, since it is empty.`
  return `Open ${verbs.label} in a new session. The one in front is left as it is.`
}
