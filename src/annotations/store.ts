/**
 * The set of annotations loaded against one open file, and its session memory.
 *
 * A store rather than state inside a card, for the same reason the overlay
 * preference is one (`ui/plotOptions.ts`): the cards write to it, the heatmap
 * panel and every lane read from it, and those live on opposite sides of the
 * app. It is keyed by file URI and held by the shell, so navigating from a
 * region to the contigs table and back does not drop ten loaded tracks — the
 * view is rebuilt, the annotations are not.
 *
 * Persistence is `UiMemory`, which is `sessionStorage` (spec §8.6). What
 * survives a reload is the *description* — labels, colours, limits, placement —
 * and, for a remote file, enough to fetch it again. A dropped local file cannot
 * be re-read without a fresh gesture in any browser, so it comes back
 * `detached`: the row is there with its settings intact and a button to point at
 * the file again, which is strictly better than either forgetting the settings
 * or pretending the data is still loaded.
 */

import { laneStartsFlipped } from '../render/lane'
import {
  laneOf,
  mapsOf,
  place,
  propagate,
  pruneLanes,
  resolveStyle,
  unplace,
  withdraw,
  type Lane,
  type MapId,
} from './placement'
import { LEAD_MAP } from './placement' 
import { recall, remember } from '../state/UiMemory'
import type {
  AnnotationCard,
  AnnotationEntry,
  AnnotationKind,
  AnnotationSource,
  LaneEdge,
  Placement,
  StoredEntry,
} from './types'
import {
  ANNOTATION_KINDS,
  LANE_EDGES,
  defaultStyle,
  hasTrackControls,
  normalisePlacement,
  placementOn,
  readStyleOf,
  structureStyleOf,
} from './types'
import { featureStyleOf } from './fields'

/**
 * The colour a newly loaded annotation gets, cycled.
 *
 * Okabe–Ito, the eight-colour qualitative set designed to stay distinguishable
 * under every common form of colour vision. The app already marks its
 * colour-safe colormaps with a tick; picking a default palette that is not safe
 * would undercut that on the one part of the figure where the colour *is* the
 * identity of the data.
 */
export const ANNOTATION_PALETTE = [
  '#0072b2', // blue
  '#d55e00', // vermillion
  '#009e73', // bluish green
  '#cc79a7', // reddish purple
  '#e69f00', // orange
  '#56b4e9', // sky blue
  '#8c6d31', // brown, for the ninth track onward
  '#5b6169', // grey
] as const

/**
 * One lane on a companion map, written down.
 *
 * Keyed by the **file** the map was showing rather than by its `MapId`, which is
 * what makes it worth persisting: a slot id is minted per deck (`PanelDeck`), so
 * an id recorded today names nothing tomorrow. The file is what the reader means
 * by "that map" anyway.
 */
export interface StoredLane {
  track: string
  uri: string
  placement: Placement
  /** Whether the lead lane it now sits on was borrowed, or already its own. */
  borrowedLead: boolean
  style?: Lane['style']
}

/** Untrusted, like every other stored shape: checked field by field. */
function isStoredLane(value: unknown): value is StoredLane {
  if (typeof value !== 'object' || value === null) return false
  const row = value as Partial<StoredLane>
  return (
    typeof row.track === 'string' &&
    row.track !== '' &&
    typeof row.uri === 'string' &&
    row.uri !== '' &&
    typeof row.placement === 'object' &&
    row.placement !== null &&
    typeof row.borrowedLead === 'boolean'
  )
}

export type AnnotationListener = (entries: readonly AnnotationEntry[]) => void

let nextId = 1

/** A session-unique id. Not derived from the file name: two files may share one. */
export function mintAnnotationId(): string {
  return `a${nextId++}`
}

/**
 * Reserve an id that came back from somewhere, so nothing new is minted onto it.
 *
 * The counter starts at one on every page load, and a restore hands back the
 * ids the *previous* load minted — so without this the first track dropped
 * after a reload is given `a1`, which the first restored row is already
 * wearing. Two rows under one id is not two tracks: `update` patches every
 * match and `remove` deletes every match, so the pair moves and dies together
 * and neither can be taken away. `app/sessions.ts` reserves tab ids on the way
 * out of storage for the same reason, and `annotations/manual.ts` reserves mark
 * ids.
 */
function reserveAnnotationId(id: string): void {
  const number = Number(id.slice(1))
  if (Number.isFinite(number) && number >= nextId) nextId = number + 1
}

export class AnnotationStore {
  private items: AnnotationEntry[] = []
  private readonly listeners = new Set<AnnotationListener>()

  /**
   * @param uri  What the rows are remembered under (§8.6).
   * @param options.persist `false` for a store nothing should outlive: a file
   *   with a genome layer carries no annotations at all (§8.5) and yet still
   *   has a 4C lane, which needs somewhere to be a lane *in*. Writing an empty
   *   list under a key nobody reads is not harmful, but it is a lie about what
   *   the session holds, and this is cheaper than one.
   */
  constructor(
    private readonly uri: string,
    private readonly options: { persist?: boolean } = {},
  ) {}

  get entries(): readonly AnnotationEntry[] {
    return this.items
  }

  // -------------------------------------------------------------------------
  // Where each track is drawn (`annotations/placement.ts`)
  // -------------------------------------------------------------------------

  /**
   * One lane per track per map. Empty until a track is placed, which is what
   * {@link begin} does for the session's own map on import.
   *
   * The *entries* above are the imported tracks and are one list however many
   * maps are on screen; this says which of them each map draws, and on which of
   * its four edges. See `annotations/placement.ts` for why the two are separate
   * things rather than one entry per map.
   */
  private lanes: Lane[] = []
  /**
   * Which file each map is showing, so a lane that outlives its map can be
   * given back to the right one. See {@link noteMapFiles}.
   */
  private readonly mapFiles = new Map<MapId, string>()
  /**
   * Where a lane was, for a map that has gone.
   *
   * Keyed on the **file**, never on the `MapId`: a slot id is minted per deck
   * and a deck closed and reopened mints new ones, so the id a lane was parked
   * under would never be seen again. What the reader means by "that map" is the
   * file it was showing, and that is what comes back.
   *
   * **Now persisted, and the reversal is worth arguing rather than deleting.**
   * This said, correctly, that a lane is not persisted either: what survives a
   * reload is the *import*, and an arrangement of pictures that no longer exist
   * is not something to restore a reader into. The premise was that the pictures
   * no longer exist. A deck of local companions now comes back
   * (`panels/deck.ts`), so they do — and a restored deck that put every track on
   * the lead would be the one part of the session that did not return.
   *
   * The old decision still holds wherever the premise still holds: where the
   * companions do *not* come back, {@link keepMaps} parks these lanes onto the
   * lead exactly as it always has, and nothing here changes that.
   *
   * Keyed on the **file**, never on the `MapId`, which is what makes persisting
   * it possible at all: a slot id is minted per deck, so an id written down
   * today would name nothing tomorrow.
   */
  private homes: StoredLane[] = []
  /** Each lane's last lone edge, by `track map` — see {@link readingEdge}. */
  private readonly alone = new Map<string, LaneEdge>()

