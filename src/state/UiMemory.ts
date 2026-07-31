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

const PREFIX = 'metacooler-viewer:ui:'

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
