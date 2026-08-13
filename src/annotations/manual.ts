/**
 * Marks the reader draws themselves (spec §8.1).
 *
 * Nothing here comes from a file, which is the whole point: this is the card
 * that turns a view into a figure. A line says *look at this coordinate*; an
 * arrowhead says *this pixel*; a rectangle says *this block of contacts*. All
 * three are stated in (contig, base pair) rather than in pixels or bins, so they
 * survive a zoom, a change of resolution in an `.mcool`, and being placed in one
 * view and read in another.
 */

import { recall, remember } from '../state/UiMemory'

/** A genomic point, as the pointing mark kinds are anchored by. */
export interface ManualPoint {
  contig: string
  bp: number
}

/**
 * A stretch of one sequence: what each side of a {@link ManualRect} is.
 *
 * Ordered — `from <= to` — because a box dragged from its bottom-right corner is
 * the same box as one dragged from its top-left, and a mark that remembered
 * which corner the hand started at would draw nothing for half of them.
 * {@link orderedSpan} settles it once, for every way in.
 */
export interface ManualSpan {
  contig: string
  from: number
  to: number
}

/** Two coordinates on one sequence, put in order and rounded to whole bases. */
export function orderedSpan(contig: string, one: number, two: number): ManualSpan {
  const from = Math.round(Math.min(one, two))
  const to = Math.round(Math.max(one, two))
  return { contig, from, to }
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

/**
 * A box on the map: an extent down the rows by an extent across the columns.
 *
 * The mark that says *this block of contacts* rather than *this coordinate* or
 * *this cell*, and the reason it is two independent spans rather than one span
 * and a ratio is that the three things people box on a contact map are not the
 * same shape. `a === b` is a square on the diagonal — a domain, a compartment
 * bin. `a` and `b` apart and equally wide is the off-diagonal square of contacts
 * between two loci. `a` and `b` apart and *unequal* is the case a square could
 * not state at all: a locus against a whole arm, an insulated boundary against
 * everything downstream of it. Any ratio, on or off the diagonal, one mark.
 *
 * Drawn as an outline for the reason `render/overlays.ts` opens with: the reader
 * is looking at what is inside the box in order to judge it, and a filled box
 * answers the question by hiding it.
 */
export interface ManualRect {
  id: string
  /** `rect` rather than `box`: it is the shape's name in every drawing API here. */
  kind: 'rect'
  /** Its extent down the row axis. */
  a: ManualSpan
  /** Its extent across the column axis. */
  b: ManualSpan
  colour: string
}

export type ManualMark = ManualLine | ManualArrowhead | ManualRect

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

  get rects(): ManualRect[] {
    return this.items.filter((mark): mark is ManualRect => mark.kind === 'rect')
  }

  /** The colour the next mark gets: the palette, cycled by how many exist. */
  nextColour(): string {
    return MANUAL_PALETTE[this.items.length % MANUAL_PALETTE.length]
  }

  add(mark: ManualMark): void {
    this.items = [...this.items, mark]
    this.changed()
  }

  /**
   * Change one mark in place.
   *
   * The patch is what every kind shares, which is the colour. The three kinds'
   * geometry fields collide by name and not by type — an arrowhead's `a` is a
   * point where a rectangle's is a span — so a patch claiming to take either
   * would be a patch that checks neither. A mark put down in the wrong place is
   * removed and put down again.
   */
  update(id: string, patch: { colour?: string }): void {
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

function isSpan(value: unknown): value is ManualSpan {
  if (typeof value !== 'object' || value === null) return false
  const span = value as Record<string, unknown>
  return (
    typeof span['contig'] === 'string' &&
    Number.isFinite(span['from']) &&
    Number.isFinite(span['to'])
  )
}

function isMark(value: unknown): value is ManualMark {
  if (typeof value !== 'object' || value === null) return false
  const mark = value as Record<string, unknown>
  if (typeof mark['id'] !== 'string' || typeof mark['colour'] !== 'string') return false
  if (mark['kind'] === 'line') {
    return ['vertical', 'horizontal', 'both'].includes(String(mark['axis'])) && isPoint(mark['at'])
  }
  if (mark['kind'] === 'rect') return isSpan(mark['a']) && isSpan(mark['b'])
  return mark['kind'] === 'arrowhead' && isPoint(mark['a']) && isPoint(mark['b'])
}

/**
 * A number of base pairs, however the reader wrote it: `120000`, `120,000`,
 * `120 kb`, `1.53 Mb`. `null` for anything that is not one, or is negative.
 *
 * Separators are stripped because a coordinate copied out of this app's own
 * readout has them: `fmt.int` writes `1,531,933`, and refusing to read back what
 * the page just wrote would be a small cruelty. `kb`/`Mb` suffixes are taken
 * too, for the same reason — the tooltip says `1.53 Mb`.
 */
function parseBases(text: string): number | null {
  const match = /^(-?\d+(?:\.\d+)?)(kb|mb|bp)?$/i.exec(text.replace(/[,_\s]/g, ''))
  if (match === null) return null
  const unit = (match[2] ?? '').toLowerCase()
  const scale = unit === 'kb' ? 1e3 : unit === 'mb' ? 1e6 : 1
  const bp = Number(match[1]) * scale
  return Number.isFinite(bp) && bp >= 0 ? Math.round(bp) : null
}

/**
 * Where the sequence name ends: the **last** colon, so `NODE_1:2:5000` names
 * `NODE_1:2`. Assemblies really do have colons in their contig names.
 */
function splitContig(text: string): { contig: string; rest: string } | null {
  const trimmed = text.trim()
  const at = trimmed.lastIndexOf(':')
  if (at <= 0) return null
  const contig = trimmed.slice(0, at).trim()
  return contig === '' ? null : { contig, rest: trimmed.slice(at + 1) }
}

/** `I:120000` or `I:120,000` → a point, or `null`. */
export function parsePoint(text: string): ManualPoint | null {
  const split = splitContig(text)
  if (split === null) return null
  const bp = parseBases(split.rest)
  return bp === null ? null : { contig: split.contig, bp }
}

/**
 * `I:120000-180000` → a span, or `null`.
 *
 * The **en dash** is taken as well as the hyphen, because this app writes one:
 * the readout says `120,000–180,000` and a reader pasting back what the page
 * showed them is doing the obvious thing. Ends are put in order rather than
 * refused, since a box is a box whichever corner it was drawn from.
 */
export function parseSpan(text: string): ManualSpan | null {
  const split = splitContig(text)
  if (split === null) return null
  const parts = split.rest.split(/[-–—]/)
  if (parts.length !== 2) return null
  const from = parseBases(parts[0])
  const to = parseBases(parts[1])
  return from === null || to === null ? null : orderedSpan(split.contig, from, to)
}

/** A point, written the way {@link parsePoint} reads it back. */
export function formatPoint(point: ManualPoint): string {
  return `${point.contig}:${Math.round(point.bp)}`
}

/** A span, written the way {@link parseSpan} reads it back. */
export function formatSpan(span: ManualSpan): string {
  return `${span.contig}:${Math.round(span.from)}-${Math.round(span.to)}`
}
