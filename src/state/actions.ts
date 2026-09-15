/**
 * What this window has done, kept as the lines that would do it again.
 *
 * The Analysis drawer already writes one run as a shell command
 * (`analysis/cliCommand.ts`), and the argument for that button — the reader who spends twenty minutes nudging
 * four numbers until the picture is right, and then has two hundred files rather
 * than one — has a hole in it that the button cannot close. It copies **the run
 * on screen**, and only while it is on screen: press *run on all maps* over a
 * deck of six and five of those commands are never offered at all, because the
 * drawer shows one result at a time; change a parameter and run again, and the
 * command that produced the figure from an hour ago is gone. A reader
 * reconstructing an afternoon is back to transcription, which is the one step
 * the whole subtree exists to remove.
 *
 * So the command is written **when the job runs** rather than when a result is
 * looked at, and it is written every time: a batch of six maps is six lines, one
 * per file, because six runs happened. That is the whole of this module.
 *
 * ## Data, not analysis
 *
 * An entry is text — a line, some `#` notes, a block of detail, a status. It is
 * emphatically *not* a `Provenance`, a `TaskResult` or an `AnalysisTask`, and
 * this module imports none of them. How a run is *spelled* as a command is
 * `analysis/record.ts`, which has `cliCommandFor` and `provenanceLines` for
 * exactly that; `state/` is where the window's memory lives, below the features
 * that fill it. Keeping the store on this side of that line is what lets a
 * `Session` open, a track load and an export land in the same list as a run
 * without any of them learning what the others are.
 *
 * ## One list for the window
 *
 * Not per tab, and not per file. A reader with three coolers open ran the
 * afternoon, not the tab — and the natural question at the end of it ("what did
 * I actually do to these files?") is one nothing per-session can answer. It is
 * also why this is a module singleton rather than something a `Session` owns:
 * a session is created and destroyed with a file, and closing a tab must not
 * take its half of the day's record with it.
 *
 * ## Kept for a week, in `localStorage`
 *
 * The point is to recover *yesterday's* commands, so the list has to survive a
 * reload, a closed tab and an evening. `localStorage`, therefore, on the same
 * reasoning `ui/ThemeToggle.ts` gives: `sessionStorage` is the train of thought
 * inside one window (§8.6), and this outlives the window by design. Capped at
 * {@link MAX_ENTRIES} and {@link MAX_AGE_DAYS} because unbounded growth in a
 * store with a five-megabyte ceiling is a store that eventually refuses the
 * write that matters, and because a command from a fortnight ago is one whose
 * file has usually moved.
 *
 * **Two windows share it.** A reader with the app open twice has one afternoon,
 * not two, and each window holds its own copy — so a plain write would be
 * whichever saved last deleting the other's morning. Every write joins what is
 * on the disk first, and a `storage` event joins the other way, so the two
 * converge without either losing a line. The one write that does not join is
 * {@link clearActions}, which means the opposite.
 *
 * **An embed writes nothing.** A figure in somebody else's page is not the
 * reader's window (§21.2), and a log of what a page's own author did with a
 * viewer has no business seeding the console a reader meets on the real site.
 * The list still fills in memory, so the panel works if it is ever opened there;
 * it simply leaves no trace, which is the line `App.rememberDurably` and
 * `SidePanel` already draw.
 *
 * **And it is in the account.** What this holds is a list of file names and the
 * loci a reader looked at, which is precisely the kind of thing §11 says a
 * reader on a borrowed machine is owed a straight answer about: `state/stored.ts`
 * counts it, and {@link forgetActions} is how the sweep drops it — the prefix
 * would clear the key on its own, and the copy this module holds in memory would
 * write it straight back.
 */

import { embedded } from '../embed'

/** Which door an action came through; the console reads it as a mark. */
export type ActionKind =
  /** An analysis task went to a worker. */
  | 'run'
  /** A file was opened as a map or as a genome. */
  | 'open'
  /** An annotation file joined the session. */
  | 'track'
  /** A file was written out. */
  | 'write'

