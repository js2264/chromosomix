/**
 * Types for `docs-versions.mjs`, which is plain JavaScript for the reason
 * `versions-manifest.mjs` is: a workflow runs it and a test imports it.
 */

/** One release's copy of the documentation. */
export interface DocsRelease {
  /** The tag, `v0.20.0`, which is also its directory. */
  version: string
  /** Where it is served: `/v0.20.0/`. */
  path: string
  /** The commit it was built from, short; empty where unknown. */
  commit: string
  /** The commit's date, ISO 8601; empty where unknown. */
  date: string
}

/** The site's manifest, `/versions.json`. */
export interface DocsManifest {
  schema: number
  /** The highest release with a copy, which the root serves; `null` before the first. */
  latest: string | null
  /** Every release's copy, newest version first. */
  releases: DocsRelease[]
  /** Main's copy, at `/dev/`; `null` until it is first published. */
  dev: { path: string; commit: string; date: string } | null
}

export declare const SCHEMA: number
export declare const DEV: string
export declare const SITE_FILES: readonly string[]
export declare const DOMAIN: string
export declare const EMPTY: Readonly<DocsManifest>

export declare function isRelease(version: unknown): boolean
export declare function newerFirst(a: string, b: string): number
export declare function isCopyDirectory(name: string): boolean
export declare function rootCopyEntries(names: readonly string[]): string[]
export declare function collisions(names: readonly string[]): string[]
export declare function parseManifest(source: string): DocsManifest
export declare function withRelease(manifest: DocsManifest, release: { version: string; commit?: string; date?: string }): DocsManifest
export declare function withDev(manifest: DocsManifest, dev: { commit?: string; date?: string }): DocsManifest
export declare function serialise(manifest: DocsManifest): string
export declare function robotsTxt(): string
export declare function rootBeforeFirstRelease(): string
