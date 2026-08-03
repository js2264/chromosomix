/**
 * Types for `sw-manifest.mjs`, which is plain JavaScript because it is imported
 * by both the Vite config and a test, and a build script that needs compiling
 * before the build can run is a bootstrapping problem nobody needs.
 */

/** Files from `public/` that belong to the app rather than to the data. */
export declare const SHELL_PUBLIC_FILES: string[]

/** `true` when a built file is part of the app rather than data it reads. */
export declare function isShellAsset(fileName: string): boolean

/** The precache list, as URLs, under Vite's base path. */
export declare function precacheUrls(fileNames: Iterable<string>, base?: string): string[]
