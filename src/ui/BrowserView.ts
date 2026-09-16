/**
 * The 1D genome browser: tracks along a genome, with no contact map under them.
 *
 * Everything it draws is drawn by code that already existed — `render/tracks.ts`
 * for a bigWig, `render/features.ts` for a gene model or a peak set, both
 * through the same {@link LaneFrame} the lanes beside a heatmap use, and both
 * addressed through the same {@link LocusAxis} (§8.4). What is new is only the
 * coordinate system underneath: instead of an axis of matrix bins, the axis is
 * the whole assembly laid end to end, one unit per base pair
 * (`genome/assembly.ts`). One mapping, two entry points; a track cannot be drawn
 * at two positions because there is only one thing that knows where a base pair
 * is.
 *
 * That is also why every gesture the heatmap has works here without being
 * reinvented: a drag pans, Option-drag selects a range to zoom into, the wheel
 * zooms about the pointer, a double click fits, two fingers pinch. The one
 * gesture that is this view's own is ⌘-scroll over a lane, which raises or lowers
 * *that track's* ceiling — the thing a reader reaches for constantly in a genome
 * browser and which has no analogue on a map.
 */

import { BaseCache } from '../annotations/bases'
import { featureLabel } from '../annotations/featureset'
import { findFeatures, hitLabel, paddedSpan } from '../annotations/search'
import {
  OVERLAY_DIM,
  extentFor,
  planStack,
  resolveGroupExtents,
  type GroupSettings,
} from '../annotations/groups'
import { SampleCache } from '../annotations/samples'
import type { AnnotationStore } from '../annotations/store'
import type { AnnotationClient } from '../annotations/worker/client'
import {
  colormapOf,
  nestsAsRibbons,
  stacksAsHeatmaps,
  drawnFromSamples,
  hasTrackControls,
  readsOf,
  scaleOf,
} from '../annotations/types'
import { ReadCache } from '../annotations/reads'
import {
  packPile,
  pileBands,
  rowsAcross,
  type PileLayout,
  drawReads,
  pileDetail,
  READ_ROW,
  READ_ROW_GAP,
  readAt,
  readColoursFor,
  readRungFor,
  rowsFor,
  type ReadRung,
} from '../render/alignments'
import { barChartCaption } from '../render/barchart'
import { featureColouring } from '../render/featureInk'
import { featuresOf } from '../annotations/fields'
import type {
  AnnotationEntry,
  BaseRegion,
  FeatureSet,
  ReadPile,
  ReadWindow,
} from '../annotations/types'
import {
  assemblyAxis,
  findContig,
  formatLocus,
  lengthsAreExact,
  parseLocus,
  rangeToUnits,
  unitsToRange,
  type Assembly,
  type LocusRange,
} from '../genome/assembly'
import type { SequenceSelection } from '../genome/selection'
import {
  RULER_FONT,
  TICK_FONT,
  drawAnchor,
  drawArcs,
  drawBoundaries,
  drawGuide,
  drawRuler,
  drawSelection,
  rulerHeightFor,
  type RulerBand,
} from '../render/browser'
import {
  orderedSpan,
  type ManualPoint,
  type ManualSpan,
  type ManualStore,
} from '../annotations/manual'
import {
  getTextScale,
  scaleFont,
  scaleLength,
  subscribeTextScale,
  textScaleField,
} from './textScale'
import {
  LABEL_BAND,
  drawFeatures,
  featureAt,
  featureLayoutFor,
  layoutFeatures,
} from '../render/features'
import {
  laneBands,
  GRIP_ROOM,
  GROUP_BAR,
  GROUP_FONT,
  clipLane,
  drawGrip,
  drawGroupBars,
  gripAcross,
  gripBox,
  groupRuns,
  snapTo,
  withinGrip,
  type LaneFrame,
} from '../render/lane'
import {
  drawLaneLabel,
  labelEndFor,
  type LaneLabelBoxes,
  type LaneLabelSpec,
  type LaneLabelStyle,
  type LimitBox,
  type NameBox,
  progressDetail,
} from '../render/laneLabel'
import type { LocusAxis, LocusWindow } from '../render/locus'
import type { MapId } from '../annotations/placement'
import { setHoverPlace } from './hoverLocus'
import { Scale } from '../render/scale'
import { basesAreDrawable, baseAt, drawSequence } from '../render/sequence'
import {
  ceilingFactor,
  drawTrack,
  drawTrackScaling,
  nudgedLimits,
  profileOf,
  resolveLimits,
  scaledTo,
  type PixelProfile,
  laneNote,
} from '../render/tracks'
import { button, el, fmt } from './dom'
import { GroupsCard } from './GroupsCard'
import {
  CEILING_MODIFIER,
  CEILING_STEP,
  DRAG_SLACK,
  LaneControls,
  type LaneMark,
} from './LaneControls'
import { LaneEditor } from './LaneEditor'
import { Modal } from './Modal'
import { openFeatureDialog } from './FeatureDialog'
import { openReadDialog } from './ReadDialog'
import { FLAG } from '../annotations/bam/format'
import {
  NAME_COLUMN_DEFAULT,
  clampNameColumn,
  readNameColumn,
  writeNameColumn,
} from './nameColumn'
import {
  LANE_MIN_SIZE,
  fieldPair,
  heightThatFills,
  setTrackHeight,
  smallestLaneSize,
  trackHeightField,
} from './trackControls'
import {
  EXPORT_DPI_CHOICES,
  canvasToPng,
  captionStamp,
  copyPngToClipboard,
  copyTextToClipboard,
  downloadBlob,
  exportBaseName,
  fileStamp,
  largestDpiThatFits,
  scaleForDpi,
} from './export'
import { locusText, type PickHandlers } from './mapPick'
import { VectorPage } from './vector'
import { KEYS, withKey } from './commands'
import { searchKey } from './SearchBox'
import { revealTrack } from './revealTrack'
import { cardTitle, iconButton } from './icons'
import {
  CROSSHAIR_COLOR,
  SELECTION_CHIP,
  SELECTION_FONT,
  SELECTION_PAD,
} from '../render/heatmap'
import { transparencyField } from './AnnotationCard'
import { openLaneMenu, readCanvasPalette } from './MatrixPanel'
import {
  PLOT_OPTION_ICONS,
  PLOT_OPTION_KEYS,
  PLOT_OPTION_LABELS,
  TRACK_OPTIONS,
  getPlotOptions,
  setPlotOption,
  subscribePlotOptions,
  type PlotOptionKey,
} from './plotOptions'
import { setReadout } from './readout'

/** Gap between two stacked lanes, in CSS pixels. Same as beside the map. */
const LANE_GAP = 4
/** How close to a lane's lower border counts as being on it. */
const LANE_GRIP = 4
/**
 * How close to the name column's edge counts as being on it.
 *
 * The same four pixels a lane's border takes, and for the same reason: a border
 * is a line, and a line is not something a hand can be asked to hit.
 */
const COLUMN_GRIP = 4
const LANE_FONT = '10px system-ui, sans-serif'
/**
 * The value range under a track's name.
 *
 * Bigger than the rest of the small print on a lane, because it is the only
 * part of it a reader *uses*: it is the axis every value on the track is read
 * against, and it is a text box. Ten pixels was small enough that finding the
 * caret in it was aiming.
 */
const RANGE_FONT = '11.5px system-ui, sans-serif'
/** The bar under a lane's name while its read is on its way, and its thickness. */
const PROGRESS_WIDTH = 56
const PROGRESS_THICKNESS = 3
/**
 * The track name, which is the one word on a lane a reader looks for.
 *
 * Bigger than everything else drawn on the lane and heavier, because in a
 * browser the name is what identifies the row — the value range beside it is a
 * fact about the axis and belongs in the small print, not at the same weight.
 */
const NAME_FONT = '600 12px system-ui, sans-serif'
/**
 * The residues of a sequence lane.
 *
 * Not a monospace, though a column of letters is the one place it would be the
 * reflex: every glyph here is placed individually at the centre of its own base,
 * so nothing is gained by their all being the same width — and the page's own
 * face keeps a lane of bases looking like part of the same drawing as the names
 * above them.
 */
const BASE_FONT = '600 11px system-ui, sans-serif'
/** Milliseconds within which a second click is a double click. */
const DOUBLE_CLICK_MS = 250
/** Smallest window the browser will zoom to: forty bases fill a wide screen. */
const MIN_SPAN = 40
/**
 * How much ink a hand-drawn rectangle's wash is worth.
 *
 * A tenth, because the thing it is drawn over is the reason the reader put it
 * there: a band that made the tracks under it harder to read would be a mark
 * that hid its own subject. Enough to be seen against both themes' plot
 * backgrounds and not enough to change the colour of a track through it.
 */
const MARK_WASH = 0.1

export interface BrowserViewProps {
  assembly: Assembly
  store: AnnotationStore
  client: AnnotationClient
  /**
   * Which of the assembly's sequences are on the axis.
   *
   * Shared with the Sequences card rather than owned here, because both are
   * views of one decision: the card is where it is made and this is where it is
   * *visible*, and a copy on either side is a copy that can disagree.
   */
  selection: SequenceSelection
  /**
   * A control the session puts in the bar, after the box.
   *
   * The switch back to the contact map this browser is standing in front of.
   * An element rather than a callback because whether there *is* one is the
   * session's question — see `Session.mapToggleButton`.
   */
  extraControl?: HTMLElement
  /** The window to open at, from the view state. Absent means the whole genome. */
  locus?: string
  /** The view moved; the hash follows. `undefined` is the whole genome. */
  onLocusChange(locus: string | undefined): void
  /**
   * How each group is drawn and scaled, for this file.
   *
   * The session's, not this view's: a group made here is the same group beside
   * the map, so the two surfaces are handed one object rather than a copy each
   * (`annotations/groups.ts`).
   */
  groups: GroupSettings
  /**
   * The reader's own marks (§8.1), drawn over the tracks.
   *
   * The session's store and not a copy, exactly as `groups` is: a mark placed
   * here is the same mark the map draws, which is the whole reason it is stated
   * in (contig, base pair) rather than in pixels. Optional because a file that
   * cannot carry marks (§8.5) has no store at all, and because a view that is
   * handed none simply draws none.
   */
  manual?: ManualStore
  /**
   * Draw only the tracks **placed on this map**, by the deck's id for the cell
   * (§25.3). Absent — the session's own browser — every visible track is a
   * lane, since one axis is the only place there is to draw it.
   */
  map?: MapId
  /**
   * What this view's pointer is published as (`ui/hoverLocus.ts`): `browser`
   * for the session's own, a cell's id for a tracks cell of the deck, so a
   * cell ignores its own echo and answers everybody else's.
   */
  hoverSource?: string
}

/** One lane, resolved for a frame: where it goes and what goes in it. */
interface Lane {
  entry: AnnotationEntry
  /** Tracks drawn *into* this lane, when its group is in overlay mode. */
  overlaid: AnnotationEntry[]
  frame: LaneFrame
  profiles: Array<{ entry: AnnotationEntry; profile: PixelProfile }>
  /**
   * Residues to draw, for a FASTA zoomed in far enough to show them.
   *
   * Exclusive with {@link profiles} for the same entry: a sequence lane is a GC
   * line or a row of bases, never both, and which one it is is decided per frame
   * from the frame itself (`basesAreDrawable`).
   */
  residues: Array<{ entry: AnnotationEntry; regions: BaseRegion[] }>
  /**
   * The read this lane is waiting on, where it is waiting on one: a window of
   * samples or of letters still on its way from the worker, with how far it
   * has got. Drawn as the detail line, over the limits and over a note — the
   * one thing a reader wants to know about a lane that is blank is whether
   * something is coming (§8.8).
   */
  pending: { done: number; total: number } | null
  /**
   * The reads to draw, for a pile lane zoomed in far enough (§8.13).
   *
   * Empty rather than falling back to anything when the lane is too wide for a
   * read to be a shape: a pile lane's only picture is the pile, and the depth a
   * reader wants out here is the row beside this one.
   *
   * The rung is carried alongside so the paint and the hit test cannot come to
   * different conclusions about which picture is on screen.
   */
  reads: Array<{
    entry: AnnotationEntry
    window: ReadWindow
    rung: ReadRung
    /**
     * Where every read of the window sits, packed for the window on screen.
     *
     * One layout per pile, sharing one row space — see `packPile`. Resolved
     * here so the paint and the hit test use the same one, and so the caption
     * can say how much of the pile did not fit.
     */
    placed: PileLayout[]
  }>
}

/**
 * One hand-drawn mark (§8.1), resolved onto this view's single axis.
 *
 * The plan the paint draws from, and the plan a test reads: jsdom refuses a 2D
 * context, so what a figure would put on the canvas has to be askable of the
 * figure itself rather than scraped off it — the same bargain `SequenceBar`
 * makes with its `hairlineAt`. Resolved to **axis units** and not to pixels,
 * because that is where the decisions are: which contig a mark is on, whether it
 * is on the axis at all, and whether it is in the window. The one step left,
 * unit → pixel, is `Scale`'s and is the same call every track on screen makes.
 */
export interface BrowserMark {
  /** The mark this came from, so two marks at one coordinate stay two. */
  id: string
  /**
   * What to draw: a rule at a coordinate, a wash over a stretch, or a triangle
   * pointing at one end of a mark whose other end is elsewhere.
   */
  kind: 'line' | 'band' | 'anchor'
  colour: string
  /** Where it starts on the axis; the coordinate itself for a line or anchor. */
  from: number
  /** Where it stops; the same number as {@link from} for a line or an anchor. */
  to: number
}

export class BrowserView {
  readonly el: HTMLElement
  /** The controls column, mounted by the session in the Aesthetics panel. */
  readonly sideEl: HTMLElement

  /**
   * The assembly this view is *of*: the whole one, or the ticked part of it.
   *
   * Not `props.assembly`, which stays the genome in full so the locus box, the
   * feature search and the Sequences card can all still name a sequence that is
   * not currently on screen.
   */
  private view: Assembly
  private axis: LocusAxis
  private readonly scale: Scale
  private readonly canvas: HTMLCanvasElement
  private readonly stage: HTMLElement
  private readonly overlays = el('div', { class: 'browser-overlays' })
  private readonly tooltip = el('div', { class: 'cell-tip hidden' })
  /**
   * Where the tooltip is pointing and how large it turned out to be.
   *
   * Two facts kept apart because they arrive at different times: the pointer is
   * known the instant it moves, the size only after the card has been laid out.
   * Placing on the first and correcting on the second is what lets the box be
   * *flipped* away from an edge without reading layout on every pointer move —
   * the same arrangement `MatrixPanel.placeTooltip` uses, for the same reason.
   */
  private tipAt: { x: number; y: number } | null = null
  private tipSize = { width: 0, height: 0 }
  private tipFrame = 0
  /**
   * The open feature card, so a second click replaces it rather than stacking.
   *
   * Held rather than fired and forgotten because this view can be torn down
   * under it — a tab closed, a map dropped on the tracks — and a dialog whose
   * opener has gone is a panel with a zoom button that navigates nothing.
   */
  private featureDialog: Modal | null = null
  /** The one box: a locus, a sequence name or a feature name, all three. */
  private readonly locusInput: HTMLInputElement
  private readonly searchList = el('div', { class: 'browser-hits hidden' })
  private readonly zoomNote = el('span', { class: 'browser-zoom' })
  private readonly groupsCard: GroupsCard
  private readonly exportStatus = el('span', { class: 'clip-note export-note' })
  private readonly cache: SampleCache
  private readonly bases: BaseCache
  /** The reads each alignment lane is drawing, kept between frames. */
  private readonly piles: ReadCache
  private readonly unsubscribes: Array<() => void> = []
  private readonly observer: ResizeObserver | null

  private dpr = 1
  private frameHandle = 0
  private disposed = false
  private bands: RulerBand[] = []
  private lanes: Lane[] = []
  /** Feature layouts from the last draw, for hit testing without a re-layout. */
  private readonly layouts = new Map<string, { frame: LaneFrame; layout: ReturnType<typeof layoutFeatures> }>()
  /**
   * The band each pile lane's reads were drawn in, for the same reason.
   *
   * The pile sits under the lane's name strip, and recomputing that split at
   * click time would be the geometry written twice, which §8.4 exists to
   * forbid. What is kept is the frame the paint actually used, so a click
   * cannot land on a different row from the one under the pointer.
   */
  private readonly piled = new Map<
    string,
    { frame: LaneFrame; window: ReadWindow; placed: PileLayout[] }
  >()
  private hover: { x: number; y: number } | null = null
  /** The lane whose lower border the pointer is on, so the grip can be drawn. */
  private gripping: string | null = null
  /** Whether track text is drawn at all — the shared `text` plot option. */
  private text = true
  /** Whether the shaded areas are drawn — the shared `fills` plot option. */
  private fills = true
  /** Whether each track's line is drawn in ink — the shared `outline` option. */
  private outline = false
  /** Whether each lane gets a rule along its floor — the `baseline` option. */
  private baseline = true
  /** Whether a guide line follows the pointer — the shared `crosshair` option. */
  private crosshair = true
  /**
   * Where each lane's two limits were drawn, from the last frame.
   *
   * Recorded by the label pass rather than recomputed, because the box a reader
   * is pointing at is the box the text was measured into: any second measurement
   * is a second opinion about the same font, and the difference between the two
   * is exactly the pixel the click misses by.
   */
  private rangeHits: RangeHit[] = []
  /**
   * Where each track's name was drawn, from the last frame.
   *
   * The same bargain the ranges make, for the same reason: a name that is only
   * drawn is a name a reader has to go and correct somewhere else, and the box
   * they point at has to be the box the text was measured into.
   */
  private nameHits: NameHit[] = []
  /** This frame's on-lane controls, in the order the layer holds them. */
  private marks: LaneMark[] = []
  /**
   * The line each lane's handle sits on, by entry, from the labels being drawn.
   *
   * The handle is level with the track's *name*, and where a name sits is a
   * layout question the label pass answers per lane — a column or the data, a
   * flipped track hanging from the ceiling, one line or one per overlaid name. So
   * the pass that places the name says where the handle goes, exactly as it
   * already does for the limits and the swatches.
   */
  private gripRows = new Map<string, number>()
  private readonly controls: LaneControls
  private readonly editor: LaneEditor
  private drag:
    // `from` is the domain start at the press, so Escape can put the view back
    // where the pan began: a pan abandoned half-way is not a shorter pan.
    | { mode: 'pan'; x: number; from: number }
    | { mode: 'select'; x0: number; x: number }
    | { mode: 'column'; x0: number; from: number }
    | { mode: 'resize'; entry: AnnotationEntry; y0: number; size: number }
    | { mode: 'reorder'; entry: AnnotationEntry; over: number }
    | { mode: 'scale'; lane: Lane; members: AnnotationEntry[]; from: number }
    | { mode: 'press'; x0: number; y0: number; lane: Lane | null; onBorder: boolean }
    | null = null
  /** A picking mode in progress; see {@link armPicking}. */
  private picking: (PickHandlers & {
    /** Called once when the mode ends, however it ends. */
    end(): void
  }) | null = null
  /**
   * The lane whose ceiling is being dragged, and how far it has moved.
   *
   * Held here rather than written to the store on every frame, and that is what
   * makes the gesture readable: the store is what the *faded* copy is drawn
   * from, so it has to stand still while the hand moves. One write, on release.
   */
  private scaling: { id: string; factor: number } | null = null
  /** Set while a navigation is ticking a sequence on its way — see {@link ensureOnAxis}. */
  private adopting = false
  /**
   * Width of the column the track names are drawn in; 0 when they are not.
   *
   * The whole of what the `gutter` option does. Every frame starts at it, the
   * ruler starts at it, and every canvas x is turned back into a base pair
   * through it ({@link atUnit}) — one number, applied once, so the ruler and the
   * tracks under it cannot start in different places.
   */
  private gutter = GRIP_MARGIN
  /**
   * How much of {@link gutter} the *names* have; 0 when they are off.
   *
   * The two are not the same number any more: the axis always starts past the
   * handles' margin, and only the part beyond it is a name column. Everything
   * that asks "is there a column" asks this one.
   */
  private nameColumn = 0
  /**
   * The width a reader dragged the column to; `null` leaves it to the names.
   *
   * The difference between the two is the difference between a measurement and
   * a decision. Measured, the column is as wide as the widest name and no
   * wider — right until one long name makes a column three others do not need.
   * Pinned, it is what the reader said, and a name that no longer fits wraps or
   * is cut rather than running out over the data.
   */
  private pinnedColumn: number | null = readNameColumn()
  /**
   * How tall the ruler is, at the text scale in force.
   *
   * A field and not a constant, because it is *both* a layout and a hit test:
   * everything below it starts at this number and a press above it is a range
   * selection. Two numbers there and clicking a chromosome's name silently
   * stops navigating.
   */
  private rulerHeight = rulerHeightFor(getTextScale())
  /** Whether the pointer is on the column's own edge, which resizes it. */
  private onColumn = false
  /**
   * What the gutter *wants* to be, measured from the labels last drawn.
   *
   * A frame behind, and unavoidably so: the width depends on the text, the text
   * is measured while drawing it, and the drawing needs the width. It cannot
   * oscillate — a name's width does not depend on where the name is drawn — and
   * a change settles on the next frame, which is the same frame the change
   * itself lands on.
   */
  private wantGutter = NAME_COLUMN_DEFAULT
  /** The widest label this paint has drawn so far; becomes {@link wantGutter}. */
  private measuredGutter = 0
  /** The canvas width the last frame was drawn at, which the export saves. */
  private canvasWidth = 0
  private exportDpi = 300
  private exportFormat: BrowserExportFormat = 'pdf'
  private clickTimer: number | null = null
  private reportTimer: number | null = null
  /**
   * The last locus this view *sent*, so the one that comes back is ignored.
   *
   * The shell writes the locus into the view state and the state comes back as
   * a render, which would otherwise re-apply a window this view is already at —
   * and `formatLocus` rounds to whole base pairs, so re-applying it mid-drag
   * snaps the view by a fraction of a pixel on every frame.
   */
  private reported: string | undefined
  /** Another surface's pointer on this axis, or `null`; see {@link showLocusEcho}. */
  private echo: { contig: string; bp: number } | null = null
  /** Whether the last thing published to the hover store was this view's. */
  private published = false

