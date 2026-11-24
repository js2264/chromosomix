/**
 * The curation stage's contact map (SPECS §33.3): how densely every two
 * genomes meet — the evidence a merge, a link and a misplaced contig rest on —
 * and, closer, how densely the contigs of a few genomes meet, with the contigs
 * a suggestion would bring into them.
 *
 * **Two levels**, a crumb in their own bar. The **genome level**: one uniform
 * cell a genome in the stage's order, MAGs then elements, never the pool
 * (§7.4); a cell the lower bound of the two genomes' affinity, on a log scale
 * from the background, so a cell resting on a read pair or two is pale; the
 * diagonal a genome's own density, 1. The **close-up** (Enter, a double click
 * on the diagonal): the selected genomes' contigs genome by genome, longest
 * first, then a grey block of candidates — contigs an offered recruit or move
 * would bring into one of them — one cell a contig, observed over expected,
 * from the worker's `curationFocus`. Both are painted by `edit/paint.ts`, the
 * reference stage's painter, on paper: a contact map is a figure, its colours
 * made for ink on white, in either theme.
 *
 * The furniture is drawn over it every frame on one canvas that also takes the
 * hand: the bars (a genome's colour, its short name where a block is ten
 * pixels, a ◆ before an element's; a close-up's contigs as a staircase of their
 * lengths under their genomes' names), the selection (an accent outline, never
 * a wash), the genome lit in every pane (its row and column dashed), the
 * suggestions (a merge an L at its cell's corner, a link a ring, an unlink a
 * cross, in the accent over a halo, as large as a cell; the review's thicker,
 * with its number).
 *
 * The hand: a press on the diagonal or a bar selects a genome (a contig, close
 * up), off it the pair; ⌘ toggles, ⇧ extends along the order; a drag along
 * the diagonal or a bar selects the run; a drag from the selection carries it
 * (`ctx.startDrag`), and the stage's one drop grammar makes the step; a genome's
 * name on a close-up's bar selects its contigs. The wheel zooms at the pointer,
 * Space held (or the middle button) pans, `0` fits, `+` and `−` zoom.
 *
 * Every number the readout prints is the answer's, never a byte's.
 */

import type { StageInk } from '../../edit/draw'
import { readInk } from '../../edit/draw'
import { paintPicture, pictureColours, type PaintLevel } from '../../edit/paint'
import { FOCUS_PICTURE_CAP, focusContactsOf, pairRatio } from '../focus'
import { colormapColor, colormapCss, DEFAULT_UI_COLORMAP } from '../../render/colormaps'
import { Scale } from '../../render/scale'
import { figurePaper } from '../../ui/canvasPalette'
import { isMac, keyBadge, keyLabel, withKey } from '../../ui/commands'
import { el } from '../../ui/dom'
import { iconButton } from '../../ui/icons'
import { getTextScale, scaleFont, subscribeTextScale } from '../../ui/textScale'
import { fmt } from '../../units'
import type { CurationFocusResult, CurationStateResult } from '../../worker/curateProtocol'
import { lowerAffinity } from '../method'
import { displayPercent, type Cancellable, type CurateChange, type CurateSelection } from '../model'
import type { Suggestion } from '../suggest'
import type { CurateContext, CurateDropTarget, CurateFrame, CuratePane } from './context'
import {
  affinityText,
  affinityTicks,
  candidatesFor,
  cellMapOf,
  clampView,
  centredView,
  closeUpAxis,
  genomeAxis,
  genomeMap,
  isIdentity,
  lengthShare,
  pairOf,
  placeLabels,
  ratioText,
  ratioTicks,
  runsOf,
  sameUnits,
  spanAt,
  type CloseUpAxis,
  type GenomeAxis,
  type GenomeMap,
  type KeyTick,
  type Span,
} from './contactLayout'

/** How far a press travels before it is a drag, in CSS pixels. */
const DRAG_PX = 4
/** Within this many pixels of the diagonal a press is on it, where cells are small. */
const DIAGONAL_PX = 6
/** Cells at least this wide are hit as themselves: the diagonal is its own cells. */
const CELL_HIT_PX = 12
/** Names are written on a bar where a block is at least this wide. */
const NAME_PX = 10
/** A bar: its colour strip, the gap between it and the map, the gap before its names. */
const STRIP = 12
const STRIP_SMALL = 5
const GAP = 3
const NAMES_GAP = 4
/** The names' room on a bar: as wide as the widest short name, within these. */
const NAMES_MIN = 44
const NAMES_MAX = 112
/** The room an element's diamond takes before its name. */
const DIAMOND_ROOM = 9
/** Room around the map and its bars; past its far edges, room for a review's number. */
const PAD = 12
const PAD_FAR = 24
const PAD_SMALL = 6
/** The fewest units a view spans: genomes, and contigs close up. */
const LEAST_GENOMES = 3
const LEAST_CONTIGS = 6
/** Rules between genomes once a cell is this wide; contigs' hairlines close up. */
const GRID_PX = 14
const HAIRLINE_PX = 8
/** A link offered is a ring from this wide a cell, the cell's box under it; one held is drawn from this wide. */
const RING_PX = 10
const HELD_PX = 10
/** The most suggestion marks drawn at once, the surest first, besides those naming the selection. */
const MARKS_MOST = 64
/** The key: its size, in CSS pixels. */
const KEY_WIDTH = 168
const KEY_HEIGHT = 30
/** A double click within this long of a click that narrowed the selection opens what was selected before it. */
const DOUBLE_MS = 600

type Level = 'genomes' | 'contigs'

/** What a point of the pane is over. */
interface Hit {
  where: 'map' | 'top' | 'left' | null
  /** The units under it: the row and the column on the map; the unit along a bar, in both. */
  row: number
  col: number
  /** On the diagonal, whose unit is then `row`. */
  diagonal: boolean
  /** On a bar's names, past its strip. */
  names: boolean
  /**
   * Off the diagonal but within a few pixels of it, where cells are small: the
   * unit there, `-1` otherwise. A press reads the cell under it — a pair of
   * neighbours is the evidence most merges rest on — and a drag from it runs
   * along the diagonal; a drop takes it.
   */
  near: number
}

interface Modifiers {
  meta: boolean
  shift: boolean
}

/** A press of the hand, until it is let go. */
type Press =
  | { kind: 'pan'; pointer: number; x: number; y: number }
  | { kind: 'run'; pointer: number; x: number; y: number; moved: boolean; anchor: number; to: number; where: 'map' | 'top' | 'left'; mod: Modifiers; base: CurateSelection }
  | { kind: 'carry'; pointer: number; x: number; y: number; unit: number; mod: Modifiers }
  | { kind: 'cell'; pointer: number; x: number; y: number; row: number; col: number; near: number; mod: Modifiers }

/** The genome level as drawn: the answer, its axis and its picture. */
interface GenomesDrawn {
  answer: CurationStateResult
  axis: GenomeAxis
  map: GenomeMap
  colours: Uint32Array
  identity: Int32Array
}

/** The close-up as drawn: its axis, and the picture held read through it. */
interface CloseDrawn {
  answer: CurationStateResult
  axis: CloseUpAxis
  cellMap: Int32Array
  levels: PaintLevel[] | null
  colours: Uint32Array | null
  /** Whether any unit reads a cell of the picture held: none, while a new close-up is read. */
  reads: boolean
  least: number
  most: number
}

/** Where the map is drawn, and the view's units: one frame's geometry. */
interface Geometry {
  n: number
  x0: number
  x1: number
  y0: number
  y1: number
  /** CSS pixels a unit. */
  k: number
  X(unit: number): number
  Y(unit: number): number
}

/** The paper's ink: the light palette, whatever the theme — the map is a figure. */
let paperHeld: StageInk | null = null
function paperInk(): StageInk {
  paperHeld ??= readInk(figurePaper())
  return paperHeld
}

/** The colour of a cell with nothing in it: the colormap's foot, which the paper is. */
function groundColour(): number {
  const [r, g, b] = colormapColor(DEFAULT_UI_COLORMAP, 0)
  return ((0xff << 24) | (b << 16) | (g << 8) | r) >>> 0
}

/** A key with Shift, as this keyboard prints it: `keyLabel` knows ⌘ and Ctrl, not Shift. */
function shifted(key: string): string {
  return isMac() ? `⇧${keyLabel(key)}` : `Shift+${keyLabel(key)}`
}

function identity(n: number): Int32Array {
  return Int32Array.from({ length: n }, (_, u) => u)
}

function sameTarget(a: CurateDropTarget | null, b: CurateDropTarget | null): boolean {
  if (a === null || b === null) return a === b
  return JSON.stringify(a) === JSON.stringify(b)
}

function typing(target: EventTarget | null): boolean {
  const node = target as HTMLElement | null
  return node !== null && (node.tagName === 'INPUT' || node.tagName === 'TEXTAREA' || node.tagName === 'SELECT' || node.isContentEditable === true)
}

export class ContactPane implements CuratePane {
  readonly element: HTMLElement
  readonly title = 'contacts'
  private readonly head: HTMLElement
  private readonly crumbs: HTMLElement
  private readonly act: HTMLButtonElement
  private readonly keyTitle: HTMLElement
  private readonly keyRamp: HTMLCanvasElement
  private readonly plot: HTMLElement
  private readonly picture: HTMLCanvasElement
  private readonly overlay: HTMLCanvasElement
  private readonly note: HTMLElement
  private large = true
  private level: Level = 'genomes'
  // The view: one scale an axis, their spans kept equal.
  private readonly sx = new Scale([0, 1], 1)
  private readonly sy = new Scale([0, 1], 1)
  private units = 0
  private fitted = true
  /** The genome level's view while the close-up is open, to go back to. */
  private genomeView: { x: [number, number]; y: [number, number]; fitted: boolean } | null = null
  // The layout, in CSS pixels of the plot.
  private box = { width: 0, height: 0 }
  private map = { x: 0, y: 0, size: 0 }
  private bar = { size: 0, strip: STRIP, gap: GAP, names: 0 }
  private dpr = 1
  private layoutDirty = true
  private namesFor: { answer: CurationStateResult | null; font: string; width: number } = { answer: null, font: '', width: NAMES_MIN }
  // What is drawn.
  private genomes: GenomesDrawn | null = null
  private close: CloseDrawn | null = null
  private offered: Suggestion[] = []
  /** Each contig's surest offered recruit or move. */
  private bringing = new Map<number, Suggestion>()
  private indexOf = new Map<string, number>()
  // The close-up's genomes, its answer held and the one asked.
  private focusIds: string[] = []
  private focusContigs = new Map<string, number[]>()
  private held: CurationFocusResult | null = null
  private request: Cancellable<CurationFocusResult> | null = null
  private requested: Int32Array | null = null
  private closeNote: string | null = null
  private closeError: string | null = null
  // Painting.
  private image: ImageData | null = null
  private readonly ground = groundColour()
  private pictureDirty = true
  private keyDirty = true
  private frameId = 0
  // The hand.
  private press: Press | null = null
  private pointer: { x: number; y: number } | null = null
  private space = false
  private anchor: { level: Level; id: string | number } | null = null
  private lastClick: { at: number; before: CurateSelection } | null = null
  private dropLit: CurateDropTarget | null = null
  private dropRefused = false
  /** A drag in flight over the map: the genome level holds still under it. */
  private dragOver = false
  private said: string | null = null
  private featuredKey: string | null = null
  private disposed = false
  private readonly offs: Array<() => void> = []

  constructor(private readonly ctx: CurateContext) {
    this.crumbs = el('nav', { class: 'curate-crumbs', attrs: { 'aria-label': 'Where the contact map is' } })
    this.act = el('button', {
      class: 'btn btn-quiet curate-contact-act hidden',
      title: withKey('The contigs of the selected genomes, and those a suggestion would bring into them; a double click on the diagonal opens them too', 'enter'),
      attrs: { type: 'button' },
      on: { click: () => this.closeUp() },
    })
    this.act.append(el('span', { text: 'close-up' }), keyBadge('enter', { class: 'kbd-inline' }))
    this.keyTitle = el('span', { class: 'curate-key-title', text: 'affinity' })
    this.keyRamp = el('canvas', { class: 'curate-key-ramp', attrs: { role: 'img' } })
    const tools = el(
      'div',
      { class: 'curate-contact-tools' },
      iconButton('maximize', withKey('Show the whole map', '0'), () => this.fit(), { class: 'btn btn-icon', size: 14 }),
      iconButton('zoom-out', withKey('Zoom out', '-'), () => this.zoomBy(1.25), { class: 'btn btn-icon', size: 14 }),
      iconButton('zoom-in', withKey('Zoom in', '+'), () => this.zoomBy(0.8), { class: 'btn btn-icon', size: 14 }),
    )
    this.head = el(
      'div',
      { class: 'curate-contact-head' },
      this.crumbs,
      this.act,
      el('div', { class: 'curate-contact-key' }, this.keyTitle, this.keyRamp),
      tools,
    )
    this.picture = el('canvas', { class: 'curate-contact-picture', attrs: { 'aria-hidden': 'true' } })
    this.overlay = el('canvas', {
      class: 'curate-contact-overlay',
      attrs: {
        tabindex: '0',
        'aria-label': 'The contacts between genomes: press the diagonal for a genome, drag along it for a run, press Enter for their contigs',
      },
    })
    this.note = el('div', { class: 'curate-contact-note hidden', attrs: { role: 'status' } })
    this.plot = el('div', { class: 'curate-contact-plot' }, this.picture, this.overlay, this.note)
    this.element = el('section', { class: 'curate-contact', attrs: { 'data-pane': 'contacts', 'data-view': 'genomes', 'data-ready': 'false', 'data-large': 'true' } }, this.head, this.plot)
    this.wire()
    this.offs.push(ctx.onFrame((target) => this.frameOn(target)))
    this.offs.push(
      subscribeTextScale(() => {
        this.namesFor = { answer: null, font: '', width: NAMES_MIN }
        this.layoutDirty = true
        this.keyDirty = true
        this.schedule()
      }),
    )
    if (typeof ResizeObserver !== 'undefined') {
      const observer = new ResizeObserver(() => this.resize())
      observer.observe(this.plot)
      this.offs.push(() => observer.disconnect())
    }
    this.rebuild()
  }

