/**
 * The structure cell: the session's 3D model, drawn beside the maps (§25).
 *
 * A cell of the deck and not a drawer, a card or a view of its own, for the
 * reason the deck exists: a structure is a *picture of a place*, and the deck
 * is the app's word for pictures of one place beside each other under one
 * navigation. What this cell shares with the maps is the place — the window
 * the lead is looking at lights the beads inside it, a pointer on any map or
 * track lights the bead at that locus, and a pointer on a bead is echoed back
 * onto every map. What it does not share is how it is drawn: the camera, the
 * representation and the colouring are its own, exactly as a companion's
 * colour scale is (§16.2).
 *
 * ## A view of a row, never a second loading path
 *
 * The model is the session's `structure` row (`annotations/g3d.ts`): this cell
 * finds it in the annotation store, builds a scene from its payload, and
 * writes every control back onto the row's style. Closing the cell leaves the
 * row; dropping a second file replaces what the row was; a saved workspace
 * brings the model back because it brings the row back. There is one file,
 * one row, one persisted entry, and this is the picture of it.
 *
 * ## Two coordinate frames, one bridge
 *
 * Nothing here converts a pixel to a base pair. A pointer on a bead is turned
 * into a locus by the scene (`structure/scene.ts`) and published as a place;
 * a place arriving from a map is turned into beads by the same scene. The
 * beads' loci are the row's own intervals, so this cell and the lane the same
 * row draws beside a map cannot disagree about where a bead is.
 */

import type { AnnotationEntry, StructureStyle, TrackSampleSet } from '../annotations/types'
import {
  STRUCTURE_COLOUR_HAPLOTYPE,
  STRUCTURE_COLOUR_POSITION,
  STRUCTURE_COLOUR_SCORE,
  STRUCTURE_COLOUR_SEQUENCE,
  STRUCTURE_OTHERS,
  STRUCTURE_REPRESENTATIONS,
  structureOf,
} from '../annotations/types'
import type { AnnotationStore } from '../annotations/store'
import type { ManualStore } from '../annotations/manual'
import { mintMarkId } from '../annotations/manual'
import type { BookmarkStore } from '../annotations/bookmarks'
import type { AnnotationClient } from '../annotations/worker/client'
import { SampleCache } from '../annotations/samples'
import {
  STRUCTURE_COLOUR_CONTACTS,
  STRUCTURE_COLOUR_DISTANCE,
  STRUCTURE_COLOUR_FEATURES,
  STRUCTURE_COLOUR_MARKS,
  STRUCTURE_COLOUR_TRACK,
  hasTrackControls,
  isIntervalSet,
} from '../annotations/types'
import type { ColorScale } from '../types'
import { featureColouring } from '../render/featureInk'
import { isArmed, pickLocus, type PickHandlers } from '../ui/mapPick'
import {
  contactsSource,
  distanceSource,
  featureSource,
  loopChords,
  marksSource,
  midpointsOf,
  structureAxis,
  trackSource,
} from '../structure/sources'
import type { ColourSource } from '../structure/colour'
import { featureFields, FIELD_LANE, FIELD_STRAND } from '../annotations/fields'
import type { LocusWindow } from '../render/locus'
import { colormapCss } from '../render/colormaps'
import { recall, remember } from '../state/UiMemory'
import type { ViewState } from '../types'
import {
  cameraOf,
  defaultCamera,
  dolly,
  fitCamera,
  orbit,
  pan,
  project,
  unitsPerPixel,
  type Camera,
} from '../structure/camera'
import { resolveColours, type BeadColours, type StructureKey } from '../structure/colour'
import { PAPER_PALETTE, drawStructure, type StructureView } from '../structure/painter'
import {
  beadsAt,
  beadsIn,
  buildStructure,
  centroidOf,
  distanceBetween,
  lociOf,
  type Structure,
} from '../structure/scene'
import type { RenderPalette, StructureRenderer } from '../structure/three'
import { button, el, fmt } from '../ui/dom'
import { icon, iconButton } from '../ui/icons'
import { readCanvasPalette } from '../ui/MatrixPanel'
import { getPlotOptions } from '../ui/plotOptions'
import { setReadout } from '../ui/readout'
import { setHoverPlace, subscribeHoverPlace } from '../ui/hoverLocus'
import { dragHasFileRow, readFileDrag } from '../ui/fileDrag'
import { VectorPage } from '../ui/vector'
import { downloadBlob, fileStamp, scaleForDpi, canvasToPng } from '../ui/export'
import { DECK_DRAG_TYPE } from './deck'
import type { DeckCell } from './cell'

export interface StructurePanelProps {
  /** The deck's id for this cell — what its hover is published as. */
  id: string
  /** The session's annotation store, where the structure row is. */
  store(): AnnotationStore | undefined
  /** The reader's marks, for a shift-click to add a line to. */
  manual?(): ManualStore | undefined
  /** The session's annotation worker, for sampling a track at each bead (§25.5). */
  client?(): AnnotationClient | undefined
  /** The reader's bookmarks, named on the model at their beads. */
  bookmarks?(): BookmarkStore | undefined
  /**
   * The lead map's own values between one place and many — the row through
   * the pinned bead, for *colour by contacts* (§25.5). `null` where the lead
   * has no block, or is not a map.
   */
  contacts?(
    from: { contig: string; bp: number },
    to: ReadonlyArray<{ contig: string; bp: number }>,
  ): Float32Array | null
  /** The scale that lead draws with, so the beads agree with the picture. */
  contactsScale?(): ColorScale | null
  /** Where the camera is remembered — the session's memory key. */
  memoryKey(): string
  /** The × on the heading. */
  onClose(): void
  /** A double-click on a bead: take the maps there. */
  onGoTo(range: { contig: string; start: number; end: number }): void
  /** A g3d dropped on the cell, or named by URL, replaces the model. */
  onDrop(file: File): void
  onDropUrl(url: string): void
  /** The grip before the name was taken hold of, or let go. */
  onDragChange(dragging: boolean): void
}

/**
 * The part of a structure cell's props the **session** supplies, and the deck
 * passes through: the deck adds the cell's id, its memory key and the two
 * handlers that are about the grid (`panels/PanelDeck.ts`).
 */
export type StructureCellProps = Omit<
  StructurePanelProps,
  'id' | 'memoryKey' | 'onClose' | 'onDragChange'
