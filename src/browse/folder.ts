/**
 * A place full of files, read one level at a time — the shape, and nothing else.
 *
 * Two things are folders to this application: a directory on the machine, and a
 * key prefix on a bucket. They have almost nothing in common underneath. One is
 * an in-process capability handed over by a permission dialog, the other is an
 * XML document over HTTPS; one has no size limit and answers instantly, the
 * other stops at a thousand keys and costs a round trip. What they *do* have in
 * common is the only thing the interface above them needs: given a path, here
 * are the sub-folders and here are the files, and given a file, here is how to
 * open it.
 *
 * So that is the interface, and the two backends (`browse/local.ts`,
 * `browse/bucket.ts`) are the whole of the difference. The Files panel never
 * asks which kind it is holding, which is the point — "a local folder or an S3
 * bucket, read the same way" is a property of this file being small rather than
 * a feature implemented twice.
 *
 * ## One level, never a walk
 *
 * {@link ConnectedFolder.list} lists one path and returns its immediate
 * children. Nothing here recurses, and that is a constraint rather than an
 * omission: on a bucket a recursive listing is one signed request per prefix
 * against a key that may be allowed some of them and not others, and on a disk
 * it is an unbounded walk of somebody's home directory to draw a sidebar. The
 * folder view is the folder, not an index of it — the same rule
 * `ui/bucketBrowse.ts` states about its filter.
 *
 * ## Paths are the backend's own, and opaque above it
 *
 * A path is whatever the backend hands back in {@link FolderEntry.path}, passed
 * to `list` unchanged. For a bucket it is a full key prefix, which is what S3
 * wants; for a local folder it is a relative path from the connected root. No
 * path arithmetic happens above this layer, so there is nowhere for the two
 * conventions to be confused for one another.
 *
 * The one convention they share is that **a folder path ends in `/`** and a file
 * path does not, because the crumb trail is built by splitting on it.
 */

import type { SourceSpec } from '../worker/protocol'

/** One row: a sub-folder, or a file that can be opened. */
export interface FolderEntry {
  kind: 'folder' | 'file'
  /** The last segment — what a row shows. */
  name: string
  /** Opaque above this layer. Hand it back to `list` or `pick`. */
  path: string
  /** Bytes, where the backend knows. `null` for a local entry not yet read. */
  size: number | null
}

export interface FolderListing {
  entries: FolderEntry[]
  /**
   * `true` when the listing stopped early.
   *
   * A bucket stops at S3's thousand-key page and a local folder stops at
   * {@link LISTING_CAP}. Both say so rather than drawing a partial folder,
   * because "my file is not here" and "my file is past the cap" look identical
   * otherwise and only one of them is something a reader can act on.
   */
  truncated: boolean
}

/**
 * What a chosen file resolves to: a URI to call it by, and where its bytes are.
 *
 * Deliberately *not* `{ uri, source, file }`. The `File` is already inside a
 * local `source` and a second copy of it is a second thing that can disagree —
 * callers narrow on `source.kind` instead, which the compiler checks.
 */
export interface PickedFile {
  uri: string
  source: SourceSpec
  /**
   * The sidecar index sitting beside it in the folder, where there is one.
   *
   * A `.bam` picked out of a listing whose `.bai` is right there, one row down
   * and drawn as inert, should not be refused for want of an index (§8.13) —
   * and a bgzipped feature file should not quietly read itself whole. Local
   * only: a bucket's sidecar is named by URL and guessed by the loader.
   */
  index?: File
  /**
   * What to call the file when its URI does not say.
   *
   * A Drive file is addressed by an id (`…/files/<id>?alt=media`) and a Dropbox
   * file by a temporary link that may not end in its name, so a backend that
   * knows the name hands it over here and the session names the map with it
   * (§16.10). Absent for a local file and for a bucket key, whose last segment
   * already is the name.
   */
  name?: string
}

/**
 * A folder somebody has connected, whichever kind it is.
 *
 * `id` is stable across reloads and is what a drag payload carries, so a row
 * dragged onto a map names its folder rather than carrying a copy of it.
 */
export interface ConnectedFolder {
  id: string
  /** What the reader calls it. Shown in the panel; never sent anywhere. */
  label: string
  kind: 'local' | 'bucket' | 'drive' | 'dropbox'
  /** Where a fresh browse starts. Not always `''` — a bucket scope has a prefix. */
  root: string
  /**
   * What to show for a path in the crumb trail, when the path is not a name.
   *
   * Absent for the disk and the bucket, whose paths *are* names. A Drive path is
   * a chain of folder ids, which nobody can read; the backend that listed the
   * folder knows what each id was called and answers here. `path` is one of the
   * folder paths a previous listing handed back.
   */
  labelOf?(path: string): string
  /**
   * `false` for a folder that will be gone after a reload.
   *
   * True of the fallback local backend and of nothing else, and the panel says
   * so on the row: a reader who connected a directory in Firefox has a snapshot
   * of it, and finding that out at the next reload is finding it out too late.
   */
  durable: boolean
  /** One level. `path` is `root` or something a previous listing handed back. */
  list(path: string): Promise<FolderListing>
  /**
   * How to open one file. Rejects where a local file has been moved or deleted
   * since the folder was connected, which is a real state and not a rare one.
   */
  pick(entry: FolderEntry): Promise<PickedFile>
}

/**
 * How many entries one level may draw.
 *
 * S3's own page is a thousand and a local folder had no limit at all, which is
 * the wrong kind of asymmetry to leave in: a `fastq/` directory with forty
 * thousand files in it would build forty thousand rows and hang the window on a
 * gesture the reader cannot undo. The same number for both, so the note under
 * the list says one thing.
 */
export const LISTING_CAP = 1000

/**
 * Split a path into the segments a crumb trail is built from.
 *
 * Shared so both backends' crumbs behave identically — and rooted at `root`
 * rather than at the true top, because a bucket key may well not be allowed to
 * list above the prefix it was given, so a crumb leading there is a click that
 * 403s.
 */
export function crumbsOf(root: string, path: string): string[] {
  const rest = path.startsWith(root) ? path.slice(root.length) : path
  return rest.split('/').filter((part) => part !== '')
}

/** Folders before files, each run sorted by name — the order every list uses. */
export function ordered(entries: readonly FolderEntry[]): FolderEntry[] {
  const folders = entries.filter((entry) => entry.kind === 'folder')
  const files = entries.filter((entry) => entry.kind === 'file')
  const byName = (a: FolderEntry, b: FolderEntry): number =>
    a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' })
  return [...folders.sort(byName), ...files.sort(byName)]
}
