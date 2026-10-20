/**
 * A called set, as **one row** drawn on one of two surfaces (§18.7).
 *
 * A task that calls intervals — peaks, boundaries, domains, A/B segments,
 * loops — produces something that can answer two questions, and the app has
 * one surface for each. *Is this pixel a feature?* is asked of the map, and the
 * set is an **overlay** on it (§8.1). *What is on the sequence here?* is asked
 * of the lanes, and the set is a **1D track** of segments beside the map and in
 * the 1D browser (§8.16), read against the lane it was called from: a peak under
 * the coverage it was called on is the only way to check it by eye.
 *
 * It used to arrive as two rows, an overlay and a lane linked by
 * {@link AnnotationEntry.partner}, each with a switch — so one run of insulation
 * put five rows on the Tracks card for three things, and drew every boundary
 * twice. It is one row now, and its **display** says which of the two it is:
 * the row's `card`, `overlay` on the map's face or `synthetic` along an edge,
 * which is the one field every surface already asks (`AnnotationStore.overlays`
 * and `drawnOnMap`). So the overlay is `render/overlays.ts`'s and the lane
 * `render/features.ts`'s, as they are for a loaded file, and nothing here draws
 * anything. On the map a set of places has a **look** — a point, or the short
 * marker across the diagonal — and a set of extents is drawn as the corners of
 * the squares it claims (`OverlayShape`).
 *
 * A loop set is its pairs on both: rings on the map, arcs as a 1D track — and a
 * loaded BEDPE, longrange or interact file takes the same two displays
 * ({@link offersDisplay}). It used to be its anchors as a track; a row stored
 * then still carries the pairs behind them, and goes back to them.
 *
 * Pure but for the store it is handed, so it is tested without a workspace.
 */

import { FeatureBuilder } from '../annotations/featureset'
import { FIELD_NAME, MAX_LEVELS, defaultFeatureStyle, fieldLevels } from '../annotations/fields'
import { LEAD_MAP, type MapId } from '../annotations/placement'
import type { AnnotationStore } from '../annotations/store'
import {
  POINT_LOOKS,
  defaultStyle,
  overlayShapeOf,
  placementOn,
  LANE_EDGES,
  type AnnotationEntry,
  type AnnotationPayload,
  type AnnotationStyle,
  type ComputedSource,
  type FeatureSet,
  type OverlayShape,
  type PairSet,
  type Placement,
} from '../annotations/types'
import { laneStartsFlipped } from '../render/lane'
import { SYNTHETIC_EDGE } from '../ui/synthetic'

/** Where a called set is drawn: beside the map as a 1D track, or on it. */
export type CalledDisplay = 'lane' | 'overlay'

/**
 * Whether a row is a set a task called: computed, and a set of intervals or of
 * pairs, drawn as a lane or an overlay. A reconstructed model is computed too,
 * and is a row of the Structures card rather than one of these (§25.6).
 */
export function isCalledSet(entry: Pick<AnnotationEntry, 'source' | 'kind' | 'card'>): boolean {
  return (
    entry.source.kind === 'computed' &&
    (entry.kind === 'segments' || entry.kind === 'pairs') &&
    (entry.card === 'overlay' || entry.card === 'synthetic')
  )
}

/**
 * Whether a row offers the display at all: a called set, and any loaded set of
 * **pairs** — a BEDPE, a longrange, an interact file — which is a loop set as
 * much as a called one is, and answers the same two questions: rings on the map,
 * or arcs along a track (§8.1).
 */
export function offersDisplay(entry: Pick<AnnotationEntry, 'source' | 'kind' | 'card'>): boolean {
  return isCalledSet(entry) || (entry.kind === 'pairs' && (entry.card === 'overlay' || entry.card === 'linear'))
}

/** Which surface a called set is on now. */
export function displayOf(entry: Pick<AnnotationEntry, 'card'>): CalledDisplay {
  return entry.card === 'overlay' ? 'overlay' : 'lane'
}

