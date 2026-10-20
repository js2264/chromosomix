/**
 * The map drawn as two lines, on screen (§7.6): the canvas, the hover, the
 * clicks, and the sections a reader drags along their line into another order.
 *
 * Built by `MatrixPanel` the first time a block is drawn as two lines, beside
 * the circle's view and kept while the panel lives; handed the same block, the
 * same scale and the same presentation, and drawn instead of it. Everything it
 * draws is arithmetic over those (`render/lines.ts`); its lanes hold what the
 * circle's rings hold (`ui/ringContents.ts`), laid along x rather than round.
 *
 * **No zoom.** Each line is as wide as the picture already, and the reader
 * reaches a genome by opening it: a click on a section opens its map, as a click
 * on an arc does. What is read is the genomes against each other, which is the
 * whole picture.
 */

import { el, fmt } from './dom'
import { getPlotOptions, subscribePlotOptions } from './plotOptions'
import { scaleFont, subscribeTextScale } from './textScale'
import { formatPosition } from '../genome/assembly'
import { SampleCache } from '../annotations/samples'
import type { AnnotationClient } from '../annotations/worker/client'
import type { AnnotationStore } from '../annotations/store'
import type { MapId } from '../annotations/placement'
import type { AnnotationEntry } from '../annotations/types'
import type { GroupSettings } from '../annotations/groups'
import { formatCount } from '../render/legend'
import { inverseTransform } from '../render/scale'
import type { LocusAxis } from '../render/locus'
import type { MatrixResult } from '../worker/protocol'
import type { LineSplit, SplitChoice } from '../app/lineSplit'
import { CHORD_CAP, NO_FOCUS, fitText, fontPixels, partnerWeights, ringNamePx, type ChordLayout, type CircleCut, type CircleFocus, type CircleModel, type CirclePalette, type CircleUnit, type DropSide } from '../render/circle'
import { circleBins, sequenceAt, sequenceIndex, type CircleBins, type RingContent, type RingInk, type SequenceIndex } from '../render/circleRings'
import {
  binAtX,
  bpAtX,
  hitLines,
  layoutRibbons,
  lineDrop,
  linesGeometry,
  linesModelOf,
  midX,
  paintLane,
  paintLineLabels,
  paintLineSections,
  paintRibbons,
  type LinesGeometry,
  type LinesHit,
  type LinesModel,
} from '../render/lines'
import {
  DRAG_SLOP,
  KEY_INSET,
  LABEL_BOLD,
  LABEL_FONT,
  RING_NAME_FONT,
  chordCount,
  chordKeyLayout,
  paintChordKey,
  readCirclePalette,
  type ChordKey,
  type CirclePresentation,
  type CircleScale,
} from './CircleView'
import { circleAxis, drawRings, ringContentOf, ringSlotsOf, type HeldRing, type RingDrawn } from './ringContents'
import type { MetaSource } from './AnnotationLanes'
import { CROSSHAIR_COLOR } from '../render/heatmap'

export interface LinesViewOptions {
  store: AnnotationStore
  map: MapId
  client?: AnnotationClient
  metadata?: MetaSource
  /** How each group of tracks is drawn and scaled — the lanes' answer. */
  groups?: GroupSettings
  /** The session's presentation as it stands now; its `lines` are this view's. */
  presentation(): CirclePresentation | undefined
  /** What the key calls the ribbons' numbers — the map key's own title. */
  keyTitle(): string
}

/** The lines' titles: the level's name over how many genomes are on it. */
const TITLE_FONT = '600 11px system-ui, sans-serif'
const TITLE_DETAIL_FONT = '10px system-ui, sans-serif'
/** Between the column of titles and the lines. */
const COLUMN_GAP = 16

/** What the picture answers to, under the key on hover (§26.4). */
function hintLines(reorder: boolean): string[] {
  return [
    'Click a section or a ribbon to open it',
    ...(reorder ? ['Drag a section along its line to reorder'] : []),
  ]
}

/** A section carried along its line (§7.6), as an arc is carried round the circle. */
interface Carry {
  kind: 'unit' | 'group'
  index: number
  /** The picture it was taken from: one rebuilt under the hand is not it. */
  lines: LinesModel
  pointer: number
  x: number
  y: number
  moved: boolean
  drop: { index: number; side: DropSide; at: number } | null
}

export class LinesView {
  readonly el: HTMLElement
  private readonly canvas: HTMLCanvasElement
  private readonly guide: HTMLCanvasElement
  private readonly tip: HTMLElement
  private readonly hint: HTMLElement
  /** What the picture says where it has nothing to draw: pick a column, or why this one draws nothing. */
  private readonly prompt: HTMLElement
  private readonly promptText: HTMLElement
  private readonly promptSelect: HTMLSelectElement
  private readonly samples: SampleCache | null
  private block: MatrixResult | null = null
  private bpPerCell = 1
  private cut: CircleCut = 'genomes'
  private split: LineSplit | null = null
  private lines: LinesModel | null = null
  private scale: CircleScale = { transform: 'log1p', colormap: 'default', limit: Number.POSITIVE_INFINITY }
  private geometry: LinesGeometry | null = null
  private ribbons: ChordLayout | null = null
  private bins: CircleBins | null = null
  private index: SequenceIndex | null = null
  private axis: LocusAxis | null = null
  private rings: RingDrawn[] = []
  private readonly held = new Map<string, HeldRing>()
  private focus: CircleFocus = NO_FOCUS
  private carry: Carry | null = null
  private press: { pointer: number; x: number; y: number } | null = null
  private size = { width: 0, height: 0 }
  private frame = 0
  private layoutKey = ''
  /** Where the key stands: in the column, between the two lines. */
  private keyAt: { x: number; y: number } | null = null
  private readonly observer: ResizeObserver | null
  private readonly unsubscribe: Array<() => void> = []

