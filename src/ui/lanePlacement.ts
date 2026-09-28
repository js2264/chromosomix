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
 *
 * An **overlay** is asked the same question with a smaller answer, and gets
 * the same field with one mark per map instead of four ({@link
 * overlayMapsField}): it is drawn on the map's face, so a map has one place for
 * it rather than four edges.
 */

import { LEAD_MAP } from '../annotations/placement'
import type { AnnotationStore } from '../annotations/store'
import type { AnnotationEntry, LaneEdge } from '../annotations/types'
import { LANE_EDGES, emptyPlacement } from '../annotations/types'
import { button, el } from './dom'
import { icon, type IconName } from './icons'

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
  /**
   * A deck's tracks cell (§25.3): a stack of lanes with no contact map in it,
   * so a place for a track and not for an overlay. Absent for a map.
   */
  tracks?: true
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
    // One line for one map, the label in its column like every other field's;
    // a line per map under the label once there are several (see the
    // stylesheet).
    { class: `field ann-field ann-field-places${named ? ' is-named' : ''}` },
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
    const node = edgeToggle(
      edge,
      last
        ? `Drawn on the ${edge} edge${named ? ` of ${map.label}` : ''} — pressing it again takes ` +
          'the track off this map, and leaves it in the list to put back'
        : on
          ? `Stop drawing this on the ${edge} edge${named ? ` of ${map.label}` : ''}`
          : `Draw this on the ${edge} edge${named ? ` of ${map.label}` : ''} as well`,
      on ? 'true' : 'false',
    )
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

/**
 * Which maps an overlay is drawn on (§8.1): a line per contact map — its name
 * and one mark, the map's grid, lit where the overlay is drawn on it — then
 * *every map*, *no map* and how many.
 *
 * The location field's shape, because it is the location field's question: an
 * overlay is placed per map exactly as a lane is (`annotations/placement.ts`),
 * and every map used to draw every one — a loop set called on one replicate
 * circled on all six. Named `maps` rather than `location`, because a
 * batch of a bigWig and a loop set shows both fields and they answer
 * differently: edges of each map there, maps here. A tracks cell is not
 * listed: it has no matrix to draw a loop on.
 *
 * `null` where there is nothing to choose — one map, with the overlay on it:
 * the eye on the row's head hides it there already, and a second switch saying
 * the same thing is two answers to one question. The one map *is* offered
 * while the overlay is drawn on none, which a deck closed after *no map* leaves
 * it, because then this is the only way back.
 */
export function overlayMapsField(
  store: AnnotationStore,
  entry: AnnotationEntry,
  maps: readonly PlacementMap[],
): HTMLElement | null {
  const faces = maps.filter((map) => map.tracks !== true)
  const drawn = faces.filter((map) => store.laneFor(entry.id, map.id) !== undefined).length
  if (faces.length === 0 || (faces.length === 1 && drawn === 1)) return null
  const named = faces.length > 1
  return el(
    'div',
    { class: `field ann-field ann-field-places${named ? ' is-named' : ''}` },
    el('span', { class: 'field-label', text: 'maps' }),
    el(
      'div',
      { class: 'ann-place-maps' },
      ...faces.map((map) => faceRow(store, entry, map, named)),
      ...(named ? [everyFaceRow(store, entry, faces, drawn)] : []),
    ),
  )
}

/** One map's mark for an overlay, and its name where there are several. */
function faceRow(
  store: AnnotationStore,
  entry: AnnotationEntry,
  map: PlacementMap,
  named: boolean,
): HTMLElement {
  const on = store.laneFor(entry.id, map.id) !== undefined
  const where = named ? map.label : 'this map'
  const node = faceToggle(
    where,
    on
      ? `Drawn on ${where} — pressing it takes it off, and leaves it in the list to put back`
      : `Draw this on ${where}`,
    on ? 'true' : 'false',
  )
  node.addEventListener('click', () => {
    // The track's own placement for the lane, as every new lane is given: its
    // edges are not read on the matrix, and a lane made any other way would be
    // one more shape for the same fact.
    if (on) store.unplaceFrom(entry.id, map.id)
    else store.placeOn(entry.id, map.id, entry.placement)
  })
  const marks = el('div', { class: 'ann-places' }, node)
  return named
    ? el(
        'div',
        { class: 'ann-place-map' },
        el('span', { class: 'ann-place-name', text: map.label, attrs: { title: map.label } }),
        marks,
      )
    : marks
}

