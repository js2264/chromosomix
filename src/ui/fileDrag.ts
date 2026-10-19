/**
 * A file that has not been read yet, dragged.
 *
 * Every drop target in this application was written for one of two things: an
 * operating-system drag carrying `DataTransfer.files`, or a track row being
 * moved between the map's edges (`TRACK_DRAG_TYPE`). A row in the Files panel is
 * neither. It names a file in a connected folder — a key on a bucket, an entry
 * in a granted directory — and there are no bytes behind it until somebody asks
 * for them, which is the whole reason the panel can list four hundred rows
 * without reading anything.
 *
 * So it travels as a third type, and the targets learn one more branch. That is
 * the same shape `TRACK_DRAG_TYPE` established and it is here for the same
 * reason: `types` is all a browser exposes *during* a drag, and a target has to
 * decide whether to light up long before it can look at what it is being handed.
 *
 * **A row of a store is the same thing** (§24.2): a file nobody has read, named
 * by an address rather than by a folder. It travels under the same type, so
 * every target that takes a Files row takes a store row too — a map's edges and
 * middle, a cell of the deck, the Tracks card, an analysis form's file box, the
 * landing page — and none of them can tell which list the hand came from.
 *
 * ## Two payloads, and only one of them is trustworthy
 *
 * The custom type carries JSON — the folder's id and the entry's path, or, for
 * a store row, a token naming the drag ({@link writePickedDrag}) — which is
 * what {@link readFileDrag} resolves back into a real file. It is readable only
 * at `drop`, like every other `getData`.
 *
 * `text/plain` is set as well and carries the **name** — a store row's address,
 * which is the useful thing about it outside this app — so dragging a row into
 * a text box somewhere else does something sensible instead of nothing. Nothing
 * in this app ever reads it: a plain string is what a text selection dragged out
 * of any input carries too, and a target that trusted it would offer to load a
 * file because somebody dragged a word across the map.
 *
 * ## Resolving happens at the drop, never at the drag
 *
 * A drag may end anywhere or nowhere, and reading a file for one that is going
 * to be cancelled is a permission prompt or a network request for a gesture the
 * reader abandoned. {@link readFileDrag} is therefore async and is called by the
 * target that accepted the drop, once.
 */

import { folderById } from '../browse/connected'
import type { PickedFile } from '../browse/folder'
import { noteLocation } from '../state/locations'

/**
 * The type a dragged **unread file** carries.
 *
 * Lowercase, because a browser lowercases every type it stores and a comparison
 * against a capital would never match — the note `TRACK_DRAG_TYPE` carries, for
 * the same reason.
 */
export const FILE_DRAG_TYPE = 'application/x-chromosomix-file'

/** Whether a drag is carrying a row out of the Files panel. */
export function dragHasFileRow(event: DragEvent): boolean {
  return Array.from(event.dataTransfer?.types ?? []).includes(FILE_DRAG_TYPE)
}

/** Mark a drag as carrying `path` in the folder `folderId`. */
export function writeFileDrag(
  event: DragEvent,
  folderId: string,
  path: string,
  name: string,
): void {
  const transfer = event.dataTransfer
  if (transfer === null) return
  transfer.effectAllowed = 'copy'
  transfer.setData(FILE_DRAG_TYPE, JSON.stringify({ folder: folderId, path, name }))
  // For everywhere that is not this app. See the header on why nothing here
  // reads it back.
  transfer.setData('text/plain', name)
}

/**
 * The file a drag out of a store is carrying, held here and named in the
 * payload by its token — see {@link writePickedDrag}.
 */
let carried: { token: string; picked: PickedFile; taken?: () => void } | null = null
/** How many such drags this page has started, which is what a token is minted from. */
let carriedCount = 0

/**
 * Mark a drag as carrying a file this window already has the address of — a
 * row of a store (§24.2) — rather than an entry of a connected folder.
 *
 * The payload names a **token**, and the file stays here. An address in the
 * payload would make this type a way for any page to have this one open any
 * URL, by dragging something across it with the right label on; a token
 * resolves only to the drag this window started, as a folder id resolves only
 * to a folder this window is connected to. A drag from another window of the
 * app resolves to nothing, as a row of a folder that window never connected
 * does. One is held at a time, since there is one hand.
 *
 * `taken` runs when a target takes the file, before it is opened: a store row
 * registers the tracks it brings with it there (`App.noteShelf`), as its two
 * buttons do — and a drag that was abandoned registers nothing.
 */
export function writePickedDrag(event: DragEvent, picked: PickedFile, taken?: () => void): void {
  const transfer = event.dataTransfer
  if (transfer === null) return
  const token = `drag-${++carriedCount}`
  carried = { token, picked, ...(taken === undefined ? {} : { taken }) }
  transfer.effectAllowed = 'copy'
  transfer.setData(FILE_DRAG_TYPE, JSON.stringify({ held: token, name: picked.name ?? picked.uri }))
  // The address: a store's file is somewhere anybody can fetch it, so its URL
  // is what a terminal or a notebook it is dropped into can use.
  transfer.setData('text/plain', picked.uri)
}

/**
 * The file a drop was carrying, or `null`.
 *
 * `null` covers every way this can fail to produce a file — a payload that is
 * not ours, a folder disconnected between the drag and the drop, an entry that
 * has been deleted since it was listed, a lapsed grant, a store row's drag
 * that another has replaced — because there is one thing a drop target does
 * about all of them, which is nothing. The panel the drag came from is still on
 * screen with the same row on it, and a message about a drag the reader has
 * already finished is a message with nowhere to go.
 */
export async function readFileDrag(event: DragEvent): Promise<PickedFile | null> {
  const raw = event.dataTransfer?.getData(FILE_DRAG_TYPE) ?? ''
  if (raw === '') return null
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null) return null
  const payload = parsed as { folder?: unknown; path?: unknown; name?: unknown; held?: unknown }
  if (typeof payload.held === 'string') {
    if (carried === null || carried.token !== payload.held) return null
    carried.taken?.()
    return carried.picked
  }
  if (typeof payload.folder !== 'string' || typeof payload.path !== 'string') return null
  if (typeof payload.name !== 'string') return null
  const folder = folderById(payload.folder)
  if (folder === null) return null
  try {
    const picked = await folder.pick({ kind: 'file', name: payload.name, path: payload.path, size: null })
    // As a row opened by a click is (`FilesCard`): where it came from (§20.6).
    noteLocation(picked)
    return picked
  } catch {
    return null
  }
}
