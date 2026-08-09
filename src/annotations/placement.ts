/**
 * One list of tracks, drawn in many places: what a track *is*, kept apart from
 * where it is drawn.
 *
 * A deck holds N maps and a track can be on any edge of any of them, which
 * breaks the shape the annotation model has had until now — one entry, one
 * `Placement` of four booleans, one map. The obvious repairs are both wrong, and
 * saying why is most of the design:
 *
 * - **One store per map**, a full copy of the track for each: the file is parsed
 *   once per map, "the list of tracks I have imported" stops existing, and
 *   recolouring a track is N edits that a reader has to keep in step by hand.
 * - **One store, one style, and only a set of maps it appears on**: nothing can
 *   ever differ per map — and the one thing that genuinely must is the value
 *   range, because two libraries at different depth do not share a ceiling. That
 *   is the same argument the deck already settles for the colour scale, where
 *   the transform and the ramp are shared and the *clip* is per panel (§16.2).
 *
 * So: a **track** is the import — the file, the data, the label, and the style
 * that is true of it wherever it appears. A **lane** is one placement of that
 * track: a map, an edge, and a sparse patch over the track's style. A track with
 * no lanes is imported and undrawn, which is a real state and the one that makes
 * "take it off every map" not mean "throw it away".
 *
 * `resolveStyle` is the whole of the cascade, and there is deliberately no more
 * to it than one spread: a lane holds only the fields somebody set *on that
 * lane*, so everything else keeps following the track for good. That is what
 * makes {@link propagate} worth having — lanes created with no patch are not
 * merely equal to the track today, they cannot drift from it tomorrow.
 *
 * **What may be overridden is deliberately almost nothing** ({@link
 * LANE_OVERRIDES}). Every field a lane can differ on is a field the maps can no
 * longer be compared on, so the list is the two that have a reason:
 *
 * - `limits`, because a ceiling is a number about one library's depth;
 * - `flip`, because which way a lane grows is a fact about the *edge* it is on,
 *   and the edge is the lane's.
 *
 * Height is **not** on the list, and that is the load-bearing omission: a deck
 * reserves the same lane room on every panel so the maps line up to the pixel
 * (§16.8), and a track two rows tall on one map and three on another would put
 * every picture beside it at a different height.
 */

import { placementOn, type AnnotationStyle, type LaneEdge, type Placement } from './types'

/**
 * The map a lane is on. Opaque here — the session's own map answers to
 * {@link LEAD_MAP} and a companion to its slot id — because nothing in this
 * module has any business knowing what a panel is.
 */
export type MapId = string

/** The session's own map, which is cell 0 of a deck and the whole of a session without one. */
export const LEAD_MAP: MapId = 'lead'

/**
 * The style fields a single placement may differ on.
 *
 * Short on purpose. See the module head: each entry is something two maps can
 * then disagree about, and a deck exists so that they do not.
 */
export const LANE_OVERRIDES = ['limits', 'flip'] as const

export type LaneOverride = (typeof LANE_OVERRIDES)[number]

/**
 * One track's presence on one map: which of its four edges, and what it does
 * differently there.
 *
 * One lane per *map*, carrying a `Placement`, rather than one per edge. Two
 * reasons, and the second is the one that decided it:
 *
 * - it is the shape the model already had — an entry has always held four
 *   booleans saying which edges it is drawn on, and a deck makes that four
 *   booleans *per map* rather than something new;
 * - it keeps a track's entry unique within a map. The lanes are drawn from a
 *   list of entries keyed by id, and a track on two edges of one map splitting
 *   into two entries with one id would break every hit box, every restyle and
 *   every reorder that resolves a lane by identity.
 */
export interface Lane {
  /** The track's id — an `AnnotationEntry.id`. */
  track: string
  map: MapId
  placement: Placement
  /**
   * Only the fields set *on this lane*. Absent or empty is the common case and
   * the good one: a lane with no patch follows its track for good.
   */
  style?: Partial<Pick<AnnotationStyle, LaneOverride>>
}

/**
 * The style one lane is drawn with: the track's, with its own patch over it.
 *
 * One spread, and it is the entire cascade. Written as a function rather than
 * inlined at the four call sites because the *order* is the rule — the lane
 * wins, and a reader who writes the spread the other way round gets a track
 * whose defaults silently overwrite what somebody set on a map.
 */
export function resolveStyle(track: AnnotationStyle, lane: Pick<Lane, 'style'>): AnnotationStyle {
  return lane.style === undefined ? track : { ...track, ...lane.style }
}

/** Whether a lane says anything of its own about a field. */
export function isOverridden(lane: Pick<Lane, 'style'>, field: LaneOverride): boolean {
  return lane.style !== undefined && lane.style[field] !== undefined
}

/**
 * Hand a field back to the track.
 *
 * The patch is dropped entirely once its last field goes, so "no override" has
 * one representation rather than two — an absent patch and an empty one would
 * otherwise compare unequal in a store that reconciles by structure.
 */
export function clearOverride(lane: Lane, field: LaneOverride): Lane {
  if (!isOverridden(lane, field)) return lane
  const { [field]: _gone, ...rest } = lane.style ?? {}
  const { style: _old, ...bare } = lane
  return Object.keys(rest).length === 0 ? bare : { ...bare, style: rest }
}

/** The lanes of one map, in the order they are stacked. */
export function lanesOn(lanes: readonly Lane[], map: MapId): Lane[] {
  return lanes.filter((lane) => lane.map === map)
}

/** The one lane a track has on a map, if it is drawn there at all. */
export function laneOf(lanes: readonly Lane[], track: string, map: MapId): Lane | undefined {
  return lanes.find((lane) => lane.track === track && lane.map === map)
}

