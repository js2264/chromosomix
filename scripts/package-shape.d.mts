/**
 * Types for `package-shape.mjs`, which is plain JavaScript for the reason
 * `pinned-shape.mjs` is: it is imported by a build script and by a test, and a
 * build script that needs compiling before the build can run is a
 * bootstrapping problem nobody needs.
 */

/** One built file, as the walk reports it. */
export interface BuiltFile {
  /** Path relative to the build root, `/`-separated. */
  name: string
  size: number
}

/** What the published `dist/` may weigh, in bytes. */
export declare const SIZE_LIMIT: number

/** Problems with the set of built files and their total size; empty when fine. */
export declare function packageFileProblems(files: Iterable<BuiltFile>): string[]

/**
 * Problems with the built `index.html`.
 *
 * No base argument, and that absence is the rule: this build has no base to be
 * checked against, only the requirement that it named none.
 */
export declare function packageIndexProblems(html: string): string[]
