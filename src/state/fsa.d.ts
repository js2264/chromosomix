/**
 * The three File System Access members TypeScript does not ship.
 *
 * `lib.dom.d.ts` carries the File System *Standard* — `FileSystemFileHandle`,
 * `FileSystemDirectoryHandle` and the rest of the origin-private surface — and
 * none of the WICG **File System Access** extensions on top of it, which are the
 * only part this application uses. Probed rather than assumed: with TypeScript
 * 5.7, `FileSystemFileHandle` resolves and all three below are errors.
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

  interface Window {
    showOpenFilePicker?(options?: {
      multiple?: boolean
      excludeAcceptAllOption?: boolean
      types?: Array<{ description?: string; accept: Record<string, string[]> }>
    }): Promise<FileSystemFileHandle[]>
  }
}

export {}
