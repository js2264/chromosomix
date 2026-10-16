/**
 * Whether this is the installed app — the desktop build, or the site installed
 * as an app — rather than the website in a browser tab (§20.6).
 *
 * One question, asked in one place, because what hangs on it is a privacy
 * decision rather than a convenience: a folder connected in the installed app
 * is kept across restarts and written into the workspaces it exports, so that
 * a session reopened tomorrow finds its files where they were; a folder
 * connected in a tab lasts the visit. An app the reader installed on their own
 * machine is a place they have chosen to keep things. A tab is a page — on a
 * shared machine, in somebody else's browser, opened from a link — and a page
 * that quietly kept a grant to a directory of unpublished data would be keeping
 * it for whoever opens the page next.
 *
 * **The desktop build** is installed by construction (`TARGET`), and so is
 * **the single-file build** (§19): a file the reader saved to their own disk
 * and opens from there, which is no more anybody else's page than the desktop
 * app is. **The site**
 * is installed when the browser opened it as an app: one of the display modes
 * an app window has and a tab does not — `standalone`, `minimal-ui`,
 * `window-controls-overlay` — or Safari's own flag for a home-screen app. Not
 * `fullscreen`, which a tab answers too once the reader presses F11: a tab
 * gone full screen is still a tab.
 */

import { TARGET } from './version'

/** The display modes a browser opens an installed web app in; a tab's is `browser`. */
const APP_MODES = ['standalone', 'minimal-ui', 'window-controls-overlay'] as const

/** `true` in the desktop and single-file builds, and in the site installed as an app. */
export function installedApp(): boolean {
  if (TARGET === 'desktop' || TARGET === 'standalone') return true
  if (typeof window === 'undefined') return false
  const nav = window.navigator as Navigator & { standalone?: boolean }
  if (nav.standalone === true) return true
  const query = window.matchMedia
  if (typeof query !== 'function') return false
  return APP_MODES.some((mode) => {
    try {
      return query.call(window, `(display-mode: ${mode})`).matches
    } catch {
      return false
    }
  })
}