  constructor(private readonly options: LinesViewOptions) {
    this.canvas = el('canvas', { class: 'circle-canvas lines-canvas' })
    this.guide = el('canvas', { class: 'circle-guide', attrs: { 'aria-hidden': 'true' } })
    this.tip = el('div', { class: 'cell-tip circle-tip hidden' })
    this.hint = el('div', { class: 'circle-hint', attrs: { 'aria-hidden': 'true' } })
    this.promptText = el('p', { class: 'lines-prompt-text' })
    this.promptSelect = el('select', { class: 'select', attrs: { 'aria-label': 'Split the genomes by' } })
    this.promptSelect.addEventListener('change', () => {
      if (this.promptSelect.value !== '') this.options.presentation()?.lines?.onColumn?.(this.promptSelect.value)
    })
    this.prompt = el('div', { class: 'lines-prompt hidden' }, this.promptText, this.promptSelect)
    this.el = el('div', { class: 'circle-wrap lines-wrap' }, this.canvas, this.guide, this.hint, this.tip, this.prompt)
    this.samples = options.client === undefined ? null : new SampleCache(options.client, () => this.schedule())
    this.unsubscribe.push(
      options.store.subscribe(() => this.schedule()),
      subscribePlotOptions(() => {
        this.drawGuide(null)
        if (!getPlotOptions().tooltip) this.tip.classList.add('hidden')
        this.schedule()
      }),
      subscribeTextScale(() => this.schedule()),
    )
    if (options.groups !== undefined) this.unsubscribe.push(options.groups.subscribe(() => this.schedule()))
    this.watchPointer()
    this.observer =
      typeof ResizeObserver === 'undefined'
        ? null
        : new ResizeObserver(() => {
            this.measure()
            this.schedule()
          })
    this.observer?.observe(this.el)
    requestAnimationFrame(() => {
      this.measure()
      this.schedule()
    })
  }

  /** The block the panel holds, at the grid it was read at, cut as the reader chose. */
  setBlock(data: MatrixResult, bpPerCell: number, cut: CircleCut = 'genomes'): void {
    if (data === this.block && bpPerCell === this.bpPerCell && cut === this.cut) return
    this.block = data
    this.bpPerCell = bpPerCell
    this.cut = cut
    this.rebuild()
  }

  /** The genomes split as the session has them now; `null` before a column is chosen. */
  setSplit(split: LineSplit | null): void {
    const same =
      split === this.split ||
      (split !== null &&
        this.split !== null &&
        split.column === this.split.column &&
        split.levels[0] === this.split.levels[0] &&
        split.levels[1] === this.split.levels[1] &&
        split.counts[0] === this.split.counts[0] &&
        split.counts[1] === this.split.counts[1])
    this.split = split
    if (!same) this.rebuild()
    this.paintPrompt()
  }

  /** The scale the Map card sets, and how many ribbons. */
  setScale(scale: CircleScale): void {
    if (scale.transform === this.scale.transform && scale.colormap === this.scale.colormap && scale.limit === this.scale.limit) {
      return
    }
    this.scale = { ...scale }
    this.ribbons = null
    this.schedule()
  }

  /** The circle's model of what is drawn, for the caption; `null` where nothing is. */
  get circle(): CircleModel | null {
    return this.lines?.model ?? null
  }

  /** What is drawn, with which line each section is on and how many genomes were left out. */
  get drawnLines(): LinesModel | null {
    return this.lines
  }

  /** The split the picture is drawn by. */
  get drawnSplit(): LineSplit | null {
    return this.split
  }

  /** The lanes as the Tracks card's heights act on them: each one's tracks. */
  ringLanes(): Array<{ members: AnnotationEntry[] }> {
    return this.ringSlots().map((slot) => ({ members: [slot.host, ...slot.overlaid] }))
  }

  /** The one height that has every lane of a line fill its share of the room — *stretch*. */
  fillingRingSize(): number | null {
    const geometry = this.geometry
    const count = geometry?.lanes.length ?? 0
    if (geometry === null || count === 0) return null
    return Math.max(6, Math.floor(geometry.laneRoom / count))
  }

  /** The two ends of the ribbons' ramp, in the map's own units. */
  chordRange(): { lo: number; hi: number } | null {
    const ribbons = this.ribbons
    if (ribbons === null || ribbons.drawn === 0) return null
    return {
      lo: inverseTransform(ribbons.range.lo, this.scale.transform),
      hi: inverseTransform(ribbons.range.hi, this.scale.transform),
    }
  }

  /** How many ribbons are drawn now. */
  chordsDrawn(): number {
    const model = this.lines?.model ?? null
    if (model === null) return 0
    return Number.isFinite(this.scale.limit) ? Math.min(model.chords.length, this.scale.limit) : model.chords.length
  }

  /** Nothing to undo: the two lines do not zoom. */
  resetZoom(): void {}

  /** No zoom, so no view of part of it. */
  zoomInView(): null {
    return null
  }

  destroy(): void {
    if (this.frame !== 0) cancelAnimationFrame(this.frame)
    this.frame = 0
    this.observer?.disconnect()
    this.samples?.destroy()
    for (const off of this.unsubscribe) off()
    this.unsubscribe.length = 0
  }

  schedule(): void {
    if (this.frame !== 0) return
    this.frame = requestAnimationFrame(() => {
      this.frame = 0
      this.draw()
    })
  }

  // -------------------------------------------------------------------------
  // The model and the layout
  // -------------------------------------------------------------------------

  private rebuild(): void {
    const block = this.block
    const split = this.split
    this.lines =
      block === null || split === null
        ? null
        : linesModelOf(block, (unit) => lineOfUnit(split, unit), this.options.presentation()?.resolver ?? {}, this.bpPerCell, this.cut, CHORD_CAP)
    this.geometry = null
    this.ribbons = null
    this.bins = null
    this.index = null
    this.axis = null
    this.held.clear()
    this.focus = NO_FOCUS
    this.layoutKey = ''
    this.paintPrompt()
    this.schedule()
  }

