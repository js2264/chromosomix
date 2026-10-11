/**
 * Types for `csp.mjs`, which is plain JavaScript for the reason `pwa-tags.mjs`
 * is: three Vite configs, three shape checks and a test import it, and a build
 * input that needed compiling before the build could run would be a
 * bootstrapping problem nobody needs.
 */

import type { Plugin } from 'vite'

/** The web builds' policy, one directive per entry. */
export declare const WEB_CSP_DIRECTIVES: readonly string[]

/** The web builds' policy, as their `index.html` carries it. */
export declare const WEB_CSP: string

/** The `<meta http-equiv="Content-Security-Policy">` tag for a policy. */
export declare function cspMetaTag(policy: string): string

/** The page with the policy right after its `<meta charset>`; throws if it cannot be placed. */
export declare function withCsp(html: string, policy: string): string

/** Every policy a page carries in a meta, in document order. */
export declare function cspOf(html: string): string[]

/** A page's inline script bodies (no `src`) and stylesheet bodies, in document order. */
export declare function inlineElements(html: string): { scripts: string[]; styles: string[] }

/** The `'sha256-…'` source for an inline element's text, as the HTML parser hands it over. */
export declare function hashSource(body: string): string

/** The single file's policy, naming the hash of every inline script and stylesheet it holds. */
export declare function standaloneCsp(html: string): string

/** The single file, with {@link standaloneCsp} written into it. */
export declare function withStandaloneCsp(html: string): string

/** Problems with a web build's page and its policy; empty when there are none. */
export declare function webCspProblems(html: string): string[]

/** Problems with the single file's policy; empty when it names exactly its own elements. */
export declare function standaloneCspProblems(html: string): string[]

/** The web builds' policy as a Vite plugin: written at build time, then checked in the emitted page. */
export declare function cspMeta(): Plugin
