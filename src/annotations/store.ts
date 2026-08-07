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

import { laneGrowsInward } from '../render/lane'
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
import { LANE_EDGES, defaultStyle, normalisePlacement, placementOn } from './types'

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
    return this.items.filter(
      (entry) =>
        entry.card !== 'overlay' &&
        entry.visible &&
        entry.status === 'ready' &&
        entry.placement[edge],
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
      visible: true,
      // One edge and not four: four copies of one track is four times the ink
      // for no more information. The **bottom** edge, because that is where a
      // track is read: every genome browser ever built stacks them horizontally
      // under a ruler, and a coverage profile turned on its side has to be read
      // with your head tilted. The other three are still there — the location
      // row moves a track to any of them, and a file dropped on an edge of the
      // map lands there — it is simply not what "add a track" should mean.
      placement,
      // A file dropped on an edge arrives already turned the right way round,
      // for the reason {@link place} turns one that is moved: on half the edges
      // a lane grows *away* from the matrix unless it is flipped, and a reader
      // who aimed at an edge is asking for a lane to read beside the map, not
      // one to read away from it. A style handed in wins — that is a restored
      // row, which is carrying a decision already made.
      style:
        options.style ??
        (() => {
          const base = defaultStyle(options.kind, this.nextColour())
          const side = sideOf(placement)
          return side !== 'neither' && !laneGrowsInward(side)
            ? { ...base, flip: !base.flip }
            : base
        })(),
    }
    // Only a *handed-in* id can already be here — a minted one is reserved past
    // everything this session has seen — and one that is, is this row arriving a
    // second time down a second road.
    const held = wanted !== undefined && this.items.some((row) => row.id === wanted)
    this.items = held
      ? this.items.map((row) => (row.id === entry.id ? entry : row))
      : [...this.items, entry]
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
   * direction. Unflipped, a lane's values grow up the page or right across it,
   * whichever the conventional orientation of its axis is
   * ({@link laneGrowsInward}); which of those points *at* the matrix then
   * depends on the side, so on two of the four edges the same track grows
   * outward, away from the picture it is beside. Two stacks meeting at a corner
   * then disagree about which way is more. Turning the axis on the way across
   * puts the growth back towards the matrix and makes the pair read as one
   * picture.
   *
   * A **toggle** and not an assignment, which is the whole reason this is a
   * method rather than a default. A reader who deliberately hung a bottom track
   * from its ceiling has said something about that track; setting `flip` from
   * the edge would throw that away on the way across and again on the way back.
   * Toggling preserves it: a pre-flipped bottom track becomes an unflipped
   * right-hand one, and moving it home restores exactly what was there.
   *
   * Only between one edge and one other. A track drawn on *two* has one `flip`
   * and two readings, so there is no answer that is right for both stacks — it
   * keeps whatever it had, and the reader decides.
   */
  place(id: string, placement: Partial<Placement>): void {
    const entry = this.byId(id)
    if (entry === undefined) return
    const whole = normalisePlacement(placement)
    const was = sideOf(entry.placement)
    const now = sideOf(whole)
    const turned =
      was !== 'neither' && now !== 'neither' && laneGrowsInward(was) !== laneGrowsInward(now)
    this.update(id, {
      placement: whole,
      ...(turned ? { style: { ...entry.style, flip: !entry.style.flip } } : {}),
    })
  }

  /** Merge a patch into one row's style. */
  restyle(id: string, patch: Partial<AnnotationEntry['style']>): void {
    const entry = this.byId(id)
    if (entry === undefined) return
    this.update(id, { style: { ...entry.style, ...patch } })
  }

  /**
   * Turn every outward-facing axis round — what the 1D browser needs.
   *
   * On the top and right edges a lane grows *outward*, away from the matrix, so
   * it is drawn flipped: that is what makes the stacks meeting at a corner of
   * one figure agree about which way is more ({@link place}). The browser has no
   * corner and no map — every lane there is a bottom lane — so a track that came
   * from one of those edges arrives hanging from its ceiling, which is not what
   * anybody chose.
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
      const side = sideOf(entry.placement)
      if (side === 'neither' || laneGrowsInward(side)) return entry
      hit = true
      return { ...entry, style: { ...entry.style, flip: !entry.style.flip } }
    })
    if (hit) this.changed()
  }

  remove(id: string): void {
    const before = this.items.length
    this.items = this.items.filter((entry) => entry.id !== id)
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
      if (entry.kind !== 'track' || entry.style.group === '') continue
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
    remember(this.uri, STORE_SCOPE, this.items.filter(persistable).map(toStored))
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
      rows.push(value)
    }
    return rows
  }
}

const STORE_SCOPE = 'annotations'

/**
 * An entry worth remembering: one that finished loading from a nameable source.
 *
 * Never the 4C profile. It has no file behind it, so there is nothing a reload
 * could re-read; what it *is* a picture of — the anchor — is a gesture on a
 * block, and the block is gone. Remembering its colours alone would leave a
 * strip on screen that says 4C and is a picture of nothing.
 */
function persistable(entry: AnnotationEntry): boolean {
  return entry.kind !== 'viewpoint' && (entry.status === 'ready' || entry.status === 'detached')
}

function toStored(entry: AnnotationEntry): StoredEntry {
  return {
    id: entry.id,
    card: entry.card,
    kind: entry.kind,
    label: entry.label,
    source:
      entry.source.kind === 'remote'
        ? { kind: 'remote', name: entry.source.name, url: entry.source.url }
        : { kind: 'local', name: entry.source.name },
    visible: entry.visible,
    placement: entry.placement,
    style: entry.style,
    ...(entry.primary === true ? { primary: true } : {}),
  }
}

const KINDS: AnnotationKind[] = ['gtf', 'track', 'segments', 'pairs', 'sequence']
const CARDS: AnnotationCard[] = ['linear', 'overlay']

function isStoredEntry(value: unknown): value is StoredEntry {
  if (typeof value !== 'object' || value === null) return false
  const row = value as Record<string, unknown>
  if (typeof row['id'] !== 'string' || typeof row['label'] !== 'string') return false
  if (!KINDS.includes(row['kind'] as AnnotationKind)) return false
  if (!CARDS.includes(row['card'] as AnnotationCard)) return false
  const source = row['source']
  if (typeof source !== 'object' || source === null) return false
  const kind = (source as Record<string, unknown>)['kind']
  if (kind !== 'local' && kind !== 'remote') return false
  return typeof row['style'] === 'object' && row['style'] !== null
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
    /\.(bw|bigwig|bigWig|gtf|gff3?|bed|bedpe|narrowPeak|broadPeak|gappedPeak|peaks|tsv|txt|fa|fasta|fna|fas)(\.gz)?$/i,
    '',
  )
}
