/**
 * The one module in `src/` that knows the desktop bridge exists.
 *
 * Everything else asks this. That is the same argument `version.ts` makes about
 * the target flag, for the same reason: a second module reaching into
 * `window.chromosomixDesktop` is a second place to get the guard wrong, and the
 * wrong guard here throws a `TypeError` on a property of `undefined` in the web
 * build, where the object never exists at all.
 *
 * **Two questions, kept apart on purpose.** `IS_DESKTOP` asks which build this
 * is; `desktop()` asks whether the bridge actually arrived. They are usually
 * the same answer and must not be assumed to be: a packaged build whose preload
 * failed to load is a real state, and in it the app should behave like the
 * browser version — no menu dispatch, no platform line in the about dialog —
 * rather than fail to start. Conflating them turns a missing menu into a blank
 * window.
 *
 * The types are declared here rather than imported from `electron/contract.cts`
 * because this file is in the bundle that the **web** build also ships, and
 * that build must not carry a module compiled for Node. Ten identifiers
 * duplicated structurally, against a `.cts` file that says so at the top of it.
 */

import { TARGET } from './version'

/** What the preload reports about the machine. Mirrors `DesktopPlatform`. */
export interface DesktopPlatform {
  electron: string
  chrome: string
  node: string
  platform: string
  arch: string
  signed: boolean
}

/** The whole bridge. Two members; see `electron/preload.cts`. */
export interface DesktopBridge {
  platform: DesktopPlatform
  onCommand(handler: (id: string) => void): void
}

declare global {
  interface Window {
    chromosomixDesktop?: DesktopBridge
  }
}

/** `true` in the packaged build, whether or not the bridge loaded. */
export const IS_DESKTOP: boolean = TARGET === 'desktop'

/**
 * The bridge, or `null` when there is none to use.
 *
 * Checked structurally rather than by truthiness: the failure this guards
 * against is a preload that ran partially, or a future version that renames a
 * member, and in both cases the object exists while the function does not. A
 * `!== undefined` test would pass and the call would throw.
 */
export function desktop(): DesktopBridge | null {
  const bridge = typeof window === 'undefined' ? undefined : window.chromosomixDesktop
  if (bridge === undefined) return null
  if (typeof bridge.onCommand !== 'function') return null
  return bridge
}