/**
 * Where an action got to.
 *
 * `interrupted` is not a state anything sets: it is what a `running` entry
 * *becomes* when it is read back from storage, because a window that went away
 * mid-job left no one to say how the job ended. Recording it as `failed` would
 * be inventing a failure and leaving it `running` would be a row that spins for
 * ever, so it says the one true thing — this window stopped watching.
 */
export type ActionStatus = 'running' | 'ok' | 'failed' | 'cancelled' | 'interrupted'

export interface LoggedAction {
  /** Unique within this browser; what {@link endAction} and a repaint key on. */
  readonly id: string
  /** Epoch milliseconds. What the day separators are cut on. */
  readonly at: number
  readonly kind: ActionKind
  /** The one line the entry is read by — a command, or a sentence. */
  readonly line: string
  /**
   * Whether {@link line} is a command a shell would take.
   *
   * `false` for everything that is a record of something the app did rather than
   * something `metacooler-run` can be asked to do — an open, a track, an export.
   * Those lines are copied out as `#` comments, so a day pasted into a file is a
   * script that runs, with the rest of the afternoon around it as context.
   * Every run is `true`: the CLI takes every task in the catalogue
   * (`analysis/cliCommand.ts`).
   */
  readonly shell: boolean
  /**
   * `#` lines that qualify the line itself, always shown and always copied.
   *
   * `cliCommandFor`'s caveats, and nothing else: a command that runs and answers
   * a slightly different question is worse than one that says what it left out,
   * so these are not part of what the output toggle hides.
   *
   * They sit **above a command and below anything else**, which is the same rule
   * read twice: a caveat qualifies a line a reader is about to run, so it comes
   * first; a note on a line that is not a command explains the thing it is
   * about, so it comes after it. Written the other way round, an open with a
   * note would open with a paragraph about a command that was never there.
   */
  readonly notes: readonly string[]
  /** The provenance block — what the output toggle shows and hides. */
  readonly detail: readonly string[]
  readonly status: ActionStatus
  /** Wall clock, once there is one. */
  readonly ms?: number
  /** The failure, in full; a truncated error is a bug report nobody can act on. */
  readonly error?: string
  /** Which map or file this was about, for the column that names it. */
  readonly where?: string
}

/** What a caller hands in. Everything the store can fill in, it fills in. */
export interface ActionDraft {
  kind: ActionKind
  line: string
  shell?: boolean
  notes?: readonly string[]
  detail?: readonly string[]
  status?: ActionStatus
  /**
   * Why it failed, for something that arrives already failed.
   *
   * A run reaches its failure through {@link endAction}, having been recorded
   * while it was still running. This is for the press of Run that never became a
   * job at all — refused for want of a file or a framing — which has no moment
   * between the two to be anything but failed.
   */
  error?: string
  where?: string
}

/** What an outcome adds to an entry already in the list. */
export interface ActionOutcome {
  status: ActionStatus
  ms?: number
  error?: string
  /** A better account of the same run, from the result's own provenance. */
  line?: string
  notes?: readonly string[]
  detail?: readonly string[]
}

const KEY = 'metacooler-viewer:actions'
const VERSION = 1

/**
 * How many lines are kept.
 *
 * A number rather than a byte budget, because the thing a reader wants back is
 * counted in commands. Five hundred is a fortnight of ordinary use and about
 * two hundred kilobytes of the five megabytes `localStorage` allows — enough
 * headroom that this can never be the write that pushes the workspace record
 * out.
 */
const MAX_ENTRIES = 500

/** Past this, a command names a file that has usually moved. */
const MAX_AGE_DAYS = 7

const MAX_AGE_MS = MAX_AGE_DAYS * 24 * 60 * 60 * 1000

/**
 * How long a write waits.
 *
 * Entries change on a job's two edges rather than on its progress, so this is
 * not the ten-hertz problem the runner's own notifier solves — but a batch over
 * a deck of thirty starts and ends sixty times in a few minutes, and each of
 * those would otherwise be a full serialise of five hundred entries. One write
 * per quarter second is under the human threshold for "did that get saved" and
 * two orders of magnitude cheaper.
 */