  constructor(private readonly props: BrowserViewProps) {
    this.view = props.selection.restrict(props.assembly)
    this.axis = assemblyAxis(this.view)
    this.scale = new Scale([0, Math.max(1, this.view.total)], 1)

    this.canvas = el('canvas', { class: 'browser-canvas', attrs: { tabindex: '0' } })
    this.stage = el('div', { class: 'browser-stage' }, this.canvas, this.overlays, this.tooltip)

    // One box, not two. What a reader types into a genome browser is "where do
    // I want to be", and `chrIV:1,000-2,000`, `chrIV` and `GAL4` are three
    // spellings of that one question — asking which of two boxes each spelling
    // belonged in was a taxonomy the reader had to learn in order to type a
    // word. The parser already accepts the first two and the name index answers
    // the third, so the box tries both and the text decides.
    this.locusInput = el('input', {
      class: 'input input-region',
      type: 'text',
      placeholder: 'chrI:1,000-20,000, a sequence, a gene, or * for the whole genome',
    })
    // A click selects what is in the box, because what is in the box is where
    // you already are. Merging the two boxes made this necessary rather than
    // merely convenient: the search box was always empty, and this one is
    // always full of the current locus, so a click that only placed the caret
    // would turn "find GAL4" into `IV:400,000-500,000GAL4`. `mouseup` is
    // suppressed for that first click alone — otherwise the browser collapses
    // the selection back to where the pointer landed — and a second click
    // inside the box behaves as any text field does.
    let takingFocus = false
    this.locusInput.addEventListener('mousedown', () => {
      takingFocus = document.activeElement !== this.locusInput
    })
    this.locusInput.addEventListener('mouseup', (event) => {
      if (!takingFocus) return
      takingFocus = false
      event.preventDefault()
    })
    this.locusInput.addEventListener('focus', () => this.locusInput.select())
    this.locusInput.addEventListener('input', () => this.search())
    this.locusInput.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') this.closeSearch()
      if (event.key === 'Enter') this.submit()
    })
    this.locusInput.addEventListener('blur', () => {
      // Deferred, or the blur beats the click on the hit it is about to take.
      window.setTimeout(() => this.closeSearch(), 150)
    })

    this.el = el(
      'section',
      { class: 'view view-browser' },
      el(
        'header',
        { class: 'view-head' },
        el(
          'div',
          { class: 'title-bar browser-bar' },
          // No title. The file's name is on its tab, in the Genome card and in
          // the crumb; a fourth copy of it took the width the locus box wants
          // and said nothing the other three had not.
          //
          // The box and its hit list are one element, because the list is
          // positioned against the box it belongs to.
          // The badge rides in the box rather than beside it, and steps out of
          // the way as soon as the caret arrives: `/` is worth knowing exactly
          // once, and after that it is furniture over the placeholder.
          el('div', { class: 'browser-search search-box' }, this.locusInput, searchKey(), this.searchList),
          button('go', () => this.submit()),
          // The way back to the map, where the map's own way here is: beside the
          // box, in the bar. Absent when there is no map behind this browser,
          // which is most of the time — a genome browser opened on a bigWig has
          // nothing to go back to.
          ...(props.extraControl === undefined ? [] : [props.extraControl]),
          iconButton('zoom-out', 'Zoom out (−)', () => this.zoomBy(1 / 1.8)),
          iconButton('zoom-in', 'Zoom in (+)', () => this.zoomBy(1.8)),
          // The same three marks the Tracks card uses, because they are the same
          // three actions and a reader should not have to learn them twice.
          iconButton('unfold-horizontal', 'The whole genome (0, or a double click)', () => this.fit()),
          iconButton(
            'unfold-vertical',
            withKey('Stretch every track to fill the height, all to one height', KEYS.stretch),
            () => this.fitTracks(),
          ),
          iconButton(
            'fold-vertical',
            'Shrink every track to the height of the shortest of them',
            () => this.shrinkTracks(),
          ),
          // Autoscale is not here. It is in the Tracks card, beside the height
          // box, with `Y` on it — and a sixth control in this row is what tips
          // the bar into wrapping, which puts one orphaned button on a line of
          // its own under the locus box. The two that stay are the two that are
          // about *this window*: fit across, and fill down.
        ),
        el(
          'p',
          { class: 'summary' },
          this.zoomNote,
          el('span', {
            class: 'hint',
            // What the Genome card says, in one line: *rounded up*, not "at its
            // last one". The lengths are the last feature on each sequence
            // rounded up to three figures (`contigsOf`), so a reader told the
            // sequence ends at its last feature would read the blank margin
            // past it as real sequence with nothing in it — and would take the
            // right-hand edge for a coordinate this file supports, which is the
            // one thing an inferred length cannot be.
            text: lengthsAreExact(props.assembly)
              ? ''
              : ' · lengths inferred from the features in this file, so each sequence ends at ' +
                'its last feature rounded up rather than at its true end',
          }),
        ),
      ),
      this.stage,
    )

    // Plot first, Groups under it. Plot is the card that acts on *this picture*
    // — refit, stretch, autoscale, the overlays, the export — and it is there
    // whatever the file is; Groups is empty until a reader has made one, and a
    // column that opens with an empty card reads as a column with nothing in
    // it.
    this.groupsCard = new GroupsCard({
      store: props.store,
      groups: props.groups,
      onChange: () => this.schedule(),
    })
    this.sideEl = el(
      'aside',
      { class: 'side' },
      this.exportCard(),
      this.tracksCard(),
      this.groupsCard.el,
    )

    // The two layers over the canvas. Both are handed the stage rather than
    // built into it, because beside a map the same two classes are given a layer
    // positioned against a grid — which is the whole reason they are not methods
    // of this view.
    this.controls = new LaneControls(this.overlays, props.store, () => this.editor.close())
    this.editor = new LaneEditor({
      host: this.stage,
      store: props.store,
      shownLimits: (id) => this.shownLimits(id),
      onChange: () => this.schedule(),
    })

    this.cache = new SampleCache(props.client, () => this.schedule())
    this.bases = new BaseCache(props.client, () => this.schedule())
    this.piles = new ReadCache(props.client, () => this.schedule())
    this.unsubscribes.push(props.store.subscribe(() => this.schedule()))
    this.unsubscribes.push(props.groups.subscribe(() => this.schedule()))
    // The cards write to the store and this view reads from it, exactly as the
    // matrix panel does: neither holds a reference to the other, which is what
    // lets the Manual annotations card live in the shell's sidebar while the
    // picture it marks up is inside a view the shell replaces.
    if (props.manual !== undefined) {
      this.unsubscribes.push(props.manual.subscribe(() => this.schedule()))
    }
    this.unsubscribes.push(
      subscribePlotOptions((plot) => {
        // Put the card away now rather than on the next pointer move — see the
        // map's twin. The repaint below is for the overlays that draw on canvas.
        if (!plot.tooltip) this.tooltip.classList.add('hidden')
        this.schedule()
      }),
    )
    // The ruler's height is the one thing a scale change moves that is not
    // simply redrawn: everything below it starts at that number, and a press
    // above it means something else.
    this.unsubscribes.push(
      subscribeTextScale((scale) => {
        this.rulerHeight = rulerHeightFor(scale)
        this.schedule()
      }),
    )
    this.unsubscribes.push(props.selection.subscribe(() => this.applySelection()))
    this.watchPointer()
    this.watchKeys()

    this.observer =
      typeof ResizeObserver === 'undefined'
        ? null
        : new ResizeObserver(() => this.remeasure())
    this.observer?.observe(this.stage)

    this.applyLocus(props.locus)
    requestAnimationFrame(() => this.remeasure())
  }

  destroy(): void {
    this.disposed = true
    this.publishHover(null)
    // A picking mode outlives nothing: the picture it was placing marks on is
    // going away. Ended here rather than left to be collected, because the card
    // that armed it is *not* going away — it lives in the shell — and it learns
    // the mode is over from this call. The map's panel does the same, for the
    // same reason: without it, navigating with the mode on leaves a button
    // reading "Done" that nothing will ever answer.
    this.cancelPicking()
    this.featureDialog?.close()
    this.featureDialog = null
    this.editor.close()
    this.controls.destroy()
    this.groupsCard.destroy()
    if (this.frameHandle !== 0) cancelAnimationFrame(this.frameHandle)
    if (this.tipFrame !== 0) cancelAnimationFrame(this.tipFrame)
    if (this.clickTimer !== null) clearTimeout(this.clickTimer)
    if (this.reportTimer !== null) clearTimeout(this.reportTimer)
    for (const off of this.unsubscribes) off()
    this.observer?.disconnect()
    this.cache.destroy()
    this.bases.destroy()
    this.piles.destroy()
    setReadout('')
  }

  // -------------------------------------------------------------------------
  // Picking (spec §8.1)
  // -------------------------------------------------------------------------

  /**
   * Place hand-drawn marks by pointing at the tracks, for as long as the mode
   * lasts.
   *
   * The same method the matrix panel offers and the same {@link PickHandlers}
   * it takes, because it is the same mode reached through the same card: the
   * Manual annotations card arms whatever is mounted through `armAll`
   * (`ui/mapPick.ts`), and a surface that answered a different call would be a
   * second implementation of the arming, the `Done` state and the Escape road.
   *
   * What is this view's own is what a gesture on **one axis** can mean. A click
   * names a base pair and a drag names a stretch of one — there is no second
   * coordinate here to report, and inventing one would be a lie about where the
   * reader pointed. So both are reported as the place on the map's diagonal that
   * they are: the click as the same locus on both axes, flagged
   * {@link PickedPlace.oneAxis} so the line form knows to draw a crosshair; the
   * drag as the same stretch on both axes, which *is* the on-diagonal square.
   * Every mark a track can make is therefore an ordinary two-axis mark, drawn
   * here as one rule or one band and on the map as the shape it always was.
   *
   * While armed, a gesture *places* rather than navigates — the only sensible
   * reading of a click during "pick a place", and the reason this is a mode
   * rather than a modifier. A drag in a `box` mode draws the marquee this view
   * already draws for a zoom, coordinate chips and all, so what the reader lets
   * go of is what they were looking at.
   *
   * @returns a function that ends the mode, for a card being torn down.
   */
  armPicking(handlers: PickHandlers, onEnd: () => void = () => {}): () => void {
    this.picking?.end()
    this.picking = { ...handlers, end: onEnd }
    // The mode has to be visible on the surface the gesture happens on, not only
    // on the button across the window that turned it on. The class is the map's
    // own (`ui/styles.css`); a stylesheet that has not yet been told about this
    // canvas costs the cursor and nothing else.
    this.canvas.classList.add('picking')
    return () => this.cancelPicking()
  }

  /** End a picking mode. Safe to call when none is in progress. */
  cancelPicking(): void {
    const picking = this.picking
    this.picking = null
    this.canvas.classList.remove('picking')
    picking?.end()
  }

  /** `true` while a gesture would place a mark rather than navigate. */
  get isPicking(): boolean {
    return this.picking !== null
  }

  /**
   * A click, as the place on the diagonal it names.
   *
   * Through {@link atUnit} and the axis, which is the one mapping this view has
   * (§8.4): the readout, the tooltip, the selection chips and this all ask the
   * same two functions the same question, so a mark cannot land a pixel away
   * from the coordinate the pointer said it was over. Nothing is placed for a
   * press before the axis begins — the handles' margin and the name column hold
   * no coordinate at all — or for one past the end of the last sequence.
   */
  private pickPlace(x: number): void {
    const handler = this.picking?.point
    if (handler === undefined) return
    const at = this.pointAt(x)
    if (at === null) return
    handler({ rows: at, cols: at, oneAxis: true })
  }

  /**
   * A drag, as the on-diagonal square it names.
   *
   * **Within one sequence only**, and refused rather than clamped when it is
   * not — the same rule, for the same reason, that {@link copyBand} applies to
   * the drag that copies a locus: the axis is a concatenation, so a drag can
   * begin in one chromosome and end in another, and the near end of one of them
   * is not what the reader drew.
   */
  private pickSpan(from: number, to: number): void {
    const handler = this.picking?.box
    if (handler === undefined) return
    const start = this.axis.unitToLocus(from)
    const end = this.axis.unitToLocus(to)
    if (start === null || end === null || start.contig !== end.contig) return
    const span: ManualSpan = orderedSpan(start.contig, start.bp, end.bp)
    handler({ rows: span, cols: span })
  }

  /** A canvas x as a genomic point, or `null` where there is no coordinate. */
  private pointAt(x: number): ManualPoint | null {
    if (x < this.gutter) return null
    const locus = this.axis.unitToLocus(this.atUnit(x))
    return locus === null ? null : { contig: locus.contig, bp: Math.round(locus.bp) }
  }

  /**
   * Save this view as a figure — the `S` key, and the button in the Export card.
   *
   * The same call either way, in the format and at the resolution the card is
   * set to: a shortcut that exported something *else* than the button beside it
   * would be a second export to keep in step.
   */
  savePlot(): void {
    void this.save()
  }

  /**
   * The same figure onto the clipboard — ⌘C, and the button beside the save.
   *
   * PNG whatever the format select says, for the reason the map's copy is one:
   * a clipboard holds an image, and a vector PDF pasted into a slide arrives as
   * a file attachment rather than a picture. The chosen resolution still counts,
   * and so does the caption — this is the figure, not a screenshot of it.
   */
  copyPlot(): void {
    void this.copy()
  }

  private async copy(): Promise<void> {
    this.exportStatus.textContent = 'copying…'
    const width = Math.max(this.canvasWidth, this.gutter + this.scale.pixels)
    const height = this.heightOf(this.lanes)
    const now = new Date()
    const caption = `${this.props.assembly.name} · ${this.zoomPhrase()} · ${captionStamp(now)}`
    const ink = readCanvasPalette(this.canvas).labelColor
    try {
      // Drawn first, so a resolution this figure cannot reach reports itself
      // through `rasterFigure`'s own message rather than as a clipboard failure.
      const png = await this.rasterFigure(width, height, caption, ink)
      // An empty blob is `rasterFigure` refusing a size it has already explained
      // in the status line; overwriting that with "copied" would hide the reason.
      if (png.size === 0) return
      await copyPngToClipboard(Promise.resolve(png))
      this.exportStatus.textContent = 'copied'
    } catch (err) {
      this.exportStatus.textContent =
        err instanceof Error ? `copy failed: ${err.message}` : 'copy failed'
    }
  }

  /**
   * Put the caret in the box — the `/` key, and the palette.
   *
   * Named as every other view names it, because the shell now asks all of them
   * the same question. There is one box here and it is both things: `chrIV`,
   * `chrIV:1,000-2,000` and `GAL4` are three spellings of *where do I want to
   * be*, and the text decides which. It answered to `l` as well until `l` was
   * found to be the labels overlay too — see `Session.commands`.
   */
  focusSearch(): void {
    this.locusInput.focus()
    this.locusInput.select()
  }

  /**
   * Go somewhere, because something outside asked — the Sequences card.
   *
   * Directly rather than through the view state, and that is the whole point.
   * A locus that reaches this view as a state patch has to survive two equality
   * gates on the way: `ViewStore.set` drops a patch that serialises to what is
   * already stored, and `applyLocus` drops one equal to what it last reported.
   * Both gates are right for what they were built for — no redundant history
   * entries, no re-applying a window mid-drag — and both are wrong for a click
   * on a list, which must move the view whether or not the address bar happens
   * to differ. Reporting still happens, so the hash follows as it always did.
   */
  showLocus(text: string): void {
    this.goTo(text)
  }

  /**
   * The stretch on screen, or `null` where the view is the whole genome or
   * straddles two sequences — what a deck cell reports to the maps (§25.3).
   */
  framedRange(): LocusRange | null {
    return this.currentRange()
  }

  /**
   * Adopt the stretches another surface is looking at, **without reporting**.
   *
   * The deck's road into a tracks cell: the lead map's window, as loci. One
   * window is a locus; several — a genome-level map framed across sequences —
   * are shown from the first's start to the last's end, since the axis here
   * lays the sequences end to end as the map's does. Not reported back, which
   * is what keeps the cell out of the lock's feedback loop: the cell that was
   * *told* where to look does not then tell the deck. `false` where nothing
   * here answers to those sequences.
   */
  applyWindows(windows: readonly LocusWindow[]): boolean {
    const first = windows[0]
    const last = windows[windows.length - 1]
    if (first === undefined || last === undefined) return false
    const from = rangeToUnits(this.view, { contig: first.contig, start: first.start, end: first.end })
    const to = rangeToUnits(this.view, { contig: last.contig, start: last.start, end: last.end })
    if (from === null || to === null) return false
    const lo = Math.min(from[0], to[0])
    const hi = Math.max(from[1], to[1])
    if (!(hi > lo)) return false
    const [d0, d1] = this.scale.domain
    // Already there, to the pixel: the window the cell asked the maps for
    // has come back round. Moving again would be a frame of nothing and, on
    // a trackpad, a fight between two hands.
    // …once the view has been measured: before its first layout the scale is
    // one pixel wide and every window is "within a pixel" of every other.
    const tolerance = this.scale.pixels > 1 ? this.scale.unitsPerPixel : 0
    if (Math.abs(d0 - lo) <= tolerance && Math.abs(d1 - hi) <= tolerance) return true
    this.scale.setDomain([lo, hi])
    this.afterMove(false)
    return true
  }

  /**
   * Mark where another surface's pointer is, on this axis (§25.4).
   *
   * The lane-echo shape the map draws for a pointer on another panel's track,
   * for the same reason: one guide, wherever "here" came from. `null` clears.
   */
  showLocusEcho(locus: { contig: string; bp: number } | null): void {
    const same =
      (locus === null && this.echo === null) ||
      (locus !== null && this.echo !== null && locus.contig === this.echo.contig && locus.bp === this.echo.bp)
    if (same) return
    this.echo = locus
    this.schedule()
  }

  /**
   * The plot as a canvas at an export dpi, for the deck's figure (§16.11, §25).
   *
   * What {@link rasterFigure} draws before its caption, on the deck's terms:
   * the deck composes cells and writes no caption per cell. `null` where the
   * page cannot open a canvas, which is a browser that cannot export at all.
   */
  exportCanvas(dpi: number): HTMLCanvasElement | null {
    const width = Math.max(this.canvasWidth, this.gutter + this.scale.pixels)
    const height = this.heightOf(this.lanes)
    const scale = scaleForDpi(dpi)
    const out = document.createElement('canvas')
    out.width = Math.max(1, Math.round(width * scale))
    out.height = Math.max(1, Math.round(height * scale))
    const ctx = out.getContext('2d')
    if (ctx === null) return null
    ctx.setTransform(scale, 0, 0, scale, 0, 0)
    this.paint(ctx, width, height, false)
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.globalCompositeOperation = 'destination-over'
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(0, 0, out.width, out.height)
    ctx.globalCompositeOperation = 'source-over'
    return out
  }

  /** Publish the place under the pointer, or `null` once it has left. */
  private publishHover(x: number | null): void {
    const locus = x === null || x < this.gutter ? null : this.axis.unitToLocus(this.atUnit(x))
    if (locus === null) {
      if (this.published) setHoverPlace(null)
      this.published = false
      return
    }
    this.published = true
    setHoverPlace({ loci: [{ contig: locus.contig, bp: locus.bp }], source: this.props.hoverSource ?? 'browser' })
  }

  /** Re-measure after a column was folded or the window changed shape. */
  remeasure(): void {
    const width = Math.max(1, this.stage.clientWidth)
    this.scale.setPixels(Math.max(1, width - this.gutter))
    this.schedule()
  }

  /**
   * Adopt a locus that came from *outside* — a link, the back button.
   *
   * The inverse of {@link report}, and required to be: what the hash carries has
   * to be what the box would accept, or a shared view opens somewhere else.
   */
  applyLocus(locus: string | undefined): void {
    if (locus === this.reported) return
    this.reported = locus
    if (locus === undefined || locus === '') {
      this.scale.reset()
      this.afterMove(false)
      return
    }
    const parsed = parseLocus(locus, this.props.assembly)
    if (parsed === null) {
      this.scale.reset()
      this.afterMove(false)
      return
    }
    if (parsed === 'whole') {
      this.scale.reset()
      this.afterMove(false)
      return
    }
    this.ensureOnAxis(parsed.contig)
    const units = rangeToUnits(this.view, parsed)
    if (units === null) return
    this.scale.setDomain(units)
    this.afterMove(false)
  }

  // -------------------------------------------------------------------------
  // Which sequences are on the axis
  // -------------------------------------------------------------------------

  /**
   * Rebuild the axis around the ticked sequences.
   *
   * The restriction is not a filter over a whole-genome axis; it *is* the axis,
   * built from a narrower assembly by the same function that builds the wide one
   * (§8.4). That is what makes a pan unable to leave the selection — there is
   * nothing outside it to pan to — rather than requiring a second clamp that the
   * wheel, the arrow keys and the drag-to-zoom would each have to remember.
   *
   * The window survives where it can. Ticking a second chromosome while reading
   * a promoter on the first should not throw the promoter away; opening the
   * whole of a selection, on the other hand, is what ticking one chromosome
   * *means*, so a view that was showing everything goes on showing everything.
   */
  private applySelection(): void {
    const next = this.props.selection.restrict(this.props.assembly)
    if (next.contigs.length === 0) return
    const keep = this.reportedLocus() === undefined ? null : this.currentRange()
    this.view = next
    this.axis = assemblyAxis(next)
    // Resets the domain to all of the new selection, which is the answer when
    // there is no window worth keeping.
    this.scale.setFull([0, Math.max(1, next.total)])
    const units = keep === null ? null : rangeToUnits(next, keep)
    if (units !== null) this.scale.setDomain(units)
    // The caret was measured into a lane of the outgoing axis, and the number in
    // it belongs to a view that no longer exists.
    this.editor.close()
    if (this.adopting) {
      this.clamp()
      this.schedule()
      return
    }
    this.afterMove(true)
  }

  /**
   * Tick a sequence that is being navigated to but is not on the axis.
   *
   * `adopting` is what keeps the hash honest across the two-step move that
   * follows. Ticking notifies, {@link applySelection} runs *inside* this call,
   * and reporting from there would write "the whole selection" to the address
   * bar a moment before the caller sets the window it was actually asked for —
   * which is only ever seen when the second report is suppressed, as it is when
   * a locus is being adopted *from* the hash.
   */
  private ensureOnAxis(contig: string): void {
    if (this.axis.segmentOf(contig) !== null) return
    this.adopting = true
    try {
      this.props.selection.ensure(contig)
    } finally {
      this.adopting = false
    }
  }

  // -------------------------------------------------------------------------
  // Navigation
  // -------------------------------------------------------------------------

  private goTo(text: string): void {
    const parsed = parseLocus(text, this.props.assembly)
    if (parsed === null) {
      this.locusInput.classList.add('is-bad')
      window.setTimeout(() => this.locusInput.classList.remove('is-bad'), 900)
      return
    }
    if (parsed === 'whole') {
      this.fit()
      return
    }
    this.ensureOnAxis(parsed.contig)
    const units = rangeToUnits(this.view, parsed)
    if (units === null) return
    this.scale.setDomain(units)
    this.afterMove(true)
  }

  private fit(): void {
    this.scale.reset()
    this.afterMove(true)
  }

  /**
   * Share the available height between the tracks, **equally**.
   *
   * The arithmetic is `heightThatFills`'s, in `trackControls.ts`, so the map's
   * Tracks card can ask the same question; what stays here is the *measurement* —
   * how much room this view has, which only this view can answer.
   *
   * Measured against the **host**, from the top of the stage down to the bottom
   * of the column this view was mounted in. Not against `this.el`, which is
   * sized by its own content: asking that how much room there is compares the
   * tracks against themselves and fits them to the height they already have,
   * which is a button that appears to do nothing.
   */
  fitTracks(): void {
    const lanes = this.lanes
    if (lanes.length === 0) return
    const host = this.roomHost()
    if (host === null) return
    const padding = Number.parseFloat(window.getComputedStyle(host).paddingBottom)
    const room =
      host.getBoundingClientRect().bottom -
      (Number.isFinite(padding) ? padding : 0) -
      this.stage.getBoundingClientRect().top -
      this.rulerHeight -
      LANE_GAP * (lanes.length + 1)
    const size = heightThatFills(room, lanes.length)
    if (size !== null) this.setTrackHeight(size)
  }

  /**
   * The other way out of a stretch: every lane down to the shortest of them.
   *
   * No measurement at all, which is what makes it the inverse of the button
   * beside it rather than a second opinion about the window. Stretch asks how
   * much room there is; this asks what the reader has already decided a small
   * lane is, and gives that answer to the rest — see `smallestLaneSize`.
   */
  shrinkTracks(): void {
    const size = smallestLaneSize(this.laneMembers())
    if (size !== null) this.setTrackHeight(size)
  }

  /** Give every lane one height, chosen rather than computed. */
  setTrackHeight(px: number): void {
    setTrackHeight(this.props.store, this.laneMembers(), px)
  }

  /** The lanes this view is drawing, as the bulk height actions want them. */
  private laneMembers(): Array<{ members: AnnotationEntry[] }> {
    return this.lanes.map((lane) => ({ members: [lane.entry, ...lane.overlaid] }))
  }

  /**
   * Hand every track's value axis back to the data.
   *
   * One press for what is otherwise one press per lane, and the commonest thing
   * a reader wants after typing a bound into the wrong track or dragging three
   * ceilings about. A group needs nothing special done to it: `auto` resolves
   * through `groupRanges`, so the members of a group come back to one shared
   * pair rather than to their own — which is what belonging to a group means.
   */
  autoscaleAll(): void {
    for (const entry of this.props.store.entries) {
      if (!hasTrackControls(entry.kind) || entry.style.limits.auto) continue
      this.props.store.restyle(entry.id, { limits: { ...entry.style.limits, auto: true } })
    }
  }

  /**
   * The nearest ancestor that has a box, which is the one with the room.
   *
   * The immediate parent is a session's `display: contents` wrapper — it exists
   * so that a tab's three panels land in the shell's grid rather than inside a
   * box of their own, and the price is that it *has* no box: every rectangle it
   * reports is zero. Walking past it finds the column the view is actually in.
   */
  private roomHost(): HTMLElement | null {
    let node = this.el.parentElement
    while (node !== null) {
      if (node.getBoundingClientRect().height > 0) return node
      node = node.parentElement
    }
    return null
  }

  private zoomBy(factor: number, atPixel?: number): void {
    this.scale.zoomAt((atPixel ?? this.gutter + this.scale.pixels / 2) - this.gutter, factor)
    this.afterMove(true)
  }

  /** A step of a continuous gesture: repaint now, report once it settles. */
  private nudged(): void {
    this.afterMove(false)
    this.reportSoon()
  }

  private panBy(pixels: number): void {
    this.scale.panByPixels(pixels)
    this.afterMove(false)
    this.reportSoon()
  }

  /**
   * Write the locus to the address bar, but not sixty times a second.
   *
   * A pan reports on every frame and a trackpad wheel fires dozens of events per
   * gesture; `history.replaceState` at that rate is throttled outright by Safari
   * (100 calls in 30 seconds) and is wasted work everywhere else. The last
   * position of a gesture is the only one worth a history entry, so that is the
   * one written.
   */
  private reportSoon(): void {
    if (this.reportTimer !== null) clearTimeout(this.reportTimer)
    this.reportTimer = window.setTimeout(() => {
      this.reportTimer = null
      this.report()
    }, REPORT_DELAY)
  }

  /** Hand the current window to the shell, remembering what was handed over. */
  private report(): void {
    this.reported = this.reportedLocus()
    this.props.onLocusChange(this.reported)
  }

  /**
   * Keep the view inside the genome, and inside a readable span.
   *
   * Both clamps are the ones the heatmap makes for the same reasons: a view
   * scrolled past the last chromosome is a screen of nothing with no way back
   * that a hand would guess, and a span below a few dozen bases is a picture of
   * one base pair blown up across a monitor, which no track has the resolution
   * to fill.
   */
  private clamp(): void {
    const [full0, full1] = this.scale.full
    const total = full1 - full0
    let [d0, d1] = this.scale.domain
    const span = Math.min(Math.max(d1 - d0, Math.min(MIN_SPAN, total)), total)
    const middle = (d0 + d1) / 2
    d0 = middle - span / 2
    d1 = middle + span / 2
    if (d0 < full0) {
      d1 += full0 - d0
      d0 = full0
    }
    if (d1 > full1) {
      d0 -= d1 - full1
      d1 = full1
    }
    this.scale.setDomain([Math.max(full0, d0), Math.min(full1, d1)])
  }

  /** After any movement: clamp, report the new locus, and repaint. */
  private afterMove(report: boolean): void {
    this.clamp()
    const locus = this.reportedLocus()
    // `*` rather than a window, when the window *is* the genome. Writing
    // `X:1-745,751` there would name whichever sequence the midpoint fell in
    // and read as though the view were on it.
    this.locusInput.value = locus ?? '*'
    if (report) {
      if (this.reportTimer !== null) clearTimeout(this.reportTimer)
      this.reportTimer = null
      this.report()
    }
    this.schedule()
  }

  /** The window, as one sequence and a span in it — what the box shows. */
  private currentRange(): LocusRange | null {
    return unitsToRange(this.view, this.scale.domain as [number, number])
  }

  /**
   * What the hash should carry: the window, or nothing at all.
   *
   * `undefined` for the whole genome, so a browser opened at its default view
   * produces a clean link rather than one pinning the assembly's exact length —
   * a number that would be wrong the moment the same tracks were opened against
   * a sizes file instead of a bigWig.
   */
  private reportedLocus(): string | undefined {
    const [d0, d1] = this.scale.domain
    const [f0, f1] = this.scale.full
    if (d0 <= f0 && d1 >= f1) return undefined
    const range = this.currentRange()
    return range === null ? undefined : formatLocus(range)
  }

  // -------------------------------------------------------------------------
  // Layout
  // -------------------------------------------------------------------------

  /**
   * The lanes to draw, and where each one sits.
   *
   * A group in **overlay** mode collapses to one lane: the first of its members
   * keeps its slot and the rest are drawn into it. That is what makes two
   * strands of an RNA-seq experiment, or a ChIP and its input, one picture
   * rather than two stacked ones you have to hold against each other — and
   * because a group already shares one pair of limits, the two are directly
   * comparable by construction.
   */
  private layout(): Lane[] {
    // Both *file* cards, because in one dimension there is no "on the map" to
    // be an overlay of: a BED is boxes and a BEDPE is arcs, and each takes a
    // lane of its own like everything else here.
    // A structure is a row of the list and never a lane: its picture is the
    // deck's structure cell (§25), and a chain of 5 kb beads drawn as boxes
    // along an axis is one solid bar saying nothing.
    const held = this.props.map === undefined ? this.props.store.entries : this.props.store.entriesOn(this.props.map)
    const entries = held.filter(
      (entry) => entry.visible && entry.status === 'ready' && entry.kind !== 'structure',
    )
    return planStack(entries, {
      groupOf: (entry) => entry.style.group,
      modeOf: (group) => this.props.groups.modeOf(group),
      sizeOf: (entry) => entry.style.size,
      gap: LANE_GAP,
      from: this.rulerHeight + LANE_GAP,
      minimum: LANE_MIN_SIZE,
    }).map((slot) => ({
      entry: slot.host,
      overlaid: slot.overlaid,
      frame: this.frameAt(slot.acrossFrom, slot.thickness),
      profiles: [],
      residues: [],
      reads: [],
      pending: null,
    }))
  }

  private frameAt(acrossFrom: number, thickness: number): LaneFrame {
    // Captured by value: frames are rebuilt every draw, and a frame that read
    // the *current* gutter would move a lane drawn in a previous one.
    const gutter = this.gutter
    return {
      orientation: 'bottom',
      toPixel: (unit) => gutter + this.scale.toPixel(unit),
      toUnit: (pixel) => this.scale.toUnit(pixel - gutter),
      domain: this.scale.domain,
      alongFrom: gutter,
      alongTo: gutter + this.scale.pixels,
      acrossFrom,
      thickness,
    }
  }

  /** A canvas x as a position on the axis, through the name column. */
  private atUnit(x: number): number {
    return this.scale.toUnit(x - this.gutter)
  }

  /**
   * The stretch a drag-to-zoom covered, onto the clipboard.
   *
   * `chr:start-stop`, the form every tool in this field takes and the same one
   * the map's Shift-drag writes — one gesture, one string, whichever surface it
   * was made on (`ui/mapPick.ts`).
   *
   * Only within one sequence. The axis here is a concatenation, so a drag can
   * begin in one chromosome and end in another; that is a perfectly good thing
   * to zoom to and it is not a locus, so the zoom happens and nothing is
   * copied — better than clamping to the near end and handing back coordinates
   * for a region the reader did not select.
   */
  private copyBand(from: number, to: number): void {
    const start = this.axis.unitToLocus(from)
    const end = this.axis.unitToLocus(to)
    if (start === null || end === null || start.contig !== end.contig) return
    void copyTextToClipboard(
      locusText({
        contig: start.contig,
        start: Math.round(start.bp),
        end: Math.round(end.bp),
      }),
    ).catch(() => {
      // An insecure context, or a browser that will not have it. Not worth a
      // dialog: the zoom the same gesture asked for has already happened.
    })
  }

  /** Total canvas height: the ruler, every lane, and the gaps between them. */
  private heightOf(lanes: Lane[]): number {
    const last = lanes[lanes.length - 1]
    return last === undefined
      ? this.rulerHeight + LANE_GAP
      : last.frame.acrossFrom + last.frame.thickness + LANE_GAP
  }

  /**
   * How tall the canvas is **on screen**: its content, or the room left in the
   * column under it, whichever is more.
   *
   * The tracks are a picture of an axis, and the axis does not stop where the
   * last one does. A reader pointing below the stack is pointing at a
   * coordinate — the crosshair belongs there and so does the readout — and until
   * the canvas reached that far there was nothing under the pointer to answer
   * with: the empty space was the column's, not the plot's, and the pointer
   * moved over it silently.
   *
   * Measured exactly as {@link fitTracks} measures, and against the same host,
   * because it is the same question about the same room. The measurement cannot
   * chase its own tail: what it reads is where the stage *begins*, which depends
   * on the header above it and not on how tall this canvas turns out to be.
   *
   * Only on screen. A figure is a picture of the tracks, and blank paper under
   * them is not part of it — so {@link heightOf} is what the export asks for.
   */
  private screenHeight(content: number): number {
    const host = this.roomHost()
    if (host === null) return content
    const padding = Number.parseFloat(window.getComputedStyle(host).paddingBottom)
    const room =
      host.getBoundingClientRect().bottom -
      (Number.isFinite(padding) ? padding : 0) -
      this.stage.getBoundingClientRect().top
    return Math.max(content, Math.floor(room))
  }

  // -------------------------------------------------------------------------
  // Drawing
  // -------------------------------------------------------------------------

  private schedule(): void {
    if (this.frameHandle !== 0 || this.disposed) return
    this.frameHandle = requestAnimationFrame(() => {
      this.frameHandle = 0
      this.draw()
    })
  }

  private draw(): void {
    // The plot options *before* the lanes are filled, not only before they are
    // painted. `fill` reads `this.text`: the name strip is one of an alignment
    // lane's fixed bands, so whether the lane is labelled decides whether a
    // read row fits at all and therefore which rung the lane fetches for. Read
    // after the fill, it would fetch against the previous frame's answer and
    // paint against this one — the two disagreeing for a frame on every toggle.
    const options = getPlotOptions()
    this.text = options.text
    this.fills = options.fills
    this.outline = options.outline
    this.baseline = options.baseline
    this.crosshair = options.crosshair

    const live = new Set(this.props.store.entries.map((entry) => entry.id))
    this.cache.prune(live)
    this.bases.prune(live)
    // The third cache, and it was missed when it was added. Its `prune` and
    // `destroy` were written, documented and never called — so a BAM removed
    // mid-decode left the worker inflating BGZF blocks for a lane that no
    // longer existed, in front of every other lane's `sample`, and left the
    // largest payload this worker sends alive for the life of the tab.
    this.piles.prune(live)
    this.dpr = window.devicePixelRatio > 0 ? window.devicePixelRatio : 1
    const width = Math.max(1, this.stage.clientWidth)
    this.canvasWidth = width
    // The name column, before anything is placed against it: it decides where
    // the axis begins, so it has to be settled before the scale knows how many
    // pixels it has. Capped at a third of the window — a column wider than that
    // is a panel, and the tracks are what this view is.
    this.nameColumn =
      options.gutter && options.text
        ? clampNameColumn(this.pinnedColumn ?? Math.round(this.wantGutter), width)
        : 0
    // …and the handles' own margin before it, which is there whether or not the
    // names have a column: a handle hangs outside its lane, and outside the
    // first lane of this view is off the left of the canvas unless the canvas
    // keeps it a strip. Thirteen pixels, once, for the whole picture — against
    // the alternative, which was every track name shifted along to make room and
    // handles that could only appear on hover.
    this.gutter = GRIP_MARGIN + this.nameColumn
    this.scale.setPixels(Math.max(1, width - this.gutter))
    this.clamp()

    this.lanes = this.layout()
    for (const lane of this.lanes) this.fill(lane)
    // Down to the foot of the column rather than to the foot of the last track:
    // the axis carries on past the stack, and so does what a reader can point
    // at. See {@link screenHeight}. Measured before the canvas is resized, so
    // the read costs nothing the `clientWidth` above has not already paid for.
    const height = this.screenHeight(this.heightOf(this.lanes))

    this.canvas.style.width = `${width}px`
    this.canvas.style.height = `${height}px`
    const wantWidth = Math.max(1, Math.round(width * this.dpr))
    const wantHeight = Math.max(1, Math.round(height * this.dpr))
    if (this.canvas.width !== wantWidth) this.canvas.width = wantWidth
    if (this.canvas.height !== wantHeight) this.canvas.height = wantHeight

    const ctx = this.canvas.getContext('2d')
    if (ctx === null) return
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0)
    ctx.clearRect(0, 0, width, height)
    this.paint(ctx, width, height)
    // The stage and the canvas share an origin here, so the layer needs no
    // offset — beside a map the same call is given one, because the stacks are
    // grid items and the layer is positioned against the grid.
    this.controls.sync(this.marks, NO_OFFSET)
    this.zoomNote.textContent = this.zoomPhrase()
  }

  /**
   * Everything on the canvas, at whatever scale the context is set to.
   *
   * `chrome` is what separates the screen from a saved figure: the handles are
   * controls, they are on screen because the pointer is over a track, and `S`
   * can be pressed with the pointer exactly there.
   */
  private paint(
    ctx: CanvasRenderingContext2D,
    width: number,
    height: number,
    chrome = true,
  ): void {
    // Read once for the whole frame: every lane asks the same question, and the
    // export asks it too so that what is saved is what was on screen. `draw`
    // has already done this for its own pass; the export enters here directly,
    // which is why it is read in both places rather than only in `draw`.
    const options = getPlotOptions()
    this.text = options.text
    this.fills = options.fills
    this.outline = options.outline
    this.baseline = options.baseline
    this.crosshair = options.crosshair
    const palette = readCanvasPalette(this.canvas)
    // The ruler starts where the tracks start. It has to: it is the axis they
    // are drawn against, and a coordinate strip that began at the edge of the
    // canvas while the data began after the name column would put every tick a
    // column's width away from the base pair it names.
    const ruler = {
      x: this.gutter,
      y: 0,
      width: width - this.gutter,
      height: this.rulerHeight,
      toPixel: (unit: number) => this.gutter + this.scale.toPixel(unit),
      axis: this.axis,
      domain: this.scale.domain,
      palette: {
        text: palette.labelColor,
        faint: palette.labelColor,
        line: palette.plotBorderColor,
        divider: palette.plotBorderColor,
        band: palette.bandColor,
        halo: palette.labelHaloColor,
      },
      dpr: this.dpr,
      fonts: { ruler: scaleFont(RULER_FONT), tick: scaleFont(TICK_FONT) },
    }
    this.bands = drawRuler(ctx, ruler)
    // Where the tracks end, which on screen is not where the canvas does: the
    // canvas reaches the foot of the column so that a reader can point below the
    // stack ({@link screenHeight}). What follows the pointer belongs down there
    // and what describes the *picture* does not — a sequence boundary is a mark
    // on the tracks, and a rule carrying it through a screen's worth of blank
    // space is a divider between two things that are not there.
    const foot = this.heightOf(this.lanes)
    drawBoundaries(ctx, ruler, this.rulerHeight, foot)

    this.layouts.clear()
    this.piled.clear()
    this.rangeHits = []
    this.nameHits = []
    this.marks = []
    this.gripRows.clear()
    this.measuredGutter = 0
    const groups = this.groupRanges()
    for (const lane of this.lanes) this.paintLane(ctx, lane, groups, palette)
    // What the labels just drawn would have needed. Used by the *next* frame,
    // which is the only order available: the width depends on the text and the
    // text is measured by drawing it.
    this.wantGutter = Math.max(40, this.measuredGutter)
    // The bar for each run of grouped lanes, at the left of the strip this view
    // keeps for its handles — the one place a mark about a lane can go without
    // being ink on somebody's data.
    drawGroupBars(
      ctx,
      groupRuns(
        this.lanes.map((lane) => ({
          group: (lane.profiles[0]?.entry ?? lane.entry).style.group,
          colour: (lane.profiles[0]?.entry ?? lane.entry).style.colour,
          acrossFrom: lane.frame.acrossFrom,
          thickness: lane.frame.thickness,
        })),
        LANE_GAP,
      ),
      {
        horizontal: true,
        along: 0,
        labelAlong: GRIP_MARGIN + 2,
        text: this.text,
        font: scaleFont(GROUP_FONT),
      },
    )

    // The reader's own marks, over the tracks and under everything that follows
    // the pointer. To the foot of the picture: on screen that is the bottom of
    // the column, in a saved figure the last track — `height` is whichever the
    // caller is drawing, which is what makes a mark end where the figure does.
    this.paintManual(ctx, height)

    // Under the shared preference, like everything else drawn over the data: a
    // reader who turned the crosshair off beside a map meant it off.
    //
    // And only where the pointer is on the **axis**. The line says "this
    // coordinate", and the strip before the axis — the handles' margin and the
    // name column when it is on — holds no coordinate at all: a line drawn
    // through a column of track names is pointing at a word.
    const hover = this.hover
    const guided = hover !== null && this.crosshair && hover.x >= this.gutter
    if (guided) {
      drawGuide(ctx, hover.x, 0, height, CROSSHAIR_COLOR, this.dpr)
    }
    // Another surface's pointer, at the same coordinate on this axis: a bead
    // under the hand in the structure cell, a cell on a map of the deck (§25.4).
    // The same guide, so a reader learns one mark for "here" everywhere.
    const echo = this.echo
    if (chrome && echo !== null) {
      const unit = this.axis.locusToUnit(echo.contig, echo.bp)
      if (unit !== null) {
        const px = this.gutter + this.scale.toPixel(unit)
        if (px >= this.gutter && px <= width) drawGuide(ctx, px, 0, height, CROSSHAIR_COLOR, this.dpr)
      }
    }
    // Where the line is drawn, it *is* the pointer, and the drawn arrowhead
    // beside it is a second, blunter mark for the same coordinate — sitting on
    // top of the answer. So the hardware pointer goes exactly where the line
    // comes, condition for condition: over the name column, where there is no
    // coordinate and therefore no line, the arrowhead is still the only thing
    // saying where the hand is (`ui/styles.css`).
    this.canvas.classList.toggle('is-guided', guided)
    // The resize grip, where the pointer is on a lane's lower border. The
    // cursor is the drawn arrowhead everywhere here — it is what points at a
    // base pair — so an affordance that lives in the cursor would not exist.
    const border = this.lanes.find((lane) => lane.entry.id === this.gripping)
    if (border !== undefined) {
      ctx.save()
      ctx.strokeStyle = CROSSHAIR_COLOR
      ctx.lineWidth = 2
      ctx.beginPath()
      const edge = border.frame.acrossFrom + border.frame.thickness + 1
      ctx.moveTo(0, edge)
      ctx.lineTo(width, edge)
      ctx.stroke()
      ctx.restore()
    }
    // The column's own edge, on the same terms: drawn where the pointer is on it
    // or while it is being dragged, and never on a figure. A column has no
    // visible boundary at rest — the names' right edge *is* the boundary — so
    // this is the whole of what says the boundary can be moved.
    if (chrome && this.nameColumn > 0 && (this.onColumn || this.drag?.mode === 'column')) {
      ctx.save()
      ctx.strokeStyle = CROSSHAIR_COLOR
      ctx.lineWidth = 2
      ctx.beginPath()
      const edge = snapTo(this.gutter, this.dpr)
      ctx.moveTo(edge, this.rulerHeight)
      // To the foot of the *tracks*, for the reason the boundaries stop there:
      // the column holds names, the names are beside the tracks, and its edge is
      // as long as the thing it is the edge of.
      ctx.lineTo(edge, foot)
      ctx.stroke()
      ctx.restore()
    }
    // A handle for every lane, in the margin the view keeps for them, and never
    // on a figure: a column of grey dots means nothing to a reader of the saved
    // picture. The one under the pointer — or the one being carried — is drawn
    // at full strength, which is the only feedback it needs to give.
    if (chrome) {
      const held = this.drag?.mode === 'reorder' ? this.drag.entry.id : null
      const under = this.hover === null ? null : (this.laneAt(this.hover.y)?.lane.entry.id ?? null)
      const active = held ?? under
      for (const lane of this.lanes) {
        const across = this.gripRow(lane)
        drawGrip(ctx, lane.frame, across, palette.labelColor, lane.entry.id === active ? 1 : GRIP_IDLE)
      }
    }
    if (this.drag?.mode === 'select') {
      const from = Math.min(this.drag.x0, this.drag.x)
      const to = Math.max(this.drag.x0, this.drag.x)
      ctx.save()
      ctx.fillStyle = CROSSHAIR_COLOR
      ctx.globalAlpha = 0.15
      ctx.fillRect(from, 0, Math.max(1, to - from), height)
      ctx.restore()
      this.paintSelectionMarks(ctx, this.drag.x0, this.drag.x, height, palette)
    }
  }

  /**
   * The two ends of a selection, to the base, while it is being dragged.
   *
   * A marquee that zooms to itself is only as good as a reader's ability to put
   * its edges where they mean to, and the shaded band alone says nothing about
   * where they are: the ruler above it is at whatever resolution the *view* is,
   * so at 20 kb per pixel it names a tick eighty thousand bases from the edge
   * being dragged. So both ends are written out exactly — the anchor, which does
   * not move, and the edge under the pointer, which does — with the span between
   * them in the middle, which is the other number a reader is watching.
   *
   * Each chip is placed *outside* its own edge where there is room, so the two
   * numbers never sit on top of the region they are measuring.
   *
   * The drawing itself is `render/browser.ts`'s, and shared with the bar over
   * the Chromosomes table: what this method owns is the two things a renderer
   * should not decide — that a coordinate here is **1-based inclusive**, because
   * that is what this view's own box takes, and where on the canvas the marks
   * belong.
   */
  private paintSelectionMarks(
    ctx: CanvasRenderingContext2D,
    anchor: number,
    moving: number,
    height: number,
    palette: ReturnType<typeof readCanvasPalette>,
  ): void {
    const at = (x: number): string | null => {
      const locus = this.axis.unitToLocus(this.atUnit(x))
      return locus === null ? null : `${locus.contig}:${fmt.int(Math.round(locus.bp) + 1)}`
    }
    const start = at(anchor)
    const end = at(moving)
    if (start === null || end === null) return

    drawSelection(ctx, {
      anchor,
      moving,
      start,
      end,
      span: fmt.bp(Math.abs(this.atUnit(moving) - this.atUnit(anchor))),
      top: this.rulerHeight,
      bottom: height,
      chipTop: this.rulerHeight + 4,
      width: this.canvasWidth,
      dpr: this.dpr,
      chipHeight: scaleLength(SELECTION_CHIP),
      chipPad: scaleLength(SELECTION_PAD),
      font: scaleFont(SELECTION_FONT),
      colour: CROSSHAIR_COLOR,
      halo: palette.labelHaloColor,
    })
  }

  /**
   * The reader's own marks, as this view would draw them (§8.1).
   *
   * A **two-axis mark seen along one axis**, which is the whole of what this
   * method decides. Beside a map a line is a column or a row, an arrowhead is a
   * cell and a rectangle is rows by columns; here there is one axis, so each of
   * them is one or two places on it:
   *
   * - a **line** is one rule, whatever its `axis` says. Vertical, horizontal and
   *   both are three answers to a question this picture does not ask — there is
   *   no second axis for them to differ on — so all three draw at the same
   *   coordinate. `AnnotationLanes` already draws the lines beside a map this
   *   way, per edge; this is the same rule with only one edge.
   * - a **rectangle** is its extent, washed over the tracks. Both extents where
   *   they differ: an off-diagonal box is genuinely *two* stretches of this axis
   *   — a locus against an arm, two loci a megabase apart — and drawing one of
   *   them would be a picture that says the mark is somewhere it is not.
   * - an **arrowhead** is a triangle at each of its two ends, deduplicated when
   *   they are the same place, exactly as the lanes beside a map do it.
   *
   * A mark on a sequence this axis has never heard of — a mark made against
   * another file, or on a sequence the reader has unticked — resolves to `null`
   * and is simply not drawn. A mark outside the window is dropped for the same
   * reason and by the same test, which is what keeps a whole genome's worth of
   * marks from costing anything at 20 kb of zoom.
   */
  get manualMarks(): readonly BrowserMark[] {
    const store = this.props.manual
    if (store === undefined) return []
    const [low, high] = this.scale.domain
    const out: BrowserMark[] = []
    // Washes first, so the rules and the triangles that name the same coordinate
    // are drawn over their own shading rather than under it.
    for (const rect of store.rects) {
      for (const span of sameSpan(rect.a, rect.b) ? [rect.a] : [rect.a, rect.b]) {
        const from = this.axis.locusToUnit(span.contig, span.from)
        const to = this.axis.locusToUnit(span.contig, span.to)
        if (from === null || to === null || to < low || from > high) continue
        // Clipped to the window rather than dropped at its edge: a domain wider
        // than the screen is the ordinary case, and a box drawn only when both
        // of its ends are in view would vanish exactly when it is zoomed into.
        out.push({
          id: rect.id,
          kind: 'band',
          colour: rect.colour,
          from: Math.max(from, low),
          to: Math.min(to, high),
        })
      }
    }
    for (const line of store.lines) {
      const at = this.axis.locusToUnit(line.at.contig, line.at.bp)
      if (at === null || at < low || at > high) continue
      out.push({ id: line.id, kind: 'line', colour: line.colour, from: at, to: at })
    }
    for (const mark of store.arrowheads) {
      const drawn = new Set<number>()
      for (const end of [mark.a, mark.b]) {
        const at = this.axis.locusToUnit(end.contig, end.bp)
        if (at === null || at < low || at > high || drawn.has(at)) continue
        drawn.add(at)
        out.push({ id: mark.id, kind: 'anchor', colour: mark.colour, from: at, to: at })
      }
    }
    return out
  }

  /**
   * Put those marks on the canvas.
   *
   * Between the tracks and the crosshair, which is where a mark belongs: over
   * the data, because it is pointing at it, and under the pointer's own line and
   * the tooltip, because those answer *where is my hand* and a reader must never
   * have to work out which of two marks is the one following them.
   *
   * Down to the foot of the picture rather than the foot of the canvas. On
   * screen the canvas runs to the bottom of the column so that a reader can
   * point below the stack ({@link screenHeight}); in a saved figure it stops at
   * the last track. `bottom` is whichever of those the caller is drawing.
   */
  private paintManual(ctx: CanvasRenderingContext2D, bottom: number): void {
    const top = this.rulerHeight
    for (const mark of this.manualMarks) {
      const from = this.gutter + this.scale.toPixel(mark.from)
      if (mark.kind === 'line') {
        drawGuide(ctx, from, top, bottom, mark.colour, this.dpr)
        continue
      }
      if (mark.kind === 'anchor') {
        drawAnchor(ctx, from, top, mark.colour)
        continue
      }
      const to = this.gutter + this.scale.toPixel(mark.to)
      ctx.save()
      // A wash rather than an outline, and the one place this view parts company
      // with the map's rectangles. There a box is drawn open because the reader
      // is judging what is *inside* it and a fill would hide the answer; here
      // what is inside it is a stretch of every track at once, so an outline
      // would be two hairlines a screen apart with nothing tying them together —
      // and the tracks stay readable through a tenth of an ink.
      ctx.globalAlpha = MARK_WASH
      ctx.fillStyle = mark.colour
      ctx.fillRect(from, top, Math.max(1, to - from), Math.max(0, bottom - top))
      ctx.restore()
    }
  }

  /**
   * Draw a pile lane: the name strip, then the reads under it (§8.13).
   *
   * Two bands out of one lane frame, cut by `laneBands`. It used to be four —
   * a depth curve and a consensus above the pile — and both are gone: the depth
   * is the row beside this one, with its own height, its own axis and its own
   * close button, and the consensus was a picture nobody asked for.
   */
  private paintPile(
    ctx: CanvasRenderingContext2D,
    lane: Lane,
    palette: ReturnType<typeof readCanvasPalette>,
  ): { entries: AnnotationEntry[]; detail: LaneLabelSpec['detail']; at: 'near' | 'far' } | null {
    const row = lane.reads[0]
    // The row's own entry, not the lane's. They are the same for a lane of one,
    // and they are not for an overlaid group — where taking the lane's would
    // paint the first member's reads in a second member's colour and file the
    // hit-test band under the wrong id.
    const entry = row.entry
    const style = entry.style
    const reads = readsOf(style)
    // The label's strip first, so the name and the read count are not read
    // through the pile — see `NAME_BAND`. Through `pileBands` because the row
    // budget `fill` sent to the worker and the hit test behind a click both
    // measure the second of these, and three expressions of one split is how
    // they came to disagree (§8.4).
    const [, pile] = pileBands(lane.frame, this.nameBand())
    this.piled.set(entry.id, { frame: pile, window: row.window, placed: row.placed })

    const colours = readColoursFor(row.window, style.colour)
    for (let i = 0; i < row.window.piles.length; i++) {
      const placed = row.placed[i]
      if (placed === undefined) continue
      drawReads(ctx, pile, this.axis, row.window.piles[i], placed, {
        colours,
        rowHeight: READ_ROW,
        rowGap: READ_ROW_GAP,
        layout: reads.layout,
        diffs: row.window.diffs !== 'none',
        opacity: style.opacity,
        font: scaleFont(LANE_FONT),
        guideColour: palette.labelColor,
      }, row.rung)
    }

    if (!this.text) return null
    return {
      entries: [entry],
      detail: { kind: 'text', text: pileDetail(row.window, row.placed) },
      at: 'near',
    }
  }

  private paintLane(
    ctx: CanvasRenderingContext2D,
    lane: Lane,
    groups: Map<string, { min: number; max: number }>,
    palette: ReturnType<typeof readCanvasPalette>,
  ): void {
    const { entry, frame } = lane
    // What to write on the lane, decided by the branch that drew it and written
    // *after* the clip is released: with a name column the label sits outside
    // the lane's own rectangle, and a clip to the data would take it away.
    let label: {
      entries: AnnotationEntry[]
      detail: LaneLabelSpec['detail']
      at: 'near' | 'far'
    } | null = null
    // The bands a stack of heatmaps was divided into, kept for the label: one
    // name per row, in the row it names (§18.11).
    let labelBands: LaneFrame[] | null = null
    clipLane(ctx, frame)
    if (lane.reads.length > 0) {
      label = this.paintPile(ctx, lane, palette)
    } else if (lane.residues.length > 0) {
      for (const { entry: member, regions } of lane.residues) {
        drawSequence(ctx, frame, this.axis, regions, {
          font: scaleFont(BASE_FONT),
          opacity: member.style.opacity,
          letters: this.text,
        })
      }
      // The name alone. A second line saying how many bases are on screen is
      // what the ruler above it already says, and it would say it *through* the
      // letters — the one thing on this lane that is there to be read.
      if (this.text) {
        label = {
          entries: lane.residues.map((row) => row.entry),
          detail: lane.pending === null ? null : progressDetail(lane.pending),
          at: 'near',
        }
      }
    } else if (lane.profiles.length > 0) {
      // While a ceiling is being dragged this lane is drawn twice: once as it
      // stood, faded and still, and once as the hand is asking for it.
      const dragged = this.scaling?.id === lane.entry.id ? this.scaling.factor : null
      // **Heatmaps stack, they do not overlay** — one rule, in
      // `annotations/types.ts`, so this lane and the one beside the map divide
      // themselves the same way.
      const bands = stacksAsHeatmaps(lane.profiles.map(({ entry: member }) => member))
        ? laneBands(
            frame,
            lane.profiles.map(() => ({ fill: true as const })),
          )
        : null
      labelBands = bands
      // **Ribbons tile, they do not overlay** — the same rule, from the same
      // module, read here for the same reason the heatmap one is.
      const nested = nestsAsRibbons(lane.profiles.map(({ entry: member }) => member))
      for (const [at, { entry: member, profile }] of lane.profiles.entries()) {
        const laneFrame = bands?.[at] ?? frame
        const extent = extentFor(member, profile.extent, groups)
        const limits = resolveLimits(member.style.limits, extent)
        const paint = {
          colour: member.style.colour,
          mode: member.style.mode,
          limits,
          guideColour: palette.labelColor,
          haloColour: palette.labelHaloColor,
          font: scaleFont(LANE_FONT),
          fills: this.fills,
          outline: this.outline,
          baseline: this.baseline,
          flip: member.style.flip,
          colormap: colormapOf(member.style, limits),
          // Overlaid tracks are translucent by necessity: two opaque areas in
          // one lane means the second hides the first, which is the opposite of
          // what overlaying them was for. Stacked heatmaps do not overlap, so
          // they keep the opacity the reader set.
          opacity:
            lane.profiles.length > 1 && bands === null && !nested
              ? member.style.opacity * OVERLAY_DIM
              : member.style.opacity,
          // The band below this one, for a ribbon: the lane's order is the
          // nesting order, and the first member has only the floor under it.
          ...(nested && at > 0 ? { floor: lane.profiles[at - 1].profile } : {}),
        }
        if (dragged === null || !hasTrackControls(member.kind)) {
          drawTrack(ctx, laneFrame, profile, paint)
        }
        else drawTrackScaling(ctx, laneFrame, profile, paint, scaledTo(limits, dragged))
      }
      const first = lane.profiles[0]
      const resolved = resolveLimits(
        first.entry.style.limits,
        extentFor(first.entry, first.profile.extent, groups),
      )
      // Mid-drag the range says where the hand is going, not where it came from:
      // the faded copy behind it is already saying that, and the number a reader
      // is watching is the one they are setting.
      const limits = dragged === null ? resolved : scaledTo(resolved, dragged)
      if (this.text) {
        label = {
          // A sequence drawn as a value track is drawn as its GC content, and
          // an unlabelled line between 0 and 1 under a genome's name is a line
          // nobody can name. The entry is copied rather than renamed, because
          // the label belongs to this frame's picture and not to the file.
          entries: lane.profiles.map((row) =>
            row.entry.kind === 'sequence'
              ? { ...row.entry, label: `${row.entry.label} · GC` }
              : row.entry,
          ),
          // A note wins the detail line. It is only ever set where the lane
          // drew *nothing* (§8.13) — a window of alignments too deep to read at
          // this width — and a pair of limits under an empty lane would be
          // describing an axis with no data on it, which reads as "there is
          // nothing here" rather than "there is too much here to draw".
          detail:
            lane.pending !== null
              ? progressDetail(lane.pending)
              : (laneNote(lane.profiles) ?? { kind: 'limits', ...limits }),
          at: labelEndFor(frame, limits, first.entry.style.flip),
        }
      }
    } else if (entry.kind === 'reads') {
      // A pile lane with nothing to pile: too far out for a read to be wider
      // than the ink it would take, or the window is still on its way. Drawn as
      // its name and a sentence rather than as an empty rectangle — a lane that
      // says nothing looks like a lane that is broken, and this one is neither
      // broken nor going to fill in by itself. The depth over the same reads is
      // the row beside it and is drawn at every zoom (§8.13), so the reader is
      // not being asked to zoom in to see *nothing*.
      if (this.text) {
        label = {
          entries: [entry],
          detail: { kind: 'text', text: 'zoom in to see reads' },
          at: 'near',
        }
      }
    } else if (entry.payload?.kind === 'pairs') {
      const drawn = drawArcs(ctx, frame, this.axis, entry.payload.data, {
        colour: entry.style.colour,
        opacity: entry.style.opacity,
      })
      if (this.text) {
        label = {
          entries: [entry],
          detail: { kind: 'text', text: `${fmt.int(drawn)} in view` },
          at: 'near',
        }
      }
    } else if (entry.payload?.kind === 'features') {
      // Every per-kind number in one place, so this surface and the map lanes
      // cannot drift into two pictures of one file (§8.16, §8.17).
      const rules = featureLayoutFor(entry.kind, frame.thickness, scaleLength)
      const layout = layoutFeatures(
        frame,
        this.axis,
        entry.payload.data,
        rules.rows,
        rules.least,
        rules.banded,
      )
      this.layouts.set(entry.id, { frame, layout })
      const set = entry.payload.data
      // What the boxes are coloured by, and whether the stranded ones point
      // (§8.16). Resolved through `featureColouring` on both surfaces and in the
      // settings card's key, so the picture, the legend and the lane's own name
      // cannot disagree about what a colour means.
      const features = featuresOf(entry.style, entry.kind)
      const ink = featureColouring(set, entry.kind, features.colourBy, entry.style.colour)
      const paint = {
        colour: entry.style.colour,
        guideColour: palette.labelColor,
        haloColour: palette.labelHaloColor,
        font: scaleFont(LANE_FONT),
        opacity: entry.style.opacity,
        labels: this.text,
        labelsBelow: true,
        labelBand: scaleLength(LABEL_BAND),
        arrows: features.arrows,
        barScale: features.bars,
        colourOf: ink.colourOf,
      }
      drawFeatures(ctx, frame, set, layout, paint, entry.kind)
      if (this.text) {
        label = {
          // Chipped in a colour that is **in the lane**: §8.12's rule, which a
          // categorical colouring needs here for the reason it needs it there —
          // a green chip over a lane of blue and orange is a legend for a track
          // that is not there. `featureColouring` decides it, and answers with
          // the entry's own colour wherever that colour is still drawn.
          entries: [
            ink.chip === entry.style.colour
              ? entry
              : { ...entry, style: { ...entry.style, colour: ink.chip } },
          ],
          detail: layout.dense
            ? {
                kind: 'text',
                text: `${fmt.int(layout.total)} ${entry.kind === 'variants' ? 'variants' : 'features'} in view`,
              }
            : // What the top of a bar means, which is the one thing a chart
              // without an axis cannot say for itself (§8.17).
              set.bars === undefined
              ? null
              : { kind: 'text', text: barChartCaption(set.bars, fmt.num, features.bars) },
          at: 'near',
        }
      }
    }
    ctx.restore()
    if (label !== null) {
      this.labelLane(ctx, lane, palette, label.entries, label.detail, label.at, labelBands)
    }
  }

  /**
   * The lane's name — or names, overlaid — and what its value axis spans.
   *
   * The drawing is `render/laneLabel.ts`'s, and shared with the stacks beside
   * the map; what stays here is this view's own geometry — the name column it
   * has and they do not, and the strip it keeps for its handles — plus the three
   * things the pass hands back. The range's boxes and the autoscale spot become
   * controls; the name's line becomes the handle's row.
   *
   * The range goes **under** the name rather than across the lane at its far
   * right. Two reasons, and the second is the one that matters. A number at the
   * opposite end of a lane from the name it belongs to has to be paired up by
   * eye every time, and with four tracks stacked that is four crossings of the
   * window. And a number that is *under its name* is a number you can put a
   * caret in: the range is the one thing on a lane a reader edits, and it should
   * be edited where it is read.
   */
  private labelLane(
    ctx: CanvasRenderingContext2D,
    lane: Lane,
    palette: ReturnType<typeof readCanvasPalette>,
    entries: AnnotationEntry[],
    detail: LaneLabelSpec['detail'],
    at: 'near' | 'far',
    /**
     * The bands a stacked lane was divided into (§18.11), one per entry.
     *
     * A name per band rather than one block for the lane. Over the data the
     * block is otherwise a line of four names written across whichever row it
     * lands on; in the column it is four lines centred on the lane, which is
     * close but still leaves the reader matching names to rows by counting. Each
     * name goes level with the row it names. The range stays on the first band,
     * once: it is the *lane's* axis and every row shares it.
     */
    bands: LaneFrame[] | null = null,
  ): void {
    // Where a right-aligned label block ends: clear of the data, and clear of
    // the handle hanging in front of it. Without the handle's room the name ran
    // straight into the dots, which is exactly what a label and a control must
    // not do — the eye reads them as one mark.
    const column =
      this.nameColumn > 0
        ? {
            start: GRIP_MARGIN,
            end: this.gutter - GUTTER_PAD - GRIP_ROOM,
            pad: GUTTER_PAD + GRIP_ROOM,
            // A second line, and only here: a column is the one place a name has
            // somewhere to continue onto. Over the data the second line would be
            // written across the track it names.
            nameLines: 2,
          }
        : null
    const stacked = bands !== null && bands.length === entries.length
    const frames = stacked && bands !== null ? bands : [lane.frame]
    const runs = stacked ? entries.map((entry) => [entry]) : [entries]
    const blockOf = (index: number): LaneLabelBoxes =>
      drawLaneLabel(ctx, frames[index], {
        names: runs[index].map((entry) => ({
          id: entry.id,
          text: entry.label,
          colour: entry.style.colour,
        })),
        // The range is the lane's and is written once, on the first band.
        detail: index === 0 ? detail : null,
        labelAt: at,
        column,
        style: browserLabelStyle(),
        palette: { text: palette.labelColor, halo: palette.labelHaloColor },
      })
    const boxes = blockOf(0)
    for (let index = 1; index < frames.length; index++) {
      const more = blockOf(index)
      boxes.names.push(...more.names)
      boxes.swatches.push(...more.swatches)
      this.wanted(more.wanted)
    }
    this.wanted(boxes.wanted)
    // The handle goes on the first name's line, whatever that line turned out to
    // be: in the column it is centred on the lane, over the data it is at the
    // end the signal is not growing from.
    this.gripRows.set(lane.entry.id, boxes.nameAcross)
    for (const hit of boxes.limits) this.rangeHits.push({ entries, hit })
    // One name, one track: an overlaid lane draws a name each, and the id the
    // paint recorded is what keeps a rename on the one that was pointed at.
    for (const hit of boxes.names) {
      const owner = entries.find((entry) => entry.id === hit.id)
      if (owner !== undefined) this.nameHits.push({ entry: owner, hit })
    }
    for (const swatch of boxes.swatches) {
      const owner = entries.find((entry) => entry.id === swatch.id)
      if (owner !== undefined) this.marks.push({ kind: 'swatch', entries: [owner], box: swatch.box })
    }
    if (boxes.auto !== null && entries.some((entry) => hasTrackControls(entry.kind))) {
      this.marks.push({ kind: 'auto', entries, at: boxes.auto })
    }
  }

  /**
   * Report how wide a label the name column would have to hold.
   *
   * Collected while the labels are drawn and applied on the next frame — see
   * {@link wantGutter}. Reset per paint by {@link paint}, so a track removed
   * gives its width back instead of the column keeping it for ever.
   */
  private wanted(width: number): void {
    if (width > this.measuredGutter) this.measuredGutter = width
  }

  /** The sequence band under a point on the ruler, if any. */
  private bandAt(x: number): RulerBand | null {
    return this.bands.find((band) => x >= band.from && x <= band.to) ?? null
  }

  /** The sequence *name* under a point, which is the smaller target inside it. */
  private bandNameAt(x: number, y: number): RulerBand | null {
    for (const band of this.bands) {
      const box = band.label
      if (box === null) continue
      if (x >= box.x0 && x <= box.x1 && y >= box.y0 && y <= box.y1) return band
    }
    return null
  }

  /**
   * The line a lane's handle sits on: the one its name was drawn on.
   *
   * `NAME_TOP` is the fallback, for a lane with no label at all — the text
   * option off, or a kind that writes nothing — which is where the name *would*
   * have gone, so switching the names back on moves no handle.
   */
  private gripRow(lane: Lane): number {
    return gripAcross(lane.frame, this.gripRows.get(lane.entry.id) ?? NAME_TOP)
  }

  /** The lane whose handle is under a point, if any. */
  private gripAt(x: number, y: number): Lane | null {
    return this.lanes.find((lane) => withinGrip(gripBox(lane.frame, this.gripRow(lane)), x, y)) ?? null
  }

  /** The min or max box under a track's name at this point, if any. */
  private rangeAt(x: number, y: number): RangeHit | null {
    for (const hit of this.rangeHits) {
      const [bx, by, width, height] = hit.hit.box
      if (x >= bx - 2 && x <= bx + width + 2 && y >= by && y <= by + height) return hit
    }
    return null
  }

  /** The track name at this point, if any. */
  private nameAt(x: number, y: number): NameHit | null {
    for (const hit of this.nameHits) {
      const [bx, by, width, height] = hit.hit.box
      if (x >= bx - 2 && x <= bx + width + 2 && y >= by && y <= by + height) return hit
    }
    return null
  }

  /** The pair a track's axis is drawn with right now, group included. */
  private shownLimits(id: string): { min: number; max: number } | null {
    const extent = this.extentOf(id)
    for (const lane of this.lanes) {
      const entry = this.memberOf(lane, id)
      if (entry === null) continue
      return resolveLimits(entry.style.limits, extent)
    }
    return null
  }

  /**
   * The strip a pile lane keeps clear at its top for its own two lines.
   *
   * Measured from the label's own metrics rather than taken as a constant:
   * `nameTop`, `detailDrop` and `nameLine` all move with the reader's text
   * size, and a fixed strip wrote the read count through the top row of reads
   * the moment the type grew. Zero where this surface draws no text at all —
   * an exported figure has no name on it and the whole lane is pile.
   */
  /**
   * A token for the reference sequences currently open, for the two caches
   * whose answers depend on them (§8.13).
   *
   * The ids of the loaded FASTA rows, in the store's own order. It addresses
   * nothing — the worker looks up its own residues — and exists only so that a
   * FASTA dropped *after* a BAM invalidates the windows already in hand.
   * Without it the mismatch marks appear on the reader's next pan and not on
   * the drop, which reads as the file not having worked.
   */
  private referenceKey(): string {
    return this.props.store.entries
      .filter((entry) => entry.kind === 'sequence' && entry.status === 'ready')
      .map((entry) => entry.id)
      .join(',')
  }

  private nameBand(): number {
    return this.text ? scaleLength(NAME_TOP + DETAIL_DROP + NAME_LINE) : 0
  }

  /**
   * One member of a lane by id, whether it is drawing a profile or a pile.
   *
   * A pile lane has no `profiles` row at all, so a lookup written over
   * `profiles` alone would not find one — and the hit test, the readout and the
   * card's own highlight all go through here.
   */
  private memberOf(lane: Lane, id: string): AnnotationEntry | null {
    return (
      lane.profiles.find((row) => row.entry.id === id)?.entry ??
      lane.reads.find((row) => row.entry.id === id)?.entry ??
      null
    )
  }

  /** Resolve every lane's samples and profiles for this frame. */
  private fill(lane: Lane): void {
    const members = [lane.entry, ...lane.overlaid]
    for (const member of members) {
      // A FASTA is the one lane whose *picture* changes with the zoom rather
      // than only its resolution, and this is where the switch is thrown: close
      // enough for a base to own a pixel and it asks for residues, otherwise it
      // asks for GC content and is a value track like any other from here on.
      if (member.kind === 'sequence' && basesAreDrawable(lane.frame)) {
        const regions = this.bases.basesFor({
          entry: member.id,
          scope: 'browser',
          axis: this.axis,
          domain: lane.frame.domain,
        })
        lane.residues.push({ entry: member, regions: regions ?? [] })
        lane.pending = this.bases.pendingOf(member.id, 'browser') ?? lane.pending
        continue
      }
      // A pile lane draws reads or it draws nothing (§8.13) — the depth is the
      // row beside it, not a rung of this one — so it never falls through to
      // the sampled road below.
      if (member.kind === 'reads') {
        // `this.text` because the name strip is a fixed band, so whether the
        // lane is labelled changes whether a read row fits at all.
        const rung = readRungFor(lane.frame, 'browser', 1, this.nameBand())
        if (rung === 'none') continue
        const window = this.piles.readsFor({
          entry: member.id,
          scope: 'browser',
          axis: this.axis,
          domain: lane.frame.domain,
          rows: rowsFor(lane.frame, this.nameBand()),
          // The browser's axis is one unit per base (§5.8), so the domain
          // span over the pixel span *is* bases per pixel.
          basesPerPixel:
            (this.scale.domain[1] - this.scale.domain[0]) / Math.max(1, this.scale.pixels),
          style: readsOf(member.style),
          reference: this.referenceKey(),
        })
        // Nothing in hand yet — the lane stays empty for this frame and the
        // reads land in the next, which is the contract every other cache here
        // keeps.
        if (window === null) continue
        // The band the pile will be drawn into, so the packing knows how many
        // rows will actually be shown — the same split the paint uses.
        const band = pileBands(lane.frame, this.nameBand())[1]
        lane.reads.push({
          entry: member,
          window,
          rung,
          placed: packPile(
            window.piles,
            this.axis,
            lane.frame,
            lane.frame.domain[0],
            lane.frame.domain[1],
            readsOf(member.style).layout,
            rowsAcross(band.thickness, READ_ROW, READ_ROW_GAP),
          ),
        })
        continue
      }
      if (!drawnFromSamples(member.kind)) continue
      const samples = this.cache.samplesFor({
        entry: member.id,
        scope: 'browser',
        axis: this.axis,
        domain: lane.frame.domain,
        pixels: this.scale.pixels,
        ...(member.derivedFrom === undefined ? {} : { derived: member.derivedFrom }),
        ...(member.kind === 'alignments'
          ? { reads: readsOf(member.style), reference: this.referenceKey() }
          : {}),
      })
      lane.profiles.push({
        entry: member,
        profile: profileOf(lane.frame, this.axis, samples, scaleOf(member.style)),
      })
      lane.pending = this.cache.pendingOf(member.id, 'browser') ?? lane.pending
    }
  }

  /**
   * The range each autoscale group resolves to, over every member on screen.
   *
   * A group is a claim that these tracks are comparable, so it is resolved over
   * all of them at once — the same two-pass rule the lanes beside a heatmap
   * follow, and the reason an overlay group is directly readable rather than two
   * lines at two scales drawn on top of each other.
   */
  private groupRanges(): Map<string, { min: number; max: number }> {
    return resolveGroupExtents(
      this.lanes.flatMap((lane) => [
        ...lane.profiles.map(({ entry, profile }) => ({
          group: entry.style.group,
          extent: profile.extent,
        })),
      ]),
      (group) => this.props.groups.scalingOf(group),
    )
  }

  private zoomPhrase(): string {
    const range = this.currentRange()
    const span = this.scale.domain[1] - this.scale.domain[0]
    const perPixel = span / Math.max(1, this.scale.pixels)
    // "4 of 16 sequences" while a selection is in force, because the difference
    // between a four-chromosome assembly and four ticked chromosomes is not
    // otherwise visible anywhere on screen — and it is the difference between
    // "this genome has four" and "you cannot currently pan to the other twelve".
    const shown = this.view.contigs.length
    const all = this.props.assembly.contigs.length
    const counted = shown === all ? `${fmt.int(all)} sequences` : `${shown} of ${fmt.int(all)} sequences`
    const where =
      range === null || span >= this.scale.full[1] - this.scale.full[0]
        ? `${counted} · ${fmt.bp(span)}`
        : `${range.contig} · ${fmt.bp(span)}`
    // Turned upside down below one base per pixel, where "0 bp per pixel" is
    // what rounding a fraction of a base to a readable unit produces — and where
    // the number a reader wants is the other one anyway, because it says whether
    // the sequence lane is about to show them letters.
    const resolution =
      perPixel >= 1
        ? `${fmt.bp(perPixel)} per pixel`
        : `${fmt.int(Math.round(1 / perPixel))} px per base`
    return `${where} · ${resolution}`
  }

  // -------------------------------------------------------------------------
  // The inline editors
  // -------------------------------------------------------------------------

  /**
   * One of the two shared overlay preferences, as a pressed-in icon.
   *
   * It *writes* to the shared store and *reads* from the subscription, so the
   * same toggle flipped from the command palette or from the heatmap's own panel
   * lights this one up: the button never holds the state itself. Both live here
   * rather than beside the map because both are about the tracks, and the tracks
   * are the whole picture in this view.
   *
   * The mark comes from `PLOT_OPTION_ICONS` rather than from the caller, so a
   * preference is the same glyph in both Tracks cards — a toggle drawn one way
   * beside a map and another beside a browser is two controls as far as a reader
   * is concerned, and the list it is offered from is what decides which exist.
   */
  private optionToggle(key: PlotOptionKey): HTMLButtonElement {
    const { label, hint } = PLOT_OPTION_LABELS[key]
    const node = iconButton(
      PLOT_OPTION_ICONS[key],
      withKey(`${label} — ${hint}`, PLOT_OPTION_KEYS[key]),
      () => setPlotOption(key, !getPlotOptions()[key]),
      { class: 'btn btn-icon btn-toggle', size: 15 },
    )
    const sync = (): void => {
      node.setAttribute('aria-pressed', String(getPlotOptions()[key]))
    }
    sync()
    this.unsubscribes.push(subscribePlotOptions(sync))
    return node
  }

  /**
   * The Export card: resolution, format, save, copy.
   *
   * Its own card and the first one in the column, matching the map's. Every
   * other control here changes the picture; this one takes the picture away, and
   * a reader arrives at it having finished with the rest — so it had no business
   * being a row at the foot of the card that holds the rest.
   */
  private exportCard(): HTMLElement {
    const dpiSelect = el('select', {
      class: 'select select-dpi',
      title: 'Dots per inch of the saved figure. 96 is what is on screen; 300 is print.',
    })
    for (const dpi of EXPORT_DPI_CHOICES) {
      dpiSelect.appendChild(el('option', { value: String(dpi), text: `${dpi} dpi` }))
    }
    dpiSelect.value = String(this.exportDpi)
    dpiSelect.addEventListener('change', () => {
      this.exportDpi = Number(dpiSelect.value)
    })
    const formatSelect = el('select', { class: 'select select-format' })
    for (const format of BROWSER_EXPORT_FORMATS) {
      formatSelect.appendChild(el('option', { value: format.value, text: format.label }))
    }
    formatSelect.value = this.exportFormat
    // A vector PDF has no resolution, so the resolution *goes* rather than
    // sitting there greyed out — which also gives the format the width it needs
    // to say "vector" on one line, the only line the row has.
    const syncDpi = (): void => {
      dpiSelect.hidden = this.exportFormat === 'pdf'
    }
    formatSelect.addEventListener('change', () => {
      this.exportFormat = formatSelect.value as BrowserExportFormat
      syncDpi()
    })
    syncDpi()

    return el(
      'div',
      { class: 'controls-card' },
      cardTitle('Export', 'download', 'controls-title'),
      el(
        'div',
        { class: 'panel-controls' },
        el(
          'div',
          { class: 'export-row export-row-flex' },
          dpiSelect,
          formatSelect,
          iconButton(
            'download',
            withKey('Save the figure, in the format chosen beside this', KEYS.savePlot),
            () => this.savePlot(),
            { class: 'btn btn-icon', size: 15 },
          ),
          // Beside the download rather than under it: they are the same figure
          // going to two places. The clipboard takes a PNG whatever the format
          // beside it says — see `KEYS.copyPlot`.
          iconButton(
            'clipboard-copy',
            withKey('Copy the figure as a PNG, ready to paste', KEYS.copyPlot),
            () => this.copyPlot(),
            { class: 'btn btn-icon', size: 15 },
          ),
        ),
        this.exportStatus,
      ),
    )
  }

  /** The Tracks card: how the stack is sized, scaled and drawn. */
  private tracksCard(): HTMLElement {
    return el(
      'div',
      { class: 'controls-card' },
      // "Tracks", not "Plot": the same card beside a contact map is one of two,
      // and the other is called Map. One name for one thing in both views.
      cardTitle('Tracks', 'palette', 'controls-title'),
      el(
        'div',
        { class: 'panel-controls' },
        // Marks rather than sentences. Each of these is a thing a reader does
        // repeatedly while reading — refit across, refit down, hand the value
        // axes back to the data, take the words off — and a column of full-width
        // buttons spelling them out is seven lines of prose in place of two rows
        // of controls. The words survive in every tooltip.
        el(
          'div',
          { class: 'plot-icon-row' },
          iconButton('unfold-horizontal', 'Fit the whole genome across (0, or a double click on the tracks)', () => this.fit(), {
            class: 'btn btn-icon',
            size: 15,
          }),
          iconButton(
            'unfold-vertical',
            withKey(
              'Stretch every track to fill the height there is, all of them to one height',
              KEYS.stretch,
            ),
            () => this.fitTracks(),
            { class: 'btn btn-icon', size: 15 },
          ),
          iconButton(
            'fold-vertical',
            'Shrink every track to the height of the shortest of them',
            () => this.shrinkTracks(),
            { class: 'btn btn-icon', size: 15 },
          ),
          iconButton(
            'chevrons-up-down',
            withKey(
              'Autoscale every track to what is in view — a group resolves as a group',
              KEYS.autoscale,
            ),
            () => this.autoscaleAll(),
            { class: 'btn btn-icon', size: 15 },
          ),
        ),
        trackHeightField((px) => this.setTrackHeight(px)),
        el(
          'div',
          { class: 'field field-block' },
          el('span', { class: 'field-label', text: 'overlays' }),
          // The shared list, in the shared order, exactly as the map's own
          // Tracks card offers it — and then the one preference that is this
          // view's alone. Spelled out by hand, this row was one toggle short of
          // that list: `tooltip` was missing, so the card that follows the
          // pointer could be turned off beside a map and only with the `p` key
          // here, which is a control that exists in one of the two places the
          // same preference is honoured. Driven from `TRACK_OPTIONS`, an option
          // added to the set arrives in both cards or in neither.
          el(
            'div',
            { class: 'plot-icon-row' },
            ...TRACK_OPTIONS.map((key) => this.optionToggle(key)),
            // Last, and not in that list, because it is about this picture and
            // no other: a heatmap's tracks have the map's own gutters to be
            // named in, and there is no name column beside one to switch on.
            this.optionToggle('gutter'),
          ),
        ),
        // The two legibility numbers on one line, under the overlays rather than
        // beside the export: both are properties of how readable the picture is,
        // and `track text` above them is the toggle that decides whether there
        // is any writing on it at all.
        fieldPair(textScaleField(), transparencyField(this.props.store)),
      ),
    )
  }

  /**
   * The view as a figure: a vector PDF, or a raster PNG at a chosen resolution.
   *
   * Both are re-*drawn* rather than screen-grabbed, which is the trade the
   * heatmap's export makes too. Where the two part company is what a page ends
   * up holding. A contact map is a raster honestly — twelve thousand bins are
   * pixels and nothing else — but nothing in this view is: every mark here is a
   * rectangle, a polyline or a word. So the PDF is written as those, through
   * {@link VectorPage}, and a figure dropped into a manuscript can be restyled,
   * recoloured and scaled by whoever receives it. PNG stays a raster because
   * that is what a PNG is.
   */
  private async save(): Promise<void> {
    // The whole canvas, name column included: the column is part of the figure —
    // it is where the track names are — and a page cut to the data would lose
    // every label on the left of it.
    const width = Math.max(this.canvasWidth, this.gutter + this.scale.pixels)
    const height = this.heightOf(this.lanes)
    const now = new Date()
    const caption = `${this.props.assembly.name} · ${this.zoomPhrase()} · ${captionStamp(now)}`
    const ink = readCanvasPalette(this.canvas).labelColor
    const base = `${exportBaseName(this.props.assembly.name)}-${fileStamp(now)}`

    let blob: Blob
    try {
      blob =
        this.exportFormat === 'pdf'
          ? await this.vectorFigure(width, height, caption, ink)
          : await this.rasterFigure(width, height, caption, ink)
    } catch (err) {
      this.exportStatus.textContent = err instanceof Error ? err.message : String(err)
      return
    }
    if (blob.size === 0) return
    downloadBlob(blob, `${base}.${this.exportFormat}`)
    this.exportStatus.textContent = ''
  }

  /** Room under the figure for the caption, at the size it is written in. */
  private get captionHeight(): number {
    return scaleLength(CAPTION_HEIGHT)
  }

  /** The figure as paths and text, at no resolution at all. */
  private async vectorFigure(
    width: number,
    height: number,
    caption: string,
    ink: string,
  ): Promise<Blob> {
    const page = new VectorPage(width, height + this.captionHeight)
    const ctx = page.ctx
    // The page under the drawing. The raster path composites this underneath at
    // the end; here it has to be the first thing painted, since a PDF is drawn
    // in order and has no `destination-over`.
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(0, 0, width, height + this.captionHeight)
    this.paint(ctx, width, height, false)
    ctx.font = scaleFont('11px Helvetica, sans-serif')
    ctx.textAlign = 'left'
    ctx.textBaseline = 'alphabetic'
    ctx.fillStyle = ink
    ctx.globalAlpha = 1
    ctx.fillText(caption, 2, height + this.captionHeight - 5)
    return page.toBlob({ title: this.props.assembly.name })
  }

  /** The same figure as pixels, redrawn at the requested resolution. */
  private async rasterFigure(
    width: number,
    height: number,
    caption: string,
    ink: string,
  ): Promise<Blob> {
    const scale = scaleForDpi(this.exportDpi)
    const fits = largestDpiThatFits(width, height + this.captionHeight)
    if (fits !== null && fits < this.exportDpi) {
      this.exportStatus.textContent = `${fits} dpi is the largest that fits this figure.`
      return new Blob([])
    }
    const out = document.createElement('canvas')
    out.width = Math.max(1, Math.round(width * scale))
    out.height = Math.max(1, Math.round((height + this.captionHeight) * scale))
    const ctx = out.getContext('2d')
    if (ctx === null) throw new Error('Could not open a canvas to draw the figure on.')
    ctx.setTransform(scale, 0, 0, scale, 0, 0)
    this.paint(ctx, width, height, false)

    ctx.setTransform(scale, 0, 0, scale, 0, 0)
    ctx.font = scaleFont('11px system-ui, sans-serif')
    ctx.textAlign = 'left'
    ctx.textBaseline = 'alphabetic'
    ctx.fillStyle = ink
    ctx.fillText(caption, 2, height + this.captionHeight - 5)
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.globalCompositeOperation = 'destination-over'
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(0, 0, out.width, out.height)
    ctx.globalCompositeOperation = 'source-over'
    return canvasToPng(out)
  }

  // -------------------------------------------------------------------------
  // Gestures
  // -------------------------------------------------------------------------

  /** The lane an entry is the host of, so a group moves as one. */
  private laneOf(entry: AnnotationEntry): Lane | undefined {
    return this.lanes.find((lane) => lane.entry.id === entry.id)
  }

  /**
   * Whether a point is on the name column's own right edge, which resizes it.
   *
   * Below the ruler only: the band above is a range selection, and a reader
   * dragging out a window should not have the first few pixels of it taken by a
   * column they were not aiming at.
   */
  private onColumnEdge(x: number, y: number): boolean {
    return this.nameColumn > 0 && y >= this.rulerHeight && Math.abs(x - this.gutter) <= COLUMN_GRIP
  }

  private laneAt(y: number): { lane: Lane; onBorder: boolean } | null {
    for (const lane of this.lanes) {
      const offset = y - lane.frame.acrossFrom
      if (offset < -LANE_GRIP || offset > lane.frame.thickness + LANE_GRIP) continue
      return { lane, onBorder: offset > lane.frame.thickness - LANE_GRIP }
    }
    return null
  }

  private watchPointer(): void {
    const canvas = this.canvas
    const at = (event: MouseEvent): { x: number; y: number } => {
      const rect = canvas.getBoundingClientRect()
      return { x: event.clientX - rect.left, y: event.clientY - rect.top }
    }

    const onDown = (event: PointerEvent): void => {
      if (event.button !== 0) return
      const { x, y } = at(event)
      // A limit under a track's name is a text box that happens to be painted.
      // Checked before the pointer is captured, so the press never becomes the
      // start of a pan the reader did not ask for.
      const limit = this.rangeAt(x, y)
      if (limit !== null) {
        event.preventDefault()
        this.editor.openLimit(limit, NO_OFFSET)
        return
      }
      // The handle, before anything reads a direction out of the press: it is
      // inside the lane, so the lane's own three-way drag would take it, and the
      // whole point of a handle is that it needs no direction at all.
      const held = this.gripAt(x, y)
      if (held !== null) {
        canvas.setPointerCapture(event.pointerId)
        canvas.classList.add('grabbing')
        this.tooltip.classList.add('hidden')
        this.drag = { mode: 'reorder', entry: held.entry, over: this.lanes.indexOf(held) }
        event.preventDefault()
        return
      }
      // The column's edge, after the handles and before the names: a lane's
      // handle hangs in the last few pixels of the column and is the smaller
      // target, and a drag that widened the column when a reorder was meant is
      // the worse miss. A double click gives the column back to the names.
      if (this.onColumnEdge(x, y)) {
        event.preventDefault()
        if (event.detail === 2) {
          this.pinnedColumn = null
          writeNameColumn(null)
          this.schedule()
          return
        }
        canvas.setPointerCapture(event.pointerId)
        this.tooltip.classList.add('hidden')
        this.drag = { mode: 'column', x0: x, from: this.nameColumn }
        return
      }
      // …and the name last of the three, for the reason the limit is first: it is
      // text on a canvas that a reader changes. *After* the handle, because the
      // two come within a few pixels of each other at the end of the name column
      // and the handle is the smaller target — a caret opening where a reorder
      // was meant is the worse miss of the two.
      const named = this.nameAt(x, y)
      if (named !== null) {
        event.preventDefault()
        this.editor.openName(named, NO_OFFSET)
        return
      }
      canvas.setPointerCapture(event.pointerId)
      canvas.focus({ preventScroll: true })
      // The readout is about where the pointer *was*: `describe` only runs when
      // no gesture is in progress, so left up it sits over a selection being
      // dragged naming a position two hundred pixels away — and contradicting
      // the coordinates written at the selection's own edges.
      this.tooltip.classList.add('hidden')
      // A picking mode owns the gesture outright, wherever on the canvas it
      // began: the reader armed it from the sidebar and every press until they
      // disarm it is one of the marks they armed it to place. Which gesture it
      // is comes from the form, exactly as it does on the map — a form waiting
      // for an extent takes the marquee this view already draws for a zoom, and
      // one waiting for a place takes a press that becomes a point on release.
      //
      // The three editors above are still checked first. A limit, a handle and a
      // name are controls that happen to be painted, and a mode over the data
      // must not swallow the caret in a text box.
      if (this.picking !== null) {
        this.drag =
          this.picking.box !== undefined
            ? { mode: 'select', x0: x, x }
            : { mode: 'press', x0: x, y0: y, lane: null, onBorder: false }
        return
      }
      // A press on the *ruler* is a range selection, with no modifier. The
      // coordinate strip is where a reader points to say "this much", and
      // asking them to hold a key to say it there — while a drag on the tracks
      // below it means pan, which is the other thing a hand wants — is a
      // keystroke spent on the one gesture that is unambiguous from its
      // position alone.
      if (y < this.rulerHeight) {
        this.drag = { mode: 'select', x0: x, x }
        return
      }
      const hit = this.laneAt(y)
      // What is left once the handle has been ruled out: a lane's lower border
      // resizes it, and everything else is a pan (or a selection, with the key).
      this.drag = { mode: 'press', x0: x, y0: y, lane: hit?.lane ?? null, onBorder: hit?.onBorder ?? false }
    }

    const onMove = (event: PointerEvent): void => {
      const { x, y } = at(event)
      const drag = this.drag
      if (drag === null) {
        this.hover = { x, y }
        this.describe(x, y, event.clientX, event.clientY)
        this.publishHover(x)
        // Drawn rather than shown as a cursor: the pointer is the arrowhead
        // everywhere on this canvas, so the affordance has to be in the picture.
        const grip = this.laneAt(y)
        this.gripping = grip?.onBorder === true ? grip.lane.entry.id : null
        // …with the exceptions the arrowhead cannot make. Over a limit the
        // pointer *is* the affordance, because "this text is a text box" is a
        // claim only a caret makes; over the ruler it says which of the two
        // things a press there will do — a name is a link to that sequence, and
        // the rest of the band is a range waiting to be dragged out.
        const onRuler = y < this.rulerHeight
        const onName = onRuler && this.bandNameAt(x, y) !== null
        // …and over a handle, where the open hand is the one shape that says
        // "take hold of this". The arrowhead points *at* a base pair, which is
        // the one thing the handle is not.
        // In this order, because the press is tested in this order: a limit, a
        // handle and a name can all come within a couple of pixels of each other
        // on a lane whose name column is narrower than its range, and a cursor
        // promising one while the press does another is worse than either.
        const onRange = !onRuler && this.rangeAt(x, y) !== null
        const onGrip = !onRuler && !onRange && this.gripAt(x, y) !== null
        const onEdge = !onRuler && !onRange && !onGrip && this.onColumnEdge(x, y)
        const onLabel = !onRuler && !onRange && !onGrip && !onEdge && this.nameAt(x, y) !== null
        canvas.classList.toggle('is-grab', onGrip)
        canvas.classList.toggle('is-text', onRange || onLabel)
        // …and over the floor a lane is resized by, the double arrow every
        // application uses for exactly that, which is also what the map's own
        // box handles show. The drawn rule stays: it is what says *which* lane
        // the border belongs to, and the cursor is what says it can be dragged.
        canvas.classList.toggle(
          'is-resize-across',
          !onRuler && !onRange && !onGrip && !onEdge && this.gripping !== null,
        )
        // The one place this canvas shows a *system* cursor: the divider is a
        // hairline, and `col-resize` is the shape every application uses to say
        // a vertical rule can be dragged sideways.
        canvas.classList.toggle('is-col', onEdge)
        if (onEdge !== this.onColumn) this.onColumn = onEdge
        canvas.classList.toggle('is-link', onName)
        canvas.classList.toggle('is-span', onRuler && !onName)
        this.schedule()
        return
      }
      if (drag.mode === 'press') {
        const dx = x - drag.x0
        const dy = y - drag.y0
        if (Math.abs(dx) + Math.abs(dy) < DRAG_SLACK) return
        if (drag.onBorder && drag.lane !== null) {
          this.drag = { mode: 'resize', entry: drag.lane.entry, y0: drag.y0, size: drag.lane.entry.style.size }
        } else if (event.altKey || event.shiftKey) {
          // Either modifier, and Shift is the one that matters: it is what the
          // map takes for the same gesture, so a reader who learned "hold Shift
          // and drag across the bit you want" on one surface finds it on the
          // other. Option stays because it is what this view has always taken.
          this.drag = { mode: 'select', x0: drag.x0, x }
        } else if (Math.abs(dy) > Math.abs(dx) && scalableLane(drag.lane) !== null) {
          // Across the lane rather than along it, which is the one direction a
          // drag on a track had no meaning in: a pan reads the axis and a
          // vertical drag moved the view by nothing at all. The direction is read
          // once, at the slack, so a pan that wanders a few pixels off the
          // horizontal stays the pan it started as.
          const lane = drag.lane as Lane
          this.drag = {
            mode: 'scale',
            lane,
            members: scalableLane(lane) ?? [],
            from: drag.y0 - lane.frame.acrossFrom,
          }
          this.scaling = { id: lane.entry.id, factor: 1 }
        } else {
          this.drag = { mode: 'pan', x: drag.x0, from: this.scale.domain[0] }
        }
        return
      }
      if (drag.mode === 'scale') {
        this.scaling = {
          id: drag.lane.entry.id,
          factor: ceilingFactor(
            drag.lane.frame,
            drag.from,
            y - drag.lane.frame.acrossFrom,
            drag.members[0]?.style.flip === true,
          ),
        }
        this.schedule()
        return
      }
      if (drag.mode === 'column') {
        // Held in the field and written once on release, as the ceiling drag is:
        // a store write per frame of a drag is a hundred writes for one decision.
        this.pinnedColumn = clampNameColumn(drag.from + (x - drag.x0), this.canvasWidth)
        this.schedule()
        return
      }
      if (drag.mode === 'pan') {
        this.panBy(x - drag.x)
        drag.x = x
        return
      }
      if (drag.mode === 'select') {
        drag.x = x
        this.schedule()
        return
      }
      if (drag.mode === 'resize') {
        this.props.store.restyle(drag.entry.id, {
          size: Math.max(LANE_MIN_SIZE, Math.round(drag.size + (y - drag.y0))),
        })
        return
      }
      // Reordering: the lane follows the pointer through the stack, one slot at
      // a time, so the list is always in the order it looks like it is in.
      //
      // Acted on once per lane *crossed*, not once per pointer move. Without
      // that an overlay group thrashes: moving its host past its own members
      // only re-elects a host, the two orders draw identically, and the move
      // fires again on every event — each one a `sessionStorage` write and a
      // rebuild of the Groups card.
      const index = this.lanes.findIndex(
        (lane) => y < lane.frame.acrossFrom + lane.frame.thickness,
      )
      if (index < 0 || index === drag.over) return
      drag.over = index
      const over = this.lanes[index]
      if (over.entry.id === drag.entry.id) return
      // The whole list, because the lanes are drawn from the whole list: in this
      // view a pair is an arc in a lane of its own, so the two store cards are
      // one stack on screen and one order underneath it.
      const to = this.props.store.entries.findIndex((row) => row.id === over.entry.id)
      if (to < 0) return
      // The whole lane moves, which for a group drawn in overlay mode is every
      // member of it: they share one slot on screen and splitting them would
      // put half a group somewhere else.
      const members = [drag.entry, ...(this.laneOf(drag.entry)?.overlaid ?? [])]
      members.forEach((member, offset) => this.props.store.moveTo(member.id, to + offset))
    }

    const onUp = (event: PointerEvent): void => {
      const drag = this.drag
      this.drag = null
      canvas.classList.remove('grabbing')
      if (drag === null) return
      const { x, y } = at(event)
      if (drag.mode === 'press') {
        // A press that did not travel, while a mode is on, is the mark it was
        // armed to place — reported now rather than through {@link clickAt},
        // which waits a quarter of a second for a second click that here would
        // only mean a second mark. The mode stays on afterwards: marking up a
        // figure is several marks, and it ends when the card or Escape says so.
        if (this.picking !== null) {
          this.pickPlace(x)
          return
        }
        this.clickAt(x, y)
        return
      }
      if (drag.mode === 'scale') {
        this.commitScaling(drag.members)
        return
      }
      if (drag.mode === 'column') {
        writeNameColumn(this.pinnedColumn)
        this.schedule()
        return
      }
      if (drag.mode === 'select') {
        const from = this.atUnit(Math.min(drag.x0, x))
        const to = this.atUnit(Math.max(drag.x0, x))
        // A marquee drawn while a form is waiting for an extent is that extent,
        // and never a zoom: taking the picture out from under a reader who was
        // drawing a box on it is the one thing this mode must not do. A drag
        // that did not travel places nothing — it is a drag the reader gave up
        // on — and, like the map's, it does not fall back to navigating either.
        if (this.picking?.box !== undefined) {
          if (to - from > 1 && Math.abs(x - drag.x0) > DRAG_SLACK) this.pickSpan(from, to)
          this.schedule()
          return
        }
        if (to - from > 1 && Math.abs(x - drag.x0) > DRAG_SLACK) {
          this.copyBand(from, to)
          this.scale.setDomain([from, to])
          this.afterMove(true)
          return
        }
        // A selection nobody dragged is a click, and on the ruler a click on a
        // sequence's name goes to that sequence. Without this it went nowhere:
        // a press on the ruler becomes a `select` immediately — that is what
        // makes drag-to-zoom need no modifier — and this branch used to end the
        // gesture silently, so the band-click navigation the ruler was built
        // with had no way of being reached.
        this.clickAt(x, y)
        return
      }
      // The end of a gesture is the position worth a history entry.
      if (drag.mode === 'pan') this.afterMove(true)
      this.schedule()
    }

    const forget = (): void => {
      this.hover = null
      this.publishHover(null)
      this.gripping = null
      this.onColumn = false
      canvas.classList.remove(
        'is-text',
        'is-link',
        'is-span',
        'is-grab',
        'is-col',
        'is-resize-across',
      )
      this.tooltip.classList.add('hidden')
      setReadout('')
      this.schedule()
    }

    /**
     * Leaving the canvas — unless it is for the lane's own controls.
     *
     * Those controls are shown, and clickable, only while the lane they belong
     * to is the one being pointed at, and the pointer being on them is *how* it
     * is being pointed at. Counting that as having left the view starts an
     * oscillation rather than merely hiding a row: the row goes transparent to
     * the pointer, which puts the pointer back on the canvas, which reveals the
     * row again, sixty times a second, and the control under the hand is never
     * there long enough to be clicked.
     */
    const onLeave = (event: PointerEvent): void => {
      const to = event.relatedTarget
      if (to instanceof Node && this.overlays.contains(to)) return
      forget()
    }

    /** …and leaving those controls for anywhere but the canvas ends it. */
    const onOverlayLeave = (event: PointerEvent): void => {
      const to = event.relatedTarget
      if (to instanceof Node && (this.canvas.contains(to) || this.overlays.contains(to))) return
      forget()
    }

    const onWheel = (event: WheelEvent): void => {
      const { x, y } = at(event)
      // ⌘-scroll over a lane is this view's own gesture: it raises or lowers
      // *that track's* ceiling, which in a genome browser is the adjustment a
      // reader makes constantly and which no map has an analogue for.
      //
      // ⌘ on a Mac and Alt elsewhere, and **never** Ctrl. A trackpad pinch is
      // delivered as a `wheel` event with `ctrlKey` set, on every platform, so
      // taking Ctrl here would swallow every pinch and silently run away with a
      // track's ceiling instead of zooming — and on Windows and Linux it would
      // shadow the browser's own zoom as well. Left alone, a pinch falls through
      // to the zoom below, which is what a pinch should do.
      if (CEILING_MODIFIER(event)) {
        const hit = this.laneAt(y)
        if (hit === null) return
        event.preventDefault()
        this.nudgeCeiling(hit.lane, event.deltaY < 0 ? 1 / CEILING_STEP : CEILING_STEP)
        return
      }
      // A sideways scroll pans, which is what a trackpad's two fingers mean in
      // every genome browser there is.
      if (Math.abs(event.deltaX) > Math.abs(event.deltaY)) {
        event.preventDefault()
        this.panBy(-event.deltaX)
        return
      }
      event.preventDefault()
      // Exponential in the delta, so a trackpad's many small events and a
      // wheel's few large ones compose to the same total zoom — the same rule
      // the heatmap uses, so the two feel like one application.
      this.scale.zoomAt(x - this.gutter, Math.exp(-event.deltaY * 0.002))
      this.nudged()
    }

    const onDouble = (event: MouseEvent): void => {
      event.preventDefault()
      if (this.clickTimer !== null) {
        clearTimeout(this.clickTimer)
        this.clickTimer = null
      }
      const { x } = at(event)
      if (event.altKey) this.zoomBy(1 / 2.5, x)
      else this.fit()
    }

    const onMenu = (event: MouseEvent): void => {
      const { y } = at(event)
      const hit = this.laneAt(y)
      if (hit === null) return
      event.preventDefault()
      // No edge: this surface has no map for a lane to be beside, so there is
      // no location to offer and every lane reads the way a horizontal track
      // under a ruler does.
      openLaneMenu(event.clientX, event.clientY, hit.lane.entry, this.props.store, null)
    }

    canvas.addEventListener('pointerdown', onDown)
    canvas.addEventListener('pointermove', onMove)
    // A cancel means the gesture was taken *away*, not that it finished:
    // treating it as a release fires the pending click — a navigation nobody
    // asked for — or commits a half-drawn zoom selection.
    const onCancel = (): void => {
      this.drag = null
      this.scaling = null
      canvas.classList.remove('grabbing')
      this.schedule()
    }

    /**
     * Escape abandons the gesture in progress, leaving the view where it was.
     *
     * The way out of a drag that has gone wrong, and the same key doing the same
     * thing on the contact map. A span is committed on release and a release
     * cannot be taken back, so without this the only way to undo a marquee drawn
     * in the wrong place was to let it zoom somewhere and navigate back.
     *
     * A pan is *rewound* rather than merely stopped: a pan that ends where the
     * reader changed their mind is the pan happening anyway. The other modes —
     * resizing a lane, dragging one up the stack, dragging the name column's
     * edge — write on release, so dropping the drag is already the whole of
     * undoing them.
     *
     * On the window and capturing, because a drag is very often begun without
     * the canvas ever taking the focus, and the key would otherwise be read by
     * whatever the reader last clicked on.
     */
    const onAbort = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      // The way out of the *mode*, before the way out of the gesture inside it.
      // On the window rather than the canvas, and for the reason the whole
      // listener is: the mode is armed from a button in a side panel, so the
      // focus at the moment the reader changes their mind is very often not on
      // the plot — and a way out that only works if you first click the thing
      // you were trying not to click is not a way out. The press is not stopped
      // here: Escape closes menus and cancels drags elsewhere in this app, and
      // one press putting away everything it can is what a reader expects.
      if (this.picking !== null) {
        event.preventDefault()
        this.cancelPicking()
      }
      const drag = this.drag
      if (drag === null) return
      event.preventDefault()
      event.stopPropagation()
      if (drag.mode === 'pan') {
        this.scale.setDomain([drag.from, drag.from + this.scale.span])
      }
      onCancel()
    }
    window.addEventListener('keydown', onAbort, true)
    canvas.addEventListener('pointerup', onUp)
    canvas.addEventListener('pointercancel', onCancel)
    canvas.addEventListener('pointerleave', onLeave)
    this.overlays.addEventListener('pointerleave', onOverlayLeave)
    canvas.addEventListener('wheel', onWheel, { passive: false })
    canvas.addEventListener('dblclick', onDouble)
    canvas.addEventListener('contextmenu', onMenu)
    this.unsubscribes.push(() => {
      canvas.removeEventListener('pointerdown', onDown)
      canvas.removeEventListener('pointermove', onMove)
      canvas.removeEventListener('pointerup', onUp)
      canvas.removeEventListener('pointercancel', onCancel)
      window.removeEventListener('keydown', onAbort, true)
      canvas.removeEventListener('pointerleave', onLeave)
      this.overlays.removeEventListener('pointerleave', onOverlayLeave)
      canvas.removeEventListener('wheel', onWheel)
      canvas.removeEventListener('dblclick', onDouble)
      canvas.removeEventListener('contextmenu', onMenu)
    })
  }

  /**
   * Move one track's ceiling by a factor.
   *
   * From whatever it is *resolved to* rather than from what is stored, so the
   * first ⌘-scroll on an auto-scaled track starts from the range on screen
   * instead of jumping to a stored `[0, 1]` nobody chose.
   */
  /**
   * The end of a scaling drag: one store write for the whole gesture.
   *
   * From the range that was resolved when the drag began, which is the one the
   * faded copy has been standing at all along — so the axis a reader let go on
   * is the axis they get. Every track in the lane, because they share it.
   */
  private commitScaling(members: readonly AnnotationEntry[]): void {
    const held = this.scaling
    this.scaling = null
    this.schedule()
    if (held === null || held.factor === 1) return
    for (const member of members) {
      if (!hasTrackControls(member.kind)) continue
      const next = nudgedLimits(member.style.limits, this.extentOf(member.id), held.factor)
      if (next !== null) this.props.store.restyle(member.id, { limits: next })
    }
  }

  /** The extent one track's data covers on screen, its group included. */
  private extentOf(id: string): { min: number; max: number } | null {
    const groups = this.groupRanges()
    for (const lane of this.lanes) {
      const row = lane.profiles.find((profile) => profile.entry.id === id)
      if (row !== undefined) return extentFor(row.entry, row.profile.extent, groups)
    }
    return null
  }

  private nudgeCeiling(lane: Lane, factor: number): void {
    const groups = this.groupRanges()
    const row = lane.profiles.find((entry) => entry.entry.id === lane.entry.id) ?? lane.profiles[0]
    const target = row?.entry ?? lane.entry
    if (!hasTrackControls(target.kind)) return
    // Through the group, as the drag does. Nudging from the lane's *own* peak
    // while its axis is showing the group's is one notch moving the ceiling by
    // a factor of the wrong number — a lane peaking at 5 in a group drawn to
    // 100 jumps to 6.25 instead of 125.
    const extent = extentFor(target, row?.profile.extent ?? null, groups)
    const next = nudgedLimits(target.style.limits, extent, factor)
    if (next !== null) this.props.store.restyle(target.id, { limits: next })
  }

  /**
   * A click that did not travel: a feature, a sequence name, or nothing.
   *
   * Deferred behind the double-click window, because the second click of "put it
   * back" must not land after the first has zoomed somewhere.
   */
  private clickAt(x: number, y: number): void {
    if (this.clickTimer !== null) clearTimeout(this.clickTimer)
    this.clickTimer = window.setTimeout(() => {
      this.clickTimer = null
      if (y < this.rulerHeight) {
        // The *name*, not the band. A band is as wide as its sequence is on
        // screen, so at whole-genome zoom clicking anywhere in the top sixty
        // pixels would zoom somewhere — including the click that ended a drag
        // a few pixels short of being one. The name is what looks clickable and
        // is the only thing that is.
        const band = this.bandNameAt(x, y) ?? (this.bands.length === 1 ? this.bandAt(x) : null)
        if (band !== null) this.goTo(band.contig)
        return
      }
      // Reads first. A pile fills the lane it is in, so every click inside one
      // would otherwise fall through to "reveal this track" — which is the
      // right answer for the gaps between reads and the wrong one for the reads
      // themselves.
      const read = this.readAtPoint(x, y)
      if (read !== null) {
        this.featureDialog?.close()
        const span = paddedSpan(read.pile.refStart[read.index], read.pile.refEnd[read.index])
        const contig = read.pile.contig
        this.featureDialog = openReadDialog({
          pile: read.pile,
          index: read.index,
          source: read.source,
          onGoTo: () => this.goTo(`${contig}:${Math.max(1, span.start + 1)}-${span.end}`),
          onClose: () => {
            this.featureDialog = null
          },
        })
        return
      }
      const hit = this.featureAtPoint(x, y)
      if (hit === null) {
        // Nothing under the pointer but the lane itself, and a press on a lane
        // is the most direct way a reader has of saying *this track*. It opens
        // that track's settings in the card that holds them — the alternative
        // being to match a name against a list in a column that may be scrolled
        // somewhere else entirely.
        const lane = this.laneAt(y)
        if (lane !== null && !lane.onBorder) revealTrack(lane.lane.entry.id)
        return
      }
      const { set, index, source } = hit
      const contig = set.contigs[set.contig[index]]
      const start = set.start[index]
      const end = set.end[index]
      // The card, not the zoom. A gene that has been clicked is already on
      // screen, so "go there" answers a question the reader did not have; what
      // they want is the systematic name, the biotype and the exons, in
      // something that stays open long enough to be read and copied out of.
      // Zooming is still one press away, inside it.
      this.featureDialog?.close()
      this.featureDialog = openFeatureDialog({
        set,
        index,
        source,
        onGoTo: () => {
          // The same margin a search hit gets, from the same function: finding a
          // gene by name and framing the gene you clicked are two gestures for
          // one intention, and the picture must not shift between them.
          const span = paddedSpan(start, end)
          this.goTo(`${contig}:${Math.max(1, span.start + 1)}-${span.end}`)
        },
        onClose: () => {
          this.featureDialog = null
        },
      })
    }, DOUBLE_CLICK_MS)
  }

  /**
   * The read under a canvas point, or `null`.
   *
   * {@link featureAtPoint}'s twin, over the bands the last paint recorded. It
   * asks `readAt` — the drawing module's own inverse — rather than reimplementing
   * the row arithmetic here, which is what keeps the click and the rectangle
   * agreeing (§8.4).
   */
  private readAtPoint(
    x: number,
    y: number,
  ): { pile: ReadPile; index: number; source: string } | null {
    for (const lane of this.lanes) {
      const band = this.piled.get(lane.entry.id)
      if (band === undefined) continue
      // Backwards, so a lane drawn over another answers first — the same
      // last-drawn-wins rule `featureAt` follows within one lane.
      for (let i = band.window.piles.length - 1; i >= 0; i--) {
        const pile = band.window.piles[i]
        const placed = band.placed[i]
        if (placed === undefined) continue
        const at = readAt(band.frame, this.axis, pile, placed, READ_ROW, READ_ROW_GAP, x, y)
        if (at !== null) return { pile, index: at, source: lane.entry.label }
      }
    }
    return null
  }

  private featureAtPoint(
    x: number,
    y: number,
  ): { set: FeatureSet; index: number; source: string } | null {
    for (const lane of this.lanes) {
      const cached = this.layouts.get(lane.entry.id)
      const set = lane.entry.payload?.kind === 'features' ? lane.entry.payload.data : null
      if (cached === undefined || set === null) continue
      const hit = featureAt(cached.frame, cached.layout, x, y)
      // The lane's own label comes back with the hit: the card names the track
      // the feature was read from, and asking the store for it afterwards would
      // mean matching an id against a list this loop is already standing in.
      if (hit !== null) return { set, index: hit.index, source: lane.entry.label }
    }
    return null
  }

  private watchKeys(): void {
    const onKey = (event: KeyboardEvent): void => {
      if (event.metaKey || event.ctrlKey || event.altKey) return
      const step = (this.scale.domain[1] - this.scale.domain[0]) * 0.2
      switch (event.key) {
        case 'ArrowLeft':
          this.scale.panByUnits(-step)
          break
        case 'ArrowRight':
          this.scale.panByUnits(step)
          break
        case '+':
        case '=':
          this.scale.zoomAt(this.scale.pixels / 2, 1.8)
          break
        case '-':
        case '_':
          this.scale.zoomAt(this.scale.pixels / 2, 1 / 1.8)
          break
        case '0':
          this.scale.reset()
          break
        default:
          return
      }
      event.preventDefault()
      // Held arrow keys repeat; one history entry for the whole hold.
      this.nudged()
    }
    this.canvas.addEventListener('keydown', onKey)
    this.unsubscribes.push(() => this.canvas.removeEventListener('keydown', onKey))
  }

  // -------------------------------------------------------------------------
  // The readout
  // -------------------------------------------------------------------------

  /**
   * Where the pointer is, and what every track says there.
   *
   * Every track, not the one under the pointer: the question a stack of tracks
   * exists to answer is "what do all of these do here", and answering it one
   * lane at a time means moving the pointer between lanes and remembering the
   * numbers. The same reasoning, and the same layout, as beside the map.
   */
  /**
   * Where the pointer is, at the precision the view can actually resolve.
   *
   * `fmt.bp` rounds to a readable unit — `477.6 kb` — which is the right answer
   * across a whole genome, where one pixel is thirteen thousand bases and a
   * figure to the base would be six digits of noise. Zoomed in it is the wrong
   * answer twice over: the number stops changing as the pointer moves, and the
   * position it names is not the one under the arrowhead. So once a pixel is
   * worth a few bases, the readout says the base.
   */
  private describePosition(locus: { contig: string; bp: number }): string {
    const perPixel = (this.scale.domain[1] - this.scale.domain[0]) / Math.max(1, this.scale.pixels)
    return perPixel <= EXACT_BP_PER_PIXEL
      ? `${locus.contig}:${fmt.int(Math.round(locus.bp) + 1)}`
      : `${locus.contig}:${fmt.bp(locus.bp)}`
  }

  private describe(x: number, y: number, clientX: number, clientY: number): void {
    // Nothing before the axis begins. The strip there is the handles' margin and
    // the name column, and neither is a position: a readout naming a base pair
    // while the pointer is on a track's *name* would be answering a question
    // nobody asked, at a coordinate the arrowhead is not on.
    const locus = x < this.gutter ? null : this.axis.unitToLocus(this.atUnit(x))
    if (locus === null) {
      this.tooltip.classList.add('hidden')
      setReadout('')
      return
    }
    const where = this.describePosition(locus)
    const rows: HTMLElement[] = []
    const parts: string[] = []
    // Which lane the pointer is actually inside. Every track is read at this
    // position, because "what do all of these do here" is the question a stack
    // is there to answer — but the one being pointed at is set in its own name's
    // weight, so the answer to "and this one?" does not have to be counted out.
    const inside = this.lanes.find(
      (lane) => y >= lane.frame.acrossFrom && y <= lane.frame.acrossFrom + lane.frame.thickness,
    )
    for (const lane of this.lanes) {
      for (const { entry, profile } of lane.profiles) {
        const slot = Math.round(x) - profile.from
        const value = slot >= 0 && slot < profile.mean.length ? profile.mean[slot] : Number.NaN
        const text = Number.isNaN(value) ? '—' : fmt.num(value)
        const here = inside !== undefined && (inside.entry.id === entry.id ||
          inside.overlaid.some((member) => member.id === entry.id))
        rows.push(
          el(
            'div',
            { class: `cell-tip-row${here ? ' is-here' : ''}` },
            el('span', { class: 'cell-tip-chip', style: { background: entry.style.colour } }),
            // The name in the track's own colour, which is the legend the
            // picture already uses: the line is that colour and so is this.
            el('span', {
              class: 'cell-tip-key',
              text: `${entry.label}:`,
              style: { color: entry.style.colour },
            }),
            el('span', { class: 'cell-tip-val', text }),
          ),
        )
        parts.push(`${entry.label} ${text}`)
      }
      // …and the base under the pointer, where a lane is showing them. The one
      // readout in this view that is a letter rather than a number, and the
      // question a reader zoomed in this far is asking.
      for (const { entry, regions } of lane.residues) {
        const letter = baseAt(regions, locus.contig, locus.bp) ?? '—'
        const here =
          inside !== undefined &&
          (inside.entry.id === entry.id ||
            inside.overlaid.some((member) => member.id === entry.id))
        rows.push(
          el(
            'div',
            { class: `cell-tip-row${here ? ' is-here' : ''}` },
            el('span', { class: 'cell-tip-chip', style: { background: entry.style.colour } }),
            el('span', {
              class: 'cell-tip-key',
              text: `${entry.label}:`,
              style: { color: entry.style.colour },
            }),
            el('span', { class: 'cell-tip-val', text: letter }),
          ),
        )
        parts.push(`${entry.label} ${letter}`)
      }
    }
    const read = this.readAtPoint(x, y)
    if (read !== null) {
      const { pile, index } = read
      const name = pile.names[index] ?? ''
      const strand = (pile.flags[index] & FLAG.REVERSE) !== 0 ? '−' : '+'
      rows.push(
        el('div', { class: 'cell-tip-row' }, el('span', {
          class: 'cell-tip-key',
          text: `${name === '' ? 'read' : name}   ${pile.contig}:${fmt.int(pile.refStart[index] + 1)}–${fmt.int(pile.refEnd[index])} (${strand})`,
        })),
      )
      rows.push(
        el('div', { class: 'cell-tip-row' }, el('span', {
          class: 'hint',
          text: `MAPQ ${pile.mapq[index]} · click for the whole record`,
        })),
      )
    }
    const feature = this.featureAtPoint(x, y)
    if (feature !== null) {
      const { set, index } = feature
      const strand = set.strand[index] === 1 ? ' (+)' : set.strand[index] === -1 ? ' (−)' : ''
      const label = featureLabel(set, index)
      const name = label === '' ? '' : `${label} `
      rows.push(
        el('div', { class: 'cell-tip-row' }, el('span', {
          class: 'cell-tip-key',
          text: `${name}${set.contigs[set.contig[index]]}:${fmt.int(set.start[index])}–${fmt.int(set.end[index])}${strand}`,
        })),
      )
      if (set.detail[index] !== '') {
        rows.push(el('div', { class: 'cell-tip-row' }, el('span', { class: 'hint', text: set.detail[index] })))
      }
    }

    setReadout(`${where}${parts.length === 0 ? '' : `   ${parts.join('   ·   ')}`}`)
    if (rows.length === 0) {
      this.tooltip.classList.add('hidden')
      return
    }
    // The same gate the map's card has, over the same store: a reader who put
    // the card away beside a matrix means it away, and finding it back in the
    // browser would be the app disagreeing with itself. `setReadout` above has
    // already run, so the status line keeps saying what the pointer is on.
    if (!getPlotOptions().tooltip) {
      this.tooltip.classList.add('hidden')
      return
    }
    this.tooltip.replaceChildren(
      el('div', { class: 'cell-tip-block' }, el('div', { class: 'cell-tip-pos', text: where }), ...rows),
    )
    this.tooltip.classList.remove('hidden')
    this.placeTip(clientX, clientY)
  }

  /**
   * Put the tooltip beside the pointer, and inside the window.
   *
   * The size is measured once per frame rather than on every move: reading
   * `offsetHeight` straight after writing the card's contents forces a
   * synchronous layout of the whole document, at whatever rate the device
   * reports pointer moves. So the box is placed immediately from the last known
   * size and corrected on the next frame if it changed — which for a tooltip
   * whose shape is the same three rows almost every time is almost never.
   */
  private placeTip(clientX: number, clientY: number): void {
    this.tipAt = { x: clientX, y: clientY }
    this.positionTip()
    if (this.tipFrame !== 0) return
    this.tipFrame = requestAnimationFrame(() => {
      this.tipFrame = 0
      const width = this.tooltip.offsetWidth
      const height = this.tooltip.offsetHeight
      if (width === this.tipSize.width && height === this.tipSize.height) return
      this.tipSize = { width, height }
      this.positionTip()
    })
  }

  /**
   * Flip and clamp against the **window**, not against the stage.
   *
   * This is the whole fix. The stage is as tall as the stack of tracks, which on
   * a session with a dozen of them is several screens — so a box clamped to the
   * stage is inside a box that mostly is not on screen, and a value read near
   * the foot of the window went under the edge of it every time. The bounds are
   * the intersection of the two, and the offset flips to the other side of the
   * pointer when the box will not fit on the near side.
   *
   * The stage rectangle has to be re-read here rather than cached: the page
   * scrolls, and the whole point of this arithmetic is where the stage is
   * relative to the viewport *now*.
   */
  private positionTip(): void {
    const at = this.tipAt
    if (at === null) return
    const pad = 14
    const gap = 4
    const { width, height } = this.tipSize
    const rect = this.stage.getBoundingClientRect()
    const minX = Math.max(rect.left, 0) + gap
    const maxX = Math.min(rect.right, window.innerWidth) - gap
    const minY = Math.max(rect.top, 0) + gap
    const maxY = Math.min(rect.bottom, window.innerHeight) - gap

    let x = at.x + pad
    if (x + width > maxX) x = at.x - pad - width
    let y = at.y + pad
    if (y + height > maxY) y = at.y - pad - height
    // `Math.max(minX, …)` on the upper bound as well, so a box wider than the
    // room left for it is pinned to the near edge rather than to a negative one.
    x = Math.min(Math.max(x, minX), Math.max(minX, maxX - width))
    y = Math.min(Math.max(y, minY), Math.max(minY, maxY - height))

    this.tooltip.style.left = `${x - rect.left}px`
    this.tooltip.style.top = `${y - rect.top}px`
  }

  // -------------------------------------------------------------------------
  // Search
  // -------------------------------------------------------------------------

  /**
   * Go where the box says, whichever of the two things it says.
   *
   * Coordinates win when the text is coordinates: `chrIV:1,000-2,000` is
   * unambiguous, and a gene that happened to match it would be a surprise. A
   * name the parser cannot read falls to the list under the box — the first hit,
   * which is the one the reader is looking at. Only when neither can make
   * anything of it does the box flash.
   */
  private submit(): void {
    const text = this.locusInput.value.trim()
    if (text === '') return
    if (parseLocus(text, this.props.assembly) === null) {
      const first = this.searchList.querySelector<HTMLElement>('.browser-hit:not(.is-empty)')
      if (first !== null) {
        first.click()
        return
      }
    }
    this.goTo(text)
    this.closeSearch()
  }

  /**
   * Find a feature by name across every loaded feature set.
   *
   * A linear scan over the `name` arrays, capped at the first handful of hits.
   * An index would be the right answer for a million-feature set and is the
   * wrong answer here: the arrays are already in memory, the scan stops at ten
   * matches, and building an index on load would cost every reader who never
   * types in this box.
   */
  private search(): void {
    const raw = this.locusInput.value.trim()
    const query = raw.toLowerCase()
    // A colon means coordinates, and coordinates have no names to suggest. The
    // list would be a "no match" hanging under a perfectly good locus.
    if (query.length < 2 || raw.includes(':')) {
      this.closeSearch()
      return
    }
    const hits: Array<{ label: string; locus: string }> = []
    // A sequence name is a search hit too: typing `chrIV` should go there
    // whether or not a gene happens to be called that.
    const contig = findContig(this.props.assembly, query)
    if (contig !== null) hits.push({ label: `${contig.name} · whole sequence`, locus: contig.name })

    // The scan is `annotations/search.ts`'s, and shared with the box beside a
    // map. What stays here is the *base*: a locus in this view is 1-based
    // inclusive (`genome/assembly.ts`) and a region on a map is 0-based
    // half-open (`metacooler/range.ts`), so the one place the two surfaces must
    // not share a line is the one that writes the string.
    for (const hit of findFeatures(this.props.store, raw)) {
      hits.push({
        label: `${hitLabel(hit)} · ${hit.contig}:${fmt.int(hit.start)} · ${hit.source}`,
        locus: `${hit.contig}:${Math.max(1, hit.start + 1)}-${hit.end}`,
      })
    }

    if (hits.length === 0) {
      this.searchList.replaceChildren(el('div', { class: 'browser-hit is-empty', text: 'no match' }))
      this.searchList.classList.remove('hidden')
      return
    }
    this.searchList.replaceChildren(
      ...hits.map((hit) =>
        button(hit.label, () => {
          this.goTo(hit.locus)
          this.closeSearch()
          // The box keeps the locus it went to, as it does for a typed one: it
          // is a locus bar as well as a search box, and a bar that empties
          // itself after every jump tells the reader nothing about where they
          // are.
          this.locusInput.value = hit.locus
        }, { class: 'browser-hit' }),
      ),
    )
    this.searchList.classList.remove('hidden')
  }

  /**
   * Put the hit list away, and *empty* it.
   *
   * Hiding alone left the buttons live, and Enter reaches the first of them
   * through a `querySelector` that does not care whether the list is on screen:
   * Escape then looked like a cancel and behaved like a deferred jump to a hit
   * nobody could see.
   */
  private closeSearch(): void {
    this.searchList.classList.add('hidden')
    this.searchList.replaceChildren()
  }
}

