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

import { recall, remember } from '../state/UiMemory'
import type {
  AnnotationCard,
  AnnotationEntry,
  AnnotationKind,
  AnnotationSource,
  StoredEntry,
} from './types'
import { defaultStyle } from './types'

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

export class AnnotationStore {
  private items: AnnotationEntry[] = []
  private readonly listeners = new Set<AnnotationListener>()

  constructor(private readonly uri: string) {}

  get entries(): readonly AnnotationEntry[] {
    return this.items
  }

  /** The rows one card shows, in load order. */
  forCard(card: AnnotationCard): AnnotationEntry[] {
    return this.items.filter((entry) => entry.card === card)
  }

  /** The rows that are loaded, visible, and drawn on `edge`. */
  drawnOn(edge: 'bottom' | 'right'): AnnotationEntry[] {
    return this.items.filter(
      (entry) =>
        entry.card === 'linear' &&
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
   */
  begin(options: {
    card: AnnotationCard
    kind: AnnotationKind
    source: AnnotationSource
    id?: string
    label?: string
    placement?: { bottom: boolean; right: boolean }
    style?: AnnotationEntry['style']
  }): AnnotationEntry {
    const entry: AnnotationEntry = {
      id: options.id ?? mintAnnotationId(),
      card: options.card,
      kind: options.kind,
      label: options.label ?? cleanLabel(options.source.name),
      source: options.source,
      status: 'loading',
      visible: true,
      // One edge and not both: two copies of one track is twice the ink for no
      // more information. The **right** edge, because the bottom is where the
      // coordinate axis, the block labels and the colourbar caption already are
      // — a stack of tracks there pushes the map up the page and competes with
      // the furniture, while the space beside it is empty in every view.
      placement: options.placement ?? { bottom: false, right: true },
      style: options.style ?? defaultStyle(options.kind, this.nextColour()),
    }
    this.items = [...this.items, entry]
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

  /** Merge a patch into one row's style. */
  restyle(id: string, patch: Partial<AnnotationEntry['style']>): void {
    const entry = this.byId(id)
    if (entry === undefined) return
    this.update(id, { style: { ...entry.style, ...patch } })
  }

  remove(id: string): void {
    const before = this.items.length
    this.items = this.items.filter((entry) => entry.id !== id)
    if (this.items.length !== before) this.changed()
  }

  /**
   * Put one row at a new position in **its own card's** list.
   *
   * The order is not decoration: {@link drawnOn} hands the lanes out in it, so
   * dragging a row up the card moves that track up the stack beside the map.
   * That is the whole reason the list is draggable — the alternative was
   * removing three tracks and dropping them again in the order you wanted.
   *
   * `to` indexes the card's own list, which is what the reader is looking at,
   * and the other card's rows keep the absolute slots they had: the two are
   * interleaved in `items` by load order, and a reorder of one is not an event
   * in the other. Out-of-range indices clamp rather than throw — a drop past the
   * last row means "last", which is what the gesture looked like.
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
   * What the panel's own drag means now that it shows every loaded file in one
   * list: the reader is looking at one order and moving a row within it. A
   * global move also keeps the relative order of everything it steps over, so
   * the per-edge lane stacks beside a map reorder exactly as they would have
   * under the card-local {@link move} — which the map's own lane drag still
   * uses, because there the reader is looking at one edge rather than at a list.
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
    return raw.filter(isStoredEntry)
  }
}

const STORE_SCOPE = 'annotations'

/** An entry worth remembering: one that finished loading from a nameable source. */
function persistable(entry: AnnotationEntry): boolean {
  return entry.status === 'ready' || entry.status === 'detached'
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