  // -------------------------------------------------------------------------
  // The pane's contract.
  // -------------------------------------------------------------------------

  update(change: CurateChange): void {
    if (this.disposed) return
    switch (change) {
      case 'state':
      case 'preview':
        this.rebuild()
        return
      case 'selection':
        this.paintHead()
        this.schedule()
        return
      case 'hover':
      case 'mode':
      case 'current':
        this.schedule()
        return
      default:
        return
    }
  }

  resize(): void {
    this.layoutDirty = true
    this.schedule()
  }

  setLarge(large: boolean): void {
    if (large === this.large) return
    this.large = large
    if (!large) this.letGo()
    this.element.classList.toggle('is-small', !large)
    this.element.dataset.large = String(large)
    this.overlay.tabIndex = large ? 0 : -1
    this.layoutDirty = true
    this.pictureDirty = true
    this.keyDirty = true
    this.paintHead()
    this.schedule()
  }

  showSuggestion(suggestion: Suggestion | null): void {
    this.featuredKey = suggestion?.key ?? null
    this.overlay.dataset.current = suggestion?.key ?? ''
    if (suggestion !== null) this.frameSuggestion(suggestion)
    this.schedule()
  }

  key(event: KeyboardEvent): boolean {
    if (!this.large || event.metaKey || event.ctrlKey || event.altKey) return false
    switch (event.key) {
      case '0':
        this.fit()
        return true
      case '+':
      case '=':
        this.zoomBy(0.8)
        return true
      case '-':
      case '_':
        this.zoomBy(1.25)
        return true
      case 'Escape':
        if (this.press === null) return false
        this.cancelPress()
        return true
      default:
        return false
    }
  }

  dropTargetAt(x: number, y: number): CurateDropTarget | null {
    if (!this.large) return null
    const rect = this.plot.getBoundingClientRect()
    return this.targetAt(x - rect.left, y - rect.top)
  }

  dispose(): void {
    this.disposed = true
    cancelAnimationFrame(this.frameId)
    this.request?.cancel()
    this.request = null
    for (const off of this.offs) off()
    this.offs.length = 0
  }

  // -------------------------------------------------------------------------
  // The levels.
  // -------------------------------------------------------------------------

  /** Open the close-up of the selected genomes, and of the genomes holding the selected contigs. */
  closeUp(): void {
    const answer = this.ctx.model.answer
    if (answer === null) return
    const selection = this.ctx.model.selection
    const exists = new Set(answer.genomes.map((genome) => genome.id))
    const ids = new Set(selection.genomes.filter((id) => exists.has(id)))
    for (const c of selection.contigs) {
      const g = answer.genomeOf[c] ?? -1
      if (g >= 0) ids.add(answer.genomes[g].id)
    }
    if (ids.size === 0) {
      this.ctx.say('Select genomes, in the list or on the map, then press Enter for their contigs.')
      return
    }
    const order = new Map(this.ctx.model.order.map((id, k) => [id, k]))
    const focus = [...ids].sort((a, b) => (order.get(a) ?? Number.MAX_SAFE_INTEGER) - (order.get(b) ?? Number.MAX_SAFE_INTEGER))
    if (this.level === 'genomes') this.genomeView = { x: this.sx.domain, y: this.sy.domain, fitted: this.fitted }
    else if (focus.length === this.focusIds.length && focus.every((id, k) => id === this.focusIds[k])) return
    this.level = 'contigs'
    this.focusIds = focus
    this.focusContigs.clear()
    this.closeError = null
    this.fitted = true
    this.anchor = null
    this.rebuild()
  }

  /** Back to every genome, at the view the genome level had. */
  back(): void {
    if (this.level === 'genomes') return
    this.level = 'genomes'
    this.request?.cancel()
    this.request = null
    this.requested = null
    this.anchor = null
    this.close = null
    const kept = this.genomeView
    this.genomeView = null
    // The genome level as it was left: fitted, or at its view, restored below.
    this.fitted = true
    this.units = 0
    this.rebuild()
    if (kept !== null && !kept.fitted) {
      this.sx.setDomain(clampView(kept.x[0], kept.x[1], this.units, LEAST_GENOMES))
      this.sy.setDomain(clampView(kept.y[0], kept.y[1], this.units, LEAST_GENOMES))
      this.fitted = false
      this.pictureDirty = true
    }
    this.schedule()
  }

  /** Which level is shown: `genomes`, or `contigs` close up. */
  get view(): Level {
    return this.level
  }

  // -------------------------------------------------------------------------
  // What is drawn, again: after a count, a preview, a level.
  // -------------------------------------------------------------------------

  /** The binning drawn: as it would be while a preview is drawn — but the genome level holds still under a drag. */
  private drawnAnswer(): CurationStateResult | null {
    const model = this.ctx.model
    if (this.level === 'genomes' && this.ctx.dragging !== null && this.dragOver) return model.answer
    return model.shown
  }

  private rebuild(): void {
    const model = this.ctx.model
    const answer = model.answer
    this.offered = model.offered()
    this.bringing = new Map()
    for (const s of this.offered) {
      if (s.kind !== 'recruit' && s.kind !== 'move') continue
      for (const c of s.contigs) {
        const held = this.bringing.get(c)
        if (held === undefined || s.confidence > held.confidence) this.bringing.set(c, s)
      }
    }
    const drawn = this.drawnAnswer()
    this.indexOf = new Map((drawn?.genomes ?? []).map((genome, g) => [genome.id, g]))
    if (this.level === 'contigs' && answer !== null) this.followFocus(answer)
    if (this.level === 'genomes') this.buildGenomes(drawn)
    else this.buildCloseUp(drawn)
    this.element.dataset.view = this.level
    this.pictureDirty = true
    this.keyDirty = true
    if (this.namesWidth() !== this.bar.names) this.layoutDirty = true
    this.paintHead()
    this.refreshHover()
    this.schedule()
  }

  /** The readout and the light again for a pointer at rest: a step or a level changed what is under it. */
  private refreshHover(): void {
    if (this.pointer === null || this.press !== null || this.ctx.dragging !== null || !this.large) return
    this.hoverAt(this.pointer.x, this.pointer.y)
  }

  private buildGenomes(answer: CurationStateResult | null): void {
    this.close = null
    if (answer === null) {
      this.genomes = null
      this.setUnits(0)
      this.element.dataset.ready = 'false'
      return
    }
    const axis = genomeAxis(answer.genomes, this.ctx.model.order)
    const map = genomeMap(answer, axis, this.ctx.data.background)
    const n = axis.genomes.length
    this.genomes = { answer, axis, map, colours: pictureColours(DEFAULT_UI_COLORMAP, map.q, map.vmin, map.vmax), identity: identity(n) }
    this.setUnits(n)
    this.element.dataset.ready = String(answer.counted)
  }

  /** The close-up's genomes after a step: one gone is followed to where most of its contigs went. */
  private followFocus(answer: CurationStateResult): void {
    const exists = new Set(answer.genomes.map((genome) => genome.id))
    const next: string[] = []
    for (const id of this.focusIds) {
      if (exists.has(id)) {
        if (!next.includes(id)) next.push(id)
        continue
      }
      const count = new Map<string, number>()
      for (const c of this.focusContigs.get(id) ?? []) {
        const g = answer.genomeOf[c] ?? -1
        if (g >= 0) count.set(answer.genomes[g].id, (count.get(answer.genomes[g].id) ?? 0) + 1)
      }
      let best: string | null = null
      for (const [to, n] of count) if (best === null || n > (count.get(best) ?? 0)) best = to
      if (best !== null && !next.includes(best)) next.push(best)
    }
    this.focusIds = next
    if (next.length === 0) {
      this.level = 'genomes'
      this.genomeView = null
      this.fitted = true
      this.units = 0
      this.request?.cancel()
      this.request = null
      this.requested = null
    }
  }

  private buildCloseUp(drawn: CurationStateResult | null): void {
    this.genomes = null
    const model = this.ctx.model
    const answer = model.answer
    if (answer === null || drawn === null) {
      this.close = null
      this.setUnits(0)
      return
    }
    const ids = new Set(this.focusIds)
    const lengths = this.ctx.data.file.lengths
    const candidates = candidatesFor(answer, this.offered, ids)
    const wanted = closeUpAxis(answer, this.focusIds, lengths, candidates)
    for (const span of wanted.spans) if (span.id !== null) this.focusContigs.set(span.id, Array.from(wanted.contigs.subarray(span.from, span.to)))
    // As it would be: the same contigs, grouped by the binning drawn.
    const axis = drawn === answer ? wanted : closeUpAxis(drawn, this.focusIds, lengths, Array.from(wanted.contigs))
    this.ask(answer, wanted.contigs)
    const held = this.held
    const cellMap = held === null ? new Int32Array(axis.contigs.length).fill(-1) : cellMapOf(axis.contigs, held.contigs)
    const picture = held?.picture ?? null
    // The pyramid pools neighbours of the order it was read in: read through
    // another, only its finest level is right.
    const levels = picture === null ? null : held !== null && isIdentity(cellMap, held.contigs.length) ? picture.levels : picture.levels.slice(0, 1)
    let least = Number.POSITIVE_INFINITY
    let most = 0
    for (const c of axis.contigs) {
      const length = lengths[c] ?? 0
      if (length > 0 && length < least) least = length
      if (length > most) most = length
    }
    this.close = {
      answer: drawn,
      axis,
      cellMap,
      levels,
      colours: picture === null ? null : pictureColours(DEFAULT_UI_COLORMAP, { low: picture.low, high: picture.high }, picture.vmin, picture.vmax),
      reads: picture !== null && cellMap.some((cell) => cell >= 0),
      least: Number.isFinite(least) ? least : 1,
      most,
    }
    this.setUnits(axis.contigs.length)
    this.element.dataset.ready = String(held !== null && sameUnits(held.contigs, wanted.contigs))
  }

  /** Ask the worker for the close-up's contacts, unless they are held or on their way. */
  private ask(answer: CurationStateResult, units: Int32Array): void {
    this.closeNote = null
    if (!answer.counted) {
      this.request?.cancel()
      this.request = null
      this.requested = null
      return
    }
    if (units.length > FOCUS_PICTURE_CAP) {
      this.request?.cancel()
      this.request = null
      this.requested = null
      this.closeNote = `These genomes and their candidates hold ${fmt.int(units.length)} contigs, more than a close-up draws (${fmt.int(FOCUS_PICTURE_CAP)}): select fewer genomes.`
      return
    }
    if (this.held !== null && sameUnits(this.held.contigs, units)) {
      this.request?.cancel()
      this.request = null
      this.requested = null
      return
    }
    if (this.request !== null && sameUnits(this.requested, units)) return
    this.request?.cancel()
    // A copy: the reader may hand the request's buffer to the worker.
    const request = this.ctx.focus(units.slice())
    this.request = request
    this.requested = units
    request.promise.then(
      (result) => {
        if (this.request !== request || this.disposed) return
        this.request = null
        this.requested = null
        this.held = result
        this.closeError = null
        if (this.level === 'contigs') this.rebuild()
      },
      (error: unknown) => {
        if (this.request !== request || this.disposed) return
        this.request = null
        this.requested = null
        const message = error instanceof Error ? error.message : String(error)
        if (/cancel|abort/i.test(message)) return
        this.closeError = message
        this.schedule()
      },
    )
  }

  /** The axis's length changed: a fitted view fits again, another is kept inside it. */
  private setUnits(n: number): void {
    const least = this.level === 'genomes' ? LEAST_GENOMES : LEAST_CONTIGS
    const was = this.units
    this.units = n
    if (n <= 0) {
      this.sx.setDomain([0, 1])
      this.sy.setDomain([0, 1])
      return
    }
    if (this.fitted || was <= 0) {
      this.sx.setDomain([0, n])
      this.sy.setDomain([0, n])
      this.fitted = true
      return
    }
    this.sx.setDomain(clampView(this.sx.domain[0], this.sx.domain[1], n, least))
    this.sy.setDomain(clampView(this.sy.domain[0], this.sy.domain[1], n, least))
  }

  // -------------------------------------------------------------------------
  // The view.
  // -------------------------------------------------------------------------

  private least(): number {
    return this.level === 'genomes' ? LEAST_GENOMES : LEAST_CONTIGS
  }

  /** Show everything. */
  fit(): void {
    if (this.units <= 0) return
    this.sx.setDomain([0, this.units])
    this.sy.setDomain([0, this.units])
    this.fitted = true
    this.pictureDirty = true
    this.schedule()
  }

  /** Zoom both axes by `factor` (over 1 out), about a point in units — the view's middle by default. */
  zoomBy(factor: number, about?: { x: number; y: number }): void {
    const n = this.units
    if (n <= 0 || !this.large) return
    const [x0, x1] = this.sx.domain
    const [y0, y1] = this.sy.domain
    const span = Math.min(n, Math.max(Math.min(this.least(), n), (x1 - x0) * factor))
    const cx = about?.x ?? (x0 + x1) / 2
    const cy = about?.y ?? (y0 + y1) / 2
    const kx = (cx - x0) / (x1 - x0)
    const ky = (cy - y0) / (y1 - y0)
    this.sx.setDomain(clampView(cx - kx * span, cx - kx * span + span, n, this.least()))
    this.sy.setDomain(clampView(cy - ky * span, cy - ky * span + span, n, this.least()))
    this.fitted = span >= n - 1e-9
    this.pictureDirty = true
    this.schedule()
  }

  private panBy(dx: number, dy: number): void {
    const n = this.units
    if (n <= 0) return
    this.sx.panByPixels(dx)
    this.sy.panByPixels(dy)
    this.sx.setDomain(clampView(this.sx.domain[0], this.sx.domain[1], n, this.least()))
    this.sy.setDomain(clampView(this.sy.domain[0], this.sy.domain[1], n, this.least()))
    this.pictureDirty = true
    this.schedule()
  }

