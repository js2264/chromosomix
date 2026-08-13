/**
 * A whole session in a link.
 *
 * §5.5 says the URL carries *what is being looked at* and `SessionConfig` says
 * the rest — eight tracks with their colours and limits, a set of ticked
 * chromosomes, forty bookmarks — belongs in a file. Both remain true. What was
 * missing is the case between them: **somebody wants to send a colleague what
 * they are looking at**, and neither answer serves it. A link carries none of
 * the work; a file has to be attached, downloaded and dropped, and by the time
 * it has been the moment has passed.
 *
 * ## Why the link holds the session rather than pointing at it
 *
 * A genuinely tiny URL needs a server to hold the state, and C1 says there is no
 * server. That constraint is not negotiable and it is not a limitation here: a
 * link that carries its own contents cannot expire, cannot be taken down, works
 * offline, works in the desktop build, and needs no account from anybody. What
 * it costs is length — a few hundred characters for a plain view, a few thousand
 * for a workspace — and length is the cheapest of those five things to give up.
 *
 * So the session is JSON, deflated, and base64url-encoded into the fragment.
 * **The fragment specifically**: a URL fragment is not sent to the server on
 * navigation, which for a page served from GitHub Pages means the contents of
 * somebody's session never reach GitHub. That is the same privacy property §11
 * claims for the data itself, extended to the description of it.
 *
 * ## And the shortener, which is a different promise
 *
 * A third-party shortener produces a genuinely short link and is offered
 * separately, never automatically, because it breaks two of the five properties
 * above: the link now depends on somebody else's service staying up, and the URL
 * — which names the bucket and the path of the file being viewed — leaves the
 * browser. Both are fine when a reader has decided they are fine. Neither is
 * something to do on their behalf, which is why {@link shortenable} refuses a
 * session over a local file outright: there is nothing on the other end for a
 * recipient to open, so the only effect of shortening it would be to post a
 * filename to a stranger.
 */

import { isRefusal, type ConfigRefusal, type SessionConfig } from './SessionConfig'
import { buildWorkspaceFile, parseWorkspaceFile } from './workspace'

/** The fragment key a shared session travels under. */
export const SHARE_KEY = 's'

/**
 * Base64url, which is base64 with two characters swapped and the padding gone.
 *
 * `+` and `/` are both legal in a fragment and both are routinely
 * percent-encoded by something in the chain — a chat client, a mail client, a
 * wiki — which turns a working link into a broken one somewhere between the two
 * people. `-` and `_` are not.
 */
