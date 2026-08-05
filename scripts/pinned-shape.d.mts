/**
 * Types for `pinned-shape.mjs`, which is plain JavaScript for the reason
 * `desktop-shape.mjs` is: it is imported by a build script and by a test, and a
 * build script that needs compiling before the build can run is a
 * bootstrapping problem nobody needs.
 */

/** One built file, as the walk reports it. */
export interface BuiltFile {
  /** Path relative to the build root, `/`-separated. */
  name: string
  size: number
}

/** What one archived build may weigh, in bytes. */
export declare const SIZE_LIMIT: number

/** Problems with the set of built files and their total size; empty when fine. */
export declare function pinnedFileProblems(files: Iterable<BuiltFile>): string[]

/** Problems with the built `index.html`, given the base it was built for. */
export declare function pinnedIndexProblems(html: string, base: string): string[]