  /** Bring the run `[from, to)` into view on both axes, centred on the diagonal. */
  private frameUnits(from: number, to: number): void {
    const n = this.units
    if (n <= 0 || !(to > from)) return
    const [x0, x1] = this.sx.domain
    const [y0, y1] = this.sy.domain
    if (from >= x0 && to <= x1 && from >= y0 && to <= y1) return
    const view = centredView(x1 - x0, from, to, n, this.least())
    this.sx.setDomain(view)
    this.sy.setDomain(view)
    this.fitted = view[1] - view[0] >= n - 1e-9
    this.pictureDirty = true
    this.schedule()
  }

  /** What a pane asked every pane to show. */
  private frameOn(target: CurateFrame): void {
    const answer = this.ctx.model.answer
    if (answer === null || this.disposed) return
    const units: number[] = []
    if (this.level === 'genomes' && this.genomes !== null) {
      const { axis, answer: drawn } = this.genomes
      const index = new Map(drawn.genomes.map((genome, g) => [genome.id, g]))
      for (const id of target.genomes ?? []) {
        const g = index.get(id)
        if (g !== undefined && axis.slotOf[g] >= 0) units.push(axis.slotOf[g])
      }
      for (const c of target.contigs ?? []) {
        const g = drawn.genomeOf[c] ?? -1
        if (g >= 0 && axis.slotOf[g] >= 0) units.push(axis.slotOf[g])
      }
    } else if (this.close !== null) {
      const { axis } = this.close
      const wanted = new Set(target.contigs ?? [])
      axis.contigs.forEach((c, u) => {
        if (wanted.has(c)) units.push(u)
      })
      for (const id of target.genomes ?? []) {
        const span = axis.spans.find((s) => s.id === id)
        if (span !== undefined) units.push(span.from, span.to - 1)
      }
    }
    if (units.length === 0) return
    this.frameUnits(Math.min(...units), Math.max(...units) + 1)
  }

  private frameSuggestion(s: Suggestion): void {
    const answer = this.ctx.model.answer
    if (answer === null) return
    this.frameOn({ genomes: s.genomes.map((g) => answer.genomes[g]?.id).filter((id): id is string => id !== undefined), contigs: s.contigs })
  }

  // -------------------------------------------------------------------------
  // Layout.
  // -------------------------------------------------------------------------

  private font(weight = ''): string {
    const base = scaleFont(this.ctx.ink().font)
    return weight === '' ? base : `${weight} ${base}`
  }

  /** The names' room: the widest short name, once an answer. */
  private namesWidth(): number {
    if (!this.large) return 0
    const answer = this.ctx.model.answer
    const font = this.font('600')
    if (this.namesFor.answer === answer && this.namesFor.font === font) return this.namesFor.width
    let width = NAMES_MIN
    const g = this.overlay.getContext('2d')
    if (g !== null && answer !== null) {
      g.font = font
      for (const genome of answer.genomes) {
        const mark = genome.kind === 'element' ? DIAMOND_ROOM : 0
        width = Math.max(width, Math.ceil(g.measureText(this.ctx.shortName(genome.id)).width) + mark + 4)
        if (width >= NAMES_MAX) break
      }
    }
    width = Math.min(NAMES_MAX, width)
    this.namesFor = { answer, font, width }
    return width
  }

  private layout(): void {
    this.layoutDirty = false
    const rect = this.plot.getBoundingClientRect()
    const width = Math.max(0, Math.floor(rect.width))
    const height = Math.max(0, Math.floor(rect.height))
    this.dpr = window.devicePixelRatio > 0 ? window.devicePixelRatio : 1
    this.box = { width, height }
    const names = this.namesWidth()
    const strip = this.large ? STRIP : STRIP_SMALL
    const gap = this.large ? GAP : 2
    const size = this.large ? names + NAMES_GAP + strip + gap : strip + gap
    const pad = this.large ? PAD : PAD_SMALL
    const far = this.large ? PAD_FAR : PAD_SMALL
    const availW = width - pad - far - size
    const availH = height - pad - far - size
    const side = Math.max(0, Math.floor(Math.min(availW, availH)))
    const x = pad + size + Math.max(0, Math.floor((availW - side) / 2))
    const y = pad + size + Math.max(0, Math.floor((availH - side) / 2))
    this.map = { x, y, size: side }
    this.bar = { size, strip, gap, names }
    const place = (node: HTMLElement, left: number, top: number, w: number, h: number): void => {
      node.style.left = `${left}px`
      node.style.top = `${top}px`
      node.style.width = `${w}px`
      node.style.height = `${h}px`
    }
    place(this.picture, x, y, side, side)
    this.picture.width = Math.round(side * this.dpr)
    this.picture.height = Math.round(side * this.dpr)
    place(this.overlay, 0, 0, width, height)
    this.overlay.width = Math.round(width * this.dpr)
    this.overlay.height = Math.round(height * this.dpr)
    this.note.style.left = `${x + side / 2}px`
    this.note.style.top = `${y + side / 2}px`
    this.sx.setPixels(Math.max(1, side))
    this.sy.setPixels(Math.max(1, side))
    this.image = null
    this.pictureDirty = true
    this.keyDirty = true
  }

  /** One frame's geometry: the view's units and where they fall. */
  private geometry(): Geometry {
    const n = Math.max(this.units, 1)
    const [x0, x1] = this.large ? this.sx.domain : [0, n]
    const [y0, y1] = this.large ? this.sy.domain : [0, n]
    const { x, y, size } = this.map
    const k = size / Math.max(1e-9, x1 - x0)
    return {
      n: this.units,
      x0,
      x1,
      y0,
      y1,
      k,
      X: (unit) => x + (unit - x0) * k,
      Y: (unit) => y + (unit - y0) * k,
    }
  }

  // -------------------------------------------------------------------------
  // Drawing.
  // -------------------------------------------------------------------------

  private schedule(): void {
    if (this.disposed || this.frameId !== 0) return
    this.frameId = requestAnimationFrame(() => {
      this.frameId = 0
      this.draw()
    })
  }

  private draw(): void {
    if (this.disposed) return
    if (this.layoutDirty) this.layout()
    if (this.pictureDirty) this.paintPicture()
    this.paintOverlay()
    if (this.keyDirty) this.paintKey()
    this.paintNote()
  }

  /** The picture, through the view: only when it, the view or the box changed. */
  private paintPicture(): void {
    this.pictureDirty = false
    const g = this.picture.getContext('2d')
    if (g === null) return
    const width = this.picture.width
    const height = this.picture.height
    if (width === 0 || height === 0) return
    if (this.image === null || this.image.width !== width || this.image.height !== height) this.image = g.createImageData(width, height)
    const target = new Uint32Array(this.image.data.buffer)
    const geo = this.geometry()
    const view = { x0: geo.x0, x1: geo.x1, y0: geo.y0, y1: geo.y1, width, height }
    const genomes = this.genomes
    const close = this.close
    if (this.level === 'genomes' && genomes !== null && genomes.map.levels.length > 0 && genomes.answer.counted) {
      paintPicture(target, view, genomes.identity, genomes.identity, genomes.map.levels, genomes.colours)
    } else if (this.level === 'contigs' && close !== null && close.levels !== null && close.colours !== null && close.cellMap.length > 0) {
      paintPicture(target, view, close.cellMap, close.cellMap, close.levels, close.colours)
    } else target.fill(0)
    // The paper under what the map holds: an empty cell is a cell with no contacts.
    const ground = this.ground
    for (let k = 0; k < target.length; k++) if (target[k] === 0) target[k] = ground
    g.putImageData(this.image, 0, 0)
  }

  private paintOverlay(): void {
    const g = this.overlay.getContext('2d')
    const geo = this.geometry()
    const [vx0, vx1] = [geo.x0, geo.x1]
    this.overlay.dataset.map = `${this.map.x} ${this.map.y} ${this.map.size}`
    this.overlay.dataset.cells = String(this.units)
    this.overlay.dataset.domain = [vx0, vx1, geo.y0, geo.y1].map((v) => v.toFixed(3)).join(' ')
    if (g === null) return
    g.setTransform(1, 0, 0, 1, 0, 0)
    g.clearRect(0, 0, this.overlay.width, this.overlay.height)
    if (this.map.size <= 0 || this.units <= 0) return
    g.setTransform(this.dpr, 0, 0, this.dpr, 0, 0)
    if (this.ctx.dragging === null && this.dropLit !== null) {
      this.dropLit = null
      this.dragOver = false
    }
    const ink = this.ctx.ink()
    const paper = paperInk()
    if (this.level === 'genomes' && this.genomes !== null) this.drawGenomes(g, geo, this.genomes, ink, paper)
    else if (this.level === 'contigs' && this.close !== null) this.drawCloseUp(g, geo, this.close, ink, paper)
  }

  // --- Shared strokes ---------------------------------------------------------

  /** A stroke over a halo of the paper, so it reads over the darkest cells. */
  private haloed(g: CanvasRenderingContext2D, paper: StageInk, colour: string, width: number, path: () => void, dash: number[] = [], halo = 2.5): void {
    g.lineCap = 'round'
    g.lineJoin = 'round'
    g.setLineDash([])
    g.globalAlpha = 0.7
    g.strokeStyle = paper.background
    g.lineWidth = width + halo
    g.beginPath()
    path()
    g.stroke()
    g.globalAlpha = 1
    g.strokeStyle = colour
    g.lineWidth = width
    g.setLineDash(dash)
    g.beginPath()
    path()
    g.stroke()
    g.setLineDash([])
  }

  /** A run's square on the diagonal, outlined: the selection's look (never a wash). */
  private outline(g: CanvasRenderingContext2D, geo: Geometry, paper: StageInk, from: number, to: number, width = 2, dash: number[] = []): void {
    const snap = (v: number): number => Math.round(v * this.dpr) / this.dpr
    let x0 = snap(geo.X(from))
    let x1 = snap(geo.X(to))
    let y0 = snap(geo.Y(from))
    let y1 = snap(geo.Y(to))
    // A cell narrower than the stroke is still outlined round its middle.
    const least = 7
    if (x1 - x0 < least) {
      const c = (x0 + x1) / 2
      x0 = c - least / 2
      x1 = c + least / 2
    }
    if (y1 - y0 < least) {
      const c = (y0 + y1) / 2
      y0 = c - least / 2
      y1 = c + least / 2
    }
    this.haloed(g, paper, paper.accent, width, () => g.rect(x0, y0, x1 - x0, y1 - y0), dash)
  }

  /**
   * A unit's row and column, dashed: what is lit in every pane. Where cells
   * are small the rules stand a little outside the unit, so its own cells
   * still show between them.
   */
  private bands(g: CanvasRenderingContext2D, geo: Geometry, paper: StageInk, from: number, to: number): void {
    const { x, y, size } = this.map
    const small = geo.k < 8
    const room = small ? 1.75 : 0
    const x0 = geo.X(from) - room
    const x1 = geo.X(to) + room
    const y0 = geo.Y(from) - room
    const y1 = geo.Y(to) + room
    const lines: Array<[number, number, number, number]> = [
      [x0, y, x0, y + size],
      [x1, y, x1, y + size],
      [x, y0, x + size, y0],
      [x, y1, x + size, y1],
    ]
    this.haloed(
      g,
      paper,
      paper.accent,
      small ? 1 : 1.25,
      () => {
        for (const [ax, ay, bx, by] of lines) {
          g.moveTo(ax, ay)
          g.lineTo(bx, by)
        }
      },
      small ? [3, 3] : [4, 3],
      small ? 1.25 : 2.5,
    )
  }

  /** The cell under the pointer, outlined. */
  private cellOutline(g: CanvasRenderingContext2D, geo: Geometry, paper: StageInk, row: number, col: number): void {
    let x0 = geo.X(col)
    let x1 = geo.X(col + 1)
    let y0 = geo.Y(row)
    let y1 = geo.Y(row + 1)
    if (x1 - x0 < 7) {
      const cx = (x0 + x1) / 2
      const cy = (y0 + y1) / 2
      x0 = cx - 3.5
      x1 = cx + 3.5
      y0 = cy - 3.5
      y1 = cy + 3.5
    }
    this.haloed(g, paper, paper.accent, 1.5, () => g.rect(x0, y0, x1 - x0, y1 - y0))
  }

  /** A numbered disc: the review's suggestion, beside its mark. */
  private disc(g: CanvasRenderingContext2D, paper: StageInk, cx: number, cy: number, number: number): void {
    g.font = this.font('600')
    const r = Math.max(9, g.measureText(String(number)).width / 2 + 4)
    const x = Math.max(r + 1, Math.min(this.box.width - r - 1, cx))
    const y = Math.max(r + 1, Math.min(this.box.height - r - 1, cy))
    g.globalAlpha = 1
    g.beginPath()
    g.arc(x, y, r, 0, 2 * Math.PI)
    g.fillStyle = paper.accent
    g.fill()
    g.lineWidth = 1.5
    g.strokeStyle = paper.background
    g.stroke()
    g.fillStyle = paper.background
    g.font = this.font('600')
    g.textAlign = 'center'
    g.textBaseline = 'middle'
    g.fillText(String(number), x, y + 0.5)
  }

  /** The cell box of a pair of units, as pixels: its middle and half its side, at least a few pixels. */
  private cellBox(geo: Geometry, row: number, col: number): { cx: number; cy: number; half: number } {
    const x0 = geo.X(col)
    const x1 = geo.X(col + 1)
    const y0 = geo.Y(row)
    const y1 = geo.Y(row + 1)
    return { cx: (x0 + x1) / 2, cy: (y0 + y1) / 2, half: Math.max((x1 - x0) / 2, 1) }
  }

  // --- The genome level -------------------------------------------------------

