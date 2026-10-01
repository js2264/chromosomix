/**
 * Places a reader saved, to come back to (spec §8.10).
 *
 * A bookmark is a **region and a bin size**, and it is worth being precise about
 * why both: the region says where to look and the bin size says at what grain,
 * because on a contact map those are two different questions and a reader who
 * found a loop at 1 kb has not found it at 20 kb. Nothing else is in it. Not a
 * zoom, not a colour scale, not which way the map was turned — those are how the
 * picture was *drawn* when the note was taken, and a bookmark that restored them
 * would be a saved screenshot rather than a saved place.
 *
 * Stated in (contig, base pair) like every other annotation in this app (§8.1),
 * so a bookmark taken at 1 kb means the same thing at 5 kb — which is the whole
 * point of carrying the bin size *separately* rather than baking it into the
 * coordinates.
 *
 * ## Why it lives here rather than in `localStorage`
 *
 * Session memory, keyed per file, exactly as the hand-drawn marks are: this is
 * the reader's train of thought through one dataset, not a preference about the
 * application. Two things make that liveable rather than lossy — the key is the
 * *file* and not the entry inside it, so changing resolution keeps the list
 * (`state/UiMemory.ts`), and the list reads and writes BED, so anything worth
 * keeping past today leaves as a file that every other genomics tool can read.
 */

import { recall, remember } from '../state/UiMemory'
import { typedPosition } from '../genome/assembly'
import { forEachRow, readHeader } from './parse'

/**
 * One saved place.
 *
 * `start` and `end` are **0-based half-open**, which is BED's convention and
 * `metacooler/range.ts`'s: a bookmark is written to a BED file and read back from
 * one, and a coordinate that changed base on the way through would be off by one
 * in whichever direction nobody checked.
 *
 * `end === start` is legal and means a point. A reader marking a loop anchor has
 * named a position rather than an interval, and the navigation copes: the zoom
 * has a floor in cells, so a zero-length window opens as far in as the grid can
 * usefully go.
 */
export interface Bookmark {
  id: string
  /**
   * What the list calls it. Empty is normal and not a hole: a bookmark taken off
   * the map has no name to take, and the row then reads as its coordinates —
   * which is the honest label and the one a reader recognises.
   */
  label: string
  contig: string
  start: number
  end: number
  /**
   * The bin size the map was open at, in base pairs.
   *
   * Absent for a bookmark that never had one — an import from BED, which is a
   * list of places and says nothing about grain. Going to one of those keeps
   * whatever resolution is open, which is the only answer that is not a guess.
   */
  binsize?: number
}

let nextId = 1

export function mintBookmarkId(): string {
  return `b${nextId++}`
}

export type BookmarkListener = (marks: readonly Bookmark[]) => void

/**
 * The bookmarks on one file, with the session persistence §8.6 gives every card.
 *
 * Deliberately the same shape as `ManualStore` — `add`, `remove`, `clear`,
 * `subscribe`, a static `stored` that validates — because they are the same kind
 * of object with the same lifetime, and a second idiom for it would be one more
 * thing to check when the two come to disagree.
 */
export class BookmarkStore {
  private items: Bookmark[]
  private readonly listeners = new Set<BookmarkListener>()

  constructor(private readonly uri: string) {
    this.items = BookmarkStore.stored(uri)
    // Ids come back from storage; minting one that collides would make two rows
    // indistinguishable to every delete.
    for (const mark of this.items) {
      const number = Number(mark.id.slice(1))
      if (Number.isFinite(number) && number >= nextId) nextId = number + 1
    }
  }

  get marks(): readonly Bookmark[] {
    return this.items
  }