/**
 * Whether a called set is a set of **places**, whose look on the map is the
 * reader's to choose: a point, or the short marker across the diagonal. A set
 * of extents has one look, the corner, and a set of pairs is a ring.
 */
export function offersLook(entry: Pick<AnnotationEntry, 'kind' | 'style' | 'payload'>): boolean {
  if (entry.kind === 'pairs' || entry.payload?.kind === 'pairs') return false
  return POINT_LOOKS.includes(overlayShapeOf(entry.style))
}

/**
 * The pairs a set of anchors was taken from — so a loop set shown as a 1D track
 * can go back on the map as its loops. Weak, because the anchors are the row's
 * payload and leave with it: a row run again, closed, or carried to another
 * resolution (which carries the same object) needs nothing cleared here.
 */
const pairsBehind = new WeakMap<FeatureSet, PairSet>()

/**
 * What a called set draws as a lane.
 *
 * A set of intervals is itself; a set of **pairs** is its anchors — both ends of
 * every pair, each place once however many pairs share it, which is the BED a
 * reader asking "where are the loop anchors" would write. The name of the first
 * pair to reach an anchor is kept, and the score is the best of the pairs at it.
 */
export function laneSetOf(payload: AnnotationPayload): FeatureSet {
  return payload.kind === 'features' ? payload.data : anchorsOf(payload.data)
}

/**
 * The set as it was called, whichever surface it is on: the pairs behind a loop
 * set's anchors, and the row's own payload otherwise. What a row is exported as
 * — a loop set leaves as its BEDPE from either surface.
 */
export function calledPayloadOf(entry: Pick<AnnotationEntry, 'payload'>): AnnotationPayload | undefined {
  const payload = entry.payload
  if (payload?.kind !== 'features') return payload
  const pairs = pairsBehind.get(payload.data)
  return pairs === undefined ? payload : { kind: 'pairs', data: pairs }
}

/** Both ends of every pair, once each. See {@link laneSetOf}. */
export function anchorsOf(pairs: PairSet): FeatureSet {
  const held = new Map<string, { contig: string; start: number; end: number; name: string; score: number; pairs: number }>()
  const visit = (contig: number, start: number, end: number, i: number): void => {
    const name = pairs.contigs[contig]
    const key = `${name}\t${start}\t${end}`
    const score = pairs.score[i]
    const known = held.get(key)
    if (known === undefined) {
      held.set(key, { contig: name, start, end, name: pairs.name[i] ?? '', score, pairs: 1 })
      return
    }
    known.pairs++
    if (Number.isFinite(score) && !(score <= known.score)) known.score = score
  }
  for (let i = 0; i < pairs.length; i++) {
    visit(pairs.contig1[i], pairs.start1[i], pairs.end1[i], i)
    visit(pairs.contig2[i], pairs.start2[i], pairs.end2[i], i)
  }
  const builder = new FeatureBuilder()
  for (const anchor of held.values()) {
    builder.add(anchor.contig, anchor.start, anchor.end, {
      name: anchor.name,
      score: anchor.score,
      detail: `anchors ${anchor.pairs}`,
    })
  }
  const set = builder.finish()
  pairsBehind.set(set, pairs)
  return set
}

/**
 * The kind and payload a called set has on one surface — the same set on both:
 * a loop set is its pairs, rings on the map and arcs as a track. It used to be
 * its anchors as a track, which drew a loop as two boxes with nothing between
 * them; the anchors leave as a BED of their own instead (`anchorsBed`).
 */
function pictureOf(payload: AnnotationPayload): { kind: 'segments' | 'pairs'; payload: AnnotationPayload } {
  return { kind: payload.kind === 'pairs' ? 'pairs' : 'segments', payload }
}

/**
 * How a called set's lane is coloured when it arrives.
 *
 * By its **name** where the names are a handful of kinds — a compartment's `A`
 * and `B` — since that is what the lane is for; by the default otherwise, which
 * on a set with no strand is the lane's own colour. A set of ids (`domain_12`)
 * has as many names as rows, and colouring it by them would be a palette with
 * nothing to say.
 */