  private drawGenomes(g: CanvasRenderingContext2D, geo: Geometry, drawn: GenomesDrawn, ink: StageInk, paper: StageInk): void {
    const { axis, answer } = drawn
    const model = this.ctx.model
    const selection = model.selection
    const slotOfId = (id: string): number => {
      const index = this.indexOf.get(id)
      return index === undefined ? -1 : axis.slotOf[index]
    }
    const selected = selection.genomes.map(slotOfId).filter((s) => s >= 0)
    const holding = new Set<number>()
    for (const c of selection.contigs) {
      const gi = answer.genomeOf[c] ?? -1
      if (gi >= 0 && axis.slotOf[gi] >= 0) holding.add(axis.slotOf[gi])
    }
    for (const s of selected) holding.delete(s)
    const lit = model.hovered.genome === null ? -1 : slotOfId(model.hovered.genome)
    const pointerHit = this.pointer !== null && this.large && this.press?.kind !== 'pan' ? this.hitAt(this.pointer.x, this.pointer.y) : null
    const dropSlot = this.dropLit?.kind === 'genome' && !this.dropRefused ? slotOfId(this.dropLit.id) : -1

    // The bars.
    for (const edge of ['top', 'left'] as const) this.genomeBar(g, edge, geo, drawn, ink, { selected: new Set(selected), lit, drop: dropSlot, pointer: pointerHit })

    // Over the map: the rules, the suggestions, what is lit, and the selection
    // last, so no halo drawn after it eats into its outline.
    const { x, y, size } = this.map
    g.save()
    g.beginPath()
    g.rect(x, y, size, size)
    g.clip()
    this.genomeRules(g, geo, axis, paper)
    // The suggestions are of the binning as it stands, and a thumbnail shows the picture and the selection only.
    const current = answer === model.answer && answer.counted && this.large
    const featured = current ? this.featured() : null
    if (current) this.genomeMarks(g, geo, drawn, paper, new Set(selection.genomes.map((id) => this.indexOf.get(id) ?? -1)), featured)
    if (lit >= 0) this.bands(g, geo, paper, lit, lit + 1)
    if (pointerHit !== null && pointerHit.where === 'map' && !pointerHit.diagonal && this.ctx.dragging === null) this.cellOutline(g, geo, paper, pointerHit.row, pointerHit.col)
    for (const [from, to] of runsOf(holding)) this.outline(g, geo, paper, from, to, 1.5, [4, 3])
    for (const [from, to] of runsOf(selected)) this.outline(g, geo, paper, from, to)
    if (dropSlot >= 0) this.outline(g, geo, paper, dropSlot, dropSlot + 1, 2.75)
    g.restore()
    if (featured !== null) this.genomeDisc(g, geo, drawn, paper, featured)
    if (this.large) this.genomeLabels(g, geo, drawn, ink, { selected, lit, pointer: pointerHit })
  }

  /** Rules between genomes where cells are wide, and the edge between the MAGs and the elements always. */
  private genomeRules(g: CanvasRenderingContext2D, geo: Geometry, axis: GenomeAxis, paper: StageInk): void {
    const { x, y, size } = this.map
    const hair = (v: number): number => (Math.floor(v * this.dpr) + 0.5) / this.dpr
    const n = axis.genomes.length
    g.lineWidth = 1 / this.dpr
    if (geo.k >= GRID_PX) {
      g.strokeStyle = paper.faint
      g.globalAlpha = Math.min(0.28, 0.1 + (geo.k - GRID_PX) / 200)
      g.beginPath()
      for (let u = Math.max(1, Math.ceil(geo.x0)); u <= Math.min(n - 1, Math.floor(geo.x1)); u++) {
        const px = hair(geo.X(u))
        g.moveTo(px, y)
        g.lineTo(px, y + size)
      }
      for (let u = Math.max(1, Math.ceil(geo.y0)); u <= Math.min(n - 1, Math.floor(geo.y1)); u++) {
        const py = hair(geo.Y(u))
        g.moveTo(x, py)
        g.lineTo(x + size, py)
      }
      g.stroke()
    }
    if (axis.mags > 0 && axis.mags < n) {
      g.globalAlpha = 0.75
      g.strokeStyle = paper.dim
      g.lineWidth = Math.max(1, 1.25 * this.dpr) / this.dpr
      g.beginPath()
      const px = hair(geo.X(axis.mags))
      const py = hair(geo.Y(axis.mags))
      g.moveTo(px, y)
      g.lineTo(px, y + size)
      g.moveTo(x, py)
      g.lineTo(x + size, py)
      g.stroke()
    }
    g.globalAlpha = 1
  }

  /** The suggestion in review: the one shown, else the review's current one. */
  private featured(): Suggestion | null {
    const model = this.ctx.model
    const key = this.featuredKey ?? (model.mode === 'review' ? (model.current?.key ?? null) : null)
    if (key === null) return null
    return this.offered.find((s) => s.key === key) ?? model.answer?.suggestions.find((s) => s.key === key) ?? null
  }

  /**
   * The merges, the links and the unlinks on offer at their cells, and —
   * close enough to tell one cell from the next — the links held: a merge in
   * both triangles, as a block of contacts is; a link or an unlink once, at
   * the MAG's row and the element's column.
   */
  private genomeMarks(g: CanvasRenderingContext2D, geo: Geometry, drawn: GenomesDrawn, paper: StageInk, selected: ReadonlySet<number>, featured: Suggestion | null): void {
    const { axis, answer } = drawn
    const slot = (gi: number | undefined): number => (gi === undefined || gi < 0 ? -1 : (axis.slotOf[gi] ?? -1))
    // The links held, in ink: what is already made (§27.3).
    if (geo.k >= HELD_PX) {
      for (const link of answer.links) {
        const e = slot(this.indexOf.get(link.element))
        const m = slot(this.indexOf.get(link.mag))
        if (e < 0 || m < 0) continue
        const { cx, cy, half } = this.cellBox(geo, Math.min(e, m), Math.max(e, m))
        this.haloed(g, paper, paper.dim, 1, () => g.arc(cx, cy, half * 1.16 - 0.5, 0, 2 * Math.PI), [], 1.5)
      }
    }
    let marked = 0
    for (const s of this.offered) {
      if (s.kind !== 'merge' && s.kind !== 'link' && s.kind !== 'unlink') continue
      if (featured !== null && s.key === featured.key) continue
      const names = s.genomes.some((gi) => selected.has(gi))
      if (marked >= MARKS_MOST && !names) continue
      marked++
      this.genomeMark(g, geo, paper, s.kind, slot(s.genomes[0]), slot(s.genomes[1]), false)
    }
    if (featured === null) return
    if (featured.kind === 'merge' || featured.kind === 'link' || featured.kind === 'unlink') {
      this.genomeMark(g, geo, paper, featured.kind, slot(featured.genomes[0]), slot(featured.genomes[1]), true)
    } else {
      // A recruit or a move: its target genome, outlined.
      const target = slot(featured.genomes[0])
      if (target >= 0) this.outline(g, geo, paper, target, target + 1, 2.25, [5, 3])
    }
  }

  /**
   * One suggestion's mark at the cell of two slots, as large as the cell is,
   * so marks a cell apart never run into each other:
   *
   * - a **merge**, an L at the cell's corner away from the diagonal, opening
   *   into it — the corner of the block the two would make (§27.3's corner) —
   *   in both triangles;
   * - a **link**, a ring round the cell; where cells are small, the cell's box;
   * - an **unlink**, a cross over the cell.
   */
  private genomeMark(g: CanvasRenderingContext2D, geo: Geometry, paper: StageInk, kind: 'merge' | 'link' | 'unlink', a: number, b: number, strong: boolean): void {
    if (a < 0 || b < 0 || a === b) return
    const lo = Math.min(a, b)
    const hi = Math.max(a, b)
    const places: Array<[number, number]> = kind === 'merge' ? [[lo, hi], [hi, lo]] : [[lo, hi]]
    const side = geo.k
    const small = side < 8
    const width = strong ? (small ? 2 : 2.5) : small ? 1.25 : 1.6
    const halo = small ? 1.5 : 2.5
    for (const [row, col] of places) {
      const x0 = geo.X(col)
      const x1 = geo.X(col + 1)
      const y0 = geo.Y(row)
      const y1 = geo.Y(row + 1)
      if (x1 < this.map.x - 12 || x0 > this.map.x + this.map.size + 12 || y1 < this.map.y - 12 || y0 > this.map.y + this.map.size + 12) continue
      const cx = (x0 + x1) / 2
      const cy = (y0 + y1) / 2
      if (kind === 'merge') {
        const upper = row < col
        const inset = small ? 0 : 1.5
        const arm = Math.max(4.5, Math.min(side * 0.55, 11))
        const px = upper ? x1 - inset : x0 + inset
        const py = upper ? y0 + inset : y1 - inset
        const dx = upper ? -1 : 1
        const dy = upper ? 1 : -1
        this.haloed(
          g,
          paper,
          paper.accent,
          width,
          () => {
            g.moveTo(px + dx * arm, py)
            g.lineTo(px, py)
            g.lineTo(px, py + dy * arm)
          },
          [],
          halo,
        )
      } else if (kind === 'link') {
        if (side >= RING_PX) this.haloed(g, paper, paper.accent, width, () => g.arc(cx, cy, side * 0.6, 0, 2 * Math.PI), [], halo)
        else this.haloed(g, paper, paper.accent, width, () => g.rect(x0 + 0.5, y0 + 0.5, Math.max(1, side - 1), Math.max(1, side - 1)), [], halo)
      } else {
        const r = Math.max(2.5, side * 0.32)
        this.haloed(
          g,
          paper,
          paper.accent,
          width,
          () => {
            g.moveTo(cx - r, cy - r)
            g.lineTo(cx + r, cy + r)
            g.moveTo(cx + r, cy - r)
            g.lineTo(cx - r, cy + r)
          },
          [],
          halo,
        )
      }
    }
  }

  /** The review's number, beside its mark in the upper triangle. */
  private genomeDisc(g: CanvasRenderingContext2D, geo: Geometry, drawn: GenomesDrawn, paper: StageInk, featured: Suggestion): void {
    const at = this.offered.findIndex((s) => s.key === featured.key)
    if (at < 0) return
    const slot = (gi: number | undefined): number => (gi === undefined || gi < 0 ? -1 : (drawn.axis.slotOf[gi] ?? -1))
    const a = slot(featured.genomes[0])
    const b = featured.kind === 'recruit' || featured.kind === 'move' ? a : slot(featured.genomes[1])
    if (a < 0 || b < 0) return
    const row = Math.min(a, b)
    const col = Math.max(a, b)
    const { cx, cy } = this.cellBox(geo, row, col)
    if (cx < this.map.x || cx > this.map.x + this.map.size || cy < this.map.y || cy > this.map.y + this.map.size) return
    // Up and right of the cell's corner, where the merge's L opens from.
    this.disc(g, paper, geo.X(col + 1) + 9, geo.Y(row) - 9, at + 1)
  }

  /** A bar's coordinates: along it, and across it outward from the map, to the canvas's. */
  private barRect(g: CanvasRenderingContext2D, edge: 'top' | 'left', a0: number, a1: number, c0: number, c1: number): void {
    const { x, y } = this.map
    if (edge === 'top') g.fillRect(a0, y - c1, a1 - a0, c1 - c0)
    else g.fillRect(x - c1, a0, c1 - c0, a1 - a0)
  }

  private genomeBar(
    g: CanvasRenderingContext2D,
    edge: 'top' | 'left',
    geo: Geometry,
    drawn: GenomesDrawn,
    ink: StageInk,
    marks: { selected: ReadonlySet<number>; lit: number; drop: number; pointer: Hit | null },
  ): void {
    const { axis, answer } = drawn
    const n = axis.genomes.length
    const { strip, gap, names, size: barSize } = this.bar
    const P = edge === 'top' ? geo.X : geo.Y
    const [u0, u1] = edge === 'top' ? [geo.x0, geo.x1] : [geo.y0, geo.y1]
    const start = edge === 'top' ? this.map.x : this.map.y
    const end = start + this.map.size
    const first = Math.max(0, Math.floor(u0))
    const last = Math.min(n, Math.ceil(u1))
    g.save()
    g.beginPath()
    if (edge === 'top') g.rect(start, this.map.y - barSize, this.map.size, barSize)
    else g.rect(this.map.x - barSize, start, barSize, this.map.size)
    g.clip()
    // The blocks: a genome's colour, an element's shorter.
    for (let s = first; s < last; s++) {
      const genome = answer.genomes[axis.genomes[s]]
      const a0 = P(s)
      const a1 = P(s + 1)
      const inset = a1 - a0 >= 4 ? 0.5 : 0
      g.fillStyle = this.ctx.colourOf(genome.id).css
      this.barRect(g, edge, a0 + inset, a1 - inset, gap, gap + (genome.kind === 'element' ? Math.round(strip * 0.6) : strip))
    }
    // The edge between the MAGs and the elements, across the strip: the
    // section's dimension line ends there too.
    if (axis.mags > 0 && axis.mags < n) {
      const at = P(axis.mags)
      if (at >= start && at <= end) {
        g.fillStyle = ink.dim
        g.globalAlpha = 0.8
        this.barRect(g, edge, at - 0.75, at + 0.75, 0, gap + strip + 2)
        g.globalAlpha = 1
      }
    }
    // A drop target, washed.
    if (marks.drop >= 0) {
      g.fillStyle = ink.accentSoft
      g.globalAlpha = 0.85
      this.barRect(g, edge, P(marks.drop), P(marks.drop + 1), 0, barSize)
      g.globalAlpha = 1
      g.strokeStyle = ink.accent
      g.lineWidth = 1.5
      const a0 = P(marks.drop)
      const a1 = P(marks.drop + 1)
      if (edge === 'top') g.strokeRect(a0, this.map.y - barSize + 0.75, a1 - a0, barSize - 1.5)
      else g.strokeRect(this.map.x - barSize + 0.75, a0, barSize - 1.5, a1 - a0)
    }
    // The selection: an accent rule between the strip and the map.
    g.fillStyle = ink.accent
    for (const [from, to] of runsOf(marks.selected)) this.barRect(g, edge, P(from), P(to), 0, Math.max(1.5, gap - 0.5))
    // The genome lit, and the pointer's: the block outlined.
    const outlined = new Set<number>()
    if (marks.lit >= 0) outlined.add(marks.lit)
    const pointer = marks.pointer
    if (pointer !== null && pointer.where !== null && this.ctx.dragging === null) outlined.add(edge === 'top' ? pointer.col : pointer.row)
    g.strokeStyle = ink.accent
    g.lineWidth = 1.5
    for (const s of outlined) {
      if (s < 0 || s >= n) continue
      const a0 = P(s)
      const a1 = Math.max(P(s + 1), a0 + 2)
      if (edge === 'top') g.strokeRect(a0, this.map.y - gap - strip, a1 - a0, strip)
      else g.strokeRect(this.map.x - gap - strip, a0, strip, a1 - a0)
    }
    // The names, where a block holds one; else each section's.
    if (this.large && names > 0) {
      const c0 = gap + strip + NAMES_GAP
      if (geo.k >= NAME_PX) {
        g.textBaseline = 'middle'
        for (let s = first; s < last; s++) {
          const along = (P(s) + P(s + 1)) / 2
          // Only a name the bar shows whole: one cut by the view's edge reads as another.
          if (along - 5 < start || along + 5 > end) continue
          const genome = answer.genomes[axis.genomes[s]]
          const chosen = marks.selected.has(s) || s === marks.lit
          g.font = this.font(chosen ? '600' : '')
          this.name(g, edge, along, c0, this.ctx.shortName(genome.id), genome.kind === 'element', names, chosen ? ink.accent : ink.text, chosen ? ink.accent : ink.dim)
        }
      } else {
        const sections: Array<[number, number, string]> = []
        if (axis.mags > 0) sections.push([0, axis.mags, `MAGs · ${fmt.int(axis.mags)}`])
        if (axis.mags < n) sections.push([axis.mags, n, `elements · ${fmt.int(n - axis.mags)}`])
        for (const [from, to, label] of sections) this.dimension(g, edge, Math.max(start, P(from)), Math.min(end, P(to)), c0 + names / 2, [label], ink)
      }
    }
    g.restore()
  }

