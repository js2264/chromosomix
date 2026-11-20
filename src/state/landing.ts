/**
 * The rung a ladder is opened at when its address names none, kept by file, so
 * the address bar can leave it out — and read an address without it back as the
 * map already open (§3.4, §9).
 *
 * An `.mcool` addressed at its root is opened at its landing rung, a third of
 * the way up from the finest (`landingRung`), and the session's address then
 * names it: `file.mcool::resolutions/25000`. That entry is where the file was
 * opened — the grid every window is counted in, the default of an analysis —
 * and not the resolution on screen, which the zoom or a pick decides (§2); in
 * the link it read as one, beside a map drawn at 500 kb. So a link carries the
 * file alone where it is open at its landing rung, which is what the file alone
 * opens at anyway, and names a rung only where it was opened at another — an
 * older link's `::1000`, honoured as it always was.
 *
 * Kept by path, the part before `::`, as the session's own address spells it,
 * and only for files this window has opened: a link to a file nobody here has
 * opened is written and read exactly as it is.
 */

import type { ViewState } from '../types'
import { splitUri } from '../ui/labels'

/** The address each laddered file lands on, by its path. */
const landed = new Map<string, string>()

/** Remember the address a file lands on: its path, `::`, and the landing entry. */
export function noteLanding(entryUri: string): void {
  const { path, group } = splitUri(entryUri)
  if (group === '/') return
  landed.set(path, entryUri)
}

/** Whether two addresses name the same entry of the same file, however the group is spelled. */
function sameEntry(a: string, b: string): boolean {
  const one = splitUri(a)
  const two = splitUri(b)
  return one.path === two.path && one.group === two.group
}

/** An address as a link writes it: the file alone where it is open at its landing rung. */
export function linkUri(uri: string): string {
  const { path, group } = splitUri(uri)
  if (group === '/') return uri
  const entry = landed.get(path)
  return entry !== undefined && sameEntry(entry, uri) ? path : uri
}

/**
 * An address as a link reads it: a file named alone is the entry it landed on
 * here — spelled as `current` spells it where that is this file open there, so
 * a step back to it is a step within the file rather than an open of another.
 */
export function openedUri(uri: string, current?: string): string {
  const { path, group } = splitUri(uri)
  if (group !== '/') return uri
  if (current !== undefined && splitUri(current).path === path && linkUri(current) === path) return current
  return landed.get(path) ?? uri
}

/** A view state as the address bar writes it ({@link linkUri}). */
export function linkState(state: ViewState): ViewState {
  const uri = linkUri(state.uri)
  return uri === state.uri ? state : { ...state, uri }
}

/** A view state as the address bar reads it ({@link openedUri}). */
export function openedState(state: ViewState | null, current?: string): ViewState | null {
  if (state === null) return null
  const uri = openedUri(state.uri, current)
  return uri === state.uri ? state : { ...state, uri }
}

/** Forget every landing: for a test. */
export function forgetLandings(): void {
  landed.clear()
}
