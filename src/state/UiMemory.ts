/**
 * Per-file memory of the things a user typed but the URL does not carry.
 *
 * The view state (§5.5) is deliberately the *shareable* state: a URL names a
 * genome, a region, a colour scale. Table filters are not in it, and should not
 * be — a link that silently carries "only rows where completeness > 90" would
 * mislead whoever opens it.
 *
 * But not being in the URL is not a reason to forget them. Filtering a 4,000-MAG
 * table, opening a genome, and coming back to an unfiltered table means doing
 * the work twice, and the second time you are retyping rather than thinking.
 *
 * So filters live here instead: keyed by file URI and by a caller-chosen scope,
 * held for the session, restored on the way back. `sessionStorage` rather than
 * `localStorage` deliberately — a filter is a train of thought, not a
 * preference, and it should not still be applied next week. It also degrades to
 * an in-memory map when storage is unavailable (Safari private mode, a strict
 * embedding), because losing a filter must never break a view.
 */

import { splitUri } from '../ui/labels'

const PREFIX = 'metacooler-viewer:ui:'

/**
 * The key one session's memory of one *file* hangs on.
 *
 * Two facts, and both of them are decisions.
 *
 * The **session id**, because two tabs on the same file are two independent
 * workspaces: keyed on the URI alone the second would adopt the first's tracks
 * and filters, which is exactly what tabs exist to prevent.
 *
 * The **file, not the entry inside it** — the path before `::`. An `.mcool` at
 * 1 kb and the same `.mcool` at 5 kb are one file, which is the definition
 * `Session.reopeningSameFile` already uses and the reason a change of resolution
 * carries every field of the view state across (`Session.carryAcrossEntries`):
 * names are names and coordinates are base pairs. Everything stored under this
 * key is the same kind of fact — a hand-drawn mark is a contig and a base pair
 * (§8.1), a ticked sequence is a name, a group is a claim about tracks, a table's
 * filter is a phrase about rows — and none of them means anything different at
 * another bin size.
 *
 * With the entry in the key all of it was *lost* on a resolution switch, and
 * silently: the previous level's marks stayed in storage under its own key, so
 * they came back if the reader switched back and stayed invisible if they did
 * not. Tracks were the exception, and only because they are carried live across
 * the reopen — which is why this surfaced as "my annotations are gone" rather
 * than as everything at once.
 */
export function fileMemoryKey(sessionId: string, uri: string): string {
  return `${sessionId}|${splitUri(uri).path}`
}

/** Storage that cannot throw. Falls back to a module-level map. */
const memory = new Map<string, string>()

function read(key: string): string | null {
  try {
    return window.sessionStorage.getItem(key)
  } catch {
    return memory.get(key) ?? null
  }
}

function write(key: string, value: string): void {
  try {
    window.sessionStorage.setItem(key, value)
  } catch {
    memory.set(key, value)
  }
}

/**
 * Remember `value` for `scope` within `uri`.
 *
 * `scope` separates independent widgets on the same file — the genomes table
 * and the contigs table each keep their own filters.
 */
export function remember(uri: string, scope: string, value: unknown): void {
  try {
    write(`${PREFIX}${uri}:${scope}`, JSON.stringify(value))
  } catch {
    /* an unserialisable value is a caller bug, not a reason to break a view */
  }
}

/**
 * Recall what {@link remember} stored, or `null`.
 *
 * The caller validates the shape: stored state outlives the code that wrote it
 * (a reload picks up a new build against an old session), so a recalled value
 * is untrusted input, exactly like the URL hash.
 */
export function recall<T>(uri: string, scope: string): T | null {
  const raw = read(`${PREFIX}${uri}:${scope}`)
  if (raw === null) return null
  try {
    return JSON.parse(raw) as T
  } catch {
    return null
  }
}