  /** Every placement, for the card that lists where a track is drawn. */
  get placements(): readonly Lane[] {
    return this.lanes
  }

  /**
   * The rows one map draws, with each lane's own patch resolved over its track.
   *
   * This is what a panel is handed instead of {@link entries}: the same tracks,
   * carrying the placement and the style *that map* draws them with. A panel
   * given this needs to know nothing about lanes at all, which is what let the
   * whole of `ui/AnnotationLanes.ts` stay as it was.
   */
  entriesOn(map: MapId): AnnotationEntry[] {
    const out: AnnotationEntry[] = []
    // In the **track list's** order, not the lane list's. Two reasons, and the
    // second is why it is not merely convenient: `moveTo` reorders the tracks,
    // so a stack that read its order off the lanes would not follow a reorder at
    // all — and a deck whose stacks are in different orders is a set of pictures
    // the eye has to re-index before it can compare them, which is the thing a
    // deck exists to avoid.
    for (const track of this.items) {
      const lane = laneOf(this.lanes, track.id, map)
      if (lane === undefined) continue
      out.push({ ...track, placement: lane.placement, style: resolveStyle(track.style, lane) })
    }
    return out
  }

  /** Which maps a track is drawn on. */
  mapsDrawing(track: string): MapId[] {
    return mapsOf(this.lanes, track)
  }

  /** The patch one map holds over a track, if any. */
  laneFor(track: string, map: MapId): Lane | undefined {
    return laneOf(this.lanes, track, map)
  }

  /** Draw a track on a map, or move it to different edges of one it is on. */
  placeOn(track: string, map: MapId, placement: Placement): void {
    this.lanes = place(this.lanes, track, map, placement)
    this.changed()
  }

  /** Take a track off one map, keeping the import and every other placement. */
  unplaceFrom(track: string, map: MapId): void {
    const before = this.lanes.length
    this.lanes = unplace(this.lanes, track, map)
    if (this.lanes.length !== before) this.changed()
  }

  /** Put a track on every map named, at the edges it is already drawn on. */
  propagateTo(track: string, maps: readonly MapId[]): void {
    this.lanes = propagate(this.lanes, track, maps)
    this.changed()
  }

  /** Take a track off every map, keeping the import. */
  withdrawFrom(track: string): void {
    const before = this.lanes.length
    this.lanes = withdraw(this.lanes, track)
    if (this.lanes.length !== before) this.changed()
  }

  /** Give one map's copy of a track a patch of its own, or hand a field back. */
  overrideOn(track: string, map: MapId, patch: Lane['style']): void {
    const held = laneOf(this.lanes, track, map)
    if (held === undefined) return
    const merged = { ...held.style, ...patch }
    for (const key of Object.keys(merged) as Array<keyof typeof merged>) {
      if (merged[key] === undefined) delete merged[key]
    }
    const next: Lane =
      Object.keys(merged).length === 0
        ? { track: held.track, map: held.map, placement: held.placement }
        : { ...held, style: merged }
    this.lanes = this.lanes.map((lane) => (lane === held ? next : lane))
    this.changed()
  }

  /**
   * Put a snapshot of lanes back, for the tracks that came back with them.
   *
   * What a **reopen** needs, and the reason it needs it is {@link begin}: every
   * row handed to that function is placed on the lead, which is exactly right
   * for an import and exactly wrong for a row that is *returning*. A change of
   * resolution is a fresh open — so is re-dropping the file, so is following a
   * link into another entry — and every track in the session is begun again
   * around it. Without this, a deck of four maps each carrying its own bigWig
   * came back with all four stacked on the first one, and a track that had lived
   * only on a companion arrived on the lead, which is a map it was never on.
   *
   * **Reconciled, not added to.** A snapshot applied on top of `begin`'s lead
   * placement would leave every track on the lead *as well as* where it belongs,
   * which on a deck of four is the same picture four times. So a track whose
   * snapshot does not name the lead is taken off it.
   *
   * Tracks the snapshot does not mention keep whatever the store gave them: a
   * row that did not come back — a `computed` one, a `detached` one — is not a
   * row this can say anything about.
   */
  restoreLanes(lanes: readonly Lane[]): void {
    const wanted = new Map<string, Lane[]>()
    for (const lane of lanes) {
      const held = wanted.get(lane.track)
      if (held === undefined) wanted.set(lane.track, [lane])
      else held.push(lane)
    }
    let moved = false
    for (const [track, placements] of wanted) {
      if (!this.items.some((row) => row.id === track)) continue
      if (!placements.some((lane) => lane.map === LEAD_MAP)) {
        this.lanes = unplace(this.lanes, track, LEAD_MAP)
        moved = true
      }
      for (const lane of placements) {
        this.lanes = place(this.lanes, track, lane.map, lane.placement)
        moved = true
      }
    }
    if (moved) this.changed()
  }

  /**
   * Which file each map of the deck is showing.
   *
   * Learnt while a map is *alive*, because that is the only time anybody can
   * ask. A `MapId` is a slot id minted per deck and never minted again, so the
   * moment a map leaves there is nothing left to say which of the reader's files
   * it was — see {@link keepMaps}, which is what needs to know.
   */
  noteMapFiles(files: ReadonlyMap<MapId, string>): void {
    for (const [map, uri] of files) this.mapFiles.set(map, uri)
  }