>

/** Where a cell's camera is remembered in the session's memory. */
const CAMERA_SCOPE = 'structure:camera'

/** How far a press may travel and still be a click. */
const CLICK_SLOP = 4

/** One empty list, handed back frame after frame so the renderer keeps its buffer. */
const NO_CHORDS: ReadonlyArray<readonly [number, number]> = []

/** What a cell says while the row it draws is not ready. */
const WAITING = {
  renderer: 'loading the 3D renderer…',
  none: 'No structure loaded. Drop a g3d here — the text g3dtools takes, or the container it writes.',
  loading: 'reading the structure…',
  empty: 'The structure has no bead on any sequence of this map.',
  lost: 'The GPU took its context away; the model comes back when it is returned.',
  noGl: 'This browser gave no WebGL context, so the model cannot be drawn here.',
}

export class StructurePanel implements DeckCell {
  readonly kind = 'structure' as const
  readonly el: HTMLElement
  private readonly nameEl: HTMLInputElement
  private readonly note = el('p', { class: 'deck-note structure-note' })
  private readonly wrap = el('div', { class: 'structure-wrap' })
  private readonly keyEl = el('div', { class: 'structure-key hidden' })
  private readonly readoutEl = el('div', { class: 'structure-readout hidden' })
  private readonly labelsEl = el('div', { class: 'structure-labels' })
  private readonly menu = el('div', { class: 'structure-menu hidden' })
  private readonly menuToggle: HTMLButtonElement
  /**
   * The GPU side, once its module has arrived.
   *
   * three.js is the one dependency this app takes for a single cell, and it is
   * loaded when the first structure cell is built rather than with the page:
   * `import()` below is a chunk of its own on the web and folded into the one
   * file of the standalone build, and every reader who never opens a structure
   * never downloads it. `null` until then, and every call that needs it asks.
   */
  private renderer: StructureRenderer | null = null
  /** Samples of a track at each bead, fetched through the session's worker. */
  private samples: SampleCache | null = null
  /** The loops drawn as chords, kept while nothing about them changed. */
  private chords: { key: string; list: Array<readonly [number, number]> } | null = null
  /** A picking mode this cell is taking part in (`ui/mapPick.ts`). */
  private picking: { handlers: PickHandlers; end: () => void } | null = null
  private observer: ResizeObserver | null = null
  private readonly unsubscribes: Array<() => void> = []
  private entry: AnnotationEntry | null = null
  private structure: Structure | null = null
  /** The payload the scene was built from, so a rebuild waits for a new one. */
  private builtFrom: unknown = null
  private colours: BeadColours | null = null
  private colouredBy: string | null = null
  private camera: Camera
  private lit: Uint8Array | null = null
  private windows: { rows: LocusWindow[]; cols: LocusWindow[] } | null = null
  private hovered: number[] = []
  private pinned = -1
  private chord: [number, number] | null = null
  private frame = 0
  private drag:
    | { mode: 'orbit' | 'pan'; x: number; y: number; x0: number; y0: number; moved: boolean; shift: boolean }
    | null = null
  private pinchDistance: number | null = null
  private readonly pointers = new Map<number, { x: number; y: number }>()
  private rememberTimer: number | null = null
  private destroyed = false

  constructor(private readonly props: StructurePanelProps) {
    this.camera = cameraOf(recall<unknown>(props.memoryKey(), CAMERA_SCOPE))
    this.nameEl = el('input', {
      class: 'input deck-name',
      type: 'text',
      value: 'structure',
      title: 'The session’s 3D model',
    })
    this.nameEl.readOnly = true
    this.nameEl.addEventListener('pointerdown', (event) => event.stopPropagation())
    this.menuToggle = iconButton('sliders-horizontal', 'How this model is drawn', () => this.toggleMenu(), {
      class: 'btn btn-icon structure-menu-toggle',
      size: 14,
    })
    const frameButton = iconButton('scan', 'Frame what the maps are looking at', () => this.frameLit(), {
      class: 'btn btn-icon structure-frame',
      size: 14,
    })
    this.wrap.append(
      this.labelsEl,
      this.keyEl,
      this.readoutEl,
      this.menu,
      el('div', { class: 'structure-corner' }, this.menuToggle, frameButton),
    )
    this.el = el(
      'section',
      { class: 'deck-panel deck-structure' },
      el(
        'header',
        { class: 'deck-head' },
        this.grip(),
        this.nameEl,
        iconButton('x', 'Close the structure cell (the model stays loaded)', () => props.onClose(), {
          class: 'btn-close',
          size: 14,
        }),
      ),
      this.note,
      el('div', { class: 'deck-body structure-body' }, this.wrap),
    )
    this.watchDrops()
    void this.loadRenderer()
    if (typeof ResizeObserver !== 'undefined') {
      this.observer = new ResizeObserver(() => this.remeasure())
      this.observer.observe(this.wrap)
    }
    const store = props.store()
    if (store !== undefined) this.unsubscribes.push(store.subscribe(() => this.sync()))
    // The marks and the bookmarks are drawn on the model, so a change to
    // either is a repaint; the marks are also a colouring (§25.5).
    const manual = props.manual?.()
    if (manual !== undefined) this.unsubscribes.push(manual.subscribe(() => this.recolour()))
    const bookmarks = props.bookmarks?.()
    if (bookmarks !== undefined) this.unsubscribes.push(bookmarks.subscribe(() => this.schedule()))
    this.unsubscribes.push(
      subscribeHoverPlace((place) => {
        if (place === null || place.source === this.source) {
          if (place === null) this.showIncoming([])
          return
        }
        this.showIncoming(place.loci)
      }),
    )
    this.sync()
  }

  /** What this cell's own hover is published as. */
  private get source(): string {
    return `structure:${this.props.id}`
  }

  // -------------------------------------------------------------------------
  // The deck's calls
  // -------------------------------------------------------------------------

  apply(_state: ViewState): void {
    // What is being looked at reaches this cell as a window
    // ({@link applyWindow}); the state itself names nothing a model needs.
    this.schedule()
  }

  applyWindow(windows: { rows: LocusWindow[]; cols: LocusWindow[] } | null): void {
    this.windows = windows
    this.relight()
    // The lead moved, so its block may have: a colouring read off that block
    // is read again, and the loops touching the window are chosen again.
    if (this.style().colourBy === STRUCTURE_COLOUR_CONTACTS) this.colours = null
    this.chords = null
    this.schedule()
  }

