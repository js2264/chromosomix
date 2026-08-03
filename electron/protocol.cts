/**
 * The scheme the renderer is served from, and everything that decides what a
 * request on it is answered with.
 *
 * Kept apart from `main.cts` because the interesting part of it is pure: given
 * a root and a URL path, which file — if any — may be read. That question has a
 * wrong answer that is a directory traversal out of the packaged application,
 * and a pure function is something a reader can check by reading.
 */

import { extname, join, normalize, relative, isAbsolute } from 'node:path'

/**
 * The scheme name, and the one origin the app ever has.
 *
 * **This string is frozen.** Chromium keys everything origin-scoped on it, and
 * in this app that is at least five things a user would notice losing: the
 * theme, the per-file table state (filters, search, sort), the remembered view
 * memory, the hash router's history entries, and the `Origin` header remote
 * hosts see. Rename it in a later release and every one of those disappears on
 * upgrade — silently, with no error and no way back, because the old origin's
 * storage is simply a different bucket that nothing reads any more.
 *
 * `viewer` is the host part and matters as much as the scheme: `app://viewer`
 * and `app://viewer2` are different origins.
 */
export const APP_SCHEME = 'app'
export const APP_ORIGIN = 'app://viewer'
export const APP_INDEX = 'app://viewer/index.html'

/**
 * The Content-Security-Policy, delivered as a **response header**.
 *
 * A `<meta http-equiv>` tag is not equivalent and cannot be substituted: it does
 * not reach a module worker at all — so the reader worker would run unpoliced
 * while the document looked protected — and it cannot express `frame-ancestors`
 * in any form.
 *
 * Two clauses are load-bearing and were verified in both directions:
 *
 * - **`'wasm-unsafe-eval'` in `script-src`.** Without it h5wasm fails to
 *   instantiate in the document *and* in the worker, with a `CompileError`
 *   raised a long way from `index.html`. The shell renders perfectly and every
 *   file open fails.
 * - **`data:` in `img-src`**, for `index.html`'s data-URI favicon.
 *
 * `style-src 'self'` without `'unsafe-inline'` is correct here and is a
 * property of the code rather than a hope: there is no `innerHTML`, no `<style>`
 * element creation and no `style=` attribute anywhere in `src/` — `el()` assigns
 * through the CSSOM, which CSP does not govern. Adding any of the three later
 * means this line has to change, and the symptom will be unstyled elements.
 *
 * `connect-src` keeps `https:` because remote files are the whole remote half of
 * the app, and localhost so that a file served from a local dev server or a
 * local object store can be opened — which is a normal thing to want and is not
 * reachable over `https:`.
 */
export const CSP = [
  "default-src 'none'",
  "script-src 'self' 'wasm-unsafe-eval'",
  "style-src 'self'",
  "img-src 'self' data: blob:",
  "font-src 'self'",
  "connect-src 'self' https: http://localhost:* http://127.0.0.1:*",
  "worker-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
  "manifest-src 'none'",
].join('; ')

/**
 * Content types for what a renderer build actually contains.
 *
 * Short on purpose. This handler serves one directory whose contents are
 * produced by our own bundler and asserted by `check-desktop-build.mjs`; a
 * general-purpose MIME table would be answering questions that cannot be asked.
 *
 * `.mjs` is present because the extension is one bundler setting away, and a
 * module served as `application/octet-stream` is refused by the module loader
 * with a message about a MIME type rather than about a missing file.
 */
export const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.wasm': 'application/wasm',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
}

/** The content type for a file name, defaulting to bytes with no claim. */
export function contentType(fileName: string): string {
  return TYPES[extname(fileName).toLowerCase()] ?? 'application/octet-stream'
}

/**
 * Resolve a URL pathname to a file inside `root`, or `null` if it escapes.
 *
 * The one security-relevant decision in the protocol handler, which is why it
 * is a pure exported function rather than three lines inline. A handler that
 * joins a pathname onto a directory and reads it will serve `/../../../etc/passwd`
 * — and in a packaged app, anything else on the user's disk — to any page that
 * can make a request, including one navigated to by a dropped file.
 *
 * The check is `relative()` rather than `startsWith()`: a prefix test says
 * `/app/renderer-evil` is inside `/app/renderer`, and on Windows it also has to
 * be right about case and separators. `relative()` answers the question that is
 * actually being asked, and three results are rejected — `''` (the root itself,
 * which is a directory and not a file), anything beginning `..` (outside), and
 * anything absolute (a different drive on Windows, where `relative()` cannot
 * express the relationship at all).
 *
 * `decodeURIComponent` is inside the try because a malformed `%` sequence throws
 * `URIError`, and an unhandled throw in a protocol handler is a renderer that
 * never receives a response — a window that hangs with nothing on the console.
 */
export function resolveInside(root: string, pathname: string): string | null {
  let decoded: string
  try {
    decoded = decodeURIComponent(pathname)
  } catch {
    return null
  }
  // A NUL truncates the path at the filesystem layer, so `a.js\0../../etc` can
  // pass a check performed on the whole string and read something else.
  if (decoded.includes('\0')) return null

  const candidate = normalize(join(root, decoded))
  const rel = relative(root, candidate)
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) return null
  return candidate
}