  /**
   * Reconcile the lanes against the maps that exist — **parking** what leaves.
   *
   * Reconciled against the deck rather than driven by an event, for the reason
   * `SampleCache.prune` gives: an event that is not sent leaks a lane for the
   * life of the session, and doing it once per render cannot go stale. Tracks
   * are pruned by {@link remove}, which is the only way one leaves.
   *
   * A departing map's lane used to be *dropped*, which left the track imported
   * and drawn nowhere — "one tick from being on the lead", and that tick is the
   * problem. Closing a deck is a statement about layout, and the two things a
   * reader means by it are that the extra pictures should go and that the work
   * they did on them should not: a coverage track computed on the third
   * replicate disappearing when the grid does reads as the close having deleted
   * it. So the lane is **moved to the lead**, at the same edge it was on, and a
   * note of where it came from is kept against the *file* that map was showing
   * ({@link noteMapFiles}). Open a deck on that file again and {@link adoptHome}
   * puts it back where it was.
   *
   * A track whose *import* is gone is dropped either way: a lane is a placement
   * of something, and {@link remove} is the one door a track leaves by.
   */
  keepMaps(maps: ReadonlySet<MapId>): void {
    const tracks = new Set(this.items.map((entry) => entry.id))
    const leaving = this.lanes.filter(
      (lane) => tracks.has(lane.track) && !maps.has(lane.map) && lane.map !== LEAD_MAP,
    )
    const before = this.lanes.length
    this.lanes = pruneLanes(this.lanes, tracks, maps)
    let moved = this.lanes.length !== before
    for (const lane of leaving) {
      const uri = this.mapFiles.get(lane.map)
      // Nothing to key the memory on — a map that left before it had opened
      // anything. The lane still comes to the lead rather than vanishing; it
      // simply has no home to be sent back to.
      const borrowedLead = laneOf(this.lanes, lane.track, LEAD_MAP) === undefined
      if (uri !== undefined) {
        this.homes = [
          ...this.homes.filter((home) => !(home.uri === uri && home.track === lane.track)),
          {
            track: lane.track,
            uri,
            placement: lane.placement,
            borrowedLead,
            ...(lane.style === undefined ? {} : { style: lane.style }),
          },
        ]
      }
      // Only where the lead had none. A track the reader had deliberately put on
      // *both* is already visible and already arranged, and moving its lead lane
      // to wherever the departing copy happened to sit would be the close
      // rearranging a map that is not going anywhere.
      //
      // At the edge it was on otherwise, not at the lead's default: a stack the
      // reader arranged on one map is the arrangement they meant, and dropping
      // it onto whichever edge the track happens to default to is a second
      // change they did not ask for.
      if (borrowedLead) this.lanes = place(this.lanes, lane.track, LEAD_MAP, lane.placement)
      moved = true
    }
    if (moved) this.changed()
  }

  /**
   * A map opened this file: put back whatever was parked for it.
   *
   * The other half of {@link keepMaps}, and idempotent by construction — it runs
   * once per render of the deck and does nothing at all unless something is
   * actually parked under this URI.
   *
   * The lead lane the parking borrowed is handed back at the same time, and only
   * where it *was* borrowed: a track the reader had deliberately put on both the
   * lead and a companion must come back on both.
   */
  adoptHome(map: MapId, uri: string): void {
    if (map === LEAD_MAP || this.homes.length === 0) return
    const coming = this.homes.filter((home) => home.uri === uri)
    if (coming.length === 0) return
    this.homes = this.homes.filter((home) => home.uri !== uri)
    let moved = false
    for (const home of coming) {
      if (!this.items.some((row) => row.id === home.track)) continue
      this.lanes = place(this.lanes, home.track, map, home.placement)
      if (home.style !== undefined) {
        const held = laneOf(this.lanes, home.track, map)
        if (held !== undefined) {
          this.lanes = this.lanes.map((lane) =>
            lane === held ? { ...lane, style: home.style } : lane,
          )
        }
      }
      if (home.borrowedLead) this.lanes = unplace(this.lanes, home.track, LEAD_MAP)
      moved = true
    }
    if (moved) this.changed()
  }

  /** The rows one card shows, in load order. */
  forCard(card: AnnotationCard): AnnotationEntry[] {
    return this.items.filter((entry) => entry.card === card)
  }

  /**
   * The rows that are loaded, visible, and drawn on `edge`.
   *
   * Every card but the overlay one, which is the difference from "the Tracks
   * card's rows": the 4C profile has a card of its own precisely because it is
   * not a loaded file, and it is a lane in every other respect (§8.1).
   */
  drawnOn(edge: LaneEdge): AnnotationEntry[] {
    return this.drawnOnMap(LEAD_MAP, edge)
  }

  /**
   * The same question asked of any map: what does it draw on this edge.
   *
   * {@link drawnOn} is this one with the session's own map filled in, so there
   * is one rule and not two — the lead is a map like the others and its
   * placements live in the same list (`annotations/placement.ts`).
   */
  drawnOnMap(map: MapId, edge: LaneEdge): AnnotationEntry[] {
    return this.entriesOn(map).filter(
      (entry) => entry.card !== 'overlay' && entry.visible && entry.status === 'ready' && entry.placement[edge],
    )
  }

  /**
   * Everything this map draws, on whichever edge, once each and in list order.
   *
   * What a turned map needs: it has one stack, below the rectangle, and a track
   * put on two edges of the square has to arrive in it once rather than twice
   * (`ui/AnnotationLanes.ts`). Asking edge by edge and merging is the same
   * question asked four times and then repaired; asking it once is the question.
   */
  drawnAnywhereOn(map: MapId): AnnotationEntry[] {
    return this.entriesOn(map).filter(
      (entry) =>
        entry.card !== 'overlay' &&
        entry.visible &&
        entry.status === 'ready' &&
        LANE_EDGES.some((edge) => entry.placement[edge]),
    )
  }

  /**
   * The rows a map will draw on `edge` once they have loaded: {@link drawnOnMap}'s
   * rows and those still reading, in list order — or on any edge, for `null`,
   * as {@link drawnAnywhereOn} asks. What a lane stack reserves its room from,
   * so the picture beside it is laid out once rather than each time a track
   * lands (§8.6).
   */
  drawnOrLoadingOn(map: MapId, edge: LaneEdge | null): AnnotationEntry[] {
    return this.entriesOn(map).filter(
      (entry) =>
        entry.card !== 'overlay' &&
        entry.visible &&
        (entry.status === 'ready' || entry.status === 'loading') &&
        (edge === null ? LANE_EDGES.some((side) => entry.placement[side]) : entry.placement[edge]),
    )
  }

  /**
   * The feature set the browser's search reads.
   *
   * The one marked, or — until anything is marked — the first loaded, which is
   * what a reader who has opened exactly one gene model means without being
   * asked. Falls through when the marked one is removed or is still loading, so
   * the search never quietly stops working.
   */
  searchSource(): AnnotationEntry | null {
    const usable = this.items.filter(
      (entry) => entry.status === 'ready' && entry.payload?.kind === 'features',
    )
    return usable.find((entry) => entry.primary === true) ?? usable[0] ?? null
  }

  /** Make one feature set the one the search reads, and the others not. */
  makePrimary(id: string): void {
    if (this.byId(id) === undefined) return
    this.items = this.items.map((entry) => ({ ...entry, primary: entry.id === id }))
    this.changed()
  }

  /** The rows drawn on the matrix itself. */
  overlays(): AnnotationEntry[] {
    return this.items.filter(
      (entry) => entry.card === 'overlay' && entry.visible && entry.status === 'ready',
    )
  }

  byId(id: string): AnnotationEntry | undefined {
    return this.items.find((entry) => entry.id === id)
  }

  /** `true` when a gene model is already loaded — §8.1 allows exactly one. */
  hasGtf(): boolean {
    return this.items.some((entry) => entry.kind === 'gtf')
  }

