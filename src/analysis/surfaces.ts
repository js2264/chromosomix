/**
 * A called set, on both of the surfaces a set of intervals has (§18.7).
 *
 * A task that calls intervals — peaks, boundaries, domains, A/B segments, loops
 * — produces something that answers two questions, and the app has one surface
 * for each. *Is this pixel a feature?* is asked of the map, and the set is an
 * **overlay** on it (§8.1). *What is on the sequence here?* is asked of the
 * lanes, and the set is a **lane of segments** beside the map and in the 1D
 * browser (§8.16) — read against the lane it was called from: a peak under the
 * coverage it was called on is the only way to check it by eye.
 *
 * So a called set arrives as **two rows**, each an ordinary row of the kind it
 * is drawn as — an overlay the overlay controls govern, and a lane the lane
 * controls govern — linked through {@link AnnotationEntry.partner} exactly as a
 * BAM's depth and pile are (§8.13). Nothing here draws anything: the overlay is
 * `render/overlays.ts`'s and the lane `render/features.ts`'s, as they are for a
 * loaded BED. Which surface is on is each row's `visible`, which is what the
 * eye on the row already toggles and what a session already remembers (§8.6),
 * and {@link surfaceToggles} is the pair of switches that names the two.
 *
 * Pure but for the store it is handed, so it is tested without a workspace.
 */

import { FeatureBuilder } from '../annotations/featureset'
import { FIELD_NAME, MAX_LEVELS, defaultFeatureStyle, fieldLevels } from '../annotations/fields'
import { LEAD_MAP, type MapId } from '../annotations/placement'
import type { AnnotationStore } from '../annotations/store'
import {
  defaultStyle,
  emptyPlacement,
  placementOn,
  LANE_EDGES,
  type AnnotationEntry,
  type AnnotationPayload,
  type AnnotationStyle,
  type ComputedSource,
  type FeatureSet,
  type PairSet,
  type Placement,
} from '../annotations/types'
import { laneStartsFlipped } from '../render/lane'
import { SYNTHETIC_EDGE } from '../ui/synthetic'

/** The lane row's id, from its overlay's: one suffix, so a restore resolves both. */
export function laneIdOf(overlayId: string): string {
  return `${overlayId}:lane`
}

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
  return builder.finish()
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
  /** The overlay row's id; the lane's is {@link laneIdOf} it. */
  id: string
  label: string
  source: ComputedSource
  payload: AnnotationPayload
  summary: string
  colour: string
  /** The map it was called from. */
  map: MapId
  /** Whether there is a map to draw an overlay on at all (a 1D browser has none). */
  overlay: boolean
  /** Whether there are lanes to draw one in at all (a metacool has none, §8.5). */
  lane: boolean
  /** Whether the lane starts switched on; see `IntervalsOutput.lane`. */
  laneShown: boolean
  /**
   * The row the lane goes directly under, where there is one: it takes that
   * row's edges on the map, and the slot after it in the one list whose order
   * is the lanes' order (§18.5).
   */
  under: string | null
}

/**
 * Put a called set on the store as its overlay and its lane.
 *
 * **A second run replaces both, and keeps what the reader decided about them.**
 * The overlay is begun afresh, as it always was, so a set called on another map
 * lands there; the lane is begun *in place*, so it keeps the slot, the edges,
 * the colour and the colouring the reader gave it. Whether each is drawn — the
 * two switches — survives the run on both.
 *
 * Returns the two ids, `null` for a surface the set was not given.
 */
