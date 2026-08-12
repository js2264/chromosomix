/**
 * Types for `standalone-shape.mjs`, which is plain JavaScript for the reason
 * `pinned-shape.mjs` is: it is imported by a build config and by a test, and a
 * build input that needs compiling before the build can run is a bootstrapping
 * problem nobody needs.
 */

/** One built file, as the walk reports it. */
export interface StandaloneFile {
  /** Path relative to the build root, `/`-separated. */
  path: string
  size: number
}

/** What the one file may weigh, in bytes. */
export declare const STANDALONE_MAX_BYTES: number
/** What it must weigh at least, below which the inlining did not happen. */
export declare const STANDALONE_MIN_BYTES: number

/** Problems with the built HTML; empty when it is genuinely self-contained. */
export declare function standaloneIndexProblems(html: string): string[]

/** Problems with the set of emitted files; empty when there is exactly one. */
export declare function standaloneFileProblems(files: readonly StandaloneFile[]): string[]
