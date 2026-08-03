/**
 * Types for `desktop-shape.mjs`, which is plain JavaScript for the same reason
 * `sw-manifest.mjs` is: it is imported by a build script and by a test, and a
 * build script that needs compiling before the build can run is a bootstrapping
 * problem nobody needs.
 */

/** Extensions that mark a file as data the viewer opens, not app it is made of. */
export declare const DATA_EXTENSIONS: string[]

/** `true` when a file name ends in a data extension, case-insensitively. */
export declare function isDataFile(name: string): boolean

/** Human-readable problems with the built `index.html`; empty when it is fine. */
export declare function indexHtmlProblems(html: string): string[]

/** Human-readable problems with an entry chunk's source; empty when it is fine. */
export declare function entryChunkProblems(source: string): string[]

/** Problems with the set of renderer file names, relative and `/`-separated. */
export declare function rendererFileProblems(names: Iterable<string>): string[]