  /** Sections still without their sequences — a genome × genome block before the contigs table — asked again. */
  private refreshSequences(): void {
    const lines = this.lines
    const block = this.block
    const split = this.split
    const resolver = this.options.presentation()?.resolver
    if (lines === null || block === null || split === null || resolver === undefined) return
    if (lines.model.units.every((unit) => unit.sequences.length > 0)) return
    const fresh = linesModelOf(block, (unit) => lineOfUnit(split, unit), resolver, this.bpPerCell, this.cut, CHORD_CAP)
    if (fresh === null) return
    if (fresh.model.units.every((unit, u) => unit.sequences.length === lines.model.units[u]?.sequences.length)) return
    this.lines = fresh
    this.geometry = null
    this.ribbons = null
    this.bins = null
    this.index = null
    this.axis = null
    this.held.clear()
    this.layoutKey = ''
  }

  private ringSlots(): ReturnType<typeof ringSlotsOf> {
    return ringSlotsOf(this.options.store, this.options.map, this.options.groups)
  }

  private measure(): void {
    const box = this.el.getBoundingClientRect()
    const width = Math.max(0, Math.round(box.width))
    const height = Math.max(0, Math.round(box.height))
    if (width === this.size.width && height === this.size.height) return
    this.size = { width, height }
    const dpr = window.devicePixelRatio || 1
    for (const canvas of [this.canvas, this.guide]) {
      canvas.width = Math.max(1, Math.round(width * dpr))
      canvas.height = Math.max(1, Math.round(height * dpr))
      canvas.style.width = `${width}px`
      canvas.style.height = `${height}px`
    }
    this.layoutKey = ''
  }

  /** The two lines' titles: each level, and how many genomes are on it. */
  private titles(): [{ title: string; detail: string }, { title: string; detail: string }] | null {
    const split = this.split
    const lines = this.lines
    if (split === null || lines === null) return null
    const onLine = (line: 0 | 1): string => {
      const model = lines.model
      if (model.kind === 'genome') {
        const count = model.units.filter((_, u) => lines.side[u] === line).length
        return `${fmt.int(count)} ${count === 1 ? 'genome' : 'genomes'}`
      }
      const genomes = (model.groups ?? []).filter((group) => lines.side[group.from] === line).length
      const contigs = model.units.filter((_, u) => lines.side[u] === line).length
      return `${fmt.int(genomes)} ${genomes === 1 ? 'genome' : 'genomes'}, ${fmt.int(contigs)} contigs`
    }
    return [
      { title: `${split.column} ${split.levels[0]}`, detail: onLine(0) },
      { title: `${split.column} ${split.levels[1]}`, detail: onLine(1) },
    ]
  }

  /** The key's box, where the legend is on and there is anything to colour. */
  private keyLayout(ctx: CanvasRenderingContext2D): ChordKey | null {
    const model = this.lines?.model ?? null
    const drawn = this.chordsDrawn()
    if (model === null || drawn === 0 || !getPlotOptions().legend) return null
    return chordKeyLayout(ctx, this.options.keyTitle(), chordCount(drawn, model.pairs, 'ribbon'))
  }

  /**
   * Everything a frame needs, recomputed only where its inputs moved: the
   * layout when the box, the lanes or the names change, the ribbons when the
   * layout or the scale does.
   */
  private prepare(measure: CanvasRenderingContext2D, width: number, height: number): boolean {
    this.refreshSequences()
    const lines = this.lines
    if (lines === null || width <= 0 || height <= 0) return false
    const slots = this.ringSlots()
    const names = getPlotOptions().labels
    const font = scaleFont(LABEL_FONT)
    const laneNames = slots.map((slot) => (slot.overlaid.length > 0 && slot.host.style.group !== '' ? slot.host.style.group : slot.host.label))
    const titles = this.titles()
    const key = this.keyLayout(measure)
    // The column left of the lines: as wide as the widest of the titles, the
    // lanes' names and the key, and never more than a quarter of the box.
    measure.save()
    let column = key?.width ?? 0
    if (titles !== null) {
      measure.font = scaleFont(TITLE_FONT)
      for (const title of titles) column = Math.max(column, measure.measureText(title.title).width)
      measure.font = scaleFont(TITLE_DETAIL_FONT)
      for (const title of titles) column = Math.max(column, measure.measureText(title.detail).width)
    }
    if (getPlotOptions().text) {
      measure.font = scaleFont(RING_NAME_FONT)
      for (const name of laneNames) column = Math.max(column, Math.min(measure.measureText(name).width, width * 0.2))
    }
    measure.restore()
    const left = KEY_INSET + Math.min(width * 0.25, column) + COLUMN_GAP
    const layoutKey =
      `${width}x${height}|${font}|${names}|${Math.round(left)}|` +
      slots.map((slot) => `${slot.host.id}:${slot.host.style.size}`).join(',')
    if (this.geometry === null || layoutKey !== this.layoutKey) {
      measure.save()
      measure.font = font
      this.geometry = linesGeometry(lines, {
        width,
        height,
        left,
        lanes: slots.map((slot) => ({ id: slot.host.id, size: slot.host.style.size })),
        measure: (text) => measure.measureText(text).width,
        fontPx: fontPixels(font),
        names,
      })
      measure.restore()
      this.layoutKey = layoutKey
      this.ribbons = null
      // A bin a pixel and a half wide along both lines, as the circle's are
      // along its rim.
      const span = Math.max(1, this.geometry.x1 - this.geometry.x0)
      this.bins = circleBins(lines.model, this.geometry, Math.max(360, Math.min(8192, Math.round((2 * span) / 1.5))))
      this.held.clear()
      this.index ??= sequenceIndex(lines.model)
      this.axis ??= circleAxis(lines.model)
    }
    const geometry = this.geometry
    this.ribbons ??= layoutRibbons(lines.model, geometry, this.scale)
    const bins = this.bins
    const index = this.index
    this.rings =
      bins === null || index === null
        ? []
        : drawRings(slots, this.options.groups, (entry) => ({
            content: ringContentOf(entry, {
              model: lines.model,
              bins,
              index,
              axis: this.axis,
              geometry,
              samples: this.samples,
              metadata: this.options.metadata,
              held: this.held,
              scope: 'lines',
            }),
            bins,
          }))
    // The key in the column with the hint under it, the two in the middle of
    // what the lines' titles leave of the ribbons' height — each title's count
    // stands on the ribbons' side of it.
    const titleRoom = 2 * fontPixels(scaleFont(TITLE_FONT)) + 8
    const from = geometry.rows[0].sections.y1 + titleRoom
    const to = geometry.rows[1].sections.y0 - titleRoom
    const hintHeight = this.hint.offsetHeight > 0 ? this.hint.offsetHeight : 52
    const block = (key?.height ?? 0) + 6 + hintHeight
    const top = Math.max(from, Math.min(to - block, (from + to) / 2 - block / 2))
    this.keyAt = key === null ? null : { x: KEY_INSET, y: Math.max(KEY_INSET, top) }
    const hintTop = this.keyAt !== null && key !== null ? this.keyAt.y + key.height : top
    this.placeHint(KEY_INSET, hintTop, left - KEY_INSET - COLUMN_GAP / 2)
    return true
  }