  /**
   * A genome's name across a bar, from `c0` outward, cut to `room`: an
   * element's after a small diamond, before it in reading order — under the
   * name on the top bar, which reads upward, and left of it on the left.
   */
  private name(g: CanvasRenderingContext2D, edge: 'top' | 'left', along: number, c0: number, text: string, element: boolean, room: number, colour: string, mark: string): void {
    const label = this.fitText(g, text, room - (element ? DIAMOND_ROOM : 0))
    if (label === '') return
    g.fillStyle = colour
    if (!element) {
      this.across(g, edge, along, c0, label)
      return
    }
    if (edge === 'top') {
      this.across(g, edge, along, c0 + DIAMOND_ROOM, label)
      g.fillStyle = mark
      this.diamond(g, edge, along, c0 + 3)
    } else {
      this.across(g, edge, along, c0, label)
      g.fillStyle = mark
      this.diamond(g, edge, along, c0 + g.measureText(label).width + 6)
    }
  }

  /** The mark of an element on a bar: a small diamond, across the bar at `c`. */
  private diamond(g: CanvasRenderingContext2D, edge: 'top' | 'left', along: number, c: number, half = 2.6): void {
    const { x, y } = this.map
    const [cx, cy] = edge === 'top' ? [along, y - c] : [x - c, along]
    g.beginPath()
    g.moveTo(cx, cy - half)
    g.lineTo(cx + half, cy)
    g.lineTo(cx, cy + half)
    g.lineTo(cx - half, cy)
    g.closePath()
    g.fill()
  }

  /** Text across a bar, from `c0` outward: a name perpendicular to the axis. */
  private across(g: CanvasRenderingContext2D, edge: 'top' | 'left', along: number, c0: number, text: string): void {
    const { x, y } = this.map
    if (edge === 'top') {
      g.save()
      g.translate(along, y - c0)
      g.rotate(-Math.PI / 2)
      g.textAlign = 'left'
      g.fillText(text, 0, 0.5)
      g.restore()
    } else {
      g.textAlign = 'right'
      g.fillText(text, x - c0, along + 0.5)
    }
  }

  /**
   * A label along a bar over a stretch, with a rule either side to its ends —
   * a dimension line: a section's name and count, a close-up genome's.
   */
  private dimension(g: CanvasRenderingContext2D, edge: 'top' | 'left', a0: number, a1: number, c: number, labels: readonly string[], ink: StageInk, colour = ink.dim, weight = '600'): void {
    if (a1 - a0 < 6) return
    g.font = this.font(weight)
    // The first of its forms that fits whole, else the last cut to the room.
    const room = Math.max(0, a1 - a0 - 10)
    const whole = labels.find((label) => g.measureText(label).width <= room)
    const text = whole ?? this.fitText(g, labels[labels.length - 1] ?? '', room)
    const width = text === '' ? 0 : g.measureText(text).width
    const mid = (a0 + a1) / 2
    const { x, y } = this.map
    const point = (along: number, acrossAt: number): [number, number] => (edge === 'top' ? [along, y - acrossAt] : [x - acrossAt, along])
    g.strokeStyle = ink.faint
    g.globalAlpha = 0.85
    g.lineWidth = 1
    g.beginPath()
    const ends: Array<[number, number]> = text === '' ? [[a0 + 2, a1 - 2]] : [
      [a0 + 2, mid - width / 2 - 5],
      [mid + width / 2 + 5, a1 - 2],
    ]
    for (const [from, to] of ends) {
      if (to - from < 2) continue
      const [fx, fy] = point(from, c)
      const [tx, ty] = point(to, c)
      g.moveTo(fx, fy)
      g.lineTo(tx, ty)
    }
    // The ends, ticked.
    for (const end of [a0 + 2, a1 - 2]) {
      const [ex, ey] = point(end, c - 3)
      const [fx, fy] = point(end, c + 3)
      g.moveTo(ex, ey)
      g.lineTo(fx, fy)
    }
    g.stroke()
    g.globalAlpha = 1
    if (text === '') return
    g.fillStyle = colour
    g.textBaseline = 'middle'
    g.textAlign = 'center'
    if (edge === 'top') g.fillText(text, mid, y - c + 0.5)
    else {
      g.save()
      g.translate(x - c, mid)
      g.rotate(-Math.PI / 2)
      g.fillText(text, 0, 0.5)
      g.restore()
    }
  }

  /** A name cut to a width, with an ellipsis where it was cut; `''` where not even that fits. */
  private fitText(g: CanvasRenderingContext2D, text: string, width: number): string {
    if (g.measureText(text).width <= width) return text
    let cut = text
    while (cut.length > 1 && g.measureText(`${cut}…`).width > width) cut = cut.slice(0, -1)
    const out = `${cut}…`
    return g.measureText(out).width <= width ? out : ''
  }

  /**
   * Names on plates, where the blocks are too narrow to hold them: the cell
   * under the pointer's row and column, the genome lit, the selection's —
   * each where it does not cover one written already.
   */
  private genomeLabels(g: CanvasRenderingContext2D, geo: Geometry, drawn: GenomesDrawn, ink: StageInk, marks: { selected: readonly number[]; lit: number; pointer: Hit | null }): void {
    const { axis, answer } = drawn
    const wanted: Array<{ edge: 'top' | 'left'; slot: number; strong: boolean }> = []
    const pointer = marks.pointer
    if (pointer !== null && pointer.where !== null && this.ctx.dragging === null) {
      wanted.push({ edge: 'top', slot: pointer.col, strong: true }, { edge: 'left', slot: pointer.row, strong: true })
    }
    if (marks.lit >= 0) wanted.push({ edge: 'top', slot: marks.lit, strong: true }, { edge: 'left', slot: marks.lit, strong: true })
    if (marks.selected.length <= 8) for (const s of marks.selected) wanted.push({ edge: 'top', slot: s, strong: false }, { edge: 'left', slot: s, strong: false })
    if (geo.k >= NAME_PX) {
      // The names are written: only the pointer's, outlined where a block is cut.
      return
    }
    const taken: Record<'top' | 'left', Array<[number, number]>> = { top: [], left: [] }
    const seen = new Set<string>()
    for (const { edge, slot, strong } of wanted) {
      if (slot < 0 || slot >= axis.genomes.length) continue
      const key = `${edge}:${slot}`
      if (seen.has(key)) continue
      seen.add(key)
      const P = edge === 'top' ? geo.X : geo.Y
      const along = (P(slot) + P(slot + 1)) / 2
      const start = edge === 'top' ? this.map.x : this.map.y
      if (along < start || along > start + this.map.size) continue
      if (taken[edge].some(([a, b]) => along > a - 8 && along < b + 8)) continue
      taken[edge].push([along - 7, along + 7])
      const genome = answer.genomes[axis.genomes[slot]]
      this.plate(g, edge, along, this.ctx.shortName(genome.id), ink, strong, genome.kind === 'element')
    }
  }

  /** A name on a plate across a bar, an element's after its diamond: a pointer's label. */
  private plate(g: CanvasRenderingContext2D, edge: 'top' | 'left', along: number, text: string, ink: StageInk, strong: boolean, element = false): void {
    const { strip, gap } = this.bar
    const c0 = gap + strip + 2
    const room = (edge === 'top' ? this.map.y : this.map.x) - c0 - 2
    const mark = element ? DIAMOND_ROOM : 0
    if (room < 16 + mark) return
    g.font = this.font('600')
    const label = this.fitText(g, text, room - 8 - mark)
    if (label === '') return
    const textWidth = g.measureText(label).width
    const width = textWidth + 8 + mark
    const thick = 15
    const { x, y } = this.map
    g.save()
    if (edge === 'top') {
      g.translate(along, y - c0)
      g.rotate(-Math.PI / 2)
    } else g.translate(x - c0, along)
    // Drawn as if on the left bar: leftward from the strip, centred on `along`.
    const bx = edge === 'top' ? 0 : -width
    const by = -thick / 2
    g.fillStyle = ink.background
    g.globalAlpha = 0.96
    g.beginPath()
    if (typeof g.roundRect === 'function') g.roundRect(bx, by, width, thick, 3)
    else g.rect(bx, by, width, thick)
    g.fill()
    g.globalAlpha = 1
    g.strokeStyle = strong ? ink.accent : ink.faint
    g.lineWidth = 1
    g.stroke()
    g.fillStyle = strong ? ink.accent : ink.text
    g.textBaseline = 'middle'
    g.textAlign = edge === 'top' ? 'left' : 'right'
    g.fillText(label, edge === 'top' ? 4 + mark : -4, 0.5)
    if (element) {
      // Before the name as it reads: nearest the strip on the top bar, leftmost on the left.
      const cx = edge === 'top' ? 4 + 3 : -4 - textWidth - 6
      g.beginPath()
      g.moveTo(cx, -2.6)
      g.lineTo(cx + 2.6, 0)
      g.lineTo(cx, 2.6)
      g.lineTo(cx - 2.6, 0)
      g.closePath()
      g.fill()
    }
    g.restore()
  }

  // --- The close-up -------------------------------------------------------------

  private drawCloseUp(g: CanvasRenderingContext2D, geo: Geometry, close: CloseDrawn, ink: StageInk, paper: StageInk): void {
    const { axis } = close
    const model = this.ctx.model
    const selection = model.selection
    const unitOf = new Map<number, number>()
    axis.contigs.forEach((c, u) => unitOf.set(c, u))
    const selected = selection.contigs.map((c) => unitOf.get(c) ?? -1).filter((u) => u >= 0)
    const selectedSpans = axis.spans.filter((span) => span.id !== null && selection.genomes.includes(span.id))
    const hovered = model.hovered
    const litUnit = hovered.contig >= 0 ? (unitOf.get(hovered.contig) ?? -1) : -1
    const litSpan = hovered.contig < 0 && hovered.genome !== null ? axis.spans.find((span) => span.id === hovered.genome) : undefined
    const pointerHit = this.pointer !== null && this.large && this.press?.kind !== 'pan' ? this.hitAt(this.pointer.x, this.pointer.y) : null
    const dropSpan = this.dropLit?.kind === 'genome' && !this.dropRefused ? (axis.spans.find((span) => span.id === (this.dropLit as { id: string }).id) ?? null) : null
    const featured = close.answer === model.answer && this.large ? this.featured() : null
    const featuredUnits = new Set<number>()
    let featuredSpan: Span | undefined
    if (featured !== null && (featured.kind === 'recruit' || featured.kind === 'move')) {
      for (const c of featured.contigs) {
        const u = unitOf.get(c)
        if (u !== undefined) featuredUnits.add(u)
      }
      const target = model.answer?.genomes[featured.genomes[0]]?.id
      featuredSpan = axis.spans.find((span) => span.id === target)
    }

    for (const edge of ['top', 'left'] as const) this.closeBar(g, edge, geo, close, ink, { selected: new Set(selected), lit: litUnit, litSpan, drop: dropSpan, featured: featuredUnits, pointer: pointerHit })

    const { x, y, size } = this.map
    g.save()
    g.beginPath()
    g.rect(x, y, size, size)
    g.clip()
    this.closeRules(g, geo, close, paper)
    // What is lit and offered first, the selection over them: no halo eats into its outline.
    if (litSpan !== undefined) this.outline(g, geo, paper, litSpan.from, litSpan.to, 1.5, [4, 3])
    if (litUnit >= 0) this.bands(g, geo, paper, litUnit, litUnit + 1)
    if (featuredSpan !== undefined) this.outline(g, geo, paper, featuredSpan.from, featuredSpan.to, 2.25, [5, 3])
    if (pointerHit !== null && pointerHit.where === 'map' && !pointerHit.diagonal && this.ctx.dragging === null) this.cellOutline(g, geo, paper, pointerHit.row, pointerHit.col)
    for (const span of selectedSpans) this.outline(g, geo, paper, span.from, span.to)
    for (const [from, to] of runsOf(selected)) this.outline(g, geo, paper, from, to)
    if (dropSpan !== null) this.outline(g, geo, paper, dropSpan.from, dropSpan.to, 2.75)
    g.restore()
    if (featured !== null && featuredSpan !== undefined) {
      // The review's number in the margin beside the first contig it would bring, else beside its genome.
      const at = this.offered.findIndex((s) => s.key === featured.key)
      const first = featuredUnits.size > 0 ? Math.min(...featuredUnits) : featuredSpan.from
      const row = geo.Y(first + 0.5)
      if (at >= 0 && row >= y && row <= y + size) this.disc(g, paper, x + size + 11, row, at + 1)
    }
    if (this.large) {
      const labels: Array<{ unit: number; strong: boolean }> = []
      if (pointerHit !== null && pointerHit.where !== null && !pointerHit.names && this.ctx.dragging === null) labels.push({ unit: pointerHit.col, strong: true }, { unit: pointerHit.row, strong: true })
      if (litUnit >= 0) labels.push({ unit: litUnit, strong: true }, { unit: litUnit, strong: true })
      for (const [k, { unit, strong }] of labels.entries()) {
        const edge = k % 2 === 0 ? 'top' : 'left'
        if (unit < 0 || unit >= axis.contigs.length) continue
        const P = edge === 'top' ? geo.X : geo.Y
        const along = (P(unit) + P(unit + 1)) / 2
        const start = edge === 'top' ? x : y
        if (along < start || along > start + size) continue
        this.plate(g, edge, along, this.ctx.data.file.names[axis.contigs[unit]] ?? `#${axis.contigs[unit]}`, ink, strong)
      }
    }
  }

