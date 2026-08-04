/**
 * Marks the reader draws themselves (spec §8.1).
 *
 * Nothing here comes from a file, which is the whole point: this is the card
 * that turns a view into a figure. A line says *look at this coordinate*; an
 * arrowhead says *this pixel*. Both are stated in (contig, base pair) rather
 * than in pixels or bins, so they survive a zoom, a change of resolution in an
 * `.mcool`, and being placed in one view and read in another.
 */

import { recall, remember } from '../state/UiMemory'

/** A genomic point, as both mark kinds are anchored by. */
export interface ManualPoint {
  contig: string
  bp: number
}

/** Which guide lines a {@link ManualLine} draws. */
export type LineAxis = 'vertical' | 'horizontal' | 'both'

export interface ManualLine {
  id: string
  kind: 'line'
  axis: LineAxis
  at: ManualPoint
  colour: string
}

/**
 * An arrowhead pointing at one pixel of the map.
 *
 * Two anchors, one per axis, so the same mark covers both cases the reader asked
 * for: `a === b` puts it on the diagonal, where it calls out a domain corner,
 * and `a !== b` puts it off the diagonal, where it calls out a loop. The glyph
 * is the same either way, because the gesture is — *this cell* — and having two
 * shapes for it would only raise the question of which one meant what.
 */
export interface ManualArrowhead {
  id: string
  kind: 'arrowhead'
  /** Where it sits on the row axis. */
  a: ManualPoint
  /** Where it sits on the column axis. */
  b: ManualPoint
  colour: string
}

export type ManualMark = ManualLine | ManualArrowhead

/** The palette hand-drawn marks cycle through: strong, and not the track set. */
export const MANUAL_PALETTE = ['#111318', '#c0392b', '#1f5fa9', '#0f8a5f'] as const

let nextId = 1

export function mintMarkId(): string {
  return `m${nextId++}`
}

export type ManualListener = (marks: readonly ManualMark[]) => void

/**
 * The marks on one file, with the same session persistence the annotation store
 * has (§8.6).
 *
 * Simpler than that store in one way that matters: a mark has no bytes behind
 * it, so nothing can arrive detached. What is written is what comes back.
 */
export class ManualStore {
  private items: ManualMark[]
  private readonly listeners = new Set<ManualListener>()

  constructor(private readonly uri: string) {
    this.items = ManualStore.stored(uri)
    // Ids come back from storage; minting one that collides with them would
    // make two marks indistinguishable to every update and delete.
    for (const mark of this.items) {
      const number = Number(mark.id.slice(1))
      if (Number.isFinite(number) && number >= nextId) nextId = number + 1
    }
  }

  get marks(): readonly ManualMark[] {
    return this.items
  }

  get lines(): ManualLine[] {
    return this.items.filter((mark): mark is ManualLine => mark.kind === 'line')
  }

  get arrowheads(): ManualArrowhead[] {
    return this.items.filter((mark): mark is ManualArrowhead => mark.kind === 'arrowhead')
  }

  /** The colour the next mark gets: the palette, cycled by how many exist. */
  nextColour(): string {
    return MANUAL_PALETTE[this.items.length % MANUAL_PALETTE.length]
  }

  add(mark: ManualMark): void {
    this.items = [...this.items, mark]
    this.changed()
  }

  update(id: string, patch: Partial<ManualLine> & Partial<ManualArrowhead>): void {
    this.items = this.items.map((mark) =>
      mark.id === id ? ({ ...mark, ...patch } as ManualMark) : mark,
    )
    this.changed()
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

  subscribe(listener: ManualListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private changed(): void {
    remember(this.uri, SCOPE, this.items)
    for (const listener of this.listeners) listener(this.items)
  }

  /** What a previous visit left, validated — stored state is untrusted input. */
  static stored(uri: string): ManualMark[] {
    const raw = recall<unknown>(uri, SCOPE)
    if (!Array.isArray(raw)) return []
    return raw.filter(isMark)
  }
}

const SCOPE = 'manual-annotations'

function isPoint(value: unknown): value is ManualPoint {
  if (typeof value !== 'object' || value === null) return false
  const point = value as Record<string, unknown>
  return typeof point['contig'] === 'string' && Number.isFinite(point['bp'])
}

function isMark(value: unknown): value is ManualMark {
  if (typeof value !== 'object' || value === null) return false
  const mark = value as Record<string, unknown>
  if (typeof mark['id'] !== 'string' || typeof mark['colour'] !== 'string') return false
  if (mark['kind'] === 'line') {
    return ['vertical', 'horizontal', 'both'].includes(String(mark['axis'])) && isPoint(mark['at'])
  }
  return mark['kind'] === 'arrowhead' && isPoint(mark['a']) && isPoint(mark['b'])
}

/**
 * `I:120000` or `I:120,000` → a point, or `null`.
 *
 * Separators are stripped because a coordinate copied out of this app's own
 * readout has them: `fmt.int` writes `1,531,933`, and refusing to read back what
 * the page just wrote would be a small cruelty. `kb`/`Mb` suffixes are taken
 * too, for the same reason — the tooltip says `1.53 Mb`.
 */
export function parsePoint(text: string): ManualPoint | null {
  const trimmed = text.trim()
  const at = trimmed.lastIndexOf(':')
  if (at <= 0) return null
  const contig = trimmed.slice(0, at).trim()
  const raw = trimmed.slice(at + 1).trim().replace(/[,_\s]/g, '')
  const match = /^(-?\d+(?:\.\d+)?)(kb|mb|bp)?$/i.exec(raw)
  if (contig === '' || match === null) return null
  const unit = (match[2] ?? '').toLowerCase()
  const scale = unit === 'kb' ? 1e3 : unit === 'mb' ? 1e6 : 1
  const bp = Number(match[1]) * scale
  return Number.isFinite(bp) && bp >= 0 ? { contig, bp: Math.round(bp) } : null
}

/** A point, written the way {@link parsePoint} reads it back. */
export function formatPoint(point: ManualPoint): string {
  return `${point.contig}:${Math.round(point.bp)}`
}
