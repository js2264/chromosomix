/**
 * The three members of Google Identity Services this application uses.
 *
 * A hand-written declaration rather than `@types/google.accounts`, for the
 * reason every other absent dependency in this repository has: the surface used
 * is `initTokenClient`, the response it hands back and `revoke`, and a package
 * would bring several hundred lines describing the sign-in button, the One Tap
 * prompt, the credential flow and the FedCM shims — none of which this app has
 * any road to, and all of which would have to be kept in step with a library
 * that is loaded at runtime from Google rather than bundled.
 *
 * Declared **global and optional-shaped** because that is what it is at
 * runtime. The script is fetched on the reader's click and not before (SPECS
 * §23.7, §11), so for the whole life of a session that never signs in the name
 * `google` is simply not bound — which is legal to *ask about* with `typeof` and
 * a `ReferenceError` to read. `auth/google.ts` is the only file that touches it
 * and it asks first; this file exists so that asking is type-checked rather than
 * cast through `any`.
 *
 * The token client is the **implicit** flow — an access token straight to the
 * page, no code exchange, no client secret, nothing for a server to hold —
 * which is the only OAuth shape a backendless app has (C1). Its cost is stated
 * where the reader can see it: the token is short-lived, it is held in memory,
 * and it is gone when the tab is.
 */

declare global {
  namespace google.accounts.oauth2 {
    /**
     * What the callback is handed, and every field is optional on purpose.
     *
     * This object arrives from a script this page did not build, through a
     * callback with no error channel of its own: a refusal at the consent screen
     * comes back *here*, as an `error` beside an absent `access_token`. Typing
     * the token as required would make the one case the caller must handle the
     * one the compiler says cannot happen.
     */
    interface TokenResponse {
      access_token?: string
      /** Seconds, as a string in some Google responses and a number in others. */
      expires_in?: number | string
      /** The scopes actually granted, which may be fewer than those asked for. */
      scope?: string
      token_type?: string
      error?: string
      error_description?: string
    }

    interface TokenClientConfig {
      client_id: string
      /** Space-separated, as Google spells it. */
      scope: string
      callback(response: TokenResponse): void
      /** Popup closed, popup blocked, or the library failing to start. */
      error_callback?(error: { type?: string; message?: string }): void
      prompt?: string
    }

    interface TokenClient {
      requestAccessToken(overrides?: { prompt?: string }): void
    }

    function initTokenClient(config: TokenClientConfig): TokenClient

    /** Tell Google to forget the grant. Best effort; the callback is optional. */
    function revoke(token: string, done?: () => void): void
  }
}

export {}
