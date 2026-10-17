/**
 * Types for `llms.mjs`, which is plain JavaScript for the reason `csp.mjs` is:
 * a Vite config and a test import it, and a build input that needed compiling
 * before the build could run would be a bootstrapping problem nobody needs.
 */

import type { Plugin } from 'vite'

/** The repository's address from a `package.json`: `git+…` and `….git` unwound. */
export declare function repositoryUrl(manifest: { repository?: string | { url?: string } }): string

/** `markdown` with every repository-relative link and image made absolute. */
export declare function absoluteLinks(markdown: string, repository: string, ref?: string): string

/** The plugin: `llms-full.txt` from the README, for the site build. */
export declare function llmsFull(): Plugin
