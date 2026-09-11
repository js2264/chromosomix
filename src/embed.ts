/**
 * How this page was mounted, and what that costs.
 *
 * The app is a window: a header, a tab strip, five columns and a status bar
 * around one view of one file. That is the right shape for the thing a reader
 * opens deliberately, and the wrong shape for the other way this application is
 * useful — **inside somebody else's page**, as the figure in a portal, in
 * supplementary material, in a lab's own site. There the window is furniture
 * around a picture nobody asked for, the tab strip offers tabs that have nowhere
 * to go, and the restore card offers a workspace belonging to whoever last used
 * that browser.
 *
 * So an embed says so, and this module is the one place that reads it:
 * `?embed=1` for the chrome-less mount, `?config=<url>` for the session to open
 * on arrival, `?hub=<url>` for the catalogue to land on (§23.2). Everything
 * downstream asks {@link mounting} rather than parsing the URL a second time.
 *
 * ## Why the query string and not the hash
 *
 * Every other piece of state this app carries is in the fragment (§5.5), so a
 * flag in the search string looks inconsistent until you watch one navigation:
 * the hash is **rewritten** on every view change (`App.writeHash`), so a flag
 * living there would be erased the first time the reader clicked a genome, and
 * the second paint would be the full window inside a 600-pixel box. The
 * fragment says *what is being looked at* and is replaced as that changes; these
 * three say *how this page was mounted*, which no navigation can change. That is
 * the same distinction `Session.edgeListUrl` draws for `?edges=`, which is a
 * fact about where a file is published rather than about the picture of it.
 *
 * It also means an embedder writes the whole thing once, in an `src=`, and gets
 * a URL whose meaning survives being reloaded, deep-linked and bookmarked.
 *
 * ## What an embed turns off, and why each one
 *
 * - **The window furniture** — header, tab strip, restore slot, status bar.
 *   Nothing in `App` needs them to exist; the columns are still built and a
 *   session still parents its cards into them, so no view has to know it is
 *   embedded (`app/App.ts`).
 * - **History entries.** `pushState` from a frame writes into the *joint*
 *   session history, so a reader's Back button would rewind the embed's pan and
 *   zoom rather than leaving the host page. The address bar is still kept in
 *   step — it is what "copy this link" and a reload are read out of — but every
 *   write replaces.
 * - **The remembered window.** `sessionStorage` and the durable workspace record
 *   are both about a window with tabs in it, and an embed is one view seeded by
 *   its URL. Left on, they would make a reload show whatever the reader last
 *   navigated to instead of the figure the page named, offer six of somebody
 *   else's tabs inside an article, and — since a third-party frame's storage is
 *   partitioned per embedding site — do all of it from a store the reader has no
 *   way to reach and clear.
 * - **The service worker and the version notice** (`main.ts`). An embed is not
 *   an app to install, and a bar offering "take the newest build" across the top
 *   of somebody's figure is chrome by another name.
 *
 * What stays is the view and everything the *view* owns: the breadcrumb, the
 * map's own controls, the deck, the analysis drawer, dropping a file, and every
 * keyboard shortcut. A host that wants the whole application simply does not
 * pass `embed=1`.
 */

import { canonicalUrl } from './sources/rewrite'

/** What the query string asks of this mount. */
export interface Mounting {
  /** Chrome-less: one view, and none of the window around it. */
  readonly embed: boolean
  /**
   * A published workspace to open on arrival, absolute, or `null`.
   *
   * The pointer form of a session, where `#session=` is the payload form. Both open
   * the same `.metacooler.json` through the same parser; the difference is who
   * holds it. A payload cannot be changed once an embed is published and grows
   * the URL by the size of the session; a pointer is a file on a bucket that can
   * be edited afterwards, has no length to worry about, and — because the names
   * inside it are resolved against its own URL (`state/SessionConfig.ts`) — is
   * self-contained enough to be copied to another bucket with its data.
   */
  readonly config: string | null
  /**
   * A hub to land on, absolute, or `null` (§23.2).
   *
   * The third parameter beside the two above, and the one that names a *shelf*
   * rather than a picture: `?config=` says "open this figure", `?hub=` says
   * "here is our catalogue, choose". A lab sends one link and colleagues land
   * on its own list of maps, with the offer to keep it.
   *
   * It is read here, beside the other two, for the reason this module exists:
   * how a page was mounted is a fact no navigation can change, so it lives in
   * the query string where `App.writeHash` cannot erase it.
   *
   * Resolved and scheme-checked exactly as `config` is, and for exactly the
   * same reason: this value is about to be handed to `fetch`.
   */
  readonly hub: string | null
}

