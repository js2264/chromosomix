/**
 * What this build is, and where it came from.
 *
 * A deployed page is a static bundle behind a CDN, so "which version am I
 * looking at" cannot be answered by asking a server — the answer has to be
 * *in* the bundle. Three facts are baked in at build time by `vite.config.ts`
 * (see the `define` block there) and shown in the about dialog:
 *
 * - the **version**, from `package.json`, which is the one place it is written;
 * - the **commit** it was built from, which is what turns a bug report about
 *   "the website" into a diff;
 * - the **date of that commit**, not of the build. A build timestamp changes on
 *   every rebuild of identical source, which makes two bundles look different
 *   when they are the same; the commit date is a property of the code.
 *
 * Every one is optional at runtime. `vitest` does not apply the app's `define`
 * block, and a build from a source tarball has no git repository to ask — both
 * land on the fallbacks rather than failing, because a missing build stamp is
 * not a reason for a viewer to refuse to start. `typeof` on an undeclared name
 * is legal JavaScript and does not throw, which is what makes the guards work
 * when the token was never substituted.
 */

declare const __APP_VERSION__: string
declare const __APP_COMMIT__: string
declare const __APP_COMMIT_DATE__: string

/** The `package.json` version this bundle was built from. */
export const VERSION: string = typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : '0.0.0-dev'

/** Short commit hash, or `''` when the build had no git repository. */
export const COMMIT: string = typeof __APP_COMMIT__ === 'string' ? __APP_COMMIT__ : ''

/** `YYYY-MM-DD` of that commit, or `''`. */
export const COMMIT_DATE: string =
  typeof __APP_COMMIT_DATE__ === 'string' ? __APP_COMMIT_DATE__ : ''

/**
 * `(meta)cooler 0.2.0` — the name and version, for anywhere a figure or a file
 * has to say what produced it.
 */
export const PRODUCER = `(meta)cooler ${VERSION}`

/**
 * The full build line: `0.2.0 · a1b2c3d · 2026-08-03`.
 *
 * Composed rather than templated, so a build with no git behind it reads
 * `0.2.0` and not `0.2.0 ·  · ` — the parts that are unknown are absent, not
 * empty.
 */
export function buildLine(): string {
  return [VERSION, COMMIT, COMMIT_DATE].filter((part) => part !== '').join(' · ')
}