/**
 * {@link everyMapRow} for an overlay, over the contact maps alone: *no map*
 * takes it off those, and leaves a tracks cell it was dropped on to that cell.
 */
function everyFaceRow(
  store: AnnotationStore,
  entry: AnnotationEntry,
  faces: readonly PlacementMap[],
  drawn: number,
): HTMLElement {
  const ids = faces.map((map) => map.id)
  return el(
    'div',
    { class: 'ann-place-all' },
    button('every map', () => store.propagateTo(entry.id, ids), {
      class: 'btn btn-quiet',
      title:
        'Draw this on every map. The copies keep following this row — recolour it here and ' +
        'they all move.',
    }),
    button('no map', () => store.withdrawFrom(entry.id, ids), {
      class: 'btn btn-quiet',
      title: 'Take it off every map. It stays in this list, with its settings, ready to put back.',
    }),
    el('span', {
      class: 'ann-place-count',
      text: drawn === faces.length ? 'on every map' : `on ${drawn} of ${faces.length}`,
    }),
  )
}

/**
 * An overlay's mark on one map, as both its controls draw it — this one and
 * the batch box's twin (`ui/batchSettings.ts`).
 *
 * The map's grid, the mark the Contact maps card is headed with: an overlay is
 * drawn *on* the map rather than beside one of its edges, so the mark is the
 * map rather than a side of it. `where` names the map to a screen reader.
 */
export function faceToggle(
  where: string,
  title: string,
  pressed: 'true' | 'false' | 'mixed',
): HTMLButtonElement {
  const node = el('button', {
    class: 'btn btn-icon btn-toggle ann-place',
    type: 'button',
    title,
    attrs: { 'aria-label': `on ${where}`, 'aria-pressed': pressed, 'data-face': '' },
  }) as HTMLButtonElement
  node.append(icon('grid-2x2', { size: 15 }))
  return node
}

/**
 * The mark for each edge: the map as a dashed square, with that edge drawn
 * solid — Lucide's `square-dashed-top-solid`, and the same square turned for
 * the other three (`scripts/build-icons.mjs`).
 */
export const EDGE_ICONS: Readonly<Record<LaneEdge, IconName>> = {
  top: 'square-dashed-top-solid',
  right: 'square-dashed-right-solid',
  bottom: 'square-dashed-bottom-solid',
  left: 'square-dashed-left-solid',
}

/**
 * One edge's button, as both placement controls draw it — this one and the
 * batch box's twin (`ui/batchSettings.ts`).
 *
 * A mark and not the word. The four words — `top`, `right`, `bottom`, `left` —
 * were a segmented control as wide as the card, a line of its own under each
 * map's name; four marks of the map with one edge drawn are a quarter of that,
 * and sit on the name's own line. The word is still the button's name, for a
 * screen reader and in `data-edge`, and the title says what a press does.
 */
export function edgeToggle(edge: LaneEdge, title: string, pressed: 'true' | 'false' | 'mixed'): HTMLButtonElement {
  const node = el('button', {
    class: 'btn btn-icon btn-toggle ann-place',
    type: 'button',
    title,
    attrs: { 'aria-label': edge, 'aria-pressed': pressed, 'data-edge': edge },
  }) as HTMLButtonElement
  node.append(icon(EDGE_ICONS[edge], { size: 15 }))
  return node
}

/** The maps a card was given, or the single unnamed lead. */
export function mapsOrLead(maps?: () => readonly PlacementMap[]): readonly PlacementMap[] {
  return maps?.() ?? [{ id: LEAD_MAP, label: '' }]
}
