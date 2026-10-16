/**
 * The map drawn round, on screen (§7.6): the canvas, the hover, the clicks and
 * the rings a reader drags into another order.
 *
 * Built by `MatrixPanel` the first time a block is drawn round and kept while
 * the panel lives. The panel hands it the block it already holds and the scale
 * its Map card sets; everything this draws is arithmetic over those
 * (`render/circle.ts`, `render/circleRings.ts`), so the circle never reads a
 * pixel the square did not.
 *
 * **The rings are the tracks.** Every row the map draws — a bigWig on any of
 * its four edges, a column of `/genomes` or `/contigs`, a computed track, a set
 * of features — is a ring here, in the Tracks card's order: the first nearest
 * the chords, as the first lane of a stack is nearest the map. Dragging a ring
 * across the others moves its row in that one list, so the card and the lanes
 * beside the square follow — one order, wherever it is drawn.
 */

import { el } from './dom'
import { getPlotOptions, subscribePlotOptions } from './plotOptions'
import { registerCircle, ringColumn, ringPlacement, subscribeRingColumn, subscribeRingPlacement } from './circlePrefs'
import { laneSize } from './trackControls'
import { scaleFont, subscribeTextScale } from './textScale'
import { fmt } from '../units'
import { formatPosition } from '../genome/assembly'
import { SampleCache } from '../annotations/samples'
import type { AnnotationClient } from '../annotations/worker/client'
import type { AnnotationStore } from '../annotations/store'
import type { MapId } from '../annotations/placement'
import {
  OVERLAY_DIM,
  extentFor,
  planStack,
  resolveGroupExtents,
  type GroupSettings,
} from '../annotations/groups'
import { colormapOf, type AnnotationEntry, type AnnotationKind, type TrackSampleSet } from '../annotations/types'
import type { MetaBlock } from '../annotations/metadata'
import { LocusAxis, type LocusSegment } from '../render/locus'
import { resolveLimits } from '../render/tracks'
import { formatCount } from '../render/legend'
import { inverseTransform } from '../render/scale'
import type { MatrixResult } from '../worker/protocol'
import type { Transform } from '../types'
import {
  CHORD_CAP,
  CIRCLE_MAX_ZOOM,
  COLUMN_MAX,
  LIGHT_CIRCLE_PALETTE,
  NO_FOCUS,
  TOP,
  anglesInView,
  arcCurve,
  carryRadius,
  namesInView,
  radialCursor,
  radialStops,
  ringEdgeAt,
  ringScale,
  unitsInView,
  chordBend,
  chordColour,
  circleGeometry,
  fitText,
  fontPixels,
  fromTwelve,
  ringNameAt,
  ringNamePx,
  circleModelOf,
  hitCircle,
  layoutChords,
  paintChords,
  paintLabels,
  paintSections,
  partnerWeights,
  type ChordLayout,
  type CircleCut,
  type CircleFocus,
  type CircleGeometry,
  type CircleHit,
  type CircleLayoutOptions,
  type CircleModel,
  type CirclePalette,
  type CircleResolver,
  type CircleUnit,
} from '../render/circle'
import {
  binAt,
  binCells,
  binSamples,
  bpAtAngle,
  circleBins,
  featureArcs,
  paintRing,
  sequenceAt,
  sequenceIndex,
  windowBins,
  type BinnedClasses,
  type BinnedValues,
  type CircleBins,
  type FeatureArc,
  type RingContent,
  type RingInk,
  type RingPaint,
  type SequenceIndex,
} from '../render/circleRings'
import type { MetaSource } from './AnnotationLanes'
import { ringBlockOrder } from './ringOrder'
import { CROSSHAIR_COLOR } from '../render/heatmap'

/**
 * The circle, as the session hands it to a view: whether it is asked for, and
 * what the file knows that the block does not.
 *
 * A presentation like the turn's (`TurnPresentation`) and kept on the same
 * terms: the state is the session's, rebuilt on every render, and the panel
 * keeps no answer of its own.
 */
export interface CirclePresentation {
  /** Whether the reader has asked for the circle. */
  on: boolean
  /** Absent where the panel draws it without owning the control. */
  onChange?(on: boolean): void
  /**
   * Why this view is not drawn round, where it cannot be — a pair of genomes,
   * a window of one sequence. The toggle is greyed with this as its reason.
   */
  refusal?: string
  /** Lengths and sequences the block does not carry (`render/circle.ts`). */
  resolver?: CircleResolver
  /** A section's arc or its name was clicked: open what it is. */
  onOpenUnit?(unit: CircleUnit): void
  /** A genome of the band over contig sections was clicked. */
  onOpenGroup?(genome: string): void
  /** A chord was clicked: open the block between its two sections. */
  onOpenPair?(a: CircleUnit, b: CircleUnit): void
  /**
   * How a block divided by genome is cut — its genomes, the default, or its
   * contigs grouped under them (`render/circle.ts`, {@link circleCuts}).
   */
  cut?: CircleCut
  /** The reader chose the other cut; absent where the panel only draws. */
  onCut?(cut: CircleCut): void
}

export interface CircleViewOptions {
  store: AnnotationStore
  map: MapId
  client?: AnnotationClient
  metadata?: MetaSource
  /** How each group of tracks is drawn and scaled — the lanes' answer, for the rings. */
  groups?: GroupSettings
  /** The session's presentation as it stands now; see {@link CirclePresentation}. */
  presentation(): CirclePresentation | undefined
  /** What the key calls the chords' numbers — the map key's own title. */
  keyTitle(): string
}

/** How the chords are drawn: the Map card's transform and ramp, and how many. */
export interface CircleScale {
  transform: Transform
  colormap: string
  /** The strongest this many chords; `Infinity` for all the model kept. */
  limit: number
}

/** The kinds a ring can be drawn from, by what is drawn. */
const SIGNAL_KINDS: ReadonlySet<AnnotationKind> = new Set<AnnotationKind>(['track', 'sequence', 'alignments'])
const META_KINDS: ReadonlySet<AnnotationKind> = new Set<AnnotationKind>(['metadata', 'classes'])
const FEATURE_KINDS: ReadonlySet<AnnotationKind> = new Set<AnnotationKind>([
  'segments',
  'gtf',
  'variants',
  'ideogram',
  'barchart',
])

/** Whether a row can be a ring at all. */
export function drawsAsRing(entry: AnnotationEntry): boolean {
  return SIGNAL_KINDS.has(entry.kind) || META_KINDS.has(entry.kind) || FEATURE_KINDS.has(entry.kind)
}

/**
 * One ring's tracks, as one lane's: a track, or an overlay group's tracks
 * drawn into the band of the first of them (`planStack`, the lanes' own plan).
 */
interface RingSlot {
  host: AnnotationEntry
  overlaid: AnnotationEntry[]
}

/** A ring as drawn: its slot's tracks, each with its numbers and its look resolved. */
interface RingDrawn {
  /** The first track's id, which the ring is held and moved by. */
  id: string
  /** What is written at twelve o'clock: the track's name, or an overlay group's. */
  label: string
  /** Each track, with the bins its numbers are in: the whole circle's, or the zoom's. */
  members: Array<RingPaint & { bins: CircleBins }>
}

/**
 * A zoomed picture's own bins and numbers (`windowBins`): as fine as the screen
 * across what is in view, computed once the view holds still and drawn for as
 * long as what is in view is inside what they cover.
 */
interface Detail {
  /** The view they were cut for; another view is redrawn from the whole circle's until they are cut again. */
  key: string
  windows: Array<[number, number]>
  bins: CircleBins
  /** Each track's numbers in those bins, kept with what they were binned from. */
  contents: Map<string, { from: readonly unknown[]; content: RingContent }>
}

/** The label font, and its bold for the lit section. */
const LABEL_FONT = '10px system-ui, sans-serif'
const LABEL_BOLD = '600 10px system-ui, sans-serif'
const RING_NAME_FONT = '10px system-ui, sans-serif'
const KEY_TITLE_FONT = '600 11px system-ui, sans-serif'
const KEY_FONT = '10px system-ui, sans-serif'

/**
 * What the picture answers to, under its key on hover (§26.4): how to zoom
 * and, zoomed, how to move about and back; then what a click and a ring do.
 * The ring's line names its grip as it is drawn — the name, or with the names
 * off the ring's end at twelve o'clock.
 */
function hintLines(zoomed: boolean, rings: boolean, named: boolean): string[] {
  return [
    zoomed ? 'Drag to pan; double-click to fit' : 'Scroll to zoom',
    !rings
      ? 'Click an arc or a chord to open it'
      : named
        ? 'Click to open; drag a ring by its name to move it'
        : 'Click to open; drag a ring at the top to move it',
  ]
}

/** A second press this soon after the first is a double one — the map's window. */
const DOUBLE_CLICK_MS = 250
/** One PageUp or PageDown, as on the map. */
const KEY_ZOOM = 1.25
/** How much a wheel's delta zooms: exponential, so a trackpad's many and a mouse's few agree. */
const WHEEL_RATE = 0.002
/** How long the view holds still before a zoom's own bins are cut. */
const SETTLE_MS = 150
/** Pixels to a bin, along the rings, in a zoomed picture's own bins. */
const BIN_PX = 1.5
/** How far past each edge of the box, in boxes, a zoomed picture's own bins reach. */
const DETAIL_PAD = 0.5
/** The most stretches of the axis a zoomed picture reads a signal over, a request each. */
const DETAIL_STRETCHES = 4

/** The key's distance from the picture's corner, its ramp's height, and its gap beside the circle. */
const KEY_INSET = 10
const KEY_BAR = 8
const KEY_GAP = 16

/** Pixels the pointer travels before a press becomes a drag: a ring carried, or the view panned. */
const DRAG_SLOP = 5

/** A press that has not yet become a click or a pan. */
interface Press {
  pointer: number
  x: number
  y: number
  /** The view's offset when the press began, which a pan moves from and Escape goes back to. */
  offset: { x: number; y: number }
  panning: boolean
}

interface RingDrag {
  id: string
  pointer: number
  /** The rings' ids in the order they are being drawn while the hand is down. */
  order: string[]
  /** The order the drag began from, for Escape. */
  from: string[]
  moved: boolean
  start: { x: number; y: number }
}

/** A binned ring, kept until its inputs change. */
interface HeldRing {
  key: unknown
  content: RingContent
}

