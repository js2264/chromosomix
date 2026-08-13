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
 * ## Two payloads, and only one of them is trustworthy
 *
 * The custom type carries JSON — the folder's id and the entry's path — which
 * is what {@link readFileDrag} resolves back into a real file. It is readable
 * only at `drop`, like every other `getData`.
 *
 * `text/plain` is set as well and carries the **name**, so dragging a row into a
 * text box somewhere else does something sensible instead of nothing. Nothing in
 * this app ever reads it: a plain string is what a text selection dragged out of
 * any input carries too, and a target that trusted it would offer to load a file
 * because somebody dragged a word across the map.
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

/**
 * The type a dragged **unread file** carries.
 *
 * Lowercase, because a browser lowercases every type it stores and a comparison
 * against a capital would never match — the note `TRACK_DRAG_TYPE` carries, for
 * the same reason.
 */
export const FILE_DRAG_TYPE = 'application/x-metacooler-file'

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
 * The file a drop was carrying, or `null`.
 *
 * `null` covers every way this can fail to produce a file — a payload that is
 * not ours, a folder disconnected between the drag and the drop, an entry that
 * has been deleted since it was listed, a lapsed grant — because there is one
 * thing a drop target does about all of them, which is nothing. The panel the
 * drag came from is still on screen with the same row on it, and a message
 * about a drag the reader has already finished is a message with nowhere to go.
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
  const payload = parsed as { folder?: unknown; path?: unknown; name?: unknown }
  if (typeof payload.folder !== 'string' || typeof payload.path !== 'string') return null
  if (typeof payload.name !== 'string') return null
  const folder = folderById(payload.folder)
  if (folder === null) return null
  try {
    return await folder.pick({ kind: 'file', name: payload.name, path: payload.path, size: null })
  } catch {
    return null
  }
}