/** Where the track name sits inside its lane, from the lane's top edge. */
const NAME_TOP = 9
/** From that line's centre to the detail line's, and one line's room under it. */
const NAME_LINE = 13
const DETAIL_DROP = 14

/**
 * The sizes this view writes its small print at.
 *
 * Bigger than beside a map, in every field, and that is the difference between
 * the two surfaces rather than an accident: a lane here is ninety pixels and its
 * name is what identifies the row, while a lane beside a map can be sixteen and
 * its text has to fit in one. The block itself is drawn by
 * `render/laneLabel.ts`, which takes these rather than choosing them.
 */
function browserLabelStyle(): LaneLabelStyle {
  return {
    nameFont: scaleFont(NAME_FONT),
    rangeFont: scaleFont(RANGE_FONT),
    progressWidth: scaleLength(PROGRESS_WIDTH),
    progressThickness: scaleLength(PROGRESS_THICKNESS),
    // Everything but the grip is in the same units as the text it spaces: the
    // two line heights keep the name and the range apart, the hit height is the
    // click box a caret opens from, and the autoscale slot is a mark placed
    // against measured text. Leaving them fixed while the type grows is what
    // makes a scaled block overlap itself and the limit boxes miss their
    // glyphs. The grip is a pointer tolerance against a border and does not
    // move — the border does not get easier to hit because the writing is
    // larger.
    swatch: scaleLength(9),
    nameTop: scaleLength(NAME_TOP),
    nameLine: scaleLength(NAME_LINE),
    detailDrop: scaleLength(DETAIL_DROP),
    inset: scaleLength(5),
    hitHeight: scaleLength(15),
    autoSlot: scaleLength(16),
    grip: LANE_GRIP,
  }
}

