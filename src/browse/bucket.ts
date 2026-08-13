/**
 * A bucket prefix, as a folder.
 *
 * Thin on purpose. `s3/list.ts` already answers the question a folder view asks —
 * one `ListObjectsV2` with a delimiter gives the immediate sub-prefixes and the
 * keys directly under a prefix — so this is a rename of its answer into the
 * shape `browse/folder.ts` describes, and nothing more. The listing, the
 * signing, the entity decoding, the URL construction and every error message
 * stay where they were.
 *
 * **Including the URL construction**, which is why a file entry's `path` is the
 * object's URL rather than its key. Rebuilding it here would mean a second copy
 * of the virtual-hosted-versus-path-style test and of the per-segment encoding,
 * in a module with no listing in front of it to check them against — and the way
 * that goes wrong is a row that looks right and 404s. The listing computed it;
 * this carries it.
 *
 * The one decision made here is what a *pick* carries with it. A file listed
 * under a scope is opened with **that scope's credential**, attached at the pick
 * rather than left to the lookup at the worker boundary. The lookup would
 * resolve the same key — the URL is under this scope's prefix by construction —
 * but a file reached through a key should be opened with the key that found it,
 * which is the rule `s3/attach.ts` and `ui/bucketBrowse.ts` both state from
 * their own side. A public scope has none, and then the field is left off
 * entirely, which is what every unsigned open in the app already sends.
 */

import { addressOf, credentialOf, type BucketScope } from '../s3/credentials'
import { listPrefix } from '../s3/list'
import {
  LISTING_CAP,
  ordered,
  type ConnectedFolder,
  type FolderEntry,
  type FolderListing,
  type PickedFile,
} from './folder'

/**
 * The folder a stored scope describes.
 *
 * Built fresh from the scope rather than held, because the scope is what
 * `localStorage` holds: a key edited in the buckets dialog takes effect without
 * anything having to be told, since the panel rebuilds this list from
 * `readScopes()` whenever it repaints.
 */
export function bucketFolder(scope: BucketScope): ConnectedFolder {
  return {
    id: bucketFolderId(scope.id),
    label: scope.label,
    kind: 'bucket',
    root: addressOf(scope.base)?.prefix ?? '',
    // A bucket entry is a line in `localStorage`; nothing about it is lost to a
    // reload, which is the half of "connected" a local folder has to work for.
    durable: true,

    async list(path: string): Promise<FolderListing> {
      const listing = await listPrefix(scope, path)
      const entries: FolderEntry[] = [
        ...listing.folders.map((folder) => ({
          kind: 'folder' as const,
          name: folder.name,
          path: folder.prefix,
          size: null,
        })),
        ...listing.objects.map((object) => ({
          kind: 'file' as const,
          name: object.name,
          path: object.url,
          size: object.size,
        })),
      ]
      // S3 returns folders and files as two lists in lexicographic order and
      // `ordered` preserves that; running it here is what makes a local folder
      // agree with a bucket, and it costs nothing on an already-sorted list.
      return { entries: ordered(entries).slice(0, LISTING_CAP), truncated: listing.truncated }
    },

    async pick(entry: FolderEntry): Promise<PickedFile> {
      const credential = credentialOf(scope)
      return {
        uri: entry.path,
        source: {
          kind: 'remote',
          url: entry.path,
          ...(credential === null ? {} : { credential }),
        },
      }
    },
  }
}

/**
 * The folder id a scope id becomes.
 *
 * Prefixed, because the two kinds of folder share one id space — a drag payload
 * and a stored "last folder" carry one string — and a local directory keyed by a
 * number could otherwise collide with a bucket keyed by one.
 */
export function bucketFolderId(scopeId: string): string {
  return `bucket:${scopeId}`
}
