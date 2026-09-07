/**
 * *Go here* and *tell me where you are*, across the frame boundary.
 *
 * An embedded viewer that can only be linked to is a picture. The thing a host
 * page actually wants is the other half: a table of loci beside the frame whose
 * rows move the map, and a caption under it that follows the map when the reader
 * moves it themselves. Both are one `postMessage` channel, and this is it.
 *
 * ## The protocol, in four messages
 *
 * Out, from the frame:
 *
 * - `{ type: 'metacooler:ready', protocol, version, commit }` — once, when the
 *   window is mounted. It carries **nothing about the reader's session**, which
 *   is what lets it be the one message posted before anybody has identified
 *   themselves.
 * - `{ type: 'metacooler:state', state }` — the view state (§5.5), as the same
 *   object the URL hash is written from, or `null` for the file picker.
 *
 * In, from the host:
 *
 * - `{ type: 'metacooler:where' }` — answered with `state`.
 * - `{ type: 'metacooler:navigate', state }` — go here. A **patch**: the keys
 *   given are laid over the view state that is on screen, so `{ locus: … }` moves
 *   the browser without the host having to know what else is in the state, a key
 *   set to `null` is *removed*, and `state: null` is the picker.
 *
 * ## Who is answered, and when
 *
 * The channel answers **the window that framed this one** — the immediate
 * parent, not an arbitrary ancestor and not another frame — and it only ever
 * speaks after that window has spoken. `ready` is the single exception and is
 * the reason the handshake terminates: the host cannot know when the frame is
 * listening, so the frame says so, and says nothing else until it is addressed.
 *
 * Replies and pushes then go to the origin the host spoke from, never to `*`.
 * That matters for one case which is easy to miss: a reader can open **their
 * own** file in an embed — a private bucket URL, a dropped path — and the state
 * that follows names it. The host page already knows the URL it framed; it has
 * no business learning the one the reader typed unless it is the page that asked
 * to be told.
 *
 * The exception is an opaque origin — a `file://` host, or a sandboxed frame
 * without `allow-same-origin`, both of which report `"null"` and cannot be named
 * as a target. There the reply goes to the same window with no origin named,
 * because that is the only address it has, and a message posted straight back at
 * the window that just spoke is as narrow as `*` ever gets.
 *
 * ## Why a patch is parsed rather than believed
 *
 * The payload is an object from another origin, so it is exactly as untrusted as
 * the URL hash — and the hash already has a reader that validates every key,
 * clamps what needs clamping and drops what it does not recognise. So a patch is
 * merged, **serialised, and parsed back** through `state/ViewState.ts`. Nothing
 * here decides what a legal view state is; `parseViewState` does, as it does for
 * a pasted link and a restored tab. One parser, three roads.
 */

import { parseViewState, serialiseViewState } from '../state/ViewState'
import type { ViewState } from '../types'
import { COMMIT, VERSION } from '../version'

/** The frame is mounted and listening. Carries nothing about the session. */
export const EMBED_READY = 'metacooler:ready'
/** Where the view is now, in answer or unprompted. */
export const EMBED_STATE = 'metacooler:state'
/** Ask where the view is. */
export const EMBED_WHERE = 'metacooler:where'
/** Move the view. */
export const EMBED_NAVIGATE = 'metacooler:navigate'

/**
 * The protocol's own version, carried by `ready`.
 *
 * Bumped when a message changes meaning, never when one is *added* — the same
 * rule `CONFIG_VERSION` states, for the same reason: a host written against
 * version 1 ignores a message it has never heard of, and would be broken by a
 * key that quietly started meaning something else.
 */
export const EMBED_PROTOCOL = 1

/** What the channel needs of the window it is driving. */
export interface EmbedHost {
  /** The view state on screen, or `null` for the picker. */
  state(): ViewState | null
  /** Go here. `null` is the picker. */
  navigate(state: ViewState | null): void
}

/** The half of `Window` a message is posted to; a test hands over a spy. */
export interface MessageTarget {
  postMessage(message: unknown, targetOrigin: string): void
}

/** The half of `Window` messages arrive on. */
export interface MessageSource {
  addEventListener(type: 'message', listener: (event: MessageEvent) => void): void
  removeEventListener(type: 'message', listener: (event: MessageEvent) => void): void
}

/**
 * Lay a patch over a view state, then read the result as if it were a link.
 *
 * The cast is the one liberty taken, and it is bounded by the two lines above
 * it: only string, number and boolean values survive the merge, and
 * `serialiseViewState` reads none but the keys it knows — so what reaches
 * `parseViewState` is a hash body of exactly the shape the address bar produces,
 * whatever the host sent. An array, an object or a function in the patch is not
 * a view-state value and is dropped rather than stringified into one.
 *
 * `null` **removes** a key, which is the only way a host can say "no locus" —
 * `undefined` does not survive `postMessage`'s structured clone, so it cannot be
 * the vocabulary for it.
 */
export function mergeState(
  current: ViewState | null,
  patch: Record<string, unknown> | null,
): ViewState | null {
  if (patch === null) return null
  const merged: Record<string, unknown> = { ...(current ?? {}) }
  for (const [key, value] of Object.entries(patch)) {
    if (value === null || value === undefined) delete merged[key]
    else if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      merged[key] = value
    }
  }
  return parseViewState(serialiseViewState(merged as unknown as ViewState))
}