export function laneStyleFor(set: FeatureSet, colour: string, placement: Placement): AnnotationStyle {
  const base = defaultStyle('segments', colour)
  const levels = fieldLevels(set, FIELD_NAME)
  const byName = levels.length >= 2 && levels.length < MAX_LEVELS
  const on = LANE_EDGES.filter((edge) => placement[edge])
  return {
    ...base,
    flip: on.length === 1 && laneStartsFlipped(on[0]) ? !base.flip : base.flip,
    ...(byName ? { features: { ...defaultFeatureStyle('segments'), colourBy: FIELD_NAME } } : {}),
  }
}

/** What {@link adoptCalledSet} is asked to put in the store. */
export interface CalledSet {
  /** The row's id. */
  id: string
  label: string
  source: ComputedSource
  /** The set as it was called: intervals, or pairs. */
  payload: AnnotationPayload
  summary: string
  colour: string
  /** The map it was called from. */
  map: MapId
  /**
   * Which surface it opens on, the first time it arrives — a second run keeps
   * whichever the reader left it on. Forced to the one there is where only one
   * is: the lane in a 1D browser, which has no map to overlay.
   */
  display: CalledDisplay
  /** How a set of segments is drawn on the map; see `OverlayShape`. */
  look: OverlayShape
  /** Whether there is a map to draw an overlay on at all (a 1D browser has none). */
  overlay: boolean
  /**
   * The row the lane goes directly under, where there is one: it takes that
   * row's edges on the map, and the slot after it in the one list whose order
   * is the lanes' order (§18.5). Its place in the list whichever surface it is
   * on, so a set put on the map and back is where it was.
   */
  under: string | null
}

/**
 * The look a row run again keeps: the reader's, where it is a look of this
 * set's own family — a point set's point or marker, an extent set's corner —
 * and the task's otherwise. A row stored before the looks carries the box they
 * replaced, and a boundary set drawn as the corners of one-bin squares would be
 * a row of hooks nobody asked for.
 */
function keptLook(style: { shape?: unknown }, look: OverlayShape): OverlayShape {
  const held = style.shape
  if (held !== 'point' && held !== 'border' && held !== 'corner') return look
  return POINT_LOOKS.includes(held) === POINT_LOOKS.includes(look) ? held : look
}

/**
 * The id a called set's lane had when a set was two rows, kept so that a
 * session written then, and a second run over a row restored from one, can
 * fold the pair into the one row it is now (`AnnotationStore.stored`).
 */
export function legacyLaneIdOf(id: string): string {
  return `${id}:lane`
}

/**
 * Put a called set on the store, as one row.
 *
 * **A second run replaces it in place, and keeps what the reader decided about
 * it**: its slot in the list, its edges, its colour, its colouring, its look,
 * whether it is shown — and which surface it is on, so a reader who put the
 * domains on the map and ran insulation again with a wider window gets the new
 * domains on the map.
 *
 * Returns the row's id.
 */
