/**
 * The credentials the site's owner ships with the build, for every reader.
 *
 * Three values, and none of them is a secret: a Google OAuth client id, which
 * every site using Google's sign-in serves in its own page; a Google API key,
 * which is restricted to this site's address and to the Drive API in the Cloud
 * console; and a Dropbox app key, which names an app and authorises nothing on
 * its own. What they are is *the site's registration* with each service, and a
 * reader who opens the published site should meet a *sign in* button, not a
 * box asking for a value only the site's owner has (§24.7).
 *
 * They arrive as build-time defines (`vite.config.ts`), read from the
 * `GOOGLE_CLIENT_ID`, `GOOGLE_API_KEY` and `DROPBOX_APP_KEY` environment
 * variables — the deploy passes the repository's Actions variables of those
 * names — and a build without them is exactly the build there was before: each
 * box in the dialog empty, each value pasted by hand. A value a reader pastes
 * always wins over the site's, because a reader signing in to their own lab's
 * project is the case the boxes existed for.
 *
 * `typeof` guards rather than bare reads, so the module also loads where no
 * define was made — the test runner, a build from a tree that predates them.
 */

declare const __GOOGLE_CLIENT_ID__: string
declare const __GOOGLE_API_KEY__: string
declare const __DROPBOX_APP_KEY__: string

export interface SiteDefaults {
  /** `….apps.googleusercontent.com`, registered against this site's origin. */
  googleClientId: string | null
  /** `AIza…`, restricted to this site and to the Drive API. */
  googleApiKey: string | null
  /** The Dropbox app's key, which works from any origin. */
  dropboxAppKey: string | null
}

function defined(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const text = value.trim()
  return text === '' ? null : text
}

export const SITE_DEFAULTS: SiteDefaults = {
  googleClientId: defined(typeof __GOOGLE_CLIENT_ID__ === 'string' ? __GOOGLE_CLIENT_ID__ : ''),
  googleApiKey: defined(typeof __GOOGLE_API_KEY__ === 'string' ? __GOOGLE_API_KEY__ : ''),
  dropboxAppKey: defined(typeof __DROPBOX_APP_KEY__ === 'string' ? __DROPBOX_APP_KEY__ : ''),
}
