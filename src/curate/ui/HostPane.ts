/**
 * The curation stage's host map (SPECS §33.3): which MAG hosts which mobile
 * element — the links held, from the file or made since, and the ones the
 * contacts offer — so a plasmid, a phage or an element in pieces is seen
 * beside the genome it lives in.
 *
 * **Two columns.** The MAGs on the left in the stage's order, the elements on
 * the right, each beside the MAG it meets most (`hostLayout.ts`), so a link
 * mostly runs level and a MAG that hosts many elements fans out to them;
 * placed when the stage opens and on *tidy*, then kept, so nothing moves under
 * the hand. Elements that meet no MAG fold into the foot (`46 meet no MAG ▸`),
 * open on a press. A node is a bar, as wide as its genome is long on a log
 * scale, in its genome's colour; its name where it has room, and always for
 * what is lit, selected or linked to them.
 *
 * **The links**, curves from a MAG to an element: a link **held** in ink, as
 * wide as the share of the element's contacts with MAGs it takes; a link
 * **offered** dashed in the accent; a held link a suggestion would undo
 * crossed in the accent; the review's question thicker, with its number.
 * Pairs neither held nor offered are not drawn. While anything is selected or
 * lit, the rest drops back. Never the pool (§7.4).
 *
 * The hand: a press selects a node (⌘ toggles, ⇧ extends along its column); a
 * press on a link selects its two genomes; **an element dragged onto a MAG is
 * linked to it** — the stage's one drop grammar makes the step, so a MAG
 * dropped on a MAG merges them. The wheel scrolls the columns, ⌘ or Ctrl with
 * it changes the rows' height, as `+` and `−` do; a drag on nothing scrolls;
 * `0` fits. Past three hundred genomes a side the map shows only what is
 * around the selection.
 *
 * Every number the readout prints is the answer's.
 */

import type { StageInk } from '../../edit/draw'
import { withKey } from '../../ui/commands'
import { el } from '../../ui/dom'
import { icon, iconButton } from '../../ui/icons'
import { getTextScale, scaleFont, subscribeTextScale } from '../../ui/textScale'
import { fmt } from '../../units'
import type { CurationStateResult } from '../../worker/curateProtocol'
import type { GenomeKind } from '../../genome/curation'
import { LIKELY } from '../method'
import type { CurateChange } from '../model'
import type { Suggestion } from '../suggest'
import { affinityText } from './contactLayout'
import type { CurateContext, CurateDropTarget, CurateFrame, CuratePane } from './context'
import {
  aroundSet,
  barHeight,
  bestHosts,
  barWidth,
  clampScroll,
  counted,
  curvePoint,
  fitPitch,
  hostAnchors,
  hostLayout,
  hostLinks,
  linkCurve,
  linkDistance,
  linkKey,
  linkWidth,
  linkWords,
  magRank,
  questionNumber,
  relatedTo,
  roomy,
  spreadLabels,
  suggestedPairs,
  type HostBand,
  type HostLayout,
  type HostLink,
  type HostPlace,
} from './hostLayout'

/** How far a press travels before it is a drag, in CSS pixels. */
const DRAG_PX = 4
/** A node's width, from the shortest genome of its kind to the longest. */
const MAG_NARROW = 16
const MAG_WIDE = 56
const ELEMENT_NARROW = 6
const ELEMENT_WIDE = 40
/** A thumbnail's nodes, as a share of the large picture's. */
const SMALL_SHARE = 0.45
/** The names' room, between these; the gap between a name and the bars. */
const NAMES_MIN = 44
const NAMES_MAX = 132
const NAME_GAP = 6
/** The links' room: names give way below the least; past the most the picture is centred. */
const LINKS_LEAST = 72
const LINKS_MOST = 560
/** Room round the plot, and above its rows for the columns' heads. */
const PAD = 12
const PAD_SMALL = 6
const CAPTION = 24
/** Rows' pitch: at most when fitted, large and small, and the most a zoom gives. */
const PITCH_FIT_MOST = 24
const PITCH_FIT_MOST_SMALL = 14
const PITCH_MOST = 44
/**
 * The map opens with a row tall enough for every name while a column holds
 * this many rows or fewer, scrolled where they overflow; past it the rows thin,
 * to a node 3 pixels high, and only what is lit carries its name.
 */
const ROWS_NAMED = 150
const PITCH_THIN = 5
/** A zoom's step. */
const ZOOM_STEP = 1.25
/** A name shows where its node has this much room either side, at the text's own scale. */
const NAME_ROOM = 11
/** A name's line where names are pushed apart, at the text's scale. */
const LABEL_LINE = 12
/** How near a node or a link a point is on it, in CSS pixels. */
const NODE_REACH = 5
const LINK_REACH = 5
/** Past this many MAGs or elements, the map opens around the selection. */
const AROUND_PAST = 300
/** The most links offered drawn, the surest first, and every one naming the selection. */
const OFFERS_MOST = 400
/** The scroll's thumb: its width, its least length, and the reach of a press on its track. */
const THUMB = 4
const THUMB_LEAST = 28
const THUMB_REACH = 12
/** Where rows run on past the view: a fade this tall at that edge. */
const FADE = 18
/** The most links a drag draws from what it carries. */
const RUBBER_MOST = 16
/** What is not lit with the selection or the pointer, while something is. */
const DIM = 0.35
/** A held link at rest: a step back from the ink, so what is offered reads over it. */
const REST = 0.6

type HostView = 'all' | 'around'

interface Modifiers {
  meta: boolean
  shift: boolean
}

/** A press of the hand, until it is let go. */
type Press =
  | { kind: 'pan'; pointer: number; y: number; moved: boolean }
  | { kind: 'thumb'; pointer: number; y: number; scroll: number }
  | { kind: 'node'; pointer: number; x: number; y: number; id: string; carry: boolean; mod: Modifiers }
  | { kind: 'link'; pointer: number; x: number; y: number; key: string; mod: Modifiers }

/** What a point of the pane is over. */
type Hit = { kind: 'mag' | 'element'; id: string } | { kind: 'link'; key: string } | { kind: 'none' }

/** The columns' places, in CSS pixels of the plot. */
interface Columns {
  /** The left edge of what is drawn: the MAGs' names, or their bars. */
  left: number
  /** The MAGs' bars end here, and the links begin. */
  magX: number
  /** The elements' bars begin here, and the links end. */
  elementX: number
  /** The names' room on each side; `0` where they give way. */
  magNames: number
  elementNames: number
  /** The rows' area. */
  top: number
  bottom: number
  /** The bars' widths, shortest to longest. */
  magNarrow: number
  magWide: number
  elementNarrow: number
  elementWide: number
}

/** One answer as drawn: what goes where, and the links between. */
interface Drawn {
  answer: CurationStateResult
  /** Whether it is the binning as it stands: the suggestions are drawn on it. */
  current: boolean
  view: HostView
  /** Around the selection, with nothing chosen. */
  empty: boolean
  layout: HostLayout
  links: HostLink[]
  linkOf: Map<string, HostLink>
  index: Map<string, number>
  kind: Map<string, GenomeKind>
  band: Map<string, HostBand>
  place: Map<string, HostPlace>
  /** Each row's element, `-1` for none; each band row's MAG band, by index. */
  rowElement: Int32Array
  rowBand: Int32Array
  /** Each genome's length, shortest and longest, by kind. */
  lengths: { mag: [number, number]; element: [number, number] }
  /** Each element's densest MAG now, and their affinity: what the readout says it meets most. */
  best: Map<string, { mag: string; affinity: number }>
  /** Links held, links offered, and held links an unlink is offered for. */
  held: number
  offered: number
  undo: number
}

/** What is lit, selected and asked, for one frame. */
interface Marks {
  selected: Set<string>
  holding: Set<string>
  lit: string | null
  hoverLink: string | null
  /** Something selected or lit: the rest drops back. */
  focus: boolean
  related: { genomes: Set<string>; links: Set<string> }
  /** The question shown: the pairs it would link or unlink, the genomes it names otherwise, and its number. */
  featuredPairs: Map<string, 'link' | 'unlink'>
  featuredNodes: Set<string>
  number: number | null
  drop: string | null
}

function typing(target: EventTarget | null): boolean {
  const node = target as HTMLElement | null
  return node !== null && (node.tagName === 'INPUT' || node.tagName === 'TEXTAREA' || node.tagName === 'SELECT' || node.isContentEditable === true)
}

function sameTarget(a: CurateDropTarget | null, b: CurateDropTarget | null): boolean {
  if (a === null || b === null) return a === b
  return JSON.stringify(a) === JSON.stringify(b)
}

/** A line of the key: what a link drawn so means. */
function keyItem(look: 'held' | 'offered' | 'unlink', words: string, title: string): HTMLElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  svg.setAttribute('class', `curate-host-key-mark is-${look}`)
  svg.setAttribute('viewBox', '0 0 24 10')
  svg.setAttribute('width', '24')
  svg.setAttribute('height', '10')
  svg.setAttribute('aria-hidden', 'true')
  const line = document.createElementNS('http://www.w3.org/2000/svg', 'line')
  line.setAttribute('x1', '1')
  line.setAttribute('y1', '5')
  line.setAttribute('x2', '23')
  line.setAttribute('y2', '5')
  line.setAttribute('class', 'curate-host-key-line')
  svg.appendChild(line)
  if (look === 'unlink') {
    const cross = document.createElementNS('http://www.w3.org/2000/svg', 'path')
    cross.setAttribute('d', 'M9 1.5 L15 8.5 M15 1.5 L9 8.5')
    cross.setAttribute('class', 'curate-host-key-cross')
    svg.appendChild(cross)
  }
  const item = el('span', { class: 'curate-host-key-item', title }, el('span', { class: 'curate-host-key-word', text: words }))
  item.prepend(svg)
  return item
}

