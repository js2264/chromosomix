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
import { formatLocus, formatPosition, typedPosition } from '../genome/assembly'

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

/**
 * Why a mark is not drawn, where it is not (§8.1).
 *
 * A mark is drawn by default and carries nothing; a hidden one says which of
 * two hands put it away, because the two are taken back differently:
 *
 * - `own` — its own eye: the card's row, the model's key, *Hide this line* on a
 *   picture's menu. It stays hidden until that mark is shown again.
 * - `all` — with the rest: the eye over the list, `A`, *Hide every mark*, or
 *   another mark shown alone. *Show the marks* brings back exactly these.
 *
 * So hiding everything to look at the pixels under them and showing them again
 * puts back the picture as it was — the one mark a reader had put away for a
 * figure stays put away, where a single flag would have shown it with the rest.
 *
 * Kept on the mark, not beside the list, so it goes wherever the mark goes —
 * the tab's memory, a saved session, a link, a reopen at another resolution —
 * with no field of its own to forget to carry.
 */
export type MarkHidden = 'own' | 'all'

export interface ManualLine {
  id: string
  kind: 'line'
  axis: LineAxis
  at: ManualPoint
  colour: string
  /** Absent while it is drawn — see {@link MarkHidden}. */
  hidden?: MarkHidden
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
  /** Absent while it is drawn — see {@link MarkHidden}. */
  hidden?: MarkHidden
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
  /** Absent while it is drawn — see {@link MarkHidden}. */
  hidden?: MarkHidden
}

export type ManualMark = ManualLine | ManualArrowhead | ManualRect

/** Whether a mark is drawn: hidden by neither hand ({@link MarkHidden}). */
export function isShown(mark: ManualMark): boolean {
  return mark.hidden === undefined
}