  /** The edges between the close-up's genomes, its candidates' dashed, and its contigs' where wide. */
  private closeRules(g: CanvasRenderingContext2D, geo: Geometry, close: CloseDrawn, paper: StageInk): void {
    const { x, y, size } = this.map
    const hair = (v: number): number => (Math.floor(v * this.dpr) + 0.5) / this.dpr
    const n = close.axis.contigs.length
    g.lineWidth = 1 / this.dpr
    if (geo.k >= HAIRLINE_PX) {
      g.strokeStyle = paper.faint
      g.globalAlpha = 0.16
      g.beginPath()
      for (let u = Math.max(1, Math.ceil(geo.x0)); u <= Math.min(n - 1, Math.floor(geo.x1)); u++) {
        const px = hair(geo.X(u))
        g.moveTo(px, y)
        g.lineTo(px, y + size)
      }
      for (let u = Math.max(1, Math.ceil(geo.y0)); u <= Math.min(n - 1, Math.floor(geo.y1)); u++) {
        const py = hair(geo.Y(u))
        g.moveTo(x, py)
        g.lineTo(x + size, py)
      }
      g.stroke()
    }
    g.strokeStyle = paper.dim
    g.globalAlpha = 0.75
    g.lineWidth = Math.max(1, 1.25 * this.dpr) / this.dpr
    for (const span of close.axis.spans) {
      if (span.from <= 0) continue
      g.setLineDash(span.id === null ? [5, 4] : [])
      g.beginPath()
      const px = hair(geo.X(span.from))
      const py = hair(geo.Y(span.from))
      g.moveTo(px, y)
      g.lineTo(px, y + size)
      g.moveTo(x, py)
      g.lineTo(x + size, py)
      g.stroke()
    }
    g.setLineDash([])
    g.globalAlpha = 1
  }

  private closeBar(
    g: CanvasRenderingContext2D,
    edge: 'top' | 'left',
    geo: Geometry,
    close: CloseDrawn,
    ink: StageInk,
    marks: { selected: ReadonlySet<number>; lit: number; litSpan: Span | undefined; drop: Span | null; featured: ReadonlySet<number>; pointer: Hit | null },
  ): void {
    const { axis, answer } = close
    const n = axis.contigs.length
    const { strip, gap, names, size: barSize } = this.bar
    const P = edge === 'top' ? geo.X : geo.Y
    const [u0, u1] = edge === 'top' ? [geo.x0, geo.x1] : [geo.y0, geo.y1]
    const start = edge === 'top' ? this.map.x : this.map.y
    const end = start + this.map.size
    const first = Math.max(0, Math.floor(u0))
    const last = Math.min(n, Math.ceil(u1))
    const lengths = this.ctx.data.file.lengths
    g.save()
    g.beginPath()
    if (edge === 'top') g.rect(start, this.map.y - barSize, this.map.size, barSize)
    else g.rect(this.map.x - barSize, start, barSize, this.map.size)
    g.clip()
    if (marks.drop !== null) {
      g.fillStyle = ink.accentSoft
      g.globalAlpha = 0.85
      this.barRect(g, edge, P(marks.drop.from), P(marks.drop.to), 0, barSize)
      g.globalAlpha = 1
    }
    // The contigs: their genome's colour (the candidates' grey), as tall as their length on a log scale.
    for (let u = first; u < last; u++) {
      const c = axis.contigs[u]
      const gi = answer.genomeOf[c] ?? -1
      const span = axis.spans[spanAt(axis.spans, u)]
      const candidate = span === undefined || span.id === null
      const a0 = P(u)
      const a1 = P(u + 1)
      const inset = a1 - a0 >= 4 ? 0.5 : 0
      const tall = this.large ? 3 + (strip - 3) * lengthShare(lengths[c] ?? 0, close.least, close.most) : strip
      g.fillStyle = candidate || gi < 0 ? this.ctx.poolColour.css : this.ctx.colourOf(answer.genomes[gi].id).css
      this.barRect(g, edge, a0 + inset, a1 - inset, gap, gap + tall)
    }
    // Each genome's edge, across the strip: its name's dimension line ends there too.
    g.fillStyle = ink.dim
    g.globalAlpha = 0.8
    for (const span of axis.spans) {
      if (span.from <= 0) continue
      const at = P(span.from)
      if (at >= start && at <= end) this.barRect(g, edge, at - 0.75, at + 0.75, 0, gap + strip + 2)
    }
    g.globalAlpha = 1
    // The selection, and what the suggestion in review would bring.
    g.fillStyle = ink.accent
    for (const [from, to] of runsOf(marks.selected)) this.barRect(g, edge, P(from), P(to), 0, Math.max(1.5, gap - 0.5))
    for (const u of marks.featured) {
      const mid = (P(u) + P(u + 1)) / 2
      if (mid < start || mid > end) continue
      const tip = gap + strip + 1
      g.beginPath()
      if (edge === 'top') {
        g.moveTo(mid - 3.5, this.map.y - tip - 5)
        g.lineTo(mid + 3.5, this.map.y - tip - 5)
        g.lineTo(mid, this.map.y - tip)
      } else {
        g.moveTo(this.map.x - tip - 5, mid - 3.5)
        g.lineTo(this.map.x - tip - 5, mid + 3.5)
        g.lineTo(this.map.x - tip, mid)
      }
      g.closePath()
      g.fill()
    }
    const outlined = new Set<number>()
    if (marks.lit >= 0) outlined.add(marks.lit)
    const pointer = marks.pointer
    if (pointer !== null && pointer.where !== null && !pointer.names && this.ctx.dragging === null) outlined.add(edge === 'top' ? pointer.col : pointer.row)
    g.strokeStyle = ink.accent
    g.lineWidth = 1.5
    for (const u of outlined) {
      if (u < 0 || u >= n) continue
      const a0 = P(u)
      const a1 = Math.max(P(u + 1), a0 + 2)
      if (edge === 'top') g.strokeRect(a0, this.map.y - gap - strip, a1 - a0, strip)
      else g.strokeRect(this.map.x - gap - strip, a0, strip, a1 - a0)
    }
    // The genomes' names, and the candidates'.
    if (this.large && names > 0) {
      const c = gap + strip + NAMES_GAP + names / 2
      const pointerSpan = pointer !== null && pointer.where !== null && pointer.where !== 'map' && pointer.names ? spanAt(axis.spans, pointer.row) : -1
      axis.spans.forEach((span, k) => {
        const a0 = Math.max(start, P(span.from))
        const a1 = Math.min(end, P(span.to))
        if (a1 <= a0) return
        const count = fmt.int(span.to - span.from)
        const labels = span.id === null ? [`candidates · ${count}`, `+${count}`] : [`${this.ctx.shortName(span.id)} · ${count}`, this.ctx.shortName(span.id)]
        const lit = k === pointerSpan || marks.litSpan === span || marks.drop === span
        this.dimension(g, edge, a0, a1, c, labels, ink, lit ? ink.accent : span.id === null ? ink.dim : ink.text, span.id === null ? '' : '600')
      })
    }
    g.restore()
  }

  // --- The key ---------------------------------------------------------------

  private paintKey(): void {
    this.keyDirty = false
    const canvas = this.keyRamp
    const g = canvas.getContext('2d')
    const ink = this.ctx.ink()
    const genomes = this.genomes
    const close = this.close
    let ticks: KeyTick[] = []
    let title = 'affinity'
    let words = ''
    if (this.level === 'genomes' && genomes !== null) {
      ticks = affinityTicks(genomes.map.vmin, genomes.map.vmax, genomes.map.background)
      words = `Affinity, at least: how densely two genomes meet against how densely each meets itself. ${affinityText(genomes.map.background)} is the background, spurious ligation; 1, as densely as a genome's own contigs.`
    } else if (close !== null && this.held?.picture) {
      const picture = this.held.picture
      title = 'observed / expected'
      ticks = ratioTicks(picture.vmin, picture.vmax, this.held.background)
      words = `Observed over expected: a pair's contacts over what the two contigs' contacts with every contig expect. ${affinityText(this.held.background)} is the background, spurious ligation; 1, as many as expected.`
    } else title = this.level === 'genomes' ? 'affinity' : 'observed / expected'
    this.keyTitle.textContent = title
    canvas.setAttribute('aria-label', words === '' ? title : words)
    canvas.title = words
    const dpr = this.dpr
    // As tall as its two lines of words, at the text's scale.
    const height = Math.ceil(KEY_HEIGHT - 18.5 + 18.5 * getTextScale())
    canvas.width = Math.round(KEY_WIDTH * dpr)
    canvas.height = Math.round(height * dpr)
    canvas.style.width = `${KEY_WIDTH}px`
    canvas.style.height = `${height}px`
    if (g === null) return
    g.setTransform(dpr, 0, 0, dpr, 0, 0)
    g.clearRect(0, 0, KEY_WIDTH, height)
    const left = 3
    const right = KEY_WIDTH - 3
    const top = 1
    const ramp = 6
    // The ramp, a device pixel a step, in the map's own colours.
    const steps = Math.max(1, Math.round((right - left) * dpr))
    for (let k = 0; k < steps; k++) {
      g.fillStyle = colormapCss(DEFAULT_UI_COLORMAP, (k + 0.5) / steps)
      g.fillRect(left + k / dpr, top, 1 / dpr + 0.02, ramp)
    }
    g.strokeStyle = ink.faint
    g.globalAlpha = 0.6
    g.lineWidth = 1 / dpr
    g.strokeRect(left + 0.5 / dpr, top + 0.5 / dpr, right - left - 1 / dpr, ramp - 1 / dpr)
    g.globalAlpha = 1
    if (ticks.length === 0) return
    // The ticks, their values under them, and a word under the two that have one.
    const family = ink.font.replace(/^[\d.]+px\s*/, '')
    const valueSize = 9.5 * getTextScale()
    const noteSize = 9 * getTextScale()
    const valuesAt = top + ramp + 3
    const notesAt = valuesAt + valueSize + 1
    g.textBaseline = 'top'
    g.textAlign = 'left'
    g.fillStyle = ink.dim
    for (const tick of ticks) g.fillRect(Math.round((left + tick.at * (right - left)) * dpr) / dpr - 0.5 / dpr, top + ramp, 1 / dpr, 2.5)
    g.font = `${valueSize}px ${family}`
    const values = placeLabels(
      ticks.map((tick) => ({ at: left + tick.at * (right - left), width: g.measureText(tick.label).width })),
      KEY_WIDTH,
      4,
      8,
    )
    g.fillStyle = ink.text
    ticks.forEach((tick, k) => {
      const from = values[k]
      if (from !== null) g.fillText(tick.label, from, valuesAt)
    })
    const noted = ticks.filter((tick) => tick.note !== undefined)
    g.font = `${noteSize}px ${family}`
    const notes = placeLabels(
      noted.map((tick) => ({ at: left + tick.at * (right - left), width: g.measureText(tick.note ?? '').width })),
      KEY_WIDTH,
      6,
      30,
    )
    g.fillStyle = ink.faint
    noted.forEach((tick, k) => {
      const from = notes[k]
      if (from !== null) g.fillText(tick.note ?? '', from, notesAt)
    })
  }

  // --- The head and the note ---------------------------------------------------

  private paintHead(): void {
    const at = this.level
    const parts: HTMLElement[] = []
    const home = el('button', {
      class: 'curate-crumb',
      text: 'genomes',
      title: at === 'genomes' ? 'Every genome, one cell each' : `Back to every genome (${shifted('enter')})`,
      attrs: { type: 'button', ...(at === 'genomes' ? { 'aria-current': 'page' } : {}) },
      on: { click: () => this.back() },
    })
    parts.push(home)
    const answer = this.ctx.model.answer
    if (at === 'contigs' && answer !== null) {
      const names = this.focusIds.map((id) => this.ctx.shortName(id))
      const full = this.focusIds.map((id) => answer.genomes.find((genome) => genome.id === id)?.name ?? id)
      const shown = names.length <= 3 ? names.join(', ') : `${names.slice(0, 2).join(', ')} + ${fmt.int(names.length - 2)}`
      parts.push(el('span', { class: 'curate-crumb-sep', text: '›', attrs: { 'aria-hidden': 'true' } }))
      parts.push(el('span', { class: 'curate-crumb-here', text: shown, title: full.join('\n'), attrs: { 'aria-current': 'page' } }))
      const axis = this.close?.axis
      if (axis !== undefined) {
        const candidates = axis.spans.find((span) => span.id === null)
        const total = axis.contigs.length - (candidates === undefined ? 0 : candidates.to - candidates.from)
        const counted = candidates === undefined ? `${fmt.int(total)} contigs` : `${fmt.int(total)} contigs · ${fmt.int(candidates.to - candidates.from)} candidate${candidates.to - candidates.from === 1 ? '' : 's'}`
        parts.push(el('span', { class: 'curate-crumb-count', text: counted }))
      }
    } else if (answer !== null) {
      const n = this.genomes?.axis.genomes.length ?? 0
      parts.push(el('span', { class: 'curate-crumb-count', text: n === 0 ? '' : `${fmt.int(n)}` }))
    }
    this.crumbs.replaceChildren(...parts)
    const selection = this.ctx.model.selection
    const can = at === 'genomes' && this.large && (selection.genomes.length > 0 || selection.contigs.some((c) => (answer?.genomeOf[c] ?? -1) >= 0))
    this.act.classList.toggle('hidden', !can)
  }