  /** A colouring's source changed under it: colour again on the next frame. */
  private recolour(): void {
    this.colours = null
    this.schedule()
  }

  remeasure(): void {
    const width = this.wrap.clientWidth
    const height = this.wrap.clientHeight
    if (width > 0 && height > 0) this.renderer?.setSize(width, height)
    this.schedule()
  }

  repaint(): void {
    this.renderer?.setPalette(this.palette())
    this.schedule()
  }

  syncName(): void {
    const label = this.entry?.label ?? 'structure'
    if (this.nameEl.value !== label) this.nameEl.value = label
  }

  exportCanvas(dpi: number, _now: Date): HTMLCanvasElement | null {
    if (this.structure === null || this.renderer === null) return null
    const scale = scaleForDpi(dpi)
    const width = Math.max(1, this.wrap.clientWidth)
    const height = Math.max(1, this.wrap.clientHeight)
    return this.renderer.snapshot(width * scale, height * scale)
  }

  destroy(): void {
    this.destroyed = true
    if (this.frame !== 0) cancelAnimationFrame(this.frame)
    if (this.rememberTimer !== null) clearTimeout(this.rememberTimer)
    for (const off of this.unsubscribes.splice(0)) off()
    this.observer?.disconnect()
    this.renderer?.destroy()
    this.samples?.destroy()
    this.cancelPicking()
    if (this.hovered.length > 0) setHoverPlace(null)
  }

  /**
   * Take part in a picking mode: a click on a bead names its locus, on both
   * axes, for the card that armed it (`ui/mapPick.ts`). A bead is one place,
   * so the two coordinates are one, as a track's are.
   */
  armPicking(handlers: PickHandlers, onEnd: () => void = () => {}): () => void {
    this.picking?.end()
    this.picking = { handlers, end: onEnd }
    this.wrap.classList.add('is-picking')
    return () => this.cancelPicking()
  }

  private cancelPicking(): void {
    const picking = this.picking
    this.picking = null
    this.wrap.classList.remove('is-picking')
    picking?.end()
  }

  /** Fetch the GPU side and seat its canvas; see {@link renderer}. */
  private async loadRenderer(): Promise<void> {
    let made: StructureRenderer
    try {
      const { StructureRenderer: Renderer } = await import('../structure/three')
      if (this.destroyed) return
      made = new Renderer(this.palette())
    } catch {
      if (!this.destroyed) this.say(WAITING.noGl)
      return
    }
    this.renderer = made
    this.wrap.prepend(made.el)
    this.watchPointer(made.el)
    this.remeasure()
    this.schedule()
  }

  // -------------------------------------------------------------------------
  // The row
  // -------------------------------------------------------------------------

  /**
   * Find the structure row and build its scene, if it has arrived.
   *
   * The first `structure` row of the store: one structure cell per deck shows
   * the one structure row the session has (§25). A row still loading, or one
   * that refused, is a sentence in the cell rather than a picture.
   */
  private sync(): void {
    const store = this.props.store()
    const entry = store?.entries.find((held) => held.kind === 'structure') ?? null
    this.entry = entry
    this.syncName()
    const payload = entry?.payload
    if (entry === null) {
      this.say(WAITING.none)
      this.structure = null
      this.builtFrom = null
    } else if (entry.status === 'error') {
      this.say(entry.error ?? 'the structure could not be read')
      this.structure = null
      this.builtFrom = null
    } else if (payload === undefined || payload.kind !== 'features' || payload.data.model === undefined) {
      this.say(entry.status === 'detached' ? 'the structure’s file has to be pointed at again' : WAITING.loading)
      this.structure = null
      this.builtFrom = null
    } else {
      // A colouring read off another row — a track's values, a feature set's
      // colours — is stale the moment the list changes under it.
      this.colours = null
      this.chords = null
      if (this.builtFrom !== payload.data) {
        this.structure = buildStructure(payload.data)
        this.builtFrom = payload.data
        this.colours = null
        this.colouredBy = null
        this.pinned = -1
        this.hovered = []
        this.chord = null
        this.relight()
        // A model that has never been looked at opens fitted; one the reader
        // has framed keeps the camera they left it with.
        if (recall<unknown>(this.props.memoryKey(), CAMERA_SCOPE) === undefined) this.frameAll()
      }
      this.say(this.structure === null || this.structure.placed === 0 ? WAITING.empty : '')
    }
    this.paintMenu()
    this.schedule()
  }

  private say(message: string): void {
    this.note.textContent = message
    this.note.classList.toggle('hidden', message === '')
  }

  private style(): StructureStyle {
    return structureOf(this.entry?.style ?? { colour: '', size: 0, mode: 'line', limits: { auto: true, min: 0, max: 1 }, group: '', shape: 'element', radius: 0, opacity: 1, flip: false })
  }

  /** Write one control's value onto the row, which is what everything reads. */
  private restyle(patch: Partial<StructureStyle>): void {
    const store = this.props.store()
    const entry = this.entry
    if (store === undefined || entry === null) return
    store.restyle(entry.id, { structure: { ...structureOf(entry.style), ...patch } })
  }

  // -------------------------------------------------------------------------
  // What is lit
  // -------------------------------------------------------------------------

  /** Recompute which beads are inside the lead's window. */
  private relight(): void {
    const structure = this.structure
    const windows = this.windows
    if (structure === null || windows === null) {
      this.lit = null
      return
    }
    const all = [...windows.rows, ...windows.cols]
    if (all.length === 0) {
      this.lit = null
      return
    }
    const lit = new Uint8Array(structure.set.length)
    let any = 0
    for (const window of all) {
      for (const bead of beadsIn(structure, window.contig, window.start, window.end)) {
        lit[bead] = 1
        any++
      }
    }
    // A window on sequences the model does not have lights nothing, and a
    // model with nothing lit is a model drawn as though nothing were said —
    // the honest picture, rather than everything ghosted.
    this.lit = any === 0 ? null : lit
  }

  // -------------------------------------------------------------------------
  // Hover, in both directions
  // -------------------------------------------------------------------------