function toBase64Url(bytes: Uint8Array): string {
  let binary = ''
  // A chunk at a time: `String.fromCharCode(...bytes)` spreads the whole array
  // into an argument list, and a session of any size overflows the stack.
  const chunk = 0x8000
  for (let at = 0; at < bytes.length; at += chunk) {
    binary += String.fromCharCode(...bytes.subarray(at, at + chunk))
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function fromBase64Url(text: string): Uint8Array {
  const padded = text.replace(/-/g, '+').replace(/_/g, '/')
  const binary = atob(padded + '='.repeat((4 - (padded.length % 4)) % 4))
  const out = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i)
  return out
}

async function deflate(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([bytes as BlobPart])
    .stream()
    .pipeThrough(new CompressionStream('deflate-raw'))
  return new Uint8Array(await new Response(stream).arrayBuffer())
}

async function inflate(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([bytes as BlobPart])
    .stream()
    .pipeThrough(new DecompressionStream('deflate-raw'))
  return new Uint8Array(await new Response(stream).arrayBuffer())
}

/**
 * A session as the fragment payload.
 *
 * `deflate-raw` rather than `gzip`: the eighteen bytes of gzip header and
 * trailer are two dozen base64 characters, and nothing here needs a checksum —
 * a corrupted fragment fails to parse as JSON, which is the same outcome a CRC
 * mismatch would give and is reached without paying for one.
 */
export async function encodeShare(config: SessionConfig): Promise<string> {
  // A workspace of **one** tab, so the link and the file are the same format
  // even though they carry different amounts of it. The wrapper costs a few
  // dozen bytes after deflate and buys one parser instead of two.
  //
  // One tab and not the window, and that is not an aesthetic call: `lengthAdvice`
  // below already warns past about eight thousand characters, and a single
  // session with eight tracks is a few thousand — a link carrying six tabs would
  // open by telling the reader not to use it. §5.5's rule says the same thing
  // from the other side: a link is *what is being looked at*, and there is one of
  // those on screen. The file is what carries a window.
  const file = buildWorkspaceFile([forSharing(config)], 0, new Date())
  const json = new TextEncoder().encode(JSON.stringify(file))
  return toBase64Url(await deflate(json))
}

/**
 * A session with the parts a link may not carry taken out.
 *
 * Applied **inside** {@link encodeShare} rather than at its call site, and that
 * placement is the point: a second caller cannot forget it. Three fields go, and
 * all three are already *claimed* to be absent from links by comments elsewhere
 * in this codebase — `SessionConfig.compare` says "a shared link still cannot",
 * and `panels/deck.ts` says spelling a companion's name into one "would post a
 * private filename to a stranger — which `state/shareLink.ts` already refuses to
 * do". Neither was true. One function makes both honest.
 *
 * - **`compare`** and **`deck.locals`** are bare local filenames. A recipient
 *   cannot open them under any resolution, and worse than useless: the grant
 *   store is keyed on the bare name and its guard compares only the name, so a
 *   recipient who has ever granted their own `rep2.cool` would open *their* file
 *   in the sender's slot with every label agreeing (`state/handles.ts`).
 * - **`source`** is the size and modification time of a file on somebody's own
 *   machine. It exists to catch a wrong file locally; in a link it is metadata
 *   about a private disk that the recipient can do nothing with.
 *
 * **`deck.looks`** is the one field that is neither kept nor dropped whole: a
 * look is keyed on the file it describes, so the ones naming local companions go
 * with `locals` and the ones naming remote companions travel. Same rule, applied
 * per member because the field has members of both kinds.
 *
 * A **local track is kept**, and the rule that decides all four is the one
 * `resolveConfig` states: a private name is stripped only where the structure
 * survives without it. A dropped companion costs a label — `state.maps` still
 * carries `~`, so the slot, the count and the order remain — while a dropped
 * track costs the row, and a recipient silently receiving seven where eight were
 * sent is exactly what that placeholder exists to prevent.
 */
export function forSharing(config: SessionConfig): SessionConfig {
  // `?? {}` because this takes whatever it is handed. Everything `parseConfig`
  // and `buildConfig` produce has a `deck`, but a link is encoded from an object
  // that has passed through other hands, and a share button that threw on a
  // config missing one field would be a worse failure than the one this function
  // exists to prevent.
  const deck = config.deck ?? {}
  // The looks of the companions a recipient can actually open, and only those.
  // A look is keyed on the file it describes (`panels/deck.ts`'s `DeckLook`), so
  // one naming a local companion carries the same bare filename `locals` is
  // stripped for — and `locals` is what says which names those are. A remote
  // companion's clip is the opposite case and worth sending: the recipient opens
  // the same URL, and a deck of four replicates arriving on four different
  // scales is the figure not arriving.
  const local = new Set((deck.locals ?? []).map((held) => held.uri))
  const looks = (deck.looks ?? []).filter((look) => !local.has(look.uri))
  const shared: SessionConfig = {
    ...config,
    deck: {
      ...(deck.starred === undefined ? {} : { starred: deck.starred }),
      ...(deck.columns === undefined ? {} : { columns: deck.columns }),
      ...(looks.length === 0 ? {} : { looks }),
    },
  }
  // Deleted rather than set to `undefined`: a key holding nothing is a third
  // state, it survives `JSON.stringify` as an absence anyway, and every reader
  // downstream treats absence as the answer.
  delete shared.compare
  delete shared.source
  return shared
}

/** The inverse. `null` for anything that is not one, rather than a throw. */
export async function decodeShare(payload: string): Promise<SessionConfig | ConfigRefusal | null> {
  let json: string
  try {
    json = new TextDecoder().decode(await inflate(fromBase64Url(payload)))
  } catch {
    // A truncated link — pasted across two lines by a mail client, most often —
    // reaches here, and the right answer is the picker rather than an error
    // screen about base64. `null` is *this* failure and only this one: the
    // payload did not survive the journey.
    return null
  }
  // Everything past the inflate arrived intact, so a refusal from here is about
  // the *workspace* and is worth passing on rather than flattening into "cut
  // short in transit". A link from a newer build is the case that matters: it
  // travelled perfectly and this build cannot read it, and telling the
  // recipient their link is broken sends them back to the sender for a fresh
  // copy of a link that will fail the same way.
  const read = parseWorkspaceFile(json)
  if (isRefusal(read)) return read
  // One tab is what a link carries, and `parseWorkspaceFile` has already refused
  // a file with none — so this is the tab that was shared.
  return read.tabs[read.active] ?? read.tabs[0]
}

/** The payload out of a location hash, or `null` when it carries none. */
export function readShareHash(hash: string): string | null {
  const text = hash.startsWith('#') ? hash.slice(1) : hash
  if (text === '') return null
  for (const part of text.split('&')) {
    const at = part.indexOf('=')
    if (at < 0) continue
    if (part.slice(0, at) === SHARE_KEY) return part.slice(at + 1)
  }
  return null
}

/** The whole link, from a payload and the page it is for. */
export function shareUrl(base: string, payload: string): string {
  const [withoutHash] = base.split('#')
  return `${withoutHash}#${SHARE_KEY}=${payload}`
}

/**
 * Whether this session is one a third-party shortener should be offered for.
 *
 * A session over a local file names a file on one machine. The long link is
 * still worth having — the recipient gets the tracks, the marks and the
 * bookmarks and is asked for the bytes, which is exactly what a reload already
 * does (§8.6) — but shortening it would send a stranger a filename in exchange
 * for nothing at all.
 */
export function shortenable(config: SessionConfig): boolean {
  return /^(https?|s3):\/\//i.test(config.state.uri)
}

/** The service, named in the interface rather than hidden behind a verb. */
export const SHORTENER = {
  name: 'is.gd',
  endpoint: 'https://is.gd/create.php',
} as const

/**
 * Ask the shortener for a short link.
 *
 * Two failures are expected and are reported rather than swallowed: the service
 * being unreachable, and the browser refusing the response for want of a CORS
 * header. Neither is recoverable here and neither should lose the reader their
 * long link, so the caller keeps it on screen throughout.
 */
export async function shorten(url: string): Promise<string> {
  const endpoint = `${SHORTENER.endpoint}?format=simple&url=${encodeURIComponent(url)}`
  const response = await fetch(endpoint, { method: 'GET' })
  if (!response.ok) {
    throw new Error(`${SHORTENER.name} refused the link (HTTP ${response.status}).`)
  }
  const short = (await response.text()).trim()
  if (!/^https?:\/\//i.test(short)) {
    throw new Error(`${SHORTENER.name} answered with something that is not a link.`)
  }
  return short
}

/**
 * How long the link is, and whether that is a problem yet.
 *
 * There is no limit in any browser that a session approaches — Chrome and
 * Firefox both handle fragments in the megabytes — but a link is rarely used in
 * a browser alone. It is pasted into Slack, into a mail client, into a wiki, and
 * some of those wrap or truncate past a couple of thousand characters. Saying
 * the number is more use than guessing on the reader's behalf: they know where
 * they are about to paste it and this does not.
 */
export function lengthAdvice(length: number): string | null {
  if (length <= 2000) return null
  if (length <= 8000) {
    return (
      `This link is ${length.toLocaleString()} characters. Every browser handles that; some ` +
      'chat and mail clients wrap or truncate past about two thousand, so paste it as a link ' +
      'rather than as text where you can.'
    )
  }
  return (
    `This link is ${length.toLocaleString()} characters, which is long enough that something ` +
    'between here and the recipient will probably break it. Saving the workspace as a file and ' +
    'sending that is the reliable form of the same thing.'
  )
}