  private paintNote(): void {
    const answer = this.ctx.model.answer
    let text: string | null = null
    let retry = false
    if (!this.large) text = null
    else if (answer === null) text = 'weighing the binning…'
    else if (this.level === 'genomes') {
      if ((this.genomes?.axis.genomes.length ?? 0) === 0) text = 'No genomes yet: select contigs and press B to make one.'
      else if (!answer.counted) text = 'The cells fill in once every contact between contigs is read.'
    } else if (!answer.counted) text = 'The close-up draws the contacts, which are being read.'
    else if (this.closeNote !== null) text = this.closeNote
    else if (this.closeError !== null) {
      text = `The close-up could not be read: ${this.closeError}`
      retry = true
    } else if (this.request !== null && this.close?.reads !== true) text = `reading the contacts among ${fmt.int(this.requested?.length ?? 0)} contigs…`
    if (text === null) {
      if (!this.note.classList.contains('hidden')) this.note.classList.add('hidden')
      return
    }
    const key = `${text}\u0000${retry}`
    if (this.note.dataset.said === key && !this.note.classList.contains('hidden')) return
    this.note.dataset.said = key
    const parts: Array<HTMLElement | string> = [text]
    if (retry) {
      parts.push(
        ' ',
        el('button', {
          class: 'btn-link',
          text: 'read it again',
          attrs: { type: 'button' },
          on: {
            click: () => {
              this.closeError = null
              this.held = null
              this.rebuild()
            },
          },
        }),
      )
    }
    this.note.replaceChildren(...parts)
    this.note.classList.remove('hidden')
  }

  // -------------------------------------------------------------------------
  // Hit-testing.
  // -------------------------------------------------------------------------

  /** What a point of the plot is over, in CSS pixels of the plot. */
  private hitAt(x: number, y: number): Hit {
    const none: Hit = { where: null, row: -1, col: -1, diagonal: false, names: false, near: -1 }
    const n = this.units
    const { x: mx, y: my, size } = this.map
    if (n <= 0 || size <= 0) return none
    const geo = this.geometry()
    const unitX = geo.x0 + (x - mx) / geo.k
    const unitY = geo.y0 + (y - my) / geo.k
    const inX = x >= mx && x < mx + size
    const inY = y >= my && y < my + size
    const valid = (u: number): number => (u >= 0 && u < n ? u : -1)
    if (inX && inY) {
      const col = valid(Math.floor(unitX))
      const row = valid(Math.floor(unitY))
      if (col < 0 || row < 0) return none
      if (row === col) return { where: 'map', row, col, diagonal: true, names: false, near: row }
      const offset = geo.X(0) - mx - (geo.Y(0) - my)
      const distance = Math.abs(x - mx - (y - my) - offset) / Math.SQRT2
      const near = geo.k < CELL_HIT_PX && distance <= DIAGONAL_PX ? valid(Math.floor((unitX + unitY) / 2)) : -1
      return { where: 'map', row, col, diagonal: false, names: false, near }
    }
    const bar = this.bar.size
    const namesFrom = this.bar.gap + this.bar.strip + 1
    if (inX && y >= my - bar && y < my) {
      const u = valid(Math.floor(unitX))
      return u < 0 ? none : { where: 'top', row: u, col: u, diagonal: false, names: my - y > namesFrom, near: u }
    }
    if (inY && x >= mx - bar && x < mx) {
      const u = valid(Math.floor(unitY))
      return u < 0 ? none : { where: 'left', row: u, col: u, diagonal: false, names: mx - x > namesFrom, near: u }
    }
    return none
  }

  /** Where something held would drop at a point of the plot: a genome's block, its cell on the diagonal or near it, a span. */
  private targetAt(x: number, y: number): CurateDropTarget | null {
    const hit = this.hitAt(x, y)
    if (hit.where === null || hit.near < 0) return null
    const id = this.genomeOfUnit(hit.near)
    return id === null ? null : { kind: 'genome', id }
  }

  /** The genome a unit is, or is in; `null` for a candidate or the pool. */
  private genomeOfUnit(unit: number): string | null {
    if (this.level === 'genomes') {
      const drawn = this.genomes
      if (drawn === null || unit < 0 || unit >= drawn.axis.genomes.length) return null
      return drawn.answer.genomes[drawn.axis.genomes[unit]].id
    }
    const close = this.close
    if (close === null) return null
    const span = close.axis.spans[spanAt(close.axis.spans, unit)]
    return span?.id ?? null
  }

  // -------------------------------------------------------------------------
  // The hand.
  // -------------------------------------------------------------------------

  private wire(): void {
    const overlay = this.overlay
    overlay.addEventListener('pointerdown', (event) => this.pointerDown(event))
    overlay.addEventListener('pointermove', (event) => this.pointerMove(event))
    overlay.addEventListener('pointerup', (event) => this.pointerUp(event))
    overlay.addEventListener('pointercancel', (event) => {
      this.release(event.pointerId)
      this.cancelPress()
    })
    overlay.addEventListener('pointerleave', () => this.pointerLeave())
    overlay.addEventListener('dblclick', (event) => this.doubleClick(event))
    overlay.addEventListener('wheel', (event) => this.wheel(event), { passive: false })
    overlay.addEventListener('contextmenu', (event) => {
      if (this.large) event.preventDefault()
    })
    // Space held pans: heard on the window, never taken from the stage, which
    // previews the review's step with it.
    const down = (event: KeyboardEvent): void => {
      if (event.key === ' ' && !typing(event.target)) this.setSpace(true)
    }
    const up = (event: KeyboardEvent): void => {
      if (event.key === ' ') this.setSpace(false)
    }
    const blur = (): void => this.setSpace(false)
    // A drag the stage carried ends with no event here: its last frame is drawn without it.
    const released = (): void => {
      if (this.dropLit === null && !this.dragOver) return
      requestAnimationFrame(() => {
        if (this.ctx.dragging !== null) return
        const was = this.dragOver
        this.dropLit = null
        this.dragOver = false
        if (was && this.level === 'genomes') this.rebuild()
        else this.schedule()
      })
    }
    window.addEventListener('keydown', down, true)
    window.addEventListener('keyup', up, true)
    window.addEventListener('blur', blur)
    window.addEventListener('pointerup', released)
    this.offs.push(() => {
      window.removeEventListener('keydown', down, true)
      window.removeEventListener('keyup', up, true)
      window.removeEventListener('blur', blur)
      window.removeEventListener('pointerup', released)
    })
  }

  private setSpace(on: boolean): void {
    if (on === this.space) return
    this.space = on
    if (this.pointer !== null) this.paintCursor(this.pointer.x, this.pointer.y)
  }

  private local(event: MouseEvent): { x: number; y: number } {
    const rect = this.plot.getBoundingClientRect()
    return { x: event.clientX - rect.left, y: event.clientY - rect.top }
  }

  private capture(pointer: number): void {
    try {
      this.overlay.setPointerCapture?.(pointer)
    } catch {
      // A pointer that is gone: nothing to hold.
    }
  }

  private release(pointer: number): void {
    try {
      if (this.overlay.hasPointerCapture?.(pointer) === true) this.overlay.releasePointerCapture(pointer)
    } catch {
      // Already let go.
    }
  }

  /** Whether a unit is selected: its genome, or close up its contig. */
  private isSelected(unit: number): boolean {
    const selection = this.ctx.model.selection
    if (this.level === 'genomes') {
      const id = this.genomeOfUnit(unit)
      return id !== null && selection.genomes.includes(id)
    }
    const c = this.close?.axis.contigs[unit]
    return c !== undefined && selection.contigs.includes(c)
  }

  private pointerDown(event: PointerEvent): void {
    if (!this.large || this.units <= 0) return
    if (event.button !== 0 && event.button !== 1) return
    if (this.ctx.dragging !== null) return
    const { x, y } = this.local(event)
    this.overlay.focus({ preventScroll: true })
    const mod: Modifiers = { meta: event.metaKey || event.ctrlKey, shift: event.shiftKey }
    if (event.button === 1 || this.space) {
      this.press = { kind: 'pan', pointer: event.pointerId, x, y }
    } else {
      const hit = this.hitAt(x, y)
      if (hit.where === null) return
      if (this.level === 'contigs' && hit.where !== 'map' && hit.names) {
        // A genome's name selects its contigs, which a drag then carries.
        const close = this.close
        const span = close === null ? undefined : close.axis.spans[spanAt(close.axis.spans, hit.row)]
        if (close === null || span === undefined) return
        this.selectSpan(span, mod)
        this.press = { kind: 'carry', pointer: event.pointerId, x, y, unit: -1, mod }
      } else if (hit.where !== 'map' || hit.diagonal) {
        const unit = hit.row
        if (!mod.meta && !mod.shift && this.isSelected(unit)) this.press = { kind: 'carry', pointer: event.pointerId, x, y, unit, mod }
        else this.press = { kind: 'run', pointer: event.pointerId, x, y, moved: false, anchor: unit, to: unit, where: hit.where, mod, base: this.ctx.model.selection }
      } else {
        this.press = { kind: 'cell', pointer: event.pointerId, x, y, row: hit.row, col: hit.col, near: hit.near, mod }
      }
    }
    this.capture(event.pointerId)
    event.preventDefault()
    this.paintCursor(x, y)
    this.schedule()
  }

  private pointerMove(event: PointerEvent): void {
    const { x, y } = this.local(event)
    this.pointer = { x, y }
    if (!this.large) return
    const press = this.press
    if (press === null) {
      if (this.ctx.dragging !== null) this.lightDrop(x, y)
      else this.hoverAt(x, y)
      return
    }
    if (event.pointerId !== press.pointer) return
    switch (press.kind) {
      case 'pan':
        this.panBy(x - press.x, y - press.y)
        press.x = x
        press.y = y
        return
      case 'run': {
        if (!press.moved && Math.hypot(x - press.x, y - press.y) < DRAG_PX) return
        press.moved = true
        const to = this.runUnit(press.where, x, y)
        if (to !== press.to) {
          press.to = to
          this.selectRun(press.anchor, to, press.mod, press.base)
        }
        this.hoverAt(x, y)
        return
      }
      case 'carry': {
        if (Math.hypot(x - press.x, y - press.y) < DRAG_PX) return
        this.press = null
        this.release(press.pointer)
        this.carry(event)
        return
      }
      case 'cell': {
        if (Math.hypot(x - press.x, y - press.y) < DRAG_PX) return
        if (press.near >= 0) {
          // Pressed beside the diagonal, where cells are small: a drag is the
          // diagonal's — the selection carried from it, or a run along it.
          if (!press.mod.meta && !press.mod.shift && this.isSelected(press.near)) {
            this.press = null
            this.release(press.pointer)
            this.carry(event)
            return
          }
          const to = this.runUnit('map', x, y)
          this.press = { kind: 'run', pointer: press.pointer, x, y, moved: true, anchor: press.near, to, where: 'map', mod: press.mod, base: this.ctx.model.selection }
          this.selectRun(press.near, to, press.mod, this.press.base)
          this.hoverAt(x, y)
          return
        }
        // A drag off the diagonal moves the view.
        this.press = { kind: 'pan', pointer: press.pointer, x, y }
        this.panBy(x - press.x, y - press.y)
        this.paintCursor(x, y)
        return
      }
    }
  }

  private pointerUp(event: PointerEvent): void {
    const press = this.press
    if (press === null || event.pointerId !== press.pointer) return
    this.press = null
    this.release(press.pointer)
    switch (press.kind) {
      case 'run':
        if (!press.moved) this.clickUnit(press.anchor, press.mod)
        else this.anchor = this.anchorOf(press.anchor)
        break
      case 'carry':
        if (press.unit >= 0) this.clickUnit(press.unit, press.mod)
        break
      case 'cell':
        this.clickCell(press.row, press.col, press.mod)
        break
      case 'pan':
        break
    }
    const { x, y } = this.local(event)
    this.paintCursor(x, y)
    this.schedule()
  }

  private pointerLeave(): void {
    this.pointer = null
    if (this.dragOver || this.dropLit !== null) {
      const was = this.dragOver
      this.dragOver = false
      this.dropLit = null
      if (was && this.level === 'genomes') this.rebuild()
    }
    if (this.press === null && this.ctx.dragging === null) {
      this.ctx.model.hover(null)
      if (this.said !== null) {
        this.said = null
        this.ctx.say(null)
      }
    }
    this.schedule()
  }

  /** Let go of whatever the hand holds: Escape, a cancelled pointer, the pane made small. */
  private cancelPress(): void {
    const press = this.press
    this.press = null
    if (press?.kind === 'run' && press.moved) this.ctx.model.select(press.base)
    this.schedule()
  }

  private letGo(): void {
    if (this.press !== null) this.release(this.press.pointer)
    this.press = null
    this.pointer = null
    if (this.said !== null) {
      this.said = null
      this.ctx.say(null)
    }
  }

  private doubleClick(event: MouseEvent): void {
    if (!this.large) return
    const { x, y } = this.local(event)
    const hit = this.hitAt(x, y)
    if (hit.where === 'map' && !hit.diagonal && hit.near < 0) {
      this.fit()
      return
    }
    if (this.level !== 'genomes' || hit.where === null) return
    // A double click on one of several genomes selected opens them all: the
    // first of its two clicks had narrowed the selection to it.
    const last = this.lastClick
    const id = this.genomeOfUnit(hit.row)
    if (last !== null && performance.now() - last.at < DOUBLE_MS && id !== null && last.before.genomes.includes(id)) this.ctx.model.select(last.before)
    this.lastClick = null
    this.closeUp()
  }

  private wheel(event: WheelEvent): void {
    if (!this.large || this.units <= 0) return
    event.preventDefault()
    const { x, y } = this.local(event)
    const geo = this.geometry()
    if (event.shiftKey || Math.abs(event.deltaX) > Math.abs(event.deltaY)) {
      const d = event.shiftKey ? event.deltaY : event.deltaX
      this.panBy(-d, -d)
      return
    }
    const factor = Math.exp(event.deltaY * (event.deltaMode === 1 ? 0.05 : 0.002))
    const hit = this.hitAt(x, y)
    const ux = geo.x0 + (x - this.map.x) / geo.k
    const uy = geo.y0 + (y - this.map.y) / geo.k
    // Over a bar, about the diagonal at the bar's place.
    const about = hit.where === 'top' ? { x: ux, y: ux } : hit.where === 'left' ? { x: uy, y: uy } : { x: ux, y: uy }
    this.zoomBy(factor, about)
  }

