/**
 * The File System Access members TypeScript does not ship.
 *
 * `lib.dom.d.ts` carries the File System *Standard* — `FileSystemFileHandle`,
 * `FileSystemDirectoryHandle` and the rest of the origin-private surface — and
 * none of the WICG **File System Access** extensions on top of it, which are the
 * only part this application uses. Probed rather than assumed: with TypeScript
 * 5.7, `FileSystemFileHandle` resolves and all of the below are errors.
 *
 * `entries()` is the one member here that TypeScript *does* ship and this
 * project does not take: it lives in `lib.dom.asynciterable.d.ts`, which
 * `tsconfig.json` does not list. Adding that lib to reach one method would pull
 * in every async-iterable declaration in the DOM at once, and the guard below is
 * wanted anyway — Firefox and Safari have no directory picker, so nothing they
 * hand this app ever has it.
 *
 * Every one is declared **optional**, and that is the point of the file rather
 * than an excess of caution. Each is genuinely absent somewhere the app runs:
 * Firefox and Safari have no picker and no `getAsFileSystemHandle`, and Safari
 * implements `FileSystemFileHandle` for the origin-private filesystem *without*
 * the permission methods — so a handle existing is not evidence that
 * `queryPermission` does. Optional members force the guard at every call site,
 * which is exactly the discipline this feature needs to stay invisible in the
 * browsers that cannot support it.
 *
 * Delete this file when `lib.dom.d.ts` carries the extensions; the compiler will
 * say so by reporting duplicate members rather than by going quiet.
 */

interface FileSystemHandlePermissionDescriptor {
  mode?: 'read' | 'readwrite'
}

declare global {
  interface FileSystemHandle {
    queryPermission?(
      descriptor?: FileSystemHandlePermissionDescriptor,
    ): Promise<PermissionState>
    requestPermission?(
      descriptor?: FileSystemHandlePermissionDescriptor,
    ): Promise<PermissionState>
  }

  interface DataTransferItem {
    /** Chromium only. `null` for an item that is not a file. */
    getAsFileSystemHandle?(): Promise<FileSystemHandle | null>
  }

  interface FileSystemDirectoryHandle {
    /** Chromium only; see the header on why it is taken here rather than from a lib. */
    entries?(): AsyncIterableIterator<[string, FileSystemHandle]>
  }

  interface Window {
    showOpenFilePicker?(options?: {
      multiple?: boolean
      excludeAcceptAllOption?: boolean
      types?: Array<{ description?: string; accept: Record<string, string[]> }>
    }): Promise<FileSystemFileHandle[]>
    /**
     * Chromium only. `mode` is asked for explicitly rather than defaulted: what
     * the reader is shown is a permission dialog, and §13's "the app never
     * modifies a file it opened" should be true of the question as well as of
     * the code.
     */
    showDirectoryPicker?(options?: {
      mode?: 'read' | 'readwrite'
      id?: string
      startIn?: string
    }): Promise<FileSystemDirectoryHandle>
  }
}

export {}