/** Every map a track is currently drawn on, in the order its lanes were made. */
export function mapsOf(lanes: readonly Lane[], track: string): MapId[] {
  const seen: MapId[] = []
  for (const lane of lanes) {
    if (lane.track !== track || seen.includes(lane.map)) continue
    seen.push(lane.map)
  }
  return seen
}

/** `true` when a track is drawn on a map at all. */
export function isPlaced(lanes: readonly Lane[], track: string, map: MapId): boolean {
  return laneOf(lanes, track, map) !== undefined
}

/**
 * Whether a track exists *only* for a set of maps that are about to go.
 *
 * What "loaded for the deck" means, stated once. A bigWig dropped on a
 * companion's edge is an import into the session's one track list, so closing
 * the maps it was drawn on leaves it loaded, invisible, and holding a row in the
 * Tracks card that says it is drawn nowhere. A track that is *also* on another
 * map is a different thing — it is being read against a picture that is staying
 * — and only loses the lanes of the maps that leave.
 *
 * A track on **no** map is not "only on these": "imported and undrawn" is a
 * state this model has on purpose (see the module head), and it is what a reader
 * has left behind when they take a track off every map and keep it. Sweeping
 * those up here would make closing a deck delete something it never touched.
 */
export function onlyOn(
  lanes: readonly Lane[],
  track: string,
  maps: ReadonlySet<MapId>,
): boolean {
  const drawn = mapsOf(lanes, track)
  return drawn.length > 0 && drawn.every((map) => maps.has(map))
}

/**
 * Draw a track on one edge of one map, if it is not there already.
 *
 * Appended, so a new lane joins the foot of the stack it lands in — the same
 * rule a newly imported track has always followed, and the one that never moves
 * a lane a reader has already positioned.
 */
export function place(
  lanes: readonly Lane[],
  track: string,
  map: MapId,
  placement: Placement,
): Lane[] {
  const held = laneOf(lanes, track, map)
  if (held === undefined) return [...lanes, { track, map, placement }]
  // Already here: the edges are replaced and the patch is kept. Moving a track
  // from one edge to another must not throw away the range somebody set on it.
  return lanes.map((lane) => (lane === held ? { ...lane, placement } : lane))
}

/**
 * Take a track off one edge of one map, or off that map entirely.
 *
 * The track itself is untouched: it stays in the list, with its style and its
 * data, ready to be put back without being read again.
 */
export function unplace(lanes: readonly Lane[], track: string, map: MapId): Lane[] {
  return lanes.filter((lane) => lane.track !== track || lane.map !== map)
}

/**
 * Put a track on every map, at the same edges it is already on.
 *
 * The gesture a deck is for: one track, the same place on each picture, so a
 * feature can be read straight across the row. The new lanes carry **no patch**,
 * which is the point — they are not a copy of the track's current look but a
 * promise to keep following it.
 *
 * Where the track is on no map yet, `fallback` says where to put it, so the
 * gesture also serves "I have just imported this, show it everywhere".
 */
export function propagate(
  lanes: readonly Lane[],
  track: string,
  maps: readonly MapId[],
  fallback: LaneEdge = 'bottom',
): Lane[] {
  const first = lanes.find((lane) => lane.track === track)
  const wanted = first?.placement ?? placementOn(fallback)
  let next = [...lanes]
  for (const map of maps) {
    // Left exactly as it is where the track is already on that map — a
    // propagate must not silently move a lane somebody positioned, nor drop the
    // range they set on it.
    if (!isPlaced(next, track, map)) next = place(next, track, map, wanted)
  }
  return next
}

/**
 * Take a track off every map at once, keeping the import.
 *
 * The counterpart to {@link propagate}, and the reason a track and its lanes are
 * different things: this leaves something in the list to put back.
 */
export function withdraw(lanes: readonly Lane[], track: string): Lane[] {
  return lanes.filter((lane) => lane.track !== track)
}

/**
 * Drop every lane of tracks or maps that are gone.
 *
 * Reconciled against the truth rather than driven by removal events, for
 * `SampleCache.prune`'s reason: an event that is not sent leaks a lane for as
 * long as the session is open, and doing it once per render cannot go stale.
 */
export function pruneLanes(
  lanes: readonly Lane[],
  tracks: ReadonlySet<string>,
  maps: ReadonlySet<MapId>,
): Lane[] {
  return lanes.filter((lane) => tracks.has(lane.track) && maps.has(lane.map))
}

/**
 * Move a lane within the stack it is in.
 *
 * Resolved by *identity* rather than by index into the whole list, for the
 * reason `AnnotationStore.moveTo` gives: a position in what is on screen is not
 * a position in the list behind it, and one lane on another edge is enough to
 * make a list-local index land a slot early.
 */
export function reorderLane(lanes: readonly Lane[], lane: Lane, to: number): Lane[] {
  const stack = lanesOn(lanes, lane.map)
  const from = stack.indexOf(lane)
  if (from < 0) return [...lanes]
  const target = Math.max(0, Math.min(stack.length - 1, Math.trunc(to)))
  if (target === from) return [...lanes]
  const ordered = [...stack]
  ordered.splice(target, 0, ...ordered.splice(from, 1))
  // Written back into the slots the stack occupied, so lanes of other edges and
  // other maps keep the absolute positions they had.
  const slots = lanes.flatMap((held, index) => (stack.includes(held) ? [index] : []))
  const next = [...lanes]
  slots.forEach((slot, index) => {
    next[slot] = ordered[index]
  })
  return next
}
