/**
 * Types for `versions-manifest.mjs`, which is plain JavaScript for the reason
 * `sw-manifest.mjs` is: it is run by the deploy job and imported by a test, and
 * a build script that needs compiling before the build can run is a
 * bootstrapping problem nobody needs.
 */

/** One published build, as the manifest records it. */
export interface ManifestEntry {
  /** Short commit hash, and the directory the build is published under. */
  commit: string
  /** The `package.json` version that commit carried. */
  version: string
  /** The commit's own timestamp, ISO 8601. */
  date: string
  /** The commit subject, one line. */
  subject: string
  /** The tag on that commit, when there is one and it is safe to publish. */
  tag: string
}

/** The manifest as a whole, newest first. */
export interface Manifest {
  /** The commit the site root is serving. */
  latest: string
  versions: ManifestEntry[]
}

/** How many of the most recent builds stay addressable regardless of version. */
export declare const KEEP_RECENT: number

/** An empty manifest, which is what a first deploy starts from. */
export declare const EMPTY: Manifest

/** Whether a tag may be published as a directory beside the commits. */
export declare function isPublishableTag(tag: unknown): boolean

/** Read a manifest that may not exist, may be empty, or may have been edited. */
export declare function parseManifest(text: string): Manifest

/** The manifest after this build: the new one added, the retention rules applied. */
export declare function nextManifest(
  previous: Manifest,
  build: ManifestEntry,
  keepRecent?: number,
): Manifest

/** Which commits are in the old manifest and not the new one. */
export declare function droppedCommits(previous: Manifest, next: Manifest): string[]

/** Which tag aliases are in the old manifest and not the new one. */
export declare function droppedTags(previous: Manifest, next: Manifest): string[]

/** Every tag the manifest publishes, with the commit it points at. */
export declare function tagAliases(manifest: Manifest): Array<{ tag: string; commit: string }>