  /**
   * The colour to give the next annotation: the first palette entry nothing is
   * already using, else the next one round.
   *
   * "First unused" rather than "next in sequence" because removing the third of
   * four tracks and dropping a replacement should give the replacement the
   * colour that just came free, not a fifth one that looks like a new series.
   */
  nextColour(): string {
    const used = new Set(this.items.map((entry) => entry.style.colour))
    const free = ANNOTATION_PALETTE.find((colour) => !used.has(colour))
    return free ?? ANNOTATION_PALETTE[this.items.length % ANNOTATION_PALETTE.length]
  }

  /**
   * Put a placeholder row on screen immediately, before a byte has been read.
   *
   * Loading a remote bigWig is a few round trips and parsing a 9.5 MB GTF is a
   * third of a second; a card that stays empty for either is one the user drops
   * the file onto twice.
   *
   * **An id that is already here is the same row being begun again**, and it
   * replaces that row *in place* rather than joining it. An id is the handle
   * everything else in the application holds a row by — `remove`, `restyle`,
   * `place`, every hit box the lanes hand back — so two rows sharing one is not
   * two tracks: it is one track listed twice, where deleting either deletes
   * both. Two callers hand an id in ({@link AnnotationLoader.restore} from
   * session storage, {@link AnnotationLoader.carry} from the file that was open
   * before), and nothing stops the same rows arriving down both roads — a
   * reload followed by re-opening the same map did exactly that, and put every
   * track on the card twice, each one saying its file had been put down.
   * Replacing keeps the row's *slot* as well, so a carried row does not jump to
   * the bottom of the list on the way through.
   */
  begin(options: {
    card: AnnotationCard
    kind: AnnotationKind
    source: AnnotationSource | { kind: 'derived'; name: string }
    id?: string
    label?: string
    placement?: Partial<Placement>
    style?: AnnotationEntry['style']
    /**
     * Whether the row is drawn, for a row that has been here before.
     *
     * Absent for a new one, which is shown: a track nobody asked to hide is a
     * track you have just added. Handed in by the two callers that are bringing
     * a row *back* — out of storage, or across from the file that was open
     * before — where it is a decision the reader already made. Left out, a
     * hidden track came back drawn every time the row was begun again, which on
     * an `.mcool` is every change of resolution: the same file at another level
     * is a fresh open, and the tracks are restored around it.
     */
    visible?: boolean
    /**
     * What the session's own map does with this row, for a row that has been
     * here before — see {@link StoredEntry.lead}.
     *
     * Absent, which is every fresh import, means the line below: the lead draws
     * it at the track's own placement, with no patch. `null` means the lead does
     * not draw it at all, and is the one thing a restore could not say before —
     * so a track a reader had moved onto the third replicate came back on the
     * first as well, every time the row was begun again.
     */
    lead?: StoredEntry['lead']
    /** The other row over the same file; see {@link AnnotationEntry.partner}. */
    partner?: string
  }): AnnotationEntry {
    const placement =
      options.placement === undefined
        ? placementOn('bottom')
        : normalisePlacement(options.placement)
    // An id handed in is reserved before anything is minted, so a row restored
    // out of storage cannot have its id handed to the next file dropped.
    const wanted = options.id
    if (wanted !== undefined) reserveAnnotationId(wanted)
    const entry: AnnotationEntry = {
      id: wanted ?? mintAnnotationId(),
      card: options.card,
      kind: options.kind,
      label: options.label ?? cleanLabel(options.source.name),
      source: options.source,
      status: 'loading',
      visible: options.visible ?? true,
      // One edge and not four: four copies of one track is four times the ink
      // for no more information. The **bottom** edge, because that is where a
      // track is read: every genome browser ever built stacks them horizontally
      // under a ruler, and a coverage profile turned on its side has to be read
      // with your head tilted. The other three are still there — the location
      // row moves a track to any of them, and a file dropped on an edge of the
      // map lands there — it is simply not what "add a track" should mean.
      placement,
      // A file dropped on an edge arrives already turned the right way round,
      // for the reason {@link place} turns one that is moved: beside the map a
      // lane grows *away* from the matrix unless it is flipped, and a reader
      // who aimed at that edge is asking for a lane to read beside the map, not
      // one to read away from it. Which edges that is, and why the horizontal
      // ones are not among them, is `laneStartsFlipped`'s. A style handed in
      // wins — that is a restored row, carrying a decision already made.
      style:
        options.style ??
        (() => {
          const base = defaultStyle(options.kind, this.nextColour())
          const side = sideOf(placement)
          return side !== 'neither' && laneStartsFlipped(side)
            ? { ...base, flip: !base.flip }
            : base
        })(),
      ...(options.partner === undefined ? {} : { partner: options.partner }),
    }
    // Only a *handed-in* id can already be here — a minted one is reserved past
    // everything this session has seen — and one that is, is this row arriving a
    // second time down a second road.
    const held = wanted !== undefined && this.items.some((row) => row.id === wanted)
    this.items = held
      ? this.items.map((row) => (row.id === entry.id ? entry : row))
      : [...this.items, entry]
    // An imported track is drawn on the session's own map, which is what it has
    // always meant. The entry's own `placement` is the *default* a new lane is
    // given — on this map now, and on any other map the reader puts it on later
    // — and the lane is where it is actually drawn.
    //
    // Except where the row is *returning* and says otherwise. A `null` is a
    // reader who took this track off the session's own map, and an object is one
    // who gave it edges or a range there of its own; both are decisions already
    // made, and re-placing over them is what made the deck's arrangement the one
    // part of a workspace that did not come back.
    // A structure is a row and never a lane (§25): its picture is the deck's
    // structure cell, and a chain of beads drawn as boxes along an edge is a
    // solid bar saying nothing. Unplaced from the start, so the stacks never
    // see it and the location control has nothing to offer it.
    this.lanes =
      options.lead === null || options.kind === 'structure'
        ? unplace(this.lanes, entry.id, LEAD_MAP)
        : place(this.lanes, entry.id, LEAD_MAP, options.lead?.placement ?? entry.placement)
    if (options.lead != null && options.lead.style !== undefined) {
      const held = laneOf(this.lanes, entry.id, LEAD_MAP)
      const style = options.lead.style
      if (held !== undefined) {
        this.lanes = this.lanes.map((lane) => (lane === held ? { ...lane, style } : lane))
      }
    }
    this.changed()
    return entry
  }

  /** Merge a patch into one row. A patch for an id that has gone is a no-op. */
  update(id: string, patch: Partial<AnnotationEntry>): void {
    let hit = false
    this.items = this.items.map((entry) => {
      if (entry.id !== id) return entry
      hit = true
      return { ...entry, ...patch }
    })
    if (hit) this.changed()
  }