export class HostPane implements CuratePane {
  readonly element: HTMLElement
  readonly title = 'hosts'
  private readonly head: HTMLElement
  private readonly counts: HTMLElement
  private readonly views: Record<HostView, HTMLButtonElement>
  private readonly plot: HTMLElement
  private readonly canvas: HTMLCanvasElement
  private readonly note: HTMLElement
  private readonly footBar: HTMLElement
  private readonly status: HTMLElement
  private readonly fold: HTMLButtonElement
  private large = true
  private dpr = 1
  private box = { width: 0, height: 0 }
  private cols: Columns = { left: 0, magX: 0, elementX: 0, magNames: 0, elementNames: 0, top: 0, bottom: 0, magNarrow: 0, magWide: 0, elementNarrow: 0, elementWide: 0 }
  /**
   * The large picture's rows: `auto` as the map opens (a name a row, or thin
   * past {@link ROWS_NAMED}), `fit` every row in view (`0`), or a pitch asked
   * (`+`, `−`, ⌘ and the wheel); and how far they are scrolled.
   */
  private zoom: { mode: 'auto' | 'fit' | 'manual'; pitch: number; scroll: number } = { mode: 'auto', pitch: 0, scroll: 0 }
  /** Whether the rows overflow the view, this frame: the wheel scrolls them. */
  private scrollable = false
  /** This frame's rows: the pitch, the scroll and the offset that centres rows shorter than the view. */
  private rows = { pitch: 1, scroll: 0, offset: 0 }
  private measureDirty = true
  private arrangeDirty = true
  private namesFor: { answer: CurationStateResult | null; font: string; mag: number; element: number } = { answer: null, font: '', mag: NAMES_MIN, element: NAMES_MIN }
  /** Each element's MAG, kept across steps; and the answer and order it was placed on. */
  private anchors = new Map<string, string | null>()
  private anchoredOn: { answer: CurationStateResult; order: readonly string[]; counted: boolean } | null = null
  private drawn: Drawn | null = null
  private chosenView: HostView | null = null
  private footOpen = false
  private shownSuggestion: Suggestion | null = null
  private framedKey: string | null = null
  /**
   * A frame asked while the map could not show it — small, or not yet
   * measured: the review frames its question before it makes the host map
   * large. Shown on the first frame drawn large; dropped by a scroll or a zoom.
   */
  private pendingFrame: CurateFrame | null = null
  // The hand.
  private press: Press | null = null
  private pointer: { x: number; y: number } | null = null
  private space = false
  private anchorNode: string | null = null
  private hoverLink: string | null = null
  private dropLit: CurateDropTarget | null = null
  private dropRefused = false
  /** A drag in flight over the map: it holds still under it. */
  private dragOver = false
  private said: string | null = null
  /** What the nodes written for scripts were written for: the layout (counted on every rebuild) and the rows. */
  private nodesSaid = ''
  private layouts = 0
  private frameId = 0
  private disposed = false
  private readonly offs: Array<() => void> = []