/** The mount of a page that was not asked for anything in particular. */
const PLAIN: Mounting = { embed: false, config: null, hub: null }

/**
 * Read a query string as a mount.
 *
 * Pure, and takes its base, so the whole contract is testable without a
 * `location`. Forgiving in the way every other reader of an outside string in
 * this app is forgiving: a value it does not understand leaves the default
 * standing rather than refusing the page.
 *
 * `embed` is **on for a key that is present** — `?embed`, `?embed=1`,
 * `?embed=true` — and off for the three spellings of "no", because a hand-edited
 * `embed=0` should mean what it says rather than being a truthy string.
 *
 * `config` and `hub` are resolved against `base` so a self-hosted deployment
 * can write `?config=session.json` or `?hub=hub.json` beside its own files, and
 * both are kept only when they come out `http:` or `https:`. That check is not
 * ceremony: the value is a URL from outside that this app is about to `fetch`,
 * and the schemes that are not those two are the ones with no server on the
 * other end and a document of their own to hand back.
 */
export function readMounting(search: string, base: string): Mounting {
  let params: URLSearchParams
  try {
    params = new URLSearchParams(search)
  } catch {
    return PLAIN
  }
  const flag = params.get('embed')
  const embed = flag !== null && flag !== '0' && flag !== 'false' && flag !== 'off'

  return {
    embed,
    config: fetchable(params.get('config'), base),
    hub: fetchable(params.get('hub'), base),
  }
}

/**
 * A query parameter naming something this page may fetch, or `null`.
 *
 * One function for `config` and `hub` rather than the check written twice: they
 * are the same kind of value — an outside URL about to be handed to `fetch` —
 * and the schemes that are not `http(s)` are the ones with no server on the
 * other end and a document of their own to hand back.
 */
function fetchable(named: string | null, base: string): string | null {
  if (named === null || named === '') return null
  try {
    // Canonicalised first (§23.5), so `?hub=gs://…` and `?config=s3://…` are
    // the https URLs they stand for by the time the scheme is judged.
    const url = new URL(canonicalUrl(named), base)
    if (url.protocol === 'http:' || url.protocol === 'https:') return url.href
  } catch {
    /* not a URL this page can resolve; the picker is the honest answer */
  }
  return null
}

/** Memoised: the address does not change under a running page. */
let held: Mounting | null = null

/**
 * This page's mount.
 *
 * Read once and kept, because it is asked for on the paint path — `writeHash`
 * consults it on every navigation — and because a mount that changed halfway
 * through a session would leave half the window drawn.
 */
export function mounting(): Mounting {
  if (held !== null) return held
  held =
    typeof window === 'undefined'
      ? PLAIN
      : readMounting(window.location.search, window.location.href)
  return held
}

/** Sugar for the check that is made in a dozen places. */
export function embedded(): boolean {
  return mounting().embed
}

/**
 * Forget the memoised mount. Tests only.
 *
 * Exported rather than reached around, so the one mutable thing in this module
 * has exactly one door and it is a named one.
 */
export function resetMounting(): void {
  held = null
}

/**
 * `true` in a frame whose top-level document is on another origin.
 *
 * The File System Access pickers — `showOpenFilePicker`, `showDirectoryPicker` —
 * are **present and throwing** in a cross-origin frame: the function is there,
 * `typeof` says `'function'`, and calling it rejects with a `SecurityError`. Every
 * capability gate in this app tests for the function (`state/handles.ts`,
 * `state/directories.ts`, `browse/local.ts`, `ui/chooseFiles.ts`), so without
 * this an embedded viewer offers a Choose-files button that silently does
 * nothing — the rejection is indistinguishable from a cancelled dialog, which is
 * exactly what those gates decided to swallow.
 *
 * Answering `true` here routes all four to the fallbacks they already have for
 * Firefox and Safari: an `<input type="file">` for files, and for a directory
 * the snapshot path. Dropping is untouched and works in a frame like anywhere
 * else, which is what keeps "drop your own file on this figure" an embed a page
 * can offer.
 *
 * **Same-origin frames are not this case** and are deliberately not caught: the
 * pickers work there, and an app framed by its own site should keep them.
 *
 * The `try` is the answer as much as the comparison is. Reading
 * `window.top.location` across origins throws, and that throw *is* the finding —
 * a frame that cannot see its top-level document is in another origin from it.
 */
export function crossOriginFrame(): boolean {
  if (typeof window === 'undefined') return false
  if (window.top === window.self || window.top === null) return false
  try {
    return window.top.location.origin !== window.location.origin
  } catch {
    return true
  }
}