export function adoptCalledSet(store: AnnotationStore, set: CalledSet): string {
  const prior = store.byId(set.id)
  // A pair restored from a session written before a set was one row, and run
  // again: the lane half goes, since the row it was the other half of is the
  // whole set now.
  if (store.byId(legacyLaneIdOf(set.id)) !== undefined) store.remove(legacyLaneIdOf(set.id))

  const display: CalledDisplay = !set.overlay
    ? 'lane'
    : prior !== undefined && isCalledSet(prior)
      ? displayOf(prior)
      : set.display
  const picture = pictureOf(set.payload)
  const lanes = laneSetOf(set.payload)

  const anchor = set.under === null ? undefined : store.byId(set.under)
  const anchorPlacement =
    anchor === undefined ? undefined : (store.laneFor(anchor.id, set.map)?.placement ?? anchor.placement)
  // The edges it is drawn on as a 1D track, held whichever surface it is on: an
  // overlay is drawn on the map's face and reads no edge, and the edges are
  // where it goes back to when the reader makes it a track again.
  const placement =
    prior !== undefined && LANE_EDGES.some((edge) => prior.placement[edge])
      ? prior.placement
      : anchorPlacement !== undefined && LANE_EDGES.some((edge) => anchorPlacement[edge])
        ? { ...anchorPlacement }
        : placementOn(SYNTHETIC_EDGE)
  const style: AnnotationStyle =
    prior !== undefined && isCalledSet(prior)
      ? { ...prior.style, shape: keptLook(prior.style, set.look) }
      : {
          ...laneStyleFor(lanes, set.colour, placement),
          shape: set.look,
          // A loop set's rings are drawn a little under opaque, as a loaded
          // BEDPE's are, so a ring over a bright pixel does not hide it.
          ...(set.payload.kind === 'pairs' ? { opacity: defaultStyle('pairs', set.colour).opacity } : {}),
        }

  store.begin({
    card: display === 'overlay' ? 'overlay' : 'synthetic',
    kind: picture.kind,
    id: set.id,
    label: set.label,
    source: set.source,
    placement,
    style,
    ...(prior === undefined ? {} : { visible: prior.visible }),
  })
  if (set.map !== LEAD_MAP) {
    store.placeOn(set.id, set.map, placement)
    store.unplaceFrom(set.id, LEAD_MAP)
  }
  store.update(set.id, { status: 'ready', payload: picture.payload, summary: set.summary })
  // Directly under the row it is read against — only on arrival, since a row
  // the reader has already moved is where they put it.
  if (prior === undefined && anchor !== undefined) {
    const at = store.entries.findIndex((row) => row.id === anchor.id)
    const from = store.entries.findIndex((row) => row.id === set.id)
    if (at >= 0 && from >= 0) store.moveTo(set.id, from > at ? at + 1 : at)
  }
  return set.id
}

/**
 * Put a called set on the other surface: a 1D track beside the map, or an
 * overlay on it.
 *
 * The row's `card` is the switch — the one field the stacks and the map's face
 * both ask — so everything about the row comes with it: its colour, its name,
 * its slot, whether it is shown. A loop set swaps its pairs for its anchors on
 * the way to the lane and back. A row with no payload — one restored from a
 * reload and not yet recomputed — changes surface alone, and takes its picture
 * when it is run again.
 *
 * On the way to the lane, a map it was put on *as an overlay* (dropped on a
 * map's face, or lit in the maps field) has no edges, and is given the row's
 * own: a track on no edge is a track on no map.
 */
export function setDisplay(store: AnnotationStore, id: string, display: CalledDisplay): void {
  const entry = store.byId(id)
  if (entry === undefined || !offersDisplay(entry) || displayOf(entry) === display) return
  const called = calledPayloadOf(entry)
  const picture = called === undefined ? null : pictureOf(called)
  // A called set's track is a computed row's; a loaded file's is a loaded one's.
  const track = isCalledSet(entry) ? 'synthetic' : 'linear'
  // A row that has only ever been an overlay — one stored before a set was one
  // row, from a file whose lanes were not drawn — has no edges of its own yet,
  // and takes the computed tracks' edge as the default its maps are given.
  const edged = LANE_EDGES.some((edge) => entry.placement[edge])
  const edges = edged ? entry.placement : placementOn(SYNTHETIC_EDGE)
  if (display === 'lane') {
    for (const map of store.mapsDrawing(id)) {
      const lane = store.laneFor(id, map)
      if (lane !== undefined && !LANE_EDGES.some((edge) => lane.placement[edge])) {
        store.placeOn(id, map, edges)
      }
    }
  }
  store.update(id, {
    card: display === 'overlay' ? 'overlay' : track,
    ...(picture === null ? {} : { kind: picture.kind, payload: picture.payload }),
    ...(display === 'lane' && !edged ? { placement: edges } : {}),
  })
}

/** Change how a set of places is drawn on the map. */
export function setLook(store: AnnotationStore, id: string, look: OverlayShape): void {
  store.restyle(id, { shape: look })
}
