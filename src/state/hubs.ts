/**
 * The hubs this browser has been told to keep, beside the ones it ships with.
 *
 * A hub reached by URL is exactly the same kind of thing as a bucket scope: a
 * place the reader connected to by pasting an address, which they will want
 * again next week and should not have to find twice. So it is kept the same way
 * — one `localStorage` key under the app's prefix, so the stored-data screen can
 * name it and *forget everything* sweeps it without knowing it exists (§24.2,
 * `state/stored.ts`) — and it is kept *only* that way: a row is a label and a
 * URL, never a copy of the catalogue. A cached hub would be a second answer
 * about what a bucket holds, stale from the moment it was written, and the
 * catalogues this format is for are megabytes.
 *
 * **Nothing here fetches anything.** A stored row becomes a `HubRef`, which is
 * a pointer; `ui/HubTable.ts` turns one into a request when a reader selects it
 * (§24.2: nothing on load). That separation is why this module is fifty lines
 * and has no idea what a hub contains.
 *
 * The subscription exists because two pickers and a table can be looking at the
 * list at once — the landing page, the Open-a-file dialog, and whichever of them
 * the reader just pressed *remember* in — and a list that refreshed only on
 * reload would show a hub in one of them and not the other.
 */

import type { HubRef } from './hub'

export type { HubRef } from './hub'

const KEY = 'metacooler-viewer:hubs'

/** One remembered hub: what to call it, and where it is. */
export interface HubRow {
  /** `hub:<n>`, minted here and stable across edits. */
  id: string
  /** What the reader calls it — the hub's own `name` when it had one. */
  label: string
  url: string
}

const listeners = new Set<() => void>()

/** Storage that cannot throw — `s3/credentials.ts`'s reasoning, and its shape. */
function readRaw(): string | null {
  try {
    return window.localStorage.getItem(KEY)
  } catch {
    return null
  }
}

function write(rows: readonly HubRow[]): void {
  try {
    window.localStorage.setItem(KEY, JSON.stringify(rows))
  } catch {
    /* a browser refusing storage still runs; the hub just is not kept */
  }
  for (const listener of listeners) listener()
}

/**
 * Every remembered hub, validated.
 *
 * Untrusted input like every other stored value in this app: a row is dropped
 * rather than repaired, because the repair for a missing URL is a menu entry
 * that fails when it is pressed. `http(s)` only, and the same check `?hub=`
 * makes for the same reason — the value is about to be handed to `fetch`.
 */
export function readHubRows(): HubRow[] {
  const raw = readRaw()
  if (raw === null) return []
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return []
  }
  if (!Array.isArray(parsed)) return []
  const out: HubRow[] = []
  const seen = new Set<string>()
  for (const entry of parsed) {
    if (typeof entry !== 'object' || entry === null) continue
    const row = entry as Record<string, unknown>
    const id = typeof row['id'] === 'string' ? row['id'] : ''
    const url = typeof row['url'] === 'string' ? row['url'] : ''
    if (id === '' || url === '' || seen.has(id) || !/^https?:\/\//i.test(url)) continue
    seen.add(id)
    const label = typeof row['label'] === 'string' && row['label'] !== '' ? row['label'] : url
    out.push({ id, label, url })
  }
  return out
}

/**
 * Remember a hub, or rename one already remembered.
 *
 * Keyed on the **URL** rather than on a minted id, which is what makes pressing
 * *remember* twice — on the landing page and then again from a `?hub=` link —
 * one row rather than two identical ones. The label of the later press wins,
 * because it is the one the reader has just seen.
 *
 * Answers with the stored row so the caller can put it straight into a
 * `HubRef` without re-reading the list to find the id it was given.
 */
export function addHubRow(row: { label: string; url: string }): HubRow {
  const rows = readHubRows()
  const found = rows.findIndex((held) => held.url === row.url)
  const label = row.label === '' ? row.url : row.label
  if (found >= 0) {
    const updated: HubRow = { ...rows[found], label }
    rows[found] = updated
    write(rows)
    return updated
  }
  // The highest `hub:<n>` in use plus one, rather than the list's length: rows
  // are removed, and a length-based id would hand a new hub the id of one the
  // reader had just forgotten — which is a stale `?hub=` bookmark pointing at
  // somebody else's shelf.
  let next = 1
  for (const held of rows) {
    const number = /^hub:(\d+)$/.exec(held.id)
    if (number !== null) next = Math.max(next, Number(number[1]) + 1)
  }
  const added: HubRow = { id: `hub:${next}`, label, url: row.url }
  rows.push(added)
  write(rows)
  return added
}

/** Forget one. Unknown ids are not an error — the row may be gone already. */
export function removeHubRow(id: string): void {
  const rows = readHubRows()
  const kept = rows.filter((row) => row.id !== id)
  if (kept.length === rows.length) return
  write(kept)
}

/** Hear about hubs being remembered or forgotten. Returns the unsubscribe. */
export function subscribeHubs(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/**
 * The remembered hubs as references, ready to be listed after the built-ins.
 *
 * Its own function rather than a `map` at each call site, because there are
 * three of them and the `builtin: false` is the load-bearing field: it is what
 * makes the table offer *forget* on these rows and not on the shipped ones, and
 * what keeps a 404 on a reader's own hub from being reported as "the Hubs
 * workflow has not run" (§24.2).
 */
export function rememberedHubs(): HubRef[] {
  return readHubRows().map((row) => ({
    id: row.id,
    label: row.label,
    url: row.url,
    builtin: false,
  }))
}