  /**
   * Draw one row on a different edge, and turn its axis to face the map.
   *
   * Which way a lane's values grow is not a preference — it is a reading
   * direction, and the two axes answer it differently: a horizontal lane grows
   * up the page wherever it is, and a vertical one grows towards the matrix
   * ({@link laneStartsFlipped}). So a lane moving between two edges that give
   * different answers has to be turned on the way, or it arrives reading
   * backwards from every other lane on the stack it joins.
   *
   * A **toggle** and not an assignment, which is the whole reason this is a
   * method rather than a default. A reader who deliberately hung a bottom track
   * from its ceiling has said something about that track; setting `flip` from
   * the edge would throw that away on the way across and again on the way back.
   * Toggling preserves it: a pre-flipped bottom track becomes an unflipped
   * right-hand one, and moving it home restores exactly what was there.
   *
   * A track drawn on *two* has one `flip` and two readings, so there is no
   * answer that is right for both stacks — on the way to two it keeps whatever
   * it had, and the reader decides. On the way back to one it is turned from the
   * edge it was last on alone ({@link readingEdge}), which is what makes a move
   * in two presses — the new edge on, the old one off — arrive the way a move in
   * one does.
   */
  place(id: string, placement: Partial<Placement>): void {
    const entry = this.byId(id)
    if (entry === undefined) return
    const whole = normalisePlacement(placement)
    const was = this.readingEdge(id, LEAD_MAP, entry.placement)
    const now = sideOf(whole)
    this.remember(id, LEAD_MAP, was)
    this.remember(id, LEAD_MAP, now)
    const turned =
      was !== 'neither' && now !== 'neither' && laneStartsFlipped(was) !== laneStartsFlipped(now)
    // The lead's own lane follows, because this control *is* the lead's. A
    // companion's placement is its own — see {@link placeAt}, which is what a
    // drag on a companion's edge goes through.
    //
    // **Before** the row's update, which is what announces the move: the lane
    // was set after it, so every listener — the Tracks card's edge buttons, and
    // the write to session storage — read the lane as it was before the press,
    // and a pressed edge stayed unlit until something else changed.
    this.lanes = place(this.lanes, id, LEAD_MAP, whole)
    this.update(id, {
      placement: whole,
      ...(turned ? { style: { ...entry.style, flip: !entry.style.flip } } : {}),
    })
  }

  /**
   * The same move, made **on one map** rather than on the track.
   *
   * {@link place} is the lead's control and writes the *track's* default
   * placement, which is right for the row in the Tracks card and for the
   * session's own map. It is the wrong door for a gesture made on a companion:
   * dragging a lane's handle from the left of the third replicate to underneath
   * it rewrote the track's default and moved the **lead's** lane, so the track
   * appeared below the first map and stayed exactly where it was on the one the
   * hand was over. §18.5 says a computed track is a track like any other, and
   * `annotations/placement.ts` says an edge is a property of the *lane*; this is
   * the one call that makes both true at once.
   *
   * A track not drawn on that map yet gets a lane, which is the same gesture
   * arriving from the other direction: a row carried from the Tracks card onto
   * the third replicate's edge, or a lane carried off another map by its grip,
   * is a reader saying *put it there*. It arrives turned for that edge exactly
   * as a move from the track's own edge would turn it — the track's `flip` is
   * a fact about *that* edge, so it is the edge the new lane is coming from.
   * It used to arrive unturned, which drew a bottom track carried onto a
   * companion's left edge growing into the map while every other lane on that
   * edge grew away from it.
   *
   * The turn {@link place} performs is performed here too, and as a **lane
   * override** — `flip` is one of the two fields a lane may differ on precisely
   * because which way a lane grows is a fact about the edge it is on, and the
   * edge is the lane's (`annotations/placement.ts`'s `LANE_OVERRIDES`).
   */
  placeAt(id: string, map: MapId, placement: Partial<Placement>): void {
    if (map === LEAD_MAP) {
      this.place(id, placement)
      return
    }
    const entry = this.byId(id)
    if (entry === undefined) return
    const lane = laneOf(this.lanes, id, map)
    const whole = normalisePlacement(placement)
    const was =
      lane === undefined
        ? this.readingEdge(id, LEAD_MAP, entry.placement)
        : this.readingEdge(id, map, lane.placement)
    const now = sideOf(whole)
    // The edge it reads for, then the edge it is on: a lane new to this map
    // reads for the track's own edge until it is on one of its own alone.
    this.remember(id, map, was)
    this.remember(id, map, now)
    const turned =
      was !== 'neither' && now !== 'neither' && laneStartsFlipped(was) !== laneStartsFlipped(now)
    this.lanes = place(this.lanes, id, map, whole)
    if (!turned) {
      this.changed()
      return
    }
    // Read through the cascade, so a lane that has said nothing about `flip` —
    // or one that is new here — turns away from whatever its *track* says
    // rather than from `false`.
    const flip = (lane === undefined ? entry.style : resolveStyle(entry.style, lane)).flip === true
    // Announces on its own, which is why nothing follows it.
    this.overrideOn(id, map, { flip: !flip })
  }

  /**
   * The edge a lane's `flip` reads for: the one edge it is on — or, on two, the
   * one it was last on **alone**.
   *
   * A lane on two edges has one `flip` and two readings, so which of them the
   * flip was set for is history rather than state. And the history is what the
   * commonest move there is needs: the location marks move a track in two
   * presses — the new edge on, then the old one off — and between them the
   * track is on both. Read from its placement alone, that step came from
   * *neither* edge, nothing was turned, and a track moved from under the map to
   * its left arrived growing into the map where one moved in a single gesture
   * grew away from it (§8.9).
   *
   * Kept for the session only: after a reload a lane on two edges keeps its
   * flip through a move off one of them, as it always did.
   */
  private readingEdge(track: string, map: MapId, placement: Placement): LaneEdge | 'neither' {
    const side = sideOf(placement)
    if (side !== 'neither') return side
    return this.alone.get(`${track} ${map}`) ?? 'neither'
  }

  /** Note the one edge a lane is on alone, for {@link readingEdge}; a lane on several is not noted. */
  private remember(track: string, map: MapId, side: LaneEdge | 'neither'): void {
    if (side !== 'neither') this.alone.set(`${track} ${map}`, side)
  }

  /** Merge a patch into one row's style. */
  restyle(id: string, patch: Partial<AnnotationEntry['style']>): void {
    const entry = this.byId(id)
    if (entry === undefined) return
    this.update(id, { style: { ...entry.style, ...patch } })
  }

