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
import { robustRangeOf, rgbOf } from '../structure/colour'
import { alignTo, displacements, type Alignment } from '../structure/align'
import { transformValue } from '../render/scale'
import { settingsField } from '../ui/laneSettings'
import type { Command } from '../ui/commands'
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
import { cardTitle, icon, iconButton } from '../ui/icons'
import { readCanvasPalette } from '../ui/MatrixPanel'
import type { Modal } from '../ui/Modal'
import { stageDialog } from '../ui/StageDialog'
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
/** Where the enlarged dialog's sidebar width is kept, so a reader sets it once. */
const SIDE_SCOPE = 'structure:side'
/** Where the row the cell was showing is remembered, so a reload draws the same model. */
const MODEL_SCOPE = 'structure:model'
/** The `loops as chords` choice that draws the reader's own arrowhead marks (§25.5). */
export const MANUAL_CHORDS = 'manual'
/** The colouring by each bead's distance to its bead in the compared model (§25.5). */
export const STRUCTURE_COLOUR_DISPLACEMENT = 'displacement'
/** The most contact chords drawn from a pinned bead: the strongest, when more pass the threshold. */
const MAX_CONTACT_CHORDS = 400

/**
 * How far from a bead's centre, in pixels, still counts as pointing at it.
 *
 * About a finger's worth of slack at the sizes a model is drawn at, and small
 * enough that in a dense globule the bead it snaps to is one the reader can
 * see they are near.
 */
const AIM_RADIUS = 14
/** The ruler's steps, in base pairs: the first at least ten beads wide is the one used. */
const RULER_STEPS = [1e4, 2e4, 5e4, 1e5, 2e5, 5e5, 1e6, 2e6, 5e6, 1e7]

/** A ruler tick's label: `300 kb`, `1.2 Mb` — no trailing zero, since a tick is a round number. */
function tickLabel(bp: number): string {
  if (bp >= 1e6) return `${+(bp / 1e6).toFixed(2)} Mb`
  if (bp >= 1e3) return `${+(bp / 1e3).toFixed(1)} kb`
  return `${bp} bp`
}
const NO_CONTACT_CHORDS: ReadonlyArray<{ bead: number; weight: number; colour: string }> = []
const NO_MARKS: ReadonlyArray<{ bead: number; colour: string }> = []
const NO_TICKS: ReadonlyArray<{ bead: number; label: string }> = []
/**
 * The key that names the centre of rotation: Cmd on a Mac, Ctrl elsewhere,
 * which is the modifier each platform's hand already holds for "act on the
 * thing under the pointer". A tap toggles the centre and axes; held, a click
 * moves the centre to the bead under the pointer.
 */
const CENTRE_KEY = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform) ? 'Meta' : 'Control'

/** How far a press may travel and still be a click. */
const CLICK_SLOP = 4

/** One empty list, handed back frame after frame so the renderer keeps its buffer. */
const NO_CHORDS: ReadonlyArray<readonly [number, number]> = []

/** What a cell says while the row it draws is not ready. */
const WAITING = {
  renderer: 'loading the 3D renderer…',
  none: 'No structure loaded. Drop a g3d here — the text g3dtools takes, or the container it writes.',
  removed: 'The model this cell was showing was removed. Pick another on the Structures card, or from the menu here.',
  loading: 'reading the structure…',
  empty: 'The structure has no bead on any sequence of this map.',
  lost: 'The GPU took its context away; the model comes back when it is returned.',
  noGl: 'This browser gave no WebGL context, so the model cannot be drawn here.',
}

/** What a click on a bead does, and what the badge in the corner says it does. */
type StructureMode = 'none' | 'mark' | 'loop' | 'measure'

export class StructurePanel implements DeckCell {
  readonly kind = 'structure' as const
  readonly el: HTMLElement
  private readonly nameEl: HTMLInputElement
  private readonly note = el('p', { class: 'deck-note structure-note' })
  private readonly wrap = el('div', { class: 'structure-wrap' })
  private readonly keyEl = el('div', { class: 'structure-key hidden' })
  private readonly readoutEl = el('div', { class: 'structure-readout hidden' })
  /**
   * The card under the pointer, naming the bead's sequence and coordinate.
   *
   * The map's card and this one are the same instrument and answer to the same
   * switch (§7's *tooltip*): a reader who turned the card off beside the map
   * meant it off, and a model that went on putting one up would be the app
   * disagreeing with itself. The line in the corner and the status bar say the
   * same thing and are not gated, exactly as they are not beside the map.
   */
  private readonly tipEl = el(
    'div',
    { class: 'cell-tip structure-tip hidden' },
    el('div', { class: 'cell-tip-pair' }),
    el('div', { class: 'cell-tip-pos' }),
  )
  /** Where the pointer last was on this cell's canvas, for placing the card. */
  private pointerAt: { x: number; y: number } | null = null
  /** The badge in the top-left corner: what a drag or a click does right now. */
  private readonly modeEl = el('div', { class: 'structure-mode' })
  /** The modifiers held, while the pointer is over this cell or its dialog is open. */
  private readonly keys = { shift: false, centre: false, space: false }
  /** A press of the centre key that no click has used yet: released, it toggles the display. */
  private centreTap = false
  private overCanvas = false
  /**
   * What a click on a bead does (§25.4): nothing but pin it, mark its locus,
   * begin or close a loop, or begin or close a measurement.
   *
   * One field rather than a flag each, because the four are exclusive and two
   * flags that must never both be true is a state a reader can reach and the
   * type cannot forbid.
   */
  private mode: StructureMode = 'none'
  /** The first bead of a loop, while one is half made. */
  private selectFirst = -1
  private markButton: HTMLButtonElement | null = null
  private loopButton: HTMLButtonElement | null = null
  private fogFrame = 0
  private fogPending: number | null = null
  private keyClickTimer: number | null = null
  private readonly labelsEl = el('div', { class: 'structure-labels' })
  /**
   * The cell's settings, as a card of the Aesthetics panel (§25.3): built
   * here, mounted by the session beside the map's cards, borrowed by the
   * dialog's sidebar and given back. One set of controls, one parent at a
   * time.
   */
  private readonly settingsEl = el('div', { class: 'controls-card structure-settings' })
  private settingsHome: { parent: HTMLElement; next: Node | null } | null = null
  /** The first bead of a measurement, while one is half made. */
  private measureFirst = -1
  private measureButton: HTMLButtonElement | null = null
  private measures: Array<readonly [number, number]> = []
  /** The turntable: the model turned slowly by itself until stopped. */
  private turning = false
  private turnFrame = 0
  /** The compared model (§25.5), aligned once per pair of rows. */
  private compared: { key: string; overlay: { structure: Structure; colours: BeadColours }; fit: Alignment } | null = null
  private contactCache: { key: string; list: ReadonlyArray<{ bead: number; weight: number; colour: string }> } | null = null
  private rulerCache: { key: string; list: ReadonlyArray<{ bead: number; label: string }> } | null = null
  private sizeCache: { key: string; samples: TrackSampleSet; sizes: Float32Array | null } | null = null
  /** The cell's body, where the picture lives when it is not enlarged. */
  private readonly body: HTMLElement
  /** The modal the picture is enlarged into, while it is (§25.3). */
  private expanded: Modal | null = null
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
  /** The row the scene was built from, so a change of row reframes the camera. */
  private builtRow: string | null = null
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
    | { mode: 'orbit' | 'pan' | 'measure'; x: number; y: number; x0: number; y0: number; moved: boolean; shift: boolean }
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
    this.measureButton = iconButton(
      'ruler',
      'Measure: drag from one bead to another for the distance between them, kept in the card (m, enlarged)',
      () => this.setMode('measure'),
      { class: 'btn btn-icon structure-measure', size: 14 },
    )
    const frameButton = iconButton('scan', 'Frame what the maps are looking at', () => this.frameLit(), {
      class: 'btn btn-icon structure-frame',
      size: 14,
    })
    const expandButton = iconButton('maximize', 'Enlarge the model, with every setting beside it', () => this.expand(), {
      class: 'btn btn-icon structure-expand',
      size: 14,
    })
    // Two buttons, not one mode that counts clicks: marking a place and
    // marking a loop are two things a reader means, and a mode where the first
    // click might be either is a mode whose first click cannot be undone by
    // stopping.
    this.markButton = iconButton(
      'map-pin',
      'Mark a bead: each click marks that bead’s locus, on every map and track (e, enlarged)',
      () => this.setMode('mark'),
      { class: 'btn btn-icon structure-select', size: 14 },
    )
    this.loopButton = iconButton(
      'link-2',
      'Mark a loop: click two beads for a loop between their loci, drawn as a chord (o, enlarged)',
      () => this.setMode('loop'),
      { class: 'btn btn-icon structure-loop', size: 14 },
    )
    this.wrap.append(
      this.labelsEl,
      this.keyEl,
      this.modeEl,
      this.tipEl,
      this.readoutEl,
      el(
        'div',
        { class: 'structure-corner' },
        this.markButton,
        this.loopButton,
        this.measureButton,
        frameButton,
        expandButton,
      ),
    )
    this.paintMode()
    this.paintSettings()
    // The modifiers are read off the window, since a key goes down wherever
    // the focus is; they are acted on only while this cell is engaged — the
    // pointer over it, its canvas focused, or its dialog open — so Cmd+C in a
    // box somewhere else toggles nothing here.
    window.addEventListener('keydown', this.onKeyDown)
    window.addEventListener('keyup', this.onKeyUp)
    window.addEventListener('blur', this.onWindowBlur)
    this.unsubscribes.push(() => {
      window.removeEventListener('keydown', this.onKeyDown)
      window.removeEventListener('keyup', this.onKeyUp)
      window.removeEventListener('blur', this.onWindowBlur)
    })
    this.body = el('div', { class: 'deck-body structure-body' }, this.wrap)
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
      this.body,
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
    if (manual !== undefined) {
      this.unsubscribes.push(
        manual.subscribe(() => {
          this.chords = null
          this.recolour()
        }),
      )
    }
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
    if (this.turnFrame !== 0) cancelAnimationFrame(this.turnFrame)
    this.expanded?.close()
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