const WRITE_DEBOUNCE_MS = 250

let entries: LoggedAction[] | null = null
let counter = 0
const listeners = new Set<() => void>()
let timer: ReturnType<typeof setTimeout> | null = null

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string')
}

/**
 * One stored row, checked field by field.
 *
 * Stored state outlives the code that wrote it, so nothing here is trusted: a
 * row from a build that spelled a field differently is dropped rather than
 * painted as `undefined`, which is the rule every other reader of storage in
 * this app follows.
 */
function parseEntry(value: unknown): LoggedAction | null {
  if (typeof value !== 'object' || value === null) return null
  const row = value as Record<string, unknown>
  const { id, at, kind, line, status } = row
  if (typeof id !== 'string' || typeof at !== 'number' || typeof line !== 'string') return null
  if (kind !== 'run' && kind !== 'open' && kind !== 'track' && kind !== 'write') return null
  const known = ['running', 'ok', 'failed', 'cancelled', 'interrupted']
  if (typeof status !== 'string' || !known.includes(status)) return null
  return {
    id,
    at,
    kind,
    line,
    shell: row['shell'] === true,
    notes: isStringArray(row['notes']) ? row['notes'] : [],
    detail: isStringArray(row['detail']) ? row['detail'] : [],
    // A window that went away while this was on the worker; see `ActionStatus`.
    status: status === 'running' ? 'interrupted' : (status as ActionStatus),
    ...(typeof row['ms'] === 'number' ? { ms: row['ms'] } : {}),
    ...(typeof row['error'] === 'string' ? { error: row['error'] } : {}),
    ...(typeof row['where'] === 'string' ? { where: row['where'] } : {}),
  }
}

/** Oldest first, so the list reads down the page the way a terminal does. */
function prune(list: LoggedAction[], now: number): LoggedAction[] {
  const fresh = list.filter((entry) => now - entry.at <= MAX_AGE_MS)
  return fresh.length <= MAX_ENTRIES ? fresh : fresh.slice(fresh.length - MAX_ENTRIES)
}

/** What is on the disk right now, parsed and checked. Never pruned here. */
function readStored(): LoggedAction[] {
  try {
    const raw = window.localStorage.getItem(KEY)
    if (raw === null) return []
    const held = JSON.parse(raw) as unknown
    if (typeof held !== 'object' || held === null) return []
    const record = held as Record<string, unknown>
    if (record['version'] !== VERSION || !Array.isArray(record['entries'])) return []
    const parsed: LoggedAction[] = []
    for (const row of record['entries']) {
      const entry = parseEntry(row)
      if (entry !== null) parsed.push(entry)
    }
    return parsed
  } catch {
    // Unreadable, refused, or written by a build that meant something else by
    // it. An empty log is the honest answer and the app is not worse for it.
    return []
  }
}

/**
 * Two windows' lists, as one.
 *
 * A reader with the app open twice has one afternoon, not two, and each window
 * holds its own copy of the list — so a plain write would be whichever window
 * saved last deleting the other one's morning. Joined by id, **this window's
 * copy winning** where both hold a row: ours is the fresher account of a row we
 * have just amended, and the other window has no reason to hold a row of ours
 * that it did not read from the disk in the first place.
 *
 * Sorted by when things happened rather than by who wrote them, because a
 * console read across two windows is still a day in the order it went.
 */
function mergeWith(stored: readonly LoggedAction[], mine: readonly LoggedAction[]): LoggedAction[] {
  const held = new Map<string, LoggedAction>()
  for (const entry of stored) held.set(entry.id, entry)
  for (const entry of mine) held.set(entry.id, entry)
  const joined = [...held.values()].sort((a, b) => a.at - b.at)
  return prune(joined, Date.now())
}

function load(): LoggedAction[] {
  if (entries !== null) return entries
  entries = prune(readStored(), Date.now())
  return entries
}

