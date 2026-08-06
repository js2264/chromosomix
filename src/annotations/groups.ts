/**
 * What a group of tracks *is*, for every surface that draws one.
 *
 * A group is two claims bundled together — these tracks belong side by side,
 * and these tracks share a value axis — and both of them are facts about the
 * tracks rather than about the view looking at them. They used to live inside
 * `BrowserView`: the modes were read from one field, written by one card and
 * honoured by one renderer, so a group made in the 1D browser meant nothing at
 * all beside a contact map, and a group set to scale each of its members
 * separately still drew on one shared axis there. The stored value and the
 * picture disagreed, which is the drift §5.8 exists to prevent.
 *
 * So the two modes, the memory they live in, and the two pure computations both
 * surfaces need from them are here, in the layer that already owns the tracks.
 * `render/lane.ts` and `render/tracks.ts` are the same idea one level down: a
 * lane is drawn once, in terms of *along* and *across*, and a group is resolved
 * once, in terms of members and extents.
 */

import { recall, remember } from '../state/UiMemory'
import type { AnnotationEntry } from './types'

/** How a group of tracks shares the picture. */
export type GroupMode = 'stacked' | 'overlay'

/**
 * How a group resolves its value axis.
 *
 * `shared` is what a group is *for* — one pair of limits over the union of what
 * its members show, which is the only way two tracks can be compared by eye —
 * and it is the default. `each` keeps the grouping (the members still move,
 * stack and overlay together) and gives every track its own axis back, for the
 * case where a group is a way of handling several tracks at once rather than a
 * claim that they are measured in the same units.
 */
export type GroupScaling = 'shared' | 'each'

/**
 * How much of its own opacity a track keeps when it shares a lane.
 *
 * Overlaid tracks are translucent by necessity: two opaque areas in one lane
 * means the second hides the first, which is the opposite of what overlaying
 * them was for. One number, here rather than at each renderer, because a lane
 * beside the map and a lane in the browser are the same picture of the same
 * decision.
 */
export const OVERLAY_DIM = 0.65

/**
 * The scopes the two modes are remembered under.
 *
 * Unchanged from when only the browser wrote them, and deliberately so:
 * `SessionConfig` round-trips both by name, so an exported session written by
 * an older build still imports and still means the same thing. Only the reader
 * moved.
 */
const MODE_SCOPE = 'browser:groups'
const SCALING_SCOPE = 'browser:scaling'

/**
 * Every group decision for one open file, remembered across its views.
 *
 * One instance per file rather than one per view: a reader who overlays two
 * strands in the 1D browser and then drops a `.cool` on it should find the two
 * strands still overlaid beside the map, because they are the same two tracks
 * and it was the same decision. The session builds it once and hands the same
 * object to both surfaces.
 *
 * Stored state outlives the code that wrote it, so what comes back out of
 * memory is validated on the way in — a scope holding something that is not a
 * record of the two words this knows is treated as nothing remembered.
 */
export class GroupSettings {
  private modes: Record<string, GroupMode>
  private scalings: Record<string, GroupScaling>
  private readonly listeners = new Set<() => void>()

  constructor(private readonly key: string) {
    this.modes = readRecord<GroupMode>(key, MODE_SCOPE, (value) =>
      value === 'stacked' || value === 'overlay',
    )
    this.scalings = readRecord<GroupScaling>(key, SCALING_SCOPE, (value) =>
      value === 'shared' || value === 'each',
    )
  }

  /** Tell every mounted surface a mode changed; returns the unsubscribe. */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  modeOf(group: string): GroupMode {
    return this.modes[group] ?? 'stacked'
  }

  setMode(group: string, mode: GroupMode): void {
    this.modes = { ...this.modes, [group]: mode }
    remember(this.key, MODE_SCOPE, this.modes)
    this.changed()
  }

  scalingOf(group: string): GroupScaling {
    return this.scalings[group] ?? 'shared'
  }

  setScaling(group: string, scaling: GroupScaling): void {
    this.scalings = { ...this.scalings, [group]: scaling }
    remember(this.key, SCALING_SCOPE, this.scalings)
    this.changed()
  }

  private changed(): void {
    for (const listener of this.listeners) listener()
  }
}

