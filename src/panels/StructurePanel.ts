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

import { formatLocus } from '../genome/assembly'
import type { AnnotationEntry, StructureStyle, TrackSampleSet } from '../annotations/types'
import { STRUCTURE_COLOUR_DISPLACEMENT } from '../annotations/types'
export { STRUCTURE_COLOUR_DISPLACEMENT }
import {
  STRUCTURE_COLOUR_HAPLOTYPE,
  STRUCTURE_COLOUR_POSITION,
  STRUCTURE_COLOUR_SEQUENCE,
  STRUCTURE_OTHERS,
  structureOf,
} from '../annotations/types'
import type { AnnotationStore } from '../annotations/store'
import type { ManualStore } from '../annotations/manual'
import { describeMark, mintMarkId, type ManualMark } from '../annotations/manual'
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
import { rgbOf, usesRamp, TELOMERE_COLOUR } from '../structure/colour'
import type { ColourSource } from '../structure/colour'
import { COLORMAP_NAMES } from '../render/colormaps'
import { alignTo, displacements, placeStructure, type Alignment } from '../structure/align'
import { settingsField } from '../ui/laneSettings'
import { withKey, type Command } from '../ui/commands'
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
  viewFrame,
  type Camera,
} from '../structure/camera'
import { resolveColours, type BeadColours, type StructureKey } from '../structure/colour'
import {
  CELL_FRAME_WIDTH,
  PAPER_PALETTE,
  drawCellFrame,
  drawStructure,
  type StructureView,
} from '../structure/painter'
import {
  beadsAt,
  beadsIn,
  buildStructure,
  centroidOf,
  distanceBetween,
  lociOf,
  telomereBeads,
  type Structure,
} from '../structure/scene'
import type { RenderPalette, StructureRenderer } from '../structure/three'
import { STRUCTURE_DRAG_TYPE, button, dragHasStructure, el, fmt, trimNumber } from '../ui/dom'
import { cardTitle, icon, iconButton } from '../ui/icons'
import { readCanvasPalette } from '../ui/MatrixPanel'
import type { Modal } from '../ui/Modal'
import { stageDialog } from '../ui/StageDialog'
import {
  getPlotOptions,
  setPlotOption,
  PLOT_OPTION_ICONS,
  PLOT_OPTION_LABELS,
  STRUCTURE_OPTIONS,
  subscribePlotOptions,
  type PlotOptionKey,
} from '../ui/plotOptions'
import { setReadout } from '../ui/readout'
import { setHoverPlace, subscribeHoverPlace } from '../ui/hoverLocus'
import { publishTurn, subscribeTurn } from '../ui/turnLink'
import { dragHasFileRow, readFileDrag } from '../ui/fileDrag'
import { VectorPage } from '../ui/vector'
import {
  EXPORT_DPI_CHOICES,
  canvasToPng,
  copyPicture,
  copyPngToClipboard,
  chooseSaveTarget,
  fileStamp,
  scaleForDpi,
  type ExportFormat,
} from '../ui/export'
import { openMenu } from '../ui/Menu'
import { exportRow } from '../ui/exportRow'
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
  /**
   * The models this cell's **siblings** are drawing, so two cells do not fall
   * to the same one.
   *
   * The remembered choice is the deck's, not the cell's, and so is the
   * fallback to the first row — so a deck restored with two structure cells
   * had both of them draw the same model, which is two copies of one picture
   * where the link said two pictures.
   */
  taken?(): readonly string[]
  /**
   * Which structure cell this is, counting from the left — its **seat**.
   *
   * Everything this cell remembers is remembered under it (§25.3): the model
   * it draws and the camera it draws from. Without it the deck's several
   * structure cells wrote to one slot, so a deck of two views came back from a
   * reload as the same view twice — and a reader who put one model in two
   * cells to look at it two ways lost the second the moment they reloaded.
   *
   * Absent for a cell with no deck around it, which is seat 0.
   */
  seat?(): number
  /**
   * The shared preferences (§26.3) another card in **this column** already
   * offers — the Map card's, or the 1D browser's.
   *
   * What the cell needs is not *which view is this* but *what is already on
   * offer*, so the answer stays right when a card's own list changes: the
   * structure card fills the gap and never doubles a control. Absent is the
   * safe answer — nothing is offered elsewhere, so everything is offered here.
   */
  sharedElsewhere?(): readonly PlotOptionKey[]
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
  /**
   * The star pressed: make this the cell the settings card is about (§25.3).
   *
   * Absent for a cell with no deck around it, which has no sibling to be
   * starred instead of — the star is a choice between cells, and one cell is
   * not a choice.
   */
  onStar?(): void
  /**
   * How many structure cells a change on this cell's card is made to: every
   * one of them while none is starred (§25.3), and this one otherwise. Absent
   * is one, which is a cell with no deck around it.
   */
  together?(): number
  /** Every structure cell of the deck, this one included, for a card that sets them all. */
  forEachStructure?(act: (cell: StructurePanel) => void): void
}

/**
 * The part of a structure cell's props the **session** supplies, and the deck
 * passes through: the deck adds the cell's id, its memory key and the two
 * handlers that are about the grid (`panels/PanelDeck.ts`).
 */
export type StructureCellProps = Omit<
  StructurePanelProps,
  'id' | 'memoryKey' | 'seat' | 'onClose' | 'onDragChange' | 'onStar' | 'together' | 'forEachStructure'
>

/** Where a cell's camera is remembered in the session's memory. */
const CAMERA_SCOPE = 'structure:camera'

/**
 * A memory scope for **this seat** (§25.3).
 *
 * Seat 0 keeps the bare scope, so a reader whose deck had the one structure
 * cell there has always been opens it where they left it rather than at the
 * defaults: the first seat *is* what every session before seats wrote.
 */
function seatScope(scope: string, seat: number): string {
  return seat <= 0 ? scope : `${scope}:${seat}`
}

function clamp(value: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, value))
}
/*
 * The settings this cell reads that are **not** the row's own live in
 * `ui/plotOptions.ts` as {@link STRUCTURE_OPTIONS}, beside the matrix's and
 * the tracks' — which picture each preference is about is one question, and
 * that file is where it is answered. This module used to keep its own copy of
 * the list, which is a list that stops being the answer the day a fourth
 * preference is one the model honours.
 */

/** Where the enlarged dialog's sidebar width is kept, so a reader sets it once. */
const SIDE_SCOPE = 'structure:side'
/** Where this seat's own height is kept (§25.3), for a cell the reader has resized. */
const HEIGHT_SCOPE = 'structure:height'
/** Where *turn together* is kept for this seat (§25.3). */
const TURN_SCOPE = 'structure:turnWith'
/** The shortest a resized cell may be, in pixels — below this the picture is not one. */
const CELL_MIN_H = 120
/** The tallest, so a drag cannot push the rest of the page off the screen. */
const CELL_MAX_H = 2000
/** Where the row the cell was showing is remembered, so a reload draws the same model. */
const MODEL_SCOPE = 'structure:model'
/** The `loops as chords` choice that draws the reader's own arrowhead marks (§25.5). */
export const MANUAL_CHORDS = 'manual'
/** The colouring by each bead's distance to its bead in the compared model (§25.5). */
/**
 * What the model saves as, in the order the row offers it.
 *
 * PNG leads here and PDF leads beside a map, and the difference is what each
 * picture *is*: a contact map is a raster whatever the file it goes into, while
 * a model is beads and sticks, so the PDF is a drawing — except of a tube,
 * which is a lit surface no path can be. The label says nothing about that:
 * `PDF` is what the file is, and the caveat is one clause of the row's title.
 */
const STRUCTURE_EXPORT_FORMATS = [
  { value: 'png', label: 'PNG' },
  { value: 'pdf', label: 'PDF' },
] as const

/**
 * The letters this cell binds while it is enlarged, written once.
 *
 * `ui/commands.ts` holds the app's own keys; these are the model's, and they
 * exist only inside the dialog (§25.3). One table because each of them is
 * needed twice — by the command that binds it and by the control that prints
 * it — and a letter spelled by hand in two places is a letter that comes to be
 * printed where it is not bound.
 */
