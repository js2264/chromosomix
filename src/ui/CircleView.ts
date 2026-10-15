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
import { colormapOf, type AnnotationEntry, type AnnotationKind } from '../annotations/types'
import type { MetaBlock } from '../annotations/metadata'
import { LocusAxis, type LocusSegment } from '../render/locus'
import { resolveLimits } from '../render/tracks'
import { formatCount } from '../render/legend'
import { inverseTransform } from '../render/scale'
import type { MatrixResult } from '../worker/protocol'
import type { Transform } from '../types'
import {
  CHORD_CAP,
  LIGHT_CIRCLE_PALETTE,
  NO_FOCUS,
  TOP,
  chordBend,
  chordColour,
  circleGeometry,
  fontPixels,
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
  members: RingPaint[]
}

/** The label font, and its bold for the lit section. */
const LABEL_FONT = '10px system-ui, sans-serif'
const LABEL_BOLD = '600 10px system-ui, sans-serif'
const RING_NAME_FONT = '10px system-ui, sans-serif'
const KEY_TITLE_FONT = '600 11px system-ui, sans-serif'
const KEY_FONT = '10px system-ui, sans-serif'

/** What the picture answers to, under its key on hover (§26.4: one sentence). */
const HINT = 'Click an arc or a chord to open it'
const HINT_WITH_RINGS = 'Click to open; drag a ring to move it'

/** The key's distance from the picture's corner, its ramp's height, and its gap beside the circle. */
const KEY_INSET = 10
const KEY_BAR = 8
const KEY_GAP = 16

