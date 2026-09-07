/**
 * Getting files from a reader, and the grant behind them where there is one.
 *
 * Two gestures open a local file — dropping it and choosing it — and in
 * Chromium each has a second form that yields a `FileSystemFileHandle` beside
 * the `File`: `DataTransferItem.getAsFileSystemHandle` and
 * `window.showOpenFilePicker`. The handle is what makes a file re-openable after
 * a reload (`state/handles.ts`).
 *
 * ## Why the grant travels in a `WeakMap` rather than in the signatures
 *
 * There are seven drop targets and six file inputs in this application, and
 * every one of them hands a `File[]` to something that eventually decides what
 * the file *is*. Threading a handle alongside would have meant changing all
 * thirteen signatures and every function between them and the open — for a value
 * that is `null` in two of the three browsers this app runs in.
 *
 * So the shape stays `File[]`, and the grant is recorded against the `File`
 * object itself. `WeakMap` because the key is the file: nothing here extends the
 * life of a `File`, and a page that drops a hundred files and opens one holds
 * one entry a moment later.
 *
 * The grant is stored as a **promise**, deliberately unawaited.
 * `getAsFileSystemHandle` has to be called synchronously inside the drop
 * handler — a `DataTransfer` is neutered the moment the event returns — while
 * nothing needs the answer until the file is opened, which is several awaits
 * later. Kicking it off and remembering the promise is what lets the drop
 * handler stay synchronous and the caller stay ignorant.
 *
 * ## The grant is recorded here and *written down* elsewhere
 *
 * Nothing in this module persists anything. A file that is dropped and never
 * opened leaves no trace, because the write happens where a session actually
 * opens the bytes — see `Session.open`. That is the difference between
 * remembering what a reader chose to look at and keeping a list of everything
 * they ever dragged onto the window.
 */

import { crossOriginFrame } from '../embed'

/** Grants for files this page has been handed, by the `File` they came with. */
const grants = new WeakMap<File, Promise<FileSystemFileHandle | null>>()

/**
 * `true` when a handle is only a handle, rather than a directory.
 *
 * Written against `undefined` as well as `null`, which the type does not admit
 * and a browser does: `getAsFileSystemHandle` on an item of a `DataTransfer`
 * built in script — which is what a synthetic drop is — resolves to `undefined`
 * rather than to either. A `TypeError` thrown here lands in the `then` below,
 * past the rejection handler beside it, and leaves the grant promise rejected
 * for whoever awaits it later.
 */
function isFileHandle(
  handle: FileSystemHandle | null | undefined,
): handle is FileSystemFileHandle {
  return handle != null && handle.kind === 'file'
}

function record(file: File, grant: Promise<FileSystemHandle | null>): void {
  grants.set(
    file,
    grant.then(
      (handle) => (isFileHandle(handle) ? handle : null),
      // A rejection here is a browser declining to describe a dropped file,
      // which costs the reader the *memory* of it and nothing else. The file
      // itself opens normally.
      () => null,
    ),
  )
}

/**
 * The files in a drop, with any grants noted on the way past.
 *
 * A drop-in replacement for `Array.from(event.dataTransfer?.files ?? [])`, which
 * is what every drop target in this app was doing, and returns exactly what that
 * returned. Call it **synchronously** in the handler.
 *
 * The pairing is by position: `DataTransfer.items` may hold strings as well as
 * files — a drag out of a text field, a URL from another window — so only the
 * `'file'` ones are counted, and those are in the same order as
 * `DataTransfer.files`.
 */
export function filesFrom(transfer: DataTransfer | null | undefined): File[] {
  const files = Array.from(transfer?.files ?? [])
  const items = Array.from(transfer?.items ?? []).filter((item) => item.kind === 'file')
  if (items.length === files.length) {
    for (const [index, item] of items.entries()) {
      const ask = item.getAsFileSystemHandle
      if (typeof ask !== 'function') break
      // Started now, awaited much later. See the header on why this must not be
      // an `await`: the transfer is dead once this handler returns.
      record(files[index], ask.call(item))
    }
  }
  return files
}

/**
 * Ask the reader to choose files.
 *
 * Uses the picker that yields grants where the browser has one, and an ordinary
 * `<input type="file">` where it does not — which is Firefox, Safari, and any
 * embedding that has disabled the newer picker. Both answer with the same
 * `File[]`, and a cancelled dialog answers with an empty one rather than never
 * answering at all.
 */
export async function chooseFiles(options: { multiple?: boolean } = {}): Promise<File[]> {
  const multiple = options.multiple ?? true
  // "Any embedding that has disabled the newer picker" is the case above, and
  // `typeof` is not how it is detected: a cross-origin frame *has* the function
  // and rejects the call (`src/embed.ts`). That rejection lands in the `catch`
  // below, which reads it as a cancelled dialog — so without this line an
  // embedded viewer offers a Choose-files button that does nothing at all, which
  // is the one outcome worse than not offering it.
  const picker =
    typeof window === 'undefined' || crossOriginFrame() ? undefined : window.showOpenFilePicker
  if (typeof picker === 'function') {
    let handles: FileSystemFileHandle[]
    try {
      handles = await picker.call(window, { multiple })
    } catch {
      // `AbortError` for a cancelled dialog, `SecurityError` for one called
      // without activation. Neither is worth a message: the reader either
      // changed their mind or is about to try again.
      return []
    }
    const files: File[] = []
    for (const handle of handles) {
      try {
        const file = await handle.getFile()
        record(file, Promise.resolve(handle))
        files.push(file)
      } catch {
        /* chosen and then moved, between two lines. Skip it. */
      }
    }
    return files
  }
  return chooseThroughInput(multiple)
}

/**
 * The fallback, and the only path in this module that touches the document.
 *
 * The input is created, used and removed rather than kept: a hidden `<input>`
 * living in the tree is a focusable node in everybody's tab order, and this one
 * would be in it for the whole life of the page.
 */
function chooseThroughInput(multiple: boolean): Promise<File[]> {
  return new Promise<File[]>((resolve) => {
    const input = document.createElement('input')
    input.type = 'file'
    input.multiple = multiple
    input.className = 'hidden-input'
    let settled = false
    const finish = (files: File[]): void => {
      if (settled) return
      settled = true
      input.remove()
      resolve(files)
    }
    input.addEventListener('change', () => finish(Array.from(input.files ?? [])))
    // Not universal, and harmless where it is missing: a reader who cancels
    // simply leaves this promise unsettled, which is what the old inline inputs
    // did too. Where it exists, the promise is tidied up instead.
    input.addEventListener('cancel', () => finish([]))
    document.body.appendChild(input)
    input.click()
  })
}

/**
 * The grant behind a file, if this page was given one.
 *
 * `null` for every file in a browser without the API, for a file that arrived
 * through the fallback input, and for one dropped from a source that declined to
 * describe it. Callers treat all three the same way: the file opens, and it is
 * simply not remembered.
 */
export async function grantFor(file: File): Promise<FileSystemFileHandle | null> {
  return (await grants.get(file)) ?? null
}