const STRUCTURE_KEYS = {
  frame: 'f',
  all: 'a',
  beads: '1',
  sticks: '2',
  tube: '3',
  labels: 'l',
  turntable: 'r',
} as const


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
  none: 'No structure loaded. Drop a g3d (text or binary), a .3dg or a bed3d here, or on the Structures card.',
  removed: 'The model this cell was showing was removed. Pick another on the Structures card.',
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
  private readonly nameEl: HTMLElement
  /**
   * The star (§25.3): which cell the *3D structure* card in the Aesthetics
   * column is about.
   *
   * A deck may hold several models, and the column holds **one** card — a
   * second copy of eighteen controls is a column nobody can read, and §26.3
   * wants a control offered once per column anyway. So the card follows a
   * cell the reader names, and this is how they name it. It used to be
   * whichever cell happened to be built first, which a reader with two models
   * discovers by dragging a slider and watching the *other* picture change.
   *
   * The same glyph and the same radio behaviour the maps' star has, because it
   * is the same idea: one of several pictures, singled out for something that
   * can only be about one of them.
   */
  private readonly starButton: HTMLButtonElement
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
  /** The corner legend (§25.4): a row per control, the live one lit. */
  private readonly modeEl = el('div', { class: 'structure-guide' })
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
  /** Re-titled on expand and collapse; see {@link paintKeys}. */
  private readonly frameButton: HTMLButtonElement
  /**
   * How fine and as what the model is saved, held across repaints.
   *
   * The card is rebuilt from the row's style whenever anything changes, so a
   * resolution kept in the row's own select would go back to its default the
   * next time a slider moved. The Export card's pair are the same two fields
   * for the same reason (`ui/MatrixPanel.ts`).
   */
  private exportDpi = 300
  private exportFormat: ExportFormat = 'png'
  /**
   * Whether a control of the card is mid-gesture, so the card holds still.
   *
   * Every write goes to the row's style, the store notifies, and {@link sync}
   * rebuilds the card from it — which mid-drag replaces the very slider the
   * hand is holding, so a drag moved the value one step and then stopped dead.
   * The lanes' own settings defer a rebuild for the same reason (a caret in a
   * box); here the gesture is a drag, and the slider keeps its own readout in
   * step while it lasts. Nothing else on this card can change under a drag of
   * one of its sliders.
   */
  private holdingSettings = false
  /**
   * What the last save or copy did, under the export row.
   *
   * One node, kept rather than rebuilt with the card: a save does not change
   * the style, so nothing repaints afterwards — but a repaint a moment later
   * for another reason must not take the line away.
   */
  private readonly exportNote = el('span', { class: 'clip-note export-note' })
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
  private rulerCache: { key: string; list: ReadonlyArray<{ bead: number; label: string }> } | null = null
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
  /** The telomeres of the model in hand: asked every frame, answered from the whole set. */
  private telomereCache: { key: string; from: Structure; beads: readonly number[] } | null = null
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
  /** How the built model was placed (§25.5), so a change to the mirrors or the frame rebuilds it. */
  private placedAs: string | null = null
  /** Whether this cell turns with the others that are turning together (§25.3). */
  private turnWith = false
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
    this.camera = cameraOf(recall<unknown>(props.memoryKey(), seatScope(CAMERA_SCOPE, props.seat?.() ?? 0)))
    // A span, not a read-only box. `.deck-name` frames itself on hover and
    // takes a caret on click, which is the rename control a map's name is
    // (§16.10) — and this name is the row's, changed on the Structures card.
    // Drawn as a box it invited a rename and then refused every keystroke.
    this.nameEl = el('span', {
      class: 'deck-name',
      text: 'structure',
      title: 'The session’s 3D model — renamed on its row in the Structures card',
    })
    this.starButton = iconButton('star', '', () => props.onStar?.(), {
      class: 'btn btn-icon deck-star structure-star',
      size: 14,
    })
    // Hidden where there is nothing to choose between: a deck with one model
    // has one card and one cell, and a radio with one option is a button that
    // does nothing. The deck shows it again when a second cell opens.
    this.paintStar(false)
    this.starButton.classList.toggle('hidden', props.onStar === undefined)
    this.measureButton = iconButton(
      'ruler',
      'Measure: drag from one bead to another for the distance between them, kept in the card',
      () => this.setMode('measure'),
      { class: 'btn btn-icon structure-measure', size: 14 },
    )
    // `maximize` is the mark the Map card's refit wears, and this is the same
    // act on the model: put the camera back on what is being looked at. It used
    // to be `scan`, a dashed square, which sat beside `maximize` on the button
    // that *enlarges* — two corner-bracket glyphs told apart only by hovering
    // them, one re-aiming a camera and the other opening a dialog.
    this.frameButton = iconButton('maximize', '', () => this.frameLit(), {
      class: 'btn btn-icon structure-frame',
      size: 14,
    })
    const expandButton = iconButton('expand', 'Enlarge the model, with every setting beside it', () => this.expand(), {
      class: 'btn btn-icon structure-expand',
      size: 14,
    })
    // Two buttons, not one mode that counts clicks: marking a place and
    // marking a loop are two things a reader means, and a mode where the first
    // click might be either is a mode whose first click cannot be undone by
    // stopping.
    this.markButton = iconButton(
      'map-pin',
      'Mark a bead: each click marks that bead’s locus, on every map and track',
      () => this.setMode('mark'),
      { class: 'btn btn-icon structure-select', size: 14 },
    )
    this.loopButton = iconButton(
      'link-2',
      'Mark a loop: click two beads for a loop between their loci, drawn as a chord',
      () => this.setMode('loop'),
      { class: 'btn btn-icon structure-loop', size: 14 },
    )
    this.wrap.append(
      this.labelsEl,
      this.keyEl,
      // The legend and the readout under it, as one column in the corner
      // rather than two things placed at two offsets (§25.4): the legend is
      // five rows or six depending on whether a mode is armed, so a readout
      // pinned below it by a number would sit on top of it half the time.
      el('div', { class: 'structure-topleft' }, this.modeEl, this.readoutEl),
      this.tipEl,
      el(
        'div',
        { class: 'structure-corner' },
        this.markButton,
        this.loopButton,
        this.measureButton,
        this.frameButton,
        expandButton,
      ),
    )
    this.paintMode()
    // Which paints the settings card too, since the card is where the other
    // two keys are printed.
    this.paintKeys()
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
    // The shared preferences this cell reads (`STRUCTURE_OPTIONS`).
    // It never heard them change: turning the key off on the Map card left the
    // model's key drawn until something else happened to repaint the cell.
    this.unsubscribes.push(
      subscribePlotOptions(() => {
        this.paintSettings()
        this.schedule()
      }),
    )
    // The cells turning together (§25.3). A follower takes the two angles and
    // nothing else: its own centre, zoom and projection are its own, which is
    // what makes two synced cells two *views* rather than one view drawn twice.
    this.turnWith = recall<unknown>(props.memoryKey(), this.seatScope(TURN_SCOPE)) === true
    this.unsubscribes.push(
      subscribeTurn((turn) => {
        if (!this.turnWith || turn.source === this.source) return
        if (turn.azimuth === this.camera.azimuth && turn.elevation === this.camera.elevation) return
        this.camera = { ...this.camera, azimuth: turn.azimuth, elevation: turn.elevation }
        // Remembered, not republished: the follower announcing the turn it was
        // just given is how two synced cells chase each other round the sphere.
        if (this.rememberTimer !== null) clearTimeout(this.rememberTimer)
        this.rememberTimer = window.setTimeout(() => {
          this.rememberTimer = null
          remember(this.props.memoryKey(), this.seatScope(CAMERA_SCOPE), this.camera)
        }, 300)
        this.schedule()
      }),
    )
    this.body = el('div', { class: 'deck-body structure-body' }, this.wrap, this.resizeGrip())
    this.el = el(
      'section',
      { class: 'deck-panel deck-structure' },
      el(
        'header',
        { class: 'deck-head' },
        this.grip(),
        this.nameEl,
        this.starButton,
        iconButton('x', 'Close the structure cell (the model stays loaded)', () => props.onClose(), {
          class: 'btn-close',
          size: 14,
        }),
      ),
      this.note,
      this.body,
    )
    // The height this seat was left at, where the reader has set one.
    const height = recall<unknown>(props.memoryKey(), this.seatScope(HEIGHT_SCOPE))
    if (typeof height === 'number' && Number.isFinite(height)) {
      this.setHeight(Math.round(clamp(height, CELL_MIN_H, CELL_MAX_H)))
    }
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
    if (this.nameEl.textContent !== label) this.nameEl.textContent = label
  }

  exportCanvas(dpi: number, _now: Date): HTMLCanvasElement | null {
    if (this.structure === null || this.renderer === null) return null
    const scale = scaleForDpi(dpi)
    const width = Math.max(1, this.wrap.clientWidth)
    const height = Math.max(1, this.wrap.clientHeight)
    const out = this.renderer.snapshot(width * scale, height * scale)
    // The cell's edge, which is what says where a model zoomed past it is cut
    // (§25.7) — at the map's plot border's weight at this resolution.
    const ctx = out?.getContext('2d') ?? null
    if (out !== null && ctx !== null) {
      drawCellFrame(
        ctx,
        { width: out.width, height: out.height },
        readCanvasPalette(this.el).plotBorderColor,
        Math.max(1, CELL_FRAME_WIDTH * scale),
      )
    }
    return out
  }

  /**
   * The cell's right-click menu: *copy this* — the model alone, as it is
   * drawn here, onto the clipboard (§7.2).
   */
  private showMenu(x: number, y: number): void {
    openMenu(x, y, [
      { label: 'This model' },
      {
        label: 'Copy this',
        hint: 'PNG',
        title:
          'The model as it is drawn here — the picture alone, with no key, buttons or frame — ' +
          'onto the clipboard as a PNG, at the screen’s resolution',
        run: () => copyPicture('model', this.modelImage()),
      },
    ])
  }

  /**
   * The model as it is drawn on screen, and nothing round it: the renderer's
   * own picture at the screen's density — its names on the model, as the
   * overlays have them — without the centre of rotation, the key, the corner's
   * buttons, the readout or the frame an exported figure carries (§25.7).
   * `null` with no model.
   */
  private modelImage(): HTMLCanvasElement | null {
    if (this.structure === null || this.renderer === null) return null
    const dpr = window.devicePixelRatio > 0 ? window.devicePixelRatio : 1
    return this.renderer.snapshot(
      Math.max(1, this.wrap.clientWidth) * dpr,
      Math.max(1, this.wrap.clientHeight) * dpr,
      { centre: false },
    )
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
    remember(this.props.memoryKey(), this.seatScope(MODEL_SCOPE), id)
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
      const remembered = recall<unknown>(this.props.memoryKey(), this.seatScope(MODEL_SCOPE))
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
    // The first row no sibling is already drawing, where this cell has no
    // choice of its own: two cells falling to the same model is one picture
    // drawn twice.
    const taken = new Set(this.props.taken?.() ?? [])
    const free = rows.find((held) => !taken.has(held.id))
    const entry = emptied ? null : (chosenRow ?? free ?? rows[0] ?? null)
    if (emptied) {
      this.chosen = null
      remember(this.props.memoryKey(), this.seatScope(MODEL_SCOPE), null)
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
      const style = structureOf(entry.style)
      // A colouring read off another row — a track's values, a feature set's
      // colours — is stale the moment the list changes under it.
      this.colours = null
      this.chords = null
      // How the reader has **placed** this model (§25.5): reflected, turned
      // into another model's frame, or neither. Part of what the scene is
      // built from, not something done to it afterwards, because every road
      // out of here reads the built coordinates — picking a bead, measuring
      // between two, the labels, the vector export. A mirror applied at the
      // camera would flip the picture and leave the numbers under it describing
      // a model nobody is looking at.
      const placement = this.placementOf(style)
      const placed = `${style.mirrorX ? 'x' : ''}${style.mirrorY ? 'y' : ''}|${style.align}|${placement.onto?.set.length ?? 0}`
      if (this.builtFrom !== payload.data || this.placedAs !== placed) {
        const switched = this.builtRow !== null && this.builtRow !== entry.id
        // A move into another model's frame carries the model's own units with
        // it, so the camera that framed it where it was shows a corner of it
        // where it has gone; a reflection leaves it the same size in the same
        // place and is watched in place.
        const moved = this.placedAs !== null && this.placedAs.split('|')[1] !== style.align
        const raw = buildStructure(payload.data)
        this.structure = raw === null ? null : placeStructure(raw, placement)
        this.placedAs = placed
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
        if (switched || moved || recall<unknown>(this.props.memoryKey(), this.seatScope(CAMERA_SCOPE)) === null) {
          this.frameAll()
        }
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
   * A title with its key, where the key is bound.
   *
   * The same gate {@link commands} puts on the bindings themselves: a letter
   * reaches the model only while it is enlarged, so a card beside a deck that
   * printed “(f)” was offering a key that folds the Files panel instead. And
   * one form for it — `withKey`'s — rather than the three the cell used to
   * carry: “(m, enlarged)” in the corner, “(f)” on the card, “(F)” everywhere
   * else in the app. Re-read on every expand and collapse ({@link paintKeys}).
   */
  private keyed(text: string, binding: string): string {
    return withKey(text, this.expanded === null ? undefined : binding)
  }

  /**
   * Write the titles that name a key, now that the gate has moved.
   *
   * The corner's frame button and the card's camera row are the two places a
   * key is printed outside the palette, and both are built once and then
   * hovered much later — so they are re-titled when the dialog opens and
   * closes rather than trusted to be rebuilt.
   */
  private paintKeys(): void {
    this.frameButton.title = this.keyed('Frame what the maps are looking at', STRUCTURE_KEYS.frame)
    this.paintSettings()
  }

  /**
   * What the cell can be told to do, with a key each (§25.3): listed in the
   * palette and bound through it, like every other command of the app.
   */
  commands(): Command[] {
    const style = this.style()
    const has = this.structure !== null
    // The state as a chip the palette and the shortcuts dialog draw, not as a
    // parenthesis in the title: "Beads (on)" is a third convention for one kind
    // of thing — beside the overlays' nouns and the panels' — and typing
    // "beads" gave a row that looked unlike every other switch in the list
    // (§26.4). It is also a title that would change under a reader looking at a
    // dialog that does not repaint.
    const on = (flag: boolean): 'on' | 'off' => (flag ? 'on' : 'off')
    // **A key only while the model is enlarged.** These are single letters, and
    // the app's own are too: `f` folds the Files panel, `a` the Annotations
    // panel. A structure cell sits *beside* a map, and its commands come first
    // in the palette's list, so binding them there took those letters away from
    // the panels for as long as a model was on screen. In the dialog the model
    // is the whole window and there is nothing else the letter could mean, so
    // that is where they are bound; the palette lists them either way, which is
    // how they are reached from the cell.
    //
    // **And the three modes have none at all** (§25.4): a bare letter that arms
    // a mode is a letter pressed by accident while the pointer happens to be
    // over the model, which is true in the dialog above all — the model is the
    // whole window there. `e`, `o` and `m` also each belonged to something else
    // (breaks, a new tab, the Aesthetics panel), so the shortcuts dialog
    // printed two rows for one letter and the reader could not tell which it
    // would do. They are pressed on the buttons, in the corner or on the card.
    const key = (binding: string): { keys?: string } => (this.expanded === null ? {} : { keys: binding })
    return [
      { id: 'structure-frame', group: 'Structure', title: 'Frame what the maps are looking at', ...key(STRUCTURE_KEYS.frame), enabled: has, run: () => this.frameLit() },
      { id: 'structure-all', group: 'Structure', title: 'Show the whole model', ...key(STRUCTURE_KEYS.all), enabled: has, run: () => this.frameAll() },
      { id: 'structure-beads', group: 'Structure', title: 'Beads', state: on(style.beads), ...key(STRUCTURE_KEYS.beads), enabled: has, run: () => this.restyle({ beads: !this.style().beads }) },
      { id: 'structure-sticks', group: 'Structure', title: 'Sticks', state: on(style.sticks), ...key(STRUCTURE_KEYS.sticks), enabled: has, run: () => this.restyle({ sticks: !this.style().sticks }) },
      { id: 'structure-tube', group: 'Structure', title: 'Tube', state: on(style.tube), ...key(STRUCTURE_KEYS.tube), enabled: has, run: () => this.restyle({ tube: !this.style().tube }) },
      { id: 'structure-labels', group: 'Structure', title: 'Sequence names', state: on(style.labels), ...key(STRUCTURE_KEYS.labels), enabled: has, run: () => this.restyle({ labels: !this.style().labels }) },
      { id: 'structure-select', group: 'Structure', title: 'Mark a bead', state: on(this.mode === 'mark'), hint: 'Each click marks that bead’s locus', enabled: has, run: () => this.setMode('mark') },
      { id: 'structure-loop', group: 'Structure', title: 'Mark a loop', state: on(this.mode === 'loop'), hint: 'Click two beads for a loop between their loci', enabled: has, run: () => this.setMode('loop') },
      { id: 'structure-measure', group: 'Structure', title: 'Measure', state: on(this.mode === 'measure'), hint: 'Drag from one bead to another for the distance between them', enabled: has, run: () => this.setMode('measure') },
      { id: 'structure-turn', group: 'Structure', title: 'Turntable', state: on(this.turning), hint: 'The model turns slowly by itself', ...key(STRUCTURE_KEYS.turntable), enabled: has, run: () => this.toggleTurning() },
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

  /**
   * The legend in the top-left corner: what the hand can do, and what it is
   * doing (§25.4).
   *
   * It was one chip naming the current gesture, which told a reader who
   * already knew the keys which key they were holding and told everybody else
   * nothing: that a drag turns the model, that Shift moves it, that ⌘ puts
   * the centre somewhere and that Space and the wheel are the fog were four
   * facts discoverable only by pressing things. So the chip became the list it
   * was the last line of — one row per control, the key on the left and what
   * it does on the right — and **the row that is live is lit**, which is the
   * chip's whole job kept.
   *
   * A **readout and not a control**, as it always was: `pointer-events: none`,
   * no borders, the translucent backing the map's key has. Pressing a row does
   * nothing, because what it names is a key, and the reader's hand is already
   * where it needs to be.
   */
  private paintMode(): void {
    const centreKey = CENTRE_KEY === 'Meta' ? '⌘' : 'Ctrl'
    // The sticky modes first, where one is armed: it is a state the cell is
    // *in* rather than a key being held, and while it runs a click does that
    // and not what the rows below describe.
    const armed = this.mode === 'measure'
      ? { key: 'drag', text: 'measure', title: 'Drag from one bead to another for the distance between them; Esc to cancel' }
      : this.mode === 'mark'
        ? { key: 'click', text: 'mark', title: 'Click a bead to mark its locus on every map and track' }
        : this.mode === 'loop'
          ? { key: 'click', text: 'loop', title: 'Click two beads for a loop between their loci; Esc to cancel' }
          : null
    const controls: Array<{ key: string; text: string; title: string }> = [
      { key: 'drag', text: 'turn', title: 'Drag to turn the model — neither angle stops' },
      { key: 'scroll', text: 'zoom', title: 'The wheel brings the model closer or takes it away' },
      { key: '⇧', text: 'move', title: 'Hold Shift and drag to move the whole model' },
      {
        key: centreKey,
        text: 'centre',
        title:
          `Hold ${centreKey} and click a bead to turn about it — the axes replant along this view. ` +
          `Tap ${centreKey} alone to show or hide the centre.`,
      },
      { key: 'space', text: 'fog', title: 'Hold Space and scroll to bring the fog forward or push it back' },
    ]
    // Which row is live. A sticky mode wins over a held key, because that is
    // what the click will do.
    const live = armed !== null
      ? armed.text
      : this.keys.centre
        ? 'centre'
        : this.keys.shift
          ? 'move'
          : this.keys.space
            ? 'fog'
            : 'turn'
    const rows = armed === null ? controls : [armed, ...controls]
    this.modeEl.replaceChildren(
      ...rows.map((control) => {
        const on = control.text === live
        // The lit row carries `structure-mode`, which is the class the badge
        // had and the name the stylesheet accents by: the chip did not go
        // away, it moved into the list it now heads.
        const node = el(
          'div',
          { class: `structure-guide-row${on ? ' structure-mode is-on' : ''}`, title: control.title },
          el('kbd', { class: 'structure-guide-key', text: control.key }),
          el('span', { class: 'structure-guide-what', text: control.text }),
        )
        if (on) node.dataset['mode'] = control.text
        return node
      }),
    )
    this.modeEl.dataset['mode'] = live
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
    setReadout(`${formatLocus(at)}   drag to a second bead, or click one, to measure to it`)
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

  /** `IV:1,000,001-1,005,000 → IV:1,200,001-1,205,000 · 3.21 apart · 200 kb along` */
  private measureLine([a, b]: readonly [number, number]): string {
    const structure = this.structure
    if (structure === null) return ''
    const la = lociOf(structure, a)
    const lb = lociOf(structure, b)
    const d = distanceBetween(structure, a, b)
    const along =
      la.contig === lb.contig ? `${fmt.bp(Math.abs((la.start + la.end) / 2 - (lb.start + lb.end) / 2))} along` : 'across sequences'
    return `${formatLocus(la)} → ${formatLocus(lb)} · ${fmt.num(d)} apart · ${along}`
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
      setReadout(`${formatLocus(at)}   click a second bead for the loop, Esc to cancel`)
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

  /**
   * How this model is placed (§25.5): the mirrors, and the model it is turned
   * into the frame of, built where there is one.
   *
   * The other model is built from its own row and thrown away — it is a frame
   * to be read against, not a picture: `compare with` is the control that
   * *draws* it, and the two are deliberately separate. A reader asking whether
   * two folds are the same wants them in one frame; a reader asking where they
   * differ wants both on screen. Asking one control to do both put a second
   * model in the picture of everybody who only wanted the first.
   */
  private placementOf(style: StructureStyle): { mirrorX: boolean; mirrorY: boolean; onto: Structure | null } {
    const mirrors = { mirrorX: style.mirrorX, mirrorY: style.mirrorY }
    if (style.align === '' || style.align === this.entry?.id) return { ...mirrors, onto: null }
    const entry = this.props.store()?.entries.find((row) => row.id === style.align)
    const payload = entry?.payload
    if (payload === undefined || payload.kind !== 'features' || payload.data.model === undefined) {
      return { ...mirrors, onto: null }
    }
    return { ...mirrors, onto: buildStructure(payload.data) }
  }

  /** Turn with the other cells that are, or stop (§25.3). */
  private setTurnWith(on: boolean): void {
    this.turnWith = on
    remember(this.props.memoryKey(), this.seatScope(TURN_SCOPE), on)
    // Pressed *on*, this cell leads: the others come round to it, which is the
    // only reading that does not depend on which cell is touched next.
    if (on) publishTurn({ azimuth: this.camera.azimuth, elevation: this.camera.elevation, source: this.source })
    this.paintSettings()
  }

  /**
   * Lay the centre's axes along this view (§25.5).
   *
   * **Neither the model nor the centre moves.** What changes is the frame the
   * arms are drawn in: x across the screen, y up it, z out of it, as they are
   * at the moment this is pressed. Afterwards every turn is read against that
   * view — which is the question a reader asks of a gizmo, *how far have I
   * come from where I was looking* — rather than against the axes the file
   * was written in, which mean nothing to anybody by the time a model has been
   * turned twice.
   */
  private replantAxes(): void {
    this.restyle({ axes: true, axesFrame: viewFrame(this.camera) })
  }

  /**
   * Fill or empty this cell's star (§25.3).
   *
   * A filled star is **live**, as the maps' is: pressing it leaves no cell
   * starred, and the card then sets every structure cell at once. The card is
   * repainted either way, since whether it says so is decided here.
   */
  setStarred(on: boolean): void {
    this.paintStar(on)
    this.paintSettings()
  }

  private paintStar(on: boolean): void {
    this.starButton.classList.toggle('is-on', on)
    this.starButton.setAttribute('aria-pressed', String(on))
    this.starButton.title = on
      ? 'The 3D structure card sets this cell. Click to unstar — the card then sets every structure.'
      : 'Star this cell: the 3D structure card then sets it alone.'
  }

  /** How many cells this cell's card is setting now; see {@link StructurePanelProps.together}. */
  private togetherCount(): number {
    return this.props.forEachStructure === undefined ? 1 : Math.max(1, this.props.together?.() ?? 1)
  }

  /**
   * Do one thing the card asks to every cell it is setting — this one alone,
   * or every structure cell while none is starred (§25.3).
   */
  private each(act: (cell: StructurePanel) => void): void {
    if (this.togetherCount() > 1 && this.props.forEachStructure !== undefined) {
      this.props.forEachStructure(act)
      return
    }
    act(this)
  }

  /** Write one control's value onto every row the card is setting. */
  private restyleAll(patch: Partial<StructureStyle>): void {
    this.each((cell) => cell.restyle(patch))
  }

  /** Start or stop the turntable, to a state rather than a flip. */
  private setTurning(on: boolean): void {
    if (this.turning !== on) this.toggleTurning()
  }

  /**
   * Whether this cell offers a star at all — a deck of one model does not.
   *
   * The card is repainted when that changes, since its line naming the starred
   * cell is there exactly while the star is ({@link cardFor}).
   */
  showStar(on: boolean): void {
    const was = !this.starButton.classList.contains('hidden')
    this.starButton.classList.toggle('hidden', !on)
    if (was !== on) this.paintSettings()
  }

  /**
   * The line under the card's title that says which cell it sets (§25.3).
   *
   * `★ Yeast_structure` for the starred cell — the name its own heading
   * wears, so the two are read as one — and `every structure — all 3` while
   * none is starred. The *Map* card's line, in its classes and its words.
   */
  private cardFor(together: number): HTMLElement[] {
    if (together > 1) {
      return [
        el(
          'p',
          {
            class: 'map-card-for is-every structure-card-for',
            title: 'No structure is starred, so a change here is made to every structure cell. Star one to set it alone.',
          },
          icon('star', { size: 12, class: 'map-card-star' }),
          el('span', { text: `every structure — all ${together}` }),
        ),
      ]
    }
    const starred = !this.starButton.classList.contains('hidden') && this.starButton.classList.contains('is-on')
    if (!starred) return []
    const name = this.entry?.label ?? 'structure'
    return [
      el(
        'p',
        {
          class: 'map-card-for structure-card-for',
          title: `This card sets ${name}, the starred structure. Star another cell to set that one instead.`,
        },
        icon('star', { size: 12, class: 'map-card-star is-on' }),
        el('span', { text: name }),
      ),
    ]
  }

  /** This seat's memory scope (§25.3), for whatever this cell remembers. */
  private seatScope(scope: string): string {
    return seatScope(scope, this.props.seat?.() ?? 0)
  }

  /**
   * The bar under the picture that sets this cell's height (§25.3).
   *
   * A structure cell used to be as tall as the row gave it and no taller,
   * which is right in a row *beside* a map — the cells line up — and wrong in
   * a column **under** one: a deck one across put the model in a 16 rem band
   * under a map that could be shrunk to a thumbnail, and nothing the reader
   * did to either of them gave the model any more room. A model has no axis to
   * line up with the map's, so it is the one cell whose height is nobody's
   * business but the reader's.
   *
   * The height is written as a property on the *cell*, not as a style on the
   * picture, because the picture is lent to the enlarged dialog and back: an
   * inline height would follow it in and hold the model to 300 pixels in the
   * middle of a full-screen stage.
   */
  private resizeGrip(): HTMLElement {
    const grip = el('div', {
      class: 'structure-resize',
      attrs: { role: 'separator', 'aria-orientation': 'horizontal', tabindex: '0' },
      title: 'Drag to make this cell taller or shorter · double-click to fit the row again',
    })
    const setTo = (height: number | null): void => {
      this.setHeight(height)
      remember(this.props.memoryKey(), this.seatScope(HEIGHT_SCOPE), height)
    }
    grip.addEventListener('pointerdown', (event) => {
      grip.setPointerCapture(event.pointerId)
      grip.classList.add('is-dragging')
      event.preventDefault()
      const from = this.wrap.getBoundingClientRect()
      const heightAt = (clientY: number): number =>
        Math.round(clamp(clientY - from.top, CELL_MIN_H, CELL_MAX_H))
      const move = (moved: PointerEvent): void => this.setHeight(heightAt(moved.clientY))
      const up = (ended: PointerEvent): void => {
        grip.removeEventListener('pointermove', move)
        grip.removeEventListener('pointerup', up)
        grip.classList.remove('is-dragging')
        if (grip.hasPointerCapture(ended.pointerId)) grip.releasePointerCapture(ended.pointerId)
        setTo(heightAt(ended.clientY))
      }
      grip.addEventListener('pointermove', move)
      grip.addEventListener('pointerup', up)
    })
    // Back to the row's own height, which is the state there is no other way
    // out of once a height has been set.
    grip.addEventListener('dblclick', () => setTo(null))
    grip.addEventListener('keydown', (event) => {
      const step = event.key === 'ArrowUp' ? -24 : event.key === 'ArrowDown' ? 24 : 0
      if (step === 0) return
      event.preventDefault()
      setTo(Math.round(clamp(this.wrap.getBoundingClientRect().height + step, CELL_MIN_H, CELL_MAX_H)))
    })
    return grip
  }

  /** Hold the picture at `height` pixels, or give it back to the row. */
  private setHeight(height: number | null): void {
    if (height === null) {
      this.el.classList.remove('has-height')
      this.el.style.removeProperty('--structure-h')
    } else {
      this.el.classList.add('has-height')
      this.el.style.setProperty('--structure-h', `${height}px`)
    }
    this.remeasure()
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
    pos.textContent = `${fmt.int(at.start + 1)}-${fmt.int(at.end)}`
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
      `${formatLocus(first)}` +
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
      `${formatLocus(at)}` +
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
      // A right press that did not travel is the cell's menu (§7.2). On the
      // release rather than on `contextmenu`, which some systems send on the
      // press — and a right drag pans the model, so the menu can only know it
      // was asked for once the hand has let go where it began.
      if (event.button === 2) {
        this.showMenu(event.clientX, event.clientY)
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
        // …and the axes are replanted along this view (§25.5). A centre put
        // somewhere new is a reader saying *read the model from here*, and
        // arms left pointing along the frame the file happened to be written
        // in answer a question nobody asked. The one gesture sets both, which
        // is why there is no second thing to remember to press.
        this.replantAxes()
        this.schedule()
        return
      }
      if (this.mode === 'mark') {
        this.markAt(bead)
        const at = lociOf(model, bead)
        setReadout(`${formatLocus(at)}   marked`)
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
    // A **row of the Structures card**, dragged onto this cell: draw that model
    // here (§25.3). The same gesture an empty cell takes, and it has to be
    // taken by a full one too — the second view of a model is asked for by
    // dragging its row onto the cell that is to hold it, and a cell that
    // ignored the drop left the reader with the grip, the drop shadow and
    // nothing happening. A cell already drawing it is not a reason to refuse:
    // two cells of one model are two views of it.
    const model = (event: DragEvent): string => event.dataTransfer?.getData(STRUCTURE_DRAG_TYPE) ?? ''

    this.wrap.addEventListener('dragover', (event) => {
      if (event.dataTransfer?.types.includes(DECK_DRAG_TYPE)) return
      event.preventDefault()
      if (dragHasStructure(event) && event.dataTransfer !== null) event.dataTransfer.dropEffect = 'copy'
      this.wrap.classList.add('is-over')
    })
    this.wrap.addEventListener('dragleave', () => this.wrap.classList.remove('is-over'))
    this.wrap.addEventListener('drop', (event) => {
      this.wrap.classList.remove('is-over')
      if (event.dataTransfer?.types.includes(DECK_DRAG_TYPE)) return
      // Before the file road, which a drag from the card has no file for.
      const row = model(event)
      if (row !== '') {
        event.preventDefault()
        event.stopPropagation()
        this.showModel(row)
        return
      }
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
    // The cells turning with this one, before the write: a follower should be
    // round to the same face while the drag is still going, not 300 ms after
    // it stops.
    if (this.turnWith) {
      publishTurn({ azimuth: this.camera.azimuth, elevation: this.camera.elevation, source: this.source })
    }
    if (this.rememberTimer !== null) clearTimeout(this.rememberTimer)
    this.rememberTimer = window.setTimeout(() => {
      this.rememberTimer = null
      remember(this.props.memoryKey(), this.seatScope(CAMERA_SCOPE), this.camera)
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
    const colourKey = `${style.colourBy}|${JSON.stringify(style.sequenceColours)}|${style.marksHidden.join(',')}`
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
      // The measurement being made, drawn with the ones already made: the
      // line follows the pointer from the bead the press landed on, so a drag
      // shows what it is about to measure rather than what it measured.
      measures:
        this.measureFirst >= 0 && this.hovered.length > 0 && this.hovered[0] !== this.measureFirst
          ? [...this.measures, [this.measureFirst, this.hovered[0]] as const]
          : this.measures,
      marks: this.markedBeads(structure, style),
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
  private markedBeads(structure: Structure, style: StructureStyle): ReadonlyArray<{ bead: number; colour: string }> {
    const marks = this.props.manual?.()?.marks ?? []
    const out: Array<{ bead: number; colour: string }> = []
    // The telomeres first, so a place the reader marked themselves is drawn
    // over one this found: their own mark is the one they are looking for.
    if (style.telomeres) {
      for (const bead of this.telomeres(structure)) out.push({ bead, colour: TELOMERE_COLOUR })
    }
    for (const mark of marks) {
      if (mark.kind !== 'line') continue
      for (const bead of beadsAt(structure, mark.at.contig, mark.at.bp)) out.push({ bead, colour: mark.colour })
    }
    return out.length === 0 ? NO_MARKS : out
  }

  /**
   * The beads at a chain end, cached against the model, because it is asked on
   * every frame and answers from the whole set.
   */
  private telomeres(structure: Structure): readonly number[] {
    const key = `${structure.set.length}|${structure.contigs.join(',')}`
    if (this.telomereCache?.key !== key || this.telomereCache.from !== structure) {
      const beads = telomereBeads(structure)
      this.telomereCache = { key, from: structure, beads }
    }
    return this.telomereCache.beads
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
      return marksSource(structure, this.props.manual?.()?.marks ?? [], new Set(this.style().marksHidden))
    }
    if (by === STRUCTURE_COLOUR_DISPLACEMENT) {
      // The overlay first, so the alignment exists; then each bead's distance
      // to its bead in the compared model, on a ramp.
      this.overlayOf(structure, this.style())
      const fit = this.compared?.fit ?? null
      if (fit === null) return { label: 'displacement — choose a model to compare with' }
      return { label: 'displacement', values: displacements(structure, fit), colormap: 'viridis' }
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
    this.samples.revise([entry])
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
    const manual = this.props.manual?.()
    if (this.style().colourBy === STRUCTURE_COLOUR_MARKS && manual !== undefined) {
      this.paintMarksKey(manual.marks)
      return
    }
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

  /**
   * The key of *colour by manual annotations* (§25.5): a row per mark, as the
   * sequence key has a row per sequence, with the same three gestures — the
   * swatch is the mark's colour, a click on its name takes it off the model's
   * colouring, a double-click shows it alone.
   *
   * The colour is the **mark's**, written to the marks' own store: the Manual
   * annotations card lists the same marks and repaints from the same store, so
   * a colour picked here is the colour there, and on every map. What a click
   * hides is the model's colouring only, kept in its style — the mark is still
   * drawn wherever it was put, and a key that deleted it would be a second ×.
   */
  private paintMarksKey(marks: readonly ManualMark[]): void {
    this.keyEl.classList.remove('hidden')
    this.keyEl.append(el('span', { class: 'structure-key-title', text: 'manual annotations' }))
    if (marks.length === 0) {
      this.keyEl.append(
        el('span', {
          class: 'structure-key-empty',
          text: 'No marks yet: draw them on the Manual annotations card, or on the model.',
        }),
      )
      return
    }
    const style = this.style()
    const hidden = new Set(style.marksHidden)
    for (const mark of marks.slice(0, 48)) this.keyEl.append(this.markChip(mark, marks, hidden))
  }

  /** One mark's row on the key — see {@link paintMarksKey}. */
  private markChip(mark: ManualMark, marks: readonly ManualMark[], hidden: ReadonlySet<string>): HTMLElement {
    const name = describeMark(mark)
    const off = hidden.has(mark.id)
    const swatch = el('input', {
      class: 'structure-key-swatch',
      type: 'color',
      value: mark.colour,
      title: `Colour for ${name}, on every map and on the Manual annotations card too`,
    })
    swatch.addEventListener('click', (event) => event.stopPropagation())
    swatch.addEventListener('input', () => this.props.manual?.()?.update(mark.id, { colour: swatch.value }))
    const button = el('button', {
      class: 'structure-key-name',
      type: 'button',
      text: name,
      title: off
        ? `${name} is off the model: click to colour it again; double-click to show it alone`
        : `Click to take ${name} off the model's colouring; double-click to show it alone`,
    })
    button.addEventListener('click', () => {
      if (this.keyClickTimer !== null) clearTimeout(this.keyClickTimer)
      this.keyClickTimer = window.setTimeout(() => {
        this.keyClickTimer = null
        const next = new Set(hidden)
        if (next.has(mark.id)) next.delete(mark.id)
        else next.add(mark.id)
        this.restyle({ marksHidden: [...next] })
      }, 220)
    })
    button.addEventListener('dblclick', () => {
      if (this.keyClickTimer !== null) clearTimeout(this.keyClickTimer)
      this.keyClickTimer = null
      const others = marks.filter((other) => other.id !== mark.id).map((other) => other.id)
      const alreadySolo = others.length > 0 && others.every((id) => hidden.has(id)) && !hidden.has(mark.id)
      // Alone again is "all back", as on the sequence key.
      this.restyle({ marksHidden: alreadySolo ? [] : others })
    })
    return el(
      'span',
      { class: `structure-key-level structure-key-seq structure-key-mark${off ? ' is-off' : ''}` },
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
          title: `${formatLocus(mark)}`,
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
    // The letters reach the model now, so the titles that name them say so —
    // the corner's frame button and, through it, the card's camera row. The
    // settings are repainted too, because the borrowed row is drawn only while
    // the dialog is up.
    this.paintKeys()
    this.paintSettings()
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
    this.paintKeys()
    this.paintSettings()
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
    if (this.holdingSettings) return
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
      node.addEventListener('input', () => {
        // The card holds still for the length of the write; see
        // {@link holdingSettings}.
        this.holdingSettings = true
        try {
          onChange(Number(node.value))
        } finally {
          this.holdingSettings = false
        }
      })
      return node
    }
    const toggleIcon = (
      name: Parameters<typeof icon>[0],
      title: string,
      on: boolean,
      onChange: (on: boolean) => void,
      // A class of its own where the control is one a test or a script has to
      // find by name; the toggle's own classes are always there too.
      options?: { class?: string },
    ): HTMLElement => {
      const extra = options?.class === undefined ? '' : ` ${options.class}`
      const node = iconButton(name, title, () => onChange(!on), {
        class: `btn btn-icon btn-toggle structure-toggle${extra}`,
        size: 15,
      })
      node.setAttribute('aria-pressed', String(on))
      return node
    }
    const row = (...nodes: HTMLElement[]): HTMLElement => el('div', { class: 'plot-icon-row' }, ...nodes)
    /**
     * A label and its select **on one line**, wherever the line has room.
     *
     * They were block fields — label above, control below — on the argument
     * that the label column leaves a select about seven characters wide and
     * turns `Yeast_structure` into `Yeast_str`. True in a 200-pixel Aesthetics
     * column and false in the enlarged dialog's sidebar, which is twice that;
     * and a column of eleven two-line fields is a sidebar nobody can see the
     * bottom of. So the row is one line and the *card* decides: a container
     * query in the stylesheet drops these to two lines below the width where
     * the value stops being legible, and nowhere above it.
     */
    /** A row of buttons, which needs the whole width, so its label sits above. */
    const buttonField = (label: string, control: HTMLElement, hint?: string): HTMLElement =>
      el('label', { class: 'field ann-field field-block', title: hint ?? '' }, el('span', { class: 'field-label', text: label }), control)
    const pickField = (label: string, control: HTMLElement, hint?: string): HTMLElement =>
      el('label', { class: 'field ann-field structure-field-pick', title: hint ?? '' }, el('span', { class: 'field-label', text: label }), control)
    /**
     * A label, the control that arms a thing, and the number that shapes it,
     * on one row.
     *
     * A toggle with nothing beside it leaves two thirds of its row empty and
     * puts its own slider on the next one, under a second label that repeats
     * what the toggle just said — *fog* then *fog depth*, *pin contacts* then
     * *threshold*. One row says both: what is on, and how much.
     */
    const armedField = (
      label: string,
      arm: HTMLElement,
      value: number,
      bounds: { min: number; max: number; step: number },
      onChange: (v: number) => void,
      options: { hint?: string; disabled?: string } = {},
    ): HTMLElement => {
      const note = el('span', { class: 'clip-note structure-value', text: trimNumber(value, 2) })
      const input = range(value, bounds.min, bounds.max, bounds.step, (next) => {
        note.textContent = trimNumber(next, 2)
        onChange(next)
      })
      input.disabled = options.disabled !== undefined
      return el(
        'div',
        { class: 'field ann-field structure-field-armed', title: options.disabled ?? options.hint ?? '' },
        el('span', { class: 'field-label', text: label }),
        arm,
        row(input, note),
      )
    }
    /**
     * A bounded fraction, with the number it is at printed beside it.
     *
     * Six of these used to be bare `<input type=range>`s, and a bead radius
     * with no number on it is a figure nobody can reproduce — not in a second
     * session, and not in a methods section. The readout is the shape
     * `textScaleField` already draws: the value after the control, dim, and
     * written as the slider moves rather than on release.
     *
     * On a labelled row of its own where the slider is the whole setting.
     * Where it only shapes something a toggle or a select arms — the fog, the
     * ghost, the contact chords — the two share one row ({@link armedField}),
     * because two rows there is one setting under two labels.
     */
    const sliderField = (
      label: string,
      value: number,
      bounds: { min: number; max: number; step: number },
      onChange: (v: number) => void,
      options: { hint?: string; disabled?: string } = {},
    ): HTMLElement => {
      const note = el('span', { class: 'clip-note structure-value', text: trimNumber(value, 2) })
      const input = range(value, bounds.min, bounds.max, bounds.step, (next) => {
        note.textContent = trimNumber(next, 2)
        onChange(next)
      })
      // Greyed with its reason in the title, never greyed silently (§8.5).
      input.disabled = options.disabled !== undefined
      return settingsField(label, row(input, note), options.disabled ?? options.hint)
    }
    const rows: HTMLElement[] = []
    // **Every cell at once**, while no structure is starred (§25.3). The rows
    // that are about *this* cell's identity — which model it draws, which it is
    // compared with or turned into the frame of — and the two that act on its
    // one picture, the measurements and the export, are not offered then: one
    // model compared with itself, or one file saved for five pictures, is not
    // a setting that can be made to all of them.
    const together = this.togetherCount()
    const alone = together === 1

    // No *structure* picker. Which cell this card sets is said under its
    // title, as the Map card says it (see below); which model a cell draws is
    // the Structures card's to decide — its eye opens a cell for a row, and a
    // row dragged onto a cell swaps that cell's model in place. A dropdown
    // here was a third way to say the second thing, in the place where a
    // reader looks for the first.
    const models = (store?.entries ?? []).filter((held) => held.kind === 'structure')

    // Compare: another model on this one. Second, beside the picker, because
    // these are the two selects that decide *which models are on screen* — and
    // because `colour by: displacement` below is measured against this one, so
    // offering the colouring first was offering a reading of nothing.
    const others = models.filter((held) => held.id !== this.entry?.id && held.status === 'ready')
    if (alone && (others.length > 0 || style.compare !== '')) {
      const choices = [{ value: '', text: 'none' }, ...others.map((held) => ({ value: held.id, text: held.label }))]
      if (style.compare !== '' && !choices.some((choice) => choice.value === style.compare)) {
        choices.push({ value: style.compare, text: `${style.compare} (no longer in the list)` })
      }
      rows.push(
        pickField(
          'compare with',
          select(choices, style.compare, (value) => this.restyleAll({ compare: value })),
          'Another structure row, aligned onto this one over the beads the two share and drawn in grey beside it; colour by displacement shows where they differ.',
        ),
      )
      const fit = style.compare === '' ? null : (this.overlayOf(structure ?? ({} as Structure), style), this.compared?.fit ?? null)
      if (style.compare !== '' && structure !== null) {
        rows.push(
          el('p', { class: 'clip-note structure-note-line', text: fit === null ? 'the two models share fewer than four beads' : `${fmt.int(fit.matched)} beads matched · RMSD ${fmt.num(fit.rmsd)} model units` }),
        )
      }
      // …and the same superposition read the other way: **this** model turned
      // into that one's frame, and that one not drawn (§25.5). Beside
      // `compare with` because they are the two halves of one question, and
      // after it because the drawn answer is the one a reader reaches for
      // first.
      const into = [{ value: '', text: 'its own' }, ...others.map((held) => ({ value: held.id, text: held.label }))]
      if (style.align !== '' && !into.some((choice) => choice.value === style.align)) {
        into.push({ value: style.align, text: `${style.align} (no longer in the list)` })
      }
      rows.push(
        pickField(
          'in the frame of',
          select(into, style.align, (value) => this.restyleAll({ align: value })),
          'Turn this model into another model’s frame, over the beads the two share, without drawing the other. ' +
            'Two cells each in one frame are two models that can be turned together and read against each other.',
        ),
      )
    }

    // Drawn as: any of the three together.
    rows.push(
      settingsField(
        'drawn as',
        row(
          toggleIcon('circle-dot', this.keyed('Beads at each place', STRUCTURE_KEYS.beads), style.beads, (on) => this.restyleAll({ beads: on })),
          toggleIcon('minus', this.keyed('Sticks between neighbours', STRUCTURE_KEYS.sticks), style.sticks, (on) => this.restyleAll({ sticks: on })),
          toggleIcon('spline', this.keyed('A tube through each run', STRUCTURE_KEYS.tube), style.tube, (on) => this.restyleAll({ tube: on })),
        ),
      ),
    )

    // Overlays: the names, the ruler, the centre. The word the Map and Tracks
    // cards use for the same row of marks over a picture.
    rows.push(
      settingsField(
        'overlays',
        row(
          toggleIcon(
            'tag',
            this.keyed(style.labels ? 'Hide the sequence names' : 'Show the sequence names', STRUCTURE_KEYS.labels),
            style.labels,
            (on) => this.restyleAll({ labels: on }),
          ),
          toggleIcon('ruler', style.ruler ? 'Hide the genomic ruler' : 'Show the genomic ruler: a tick every step along each chain', style.ruler, (on) => this.restyleAll({ ruler: on })),
          toggleIcon(
            'unfold-horizontal',
            style.telomeres
              ? 'Hide the telomeres'
              : 'Mark the telomeres: a yellow bead at both ends of every chain',
            style.telomeres,
            (on) => this.restyleAll({ telomeres: on }),
          ),
          toggleIcon('locate-fixed', style.axes ? 'Hide the centre and axes' : 'Show the centre and axes', style.axes, (on) => this.restyleAll({ axes: on })),
        ),
      ),
    )

    // Colour by, and size by.
    //
    // The model's own five first, in the order a reader goes through them —
    // what it is, where along it, what they marked on it, and then the two
    // that read from the pinned bin — and after them what another row lends.
    // Named for what they measure: *spatial* distance, because the map beside
    // it is a distance too, in base pairs, and *linear* position for the same
    // reason. The file's score column is not among them: a g3d carries none
    // worth a ramp, and the one it could name was a column of nothing.
    const colourings: Array<{ value: string; text: string }> = [
      { value: STRUCTURE_COLOUR_SEQUENCE, text: 'sequence' },
      { value: STRUCTURE_COLOUR_POSITION, text: 'linear position along the sequence' },
      ...(this.props.manual?.() !== undefined ? [{ value: STRUCTURE_COLOUR_MARKS, text: 'manual annotations' }] : []),
      { value: STRUCTURE_COLOUR_DISTANCE, text: 'spatial distance to pinned bin' },
      ...(this.props.contacts !== undefined ? [{ value: STRUCTURE_COLOUR_CONTACTS, text: 'contacts with pinned bin' }] : []),
      ...(structure !== null && structure.haplotypes.length > 1 ? [{ value: STRUCTURE_COLOUR_HAPLOTYPE, text: 'haplotype' }] : []),
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
    for (const held of tracks) colourings.push({ value: `${STRUCTURE_COLOUR_TRACK}${held.id}`, text: `${held.label} · track` })
    for (const held of featureSets) colourings.push({ value: `${STRUCTURE_COLOUR_FEATURES}${held.id}`, text: `${held.label} · features` })
    // `displacement`, not `displacement from the compared model`: the row above
    // this one is `compare with` and it names the model, and the longer text did
    // not fit the column even as a full-width block — it read `displacement from
    // the cor…`, which is a value clipped mid-word in the control that is
    // reporting it.
    if (style.compare !== '') colourings.push({ value: STRUCTURE_COLOUR_DISPLACEMENT, text: 'displacement' })
    if (!colourings.some((option) => option.value === style.colourBy)) {
      colourings.push({ value: style.colourBy, text: `${style.colourBy} (no longer in the list)` })
    }
    rows.push(pickField('colour by', select(colourings, style.colourBy, (value) => this.restyleAll({ colourBy: value }))))
    // The ramp, but only where the colouring is one. Sequence and haplotype are
    // levels and have no scale to change, and a control that does nothing under
    // the default colouring is one a reader tries and then distrusts.
    if (usesRamp(style.colourBy)) {
      rows.push(
        pickField(
          'colour scale',
          select(
            [
              { value: '', text: 'the colouring’s own' },
              ...COLORMAP_NAMES.map((name) => ({ value: name, text: name })),
            ],
            style.colormap,
            (value) => this.restyleAll({ colormap: value }),
          ),
          'The ramp this colouring is drawn on; left at its own, a track’s beads take the lane’s colormap and contacts take the map’s.',
        ),
      )
    }
    rows.push(sliderField('bead radius', style.beadRadius, { min: 0.05, max: 1.5, step: 0.05 }, (v) => this.restyleAll({ beadRadius: v })))
    rows.push(sliderField('tube radius', style.tubeRadius, { min: 0.05, max: 1, step: 0.05 }, (v) => this.restyleAll({ tubeRadius: v })))

    // Which homologue, on a phased model. `haplotype` and not `show`: the marks
    // row below is `overlays`, and two rows reading `show` on one card is one
    // name for two questions.
    if (structure !== null && structure.haplotypes.length > 1) {
      const haplotypes = [{ value: '', text: 'both homologues' }, ...structure.haplotypes.map((name) => ({ value: name, text: name }))]
      rows.push(settingsField('haplotype', select(haplotypes, style.haplotype, (value) => this.restyleAll({ haplotype: value }))))
    }


    // What is outside the window, and *then* how much of it is left: the
    // choice before the modifier, because under `hide` there is nothing for an
    // opacity to be the opacity of — which is why the slider is greyed there,
    // with the reason in its title, rather than dragged to no effect.
    rows.push(
      armedField(
        'outside window',
        select(STRUCTURE_OTHERS.map((o) => ({ value: o, text: o })), style.others, (value) => this.restyleAll({ others: value as StructureStyle['others'] })),
        style.opacity,
        { min: 0, max: 1, step: 0.05 },
        (v) => this.restyleAll({ opacity: v }),
        {
          hint: 'What becomes of the beads outside the window the maps are looking at, and how faint the ghosted ones are.',
          ...(style.others === 'hide'
            ? { disabled: 'Nothing is ghosted while what is outside the window is hidden.' }
            : {}),
        },
      ),
    )

    // Chords: a loop set or the reader's marks, and the map's contacts from the
    // pin. The toggle is absent while the set is `none` — a lit *show the
    // chords* with nothing to show is a control that cannot keep its promise
    // (§8.5), and a reader pressing it could not tell which of the two was why
    // the model stayed bare.
    const loopRows = (store?.entries ?? []).filter((held) => held.kind === 'pairs' && held.status === 'ready')
    const hasMarks = this.props.manual?.() !== undefined
    const loopChoices: Array<{ value: string; text: string }> = [
      { value: '', text: 'none' },
      ...loopRows.map((held) => ({ value: held.id, text: held.label })),
      ...(hasMarks ? [{ value: MANUAL_CHORDS, text: 'manual annotations' }] : []),
    ]
    if (style.loops !== '' && !loopChoices.some((choice) => choice.value === style.loops)) {
      loopChoices.push({ value: style.loops, text: `${style.loops} (no longer in the list)` })
    }
    rows.push(
      el(
        'div',
        { class: 'field ann-field structure-field-with-toggle' },
        el('span', { class: 'field-label', text: 'loops as chords' }),
        ...(style.loops === ''
          ? []
          : [toggleIcon('link-2', style.chords ? 'Hide the chords' : 'Show the chords', style.chords, (on) => this.restyleAll({ chords: on }))]),
        select(loopChoices, style.loops, (value) => this.restyleAll({ loops: value })),
      ),
    )

    // Depth: the fog and the slab.
    rows.push(
      armedField(
        'fog',
        toggleIcon('cloud-fog', style.fogOn ? 'Turn the fog off' : 'Turn the fog on', style.fogOn, (on) => this.restyleAll({ fogOn: on })),
        style.fog,
        { min: 0, max: 1, step: 0.05 },
        (v) => this.restyleAll({ fog: v }),
        { hint: 'The fog for depth, and how far back it starts: Space + scroll on the model moves it too.' },
      ),
    )
    rows.push(
      sliderField('depth slab', style.slab, { min: 0.02, max: 1, step: 0.02 }, (v) => this.restyleAll({ slab: v }), {
        hint: 'Keep only what lies within this fraction of the model’s reach of the centre of rotation, front and back. All the way right is everything.',
      }),
    )

    // The shared preferences this picture reads (§26.3), offered **wherever
    // nothing else in this column offers them**.
    //
    // Three cases, one rule. Enlarged, the model is the window and every other
    // card is *behind* the dialog, so all of them are borrowed in — the one
    // switch for the key the reader is looking at should not be the one they
    // cannot reach. Beside a map, the Map card offers all three and this row
    // is empty, because §26.3 wants a control offered once per column and two
    // copies ten lines apart read as two settings. Beside the **1D browser**,
    // whose Tracks card offers the crosshair and the card but has no *legend*
    // — a browser has no key to hide — this row is the model's key toggle and
    // nothing else, where it used to be nowhere at all: a reader in a
    // browser-led deck could turn the key off only by enlarging the model.
    const offeredElsewhere = new Set(this.props.sharedElsewhere?.() ?? [])
    const shared = this.expanded !== null
      ? STRUCTURE_OPTIONS
      : STRUCTURE_OPTIONS.filter((key) => !offeredElsewhere.has(key))
    if (shared.length > 0) {
      rows.push(
        settingsField(
          'shared',
          row(
            ...shared.map((key) => {
              const { label, hint } = PLOT_OPTION_LABELS[key]
              const on = getPlotOptions()[key]
              return toggleIcon(PLOT_OPTION_ICONS[key], `${label} — ${hint}`, on, () => setPlotOption(key, !on), {
                class: `structure-shared structure-shared-${key}`,
              })
            }),
          ),
          this.expanded !== null
            ? 'Settings about every picture in the app that this one reads, offered here because the cards that own them are behind the dialog.'
            : 'Settings about every picture in the app that this one reads, and that no other card in this column offers.',
        ),
      )
    }

    // Measurements: the list, each removable.
    if (alone && this.measures.length > 0) {
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

    // Camera: presets, the turntable, framing. Block fields — the label above
    // the buttons — because three words and a toggle do not fit beside one.
    //
    // Bordered buttons, as every other action in this column is. They were
    // quiet words, which beside a bordered toggle read as a caption for it: a
    // reader had no way of knowing the model could be put on its side without
    // hovering the word `side` and finding a tooltip.
    rows.push(
      buttonField(
        'camera',
        row(
          button('front', () => this.each((cell) => cell.lookFrom(0, 0)), { class: 'btn', title: 'Look from the front' }),
          button('top', () => this.each((cell) => cell.lookFrom(0, Math.PI / 2 - 0.01)), { class: 'btn', title: 'Look from above' }),
          button('side', () => this.each((cell) => cell.lookFrom(Math.PI / 2, 0)), { class: 'btn', title: 'Look from the side' }),
          toggleIcon(
            'rotate-cw',
            this.keyed(this.turning ? 'Stop the turntable' : 'Turn the model slowly by itself', STRUCTURE_KEYS.turntable),
            this.turning,
            () => {
              const on = !this.turning
              this.each((cell) => cell.setTurning(on))
            },
          ),
          toggleIcon(
            'link',
            this.turnWith
              ? 'Stop turning with the other cells'
              : 'Turn with every other cell set to turn together — one drag turns them all, each keeping its own centre and zoom',
            this.turnWith,
            (on) => this.each((cell) => cell.setTurnWith(on)),
            { class: 'btn btn-icon structure-turn-with' },
          ),
          button('replant the axes', () => this.each((cell) => cell.replantAxes()), {
            class: 'btn structure-replant',
            title:
              'Lay the centre’s axes along this view — x across, y up, z out of the page. ' +
              'Neither the model nor the centre moves; only the frame they are read against.',
          }),
        ),
      ),
    )
    rows.push(
      buttonField(
        'frame',
        row(
          button('the window', () => this.each((cell) => cell.frameLit()), {
            class: 'btn',
            title: this.keyed('Put the camera on what the maps are looking at', STRUCTURE_KEYS.frame),
          }),
          button('everything', () => this.each((cell) => cell.frameAll()), {
            class: 'btn',
            title: this.keyed('Put the camera on the whole model', STRUCTURE_KEYS.all),
          }),
          toggleIcon(
            'flip-horizontal',
            'Mirror the model across the screen. A model from contacts is fixed only up to ' +
              'reflection, so this is how one is brought into the same hand as another.',
            style.mirrorX,
            (on) => this.restyleAll({ mirrorX: on }),
            { class: 'btn btn-icon structure-mirror-x' },
          ),
          toggleIcon(
            'flip-vertical',
            'Mirror the model up the screen — the same reflection as the one beside it, seen the other way up.',
            style.mirrorY,
            (on) => this.restyleAll({ mirrorY: on }),
            { class: 'btn btn-icon structure-mirror-y' },
          ),
        ),
      ),
    )

    // Export: the app's one export row (`ui/exportRow.ts`) — how fine, what
    // file, go — and not the pair of quiet words `PNG PDF` this card used to
    // end with. Those were the third export idiom on one screen, and the only
    // one with no resolution in it: a reader who had set 600 dpi in the Export
    // card above got 300 from here and nothing said so.
    const exportRowEl = exportRow({
      dpi: {
        choices: EXPORT_DPI_CHOICES,
        value: this.exportDpi,
        onChange: (dpi) => {
          this.exportDpi = dpi
        },
      },
      formats: STRUCTURE_EXPORT_FORMATS,
      format: this.exportFormat,
      formatTitle:
        'PNG is the picture as the GPU drew it. PDF is a drawing — beads and sticks as paths, ' +
        'a tube as a raster at the resolution beside it, since a lit surface is not a path.',
      onFormat: (format) => {
        this.exportFormat = format === 'pdf' ? 'pdf' : 'png'
      },
      onSave: (format, dpi) => void (format === 'pdf' ? this.savePdf(dpi) : this.savePng(dpi)),
      onCopy: (dpi) => void this.copyModel(dpi),
      saveTitle: 'Save the model, at the resolution and in the format chosen beside this',
      copyTitle: 'Copy the model as a PNG, ready to paste',
    })
    if (alone) {
      rows.push(
        el(
          'div',
          { class: 'field field-block' },
          el('span', { class: 'field-label', text: 'export' }),
          exportRowEl.el,
          this.exportNote,
        ),
      )
    }

    this.settingsEl.replaceChildren(
      cardTitle('3D structure', 'box', 'controls-title'),
      // The same line the *Map* card carries (§16.5): which cell a change here
      // reaches, said where the change is made — the starred one by name, with
      // the star it was starred by, or every cell while none is. Nothing on a
      // deck of one structure cell, where the star is not offered and the card
      // can be about nothing else.
      ...this.cardFor(together),
      el('div', { class: 'panel-controls' }, ...rows),
    )
  }

  // -------------------------------------------------------------------------
  // Export
  // -------------------------------------------------------------------------

  private async savePng(dpi: number): Promise<void> {
    if (this.view() === null) {
      this.exportNote.textContent = 'nothing to save: no model is drawn'
      return
    }
    const now = new Date()
    // Where it goes first, while the press is still the reader's (`ui/export.ts`).
    const target = await chooseSaveTarget(`structure-${fileStamp(now)}-${dpi}dpi.png`, 'image/png')
    if (target === null) return
    this.exportNote.textContent = `saving ${target.name}…`
    try {
      const out = this.exportCanvas(dpi, now)
      if (out === null) {
        this.exportNote.textContent = 'nothing to save: no model is drawn'
        return
      }
      const blob = await canvasToPng(out)
      await target.write(blob)
      this.exportNote.textContent = `${target.name} · ${fmt.bytes(blob.size)}`
    } catch (err) {
      this.exportNote.textContent =
        err instanceof Error ? `export failed: ${err.message}` : 'export failed'
    }
  }

  /**
   * The model on the clipboard, as a PNG, at the row's resolution.
   *
   * The same act the Export card's second button performs on the map, and the
   * reason the row has one here too: a model goes into a slide or a message as
   * often as it goes into a file, and a reader who had learned the map's pair
   * had to learn the structure's single button instead.
   */
  private async copyModel(dpi: number): Promise<void> {
    this.exportNote.textContent = 'copying…'
    try {
      const out = this.exportCanvas(dpi, new Date())
      if (out === null) {
        this.exportNote.textContent = 'nothing to copy: no model is drawn'
        return
      }
      await copyPngToClipboard(canvasToPng(out))
      this.exportNote.textContent = `copied · ${out.width}×${out.height} px`
    } catch (err) {
      this.exportNote.textContent =
        err instanceof Error ? `copy failed: ${err.message}` : 'copy failed'
    }
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
  private async savePdf(dpi: number): Promise<void> {
    const view = this.view()
    if (view === null) {
      this.exportNote.textContent = 'nothing to save: no model is drawn'
      return
    }
    const now = new Date()
    const target = await chooseSaveTarget(`structure-${fileStamp(now)}.pdf`, 'application/pdf')
    if (target === null) return
    this.exportNote.textContent = `saving ${target.name}…`
    try {
      const width = Math.max(1, this.wrap.clientWidth)
      const height = Math.max(1, this.wrap.clientHeight)
      const page = new VectorPage(width, height)
      if (view.style.tube) {
        // At the row's resolution, not a fixed 300: the reader chose a number
        // beside this button and the one part of this page that is a raster is
        // the one part that could have ignored it.
        const raster = this.exportCanvas(dpi, now)
        if (raster === null) {
          this.exportNote.textContent = 'nothing to save: no model is drawn'
          return
        }
        page.ctx.drawImage(raster, 0, 0, width, height)
      } else {
        drawStructure(page.ctx, { width, height }, view, PAPER_PALETTE)
        // The raster above carries its frame from `exportCanvas`; paths get
        // theirs as a path.
        drawCellFrame(page.ctx, { width, height }, readCanvasPalette(this.el).plotBorderColor, CELL_FRAME_WIDTH)
      }
      const blob = await page.toBlob({ title: 'structure', created: now })
      await target.write(blob)
      this.exportNote.textContent = `${target.name} · ${fmt.bytes(blob.size)}`
    } catch (err) {
      this.exportNote.textContent =
        err instanceof Error ? `export failed: ${err.message}` : 'export failed'
    }
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

