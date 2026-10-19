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
 * tabs and opens as them, through the road `?config=` takes. A third road is
 * the hand: a row dragged out of the drawer and let go somewhere says *where*,
 * as a row of the Files column does ({@link rowDrag}).
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
  /**
   * A row was taken hold of: mark the drag as carrying its file
   * (`ui/fileDrag.ts`), so it can be let go wherever a row of the Files column
   * can (§20.5) — the shell's, because the file a row names and the tracks it
   * brings are what its two verbs open, and a third account of them here would
   * be the one to drift.
   */
  drag(entry: StoreEntry, event: DragEvent): void
  /** Whether the tab in front holds nothing, which decides what the verbs say. */
  tabEmpty(): boolean
}

/**
 * Make a store row draggable, as a row of the Files column is (§20.5, §24.2):
 * let go on a map's edge or its middle, on a cell of the deck, on the Tracks
 * card or on an analysis form's file box, the file opens there, and no list
 * can be told from the other by where its rows land.
 *
 * Not a workspace's row. It is tabs and not a file, and there is nowhere one
 * could be aimed — which is why a saved workspace is not a draggable row in a
 * folder either.
 */
export function rowDrag(row: HTMLElement, entry: StoreEntry, host: StoreHost): HTMLElement {
  if (entry.kind === 'workspace') return row
  row.draggable = true
  row.classList.add('is-draggable')
  row.addEventListener('dragstart', (event) => host.drag(entry, event))
  return row
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