  /**
   * Add one, or say it was already there.
   *
   * The duplicate check is what makes the button beside `go` safe to press
   * twice: a reader who cannot remember whether they saved this view will press
   * it again, and a second identical row is worse than no feedback at all.
   * Compared on the place and the grain rather than on the label, since those
   * are what the bookmark *is*.
   */
  add(mark: Bookmark): boolean {
    const same = this.items.find(
      (held) =>
        held.contig === mark.contig &&
        held.start === mark.start &&
        held.end === mark.end &&
        held.binsize === mark.binsize,
    )
    if (same !== undefined) return false
    this.items = [...this.items, mark]
    this.changed()
    return true
  }

  /** Add several, keeping the order they arrived in. Returns how many stuck. */
  addAll(marks: readonly Bookmark[]): number {
    let added = 0
    for (const mark of marks) if (this.add(mark)) added++
    return added
  }

  remove(id: string): void {
    const before = this.items.length
    this.items = this.items.filter((mark) => mark.id !== id)
    if (this.items.length !== before) this.changed()
  }

  clear(): void {
    if (this.items.length === 0) return
    this.items = []
    this.changed()
  }

  subscribe(listener: BookmarkListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private changed(): void {
    remember(this.uri, SCOPE, this.items)
    for (const listener of this.listeners) listener(this.items)
  }

  /** What a previous visit left, validated — stored state is untrusted input. */
  static stored(uri: string): Bookmark[] {
    const raw = recall<unknown>(uri, SCOPE)
    if (!Array.isArray(raw)) return []
    return raw.filter(isBookmark)
  }
}

const SCOPE = 'bookmarks'

function isBookmark(value: unknown): value is Bookmark {
  if (typeof value !== 'object' || value === null) return false
  const mark = value as Record<string, unknown>
  if (typeof mark['id'] !== 'string' || typeof mark['label'] !== 'string') return false
  if (typeof mark['contig'] !== 'string' || mark['contig'] === '') return false
  if (!Number.isFinite(mark['start']) || !Number.isFinite(mark['end'])) return false
  const binsize = mark['binsize']
  return binsize === undefined || (typeof binsize === 'number' && binsize > 0)
}

// ---------------------------------------------------------------------------
// Reading and writing a region
// ---------------------------------------------------------------------------

/** A place with no identity yet: what a string or a BED row resolves to. */
export interface Region {
  contig: string
  start: number
  end: number
}

/**
 * `chrI:100000-200000` → a region, or `null`: the region string a link carries,
 * read back.
 *
 * The digits as written, 0-based and half-open — {@link formatRegion}'s
 * inverse, and what the view reads a bookmark's `focus` with. What a *reader*
 * types is {@link parseTypedRegion}, which takes the same spellings and reads
 * them as the display form of §26.1.
 *
 * The same tolerances `parsePoint` has, and for the same reason: the string
 * pasted in here came out of this app's own readout or breadcrumb, both of which
 * write separators, and one of which writes `1.53 Mb`. A bare contig is refused
 * — its length is not known here, and a bookmark of "all of chromosome IV" is
 * what the region view's own box is for.
 *
 * A single position (`chrI:150000`) is a region of zero length, which is what a
 * loop anchor is.
 */
export function parseRegion(text: string): Region | null {
  const read = readRegion(text)
  if (read === null) return null
  return { contig: read.contig, start: read.start, end: read.end }
}

/**
 * What a reader typed into the Bookmarks card, as a place — read the way every
 * locus box in this application reads one (§26.1).
 *
 * **1-based and inclusive**, the display form and every spelling of it: the
 * card prints `II:120,001-180,000` for the window a map was framed on, and that
 * string typed back must save that same window. It used to be read as written,
 * 0-based, under rows printed 0-based too — so the card agreed with itself and
 * with nothing else on the screen: a locus copied off the breadcrumb, out of
 * IGV or out of a paper landed a base to the right of the place it names.
 *
 * {@link parseRegion}'s tolerances — separators, `kb` and `Mb`, `..`, a colon in
 * a name, the ends either way round — and then the conversion, which is
 * `genome/assembly.ts`'s and nobody else's: the first base loses one and the
 * last stays. One position is a place of no width *at that base*, as a loop
 * anchor is.
 */
export function parseTypedRegion(text: string): Region | null {
  const read = readRegion(text)
  if (read === null) return null
  const start = typedPosition(read.start)
  return { contig: read.contig, start, end: read.point ? start : read.end }
}

/** A region string's name and numbers as written, ordered; `point` where there was one. */
function readRegion(text: string): (Region & { point: boolean }) | null {
  const trimmed = text.trim()
  const at = trimmed.lastIndexOf(':')
  if (at <= 0) return null
  const contig = trimmed.slice(0, at).trim()
  if (contig === '') return null
  const body = trimmed.slice(at + 1).replace(/[,_\s]/g, '')
  // Split on the *last* dash, so a negative coordinate is a parse failure rather
  // than a silently reinterpreted range. `..` is taken too: it is what a reader
  // copying out of an Ensembl or IGV URL has in hand.
  const parts = body.includes('..') ? body.split('..') : splitRange(body)
  if (parts === null) return null
  const start = readBp(parts[0])
  const second = parts[1]
  const end = second === undefined ? start : readBp(second)
  if (start === null || end === null) return null
  return { contig, start: Math.min(start, end), end: Math.max(start, end), point: second === undefined }
}

function splitRange(body: string): [string, string?] | null {
  const at = body.lastIndexOf('-')
  if (at <= 0) return [body]
  return [body.slice(0, at), body.slice(at + 1)]
}

function readBp(raw: string): number | null {
  const match = /^(\d+(?:\.\d+)?)(kb|mb|bp)?$/i.exec(raw.trim())
  if (match === null) return null
  const unit = (match[2] ?? '').toLowerCase()
  const scale = unit === 'kb' ? 1e3 : unit === 'mb' ? 1e6 : 1
  const bp = Number(match[1]) * scale
  return Number.isFinite(bp) && bp >= 0 ? Math.round(bp) : null
}

/**
 * A region as the app's own region string, which is what a link carries.
 *
 * No separators and no units: this one is read by `metacooler/range.ts` at the
 * far end rather than by a person, and every character that has to survive a URL
 * hash is a character worth not spending.
 */
export function formatRegion(region: Region): string {
  return `${region.contig}:${Math.round(region.start)}-${Math.round(region.end)}`
}

// ---------------------------------------------------------------------------
// BED
// ---------------------------------------------------------------------------

/**
 * Regions from a BED file: the first three columns, plus the name if there is
 * one.
 *
 * Deliberately *not* `parseBed`. That builds a `FeatureSet` — exon blocks, thick
 * ranges, peak flavours, a per-contig index — because a track has to be drawn at
 * every zoom, and none of it is a bookmark. What a bookmark needs is the three
 * columns every flavour of BED agrees about, and reading only those means a
 * narrowPeak, a BEDPE's first mate, and a two-column-plus-header table from R
 * all import without a format question being asked.
 *
 * `skipped` counts rows that had no region in them, so the card can say so: a
 * file that produced four bookmarks out of forty rows has told the reader
 * something, and an import that silently keeps the four has not.
 */
export function regionsFromBed(text: string): { regions: Array<Region & { label: string }>; skipped: number } {
  const regions: Array<Region & { label: string }> = []
  const header = readHeader(text)
  let skipped = 0
  let first = true

  forEachRow(text, (columns) => {
    if (first && header !== null) {
      first = false
      return
    }
    first = false
    const contig = columns[0]
    const start = readInt(columns[1])
    const end = readInt(columns[2])
    if (contig === undefined || contig === '' || start === null || end === null) {
      skipped++
      return
    }
    const name = columns[3] !== undefined && columns[3] !== '.' ? columns[3] : ''
    regions.push({
      contig,
      start: Math.min(start, end),
      end: Math.max(start, end),
      label: name,
    })
  })

  return { regions, skipped }
}

function readInt(value: string | undefined): number | null {
  if (value === undefined || !/^\d+$/.test(value.trim())) return null
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}