/** Pixels the pointer travels before a press on a ring becomes a drag. */
const DRAG_SLOP = 5

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
  private size = { width: 0, height: 0 }
  private frame = 0
  private layoutKey = ''
  /** Where the key is drawn: beside the circle, or in the corner it leaves clear. */
  private keyAt: { x: number; y: number } | null = null
  private readonly observer: ResizeObserver | null
  private readonly unsubscribe: Array<() => void> = []

  constructor(private readonly options: CircleViewOptions) {
    this.canvas = el('canvas', { class: 'circle-canvas' })
    this.tip = el('div', { class: 'cell-tip circle-tip hidden' })
    // Under the picture's corner, as the map's reframe hint is: the two
    // gestures nothing on screen announces.
    this.hint = el('div', { class: 'circle-hint', attrs: { 'aria-hidden': 'true' }, text: HINT })
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
    const geometry = this.geometry
    const count = geometry?.rings.length ?? 0
    if (geometry === null || count === 0) return null
    return Math.max(6, Math.floor(Math.min(geometry.ringRoom / count, geometry.outer * 0.16)))
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
    this.model =
      block === null
        ? null
        : circleModelOf(block, this.options.presentation()?.resolver ?? {}, this.bpPerCell, CHORD_CAP, this.cut)
    this.geometry = null
    this.chords = null
    this.bins = null
    this.index = null
    this.axis = null
    this.held.clear()
    this.focus = NO_FOCUS
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
    this.chords = null
    this.bins = null
    this.index = null
    this.axis = null
    this.held.clear()
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
    const key =
      `${width}x${height}|${font}|${names}|${corner?.width ?? 0}x${corner?.height ?? 0}|` +
      slots.map((slot) => `${slot.host.id}:${slot.host.style.size}`).join(',')
    // Under the key, or in its corner where there is no key to stand under.
    if (this.keyAt !== null && box !== null) this.placeHint(this.keyAt.x, this.keyAt.y + box.height, slots.length > 0)
    else this.placeHint(width - KEY_INSET, KEY_INSET - 6, slots.length > 0, true)
    if (this.geometry === null || key !== this.layoutKey) {
      measure.font = font
      this.geometry = circleGeometry(model, {
        width,
        height,
        rings: slots.map((slot) => ({ id: slot.host.id, size: slot.host.style.size })),
        measure: (text) => measure.measureText(text).width,
        fontPx: fontPixels(font),
        names,
        ...(corner === undefined ? {} : { corner }),
      })
      this.layoutKey = key
      this.chords = null
      // The bins follow the circle's own size, not the rings': a ring is a
      // band of the same angles whatever its radius.
      const outer = this.geometry.sections.inner
      const count = Math.max(360, Math.min(4096, Math.round(2 * Math.PI * outer)))
      if (this.bins === null || this.bins.count < count * 0.8 || this.bins.count > count * 1.25) {
        this.bins = circleBins(model, this.geometry, count)
        this.held.clear()
      } else {
        // Same count, new angles: the binning is in base pairs and stands; only
        // where each bin is drawn moves with the layout.
        this.bins = circleBins(model, this.geometry, this.bins.count)
      }
      this.index ??= sequenceIndex(model)
      this.axis ??= circleAxis(model)
    }
    this.chords ??= layoutChords(model, this.geometry, this.scale)
    this.rings = this.ringsOf(slots)
    return true
  }

  /**
   * The rings' tracks with their numbers binned and their axes resolved — a
   * group's over every ring that holds one of its tracks, as a group's lanes
   * share one beside the map (`resolveGroupExtents`), unless the group is set
   * to scale each of its tracks on its own.
   */
  private ringsOf(slots: readonly RingSlot[]): RingDrawn[] {
    const built = slots.map((slot) => ({
      slot,
      members: [slot.host, ...slot.overlaid].map((entry) => ({ entry, content: this.contentOf(entry) })),
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
      label: slot.overlaid.length > 0 && slot.host.style.group !== '' ? slot.host.style.group : slot.host.label,
      members: members.map(({ entry, content }) => ({
        id: entry.id,
        label: entry.label,
        colour: entry.style.colour,
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

  private contentOf(entry: AnnotationEntry): RingContent {
    const model = this.model
    const bins = this.bins
    const index = this.index
    const geometry = this.geometry
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
    this.canvas.dataset.geometry = JSON.stringify({
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
      // The band's wash under the first track, and an overlaid track over it.
      ring.members.forEach((member, m) => {
        paintRing(ctx, member, band, geometry, bins, m === 0 ? palette.wash : null, ink, dim)
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
    this.paintRingNames(ctx, geometry, palette)
    this.paintKey(ctx, chords, palette)
    if (live && this.drag?.moved === true) this.paintHeld(ctx, geometry, palette)
  }

  /**
   * The hint under the key, saying the gestures this picture has: rings only
   * where there are rings to drag.
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
    const text = rings ? HINT_WITH_RINGS : HINT
    if (this.hint.textContent !== text) this.hint.textContent = text
  }

  private isHeld(id: string): boolean {
    return this.drag?.moved === true && this.drag.id === id
  }

  /**
   * Each ring's name, where the rings cross twelve o'clock.
   *
   * That is the one place round the circle that is nobody's: the gap the
   * sections leave open at the top runs in through every ring, and a name
   * written there labels its ring without a key to match it against.
   */
  private paintRingNames(ctx: CanvasRenderingContext2D, geometry: CircleGeometry, palette: CirclePalette): void {
    // The Tracks card's `track text`, which is every track's name wherever it
    // is drawn: off, the rings are ink alone.
    if (this.rings.length === 0 || !getPlotOptions().text) return
    ctx.save()
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.lineJoin = 'round'
    // As large as the label font, and no larger than the ring is thick plus its
    // gap, so a stack of thin rings is a stack of names rather than a smear.
    const wanted = fontPixels(scaleFont(RING_NAME_FONT))
    this.rings.forEach((ring, k) => {
      const band = geometry.rings[k]
      if (band === undefined) return
      const px = Math.min(wanted, band.outer - band.inner + 3)
      if (px < 7) return
      ctx.font = `${this.isHeld(ring.id) ? '600 ' : ''}${px.toFixed(1)}px system-ui, sans-serif`
      const r = (band.inner + band.outer) / 2
      const x = geometry.cx + Math.cos(TOP) * r
      const y = geometry.cy + Math.sin(TOP) * r
      ctx.lineWidth = 3
      ctx.strokeStyle = palette.halo
      ctx.strokeText(ring.label, x, y)
      ctx.fillStyle = this.isHeld(ring.id) ? palette.accent : palette.dim
      ctx.fillText(ring.label, x, y)
    })
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
      ctx.arc(geometry.cx, geometry.cy, r, 0, Math.PI * 2)
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
    if (key === null) return
    ctx.save()
    const at = this.keyAt
    if (at === null) return
    const x = at.x
    let y = at.y
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
    if (at === null || geometry === null || this.drag !== null || !getPlotOptions().crosshair) return
    const dx = at.x - geometry.cx
    const dy = at.y - geometry.cy
    const r = Math.hypot(dx, dy)
    if (r < geometry.chord || r > geometry.outer) return
    const angle = Math.atan2(dy, dx)
    const reach = geometry.band?.outer ?? geometry.sections.outer
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

  private watchPointer(): void {
    const canvas = this.canvas
    const local = (event: PointerEvent): { x: number; y: number } => {
      const box = canvas.getBoundingClientRect()
      return { x: event.clientX - box.left, y: event.clientY - box.top }
    }
    canvas.addEventListener('pointermove', (event) => {
      const at = local(event)
      if (this.pending !== null && this.drag === null) {
        const moved = Math.hypot(at.x - this.pending.x, at.y - this.pending.y)
        if (moved >= DRAG_SLOP) this.beginDrag(this.pending, event)
      }
      if (this.drag !== null) {
        this.moveDrag(at)
        return
      }
      this.hover(at)
    })
    canvas.addEventListener('pointerleave', () => {
      if (this.drag !== null) return
      this.drawGuide(null)
      this.setFocus(NO_FOCUS)
      this.tip.classList.add('hidden')
      canvas.style.cursor = ''
    })
    canvas.addEventListener('pointerdown', (event) => {
      if (event.button !== 0) return
      const at = local(event)
      const hit = this.hitAt(at)
      if (hit?.kind === 'ring') {
        const ring = this.rings[hit.ring]
        if (ring !== undefined) this.pending = { id: ring.id, x: at.x, y: at.y, pointer: event.pointerId }
      }
    })
    canvas.addEventListener('pointerup', (event) => {
      const drag = this.drag
      this.pending = null
      if (drag !== null) {
        this.endDrag(true)
        if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId)
        return
      }
      if (event.button !== 0) return
      this.click(this.hitAt(local(event)))
    })
    canvas.addEventListener('pointercancel', () => {
      this.pending = null
      if (this.drag !== null) this.endDrag(false)
    })
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape' && this.drag !== null) {
        event.preventDefault()
        this.endDrag(false)
      }
    }
    window.addEventListener('keydown', onKey)
    this.unsubscribe.push(() => window.removeEventListener('keydown', onKey))
  }

  private hitAt(at: { x: number; y: number }): CircleHit | null {
    const geometry = this.geometry
    const model = this.model
    if (geometry === null || model === null) return null
    return hitCircle(geometry, model, this.chords, at.x, at.y)
  }

  private hover(at: { x: number; y: number }): void {
    this.drawGuide(at)
    const hit = this.hitAt(at)
    this.canvas.style.cursor =
      hit === null ? '' : hit.kind === 'ring' ? 'grab' : 'pointer'
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
      const bins = this.bins
      if (ring === undefined || geometry === null || bins === null) return
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
        lines.push({ text: ringValue(ring.members[0].content, bins, hit.unit, hit.angle) })
      } else {
        for (const member of ring.members) {
          lines.push({ text: `${member.label} · ${ringValue(member.content, bins, hit.unit, hit.angle)}` })
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
