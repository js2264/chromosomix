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

/** The site's pages that `index` (an `llms.txt`) links, as paths under the site's root, in order. */
export declare function linkedPages(index: string): string[]

/** The whole of `llms-full.txt`: the README, then each page `index` links, read by `read(path)`. */
export declare function llmsFullText(
  readme: string,
  index: string,
  read: (path: string) => string,
  repository: string,
): string

/** Whether a path under the site's root is one of the files for language models. */
export declare function isAgentPath(path: string): boolean

/** Every file by its path: what the app renders through `load`, then `llms-full.txt`. */
export declare function agentFiles(load: (id: string) => Promise<Record<string, any>>): Promise<Map<string, string>>

/** The files, rendered through a Vite server made for it and closed after. */
export declare function buildAgentFiles(): Promise<Map<string, string>>

/** The plugin, for the site build and its dev server. */
export declare function llms(): Plugin
