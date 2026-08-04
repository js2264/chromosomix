/**
 * What the tab strip remembers between visits.
 *
 * `sessionStorage`, like everything else the app remembers that is not a
 * preference (`state/UiMemory.ts`, spec §8.6): a set of open files is a train of
 * thought and it belongs to the window it was opened in, not to the browser
 * profile. Closing the tab is meant to end it.
 *
 * What is stored is a **serialised view state per session, and which one was
 * active** — nothing else. That is deliberately the same string the address bar
 * carries, so a remembered tab and a shared link are the same kind of thing and
 * there is one parser for both. It also bounds what a restore can go wrong
 * about: a stored entry is either a legal view state or it is dropped.
 *
 * A restored tab is *named*, not opened. A remote file re-opens itself when the
 * tab is clicked; a local one cannot — no browser re-reads a dropped file
 * without a fresh gesture — and comes back as the picker with the link's own
 * explanation, which is the behaviour a pasted link to a local file has always
 * had.
 */

const KEY = 'metacooler-viewer:sessions'

export interface SessionSnapshot {
  id: string
  /** The session's view state, serialised exactly as the URL hash carries it. */
  hash: string
}

export interface StoredSessions {
  sessions: SessionSnapshot[]
  /** The id that was on screen, or `null` when nothing was. */
  active: string | null
}

const EMPTY: StoredSessions = { sessions: [], active: null }

export function writeSessions(value: StoredSessions): void {
  try {
    window.sessionStorage.setItem(KEY, JSON.stringify(value))
  } catch {
    /* a browser that refuses storage still runs; it just starts fresh */
  }
}

/**
 * What a previous visit left, validated.
 *
 * Untrusted input, exactly like the URL hash: stored state outlives the build
 * that wrote it, so every field is checked and anything that fails is dropped
 * rather than repaired into a tab pointing at nothing.
 */
export function readSessions(): StoredSessions {
  let raw: unknown
  try {
    const text = window.sessionStorage.getItem(KEY)
    if (text === null) return EMPTY
    raw = JSON.parse(text)
  } catch {
    return EMPTY
  }
  if (typeof raw !== 'object' || raw === null) return EMPTY
  const record = raw as Record<string, unknown>
  const list = Array.isArray(record['sessions']) ? record['sessions'] : []
  const sessions: SessionSnapshot[] = []
  const seen = new Set<string>()
  for (const entry of list) {
    if (typeof entry !== 'object' || entry === null) continue
    const row = entry as Record<string, unknown>
    const id = row['id']
    const hash = row['hash']
    if (typeof id !== 'string' || typeof hash !== 'string' || id === '' || hash === '') continue
    // Two tabs with one id would share every scope keyed on it — their tracks,
    // their filters, their marks. A duplicate is corruption, not a session.
    if (seen.has(id)) continue
    seen.add(id)
    sessions.push({ id, hash })
  }
  const active = record['active']
  return {
    sessions,
    active: typeof active === 'string' && seen.has(active) ? active : null,
  }
}

/**
 * The number a fresh session id must start above, so a restored `s3` and a new
 * one cannot collide.
 *
 * Ids are minted per page load and the counter starts at 1, so restoring three
 * tabs and opening a fourth would otherwise hand out `s1` twice.
 */
export function highestId(sessions: readonly SessionSnapshot[]): number {
  let high = 0
  for (const session of sessions) {
    const match = /^s(\d+)$/.exec(session.id)
    if (match !== null) high = Math.max(high, Number(match[1]))
  }
  return high
}
