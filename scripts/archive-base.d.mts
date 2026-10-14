/**
 * Types for `archive-base.mjs`, which is plain JavaScript for the reason
 * `pinned-shape.mjs` is: a workflow runs it with `node` before anything is
 * compiled, and a test imports it.
 */

/** The two kinds of copy the archive holds: archived pushes and previews. */
export declare const ARCHIVE_KINDS: readonly ['v', 'pr']

export type ArchiveKind = (typeof ARCHIVE_KINDS)[number]

/** Whether `name`, under `kind`, is a build rather than a release alias. */
export declare function isBuildDirectory(kind: ArchiveKind, name: string): boolean

/** Whether a built file is text a base could be baked into. */
export declare function isTextAsset(name: string): boolean

/** The site root a build was made for, from its `index.html`; `null` if unreadable. */
export declare function bakedSiteBase(html: string, kind: ArchiveKind, name: string): string | null

/** One file of a build, moved from one site root to another. */
export declare function rebaseText(
  text: string,
  move: { from: string; to: string; kind: ArchiveKind; name: string },
): string