/** A mark with no reason to be hidden, as a new one is: the field gone, not `undefined`. */
function shownMark(mark: ManualMark): ManualMark {
  if (mark.hidden === undefined) return mark
  const { hidden: _hidden, ...rest } = mark
  return rest as ManualMark
}

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

  /**
   * Every mark, drawn or not: what the card lists, the export writes and a
   * reopen carries. A picture reads {@link shown}, or the three below.
   */
  get marks(): readonly ManualMark[] {
    return this.items
  }

  /** The marks a picture draws: every one a reader has not put away (§8.1). */
  get shown(): ManualMark[] {
    return this.items.filter(isShown)
  }

  /**
   * The drawn lines, arrowheads and rectangles, kind by kind.
   *
   * **Drawn**, not every one held: these three are what the map, the lanes, a
   * tracks cell and the 1D browser paint from, so a hidden mark leaves every
   * one of those pictures by one rule, here, rather than by a filter each
   * surface would have to remember — and a figure saved with a mark hidden is
   * the figure with no such mark, down to the band the lanes keep for anchors.
   */
  get lines(): ManualLine[] {
    return this.items.filter((mark): mark is ManualLine => mark.kind === 'line' && isShown(mark))
  }

  get arrowheads(): ManualArrowhead[] {
    return this.items.filter((mark): mark is ManualArrowhead => mark.kind === 'arrowhead' && isShown(mark))
  }

  get rects(): ManualRect[] {
    return this.items.filter((mark): mark is ManualRect => mark.kind === 'rect' && isShown(mark))
  }

  /** Whether any mark is drawn — what the eye over the list and `A` are lit by. */
  get anyShown(): boolean {
    return this.items.some(isShown)
  }

  /** How many are put away, by either hand. */
  get hiddenCount(): number {
    return this.items.length - this.shown.length
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
   * Many marks in one change, as an imported file brings them — each given an
   * id and the next colour, and one notification rather than one per row.
   *
   * A mark already on the file is not added twice: importing the file you just
   * exported, or the same file again, is a thing readers do by accident, and a
   * second copy of a mark is drawn exactly on top of the first so nobody could
   * see it was there to remove. *Already there* is the place, not the colour or
   * the id, since the file carries neither. Returns how many went in.
   */
  addAll(marks: ReadonlyArray<DistributiveOmit<ManualMark, 'id' | 'colour'>>): number {
    const seen = new Set(this.items.map(placeOf))
    const added: ManualMark[] = []
    for (const mark of marks) {
      const key = placeOf(mark)
      if (seen.has(key)) continue
      seen.add(key)
      const colour = MANUAL_PALETTE[(this.items.length + added.length) % MANUAL_PALETTE.length]
      added.push({ ...mark, id: mintMarkId(), colour } as ManualMark)
    }
    if (added.length > 0) {
      this.items = [...this.items, ...added]
      this.changed()
    }
    return added.length
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

  /**
   * Put a mark somewhere else: the same mark — its id, its colour, its place
   * in the list — at the coordinates the reader typed over its row.
   *
   * The whole mark rather than a patch, for the reason {@link update} gives:
   * the three kinds' geometry fields collide by name and not by type, so the
   * caller hands over a mark its own type checked. A kind that differs from
   * the one held is refused, since a line typed over an arrowhead's row is a
   * different mark, and that is a remove and an add.
   */
  reshape(next: ManualMark): void {
    const held = this.items.find((mark) => mark.id === next.id)
    if (held === undefined || held.kind !== next.kind) return
    // Its colour and whether it is drawn are the held mark's, not the editor's
    // copy of them: where a mark is and whether it is shown are two questions,
    // and a row typed over is answering the first.
    const moved = shownMark({ ...next, colour: held.colour } as ManualMark)
    const kept = held.hidden === undefined ? moved : ({ ...moved, hidden: held.hidden } as ManualMark)
    this.items = this.items.map((mark) => (mark.id === next.id ? kept : mark))
    this.changed()
  }

  // -------------------------------------------------------------------------
  // Drawn or not (§8.1)
  // -------------------------------------------------------------------------

  /**
   * Show or hide one mark by its own hand — its row's eye, its row on the
   * model's key, a picture's menu ({@link MarkHidden}'s `own`).
   *
   * Every other mark is left as it was, so a press on one row changes every
   * picture by that one mark. Shown, a mark loses either reason: one put away
   * with the rest and then shown from its own row is simply shown.
   */
  setShown(id: string, shown: boolean): void {
    this.restate((mark) => {
      if (mark.id !== id) return mark
      if (shown) return shownMark(mark)
      return mark.hidden === 'own' ? mark : ({ ...mark, hidden: 'own' } as ManualMark)
    })
  }

  /** Put every drawn mark away together (`all`), leaving the ones already away as they are. */
  hideAll(): void {
    this.restate((mark) => (mark.hidden === undefined ? ({ ...mark, hidden: 'all' } as ManualMark) : mark))
  }

  /**
   * Bring back the marks put away together — and only those, so a mark hidden
   * from its own row before stays hidden. Where none was put away that way,
   * every mark comes back: hidden one by one, *show the marks* is all of them.
   */
  showAll(): void {
    const together = this.items.some((mark) => mark.hidden === 'all')
    this.restate((mark) => (!together || mark.hidden === 'all' ? shownMark(mark) : mark))
  }

  /**
   * The eye over the list and `A`: hide what is drawn, or bring back what that
   * hid. Whether any mark is drawn afterwards.
   *
   * *Any* drawn mark makes it a hide, as the Groups card's eye does: a reader
   * who has put one mark away by hand and presses the eye for all of them means
   * the rest, not that one back.
   */
  toggleAll(): boolean {
    if (this.anyShown) this.hideAll()
    else this.showAll()
    return this.anyShown
  }

  /**
   * This mark alone: it is drawn and every other drawn mark is put away with
   * the rest — so *show the marks* undoes it. Asked of the one mark already
   * drawn alone, it is that undoing: the others come back, as a second
   * double-click on a sequence's key brings every sequence back (§25.5).
   */
  showAlone(id: string): void {
    const target = this.items.find((mark) => mark.id === id)
    if (target === undefined) return
    const alone = isShown(target) && this.items.every((mark) => mark.id === id || !isShown(mark))
    if (alone) {
      this.showAll()
      return
    }
    this.restate((mark) => {
      if (mark.id === id) return shownMark(mark)
      return mark.hidden === undefined ? ({ ...mark, hidden: 'all' } as ManualMark) : mark
    })
  }

  /** Write a change made mark by mark, and say so once — or not at all, where nothing moved. */
  private restate(next: (mark: ManualMark) => ManualMark): void {
    let moved = false
    const items = this.items.map((mark) => {
      const after = next(mark)
      if (after !== mark) moved = true
      return after
    })
    if (!moved) return
    this.items = items
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
    return raw.filter(isMark).map(knownVisibility)
  }
}

const SCOPE = 'manual-annotations'

/** `Omit` over each member of a union rather than over what they share. */
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never

/** A mark's geometry as one string: what two marks at the same place share. */
function placeOf(mark: DistributiveOmit<ManualMark, 'id' | 'colour'>): string {
  if (mark.kind === 'line') return `line ${mark.axis} ${formatPoint(mark.at)}`
  if (mark.kind === 'rect') return `rect ${formatSpan(mark.a)} ${formatSpan(mark.b)}`
  return `arrowhead ${formatPoint(mark.a)} ${formatPoint(mark.b)}`
}

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
 * A stored mark's reason to be hidden, where it is one this build knows — and
 * drawn otherwise. A mark nobody can show again is worse than one shown.
 */
function knownVisibility(mark: ManualMark): ManualMark {
  const hidden: unknown = mark.hidden
  return hidden === 'own' || hidden === 'all' ? mark : shownMark(mark)
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

/**
 * `I:120,001` or `I:120001` → a point, or `null`.
 *
 * **1-based**, as the row above the box prints the mark and as every locus box
 * in this application reads one (§26.1): the mark keeps the 0-based base it
 * names, which is what a line is drawn at and what its BED row is written from,
 * and the one subtraction is `typedPosition`'s. It was read as written — beside
 * rows printed the same way, so the card agreed with itself and a coordinate
 * copied off the map's readout landed one base to the right.
 */
export function parsePoint(text: string): ManualPoint | null {
  const split = splitContig(text)
  if (split === null) return null
  const base = parseBases(split.rest)
  return base === null ? null : { contig: split.contig, bp: typedPosition(base) }
}

/**
 * `I:120,001-180,000` → a span, or `null`.
 *
 * 1-based and inclusive, as {@link parsePoint} and for its reason: the first
 * base loses one and the last stays, which is the whole of the conversion to
 * the half-open span the mark keeps.
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
  const first = parseBases(parts[0])
  const last = parseBases(parts[1])
  if (first === null || last === null) return null
  return orderedSpan(split.contig, typedPosition(Math.min(first, last)), Math.max(first, last))
}

/**
 * A point, written the way {@link parsePoint} reads it back: the copy form of
 * §26.1, 1-based and ungrouped, which is what *Copy coordinates* puts on the
 * clipboard for a terminal or a spreadsheet.
 */
export function formatPoint(point: ManualPoint): string {
  return `${point.contig}:${Math.round(point.bp) + 1}`
}

/** A span, written the way {@link parseSpan} reads it back — the copy form, as {@link formatPoint}. */
export function formatSpan(span: ManualSpan): string {
  const [from, to] = shownSpan(span)
  return `${span.contig}:${from + 1}-${to}`
}

/**
 * A span's two ends as a reader is shown them: never empty.
 *
 * A box drawn inside one bin can have no width, and §26.1 has no way to write
 * one — `I:101-100` reads back as two bases the other way round. So it is shown
 * as the one base it is written to a BEDPE as (`annotations/export.ts`), which
 * is also what typing it back makes of it.
 */
function shownSpan(span: ManualSpan): [number, number] {
  const from = Math.round(span.from)
  return [from, Math.max(from + 1, Math.round(span.to))]
}

/**
 * A mark, as the reader reads it — 1-based, with grouped digits, which is what
 * every other coordinate on screen wears (§26.1).
 *
 * `formatPoint` and `formatSpan` write the ungrouped form their own boxes take
 * back, and that is what a *copy* wants (§26.1's last rule) — but this row is
 * read rather than pasted, and `I:120000` in a card whose placeholders say
 * `rows I:120,000` was the fifth spelling of a locus on one screen. The boxes
 * take the grouped form too, so nothing about the round trip is lost.
 */
export function describeMark(mark: ManualMark): string {
  if (mark.kind === 'line') {
    const glyph = mark.axis === 'vertical' ? '│' : mark.axis === 'horizontal' ? '─' : '┼'
    return `${glyph} ${pointLabel(mark.at)}`
  }
  if (mark.kind === 'rect') {
    const a = spanLabel(mark.a)
    const b = spanLabel(mark.b)
    // One extent for a box on the diagonal, which is what its form takes back.
    return a === b ? `▭ ${a}` : `▭ ${a} × ${b}`
  }
  const a = pointLabel(mark.a)
  const b = pointLabel(mark.b)
  return a === b ? `◤ ${a}` : `◤ ${a} × ${b}`
}

/**
 * A point as a reader reads it: `IV:1,200,001`, the base it names. Its box reads
 * it back (§26.1).
 *
 * Through `formatPosition`, the one writer of a base. It printed the number as
 * it is kept, 0-based and grouped by the reader's locale — one base before the
 * same position anywhere else on the screen, and with full stops in a German
 * browser.
 */
export function pointLabel(point: ManualPoint): string {
  return formatPosition(point.contig, Math.round(point.bp))
}

/** A span as a reader reads it: `IV:1,100,001-1,150,000`, through `formatLocus`. */
export function spanLabel(span: ManualSpan): string {
  const [start, end] = shownSpan(span)
  return formatLocus({ contig: span.contig, start, end })
}
