/**
 * A directory on this machine, as a folder — in two shapes, because browsers
 * disagree about whether a directory is a thing a page may hold.
 *
 * ## The two shapes, and why both exist
 *
 * **A grant** (`showDirectoryPicker`, Chromium and the desktop build). The
 * reader points at a directory once and the page holds a
 * `FileSystemDirectoryHandle`: a capability, not a copy and not a path. Every
 * listing is read through it at the moment it is asked for, so the folder is
 * *live* — a file written into it by a pipeline five minutes later is simply
 * there — and the handle is structured-cloneable, so it survives in IndexedDB
 * and the folder is still connected after a reload. This is what "Connect"
 * means when the browser can mean it.
 *
 * **A snapshot** (`<input webkitdirectory>`, everywhere else). Firefox and
 * Safari have no picker, and what they do have hands back a **flat** `File[]`
 * where each file carries a `webkitRelativePath`. The tree is rebuilt from those
 * strings, once, and that is the whole of what the page will ever know: it does
 * not update, and it does not survive a reload, because a `File` is a set of
 * bytes the page was handed rather than permission to go and get them.
 *
 * They are not the same feature and the panel says so on the row
 * ({@link ConnectedFolder.durable}). A reader who connected a directory in
 * Firefox and finds it gone after a reload has been told something at the wrong
 * moment; the alternative — offering it only in Chromium — takes a working
 * gesture away from two browsers this app supports, to avoid explaining one
 * sentence.
 *
 * ## What a connected directory is, in privacy terms
 *
 * A broader grant than a chosen file, and it is worth being exact about how.
 * The page can now *see the names* of everything under the directory and read
 * any of them without a further gesture — that is what makes browsing possible —
 * and, for the durable shape, it can do so again after a restart. What has not
 * changed at all is where the bytes go: nowhere. §11 holds exactly as it held
 * for a dropped file, `LocalFileSource` reads a slice at a time from a `File`
 * object obtained here, and no byte crosses a network. The grant is listed and
 * revocable in the stored-data screen for the same reason a file grant is
 * (`state/handles.ts`).
 *
 * Read-only throughout: the picker is asked in `'read'` mode, and §13's "the app
 * never modifies a file it opened" is a rule about the whole application rather
 * than a property of the API being used.
 */

import {
  LISTING_CAP,
  ordered,
  type ConnectedFolder,
  type FolderEntry,
  type FolderListing,
  type PickedFile,
} from './folder'
import { indexNamesFor } from '../annotations/sidecar'
import { crossOriginFrame } from '../embed'

/**
 * `true` where this browser can hold a directory at all — the grant shape.
 *
 * The frame check is the third browser this app runs in that has the picker and
 * cannot use it: a cross-origin frame answers `'function'` and then rejects the
 * call (`src/embed.ts`). Answering `false` here is what routes an embedded
 * viewer to the snapshot path below, which is the same path Firefox and Safari
 * have always taken and which works in a frame.
 */
export function directoryPickerSupported(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.showDirectoryPicker === 'function' &&
    !crossOriginFrame()
  )
}

/**
 * Ask for a directory, the grant way. `null` if the reader cancels or cannot.
 *
 * `'read'` mode explicitly. The default is also read, and saying so is the line
 * that keeps §13 true of the permission the reader is actually shown: a dialog
 * offering write access to a directory is a different question from the one this
 * app means to ask.
 */
export async function chooseDirectory(): Promise<FileSystemDirectoryHandle | null> {
  const picker = typeof window === 'undefined' ? undefined : window.showDirectoryPicker
  if (typeof picker !== 'function') return null
  try {
    return await picker.call(window, { mode: 'read' })
  } catch {
    // `AbortError` for a cancelled dialog, `SecurityError` for one called
    // without activation or from an opaque origin — which is what the standalone
    // `file://` build is. All three answer `null`, and the caller takes `null`
    // for a cancel: `connectDirectory` does not go on to the snapshot picker,
    // so where this picker refuses, nothing opens and nothing is said.
    return null
  }
}

/**
 * Ask for a directory, the snapshot way. `[]` if the reader cancels.
 *
 * The input is created, used and removed rather than kept, for
 * `ui/chooseFiles.ts`'s reason: a hidden `<input>` living in the tree is a
 * focusable node in everybody's tab order for the whole life of the page.
 */
export function chooseDirectoryFiles(): Promise<File[]> {
  return new Promise<File[]>((resolve) => {
    const input = document.createElement('input')
    input.type = 'file'
    input.className = 'hidden-input'
    // Not in the typed surface — it is a non-standard attribute two engines
    // implement and one standardised under another name — so it is set rather
    // than assigned.
    input.setAttribute('webkitdirectory', '')
    input.setAttribute('directory', '')
    input.multiple = true
    let settled = false
    const finish = (files: File[]): void => {
      if (settled) return
      settled = true
      input.remove()
      resolve(files)
    }
    input.addEventListener('change', () => finish(Array.from(input.files ?? [])))
    // Not universal, and harmless where it is missing: a reader who cancels
    // simply leaves this promise unsettled, exactly as the file input does.
    input.addEventListener('cancel', () => finish([]))
    document.body.appendChild(input)
    input.click()
  })
}

/**
 * The directory a granted handle names.
 *
 * Every listing walks down from the root handle rather than caching the handles
 * along the way. That is a handful of `getDirectoryHandle` calls against an
 * in-process API to draw one level, which is not a cost worth a cache — and a
 * cache is precisely what would make the live property above stop being true,
 * by holding a handle to a directory that has since been renamed.
 */