  /** The row the reader asked for, or `null` for whichever is first. */
  private chosen: string | null = null
  /**
   * How the choice was made. A row *picked* this session and then removed
   * leaves the cell empty rather than quietly showing another model; a row
   * *remembered* from an earlier session that is gone falls back to the first,
   * since the reader has not chosen anything yet today.
   */

  /**
   * Draw this row: the Structures card's *show in the deck*, and the picker.
   *
   * Remembered per file, so the model the reader chose is the one a reload
   * draws; a row that is gone by then falls back to the first (`sync`).
   */
  showModel(id: string): void {
    this.chosen = id
    remember(this.props.memoryKey(), MODEL_SCOPE, id)
    this.sync()
  }

  shownModel(): string | null {
    return this.entry?.id ?? null
  }

  /**
   * Find the structure row and build its scene, if it has arrived.
   *
   * The row the reader chose — from the Structures card or the cell's own
   * picker, remembered per file — or the first `structure` row of the store
   * where none was chosen or the chosen one is gone: one structure cell per
   * deck draws one model at a time (§25). A row still loading, or one that
   * refused, is a sentence in the cell rather than a picture.
   */
  private sync(): void {
    const store = this.props.store()
    const rows = (store?.entries ?? []).filter((held) => held.kind === 'structure')
    if (this.chosen === null) {
      const remembered = recall<unknown>(this.props.memoryKey(), MODEL_SCOPE)
      if (typeof remembered === 'string') {
        this.chosen = remembered
      }
    }
    const chosenRow = rows.find((held) => held.id === this.chosen)
    // **The row this cell is drawing, removed from the Structures card, empties
    // the cell** (§25.3) — however the cell came to be drawing it. Falling to
    // whichever model is next would put a picture nobody asked for in the place
    // of the one they closed, and it is the same picture whether the reader
    // picked this row from the card, restored it with the session, or simply
    // got it as the only one there was. The gate used to be the first of those
    // three, which meant the commonest case — one model, loaded and shown —
    // went on showing a stale name over an empty stage.
    const shown = this.entry
    const emptied = shown !== null && !rows.some((held) => held.id === shown.id)
    const entry = emptied ? null : (chosenRow ?? rows[0] ?? null)
    if (emptied) {
      this.chosen = null
      remember(this.props.memoryKey(), MODEL_SCOPE, null)
    }
    this.entry = entry
    this.syncName()
    const payload = entry?.payload
    if (entry === null) {
      this.say(rows.length > 0 ? WAITING.removed : WAITING.none)
      this.structure = null
      this.builtFrom = null
      this.builtRow = null
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
        const switched = this.builtRow !== null && this.builtRow !== entry.id
        this.structure = buildStructure(payload.data)
        this.builtFrom = payload.data
        this.builtRow = entry.id
        this.colours = null
        this.colouredBy = null
        this.pinned = -1
        this.hovered = []
        this.chord = null
        this.relight()
        // A model that has never been looked at opens fitted; one the reader
        // has framed keeps the camera they left it with. A *different* row —
        // the picker, the Structures card, a model that has just landed — is
        // framed afresh: its beads are in their own units around their own
        // centre, and the camera that framed the last model shows a corner of
        // this one, or nothing.
        if (switched || recall<unknown>(this.props.memoryKey(), CAMERA_SCOPE) === null) this.frameAll()
      }
      this.say(this.structure === null || this.structure.placed === 0 ? WAITING.empty : '')
      // The ghosted sequences are part of the style, so a change to the row
      // — the key's click — is a change to what is lit.
      this.relight()
    }
    this.paintSettings()
    this.schedule()
  }

  /** The card of settings, for the Aesthetics panel (`PanelDeck.structureSettings`). */
  settings(): HTMLElement {
    return this.settingsEl
  }

  /**
   * What the cell can be told to do, with a key each (§25.3): listed in the
   * palette and bound through it, like every other command of the app.
   */
  commands(): Command[] {
    const style = this.style()
    const has = this.structure !== null
    const on = (flag: boolean): string => (flag ? 'on' : 'off')
    // **A key only while the model is enlarged.** These are single letters, and
    // the app's own are too: `f` folds the Files panel, `a` the Annotations
    // panel. A structure cell sits *beside* a map, and its commands come first
    // in the palette's list, so binding them there took those letters away from
    // the panels for as long as a model was on screen. In the dialog the model
    // is the whole window and there is nothing else the letter could mean, so
    // that is where they are bound; the palette lists them either way, which is
    // how they are reached from the cell.
    const key = (binding: string): { keys?: string } => (this.expanded === null ? {} : { keys: binding })
    return [
      { id: 'structure-frame', group: 'Structure', title: 'Frame what the maps are looking at', ...key('f'), enabled: has, run: () => this.frameLit() },
      { id: 'structure-all', group: 'Structure', title: 'Show the whole model', ...key('a'), enabled: has, run: () => this.frameAll() },
      { id: 'structure-beads', group: 'Structure', title: `Beads (${on(style.beads)})`, ...key('1'), enabled: has, run: () => this.restyle({ beads: !this.style().beads }) },
      { id: 'structure-sticks', group: 'Structure', title: `Sticks (${on(style.sticks)})`, ...key('2'), enabled: has, run: () => this.restyle({ sticks: !this.style().sticks }) },
      { id: 'structure-tube', group: 'Structure', title: `Tube (${on(style.tube)})`, ...key('3'), enabled: has, run: () => this.restyle({ tube: !this.style().tube }) },
      { id: 'structure-labels', group: 'Structure', title: `Sequence names (${on(style.labels)})`, ...key('l'), enabled: has, run: () => this.restyle({ labels: !this.style().labels }) },
      { id: 'structure-select', group: 'Structure', title: `Mark a bead (${on(this.mode === 'mark')})`, hint: 'Each click marks that bead’s locus', ...key('e'), enabled: has, run: () => this.setMode('mark') },
      { id: 'structure-loop', group: 'Structure', title: `Mark a loop (${on(this.mode === 'loop')})`, hint: 'Click two beads for a loop between their loci', ...key('o'), enabled: has, run: () => this.setMode('loop') },
      { id: 'structure-measure', group: 'Structure', title: `Measure (${on(this.mode === 'measure')})`, hint: 'Drag from one bead to another for the distance between them', ...key('m'), enabled: has, run: () => this.setMode('measure') },
      { id: 'structure-turn', group: 'Structure', title: `Turntable (${on(this.turning)})`, hint: 'The model turns slowly by itself', ...key('r'), enabled: has, run: () => this.toggleTurning() },
    ]
  }

  // -------------------------------------------------------------------------
  // The keys: what a drag or a click does, said in the corner
  // -------------------------------------------------------------------------

  /** Whether the reader's hand is on this cell: the pointer over it, its canvas focused, or its dialog open. */
  private engaged(): boolean {
    return (
      this.overCanvas ||
      this.expanded !== null ||
      (document.activeElement !== null && this.wrap.contains(document.activeElement))
    )
  }

  private readonly onKeyDown = (event: KeyboardEvent): void => {
    if (!this.engaged()) return
    if (event.key === 'Shift') this.keys.shift = true
    else if (event.key === CENTRE_KEY) {
      if (!this.keys.centre) this.centreTap = true
      this.keys.centre = true
    } else if (event.key === ' ' || event.code === 'Space') {
      // Space with the pointer on the model: the fog's key. Held rather than
      // toggled, so the page does not scroll while the hand is here.
      if (this.overCanvas) event.preventDefault()
      this.keys.space = true
    } else if (event.key === 'Escape' && (this.selectFirst >= 0 || this.measureFirst >= 0)) {
      this.selectFirst = -1
      this.measureFirst = -1
      this.pinned = -1
      setReadout('')
      this.schedule()
    } else if (this.keys.centre) {
      // Cmd with another key is a shortcut, not a tap.
      this.centreTap = false
    }
    this.paintMode()
  }

  private readonly onKeyUp = (event: KeyboardEvent): void => {
    if (event.key === 'Shift') this.keys.shift = false
    else if (event.key === CENTRE_KEY) {
      const tap = this.centreTap && this.keys.centre && this.engaged()
      this.keys.centre = false
      this.centreTap = false
      // A tap of the key alone shows or hides the centre of rotation and the
      // axes through it; a click while it was held has already used it.
      if (tap) this.restyle({ axes: !this.style().axes })
    } else if (event.key === ' ' || event.code === 'Space') this.keys.space = false
    this.paintMode()
  }

  private readonly onWindowBlur = (): void => {
    this.keys.shift = false
    this.keys.centre = false
    this.keys.space = false
    this.centreTap = false
    this.paintMode()
  }

  /** The badge: which of the four things the hand is about to do. */
  private paintMode(): void {
    const mode = this.mode === 'measure'
      ? { icon: 'ruler', text: 'measure', title: 'Drag from one bead to another for the distance between them; Esc to cancel' }
      : this.mode === 'mark'
      ? { icon: 'map-pin', text: 'mark', title: 'Click a bead to mark its locus on every map and track' }
      : this.mode === 'loop'
      ? { icon: 'link-2', text: 'loop', title: 'Click two beads for a loop between their loci; Esc to cancel' }
      : this.keys.centre
        ? { icon: 'locate-fixed', text: 'centre', title: `Click a bead to turn about it; tap ${CENTRE_KEY === 'Meta' ? '⌘' : 'Ctrl'} alone to show or hide the centre` }
        : this.keys.shift
          ? { icon: 'move', text: 'move', title: 'Drag to move the whole model' }
          : this.keys.space
            ? { icon: 'layers', text: 'fog', title: 'Scroll to bring the fog forward or push it back' }
            : { icon: 'rotate-3d', text: 'turn', title: 'Drag to turn the model; Shift-drag moves it; scroll zooms' }
    this.modeEl.replaceChildren(icon(mode.icon as Parameters<typeof icon>[0], { size: 13 }), el('span', { text: mode.text }))
    this.modeEl.title = mode.title
    this.modeEl.dataset['mode'] = mode.text
  }

  /** Turn a mode on, or off where it is the one already on. Half-made work is dropped either way. */
  private setMode(next: Exclude<StructureMode, 'none'>): void {
    this.mode = this.mode === next ? 'none' : next
    this.selectFirst = -1
    this.measureFirst = -1
    const sync = (button: HTMLButtonElement | null, which: StructureMode): void => {
      button?.classList.toggle('is-on', this.mode === which)
      button?.setAttribute('aria-pressed', String(this.mode === which))
    }
    sync(this.markButton, 'mark')
    sync(this.loopButton, 'loop')
    sync(this.measureButton, 'measure')
    if (this.mode === 'none') setReadout('')
    this.paintMode()
    this.schedule()
  }

  /**
   * A click in measure mode: the first bead is held, the second closes a
   * measurement — the distance in the model's units and the genomic
   * separation, kept in the card until removed, drawn as dashed ink with the
   * distance written at the middle.
   */
  /** The line under the model while one end of a measurement is held. */
  private sayMeasureFrom(bead: number): void {
    const structure = this.structure
    if (structure === null) return
    const at = lociOf(structure, bead)
    setReadout(`${at.contig}:${fmt.int(at.start + 1)}–${fmt.int(at.end)}   drag to a second bead, or click one, to measure to it`)
  }

  /** The second end: the measurement is kept in the card and drawn on the model. */
  private closeMeasure(bead: number): void {
    const first = this.measureFirst
    if (first < 0 || first === bead) return
    const pair: readonly [number, number] = [first, bead]
    this.measureFirst = -1
    this.pinned = -1
    this.measures = [...this.measures, pair]
    setReadout(this.measureLine(pair))
    this.paintSettings()
    this.schedule()
  }

  /** The end held, let go: a press on nothing, or Escape. */
  private cancelMeasure(): void {
    if (this.measureFirst < 0) return
    this.measureFirst = -1
    this.pinned = -1
    setReadout('')
    this.schedule()
  }

  /** `IV:1,000,001–1,005,000 → IV:1,200,001–1,205,000 · 3.21 apart · 200 kb along` */
  private measureLine([a, b]: readonly [number, number]): string {
    const structure = this.structure
    if (structure === null) return ''
    const la = lociOf(structure, a)
    const lb = lociOf(structure, b)
    const d = distanceBetween(structure, a, b)
    const along =
      la.contig === lb.contig ? `${fmt.bp(Math.abs((la.start + la.end) / 2 - (lb.start + lb.end) / 2))} along` : 'across sequences'
    return `${la.contig}:${fmt.int(la.start + 1)}–${fmt.int(la.end)} → ${lb.contig}:${fmt.int(lb.start + 1)}–${fmt.int(lb.end)} · ${fmt.num(d)} apart · ${along}`
  }

  private toggleTurning(): void {
    this.turning = !this.turning
    if (this.turning) {
      const step = (): void => {
        if (!this.turning || this.destroyed) return
        this.camera = orbit(this.camera, 0.004, 0)
        this.schedule()
        this.turnFrame = requestAnimationFrame(step)
      }
      this.turnFrame = requestAnimationFrame(step)
    } else if (this.turnFrame !== 0) {
      cancelAnimationFrame(this.turnFrame)
      this.turnFrame = 0
      this.rememberCamera()
    }
    this.paintSettings()
  }

  /** A view from a side: the camera's angles set, its distance and target kept. */
  private lookFrom(azimuth: number, elevation: number): void {
    this.camera = { ...this.camera, azimuth, elevation }
    this.rememberCamera()
    this.schedule()
  }

  /**
   * A click in select mode: the first bead is held; the same bead again is a
   * line mark at its locus on both axes; another bead is an arrowhead — the
   * map's loop mark — between the two (§25.4). The marks are the reader's
   * own (`annotations/manual.ts`), so every map, lane and the tracks cell
   * draws them, and the model draws its arrowheads as chords.
   */
  /**
   * A click in loop mode: the first bead is held, the second closes a loop.
   *
   * Only a loop — a click that would have marked a single place is its own
   * mode now, so neither gesture has to guess which the reader meant from how
   * many clicks they have made so far.
   */
  private loopClick(bead: number): void {
    const structure = this.structure
    const manual = this.props.manual?.()
    if (structure === null || manual === undefined) return
    if (bead < 0) {
      this.selectFirst = -1
      this.pinned = -1
      setReadout('')
      this.schedule()
      return
    }
    if (this.selectFirst < 0 || this.selectFirst === bead) {
      this.selectFirst = bead
      this.pinned = bead
      const at = lociOf(structure, bead)
      setReadout(`${at.contig}:${fmt.int(at.start + 1)}–${fmt.int(at.end)}   click a second bead for the loop, Esc to cancel`)
      this.schedule()
      return
    }
    const first = this.selectFirst
    this.selectFirst = -1
    this.pinned = -1
    setReadout('')
    const a = lociOf(structure, first)
    const b = lociOf(structure, bead)
    manual.add({
      id: mintMarkId(),
      kind: 'arrowhead',
      a: { contig: a.contig, bp: Math.round((a.start + a.end) / 2) },
      b: { contig: b.contig, bp: Math.round((b.start + b.end) / 2) },
      colour: manual.nextColour(),
    })
    // The loop drawn where it was made: the marks become the chords unless
    // a loop set already is.
    if (this.style().loops === '') this.restyle({ loops: MANUAL_CHORDS })
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
    if (structure === null) {
      this.lit = null
      return
    }
    // Under `outside the window: show` the window ghosts nothing; the key's
    // own ghosting still does.
    const window = this.style().others === 'show' ? null : this.windowLit(structure)
    this.lit = this.ghostSequences(structure, window)
  }

  /** The beads inside the lead's window, or `null` where nothing is said. */
  private windowLit(structure: Structure): Uint8Array | null {
    const windows = this.windows
    if (windows === null) return null
    const all = [...windows.rows, ...windows.cols]
    if (all.length === 0) return null
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
    return any === 0 ? null : lit
  }

  /**
   * The sequences the reader ghosted from the key (§25.5), taken out of the
   * lit mask — on top of the window's, or alone where there is no window.
   * A ghosted sequence is drawn as the beads outside the window are, so
   * `outside the window: hide` hides it too, which is the reading a reader
   * who chose *hide* wants of a sequence they put away.
   */
  private ghostSequences(structure: Structure, lit: Uint8Array | null): Uint8Array | null {
    const ghosted = new Set(this.style().ghosted)
    if (ghosted.size === 0) return lit
    const n = structure.set.length
    const out = lit === null ? new Uint8Array(n).fill(1) : Uint8Array.from(lit)
    for (let i = 0; i < n; i++) {
      if (ghosted.has(structure.contigs[structure.set.contig[i]] ?? '')) out[i] = 0
    }
    return out
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

  /**
   * The card under the pointer: the bead's sequence, and where along it.
   *
   * Placed from the pointer's own position rather than from the bead's, and
   * on the side of it with room, so the card never covers the thing it is
   * about or leaves the cell.
   */
  private paintTip(at: { contig: string; start: number; end: number; haplotype: string }): void {
    const point = this.pointerAt
    if (point === null || !getPlotOptions().tooltip) {
      this.tipEl.classList.add('hidden')
      return
    }
    const structure = this.structure
    const [name, pos] = this.tipEl.children as unknown as [HTMLElement, HTMLElement]
    name.textContent =
      structure !== null && structure.haplotypes.length > 1 ? `${at.contig} · ${at.haplotype}` : at.contig
    pos.textContent = `${fmt.int(at.start + 1)}–${fmt.int(at.end)}`
    this.tipEl.classList.remove('hidden')
    // Measured after it is shown, so a card that just grew is placed at its
    // new size rather than at the one it had while it was empty.
    const pad = 14
    const box = this.wrap.getBoundingClientRect()
    const width = this.tipEl.offsetWidth
    const height = this.tipEl.offsetHeight
    const left = point.x + pad + width > box.width ? point.x - pad - width : point.x + pad
    const top = point.y + pad + height > box.height ? point.y - pad - height : point.y + pad
    this.tipEl.style.transform = `translate(${Math.max(0, Math.round(left))}px, ${Math.max(0, Math.round(top))}px)`
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

  /**
   * The bead the pointer is aiming at, with the slack a hand needs.
   *
   * A bead is a few pixels across and a tube is thinner than that, so an exact
   * hit is a test of the reader's aim rather than of what they meant. Within
   * {@link AIM_RADIUS} pixels the nearest bead is taken as the one aimed at,
   * and the cursor says so by becoming a cross — so the slack is visible
   * rather than a surprise.
   */
  private aimAt(x: number, y: number): number {
    const bead = this.renderer?.pickNear(x, y, AIM_RADIUS) ?? -1
    this.renderer?.el.classList.toggle('is-aimed', bead >= 0)
    return bead
  }

  /** The bead under this cell's own pointer, published for the maps and said in the bar. */
  private hoverOwn(bead: number): void {
    const structure = this.structure
    if (structure === null) return
    if (bead < 0) {
      this.tipEl.classList.add('hidden')
      this.renderer?.el.classList.remove('is-aimed')
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
    const at = lociOf(structure, bead)
    this.paintTip(at)
    if (this.hovered.length === 1 && this.hovered[0] === bead && this.chord === null) return
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
    // …and in the cell's own corner, which is where a reader looking at the
    // model is looking. It used to appear only for a place named by another
    // panel, so pointing at the model itself — the one gesture that is
    // certainly about the model — was the case that said nothing. One place,
    // never a pair: a bead is one locus. Not the tooltip and not gated with
    // it; that switch is about the card that follows the pointer (§7).
    this.paintReadout([{ contig: at.contig, bp: (at.start + at.end) / 2 }])
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
      // In measure mode a press that lands on a bead is the start of a
      // measurement, not of an orbit: the reader is pointing at one end of a
      // distance and the model must hold still while they travel to the other.
      // A press that lands on nothing still turns the model, because a mode is
      // not a reason to lose the camera.
      if (this.mode === 'measure' && event.button === 0 && !event.shiftKey) {
        const bead = this.aimAt(at.x, at.y)
        if (bead >= 0) {
          this.measureFirst = bead
          this.pinned = bead
          this.sayMeasureFrom(bead)
          this.drag = { mode: 'measure', x: at.x, y: at.y, x0: at.x, y0: at.y, moved: false, shift: false }
          this.schedule()
          return
        }
      }
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
      this.pointerAt = at
      if (drag === null) {
        this.overCanvas = true
        this.hoverOwn(this.aimAt(at.x, at.y))
        return
      }
      const dx = at.x - drag.x
      const dy = at.y - drag.y
      if (Math.hypot(at.x - drag.x0, at.y - drag.y0) > CLICK_SLOP) drag.moved = true
      if (drag.mode === 'measure') {
        // The bead under the pointer, so the line follows the hand and the
        // reader can see what they are about to measure to.
        this.hoverOwn(this.aimAt(at.x, at.y))
        drag.x = at.x
        drag.y = at.y
        return
      }
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
      // A measuring drag let go on a second bead closes the measurement; let
      // go where it began, or on nothing, it leaves the first end held so a
      // second click can still close it. Two gestures, one state.
      if (drag.mode === 'measure') {
        const to = this.aimAt(local(event).x, local(event).y)
        if (to >= 0 && to !== this.measureFirst) this.closeMeasure(to)
        return
      }
      if (drag.moved) {
        this.rememberCamera()
        return
      }
      // A press that did not travel is a click: pin the bead, or with Shift
      // put a mark at its locus that every map and track then draws (§8.1).
      const at = local(event)
      const bead = this.aimAt(at.x, at.y)
      if (bead < 0) {
        if (this.mode === 'loop') this.loopClick(-1)
        else if (this.mode === 'measure') this.cancelMeasure()
        else if (this.pinned >= 0) {
          this.pinned = -1
          this.schedule()
        }
        return
      }
      const model = this.structure
      if (model === null) return
      // The centre key held: the click puts the centre of rotation on the
      // bead, and the tap that would have toggled the display is spent.
      if (event.metaKey || event.ctrlKey) {
        this.centreTap = false
        this.camera = { ...this.camera, target: [model.x[bead], model.y[bead], model.z[bead]] }
        this.rememberCamera()
        this.schedule()
        return
      }
      if (this.mode === 'mark') {
        this.markAt(bead)
        const at = lociOf(model, bead)
        setReadout(`${at.contig}:${fmt.int(at.start + 1)}–${fmt.int(at.end)}   marked`)
        this.schedule()
        return
      }
      if (this.mode === 'loop') {
        this.loopClick(bead)
        return
      }
      if (this.mode === 'measure') {
        // The press already held this bead as the first end; a click on a
        // second closes the measurement the drag would have.
        if (this.measureFirst >= 0 && this.measureFirst !== bead) this.closeMeasure(bead)
        return
      }
      // A picking mode first: the click names a place for the card that asked
      // (a mark's form, an analysis's locus box) rather than pinning.
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
    canvas.addEventListener('pointerenter', () => {
      this.overCanvas = true
    })
    canvas.addEventListener('pointerleave', () => {
      this.overCanvas = false
      this.pointerAt = null
      this.tipEl.classList.add('hidden')
      canvas.classList.remove('is-aimed')
      if (this.drag === null) this.hoverOwn(-1)
    })
    canvas.addEventListener('contextmenu', (event) => event.preventDefault())
    canvas.addEventListener(
      'wheel',
      (event) => {
        event.preventDefault()
        // Space held: the wheel moves the fog rather than the camera —
        // forward to read the front of a dense model, back to see it all.
        if (this.keys.space) {
          const held = this.fogPending ?? this.style().fog
          this.fogPending = Math.max(0, Math.min(1, held + event.deltaY * 0.0012))
          if (this.fogFrame === 0) {
            this.fogFrame = requestAnimationFrame(() => {
              this.fogFrame = 0
              const fog = this.fogPending
              this.fogPending = null
              if (fog !== null) this.restyle({ fog })
            })
          }
          return
        }
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
      const bead = this.aimAt(at.x, at.y)
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
    // The window's beads, whatever `outside the window` says about the rest:
    // under `show` nothing is ghosted, and the frame is still the window's.
    const lit = this.windowLit(structure)
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
    // Orthographic, always: a model has no horizon, and a perspective view of
    // a fibre made distances at the back read shorter than the same at the
    // front, which is a lie about the one thing the model says.
    if (this.camera.projection !== 'orthographic') this.camera = { ...this.camera, projection: 'orthographic' }
    // Keyed on the reader's own sequence colours too: a swatch changed on
    // the key is a colouring changed.
    const colourKey = `${style.colourBy}|${JSON.stringify(style.sequenceColours)}`
    if (this.colours === null || this.colouredBy !== colourKey) {
      this.colours = resolveColours(structure, style, this.colourSource(structure, style.colourBy))
      this.colouredBy = colourKey
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
      sizes: this.sizesOf(structure, style),
      contactChords: style.contactChords ? this.contactChordsOf(structure, style) : NO_CONTACT_CHORDS,
      // The measurement being made, drawn with the ones already made: the
      // line follows the pointer from the bead the press landed on, so a drag
      // shows what it is about to measure rather than what it measured.
      measures:
        this.measureFirst >= 0 && this.hovered.length > 0 && this.hovered[0] !== this.measureFirst
          ? [...this.measures, [this.measureFirst, this.hovered[0]] as const]
          : this.measures,
      marks: this.markedBeads(structure),
      ruler: style.ruler ? this.rulerOf(structure) : NO_TICKS,
      overlay: this.overlayOf(structure, style),
    }
  }

  /**
   * The reader's marked *places* as beads (§25.4), in each mark's own colour.
   *
   * A line mark names one place, which is one bead — or the two homologues of
   * one place on a phased model, which are two beads of the same place. A loop
   * and a rectangle are not places and are not here: the chord says the one,
   * the colouring says the other.
   */
  private markedBeads(structure: Structure): ReadonlyArray<{ bead: number; colour: string }> {
    const marks = this.props.manual?.()?.marks ?? []
    if (marks.length === 0) return NO_MARKS
    const out: Array<{ bead: number; colour: string }> = []
    for (const mark of marks) {
      if (mark.kind !== 'line') continue
      for (const bead of beadsAt(structure, mark.at.contig, mark.at.bp)) out.push({ bead, colour: mark.colour })
    }
    return out.length === 0 ? NO_MARKS : out
  }

  /**
   * A size per bead from a track (§25.5): the track's value at the bead,
   * scaled between half and nearly twice the bead radius over its robust
   * range, so one outlier does not make every other bead a dot. `null` for
   * every bead the same, and while the samples are on their way.
   */
  private sizesOf(structure: Structure, style: StructureStyle): Float32Array | null {
    if (style.sizeBy === '') return null
    const entry = this.props.store()?.entries.find((row) => row.id === style.sizeBy)
    if (entry === undefined || !hasTrackControls(entry.kind)) return null
    const samples = this.samplesOf(structure, entry)
    if (samples === null) return null
    // Keyed on the samples object itself: the cache hands back a new one
    // when a fetch lands, which is when the sizes have to be read again.
    const key = `${entry.id}:${structure.set.length}`
    if (this.sizeCache !== null && this.sizeCache.key === key && this.sizeCache.samples === samples) return this.sizeCache.sizes
    const source = trackSource(structure, samples, entry.label, entry.style.limits)
    const values = source.values ?? new Float32Array(structure.set.length).fill(Number.NaN)
    const range = source.range ?? robustRangeOf(values)
    const span = range.max > range.min ? range.max - range.min : 1
    const sizes = new Float32Array(values.length)
    for (let i = 0; i < values.length; i++) {
      const v = values[i]
      sizes[i] = Number.isNaN(v) ? 0.7 : 0.5 + 1.3 * Math.max(0, Math.min(1, (v - range.min) / span))
    }
    this.sizeCache = { key, samples, sizes }
    return sizes
  }

  /**
   * The map's contacts from the pinned bead as chords (§25.5): every bead
   * whose contact with it is at least the threshold of the strongest, the
   * weight that fraction, the colour the map's own for the value — so the
   * chords are the pinned bead's row of the map, read in space.
   */
  private contactChordsOf(structure: Structure, style: StructureStyle): ReadonlyArray<{ bead: number; weight: number; colour: string }> {
    const contacts = this.props.contacts
    if (contacts === undefined || this.pinned < 0) return NO_CONTACT_CHORDS
    const key = `${this.pinned}:${style.contactThreshold}:${structure.set.length}`
    if (this.contactCache !== null && this.contactCache.key === key) return this.contactCache.list
    const from = lociOf(structure, this.pinned)
    const values = contacts({ contig: from.contig, bp: (from.start + from.end) / 2 }, midpointsOf(structure))
    const scale = this.props.contactsScale?.() ?? null
    if (values === null) return NO_CONTACT_CHORDS
    // A contact's weight is where it sits on the map's own colour scale —
    // the transformed value between the scale's ends — because that is the
    // scale a reader is looking at, and because on a Hi-C row read raw the
    // two neighbours of the pin are the whole picture: everything a few
    // beads away is under a hundredth of them, and a fraction of the
    // strongest reaches nothing. Without a scale, the fraction of the
    // strongest is all there is.
    const onScale = scale !== null && scale.vmax > scale.vmin
    let max = 0
    for (let i = 0; i < values.length; i++) {
      if (i === this.pinned || !Number.isFinite(values[i])) continue
      if (values[i] > max) max = values[i]
    }
    if (max <= 0) return NO_CONTACT_CHORDS
    const ink = this.palette().ink
    const list: Array<{ bead: number; weight: number; colour: string }> = []
    for (let i = 0; i < values.length; i++) {
      if (i === this.pinned || !Number.isFinite(values[i])) continue
      const weight = onScale
        ? Math.max(0, Math.min(1, (transformValue(values[i], scale.transform) - scale.vmin) / (scale.vmax - scale.vmin)))
        : values[i] / max
      if (weight < style.contactThreshold || weight <= 0) continue
      const colour = onScale ? colormapCss(scale.colormap, weight) : ink
      list.push({ bead: i, weight, colour })
    }
    list.sort((p, q) => q.weight - p.weight)
    const kept = list.slice(0, MAX_CONTACT_CHORDS)
    this.contactCache = { key, list: kept }
    return kept
  }

  /**
   * The genomic ruler (§25.5): a tick at the first bead of every step along
   * each chain, the step the first nice one at least ten beads wide, labelled
   * in the shortest unit that says it.
   */
  private rulerOf(structure: Structure): ReadonlyArray<{ bead: number; label: string }> {
    const key = `${structure.set.length}:${structure.width}`
    if (this.rulerCache !== null && this.rulerCache.key === key) return this.rulerCache.list
    const set = structure.set
    // A tick every ten beads, and never more than about forty along the whole
    // model: a genome of sixteen chromosomes at 5 kb is not read at 50 kb.
    let total = 0
    for (const chain of structure.chains) {
      const last = chain.beads[chain.beads.length - 1]
      if (last !== undefined) total += set.end[last] - set.start[chain.beads[0] ?? last]
    }
    const floor = Math.max(structure.width * 10, total / 40)
    const step = RULER_STEPS.find((candidate) => candidate >= floor) ?? RULER_STEPS[RULER_STEPS.length - 1]
    const list: Array<{ bead: number; label: string }> = []
    for (const chain of structure.chains) {
      let last = -1
      for (let k = 0; k < chain.beads.length; k++) {
        const i = chain.beads[k]
        if (structure.present[i] === 0) continue
        const tick = Math.floor(set.start[i] / step)
        if (tick === last) continue
        last = tick
        // Not the zero tick: a chain's start is where its name is, and
        // sixteen "0 bp" labels on a genome say nothing sixteen times.
        if (tick === 0) continue
        list.push({ bead: i, label: tickLabel(tick * step) })
      }
    }
    this.rulerCache = { key, list }
    return list
  }

  /**
   * The compared model (§25.5): another structure row, aligned onto this one
   * over the beads they share (`structure/align.ts`), drawn in one muted
   * colour so this model reads as the one in colour. Aligned once per pair
   * of rows and kept until either changes.
   */
  private overlayOf(structure: Structure, style: StructureStyle): { structure: Structure; colours: BeadColours } | null {
    if (style.compare === '' || style.compare === this.entry?.id) {
      this.compared = null
      return null
    }
    const entry = this.props.store()?.entries.find((row) => row.id === style.compare)
    const payload = entry?.payload
    if (entry === undefined || payload === undefined || payload.kind !== 'features' || payload.data.model === undefined) {
      this.compared = null
      return null
    }
    const key = `${this.entry?.id ?? ''}:${entry.id}:${structure.set.length}`
    if (this.compared !== null && this.compared.key === key) return this.compared.overlay
    const other = buildStructure(payload.data)
    if (other === null) {
      this.compared = null
      return null
    }
    const fit = alignTo(structure, other)
    if (fit === null) {
      this.compared = null
      return null
    }
    const moved: Structure = { ...other, x: fit.x, y: fit.y, z: fit.z }
    const css = new Array<string>(moved.set.length).fill('#8c8c8c')
    const colours: BeadColours = { rgb: rgbOf(css), css, key: { kind: 'none', title: '' } }
    this.compared = { key, overlay: { structure: moved, colours }, fit }
    return this.compared.overlay
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
    if (by === STRUCTURE_COLOUR_DISPLACEMENT) {
      // The overlay first, so the alignment exists; then each bead's distance
      // to its bead in the compared model, on a ramp.
      this.overlayOf(structure, this.style())
      const fit = this.compared?.fit ?? null
      if (fit === null) return { label: 'displacement — choose a model to compare with' }
      return { label: 'displacement from the compared model', values: displacements(structure, fit), colormap: 'viridis' }
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
    if (loops === MANUAL_CHORDS) {
      const marks = this.props.manual?.()?.marks ?? []
      const key = `${MANUAL_CHORDS}:${marks.length}:${marks.map((mark) => mark.id).join(',')}`
      if (this.chords === null || this.chords.key !== key) {
        const list: Array<readonly [number, number]> = []
        for (const mark of marks) {
          if (mark.kind !== 'arrowhead') continue
          const a = beadsAt(structure, mark.a.contig, mark.a.bp)[0]
          const b = beadsAt(structure, mark.b.contig, mark.b.bp)[0]
          if (a !== undefined && b !== undefined && a !== b) list.push([a, b])
        }
        this.chords = { key, list }
      }
      return this.chords.list
    }
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
    // The key first, before the renderer is asked for anything: it is DOM,
    // it says what the colours mean, and its rows are controls — a sequence
    // ghosted from it, a colour picked on it — that should work while the
    // GPU is still loading, or gave no context at all. The map's *legend*
    // switch hides it here too: one switch for what the figure carries.
    this.paintKey(getPlotOptions().legend ? view.colours.key : { kind: 'none', title: '' })
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
    if (key.title === 'sequence' && structure !== null) {
      for (const level of key.levels.slice(0, 48)) this.keyEl.append(this.sequenceChip(structure, style, level))
      return
    }
    for (const level of key.levels.slice(0, 24)) {
      const chip = el(
        'button',
        { class: 'structure-key-level', type: 'button', title: `Show only ${level.label}; click again for all` },
        el('span', { class: 'structure-key-chip', style: { background: level.colour } }),
        el('span', { text: level.label }),
      )
      // A haplotype chip solos its homologue, which is the one solo a model
      // keeps (`StructureStyle.haplotype`).
      if (key.title === 'haplotype' && structure !== null && structure.haplotypes.includes(level.label)) {
        chip.classList.toggle('is-on', style.haplotype === level.label)
        chip.addEventListener('click', () =>
          this.restyle({ haplotype: style.haplotype === level.label ? '' : level.label }),
        )
      }
      this.keyEl.append(chip)
    }
  }

  /**
   * A sequence's row on the key (§25.5): its swatch is a colour picker, a
   * click on its name ghosts it, a double-click shows it alone.
   *
   * The two gestures are told apart by a short wait, since a double-click is
   * two clicks first; the wait is the cost of not needing a second control.
   */
  private sequenceChip(
    structure: Structure,
    style: StructureStyle,
    level: { label: string; colour: string },
  ): HTMLElement {
    const name = level.label
    const ghosted = new Set(style.ghosted)
    const swatch = el('input', {
      class: 'structure-key-swatch',
      type: 'color',
      value: level.colour,
      title: `Colour for ${name}`,
    })
    swatch.addEventListener('click', (event) => event.stopPropagation())
    swatch.addEventListener('input', () =>
      this.restyle({ sequenceColours: { ...style.sequenceColours, [name]: swatch.value } }),
    )
    const button = el('button', {
      class: 'structure-key-name',
      type: 'button',
      text: name,
      title: ghosted.has(name)
        ? `${name} is ghosted: click to draw it again; double-click to show it alone`
        : `Click to ghost ${name}; double-click to show it alone`,
    })
    button.addEventListener('click', () => {
      if (this.keyClickTimer !== null) clearTimeout(this.keyClickTimer)
      this.keyClickTimer = window.setTimeout(() => {
        this.keyClickTimer = null
        const next = new Set(ghosted)
        if (next.has(name)) next.delete(name)
        else next.add(name)
        this.restyle({ ghosted: [...next] })
      }, 220)
    })
    button.addEventListener('dblclick', () => {
      if (this.keyClickTimer !== null) clearTimeout(this.keyClickTimer)
      this.keyClickTimer = null
      const others = structure.contigs.filter((other) => other !== name)
      const alreadySolo = others.length > 0 && others.every((other) => ghosted.has(other)) && !ghosted.has(name)
      // Solo again is "all back": the second double-click undoes the first.
      this.restyle({ ghosted: alreadySolo ? [] : others })
    })
    return el(
      'span',
      { class: `structure-key-level structure-key-seq${ghosted.has(name) ? ' is-off' : ''}` },
      swatch,
      button,
    )
  }

  /** Chain names over their midpoint beads, as DOM so they scale with the page's text. */
  private paintLabels(view: StructureView): void {
    this.labelsEl.replaceChildren()
    const structure = view.structure
    const box = { width: this.wrap.clientWidth, height: this.wrap.clientHeight }
    // The ruler's labels, at most eighty of them so a whole genome is not a
    // cloud of numbers: every k-th tick where there are more.
    if (view.ruler.length > 0) {
      const every = Math.max(1, Math.ceil(view.ruler.length / 80))
      view.ruler.forEach((tick, index) => {
        if (index % every !== 0) return
        if (view.lit !== null && view.lit[tick.bead] === 0 && view.style.others === 'hide') return
        const at = projectInto(view, box, tick.bead)
        if (at === null) return
        this.labelsEl.append(
          el('span', { class: 'structure-label is-tick', text: tick.label, style: { left: `${at.px}px`, top: `${at.py}px` } }),
        )
      })
    }
    // The measurements' distances, at the middle of each.
    for (const [a, b] of view.measures) {
      const pa = projectInto(view, box, a)
      const pb = projectInto(view, box, b)
      if (pa === null || pb === null) continue
      this.labelsEl.append(
        el('span', {
          class: 'structure-label is-measure',
          text: fmt.num(distanceBetween(structure, a, b)),
          style: { left: `${(pa.px + pb.px) / 2}px`, top: `${(pa.py + pb.py) / 2}px` },
        }),
      )
    }
    if (!view.style.labels) return
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

  // -------------------------------------------------------------------------
  // Enlarged
  // -------------------------------------------------------------------------

  /**
   * The model in a modal, with every setting in a sidebar beside it (§25.3).
   *
   * The same picture, not a second one: the cell's own canvas, key, labels
   * and menu are **moved** into the dialog and moved back when it closes, so
   * the camera the reader left it at, the colouring they chose and the pin
   * they set are what the cell shows afterwards — there is nothing to copy
   * across because nothing was duplicated. The renderer follows the box it
   * is in through its resize observer, and the settings write through the
   * store as they do in the cell, so what is changed here is changed there.
   */
  private expand(): void {
    if (this.expanded !== null) return
    // The settings card is borrowed from the Aesthetics panel for as long as
    // the dialog is up, and given back where it was.
    const parent = this.settingsEl.parentElement
    this.settingsHome = parent === null ? null : { parent, next: this.settingsEl.nextSibling }
    this.expanded = stageDialog({
      title: this.entry?.label ?? 'structure',
      variant: 'modal-structure',
      stage: this.wrap,
      stageClass: 'structure-stage',
      side: this.settingsEl,
      sideClass: 'structure-side',
      memoryKey: () => this.props.memoryKey(),
      scope: SIDE_SCOPE,
      onResize: () => this.remeasure(),
      onClose: () => this.collapse(),
    })
    // Sized once the dialog is laid out, not before: the observer answers
    // the box's new size, and the first frame should not be drawn at the
    // cell's.
    requestAnimationFrame(() => this.remeasure())
  }

  /** The picture back in its cell, as the reader left it in the dialog. */
  private collapse(): void {
    this.expanded = null
    // The card goes back where the dialog took it from, and the picture
    // back into the cell's body.
    const home = this.settingsHome
    this.settingsHome = null
    // …before the sibling it had, where that sibling is still there — the
    // column may have been rebuilt while the dialog was up.
    if (home !== null && home.parent.isConnected) {
      home.parent.insertBefore(this.settingsEl, home.next !== null && home.next.parentNode === home.parent ? home.next : null)
    }
    if (!this.destroyed) this.body.append(this.wrap)
    requestAnimationFrame(() => this.remeasure())
  }

  /**
   * The settings card, rebuilt from the row's style each time something
   * changes — the map's own card's shape (`MatrixPanel`'s *Map* card): a
   * heading, then labelled fields, with every on/off setting an icon toggle
   * and every choice a select, from the same primitives the lanes' settings
   * are built with, so the column reads as one column.
   */
  private paintSettings(): void {
    const style = this.style()
    const structure = this.structure
    const store = this.props.store()
    const select = (
      options: Array<{ value: string; text: string }>,
      value: string,
      onChange: (value: string) => void,
    ): HTMLSelectElement => {
      const node = el('select', { class: 'select' })
      for (const option of options) node.append(el('option', { value: option.value, text: option.text }))
      node.value = value
      node.addEventListener('change', () => onChange(node.value))
      return node
    }
    const range = (value: number, min: number, max: number, step: number, onChange: (v: number) => void): HTMLInputElement => {
      const node = el('input', { class: 'structure-range', type: 'range' })
      node.min = String(min)
      node.max = String(max)
      node.step = String(step)
      node.value = String(value)
      node.addEventListener('input', () => onChange(Number(node.value)))
      return node
    }
    const toggleIcon = (name: Parameters<typeof icon>[0], title: string, on: boolean, onChange: (on: boolean) => void): HTMLElement => {
      const node = iconButton(name, title, () => onChange(!on), { class: 'btn btn-icon btn-toggle structure-toggle', size: 15 })
      node.setAttribute('aria-pressed', String(on))
      return node
    }
    const row = (...nodes: HTMLElement[]): HTMLElement => el('div', { class: 'plot-icon-row' }, ...nodes)
    const blockField = (label: string, control: HTMLElement, hint?: string): HTMLElement =>
      el('label', { class: 'field ann-field field-block', title: hint ?? '' }, el('span', { class: 'field-label', text: label }), control)
    const rows: HTMLElement[] = []

    // Which model, where there is more than one to choose between.
    const models = (store?.entries ?? []).filter((held) => held.kind === 'structure')
    if (models.length > 1) {
      rows.push(
        settingsField(
          'model',
          select(models.map((held) => ({ value: held.id, text: held.label })), this.entry?.id ?? '', (value) => this.showModel(value)),
          'Which structure row this cell draws; the Structures card says the same from its side.',
        ),
      )
    }

    // Drawn as: any of the three together.
    rows.push(
      settingsField(
        'drawn as',
        row(
          toggleIcon('circle-dot', 'Beads at each place (1)', style.beads, (on) => this.restyle({ beads: on })),
          toggleIcon('minus', 'Sticks between neighbours (2)', style.sticks, (on) => this.restyle({ sticks: on })),
          toggleIcon('spline', 'A tube through each run (3)', style.tube, (on) => this.restyle({ tube: on })),
        ),
      ),
    )

    // Colour by, and size by.
    const colourings: Array<{ value: string; text: string }> = [
      { value: STRUCTURE_COLOUR_SEQUENCE, text: 'sequence' },
      ...(structure !== null && structure.haplotypes.length > 1 ? [{ value: STRUCTURE_COLOUR_HAPLOTYPE, text: 'haplotype' }] : []),
      { value: STRUCTURE_COLOUR_POSITION, text: 'position along the sequence' },
      { value: STRUCTURE_COLOUR_SCORE, text: 'score column' },
    ]
    if (structure !== null) {
      for (const field of featureFields(structure.set, 'structure')) {
        if (field.key === FIELD_LANE || field.key === FIELD_STRAND || field.key === 'score' || field.key === 'haplotype') continue
        colourings.push({ value: field.key, text: `${field.label} (from the file)` })
      }
    }
    const tracks = (store?.entries ?? []).filter((held) => hasTrackControls(held.kind) && held.status === 'ready')
    const featureSets = (store?.entries ?? []).filter(
      (held) => held.kind !== 'structure' && isIntervalSet(held.kind) && held.status === 'ready',
    )
    for (const held of tracks) colourings.push({ value: `${STRUCTURE_COLOUR_TRACK}${held.id}`, text: `${held.label} (track)` })
    for (const held of featureSets) colourings.push({ value: `${STRUCTURE_COLOUR_FEATURES}${held.id}`, text: `${held.label} (features)` })
    if (this.props.manual?.() !== undefined) colourings.push({ value: STRUCTURE_COLOUR_MARKS, text: 'your marks' })
    colourings.push({ value: STRUCTURE_COLOUR_DISTANCE, text: 'distance to the pinned bead' })
    if (this.props.contacts !== undefined) colourings.push({ value: STRUCTURE_COLOUR_CONTACTS, text: 'contacts with the pinned bead (the map’s row)' })
    if (style.compare !== '') colourings.push({ value: STRUCTURE_COLOUR_DISPLACEMENT, text: 'displacement from the compared model' })
    if (!colourings.some((option) => option.value === style.colourBy)) {
      colourings.push({ value: style.colourBy, text: `${style.colourBy} (no longer in the list)` })
    }
    rows.push(settingsField('colour by', select(colourings, style.colourBy, (value) => this.restyle({ colourBy: value }))))
    const sizeChoices = [{ value: '', text: 'the same everywhere' }, ...tracks.map((held) => ({ value: held.id, text: held.label }))]
    if (style.sizeBy !== '' && !sizeChoices.some((choice) => choice.value === style.sizeBy)) {
      sizeChoices.push({ value: style.sizeBy, text: `${style.sizeBy} (no longer in the list)` })
    }
    rows.push(
      settingsField(
        'size by',
        select(sizeChoices, style.sizeBy, (value) => this.restyle({ sizeBy: value })),
        'A track whose value at each bead sets the bead’s size — a second channel beside the colour.',
      ),
    )
    rows.push(settingsField('bead radius', range(style.beadRadius, 0.05, 1.5, 0.05, (v) => this.restyle({ beadRadius: v }))))
    rows.push(settingsField('tube radius', range(style.tubeRadius, 0.05, 1, 0.05, (v) => this.restyle({ tubeRadius: v }))))

    // Chords: a loop set or the reader's marks, and the map's contacts from the pin.
    const loopRows = (store?.entries ?? []).filter((held) => held.kind === 'pairs' && held.status === 'ready')
    const hasMarks = this.props.manual?.() !== undefined
    const loopChoices: Array<{ value: string; text: string }> = [
      { value: '', text: 'none' },
      ...loopRows.map((held) => ({ value: held.id, text: held.label })),
      ...(hasMarks ? [{ value: MANUAL_CHORDS, text: 'your marks (arrowheads)' }] : []),
    ]
    if (style.loops !== '' && !loopChoices.some((choice) => choice.value === style.loops)) {
      loopChoices.push({ value: style.loops, text: `${style.loops} (no longer in the list)` })
    }
    rows.push(
      el(
        'div',
        { class: 'field ann-field structure-field-with-toggle' },
        el('span', { class: 'field-label', text: 'loops as chords' }),
        toggleIcon('link-2', style.chords ? 'Hide the chords' : 'Show the chords', style.chords, (on) => this.restyle({ chords: on })),
        select(loopChoices, style.loops, (value) => this.restyle({ loops: value })),
      ),
    )
    if (this.props.contacts !== undefined) {
      rows.push(
        el(
          'div',
          { class: 'field ann-field structure-field-with-toggle', title: 'The map’s contacts from the pinned bead, as chords to every bead above the threshold — as thick as the contact, in the map’s colour for it. Pin a bead with a click.' },
          el('span', { class: 'field-label', text: 'contacts from the pin' }),
          toggleIcon('waypoints', style.contactChords ? 'Hide the contact chords' : 'Show the contact chords', style.contactChords, (on) => this.restyle({ contactChords: on })),
          range(style.contactThreshold, 0, 1, 0.02, (v) => this.restyle({ contactThreshold: v })),
        ),
      )
    }

    // What is outside the window, and how much of it is left.
    rows.push(settingsField('ghost opacity', range(style.opacity, 0, 1, 0.05, (v) => this.restyle({ opacity: v }))))
    rows.push(
      settingsField(
        'outside the window',
        select(STRUCTURE_OTHERS.map((o) => ({ value: o, text: o })), style.others, (value) => this.restyle({ others: value as StructureStyle['others'] })),
      ),
    )
    if (structure !== null && structure.haplotypes.length > 1) {
      const haplotypes = [{ value: '', text: 'both homologues' }, ...structure.haplotypes.map((name) => ({ value: name, text: name }))]
      rows.push(settingsField('show', select(haplotypes, style.haplotype, (value) => this.restyle({ haplotype: value }))))
    }

    // Depth: the fog and the slab.
    rows.push(
      el(
        'div',
        { class: 'field ann-field structure-field-with-toggle', title: 'The fog for depth: Space + scroll on the model moves it too.' },
        el('span', { class: 'field-label', text: 'fog' }),
        toggleIcon('cloud-fog', style.fogOn ? 'Turn the fog off' : 'Turn the fog on', style.fogOn, (on) => this.restyle({ fogOn: on })),
        range(style.fog, 0, 1, 0.05, (v) => this.restyle({ fog: v })),
      ),
    )
    rows.push(
      settingsField(
        'depth slab',
        range(style.slab, 0.02, 1, 0.02, (v) => this.restyle({ slab: v })),
        'Keep only what lies within this fraction of the model’s reach of the centre of rotation, front and back — a way into a dense model. All the way right is everything.',
      ),
    )

    // Overlays: the names, the ruler, the centre.
    rows.push(
      settingsField(
        'show',
        row(
          toggleIcon('tag', style.labels ? 'Hide the sequence names (l)' : 'Show the sequence names (l)', style.labels, (on) => this.restyle({ labels: on })),
          toggleIcon('ruler', style.ruler ? 'Hide the genomic ruler' : 'Show the genomic ruler: a tick every step along each chain', style.ruler, (on) => this.restyle({ ruler: on })),
          toggleIcon('locate-fixed', style.axes ? 'Hide the centre and axes' : 'Show the centre and axes', style.axes, (on) => this.restyle({ axes: on })),
        ),
      ),
    )

    // Compare: another model on this one.
    const others = models.filter((held) => held.id !== this.entry?.id && held.status === 'ready')
    if (others.length > 0 || style.compare !== '') {
      const choices = [{ value: '', text: 'none' }, ...others.map((held) => ({ value: held.id, text: held.label }))]
      if (style.compare !== '' && !choices.some((choice) => choice.value === style.compare)) {
        choices.push({ value: style.compare, text: `${style.compare} (no longer in the list)` })
      }
      rows.push(
        settingsField(
          'compare with',
          select(choices, style.compare, (value) => this.restyle({ compare: value })),
          'Another structure row, aligned onto this one over the beads the two share and drawn in grey beside it; colour by displacement shows where they differ.',
        ),
      )
      const fit = style.compare === '' ? null : (this.overlayOf(structure ?? ({} as Structure), style), this.compared?.fit ?? null)
      if (style.compare !== '' && structure !== null) {
        rows.push(
          el('p', { class: 'clip-note structure-note-line', text: fit === null ? 'the two models share fewer than four beads' : `${fmt.int(fit.matched)} beads matched · RMSD ${fmt.num(fit.rmsd)} model units` }),
        )
      }
    }

    // Camera: presets, the turntable, framing. Block fields — the label above
    // the buttons — because three words and a toggle do not fit beside one.
    rows.push(
      blockField(
        'camera',
        row(
          button('front', () => this.lookFrom(0, 0), { class: 'btn btn-quiet', title: 'Look from the front' }),
          button('top', () => this.lookFrom(0, Math.PI / 2 - 0.01), { class: 'btn btn-quiet', title: 'Look from above' }),
          button('side', () => this.lookFrom(Math.PI / 2, 0), { class: 'btn btn-quiet', title: 'Look from the side' }),
          toggleIcon('rotate-cw', this.turning ? 'Stop the turntable (r)' : 'Turn the model slowly by itself (r)', this.turning, () => this.toggleTurning()),
        ),
      ),
    )
    rows.push(
      blockField(
        'frame',
        row(
          button('the window', () => this.frameLit(), { class: 'btn btn-quiet', title: 'Put the camera on what the maps are looking at (f)' }),
          button('everything', () => this.frameAll(), { class: 'btn btn-quiet', title: 'Put the camera on the whole model (a)' }),
        ),
      ),
    )

    // Measurements: the list, each removable.
    if (this.measures.length > 0) {
      const list = el('div', { class: 'structure-measures' })
      this.measures.forEach((pair, index) => {
        list.append(
          el(
            'div',
            { class: 'structure-measure-row' },
            el('span', { class: 'structure-measure-text', text: this.measureLine(pair) }),
            iconButton('x', 'Remove this measurement', () => {
              this.measures = this.measures.filter((_, at) => at !== index)
              this.paintSettings()
              this.schedule()
            }, { class: 'btn-close', size: 12 }),
          ),
        )
      })
      rows.push(el('div', { class: 'field field-block' }, el('span', { class: 'field-label', text: 'measurements' }), list))
    }

    rows.push(
      el(
        'div',
        { class: 'structure-export' },
        button('PNG', () => void this.savePng(), { class: 'btn btn-quiet', title: 'Save this picture at 300 dpi' }),
        button('PDF', () => void this.savePdf(), {
          class: 'btn btn-quiet',
          title: 'Save this picture as a PDF: beads and sticks as paths, a tube as a 300 dpi raster — a lit surface is not a path',
        }),
      ),
    )

    this.settingsEl.replaceChildren(
      cardTitle('3D structure', 'box', 'controls-title'),
      el('div', { class: 'panel-controls' }, ...rows),
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
    if (view.style.tube) {
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

