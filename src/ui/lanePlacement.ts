/**
 * *Where is this track drawn* — the one control, for every card that has rows.
 *
 * It lived inside `ui/AnnotationCard.ts` as three private methods, which was
 * right while there was one card with tracks on it. §18.5's claim is that a
 * computed track is a track like any other — same colour chip, same limits, same
 * four edges, same reorder — and the Synthetic card that listed them then was
 * the counter-example: it had the colour, the name and the eye, and no way at
 * all to say which map an eigenvector should be drawn beside or on which edge of
 * it. (Those rows are the Tracks card's own now.)
 *
 * So the control moves here and every card with lanes mounts the same one — the
 * Tracks card and the Metadata annotations card — and the Tracks card's batch
 * box mounts its twin for several rows (`ui/batchSettings.ts`). Nothing about it
 * changed on the way: four edges rather than a choice of one, because a track
 * can be on several and several is a real answer; a row per map once there is
 * more than one map to choose between; and the last edge on a map turning the
 * track *off that map* rather than leaving it visible and drawn nowhere.
 *
 * Every path through it ends at {@link AnnotationStore.placeAt}, which is the
 * one door that knows the difference between the session's own map and a
 * companion — and, on either, turns a lane that crosses between a horizontal
 * stack and a vertical one so it arrives reading the same way up as its
 * neighbours (`render/lane.ts`'s `laneStartsFlipped`).
 */

import { LEAD_MAP } from '../annotations/placement'
import type { AnnotationStore } from '../annotations/store'
import type { AnnotationEntry, LaneEdge } from '../annotations/types'
import { LANE_EDGES, emptyPlacement } from '../annotations/types'
import { button, el } from './dom'

/** One map a track may be drawn on, as the deck names it. */
export interface PlacementMap {
  id: string
  label: string
  /**
   * The edges this cell can draw a track on, where it is not a map (§25.3):
   * a tracks cell has one axis and one stack, along the bottom. Absent for a
   * map, which has all four. The other buttons are greyed rather than hidden,
   * so the row keeps the shape every other row has.
   */
  edges?: readonly LaneEdge[]
}

/**
 * The whole control: a `location` field, one row of edges per map.
 *
 * `maps` is what the deck offers, or a single unnamed lead where there is no
 * deck — one map is the case this has always been, and it keeps exactly the
 * shape it had, because *which map* is not a question a session with one map is
 * asking.
 */
export function placementField(
  store: AnnotationStore,
  entry: AnnotationEntry,
  maps: readonly PlacementMap[],
): HTMLElement {
  const named = maps.length > 1
  return el(
    'div',
    // The one field in a card body that does not put its label in a column; see
    // the stylesheet for why four edges cannot share a row this narrow with one.
    { class: 'field ann-field ann-field-places' },
    el('span', { class: 'field-label', text: 'location' }),
    el(
      'div',
      { class: 'ann-place-maps' },
      ...maps.map((map) => edgeRow(store, entry, map, named)),
      ...(named ? [everyMapRow(store, entry, maps)] : []),
    ),
  )
}

/**
 * The four edges of one map, and whether this track is on them.
 *
 * Reads the *lane*, not the entry: the entry's own placement is the default a
 * new lane is given, and where a track is actually drawn on a given map is that
 * map's lane (`annotations/placement.ts`).
 */
function edgeRow(
  store: AnnotationStore,
  entry: AnnotationEntry,
  map: PlacementMap,
  named: boolean,
): HTMLElement {
  const lane = store.laneFor(entry.id, map.id)
  const placement = lane?.placement ?? emptyPlacement()
  const only = LANE_EDGES.filter((edge) => placement[edge])
  const edgeButton = (edge: LaneEdge): HTMLElement => {
    const on = placement[edge]
    const last = on && only.length === 1
    const node = el('button', {
      class: 'btn btn-toggle ann-place',
      type: 'button',
      text: edge,
      title: last
        ? `Drawn on the ${edge} edge${named ? ` of ${map.label}` : ''} — pressing it again takes ` +
          'the track off this map, and leaves it in the list to put back'
        : on
          ? `Stop drawing this on the ${edge} edge${named ? ` of ${map.label}` : ''}`
          : `Draw this on the ${edge} edge${named ? ` of ${map.label}` : ''} as well`,
    })
    node.setAttribute('aria-pressed', String(on))
    if (map.edges !== undefined && !map.edges.includes(edge)) {
      node.disabled = true
      node.title = `${map.label} has no ${edge} edge: a stack of tracks is drawn along one axis`
    }
    node.addEventListener('click', () => {
      const next = { ...placement, [edge]: !on }
      // Off its last edge is off *this map* — the track stays in the list with
      // its settings, which is what makes putting it back cost nothing.
      if (LANE_EDGES.every((side) => !next[side])) store.unplaceFrom(entry.id, map.id)
      else store.placeAt(entry.id, map.id, next)
    })
    return node
  }
  const edges = el('div', { class: 'ann-places' }, ...LANE_EDGES.map(edgeButton))
  return named
    ? el(
        'div',
        { class: 'ann-place-map' },
        el('span', { class: 'ann-place-name', text: map.label, attrs: { title: map.label } }),
        edges,
      )
    : edges
}

/**
 * One track, the same place on every map — and the way back.
 *
 * The gesture a deck is for: a feature read straight across a row of pictures
 * needs the track under each of them at the same edge. The copies carry no
 * settings of their own, so recolouring the track moves all of them for good
 * (`annotations/placement.ts`); "no map" takes them all away and keeps the
 * import, which is why it is not the same button as remove.
 */
function everyMapRow(
  store: AnnotationStore,
  entry: AnnotationEntry,
  maps: readonly PlacementMap[],
): HTMLElement {
  const drawn = store.mapsDrawing(entry.id).length
  return el(
    'div',
    { class: 'ann-place-all' },
    button('every map', () => store.propagateTo(entry.id, maps.map((map) => map.id)), {
      class: 'btn btn-quiet',
      title:
        'Draw this on every map, at the edges it is already on. The copies keep following this ' +
        'row — recolour it here and they all move.',
    }),
    button('no map', () => store.withdrawFrom(entry.id), {
      class: 'btn btn-quiet',
      title: 'Take it off every map. It stays in this list, with its settings, ready to put back.',
    }),
    el('span', {
      class: 'ann-place-count',
      text: drawn === maps.length ? 'on every map' : `on ${drawn} of ${maps.length}`,
    }),
  )
}

/** The maps a card was given, or the single unnamed lead. */
export function mapsOrLead(maps?: () => readonly PlacementMap[]): readonly PlacementMap[] {
  return maps?.() ?? [{ id: LEAD_MAP, label: '' }]
}