/** The layer and the canvas share an origin here, so nothing is offset. */
const NO_OFFSET = { left: 0, top: 0 }

/**
 * The value tracks in a lane, or `null` where there is no axis to drag.
 *
 * A gene model and a peak set have no ceiling, so a drag across one has nothing
 * to mean and falls through to the pan it has always been. A sequence lane is
 * excluded for a reason of its own: GC content is a fraction, and an axis that
 * is not `[0, 1]` is not a fraction any more.
 */
function scalableLane(lane: Lane | null): AnnotationEntry[] | null {
  if (lane === null) return null
  // `profiles` alone, which is now the whole of it: a pile lane has no value
  // axis at all, and the depth a reader drags the ceiling of is the row beside
  // it (§8.13).
  const tracks = lane.profiles
    .map((row) => row.entry)
    .filter((entry) => hasTrackControls(entry.kind))
  return tracks.length === 0 ? null : tracks
}

/**
 * Whether a rectangle's two sides are the same stretch — the on-diagonal box.
 *
 * By value and not by identity: a mark that has been round-tripped through
 * session storage is two equal objects rather than one shared one, and a
 * diagonal box that came back from a previous visit would otherwise be washed
 * over the tracks twice.
 */
function sameSpan(one: ManualSpan, two: ManualSpan): boolean {
  return one.contig === two.contig && one.from === two.from && one.to === two.to
}


