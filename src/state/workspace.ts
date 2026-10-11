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
 * every exported `.chromosomix.json` and every share link, for the benefit of one
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
import {
  CONFIG_VERSION,
  isRefusal,
  parseTab,
  readTab,
  type ConfigRefusal,
  type SessionConfig,
} from './SessionConfig'
import { COMMIT, PRODUCER } from '../version'

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
/** Set once by {@link suspendWorkspace}; see there for why nothing clears it. */
let suspended = false

/**
 * Remember this workspace, shortly.
 *
 * Fire-and-forget by design: no caller has anything useful to do about a failed
 * write, and `App.remember()` is on the state-change path where an `await` would
 * put storage between a click and a repaint.
 */
export function writeWorkspace(value: Workspace): void {
  // The reader asked, in this window, that nothing be kept ({@link
  // suspendWorkspace}). Dropped rather than deferred: there is no later moment
  // at which this value becomes one they asked for.
  if (suspended) return
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
 * Each tab goes through `parseTab` rather than being trusted as an object,
 * which is the one thing worth insisting on: there is exactly *one* validator
 * for a tab in this app, and one that arrived from a file, from a share link and
 * from here is checked by the same code. A second validator would be a second
 * thing to keep in step with `SessionConfig`, and it would drift.
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
      config = parseTab(row['config'])
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
 *
 * Dropping is all this does, and for "Forget everything" that is deliberately
 * not enough on its own — see {@link suspendWorkspace}, which `state/stored.ts`
 * calls beside this one.
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
 * Stop writing the record at all, for the rest of this page load.
 *
 * The second half of "Forget everything" (`state/stored.ts`), and the half that
 * is easy to leave out because the first half *looks* complete: the record is
 * gone the moment the button is pressed. It comes back on its own.
 * `App.rememberDurably()` sits on the state-change path and writes
 * unconditionally once the boot has settled, and `pagehide` flushes whatever is
 * waiting — so a reader on a borrowed laptop pressed the button, watched the
 * record go, panned the map once (or simply closed the browser) and the next
 * person to open the site was met by the banner naming the file they had been
 * reading. That is the §11 outcome the button exists to prevent, reached
 * without the reader doing anything they would recognise as undoing it.
 *
 * **Nothing clears this, and {@link forgetWorkspace} deliberately does not.**
 * Re-arming there is the tempting shortcut and it hands the leak straight back:
 * closing the last tab is `recordAction`'s `'forget'`, so a reader who forgot
 * everything and then closed their one tab would be recorded again by the next
 * file they opened, having asked for exactly the opposite. Being forgotten is
 * not a state that a pan, a tab close or a "Start fresh" should be able to talk
 * this window out of.
 *
 * A **reload** re-arms it, because module state does not survive one — and that
 * is the right line rather than a leak in the flag. It is the same line
 * `stored.ts` draws when it refuses to reload the page on the reader's behalf:
 * a live tab is something they are looking at, not something that was kept, and
 * a window they have deliberately started again is a new answer to the same
 * question.
 */
export function suspendWorkspace(): void {
  suspended = true
  // The write already on the debounce goes too. It was queued before the button
  // and would land half a second after it, which is the failure `forgetWorkspace`
  // above cancels for "Start fresh" and the one the sweep used to walk into.
  if (timer !== null) {
    clearTimeout(timer)
    timer = null
  }
  pending = null
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

// ---------------------------------------------------------------------------
// The workspace as a file
// ---------------------------------------------------------------------------

/** What the file says it is, so a stray `.json` is not read as one. */
export const WORKSPACE_KIND = 'chromosomix.workspace'

/**
 * A workspace written out: every tab in the window, and which was in front.
 *
 * ## Why this is not the record above
 *
 * They are the same *idea* and deliberately not the same shape, because they
 * are different artifacts with one difference that matters: **the record keeps
 * session ids and the file must not.**
 *
 * A record is private to this browser and its ids are live — they key every
 * `UiMemory` scope of a tab that is still open, and reusing them on restore is
 * what puts a reader back in the window they left. A sender's `s1` means nothing
 * in a recipient's window and would *collide* with a tab they already have, so a
 * file carries its tabs in order and names the active one by **index**.
 *
 * What the two do share is the only thing worth sharing: `SessionConfig`, and
 * therefore `parseTab`. One definition of what a tab is, three roads.
 */
export interface WorkspaceFile {
  kind: typeof WORKSPACE_KIND
  version: number
  createdAt: string
  /** Which build wrote it; see `SessionConfig.producer`. */
  producer?: string
  commit?: string
  /** Index into {@link tabs}, or `-1` when the window had nothing in front. */
  active: number
  tabs: SessionConfig[]
}

/** Gather the open tabs into the thing that gets written to disk. */
export function buildWorkspaceFile(
  tabs: readonly SessionConfig[],
  active: number,
  now: Date,
): WorkspaceFile {
  return {
    kind: WORKSPACE_KIND,
    version: CONFIG_VERSION,
    createdAt: now.toISOString(),
    producer: PRODUCER,
    ...(COMMIT === '' ? {} : { commit: COMMIT }),
    // Clamped rather than trusted: an out-of-range index would open a window
    // with no tab in front, which is a state nothing else in the app produces.
    active: active >= 0 && active < tabs.length ? active : tabs.length > 0 ? 0 : -1,
    tabs: [...tabs],
  }
}

/**
 * Read a workspace out of a file's text, or refuse it with a reason.
 *
 * Strict about identity and forgiving about contents, which is the same
 * character `readTab` has and for the same reasons — a file arrives from
 * anywhere and must name itself, while a tab it holds may have been written by a
 * build that knew fewer fields.
 *
 * **A tab that does not check out is dropped and its neighbours are kept.** Nine
 * good tabs and one corrupt one is nine tabs, not an error screen: the reader
 * loses what was actually lost and nothing more.
 */
export function parseWorkspaceFile(text: string): WorkspaceFile | ConfigRefusal {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return { reason: 'not-json' }
  }
  if (typeof parsed !== 'object' || parsed === null) return { reason: 'not-a-workspace' }
  const row = parsed as Record<string, unknown>
  if (row['kind'] !== WORKSPACE_KIND) return { reason: 'not-a-workspace' }

  // The same gate `readTab` applies, one level up and for the same reason: a
  // version is a claim about what every field in the file *means*, so a file
  // from a newer build is refused rather than read as though it were current.
  const version = typeof row['version'] === 'number' ? row['version'] : CONFIG_VERSION
  if (version > CONFIG_VERSION) {
    const producer = row['producer']
    return {
      reason: 'newer',
      version,
      ...(typeof producer === 'string' && producer !== '' ? { producer } : {}),
    }
  }

  const list = Array.isArray(row['tabs']) ? (row['tabs'] as unknown[]) : []
  const tabs: SessionConfig[] = []
  for (const entry of list) {
    const tab = readTab(entry)
    if (!isRefusal(tab)) tabs.push(tab)
  }
  if (tabs.length === 0) return { reason: 'not-a-workspace' }

  const active = row['active']
  const producer = row['producer']
  const commit = row['commit']
  return {
    kind: WORKSPACE_KIND,
    version,
    createdAt: typeof row['createdAt'] === 'string' ? row['createdAt'] : '',
    ...(typeof producer === 'string' && producer !== '' ? { producer } : {}),
    ...(typeof commit === 'string' && commit !== '' ? { commit } : {}),
    // Out of range is the front tab, not an error: the index may name a tab that
    // was dropped above, and a window has to open on something.
    active: typeof active === 'number' && active >= 0 && active < tabs.length ? active : 0,
    tabs,
  }
}

/**
 * What a saved workspace is called.
 *
 * The tab **count is deliberately not in the name**. It would be wrong the
 * moment anybody edits the file, and nothing routes on the name anyway — the
 * `kind` inside is what decides. The `.chromosomix.json` suffix stays so the
 * family is recognisable and so `looksLikeConfig` and any future file
 * association keep working.
 */
export function workspaceFileName(stamp: string): string {
  return `workspace-${stamp}.chromosomix.json`
}

/**
 * How many incoming tabs a window can seat, and what it does with the one it
 * already has.
 *
 * A pure function for the reason `recordAction` is one: the rules are small,
 * each guards a failure that is invisible when it happens, and none of them
 * needs a DOM to decide.
 *
 * - **A window with one empty tab consumes it.** Dropping a workspace onto a
 *   fresh window should not leave the picker sitting beside the imports.
 * - **Never more than the window allows.** Twelve is a memory limit, not a
 *   rendering one (`App.MAX_SESSIONS`), and a partial import is useful where an
 *   abort loses everything — so the overflow is *counted* and named rather than
 *   dropped in silence.
 */
export function seatWorkspace(state: {
  /** Tabs currently holding a file. */
  open: number
  /** Whether exactly one tab is present and empty. */
  emptyTab: boolean
  incoming: number
  max: number
}): { consumeEmpty: boolean; take: number; dropped: number } {
  const consumeEmpty = state.emptyTab && state.open === 0
  const room = Math.max(0, state.max - state.open)
  const take = Math.min(state.incoming, room)
  return { consumeEmpty, take, dropped: state.incoming - take }
}
