/**
 * Every open tab, kept across a browser restart — and *offered* back, never
 * applied.
 *
 * ## What this is not
 *
 * It is not a replacement for `app/sessions.ts`, and that module's rule is
 * unchanged: the tab strip lives in `sessionStorage`, a set of open files
 * belongs to the window it was opened in, and closing the tab is meant to end
 * it. All of that still holds, and **`sessionStorage` still wins whenever it is
 * present** — it is the same browsing context and strictly fresher, so a reload
 * reads it and never looks here. This record is consulted in exactly one case:
 * there is no session storage at all, which is precisely "the browser was
 * closed".
 *
 * That is also why the record is *offered* rather than restored. Silently
 * reopening six files a week later would reverse a decision `app/sessions.ts`
 * made deliberately, and on a shared machine it would put somebody's unpublished
 * data on screen for whoever sat down next. So the landing page asks, and
 * "Start fresh" is a real answer that forgets the record.
 *
 * ## Why the id sits beside the config rather than inside it
 *
 * A `SessionConfig` is deliberately portable: `applyConfig` re-keys it into
 * whatever tab imports it (`state/SessionConfig.ts`), which is what lets a
 * session exported from tab 3 open in tab 7 without dragging tab 3's memory
 * with it. Folding the session id into the config would put a tab identity into
 * every exported `.metacooler.json` and every share link, for the benefit of one
 * consumer. So the id travels here, in the wrapper, where it is needed for
 * `reserveSessionIds` and for the `UiMemory` keys and nowhere else.
 *
 * ## Written on a debounce
 *
 * `App.remember()` is called on every state change, which includes every frame
 * of a colour-slider drag. A full multi-tab config per frame would serialise
 * IndexedDB transactions behind the drag and make the map stutter — with no
 * error, and looking exactly like a rendering problem. So writes coalesce, and
 * `flushWorkspace` exists for the one moment that cannot wait for a timer: the
 * page going away.
 */

import { STORES, store } from './idb'
import { parseConfig, type SessionConfig } from './SessionConfig'

/** The one key the workspace store holds. */
const KEY = 'current'

/**
 * The record's own version.
 *
 * Read but not yet branched on. It is here because the alternative — adding it
 * when the shape first changes — means the *old* records are the ones with no
 * version in them, which is the case that is hardest to detect and easiest to
 * misread.
 */
export const WORKSPACE_VERSION = 1

/** One tab: the id the strip knew it by, and everything the tab was. */
export interface WorkspaceSession {
  id: string
  config: SessionConfig
}

export interface Workspace {
  version: number
  /** When it was written, for the card that asks whether to restore it. */
  savedAt: string
  sessions: WorkspaceSession[]
  /** The id that was on screen, or `null` when nothing was. */
  active: string | null
}

const workspaceStore = store(STORES.workspace)

/** Trailing debounce, so a drag writes once at the end rather than per frame. */
const WRITE_DELAY_MS = 500

let timer: ReturnType<typeof setTimeout> | null = null
let pending: Workspace | null = null
let inFlight: Promise<void> = Promise.resolve()

/**
 * Remember this workspace, shortly.
 *
 * Fire-and-forget by design: no caller has anything useful to do about a failed
 * write, and `App.remember()` is on the state-change path where an `await` would
 * put storage between a click and a repaint.
 */
export function writeWorkspace(value: Workspace): void {
  pending = value
  if (timer !== null) return
  timer = setTimeout(() => {
    timer = null
    void flushWorkspace()
  }, WRITE_DELAY_MS)
}

/**
 * Write whatever is waiting, now.
 *
 * For `pagehide` and `visibilitychange`, which are the last moments a tab is
 * told about — a debounce timer does not survive the page being closed, so
 * without this the last few seconds of a session are the ones that get lost, and
 * they are the ones the reader remembers.
 */
export async function flushWorkspace(): Promise<void> {
  if (timer !== null) {
    clearTimeout(timer)
    timer = null
  }
  const value = pending
  pending = null
  if (value === null) return
  inFlight = inFlight.then(() => workspaceStore.set(KEY, value)).catch(() => undefined)
  await inFlight
}