/**
 * The strip this view keeps at its left for the lane handles.
 *
 * The group bar, then the handle hanging just before the data starts. Every
 * lane in this view begins at the same place, so this is also what makes the
 * handles a *column* — one line of them down the side, at a constant x, which
 * is what a stack of rows with grips looks like everywhere else.
 *
 * Faint, permanent and outside every lane: the alternative was a slot cut out
 * of each track's label, which moved every name along and could only show the
 * handle on hover — because a permanent one would have been sitting on the
 * signal.
 *
 * Exported because it is where the axis *begins*, and a test that puts a click
 * on this canvas has to know that: a gesture aimed at the left edge lands in the
 * margin, where there is no coordinate at all and nothing is meant to happen.
 */
export const GRIP_MARGIN = GROUP_BAR + 2 + GRIP_ROOM

/**
 * How strongly a handle nobody is pointing at is drawn.
 *
 * Eight handles at full strength is a column of furniture down the side of the
 * picture. Faint enough to read as controls waiting to be used, solid enough to
 * be seen without hunting.
 */
const GRIP_IDLE = 0.45



/** Clear space between the end of a name and the start of the data. */
const GUTTER_PAD = 8

/**
 * Below this many bases per pixel, the readout names the base rather than
 * rounding to a unit.
 *
 * Ten is where the two answers part company: at ten bases per pixel `fmt.bp`
 * still writes kilobases, so moving the pointer a hundred pixels changes the
 * number by one digit — while the base under the arrowhead has moved a thousand
 * times. Above it the exact figure would be six digits of false precision about
 * a pixel covering thirteen thousand bases.
 */