  private placeHint(left: number, top: number, room: number): void {
    this.hint.style.transform = `translate(${Math.round(left)}px, ${Math.round(top + 6)}px)`
    this.hint.style.maxWidth = `${Math.max(80, Math.floor(room))}px`
    this.hint.style.textAlign = ''
    const presentation = this.options.presentation()
    const reorder = presentation?.onMoveUnit !== undefined || presentation?.onMoveGroup !== undefined
    const lines = hintLines(reorder)
    const text = lines.join('\n')
    if (this.hint.dataset.text !== text) {
      this.hint.dataset.text = text
      this.hint.replaceChildren(...lines.map((line) => el('div', { text: line })))
    }
  }

  /**
   * What the picture says where it draws nothing: before a column is chosen,
   * which column — the same select as the Map card's `split by` row — and where
   * the column leaves a line empty, that it does.
   */
  private paintPrompt(): void {
    const presentation = this.options.presentation()?.lines
    const split = this.split
    const empty = split !== null && this.block !== null && this.lines === null
    const show = presentation !== undefined && (split === null || empty)
    this.prompt.classList.toggle('hidden', !show)
    if (!show || presentation === undefined) return
    this.promptText.textContent =
      split === null
        ? 'Split the genomes into two lines by a column of the Genomes table: one with two values, a line each. A genome with no value is left out.'
        : `The genomes here have one value of ${split.column} between them, or none; there is nothing to join ` +
          'between two lines. Pick another column, or open more genomes.'
    paintSplitSelect(this.promptSelect, presentation.choices, split?.column ?? null)
  }

  // -------------------------------------------------------------------------
  // Drawing
  // -------------------------------------------------------------------------

