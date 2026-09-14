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
declare const __APP_HOMEPAGE__: string
declare const __APP_COMMIT__: string
declare const __APP_COMMIT_DATE__: string
declare const __APP_TARGET__: string

/** The `package.json` version this bundle was built from. */
export const VERSION: string = typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : '0.0.0-dev'

/** Short commit hash, or `''` when the build had no git repository. */
export const COMMIT: string = typeof __APP_COMMIT__ === 'string' ? __APP_COMMIT__ : ''

/**
 * The deployed site, absolute, from `package.json`'s `homepage` — or `''`.
 *
 * What a build with no site of its own reaches for when it needs one: the
 * desktop and a standalone file read the generated stores from here
 * (`ui/examples.ts`), having no origin of their own to publish beside. Empty
 * in the test runtime, which defines nothing, and the code that reads it
 * treats empty as "no site".
 */
export const HOMEPAGE: string = typeof __APP_HOMEPAGE__ === 'string' ? __APP_HOMEPAGE__ : ''

/** `YYYY-MM-DD` of that commit, or `''`. */
export const COMMIT_DATE: string =
  typeof __APP_COMMIT_DATE__ === 'string' ? __APP_COMMIT_DATE__ : ''

/**
 * Which of the two builds this is.
 *
 * The one place the flag lives. Every other module asks this rather than
 * reading the token itself, because a guard is only as good as the number of
 * copies of it — and the token is substituted by a `define`, so a second copy
 * that is spelt slightly differently silently reads `undefined` and takes the
 * web path in the desktop build.
 *
 * Anything other than the exact string `desktop` is the web target, including
 * the case the guards above exist for: `vitest` applies no `define` block, so
 * the name is never substituted and `typeof` on an undeclared identifier is the
 * only legal way to ask about it.
 */
export const TARGET: 'web' | 'desktop' | 'standalone' =
  typeof __APP_TARGET__ === 'string' && (__APP_TARGET__ === 'desktop' || __APP_TARGET__ === 'standalone')
    ? __APP_TARGET__
    : 'web'

/**
 * The single-file build, opened from a disk rather than served.
 *
 * Its origin is opaque, so **every remote read fails** — not slowly, not
 * partially, but with a `NetworkError` before a byte moves. Three surfaces have
 * to know: the picker, which must not offer a URL box that cannot work; the
 * demo catalogue, which is on a bucket; and the service worker, which cannot be
 * registered at all. §8.5's doctrine applies to all three — a control that
 * cannot keep its promise is **absent**, not disabled, because a disabled one
 * spends the reader's attention on discovering why.
 */
export const IS_STANDALONE = TARGET === 'standalone'

/**
 * `(meta)cooler 0.2.0`, or `(meta)cooler 0.2.0 desktop` — the name and version,
 * for anywhere a figure or a file has to say what produced it.
 *
 * The target is part of the answer because this string ends up in every
 * exported PDF's `/Producer` field, and "which build made this figure" is the
 * first question asked when one came out wrong.
 */
export const PRODUCER = `(meta)cooler ${VERSION}${TARGET === 'web' ? '' : ` ${TARGET}`}`

/**
 * The full build line: `0.2.0 · a1b2c3d · 2026-08-03`, with `· desktop` when
 * that is what is running.
 *
 * Composed rather than templated, so a build with no git behind it reads
 * `0.2.0` and not `0.2.0 ·  · ` — the parts that are unknown are absent, not
 * empty. The target joins on the same terms: the web build is the default and
 * says nothing, which keeps the line on the website exactly what it was.
 */
export function buildLine(): string {
  return [VERSION, COMMIT, COMMIT_DATE, TARGET === 'web' ? '' : TARGET]
    .filter((part) => part !== '')
    .join(' · ')
}