/** `true` for a message shaped like one of ours, whoever sent it. */
function isEmbedMessage(data: unknown): data is { type: string; state?: unknown } {
  return (
    typeof data === 'object' &&
    data !== null &&
    typeof (data as { type?: unknown }).type === 'string'
  )
}

/**
 * One frame's end of the conversation.
 *
 * Built by {@link embedChannel} in the app and by tests directly, which is why
 * the parent and the event source are arguments rather than reached for: the
 * whole protocol is then assertable without a second window existing.
 */
export class EmbedChannel {
  /**
   * Who has spoken, and how to answer them. `null` until somebody has.
   *
   * The origin is what `postMessage` is given as its target, so the opaque case
   * is not a second field but a different value in this one: `'*'`, aimed at the
   * same window. Every send then reads one thing, and there is no pair of fields
   * that can disagree about who the host is.
   */
  private reply: { target: MessageTarget; origin: string } | null = null
  /**
   * The last state posted, serialised.
   *
   * A `navigate` is answered *and* produces a view change, which is two reasons
   * to send the same thing; and a repaint that leaves the state alone is no
   * reason at all. Comparing the string the address bar would carry collapses
   * both, and is the same equality the hash writer uses one layer up.
   */
  private sent: string | null = null
  private listening = false

  private readonly onMessage = (event: MessageEvent): void => this.receive(event)

  constructor(
    private readonly host: EmbedHost,
    /** The window that framed this one, or `null` when nothing did. */
    private readonly parent: MessageTarget | null,
    private readonly events: MessageSource,
  ) {}

  /** Listen, and announce. Safe to call twice. */
  start(): void {
    if (this.listening || this.parent === null) return
    this.listening = true
    this.events.addEventListener('message', this.onMessage)
    // To `*`, and the only message that ever is. A host cannot name an origin it
    // has not been told about, and this carries nothing worth withholding: which
    // build is in the frame, and that it is ready to be addressed.
    this.parent.postMessage(
      {
        type: EMBED_READY,
        protocol: EMBED_PROTOCOL,
        version: VERSION,
        ...(COMMIT === '' ? {} : { commit: COMMIT }),
      },
      '*',
    )
  }

  /** Stop listening. The host is forgotten with the listener. */
  stop(): void {
    if (!this.listening) return
    this.listening = false
    this.events.removeEventListener('message', this.onMessage)
    this.reply = null
    this.sent = null
  }

  /**
   * The view moved.
   *
   * Called on every view change, and silent until somebody has asked to be told
   * — which is what keeps an embed that nobody is driving from posting a
   * message per pan.
   */
  moved(): void {
    this.send()
  }

  /**
   * `true` when this message came from the window that framed us.
   *
   * The two casts are to one type the DOM keeps apart for good reasons that are
   * not this one: `event.source` is a `MessageEventSource` and `parent` is
   * narrowed here to the one method this class calls on it. Identity is the
   * whole question, and both are the same object when the answer is yes.
   */
  private fromParent(event: MessageEvent): boolean {
    return (event.source as unknown) === (this.parent as unknown)
  }

  private receive(event: MessageEvent): void {
    // The parent and nothing else. A message from a sibling frame, from a
    // pop-up, or from this window's own code is not the host addressing us, and
    // an embed has exactly one host.
    if (this.parent === null || !this.fromParent(event)) return
    const data = event.data
    if (!isEmbedMessage(data)) return
    if (data.type !== EMBED_WHERE && data.type !== EMBED_NAVIGATE) return

    // A `navigate` carries a patch or an explicit `null` and nothing else.
    // Anything else is a typo rather than a question — refused **before** the
    // host is recorded, so a malformed message neither moves the view nor
    // subscribes its sender to what the reader does next.
    const patch = data.type === EMBED_NAVIGATE ? data.state : undefined
    if (data.type === EMBED_NAVIGATE && patch !== null && typeof patch !== 'object') return

    // Whoever has spoken is who gets told from now on. An origin that cannot be
    // named is answered at the window itself; see the header on why that is as
    // narrow as it looks.
    const named = event.origin !== 'null' && event.origin !== ''
    this.reply = { target: this.parent, origin: named ? event.origin : '*' }

    if (data.type === EMBED_NAVIGATE) {
      this.host.navigate(
        patch === null ? null : mergeState(this.host.state(), patch as Record<string, unknown>),
      )
    }
    // Both messages are answered with the state, and `navigate` is answered
    // *after* it has been applied — so what comes back is where the view
    // actually went, which for a patch the parser trimmed is not always where
    // the host asked to go.
    this.send()
  }

  private send(): void {
    const to = this.reply
    if (to === null) return
    const state = this.host.state()
    const key = state === null ? '' : serialiseViewState(state)
    if (key === this.sent) return
    this.sent = key
    to.target.postMessage({ type: EMBED_STATE, state }, to.origin)
  }
}

/**
 * The channel for this page, or `null` where there is nobody to talk to.
 *
 * `null` in a top-level window, which is the ordinary case and not a failure:
 * the app is then the whole page and the host it would be answering is the
 * reader.
 */
export function embedChannel(host: EmbedHost): EmbedChannel | null {
  if (typeof window === 'undefined') return null
  if (window.parent === window.self || window.parent === null) return null
  return new EmbedChannel(host, window.parent, window)
}