  constructor(private readonly ctx: CurateContext) {
    this.counts = el('span', { class: 'curate-host-counts' })
    const view = (name: HostView, text: string, title: string): HTMLButtonElement =>
      el('button', {
        class: 'btn btn-toggle curate-host-view',
        text,
        title,
        attrs: { type: 'button', 'aria-pressed': 'false', 'data-view': name },
        on: { click: () => this.setView(name) },
      })
    this.views = {
      all: view('all', 'all', 'Every MAG and every element'),
      around: view('around', 'around the selection', 'The genomes selected, the genomes linked to them, and their elements’ other hosts'),
    }
    const key = el(
      'div',
      { class: 'curate-host-key' },
      keyItem('held', 'linked', 'A link held: from the file, taken, or made by hand; as wide as its share of the element’s contacts with MAGs'),
      keyItem('offered', 'offered', 'A link the contacts offer'),
      keyItem('unlink', 'to undo', 'A link held that the contacts no longer support: an unlink offered'),
    )
    const tools = el(
      'div',
      { class: 'curate-host-tools' },
      iconButton('maximize', withKey('Show every row', '0'), () => this.fit(), { class: 'btn btn-icon', size: 14 }),
      iconButton('zoom-out', withKey('Shorter rows', '-'), () => this.zoomBy(1 / ZOOM_STEP), { class: 'btn btn-icon', size: 14 }),
      iconButton('zoom-in', withKey('Taller rows', '+'), () => this.zoomBy(ZOOM_STEP), { class: 'btn btn-icon', size: 14 }),
    )
    this.head = el(
      'div',
      { class: 'curate-host-head' },
      this.counts,
      el('div', { class: 'curate-host-views', attrs: { role: 'group', 'aria-label': 'Which genomes the host map shows' } }, this.views.all, this.views.around),
      key,
      tools,
    )
    this.canvas = el('canvas', {
      class: 'curate-host-canvas',
      attrs: {
        tabindex: '0',
        'aria-label': 'The hosts: the MAGs on the left, the elements on the right, their links between. Press a node to select it, drag an element onto a MAG to link them.',
      },
    })
    this.note = el('div', { class: 'curate-host-note hidden', attrs: { role: 'status' } })
    this.plot = el('div', { class: 'curate-host-plot' }, this.canvas, this.note)
    this.status = el('span', { class: 'curate-host-status' })
    this.fold = el('button', {
      class: 'btn btn-quiet curate-host-fold hidden',
      attrs: { type: 'button', 'aria-expanded': 'false' },
      on: { click: () => this.toggleFoot() },
    })
    this.footBar = el('div', { class: 'curate-host-foot hidden' }, this.status, this.fold)
    this.element = el(
      'section',
      { class: 'curate-host', attrs: { 'data-pane': 'hosts', 'data-view': 'all', 'data-zoom': 'fit', 'data-ready': 'false', 'data-large': 'true' } },
      this.head,
      this.plot,
      this.footBar,
    )
    this.wire()
    this.offs.push(ctx.onFrame((target) => this.frameOn(target)))
    this.offs.push(
      subscribeTextScale(() => {
        this.namesFor = { answer: null, font: '', mag: NAMES_MIN, element: NAMES_MIN }
        this.arrangeDirty = true
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
      case 'mode':
      case 'current':
        // Around the selection, what is shown follows it.
        if (this.drawn?.view === 'around') this.rebuild()
        else this.schedule()
        return
      case 'hover':
        this.schedule()
        return
      default:
        return
    }
  }

  resize(): void {
    this.measureDirty = true
    this.schedule()
  }

  setLarge(large: boolean): void {
    if (large === this.large) return
    this.large = large
    if (!large) this.letGo()
    this.element.classList.toggle('is-small', !large)
    this.element.dataset.large = String(large)
    this.canvas.tabIndex = large ? 0 : -1
    this.arrangeDirty = true
    this.paintChrome()
    this.schedule()
  }

  showSuggestion(suggestion: Suggestion | null): void {
    this.shownSuggestion = suggestion
    this.canvas.dataset.current = suggestion?.key ?? ''
    const key = suggestion?.key ?? null
    if (key !== this.framedKey) {
      this.framedKey = key
      if (suggestion !== null) this.frameSuggestion(suggestion)
    }
    if (this.drawn?.view === 'around') this.rebuild()
    else this.schedule()
  }

  key(event: KeyboardEvent): boolean {
    if (!this.large || event.metaKey || event.ctrlKey || event.altKey) return false
    switch (event.key) {
      case '0':
        this.fit()
        return true
      case '+':
      case '=':
        this.zoomBy(ZOOM_STEP)
        return true
      case '-':
      case '_':
        this.zoomBy(1 / ZOOM_STEP)
        return true
      case 'Escape':
        if (this.press === null) return false
        this.press = null
        this.schedule()
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
    for (const off of this.offs) off()
    this.offs.length = 0
  }

  // -------------------------------------------------------------------------
  // For scripts and tests.
  // -------------------------------------------------------------------------

  /** Which genomes are shown: `all`, or `around` the selection. */
  get view(): HostView {
    return this.drawn?.view ?? this.chosenView ?? 'all'
  }

  /**
   * Where a genome's node is drawn, in client pixels — the middle of its bar —
   * or `null` where it is not placed (folded, around the selection, gone).
   */
  nodeAt(id: string): { clientX: number; clientY: number } | null {
    const at = this.nodePoint(id)
    if (at === null) return null
    const rect = this.plot.getBoundingClientRect()
    return { clientX: rect.left + at.x, clientY: rect.top + at.y }
  }

  // -------------------------------------------------------------------------
  // What is drawn, again: after a count, a preview, a view.
  // -------------------------------------------------------------------------

  /** The binning drawn: as it would be while a preview is drawn — but held still under a drag over it. */
  private drawnAnswer(): CurationStateResult | null {
    const model = this.ctx.model
    if (this.ctx.dragging !== null && this.dragOver) return model.answer
    return model.shown
  }

  /** Each element's MAG, placed afresh as the stage's order is — first, on the contacts' read, on tidy — and kept between. */
  private refreshAnchors(answer: CurationStateResult): void {
    const order = this.ctx.model.order
    const was = this.anchoredOn
    if (was !== null && was.answer === answer && was.order === order) return
    // A tidy lays the order out again on the same answer; the read, on its first counted one.
    const fresh = was === null || (answer.counted && !was.counted) || (was.answer === answer && was.order !== order)
    const rank = magRank(answer.genomes, order)
    this.anchors = hostAnchors(answer.genomes, answer.pairs, answer.links, rank, fresh ? {} : { kept: this.anchors })
    this.anchoredOn = { answer, order, counted: answer.counted }
  }

  private rebuild(): void {
    const model = this.ctx.model
    const answer = model.answer
    const drawn = this.drawnAnswer()
    if (answer === null || drawn === null) {
      this.drawn = null
      this.element.dataset.ready = 'false'
      this.paintChrome()
      this.schedule()
      return
    }
    this.refreshAnchors(answer)
    const current = drawn === answer
    const links = hostLinks(drawn, current && answer.counted ? this.offersOf(answer) : [])
    const kind = new Map(drawn.genomes.map((genome) => [genome.id, genome.kind]))
    const mags = drawn.genomes.filter((genome) => genome.kind === 'mag').length
    const view: HostView = this.chosenView ?? (mags > AROUND_PAST || drawn.genomes.length - mags > AROUND_PAST ? 'around' : 'all')
    let visible: Set<string> | null = null
    let anchors = this.anchors
    if (view === 'around') {
      visible = aroundSet(this.chosen(drawn), links, (id) => kind.get(id))
      const allowed = new Set([...visible].filter((id) => kind.get(id) === 'mag'))
      anchors = hostAnchors(drawn.genomes, drawn.pairs, drawn.links, magRank(drawn.genomes, model.order), { kept: this.anchors, allowed })
    } else if (!current) anchors = hostAnchors(drawn.genomes, drawn.pairs, drawn.links, magRank(drawn.genomes, model.order), { kept: this.anchors })
    const layout = hostLayout(drawn.genomes, model.order, anchors, { visible, footOpen: this.footOpen || view === 'around' })
    const band = new Map(layout.mags.map((b) => [b.id, b]))
    const place = new Map(layout.elements.map((p) => [p.id, p]))
    const placed = (link: HostLink): boolean => band.has(link.mag) && place.has(link.element)
    const drawable = links.filter(placed)
    const rowElement = new Int32Array(layout.total).fill(-1)
    layout.elements.forEach((p, k) => {
      if (p.row >= 0 && p.row < rowElement.length) rowElement[p.row] = k
    })
    const rowBand = new Int32Array(layout.rows).fill(-1)
    layout.mags.forEach((b, k) => rowBand.fill(k, b.from, b.to))
    const lengths = { mag: [Number.POSITIVE_INFINITY, 0] as [number, number], element: [Number.POSITIVE_INFINITY, 0] as [number, number] }
    for (const genome of drawn.genomes) {
      const range = lengths[genome.kind]
      if (genome.length > 0) range[0] = Math.min(range[0], genome.length)
      range[1] = Math.max(range[1], genome.length)
    }
    this.drawn = {
      answer: drawn,
      current,
      view,
      empty: view === 'around' && (visible?.size ?? 0) === 0,
      layout,
      links: drawable,
      linkOf: new Map(drawable.map((link) => [link.key, link])),
      index: new Map(drawn.genomes.map((genome, g) => [genome.id, g])),
      kind,
      band,
      place,
      rowElement,
      rowBand,
      lengths,
      best: bestHosts(drawn.genomes, drawn.pairs, magRank(drawn.genomes, model.order)),
      held: drawn.links.length,
      offered: links.filter((link) => !link.held && link.offer !== null).length,
      undo: links.filter((link) => link.held && link.offer?.kind === 'unlink').length,
    }
    this.layouts++
    this.element.dataset.view = view
    this.element.dataset.ready = String(answer.counted)
    if (this.hoverLink !== null && !this.drawn.linkOf.has(this.hoverLink)) this.hoverLink = null
    this.arrangeDirty = true
    this.paintChrome()
    this.refreshHover()
    this.schedule()
  }

  /** The link and unlink suggestions on offer, by the genomes' ids: the surest, and every one naming the selection. */
  private offersOf(answer: CurationStateResult): Array<{ element: string; mag: string; suggestion: Suggestion }> {
    const selected = new Set(this.ctx.model.selection.genomes)
    const list = this.ctx.model
      .offered()
      .filter((s) => s.kind === 'link' || s.kind === 'unlink')
      .sort((a, b) => b.confidence - a.confidence || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
    const out: Array<{ element: string; mag: string; suggestion: Suggestion }> = []
    for (const s of list) {
      const element = answer.genomes[s.genomes[0]]?.id
      const mag = answer.genomes[s.genomes[1]]?.id
      if (element === undefined || mag === undefined) continue
      if (out.length >= OFFERS_MOST && !selected.has(element) && !selected.has(mag)) continue
      out.push({ element, mag, suggestion: s })
    }
    return out
  }

  /** What around the selection is around: the genomes selected, those holding the contigs selected, and the question shown. */
  private chosen(answer: CurationStateResult): Set<string> {
    const selection = this.ctx.model.selection
    const out = new Set(selection.genomes)
    for (const c of selection.contigs) {
      const g = answer.genomeOf[c] ?? -1
      if (g >= 0) out.add(answer.genomes[g].id)
    }
    const featured = this.featured()
    const now = this.ctx.model.answer
    if (featured !== null && now !== null) for (const g of featured.genomes) if (now.genomes[g] !== undefined) out.add(now.genomes[g].id)
    return out
  }

  /** The readout and the light again for a pointer at rest: a step changed what is under it. */
  private refreshHover(): void {
    if (this.pointer === null || this.press !== null || this.ctx.dragging !== null || !this.large) return
    // On the rows as they now are.
    if (this.measureDirty) this.measure()
    if (this.arrangeDirty) this.arrange()
    this.hoverAt(this.pointer.x, this.pointer.y)
  }

  /** The question shown: the one framed, else the review's. */
  private featured(): Suggestion | null {
    const model = this.ctx.model
    return this.shownSuggestion ?? (model.mode === 'review' ? model.current : null)
  }

  // -------------------------------------------------------------------------
  // The view and the rows.
  // -------------------------------------------------------------------------

  private setView(view: HostView): void {
    this.chosenView = view
    this.zoom = { mode: 'auto', pitch: 0, scroll: 0 }
    this.rebuild()
  }

  private toggleFoot(): void {
    this.footOpen = !this.footOpen
    this.rebuild()
    if (!this.footOpen || this.drawn === null) return
    // Shown where they begin, the rows before them just above: scrolled to, where the rows do not fit.
    if (this.measureDirty) this.measure()
    if (this.arrangeDirty) this.arrange()
    const { layout } = this.drawn
    const from = Math.max(0, layout.rows - 2)
    this.frameRows(layout.rows, layout.total, [from, from + Math.floor((this.cols.bottom - this.cols.top) / Math.max(1, this.rows.pitch))])
  }

  /** Every row in the view. */
  fit(): void {
    this.pendingFrame = null
    this.zoom = { mode: 'fit', pitch: 0, scroll: 0 }
    this.arrangeDirty = true
    this.schedule()
  }

  /** Taller rows (`factor` over 1) or lower ones, about a height of the plot — the view's middle by default. */
  zoomBy(factor: number, about?: number): void {
    if (!this.large || this.drawn === null) return
    this.pendingFrame = null
    if (this.measureDirty) this.measure()
    if (this.arrangeDirty) this.arrange()
    const { top, bottom } = this.cols
    const view = bottom - top
    const total = this.drawn.layout.total
    const fit = fitPitch(total, view, PITCH_FIT_MOST)
    const was = this.rows.pitch
    const next = Math.max(fit, Math.min(PITCH_MOST, was * factor))
    if (Math.abs(next - was) < 1e-9) return
    const at = about ?? (top + bottom) / 2
    const row = (at - top - this.rows.offset + this.rows.scroll) / was
    const content = total * next
    const offset = content < view ? (view - content) / 2 : 0
    this.zoom = { mode: next <= fit + 1e-9 ? 'fit' : 'manual', pitch: next, scroll: clampScroll(row * next - (at - top - offset), content, view) }
    this.arrangeDirty = true
    this.schedule()
  }

  private scrollBy(dy: number): void {
    if (!this.large || this.drawn === null || !this.scrollable) return
    this.pendingFrame = null
    const view = this.cols.bottom - this.cols.top
    const content = this.drawn.layout.total * this.rows.pitch
    const next = clampScroll(this.zoom.scroll + dy, content, view)
    if (next === this.zoom.scroll) return
    this.zoom.scroll = next
    this.arrangeDirty = true
    this.schedule()
  }

  /**
   * Bring the rows `[from, to)` into view, centred, where they are not in it:
   * where they are more than the view holds, the `subject`'s rows — what the
   * frame is about first — centred instead.
   */
  private frameRows(from: number, to: number, subject?: readonly [number, number]): void {
    if (!this.large || this.drawn === null || !(to > from)) return
    if (this.measureDirty) this.measure()
    if (this.arrangeDirty) this.arrange()
    const { pitch, offset } = this.rows
    const view = this.cols.bottom - this.cols.top
    const y0 = offset + from * pitch - this.zoom.scroll
    const y1 = offset + to * pitch - this.zoom.scroll
    if (y0 >= 0 && y1 <= view) return
    const [a, b] = (to - from) * pitch > view && subject !== undefined ? subject : [from, to]
    const content = this.drawn.layout.total * pitch
    this.zoom.scroll = clampScroll(offset + ((a + b) / 2) * pitch - view / 2, content, view)
    this.arrangeDirty = true
    this.schedule()
  }

  /** The rows of some genomes, first to last. */
  private rowsOf(ids: Iterable<string>): [number, number] | null {
    const drawn = this.drawn
    if (drawn === null) return null
    let from = Number.POSITIVE_INFINITY
    let to = Number.NEGATIVE_INFINITY
    for (const id of ids) {
      const band = drawn.band.get(id)
      const place = drawn.place.get(id)
      if (band !== undefined) {
        from = Math.min(from, Math.floor(band.at - 0.5))
        to = Math.max(to, Math.ceil(band.at + 0.5))
      }
      if (place !== undefined) {
        from = Math.min(from, place.row)
        to = Math.max(to, place.row + 1)
      }
    }
    return Number.isFinite(from) ? [from, to] : null
  }

  /** What a part asked every part to show. */
  private frameOn(target: CurateFrame): void {
    const drawn = this.drawn
    if (this.disposed) return
    if (drawn === null || !this.large || this.measureDirty || this.box.height === 0) {
      this.pendingFrame = target
      this.schedule()
      return
    }
    const ids = new Set(target.genomes ?? [])
    for (const c of target.contigs ?? []) {
      const g = drawn.answer.genomeOf[c] ?? -1
      if (g >= 0) ids.add(drawn.answer.genomes[g].id)
    }
    const span = this.rowsOf(ids)
    // The first genome named is what the frame is about: an element's links, a merge's survivor.
    const first = [...ids].find((id) => drawn.band.has(id) || drawn.place.has(id))
    if (span !== null) this.frameRows(span[0], span[1], first === undefined ? undefined : (this.rowsOf([first]) ?? undefined))
  }

  private frameSuggestion(s: Suggestion): void {
    const answer = this.ctx.model.answer
    if (answer === null) return
    this.frameOn({ genomes: s.genomes.map((g) => answer.genomes[g]?.id).filter((id): id is string => id !== undefined) })
  }

  // -------------------------------------------------------------------------
  // Layout.
  // -------------------------------------------------------------------------

  private font(weight = ''): string {
    const base = scaleFont(this.ctx.ink().font)
    return weight === '' ? base : `${weight} ${base}`
  }

  /** The names' room on each side: the widest short name, once an answer. */
  private namesWidth(): { mag: number; element: number } {
    const answer = this.drawn?.answer ?? null
    const font = this.font('600')
    if (this.namesFor.answer === answer && this.namesFor.font === font) return this.namesFor
    let mag = NAMES_MIN
    let element = NAMES_MIN
    const g = this.canvas.getContext('2d')
    if (g !== null && answer !== null) {
      g.font = font
      for (const genome of answer.genomes) {
        const width = Math.ceil(g.measureText(this.ctx.shortName(genome.id)).width) + 4
        if (genome.kind === 'mag') mag = Math.max(mag, width)
        else element = Math.max(element, width)
      }
    }
    this.namesFor = { answer, font, mag: Math.min(NAMES_MAX, mag), element: Math.min(NAMES_MAX, element) }
    return this.namesFor
  }

  private measure(): void {
    this.measureDirty = false
    const rect = this.plot.getBoundingClientRect()
    const width = Math.max(0, Math.floor(rect.width))
    const height = Math.max(0, Math.floor(rect.height))
    this.dpr = window.devicePixelRatio > 0 ? window.devicePixelRatio : 1
    this.box = { width, height }
    this.canvas.style.width = `${width}px`
    this.canvas.style.height = `${height}px`
    this.canvas.width = Math.round(width * this.dpr)
    this.canvas.height = Math.round(height * this.dpr)
    this.arrangeDirty = true
  }

  /** The columns and the rows, for the box, the names and the rows drawn. */
  private arrange(): void {
    this.arrangeDirty = false
    const { width, height } = this.box
    const large = this.large
    const pad = large ? PAD : PAD_SMALL
    const share = large ? 1 : SMALL_SHARE
    const magWide = MAG_WIDE * share
    const elementWide = ELEMENT_WIDE * share
    let magNames = 0
    let elementNames = 0
    if (large) {
      const names = this.namesWidth()
      magNames = names.mag
      elementNames = names.element
    }
    const gaps = (magNames > 0 ? NAME_GAP : 0) + (elementNames > 0 ? NAME_GAP : 0)
    let links = width - 2 * pad - magWide - elementWide - magNames - elementNames - gaps
    if (large && links < LINKS_LEAST) {
      // The names give way first, to their least, then go.
      const short = LINKS_LEAST - links
      const room = magNames + elementNames - 2 * NAMES_MIN
      if (room >= short) {
        const cut = short / Math.max(1, magNames + elementNames - 2 * NAMES_MIN)
        magNames -= (magNames - NAMES_MIN) * cut
        elementNames -= (elementNames - NAMES_MIN) * cut
      } else {
        magNames = 0
        elementNames = 0
      }
      links = width - 2 * pad - magWide - elementWide - magNames - elementNames - (magNames > 0 ? 2 * NAME_GAP : 0)
    }
    links = Math.max(16, links)
    const span = Math.min(links, large ? LINKS_MOST : links)
    const left = pad + (links - span) / 2
    const magX = left + magNames + (magNames > 0 ? NAME_GAP : 0) + magWide
    const top = large ? CAPTION + 4 : pad
    const bottom = Math.max(top, height - pad)
    this.cols = {
      left,
      magX,
      elementX: magX + span,
      magNames,
      elementNames,
      top,
      bottom,
      magNarrow: MAG_NARROW * share,
      magWide,
      elementNarrow: ELEMENT_NARROW * share,
      elementWide,
    }
    const total = this.drawn?.layout.total ?? 0
    const view = bottom - top
    if (!large) {
      const pitch = fitPitch(total, view, PITCH_FIT_MOST_SMALL)
      this.rows = { pitch, scroll: 0, offset: total * pitch < view ? (view - total * pitch) / 2 : 0 }
      this.scrollable = false
    } else {
      const fit = fitPitch(total, view, PITCH_FIT_MOST)
      const zoom = this.zoom
      zoom.pitch =
        zoom.mode === 'fit'
          ? fit
          : zoom.mode === 'auto'
            ? Math.max(fit, total <= ROWS_NAMED ? this.namedPitch() : PITCH_THIN)
            : Math.max(fit, Math.min(PITCH_MOST, zoom.pitch))
      const content = total * zoom.pitch
      zoom.scroll = clampScroll(zoom.scroll, content, view)
      this.scrollable = content > view + 0.5
      this.rows = { pitch: zoom.pitch, scroll: zoom.scroll, offset: content < view ? (view - content) / 2 : 0 }
    }
    this.element.dataset.zoom = !large || !this.scrollable ? 'fit' : 'rows'
  }

  /** A row with room for a name, at the text's scale. */
  private namedPitch(): number {
    return Math.ceil(NAME_ROOM * getTextScale()) + 3
  }

  /** A row's place down the plot: `row` in rows from the top (a node's middle at `row + 0.5`). */
  private Y(row: number): number {
    return this.cols.top + this.rows.offset + row * this.rows.pitch - this.rows.scroll
  }

  private barOf(id: string): number {
    const drawn = this.drawn
    if (drawn === null) return 0
    const g = drawn.index.get(id)
    const genome = g === undefined ? undefined : drawn.answer.genomes[g]
    if (genome === undefined) return 0
    const c = this.cols
    const [least, most] = drawn.lengths[genome.kind]
    return genome.kind === 'mag' ? barWidth(genome.length, least, most, c.magNarrow, c.magWide) : barWidth(genome.length, least, most, c.elementNarrow, c.elementWide)
  }

  /** A node's middle, its bar's middle, in CSS pixels of the plot. */
  private nodePoint(id: string): { x: number; y: number } | null {
    const drawn = this.drawn
    if (drawn === null) return null
    if (this.measureDirty) this.measure()
    if (this.arrangeDirty) this.arrange()
    const band = drawn.band.get(id)
    if (band !== undefined) return { x: this.cols.magX - this.barOf(id) / 2, y: this.Y(band.at) }
    const place = drawn.place.get(id)
    if (place !== undefined) return { x: this.cols.elementX + this.barOf(id) / 2, y: this.Y(place.row + 0.5) }
    return null
  }

  /** Where a link runs: from the MAG's bar to the element's. */
  private linkEnds(link: HostLink): [number, number, number, number] | null {
    const drawn = this.drawn
    const band = drawn?.band.get(link.mag)
    const place = drawn?.place.get(link.element)
    if (band === undefined || place === undefined) return null
    return [this.cols.magX + 1, this.Y(band.at), this.cols.elementX - 1, this.Y(place.row + 0.5)]
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
    if (this.measureDirty) this.measure()
    if (this.arrangeDirty) this.arrange()
    if (this.pendingFrame !== null && this.large && this.box.height > 0 && this.drawn !== null) {
      const target = this.pendingFrame
      this.pendingFrame = null
      this.frameOn(target)
      if (this.arrangeDirty) this.arrange()
    }
    this.paint()
    this.paintNote()
  }

  /** What is selected, lit and asked, for this frame. */
  private marks(drawn: Drawn): Marks {
    const model = this.ctx.model
    const selection = model.selection
    const selected = new Set(selection.genomes.filter((id) => drawn.kind.has(id)))
    const holding = new Set<string>()
    for (const c of selection.contigs) {
      const g = drawn.answer.genomeOf[c] ?? -1
      const id = g >= 0 ? drawn.answer.genomes[g].id : undefined
      if (id !== undefined && !selected.has(id)) holding.add(id)
    }
    const lit = model.hovered.genome !== null && drawn.kind.has(model.hovered.genome) ? model.hovered.genome : null
    const hoverLink = this.large && this.ctx.dragging === null ? this.hoverLink : null
    const focusIds = new Set([...selected, ...holding])
    if (lit !== null) focusIds.add(lit)
    const hovered = hoverLink === null ? undefined : drawn.linkOf.get(hoverLink)
    const related = relatedTo(focusIds, drawn.links)
    if (hovered !== undefined) {
      related.genomes.add(hovered.element)
      related.genomes.add(hovered.mag)
      related.links.add(hovered.key)
    }
    const featuredPairs = new Map<string, 'link' | 'unlink'>()
    const featuredNodes = new Set<string>()
    let number: number | null = null
    const featured = this.large ? this.featured() : null
    const now = model.answer
    if (featured !== null && now !== null) {
      for (const pair of suggestedPairs(featured, (g) => now.genomes[g]?.id)) featuredPairs.set(linkKey(pair.element, pair.mag), pair.kind)
      if (featuredPairs.size === 0) for (const g of featured.genomes) if (now.genomes[g] !== undefined) featuredNodes.add(now.genomes[g].id)
      number = questionNumber(model.queue(), featured.key, LIKELY)
    }
    const drop = this.ctx.dragging !== null && this.dropLit?.kind === 'genome' && !this.dropRefused ? this.dropLit.id : null
    return { selected, holding, lit, hoverLink: hovered === undefined ? null : hovered.key, focus: focusIds.size > 0 || hovered !== undefined, related, featuredPairs, featuredNodes, number, drop }
  }

  private paint(): void {
    const drawn = this.drawn
    this.writeData()
    const g = this.canvas.getContext('2d')
    if (g === null) return
    g.setTransform(1, 0, 0, 1, 0, 0)
    g.clearRect(0, 0, this.canvas.width, this.canvas.height)
    const { width, height } = this.box
    if (drawn === null || width <= 0 || height <= 0) return
    g.setTransform(this.dpr, 0, 0, this.dpr, 0, 0)
    const ink = this.ctx.ink()
    const marks = this.marks(drawn)
    if (this.large) this.captions(g, ink, drawn)
    const { top, bottom } = this.cols
    g.save()
    g.beginPath()
    g.rect(0, top - 3, width, bottom - top + 6)
    g.clip()
    this.drawDrop(g, ink, drawn, marks)
    this.drawLinks(g, ink, drawn, marks)
    this.drawFootRule(g, ink, drawn)
    this.drawNodes(g, ink, drawn, marks)
    if (this.large) this.drawLabels(g, ink, drawn, marks)
    g.restore()
    if (this.large) {
      this.drawScroll(g, ink, drawn)
      this.drawDisc(g, ink, drawn, marks)
      this.drawRubber(g, ink, drawn, marks)
    }
  }

  /** Where the scroll's thumb is, on its track at the plot's right edge; `null` when the rows fit. */
  private thumb(drawn: Drawn): { x: number; y: number; length: number; track: [number, number]; travel: number } | null {
    if (!this.scrollable) return null
    const { top, bottom } = this.cols
    const view = bottom - top
    const content = drawn.layout.total * this.rows.pitch
    const track: [number, number] = [top + 2, bottom - 2]
    const room = track[1] - track[0]
    const length = Math.max(THUMB_LEAST, Math.min(room, (room * view) / content))
    const travel = Math.max(1, content - view)
    const y = track[0] + (this.rows.scroll / travel) * (room - length)
    return { x: this.box.width - THUMB - 3, y, length, track, travel }
  }

  /** Where the rows run on past the view, a fade at that edge; and the scroll's thumb. */
  private drawScroll(g: CanvasRenderingContext2D, ink: StageInk, drawn: Drawn): void {
    const thumb = this.thumb(drawn)
    if (thumb === null) return
    const { top, bottom } = this.cols
    const { width } = this.box
    const fade = (from: number, step: 1 | -1): void => {
      // Strips of the background, thinning away from the edge: no gradient to parse a colour into.
      g.fillStyle = ink.background
      const strips = 9
      for (let k = 0; k < strips; k++) {
        g.globalAlpha = 0.92 * (1 - k / strips)
        const y = step > 0 ? from + (k * FADE) / strips : from - ((k + 1) * FADE) / strips
        g.fillRect(0, y, width - THUMB - 6, FADE / strips + 0.5)
      }
      g.globalAlpha = 1
    }
    if (this.rows.scroll > 0.5) fade(top - 3, 1)
    if (this.rows.scroll < thumb.travel - 0.5) fade(bottom + 3, -1)
    const held = this.press?.kind === 'thumb'
    g.fillStyle = held ? ink.dim : ink.faint
    g.globalAlpha = held ? 0.8 : 0.45
    g.beginPath()
    if (typeof g.roundRect === 'function') g.roundRect(thumb.x, thumb.y, THUMB, thumb.length, THUMB / 2)
    else g.rect(thumb.x, thumb.y, THUMB, thumb.length)
    g.fill()
    g.globalAlpha = 1
  }

  /** Scroll so the thumb's middle is at a height of the plot: a press on its track. */
  private scrollToThumb(y: number): void {
    const drawn = this.drawn
    const thumb = drawn === null ? null : this.thumb(drawn)
    if (thumb === null) return
    const room = thumb.track[1] - thumb.track[0] - thumb.length
    const share = room > 0 ? (y - thumb.track[0] - thumb.length / 2) / room : 0
    this.zoom.scroll = clampScroll(share * thumb.travel, thumb.travel + (this.cols.bottom - this.cols.top), this.cols.bottom - this.cols.top)
    this.arrangeDirty = true
    this.schedule()
  }

  /** The columns' heads: `MAGs` and `elements`, each with its section's prefix where room is. */
  private captions(g: CanvasRenderingContext2D, ink: StageInk, drawn: Drawn): void {
    const { left, magX, elementX } = this.cols
    const y = Math.round(CAPTION / 2) + 2
    const mags = drawn.layout.mags.length
    const elements = drawn.layout.elements.length + (drawn.view === 'all' && !this.footOpen ? drawn.layout.foot.length : 0)
    g.textBaseline = 'middle'
    g.textAlign = 'left'
    const head = (x: number, room: number, word: string, prefix: string): void => {
      g.font = this.font('600')
      g.fillStyle = ink.dim
      const text = this.fitText(g, word, room)
      if (text === '') return
      g.fillText(text, x, y)
      const used = g.measureText(text).width
      if (prefix === '' || text !== word) return
      g.font = this.font()
      g.fillStyle = ink.faint
      // The prefix every name of the column shares, whole or not at all: cut, it names nothing.
      const shared = `${prefix}…`
      if (g.measureText(shared).width <= room - used - 8) g.fillText(shared, x + used + 8, y)
    }
    head(left, magX - left, `MAGs · ${fmt.int(mags)}`, this.ctx.prefixOf('mag'))
    head(elementX, this.box.width - PAD - elementX, `elements · ${fmt.int(elements)}`, this.ctx.prefixOf('element'))
  }

  /** The genome a drag would land on, washed across its column. */
  private drawDrop(g: CanvasRenderingContext2D, ink: StageInk, drawn: Drawn, marks: Marks): void {
    if (marks.drop === null) return
    const box = this.nodeBox(drawn, marks.drop)
    if (box === null) return
    g.fillStyle = ink.accentSoft
    g.globalAlpha = 0.9
    g.beginPath()
    if (typeof g.roundRect === 'function') g.roundRect(box.x, box.y, box.width, box.height, 4)
    else g.rect(box.x, box.y, box.width, box.height)
    g.fill()
    g.globalAlpha = 1
  }

  /** A node's place across its column — its band, or its row — at least a few pixels high. */
  private nodeBox(drawn: Drawn, id: string): { x: number; y: number; width: number; height: number } | null {
    const band = drawn.band.get(id)
    const place = drawn.place.get(id)
    const least = 14
    let y0: number
    let y1: number
    let x0: number
    let x1: number
    if (band !== undefined) {
      y0 = this.Y(band.from)
      y1 = this.Y(band.to)
      x0 = this.cols.left - 4
      x1 = this.cols.magX + 4
    } else if (place !== undefined) {
      y0 = this.Y(place.row)
      y1 = this.Y(place.row + 1)
      x0 = this.cols.elementX - 4
      x1 = Math.min(this.box.width - 2, this.cols.elementX + this.cols.elementWide + NAME_GAP + this.cols.elementNames + 4)
    } else return null
    if (y1 - y0 < least) {
      const mid = (y0 + y1) / 2
      y0 = mid - least / 2
      y1 = mid + least / 2
    }
    return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 }
  }

  /** A stroke over a halo of the background, so it reads over what it crosses. */
  private haloed(g: CanvasRenderingContext2D, ink: StageInk, colour: string, width: number, path: () => void, dash: number[] = [], halo = 2.5): void {
    g.lineCap = 'round'
    g.lineJoin = 'round'
    g.setLineDash([])
    if (halo <= 0) {
      this.stroke(g, colour, width, path, dash)
      return
    }
    const alpha = g.globalAlpha
    g.globalAlpha = alpha * 0.8
    g.strokeStyle = ink.background
    g.lineWidth = width + halo
    g.beginPath()
    path()
    g.stroke()
    g.globalAlpha = alpha
    this.stroke(g, colour, width, path, dash)
  }

  /** One stroke: round ends, but a dash's ends square, so a gap stays one however wide the line. */
  private stroke(g: CanvasRenderingContext2D, colour: string, width: number, path: () => void, dash: number[] = []): void {
    g.lineCap = dash.length > 0 ? 'butt' : 'round'
    g.strokeStyle = colour
    g.lineWidth = width
    g.setLineDash(dash)
    g.beginPath()
    path()
    g.stroke()
    g.setLineDash([])
    g.lineCap = 'round'
  }

  /** The links: the ones dropped back first, then what is lit with the selection, the question last. */
  private drawLinks(g: CanvasRenderingContext2D, ink: StageInk, drawn: Drawn, marks: Marks): void {
    const { top, bottom } = this.cols
    const large = this.large
    const lit = (link: HostLink): boolean => !marks.focus || marks.related.links.has(link.key) || marks.featuredPairs.has(link.key)
    const layers: HostLink[][] = [[], [], []]
    for (const link of drawn.links) {
      // A thumbnail shows the binning, not what is offered on it.
      if (!link.held && (!large || !drawn.current)) continue
      layers[marks.featuredPairs.has(link.key) || link.key === marks.hoverLink ? 2 : lit(link) ? 1 : 0].push(link)
    }
    for (const [layer, list] of layers.entries()) {
      for (const link of list) {
        const ends = this.linkEnds(link)
        if (ends === null) continue
        const [x0, y0, x1, y1] = ends
        if (Math.max(y0, y1) < top - 8 || Math.min(y0, y1) > bottom + 8) continue
        const featured = marks.featuredPairs.get(link.key)
        const hovered = link.key === marks.hoverLink
        // No thicker than its rows allow: a crowded column is not a barcode.
        const width = large ? Math.min(linkWidth(link), Math.max(1, this.rows.pitch * 0.55)) : Math.max(0.75, linkWidth(link) * 0.6)
        const path = (): void => {
          const [, , bx, by, cx, cy] = linkCurve(x0, y0, x1, y1)
          g.moveTo(x0, y0)
          g.bezierCurveTo(bx, by, cx, cy, x1, y1)
        }
        if (link.held) {
          const strong = hovered || featured !== undefined
          g.globalAlpha = layer === 0 ? DIM * REST : 1
          if (strong) this.haloed(g, ink, ink.accent, width + (featured !== undefined ? 1.5 : 0.75), path)
          else if (marks.focus && layer > 0) this.haloed(g, ink, ink.text, width, path, [], 2)
          else {
            // At rest, in ink a step back: what is held is the ground the offers stand on.
            g.globalAlpha = layer === 0 ? DIM * REST : REST
            this.stroke(g, ink.dim, width, path)
          }
        } else {
          const thick = width + (featured !== undefined ? 1.5 : hovered ? 0.75 : 0)
          const dash = [Math.max(5, 1.6 * thick + 2), Math.max(3, thick + 1)]
          g.globalAlpha = layer === 0 ? DIM : 1
          this.haloed(g, ink, ink.accent, thick, path, dash, layer === 0 ? 0 : featured !== undefined || hovered ? 2.5 : 1.5)
        }
        g.globalAlpha = layer === 0 ? DIM : 1
        // A held link the contacts no longer support: crossed at its middle.
        if (link.offer?.kind === 'unlink' && drawn.current && large) {
          const [mx, my] = curvePoint(x0, y0, x1, y1, 0.5)
          const r = featured !== undefined ? 5.5 : 4
          this.haloed(
            g,
            ink,
            ink.accent,
            featured !== undefined ? 2.25 : 1.75,
            () => {
              g.moveTo(mx - r, my - r)
              g.lineTo(mx + r, my + r)
              g.moveTo(mx + r, my - r)
              g.lineTo(mx - r, my + r)
            },
            [],
            2.5,
          )
        }
      }
    }
    g.globalAlpha = 1
  }

  /** Where the foot's elements begin, when it is open: a faint rule across the elements' column. */
  private drawFootRule(g: CanvasRenderingContext2D, ink: StageInk, drawn: Drawn): void {
    const { layout } = drawn
    if (layout.total <= layout.rows || layout.rows === 0) return
    const y = Math.round(this.Y(layout.rows)) + 0.5
    if (y < this.cols.top || y > this.cols.bottom) return
    g.strokeStyle = ink.faint
    g.globalAlpha = 0.7
    g.lineWidth = 1
    g.setLineDash([3, 3])
    g.beginPath()
    g.moveTo(this.cols.elementX - 4, y)
    g.lineTo(Math.min(this.box.width - 4, this.cols.elementX + this.cols.elementWide + NAME_GAP + this.cols.elementNames), y)
    g.stroke()
    g.setLineDash([])
    g.globalAlpha = 1
    // What the rows under it are, said where they begin: around the selection they
    // are the elements whose MAGs are not shown, which may meet one.
    if (!this.large || drawn.view !== 'all') return
    g.font = this.font()
    g.fillStyle = ink.faint
    g.textAlign = 'right'
    g.textBaseline = 'middle'
    g.fillText(`${fmt.int(layout.total - layout.rows)} meet no MAG`, this.cols.elementX - 12, y + Math.min(this.rows.pitch / 2, 9) + 0.5)
  }

  /** The nodes: a bar each, in its genome's colour; the selection outlined, never washed. */
  private drawNodes(g: CanvasRenderingContext2D, ink: StageInk, drawn: Drawn, marks: Marks): void {
    const { top, bottom, magX, elementX } = this.cols
    const pitch = this.rows.pitch
    const height = this.large ? barHeight(pitch) : Math.min(4, Math.max(1, pitch - 1))
    const bar = (id: string, x: number, y: number, width: number): void => {
      g.fillStyle = this.ctx.colourOf(id).css
      g.beginPath()
      const r = Math.min(2, height / 2)
      if (typeof g.roundRect === 'function') g.roundRect(x, y - height / 2, width, height, r)
      else g.rect(x, y - height / 2, width, height)
      g.fill()
    }
    const outlines: Array<{ x: number; y: number; width: number; look: 'selected' | 'lit' | 'holding' | 'featured' | 'drop' }> = []
    const node = (id: string, x: number, y: number, width: number): void => {
      if (y < top - 6 || y > bottom + 6) return
      const kept = !marks.focus || marks.related.genomes.has(id) || marks.featuredNodes.has(id)
      g.globalAlpha = kept ? 1 : DIM
      bar(id, x, y, width)
      if (marks.drop === id) outlines.push({ x, y, width, look: 'drop' })
      else if (marks.selected.has(id)) outlines.push({ x, y, width, look: 'selected' })
      else if (marks.lit === id) outlines.push({ x, y, width, look: 'lit' })
      else if (marks.holding.has(id)) outlines.push({ x, y, width, look: 'holding' })
      if (marks.featuredNodes.has(id) && marks.drop !== id && !marks.selected.has(id)) outlines.push({ x, y, width, look: 'featured' })
    }
    for (const band of drawn.layout.mags) {
      const width = this.barOf(band.id)
      node(band.id, magX - width, this.Y(band.at), width)
    }
    for (const place of drawn.layout.elements) node(place.id, elementX, this.Y(place.row + 0.5), this.barOf(place.id))
    g.globalAlpha = 1
    for (const { x, y, width, look } of outlines) {
      const room = look === 'selected' || look === 'drop' ? 2.5 : 2
      const box = (): void => {
        const h = height + 2 * room
        if (typeof g.roundRect === 'function') g.roundRect(x - room, y - h / 2, width + 2 * room, h, 3)
        else g.rect(x - room, y - h / 2, width + 2 * room, h)
      }
      if (look === 'selected') this.haloed(g, ink, ink.accent, 2, box)
      else if (look === 'drop') this.haloed(g, ink, ink.accent, 2.5, box)
      else if (look === 'lit') this.haloed(g, ink, ink.accent, 1.5, box, [], 2)
      else if (look === 'holding') this.haloed(g, ink, ink.accent, 1.5, box, [3, 2], 2)
      else this.haloed(g, ink, ink.accent, 2, box, [4, 3], 2.5)
    }
  }

  /**
   * The names: each node's where it has room, and always the ones lit with
   * the selection and the pointer — pushed apart where those crowd, a leader
   * from a name moved to its node.
   */
  private drawLabels(g: CanvasRenderingContext2D, ink: StageInk, drawn: Drawn, marks: Marks): void {
    const c = this.cols
    const scale = getTextScale()
    const room = NAME_ROOM * scale
    const line = LABEL_LINE * scale
    const strong = (id: string): boolean => marks.selected.has(id) || marks.lit === id || marks.drop === id
    const wanted = (id: string): boolean => strong(id) || marks.holding.has(id) || marks.featuredNodes.has(id) || (marks.focus && marks.related.genomes.has(id))
    const featuredEnds = new Set<string>()
    for (const key of marks.featuredPairs.keys()) for (const id of key.split('\t')) featuredEnds.add(id)
    const columns: Array<{ side: 'mag' | 'element'; nodes: Array<{ id: string; y: number }>; names: number }> = [
      { side: 'mag', nodes: drawn.layout.mags.map((b) => ({ id: b.id, y: this.Y(b.at) })), names: c.magNames },
      { side: 'element', nodes: drawn.layout.elements.map((p) => ({ id: p.id, y: this.Y(p.row + 0.5) })), names: c.elementNames },
    ]
    g.textBaseline = 'middle'
    for (const { side, nodes, names } of columns) {
      if (names <= 0 || nodes.length === 0) continue
      const free = roomy(
        nodes.map((n) => n.y),
        room,
      )
      const inView = (y: number): boolean => y >= c.top - 2 && y <= c.bottom + 2
      // The names asked for, the strongest kept where too many crowd the column.
      let forced = nodes.filter((n) => inView(n.y) && (wanted(n.id) || featuredEnds.has(n.id)))
      const fits = Math.max(1, Math.floor((c.bottom - c.top) / line))
      if (forced.length > fits) forced = forced.filter((n) => strong(n.id) || featuredEnds.has(n.id)).slice(0, fits)
      const at = spreadLabels(
        forced.map((n) => n.y),
        c.top,
        c.bottom,
        line,
      )
      const taken = at.map((y) => [y - line / 2, y + line / 2] as const)
      const forcedIds = new Set(forced.map((n) => n.id))
      const x = side === 'mag' ? c.magX - c.magWide - NAME_GAP : c.elementX + c.elementWide + NAME_GAP
      g.textAlign = side === 'mag' ? 'right' : 'left'
      nodes.forEach((n, k) => {
        if (!free[k] || forcedIds.has(n.id) || !inView(n.y)) return
        if (taken.some(([a, b]) => n.y + line / 2 > a && n.y - line / 2 < b)) return
        const dim = marks.focus && !marks.related.genomes.has(n.id)
        g.globalAlpha = dim ? DIM : 1
        g.font = this.font()
        g.fillStyle = ink.text
        g.fillText(this.fitText(g, this.ctx.shortName(n.id), names), x, n.y + 0.5)
      })
      g.globalAlpha = 1
      forced.forEach((n, k) => {
        const y = at[k]
        const bold = strong(n.id) || featuredEnds.has(n.id)
        g.font = this.font(bold ? '600' : '')
        const text = this.fitText(g, this.ctx.shortName(n.id), names)
        if (Math.abs(y - n.y) > 1.5) {
          // Moved off its row: a leader from the name to the node's bar.
          const width = this.barOf(n.id)
          const from = side === 'mag' ? x + 2 : x - 2
          const to = side === 'mag' ? c.magX - width - 2 : c.elementX + width + 2
          g.strokeStyle = ink.faint
          g.lineWidth = 1
          g.globalAlpha = 0.8
          g.beginPath()
          g.moveTo(from, y)
          g.lineTo((from + to) / 2, y)
          g.lineTo(to, n.y)
          g.stroke()
          g.globalAlpha = 1
        }
        g.fillStyle = strong(n.id) || featuredEnds.has(n.id) ? ink.accent : ink.text
        g.fillText(text, x, y + 0.5)
      })
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

  /** The review's number, beside the question's first link. */
  private drawDisc(g: CanvasRenderingContext2D, ink: StageInk, drawn: Drawn, marks: Marks): void {
    if (marks.number === null) return
    let at: [number, number] | null = null
    const pairs = [...marks.featuredPairs].sort((a, b) => (a[1] === b[1] ? 0 : a[1] === 'link' ? -1 : 1))
    for (const [key, kind] of pairs) {
      const [element, mag] = key.split('\t')
      const link = drawn.linkOf.get(key) ?? { key, element, mag, held: false, fromFile: false, pair: null, offer: null }
      const ends = this.linkEnds(link)
      if (ends === null) continue
      // A third of the way from the element, above the curve: clear of an unlink's cross at its middle.
      const [mx, my] = curvePoint(ends[0], ends[1], ends[2], ends[3], kind === 'link' ? 0.5 : 0.68)
      at = [mx, my - 13]
      break
    }
    if (at === null) {
      // A merge, a move or a recruit: beside its first genome's node.
      const first = [...marks.featuredNodes][0]
      const point = first === undefined ? null : this.nodePoint(first)
      if (point === null) return
      const band = drawn.band.has(first)
      at = [band ? this.cols.magX + 14 : this.cols.elementX - 14, point.y - 10]
    }
    const [cx, cy] = at
    if (cy < this.cols.top - 4 || cy > this.cols.bottom + 4) return
    g.font = this.font('600')
    const text = String(marks.number)
    const r = Math.max(9, g.measureText(text).width / 2 + 4)
    const x = Math.max(r + 1, Math.min(this.box.width - r - 1, cx))
    const y = Math.max(r + 1, Math.min(this.box.height - r - 1, cy))
    g.globalAlpha = 1
    g.beginPath()
    g.arc(x, y, r, 0, 2 * Math.PI)
    g.fillStyle = ink.accent
    g.fill()
    g.lineWidth = 1.5
    g.strokeStyle = ink.background
    g.stroke()
    g.fillStyle = ink.background
    g.textAlign = 'center'
    g.textBaseline = 'middle'
    g.fillText(text, x, y + 0.5)
  }

  /** A drag of elements over the map: a curve from each to the MAG it would be linked to, or to the pointer. */
  private drawRubber(g: CanvasRenderingContext2D, ink: StageInk, drawn: Drawn, marks: Marks): void {
    const dragged = this.ctx.dragging
    const pointer = this.pointer
    if (dragged === null || dragged.kind !== 'genomes' || pointer === null || !this.dragOver) return
    const onMag = marks.drop !== null && drawn.band.has(marks.drop) ? (drawn.band.get(marks.drop) as HostBand) : null
    let drawnCount = 0
    for (const id of dragged.ids) {
      if (drawnCount >= RUBBER_MOST) break
      const place = drawn.place.get(id)
      if (place === undefined) continue
      drawnCount++
      const x0 = this.cols.elementX - 1
      const y0 = this.Y(place.row + 0.5)
      const [x1, y1] = onMag === null ? [pointer.x, pointer.y] : [this.cols.magX + 1, this.Y(onMag.at)]
      this.haloed(
        g,
        ink,
        ink.accent,
        2,
        () => {
          const [, , bx, by, cx, cy] = linkCurve(x1, y1, x0, y0)
          g.moveTo(x1, y1)
          g.bezierCurveTo(bx, by, cx, cy, x0, y0)
        },
        [6, 4],
      )
    }
  }

  // --- The head, the foot and the note ------------------------------------------

  private paintChrome(): void {
    const drawn = this.drawn
    const view = drawn?.view ?? this.chosenView ?? 'all'
    for (const [name, button] of Object.entries(this.views) as Array<[HostView, HTMLButtonElement]>) button.setAttribute('aria-pressed', String(name === view))
    if (drawn === null) this.counts.textContent = ''
    else {
      const parts = [counted(drawn.held, 'link')]
      if (drawn.offered > 0) parts.push(`${fmt.int(drawn.offered)} offered`)
      if (drawn.undo > 0) parts.push(`${fmt.int(drawn.undo)} to undo`)
      this.counts.textContent = parts.join(' · ')
      this.counts.title = drawn.answer.counted ? 'Links held between an element and a MAG, and the links the contacts offer' : 'The file’s links: what the contacts offer comes once every contact between contigs is read'
    }
    // The foot: what the map leaves out, and why.
    const foot = drawn === null || drawn.view === 'around' ? 0 : drawn.layout.foot.length
    const counting = drawn?.answer.counted === true
    if (foot > 0 && this.large) {
      const words = counting ? `${fmt.int(foot)} meet no MAG` : `${fmt.int(foot)} not linked`
      this.fold.replaceChildren(el('span', { text: words }), icon(this.footOpen ? 'chevron-down' : 'chevron-right', { size: 13 }))
      this.fold.title = this.footOpen
        ? 'Fold them away'
        : counting
          ? 'The elements in contact with no MAG: press to show them at the foot of the elements'
          : 'The elements the file links to no MAG: press to show them at the foot of the elements'
      this.fold.setAttribute('aria-expanded', String(this.footOpen))
      this.fold.dataset.foot = String(foot)
      this.fold.classList.remove('hidden')
    } else this.fold.classList.add('hidden')
    let status = ''
    if (drawn !== null && this.large) {
      if (!counting) status = 'the file’s links; their contacts come once every contact between contigs is read'
      else if (drawn.view === 'around' && !drawn.empty) {
        const shown = drawn.layout.mags.length + drawn.layout.elements.length
        status = `around the selection · ${fmt.int(shown)} of ${counted(drawn.answer.genomes.length, 'genome')}`
      }
    }
    this.status.textContent = status
    this.footBar.classList.toggle('hidden', !this.large || (status === '' && this.fold.classList.contains('hidden')))
  }

  private paintNote(): void {
    const answer = this.ctx.model.answer
    const drawn = this.drawn
    let text: string | null = null
    if (!this.large) text = null
    else if (answer === null || drawn === null) text = 'weighing the binning…'
    else if (drawn.empty) text = 'Select a genome, in the list or on a map, to see it with its links and its elements’ other hosts.'
    else if (!drawn.answer.genomes.some((genome) => genome.kind === 'element')) text = 'No mobile elements in this map: select contigs and press E to make one.'
    else if (!drawn.answer.genomes.some((genome) => genome.kind === 'mag')) text = 'No MAGs in this map to host its elements: select contigs and press B to make one.'
    if (text === null) {
      if (!this.note.classList.contains('hidden')) this.note.classList.add('hidden')
      return
    }
    if (this.note.textContent !== text) this.note.textContent = text
    this.note.classList.remove('hidden')
  }

  /** Where things are, for scripts: the columns, the rows, and every node in view. */
  private writeData(): void {
    const c = this.cols
    const data = this.canvas.dataset
    data.columns = `${c.magX.toFixed(1)} ${c.elementX.toFixed(1)}`
    data.rows = String(this.drawn?.layout.total ?? 0)
    data.pitch = this.rows.pitch.toFixed(3)
    data.scroll = this.rows.scroll.toFixed(1)
    const drawn = this.drawn
    const said = `${this.layouts} ${this.rows.pitch} ${this.rows.scroll} ${this.rows.offset} ${c.magX} ${c.elementX} ${this.box.width} ${this.box.height}`
    if (said === this.nodesSaid && drawn !== null && data.nodes !== undefined) return
    this.nodesSaid = said
    if (drawn === null) {
      data.nodes = '{}'
      return
    }
    const nodes: Record<string, [number, number]> = {}
    const add = (id: string): void => {
      const at = this.nodePoint(id)
      if (at !== null && at.y >= c.top && at.y <= c.bottom) nodes[id] = [Math.round(at.x * 10) / 10, Math.round(at.y * 10) / 10]
    }
    for (const band of drawn.layout.mags) add(band.id)
    for (const place of drawn.layout.elements) add(place.id)
    data.nodes = JSON.stringify(nodes)
  }

  // -------------------------------------------------------------------------
  // Hit-testing.
  // -------------------------------------------------------------------------

  /** What a point of the plot is over, in CSS pixels of the plot. */
  private hitAt(x: number, y: number): Hit {
    const drawn = this.drawn
    const none: Hit = { kind: 'none' }
    if (drawn === null || drawn.layout.total === 0) return none
    const c = this.cols
    if (y < c.top - NODE_REACH || y > c.bottom + NODE_REACH) return none
    const { pitch, scroll, offset } = this.rows
    const row = (y - c.top - offset + scroll) / pitch
    if (x >= c.left - 4 && x <= c.magX + 4) {
      const bands = drawn.layout.mags
      const k = row >= 0 && row < drawn.rowBand.length ? drawn.rowBand[Math.floor(row)] : -1
      if (k >= 0) return { kind: 'mag', id: bands[k].id }
      // Past the rows' ends, the nearest node within reach.
      const near = bands.find((b) => Math.abs(this.Y(b.at) - y) <= NODE_REACH)
      return near === undefined ? none : { kind: 'mag', id: near.id }
    }
    const right = Math.min(this.box.width, c.elementX + c.elementWide + NAME_GAP + c.elementNames + 4)
    if (x >= c.elementX - 4 && x <= right) {
      const k = row >= 0 && row < drawn.rowElement.length ? drawn.rowElement[Math.floor(row)] : -1
      if (k >= 0) return { kind: 'element', id: drawn.layout.elements[k].id }
      const near = drawn.layout.elements.find((p) => Math.abs(this.Y(p.row + 0.5) - y) <= NODE_REACH)
      return near === undefined ? none : { kind: 'element', id: near.id }
    }
    if (x > c.magX && x < c.elementX) {
      let best: HostLink | null = null
      let distance = Number.POSITIVE_INFINITY
      for (const link of drawn.links) {
        if (!link.held && !drawn.current) continue
        const ends = this.linkEnds(link)
        if (ends === null) continue
        const reach = LINK_REACH + linkWidth(link) / 2
        if (y < Math.min(ends[1], ends[3]) - reach || y > Math.max(ends[1], ends[3]) + reach) continue
        const d = linkDistance(x, y, ends[0], ends[1], ends[2], ends[3])
        if (d <= reach && d < distance) {
          best = link
          distance = d
        }
      }
      if (best !== null) return { kind: 'link', key: best.key }
    }
    return none
  }

  /** Where something held would drop at a point of the plot: a node. */
  private targetAt(x: number, y: number): CurateDropTarget | null {
    const hit = this.hitAt(x, y)
    return hit.kind === 'mag' || hit.kind === 'element' ? { kind: 'genome', id: hit.id } : null
  }

  // -------------------------------------------------------------------------
  // The hand.
  // -------------------------------------------------------------------------

  private wire(): void {
    const canvas = this.canvas
    canvas.addEventListener('pointerdown', (event) => this.pointerDown(event))
    canvas.addEventListener('pointermove', (event) => this.pointerMove(event))
    canvas.addEventListener('pointerup', (event) => this.pointerUp(event))
    canvas.addEventListener('pointercancel', (event) => {
      this.release(event.pointerId)
      this.press = null
      this.schedule()
    })
    canvas.addEventListener('pointerleave', () => this.pointerLeave())
    canvas.addEventListener('dblclick', (event) => this.doubleClick(event))
    canvas.addEventListener('wheel', (event) => this.wheel(event), { passive: false })
    canvas.addEventListener('contextmenu', (event) => {
      if (this.large) event.preventDefault()
    })
    // Space held pans, as on the contact map: heard on the window, never taken from the stage.
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
        if (was) this.rebuild()
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
      this.canvas.setPointerCapture?.(pointer)
    } catch {
      // A pointer that is gone: nothing to hold.
    }
  }

  private release(pointer: number): void {
    try {
      if (this.canvas.hasPointerCapture?.(pointer) === true) this.canvas.releasePointerCapture(pointer)
    } catch {
      // Already let go.
    }
  }

  private pointerDown(event: PointerEvent): void {
    if (!this.large || this.drawn === null) return
    if (event.button !== 0 && event.button !== 1) return
    if (this.ctx.dragging !== null) return
    const { x, y } = this.local(event)
    this.canvas.focus({ preventScroll: true })
    const mod: Modifiers = { meta: event.metaKey || event.ctrlKey, shift: event.shiftKey }
    const thumb = this.thumb(this.drawn)
    if (event.button === 0 && thumb !== null && x >= this.box.width - THUMB_REACH && y >= thumb.track[0] && y <= thumb.track[1]) {
      // The thumb taken where it is; a press on its track brings it there first.
      if (y < thumb.y || y > thumb.y + thumb.length) this.scrollToThumb(y)
      this.press = { kind: 'thumb', pointer: event.pointerId, y, scroll: this.zoom.scroll }
      this.capture(event.pointerId)
      event.preventDefault()
      this.schedule()
      return
    }
    const hit = event.button === 1 || this.space ? ({ kind: 'none' } as Hit) : this.hitAt(x, y)
    if (hit.kind === 'mag' || hit.kind === 'element') {
      const carry = !mod.meta && !mod.shift && this.ctx.model.selection.genomes.includes(hit.id)
      this.press = { kind: 'node', pointer: event.pointerId, x, y, id: hit.id, carry, mod }
    } else if (hit.kind === 'link') this.press = { kind: 'link', pointer: event.pointerId, x, y, key: hit.key, mod }
    else this.press = { kind: 'pan', pointer: event.pointerId, y, moved: false }
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
      case 'thumb': {
        const thumb = this.drawn === null ? null : this.thumb(this.drawn)
        if (thumb === null) return
        const room = thumb.track[1] - thumb.track[0] - thumb.length
        const view = this.cols.bottom - this.cols.top
        this.zoom.scroll = clampScroll(press.scroll + ((y - press.y) / Math.max(1, room)) * thumb.travel, thumb.travel + view, view)
        this.arrangeDirty = true
        this.schedule()
        return
      }
      case 'pan':
        if (!press.moved && Math.abs(y - press.y) < DRAG_PX) return
        press.moved = true
        this.scrollBy(press.y - y)
        press.y = y
        this.paintCursor(x, y)
        return
      case 'node': {
        if (Math.hypot(x - press.x, y - press.y) < DRAG_PX) return
        this.press = null
        this.release(press.pointer)
        // The selection, where the node is in it; else the node alone.
        const ids = press.carry ? [...this.ctx.model.selection.genomes] : [press.id]
        this.ctx.startDrag({ kind: 'genomes', ids }, event)
        this.setSaid(null)
        this.lightDrop(x, y)
        return
      }
      case 'link':
        if (Math.hypot(x - press.x, y - press.y) < DRAG_PX) return
        // A drag from a link scrolls, as one from nothing does.
        this.press = { kind: 'pan', pointer: press.pointer, y, moved: true }
        this.scrollBy(press.y - y)
        return
    }
  }

  private pointerUp(event: PointerEvent): void {
    const press = this.press
    if (press === null || event.pointerId !== press.pointer) return
    this.press = null
    this.release(press.pointer)
    switch (press.kind) {
      case 'node':
        this.clickNode(press.id, press.mod)
        break
      case 'link':
        this.clickLink(press.key, press.mod)
        break
      case 'pan':
      case 'thumb':
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
      if (was) this.rebuild()
    }
    if (this.press === null && this.ctx.dragging === null) {
      if (this.hoverLink !== null) this.hoverLink = null
      this.ctx.model.hover(null)
      this.setSaid(null)
    }
    this.schedule()
  }

  /** Let go of whatever the hand holds: the pane made small. */
  private letGo(): void {
    if (this.press !== null) this.release(this.press.pointer)
    this.press = null
    this.pointer = null
    this.hoverLink = null
    this.setSaid(null)
  }

  private doubleClick(event: MouseEvent): void {
    if (!this.large) return
    const { x, y } = this.local(event)
    const hit = this.hitAt(x, y)
    if (hit.kind === 'mag' || hit.kind === 'element') this.ctx.frame({ genomes: [hit.id] })
    else if (hit.kind === 'none') this.fit()
  }

  private wheel(event: WheelEvent): void {
    if (!this.large || this.drawn === null) return
    event.preventDefault()
    const { y } = this.local(event)
    if (event.ctrlKey || event.metaKey) {
      this.zoomBy(Math.exp(-event.deltaY * (event.deltaMode === 1 ? 0.05 : 0.002)), y)
      return
    }
    const lines = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? this.cols.bottom - this.cols.top : 1
    this.scrollBy(event.deltaY * lines)
  }

  // --- Selecting -----------------------------------------------------------------

  /** A node's column, top to bottom, as ids. */
  private columnOf(id: string): string[] | null {
    const drawn = this.drawn
    if (drawn === null) return null
    if (drawn.band.has(id)) return drawn.layout.mags.map((b) => b.id)
    if (drawn.place.has(id)) return drawn.layout.elements.map((p) => p.id)
    return null
  }

  /**
   * A press on a node let go where it was: select it, ⌘ toggle it, ⇧ extend
   * to it along its column — from the node pressed last, or, where that is no
   * longer selected (⌘ took it away, a press elsewhere since), from the last
   * node of the column that is, as the list extends.
   */
  private clickNode(id: string, mod: Modifiers): void {
    const model = this.ctx.model
    const column = this.columnOf(id)
    if (mod.shift && column !== null) {
      const selected = new Set(model.selection.genomes)
      let from = this.anchorNode !== null && selected.has(this.anchorNode) ? column.indexOf(this.anchorNode) : -1
      if (from < 0) for (let k = column.length - 1; k >= 0 && from < 0; k--) if (selected.has(column[k])) from = k
      const to = column.indexOf(id)
      if (from >= 0 && to >= 0) {
        model.selectGenomes(column.slice(Math.min(from, to), Math.max(from, to) + 1))
        return
      }
    }
    model.selectGenomes([id], mod.meta ? 'toggle' : mod.shift ? 'add' : 'replace')
    this.anchorNode = id
  }

  /** A press on a link: its two genomes. */
  private clickLink(key: string, mod: Modifiers): void {
    const link = this.drawn?.linkOf.get(key)
    if (link === undefined) return
    this.ctx.model.selectGenomes([link.element, link.mag], mod.meta ? 'toggle' : mod.shift ? 'add' : 'replace')
    this.anchorNode = link.element
  }

  // --- Hover, the readout, the drop ---------------------------------------------

  private setSaid(words: string | null): void {
    if (words === this.said) return
    this.said = words
    this.ctx.say(words)
  }

  private hoverAt(x: number, y: number): void {
    const hit = this.hitAt(x, y)
    this.paintCursor(x, y, hit)
    const model = this.ctx.model
    const link = hit.kind === 'link' ? (this.drawn?.linkOf.get(hit.key) ?? null) : null
    const nextLink = link?.key ?? null
    if (nextLink !== this.hoverLink) {
      this.hoverLink = nextLink
      this.schedule()
    }
    if (hit.kind === 'mag' || hit.kind === 'element') {
      model.hover(hit.id)
      this.setSaid(this.genomeWords(hit.id))
    } else if (link !== null) {
      // A link lights its element: the genome the link is about.
      model.hover(link.element)
      this.setSaid(linkWords(link, this.ctx.shortName(link.element), this.ctx.shortName(link.mag)))
    } else {
      model.hover(null)
      this.setSaid(null)
    }
  }

  private lightDrop(x: number, y: number): void {
    const target = this.targetAt(x, y)
    const wasOver = this.dragOver
    this.dragOver = true
    if (!wasOver) this.rebuild()
    if (!sameTarget(target, this.dropLit)) {
      this.dropLit = target
      this.dropRefused = target === null ? false : (this.ctx.dropWords(target)?.refused ?? false)
    }
    this.paintCursor(x, y)
    this.schedule()
  }

  private paintCursor(x: number, y: number, hit: Hit = this.hitAt(x, y)): void {
    let cursor = ''
    const scrollable = this.scrollable
    if (this.press?.kind === 'pan' && this.press.moved) cursor = 'grabbing'
    else if (this.ctx.dragging !== null) cursor = ''
    else if (this.space) cursor = scrollable ? 'grab' : ''
    else if (hit.kind === 'mag' || hit.kind === 'element') cursor = this.ctx.model.selection.genomes.includes(hit.id) ? 'grab' : 'pointer'
    else if (hit.kind === 'link') cursor = 'pointer'
    else if (scrollable) cursor = 'grab'
    if (this.canvas.dataset.cursor !== cursor) this.canvas.dataset.cursor = cursor
  }

  // --- Words ---------------------------------------------------------------------

  /** A node: its length, its contigs, its quality, what it hosts or what hosts it, and what is offered. */
  private genomeWords(id: string): string | null {
    const drawn = this.drawn
    const g = drawn?.index.get(id)
    if (drawn === null || g === undefined) return null
    const genome = drawn.answer.genomes[g]
    const short = (other: string): string => this.ctx.shortName(other)
    const parts = [short(id), fmt.bp(genome.length), counted(genome.contigs, 'contig')]
    const held = drawn.answer.links
    const offered = drawn.links.filter((link) => !link.held && link.offer !== null && (link.element === id || link.mag === id))
    if (genome.kind === 'mag') {
      const q = genome.quality
      if (q !== null) parts.push(`${fmt.pct(q.weightedCompleteness, 0)} complete`, `${fmt.fixed(q.weightedRedundancy, 2)} redundant`)
      const hosts = held.filter((link) => link.mag === id).length
      parts.push(hosts === 0 ? 'hosts no element' : `hosts ${counted(hosts, 'element')}`)
      if (offered.length > 0) parts.push(`${counted(offered.length, 'link')} offered`)
      return parts.join(' · ')
    }
    const hosts = held.filter((link) => link.element === id).map((link) => short(link.mag))
    parts.push(hosts.length === 0 ? 'no host' : `hosted by ${hosts.join(', ')}`)
    if (offered.length > 0) parts.push(`${offered.length === 1 ? 'a link' : `${fmt.int(offered.length)} links`} offered to ${offered.map((link) => short(link.mag)).join(', ')}`)
    if (drawn.answer.counted) {
      const best = drawn.best.get(id)
      parts.push(best === undefined ? 'meets no MAG' : `meets ${short(best.mag)} most, affinity ${affinityText(best.affinity)}`)
    }
    return parts.join(' · ')
  }
}