  /**
   * The same patch into several rows' styles, announced **once**.
   *
   * What the Tracks card's batch box writes through (§8.1): a limit typed for
   * twelve ticked tracks is one change, and twelve calls to {@link restyle}
   * were twelve writes to session storage and twelve rounds of every listener
   * — the card, the lanes and the workspace — for the reader's one gesture.
   * Ids that have gone are skipped, as `restyle` skips one.
   *
   * The patch may be a function of each row's style, for a setting that keeps
   * part of what the row had: *auto* on a batch keeps each row's own manual
   * pair for when it leaves auto again, as a row's own button does.
   */
  restyleEach(
    ids: readonly string[],
    patch:
      | Partial<AnnotationEntry['style']>
      | ((style: AnnotationEntry['style']) => Partial<AnnotationEntry['style']>),
  ): void {
    const wanted = new Set(ids)
    let hit = false
    this.items = this.items.map((entry) => {
      if (!wanted.has(entry.id)) return entry
      hit = true
      const change = typeof patch === 'function' ? patch(entry.style) : patch
      return { ...entry, style: { ...entry.style, ...change } }
    })
    if (hit) this.changed()
  }

  /**
   * Turn every turned axis back — what the 1D browser needs.
   *
   * A lane beside the map's right edge grows *outward*, away from the matrix,
   * unless it is flipped, so it is drawn flipped ({@link place}). The browser
   * has no map to be beside — every lane there is a horizontal one under a
   * ruler — so a track that came from that edge arrives hanging from its
   * ceiling, which is not what anybody chose.
   *
   * A *toggle*, and therefore its own inverse: the same call puts the picture
   * back on the way to the map, and a track deliberately hung from its ceiling
   * keeps that decision through both trips. The set it acts on is the tracks
   * drawn on exactly one edge, and only the edges whose reading disagrees with
   * the browser's — a track on two has one `flip` and two readings, so there is
   * no answer that is right for both stacks and it is left alone, exactly as
   * {@link place} leaves it.
   */
  turnAxesForBrowser(): void {
    let hit = false
    this.items = this.items.map((entry) => {
      const side = this.readingEdge(entry.id, LEAD_MAP, entry.placement)
      if (side === 'neither' || !laneStartsFlipped(side)) return entry
      hit = true
      return { ...entry, style: { ...entry.style, flip: !entry.style.flip } }
    })
    if (hit) this.changed()
  }

  /**
   * Take a row out, and with it anything computed from it.
   *
   * The cascade is not a courtesy. A derived row holds no data — it names two
   * other rows and reads whatever they have in hand (`annotations/derived.ts`) —
   * so an operand that is removed leaves a lane that can never draw again,
   * keeping its name, its colour and its place in the stack while showing
   * nothing. Removing it is the only outcome that is not a lie; the alternative
   * of refusing to remove the operand is worse, since it makes an ordinary row
   * undeletable for a reason the reader cannot see.
   */
  remove(id: string): void {
    const before = this.items.length
    const gone = new Set([id])
    // Iterated to a fixed point, because a derived row may itself be an operand:
    // a ratio of two ratios is a reasonable thing to build, and one pass would
    // leave the outer one orphaned.
    for (;;) {
      const next = this.items.filter(
        (entry) =>
          !gone.has(entry.id) &&
          entry.derivedFrom !== undefined &&
          (gone.has(entry.derivedFrom.a) || gone.has(entry.derivedFrom.b)),
      )
      if (next.length === 0) break
      for (const entry of next) gone.add(entry.id)
    }
    this.items = this.items
      .filter((entry) => !gone.has(entry.id))
      // A BAM's two rows point at each other (§8.13), and closing one leaves
      // the other holding an id nothing answers to. Cleared rather than left to
      // be ignored on read: the link is what the settings card offers to write
      // through, and a row that still claims a partner would be offering to
      // change a lane that is not on screen.
      .map((entry) =>
        entry.partner !== undefined && gone.has(entry.partner)
          ? { ...entry, partner: undefined }
          : entry,
      )
    // A lane naming a track that has gone would draw nothing and hold a slot in
    // every stack it was in, so the placements go with the import.
    this.lanes = this.lanes.filter((lane) => !gone.has(lane.track))
    if (this.items.length !== before) this.changed()
  }

  /**
   * Put one row at a new position in **its own card's** list.
   *
   * `to` indexes the card's own list, and the other card's rows keep the
   * absolute slots they had: the two are interleaved in `items` by load order,
   * and a reorder of one is not an event in the other. Out-of-range indices
   * clamp rather than throw — a drop past the last row means "last", which is
   * what the gesture looked like.
   *
   * **Nothing on screen reorders through this any more**, and that is worth
   * stating rather than leaving to be rediscovered. Every drag — the card's rows,
   * the browser's lanes, the map's lane stacks — resolves its target by
   * *identity* and calls {@link moveTo}, because a position in what is being
   * looked at is not a position in a card's list: a stack beside the map holds
   * the tracks that are visible, ready and on that edge, so one hidden row made a
   * card-local index land a slot early and put the last slot out of reach. This
   * stays because a card-local reorder is a coherent thing for a store to offer;
   * it is not the thing a lane drag wants.
   */
  move(id: string, to: number): void {
    const entry = this.byId(id)
    if (entry === undefined) return
    const list = this.forCard(entry.card)
    const from = list.findIndex((row) => row.id === id)
    const target = Math.max(0, Math.min(list.length - 1, to))
    if (from < 0 || from === target) return
    list.splice(target, 0, ...list.splice(from, 1))
    // Refill this card's slots from the reordered list, in slot order.
    let next = 0
    this.items = this.items.map((row) => (row.card === entry.card ? list[next++] : row))
    this.changed()
  }

  /**
   * Put one row at a position in the **whole** list.
   *
   * What every drag in the application means: the reader is looking at one
   * order and moving a row within it. A global move keeps the relative order of
   * everything it steps over, so a per-edge lane stack beside the map reorders
   * as its reader expects even though the index is over the whole list — which
   * is why the lane drags resolve a slot to the *entry* in it and then ask for
   * that entry's position here, rather than handing a slot number to
   * {@link move}.
   */
  moveTo(id: string, to: number): void {
    const from = this.items.findIndex((row) => row.id === id)
    if (from < 0) return
    const target = Math.max(0, Math.min(this.items.length - 1, to))
    if (from === target) return
    const next = [...this.items]
    next.splice(target, 0, ...next.splice(from, 1))
    this.items = next
    this.changed()
  }

  clear(): void {
    if (this.items.length === 0) return
    this.items = []
    this.lanes = []
    this.changed()
  }

