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

import { rowVerbs } from '../rowVerbs'
import type { StoreEntry } from '../../state/store'

export interface StoreHost {
  /** Open one entry: an empty tab is filled, otherwise a new tab is opened. */
  open(entry: StoreEntry): void
  /**
   * The same, and then **load the tracks the entry carries**.
   *
   * Its own verb rather than a flag on {@link StoreHost.open}, because the two
   * are different promises. *Open* is one file and whatever the reader does
   * next; *open with its tracks* is a sentence that has to come true, and a
   * reader who presses it and gets a genome with a button offering the tracks
   * has been handed the thing they just pressed past (§24.10).
   */
  openWithTracks(entry: StoreEntry): void
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

/**
 * The verbs on one row: the pair every file row in the app carries
 * (`ui/rowVerbs.ts`), bound to the two roads above. A workspace has the second
 * alone: it is tabs, not a file, and the config road decides where they land.
 */
export function rowActions(entry: StoreEntry, host: StoreHost): HTMLElement[] {
  return rowVerbs({
    label: entry.label,
    kind: entry.kind,
    tabEmpty: host.tabEmpty(),
    onAdd: () => host.add(entry),
    onNew: () => host.open(entry),
  })
}