export class CircleView {
  readonly el: HTMLElement
  private readonly canvas: HTMLCanvasElement
  /** The crosshair's own layer over the picture; see {@link drawGuide}. */
  private readonly guide: HTMLCanvasElement
  private readonly tip: HTMLElement
  private readonly hint: HTMLElement
  private readonly samples: SampleCache | null
  private block: MatrixResult | null = null
  private bpPerCell = 1
  private cut: CircleCut = 'genomes'
  private model: CircleModel | null = null
  private scale: CircleScale = { transform: 'log1p', colormap: 'default', limit: Number.POSITIVE_INFINITY }
  private geometry: CircleGeometry | null = null
  private chords: ChordLayout | null = null
  private bins: CircleBins | null = null
  private index: SequenceIndex | null = null
  private axis: LocusAxis | null = null
  private rings: RingDrawn[] = []
  private readonly held = new Map<string, HeldRing>()
  private focus: CircleFocus = NO_FOCUS
  private drag: RingDrag | null = null
  private pending: { id: string; x: number; y: number; pointer: number } | null = null
  /**
   * The zoom (§7.6): how many times the picture's radius the circle is drawn
   * at, and where its middle is, from the middle of the box. 1 and nowhere is
   * the circle fitted to the box.
   */
  private zoom = 1
  private offset = { x: 0, y: 0 }
  /** The circle fitted to the box, which a zoom is laid out against. */
  private fitGeometry: CircleGeometry | null = null
  /** What the fitted circle was laid out from, which a zoom lays the same circle out from. */
  private layoutInputs: Omit<CircleLayoutOptions, 'corner' | 'zoom'> & { names: boolean } | null = null
  /** The view the picture's geometry is of: the layout, the zoom and the offset. */
  private viewKey = ''
  /** The angles of the rings in a zoomed view, in the circle's turn; `null` fitted. */
  private viewWindows: Array<[number, number]> | null = null
  private press: Press | null = null
  /** Every pointer down on the picture, for a pinch. */
  private readonly pointers = new Map<number, { x: number; y: number }>()
  private pinch: { distance: number; x: number; y: number } | null = null
  /** A click waiting out the double-click window, which a second press calls off. */
  private clickTimer: ReturnType<typeof setTimeout> | null = null
  /** Where and when the last click was let go, which a second within the window doubles. */
  private lastClick: { x: number; y: number; time: number } | null = null
  /**
   * Where the pointer was when the view moved under it: the card and the
   * crosshair are asked again of the next frame, which is the first drawn at
   * the new view.
   */
  private rehover: { x: number; y: number } | null = null
  private settleTimer: ReturnType<typeof setTimeout> | null = null
  private detail: Detail | null = null
  /** Where each ring's name is written, which is its grip. */
  private nameBoxes: Array<{ id: string; x0: number; y0: number; x1: number; y1: number }> = []
  /** The ring whose grip the pointer is over, drawn lit. */
  private gripHover: string | null = null
  /**
   * A ring made thicker or thinner by its foot — its inner edge, the one a
   * thicker ring moves, as a lane's is its far border (§7.6). Held here while
   * the hand is down, as a ring carried is, and written to the track's height
   * once it lets go; Escape puts the height back.
   */
  private resize: {
    id: string
    pointer: number
    x: number
    y: number
    /** How far from the middle the press was, which the drag is measured from. */
    r0: number
    /** How far the rings were squeezed into their room at the press (`ringScale`). */
    scale: number
    /** The track's height when the press began. */
    from: number
    size: number
    moved: boolean
  } | null = null
  /** The ring whose foot the pointer is on, its edge ruled in the crosshair's blue. */
  private edgeHover: string | null = null
  private size = { width: 0, height: 0 }
  private frame = 0
  private layoutKey = ''
  /** Where the key is drawn: beside the circle, or in the corner it leaves clear. */
  private keyAt: { x: number; y: number } | null = null
  private readonly observer: ResizeObserver | null
  private readonly unsubscribe: Array<() => void> = []