function write(options: { merge: boolean } = { merge: true }): void {
  // See the module docstring: the list still fills, and nothing is left behind.
  if (embedded()) return
  if (options.merge) entries = mergeWith(readStored(), entries ?? [])
  try {
    window.localStorage.setItem(
      KEY,
      JSON.stringify({ version: VERSION, entries: entries ?? [] }),
    )
  } catch {
    // A full or refused store loses the record and keeps the window working,
    // which is the right way round: this is a convenience over the thing the
    // reader is actually doing.
  }
}

/**
 * Another window wrote the log.
 *
 * `storage` fires in every document of this origin **except** the one that
 * wrote, so this is only ever news. Merged rather than adopted, for the reason
 * {@link mergeWith} gives — and with one exception, which is the whole of how a
 * **clear** travels: an empty stored list is not a window with nothing to say,
 * it is somebody having pressed the button that means *forget all of this*, and
 * a window that answered by writing its own copy back would be undoing a
 * decision the reader made about the record rather than about a window.
 */
function onStorage(event: StorageEvent): void {
  if (event.key !== KEY) return
  const stored = readStored()
  entries = stored.length === 0 ? [] : mergeWith(stored, entries ?? [])
  for (const listener of listeners) listener()
}

if (typeof window !== 'undefined') window.addEventListener('storage', onStorage)

function schedule(): void {
  if (timer !== null) return
  timer = setTimeout(() => {
    timer = null
    write()
  }, WRITE_DEBOUNCE_MS)
}

function changed(): void {
  schedule()
  for (const listener of listeners) listener()
}

/**
 * Record something that happened, and give back the id it is filed under.
 *
 * An action that has an end — a run — is recorded `running` and finished later
 * through {@link endAction}. One that does not is recorded with its outcome
 * already on it, which is every open, track and export: they have happened by
 * the time anything here is told about them.
 */
export function logAction(draft: ActionDraft): string {
  const list = load()
  counter++
  const id = `${Date.now().toString(36)}-${counter.toString(36)}`
  list.push({
    id,
    at: Date.now(),
    kind: draft.kind,
    line: draft.line,
    shell: draft.shell === true,
    notes: draft.notes ?? [],
    detail: draft.detail ?? [],
    status: draft.status ?? 'ok',
    ...(draft.error === undefined ? {} : { error: draft.error }),
    ...(draft.where === undefined ? {} : { where: draft.where }),
  })
  entries = prune(list, Date.now())
  changed()
  return id
}

/**
 * A recorded action reached its end.
 *
 * The line may be **replaced**, and a run's is: the entry is written when the
 * job is dispatched, from the parameters and the framing it was queued with,
 * and what comes back carries the result's own `Provenance`. Those are two
 * accounts of one run and the second is authoritative, so it wins rather than
 * being appended beside the first — two accounts of one run is how they come to
 * disagree.
 *
 * An id that is no longer in the list is not an error: it has aged out, or been
 * cleared by a reader while its job was still running.
 */
export function endAction(id: string, outcome: ActionOutcome): void {
  const list = load()
  const at = list.findIndex((entry) => entry.id === id)
  if (at < 0) return
  const before = list[at]
  list[at] = {
    ...before,
    status: outcome.status,
    ...(outcome.ms === undefined ? {} : { ms: outcome.ms }),
    ...(outcome.error === undefined ? {} : { error: outcome.error }),
    ...(outcome.line === undefined ? {} : { line: outcome.line }),
    ...(outcome.notes === undefined ? {} : { notes: outcome.notes }),
    ...(outcome.detail === undefined ? {} : { detail: outcome.detail }),
  }
  changed()
}

/** Everything held, oldest first. */
export function actions(): readonly LoggedAction[] {
  return load()
}

/** How many, for the button that says whether there is anything to look at. */
export function actionCount(): number {
  return load().length
}