  /** A place named by another surface: light its beads, and join a contact's two. */
  private showIncoming(loci: ReadonlyArray<{ contig: string; bp: number }>): void {
    const structure = this.structure
    if (structure === null) return
    const beads: number[] = []
    const ends: number[][] = []
    for (const locus of loci) {
      const at = beadsAt(structure, locus.contig, locus.bp)
      ends.push(at)
      beads.push(...at)
    }
    this.hovered = beads
    this.chord = null
    if (ends.length === 2 && ends[0].length > 0 && ends[1].length > 0) {
      // The same haplotype at both ends where there is one, else the first of each.
      const a = ends[0]
      const pair = a
        .map((bead) => [bead, ends[1].find((other) => structure.model.hap[other] === structure.model.hap[bead])] as const)
        .find(([, other]) => other !== undefined)
      const [from, to] = pair === undefined ? [a[0], ends[1][0]] : [pair[0], pair[1] as number]
      if (from !== to) this.chord = [from, to]
    }
    this.paintReadout(loci)
    this.schedule()
  }

  /** The line in the corner: the place under the pointer, and a distance for a contact. */
  private paintReadout(loci: ReadonlyArray<{ contig: string; bp: number }>): void {
    const structure = this.structure
    if (structure === null || loci.length === 0 || this.hovered.length === 0) {
      this.readoutEl.classList.add('hidden')
      return
    }
    const parts: string[] = []
    if (this.chord !== null) {
      const distance = distanceBetween(structure, this.chord[0], this.chord[1])
      if (Number.isFinite(distance)) parts.push(`${fmt.num(distance)} apart in the model`)
    }
    const first = lociOf(structure, this.hovered[0])
    parts.unshift(
      `${first.contig}:${fmt.int(first.start + 1)}–${fmt.int(first.end)}` +
        (structure.haplotypes.length > 1 ? ` · ${this.hovered.map((b) => lociOf(structure, b).haplotype).join(', ')}` : ''),
    )
    this.readoutEl.textContent = parts.join('   ·   ')
    this.readoutEl.classList.remove('hidden')
  }

  /** The bead under this cell's own pointer, published for the maps and said in the bar. */
  private hoverOwn(bead: number): void {
    const structure = this.structure
    if (structure === null) return
    if (bead < 0) {
      if (this.hovered.length > 0 || this.chord !== null) {
        this.hovered = []
        this.chord = null
        setHoverPlace(null)
        setReadout('')
        this.readoutEl.classList.add('hidden')
        this.schedule()
      }
      return
    }
    if (this.hovered.length === 1 && this.hovered[0] === bead && this.chord === null) return
    const at = lociOf(structure, bead)
    // Every homologue at that locus lights, so the pair reads as a pair; the
    // place published is one, since a bead is one genomic place.
    this.hovered = beadsAt(structure, at.contig, (at.start + at.end) / 2)
    if (!this.hovered.includes(bead)) this.hovered = [bead]
    this.chord = null
    const chain = structure.chains[structure.chainOf[bead]]
    const along = structure.along[bead]
    setHoverPlace({ loci: [{ contig: at.contig, bp: (at.start + at.end) / 2 }], source: this.source })
    setReadout(
      `${at.contig}:${fmt.int(at.start + 1)}–${fmt.int(at.end)}` +
        (structure.haplotypes.length > 1 ? `   ${at.haplotype}` : '') +
        `   bead ${fmt.int(along + 1)} of ${fmt.int(chain?.beads.length ?? 0)}`,
    )
    this.readoutEl.classList.add('hidden')
    this.schedule()
  }

  // -------------------------------------------------------------------------
  // Gestures
  // -------------------------------------------------------------------------