  constructor(private readonly options: CircleViewOptions) {
    // Focusable, for the map's keys: the arrows pan, Page Up and Page Down
    // zoom, Home fits.
    this.canvas = el('canvas', { class: 'circle-canvas', attrs: { tabindex: '0' } })
    this.tip = el('div', { class: 'cell-tip circle-tip hidden' })
    // Under the picture's corner, as the map's reframe hint is: the gestures
    // nothing on screen announces ({@link hintLines}).
    this.hint = el('div', { class: 'circle-hint', attrs: { 'aria-hidden': 'true' } })
    this.guide = el('canvas', { class: 'circle-guide', attrs: { 'aria-hidden': 'true' } })
    this.el = el('div', { class: 'circle-wrap' }, this.canvas, this.guide, this.hint, this.tip)
    this.samples =
      options.client === undefined ? null : new SampleCache(options.client, () => this.schedule())
    this.unsubscribe.push(options.store.subscribe(() => this.schedule()))
    // The overlays and the text size are the reader's, shared with every
    // picture on screen (`ui/plotOptions.ts`, `ui/textScale.ts`); the groups are
    // the file's, shared with every lane. Each change is the next frame's to
    // draw — the names, the key and the font are in its layout's key.
    this.unsubscribe.push(
      subscribePlotOptions(() => {
        this.drawGuide(null)
        if (!getPlotOptions().tooltip) this.tip.classList.add('hidden')
        this.schedule()
      }),
      subscribeTextScale(() => this.schedule()),
      // Inside the sections or outside them, and the names in a column or
      // not: the layout's, in its key.
      subscribeRingPlacement(() => this.schedule()),
      subscribeRingColumn(() => this.schedule()),
      // Whether a circle is on screen, which is whose the name column's key is.
      registerCircle(this.el),
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

  /** The scale the Map card sets, and how many chords. */
  setScale(scale: CircleScale): void {
    if (
      scale.transform === this.scale.transform &&
      scale.colormap === this.scale.colormap &&
      scale.limit === this.scale.limit
    ) {
      return
    }
    this.scale = { ...scale }
    this.chords = null
    this.schedule()
  }

  /** The model drawn, or `null` where the block is not a circle. */
  get circle(): CircleModel | null {
    return this.model
  }

  /** Whether the block in hand can be drawn round at all. */
  get drawable(): boolean {
    return this.model !== null
  }

  /**
   * The rings as the lanes they are — each one's tracks — for the Tracks card's
   * heights while the circle is drawn: they are every track the map draws, a
   * bigWig on a genome × genome block among them, where the square has no lane.
   */
  ringLanes(): Array<{ members: AnnotationEntry[] }> {
    return this.ringSlots().map((slot) => ({ members: [slot.host, ...slot.overlaid] }))
  }

  /**
   * The one height that has every ring fill the room the rings share — what
   * the Tracks card's *stretch* sets while the circle is drawn — or `null`
   * before there is a layout or a ring.
   */
  fillingRingSize(): number | null {
    // The fitted circle's room, whatever the zoom: a lane's height is the same
    // at every zoom, as it is beside a square zoomed in on.
    const geometry = this.fitGeometry
    const count = geometry?.rings.length ?? 0
    if (geometry === null || count === 0) return null
    return Math.max(6, Math.floor(geometry.ringRoom / count))
  }

  /**
   * The two ends of the chords' ramp, in the map's own units — what the key
   * writes under its ramp, and the caption writes whether the key is drawn or
   * not. `null` before the chords are laid out.
   */
  chordRange(): { lo: number; hi: number } | null {
    const chords = this.chords
    if (chords === null || chords.drawn === 0) return null
    return {
      lo: inverseTransform(chords.range.lo, this.scale.transform),
      hi: inverseTransform(chords.range.hi, this.scale.transform),
    }
  }

  /** How many chords the picture draws now, for a caption. */
  chordsDrawn(): number {
    const model = this.model
    if (model === null) return 0
    const limit = this.scale.limit
    return Number.isFinite(limit) ? Math.min(model.chords.length, limit) : model.chords.length
  }

  destroy(): void {
    if (this.frame !== 0) cancelAnimationFrame(this.frame)
    this.frame = 0
    this.cancelClick()
    if (this.settleTimer !== null) clearTimeout(this.settleTimer)
    this.settleTimer = null
    this.observer?.disconnect()
    this.samples?.destroy()
    for (const off of this.unsubscribe) off()
    this.unsubscribe.length = 0
  }

  /** Ask for a frame; several asks in one frame are one draw. */
  schedule(): void {
    if (this.frame !== 0) return
    this.frame = requestAnimationFrame(() => {
      this.frame = 0
      this.draw()
    })
  }

  // -------------------------------------------------------------------------
  // The model, the layout, the rings
  // -------------------------------------------------------------------------

  private rebuild(): void {
    const block = this.block
    const before = this.model
    this.model =
      block === null
        ? null
        : circleModelOf(block, this.options.presentation()?.resolver ?? {}, this.bpPerCell, CHORD_CAP, this.cut)
    this.geometry = null
    this.fitGeometry = null
    this.chords = null
    this.bins = null
    this.index = null
    this.axis = null
    this.held.clear()
    this.detail = null
    this.focus = NO_FOCUS
    // The same sections read again — another balance, another transform —
    // are the same circle, and keep the zoom the reader is in; other sections
    // are another circle, drawn whole.
    if (before === null || this.model === null || !sameSections(before, this.model)) this.resetZoom()
    this.schedule()
  }

  /**
   * A genome × genome block knows its genomes and not their contigs, and the
   * table that does may land after the circle is drawn. Asked again each frame
   * for the sections still without any — a lookup, not a read — so the rings
   * arrive with the table rather than with the next navigation.
   */
  private refreshSequences(): void {
    const model = this.model
    const resolver = this.options.presentation()?.resolver
    if (model === null || resolver === undefined) return
    if (model.units.every((unit) => unit.sequences.length > 0)) return
    const block = this.block
    if (block === null) return
    const fresh = circleModelOf(block, resolver, this.bpPerCell, CHORD_CAP, this.cut)
    if (fresh === null) return
    if (fresh.units.every((unit, u) => unit.sequences.length === model.units[u]?.sequences.length)) return
    this.model = fresh
    this.geometry = null
    this.fitGeometry = null
    this.chords = null
    this.bins = null
    this.index = null
    this.axis = null
    this.held.clear()
    this.detail = null
  }

  /**
   * The rings in the order they are drawn — a drag's while one is held — as
   * the lanes' slots: a track a ring, except that an overlay group's tracks
   * share the first one's ring, as they share its lane beside the map.
   */
  private ringSlots(): RingSlot[] {
    const rows = this.options.store.drawnAnywhereOn(this.options.map).filter(drawsAsRing)
    const groups = this.options.groups
    const slots: RingSlot[] = planStack(rows, {
      groupOf: (entry) => entry.style.group,
      modeOf: (group) => groups?.modeOf(group) ?? 'stacked',
      sizeOf: (entry) => entry.style.size,
      gap: 0,
      minimum: 1,
    }).map((slot) => ({ host: slot.host, overlaid: slot.overlaid }))
    const drag = this.drag
    if (drag === null || !drag.moved) return slots
    const byId = new Map(slots.map((slot) => [slot.host.id, slot]))
    return drag.order.map((id) => byId.get(id)).filter((slot): slot is RingSlot => slot !== undefined)
  }

  /** A ring's track's height: the store's, or the one its foot is being dragged to. */
  private sizeOf(entry: AnnotationEntry): number {
    const resize = this.resize
    return resize !== null && resize.moved && resize.id === entry.id ? resize.size : entry.style.size
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
    this.geometry = null
  }

  /**
   * Everything a frame needs, recomputed only where its inputs moved: the
   * geometry when the size or the rings change, the chords when the geometry
   * or the scale does, the bins with the geometry.
   */
  private prepare(measure: CanvasRenderingContext2D, width: number, height: number): boolean {
    this.refreshSequences()
    const model = this.model
    if (model === null || width <= 0 || height <= 0) return false
    const slots = this.ringSlots()
    const names = getPlotOptions().labels
    const font = scaleFont(LABEL_FONT)
    // The key stands beside the circle where the column is wide enough, and in
    // the corner where it is not — and then the circle leaves the corner clear.
    // Not the hint under it: that shows only while the pointer is over the
    // picture, as the square's does, and a circle shrunk all the time for a line
    // shown some of the time would be paying for it in every name it draws.
    const box = this.keyLayout(measure)
    const full = Math.max(24, Math.min(width, height) / 2 - 6)
    const beside = box !== null && width / 2 + full + KEY_GAP + box.width + KEY_INSET <= width
    this.keyAt =
      box === null
        ? null
        : beside
          ? { x: width / 2 + full + KEY_GAP, y: Math.max(KEY_INSET, height / 2 - full) }
          : { x: width - KEY_INSET - box.width, y: KEY_INSET }
    const corner =
      box === null || beside
        ? undefined
        : { width: box.width + 2 * KEY_INSET, height: box.height + 2 * KEY_INSET }
    const outside = ringPlacement() === 'outside'
    // The rings' names in a column before twelve, the arcs ending short of it
    // — the circle's own `name column`, on unless the reader turned it off,
    // which as the 1D browser's needs the names on at all (§7.6).
    const columned = ringColumn() && getPlotOptions().text && slots.length > 0
    const ringNames = slots.map(ringLabel)
    const key =
      `${width}x${height}|${font}|${names}|${outside ? 'out' : 'in'}|${corner?.width ?? 0}x${corner?.height ?? 0}|` +
      `${columned ? `column:${ringNames.join('\u0001')}` : ''}|` +
      slots.map((slot) => `${slot.host.id}:${this.sizeOf(slot.host)}`).join(',')
    // Under the key, or in its corner where there is no key to stand under.
    if (this.keyAt !== null && box !== null) this.placeHint(this.keyAt.x, this.keyAt.y + box.height, slots.length > 0)
    else this.placeHint(width - KEY_INSET, KEY_INSET - 6, slots.length > 0, true)
    if (this.fitGeometry === null || key !== this.layoutKey) {
      measure.font = font
      this.layoutInputs = {
        width,
        height,
        rings: slots.map((slot) => ({ id: slot.host.id, size: this.sizeOf(slot.host) })),
        measure: (text) => measure.measureText(text).width,
        fontPx: fontPixels(font),
        names,
        outside,
        ...(columned
          ? {
              column: {
                names: ringNames,
                px: fontPixels(scaleFont(RING_NAME_FONT)),
                // In the font the names are written in, and the font the
                // sections' names are measured in put back after.
                measure: (text: string, px: number): number => {
                  const before = measure.font
                  measure.font = `${px.toFixed(1)}px system-ui, sans-serif`
                  const width = measure.measureText(text).width
                  measure.font = before
                  return width
                },
              },
            }
          : {}),
      }
      this.fitGeometry = circleGeometry(model, {
        ...this.layoutInputs,
        ...(corner === undefined ? {} : { corner }),
      })
      this.layoutKey = key
      this.geometry = null
      // A zoom's own bins are angles of the layout they were cut in, and a new
      // layout can move every arc — a first ring widens the gap at twelve.
      // Dropped, they are cut again once the view holds still.
      this.detail = null
      // The bins follow the circle's own size, not the rings': a ring is a
      // band of the same angles whatever its radius.
      const fit = this.fitGeometry
      const count = Math.max(360, Math.min(4096, Math.round(2 * Math.PI * fit.sections.inner)))
      if (this.bins === null || this.bins.count < count * 0.8 || this.bins.count > count * 1.25) {
        this.bins = circleBins(model, fit, count)
        this.held.clear()
      } else {
        // Same count, new angles: the binning is in base pairs and stands; only
        // where each bin is drawn moves with the layout.
        this.bins = circleBins(model, fit, this.bins.count)
      }
      this.index ??= sequenceIndex(model)
      this.axis ??= circleAxis(model)
    }
    // The picture: the fitted circle, or the zoom's (§7.6).
    const view = `${key}|${this.zoom}|${this.offset.x}|${this.offset.y}`
    if (this.geometry === null || view !== this.viewKey) {
      const zoomed = this.layoutAt(this.zoom, this.offset)
      this.geometry = zoomed?.geometry ?? this.fitGeometry
      this.viewWindows = zoomed?.windows ?? null
      this.viewKey = view
      this.chords = null
    }
    this.chords ??= layoutChords(model, this.geometry, this.scale)
    // A zoomed view that moved without a gesture — the box resized, a ring
    // added — has its own bins cut again once it holds still, as a gesture's has.
    if (
      this.zoom > 1 &&
      this.settleTimer === null &&
      (this.viewWindows?.length ?? 0) > 0 &&
      !this.detailCovers()
    ) {
      this.settleTimer = setTimeout(() => this.cutDetail(), SETTLE_MS)
    }
    this.rings = this.ringsOf(slots)
    return true
  }

  /**
   * The circle laid out at a zoom, its middle `offset` from the box's — the
   * sections at `zoom` times the fitted radius, each ring as thick as its lane
   * is tall where the room allows — with the names of what is in view
   * (`namesInView`), and the angles of the rings in view. `null` at 1, which
   * is the fitted circle itself.
   */
  private layoutAt(
    zoom: number,
    offset: { x: number; y: number },
  ): { geometry: CircleGeometry; windows: Array<[number, number]> } | null {
    const model = this.model
    const fit = this.fitGeometry
    const inputs = this.layoutInputs
    if (zoom <= 1 || model === null || fit === null || inputs === null) return null
    const { width, height } = inputs
    const room = fit.outer - fit.labelAt
    const laid = circleGeometry(model, {
      ...inputs,
      zoom: { cx: width / 2 + offset.x, cy: height / 2 + offset.y, rim: fit.labelAt * zoom, labelRoom: room, gap: fit.gap },
    })
    const windows = anglesInView(laid, { x0: 0, y0: 0, x1: width, y1: height })
    const named = namesInView(model, laid, unitsInView(laid, windows), inputs.names)
    return {
      geometry: {
        ...laid,
        labelled: named.labelled,
        groupLabelled: named.groupLabelled,
        names: named.names,
        // A circle that kept no room for names at rest — a thousand genomes,
        // none of them named — writes the ones a zoom brings into view past
        // its rim, where the zoom has made the room: as long as a name could
        // have been at rest, and the rim does not move for them.
        outer: room > 0 || !named.names ? laid.outer : laid.labelAt + Math.max(24, fit.outer * 0.4),
      },
      windows,
    }
  }

  /** Whether the picture is zoomed in on: what a double click, Home and the refit put back. */
  get zoomed(): boolean {
    return this.zoom > 1
  }

  /**
   * How far the picture is zoomed in, and how many of its sections are in
   * view — what a figure of a zoomed view says of itself in its caption;
   * `null` while the whole circle is drawn.
   */
  zoomInView(): { zoom: number; sections: number } | null {
    const geometry = this.geometry
    const windows = this.viewWindows
    if (this.zoom <= 1 || geometry === null || windows === null) return null
    const seen = unitsInView(geometry, windows)
    return { zoom: this.zoom, sections: seen.reduce((sum, on) => sum + on, 0) }
  }

  /** Back to the whole circle, fitted to the box. */
  resetZoom(): void {
    if (this.settleTimer !== null) clearTimeout(this.settleTimer)
    this.settleTimer = null
    this.detail = null
    if (this.zoom === 1 && this.offset.x === 0 && this.offset.y === 0) return
    this.zoom = 1
    this.offset = { x: 0, y: 0 }
    this.schedule()
  }

  /**
   * Zoom by `factor` about a point of the box, keeping what is under it there:
   * the same angle, and the same place in the same layer ({@link carryRadius}).
   * From 1 to {@link CIRCLE_MAX_ZOOM}; at 1 the circle is fitted again.
   */
  private zoomAt(x: number, y: number, factor: number): void {
    const fit = this.fitGeometry
    if (fit === null || !(factor > 0)) return
    // The view as it stands, not as last drawn: a trackpad sends several steps
    // a frame, and each is anchored in the view the one before it left.
    const from = this.layoutAt(this.zoom, this.offset)?.geometry ?? fit
    const zoom = Math.max(1, Math.min(CIRCLE_MAX_ZOOM, this.zoom * factor))
    if (zoom === this.zoom) return
    if (zoom <= 1) {
      this.resetZoom()
      return
    }
    // The radii depend on the zoom alone, so the layout at the new zoom about
    // any middle says where each layer will be.
    const to = this.layoutAt(zoom, this.offset)?.geometry
    if (to === undefined) return
    const dx = x - from.cx
    const dy = y - from.cy
    const angle = Math.atan2(dy, dx)
    const carried = carryRadius(radialStops(from), radialStops(to), Math.hypot(dx, dy))
    const { width, height } = this.size
    this.zoom = zoom
    this.setOffset({
      x: x - Math.cos(angle) * carried - width / 2,
      y: y - Math.sin(angle) * carried - height / 2,
    })
  }

  /** Slide the zoomed picture by this many pixels; a fitted circle does not move. */
  private panBy(dx: number, dy: number): void {
    if (this.zoom <= 1) return
    this.setOffset({ x: this.offset.x + dx, y: this.offset.y + dy })
  }

  /**
   * Put the circle's middle `offset` from the box's, held where the box's
   * middle is still on the circle — and nearer the fit the nearer the zoom is
   * to 1, so a zoom out comes back to the fitted circle rather than to a
   * corner of it.
   */
  private setOffset(offset: { x: number; y: number }): void {
    const fit = this.fitGeometry
    if (fit === null) return
    const reach = fit.labelAt * this.zoom * Math.min(1, (this.zoom - 1) / 0.25)
    const d = Math.hypot(offset.x, offset.y)
    this.offset = d <= reach || d === 0 ? offset : { x: (offset.x * reach) / d, y: (offset.y * reach) / d }
    this.viewChanged()
  }

  /** The view moved: draw it, and cut its own bins once it holds still. */
  private viewChanged(): void {
    this.schedule()
    if (this.settleTimer !== null) clearTimeout(this.settleTimer)
    this.settleTimer = this.zoom > 1 ? setTimeout(() => this.cutDetail(), SETTLE_MS) : null
    if (this.zoom <= 1) this.detail = null
  }

  /**
   * A zoomed picture's own bins, as fine as the screen across the rings in
   * view ({@link Detail}); their numbers are read as they are drawn.
   */
  private cutDetail(): void {
    this.settleTimer = null
    const model = this.model
    const geometry = this.geometry
    const { width, height } = this.size
    if (this.zoom <= 1 || model === null || geometry === null || (this.viewWindows?.length ?? 0) === 0) {
      this.detail = null
      return
    }
    // Half a box past each edge, as a lane's read is padded past its window:
    // a pan inside that is drawn as finely as the view it began from.
    const windows = anglesInView(geometry, {
      x0: -width * DETAIL_PAD,
      y0: -height * DETAIL_PAD,
      x1: width * (1 + DETAIL_PAD),
      y1: height * (1 + DETAIL_PAD),
    })
    const bins = windowBins(model, geometry, windows, geometry.sections.inner / BIN_PX)
    this.detail = { key: this.viewKey, windows, bins, contents: new Map() }
    this.schedule()
  }

  /**
   * Whether the zoom's own bins cover the picture on screen: those of this
   * view, or of one the view has moved within — a zoom further in, a pan that
   * stays inside — whose bins are still where they were, only fewer to the
   * pixel. Otherwise the rings are drawn from the whole circle's until the view
   * holds still.
   */
  private detailCovers(): boolean {
    const detail = this.detail
    const windows = this.viewWindows
    if (detail === null || this.zoom <= 1 || windows === null) return false
    if (detail.key === this.viewKey) return true
    return windows.every(([a, b]) => detail.windows.some(([c, d]) => c <= a + 1e-9 && b <= d + 1e-9))
  }

  /**
   * The rings' tracks with their numbers binned and their axes resolved — a
   * group's over every ring that holds one of its tracks, as a group's lanes
   * share one beside the map (`resolveGroupExtents`), unless the group is set
   * to scale each of its tracks on its own.
   */
  private ringsOf(slots: readonly RingSlot[]): RingDrawn[] {
    const whole = this.bins
    if (whole === null) return []
    const detail = this.detailCovers() ? this.detail : null
    const built = slots.map((slot) => ({
      slot,
      members: [slot.host, ...slot.overlaid].map((entry) => {
        // The zoom's own numbers where it has them, the whole circle's until then.
        const fine = detail === null ? null : this.detailContentOf(entry, detail)
        return fine !== null && detail !== null
          ? { entry, content: fine, bins: detail.bins }
          : { entry, content: this.contentOf(entry), bins: whole }
      }),
    }))
    const groups = resolveGroupExtents(
      built.flatMap(({ members }) => members).map(({ entry, content }) => ({
        group: entry.style.group,
        extent: content.kind === 'values' ? content.values.extent : null,
      })),
      (group) => this.options.groups?.scalingOf(group) ?? 'shared',
    )
    return built.map(({ slot, members }) => ({
      id: slot.host.id,
      // An overlay group's ring is named by the group, as the reader named
      // it; the tooltip names each of its tracks beside its value.
      label: ringLabel(slot),
      members: members.map(({ entry, content, bins }) => ({
        id: entry.id,
        label: entry.label,
        colour: entry.style.colour,
        bins,
        // Overlaid tracks are translucent by necessity, as in their lane: two
        // opaque areas in one band hide each other.
        opacity: members.length > 1 ? entry.style.opacity * OVERLAY_DIM : entry.style.opacity,
        content:
          content.kind === 'values'
            ? this.valuesContent(entry, content.values, undefined, extentFor(entry, content.values.extent, groups))
            : content,
      })),
    }))
  }

  /**
   * A track's numbers in a zoom's own bins, kept with them: a signal read
   * again for the stretch of the circle the bins cover at the screen's
   * resolution — a request of its own beside the whole circle's, so neither
   * evicts the other, and one a stretch where the view shows several: either
   * side of twelve o'clock is either end of the circle's axis — and a column
   * of the file put in the finer bins. `null` while a read is on its way, and
   * for a feature, whose arcs need no bins.
   */
  private detailContentOf(entry: AnnotationEntry, detail: Detail): RingContent | null {
    const model = this.model
    const index = this.index
    if (model === null || index === null) return null
    const held = detail.contents.get(entry.id)
    const keep = (from: readonly unknown[], content: RingContent): RingContent | null => {
      if (content.kind === 'empty') return null
      detail.contents.set(entry.id, { from, content })
      return content
    }
    if (SIGNAL_KINDS.has(entry.kind)) {
      const axis = this.axis
      const stretches = this.detailStretches(detail)
      if (axis === null || this.samples === null || stretches.length === 0) return null
      const sets: TrackSampleSet[] = []
      for (const [k, stretch] of stretches.entries()) {
        const samples = this.samples.samplesFor({
          entry: entry.id,
          scope: `circle-detail-${k}`,
          axis,
          domain: stretch.domain,
          pixels: stretch.pixels,
          ...(entry.derivedFrom === undefined ? {} : { derived: entry.derivedFrom }),
          ...(entry.style.reads === undefined ? {} : { reads: entry.style.reads }),
        })
        // What is held may be another view's, until this one's lands.
        if (samples === null || !samplesCover(samples, axis, stretch.domain)) return null
        sets.push(samples)
      }
      if (held !== undefined && sameList(held.from, sets)) return held.content
      const samples = joinSamples(sets)
      return keep(sets, this.valuesContent(entry, binSamples(samples, detail.bins, index), samples.note))
    }
    if (META_KINDS.has(entry.kind)) {
      const metadata = this.options.metadata
      if (metadata === undefined) return null
      const revision = [metadata.revision()]
      if (held !== undefined && sameList(held.from, revision)) return held.content
      const cells = metadata.cellsFor(entry, sequenceBlock(model))
      if (cells === null) return null
      const binned = binCells(cells, model, detail.bins)
      return keep(
        revision,
        binned.kind === 'qualitative'
          ? { kind: 'classes', classes: binned as BinnedClasses }
          : this.valuesContent(entry, binned as BinnedValues),
      )
    }
    return null
  }

  /**
   * The stretches of the circle's axis — its sequences end to end, in circle
   * order — that a zoom's bins in view cover, each with how many bins it
   * spans: one, or more where the view straddles twelve o'clock or shows two
   * sides of the circle. None where they would be more than half the axis,
   * which the whole circle's numbers draw nearly as finely.
   */
  private detailStretches(detail: Detail): Array<{ domain: [number, number]; pixels: number }> {
    const model = this.model
    if (model === null) return []
    const starts: number[] = []
    let at = 0
    for (const unit of model.units) {
      starts.push(at)
      for (const sequence of unit.sequences) at += Math.max(0, sequence.length)
    }
    const total = at
    const bins = detail.bins
    const out: Array<{ domain: [number, number]; pixels: number }> = []
    for (const [w0, w1] of detail.windows) {
      let lo = Number.POSITIVE_INFINITY
      let hi = Number.NEGATIVE_INFINITY
      let pixels = 0
      for (let bin = 0; bin < bins.count; bin++) {
        if (!(bins.a0[bin] < w1 && bins.a1[bin] > w0)) continue
        const u = bins.unit[bin]
        lo = Math.min(lo, starts[u] + bins.from[bin])
        hi = Math.max(hi, starts[u] + bins.to[bin])
        pixels++
      }
      if (!(hi > lo)) continue
      const last = out[out.length - 1]
      if (last !== undefined && lo <= last.domain[1]) {
        last.domain[1] = Math.max(last.domain[1], hi)
        last.pixels += pixels
      } else {
        out.push({ domain: [lo, hi], pixels })
      }
    }
    const span = out.reduce((sum, stretch) => sum + stretch.domain[1] - stretch.domain[0], 0)
    return out.length > DETAIL_STRETCHES || span > total / 2 ? [] : out
  }

  private contentOf(entry: AnnotationEntry): RingContent {
    const model = this.model
    const bins = this.bins
    const index = this.index
    // The fitted circle's: a zoom moves the radii and not the angles, so the
    // whole circle's bins and a feature's arc are the same under any zoom.
    const geometry = this.fitGeometry
    if (model === null || bins === null || index === null || geometry === null) {
      return { kind: 'empty', note: '' }
    }
    if (model.units.every((unit) => unit.sequences.length === 0)) {
      return { kind: 'empty', note: 'The contigs of these genomes are still being read.' }
    }
    if (SIGNAL_KINDS.has(entry.kind)) {
      const axis = this.axis
      if (axis === null || this.samples === null) return { kind: 'empty', note: '' }
      const samples = this.samples.samplesFor({
        entry: entry.id,
        scope: 'circle',
        axis,
        domain: [0, axis.unitEnd],
        pixels: bins.count,
        ...(entry.derivedFrom === undefined ? {} : { derived: entry.derivedFrom }),
        ...(entry.style.reads === undefined ? {} : { reads: entry.style.reads }),
      })
      if (samples === null) return { kind: 'empty', note: 'reading…' }
      const held = this.held.get(entry.id)
      let values: BinnedValues
      if (held !== undefined && held.key === samples && held.content.kind === 'values') {
        values = held.content.values
      } else {
        values = binSamples(samples, bins, index)
      }
      const content = this.valuesContent(entry, values, samples.note)
      this.held.set(entry.id, { key: samples, content })
      return content
    }
    if (META_KINDS.has(entry.kind)) {
      const metadata = this.options.metadata
      if (metadata === undefined) return { kind: 'empty', note: '' }
      const key = `${metadata.revision()}`
      const held = this.held.get(entry.id)
      if (held !== undefined && held.key === key && held.content.kind !== 'empty') {
        return held.content.kind === 'values' ? this.valuesContent(entry, held.content.values) : held.content
      }
      const cells = metadata.cellsFor(entry, sequenceBlock(model))
      if (cells === null) {
        return {
          kind: 'empty',
          note:
            entry.source.kind === 'metadata' && entry.source.table === 'bins'
              ? 'A column of /bins is drawn beside a map, where a cell is a bin.'
              : 'reading…',
        }
      }
      const binned = binCells(cells, model, bins)
      const content: RingContent =
        binned.kind === 'qualitative'
          ? { kind: 'classes', classes: binned as BinnedClasses }
          : this.valuesContent(entry, binned as BinnedValues)
      this.held.set(entry.id, { key, content })
      return content
    }
    if (FEATURE_KINDS.has(entry.kind) && entry.payload?.kind === 'features') {
      const set = entry.payload.data
      const held = this.held.get(entry.id)
      const key = { set, geometry }
      if (held !== undefined && sameKey(held.key, key)) return held.content
      const content: RingContent = { kind: 'features', arcs: featureArcs(set, model, geometry, index) }
      this.held.set(entry.id, { key, content })
      return content
    }
    return { kind: 'empty', note: '' }
  }

  /** A row's numbers with its limits and look resolved, against its own extent or its group's. */
  private valuesContent(
    entry: AnnotationEntry,
    values: BinnedValues,
    note?: string,
    extent: BinnedValues['extent'] = values.extent,
  ): RingContent {
    const limits = resolveLimits(entry.style.limits, extent)
    if (values.extent === null && note !== undefined && note !== '') return { kind: 'empty', note }
    return {
      kind: 'values',
      values,
      limits,
      mode: entry.style.mode,
      colormap: colormapOf(entry.style, limits),
      flip: entry.style.flip === true,
    }
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
    if (!this.prepare(ctx, width, height)) return
    this.paint(ctx, readCirclePalette(this.canvas), true)
    this.describeGeometry()
    const at = this.rehover
    this.rehover = null
    if (at !== null && this.drag === null && this.press?.panning !== true) this.hover(at)
  }

  /**
   * Where everything is, on the canvas's own dataset — read by the galleries to
   * aim at a ring or a section, as the edit stage publishes its view, and by
   * nothing in the app.
   */
  private describeGeometry(): void {
    const geometry = this.geometry
    const model = this.model
    if (geometry === null || model === null) return
    const round = (value: number): number => Math.round(value * 10) / 10
    const names = new Map(this.rings.map((ring) => [ring.id, ring.label]))
    const groupArcs = geometry.groupArcs
    // The three strongest chords drawn, each with the middle of its ribbon —
    // halfway along the curve through the bend — which is where it is aimed at.
    const strongest: Array<{ a: string; b: string; x: number; y: number }> = []
    const chords = this.chords
    if (chords !== null) {
      for (let slot = chords.drawn - 1; slot >= Math.max(0, chords.drawn - 3); slot--) {
        const chord = model.chords[chords.order[slot]]
        const aMid = chords.ends[slot * 4]
        const bMid = chords.ends[slot * 4 + 2]
        const r = geometry.chord
        const bend = chordBend(geometry.cx, geometry.cy, r, aMid, bMid)
        strongest.push({
          a: model.units[chord.a].name,
          b: model.units[chord.b].name,
          x: round(0.25 * (geometry.cx + Math.cos(aMid) * r) + 0.5 * bend.x + 0.25 * (geometry.cx + Math.cos(bMid) * r)),
          y: round(0.25 * (geometry.cy + Math.sin(aMid) * r) + 0.5 * bend.y + 0.25 * (geometry.cy + Math.sin(bMid) * r)),
        })
      }
    }
    const detail = this.detailCovers() ? this.detail : null
    this.canvas.dataset.geometry = JSON.stringify({
      zoom: Math.round(this.zoom * 1000) / 1000,
      offset: { x: round(this.offset.x), y: round(this.offset.y) },
      // The angles in view, zoomed, and the zoom's own bins where they are drawn.
      windows: this.viewWindows?.map(([a, b]) => [Math.round(a * 1e4) / 1e4, Math.round(b * 1e4) / 1e4]) ?? null,
      detail: detail === null ? null : { bins: detail.bins.count, tracks: detail.contents.size },
      outer: round(geometry.outer),
      outside: geometry.outside,
      topGap: Math.round(geometry.topGap * 1e4) / 1e4,
      gap: [Math.round(geometry.gap.from * 1e4) / 1e4, Math.round(geometry.gap.to * 1e4) / 1e4],
      column: geometry.column,
      grips: this.nameBoxes.map((box) => ({
        id: box.id,
        x: round((box.x0 + box.x1) / 2),
        y: round((box.y0 + box.y1) / 2),
      })),
      labelled: geometry.labelled.reduce((sum, on) => sum + on, 0),
      cx: round(geometry.cx),
      cy: round(geometry.cy),
      sections: [round(geometry.sections.inner), round(geometry.sections.outer)],
      band: geometry.band === null ? null : [round(geometry.band.inner), round(geometry.band.outer)],
      groups:
        model.groups === null || groupArcs === null
          ? null
          : model.groups.map((group, g) => ({
              name: group.name,
              mid: round(((groupArcs[2 * g] + groupArcs[2 * g + 1]) / 2) * 1000) / 1000,
            })),
      chord: round(geometry.chord),
      labelAt: round(geometry.labelAt),
      names: geometry.names,
      fontPx: geometry.fontPx,
      rings: geometry.rings.map((ring) => ({
        id: ring.id,
        name: names.get(ring.id) ?? ring.id,
        inner: round(ring.inner),
        outer: round(ring.outer),
      })),
      units: model.units.map((unit, u) => ({
        name: unit.name,
        mid: round((geometry.arcs[2 * u] + geometry.arcs[2 * u + 1]) / 2 * 1000) / 1000,
      })),
      chords: this.chords?.drawn ?? 0,
      pairs: model.pairs,
      // Of the chords drawn, how many join two sections of one genome — a
      // contig circle's within-bin links, which the log of a gallery prints.
      withinGenome: model.groups === null ? null : this.chordsWithinGenome(),
      strongest,
    })
  }

  private chordsWithinGenome(): number {
    const model = this.model
    const chords = this.chords
    if (model === null || chords === null) return 0
    let within = 0
    for (let slot = 0; slot < chords.drawn; slot++) {
      const chord = model.chords[chords.order[slot]]
      const a = model.units[chord.a].genome
      if (a !== undefined && a === model.units[chord.b].genome) within++
    }
    return within
  }

  /**
   * The whole picture into a context already scaled to CSS pixels: rings,
   * chords, sections, names, the rings' names and the key.
   *
   * The screen and the figure both come through here, which is what keeps
   * them one picture. `live` is the screen's: the hover and a ring in the hand
   * are drawn there and never into a file.
   */
  private paint(ctx: CanvasRenderingContext2D, palette: CirclePalette, live: boolean): void {
    const model = this.model
    const geometry = this.geometry
    const chords = this.chords
    const bins = this.bins
    if (model === null || geometry === null || chords === null || bins === null) return
    const focus = live ? this.focus : NO_FOCUS
    const lit = focus.unit >= 0 || focus.slot >= 0 || focus.group >= 0
    const options = getPlotOptions()
    const ink: RingInk = {
      guide: palette.text,
      fills: options.fills,
      outline: options.outline,
      baseline: options.baseline,
    }
    this.rings.forEach((ring, k) => {
      const band = geometry.rings[k]
      if (band === undefined) return
      const dim = lit && !this.isHeld(ring.id)
      // The band's wash under the first track, and an overlaid track over it,
      // each in its own bins: the whole circle's, or a zoom's own.
      ring.members.forEach((member, m) => {
        paintRing(ctx, member, band, geometry, member.bins, m === 0 ? palette.wash : null, ink, dim)
      })
    })
    paintChords(ctx, { model, geometry, chords, colormap: this.scale.colormap, focus })
    const sections = {
      model,
      geometry,
      palette,
      focus,
      chords,
      colormap: this.scale.colormap,
      transform: this.scale.transform,
    }
    paintSections(ctx, sections)
    paintLabels(ctx, { ...sections, font: scaleFont(LABEL_FONT), boldFont: scaleFont(LABEL_BOLD) })
    if (live && this.drag === null && this.gripHover !== null) this.paintGrip(ctx, geometry, palette)
    if (live && this.drag === null) this.paintEdge(ctx, geometry)
    this.paintRingNames(ctx, geometry, palette, live)
    this.paintKey(ctx, chords, palette)
    if (live && this.drag?.moved === true) this.paintHeld(ctx, geometry, palette)
  }

  /**
   * The hint under the key, saying the gestures this picture has: rings only
   * where there are rings to drag, and their grip as it is drawn.
   */
  private placeHint(left: number, top: number, rings: boolean, fromRight = false): void {
    // Under the key, its left edge on the key's and no wider than the room to
    // the right edge — the sentence is longer than the key, and wraps rather
    // than runs off. With no key, its right edge on the corner's.
    this.hint.style.transform = fromRight
      ? `translate(${Math.round(left)}px, ${Math.round(top + 6)}px) translateX(-100%)`
      : `translate(${Math.round(left)}px, ${Math.round(top + 6)}px)`
    this.hint.style.maxWidth = fromRight
      ? `${Math.max(0, Math.min(240, Math.floor(left - KEY_INSET)))}px`
      : `${Math.max(0, Math.floor(this.size.width - left - KEY_INSET))}px`
    this.hint.style.textAlign = fromRight ? 'right' : ''
    const lines = hintLines(this.zoom > 1, rings, getPlotOptions().text)
    const text = lines.join('\n')
    if (this.hint.dataset.text !== text) {
      this.hint.dataset.text = text
      this.hint.replaceChildren(...lines.map((line) => el('div', { text: line })))
    }
  }

  private isHeld(id: string): boolean {
    return this.drag?.moved === true && this.drag.id === id
  }

  /**
   * Each ring's name, where the rings cross twelve o'clock.
   *
   * That is the one place round the circle that is nobody's: the gap the
   * sections leave open at the top runs in through every ring, and a name
   * written there labels its ring without a key to match it against — and is
   * the ring's handle, as a lane's name is its own (§7.6): the rest of the
   * picture is for panning. Where each is written is kept, on screen, for
   * {@link gripAt}.
   */
  private paintRingNames(
    ctx: CanvasRenderingContext2D,
    geometry: CircleGeometry,
    palette: CirclePalette,
    live: boolean,
  ): void {
    if (live) this.nameBoxes = []
    // The Tracks card's `track text`, which is every track's name wherever it
    // is drawn: off, the rings are ink alone.
    if (this.rings.length === 0 || !getPlotOptions().text) return
    ctx.save()
    // In the column, right-aligned on twelve o'clock where the tracks start, as
    // the 1D browser's names end where its tracks begin — the arcs ending short
    // of the names, so no track is drawn under one; without it, centred over
    // the opening just before twelve and the ends of the tracks either side.
    const column = geometry.column
    ctx.textAlign = column ? 'right' : 'center'
    ctx.textBaseline = 'middle'
    ctx.lineJoin = 'round'
    const wanted = fontPixels(scaleFont(RING_NAME_FONT))
    this.rings.forEach((ring, k) => {
      const band = geometry.rings[k]
      if (band === undefined) return
      const px = ringNamePx(wanted, band)
      if (px === null) return
      const held = this.isHeld(ring.id)
      const lit = live && !held && this.drag === null && this.gripHover === ring.id
      ctx.font = `${held || lit ? '600 ' : ''}${px.toFixed(1)}px system-ui, sans-serif`
      const { x, y } = ringNameAt(geometry, band)
      // A name longer than the column may be loses its middle, as a section's
      // name does — the column was measured to the same length.
      const text = column ? fitText(ctx, ring.label, geometry.outer * COLUMN_MAX) : ring.label
      ctx.lineWidth = 3
      ctx.strokeStyle = palette.halo
      ctx.strokeText(text, x, y)
      // In the text's own ink in the column, where nothing is under a name; dim
      // over the ends of the tracks without it.
      ctx.fillStyle = held ? palette.accent : lit || column ? palette.text : palette.dim
      ctx.fillText(text, x, y)
      if (live) {
        const width = ctx.measureText(text).width
        const left = column ? x - width : x - width / 2
        this.nameBoxes.push({ id: ring.id, x0: left - 3, y0: y - px / 2 - 2, x1: left + width + 3, y1: y + px / 2 + 2 })
      }
    })
    ctx.restore()
  }

  /**
   * The ring whose handle the pointer is over, edged faintly in the accent the
   * held ring is edged in: this is the one a drag would carry.
   */
  private paintGrip(ctx: CanvasRenderingContext2D, geometry: CircleGeometry, palette: CirclePalette): void {
    const at = this.rings.findIndex((ring) => ring.id === this.gripHover)
    const band = geometry.rings[at]
    if (band === undefined) return
    ctx.save()
    ctx.strokeStyle = palette.accent
    ctx.globalAlpha = 0.45
    ctx.lineWidth = 1
    for (const r of [band.inner - 1.5, band.outer + 1.5]) {
      ctx.beginPath()
      ctx.moveTo(geometry.cx + Math.cos(TOP) * r, geometry.cy + Math.sin(TOP) * r)
      arcCurve(ctx, geometry.cx, geometry.cy, r, TOP, TOP + Math.PI * 2)
      ctx.stroke()
    }
    ctx.restore()
  }

  /**
   * The foot of the ring under the pointer, or of the one being resized: a
   * rule round the circle in the crosshair's blue, two pixels wide, in the gap
   * just inside the ring — the 1D browser's rule under a lane's border, bent
   * round. The cursor says the edge can be dragged; the rule says whose it is.
   */
  private paintEdge(ctx: CanvasRenderingContext2D, geometry: CircleGeometry): void {
    const id = this.resize?.moved === true ? this.resize.id : this.edgeHover
    const band = id === null ? undefined : geometry.rings.find((ring) => ring.id === id)
    if (band === undefined) return
    const r = Math.max(1, band.inner - 1)
    ctx.save()
    ctx.strokeStyle = CROSSHAIR_COLOR
    ctx.lineWidth = 2
    ctx.beginPath()
    ctx.moveTo(geometry.cx + Math.cos(TOP) * r, geometry.cy + Math.sin(TOP) * r)
    arcCurve(ctx, geometry.cx, geometry.cy, r, TOP, TOP + Math.PI * 2)
    ctx.stroke()
    ctx.restore()
  }

  /** The held ring's two edges, in the accent: what the hand has hold of. */
  private paintHeld(ctx: CanvasRenderingContext2D, geometry: CircleGeometry, palette: CirclePalette): void {
    const at = this.rings.findIndex((ring) => this.isHeld(ring.id))
    const band = geometry.rings[at]
    if (band === undefined) return
    ctx.save()
    ctx.strokeStyle = palette.accent
    ctx.lineWidth = 1.5
    for (const r of [band.inner - 1.5, band.outer + 1.5]) {
      ctx.beginPath()
      ctx.moveTo(geometry.cx + Math.cos(TOP) * r, geometry.cy + Math.sin(TOP) * r)
      arcCurve(ctx, geometry.cx, geometry.cy, r, TOP, TOP + Math.PI * 2)
      ctx.stroke()
    }
    ctx.restore()
  }

  /**
   * The chords' key, in the top-right corner where the map's key is: what the
   * colour means, the two ends of the ramp in the map's own units, and how many
   * chords are drawn of how many pairs share contacts.
   */
  private paintKey(ctx: CanvasRenderingContext2D, chords: ChordLayout, palette: CirclePalette): void {
    const key = this.keyLayout(ctx)
    const at = this.keyAt
    if (key === null || at === null) return
    ctx.save()
    const x = at.x
    let y = at.y
    if (this.zoom > 1) {
      // Zoomed, the circle runs under the key: a card beneath it, so the ramp
      // and its numbers are read against the page and not against the chords.
      const pad = 6
      ctx.globalAlpha = 0.92
      ctx.fillStyle = palette.halo
      ctx.beginPath()
      roundedBox(ctx, x - pad, y - pad, key.width + 2 * pad, key.height + 2 * pad, 4)
      ctx.fill()
      ctx.globalAlpha = 0.3
      ctx.strokeStyle = palette.dim
      ctx.lineWidth = 0.75
      ctx.stroke()
      ctx.globalAlpha = 1
    }
    ctx.textAlign = 'left'
    ctx.textBaseline = 'top'
    ctx.fillStyle = palette.text
    ctx.font = key.titleFont
    ctx.fillText(key.title, x, y)
    y += key.titlePx + 5
    const steps = 48
    for (let k = 0; k < steps; k++) {
      ctx.fillStyle = chordColour(this.scale.colormap, k / (steps - 1))
      ctx.fillRect(x + (key.barWidth * k) / steps, y, key.barWidth / steps + 0.5, KEY_BAR)
    }
    y += KEY_BAR + 3
    ctx.font = key.font
    ctx.fillStyle = palette.dim
    const lo = inverseTransform(chords.range.lo, this.scale.transform)
    const hi = inverseTransform(chords.range.hi, this.scale.transform)
    ctx.fillText(formatCount(lo), x, y)
    ctx.textAlign = 'right'
    ctx.fillText(formatCount(hi), x + key.barWidth, y)
    ctx.textAlign = 'left'
    y += key.px + 4
    ctx.fillText(key.count, x, y)
    ctx.restore()
  }

  /**
   * The key's words and its box, measured before anything is laid out: the
   * circle is sized to leave the box clear, and the box depends only on the
   * words — what the numbers are, and how many chords of how many.
   */
  private keyLayout(ctx: CanvasRenderingContext2D): {
    title: string
    count: string
    titleFont: string
    font: string
    titlePx: number
    px: number
    barWidth: number
    width: number
    height: number
  } | null {
    const model = this.model
    const drawn = this.chordsDrawn()
    // The Map card's `legend`, which is the square's key: off, the circle has
    // none, on screen or in a figure, and the corner it kept is the circle's.
    if (model === null || drawn === 0 || !getPlotOptions().legend) return null
    const titleFont = scaleFont(KEY_TITLE_FONT)
    const font = scaleFont(KEY_FONT)
    const title = this.options.keyTitle()
    // How many of how many, and the select beside the card says which: the
    // strongest.
    const count =
      drawn >= model.pairs
        ? `${fmt.int(drawn)} ${drawn === 1 ? 'chord' : 'chords'}`
        : `${fmt.int(drawn)} of ${fmt.int(model.pairs)} chords`
    ctx.save()
    ctx.font = titleFont
    const titleWidth = ctx.measureText(title).width
    ctx.font = font
    const countWidth = ctx.measureText(count).width
    ctx.restore()
    const barWidth = Math.max(96, Math.min(150, titleWidth))
    const titlePx = fontPixels(titleFont)
    const px = fontPixels(font)
    return {
      title,
      count,
      titleFont,
      font,
      titlePx,
      px,
      barWidth,
      width: Math.max(barWidth, titleWidth, countWidth),
      height: titlePx + 5 + KEY_BAR + 3 + px + 4 + px,
    }
  }

  /**
   * The picture for a figure: its size, and a painter that draws it at a scale
   * from the context's origin — onto a canvas for a PNG, a vector page for a PDF.
   */
  figure(): { width: number; height: number; paint(ctx: CanvasRenderingContext2D, scale: number): void } | null {
    const { width, height } = this.size
    const geometry = this.geometry
    if (this.model === null || geometry === null || width <= 0 || height <= 0) return null
    if (this.zoom > 1) {
      // Zoomed, the figure is the view: the box, and as much of the circle as
      // is in it, cut at its edges as the screen cuts it.
      return {
        width,
        height,
        paint: (ctx, scale) => {
          ctx.save()
          ctx.setTransform(scale, 0, 0, scale, 0, 0)
          ctx.beginPath()
          ctx.rect(0, 0, width, height)
          ctx.clip()
          if (this.prepare(ctx, width, height)) this.paint(ctx, readCirclePalette(this.canvas), false)
          ctx.restore()
        },
      }
    }
    // Cropped to the circle and its key: the column's width is the screen's
    // business, and a figure of a circle in a strip of paper is not a figure.
    const measure = this.canvas.getContext('2d')
    const key = measure === null ? null : this.keyLayout(measure)
    const at = this.keyAt
    const pad = 8
    let left = geometry.cx - geometry.outer - pad
    let right = geometry.cx + geometry.outer + pad
    let top = geometry.cy - geometry.outer - pad
    let bottom = geometry.cy + geometry.outer + pad
    if (key !== null && at !== null) {
      left = Math.min(left, at.x - pad)
      right = Math.max(right, at.x + key.width + pad)
      top = Math.min(top, at.y - pad)
      bottom = Math.max(bottom, at.y + key.height + pad)
    }
    left = Math.max(0, Math.floor(left))
    top = Math.max(0, Math.floor(top))
    right = Math.min(width, Math.ceil(right))
    bottom = Math.min(height, Math.ceil(bottom))
    return {
      width: right - left,
      height: bottom - top,
      paint: (ctx, scale) => {
        ctx.save()
        ctx.setTransform(scale, 0, 0, scale, -left * scale, -top * scale)
        if (this.prepare(ctx, width, height)) this.paint(ctx, readCirclePalette(this.canvas), false)
        ctx.restore()
      },
    }
  }

  /**
   * The crosshair, the circle's way: a radial line through every ring and
   * section at the pointer's angle — the square's guide line through the lanes,
   * bent round (§7.6). Over the chord disc there is none, since a chord under
   * the hand is lit whole. On a canvas of its own over the picture, so
   * following the hand costs one line and not a frame of rings and chords.
   */
  private drawGuide(at: { x: number; y: number } | null): void {
    const canvas = this.guide
    const ctx = canvas.getContext('2d')
    if (ctx === null) return
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.clearRect(0, 0, canvas.width, canvas.height)
    const geometry = this.geometry
    const held = this.drag !== null || this.resize?.moved === true
    if (at === null || geometry === null || held || !getPlotOptions().crosshair) return
    const dx = at.x - geometry.cx
    const dy = at.y - geometry.cy
    const r = Math.hypot(dx, dy)
    if (r < geometry.chord || r > geometry.outer) return
    const angle = Math.atan2(dy, dx)
    // Through every layer to the outermost: the sections or their band, or
    // the last ring where the rings are outside them.
    const reach = Math.max(
      geometry.band?.outer ?? 0,
      geometry.sections.outer,
      ...geometry.rings.map((ring) => ring.outer),
    )
    const dpr = canvas.width / Math.max(1, this.size.width)
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.strokeStyle = CROSSHAIR_COLOR
    ctx.lineWidth = Math.max(1 / dpr, 0.75)
    ctx.beginPath()
    ctx.moveTo(geometry.cx + Math.cos(angle) * geometry.chord, geometry.cy + Math.sin(angle) * geometry.chord)
    ctx.lineTo(geometry.cx + Math.cos(angle) * reach, geometry.cy + Math.sin(angle) * reach)
    ctx.stroke()
  }

  // -------------------------------------------------------------------------
  // The pointer
  // -------------------------------------------------------------------------

  /**
   * The map's gestures, bent round (§7.6): the wheel zooms about the pointer
   * and a pinch about the fingers; zoomed, a drag pans, a sideways scroll or ⌘
   * with the wheel slides, and a double click fits the circle again; the keys
   * are the map's. A ring is carried by its handle — its name, or with the
   * names off its stretch of the gap at twelve o'clock — as a lane is by its
   * own, so the rest of the picture is free for the pan. A press that did not
   * travel is a click, held back for the double click's window as the map's
   * is, so the second click of a fit does not land after the first has opened
   * something.
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
      this.pointers.set(event.pointerId, at)
      // Every press is followed to its release, wherever the hand goes: a
      // release missed outside the picture would leave a pointer down here,
      // and the next press would be the second finger of a pinch.
      canvas.setPointerCapture(event.pointerId)
      // The keys are the picture's once it is pressed, as the map's are.
      canvas.focus({ preventScroll: true })
      if (this.pointers.size === 2) {
        // A second finger: a pinch, which calls off what the first began.
        this.pending = null
        this.press = null
        if (this.drag !== null) this.endDrag(false)
        if (this.resize !== null) this.endResize(false)
        this.cancelClick()
        this.pinch = this.pinchNow()
        return
      }
      if (this.pointers.size > 2) return
      const grip = this.gripAt(at)
      if (grip !== null) {
        this.pending = { id: grip, x: at.x, y: at.y, pointer: event.pointerId }
        return
      }
      // A ring's foot, before a pan: the edge is the ring's, as a lane's border
      // is its own beside the map.
      const edge = this.edgeAt(at)
      const slots = this.ringSlots()
      const host = edge === null ? undefined : slots.find((slot) => slot.host.id === edge)?.host
      const geometry = this.geometry
      if (host !== undefined && geometry !== null) {
        const size = host.style.size
        this.resize = {
          id: host.id,
          pointer: event.pointerId,
          x: at.x,
          y: at.y,
          r0: Math.hypot(at.x - geometry.cx, at.y - geometry.cy),
          scale: ringScale(
            slots.map((slot) => slot.host.style.size),
            geometry.ringRoom,
          ),
          from: size,
          size,
          moved: false,
        }
        return
      }
      this.press = { pointer: event.pointerId, x: at.x, y: at.y, offset: { ...this.offset }, panning: false }
    })
    canvas.addEventListener('pointermove', (event) => {
      const at = local(event)
      if (this.pointers.has(event.pointerId)) this.pointers.set(event.pointerId, at)
      if (this.pinch !== null) {
        this.movePinch()
        return
      }
      const resize = this.resize
      if (resize !== null && resize.pointer === event.pointerId) {
        if (!resize.moved && Math.hypot(at.x - resize.x, at.y - resize.y) < DRAG_SLOP) return
        this.moveResize(at)
        return
      }
      const pending = this.pending
      if (pending !== null && this.drag === null && pending.pointer === event.pointerId) {
        if (Math.hypot(at.x - pending.x, at.y - pending.y) >= DRAG_SLOP) this.beginDrag(pending, event)
      }
      if (this.drag !== null) {
        this.moveDrag(at)
        return
      }
      const press = this.press
      if (press !== null && press.pointer === event.pointerId) {
        if (!press.panning && this.zoom > 1 && Math.hypot(at.x - press.x, at.y - press.y) >= DRAG_SLOP) {
          this.beginPan(press, event)
        }
        if (press.panning) {
          this.setOffset({ x: press.offset.x + at.x - press.x, y: press.offset.y + at.y - press.y })
          return
        }
      }
      this.hover(at)
    })
    canvas.addEventListener('pointerleave', () => {
      if (this.drag !== null || this.press?.panning === true || this.pinch !== null || this.resize !== null) return
      this.drawGuide(null)
      this.setFocus(NO_FOCUS)
      this.setGripHover(null)
      this.setEdgeHover(null)
      this.tip.classList.add('hidden')
      canvas.style.cursor = ''
    })
    canvas.addEventListener('pointerup', (event) => {
      const at = local(event)
      const down = this.pointers.delete(event.pointerId)
      if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId)
      if (this.pinch !== null) {
        // The first finger up ends the pinch, and the other's lift is no click.
        this.pinch = null
        return
      }
      const resize = this.resize
      if (resize !== null && resize.pointer === event.pointerId) {
        if (resize.moved) {
          this.endResize(true)
          this.rehover = at
          return
        }
        // A press on a foot that did not travel is a click, as anywhere else.
        this.resize = null
        this.released(at)
        return
      }
      const pending = this.pending
      this.pending = null
      if (this.drag !== null) {
        this.endDrag(true)
        return
      }
      const press = this.press
      this.press = null
      if (press?.panning === true) {
        this.endPan(at)
        return
      }
      if (!down || (press === null && pending === null)) return
      this.released(at)
    })
    const abandon = (event: PointerEvent): void => {
      if (!this.pointers.delete(event.pointerId)) return
      this.pinch = null
      this.pending = null
      if (this.drag !== null) this.endDrag(false)
      if (this.resize !== null) this.endResize(false)
      if (this.press?.panning === true) canvas.style.cursor = ''
      this.press = null
    }
    canvas.addEventListener('pointercancel', abandon)
    // A capture taken away mid-gesture — the picture taken off the page — ends
    // it where it stands; after a release the pointer is already gone.
    canvas.addEventListener('lostpointercapture', abandon)
    canvas.addEventListener(
      'wheel',
      (event) => {
        event.preventDefault()
        const at = local(event)
        // Sideways, the picture slides, as a trackpad's two fingers slide the
        // map; and with ⌘ held, up and down slide too. Never with Ctrl, which
        // is a trackpad's pinch: that zooms.
        if (Math.abs(event.deltaX) > Math.abs(event.deltaY) || (event.metaKey && !event.ctrlKey)) {
          this.panBy(-event.deltaX, -event.deltaY)
          this.rehover = at
          return
        }
        // Exponential in the delta, so a trackpad's many small steps and a
        // wheel's few large ones come to the same zoom; a wheel that counts in
        // lines, a notch's worth a line.
        this.zoomAt(at.x, at.y, Math.exp(-event.deltaY * (event.deltaMode === 1 ? 0.05 : WHEEL_RATE)))
        this.rehover = at
      },
      { passive: false },
    )
    canvas.addEventListener('keydown', (event) => this.onKey(event))
    const onEscape = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      if (this.drag !== null) {
        event.preventDefault()
        this.endDrag(false)
      } else if (this.resize?.moved === true) {
        event.preventDefault()
        this.endResize(false)
      } else if (this.press?.panning === true) {
        // The pan goes back to where it began, as a drag of a ring does.
        event.preventDefault()
        const press = this.press
        this.press = null
        this.setOffset(press.offset)
        canvas.style.cursor = ''
      }
    }
    window.addEventListener('keydown', onEscape)
    this.unsubscribe.push(() => window.removeEventListener('keydown', onEscape))
  }

  /**
   * The map's keys (§7.2), on the circle: the arrows pan a tenth of the box
   * (a half with Shift), Page Up and Page Down zoom about its middle by a
   * wheel notch's worth, Home fits. Not `0`, which fits from anywhere in the
   * window through the panel, nor `+` and `−`, which are the map's resolution.
   */
  private onKey(event: KeyboardEvent): void {
    if (event.altKey || event.ctrlKey || event.metaKey) return
    const { width, height } = this.size
    const step = event.shiftKey ? 0.5 : 0.1
    switch (event.key) {
      case 'ArrowLeft':
        this.panBy(width * step, 0)
        break
      case 'ArrowRight':
        this.panBy(-width * step, 0)
        break
      case 'ArrowUp':
        this.panBy(0, height * step)
        break
      case 'ArrowDown':
        this.panBy(0, -height * step)
        break
      case 'PageUp':
        this.zoomAt(width / 2, height / 2, KEY_ZOOM)
        break
      case 'PageDown':
        this.zoomAt(width / 2, height / 2, 1 / KEY_ZOOM)
        break
      case 'Home':
        this.resetZoom()
        break
      default:
        return
    }
    event.preventDefault()
  }

  /**
   * A press let go where it began: a second one inside the double click's
   * window fits the circle and calls off the first; a first is a click once
   * the window has passed.
   */
  private released(at: { x: number; y: number }): void {
    const last = this.lastClick
    const now = performance.now()
    if (
      last !== null &&
      this.clickTimer !== null &&
      now - last.time <= DOUBLE_CLICK_MS &&
      Math.hypot(at.x - last.x, at.y - last.y) <= DRAG_SLOP * 2
    ) {
      this.cancelClick()
      this.lastClick = null
      this.resetZoom()
      this.rehover = at
      this.schedule()
      return
    }
    this.cancelClick()
    this.lastClick = { x: at.x, y: at.y, time: now }
    const hit = this.hitAt(at)
    const model = this.model
    // A hit is indices into this model, and a click is heard a moment later:
    // a circle rebuilt in between is not the one that was clicked.
    this.clickTimer = setTimeout(() => {
      this.clickTimer = null
      if (this.model === model) this.click(hit)
    }, DOUBLE_CLICK_MS)
  }

  private cancelClick(): void {
    if (this.clickTimer !== null) clearTimeout(this.clickTimer)
    this.clickTimer = null
  }

  /** A press that has travelled, on a zoomed picture: the picture follows the hand. */
  private beginPan(press: Press, event: PointerEvent): void {
    press.panning = true
    this.cancelClick()
    this.canvas.setPointerCapture(event.pointerId)
    this.canvas.style.cursor = 'grabbing'
    this.tip.classList.add('hidden')
    this.drawGuide(null)
    this.setFocus(NO_FOCUS)
    this.setGripHover(null)
  }

  private endPan(at: { x: number; y: number }): void {
    this.canvas.style.cursor = ''
    this.rehover = at
    this.schedule()
  }

  /** Where two fingers are: how far apart, and their middle. */
  private pinchNow(): { distance: number; x: number; y: number } | null {
    const [a, b] = [...this.pointers.values()]
    if (a === undefined || b === undefined) return null
    return { distance: Math.hypot(a.x - b.x, a.y - b.y), x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }
  }

  /** Two fingers moved: the circle zooms about their middle as they spread, and follows it. */
  private movePinch(): void {
    const from = this.pinch
    const to = this.pinchNow()
    if (from === null || to === null) return
    if (from.distance > 0 && to.distance > 0) this.zoomAt(from.x, from.y, to.distance / from.distance)
    this.panBy(to.x - from.x, to.y - from.y)
    this.pinch = to
  }

  /**
   * The ring whose handle is under the point, or `null`: its name where the
   * names are written, and its stretch of the gap at twelve o'clock, which is
   * where the name would be — so a ring with the names off is held there.
   */
  private gripAt(at: { x: number; y: number }): string | null {
    const geometry = this.geometry
    if (geometry === null || this.rings.length === 0) return null
    for (const box of this.nameBoxes) {
      if (at.x >= box.x0 && at.x <= box.x1 && at.y >= box.y0 && at.y <= box.y1) return box.id
    }
    const dx = at.x - geometry.cx
    const dy = at.y - geometry.cy
    const r = Math.hypot(dx, dy)
    // In the opening just before twelve o'clock, narrow or the column's.
    const off = fromTwelve(Math.atan2(dy, dx))
    if (off < geometry.gap.from || off > geometry.gap.to) return null
    const k = geometry.rings.findIndex((band) => r >= band.inner - 2 && r <= band.outer + 2)
    return k < 0 ? null : (this.rings[k]?.id ?? null)
  }

  private setGripHover(id: string | null): void {
    if (id === this.gripHover) return
    this.gripHover = id
    this.schedule()
  }

  /** The ring whose foot is under the point (`ringEdgeAt`), or `null`. */
  private edgeAt(at: { x: number; y: number }): string | null {
    const geometry = this.geometry
    if (geometry === null || this.rings.length === 0) return null
    const k = ringEdgeAt(geometry, at.x, at.y)
    return k < 0 ? null : (this.rings[k]?.id ?? null)
  }

  private setEdgeHover(id: string | null): void {
    if (id === this.edgeHover) return
    this.edgeHover = id
    this.schedule()
  }

  /**
   * The held foot at the pointer: the lane's height grown by how far in the
   * hand has gone since the press — out, shrunk — a pixel of height a pixel
   * where the rings fit, which keeps the foot under the hand as a lane's
   * border is, and that divided by how far the rings were squeezed where they
   * share their room (`ringScale`), so the ring still grows as the hand goes.
   * Held to what a lane may be.
   */
  private moveResize(at: { x: number; y: number }): void {
    const resize = this.resize
    const geometry = this.geometry
    if (resize === null || geometry === null) return
    if (!resize.moved) {
      resize.moved = true
      this.cancelClick()
      this.drawGuide(null)
      this.setFocus(NO_FOCUS)
      this.canvas.setPointerCapture(resize.pointer)
    }
    const r = Math.hypot(at.x - geometry.cx, at.y - geometry.cy)
    resize.size = laneSize(resize.from + (resize.r0 - r) / Math.max(0.05, resize.scale))
    this.schedule()
    // The height being set, beside the hand: the ring is drawn as thick as its
    // room allows, and the number is what the lane beside a map will be.
    const ring = this.rings.find((entry) => entry.id === resize.id)
    if (ring === undefined || !getPlotOptions().tooltip) {
      this.tip.classList.add('hidden')
      return
    }
    this.tip.replaceChildren(
      el('div', { class: 'cell-tip-title', text: ring.label }),
      el('div', { class: 'cell-tip-line', text: `${fmt.int(resize.size)} px high` }),
    )
    this.tip.classList.remove('hidden')
    this.placeTip(at)
  }

  /**
   * Let go of a foot: the track takes the height it was dragged to — the
   * host's, which an overlay group's other tracks are drawn at, as in their
   * lane — or, abandoned, keeps the one it had.
   */
  private endResize(commit: boolean): void {
    const resize = this.resize
    this.resize = null
    if (resize === null) return
    this.canvas.style.cursor = ''
    this.tip.classList.add('hidden')
    if (commit && resize.moved && resize.size !== resize.from) {
      this.options.store.restyle(resize.id, { size: resize.size })
    }
    this.schedule()
  }

  private hitAt(at: { x: number; y: number }): CircleHit | null {
    const geometry = this.geometry
    const model = this.model
    if (geometry === null || model === null) return null
    return hitCircle(geometry, model, this.chords, at.x, at.y)
  }

  private hover(at: { x: number; y: number }): void {
    const hit = this.hitAt(at)
    const grip = this.gripAt(at)
    const edge = grip === null ? this.edgeAt(at) : null
    // No crosshair over a ring's handle: the gap it is in has no data to line
    // up, and the line would run through the names the hand is reaching for.
    this.drawGuide(grip === null ? at : null)
    this.setGripHover(grip)
    this.setEdgeHover(edge)
    const geometry = this.geometry
    this.canvas.style.cursor =
      grip !== null
        ? 'grab'
        : edge !== null && geometry !== null
          ? radialCursor(Math.atan2(at.y - geometry.cy, at.x - geometry.cx))
          : hit === null || hit.kind === 'ring'
            ? ''
            : 'pointer'
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

  /** What a click on each part opens: the same things the square's clicks open. */
  private click(hit: CircleHit | null): void {
    const model = this.model
    const presentation = this.options.presentation()
    if (hit === null || model === null || presentation === undefined) return
    if (hit.kind === 'section') {
      const unit = model.units[hit.unit]
      if (unit !== undefined) presentation.onOpenUnit?.(unit)
    } else if (hit.kind === 'group') {
      const group = model.groups?.[hit.group]
      if (group !== undefined) presentation.onOpenGroup?.(group.name)
    } else if (hit.kind === 'chord' && this.chords !== null) {
      const chord = model.chords[this.chords.order[hit.slot]]
      const a = chord === undefined ? undefined : model.units[chord.a]
      const b = chord === undefined ? undefined : model.units[chord.b]
      if (a !== undefined && b !== undefined) presentation.onOpenPair?.(a, b)
    }
  }

  // -------------------------------------------------------------------------
  // Dragging a ring
  // -------------------------------------------------------------------------

  private beginDrag(pending: { id: string; pointer: number; x: number; y: number }, event: PointerEvent): void {
    const order = this.ringSlots().map((slot) => slot.host.id)
    this.drawGuide(null)
    this.drag = { id: pending.id, pointer: pending.pointer, order: [...order], from: order, moved: true, start: pending }
    this.pending = null
    this.canvas.setPointerCapture(event.pointerId)
    this.canvas.style.cursor = 'grabbing'
    this.tip.classList.add('hidden')
    this.setFocus(NO_FOCUS)
    this.schedule()
  }

  /**
   * The held ring goes to whichever place its middle is nearest the pointer,
   * and the others close up round it — the order is the picture's while the
   * hand is down, and the store's only when it lets go.
   */
  private moveDrag(at: { x: number; y: number }): void {
    const drag = this.drag
    const geometry = this.geometry
    if (drag === null || geometry === null) return
    const r = Math.hypot(at.x - geometry.cx, at.y - geometry.cy)
    const middles = geometry.rings.map((ring) => (ring.inner + ring.outer) / 2)
    let nearest = 0
    for (let k = 1; k < middles.length; k++) {
      if (Math.abs(middles[k] - r) < Math.abs(middles[nearest] - r)) nearest = k
    }
    const current = drag.order.indexOf(drag.id)
    if (current < 0 || nearest === current) return
    const next = drag.order.filter((id) => id !== drag.id)
    next.splice(nearest, 0, drag.id)
    drag.order = next
    this.schedule()
  }

  /**
   * Let go: the ring takes the place of the row now where it was dropped, in
   * the one list the card and every lane read — or, cancelled, goes back.
   */
  private endDrag(commit: boolean): void {
    const drag = this.drag
    this.drag = null
    this.canvas.style.cursor = ''
    if (drag === null) return
    if (commit) {
      const to = drag.order.indexOf(drag.id)
      const displaced = drag.from[to]
      if (displaced !== undefined && displaced !== drag.id) {
        this.moveRing(drag.id, displaced, to > drag.from.indexOf(drag.id))
      }
    }
    this.schedule()
  }

  /**
   * One ring's tracks to another's place in the store, as a block
   * (`ringBlockOrder`): an overlay group moves whole and keeps its order.
   */
  private moveRing(id: string, displaced: string, outwards: boolean): void {
    const store = this.options.store
    const slots = this.ringSlots()
    const mine = slots.find((slot) => slot.host.id === id)
    const theirs = slots.find((slot) => slot.host.id === displaced)
    if (mine === undefined || theirs === undefined) return
    const desired = ringBlockOrder(
      store.entries.map((entry) => entry.id),
      [mine.host, ...mine.overlaid].map((entry) => entry.id),
      [theirs.host, ...theirs.overlaid].map((entry) => entry.id),
      outwards,
    )
    desired.forEach((entry, k) => {
      if (store.entries[k]?.id !== entry) store.moveTo(entry, k)
    })
  }

  // -------------------------------------------------------------------------
  // The card under the pointer
  // -------------------------------------------------------------------------

  /**
   * The card under the pointer, in the map's own card: what a section is and
   * whom it touches, what a chord weighs against each of its ends, and what a
   * ring holds at that place.
   */
  private describe(hit: CircleHit | null, at: { x: number; y: number }): void {
    const model = this.model
    if (hit === null || model === null || !getPlotOptions().tooltip) {
      this.tip.classList.add('hidden')
      return
    }
    const lines: Array<{ text: string; strong?: boolean }> = []
    const noun = 'contacts'
    if (hit.kind === 'section' || hit.kind === 'group') {
      const unitIndex = hit.kind === 'section' ? hit.unit : -1
      const group = hit.kind === 'group' ? model.groups?.[hit.group] : undefined
      const name = group?.name ?? model.units[unitIndex]?.label ?? ''
      const unit = model.units[unitIndex]
      lines.push({ text: name, strong: true })
      if (unit?.genome !== undefined && model.kind === 'contig') lines.push({ text: unit.genome })
      const bp =
        group === undefined
          ? (unit?.bp ?? 0)
          : model.units.slice(group.from, group.to).reduce((sum, member) => sum + member.bp, 0)
      lines.push({ text: fmt.bp(bp) })
      if (group !== undefined) {
        lines.push({ text: `${fmt.int(group.to - group.from)} contigs` })
      } else if (unit !== undefined) {
        const within = model.intra[unitIndex]
        const between = model.inter[unitIndex]
        lines.push({ text: `${formatCount(within)} ${noun} within` })
        const share = within + between > 0 ? ` (${fmt.pct(between / (within + between))})` : ''
        lines.push({ text: `${formatCount(between)} with the others${share}` })
      }
      const weights = partnerWeights(model, this.focus)
      if (weights !== null) {
        const ranked = [...weights.keys()].filter((k) => weights[k] > 0).sort((x, y) => weights[y] - weights[x])
        for (const k of ranked.slice(0, 5)) {
          lines.push({ text: `→ ${model.units[k].label} · ${formatCount(weights[k])}` })
        }
        if (ranked.length > 5) lines.push({ text: `and ${fmt.int(ranked.length - 5)} more` })
      }
    } else if (hit.kind === 'chord' && this.chords !== null) {
      const chord = model.chords[this.chords.order[hit.slot]]
      if (chord === undefined) return
      const a = model.units[chord.a]
      const b = model.units[chord.b]
      lines.push({ text: `${a.label} × ${b.label}`, strong: true })
      lines.push({ text: `${fmt.int(Math.round(chord.weight))} ${noun}` })
      const ofA = model.inter[chord.a] > 0 ? chord.weight / model.inter[chord.a] : Number.NaN
      const ofB = model.inter[chord.b] > 0 ? chord.weight / model.inter[chord.b] : Number.NaN
      if (Number.isFinite(ofA)) lines.push({ text: `${fmt.pct(ofA)} of ${a.label}’s with the others` })
      if (Number.isFinite(ofB)) lines.push({ text: `${fmt.pct(ofB)} of ${b.label}’s with the others` })
    } else if (hit.kind === 'ring') {
      const ring = this.rings[hit.ring]
      const geometry = this.geometry
      if (ring === undefined || geometry === null) return
      // One track: its name over the place and its value. Several in one
      // ring: the place, then each track's name beside its value.
      if (ring.members.length === 1) lines.push({ text: ring.label, strong: true })
      const unit = model.units[hit.unit]
      const bp = Math.floor(bpAtAngle(geometry, model, hit.unit, hit.angle))
      const place = sequenceAt(model, hit.unit, bp)
      lines.push({
        text:
          place === null
            ? unit.label
            : model.kind === 'genome'
              ? `${unit.label} · ${formatPosition(place.name, place.position)}`
              : formatPosition(place.name, place.position),
      })
      if (ring.members.length === 1) {
        const member = ring.members[0]
        lines.push({ text: ringValue(member.content, member.bins, hit.unit, hit.angle) })
      } else {
        for (const member of ring.members) {
          lines.push({ text: `${member.label} · ${ringValue(member.content, member.bins, hit.unit, hit.angle)}` })
        }
      }
    }
    this.tip.replaceChildren(
      ...lines.map((line, k) =>
        el('div', { class: line.strong === true || k === 0 ? 'cell-tip-title' : 'cell-tip-line', text: line.text }),
      ),
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
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * What a ring is called: its track's name, or an overlay group's, as the reader
 * named it — the tooltip names each of its tracks beside its value.
 */
function ringLabel(slot: RingSlot): string {
  return slot.overlaid.length > 0 && slot.host.style.group !== '' ? slot.host.style.group : slot.host.label
}

/** What a ring holds at an angle of a section, as the card says it. */
function ringValue(content: RingContent, bins: CircleBins, unit: number, angle: number): string {
  if (content.kind === 'empty') return content.note === '' ? 'nothing here' : content.note
  if (content.kind === 'features') {
    const hits = content.arcs.filter((arc: FeatureArc) => angle >= arc.a0 && angle <= arc.a1)
    return hits.length === 0 ? 'no feature here' : `${fmt.int(hits.length)} ${hits.length === 1 ? 'feature' : 'features'}`
  }
  const bin = binAt(bins, unit, angle)
  if (bin < 0) return 'nothing here'
  if (content.kind === 'classes') {
    const code = content.classes.codes[bin]
    return code < 0 ? 'no value' : content.classes.levels[code]
  }
  const value = content.values.values[bin]
  return Number.isFinite(value) ? fmt.num(value) : 'no value'
}

/**
 * Whether a sample set holds every base of a stretch of the axis: the cache
 * hands back what it last held while a new window is on its way, and numbers
 * of another stretch binned into these bins would draw gaps where they are not.
 */
function samplesCover(samples: TrackSampleSet, axis: LocusAxis, domain: readonly [number, number]): boolean {
  return axis.windows(domain).every((window) =>
    samples.regions.some(
      (region) => region.contig === window.contig && region.start <= window.start && region.end >= window.end,
    ),
  )
}

/**
 * The circle's sequences as one axis, end to end, a base pair a unit — what
 * the sample cache asks the worker for, one region a sequence.
 */
function circleAxis(model: CircleModel): LocusAxis {
  const segments: LocusSegment[] = []
  let at = 0
  for (const unit of model.units) {
    for (const sequence of unit.sequences) {
      const length = Math.max(0, sequence.length)
      if (length === 0) continue
      segments.push({
        contig: sequence.name,
        unitStart: at,
        unitEnd: at + length,
        bpStart: 0,
        bpPerUnit: 1,
        contigLength: length,
      })
      at += length
    }
  }
  return new LocusAxis(segments)
}

/**
 * The circle's sequences as a contig-level block, one cell a sequence — the
 * shape the metadata index resolves a `/genomes` or `/contigs` column onto, a
 * genome's value broadcast to each of its contigs (§8.12).
 */
function sequenceBlock(model: CircleModel): MetaBlock {
  const runs: Array<{ label: string; start: number; end: number }> = []
  for (const unit of model.units) {
    for (const sequence of unit.sequences) {
      runs.push({ label: sequence.name, start: runs.length, end: runs.length + 1 })
    }
  }
  return { level: 'contig', runs, cells: runs.length, blockStart: 0, binsPerCell: 1 }
}

/** Several reads of one track as one set, for one binning: their regions together. */
function joinSamples(sets: readonly TrackSampleSet[]): TrackSampleSet {
  if (sets.length === 1) return sets[0]
  let extent: TrackSampleSet['extent'] = null
  for (const set of sets) {
    if (set.extent === null) continue
    extent =
      extent === null
        ? { ...set.extent }
        : { min: Math.min(extent.min, set.extent.min), max: Math.max(extent.max, set.extent.max) }
  }
  const note = sets.find((set) => set.note !== undefined && set.note !== '')?.note
  return {
    basesPerPixel: Math.min(...sets.map((set) => set.basesPerPixel)),
    regions: sets.flatMap((set) => set.regions),
    extent,
    ...(note === undefined ? {} : { note }),
    ...(sets[0].mods === undefined ? {} : { mods: sets[0].mods }),
  }
}

/** A box with its corners rounded, as a path: quadratics, which a vector page draws as they are. */
function roundedBox(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  ctx.moveTo(x + r, y)
  ctx.lineTo(x + w - r, y)
  ctx.quadraticCurveTo(x + w, y, x + w, y + r)
  ctx.lineTo(x + w, y + h - r)
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h)
  ctx.lineTo(x + r, y + h)
  ctx.quadraticCurveTo(x, y + h, x, y + h - r)
  ctx.lineTo(x, y + r)
  ctx.quadraticCurveTo(x, y, x + r, y)
  ctx.closePath()
}

/** Whether two lists hold the same things, in the same order. */
function sameList(a: readonly unknown[], b: readonly unknown[]): boolean {
  return a.length === b.length && a.every((item, k) => item === b[k])
}

/** Whether two circles are of the same sections, in the same order and of the same lengths. */
function sameSections(a: CircleModel, b: CircleModel): boolean {
  return (
    a.kind === b.kind &&
    a.units.length === b.units.length &&
    a.units.every((unit, u) => unit.name === b.units[u].name && unit.bp === b.units[u].bp)
  )
}

function sameKey(a: unknown, b: { set: unknown; geometry: unknown }): boolean {
  return (
    typeof a === 'object' &&
    a !== null &&
    (a as { set?: unknown }).set === b.set &&
    (a as { geometry?: unknown }).geometry === b.geometry
  )
}

/**
 * The circle's colours, from the box it is drawn in.
 *
 * The picture is pinned to the light palette like every picture (§16.5), so
 * these are the figure's colours on either theme; the fallbacks are the light
 * values, for a canvas asked before it is in the document.
 */
export function readCirclePalette(from: Element): CirclePalette {
  const style = getComputedStyle(from)
  const pick = (name: string, fallback: string): string => {
    const value = style.getPropertyValue(name).trim()
    return value === '' ? fallback : value
  }
  return {
    text: pick('--text', LIGHT_CIRCLE_PALETTE.text),
    dim: pick('--text-dim', LIGHT_CIRCLE_PALETTE.dim),
    halo: pick('--bg', LIGHT_CIRCLE_PALETTE.halo),
    accent: pick('--accent', LIGHT_CIRCLE_PALETTE.accent),
    wash: pick('--bg-sunken', LIGHT_CIRCLE_PALETTE.wash),
    sections: LIGHT_CIRCLE_PALETTE.sections,
  }
}