export function subscribeActions(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/**
 * Empty the log at the reader's request.
 *
 * Written through immediately rather than on the debounce: this is the one
 * change a reader might make and then close the tab, and a clear that had not
 * reached storage yet would come back on the next visit.
 */
export function clearActions(): void {
  entries = []
  if (timer !== null) {
    clearTimeout(timer)
    timer = null
  }
  // Without the merge, which every other write makes: this is the one write that
  // means *forget what is there* rather than *add what I have*, and joining the
  // stored list back in would be the button undoing itself. The empty list is
  // also what tells another window the same thing; see {@link onStorage}.
  write({ merge: false })
  for (const listener of listeners) listener()
}

/**
 * Drop everything, for the "forget everything" sweep.
 *
 * The key goes with the prefix either way; what this adds is the copy in
 * memory, without which the next recorded action would write the whole list
 * back out — the same trap `forgetAllHandles` exists to close.
 */
export function forgetActions(): void {
  clearActions()
  try {
    window.localStorage.removeItem(KEY)
  } catch {
    /* nothing was stored, so nothing has to be removed */
  }
}

/**
 * Forget the copy in memory, leaving what is stored where it is. Tests only.
 *
 * The one thing a running window never does and a **reload** always does, which
 * is what makes it worth a door: a `running` entry becomes `interrupted` on the
 * way back in (see {@link ActionStatus}), and that is a rule no test could reach
 * otherwise without a second page. Exported rather than reached around, so the
 * mutable state in this module has exactly one door and it is a named one — the
 * same arrangement `embed.ts` makes for its memoised mount.
 */
export function resetActions(): void {
  entries = null
  if (timer !== null) {
    clearTimeout(timer)
    timer = null
  }
}

/** `2026-09-11`, in local time — what a day separator is cut on. */
export function dayOf(at: number): string {
  const when = new Date(at)
  const month = String(when.getMonth() + 1).padStart(2, '0')
  const day = String(when.getDate()).padStart(2, '0')
  return `${when.getFullYear()}-${month}-${day}`
}

/** `14:03:57`, in local time — the stamp on a row. */
export function timeOf(at: number): string {
  const when = new Date(at)
  const parts = [when.getHours(), when.getMinutes(), when.getSeconds()]
  return parts.map((part) => String(part).padStart(2, '0')).join(':')
}

/**
 * One entry, as the lines it is copied out as.
 *
 * Here rather than in the panel because there are two callers — a row's own copy
 * button and the whole-log text below — and the order of these four pieces is a
 * rule rather than a layout: the provenance, then a caveat *above* the command
 * it qualifies or a refusal *below* the line it explains, then the failure. Two
 * copies of that drifted the first time it changed.
 */
export function actionLines(entry: LoggedAction, options: { detail: boolean }): string[] {
  const lines: string[] = []
  if (options.detail) lines.push(...entry.detail)
  if (entry.shell) {
    lines.push(...entry.notes, entry.line)
  } else {
    lines.push(`# ${timeOf(entry.at)}  ${entry.line}`, ...entry.notes)
  }
  if (entry.error !== undefined) lines.push(`# failed: ${entry.error}`)
  return lines
}

export interface ActionTextOptions {
  /** Include each entry's detail block — what the console's output toggle asks. */
  detail: boolean
  /** Only this day (`2026-09-11`), or every day when absent. */
  day?: string
}

/**
 * The log as text, ready for a clipboard or a file.
 *
 * A **script**, not a transcript, and the difference is which lines carry a `#`:
 * every command is bare and everything else — the day headings, the opens, the
 * exports, the provenance, a failure's message — is a comment. So a day copied
 * out of this panel and pasted into a file runs, in the order it was run in the
 * first place, with the afternoon around it left in as the context that says
 * what the commands were for.
 */
export function actionsText(options: ActionTextOptions): string {
  const wanted = load().filter((entry) => options.day === undefined || dayOf(entry.at) === options.day)
  const lines: string[] = []
  let day = ''
  for (const entry of wanted) {
    const own = dayOf(entry.at)
    if (own !== day) {
      if (lines.length > 0) lines.push('')
      lines.push(`# ${own}`)
      day = own
    }
    lines.push(...actionLines(entry, { detail: options.detail }))
  }
  return lines.length === 0 ? '' : `${lines.join('\n')}\n`
}