  private draw(): void {
    const ctx = this.canvas.getContext('2d')
    if (ctx === null) return
    const { width, height } = this.size
    const dpr = this.canvas.width / Math.max(1, width)
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height)
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    if (!this.prepare(ctx, width, height)) {
      this.hint.classList.add('hidden')
      return
    }
    this.hint.classList.remove('hidden')
    this.paint(ctx, readCirclePalette(this.canvas), true)
    this.describeGeometry()
  }

  /**
   * The whole picture into a context already scaled to CSS pixels: the lanes,
   * the ribbons, the sections, the names, the titles and the key. The screen and
   * a figure both come through here; `live` is the screen's — the hover and a
   * section in the hand are never drawn into a file.
   */
  private paint(ctx: CanvasRenderingContext2D, palette: CirclePalette, live: boolean): void {
    const lines = this.lines
    const geometry = this.geometry
    const ribbons = this.ribbons
    if (lines === null || geometry === null || ribbons === null) return
    const focus = live ? this.focus : NO_FOCUS
    const lit = focus.unit >= 0 || focus.slot >= 0 || focus.group >= 0
    const options = getPlotOptions()
    const ink: RingInk = { guide: palette.text, fills: options.fills, outline: options.outline, baseline: options.baseline }
    this.rings.forEach((ring, k) => {
      const lane = geometry.lanes[k]
      if (lane === undefined) return
      for (const line of [0, 1] as const) {
        ring.members.forEach((member, m) => {
          paintLane(ctx, member, lane.rows[line], line, geometry, member.bins, m === 0 ? palette.wash : null, ink, lit)
        })
      }
    })
    const paint = { lines, geometry, ribbons, palette, focus, colormap: this.scale.colormap, transform: this.scale.transform }
    paintRibbons(ctx, paint)
    paintLineSections(ctx, paint)
    const labelRoom = Math.max(24, geometry.rows[0].labelAt - 4)
    paintLineLabels(ctx, { ...paint, font: scaleFont(LABEL_FONT), boldFont: scaleFont(LABEL_BOLD), room: labelRoom })
    this.paintColumn(ctx, geometry, palette)
    const key = this.keyLayout(ctx)
    if (key !== null && this.keyAt !== null) {
      paintChordKey(ctx, key, this.keyAt, { ...this.scale, range: ribbons.range }, palette, false)
    }
    if (live && this.carry?.moved === true) this.paintCarry(ctx, geometry, palette, this.carry)
  }

  /**
   * The column left of the lines: each line's title by its sections — the level,
   * in bold, over how many genomes are on it — and each lane's name by its lane,
   * right-aligned where the lane begins, as the 1D browser names its lanes.
   */
  private paintColumn(ctx: CanvasRenderingContext2D, geometry: LinesGeometry, palette: CirclePalette): void {
    const right = geometry.x0 - COLUMN_GAP / 2
    ctx.save()
    ctx.textAlign = 'right'
    ctx.textBaseline = 'middle'
    ctx.lineJoin = 'round'
    const titles = this.titles()
    if (titles !== null) {
      for (const line of [0, 1] as const) {
        const rows = geometry.rows[line]
        const middle = (rows.sections.y0 + rows.sections.y1) / 2
        const title = titles[line]
        const titlePx = fontPixels(scaleFont(TITLE_FONT))
        // The title against its sections, its count on the ribbons' side —
        // under the top line's, over the bottom line's — where the column is
        // empty whatever the names and the lanes take.
        const detailY = line === 0 ? middle + titlePx + 1 : middle - titlePx - 1
        ctx.font = scaleFont(TITLE_FONT)
        ctx.fillStyle = palette.text
        ctx.fillText(fitText(ctx, title.title, right - KEY_INSET), right, middle)
        ctx.font = scaleFont(TITLE_DETAIL_FONT)
        ctx.fillStyle = palette.dim
        ctx.fillText(fitText(ctx, title.detail, right - KEY_INSET), right, detailY)
      }
    }
    if (getPlotOptions().text) {
      const wanted = fontPixels(scaleFont(RING_NAME_FONT))
      this.rings.forEach((ring, k) => {
        const lane = geometry.lanes[k]
        if (lane === undefined) return
        for (const line of [0, 1] as const) {
          const rect = lane.rows[line]
          const px = ringNamePx(wanted, { inner: rect.y0, outer: rect.y1 })
          if (px === null) continue
          ctx.font = `${px.toFixed(1)}px system-ui, sans-serif`
          ctx.fillStyle = palette.text
          ctx.fillText(fitText(ctx, ring.label, right - KEY_INSET), right, (rect.y0 + rect.y1) / 2)
        }
      })
    }
    ctx.restore()
  }

  /** The section in the hand, edged in the accent, and the bar in the gap it would land in. */
  private paintCarry(ctx: CanvasRenderingContext2D, geometry: LinesGeometry, palette: CirclePalette, carry: Carry): void {
    const line = carry.kind === 'unit' ? (carry.lines.side[carry.index] as 0 | 1) : (geometry.groupSide?.[carry.index] as 0 | 1)
    const rows = geometry.rows[line]
    const arcs = carry.kind === 'unit' ? geometry.arcs : geometry.groupArcs
    const band = carry.kind === 'unit' ? rows.sections : rows.band
    if (arcs === null || band === null || line === undefined) return
    ctx.save()
    const x0 = arcs[2 * carry.index]
    const x1 = arcs[2 * carry.index + 1]
    ctx.strokeStyle = palette.accent
    ctx.lineWidth = 1.5
    ctx.strokeRect(x0 - 1.5, band.y0 - 1.5, x1 - x0 + 3, band.y1 - band.y0 + 3)
    const drop = carry.drop
    if (drop !== null) {
      const top = Math.min(rows.sections.y0, rows.band?.y0 ?? Number.POSITIVE_INFINITY) - 6
      const bottom = Math.max(rows.sections.y1, rows.band?.y1 ?? 0) + 6
      ctx.lineCap = 'round'
      ctx.beginPath()
      ctx.moveTo(drop.at, top)
      ctx.lineTo(drop.at, bottom)
      ctx.strokeStyle = palette.halo
      ctx.lineWidth = 6
      ctx.stroke()
      ctx.strokeStyle = palette.accent
      ctx.lineWidth = 3
      ctx.stroke()
    }
    ctx.restore()
  }

  /**
   * The picture for a figure: the whole box, painted at a scale from the
   * context's origin — onto a canvas for a PNG, a vector page for a PDF.
   */
  figure(): { width: number; height: number; paint(ctx: CanvasRenderingContext2D, scale: number): void } | null {
    const { width, height } = this.size
    if (this.lines === null || this.geometry === null || width <= 0 || height <= 0) return null
    return {
      width,
      height,
      paint: (ctx, scale) => {
        ctx.save()
        ctx.setTransform(scale, 0, 0, scale, 0, 0)
        if (this.prepare(ctx, width, height)) this.paint(ctx, readCirclePalette(this.canvas), false)
        ctx.restore()
      },
    }
  }

  /**
   * Where everything is, on the canvas's own dataset — read by the galleries to
   * aim at a section or a ribbon, and by nothing in the app.
   */
  private describeGeometry(): void {
    const lines = this.lines
    const geometry = this.geometry
    const ribbons = this.ribbons
    if (lines === null || geometry === null) return
    const round = (value: number): number => Math.round(value * 10) / 10
    const model = lines.model
    const strongest: Array<{ a: string; b: string; x: number; y: number }> = []
    if (ribbons !== null) {
      for (let slot = ribbons.drawn - 1; slot >= Math.max(0, ribbons.drawn - 3); slot--) {
        const chord = model.chords[ribbons.order[slot]]
        const ends = ribbons.ends
        // Halfway down the ribbon, between its two ends' middles.
        const x = (ends[slot * 4] + ends[slot * 4 + 2]) / 2
        strongest.push({ a: model.units[chord.a].name, b: model.units[chord.b].name, x: round(x), y: round((geometry.ribbons.y0 + geometry.ribbons.y1) / 2) })
      }
    }
    this.canvas.dataset.geometry = JSON.stringify({
      layout: 'lines',
      split: this.split === null ? null : { column: this.split.column, levels: this.split.levels, counts: this.split.counts, missing: this.split.missing },
      leftOut: lines.leftOut,
      x0: round(geometry.x0),
      x1: round(geometry.x1),
      rows: geometry.rows.map((rows) => ({
        sections: [round(rows.sections.y0), round(rows.sections.y1)],
        band: rows.band === null ? null : [round(rows.band.y0), round(rows.band.y1)],
        labelAt: round(rows.labelAt),
      })),
      ribbons: [round(geometry.ribbons.y0), round(geometry.ribbons.y1)],
      lanes: geometry.lanes.map((lane) => ({ id: lane.id, rows: lane.rows.map((rect) => [round(rect.y0), round(rect.y1)]) })),
      units: model.units.map((unit, u) => ({ name: unit.name, line: lines.side[u], mid: round(midX(geometry, u)) })),
      groups:
        model.groups === null || geometry.groupArcs === null
          ? null
          : model.groups.map((group, g) => ({
              name: group.name,
              line: geometry.groupSide?.[g] ?? 0,
              mid: round(((geometry.groupArcs as Float64Array)[2 * g] + (geometry.groupArcs as Float64Array)[2 * g + 1]) / 2),
            })),
      names: geometry.names,
      labelled: geometry.labelled.reduce((sum, on) => sum + on, 0) + (geometry.groupLabelled?.reduce((sum, on) => sum + on, 0) ?? 0),
      chords: ribbons?.drawn ?? 0,
      pairs: model.pairs,
      key: this.keyAt,
      strongest,
    })
  }

  /** The crosshair, the lines' way: a vertical hairline through the lanes and the sections of the line under the pointer. */
  private drawGuide(at: { x: number; y: number } | null): void {
    const canvas = this.guide
    const ctx = canvas.getContext('2d')
    if (ctx === null) return
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.clearRect(0, 0, canvas.width, canvas.height)
    const geometry = this.geometry
    if (at === null || geometry === null || this.carry?.moved === true || !getPlotOptions().crosshair) return
    if (at.x < geometry.x0 || at.x > geometry.x1) return
    const line = at.y <= geometry.ribbons.y0 ? 0 : at.y >= geometry.ribbons.y1 ? 1 : null
    if (line === null) return
    const rows = geometry.rows[line]
    const outer = geometry.lanes.reduce(
      (edge, lane) => (line === 0 ? Math.min(edge, lane.rows[0].y0) : Math.max(edge, lane.rows[1].y1)),
      line === 0 ? (rows.band?.y0 ?? rows.sections.y0) : (rows.band?.y1 ?? rows.sections.y1),
    )
    const inner = line === 0 ? rows.sections.y1 : rows.sections.y0
    const dpr = canvas.width / Math.max(1, this.size.width)
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.strokeStyle = CROSSHAIR_COLOR
    ctx.lineWidth = Math.max(1 / dpr, 0.75)
    ctx.beginPath()
    ctx.moveTo(at.x, outer)
    ctx.lineTo(at.x, inner)
    ctx.stroke()
  }

  // -------------------------------------------------------------------------
  // The pointer
  // -------------------------------------------------------------------------

  /**
   * A press on a section or a genome's band that travels carries it along its
   * line (§7.6); one that does not is a click, heard at once — with no zoom,
   * there is no double click to wait for.
   */
  private watchPointer(): void {
    const canvas = this.canvas
    const local = (event: MouseEvent): { x: number; y: number } => {
      const box = canvas.getBoundingClientRect()
      return { x: event.clientX - box.left, y: event.clientY - box.top }
    }
    canvas.addEventListener('pointerdown', (event) => {
      if (event.button !== 0) return
      const at = local(event)
      canvas.setPointerCapture(event.pointerId)
      this.carry = this.carryFrom(this.hitAt(at), event.pointerId, at)
      this.press = { pointer: event.pointerId, x: at.x, y: at.y }
    })
    canvas.addEventListener('pointermove', (event) => {
      const at = local(event)
      const carry = this.carry
      if (carry !== null && carry.pointer === event.pointerId) {
        if (carry.moved || Math.hypot(at.x - carry.x, at.y - carry.y) >= DRAG_SLOP) {
          this.moveCarry(carry, at)
          return
        }
      }
      this.hover(at)
    })
    canvas.addEventListener('pointerleave', () => {
      if (this.carry?.moved === true) return
      this.drawGuide(null)
      this.setFocus(NO_FOCUS)
      this.tip.classList.add('hidden')
      canvas.style.cursor = ''
    })
    canvas.addEventListener('pointerup', (event) => {
      const at = local(event)
      if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId)
      const carry = this.carry
      if (carry !== null && carry.pointer === event.pointerId && carry.moved) {
        this.endCarry(true)
        this.press = null
        this.hover(at)
        return
      }
      this.carry = null
      const press = this.press
      this.press = null
      if (press === null || press.pointer !== event.pointerId) return
      this.click(this.hitAt(at))
    })
    const abandon = (): void => {
      if (this.carry !== null) this.endCarry(false)
      this.press = null
    }
    canvas.addEventListener('pointercancel', abandon)
    canvas.addEventListener('lostpointercapture', (event) => {
      if (this.carry?.pointer === event.pointerId) abandon()
    })
    const onEscape = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape' || this.carry?.moved !== true) return
      event.preventDefault()
      this.endCarry(false)
      this.press = null
    }
    window.addEventListener('keydown', onEscape)
    this.unsubscribe.push(() => window.removeEventListener('keydown', onEscape))
  }

  private hitAt(at: { x: number; y: number }): LinesHit | null {
    const lines = this.lines
    const geometry = this.geometry
    if (lines === null || geometry === null) return null
    return hitLines(lines, geometry, this.ribbons, at.x, at.y)
  }

  private hover(at: { x: number; y: number }): void {
    const hit = this.hitAt(at)
    this.drawGuide(at)
    this.canvas.style.cursor = hit === null || hit.kind === 'lane' ? '' : 'pointer'
    this.setFocus(
      hit === null
        ? NO_FOCUS
        : hit.kind === 'section'
          ? { unit: hit.unit, slot: -1, group: -1 }
          : hit.kind === 'group'
            ? { unit: -1, slot: -1, group: hit.group }
            : hit.kind === 'chord'
              ? { unit: -1, slot: hit.slot, group: -1 }
              : NO_FOCUS,
    )
    this.describe(hit, at)
  }

  private setFocus(focus: CircleFocus): void {
    if (focus.unit === this.focus.unit && focus.slot === this.focus.slot && focus.group === this.focus.group) return
    this.focus = focus
    this.schedule()
  }

  /** What a click on each part opens: what the circle's clicks open. */
  private click(hit: LinesHit | null): void {
    const model = this.lines?.model ?? null
    const presentation = this.options.presentation()
    if (hit === null || model === null || presentation === undefined) return
    if (hit.kind === 'section') {
      const unit = model.units[hit.unit]
      if (unit !== undefined) presentation.onOpenUnit?.(unit)
    } else if (hit.kind === 'group') {
      const group = model.groups?.[hit.group]
      if (group !== undefined) presentation.onOpenGroup?.(group.name)
    } else if (hit.kind === 'chord' && this.ribbons !== null) {
      const chord = model.chords[this.ribbons.order[hit.slot]]
      const a = chord === undefined ? undefined : model.units[chord.a]
      const b = chord === undefined ? undefined : model.units[chord.b]
      if (a !== undefined && b !== undefined) presentation.onOpenPair?.(a, b)
    }
  }

  /** The card under the pointer, in the map's own card. */
  private describe(hit: LinesHit | null, at: { x: number; y: number }): void {
    const lines = this.lines
    const geometry = this.geometry
    if (hit === null || lines === null || geometry === null || !getPlotOptions().tooltip) {
      this.tip.classList.add('hidden')
      return
    }
    const model = lines.model
    const out: Array<{ text: string; strong?: boolean }> = []
    if (hit.kind === 'section' || hit.kind === 'group') {
      const group = hit.kind === 'group' ? model.groups?.[hit.group] : undefined
      const unit = hit.kind === 'section' ? model.units[hit.unit] : undefined
      out.push({ text: group?.name ?? unit?.label ?? '', strong: true })
      if (unit?.genome !== undefined && model.kind === 'contig') out.push({ text: unit.genome })
      const line = hit.kind === 'section' ? lines.side[hit.unit] : group === undefined ? 0 : lines.side[group.from]
      if (this.split !== null) out.push({ text: `${this.split.column} ${this.split.levels[line]}` })
      const bp = group === undefined ? (unit?.bp ?? 0) : model.units.slice(group.from, group.to).reduce((sum, member) => sum + member.bp, 0)
      out.push({ text: fmt.bp(bp) })
      if (group !== undefined) {
        out.push({ text: `${fmt.int(group.to - group.from)} contigs` })
      } else if (hit.kind === 'section') {
        const within = model.intra[hit.unit]
        const between = model.inter[hit.unit]
        out.push({ text: `${formatCount(within)} contacts within` })
        const share = within + between > 0 ? ` (${fmt.pct(between / (within + between))})` : ''
        out.push({ text: `${formatCount(between)} with the other line${share}` })
      }
      const weights = partnerWeights(model, this.focus)
      if (weights !== null) {
        const ranked = [...weights.keys()].filter((k) => weights[k] > 0).sort((x, y) => weights[y] - weights[x])
        for (const k of ranked.slice(0, 5)) out.push({ text: `→ ${model.units[k].label} · ${formatCount(weights[k])}` })
        if (ranked.length > 5) out.push({ text: `and ${fmt.int(ranked.length - 5)} more` })
      }
    } else if (hit.kind === 'chord' && this.ribbons !== null) {
      const chord = model.chords[this.ribbons.order[hit.slot]]
      if (chord === undefined) return
      const a = model.units[chord.a]
      const b = model.units[chord.b]
      out.push({ text: `${a.label} × ${b.label}`, strong: true })
      out.push({ text: `${fmt.int(Math.round(chord.weight))} contacts` })
      const ofA = model.inter[chord.a] > 0 ? chord.weight / model.inter[chord.a] : Number.NaN
      const ofB = model.inter[chord.b] > 0 ? chord.weight / model.inter[chord.b] : Number.NaN
      if (Number.isFinite(ofA)) out.push({ text: `${fmt.pct(ofA)} of ${a.label}’s with the other line` })
      if (Number.isFinite(ofB)) out.push({ text: `${fmt.pct(ofB)} of ${b.label}’s with the other line` })
    } else if (hit.kind === 'lane') {
      const ring = this.rings[hit.lane]
      if (ring === undefined) return
      if (ring.members.length === 1) out.push({ text: ring.label, strong: true })
      const unit = model.units[hit.unit]
      const bp = Math.floor(bpAtX(geometry, model, hit.unit, hit.x))
      const place = sequenceAt(model, hit.unit, bp)
      out.push({
        text:
          place === null
            ? unit.label
            : model.kind === 'genome'
              ? `${unit.label} · ${formatPosition(place.name, place.position)}`
              : formatPosition(place.name, place.position),
      })
      for (const member of ring.members) {
        const value = laneValue(member.content, member.bins, hit.unit, hit.x)
        out.push({ text: ring.members.length === 1 ? value : `${member.label} · ${value}` })
      }
    }
    this.tip.replaceChildren(
      ...out.map((line, k) => el('div', { class: line.strong === true || k === 0 ? 'cell-tip-title' : 'cell-tip-line', text: line.text })),
    )
    this.tip.classList.remove('hidden')
    this.placeTip(at)
  }

  private placeTip(at: { x: number; y: number }): void {
    const pad = 14
    const width = this.tip.offsetWidth
    const height = this.tip.offsetHeight
    const left = at.x + pad + width > this.size.width ? at.x - pad - width : at.x + pad
    const top = at.y + pad + height > this.size.height ? at.y - pad - height : at.y + pad
    this.tip.style.transform = `translate(${Math.max(0, left)}px, ${Math.max(0, top)}px)`
  }

  // -------------------------------------------------------------------------
  // Carrying a section along its line (§7.6)
  // -------------------------------------------------------------------------

  private carryFrom(hit: LinesHit | null, pointer: number, at: { x: number; y: number }): Carry | null {
    const lines = this.lines
    const presentation = this.options.presentation()
    if (hit === null || lines === null || presentation === undefined) return null
    const taken =
      hit.kind === 'section' && presentation.onMoveUnit !== undefined
        ? { kind: 'unit' as const, index: hit.unit }
        : hit.kind === 'group' && presentation.onMoveGroup !== undefined
          ? { kind: 'group' as const, index: hit.group }
          : null
    if (taken === null) return null
    const carry: Carry = { ...taken, lines, pointer, x: at.x, y: at.y, moved: false, drop: null }
    return this.carryAmong(carry).length < 2 ? null : carry
  }

  /**
   * The places a carried section can land among, left to right: its line's
   * genomes for a genome — the column put it on that line — and its genome's
   * contigs for a contig.
   */
  private carryAmong(carry: Carry): number[] {
    const geometry = this.geometry
    if (geometry === null) return []
    const model = carry.lines.model
    if (carry.kind === 'group') {
      const sides = geometry.groupSide
      const line = sides?.[carry.index]
      return (model.groups ?? []).map((_, g) => g).filter((g) => sides?.[g] === line)
    }
    const line = carry.lines.side[carry.index]
    const group = model.groups?.find((candidate) => carry.index >= candidate.from && carry.index < candidate.to)
    return Array.from(geometry.members[line as 0 | 1]).filter(
      (u) => group === undefined || (u >= group.from && u < group.to),
    )
  }

  private moveCarry(carry: Carry, at: { x: number; y: number }): void {
    const geometry = this.geometry
    if (geometry === null || this.lines !== carry.lines) {
      this.endCarry(false)
      return
    }
    if (!carry.moved) {
      carry.moved = true
      this.press = null
      this.canvas.style.cursor = 'grabbing'
      this.drawGuide(null)
      this.setFocus(
        carry.kind === 'unit' ? { unit: carry.index, slot: -1, group: -1 } : { unit: -1, slot: -1, group: carry.index },
      )
    }
    const arcs = carry.kind === 'unit' ? geometry.arcs : geometry.groupArcs
    carry.drop = arcs === null ? null : lineDrop(arcs, this.carryAmong(carry), carry.index, at.x)
    this.schedule()
    if (!getPlotOptions().tooltip) {
      this.tip.classList.add('hidden')
      return
    }
    const model = carry.lines.model
    const name = (index: number): string =>
      carry.kind === 'unit' ? (model.units[index]?.label ?? '') : (model.groups?.[index]?.name ?? '')
    const drop = carry.drop
    const unit = carry.kind === 'unit' ? model.units[carry.index] : undefined
    this.tip.replaceChildren(
      el('div', { class: 'cell-tip-title', text: name(carry.index) }),
      el('div', {
        class: 'cell-tip-line',
        text: drop === null ? 'Stays where it is' : `${drop.side === 'before' ? 'Before' : 'After'} ${name(drop.index)}`,
      }),
      ...(unit?.genome !== undefined && model.groups !== null
        ? [el('div', { class: 'cell-tip-line', text: `Within ${unit.genome}` })]
        : []),
    )
    this.tip.classList.remove('hidden')
    this.placeTip(at)
  }

  /** Let go: the section goes beside the one it was dropped by, in the reader's order — or stays. */
  private endCarry(commit: boolean): void {
    const carry = this.carry
    this.carry = null
    if (carry === null) return
    if (carry.moved) {
      this.canvas.style.cursor = ''
      this.tip.classList.add('hidden')
      this.setFocus(NO_FOCUS)
    }
    const drop = carry.drop
    const presentation = this.options.presentation()
    if (commit && carry.moved && drop !== null && presentation !== undefined && this.lines === carry.lines) {
      const model = carry.lines.model
      if (carry.kind === 'unit') {
        const moved = model.units[carry.index]
        const anchor = model.units[drop.index]
        if (moved !== undefined && anchor !== undefined) presentation.onMoveUnit?.(moved, anchor, drop.side)
      } else {
        const moved = model.groups?.[carry.index]
        const anchor = model.groups?.[drop.index]
        if (moved !== undefined && anchor !== undefined) presentation.onMoveGroup?.(moved.name, anchor.name, drop.side)
      }
    }
    this.schedule()
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** A section's line: a genome's own, a contig's genome's — or none. */
function lineOfUnit(split: LineSplit, unit: CircleUnit): -1 | 0 | 1 {
  if (unit.kind === 'genome') return split.lineOf(unit.name)
  return unit.genome === undefined ? -1 : split.lineOf(unit.genome)
}

/** What a lane holds at an x of a section, as the card says it. */
function laneValue(content: RingContent, bins: CircleBins, unit: number, x: number): string {
  if (content.kind === 'empty') return content.note === '' ? 'nothing here' : content.note
  if (content.kind === 'features') {
    const hits = content.arcs.filter((arc) => arc.unit === unit && x >= arc.a0 && x <= arc.a1)
    return hits.length === 0 ? 'no feature here' : `${fmt.int(hits.length)} ${hits.length === 1 ? 'feature' : 'features'}`
  }
  const bin = binAtX(bins, unit, x)
  if (bin < 0) return 'nothing here'
  if (content.kind === 'classes') {
    const code = content.classes.codes[bin]
    return code < 0 ? 'no value' : content.classes.levels[code]
  }
  const value = content.values.values[bin]
  return Number.isFinite(value) ? fmt.num(value) : 'no value'
}

/**
 * Fill a `split by` select (§7.6): a first option asking for a column where
 * none is chosen, then every column of the Genomes table — those that split the
 * genomes in two with their two levels, the rest greyed with why not. The
 * options are rebuilt only when the list itself changed, so a select whose menu
 * is open is not closed under the pointer.
 */
export function paintSplitSelect(select: HTMLSelectElement, choices: readonly SplitChoice[], column: string | null): void {
  const key = JSON.stringify([column === null, choices.map((choice) => [choice.column, choice.levels, choice.reason])])
  if (select.dataset.key !== key) {
    select.dataset.key = key
    select.replaceChildren(
      ...(column === null ? [el('option', { value: '', text: 'pick a column…' })] : []),
      ...choices.map((choice) => {
        const option = el('option', {
          value: choice.column,
          text:
            choice.levels === null
              ? `${choice.column} — ${choice.reason ?? 'cannot split'}`
              : `${choice.column} — ${choice.levels[0]} | ${choice.levels[1]}`,
        })
        option.disabled = choice.levels === null
        return option
      }),
    )
  }
  select.value = column ?? ''
}
