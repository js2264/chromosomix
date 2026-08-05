/**
 * Types for `pwa-tags.mjs`, which is plain JavaScript for the same reason
 * `sw-manifest.mjs` is: it is imported by two Vite configs and by a test, and a
 * build helper that needs compiling before the build can run is a
 * bootstrapping problem nobody needs.
 */

import type { Plugin } from 'vite'

/** The substitution, as a string function, so a test can run it. */
export declare function stripPwaTagsFrom(html: string): string

/** The same thing as a Vite plugin, which is how both configs use it. */
export declare function stripPwaTags(): Plugin