function readRecord<T extends string>(
  key: string,
  scope: string,
  ok: (value: string) => boolean,
): Record<string, T> {
  const stored = recall<unknown>(key, scope)
  if (typeof stored !== 'object' || stored === null) return {}
  const out: Record<string, T> = {}
  for (const [group, value] of Object.entries(stored as Record<string, unknown>)) {
    if (typeof value === 'string' && ok(value)) out[group] = value as T
  }
  return out
}

/** One slot in a stack: the lane's own track, and whatever shares it. */
export interface StackSlot<T> {
  /** The entry the lane belongs to — its size, and the row a drag moves. */
  host: T
  /** Tracks drawn *into* this lane, when its group is in overlay mode. */
  overlaid: T[]
  acrossFrom: number
  thickness: number
}

/**
 * Turn a list of tracks into the lanes that will be drawn for them.
 *
 * The one place a group in overlay mode collapses: the first member met claims
 * a slot, every later member of the same group joins it, and everything else
 * gets a lane of its own. Which means the *order* on screen is the order in the
 * list, and a group drawn in one lane occupies exactly the slot its first
 * member would have had — so a reader who overlays a group does not find it
 * somewhere else in the stack.
 *
 * Pure arithmetic over sizes, with no idea which edge it is laying out. The
 * caller turns `acrossFrom` and `thickness` into a {@link LaneFrame}, which is
 * what knows whether across is down the page or across it.
 */
export function planStack<T>(
  entries: readonly T[],
  options: {
    groupOf(entry: T): string
    modeOf(group: string): GroupMode
    sizeOf(entry: T): number
    gap: number
    /** Where the first lane starts; the ruler's height in the browser, 0 beside a map. */
    from?: number
    minimum: number
  },
): Array<StackSlot<T>> {
  const slots: Array<StackSlot<T>> = []
  const claimed = new Map<string, StackSlot<T>>()
  let across = options.from ?? 0
  for (const entry of entries) {
    const group = options.groupOf(entry)
    const overlaid = group !== '' && options.modeOf(group) === 'overlay'
    const host = overlaid ? claimed.get(group) : undefined
    if (host !== undefined) {
      host.overlaid.push(entry)
      continue
    }
    const thickness = Math.max(options.minimum, Math.round(options.sizeOf(entry)))
    const slot: StackSlot<T> = { host: entry, overlaid: [], acrossFrom: across, thickness }
    slots.push(slot)
    if (overlaid) claimed.set(group, slot)
    across += thickness + options.gap
  }
  return slots
}

/** What one track contributes to its group's axis: which group, and its extent. */
export interface GroupContribution {
  group: string
  extent: { min: number; max: number } | null
}

/**
 * One pair of limits per group, over the union of what its members show.
 *
 * A group set to scale each of its members separately contributes nothing, and
 * that is the whole of what the setting does: with no entry in this map every
 * lookup falls back to the track's own extent, which is what an ungrouped track
 * uses. So the two scalings need one code path and not two, and `each` cannot
 * fall out of step with `shared` by being implemented somewhere else.
 *
 * Fed from *every* lane the surface draws, both edges included beside a map: a
 * group is a claim that these tracks are comparable, and comparing them on two
 * different scales because they happen to be on different edges would defeat
 * it.
 */
export function resolveGroupExtents(
  contributions: Iterable<GroupContribution>,
  scalingOf: (group: string) => GroupScaling,
): Map<string, { min: number; max: number }> {
  const groups = new Map<string, { min: number; max: number }>()
  for (const { group, extent } of contributions) {
    if (group === '' || extent === null || scalingOf(group) === 'each') continue
    const seen = groups.get(group)
    groups.set(
      group,
      seen === undefined
        ? { ...extent }
        : { min: Math.min(seen.min, extent.min), max: Math.max(seen.max, extent.max) },
    )
  }
  return groups
}

/**
 * The extent one track's axis is resolved against: its group's, or its own.
 *
 * Three lines, written at four call sites before this existed, and the kind of
 * three lines where the fourth copy is the one that forgets the fallback.
 */
export function extentFor(
  entry: Pick<AnnotationEntry, 'style'>,
  own: { min: number; max: number } | null,
  groups: Map<string, { min: number; max: number }>,
): { min: number; max: number } | null {
  const group = entry.style.group
  return group === '' ? own : (groups.get(group) ?? own)
}
