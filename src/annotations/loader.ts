/**
 * Turning a dropped file into a row on a card.
 *
 * Separate from the cards because three callers need it — the drop areas, the
 * URL box, and the one-click demo loader — and because the interesting part is
 * not the DOM but the routing: a *zone* says what the reader meant, the file's
 * bytes say what it is, and where those disagree the file wins and the reader is
 * told (spec §8.3).
 */

import type { AnnotationStore } from './store'
import type { AnnotationCard, AnnotationEntry, AnnotationKind, AnnotationSource, StoredEntry } from './types'
import type { AnnotationClient } from './worker/client'
import type { DetectedFormat, WireSource } from './worker/protocol'

/** Which drop area a file landed on. */
export type DropZone = 'gtf' | 'track' | 'segments' | 'pairs'

export class AnnotationLoader {
  constructor(
    private readonly store: AnnotationStore,
    private readonly client: AnnotationClient,
    /** The map's contig names, for the §8.2 overlap report. */
    private readonly mapContigs: string[],
  ) {}

  /** Load one or more dropped files onto a card. */
  addFiles(card: AnnotationCard, zone: DropZone, files: readonly File[]): void {
    for (const file of files) {
      this.begin(card, zone, { kind: 'local', file, name: file.name })
    }
  }

  /** Load a file named by URL — a published track, or one of the demo files. */
  addUrl(card: AnnotationCard, zone: DropZone, url: string, label?: string): void {
    const trimmed = url.trim()
    if (trimmed === '') return
    const name = trimmed.split('/').pop() ?? trimmed
    this.begin(card, zone, { kind: 'remote', url: trimmed, name }, label)
  }

  /**
   * Re-open what a previous visit left in session storage (§8.6).
   *
   * A remote entry is fetched again, since its URL is all that was ever needed.
   * A local one cannot be — no browser re-reads a dropped file without a fresh
   * gesture — so it comes back `detached`, holding its colours and limits and
   * waiting for the same file to be dropped on it again.
   */
  restore(stored: readonly StoredEntry[]): void {
    for (const row of stored) {
      if (row.source.kind === 'remote' && row.source.url !== undefined) {
        this.begin(
          row.card,
          zoneOf(row.kind),
          { kind: 'remote', url: row.source.url, name: row.source.name },
          row.label,
          row,
        )
        continue
      }
      this.store.begin({
        card: row.card,
        kind: row.kind,
        source: { kind: 'detached', name: row.source.name } as never,
        id: row.id,
        label: row.label,
        placement: row.placement,
        style: row.style,
      })
      this.store.update(row.id, {
        status: 'detached',
        source: { kind: 'detached', name: row.source.name },
        summary: 'dropped file — re-open it to draw it again',
        visible: row.visible,
      })
    }
  }

  /**
   * Re-attach a detached row to the file it was made from.
   *
   * The id is kept, so the row does not jump to the bottom of the card and the
   * settings the reader chose stay attached to the thing they chose them for.
   */
  reattach(id: string, file: File): void {
    const entry = this.store.byId(id)
    if (entry === undefined) return
    this.store.update(id, {
      status: 'loading',
      source: { kind: 'local', file, name: file.name },
      error: undefined,
    })
    void this.read(entry.card, id, { kind: 'local', file, name: file.name })
  }

  private begin(
    card: AnnotationCard,
    zone: DropZone,
    source: AnnotationSource,
    label?: string,
    stored?: StoredEntry,
  ): AnnotationEntry {
    const entry = this.store.begin({
      card,
      // The placeholder takes the zone's kind; the file's own format corrects it
      // a moment later. Guessing here is only about what the row *looks* like
      // while it loads.
      kind: stored?.kind ?? kindOfZone(zone),
      source,
      ...(stored === undefined ? {} : { id: stored.id, placement: stored.placement, style: stored.style }),
      ...(label === undefined ? {} : { label }),
    })
    void this.read(card, entry.id, toWire(source))
    return entry
  }