export function handleFolder(
  id: string,
  label: string,
  handle: FileSystemDirectoryHandle,
): ConnectedFolder {
  const walk = async (path: string): Promise<FileSystemDirectoryHandle> => {
    let at = handle
    for (const part of path.split('/')) {
      if (part === '') continue
      at = await at.getDirectoryHandle(part)
    }
    return at
  }

  return {
    id,
    label,
    kind: 'local',
    root: '',
    durable: true,

    async list(path: string): Promise<FolderListing> {
      const directory = await walk(path)
      const entries: FolderEntry[] = []
      // `entries()` is a Chromium extension and is not in `lib.dom` at this
      // TypeScript version, so it is declared optional in `state/fsa.d.ts` and
      // guarded here. A handle without it cannot have come from a picker this
      // module called, but the guard is what the optional type is for.
      const iterate = directory.entries
      if (typeof iterate !== 'function') return { entries, truncated: false }
      let seen = 0
      let truncated = false
      for await (const [name, child] of iterate.call(directory)) {
        // One past the cap is enough to know there are more. Reading the rest
        // of a forty-thousand-file directory to count them would be the cost
        // the cap exists to avoid.
        if (seen >= LISTING_CAP) {
          truncated = true
          break
        }
        seen++
        // Dotfiles are skipped. A directory listing that opens with `.DS_Store`
        // and four `.git` entries is a listing of somebody's tooling, and none
        // of it is a file this application opens.
        if (name.startsWith('.')) continue
        entries.push({
          kind: child.kind === 'directory' ? 'folder' : 'file',
          name,
          path: child.kind === 'directory' ? `${path}${name}/` : `${path}${name}`,
          // Not read. A `File` per row is a `getFile()` per row, which turns
          // drawing a list into as many calls as it has entries — for a number
          // the reader has not asked for yet. The row shows it once picked.
          size: null,
        })
      }
      return { entries: ordered(entries), truncated }
    },

    async pick(entry: FolderEntry): Promise<PickedFile> {
      const slash = entry.path.lastIndexOf('/')
      const directory = await walk(slash === -1 ? '' : entry.path.slice(0, slash + 1))
      const file = await (await directory.getFileHandle(entry.name)).getFile()
      // The sidecar beside it, if the folder holds one. Picking a `.bam` whose
      // `.bai` is one row down and greyed out, and then being told to run
      // `samtools index`, is the least useful thing this could do.
      let index: File | undefined
      for (const name of indexNamesFor(entry.name)) {
        try {
          index = await (await directory.getFileHandle(name)).getFile()
          break
        } catch {
          // Not there. The next candidate spelling, then no index at all.
        }
      }
      // The bare name, as every other local open in this app uses: a URI is what
      // a session is *of*, `state/handles.ts` keys grants by it, and a relative
      // path would make `rep1.cool` from a connected folder a different file
      // from the same `rep1.cool` dropped on the window.
      return {
        uri: file.name,
        source: { kind: 'local', file },
        ...(index === undefined ? {} : { index }),
      }
    },
  }
}

/**
 * The directory a flat `File[]` describes.
 *
 * The tree is derived once, from `webkitRelativePath`, and then this answers out
 * of memory. Every browser that takes this path gives every file the same first
 * segment — the directory's own name — and that segment is dropped, so the root
 * of the folder is the directory the reader chose rather than a single node
 * containing it.
 */
export function snapshotFolder(id: string, label: string, files: readonly File[]): ConnectedFolder {
  /** Relative path (without the leading directory name) → the file. */
  const byPath = new Map<string, File>()
  for (const file of files) {
    const relative = (file.webkitRelativePath ?? '').split('/').slice(1).join('/')
    byPath.set(relative === '' ? file.name : relative, file)
  }

  return {
    id,
    label,
    kind: 'local',
    root: '',
    // The half of "connected" this shape cannot keep. See the module header.
    durable: false,

    async list(path: string): Promise<FolderListing> {
      const folders = new Set<string>()
      const entries: FolderEntry[] = []
      for (const [relative, file] of byPath) {
        if (!relative.startsWith(path)) continue
        const rest = relative.slice(path.length)
        if (rest === '') continue
        const slash = rest.indexOf('/')
        if (slash === -1) {
          if (rest.startsWith('.')) continue
          entries.push({ kind: 'file', name: rest, path: relative, size: file.size })
          continue
        }
        // A sub-folder is named by every file under it, so it is collected in a
        // set and emitted once.
        const name = rest.slice(0, slash)
        if (name.startsWith('.')) continue
        folders.add(name)
      }
      for (const name of folders) {
        entries.push({ kind: 'folder', name, path: `${path}${name}/`, size: null })
      }
      const sorted = ordered(entries)
      return { entries: sorted.slice(0, LISTING_CAP), truncated: sorted.length > LISTING_CAP }
    },

    async pick(entry: FolderEntry): Promise<PickedFile> {
      const file = byPath.get(entry.path)
      if (file === undefined) throw new Error(`${entry.name} is no longer in this folder.`)
      const slash = entry.path.lastIndexOf('/')
      const at = slash === -1 ? '' : entry.path.slice(0, slash + 1)
      let index: File | undefined
      for (const name of indexNamesFor(entry.name)) {
        index = byPath.get(`${at}${name}`)
        if (index !== undefined) break
      }
      return {
        uri: file.name,
        source: { kind: 'local', file },
        ...(index === undefined ? {} : { index }),
      }
    },
  }
}
