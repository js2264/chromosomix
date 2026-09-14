/**
 * What a store's page needs from the window, and the two verbs every row has.
 *
 * A store front knows how to draw a catalogue and nothing about tabs. What it
 * asks of the shell is three things, and they are the three roads the shell
 * already has: open an entry as the thing on screen, join it to what is there,
 * or open several as one picture. The shell decides what those mean for the
 * tab in front — which is where the promise below is kept.
 *
 * ## A store row never destroys a tab
 *
 * Every door to a file in this app is either *replace* or *add* (`App.ts` on
 * the header's `+`), and a store row is neither, because a reader browsing a
 * catalogue beside a map they spent an hour on must not lose it to a
 * misclick on a row. So **open** fills an empty tab and otherwise opens a new
 * one, and **add** joins the open tab — a map beside the map, anything else as
 * a track — which is the routing a dropped file takes. A workspace row is whole
 * tabs and opens as them, through the road `?config=` takes.
 */

import { button } from '../dom'
import { iconButton } from '../icons'
import type { StoreEntry } from '../../state/store'

export interface StoreHost {
  /** Open one entry: an empty tab is filled, otherwise a new tab is opened. */
  open(entry: StoreEntry): void
  /** Join the open tab: a map beside the map, anything else as a track. An empty tab is filled. */
  add(entry: StoreEntry): void
  /**
   * Open several entries as one picture: a lead in a tab, the rest joined to
   * it. The first map is the lead; with no map, the first entry is.
   */
  openTogether(entries: readonly StoreEntry[]): void
  /** Whether the tab in front holds nothing, which decides what the verbs say. */
  tabEmpty(): boolean
}

/** The word on the primary verb, given where it will land. */
export function openLabel(host: StoreHost): string {
  return host.tabEmpty() ? 'open' : 'open in a new tab'
}

/**
 * The verbs on one row.
 *
 * `open` always; `add` only when there is something to add to, because on an
 * empty tab the two are one gesture and a row with two buttons that do the
 * same thing is a row a reader has to think about. A workspace has `open`
 * alone: it is tabs, not a file, and the config road decides where they land.
 */
export function rowActions(entry: StoreEntry, host: StoreHost): HTMLElement[] {
  const open = iconButton(
    'arrow-right',
    entry.kind === 'workspace'
      ? `Open ${entry.label} — a saved session, as its own tab`
      : host.tabEmpty()
        ? `Open ${entry.label} in this tab`
        : `Open ${entry.label} in a new tab. The one in front is left as it is.`,
    () => host.open(entry),
    { class: 'btn-icon store-row-open', size: 14 },
  )
  if (entry.kind === 'workspace' || host.tabEmpty()) return [open]
  const add = button('add', () => host.add(entry), {
    class: 'btn btn-quiet store-row-add',
    title:
      entry.kind === 'map'
        ? `Add ${entry.label} beside the map in front, as a panel of the deck`
        : `Add ${entry.label} to the tab in front, as a track`,
  })
  return [add, open]
}