export function adoptCalledSet(
  store: AnnotationStore,
  set: CalledSet,
): { overlay: string | null; lane: string | null } {
  const laneId = laneIdOf(set.id)
  const priorOverlay = store.byId(set.id)
  const priorLane = store.byId(laneId)

  let overlay: string | null = null
  if (set.overlay) {
    if (priorOverlay !== undefined) store.remove(set.id)
    store.begin({
      card: 'overlay',
      kind: set.payload.kind === 'pairs' ? 'pairs' : 'segments',
      id: set.id,
      label: set.label,
      source: set.source,
      placement: emptyPlacement(),
      style: defaultStyle(set.payload.kind === 'pairs' ? 'pairs' : 'segments', set.colour),
      ...(priorOverlay === undefined ? {} : { visible: priorOverlay.visible }),
      ...(set.lane ? { partner: laneId } : {}),
    })
    if (set.map !== LEAD_MAP) {
      store.placeOn(set.id, set.map, emptyPlacement())
      store.unplaceFrom(set.id, LEAD_MAP)
    }
    store.update(set.id, { status: 'ready', payload: set.payload, summary: set.summary })
    overlay = set.id
  }
  if (!set.lane) return { overlay, lane: null }

  const lanes = laneSetOf(set.payload)
  const anchor = set.under === null ? undefined : store.byId(set.under)
  const anchorPlacement =
    anchor === undefined ? undefined : (store.laneFor(anchor.id, set.map)?.placement ?? anchor.placement)
  const placement =
    priorLane?.placement ??
    (anchorPlacement !== undefined && LANE_EDGES.some((edge) => anchorPlacement[edge])
      ? { ...anchorPlacement }
      : placementOn(SYNTHETIC_EDGE))
  store.begin({
    card: 'synthetic',
    kind: 'segments',
    id: laneId,
    label: set.label,
    source: set.source,
    placement,
    style: priorLane?.style ?? laneStyleFor(lanes, set.colour, placement),
    visible: priorLane?.visible ?? set.laneShown,
    ...(overlay === null ? {} : { partner: overlay }),
  })
  if (set.map !== LEAD_MAP) {
    store.placeOn(laneId, set.map, placement)
    store.unplaceFrom(laneId, LEAD_MAP)
  }
  store.update(laneId, {
    status: 'ready',
    payload: { kind: 'features', data: lanes },
    summary: set.summary,
  })
  // Directly under the row it is read against — only on arrival, since a lane
  // the reader has already moved is where they put it.
  if (priorLane === undefined && anchor !== undefined) {
    const at = store.entries.findIndex((row) => row.id === anchor.id)
    const from = store.entries.findIndex((row) => row.id === laneId)
    if (at >= 0 && from >= 0) store.moveTo(laneId, from > at ? at + 1 : at)
  }
  return { overlay, lane: laneId }
}

/**
 * The overlay and the lane of one called set, from either of its rows.
 *
 * `null` for a row that is not half of such a pair — a loaded BED, a profile,
 * a BAM's depth — so the switches are offered only where both surfaces exist.
 */
export function surfacesOf(
  store: AnnotationStore,
  entry: AnnotationEntry,
): { overlay: AnnotationEntry; lane: AnnotationEntry } | null {
  if (entry.source.kind !== 'computed' || entry.partner === undefined) return null
  const other = store.byId(entry.partner)
  if (other === undefined) return null
  if (entry.card === 'overlay' && other.card === 'synthetic' && other.kind === 'segments') {
    return { overlay: entry, lane: other }
  }
  if (other.card === 'overlay' && entry.card === 'synthetic' && entry.kind === 'segments') {
    return { overlay: other, lane: entry }
  }
  return null
}

/**
 * Which surface a row of a called set is, in the words of its switch — or
 * `null` for any other row.
 *
 * The two rows share a name, so the line under it says which is which:
 * `Diamond insulation · 412 boundaries · on the map` over the overlay and
 * `… · as a lane` over the lane (§18.7). Read from the row alone, because the
 * line is built where there is no store to ask.
 */
export function surfaceWord(entry: AnnotationEntry): string | null {
  if (entry.source.kind !== 'computed' || entry.partner === undefined) return null
  if (entry.card === 'overlay') return 'on the map'
  if (entry.card === 'synthetic' && entry.kind === 'segments') return 'as a lane'
  return null
}
