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

/** One pull request's preview, as the manifest records it. */
export interface PullEntry {
  /** The pull request number, and the directory under `pr/` the preview is published in. */
  number: number
  /** Short hash of the pull request's head when the preview was built. */
  commit: string
  /** The pull request's title, bounded, for the menu. */
  title: string
  /** The branch the pull request comes from, bounded, for the tooltip. */
  branch: string
  /** The head commit's own timestamp, ISO 8601. */
  date: string
}

/** The manifest as a whole, newest first. */
export interface Manifest {
  /** The commit the site root is serving. */
  latest: string
  versions: ManifestEntry[]
  /** The open pull requests with a preview, newest number first. */
  pulls: PullEntry[]
}

/**
 * A manifest as it is handed *in*. `pulls` is optional here because a manifest
 * written before previews existed has none, and every function below treats a
 * missing list as an empty one; what comes *out* is always a {@link Manifest}.
 */
export type ManifestInput = Omit<Manifest, 'pulls'> & { pulls?: PullEntry[] }

/**
 * What {@link withPull} is handed. The number and the commit are what the row
 * is checked on; the text is carried as text, bounded, and defaults to empty.
 */
export type PullInput = Pick<PullEntry, 'number' | 'commit'> &
  Partial<Pick<PullEntry, 'title' | 'branch' | 'date'>>

/** How many of the most recent builds stay addressable regardless of version. */
export declare const KEEP_RECENT: number

/** The path segment pull-request previews are published under, beside `v/`. */
export declare const PULL_SEGMENT: 'pr'

/** An empty manifest, which is what a first deploy starts from. */
export declare const EMPTY: Manifest

/** Whether a tag may be published as a directory beside the commits. */
export declare function isPublishableTag(tag: unknown): boolean

/** Read a manifest that may not exist, may be empty, or may have been edited. */
export declare function parseManifest(text: string): Manifest

/** The manifest after this build: the new one added, the retention rules applied. */
export declare function nextManifest(
  previous: ManifestInput,
  build: ManifestEntry,
  keepRecent?: number,
): Manifest

/** Which commits are in the old manifest and not the new one. */
export declare function droppedCommits(previous: ManifestInput, next: ManifestInput): string[]

/** Which tag aliases are in the old manifest and not the new one. */
export declare function droppedTags(previous: ManifestInput, next: ManifestInput): string[]

/** Every tag the manifest publishes, with the commit it points at. */
export declare function tagAliases(manifest: ManifestInput): Array<{ tag: string; commit: string }>

/** The manifest with one pull request's preview in it — added, or replaced. Throws on a row that cannot name a directory. */
export declare function withPull(previous: ManifestInput, entry: PullInput): Manifest

/** The manifest without one pull request's preview — what closing it does. */
export declare function withoutPull(previous: ManifestInput, number: number): Manifest

/** The directory a preview is published in, relative to the site root: `pr/<number>`. */
export declare function pullDirectory(number: number): string