  subscribe(listener: AnnotationListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /**
   * The autoscale groups in force, as `group name → the entries in it`.
   *
   * Only non-empty names, and only tracks: a group of one is the same thing as
   * no group, and the card offers the control on nothing else.
   */
  scaleGroups(): Map<string, AnnotationEntry[]> {
    const out = new Map<string, AnnotationEntry[]>()
    for (const entry of this.items) {
      if (!hasTrackControls(entry.kind) || entry.style.group === '') continue
      const bucket = out.get(entry.style.group)
      if (bucket === undefined) out.set(entry.style.group, [entry])
      else bucket.push(entry)
    }
    return out
  }

  private changed(): void {
    this.persist()
    const snapshot = this.items
    for (const listener of this.listeners) listener(snapshot)
  }

  private persist(): void {
    if (this.options.persist === false) return
    remember(
      this.uri,
      STORE_SCOPE,
      this.items
        .filter(persistable)
        .map((entry) => toStored(entry, laneOf(this.lanes, entry.id, LEAD_MAP))),
    )
    remember(this.uri, LANES_SCOPE, this.parkedFor())
  }

  /**
   * Every lane that is on a companion, in the shape {@link homes} keeps.
   *
   * The live lanes and the parked ones in one list, because from the outside
   * they are one fact — *where the reader put this track* — and which of the two
   * a given lane is in depends only on whether its map happens to be on screen
   * at this instant. Persisting only `homes` would write down the tracks whose
   * maps had been *closed* and forget the ones still open, which is exactly
   * backwards.
   *
   * Keyed by file and track, so a lane that is both live and parked — the same
   * file open in a cell *and* remembered from a closed one — is written once,
   * with the live placement winning.
   */
  parkedFor(): StoredLane[] {
    const out = new Map<string, StoredLane>()
    for (const home of this.homes) out.set(`${home.uri} ${home.track}`, home)
    for (const lane of this.lanes) {
      if (lane.map === LEAD_MAP) continue
      const uri = this.mapFiles.get(lane.map)
      // A map that left before it had opened anything: nothing to key on, which
      // is the same case {@link keepMaps} declines to record.
      if (uri === undefined) continue
      out.set(`${uri} ${lane.track}`, {
        track: lane.track,
        uri,
        placement: lane.placement,
        // The same question `keepMaps` asks: would putting this lane back have
        // to borrow a lead lane, or does the reader already have one there?
        borrowedLead: laneOf(this.lanes, lane.track, LEAD_MAP) === undefined,
        ...(lane.style === undefined ? {} : { style: lane.style }),
      })
    }
    return [...out.values()]
  }

  /**
   * Adopt an arrangement a previous visit wrote down.
   *
   * A **seed**, not a restore: nothing is placed here. The lanes go into the
   * parking, and {@link adoptHome} — which already runs once per render for
   * every live cell — puts each one back at the moment a panel opens the file it
   * belongs to. So a companion that comes back gets its tracks, one that does
   * not leaves them on the lead, and neither case needs a second code path.
   *
   * Existing entries win: this is called on the way up, and anything already
   * parked was parked by *this* session, which is newer than the record.
   */
  seedHomes(homes: readonly StoredLane[]): void {
    if (homes.length === 0) return
    const held = new Set(this.homes.map((home) => `${home.uri} ${home.track}`))
    this.homes = [
      ...this.homes,
      ...homes.filter((home) => !held.has(`${home.uri} ${home.track}`)),
    ]
  }

  /** What a previous visit remembered about where the tracks were drawn. */
  static storedLanes(uri: string): StoredLane[] {
    const raw = recall<unknown>(uri, LANES_SCOPE)
    if (!Array.isArray(raw)) return []
    return (raw as unknown[]).filter(isStoredLane)
  }

  /**
   * What a previous visit to this file left behind, validated.
   *
   * Untrusted input, exactly like the URL hash: a session outlives the build
   * that wrote it, so every field is checked and a row that fails is dropped
   * rather than repaired into something the renderers would choke on.
   */
  static stored(uri: string): StoredEntry[] {
    const raw = recall<unknown>(uri, STORE_SCOPE)
    if (!Array.isArray(raw)) return []
    // Two rows under one id is corruption rather than two tracks — see
    // {@link AnnotationStore.begin} — and a session written by a build that
    // could produce it is still in a reader's `sessionStorage`. Dropping the
    // twin on the way out is what lets a reload recover instead of coming back
    // doubled for ever.
    const seen = new Set<string>()
    const rows: StoredEntry[] = []
    for (const value of raw) {
      if (!isStoredEntry(value) || seen.has(value.id)) continue
      seen.add(value.id)
      // The one field normalised on the way out rather than checked in the
      // guard: an unreadable `lead` costs a lane its edges, and refusing the row
      // over it would cost the import. See {@link readLead}.
      const { lead: raw, ...rest } = value
      const lead = readLead(raw)
      const row = lead === undefined ? rest : { ...rest, lead }
      // The second field normalised here rather than checked in the guard, and
      // for the opposite reason to `lead`'s: this one has a *safe* reading of
      // every malformed value, so clamping it costs nothing and refusing the
      // row would cost the file. The guard checks only that `style` is an
      // object, which is enough to hand a renderer a negative MAPQ floor or a
      // colouring it has never heard of — see {@link readStyleOf}.
      rows.push(
        row.style.reads === undefined &&
          row.style.features === undefined &&
          row.style.structure === undefined
          ? row
          : {
              ...row,
              style: {
                ...row.style,
                ...(row.style.reads === undefined
                  ? {}
                  : { reads: readStyleOf(row.style.reads) }),
                // The same treatment for the same reason (§8.16): a colouring
                // this build has never heard of is a string, and a string is
                // what a renderer would try to read a column by.
                ...(row.style.features === undefined
                  ? {}
                  : { features: featureStyleOf(row.style.features, row.kind) }),
                // …and a third time for a model's controls (§25), where the
                // unclamped values are a radius of a million and an opacity a
                // renderer would draw as more than opaque.
                ...(row.style.structure === undefined
                  ? {}
                  : { structure: structureStyleOf(row.style.structure) }),
              },
            },
      )
    }
    return rows
  }
}

const STORE_SCOPE = 'annotations'

/**
 * Where the tracks were drawn, when the answer is not "on the lead".
 *
 * Its own scope rather than a field on {@link StoredEntry}, because a track is
 * on 0..N maps — each with its own placement *and* its own optional style patch
 * — and one `map` string on the entry could express neither. See
 * `annotations/placement.ts`.
 */
const LANES_SCOPE = 'deck:lanes'

/**
 * An entry worth remembering: one that finished loading from a nameable source.
 *
 * A **derived** row is not one, and saying so here is what stops it coming back
 * as something it never was. It is computed from two other rows
 * (`annotations/derived.ts`) and holds no bytes and no recipe that
 * {@link StoredEntry} can carry — so it used to fall through {@link toStored}'s
 * last arm and be written as `{ kind: 'local' }`, which restored a *detached
 * local file* under the derived row's label: a row offering to re-open a file
 * that has never existed, on a disk where it cannot be found. Losing the row
 * across a reload is the smaller wrong, and it is the honest one until there is
 * a stored shape that can name an operation and its two operands.
 */
function persistable(entry: AnnotationEntry): boolean {
  if (entry.source.kind === 'derived') return false
  return entry.status === 'ready' || entry.status === 'detached'
}

/**
 * @param lead The track's lane on the session's own map, or `undefined` where
 *   it has none — which is a fact worth writing down rather than an absence.
 *   See {@link StoredEntry.lead}.
 */
function toStored(entry: AnnotationEntry, lead: Lane | undefined): StoredEntry {
  return {
    id: entry.id,
    card: entry.card,
    kind: entry.kind,
    label: entry.label,
    source:
      entry.source.kind === 'remote'
        ? {
            kind: 'remote',
            name: entry.source.name,
            url: entry.source.url,
            // Only where it was named. A guessed sidecar is re-derived on every
            // load; a named one is the only way to index a presigned URL, and
            // losing it across a reload reopens a BAM that cannot be read.
            ...(entry.source.index === undefined ? {} : { index: entry.source.index }),
          }
        : entry.source.kind === 'computed'
          ? {
              kind: 'computed',
              name: entry.source.name,
              task: entry.source.task,
              recipe: entry.source.recipe,
              framing: entry.source.framing,
            }
          : // A column of the open file's own tables (§8.12). Two strings are
            // the whole of it, and they are enough to draw the row again
            // without asking the reader for anything — the file they name is
            // the file that is open.
            entry.source.kind === 'metadata'
            ? {
                kind: 'metadata',
                name: entry.source.name,
                table: entry.source.table,
                column: entry.source.column,
              }
            : // `local` and `detached`, which are one case here on purpose: a
              // detached row *is* a local file whose handle this browser no
              // longer holds, and writing it as one is what brings it back with
              // its colours and its limits, waiting to be pointed at the same
              // file again (§8.6). `derived` never reaches this arm — see
              // {@link persistable}. The `File` itself is not written, and nor
              // is `index`: neither survives storage, so a restored row asks
              // for the pair again.
              { kind: 'local', name: entry.source.name },
    visible: entry.visible,
    placement: entry.placement,
    style: entry.style,
    // Written only where it says something. A track drawn on the lead at its
    // own placement with no patch is the overwhelming majority of rows, and
    // stamping `lead` onto every one of them would put a second copy of
    // `placement` in every workspace file for the benefit of the few that
    // differ. `null` — off the lead entirely — is the one absence that has to
    // be spelled, because absence already means the opposite.
    ...(lead === undefined
      ? { lead: null }
      : lead.style === undefined && samePlacement(lead.placement, entry.placement)
        ? {}
        : { lead: { placement: lead.placement, ...(lead.style === undefined ? {} : { style: lead.style }) } }),
    ...(entry.primary === true ? { primary: true } : {}),
    ...(entry.partner === undefined ? {} : { partner: entry.partner }),
  }
}

/** Whether two placements light the same edges. */
function samePlacement(a: Placement, b: Placement): boolean {
  return LANE_EDGES.every((edge) => a[edge] === b[edge])
}

/** Every kind, from the one place that lists them (`annotations/types.ts`). */
const KINDS: readonly AnnotationKind[] = ANNOTATION_KINDS
const CARDS: AnnotationCard[] = ['linear', 'overlay', 'synthetic', 'metadata', 'structure']

function isStoredEntry(value: unknown): value is StoredEntry {
  if (typeof value !== 'object' || value === null) return false
  const row = value as Record<string, unknown>
  if (typeof row['id'] !== 'string' || typeof row['label'] !== 'string') return false
  if (!KINDS.includes(row['kind'] as AnnotationKind)) return false
  if (!CARDS.includes(row['card'] as AnnotationCard)) return false
  const source = row['source']
  if (typeof source !== 'object' || source === null) return false
  const kind = (source as Record<string, unknown>)['kind']
  if (kind !== 'local' && kind !== 'remote' && kind !== 'computed' && kind !== 'metadata') {
    return false
  }
  // Same reason as `index` below: stored state is untrusted input, and a
  // `partner` that is not a string would be compared against row ids and
  // written through to by the settings card.
  const partner = row['partner']
  if (partner !== undefined && typeof partner !== 'string') return false
  // Stored state outlives the build that wrote it and reaches here from a share
  // link, so it is untrusted input. An `index` that is not a string would be
  // handed to `fetch` as a URL.
  const index = (source as Record<string, unknown>)['index']
  if (index !== undefined && typeof index !== 'string') return false
  // A metadata row that lost either half of its address names no column, and a
  // row that names no column can only come back as an empty lane.
  if (kind === 'metadata') {
    const named = source as Record<string, unknown>
    if (typeof named['table'] !== 'string' || typeof named['column'] !== 'string') return false
  }
  // A computed row that lost its recipe is not a row that can be recomputed,
  // and a Recompute button that cannot is worse than no row at all.
  if (kind === 'computed') {
    const row2 = source as Record<string, unknown>
    if (typeof row2['task'] !== 'string') return false
    if (typeof row2['recipe'] !== 'object' || row2['recipe'] === null) return false
  }
  return typeof row['style'] === 'object' && row['style'] !== null
}

/**
 * The lead's lane, read out of a stored row.
 *
 * Three legal states and a fourth that is corruption — absent, `null`, an object
 * naming a placement, and anything else — and the fourth is normalised to
 * *absent* rather than dropping the row. Losing this field costs a lane its
 * edges; losing the row loses the file it names, which is the whole import.
 * `undefined` is returned for both absent and unreadable, which is right: the
 * two mean the same thing to every reader of it.
 */
function readLead(value: unknown): StoredEntry['lead'] {
  if (value === null) return null
  if (typeof value !== 'object') return undefined
  const row = value as Record<string, unknown>
  const placement = row['placement']
  if (typeof placement !== 'object' || placement === null) return undefined
  const style = row['style']
  return {
    placement: normalisePlacement(placement as Partial<Placement>),
    ...(typeof style === 'object' && style !== null
      ? { style: style as NonNullable<StoredEntry['lead']>['style'] }
      : {}),
  }
}

/** Which stack a placement puts a track in, if it puts it in exactly one. */
function sideOf(placement: Placement): LaneEdge | 'neither' {
  const on = LANE_EDGES.filter((edge) => placement[edge])
  return on.length === 1 ? on[0] : 'neither'
}

/**
 * A file name as a track label: no directory, no suffix, and no `.bw` left on
 * the end of a name that is going to sit in a 16 rem column.
 *
 * Double suffixes go too (`.gtf.gz`), and only the ones this app recognises —
 * truncating at the last dot would turn `Yeast_ChIP_Pol2-vs-input` into
 * `Yeast_ChIP_Pol2-vs`.
 */
export function cleanLabel(name: string): string {
  const base = name.split('/').pop() ?? name
  return base.replace(
    /\.(bw|bigwig|bigWig|bb|bigbed|gtf|gff3?|bed|bedpe|vcf|bam|narrowPeak|broadPeak|gappedPeak|peaks|bdg|bedgraph|wig|tsv|txt|fa|fasta|fna|fas|g3d|3dg|bed3d)(\.gz)?$/i,
    '',
  )
}
