/**
 * Types for `shell-icon.mjs`, which is plain JavaScript for the same reason
 * `pwa-tags.mjs` is: it is imported by two Vite configs, and a build helper that
 * needs compiling before the build can run is a bootstrapping problem nobody
 * needs.
 */

import type { Plugin } from 'vite'

/**
 * The mark, emitted beside a build whose `publicDir` is off.
 *
 * @param name Plugin name, so the two configs that use it are distinguishable
 *   in a build log.
 */
export declare function shellIcon(name: string): Plugin