  private watchPointer(canvas: HTMLCanvasElement): void {
    const local = (event: { clientX: number; clientY: number }): { x: number; y: number } => {
      const rect = canvas.getBoundingClientRect()
      return { x: event.clientX - rect.left, y: event.clientY - rect.top }
    }
    canvas.addEventListener('pointerdown', (event) => {
      if (event.button !== 0 && event.button !== 2) return
      const at = local(event)
      this.pointers.set(event.pointerId, at)
      if (this.pointers.size === 2) {
        const [a, b] = [...this.pointers.values()]
        this.pinchDistance = Math.hypot(a.x - b.x, a.y - b.y)
        this.drag = null
        return
      }
      canvas.setPointerCapture(event.pointerId)
      this.drag = {
        mode: event.button === 2 || event.shiftKey ? 'pan' : 'orbit',
        x: at.x,
        y: at.y,
        x0: at.x,
        y0: at.y,
        moved: false,
        shift: event.shiftKey,
      }
    })
    canvas.addEventListener('pointermove', (event) => {
      const at = local(event)
      if (this.pointers.has(event.pointerId)) this.pointers.set(event.pointerId, at)
      if (this.pointers.size === 2 && this.pinchDistance !== null) {
        const [a, b] = [...this.pointers.values()]
        const distance = Math.hypot(a.x - b.x, a.y - b.y)
        if (distance > 0 && this.pinchDistance > 0) {
          this.camera = dolly(this.camera, this.pinchDistance / distance)
          this.pinchDistance = distance
          this.schedule()
        }
        return
      }
      const drag = this.drag
      if (drag === null) {
        this.hoverOwn(this.renderer?.pick(at.x, at.y) ?? -1)
        return
      }
      const dx = at.x - drag.x
      const dy = at.y - drag.y
      if (Math.hypot(at.x - drag.x0, at.y - drag.y0) > CLICK_SLOP) drag.moved = true
      if (drag.mode === 'orbit') {
        this.camera = orbit(this.camera, -dx * 0.008, dy * 0.008)
      } else {
        const per = unitsPerPixel(this.camera, { width: canvas.clientWidth, height: canvas.clientHeight })
        this.camera = pan(this.camera, -dx * per, dy * per)
      }
      drag.x = at.x
      drag.y = at.y
      this.schedule()
    })
    const release = (event: PointerEvent): void => {
      this.pointers.delete(event.pointerId)
      if (this.pointers.size < 2) this.pinchDistance = null
      const drag = this.drag
      this.drag = null
      if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId)
      if (drag === null) return
      if (drag.moved) {
        this.rememberCamera()
        return
      }
      // A press that did not travel is a click: pin the bead, or with Shift
      // put a mark at its locus that every map and track then draws (§8.1).
      const at = local(event)
      const bead = this.renderer?.pick(at.x, at.y) ?? -1
      if (bead < 0) {
        if (this.pinned >= 0) {
          this.pinned = -1
          this.schedule()
        }
        return
      }
      // A picking mode first: the click names a place for the card that asked
      // (a mark's form, an analysis's locus box) rather than pinning.
      const model = this.structure
      if (model === null) return
      const picked = lociOf(model, bead)
      if (this.picking !== null) {
        const point = { contig: picked.contig, bp: Math.round((picked.start + picked.end) / 2) }
        this.picking.handlers.point?.({ rows: point, cols: point, oneAxis: true })
        return
      }
      if (isArmed()) {
        pickLocus({ contig: picked.contig, start: picked.start, end: picked.end })
        return
      }
      if (drag.shift) this.markAt(bead)
      else {
        this.pinned = this.pinned === bead ? -1 : bead
        // A colouring from the pinned bead follows the pin.
        const by = this.style().colourBy
        if (by === STRUCTURE_COLOUR_DISTANCE || by === STRUCTURE_COLOUR_CONTACTS) this.colours = null
      }
      this.schedule()
    }
    canvas.addEventListener('pointerup', release)
    canvas.addEventListener('pointercancel', release)
    canvas.addEventListener('pointerleave', () => {
      if (this.drag === null) this.hoverOwn(-1)
    })
    canvas.addEventListener('contextmenu', (event) => event.preventDefault())
    canvas.addEventListener(
      'wheel',
      (event) => {
        event.preventDefault()
        const factor = Math.exp(event.deltaY * 0.0015)
        // About the pointer: the point under the hand stays under the hand, which
        // is what a zoom on the map does and what a hand expects.
        const at = local(event)
        const box = { width: canvas.clientWidth, height: canvas.clientHeight }
        const before = unitsPerPixel(this.camera, box)
        const next = dolly(this.camera, factor)
        const after = unitsPerPixel(next, box)
        const dx = (at.x - box.width / 2) * (before - after)
        const dy = (at.y - box.height / 2) * (before - after)
        this.camera = pan(next, dx, -dy)
        this.rememberCamera()
        this.schedule()
      },
      { passive: false },
    )
    // A double-click on a bead takes the maps to its locus (§25.4); on the
    // air, it frames what they are looking at.
    canvas.addEventListener('dblclick', (event) => {
      const at = local(event)
      const bead = this.renderer?.pick(at.x, at.y) ?? -1
      const model = this.structure
      if (bead >= 0 && model !== null) {
        const locus = lociOf(model, bead)
        this.props.onGoTo({ contig: locus.contig, start: locus.start, end: locus.end })
        return
      }
      this.frameLit()
    })
    canvas.addEventListener('keydown', (event) => {
      const step = 0.08
      if (event.key === 'ArrowLeft') this.camera = orbit(this.camera, -step, 0)
      else if (event.key === 'ArrowRight') this.camera = orbit(this.camera, step, 0)
      else if (event.key === 'ArrowUp') this.camera = orbit(this.camera, 0, step)
      else if (event.key === 'ArrowDown') this.camera = orbit(this.camera, 0, -step)
      else return
      event.preventDefault()
      this.rememberCamera()
      this.schedule()
    })
    canvas.tabIndex = 0
  }

  /** A dropped g3d replaces the model; a dragged map is the grid's business. */
  private watchDrops(): void {
    this.wrap.addEventListener('dragover', (event) => {
      if (event.dataTransfer?.types.includes(DECK_DRAG_TYPE)) return
      event.preventDefault()
      this.wrap.classList.add('is-over')
    })
    this.wrap.addEventListener('dragleave', () => this.wrap.classList.remove('is-over'))
    this.wrap.addEventListener('drop', (event) => {
      this.wrap.classList.remove('is-over')
      if (event.dataTransfer?.types.includes(DECK_DRAG_TYPE)) return
      const file = event.dataTransfer?.files?.[0]
      // A row out of the Files panel: resolved to a file or a URL first, which
      // costs a fetch, so the branch below (a list already in hand) is not
      // reached for it.
      if (dragHasFileRow(event)) {
        event.preventDefault()
        event.stopPropagation()
        void readFileDrag(event).then((picked) => {
          if (picked === null) return
          if (picked.source.kind === 'local') this.props.onDrop(picked.source.file)
          else this.props.onDropUrl(picked.uri)
        })
        return
      }
      if (file !== undefined) {
        event.preventDefault()
        event.stopPropagation()
        this.props.onDrop(file)
      }
    })
  }

  /** A shift-click: a line at the bead's locus, in the reader's own marks. */
  private markAt(bead: number): void {
    const structure = this.structure
    const manual = this.props.manual?.()
    if (structure === null || manual === undefined) return
    const at = lociOf(structure, bead)
    manual.add({
      id: mintMarkId(),
      kind: 'line',
      axis: 'both',
      at: { contig: at.contig, bp: Math.round((at.start + at.end) / 2) },
      colour: manual.nextColour(),
    })
  }

  /** Put the camera on what the maps are looking at, or on everything. */
  private frameLit(): void {
    const structure = this.structure
    if (structure === null) return
    const lit = this.lit
    const beads: number[] = []
    for (let i = 0; i < structure.set.length; i++) {
      if (lit === null || lit[i] === 1) beads.push(i)
    }
    const sphere = centroidOf(structure, beads)
    if (sphere === null) return
    this.camera = fitCamera(this.camera, sphere)
    this.rememberCamera()
    this.schedule()
  }

  private frameAll(): void {
    const structure = this.structure
    if (structure === null) return
    const sphere = centroidOf(structure, Array.from({ length: structure.set.length }, (_, i) => i))
    if (sphere === null) return
    this.camera = fitCamera(defaultCamera(), sphere)
    this.schedule()
  }

  /** Write the camera down, once the hand has settled. */
  private rememberCamera(): void {
    if (this.rememberTimer !== null) clearTimeout(this.rememberTimer)
    this.rememberTimer = window.setTimeout(() => {
      this.rememberTimer = null
      remember(this.props.memoryKey(), CAMERA_SCOPE, this.camera)
    }, 300)
  }

  /**
   * The handle the cell is dragged by, before its name — the same grip a
   * companion has, for the same swap gesture.
   */
  private grip(): HTMLElement {
    const node = el('span', {
      class: 'deck-grip',
      title: 'Drag to move this cell to another cell of the deck',
      attrs: { draggable: 'true', 'aria-label': 'Move this cell' },
    })
    node.append(icon('grip-vertical', { size: 12 }))
    node.addEventListener('dragstart', (event) => {
      event.dataTransfer?.setData(DECK_DRAG_TYPE, this.source)
      if (event.dataTransfer !== null) event.dataTransfer.effectAllowed = 'move'
      this.el.classList.add('is-dragging')
      this.props.onDragChange(true)
    })
    node.addEventListener('dragend', () => {
      this.el.classList.remove('is-dragging')
      this.props.onDragChange(false)
    })
    return node
  }

  // -------------------------------------------------------------------------
  // Drawing
  // -------------------------------------------------------------------------

  private palette(): RenderPalette {
    const read = readCanvasPalette(this.el)
    return { background: read.labelHaloColor, ink: read.labelColor, halo: read.labelHaloColor }
  }

  private schedule(): void {
    if (this.frame !== 0 || this.destroyed) return
    this.frame = requestAnimationFrame(() => {
      this.frame = 0
      this.draw()
    })
  }

  private view(): StructureView | null {
    const structure = this.structure
    const entry = this.entry
    if (structure === null || entry === null) return null
    const style = this.style()
    const projection = style.projection
    if (this.camera.projection !== projection) this.camera = { ...this.camera, projection }
    if (this.colours === null || this.colouredBy !== style.colourBy) {
      this.colours = resolveColours(structure, style, this.colourSource(structure, style.colourBy))
      this.colouredBy = style.colourBy
    }
    const haplotype = style.haplotype === '' ? -1 : structure.haplotypes.indexOf(style.haplotype)
    return {
      structure,
      camera: this.camera,
      style,
      colours: this.colours,
      lit: this.lit,
      hovered: getPlotOptions().crosshair ? this.hovered : [],
      pinned: this.pinned,
      chord: getPlotOptions().crosshair ? this.chord : null,
      chords: this.loopsOf(structure, style.loops),
      haplotype,
    }
  }

  /**
   * What a colouring outside the file is read from (§25.5), or `null` for
   * one the file answers itself. Each reads the session's own machinery —
   * the store's rows, the sample cache, the marks, the lead map — and hands
   * the numbers to `structure/sources.ts`, which decides what they mean.
   */
  private colourSource(structure: Structure, by: string): ColourSource | null {
    const store = this.props.store()
    if (by.startsWith(STRUCTURE_COLOUR_TRACK)) {
      const id = by.slice(STRUCTURE_COLOUR_TRACK.length)
      const entry = store?.entries.find((row) => row.id === id)
      if (entry === undefined || !hasTrackControls(entry.kind)) {
        return { label: 'a track no longer in the list' }
      }
      return trackSource(structure, this.samplesOf(structure, entry), entry.label, entry.style.limits)
    }
    if (by.startsWith(STRUCTURE_COLOUR_FEATURES)) {
      const id = by.slice(STRUCTURE_COLOUR_FEATURES.length)
      const entry = store?.entries.find((row) => row.id === id)
      const payload = entry?.payload
      if (entry === undefined || payload === undefined || payload.kind !== 'features') {
        return { label: 'a feature set no longer in the list' }
      }
      const colouring = featureColouring(
        payload.data,
        entry.kind,
        entry.style.features?.colourBy ?? '',
        entry.style.colour,
      )
      return featureSource(structure, payload.data, entry.label, entry.style.colour, colouring.colourOf)
    }
    if (by === STRUCTURE_COLOUR_MARKS) {
      return marksSource(structure, this.props.manual?.()?.marks ?? [])
    }
    if (by === STRUCTURE_COLOUR_DISTANCE) return distanceSource(structure, this.pinned)
    if (by === STRUCTURE_COLOUR_CONTACTS) {
      const contacts = this.props.contacts
      if (contacts === undefined || this.pinned < 0) return contactsSource(structure, null, null)
      const from = lociOf(structure, this.pinned)
      const values = contacts({ contig: from.contig, bp: (from.start + from.end) / 2 }, midpointsOf(structure))
      return contactsSource(structure, values, this.props.contactsScale?.() ?? null)
    }
    return null
  }

  /**
   * A track's samples over the whole model, one bucket per bead.
   *
   * Through the same cache the lanes use, keyed to this cell, so the values
   * are the covered-base-weighted means the lane itself draws. `null` until
   * they arrive, and the cache's callback colours again when they do.
   */
  private samplesOf(structure: Structure, entry: AnnotationEntry): TrackSampleSet | null {
    const client = this.props.client?.()
    if (client === undefined) return null
    if (this.samples === null) this.samples = new SampleCache(client, () => this.recolour())
    const axis = structureAxis(structure)
    return this.samples.samplesFor({
      entry: entry.id,
      scope: `structure:${this.props.id}`,
      axis,
      domain: [0, axis.unitEnd],
      pixels: Math.max(1, structure.set.length),
      ...(entry.derivedFrom === undefined ? {} : { derived: entry.derivedFrom }),
    })
  }

  /** The loops row drawn as chords, or none; kept while nothing about it changed. */
  private loopsOf(structure: Structure, loops: string): ReadonlyArray<readonly [number, number]> {
    if (loops === '') return NO_CHORDS
    const entry = this.props.store()?.entries.find((row) => row.id === loops)
    const payload = entry?.payload
    if (entry === undefined || payload === undefined || payload.kind !== 'pairs') return NO_CHORDS
    const key = `${loops}:${payload.data.length}:${this.lit === null ? 'all' : 'lit'}`
    if (this.chords === null || this.chords.key !== key) {
      this.chords = { key, list: loopChords(structure, payload.data, this.lit) }
    }
    return this.chords.list
  }

  private draw(): void {
    const view = this.view()
    if (view === null) {
      this.keyEl.classList.add('hidden')
      this.labelsEl.replaceChildren()
      return
    }
    if (this.renderer === null) {
      this.say(WAITING.renderer)
      return
    }
    if (!this.renderer.available) {
      this.say(WAITING.noGl)
      return
    }
    if (this.renderer.lost) this.say(WAITING.lost)
    else if (this.note.textContent === WAITING.renderer || this.note.textContent === WAITING.lost) this.say('')
    this.renderer.setView(view)
    this.paintKey(view.colours.key)
    this.paintLabels(view)
  }

  /** The corner key, as the map's is: what the colours mean. */
  private paintKey(key: StructureKey): void {
    this.keyEl.replaceChildren()
    if (key.kind === 'none') {
      this.keyEl.classList.add('hidden')
      return
    }
    this.keyEl.classList.remove('hidden')
    this.keyEl.append(el('span', { class: 'structure-key-title', text: key.title }))
    if (key.kind === 'ramp') {
      const stops = Array.from({ length: 9 }, (_, i) => colormapCss(key.colormap, i / 8)).join(', ')
      this.keyEl.append(
        el('span', { class: 'structure-key-ramp', style: { background: `linear-gradient(to right, ${stops})` } }),
        el('span', { class: 'structure-key-range', text: `${fmt.num(key.min)} – ${fmt.num(key.max)}` }),
      )
      return
    }
    const structure = this.structure
    const style = this.style()
    for (const level of key.levels.slice(0, 24)) {
      const chip = el(
        'button',
        { class: 'structure-key-level', type: 'button', title: `Show only ${level.label}; click again for all` },
        el('span', { class: 'structure-key-chip', style: { background: level.colour } }),
        el('span', { text: level.label }),
      )
      // A haplotype chip solos its homologue, which is the one solo a model
      // keeps (`StructureStyle.haplotype`); a sequence chip is a legend only.
      if (key.title === 'haplotype' && structure !== null && structure.haplotypes.includes(level.label)) {
        chip.classList.toggle('is-on', style.haplotype === level.label)
        chip.addEventListener('click', () =>
          this.restyle({ haplotype: style.haplotype === level.label ? '' : level.label }),
        )
      }
      this.keyEl.append(chip)
    }
  }

  /** Chain names over their midpoint beads, as DOM so they scale with the page's text. */
  private paintLabels(view: StructureView): void {
    this.labelsEl.replaceChildren()
    if (!view.style.labels) return
    const structure = view.structure
    const box = { width: this.wrap.clientWidth, height: this.wrap.clientHeight }
    // The reader's bookmarks, at the bead in the middle of each (§25.5).
    for (const mark of this.props.bookmarks?.()?.marks ?? []) {
      const bead = beadsAt(structure, mark.contig, (mark.start + mark.end) / 2)[0]
      if (bead === undefined) continue
      if (view.lit !== null && view.lit[bead] === 0 && view.style.others === 'hide') continue
      const at = projectInto(view, box, bead)
      if (at === null) continue
      this.labelsEl.append(
        el('span', {
          class: 'structure-label is-bookmark',
          text: mark.label,
          title: `${mark.contig}:${fmt.int(mark.start + 1)}–${fmt.int(mark.end)}`,
          style: { left: `${at.px}px`, top: `${at.py}px` },
        }),
      )
    }
    for (const chain of structure.chains) {
      if (view.haplotype >= 0 && chain.hap !== view.haplotype) continue
      const mid = chain.beads[chain.beads.length >> 1]
      if (structure.present[mid] === 0) continue
      if (view.lit !== null && view.lit[mid] === 0 && view.style.others === 'hide') continue
      const at = projectInto(view, box, mid)
      if (at === null) continue
      const name = structure.contigs[chain.contig]
      const text =
        structure.haplotypes.length > 1 && view.haplotype < 0 ? `${name} ${structure.haplotypes[chain.hap]}` : name
      this.labelsEl.append(
        el('span', {
          class: `structure-label${view.lit !== null && view.lit[mid] === 0 ? ' is-ghost' : ''}`,
          text,
          style: { left: `${at.px}px`, top: `${at.py}px` },
        }),
      )
    }
  }

  // -------------------------------------------------------------------------
  // The menu
  // -------------------------------------------------------------------------

  private toggleMenu(): void {
    const open = this.menu.classList.toggle('hidden')
    this.menuToggle.classList.toggle('is-on', !open)
    if (!open) this.paintMenu()
  }

  /** The controls, rebuilt from the row's style each time something changes. */
  private paintMenu(): void {
    if (this.menu.classList.contains('hidden')) return
    const style = this.style()
    const structure = this.structure
    const select = (
      label: string,
      options: Array<{ value: string; text: string }>,
      value: string,
      onChange: (value: string) => void,
    ): HTMLElement => {
      const node = el('select', { class: 'select select-tiny' })
      for (const option of options) node.append(el('option', { value: option.value, text: option.text }))
      node.value = value
      node.addEventListener('change', () => onChange(node.value))
      return el('label', { class: 'structure-field' }, el('span', { text: label }), node)
    }
    const range = (label: string, value: number, min: number, max: number, step: number, onChange: (v: number) => void): HTMLElement => {
      const node = el('input', { class: 'structure-range', type: 'range' })
      node.min = String(min)
      node.max = String(max)
      node.step = String(step)
      node.value = String(value)
      node.addEventListener('input', () => onChange(Number(node.value)))
      return el('label', { class: 'structure-field' }, el('span', { text: label }), node)
    }
    const toggle = (label: string, on: boolean, onChange: (on: boolean) => void): HTMLElement => {
      const node = el('input', { type: 'checkbox' })
      node.checked = on
      node.addEventListener('change', () => onChange(node.checked))
      return el('label', { class: 'structure-field structure-toggle' }, node, el('span', { text: label }))
    }
    const colourings: Array<{ value: string; text: string }> = [
      { value: STRUCTURE_COLOUR_SEQUENCE, text: 'sequence' },
      ...(structure !== null && structure.haplotypes.length > 1
        ? [{ value: STRUCTURE_COLOUR_HAPLOTYPE, text: 'haplotype' }]
        : []),
      { value: STRUCTURE_COLOUR_POSITION, text: 'position along the sequence' },
      { value: STRUCTURE_COLOUR_SCORE, text: 'score column' },
    ]
    if (structure !== null) {
      for (const field of featureFields(structure.set, 'structure')) {
        if (field.key === FIELD_LANE || field.key === FIELD_STRAND || field.key === 'score') continue
        if (field.key === 'haplotype') continue
        colourings.push({ value: field.key, text: `${field.label} (from the file)` })
      }
    }
    // The session's rows, as colourings (§25.5): a track's values at each
    // bead, a feature set's colours where a bead overlaps one — and the
    // reader's marks, the pinned bead's distances, the map's row through it.
    const store = this.props.store()
    const tracks = (store?.entries ?? []).filter((row) => hasTrackControls(row.kind) && row.status === 'ready')
    const featureSets = (store?.entries ?? []).filter(
      (row) => row.kind !== 'structure' && isIntervalSet(row.kind) && row.status === 'ready',
    )
    for (const row of tracks) colourings.push({ value: `${STRUCTURE_COLOUR_TRACK}${row.id}`, text: `${row.label} (track)` })
    for (const row of featureSets) {
      colourings.push({ value: `${STRUCTURE_COLOUR_FEATURES}${row.id}`, text: `${row.label} (features)` })
    }
    if (this.props.manual?.() !== undefined) colourings.push({ value: STRUCTURE_COLOUR_MARKS, text: 'your marks' })
    colourings.push({ value: STRUCTURE_COLOUR_DISTANCE, text: 'distance to the pinned bead' })
    if (this.props.contacts !== undefined) {
      colourings.push({ value: STRUCTURE_COLOUR_CONTACTS, text: 'contacts with the pinned bead (the map’s row)' })
    }
    // A colouring the list no longer has stays selectable, so the picker
    // says what is chosen rather than quietly showing the first option.
    if (!colourings.some((option) => option.value === style.colourBy)) {
      colourings.push({ value: style.colourBy, text: `${style.colourBy} (no longer in the list)` })
    }
    const loopRows = (store?.entries ?? []).filter((row) => row.kind === 'pairs' && row.status === 'ready')
    const loopChoices: Array<{ value: string; text: string }> = [
      { value: '', text: 'none' },
      ...loopRows.map((row) => ({ value: row.id, text: row.label })),
    ]
    if (style.loops !== '' && !loopRows.some((row) => row.id === style.loops)) {
      loopChoices.push({ value: style.loops, text: `${style.loops} (no longer in the list)` })
    }
    const haplotypes: Array<{ value: string; text: string }> = [
      { value: '', text: 'both homologues' },
      ...(structure?.haplotypes.map((name) => ({ value: name, text: name })) ?? []),
    ]
    this.menu.replaceChildren(
      select(
        'drawn as',
        STRUCTURE_REPRESENTATIONS.map((r) => ({ value: r, text: r })),
        style.representation,
        (value) => this.restyle({ representation: value as StructureStyle['representation'] }),
      ),
      select('colour by', colourings, style.colourBy, (value) => this.restyle({ colourBy: value })),
      ...(loopRows.length > 0 || style.loops !== ''
        ? [select('loops as chords', loopChoices, style.loops, (value) => this.restyle({ loops: value }))]
        : []),
      range('bead radius', style.beadRadius, 0.05, 1.5, 0.05, (v) => this.restyle({ beadRadius: v })),
      range('tube radius', style.tubeRadius, 0.05, 1, 0.05, (v) => this.restyle({ tubeRadius: v })),
      range('opacity', style.opacity, 0.1, 1, 0.05, (v) => this.restyle({ opacity: v })),
      select(
        'outside the window',
        STRUCTURE_OTHERS.map((o) => ({ value: o, text: o })),
        style.others,
        (value) => this.restyle({ others: value as StructureStyle['others'] }),
      ),
      select(
        'gaps',
        [
          { value: 'break', text: 'break the tube' },
          { value: 'dashed', text: 'dashed' },
        ],
        style.gaps,
        (value) => this.restyle({ gaps: value as StructureStyle['gaps'] }),
      ),
      select(
        'projection',
        [
          { value: 'perspective', text: 'perspective' },
          { value: 'orthographic', text: 'orthographic' },
        ],
        style.projection,
        (value) => this.restyle({ projection: value as StructureStyle['projection'] }),
      ),
      ...(structure !== null && structure.haplotypes.length > 1
        ? [select('show', haplotypes, style.haplotype, (value) => this.restyle({ haplotype: value }))]
        : []),
      toggle('lit', style.lit, (on) => this.restyle({ lit: on })),
      toggle('sequence names', style.labels, (on) => this.restyle({ labels: on })),
      el(
        'div',
        { class: 'structure-export' },
        button('PNG', () => void this.savePng(), { class: 'btn btn-quiet', title: 'Save this picture at 300 dpi' }),
        button('PDF', () => void this.savePdf(), {
          class: 'btn btn-quiet',
          title:
            'Save this picture as a PDF: beads and sticks as paths, a tube as a 300 dpi raster — a lit surface is not a path',
        }),
      ),
    )
  }

  // -------------------------------------------------------------------------
  // Export
  // -------------------------------------------------------------------------

  private async savePng(): Promise<void> {
    const out = this.exportCanvas(300, new Date())
    if (out === null) return
    downloadBlob(await canvasToPng(out), `structure-${fileStamp(new Date())}-300dpi.png`)
  }

  /**
   * The vector figure, where the representation is paths; the raster otherwise.
   *
   * Beads and sticks go through `structure/painter.ts`, projected through the
   * same camera the screen was — the picture on paper is the picture on screen
   * in the representation that is paths. A tube is a lit surface no `arc` can
   * be, and exports as the raster the GPU drew, on the page the way a deck
   * does.
   */
  private async savePdf(): Promise<void> {
    const view = this.view()
    if (view === null) return
    const now = new Date()
    const width = Math.max(1, this.wrap.clientWidth)
    const height = Math.max(1, this.wrap.clientHeight)
    const page = new VectorPage(width, height)
    if (view.style.representation === 'tube') {
      const raster = this.exportCanvas(300, now)
      if (raster === null) return
      page.ctx.drawImage(raster, 0, 0, width, height)
    } else {
      drawStructure(page.ctx, { width, height }, view, PAPER_PALETTE)
    }
    downloadBlob(await page.toBlob({ title: 'structure', created: now }), `structure-${fileStamp(now)}.pdf`)
  }
}

/** Where a bead lands in the wrap, through the pure camera. */
function projectInto(
  view: StructureView,
  box: { width: number; height: number },
  bead: number,
): { px: number; py: number } | null {
  const { structure } = view
  // Reached through the painter's own projection rather than the renderer's, so
  // a label sits where the GPU drew its bead: both are the same camera.
  return project(view.camera, box, structure.x[bead], structure.y[bead], structure.z[bead])
}