  /** The unit a run reaches: along a bar, or the pointer brought onto the diagonal. */
  private runUnit(where: 'map' | 'top' | 'left', x: number, y: number): number {
    const geo = this.geometry()
    const ux = geo.x0 + (x - this.map.x) / geo.k
    const uy = geo.y0 + (y - this.map.y) / geo.k
    const unit = where === 'top' ? ux : where === 'left' ? uy : (ux + uy) / 2
    return Math.max(0, Math.min(this.units - 1, Math.floor(unit)))
  }

  // --- Selecting ----------------------------------------------------------------

  /** A unit's identity, kept across a recount: a genome's id, a contig's index. */
  private anchorOf(unit: number): { level: Level; id: string | number } | null {
    if (this.level === 'genomes') {
      const id = this.genomeOfUnit(unit)
      return id === null ? null : { level: 'genomes', id }
    }
    const c = this.close?.axis.contigs[unit]
    return c === undefined ? null : { level: 'contigs', id: c }
  }

  private anchorUnit(): number {
    const anchor = this.anchor
    if (anchor === null || anchor.level !== this.level) return -1
    if (this.level === 'genomes') {
      const drawn = this.genomes
      const g = typeof anchor.id === 'string' ? this.indexOf.get(anchor.id) : undefined
      return drawn === null || g === undefined ? -1 : drawn.axis.slotOf[g]
    }
    return this.close?.axis.contigs.indexOf(anchor.id as number) ?? -1
  }

  /** The units `[from, to]` as what they select: genomes' ids, or contigs. */
  private unitsBetween(a: number, b: number): { genomes: string[]; contigs: number[] } {
    const lo = Math.min(a, b)
    const hi = Math.max(a, b)
    if (this.level === 'genomes') {
      const ids: string[] = []
      for (let u = lo; u <= hi; u++) {
        const id = this.genomeOfUnit(u)
        if (id !== null) ids.push(id)
      }
      return { genomes: ids, contigs: [] }
    }
    const axis = this.close?.axis
    return { genomes: [], contigs: axis === undefined ? [] : Array.from(axis.contigs.subarray(lo, hi + 1)) }
  }

  /** A press on a unit let go where it was: select it, ⌘ toggle it, ⇧ extend to it from the last. */
  private clickUnit(unit: number, mod: Modifiers): void {
    const model = this.ctx.model
    const before = model.selection
    const from = this.anchorUnit()
    if (mod.shift && from >= 0) {
      const run = this.unitsBetween(from, unit)
      if (this.level === 'genomes') model.selectGenomes(run.genomes)
      else model.selectContigs(run.contigs)
      return
    }
    const one = this.unitsBetween(unit, unit)
    const how = mod.meta ? 'toggle' : 'replace'
    if (this.level === 'genomes') model.selectGenomes(one.genomes, how)
    else model.selectContigs(one.contigs, how)
    this.anchor = this.anchorOf(unit)
    this.lastClick = { at: performance.now(), before }
  }

  /** A press off the diagonal: the pair — both genomes, or close up both contigs. */
  private clickCell(row: number, col: number, mod: Modifiers): void {
    const model = this.ctx.model
    const a = this.unitsBetween(row, row)
    const b = this.unitsBetween(col, col)
    const how = mod.meta ? 'toggle' : mod.shift ? 'add' : 'replace'
    if (this.level === 'genomes') model.selectGenomes([...a.genomes, ...b.genomes], how)
    else model.selectContigs([...a.contigs, ...b.contigs], how)
    this.anchor = this.anchorOf(row)
  }

  /** A drag along the diagonal or a bar: the run, live; ⌘ adds it to what was selected. */
  private selectRun(anchor: number, to: number, mod: Modifiers, base: CurateSelection): void {
    const model = this.ctx.model
    const run = this.unitsBetween(anchor, to)
    if (mod.meta || mod.shift) {
      model.select({ genomes: [...base.genomes, ...run.genomes], contigs: [...base.contigs, ...run.contigs] })
      return
    }
    if (this.level === 'genomes') model.selectGenomes(run.genomes)
    else model.selectContigs(run.contigs)
  }

  /** A genome's name on a close-up's bar: its contigs — ⌘ takes them away again where all are selected. */
  private selectSpan(span: Span, mod: Modifiers): void {
    const model = this.ctx.model
    const axis = this.close?.axis
    if (axis === undefined) return
    const contigs = Array.from(axis.contigs.subarray(span.from, span.to))
    const selection = model.selection
    if (mod.meta || mod.shift) {
      const held = new Set(selection.contigs)
      const all = contigs.every((c) => held.has(c))
      const next = all && mod.meta ? selection.contigs.filter((c) => !contigs.includes(c)) : [...selection.contigs, ...contigs]
      model.select({ genomes: selection.genomes, contigs: next })
    } else model.selectContigs(contigs)
    this.anchor = this.anchorOf(span.from)
  }

  /** Carry the selection: the stage draws it held and makes the drop's step. */
  private carry(event: PointerEvent): void {
    const selection = this.ctx.model.selection
    if (this.level === 'genomes') {
      if (selection.genomes.length > 0) this.ctx.startDrag({ kind: 'genomes', ids: [...selection.genomes] }, event)
    } else if (selection.contigs.length > 0) this.ctx.startDrag({ kind: 'contigs', contigs: [...selection.contigs] }, event)
    if (this.said !== null) this.said = null
    this.schedule()
  }

  // --- Hover, the readout, the drop ---------------------------------------------

  private hoverAt(x: number, y: number): void {
    const hit = this.hitAt(x, y)
    this.paintCursor(x, y, hit)
    const model = this.ctx.model
    let genome: string | null = null
    let contig = -1
    let words: string | null = null
    if (hit.where !== null) {
      if (this.level === 'genomes') {
        genome = this.genomeOfUnit(hit.row)
        words = hit.where === 'map' && !hit.diagonal ? this.pairWords(hit.row, hit.col) : this.genomeWords(hit.row)
      } else if (hit.where !== 'map' && hit.names) {
        const close = this.close
        const span = close === null ? undefined : close.axis.spans[spanAt(close.axis.spans, hit.row)]
        genome = span?.id ?? null
        words = span === undefined ? null : this.spanWords(span)
      } else {
        const close = this.close
        contig = close?.axis.contigs[hit.row] ?? -1
        const gi = contig >= 0 && close !== null ? (close.answer.genomeOf[contig] ?? -1) : -1
        genome = gi >= 0 && close !== null ? close.answer.genomes[gi].id : null
        words = hit.where === 'map' && !hit.diagonal ? this.contigPairWords(hit.row, hit.col) : this.contigWords(hit.row)
      }
    }
    model.hover(genome, contig)
    if (words !== this.said) {
      this.said = words
      this.ctx.say(words)
    }
    this.schedule()
  }

  private lightDrop(x: number, y: number): void {
    const target = this.targetAt(x, y)
    const wasOver = this.dragOver
    this.dragOver = true
    if (!wasOver && this.level === 'genomes') this.rebuild()
    if (sameTarget(target, this.dropLit)) return
    this.dropLit = target
    this.dropRefused = target === null ? false : (this.ctx.dropWords(target)?.refused ?? false)
    this.schedule()
  }

  private paintCursor(x: number, y: number, hit: Hit = this.hitAt(x, y)): void {
    let cursor = ''
    if (this.press?.kind === 'pan') cursor = 'grabbing'
    else if (this.space) cursor = 'grab'
    else if (hit.where === 'map' && !hit.diagonal) cursor = this.fitted ? 'crosshair' : 'grab'
    else if (hit.where !== null) cursor = this.isSelected(hit.row) || (this.level === 'contigs' && hit.names && hit.where !== 'map') ? 'grab' : 'pointer'
    if (this.overlay.dataset.cursor !== cursor) this.overlay.dataset.cursor = cursor
  }

  // --- Words ---------------------------------------------------------------------

  /** A genome on the diagonal or a bar: its length, its contigs, its quality or its hosts. */
  private genomeWords(slot: number): string | null {
    const drawn = this.genomes
    if (drawn === null || slot < 0 || slot >= drawn.axis.genomes.length) return null
    const genome = drawn.answer.genomes[drawn.axis.genomes[slot]]
    const parts = [this.ctx.shortName(genome.id), fmt.bp(genome.length), `${fmt.int(genome.contigs)} contig${genome.contigs === 1 ? '' : 's'}`]
    if (genome.kind === 'mag') {
      const q = genome.quality
      if (q !== null) parts.push(`${fmt.pct(q.weightedCompleteness, 0)} complete`, `${fmt.fixed(q.weightedRedundancy, 2)} redundant`)
    } else {
      const hosts = drawn.answer.links.filter((link) => link.element === genome.id).map((link) => this.ctx.shortName(link.mag))
      parts.push(hosts.length === 0 ? 'an element, no host' : `an element, hosted by ${hosts.join(', ')}`)
    }
    return parts.join(' · ')
  }

  /** Two genomes: their affinity and its lower bound, their contacts, and what is suggested of them. */
  private pairWords(row: number, col: number): string | null {
    const drawn = this.genomes
    if (drawn === null) return null
    const { axis, answer, map } = drawn
    const a = axis.genomes[row]
    const b = axis.genomes[col]
    if (a === undefined || b === undefined) return null
    const A = answer.genomes[a]
    const B = answer.genomes[b]
    const parts = [`${this.ctx.shortName(A.id)} × ${this.ctx.shortName(B.id)}`]
    if (!answer.counted) {
      parts.push('the contacts are being read')
      return parts.join(' · ')
    }
    const k = pairOf(map, answer.genomes.length, a, b)
    if (k < 0) parts.push('no contacts')
    else {
      const affinity = answer.pairs.affinity[k]
      const contacts = answer.pairs.contacts[k]
      const lower = lowerAffinity(affinity, contacts)
      parts.push(`affinity ${affinityText(affinity)} (at least ${affinityText(lower)})`, `${fmt.int(contacts)} contact${contacts === 1 ? '' : 's'}`)
    }
    // What is held and what is offered between them.
    const element = A.kind === 'element' ? A : B.kind === 'element' ? B : null
    const mag = A.kind === 'mag' ? A : B.kind === 'mag' ? B : null
    if (element !== null && mag !== null && element !== mag) {
      if (answer.links.some((link) => link.element === element.id && link.mag === mag.id)) {
        const fromFile = this.ctx.data.file.links.some((link) => link.element === element.id && link.mag === mag.id)
        parts.push(fromFile ? 'linked, from the file' : 'linked')
      }
    }
    if (answer === this.ctx.model.answer) {
      const s = this.offered.find((x) => (x.kind === 'merge' || x.kind === 'link' || x.kind === 'unlink') && x.genomes.includes(a) && x.genomes.includes(b))
      if (s !== undefined) parts.push(`${s.kind} ${displayPercent(s.confidence)}%`)
    }
    return parts.join(' · ')
  }

  /** A close-up's contig: its length, its genome, and where a suggestion would take it. */
  private contigWords(unit: number): string | null {
    const close = this.close
    if (close === null) return null
    const c = close.axis.contigs[unit]
    if (c === undefined) return null
    const { names, lengths } = this.ctx.data.file
    const g = close.answer.genomeOf[c] ?? -1
    const parts = [names[c] ?? `#${c}`, fmt.bp(lengths[c] ?? 0), g < 0 ? 'unbinned' : `in ${this.ctx.shortName(close.answer.genomes[g].id)}`]
    const s = this.bringing.get(c)
    const answer = this.ctx.model.answer
    if (s !== undefined && answer !== null) {
      const target = answer.genomes[s.genomes[0]]
      if (target !== undefined) parts.push(`${s.kind === 'recruit' ? 'recruit into' : 'move to'} ${this.ctx.shortName(target.id)} ${displayPercent(s.confidence)}%`)
    }
    const places = close.answer.contigs
    const own = places.ownAffinity[c]
    if (Number.isFinite(own)) parts.push(`own affinity ${affinityText(own)}`)
    const best = places.best[c] ?? -1
    if (best >= 0 && close.answer.genomes[best] !== undefined) parts.push(`best ${this.ctx.shortName(close.answer.genomes[best].id)}, affinity ${affinityText(places.bestAffinity[c])}`)
    return parts.join(' · ')
  }

  /** Two contigs: their contacts, and those over what their contacts with every contig expect. */
  private contigPairWords(row: number, col: number): string | null {
    const close = this.close
    const held = this.held
    if (close === null) return null
    const a = close.axis.contigs[row]
    const b = close.axis.contigs[col]
    if (a === undefined || b === undefined) return null
    const { names } = this.ctx.data.file
    const parts = [`${names[a] ?? `#${a}`} × ${names[b] ?? `#${b}`}`]
    const i = close.cellMap[row] ?? -1
    const j = close.cellMap[col] ?? -1
    if (held === null || i < 0 || j < 0) {
      parts.push('reading…')
      return parts.join(' · ')
    }
    const contacts = focusContactsOf(held, i, j)
    if (!(contacts > 0)) parts.push('no contacts')
    else {
      const ratio = pairRatio(contacts, held.visibility[i], held.visibility[j], held.total)
      parts.push(`${fmt.int(contacts)} contact${contacts === 1 ? '' : 's'}`, `${ratioText(ratio)} expected`)
    }
    return parts.join(' · ')
  }

  /** A close-up's genome, or its candidates, by the name on the bar. */
  private spanWords(span: Span): string {
    const count = span.to - span.from
    if (span.id === null) return `candidates · ${fmt.int(count)} contig${count === 1 ? '' : 's'} a suggestion would bring into these genomes · press to select them, drag them onto a genome`
    return `${this.ctx.shortName(span.id)} · ${fmt.int(count)} contig${count === 1 ? '' : 's'} · press to select them, drag them onto another genome`
  }
}
