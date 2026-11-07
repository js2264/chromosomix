/**
 * What an open of a remote map read, kept for the next open of it (§6.1, §12).
 *
 * Opening a map over the network is a walk: every read names the place of the
 * next, and each is a request the next waits for. The places do not move while
 * the file does not, so what one open read — its *read plan* — is written down
 * by the reader (`sources/RemoteRangeSource.ts`, `recorded`) and handed to the
 * next open of the same map, which fetches it side by side before the walk
 * starts and then walks out of the cache. Two halves: the open's own walk, keyed
 * by the map's address, and the first view's, keyed by that and the window it
 * read — a view plan is only fetched for an open that goes to the same window.
 *
 * Kept in `localStorage` rather than the IndexedDB the workspace lives in: a
 * plan is a few hundred bytes of numbers, read once on an open, and a store of
 * its own there would be a version bump that blocks the database for a page
 * while an older tab holds it open. The size of the file is the plan's check:
 * a plan made on a file of any other size is not used. The forty maps opened
 * most recently are kept, and four windows of each.
 */

import type { ReadPlan } from '../sources/RemoteRangeSource'
import type { ReadPlans } from '../worker/protocol'

const KEY = 'chromosomix:read-plans'

/** Maps whose plans are kept, the least recently opened dropped first. */
const MAX_MAPS = 40

/** Windows kept per map, the least recently read dropped first. */
const MAX_VIEWS = 4

/** One map's plans, as stored. */
export interface StoredPlans {
  size: number
  open: Array<[number, number]>
  /** The first view's walk, by the window it read. */
  views: Record<string, Array<[number, number]>>
  /** When it was last opened. The maps are kept in the order they were. */
  at: number
}

type Stored = Record<string, StoredPlans>

function readAll(): Stored {
  try {
    const raw = globalThis.localStorage?.getItem(KEY)
    if (raw === null || raw === undefined) return {}
    const parsed: unknown = JSON.parse(raw)
    return parsed !== null && typeof parsed === 'object' ? (parsed as Stored) : {}
  } catch {
    return {}
  }
}

function writeAll(stored: Stored): void {
  try {
    globalThis.localStorage?.setItem(KEY, JSON.stringify(stored))
  } catch {
    // A browser that refuses storage still opens maps, one walk at a time.
  }
}

/** `true` for a list of `[start, end)` pairs this module could have written. */
function isRanges(value: unknown): value is Array<[number, number]> {
  return (
    Array.isArray(value) &&
    value.every(
      (pair) =>
        Array.isArray(pair) &&
        pair.length === 2 &&
        Number.isSafeInteger(pair[0]) &&
        Number.isSafeInteger(pair[1]) &&
        pair[0] >= 0 &&
        pair[1] > pair[0],
    )
  )
}

/** Ranges from several plans, as one ascending, disjoint list. */
export function mergeRanges(...lists: ReadonlyArray<ReadonlyArray<readonly [number, number]>>): Array<[number, number]> {
  const all = lists.flat().map(([start, end]) => [start, end] as [number, number])
  all.sort((a, b) => a[0] - b[0])
  const merged: Array<[number, number]> = []
  for (const [start, end] of all) {
    const held = merged[merged.length - 1]
    if (held !== undefined && start <= held[1]) held[1] = Math.max(held[1], end)
    else merged.push([start, end])
  }
  return merged
}

/**
 * The plan for an open of `uri` that goes to `region` — the open's walk, and the
 * view's where one was kept for that window — from `stored`, or `null`.
 */
export function planOf(stored: StoredPlans | undefined, region: string | undefined): ReadPlan | null {
  if (stored === undefined || !Number.isSafeInteger(stored.size) || !isRanges(stored.open)) return null
  const view = region === undefined ? undefined : stored.views?.[region]
  const ranges = mergeRanges(stored.open, isRanges(view) ? view : [])
  return ranges.length === 0 ? null : { size: stored.size, ranges }
}

/** What was kept for an open of `uri` going to `region`, or `null`. */
export function planFor(uri: string, region: string | undefined): ReadPlan | null {
  return planOf(readAll()[uri], region)
}

/**
 * Keep what an open of `uri` read: its walk, and — where it went to a window —
 * that window's. A plan of nothing is not kept, and neither is one whose halves
 * disagree about the file's size.
 */
export function rememberPlans(uri: string, region: string | undefined, plans: ReadPlans): void {
  const open = plans.open
  if (open === null || open.ranges.length === 0) return
  const stored = readAll()
  const held = stored[uri]
  const views: Record<string, Array<[number, number]>> =
    held !== undefined && held.size === open.size && held.views !== null && typeof held.views === 'object' ? { ...held.views } : {}
  if (region !== undefined && plans.view !== null && plans.view.size === open.size && plans.view.ranges.length > 0) {
    delete views[region]
    views[region] = plans.view.ranges
    const names = Object.keys(views)
    for (const name of names.slice(0, Math.max(0, names.length - MAX_VIEWS))) delete views[name]
  }
  // Last in, by key order, which a JSON round trip keeps: the oldest go first.
  delete stored[uri]
  stored[uri] = { size: open.size, open: open.ranges, views, at: Date.now() }
  writeAll(Object.fromEntries(Object.entries(stored).slice(-MAX_MAPS)))
}