/**
 * What a previous browser session left, validated.
 *
 * Untrusted input, exactly as `readSessions` treats its own: a stored record
 * outlives the build that wrote it, so every field is checked and anything that
 * fails is dropped rather than repaired into a tab pointing at nothing.
 *
 * Each config goes back through `parseConfig` rather than being trusted as an
 * object, which costs a `JSON.stringify` round trip per tab and buys the one
 * thing worth buying: there is exactly *one* validator for a session in this
 * app, and a config that arrived from a file, from a share link and from here
 * is checked by the same code. A second validator would be a second thing to
 * keep in step with `SessionConfig`, and it would drift.
 *
 * Not clamped to a tab limit here. `App.restore` already slices its own
 * `MAX_SESSIONS`, and arity is the shell's business rather than storage's.
 */
export async function readWorkspace(): Promise<Workspace | null> {
  const raw = await workspaceStore.get<unknown>(KEY)
  if (typeof raw !== 'object' || raw === null) return null
  const record = raw as Record<string, unknown>
  const list = Array.isArray(record['sessions']) ? record['sessions'] : []

  const sessions: WorkspaceSession[] = []
  const seen = new Set<string>()
  for (const entry of list) {
    if (typeof entry !== 'object' || entry === null) continue
    const row = entry as Record<string, unknown>
    const id = row['id']
    if (typeof id !== 'string' || id === '') continue
    // Two tabs with one id would share every scope keyed on it — their tracks,
    // their filters, their marks. A duplicate is corruption, not a session; the
    // same judgement `readSessions` makes, for the same reason.
    if (seen.has(id)) continue
    let config: SessionConfig | null
    try {
      config = parseConfig(JSON.stringify(row['config']))
    } catch {
      // A config holding something `JSON.stringify` refuses — a cycle, a BigInt
      // — which is not something any writer here produces and is therefore a
      // record somebody else wrote.
      config = null
    }
    if (config === null) continue
    seen.add(id)
    sessions.push({ id, config })
  }
  if (sessions.length === 0) return null

  const active = record['active']
  const savedAt = record['savedAt']
  const version = record['version']
  return {
    version: typeof version === 'number' ? version : WORKSPACE_VERSION,
    savedAt: typeof savedAt === 'string' ? savedAt : '',
    sessions,
    active: typeof active === 'string' && seen.has(active) ? active : null,
  }
}

/**
 * Drop the record.
 *
 * Both "Start fresh" and "Forget everything" land here. Any write still waiting
 * is dropped with it, or the debounce would put the workspace straight back a
 * moment after the reader asked for it to go.
 */
export async function forgetWorkspace(): Promise<void> {
  if (timer !== null) {
    clearTimeout(timer)
    timer = null
  }
  pending = null
  await workspaceStore.delete(KEY)
}

/**
 * Whether the record may be written, cleared, or neither, right now.
 *
 * A pure function because the rule is subtle and the bug it encodes was
 * invisible: **a window with nothing open is two completely different facts.**
 * After the reader closes their last tab it means *I am finished, forget this*.
 * During startup it means *nothing has been restored yet* — and acting on it
 * there deletes the record while the very read that would have offered it back
 * is still in flight. That is a race, it resolves differently on a warm cache
 * than a cold one, and what a reader sees is a workspace that vanishes on some
 * loads and not others with nothing to show for it.
 *
 * `wait` is therefore not an optimisation; it is the whole point.
 */
export function recordAction(state: {
  /** Has the boot decided whether to offer a previous workspace? */
  settled: boolean
  /** Is that offer on screen, unanswered? */
  offering: boolean
  /** How many open tabs actually hold a file. */
  tabs: number
}): 'write' | 'forget' | 'wait' {
  // Before the question is settled, and while it is on the reader's screen, the
  // record is not this window's to touch — forgetting it would delete the thing
  // they are being asked about.
  if (!state.settled || state.offering) return 'wait'
  return state.tabs === 0 ? 'forget' : 'write'
}

/** What the restore card counts, as data rather than as a sentence. */
export interface WorkspaceSummary {
  tabs: number
  /** File labels, in tab order — what the reader recognises the session by. */
  files: string[]
  tracks: number
}

/**
 * Summarise a record for the offer.
 *
 * Here rather than in the card because it is arithmetic over a stored shape and
 * it is worth a test; the card turns it into English, which is not.
 */
export function summariseWorkspace(workspace: Workspace): WorkspaceSummary {
  return {
    tabs: workspace.sessions.length,
    files: workspace.sessions.map((session) => session.config.state.uri),
    tracks: workspace.sessions.reduce((total, session) => total + session.config.tracks.length, 0),
  }
}
