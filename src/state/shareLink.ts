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

import { CONFIG_KIND, parseConfig, type SessionConfig } from './SessionConfig'

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
  const json = new TextEncoder().encode(JSON.stringify(config))
  return toBase64Url(await deflate(json))
}

/** The inverse. `null` for anything that is not one, rather than a throw. */
export async function decodeShare(payload: string): Promise<SessionConfig | null> {
  try {
    const json = new TextDecoder().decode(await inflate(fromBase64Url(payload)))
    const config = parseConfig(json)
    return config !== null && config.kind === CONFIG_KIND ? config : null
  } catch {
    // A truncated link — pasted across two lines by a mail client, most often —
    // reaches here, and the right answer is the picker rather than an error
    // screen about base64.
    return null
  }
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
    'between here and the recipient will probably break it. Saving the session as a file and ' +
    'sending that is the reliable form of the same thing.'
  )
}