const EXACT_BP_PER_PIXEL = 10

/**
 * One end of a lane's value axis, the box it was drawn in, and whose it is.
 *
 * The tracks are every track the range belongs to — which for an overlay group
 * is all of them, not the one whose limits happened to be written down. A lane
 * draws one range under however many names it holds, and that single pair is a
 * claim about the *lane*: the whole point of overlaying two tracks is that they
 * are drawn against one axis.
 */
interface RangeHit {
  entries: AnnotationEntry[]
  hit: LimitBox
}

/**
 * One track's name, the box it was drawn in, and whose it is.
 *
 * One entry rather than the lane's list, which is the whole difference from
 * {@link RangeHit}: a lane's range is a claim about the lane, and its names are
 * claims about the tracks in it.
 */
interface NameHit {
  entry: AnnotationEntry
  hit: NameBox
}

/** Room under the figure for the one-line caption the export adds. */
const CAPTION_HEIGHT = 18

/**
 * What this view saves as.
 *
 * Not `EXPORT_FORMATS`, which is the heatmap's list: there the PDF is a page
 * carrying one lossless image, because a contact map *is* a raster and pretending
 * otherwise would mean writing down a million rectangles. Here nothing is, so
 * the PDF is the drawing itself and says so on the button.
 */
const BROWSER_EXPORT_FORMATS = [
  { value: 'pdf', label: 'PDF (vector)' },
  { value: 'png', label: 'PNG' },
] as const
type BrowserExportFormat = (typeof BROWSER_EXPORT_FORMATS)[number]['value']

/** How long a continuous gesture must rest before the locus reaches the URL. */
const REPORT_DELAY = 220