  /**
   * Read a file and settle what it is.
   *
   * The zone the file landed on is deliberately not consulted here: it decided
   * only what the placeholder row looked like while this was in flight. What
   * comes back decides the rest (§8.3).
   */
  private async read(card: AnnotationCard, id: string, source: WireSource): Promise<void> {
    try {
      const result = await this.client.request<'load'>({
        kind: 'load',
        entry: id,
        source,
        mapContigs: this.mapContigs,
      })
      const kind = kindFor(card, result.format)
      if (kind === null) {
        this.store.update(id, { status: 'error', error: refusal(card, result.format) })
        this.client.drop(id)
        return
      }
      // Exactly one gene model (§8.1). Checked here rather than at the drop,
      // because until the bytes are read nothing knows this file is one.
      if (kind === 'gtf' && this.store.entries.some((row) => row.kind === 'gtf' && row.id !== id)) {
        this.store.update(id, {
          status: 'error',
          error:
            'One gene model at a time: a second drawn over the first is a smear rather than a ' +
            'comparison. Remove the loaded one first.',
        })
        this.client.drop(id)
        return
      }
      this.store.update(id, {
        kind,
        status: 'ready',
        summary: result.summary,
        overlap: result.overlap,
        ...(result.payload === undefined ? {} : { payload: result.payload }),
        ...(result.fileExtent === undefined ? {} : { fileExtent: result.fileExtent }),
        error: undefined,
      })
    } catch (err) {
      this.store.update(id, {
        status: 'error',
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }
}

/** A `File` is structured-cloneable, so a local file crosses by reference (§11). */
function toWire(source: AnnotationSource): WireSource {
  return source.kind === 'local'
    ? { kind: 'local', file: source.file, name: source.name }
    : { kind: 'remote', url: source.url, name: source.name }
}

/** What a zone's placeholder row calls itself while it loads. */
function kindOfZone(zone: DropZone): AnnotationKind {
  return zone === 'pairs' ? 'pairs' : zone === 'track' ? 'track' : zone === 'gtf' ? 'gtf' : 'segments'
}

/** The zone a loaded kind belongs to, for a restore or a re-attach. */
function zoneOf(kind: AnnotationKind): DropZone {
  return kind === 'gtf' ? 'gtf' : kind === 'track' ? 'track' : kind === 'pairs' ? 'pairs' : 'segments'
}

/**
 * What a card does with a file of this format, or `null` if it does nothing.
 *
 * The **format decides**, not the zone. Dropping a BED on the tracks area is a
 * near-miss the app can simply absorb; dropping a bedpe on a card that draws
 * lanes is not, because there is no lane a pair belongs in.
 */
export function kindFor(card: AnnotationCard, format: DetectedFormat): AnnotationKind | null {
  if (card === 'linear') {
    if (format === 'bigwig') return 'track'
    if (format === 'gtf') return 'gtf'
    // A bigBed is read whole and parsed as the BED it holds, so from here it is
    // one: boxes on a lane, and a BED12 with exons draws them.
    if (format === 'bed' || format === 'bigbed') return 'segments'
    return null
  }
  if (format === 'bed' || format === 'bigbed') return 'segments'
  if (format === 'bedpe') return 'pairs'
  return null
}

/** Why a card cannot take this file, and which card can. */
function refusal(card: AnnotationCard, format: DetectedFormat): string {
  if (format === 'sizes') {
    return (
      'This is a chrom.sizes: two columns naming an assembly. It declares a genome rather than ' +
      'annotating one, so it opens a browser rather than joining this map.'
    )
  }
  if (format === 'hdf5') {
    return 'This is a contact map, not an annotation. Open it as a file, or drop it to compare.'
  }
  if (card === 'linear') {
    return 'This is a paired file. Pairs are drawn on the map, not beside it — drop it on Map overlays.'
  }
  if (format === 'bigwig') {
    return 'A bigWig is a value track, which is drawn beside the map — drop it on Linear annotations.'
  }
  return 'A gene model is a linear annotation, which is drawn beside the map — drop it on Linear annotations.'
}
