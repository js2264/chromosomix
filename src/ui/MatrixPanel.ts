/**
 * The heatmap panel: canvas, colourbar, colour controls, hover readout.
 *
 * Shared by the genome, pair, region and overview views so that all four have
 * the same defaults, the same keys and the same readout. Two properties matter
 * enough to state:
 *
 * 1. **Pan and zoom perform zero I/O.** The whole block is already in memory
 *    (spec §2), so every interaction here is a canvas transform over data that
 *    has already arrived. Nothing in this file holds a reference to the worker
 *    client, which makes that structural rather than a promise.
 * 2. **The scale rule is `metacooler show`'s** (§7.1) — `log1p`, `vmin = 0`,
 *    `vmax` at the 99th percentile of the non-zero *transformed* values,
 *    recomputed on every view change, with a manual override. `vmax: NaN` is
 *    how {@link HeatmapView} is asked for that default, so the number the CLI
 *    computes and the number drawn here come from one implementation. The
 *    *colormap* the panel opens with is the viewer's own ramp rather than the
 *    CLI's `afmhot_r`, which the picker still offers unchanged
 *    ({@link DEFAULT_UI_COLORMAP}).
 *
 * Interaction — drag, wheel, click, and the §7.2 keyboard pan and zoom — is
 * `HeatmapView.attach()`'s, not this panel's: the view owns the transform, so
 * it is the only thing that can move it coherently.
 */

import {
  MANUAL_PALETTE,
  formatPoint,
  mintMarkId,
  orderedSpan,
  type ManualArrowhead,
  type ManualLine,
  type ManualMark,
  type ManualPoint,
  type ManualRect,
  type ManualSpan,
  type ManualStore,
} from '../annotations/manual'
import type { GroupSettings } from '../annotations/groups'
import { AnnotationStore } from '../annotations/store'
import { everyTrackOpacityField } from './AnnotationCard'
import { KEYS, keyLabel, optionKey, shiftKey, withKey } from './commands'
import { cardTitle, icon, iconButton } from './icons'
import { LANE_EDGES, hasAMovableAxis, overlayShapeOf } from '../annotations/types'
import type { AnnotationClient } from '../annotations/worker/client'
import { LABEL_MIN_SPAN_BP, MAX_CATEGORICAL_TICKS } from '../constants'
import {
  drawKey,
  formatCount,
  keyContent,
  keyTitle,
  type KeyContent,
} from '../render/legend'
import { locusAxisFrom, type LocusAxis, type LocusWindow } from '../render/locus'
import { axisThroughEdit } from '../edit/axis'
import { stretchInFile } from '../edit/places'
import type { EditedAssembly } from '../genome/edit'
import { formatLocus, formatPosition } from '../genome/assembly'
import {
  drawArrowheads,
  drawDiagonalFeatures,
  drawManualLines,
  drawManualRects,
  manualMarksAt,
  drawPairs,
  type OverlayAxes,
  type OverlayFrame,
} from '../render/overlays'
import {
  AnnotationLanes,
  CORNER_SIDE,
  LANE_GAP,
  type LaneEdge,
  type LaneGeometry,
  type MetaAxes,
  type MetaSource,
} from './AnnotationLanes'
import type { MetaBlock } from '../annotations/metadata'
import {
  COMPARE_OPS,
  combine,
  isCompareOp,
  type CompareOp,
} from '../render/compare'
import {
  preferredTransform,
  type DerivedValues,
  type SmoothedField,
  type SmoothingRequest,
  type Normalisation,
} from '../render/derive'
import { SMOOTH_CHOICES } from '../render/smooth'
import type { CorrelationField } from '../analysis/compartments'
import type { Cancellable } from '../worker/client'
import {
  BIN_FRACTION,
  anchorColumns,
  binsForColumns,
  cellAt,
  cellLoci,
  isTurnable,
  rotateBlock,
  separationCoords,
  reachForRows,
  rowsForReach,
  separationForRows,
  turnDepthFor,
  turnedAxis,
  type RotateDirection,
  type RotatedBlock,
} from '../render/rotate'
import { alongAxis, anchorFor, turnedDense } from '../render/turnGeometry'
import {
  COLORMAP_NAMES,
  COLOR_VISION_SAFE_COLORMAPS,
  DEFAULT_DIVERGING_COLORMAP,
  DEFAULT_UI_COLORMAP,
  isDivergingColormap,
} from '../render/colormaps'
import {
  CROSSHAIR_COLOR,
  DEFAULT_LABEL_FONT,
  HeatmapView,
  type AxisCoordSet,
  type AxisSpanSet,
  type AxisCoords,
  type Cell,
  type PlotOptions,
  type DrawnBox,
  type SelectionBox,
  type SelectionText,
} from '../render/heatmap'
import {
  refineEnabled,
  setRefineEnabled,
  subscribeRefine,
  type RefineView,
} from './refine'
import { diagonalLocked, subscribeDiagonalLock, toggleDiagonalLock } from './diagonalLock'
import { inverseTransform, type Scale } from '../render/scale'
import type { ColorScale, DenseMatrix, Extent, Transform } from '../types'
import type { AnalysisFraming } from '../analysis/types'
import { BLOCK_COPY_LIMIT_BYTES, type BlockInput } from '../analysis/worker/protocol'
import type { AxisGroup, MatrixResult } from '../worker/protocol'
import { DEFAULT_ARM_WINDOW, armsInForce, armsKey, originInMiddle } from './armFrame'
import {
  axisCoordsFor,
  axisSpansFor,
  binsOf,
  bpWithin,
  groupAt,
  separatorsFor,
  slidesAlongDiagonal,
  spanOnAxis,
  toDense,
} from './blockAxes'
import { FIGURE_BACKGROUND, readCanvasPalette, readPageText } from './canvasPalette'
import { ClipRange } from './ClipRange'
import { GroupsCard } from './GroupsCard'
import { LEAD_MAP, type MapId } from '../annotations/placement'
import { COUNT_SCORE as DEFAULT_COUNT_COLUMN, type ScoreChoice } from './scores'
import {
  isArmed,
  locusText,
  pickLocus,
  subscribePick,
  type PickedLocus,
  type PickHandlers,
} from './mapPick'
import { bandRegion, onDiagonal, spanText, type SelectedAxis, type SelectedRegion } from './mapSelection'
import { framedPhrase, resolutionNote } from './mapSummary'
import { LaneControls } from './LaneControls'
import { LaneEditor } from './LaneEditor'
import { LaneGestures } from './LaneGestures'
import { MapBox } from './MapBox'
import { MAP_CORRELATION_BINS, MapDerivation } from './MapDerivation'
import { MapFigure } from './MapFigure'
import { MapReadout } from './MapReadout'
import {
  fieldPair,
  heightThatFills,
  setTrackHeight,
  smallestLaneSize,
  trackHeightField,
} from './trackControls'
import { el, field, fmt, trimNumber } from './dom'
import { resolutionLabel } from '../units'
import { depthPhrase, type DrawnDepth } from '../contacts'
import { MapKey } from './MapKey'
import {
  type ExportFormat,
  captionStamp,
  copyPicture,
  copyTextToClipboard,
} from './export'
import { openMenu, type MenuItem } from './Menu'
import { marksMenu } from './marksMenu'
import { offerLanding } from './laneCarry'
import type { CellFigure } from '../panels/deckFigure'
import { setReadout } from './readout'
import { HOVER_SOURCE_MAP, setHoverPlace, type HoverPlace } from './hoverLocus'
import {
  MATRIX_OPTIONS,
  PLOT_OPTION_ICONS,
  PLOT_OPTION_KEYS,
  PLOT_OPTION_LABELS,
  TRACK_ONLY_OPTIONS,
  getPlotOptions,
  setPlotOption,
  subscribePlotOptions,
  type PlotOptionKey,
} from './plotOptions'
import { scaleFont, subscribeTextScale, textScaleField } from './textScale'

const TRANSFORMS: Transform[] = ['log1p', 'log10', 'log2', 'none']

/**
 * What each way of putting two files together is called on screen.
 *
 * `split` rather than "diagonal" or "side by side": it is the word the card and
 * the spec already use for this, and a control that renamed it would leave a
 * reader looking for the feature they read about.
 */
const COMPARE_OP_LABELS: Record<CompareOp, string> = {
  split: 'split',
  ratio: 'ratio',
  difference: 'difference',
}

/**
 * The two faces of the turn toggle: **the shape it will give you**.
 *
 * A triangle while the map is square, because pressing it produces one — a
 * domain standing on a genomic axis is what a turned map looks like — and a
 * square once it is turned, because pressing it now brings that back. The mark
 * is the destination rather than the state, which is the one reading that never
 * needs a second glance: a toggle showing what you already have makes you check
 * the picture to find out what the button does.
 */
const TURN_ICONS = { off: 'triangle', on: 'square' } as const

/**
 * Three bars, left-aligned, longest at the top: a resolution ladder, read from
 * the coarse end down.
 *
 * The one mark in the set upstream does not supply; `scripts/build-icons.mjs`
 * says why, and why the nearest Lucide shape reads as a letter E at this size.
 *
 * One mark for both states, lit when on, like every other toggle in these rows.
 * The turn is the exception and earns it: triangle and square are two *pictures*
 * of the map, so the button shows which one you would get. There is no second
 * picture of a resolution.
 */
const REFINE_ICON = 'bars-decreasing'

const REFINE_HINT =
  'Adaptive resolution. Off, the block is read once and zooming magnifies it — which is what ' +
  'every map here has always done. On, zooming past what that block can show reads the same ' +
  'window again at a finer grid, down to the file’s own bins: the map holds still while it does, ' +
  'with a spinner in the corner, and Escape calls it off. Panning to the edge of what has been ' +
  'read fetches the next stretch at the same resolution. Nothing is tiled and nothing is ' +
  'stitched — every picture is one whole block.'

const TURN_HINT =
  'Turn the map 45°: position along the bottom, distance from the diagonal up the side. ' +
  'Available on one sequence against itself, which is the only block that has a diagonal ' +
  'to measure from.'

/**
 * One stroke along the main diagonal: the line the view is put back on.
 *
 * It was `move-diagonal-2` — the same line with an arrowhead on each end — and
 * the heads were saying the wrong thing twice. They read as *drag along here*,
 * and this button drags nothing; and at the 15 px these marks are drawn at, two
 * arrowheads are most of the ink, so the glyph chiefly showed arrows. The line
 * on its own is the diagonal, which is the whole of what the press is about.
 */
const DIAGONAL_ICON = 'diagonal'

/**
 * The diagonal lock's tooltip, in the reader's own modifier: read when the
 * button is built, since a module's constants are read before anything has
 * said which platform this is.
 */
const diagonalHint = (): string =>
  `Lock the view on the diagonal (${keyLabel(KEYS.diagonal)}). Slides it onto the nearest ` +
  'on-diagonal window at the zoom it is already at and keeps it there: a drag, a scroll, a ' +
  'zoom or an arrow key moves it along the diagonal, a sideways scroll slides down it, and ' +
  `${optionKey()} + drag draws its box on it. Pressed again, it lets go, and a sideways scroll ` +
  'is the columns alone. Greyed on a block that has no diagonal, and while the map is turned, ' +
  'where the picture already is one.'

const OE_HINT =
  'Observed over expected. Divide each cell by what its genomic distance predicts — the mean ' +
  'over every pair of bins that far apart, measured on this block, with one scalar between ' +
  'sequences. Contact frequency falls by orders of magnitude from the diagonal outwards and ' +
  'that decay is not what anybody is looking for; dividing it out makes the departures from it ' +
  'the picture. Drawn on a scale centred at 1, with a cell of nothing observed left as paper.'

const OE_ON_BASELINE_HINT =
  'The cells already are the expected values, so there is nothing left to divide by them. ' +
  'Choose another score to get the toggle back.'

const BASELINE_HINT =
  'The baseline O/E divides by, drawn instead of applied: every cell replaced by the mean of ' +
  'this block at that bin separation. Worth a look because an O/E is only as trustworthy as ' +
  'the curve underneath it, and at long separations that curve is averaged over few cells.'

const ARM_BASELINE_HINT =
  'The expected along both arms of a circular chromosome, drawn: every cell replaced by the mean ' +
  'of the cells as far apart along the arms, on one arm or across the two, so both diagonals are ' +
  'in it — the main one and the secondary one through the origin, which expected averages away.'

const ARMS_ON_ARM_BASELINE_HINT =
  'The cells already are the expected along both arms. Choose another score to get the toggle back.'

/** A colour scale a derivation took over, to be given back when it is switched off (§7.5). */
export interface BorrowedScale {
  transform: Transform
  colormap: string
  vmin?: number
  vmax?: number
}

export interface MatrixPanelOptions {
  /** Bin size in bp, for the coordinate readout. */
  binsize: number
  /** Offered aggregation levels; omit for views with no level toggle. */
  levels?: Array<'bin' | 'contig'>
  /**
   * What to *call* each level, where the file's vocabulary differs from the
   * internal name. A cooler's sequences are chromosomes, and a control offering
   * "contig" on one is the app speaking about a file in words the file does not
   * use.
   */
  levelLabels?: Partial<Record<'bin' | 'contig', string>>
  initial?: {
    transform?: Transform
    colormap?: string
    vmin?: number
    vmax?: number
    level?: 'bin' | 'contig'
    /**
     * The scale a derivation on the panel this one replaces had taken over, and
     * would have given back (§7.5): carried across a rebuild of the same map,
     * which is what a change of comparison and the second map's eye both are.
     * The seed above is then the borrowed scale, and this is what a map that
     * no longer derives anything goes back to.
     */
    restore?: BorrowedScale
    /**
     * What this map is drawn on with nothing set (§7.1), given back by a
     * derivation that arrived already drawn — a link, a reload, Back — whose
     * seed is the borrowed scale and never saw the one it replaced.
     */
    defaults?: { transform: Transform; colormap: string }
  }
  /** Whether counts are currently multiplied by their bin weights (§6.4). */
  balance?: boolean
  /**
   * What the cells can be drawn from, and which of those they are.
   *
   * One control where there were two halves of a question: a tickbox that said
   * "balanced" and no way at all to reach a file's other `/pixels` columns. See
   * `ui/scores.ts` for why balancing is in the same list as the columns despite
   * being a transform rather than one.
   *
   * Absent on a view that does not offer the choice at all.
   */
  scores?: {
    choices: readonly ScoreChoice[]
    current: string
    onChange(choice: ScoreChoice): void
  }
  onScaleChange?(scale: {
    transform: Transform
    colormap: string
    vmin?: number
    vmax?: number
  }): void
  onLevelChange?(level: 'bin' | 'contig'): void
  /**
   * A cell was clicked; offsets are block-local, ids are absolute.
   *
   * `genomes` is the genome each axis is *in* at that cell, where the block was
   * read with them (`namesGenomes`). It is what lets a view answer a click with
   * the unit a reader is looking at rather than with the unit the axis happens
   * to be indexed by: on a whole-metagenome picture the cells are bins, the
   * runs are contigs, and the thing being pointed at is a MAG.
   */
  onCellClick?(
    cell: Cell,
    groups: { row?: AxisGroup; col?: AxisGroup },
    genomes?: { row?: string; col?: string },
  ): void
  /**
   * What the exported figure is a picture *of*, for its caption.
   *
   * The panel knows the bin size, the transform and the level; it does not know
   * which file or which genome, because it is mounted by five different views
   * over the same data. The router does, and passes it down.
   */
  caption?: FigureSubject
  /**
   * An axis label was clicked. `name` is the block's own name — a genome in the
   * whole-metagenome overview, a contig everywhere else — and the view opens
   * whatever that name is.
   */
  onLabelClick?(axis: 'rows' | 'cols', name: string): void
  /**
   * A box was selected. The panel resolves it to *one* block and, at bin level,
   * to a base-pair range inside it; the view decides what opening that means.
   */
  onSelectRegion?(selection: SelectedRegion): void
  /**
   * Keep the colour controls out of the panel so the owning view can place them
   * elsewhere — the genome and region views stack them in their sidebar, above
   * the contig list. The panel still owns them; only their mount point moves.
   */
  detachedControls?: boolean
  /**
   * Suppress the panel's own title line.
   *
   * Every view already names what it is showing in its `<h2>`, so the panel
   * title repeated it one line lower ("metator_00001_00000" then
   * "metator_00001_00000 — contig level"). The level is in the controls; the
   * name is in the heading; the line said nothing either did not.
   */
  hideTitle?: boolean
  /**
   * Draw annotations beside and on the matrix (spec §8).
   *
   * Supplied on every file, a `.metacool` included (§8.5), once the session has
   * built its annotations, and absent before then — which is not a decision
   * this panel makes. With it absent the panel is byte for byte the panel it
   * was before annotations existed — no lanes, no listeners, no worker.
   */
  annotations?: AnnotationContext
  /**
   * Draw a second file in the lower-left triangle (`render/compare.ts`).
   *
   * Present only while two files are open. The *data* arrives through
   * {@link MatrixPanel.setData}; this is what the panel needs to talk about it:
   * whose numbers are on which side of the diagonal, and the one control the
   * comparison has of its own.
   */
  compare?: ComparePresentation
  /**
   * Values computed here rather than read (`render/derive.ts`).
   *
   * The normalisation arrives through {@link MatrixPanelOptions.scores}, because
   * to a reader it is one more answer to "what are these cells"; the baseline
   * has a control of its own, because it answers "compared to what" and composes
   * with every one of those answers.
   */
  derive?: DerivePresentation
  /**
   * Draw the map turned 45° (`render/rotate.ts`).
   *
   * Present on every view that mounts a panel; whether it is *offered* is
   * `isTurnable`'s answer about the block, which cannot be known until one has
   * arrived. The panel therefore reports back what it found rather than being
   * told — {@link TurnPresentation.onAvailable} is how the control learns to
   * grey itself.
   */
  turn?: TurnPresentation
  /**
   * The window on screen changed — a pan, a zoom, a new block.
   *
   * Fired from the draw loop but **only when the window it names has actually
   * moved**, which is what makes it affordable: a drag is sixty frames a second
   * and the phrase under the map changes a handful of times across one. The
   * argument is deliberately nothing; a listener that wants the window asks
   * {@link MatrixPanel.framedRegion} for it, so there is one answer rather than
   * two that can drift.
   *
   * One caller: the zoom-out button beside the region box, which has to grey
   * itself the moment there is nothing further out to go to.
   */
  onViewMoved?(): void
  /**
   * What the heading above this panel currently says the window is, if anything.
   *
   * Paired with {@link MatrixPanel.setWindowNamedAbove}: the summary line drops
   * the locus only where this returns exactly the string the summary would have
   * opened with, so the elision can never hide a window that was not already on
   * screen. `undefined` for a panel with no heading of its own — a cell of a
   * deck — where the summary is the only place the window is written.
   */
  headingLocus?(): string | null
}

/**
 * *This sequence is circular* — the declaration, as the session passes it round
 * (SPECS §8.15).
 *
 * **Not a control on this panel.** It was one, in the card about the map, and
 * the tickbox is gone: a declaration about the assembly asked one sequence at a
 * time, of whichever one was on screen, is a question in the wrong place, and it
 * left no way to read which sequences had been declared. The ticking is a column
 * of the Chromosomes table now (`ui/ContigsTable.ts`) and the mark is in the
 * General panel's list.
 *
 * What survives is the *reading*: `RegionView` needs to know whether this window
 * may run off the end of its sequence, and it is handed this. Still a
 * presentation rather than a boolean, on `derive`'s rule — the state lives in
 * the session (`state/circular.ts`) and nothing in a view remembers an answer —
 * and `on` is written through when the declaration changes under an open map,
 * which is what lets the ladder be re-armed without the reader losing their
 * zoom.
 */
export interface CircularPresentation {
  /** The sequence it is about, spelled as this map spells it. */
  label: string
  on: boolean
  onChange(on: boolean): void
}

/**
 * The stretch of one sequence a panel is showing, with the sequence's length.
 *
 * Two callers and they do different things with it: the Bookmarks card writes it
 * down, and the zoom-out button widens it. The length is here for the second —
 * widening has to stop at the end of the sequence, and neither caller carries an
 * assembly to look it up in.
 */
export interface FramedRegion {
  contig: string
  start: number
  end: number
  /** The whole sequence's length in base pairs, which is where coordinates stop. */
  length: number
  /**
   * The window runs across the sequence's own origin (§8.15), so `end` is
   * **below** `start` and the window is what lies outside the two.
   *
   * A circular axis panned across its junction shows the same sequence twice —
   * its tail, then its head — and that is one window written backwards rather
   * than two places. Which is a legal region on a declared sequence and an error
   * on every other, so it is flagged rather than left for a caller to notice
   * from the arithmetic: the zoom-out widens it, and the Bookmarks card refuses
   * it, because a BED interval cannot be written backwards.
   */
  wrapped?: boolean
}

/**
 * How big a panel came out, for whoever is laying it out beside others.
 *
 * Both halves are needed and they answer different questions: `lanes` is the
 * room a companion has to *reserve* so its picture sits at the same height,
 * and `plot` is the size that picture has to *be*.
 */
export interface PanelGeometry {
  lanes: Record<LaneEdge, number>
  /** The plot's width in CSS pixels. */
  plot: number
  /**
   * The plot's height in CSS pixels, which is **not** its width.
   *
   * It was, for as long as the only picture was a square. A turned map is a band
   * along its diagonal and is a fraction of the height of the square it came out
   * of (§17.2), so a deck that sized anything from the width alone sized it for
   * a picture that is not on screen — and the thing it sized was the empty cell,
   * which then set the height of its whole row and pushed every map in that row
   * to the foot of a rectangle of air.
   */
  plotHeight: number
}

export interface TurnPresentation {
  /** Whether the reader has asked for the turned view. */
  on: boolean
  /**
   * Absent where this panel draws the turn but does not own it.
   *
   * A companion panel of a deck (§16) is that case, and it is the same rule
   * {@link DerivePresentation.onExpectedChange} states: the turn is one of the
   * things the deck shares, every panel has to draw it, and only one may offer
   * the control. No handler, no button, and the map is still turned.
   */
  onChange?(on: boolean): void
  /**
   * Which way distance grows: `up` for a lone map and for the first file of a
   * comparison, `down` for the second, so the pair meets at one genomic axis.
   */
  direction?: RotateDirection
  /**
   * Whether this block *can* be turned, reported after every read.
   *
   * The gate is a fact about the block rather than about the view — a region of
   * one chromosome can be turned and the whole of a metagenome cannot — and the
   * block is what the panel has. The control is greyed rather than hidden on a
   * `false`, so a reader can see what exists and learn what it wants of them.
   */
  onAvailable?(possible: boolean): void
}

/**
 * What the map needs to offer and apply the arm-frame O/E (§8.15).
 *
 * The frame is the sequence the view is a window on — where it starts in the
 * file's bins, how many it has, where its origin is and whether it is round — so
 * the panel can say which bin of it each row of whatever block arrives is, a
 * rotated one included. `null` where there is no origin to read the arms from,
 * with {@link refusal} saying so.
 */
export interface ArmsPresentation {
  /** The window along the arms in bins while it is on; `undefined` while off. */
  window: number | undefined
  /**
   * The sequence the arms are of, in the **open** map's bins: where it starts
   * on the axis, how many bins it has and which holds the origin — with that
   * grid's bin size and the sequence's length in base pairs, so a block read on
   * another grid can be placed on it.
   */
  frame: {
    startBin: number
    n: number
    origin: number
    circular: boolean
    binsize: number
    length: number
    /** The origin itself, in base pairs, 0-based — what `ori` centres on. */
    originBp: number
  } | null
  /** Why it cannot be offered on this view, or `null` when it can. */
  refusal: string | null
  /** Absent on a panel that applies it without owning the control. */
  onChange?(window: number | undefined): void
  /**
   * Frame the whole circle with its origin in the middle, where the sequence is
   * circular and has one — the way every figure of a bacterial map is drawn,
   * with the arms running out to the corners and meeting at the terminus.
   *
   * @param centred Whether the origin is in the middle of what is drawn now —
   *   the button is lit then, and pressed it frames the sequence as usual again.
   */
  onCentre?(centred: boolean): void
}

const CENTRE_HINT =
  'Frame the whole circle with its origin in the middle: the arms run out to the corners and ' +
  'meet at the terminus.'

const UNCENTRE_HINT =
  'The origin is in the middle of the view. Press to frame the sequence from its first base again.'

const ARMS_HINT =
  'Divide by the decay along both arms of a bacterial chromosome — its secondary diagonal ' +
  'through the origin as well as the main one — so what is left is its compartments. Reads the ' +
  'origin on the Chromosomes table: the first base unless one is set.'

export interface DerivePresentation {
  /** Normalisation to compute from the block; absent for none. */
  normalise?: Normalisation
  /** Whether cells are divided by what their genomic distance predicts. */
  expected: boolean
  /**
   * Absent where this panel applies the derivation but does not own it.
   *
   * A companion panel of a deck (§16) is exactly that case: the derivation is
   * one of the things the deck *shares*, so every panel has to draw it and only
   * one may offer the control — five copies of a shared toggle being five ways
   * for a reader to put the deck out of step with itself. No handler, no
   * control, and the values are still derived.
   */
  onExpectedChange?(on: boolean): void
  /**
   * The baseline against **both** diagonals of a bacterial chromosome (§8.15),
   * offered where the view is one sequence.
   *
   * Absent on every view that is not a window on one sequence, and on a
   * companion that draws it without owning the control.
   */
  arms?: ArmsPresentation
  /**
   * How much despeckling, as the picker's token; `0` for none
   * (`render/smooth.ts`).
   *
   * Shared and applied exactly as {@link expected} is, including on a companion
   * that draws it without offering the control — a deck whose panels smoothed
   * differently would be five pictures that could not be compared, which is the
   * one thing a deck is for.
   */
  smooth: string
  /** Absent on a panel that applies the smoothing but does not own it. */
  onSmoothChange?(token: string): void
  /**
   * Whether the square is replaced by the correlation between its rows.
   *
   * Implies {@link expected}: a correlation of anything but observed-over-expected
   * is a correlation of the distance decay, in which every pair of rows agrees
   * and the picture says nothing. The panel forces it rather than refusing, so
   * the toggle is one click and the caption says both were applied.
   */
  correlate: boolean
  /** Absent on a panel that draws a correlation but does not own the control. */
  onCorrelateChange?(on: boolean): void
  /**
   * Whether every cell is replaced by the baseline {@link expected} divides by.
   *
   * Overrides it rather than combining with it — O/E of the baseline is 1
   * wherever it is anything — so the toggle is greyed while this is on and says
   * why. Carried by the score for the same reason the correlation is: it is one
   * of the answers to "what are these numbers" (`ui/scores.ts`).
   */
  baseline: boolean
  /**
   * Take that baseline along both arms of a circular chromosome (§8.15) — the
   * score picker's `arm decay`.
   *
   * Read along {@link arms} whether or not the toggle is on, at its window or
   * the one it turns on at: this is the arm-frame baseline and no other, so the
   * toggle is greyed while it is drawn, as the O/E's is under any baseline.
   */
  alongArms?: boolean
  /**
   * Compute one, off the main thread.
   *
   * A callback rather than a client, so this file keeps knowing nothing about
   * workers: the session owns the thread, the panel owns the block and the
   * cache, and the seam between them is one array in and one array out. Absent
   * where nothing can compute one, which is what greys the control.
   */
  correlateBlock?(
    values: Float32Array,
    n: number,
    onProgress?: (done: number, total: number) => void,
  ): Cancellable<CorrelationField>
  /**
   * A correlation failed for a reason that was not a cancellation.
   *
   * Reported rather than swallowed, and reported to the *session*, because the
   * panel's own places to put a message are both wrong for it: the veil is over
   * the map a reader is trying to look at, and the view note is rewritten on
   * every render. The toggle is switched off before this is called, so the
   * message describes something that is over.
   */
  onCorrelateFailure?(message: string): void
  /**
   * Run the adaptive despeckle off this thread.
   *
   * A callback rather than a client, exactly as {@link correlateBlock} is and for
   * its reason: the session owns the worker, the panel owns the block and the
   * cache, and the seam is the arrays in and the arrays out. Absent where nothing
   * can run one, in which case the filter is computed inline at whatever it
   * costs — which is right, because the alternative is not doing it at all.
   */
  smoothBlock?(request: SmoothingRequest): Cancellable<SmoothedField>
}

const CORRELATE_HINT =
  'Replace the square by the Pearson correlation between its rows, whose checkerboard is the ' +
  'A/B compartments — the same matrix the Compartments task solves. Implies O/E and balanced ' +
  'counts; one file, square blocks, up to ' +
  `${MAP_CORRELATION_BINS.toLocaleString()} bins a side — a fraction of a second at a thousand, a few at the most.`

/**
 * One entry of the score picker.
 *
 * The entries that are a pipeline or a model rather than a reading carry a
 * note of their own, because the field's hint has no room to say what each
 * does or what it refuses — and a reader hovering that entry is the one
 * asking.
 */
function scoreOption(choice: ScoreChoice): HTMLOptionElement {
  const option = el('option', { value: choice.id, text: choice.label })
  if (choice.correlate === true) option.title = CORRELATE_HINT
  if (choice.baseline === true) option.title = choice.alongArms === true ? ARM_BASELINE_HINT : BASELINE_HINT
  return option
}

/**
 * What a figure is a picture *of*: the file, the genome, and the total the map
 * was drawn to (§6.5) — the three things a panel cannot know from its block.
 */
export interface FigureSubject {
  file: string
  genome?: string
  /**
   * What the map is drawn to, or `null` for the file as stored. A function,
   * because the reader's answer lands after the panel is built, and a figure
   * saved later has to say what it shows.
   */
  depth?: () => DrawnDepth | null
}

export interface ComparePresentation {
  /** The two file names, in order: above the diagonal, then below it. */
  labels: [string, string]
  /** How the two are put together — the split, or one derived field. */
  op: CompareOp
  onOpChange(op: CompareOp): void
}

/** What the panel needs to draw annotations against this file. */
export interface AnnotationContext {
  store: AnnotationStore
  /**
   * Which map's lanes this panel draws (`annotations/placement.ts`).
   *
   * The tracks are one list for the whole session; a map draws the ones placed
   * on it, with whatever patch that placement carries. Absent means the
   * session's own map, which is what every view but a deck's companions is.
   */
  map?: MapId
  manual: ManualStore
  client: AnnotationClient
  /**
   * How each group of tracks is drawn and scaled, for this file.
   *
   * The session's instance, the same one the 1D browser is handed: a group is a
   * fact about the tracks, not about whichever surface happens to be showing
   * them (`annotations/groups.ts`).
   */
  groups: GroupSettings
  /**
   * A contig's length in base pairs, from the contigs table.
   *
   * Passed as a lookup rather than a table because an *aggregated* axis carries
   * one cell per contig and no length of its own, and because the panel has no
   * business knowing the reader's table shapes.
   */
  contigLength(name: string): number | undefined
  /**
   * The edited assembly this map is drawn through, where it is drawn through
   * one (§27.7) — and `null` for the file as it is.
   *
   * The reader answers in the edited assembly; the tracks, marks and features
   * are in the file's. Asked each time an axis is built, so a map whose edit
   * changes is drawn through the new one from the next block on
   * (`edit/axis.ts`).
   */
  edited?(): EditedAssembly | null
  /**
   * Where the file's own columns come from (§8.12).
   *
   * Absent on a surface that draws no metadata lanes — the 1D browser, a panel
   * built before the tables were read — and then a metadata row on the card
   * simply has nothing to draw here, which is the same state a `/bins` column
   * is in while its slice is on its way.
   */
  metadata?: MetaSource
  /**
   * Files were dropped on one edge of the map: load them, drawn on that edge.
   *
   * The panel does not load anything itself — it has no loader and no idea what
   * a bigWig is — it only knows *where the pointer was*, which is the one thing
   * the session cannot know. The edge is the whole of what this adds over
   * dropping on the card in the sidebar: aiming at the bottom of the map is a
   * reader saying which stack they want it in, in the same gesture that brings
   * the file in.
   *
   * Absent on a file that cannot carry annotation files at all, which is also
   * what turns the drop rectangles into move-only targets.
   *
   * `null` is the rectangle in the middle, *on this map*: the files are this
   * map's, drawn on its face if they are overlays and on their usual edge if
   * they are tracks (§8.1).
   */
  loadOnEdge?(files: readonly File[], edge: LaneEdge | null): void
  /**
   * The same aim, at a row dragged out of the Files panel.
   *
   * A second door rather than a widening of {@link loadOnEdge}, because what
   * arrives is a different thing: that one takes `File`s, which the drop event
   * already holds, and this one takes the *event*, because the file behind the
   * row has to be fetched and that cannot happen while a drop handler is
   * running. Reading the payload here and awaiting it would also mean this panel
   * knowing how a connected folder is read, which is `browse/`'s business and
   * the session's.
   *
   * Absent for the same reason `loadOnEdge` is: a file that cannot carry
   * annotations has no stack to aim at, and a rectangle that lights up for a
   * drop it will not answer is a target that eats the file.
   */
  pickOnEdge?(event: DragEvent, edge: LaneEdge | null): void
}

/**
 * A deck's answer to its lead panel's export controls.
 *
 * Each returns whether it took the gesture: `false` means the deck is one map
 * and the panel should export its own figure, vector and all.
 */
export interface DeckExport {
  save(format: ExportFormat, dpi: number): Promise<boolean>
  copy(dpi: number): Promise<boolean>
}

export class MatrixPanel {
  readonly el: HTMLElement
  /**
   * The colour controls, as a self-contained card. Always built; mounted inside
   * {@link el} unless `detachedControls` was set, in which case the owning view
   * places it. Wired either way — the panel keeps the listeners.
   */
  readonly controlsEl: HTMLElement
  /**
   * The Tracks card: how the lanes are sized, scaled and drawn.
   *
   * Separate from the colour card because the two answer different questions —
   * one is *what the matrix looks like*, the other *what the tracks beside it
   * do* — and because every view mounts this one identically, which is the whole
   * of "the same plotting options everywhere".
   */
  readonly plotEl: HTMLElement
  /**
   * The Export card: resolution, format, save, copy.
   *
   * Its own card and not a row at the foot of another one. Every other control
   * this panel offers changes the picture; this one takes the picture away, and
   * a reader arrives at it having finished with the rest.
   */
  readonly exportEl: HTMLElement
  /**
   * What the map currently *shows*, as opposed to what it holds.
   *
   * A panel-owned node the view mounts on its own subtitle line, because the
   * number changes on every wheel click while the rest of that line is written
   * once per read. The same arrangement the 1D browser's `.browser-zoom` has,
   * for the same reason — and the same words, so `chrI · 23.6 kb` means the same
   * thing whichever picture a reader is looking at.
   */
  readonly viewNote: HTMLElement = el('span', { class: 'view-span' })
  /** The window {@link MatrixPanelOptions.onViewMoved} was last fired for. */
  private framedAt = ''
  /**
   * The cards this panel contributes to whichever view's Aesthetics column.
   *
   * A list rather than two named fields, because it is no longer two: a file
   * that can carry annotations gets a Groups card as well, and every view that
   * mounts a map spreads whatever is here. Naming each card at five call sites
   * is how the fifth one ends up missing the card the other four have — which is
   * exactly how the Groups card came to exist only in the 1D browser.
   */
  readonly cards: readonly HTMLElement[]

  private readonly groupsCard: GroupsCard | null
  /**
   * The store the lanes are drawn from.
   *
   * The session's, where it has handed one over — every file has one, a
   * `.metacool` included (§8.5). Where it has not, an empty one that nothing
   * persists, so that everything downstream of a store can be built
   * unconditionally rather than behind four `null` checks. It stays empty: no
   * worker, no loader, no cards, and nothing that could load a file.
   */
  private readonly laneStore: AnnotationStore
  private unsubscribePick: () => void = () => {}

  private readonly canvas: HTMLCanvasElement
  /** The key in the map's top-right corner; two of them under a comparison. */
  private readonly key: MapKey
  private readonly key2: MapKey
  private readonly keySlot: HTMLElement
  /** The two keys in {@link keySlot}, hidden together where the legend is off or the screen is a phone's. */
  private readonly keys: HTMLElement
  /**
   * How to zoom into a region from here, under the keys while the pointer is
   * over the map ({@link paintReframeHint}).
   */
  private readonly reframeHint: HTMLElement
  /**
   * The box the picture is drawn in, the four handles on its edges, and the
   * room it has (`ui/MapBox.ts`).
   */
  private readonly box: MapBox
  /**
   * What the numbers in the cells are called, before the transform is added.
   *
   * The *outermost* operation, written when the block is derived: `O/E`, a
   * comparison's own phrase, or empty for cells as they were read. The score
   * itself is not in it — that is read from the picker, which is where the
   * reader chose it (see {@link keyFor}).
   */
  private laneListener: ((geometry: PanelGeometry) => void) | null = null
  private hoverListener: ((cell: { row: number; col: number } | null) => void) | null = null
  /**
   * Which map of the deck this panel *is*, for the lanes it draws.
   *
   * The lead when nothing says otherwise, which is every session with no deck in
   * it. It is a property of the panel rather than of the gesture, so anything
   * that moves a lane from here says *which map* it moved it on
   * (`annotations/store.ts`'s `placeAt`).
   */
  private readonly mapId: MapId
  /** Where another panel's pointer is, in this panel's cells. */
  private echo: { row: number; col: number } | null = null
  /** Where another panel's pointer is *on a track*, in this panel's cells. */
  private laneEcho: { axis: 'rows' | 'cols'; unit: number } | null = null
  private units = ''
  /** What the score is called, where nothing here chose it. */
  private scoreLabel = ''
  /**
   * The score picker, where this panel has one, so it can be told what changed.
   *
   * A `<select>` holds no state worth keeping — the choice belongs to whoever
   * reads the file — so this is only ever *written to*, and only from
   * {@link syncScoreChoice}. `null` on a file with one answer, where offering a
   * dropdown would be offering a choice that cannot be made.
   */
  private scoreSelect: HTMLSelectElement | null = null
  /**
   * The line under the *Map* card's title saying which map of a deck the card
   * sets (§16.5) — the starred one, or every map where none is starred.
   * Hidden on a map with no deck around it, where there is nothing to choose.
   */
  private readonly cardFor = el('p', { class: 'map-card-for hidden' })
  /** Whether the window is too narrow for a key over the picture. */
  private narrow = false
  /** Whether the key is shown — the `legend` overlay; see `ui/plotOptions.ts`. */
  private legendOn = getPlotOptions().legend
  /**
   * The Export card, and every drawing of the figure it saves — PNG, PDF, the
   * deck's cell and the clipboard's copy (`ui/MapFigure.ts`).
   */
  private readonly figure: MapFigure
  private readonly heatmap: HeatmapView
  private readonly titleNode: HTMLElement
  private readonly clip: ClipRange
  private readonly transformSelect: HTMLSelectElement
  private readonly colormapSelect: HTMLSelectElement
  private readonly overlay: HTMLElement
  /**
   * Every button that lights up for a given option — plural, because one of them
   * is offered twice. The crosshair sits in both the Map row and the Tracks row
   * (see `MATRIX_OPTIONS`), and a map keyed one-to-one silently kept only the
   * second: pressing either would work, but the first would never light.
   */
  private readonly optionButtons = new Map<PlotOptionKey, HTMLElement[]>()
  private readonly unsubscribePlotOptions: () => void
  private readonly unsubscribeTextScale: () => void
  private readonly unsubscribeDiagonalLock: () => void
  private readonly themeWatchers: () => void
  private readonly narrowWatcher: () => void
  private readonly observer: ResizeObserver | null
  /** What the figure is called, for the download name. */
  private exportName = 'contact-map'

  private data: MatrixResult | null = null
  /** Where this panel is looking, for whoever is keeping N of them in step. */
  private viewportListener: ((rows: [number, number], cols: [number, number]) => void) | null = null
  /**
   * Who to tell where the picture is, in the reader's own bins — see
   * {@link setRefineListener}.
   *
   * A second slot rather than a use of {@link viewportListener}, because a deck
   * already owns that one and the two want different things: the lock wants
   * cells so it can translate between panels, and this wants absolute bins so a
   * read can be made of them.
   */
  private refineListener: ((view: RefineView) => void) | null = null
  /**
   * The second file's block, when one is open.
   *
   * Kept beside the merged values rather than only merged into them, because a
   * reader hovering a cell wants *both* numbers — the whole question a compared
   * map asks is how the two differ here — and after the merge only one of them
   * is still in the matrix.
   */
  private second: { data: MatrixResult } | null = null
  /**
   * What this block was turned into, kept for the readout and the colourbar.
   *
   * The readout's problem is the compared map's, one step further on: after the
   * derivation the matrix holds a ratio, and a reader hovering a cell is asking
   * about a ratio *and* about the counts behind it. Both are still reachable —
   * the counts from {@link data}, the derived value from here.
   */
  private derived: DerivedValues | null = null
  /**
   * The values the heatmap is drawing — the derived field where there is one,
   * and the block's own values where there is not.
   *
   * A reference to the array already handed to the renderer, not a copy, so the
   * readout is by construction reporting the number under the colour rather than
   * a second computation that could disagree with it.
   */
  private drawn: Float32Array | null = null
  /**
   * The turned block on screen, or `null` for a square map.
   *
   * Kept because the readout cannot work without it: a pointer over a turned map
   * is over a band row and a half-bin column, and the pair of bins that produced
   * the cell is only recoverable through `render/rotate.ts`'s inverse.
   */
  private turned: RotatedBlock | null = null
  /** The turn control, greyed while the block on screen has no diagonal. */
  private turnButton: HTMLElement | null = null
  /** The diagonal lock's toggle, greyed where there is no diagonal to hold the view on. */
  private diagonalButton: HTMLElement | null = null
  /** Whether there is a diagonal to go to: one in the block, and no turn. */
  private diagonalPossible = false
  /** The adaptive-resolution switch, and its unsubscribe. */
  private refineButton: HTMLElement | null = null
  private stopRefineWatch: (() => void) | null = null
  /** The O/E control, lit from {@link setDerive} rather than from its own click. */
  private expectedButton: HTMLElement | null = null
  /** The arm-frame toggle beside it, where the view is one sequence (§8.15). */
  private armsButton: HTMLButtonElement | null = null
  /** The `ori` action beside it, shown where there is a circle and an origin. */
  private centreButton: HTMLButtonElement | null = null

  /**
   * The despeckle picker, lit from {@link setDerive} for the O/E toggle's
   * reason: the setting is the session's and can move from a link.
   *
   * `null` on a panel that was not given {@link DerivePresentation.onSmoothChange}
   * — a deck companion, which draws the smoothing and does not offer it.
   */
  private smoothSelect: HTMLSelectElement | null = null

  /**
   * The values this panel computes rather than reads, and the jobs that compute
   * them off the main thread: the correlation and the despeckle, their caches,
   * and their lines on the veil (`ui/MapDerivation.ts`).
   */
  private readonly derivation: MapDerivation
  /** The last title {@link setData} was given, so a turn can re-run it. */
  private lastTitle = ''
  /**
   * The square block the band is cut from, kept so a re-cut costs one rotation.
   *
   * The band's depth follows the zoom, so zooming out needs a deeper cut — and
   * re-running the whole derivation for it would put a normalisation and a
   * baseline pass behind a wheel click. Only the geometry has to be redone.
   */
  private square: DenseMatrix | null = null
  /**
   * The distance from the diagonal a **deck** has asked every panel to reach, in
   * base pairs, or `null` for a map that answers to its own box.
   *
   * `null` is the ordinary state and is every map outside a deck. See
   * {@link setTurnReach} for why a deck cannot leave this to the box.
   */
  private deckReach: number | null = null
  /** The neutral value of what is currently drawn, or `null` for a count field. */
  private neutral: number | null = null
  /**
   * The presentation to give back when the derivation is switched off, and the
   * transform the derived one is currently holding.
   *
   * A derived field takes over the transform, the colormap and the clip, because
   * none of the three means the same thing about a ratio as about a count — a
   * `vmax` of 8 is a sensible ceiling on `log1p` counts and nonsense on `log2`
   * of a ratio. Taking them is only defensible if they come back, so what was
   * there is held here rather than overwritten.
   */
  private divergingRestore: {
    transform: Transform
    colormap: string
    vmin: number | undefined
    vmax: number | undefined
  } | null = null
  private divergingApplied: Transform | null = null
  /**
   * Whether the scale on this panel is still the seed it was built with, and
   * nobody said what that seed was borrowed from — true until the first
   * derivation is weighed, or the reader touches the scale.
   */
  private freshSeed: boolean
  private transform: Transform
  /** `clip`, or `clip (log10)` under a transform; see {@link paintClipUnits}. */
  private readonly clipLabel: HTMLElement
  private colormap: string
  private manualVmin: number | undefined
  private manualVmax: number | undefined
  private level: 'bin' | 'contig'
  private frame = 0
  /** The scale the colourbar was last drawn for; `null` until it has been. */
  private painted: ColorScale | null = null
  /**
   * The lane stacks — all four of them, on every file.
   *
   * Built unconditionally, including on a panel handed no annotations, where
   * they stay empty. What the panel was given decides what can be *put* in the
   * stacks, not whether the stacks exist: keeping them means the drop zones,
   * the edge-to-edge drag and the loop marks are one code path rather than one
   * with a hole in it.
   */
  private readonly lanes: AnnotationLanes
  /** The grid holding the map and its lanes; the tooltip's positioning parent. */
  private readonly grid: HTMLElement
  /**
   * The map's own box inside that grid — the canvas, the key and the handles.
   *
   * Held for {@link MapBox.measureRoom}, which reads the height a square map would have
   * claimed off this element's `max-height`: the one place the layout writes
   * that number as a length rather than as the `clamp()` it comes from.
   */
  private readonly wrap: HTMLElement
  /** The cell under the pointer, so the lanes can continue the crosshair. */
  private hoverCell: Cell | null = null
  /**
   * The gestures on the lane stacks, and the rectangles inside the map a lane
   * or a file is dropped on (`ui/LaneGestures.ts`).
   */
  private readonly laneGestures: LaneGestures
  /**
   * The layer of controls over each lane stack, and the caret that opens in one.
   *
   * Positioned against {@link grid} rather than given a grid area of their own.
   * `.panel-grid`'s tracks are sized from their content, so a sized child sharing
   * a lane's cell would inflate that track and shrink the map; laid over the grid
   * absolutely, and offset each frame by the canvas's own position in it, they
   * take no space at all. It is the same conversion `MapReadout.placeTooltip`
   * performs, for the same reason.
   */
  private readonly laneLayers = new Map<LaneEdge, HTMLElement>()
  private readonly laneControls = new Map<LaneEdge, LaneControls>()
  private laneEditor: LaneEditor | null = null
  /**
   * The two axes as annotations see them, rebuilt with every block.
   *
   * Held here rather than only inside {@link lanes}, because the overlays and
   * the click-to-place picker need them too — and three copies of the same
   * mapping is exactly what §8.4 exists to prevent.
   */
  private locusAxes: OverlayAxes = { rows: null, cols: null }
  /**
   * The **square** block's two axes, kept under a turn as well.
   *
   * {@link locusAxes} is what the picture is drawn against, and on a turned map
   * its rows are deliberately `null`: y is distance from the diagonal, which is
   * not a place, and a lane or an overlay asking that axis for a locus is asking
   * the wrong question (`render/rotate.ts`).
   *
   * A **click** is not that question. It lands on a cell, and a cell of a turned
   * band is a cell of the square underneath it ({@link squareCell}) — which has a
   * row coordinate and a column coordinate like any other. This is the pair that
   * turns it back into two loci, and it is the same pair the readout uses, for
   * the same reason: one coordinate system for the pointer, whichever way the map
   * is drawn. Without it, `pick on map` and the right-click menu were silently
   * dead on every turned map, which is the presentation a region view opens in.
   */
  private squareAxes: OverlayAxes = { rows: null, cols: null }
  /**
   * The drawn axes in the reader's own coordinates, where the map is drawn
   * through an edit (§27.7) — the edited sequences, as the region box, the
   * heading and a band dragged for a form name them. {@link locusAxes} is the
   * same picture in the file's coordinates, which the lanes, the marks and
   * every other surface speak. The same object as that one without an edit.
   */
  private ownAxes: OverlayAxes = { rows: null, cols: null }
  /**
   * The block the colour range is measured from, and how much genome it covers.
   *
   * The widest block installed since the view was built — see {@link gaugeFor}.
   * `null` until the first one arrives.
   */
  private gaugeBlock: { spanBp: number; dense: DenseMatrix } | null = null
  /** The gauge the view is currently measuring from — see {@link gaugeFor}. */
  private gaugeShown: DenseMatrix | null = null
  /** The open map's own bin size — see {@link openBinsize}. */
  private readonly baseBinsize: number
  /** A box being drawn on a turned map; see {@link previewRect}. */
  private pendingRect: ManualRect | null = null
  /** A picking mode in progress; see {@link armPicking}. */
  private picking: (PickHandlers & {
    /** Called once when the mode ends, however it ends. */
    end(): void
  }) | null = null
  /**
   * What the pointer is over, on the status bar's line and on the card beside
   * the pointer (`ui/MapReadout.ts`).
   */
  private readonly readout: MapReadout
  /**
   * Teardowns for the listeners this panel registers itself: the map's own menu,
   * Escape, the stores' subscriptions and the landing it offers carried lanes.
   * The lane canvases' pointer listeners are {@link LaneGestures}'s, and it
   * releases them.
   */
  private readonly laneListeners: Array<() => void> = []
  /** The stack thicknesses the stylesheet was last told about, per edge. */
  private laneBudget: Record<LaneEdge, number> = { top: -1, right: -1, bottom: -1, left: -1 }
  /**
   * How far the stacks' names run out into the map's corners, by the *side*
   * of the map each corner widens (§8.8) — the left of the map for the bottom
   * stack's names, and so on round.
   */
  private cornerBudget: Record<LaneEdge, number> = { top: 0, right: 0, bottom: 0, left: 0 }
  /**
   * Room to leave on each edge whether or not this panel has a stack there.
   *
   * Zero on its own, and set by a deck to the largest any of its panels needs
   * (§16.8). Kept apart from {@link laneBudget} rather than folded into it, so
   * that {@link reportGeometry} keeps answering with what this panel's *own*
   * tracks take: a deck that was told the reserved figure back would raise the
   * floor to its own floor for ever.
   */
  private laneFloor: Record<LaneEdge, number> = { top: 0, right: 0, bottom: 0, left: 0 }

  constructor(private readonly options: MatrixPanelOptions) {
    this.baseBinsize = Math.max(1, options.binsize)
    this.transform = options.initial?.transform ?? 'log1p'
    this.colormap = options.initial?.colormap ?? DEFAULT_UI_COLORMAP
    this.manualVmin = options.initial?.vmin
    this.manualVmax = options.initial?.vmax
    // A scale carried from the panel this one replaces, while a derivation had
    // it: the seed is what that derivation drew with, so it is held as applied,
    // and the next weighing either keeps it or gives back what it took.
    const carried = options.initial?.restore
    if (carried !== undefined) {
      this.divergingRestore = {
        transform: carried.transform,
        colormap: carried.colormap,
        vmin: carried.vmin,
        vmax: carried.vmax,
      }
      this.divergingApplied = this.transform
    }
    this.freshSeed = carried === undefined
    this.level = options.initial?.level ?? 'bin'
    this.derivation = new MapDerivation({
      options,
      setBusy: (busy, message) => this.setBusy(busy, message),
      redraw: () => this.redraw(),
    })

    this.canvas = el('canvas', { class: 'heatmap-canvas' })
    // The readout and the card beside the pointer, which say what is under it
    // over the map and over every lane (`ui/MapReadout.ts`).
    this.readout = new MapReadout({
      options,
      data: () => this.data,
      turned: () => this.turned,
      second: () => this.second,
      squareCell: (cell) => this.squareCell(cell),
      scoreWord: () => this.scoreWord(),
      derivedReading: (row, col) => this.derivedReading(row, col),
    })
    this.titleNode = el('h2', { class: 'panel-title', text: '' })
    this.overlay = el('div', { class: 'panel-overlay hidden' })

    // The lanes and the store behind them, before anything that can *ask* about
    // them: the first scheduled frame measures the stacks, and it runs while
    // the constructor is still building the cards below. Only the canvases are
    // made here; where they are mounted and what listens to them comes later.
    //
    // Where the panel was handed no annotations there is still a store, empty
    // and persisting nothing, so the lane machinery below has one object to be
    // built against rather than a `null` to be checked at every use.
    this.laneStore = options.annotations?.store ?? new AnnotationStore('', { persist: false })
    this.mapId = options.annotations?.map ?? LEAD_MAP
    this.lanes = new AnnotationLanes({
      store: this.laneStore,
      ...(options.annotations?.map === undefined ? {} : { map: options.annotations.map }),
      ...(options.annotations?.manual === undefined ? {} : { manual: options.annotations.manual }),
      ...(options.annotations?.client === undefined ? {} : { client: options.annotations.client }),
      ...(options.annotations?.groups === undefined ? {} : { groups: options.annotations.groups }),
      ...(options.annotations?.metadata === undefined
        ? {}
        : { metadata: options.annotations.metadata }),
      // Each stack's names beside the map, in the corner that follows it
      // clockwise, rather than over its data (§8.8).
      corners: true,
      onChange: () => this.schedule(),
    })

    this.heatmap = new HeatmapView(this.canvas, {
      plotOptions: getPlotOptions(),
      ...readCanvasPalette(this.canvas),
      // Contig labels are drawn only below the Python threshold; above it they
      // would be a grey smear rather than information (`ops/show.py`).
      maxLabels: MAX_CATEGORICAL_TICKS,
      // Gutters are measured from the labels themselves: real contig names run
      // to `NODE_7431_len_134871`, which no fixed margin fits, and a genome with
      // too many contigs to label should not reserve a gutter at all.
      autoMargin: true,
      labelFont: scaleFont(DEFAULT_LABEL_FONT),
      onChange: () => this.schedule(),
      onHover: (cell, event) => this.describe(cell, event),
      onCellClick: (cell) => this.emitClick(cell),
      onLabelClick: (axis, block) => this.options.onLabelClick?.(axis, block.label),
      // Shift-drag names a band of one axis. Reported as indices of the block
      // and turned into a *locus* here, because this is the object that knows
      // the axes — and a locus is what both a clipboard and a form want. The
      // renderer has already zoomed, or not, according to its band mode.
      onBand: (axis, span) => this.bandDragged(axis, span),
      // A box drawn for a form that asked for one. Resolved here, like the band
      // above and for the same reason: the renderer knows cells and this is the
      // object that knows which sequence and which base pair they are.
      onDrawn: (box: DrawnBox) => this.boxDrawn(box),
      // …and the same box on every move while it is drawn, so a turned map can
      // show what is coming. See {@link previewRect}.
      onDrawing: (box: DrawnBox | null) => this.previewRect(box),
      // Only wired when the view wants it; without it a drag zooms, which is
      // the renderer's own behaviour.
      ...(options.onSelectRegion === undefined
        ? {}
        : { onSelect: (box: SelectionBox) => this.emitSelection(box) }),
      // Wired whichever of the two a selection does: what was framed goes on the
      // clipboard either way, which is the 2D half of what Shift-drag does in
      // one dimension.
      onSelectionMade: (box: SelectionBox) => this.copySelection(box),
      // Wired whichever the drag does. The numbers are what makes a marquee
      // aimable, and a box that zooms needs them exactly as much as one that
      // opens a region — more, if anything, since a zoom leaves no address bar
      // entry saying where it went.
      selectionLabel: (box) => this.describeSelection(box),
    })
    this.heatmap.attach()
    this.watchContextMenu()
    // The reader's two bounds are editable *here*, in the corner of the map,
    // and not only in the clip card: somebody who can read a bound off a legend
    // will try to change it there. The second file's key is not editable — it
    // describes the first file's clip converted into the second's counts, and a
    // caret in it would be a control over an arithmetic result.
    this.key = new MapKey({
      onChange: (bound, value) => {
        if (bound === 'lo') this.manualVmin = value ?? undefined
        else this.manualVmax = value ?? undefined
        this.rescale()
      },
    })
    this.key2 = new MapKey()

    const transformSelect = el('select', { class: 'select' })
    this.transformSelect = transformSelect
    for (const name of TRANSFORMS) transformSelect.appendChild(el('option', { value: name, text: name }))
    transformSelect.value = this.transform
    transformSelect.addEventListener('change', () => {
      this.transform = transformSelect.value as Transform
      // A clip is a pair of numbers in transformed units, so it does not survive
      // a change of transform: `vmax = 8` is a sensible ceiling under `log1p`
      // and a black image under `none`. Back to auto, which is right for both.
      this.manualVmin = undefined
      this.manualVmax = undefined
      this.rescale()
    })

    const colormapSelect = el('select', { class: 'select' })
    this.colormapSelect = colormapSelect
    for (const name of COLORMAP_NAMES) {
      const safe = COLOR_VISION_SAFE_COLORMAPS.includes(name)
      colormapSelect.appendChild(el('option', { value: name, text: safe ? `${name} ✓` : name }))
    }
    colormapSelect.value = this.colormap
    colormapSelect.title = 'A ✓ marks a colour-vision-safe map.'
    colormapSelect.addEventListener('change', () => {
      this.colormap = colormapSelect.value
      this.rescale()
    })

    // The unit the boxes are in, in the label: `clip (log10)`. The caption
    // under them is in counts, so without it the row shows two number systems
    // and names neither — a reader who typed the caption's own `0.089` into a
    // log10 box clipped the map a thousandfold too high and nothing said so.
    this.clipLabel = el('span', { class: 'field-label' })
    this.paintClipUnits()
    this.clip = new ClipRange({
      onChange: (clip) => {
        this.manualVmin = clip?.vmin
        this.manualVmax = clip?.vmax
        this.rescale()
      },
      // The boxes are in transformed units, as the key in the map's corner is;
      // the caption says what those are in the units the readout under the
      // pointer uses — and in the word for them the key and the readout
      // already use.
      format: (value) => formatCount(inverseTransform(value, this.transform)),
      unit: () => (this.comparisonLabel() !== null ? '' : this.scoreWord()),
    })

    // Every field lives in the *Map* card, a companion's included. A companion
    // used to carry the score, the transform, the ramp and the clip in a menu
    // in its picture's corner instead; that menu is gone, and the Aesthetics
    // column shows the **starred** map's card (§16.5), so one card sets one map
    // and there is never a second copy of a control over one scale.
    const controls: HTMLElement[] = [
      field(
        'transform',
        transformSelect,
        'How a value becomes a colour — none, log10, log2 or log1p; the same as the metacooler show command’s transform.',
      ),
      // `colours`, which is what a lane's own row calls the same control: the
      // card said `colormap`, the lane row said `colours` and the 3D card says
      // `colour by`, so one column carried two spellings and three names for
      // one kind of choice. `colormap` survives as the technical word in SPECS
      // and in the CLI, where it is a parameter rather than a label.
      field('colours', colormapSelect, 'The ramp; a ✓ marks a colour-vision-safe one. afmhot_r is what the CLI draws.'),
      // Not `field()`: that wraps its control in a `<label>`, and a label around
      // four inputs and a button focuses whichever one it feels like.
      el(
        'div',
        {
          class: 'field field-clip',
          title:
            'Where the colourmap starts and saturates. ' +
            'Auto is 0 to the 99th percentile of the values in view.',
        },
        // The transform in the label, because the boxes are in transformed
        // units while the caption under them is in the units the readout under
        // the pointer uses: `-4.182` and `0.000066` are the same bound written
        // two ways, and with neither of them named a reader typing a clip could
        // not tell which to type.
        this.clipLabel,
        this.clip.el,
      ),
    ]

    // Ahead of the transform in the row, because it is a question about the
    // *numbers* and the two after it are questions about the picture — and
    // because it belongs beside the score and the baseline, which is where a
    // reader looks for "what am I being shown". Offered only where this panel
    // owns the setting, on {@link DerivePresentation.onExpectedChange}'s rule.
    const onSmoothChange = options.derive?.onSmoothChange
    if (onSmoothChange !== undefined) {
      const smoothSelect = el('select', { class: 'select' })
      this.smoothSelect = smoothSelect
      for (const choice of SMOOTH_CHOICES) {
        smoothSelect.appendChild(el('option', { value: choice.id, text: choice.label }))
      }
      smoothSelect.value = options.derive?.smooth ?? '0'
      smoothSelect.addEventListener('change', () => {
        onSmoothChange(smoothSelect.value)
      })
      controls.unshift(
        // One or two sentences, as a tooltip is (§26.4). What this replaces
        // was a hundred and thirty words — why a ratio smooths both files,
        // what an adaptive window does away from the diagonal, why it is off
        // by default — in a `title` that shows for a few seconds and cannot be
        // scrolled. That argument is in SPECS §7.5, where it can be read.
        field(
          'smooth',
          smoothSelect,
          'Average each cell with the cells around it before anything is compared or divided. ' +
            'Adaptive widens the window where the counts thin out, and turns the O/E on.',
        ),
      )
    }

    /**
     * One overlay toggle. It *writes* to the shared store and *reads* from the
     * subscription below, so a toggle flipped from the command palette lights
     * the same button up — the button never holds the state itself.
     */
    // The same marks the 1D browser's Tracks card uses, from the same table. A
    // column of eight worded buttons is eight lines of prose where the browser
    // beside it has two rows of glyphs — and they are the same eight options.
    const optionToggle = (key: PlotOptionKey): HTMLElement => {
      const { label, hint } = PLOT_OPTION_LABELS[key]
      const node = iconButton(
        PLOT_OPTION_ICONS[key],
        withKey(`${label} — ${hint}`, PLOT_OPTION_KEYS[key]),
        () => setPlotOption(key, !getPlotOptions()[key]),
        { class: 'btn btn-icon btn-toggle', size: 15 },
      )
      const known = this.optionButtons.get(key)
      if (known === undefined) this.optionButtons.set(key, [node])
      else known.push(node)
      return node
    }

    this.figure = new MapFigure({
      heatmap: this.heatmap,
      lanes: this.lanes,
      canvas: this.canvas,
      laneGeometry: () => this.laneGeometry(),
      renderKeys: (ctx, scale, origin) => this.renderKeys(ctx, scale, origin),
      caption: (now) => this.figureCaption(now),
      exportName: () => this.exportName,
    })
    this.exportEl = this.figure.card

    this.plotEl = el(
      'div',
      { class: 'controls-card' },
      // "Tracks", not "Plot": beside a contact map there are two pictures on
      // screen, and everything left in this card draws on the lanes. The card
      // that draws on the matrix is called Map, and between the two names there
      // is no longer a control a reader has to find by trying it.
      cardTitle('Tracks', 'palette', 'controls-title'),
      el(
        'div',
        { class: 'panel-controls' },
        // Marks rather than sentences, and the same marks the 1D browser's
        // Tracks card uses: these are the same actions, and a reader should not
        // have to learn them twice because there happens to be a matrix above
        // the tracks this time. The words survive in the tooltips.
        //
        // Under a label, like every other row in this card. Three near-identical
        // vertical arrows with no word over them were the first thing in the
        // column and the least explained thing in it.
        el(
          'div',
          { class: 'field field-block' },
          el('span', { class: 'field-label', text: 'all tracks' }),
          el(
            'div',
            { class: 'plot-icon-row' },
            iconButton(
            'chevrons-up-down',
            withKey(
              'Autoscale every track to what is in view — a group resolves as a group',
              KEYS.autoscale,
            ),
            () => this.autoscaleTracks(),
            { class: 'btn btn-icon', size: 15 },
          ),
          // Stretch, only where there are lanes to stretch. On a file that
          // cannot carry annotations (§8.5) the row would be a control that
          // never does anything, which is worse than a row of two.
          ...(options.annotations === undefined
            ? []
            : [
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
              ]),
          ),
        ),
        // The same box the browser's Tracks card carries, applying the same rule
        // to the same tracks: the two are one decision taken two ways — fill the
        // window, or this many pixels — and a reader who has just stretched two
        // lanes into two four-hundred-pixel strips reaches for this immediately
        // afterwards.
        ...(options.annotations === undefined
          ? []
          : [
              trackHeightField((px) => this.setTrackHeight(px), {
                lanes: () => LANE_EDGES.flatMap((edge) => this.lanes.lanesOn(edge)),
                subscribe: (onChange) => this.laneStore.subscribe(onChange),
              }),
            ]),
        // The four that draw on the matrix used to sit under these, in the same
        // card, separated by a label — and a label is not a card. They are in
        // Map now, beside the transform and the ramp they belong with; stored
        // together all the same, so a crosshair turned off here is off in the 1D
        // browser too, since it is the same preference about the same gesture.
        //
        // What is left is the ones this column does not already offer above.
        // The crosshair and the card are about both pictures and used to be in
        // both rows, lit together: two identical buttons ten lines apart read as
        // two settings, and a reader who turned one off watched the other go
        // dark and wondered what else was coupled. The browser's Tracks card,
        // which has no Map card over it, still offers the whole list
        // (`ui/plotOptions.ts`).
        el(
          'div',
          { class: 'field field-block' },
          el('span', { class: 'field-label', text: 'overlays' }),
          el('div', { class: 'plot-icon-row' }, ...TRACK_ONLY_OPTIONS.map(optionToggle)),
        ),
        // The two legibility numbers on one line, because they are one question
        // asked twice — how easily can this picture be read — and the second is
        // the same control the browser's Tracks card carries, writing the same
        // field of the same store: a reader who faded the tracks beside the map
        // and then closed it finds them faded in the browser, which is what
        // "these are the same tracks" has to mean.
        this.options.annotations === undefined
          ? textScaleField()
          : fieldPair(textScaleField(), everyTrackOpacityField(this.options.annotations.store)),
      ),
    )
    // The matrix's own labels are the one thing a scale change does not simply
    // redraw: the gutters they sit in are measured from the font, so the canvas
    // has to be told rather than repainted. Both legends, because a compared map
    // has two and updating one leaves the other at the old size.
    this.unsubscribeTextScale = subscribeTextScale(() => {
      this.heatmap.setLabelFont(scaleFont(DEFAULT_LABEL_FONT))
      this.painted = null
      this.schedule()
    })
    // Armed and disarmed from a form in the sidebar, and what changes here is
    // what the next Shift-drag on the picture means — so the map has to be told
    // rather than asked, and told at the moment the button is pressed rather
    // than at the moment the hand moves.
    this.unsubscribePick = subscribePick(() => {
      this.heatmap.setBandMode(isArmed() ? 'pick' : 'zoom')
    })
    this.unsubscribePlotOptions = subscribePlotOptions((options) => {
      this.heatmap.setPlotOptions(options)
      this.paintPlotOptions(options)
      // The key is the panel's, not the renderer's, so the renderer's copy of
      // the option changes nothing on its own: hidden here, and skipped in the
      // export, which draws what the screen shows.
      this.legendOn = options.legend
      this.keys.classList.toggle('hidden', this.narrow || !this.legendOn)
      // Put away now, not on the next pointer move: a control that needs the
      // hand to twitch before it takes effect reads as not having worked.
      if (!options.tooltip) this.readout.hide()
    })
    // The box the picture is drawn in and the handles on its edges, which
    // follow the session's two sizes from here on (`ui/MapBox.ts`).
    this.box = new MapBox({
      heatmap: this.heatmap,
      lanes: this.lanes,
      grid: () => this.grid,
      wrap: () => this.wrap,
      turned: () => this.turned,
      hostSize: () => this.readout.hostSize,
      schedule: () => this.schedule(),
    })
    // Every map's, a companion's as well as the lead's: a deck's maps move as
    // one, and one held on its diagonal beside one that was not would be dragged
    // off it by its own neighbour (`ui/diagonalLock.ts`).
    this.heatmap.setDiagonalLock(diagonalLocked())
    this.unsubscribeDiagonalLock = subscribeDiagonalLock((on) => {
      this.heatmap.setDiagonalLock(on)
      this.paintDiagonalLock(on)
      this.paintReframeHint()
      this.schedule()
    })

    // Offered whenever there is more than one answer. A file with no weights and
    // no extra columns has exactly one thing its cells can be, and a dropdown
    // with a single entry is a control that cannot be used — it says "you have a
    // choice here" and then refuses to make one.
    const scores = options.scores
    if (scores !== undefined && scores.choices.length > 1) {
      const select = el('select', { class: 'select' })
      this.scoreSelect = select
      select.append(...scores.choices.map(scoreOption))
      select.value = scores.current
      select.addEventListener('change', () => {
        // Through the list held now rather than the one built with: a circle
        // ticked since offers an entry the first never had ({@link offerScores}).
        const choices = this.options.scores?.choices ?? scores.choices
        const picked = choices.find((choice) => choice.id === select.value)
        if (picked !== undefined) scores.onChange(picked)
      })
      // No transform is forced by any of these. Balanced values are fractions, so
      // `log10` of them is negative throughout, which the auto rule used to
      // answer with `[0, 1]` — a blank panel — and the old tickbox used to dodge
      // by switching the transform to `log1p` behind the user's back. Both the
      // rule and `log10`'s treatment of zero now handle a sub-unit matrix, so the
      // transform is the user's choice again (`render/scale.ts`), which is also
      // what makes an unknown extra column safe to offer: whatever it holds, the
      // reader can find a transform that shows it.
      // **Beside its label, like the three selects under it.** It was a block
      // field, and the reason was real — beside a 6.5 rem label the select was
      // about seven characters wide and the native arrow ate the last of them,
      // so the one word a reader checks before reading a map read `balancec`.
      // The answer was the label column, not the shape of this one row: at
      // 4.6 rem every option in this card fits beside its label, and a card
      // that held one label above its dropdown and three beside theirs was
      // four rows of two different shapes for one kind of question.
      const scoreField = field(
        'score',
        select,
        // Two sentences. What this replaces was ninety words describing all
        // seven entries, in a tooltip that shows for a few seconds — and each
        // entry that needs a note already carries one on its own option, which
        // is where a reader hovering that entry will find it.
        'What the cells are: the stored counts, cooler’s balanced matrix, or a reading ' +
          'computed here from the block on screen. Each of those has its own note on hover.',
      )
      // First among the value fields: it is the question the other three answer
      // *about* — what the numbers are, before how they are transformed,
      // ramped and clipped.
      controls.unshift(scoreField)
    }

    if (options.compare !== undefined) {
      const compare = options.compare
      const opSelect = el('select', { class: 'select' })
      for (const name of COMPARE_OPS) {
        opSelect.appendChild(el('option', { value: name, text: COMPARE_OP_LABELS[name] }))
      }
      opSelect.value = compare.op
      opSelect.addEventListener('change', () => {
        if (isCompareOp(opSelect.value)) compare.onOpChange(opSelect.value)
      })
      controls.unshift(
        field(
          'compare',
          opSelect,
          `How the two files are put together. Split draws ${compare.labels[0]} above the ` +
            `diagonal and ${compare.labels[1]} below it, each in its own counts; ratio and ` +
            'difference draw one derived field over the whole square, centred where the two agree.',
        ),
      )
    }

    // The turn and the baseline: two switches, one row, and both of them
    // toggles rather than the button and the tickbox they used to be.
    //
    // They belong together because they are the two controls that change *what
    // picture this is* — one the geometry, one the units — as against the score
    // and the clip, which change what a number is worth, and the overlays, which
    // change what is drawn over it. And they are toggles because they are
    // states, not actions: an icon button that looks the same before and after
    // it has been pressed is the one shape a reader cannot read the setting off,
    // and a tickbox beside it made the same setting look like a different kind
    // of thing. Same mark, same lit state, same `aria-pressed` as every overlay.
    const picture: HTMLElement[] = []

    // The refit, first: it is the only one of these that is an *action*, and
    // the one that says what the other three are a picture of. Unlit, as the
    // recentre-on-diagonal beside it is, because there is no state to read off
    // either of them.
    picture.push(
      iconButton(
        'maximize',
        withKey('Undo every pan and zoom — a double click on the plot does too', KEYS.fit),
        () => this.fit(),
        { class: 'btn btn-icon', size: 15 },
      ),
    )

    // Then the refine, because it decides what the two after it are *of*: the
    // turn changes the geometry and `O/E` changes the units, and both of those
    // are read off whatever grid the picture is on. Off by default
    // (`ui/refine.ts`), so this is the control that turns it on rather than a
    // light that happens to be lit.
    const refineButton = iconButton(
      REFINE_ICON,
      REFINE_HINT,
      () => {
        setRefineEnabled(!refineEnabled())
      },
      { class: 'btn btn-icon btn-toggle', size: 15 },
    )
    this.refineButton = refineButton
    this.paintRefine(refineEnabled())
    // **Not offered, for now.** The switch is built, painted and subscribed
    // exactly as before — the preference is global, it is still honoured by
    // every panel, and the palette and a stored `on` still reach it — it simply
    // is not in the row. Built rather than skipped so that putting it back is
    // one line rather than an unpicking, and so the machinery below cannot rot
    // while it is out of sight.
    const OFFER_REFINE = false
    // A global preference with several panels on screen: a deck of five maps
    // that disagreed about whether the zoom reads would be five answers to one
    // question. Unsubscribed with the panel.
    this.stopRefineWatch = subscribeRefine((on) => {
      this.paintRefine(on)
      // The note under the map tells a reader what zooming will do, and it now
      // tells them a different thing.
      this.schedule()
    })
    if (OFFER_REFINE) picture.push(refineButton)

    const turn = options.turn
    if (turn !== undefined && turn.onChange !== undefined) {
      // Read back through `this.options` rather than through the object
      // captured here. The session builds a fresh presentation on every render
      // and {@link setTurn} swaps it in, so a closure over the construction-time
      // one answers "is it turned?" with the state the panel opened in — and the
      // control becomes a one-way switch that asks for a flip that is already on
      // and can never ask for it to come off.
      const button = iconButton(
        TURN_ICONS.off,
        TURN_HINT,
        () => {
          const held = this.options.turn
          held?.onChange?.(held.on !== true)
        },
        { class: 'btn btn-icon btn-toggle', size: 15 },
      )
      this.turnButton = button
      this.paintTurn(turn.on === true)
      picture.push(button)

      // Beside the turn, and offered by whoever offers it: the turn *makes* a
      // picture of the diagonal and this one *holds the view on* it, and in a
      // deck the lock is every map's. A companion, which draws the turn without
      // owning the control, has no more business owning this one.
      //
      // A toggle, lit while the view is held: it used to be an action — the view
      // slid onto the diagonal, once — and every gesture after it slid the view
      // off again, so a reader reading along the diagonal pressed it after every
      // drag. Locking does that press and then keeps to it (§7.2).
      const diagonalButton = iconButton(DIAGONAL_ICON, diagonalHint(), () => void toggleDiagonalLock(), {
        class: 'btn btn-icon btn-toggle',
        size: 15,
      })
      this.diagonalButton = diagonalButton
      // Disabled until a block says otherwise: the panel is built before
      // anything is read, and a control that is live before there is a picture
      // to move is one that does nothing when pressed.
      this.paintDiagonal(false)
      this.paintDiagonalLock(diagonalLocked())
      picture.push(diagonalButton)
    }

    // The baseline. A control of its own rather than an entry in the score
    // picker, because it composes with every entry in that list rather than
    // being one more of them: `O/E` of balanced counts is the standard reading,
    // and folding it in would make the two mutually exclusive for no reason but
    // the shape of the control.
    const derive = options.derive
    if (derive !== undefined && derive.onExpectedChange !== undefined) {
      const onExpectedChange = derive.onExpectedChange
      // Two letters and a stroke, not a glyph. Every mark in these rows stands
      // for something with a shape — a ruler, a grid, a crosshair — and a ratio
      // has none; the nearest drawn thing is a division sign, which would say
      // "divide" without saying by what. `O/E` is what the field is called in
      // every paper it appears in and what the colourbar beside it already says,
      // so the button is simply that, set to the size the marks beside it are.
      const button = el('button', {
        class: 'btn btn-icon btn-toggle btn-word',
        title: OE_HINT,
        attrs: { type: 'button', 'aria-label': OE_HINT },
      })
      button.append(el('span', { class: 'btn-word-text', text: 'O/E' }))
      button.addEventListener('click', () => {
        onExpectedChange(this.options.derive?.expected !== true)
      })
      this.expectedButton = button
      this.paintExpected(derive.expected)
      this.gateExpected(derive.baseline)
      picture.push(button)

      // Beside the O/E it modifies, and only where there is one sequence for it
      // to be about. A word, like the O/E's: the thing it divides out has no
      // shape of its own to draw a mark from.
      //
      // **Made with the O/E and shown by the presentation**, never decided once
      // here: the row is built with the panel, and the origin a task places, or
      // the circle the first open ticks, arrives after it — so a button built
      // only if the answer was already in stayed missing until the view was
      // rebuilt, and an `ori` that captured its origin centred on the old one
      // after a second run moved it. Both read the live presentation instead.
      const armsButton = el('button', {
        class: 'btn btn-icon btn-toggle btn-word',
        title: ARMS_HINT,
        attrs: { type: 'button', 'aria-label': ARMS_HINT },
      })
      armsButton.append(el('span', { class: 'btn-word-text', text: 'arms' }))
      armsButton.addEventListener('click', () => {
        const held = this.options.derive?.arms
        held?.onChange?.(held.window === undefined ? DEFAULT_ARM_WINDOW : undefined)
      })
      this.armsButton = armsButton
      picture.push(armsButton)
      // A toggle, lit while the origin is in the middle of what is drawn:
      // pressed then, it frames the sequence from its first base again (§8.15).
      // Read off the window on screen rather than off the view's named region,
      // which a pan does not move.
      const centre = el('button', {
        class: 'btn btn-icon btn-toggle btn-word',
        title: CENTRE_HINT,
        attrs: { type: 'button', 'aria-label': CENTRE_HINT, 'aria-pressed': 'false' },
      })
      centre.append(el('span', { class: 'btn-word-text', text: 'ori' }))
      centre.addEventListener('click', () =>
        this.options.derive?.arms?.onCentre?.(this.centredOnOrigin()),
      )
      this.centreButton = centre
      picture.push(centre)
      this.paintArms(derive.arms)
    }

    if (picture.length > 0) {
      controls.unshift(
        el(
          'div',
          { class: 'field field-block' },
          el('span', { class: 'field-label', text: 'picture' }),
          el('div', { class: 'plot-icon-row' }, ...picture),
        ),
      )
    }

    if (options.levels && options.levels.length > 1) {
      const levelSelect = el('select', { class: 'select' })
      for (const name of options.levels) {
        levelSelect.appendChild(
          el('option', { value: name, text: options.levelLabels?.[name] ?? name }),
        )
      }
      levelSelect.value = this.level
      levelSelect.addEventListener('change', () => {
        this.level = levelSelect.value as 'bin' | 'contig'
        options.onLevelChange?.(this.level)
      })
      controls.unshift(field('level', levelSelect, 'Summed from the loaded matrix — no further reads.'))
    }

    // **There is no circular tickbox here any more** (§8.15). It sat in the card
    // about the map, which was the right card for what it *changes* and the
    // wrong place for what it *is*: a declaration about the assembly — which of
    // these sequences is a plasmid, which is the mitochondrion — asked one
    // sequence at a time, of whichever one happened to be on screen, and
    // readable nowhere. It is a column of tick boxes in the Chromosomes table
    // now, beside the lengths, where every sequence is a row; the General
    // panel's list wears the mark; and this panel still *reads* the answer
    // through `RegionViewProps.circular`, which is what arms the wrapped read.

    // The marks that draw on the matrix, in the card about the matrix. They
    // spent a release at the bottom of the Tracks card under a label reading
    // "matrix", two rows below four buttons that do nothing to it — which is a
    // card apologising for holding the wrong things.
    //
    // **Only things that light.** The refit used to lead this row, on the
    // argument that five marks fit across the column and a row of one reads as
    // a category with one member. But it is the one mark under `overlays` that
    // never lights, beside seven that do — so a reader counting what is drawn
    // on their map found an eighth overlay that was apparently off, and turned
    // it on by pressing it, and lost their pan. It is in the `picture` row
    // above with the turn and the diagonal, which is where the actions that are
    // about the picture rather than about what is drawn over it now live.
    controls.push(
      el(
        'div',
        { class: 'field field-block' },
        el('span', { class: 'field-label', text: 'overlays' }),
        el('div', { class: 'plot-icon-row' }, ...MATRIX_OPTIONS.map(optionToggle)),
      ),
    )

    this.controlsEl = el(
      'div',
      { class: 'controls-card' },
      // "Map", not "View": the card beside it is about the tracks, and both of
      // them are views of something. This one is the matrix.
      cardTitle('Map', 'sliders-horizontal', 'controls-title'),
      // Which map of a deck this card sets, under the title; see {@link setCardFor}.
      this.cardFor,
      el('div', { class: 'panel-controls' }, ...controls),
    )
    // After *both* rows exist, not after the first. The Map card is built well
    // below the Tracks card, so painting where the Tracks card ends left every
    // toggle in this one unlit until the next time somebody changed one — which
    // for the crosshair, offered in both rows, meant the two disagreed on sight.
    this.paintPlotOptions(getPlotOptions())

    // The four edge rectangles live **inside the map**, not over the grid that
    // holds the map and its lanes. Over the grid they covered a quarter of the
    // height and a fifth of the width of the whole thing — which is where the
    // lane stacks are — so a track dragged towards the end of its own stack met
    // a drop target instead of the gap it was aiming for, and the last position
    // in the order could not be reached at all. Inside the map they overlap
    // nothing that can be dragged, they are thirty-pixel strips rather than
    // quarters of the picture, and they still name the edge they stand for.
    //
    // Built on every file, not only where annotations can be loaded: the
    // rectangles are also where a lane already drawn is dragged to move it to
    // another edge, and that gesture needs no loader.
    // The keys, and under them how to zoom into a region: one column in the
    // corner, so the hint moves up into the corner when the legend is off and
    // stands under the keys when it is on.
    this.keys = el('div', { class: 'map-keys' }, this.key.el, this.key2.el)
    this.reframeHint = el('div', { class: 'map-hint', attrs: { 'aria-hidden': 'true' } })
    this.keySlot = el('div', { class: 'map-key-slot' }, this.keys, this.reframeHint)
    this.paintReframeHint(false)
    // The gestures on the lane stacks and the rectangles they aim at, before the
    // map's own box: the rectangles are built into it (`ui/LaneGestures.ts`).
    this.laneGestures = new LaneGestures({
      lanes: this.lanes,
      store: this.laneStore,
      mapId: this.mapId,
      heatmap: this.heatmap,
      options,
      readout: this.readout,
      grid: () => this.grid,
      editor: () => this.laneEditor,
      isPicking: () => this.picking !== null,
      laneGeometry: () => this.laneGeometry(),
      turned: () => this.turned,
      locusAxes: () => this.locusAxes,
      schedule: () => this.schedule(),
      bandDragged: (which, span) => this.bandDragged(which, span),
    })
    const wrap = (this.wrap = el(
      'div',
      { class: 'heatmap-wrap' },
      this.canvas,
      this.overlay,
      this.keySlot,
      this.box.grips.top,
      this.box.grips.bottom,
      this.box.grips.left,
      this.box.grips.right,
      ...LANE_EDGES.map((edge) => this.laneGestures.edgeZone(edge)),
      this.laneGestures.faceZone(),
    ))

    for (const edge of LANE_EDGES) {
      const layer = el('div', { class: 'lane-overlays' })
      this.laneLayers.set(edge, layer)
      this.laneControls.set(
        edge,
        // A track added, removed or regrouped moves the lane a caret was
        // measured into, and a box hanging over the wrong lane would commit
        // its number to the right one. A pan changes no signature, which is
        // why the caret survives one.
        new LaneControls(layer, this.laneStore, () => this.laneEditor?.close()),
      )
    }

    // The map and its lanes are one grid, so a lane canvas is the same width as
    // the map's canvas by construction rather than by arrangement — and the
    // tooltip, parented here, can float over any of them.
    this.grid = el(
      'div',
      { class: 'panel-grid' },
      wrap,
      ...LANE_EDGES.map((edge) => this.lanes.canvasFor(edge)),
      ...LANE_EDGES.map((edge) => this.lanes.labelCanvases[edge]),
      ...this.laneLayers.values(),
      this.readout.tooltip,
    )
    this.laneEditor = new LaneEditor({
      host: this.grid,
      store: this.laneStore,
      shownLimits: (id) => this.lanes.shownLimits(id),
      onChange: () => this.schedule(),
    })
    for (const edge of LANE_EDGES) {
      this.laneGestures.watchLane(edge, this.lanes.canvasFor(edge), this.lanes.labelCanvases[edge])
    }
    this.laneGestures.watchEdgeDrops()
    this.laneListeners.push(offerLanding(this.laneGestures.laneSurface))
    // A restyle, a rename or a move of any lane is a different picture. Taken
    // on the store this panel was built against, which on a file with no
    // annotation machinery is the empty one — it never fires, and that costs
    // nothing next to a branch here.
    this.laneListeners.push(this.laneStore.subscribe(() => this.schedule()))
    const annotations = options.annotations
    if (options.annotations !== undefined) {
      this.heatmap.setOverlayPainter((ctx, frame) => this.paintOverlays(ctx, frame))
      // Escape abandons a half-finished pick. On the window rather than the
      // canvas: the gesture is armed from a button in the sidebar, so the focus
      // is very often not on the plot at the moment the reader changes their
      // mind.
      const onEscape = (event: KeyboardEvent): void => {
        if (event.key === 'Escape' && this.picking !== null) {
          event.preventDefault()
          this.cancelPicking()
        }
      }
      window.addEventListener('keydown', onEscape)
      this.laneListeners.push(() => window.removeEventListener('keydown', onEscape))
      // The cards write to the stores and the panel reads from them; neither
      // needs a reference to the other, which is what lets the cards live in the
      // shell's sidebar while the plot lives inside a view the shell replaces.
      this.laneListeners.push(options.annotations.manual.subscribe(() => this.schedule()))
    }

    // Inside the picture, in its top-right corner, where every figure in the
    // literature puts a key — and where it costs the map none of its width. The
    // strip that used to stand beside the plot took between 5.5 and 7 rem of
    // the column it was next to, which in a deck of four is four such margins
    // and maps a third narrower than the window could have drawn them.
    const body = el('div', { class: 'panel-body' }, this.grid)

    // The same card the 1D browser's column has, built from the same class:
    // beside a map a group could be *made* — from the row's own select, or the
    // batch bar — and then never inspected, undone or drawn differently, which
    // made the mode a decision with nowhere to take it back.
    this.groupsCard =
      annotations === undefined
        ? null
        : new GroupsCard({
            store: annotations.store,
            groups: annotations.groups,
            onChange: () => this.schedule(),
          })
    this.cards = [
      this.exportEl,
      this.controlsEl,
      this.plotEl,
      ...(this.groupsCard === null ? [] : [this.groupsCard.el]),
    ]
    this.syncCardsShown()

    this.el = el(
      'section',
      { class: 'panel' },
      ...(options.hideTitle === true && options.detachedControls === true
        ? []
        : [
            el(
              'header',
              { class: 'panel-head' },
              ...(options.hideTitle === true ? [] : [this.titleNode]),
              ...(options.detachedControls === true
                ? []
                : [this.exportEl, this.controlsEl, this.plotEl]),
            ),
          ]),
      body,
    )

    // Labels and the plot frame are page furniture, so they follow the theme.
    // The canvas cannot read a CSS variable, and the values are only correct
    // for the theme that was in force when they were read — hence a watcher on
    // both the explicit override and the system preference.
    this.themeWatchers = watchTheme(() => {
      this.heatmap.setPalette(readCanvasPalette(this.canvas))
      this.schedule()
    })

    // The key hides itself on a phone, where the plot is as wide as the screen
    // and a box in its corner covers a real fraction of the data. Same
    // breakpoint as the stylesheet's, stated once here because what the export
    // draws cannot read a media query.
    this.narrowWatcher = watchMedia(NARROW_QUERY, (narrow) => {
      this.narrow = narrow
      this.keys.classList.toggle('hidden', narrow || !this.legendOn)
      // Nor the hint, on a screen with no Option key to hold.
      this.reframeHint.classList.toggle('hidden', narrow)
      this.schedule()
    })

    this.observer =
      typeof ResizeObserver === 'undefined'
        ? null
        : new ResizeObserver(() => {
            // The *grid* is what is observed, not the plot: it is the tooltip's
            // positioning parent, and it is the box that changes when a lane
            // appears — which the plot's own size does not.
            this.readout.hostSize = { width: this.grid.clientWidth, height: this.grid.clientHeight }
            // Room *and* box, which is what a lane appearing has to change: the
            // stack beside the map takes from the same width the band is drawn
            // in, and re-measuring without redrawing left the band overlapping
            // the tracks that had just arrived under it.
            this.box.refit()
            this.heatmap.resize()
            this.placeKey()
            this.centrePlot(body)
            this.schedule()
          })
    this.observer?.observe(this.grid)
    // …and the box the grid is centred in, which is what actually says how much
    // room a turned map has. The grid is sized by its own contents, so a window
    // widened around a map that did not change size moves this and not that.
    this.observer?.observe(body)
    // The canvas has no size until it is in the document; size it once laid out.
    // And no *computed palette* either — the three colours it borrows come from
    // the centre column it is about to be mounted in — so read them again here,
    // rather than trust the fallbacks the constructor had to use.
    requestAnimationFrame(() => {
      this.readout.hostSize = { width: this.grid.clientWidth, height: this.grid.clientHeight }
      this.box.measureRoom()
      this.heatmap.setPalette(readCanvasPalette(this.canvas))
      this.heatmap.resize()
      this.placeKey()
      this.centrePlot(body)
      this.schedule()
    })
  }

  /**
   * Bring the map into the middle of a body too narrow for it and its lanes.
   *
   * A deck cell three or four across is that body (§16.5): its lanes are wider
   * than it before the map has had a pixel, and it scrolls sideways rather than
   * painting them over the next cell. Left at the start of that scroll, the
   * cell showed its left-hand stack and no map at all — the one thing the cell
   * is of. So the map is centred, and the stacks either side of it are what the
   * reader scrolls to. A no-op anywhere the body is not a scroll box, or fits.
   */
  private centrePlot(body: HTMLElement): void {
    if (body.scrollWidth <= body.clientWidth + 1) return
    const box = body.getBoundingClientRect()
    const plot = this.wrap.getBoundingClientRect()
    const centre = plot.left - box.left + body.scrollLeft + plot.width / 2
    body.scrollLeft = Math.max(0, Math.round(centre - body.clientWidth / 2))
  }

  /**
   * Save the map as a figure — the `S` key, and the button in the Export card
   * ({@link MapFigure.savePlot}).
   */
  savePlot(): void {
    this.figure.savePlot()
  }

  /**
   * Route this panel's export to the deck it leads, or back to itself
   * ({@link MapFigure.setDeckExport}).
   */
  setDeckExport(hook: DeckExport | null): void {
    this.figure.setDeckExport(hook)
  }

  /** The same figure onto the clipboard — ⌘C ({@link MapFigure.copyPlot}). */
  copyPlot(): void {
    this.figure.copyPlot()
  }

  /**
   * Hand every lane's value axis back to the data — the `y` key, and the button.
   *
   * The browser's own button, beside a map. One press for what is otherwise one
   * press per lane, and the commonest thing a reader wants after dragging three
   * ceilings about. A group needs nothing special: `auto` resolves through the
   * group's own range, so its members come back to one shared pair.
   *
   * Public because the key is a session command: the shortcut and the mark in
   * the Tracks card have to be the same action, or one of them is a second
   * implementation waiting to drift from the other.
   */
  autoscaleTracks(): void {
    // Every lane whose axis a reader can move, as the browser's button asks —
    // not only those drawn as a profile, which left a barChart's or a junction
    // lane's typed pair standing beside a map after the button that says
    // *every track* (§8.17, §8.23).
    for (const entry of this.laneStore.entries) {
      if (!hasAMovableAxis(entry.kind) || entry.style.limits.auto) continue
      this.laneStore.restyle(entry.id, { limits: { ...entry.style.limits, auto: true } })
    }
  }

  /**
   * Share the height there is between the lanes on both edges, equally.
   *
   * The arithmetic is the browser's, out of `trackControls.ts`; what differs is
   * the *measurement*, and it differs in a way that has to be stated. Beside a
   * map the room is not a subtraction — the plot's own height is `100vh` minus
   * its furniture minus `--lane-bottom`, and `--lane-bottom` is what this writes
   * — so "fill the room left over" would divide by a number that depends on the
   * answer, and could oscillate. The budget is therefore taken **once**, from
   * what the grid currently occupies, and each edge is given its own share of
   * it: the bottom stack's budget is a height and the right stack's is a width
   * taken out of the map's own column.
   */
  /**
   * Show the tracks beside this map, or draw the map on its own.
   *
   * The third stop of the map/tracks cycle, and the only one of the three that
   * does not change which view is mounted: hiding the map swaps a browser in for
   * a panel, and hiding the *tracks* is this panel drawing fewer things. Nothing
   * is edited — see `AnnotationLanes.setBare` — so the stacks come back exactly
   * as they were.
   */
  showLanes(shown: boolean): void {
    this.lanes.setBare(!shown)
    // The stacks' thickness is what the grid reserves for them, and it is
    // written from the same measurement the map's own size comes out of, so this
    // has to go all the way round rather than only asking for a repaint.
    this.remeasure()
  }

  /**
   * Whether the O/E toggle is lit, for its command's chip (`KEYS.expected`) —
   * `null` where this panel offers none: a companion of a deck, a view with no
   * derivation to take.
   */
  get expectedLit(): boolean | null {
    return this.expectedButton === null ? null : this.expectedButton.getAttribute('aria-pressed') === 'true'
  }

  /** Whether {@link toggleExpected} has a toggle to press: one offered, and not greyed by a baseline. */
  get canToggleExpected(): boolean {
    return this.expectedButton !== null && !this.expectedButton.hasAttribute('disabled')
  }

  /** `e`: the O/E toggle's press (§7.5), whatever its button would do. */
  toggleExpected(): void {
    if (this.canToggleExpected) this.expectedButton?.click()
  }

  /** Whether {@link centreOnDiagonal} has somewhere to go: a diagonal in the block, and no turn. */
  get canCentreOnDiagonal(): boolean {
    return this.diagonalPossible
  }

  /**
   * The view slid onto the diagonal at the zoom it is at — what taking the
   * diagonal lock does first (§7.2), and nothing where its button is greyed: a
   * block with no diagonal, or a turned map, whose picture already is one.
   */
  centreOnDiagonal(): void {
    if (this.diagonalPossible) this.heatmap.centreOnDiagonal()
  }

  fitTracks(): void {
    const box = this.grid.getBoundingClientRect()
    // Per axis rather than per edge: the stacks above and below the map take
    // from one height between them, and a half each would let four lanes take
    // the whole window. The same for the two beside it.
    for (const axis of [
      { edges: ['top', 'bottom'] as const, room: box.height },
      { edges: ['left', 'right'] as const, room: box.width },
    ]) {
      const slots = axis.edges.reduce((total, edge) => total + this.lanes.slotCount(edge), 0)
      if (slots === 0) continue
      // Half the box on the axis these stacks take from, which is the most they
      // may claim without the map ceasing to be the thing being looked at.
      const room = axis.room / 2 - LANE_GAP * (slots + 1)
      const size = heightThatFills(room, slots)
      if (size === null) continue
      for (const edge of axis.edges) {
        setTrackHeight(this.laneStore, this.lanes.lanesOn(edge), size)
      }
    }
  }

  /**
   * The other way out of a stretch: every lane down to the shortest of them.
   *
   * Across every edge rather than each on its own, which is the same rule
   * {@link setTrackHeight} follows and for the same reason: a bottom lane and a
   * right-hand one meet at the corner of one figure, and two stacks shrunk to
   * two different heights is the corner disagreeing with itself.
   */
  shrinkTracks(): void {
    const size = smallestLaneSize(LANE_EDGES.flatMap((edge) => this.lanes.lanesOn(edge)))
    if (size === null) return
    this.setTrackHeight(size)
  }

  /** Give every lane on every edge one height, chosen rather than computed. */
  setTrackHeight(px: number): void {
    for (const edge of LANE_EDGES) {
      setTrackHeight(this.laneStore, this.lanes.lanesOn(edge), px)
    }
  }

  /**
   * Point the turn control at the picture the next press produces.
   *
   * **A swap, not a light**, and that is the whole of what changed here. Its
   * mark is the *destination*: a square map offers a triangle, and a turned one
   * offers a square. Lighting it as well said the opposite thing at the same
   * time — a turned map showed a square in accent blue, which reads as "square
   * is on" beside a band along a diagonal, and the reader has to press it to
   * find out which of the two the button meant. The neighbouring toggles are
   * lights and are right to be: `O/E` keeps one mark and changes its state, so
   * the tint is the only thing that can carry it.
   *
   * `aria-pressed` is what the stylesheet tints by, so it is the thing that has
   * to go — and with it the state has to be said in words instead, since a
   * screen reader was reading it off exactly that attribute. The label is the
   * button's whole meaning either way, which is why it is written here rather
   * than left at the construction-time hint.
   */
  private paintTurn(on: boolean): void {
    const button = this.turnButton
    if (button === null) return
    button.removeAttribute('aria-pressed')
    button.classList.remove('is-on')
    const label = on ? 'Draw this map square again' : 'Turn this map 45°, onto its diagonal'
    button.title = `${label}. ${TURN_HINT}`
    button.setAttribute('aria-label', label)
    button.replaceChildren(icon(on ? TURN_ICONS.on : TURN_ICONS.off, { size: 15 }))
  }

  /**
   * Offer the recentre control, or grey it.
   *
   * Greyed rather than hidden, on the same rule the turn beside it follows: a
   * reader looking at the trans corner of two chromosomes should be able to see
   * that the control exists and find out from its hint what it wants of them.
   *
   * Off while the map is turned as well as on a block with no diagonal, and the
   * second is not a technicality: a turned picture *is* the diagonal, so the
   * button would be offering to move the view to where it already is.
   */
  private paintDiagonal(possible: boolean): void {
    this.diagonalPossible = possible
    const button = this.diagonalButton
    if (button === null) return
    button.classList.toggle('is-disabled', !possible)
    if (button instanceof HTMLButtonElement) button.disabled = !possible
  }

  /**
   * Say how to zoom into a region from here — the words under the key while
   * the pointer is over the map (§7.2).
   *
   * Option and a drag is the gesture, and nothing on the picture says so: a
   * reader who has not opened the shortcuts dialog pans, wheels and gives up on
   * the one gesture that opens a stretch at its own resolution. So it is said in
   * the corner, small and with no box round it — a halo of the page for
   * legibility over cells — and only while the hand is over the map, which is
   * when the question is asked. In the reader's own modifiers, and saying what a
   * drag will do *now*: under the diagonal lock Option alone draws on the
   * diagonal, under a turn the box is a stretch of the genome, and Shift's line
   * only where there is a diagonal for it to pin a box to.
   */
  private paintReframeHint(turned: boolean = this.turned !== null): void {
    const opt = optionKey()
    const lines = turned
      ? [`${opt} + drag to zoom into a stretch`]
      : !this.diagonalPossible
        ? [`${opt} + drag to zoom into a region`]
        : diagonalLocked()
          ? [`${opt} + drag to zoom along the diagonal`]
          : [`${opt} + drag to zoom into a region`, `${shiftKey()} + ${opt} + drag to zoom along the diagonal`]
    this.reframeHint.replaceChildren(...lines.map((text) => el('div', { text })))
  }

  /**
   * Light the diagonal lock's toggle.
   *
   * From the store rather than from the press, for {@link paintRefine}'s reason:
   * the lock is every map's and is moved from the keyboard and the palette as
   * often as from here. Lit and greyed together is a state too — a lock taken
   * on a block the diagonal does not cross, waiting for the next one that it
   * does.
   */
  private paintDiagonalLock(on: boolean): void {
    const button = this.diagonalButton
    if (button === null) return
    button.setAttribute('aria-pressed', String(on))
    button.classList.toggle('is-on', on)
  }

  /**
   * Light the adaptive-resolution toggle.
   *
   * Read from the store rather than from a captured value, for the reason
   * {@link paintTurn} is: the preference is global and can be moved from the
   * command palette or from another panel, and a switch that answers from what
   * it was built with is a switch that comes to disagree with the thing it
   * controls.
   */
  private paintRefine(on: boolean): void {
    const button = this.refineButton
    if (button === null) return
    button.setAttribute('aria-pressed', String(on))
    button.classList.toggle('is-on', on)
  }

  /**
   * Light the arms toggle, and grey it with the reason where there is no origin
   * to read the arms from — a control that does nothing when pressed is one a
   * reader concludes is broken.
   */
  private paintArms(arms: ArmsPresentation | undefined): void {
    this.centreButton?.classList.toggle('hidden', arms?.onCentre === undefined)
    this.paintCentre()
    const button = this.armsButton
    if (button === null) return
    button.classList.toggle('hidden', arms?.onChange === undefined)
    // Greyed under `arm decay`, as the O/E is under any baseline: that one is
    // read along the arms whatever the toggle says, so a press would change
    // nothing on screen (§8.15).
    const alongArms = this.options.derive?.baseline === true && this.options.derive.alongArms === true
    const on = arms?.window !== undefined && arms.refusal === null && !alongArms
    button.setAttribute('aria-pressed', String(on))
    button.classList.toggle('is-on', on)
    const refused = arms === undefined || arms.refusal !== null
    button.disabled = refused || alongArms
    const hint = refused ? (arms?.refusal ?? ARMS_HINT) : alongArms ? ARMS_ON_ARM_BASELINE_HINT : ARMS_HINT
    button.title = hint
    button.setAttribute('aria-label', hint)
  }

  /** Light `ori` while the origin is in the middle of what is drawn. */
  private paintCentre(): void {
    const button = this.centreButton
    if (button === null) return
    const on = this.centredOnOrigin()
    if (button.getAttribute('aria-pressed') === String(on)) return
    button.setAttribute('aria-pressed', String(on))
    button.classList.toggle('is-on', on)
    const hint = on ? UNCENTRE_HINT : CENTRE_HINT
    button.title = hint
    button.setAttribute('aria-label', hint)
  }

  /**
   * Whether the origin is in the middle of the window on screen, to within a
   * drawn cell — which is what `ori` leaves the view as, and what a zoom about
   * the middle keeps.
   */
  private centredOnOrigin(): boolean {
    const frame = this.options.derive?.arms?.frame
    const axis = this.locusAxes.cols
    if (frame === null || frame === undefined || this.data === null || axis === null) return false
    // One sequence across the whole picture: a view over two has no one origin.
    const scale = this.heatmap.scaleX
    const windows = this.framedWindows(axis, scale)
    if (windows.length === 0 || windows.some((window) => window.contig !== windows[0].contig)) {
      return false
    }
    const [from, to] = scale.domain
    const unit = (from + to) / 2
    const perUnit = axis.segmentAt(unit)?.bpPerUnit ?? 0
    // Two bins, or a pixel where a pixel is coarser. A bin is the grid the
    // picture is drawn on, and the zoom buttons scale the window about its
    // middle once its ends are rounded out to whole bins, which can move the
    // middle by up to another one: a zoom about the origin keeps it lit, and a
    // pan of any size a reader can see does not.
    const bin = Math.max(frame.binsize, this.options.binsize)
    const tolerance = Math.max(2 * bin, scale.unitsPerPixel * perUnit)
    return originInMiddle(axis.unitToLocus(unit), frame, tolerance)
  }

  /** Light the O/E toggle. Its state lives in the presentation, not in the DOM. */
  private paintExpected(on: boolean): void {
    const button = this.expectedButton
    if (button === null) return
    button.setAttribute('aria-pressed', String(on))
    button.classList.toggle('is-on', on)
  }

  /**
   * Grey the O/E toggle while the score picker is showing the baseline itself.
   *
   * Disabled rather than hidden, and with the reason in the tooltip: a control
   * that vanishes when a *different* control moves reads as a bug, while one
   * that greys and says "you are looking at the denominator" reads as an
   * explanation of the picture on screen.
   */
  private gateExpected(baseline: boolean): void {
    const button = this.expectedButton
    if (button === null) return
    const hint = baseline ? OE_ON_BASELINE_HINT : OE_HINT
    button.toggleAttribute('disabled', baseline)
    button.title = hint
    button.setAttribute('aria-label', hint)
  }

  /**
   * Show the despeckle setting the panel is drawing. {@link paintExpected}'s
   * counterpart, and silent on a companion, which has no picker to set.
   *
   * Programmatic assignment to a `<select>` fires no `change` event, so this
   * cannot loop back through the handler that called it.
   */
  private paintSmooth(token: string): void {
    const select = this.smoothSelect
    if (select === null) return
    select.value = String(token)
  }


  /** Reflect the shared overlay state on the buttons. */
  private paintPlotOptions(options: PlotOptions): void {
    for (const [key, nodes] of this.optionButtons) {
      for (const node of nodes) node.setAttribute('aria-pressed', String(options[key]))
    }
  }

  /** Release the resize observer, the canvas listeners and the subscription. */
  // Before the promise below, which replaces it: fields are set in the order
  // they are written, and the other way round this no-op would overwrite the
  // resolver the promise had just handed over.
  private markFirstData: () => void = () => {}

  /**
   * Settles when this panel is handed its first block — or goes away without
   * one, so nothing waiting on it waits for ever.
   *
   * What the session holds a file's tracks behind (§8.6): the map is the
   * picture a reader opened, and the track downloads it used to race for the
   * same connection — a twelve-megabyte FASTA among them — are held until it
   * is drawn.
   */
  readonly firstData: Promise<void> = new Promise((resolve) => {
    this.markFirstData = resolve
  })

  destroy(): void {
    this.markFirstData()
    this.stopRefineWatch?.()
    this.stopRefineWatch = null
    // A correlation running for a panel that is going away is seconds of a
    // worker thread spent on a picture nobody will see. Cancelled rather than
    // left to resolve into a dead panel, and the client itself is the session's
    // to close.
    this.derivation.destroy()
    setReadout('')
    // A picking mode outlives nothing: the plot it was placing marks on is going
    // away. Ended here rather than left to be garbage-collected, because the
    // card that armed it is *not* going away — it lives in the shell — and it
    // learns the mode is over from this call. Without it, navigating with the
    // mode on leaves a button reading "done" that nothing will ever answer.
    this.cancelPicking()
    this.unsubscribePlotOptions()
    this.unsubscribePick()
    this.unsubscribeTextScale()
    this.box.destroy()
    this.unsubscribeDiagonalLock()
    this.themeWatchers()
    this.narrowWatcher()
    this.observer?.disconnect()
    this.heatmap.detach()
    for (const off of this.laneListeners) off()
    this.laneListeners.length = 0
    // The gestures' own listeners on the lane canvases and the window, and the
    // feature card a click on a lane opened (`ui/LaneGestures.ts`).
    this.laneGestures.destroy()
    // The lanes' sample cache goes with the panel, not with the file: the store
    // outlives this view, and a cache keyed on a view's own geometry would be
    // answering the next view's questions with the last one's data.
    this.lanes.destroy()
    // Through the editor's own close, not by detaching its node: removing a
    // focused input *is* a blur, so a raw removal would hand the blur handler a
    // live editor and commit a value on the way out — from here, that is a store
    // write by a panel that no longer exists.
    this.laneEditor?.close()
    for (const controls of this.laneControls.values()) controls.destroy()
    this.groupsCard?.destroy()
    if (this.frame !== 0) cancelAnimationFrame(this.frame)
    this.readout.destroy()
  }

  /**
   * Re-measure everything after the *shell* changed how much room there is.
   *
   * Folding or dragging a side panel is the one size change nothing here can
   * observe: the plot is normally sized by the window's height, so a wider
   * column resizes no box the `ResizeObserver` is watching — and yet the plot
   * has to grow into the space and re-centre itself in it. The view's own
   * resizes still come through the observer; this is for the ones that arrive
   * from outside it.
   */
  remeasure(): void {
    this.readout.hostSize = { width: this.grid.clientWidth, height: this.grid.clientHeight }
    this.box.refit()
    this.heatmap.resize()
    this.placeKey()
    this.schedule()
  }

  /**
   * Put the key in the top-right corner of the *plot frame*.
   *
   * Not of the wrapper: the canvas is inset by however much its axis labels
   * need, and a key flush with the wrapper's corner floats in the margin above
   * the picture rather than sitting inside it. Read from the frame rather than
   * from the data rectangle, so the key does not walk about as the reader pans
   * a block smaller than its window.
   */
  private placeKey(): void {
    this.reportGeometry()
    const plot = this.heatmap.plotRect
    const size = this.heatmap.cssSize
    this.keySlot.style.top = `${Math.round(plot.y + KEY_INSET)}px`
    this.keySlot.style.right = `${Math.round(size.width - plot.x - plot.width + KEY_INSET)}px`
    // **And away where it would cover the picture rather than annotate it.**
    // The key is capped at 14 rem, and at three cells across a deck the lead —
    // which is the one every other cell is compared against — has three side
    // lanes and about 175 px of plot left, so the box sat over the top half of
    // the data it was explaining. The same argument the phone breakpoint above
    // makes, measured against the picture instead of the window, because a
    // media query cannot see how many cells the reader has opened.
    this.keySlot.classList.toggle('is-crowded', plot.width > 0 && plot.width < KEY_MIN_PLOT)
    this.box.placeGrips()
  }

  /** Refit the block to the canvas, undoing every pan and zoom. */
  fit(): void {
    this.heatmap.fit()
    this.schedule()
  }

  /**
   * The figure as one canvas, at `dpi` dots per inch, framed as the screen is
   * ({@link MapFigure.exportCanvas}).
   */
  exportCanvas(dpi: number, now = new Date()): HTMLCanvasElement {
    return this.figure.exportCanvas(dpi, now)
  }

  /** The figure as one cell of the deck's (§16.5): {@link MapFigure.deckFigure}. */
  deckFigure(now: Date): CellFigure {
    return this.figure.deckFigure(now)
  }

  /**
   * What the figure is of, with the coordinates it is *actually framed at*.
   *
   * A view is panned and zoomed before it is exported, and the export keeps
   * that framing — so a figure captioned `XVI` when it shows 200–600 kb of
   * chromosome XVI is wrong in the way that matters, and the reader has no way
   * to tell from the picture. The suffix is the **display form** (§26.1),
   * through `formatLocus`: 1-based inclusive with grouped digits, which is what
   * the map's own summary, the drawer's *will run on* line and the cell
   * subtitle all print. It used to be `fmt.int` of the 0-based start, which was
   * neither that form nor the region grammar it claimed to be — so one framing
   * appeared on one screen as `IV:1,000,000-1,400,000` in the drawer's head and
   * `IV:1,000,001-…` under the picture, a one-base disagreement that reads as
   * two different windows.
   *
   * Omitted only where it would add nothing: an axis with no single coordinate
   * system (a genome, whose axis is contigs), a block with two different axes
   * (contig × contig), and a picture that is the whole sequence from base zero.
   *
   * **Rows, and then columns, because a turned map has no row positions.**
   * Rotating a map puts *separation* on the vertical axis, so its rows measure
   * how far apart rather than where; asking them where the picture is used to
   * produce a locus with a negative end — `16:49,540,000--20,000` — which then
   * went into the figure's caption and into the provenance line of every track
   * computed from it. `framedRange` refuses a separation axis now
   * ({@link AxisCoords.separation}), and the genomic axis of a turned band is
   * its columns, so asking them next is what gets the region right rather than
   * merely stops it being wrong.
   */
  private framedSubject(): string {
    const subject = this.exportName
    if (subject.includes(' × ')) return subject
    const range = this.framedBpRange()
    if (range === null) return subject
    const name = subject.split(':')[0]
    return formatLocus({ contig: name, start: range.start, end: range.end })
  }

  /**
   * The window on screen in base pairs, snapped to whole bins.
   *
   * `HeatmapView.framedRange` measures the drawn lattice, and a **turned** map
   * is drawn on half bins (`render/rotate.ts`): the right half of the last bin
   * has no column, so the raw answer is half a bin short and the line under the
   * picture read `400 × 400 bins · 1.0 kb · IV:1,000,001-1,399,500 · 399.5 kb`
   * — an arithmetic a reader checks and does not get. The turn is a
   * presentation (§17.2), so the window it reports is the window the square
   * reports: both ends on a bin edge, which is where the cells are.
   *
   * `null` where there is nothing to name — no coordinates, or the whole
   * sequence from base zero, which the subject already says.
   */
  private framedBpRange(): { start: number; end: number } | null {
    const range = this.heatmap.framedRange('rows') ?? this.heatmap.framedRange('cols')
    if (range === null || range.whole) return null
    return {
      start: this.snapToBin(range.start, 'down'),
      end: this.snapToBin(range.end, 'up'),
    }
  }

  /**
   * A base-pair coordinate on the nearest bin edge, in the given direction.
   *
   * Rounded to the file's own bin size rather than to whatever the lattice
   * counts in, because that is what a bin *is*: on a square map every edge is
   * already one and this changes nothing, which is the point — one rule, one
   * answer, both presentations.
   */
  private snapToBin(bp: number, towards: 'up' | 'down'): number {
    const binsize = this.options.binsize
    if (!(binsize > 0)) return Math.round(bp)
    return towards === 'down'
      ? Math.max(0, Math.floor(bp / binsize) * binsize)
      : Math.ceil(bp / binsize) * binsize
  }

  /**
   * What the exported figure says it is: the subject, and where it came from.
   *
   * Everything here is a fact a reader of the figure would otherwise have to be
   * told separately, and every one of them has been the subject of an email
   * about a screenshot: which file, which genome, which region, what bin size,
   * and when — a contact map of the same region at two bin sizes is two
   * different pictures, and a map re-exported after a re-run is a third.
   */
  figureCaption(now: Date): { title: string; detail: string } {
    const context = this.options.caption
    const subject = this.framedSubject()
    const genome = context?.genome
    // `›` rather than `·` between the two: a contig belongs *inside* its
    // genome, which is the relationship the breadcrumb draws the same way. Not
    // added when the subject already opens with the genome — a genome's own
    // view names it once, and a pair names both.
    const title =
      genome === undefined || genome === '' || subject.startsWith(genome)
        ? subject
        : `${genome} › ${subject}`

    const parts: string[] = []
    if (context?.file !== undefined && context.file !== '') parts.push(context.file)
    // A map drawn to another total than the file's (§6.5), said beside the file
    // it was drawn from: a subsample is not the file, and an oversample is an
    // inference, and a figure that travels without its controls has to carry
    // which of the three it is.
    const depth = context?.depth?.() ?? null
    if (depth !== null && depth.mode !== 'none') parts.push(depthPhrase(depth))
    if (this.options.binsize > 0) parts.push(`${resolutionLabel(this.options.binsize)} bins`)
    if (this.level === 'contig') parts.push('contig level')
    if (this.options.balance === true) parts.push('balanced')
    // What the cells are, in the caption, because an exported figure leaves the
    // controls behind: a ratio map and a count map are the same picture to
    // anyone who receives one without being told which it is.
    // Both halves, and in the order they were applied: `ICE · O/E · file1 /
    // file2` is a complete account of the arithmetic, where either half alone
    // would describe a different figure.
    if (this.derived !== null && this.derived.label !== 'counts') parts.push(this.derived.label)
    const comparison = this.comparisonLabel()
    if (comparison !== null) parts.push(comparison)
    if (this.derived?.scope != null) parts.push(this.derived.scope)
    parts.push(this.transform === 'none' ? 'linear' : this.transform)
    // The two ends of the colour scale, as the key states them: a figure whose
    // key has been switched off, or two figures set side by side, are read
    // against their ranges, and a caption that left them out left the reader
    // to guess what the darkest cell was worth.
    const painted = this.painted
    if (painted !== null) {
      const key = this.keyFor(painted)
      parts.push(`colour ${key.loLabel} to ${key.hiLabel}`)
    }
    parts.push(captionStamp(now))
    return { title, detail: parts.join(' · ') }
  }

  /**
   * The framing an analysis would run on, taken **now** (§18.4).
   *
   * A snapshot and not a live view, which is the whole discipline: a finished
   * pileup is a record of the picture it was computed from, so panning
   * afterwards must not quietly change what a figure claims. The drawer prints
   * this back and offers to take a new one; nothing here follows the map.
   *
   * `binsPerCell` is *reported*, not applied. A task that reads for itself reads
   * at the file's native resolution and ignores it; a task that borrows the
   * block below must not pretend the block is finer than it is. Recording it is
   * what lets each of them be right.
   */
  analysisFraming(uri: string): AnalysisFraming | null {
    const data = this.data
    if (data === null) return null
    const binsPerCell = data.binsPerCell ?? 1

    // The score picker's `current` is an **id**, and an id is not a column.
    // `balanced` is counts times two weights and `ICE` is computed here from
    // counts; neither names anything in `/pixels`, so handing one to the reader
    // asks for a dataset that does not exist. Unflattened through the picker's
    // own list — the same three fields `Session.setScore` splits it into — so
    // there is one definition of what a choice means rather than two.
    const scores = this.options.scores
    const choice = scores?.choices.find((entry) => entry.id === scores.current)
    const value = choice?.value ?? DEFAULT_COUNT_COLUMN
    const balance = choice?.balance ?? this.options.balance === true
    const normalise = choice?.normalise ?? null

    const parts = [this.framedSubject()]
    // **The file's bin size, not the screen's.** `binsPerCell` is how many bins
    // the *view* sums into one drawn cell when it is zoomed out, and it was
    // multiplied in here — so a 20 kb file being looked at four bins to the cell
    // reported `80.0 kb bins`, and every track computed from it carried that
    // line as the resolution it was measured at. No task is ever measured at it:
    // `run/blocks.ts` refuses a pooled block outright, so every one of them
    // reads the file at its own resolution. The pooling is a fact about the
    // picture rather than about the numbers, so it is said as one, and only
    // where there is any.
    if (this.options.binsize > 0) {
      parts.push(`${resolutionLabel(this.options.binsize)} bins`)
      if (binsPerCell > 1) parts.push(`${fmt.int(binsPerCell)} per drawn cell`)
    }
    if (this.level === 'contig') parts.push('contig level')
    // The flag and the label are two facts about one reading, and on the
    // commonest file they are the same word: the balanced entry of the score
    // picker is labelled `balanced` (`ui/scores.ts`), so pushing both wrote
    // `… · 1.0 kb bins · balanced · balanced` into every computed row's
    // provenance line and every TSV header — the one line whose job is to say
    // exactly what a model or a track was computed from, reading as though the
    // machine had stuttered. Pushed once where they agree, both where they do
    // not: `balanced · correlation` says something neither half says alone.
    const score = choice?.label ?? value
    if (balance && score !== 'balanced') parts.push('balanced')
    parts.push(score)
    // The total the map was drawn to (§6.5), which every count a task reads is a
    // count *of*: in the drawer's header, the provenance line and the command
    // that reproduces it.
    const depth = this.options.caption?.depth?.() ?? null
    if (depth !== null && depth.mode !== 'none') parts.push(depthPhrase(depth))
    return {
      uri,
      rows: [data.rowExtent[0], data.rowExtent[1]],
      cols: [data.colExtent[0], data.colExtent[1]],
      binsize: this.options.binsize,
      binsPerCell,
      balance,
      value,
      normalise,
      level: data.level,
      label: parts.join(' · '),
      ...(depth === null ? {} : { contacts: depth.contacts }),
    }
  }

  /**
   * A copy of the block on screen, when copying it is cheap (§18.3).
   *
   * **Copied, never transferred.** `Transferable` is the optimisation that looks
   * free here and is the one that blanks the map: the buffer handed away is the
   * one the heatmap draws from, and what is left behind is a neutered array and
   * a blank canvas several frames from the cause.
   *
   * So the size is checked *before* the copy rather than after. A yeast
   * chromosome at 1 kb is 9 MB and clones in a few milliseconds; a whole yeast
   * genome at 1 kb is 586 MB, where the copy is itself the expensive operation
   * and would stall the main thread performing it — which is exactly the frame
   * this whole arrangement exists to protect. Past the limit the answer is
   * `null` and the worker reads for itself, which is what its own mount is for.
   */
  /**
   * The block on screen, as the reader worker sent it.
   *
   * Read-only, and for one caller: a ladder being armed again mid-view has to
   * adopt the block that is *drawn* rather than the one the view first loaded,
   * or it plans its next read from an extent nobody is looking at (§8.15's
   * circular toggle is the case). Every other consumer wants
   * {@link analysisBlock}, which copies and refuses a wrapped one.
   */
  get block(): MatrixResult | null {
    return this.data
  }

  analysisBlock(): BlockInput | null {
    const data = this.data
    if (data === null) return null
    if (data.values.byteLength > BLOCK_COPY_LIMIT_BYTES) return null
    // **Never a block read round a circle** (SPECS §8.15). Its extents are
    // unwrapped — they run off the end of the sequence and resolve modulo it —
    // and every consumer of this one reads them as ordinary absolute bins:
    // `run/blocks.ts` asks whether the block *covers* a sequence's span and then
    // indexes straight into it. The arithmetic that keeps the two apart today is
    // a coincidence of the width cap rather than a rule, and a task reading a
    // rotated block as an unrotated one is the exact shape of wrong answer this
    // whole subtree is written against. The task reads for itself instead, which
    // is slower and right.
    if (data.wrapped !== undefined) return null
    return {
      nrows: data.nrows,
      ncols: data.ncols,
      values: data.values.slice(),
      rowExtent: [data.rowExtent[0], data.rowExtent[1]],
      colExtent: [data.colExtent[0], data.colExtent[1]],
      binsPerCell: data.binsPerCell ?? 1,
    }
  }

  /**
   * Everything drawn on the data: the overlays placed on this map, then the
   * hand-drawn marks over them.
   *
   * Files first and marks second, because a mark is what the reader put there
   * and it must not end up underneath a circle from a loop table.
   */
  /**
   * The frame the overlays are painted against on screen, as it stands: what
   * the heatmap hands {@link paintOverlays}, for a point under the pointer to
   * be measured in the same pixels the marks were drawn in.
   */
  private overlayFrame(): OverlayFrame {
    return {
      plot: this.heatmap.plotRect,
      data: this.heatmap.dataRect,
      rowScale: this.heatmap.scaleY,
      colScale: this.heatmap.scaleX,
      dpr: this.heatmap.devicePixelRatio,
    }
  }

  private paintOverlays(ctx: CanvasRenderingContext2D, frame: OverlayFrame): void {
    const context = this.options.annotations
    if (context === undefined) return
    const palette = readCanvasPalette(this.canvas)

    for (const entry of context.store.overlays(this.mapId)) {
      if (entry.payload?.kind === 'features') {
        drawDiagonalFeatures(ctx, frame, this.locusAxes, entry.payload.data, {
          colour: entry.style.colour,
          opacity: entry.style.opacity,
          shape: overlayShapeOf(entry.style),
          // A point is ringed in the page's own colour, as an arrowhead is.
          halo: palette.labelHaloColor,
        })
      } else if (entry.payload?.kind === 'pairs') {
        drawPairs(ctx, frame, this.locusAxes, entry.payload.data, {
          colour: entry.style.colour,
          opacity: entry.style.opacity,
          radius: entry.style.radius,
        })
      }
    }

    // Boxes under the pointers, for the reason the files go under the marks: a
    // box is an area and a line or an arrowhead is aimed at something, and an
    // aim that disappears where it crosses an outline is an aim at the outline.
    // The one being drawn is drawn with them, because it is one of them: what
    // the reader lets go of is what they were already looking at.
    drawManualRects(
      ctx,
      frame,
      this.locusAxes,
      this.pendingRect === null
        ? context.manual.rects
        : [...context.manual.rects, this.pendingRect],
    )
    drawManualLines(ctx, frame, this.locusAxes, context.manual.lines)
    drawArrowheads(ctx, frame, this.locusAxes, context.manual.arrowheads, palette.labelHaloColor)
    this.laneGestures.paintLaneGuide(ctx, frame)
  }

  /**
   * Place marks by clicking the map, for as long as the mode is on.
   *
   * A **mode**, not a count. It used to collect a fixed number of points and
   * resolve, which meant one arming per mark: click the button, click the map,
   * click the button again. Marking up a figure is not one gesture, it is eight
   * — the corners of four domains, or every loop worth an arrowhead — and the
   * trip back to the sidebar between each was the whole cost of the feature.
   * Now the mode stays on and each click reports a point; the card ends it, and
   * so does Escape.
   *
   * While armed, a click *places* rather than navigates — the only sensible
   * reading of a click during a "pick a point" gesture, and the reason this is a
   * mode rather than a modifier.
   *
   * Each point is reported on **both** axes, because a click is one cell and a
   * cell has a row coordinate and a column coordinate. A vertical line wants the
   * column, a horizontal one the row, and an arrowhead wants both — so the panel
   * hands over both and lets the card take what it means.
   *
   * **A box is a drag**, and a form asking for one says so by handing over a
   * `box` handler instead of a `point` one ({@link PickHandlers}). Then a plain
   * drag draws a marquee rather than panning, and its release is reported as a
   * stretch per axis. A click in that mode does nothing — there is no rectangle
   * in it — rather than falling back to navigating, which would take the picture
   * out from under a reader who had merely twitched.
   *
   * @returns a function that ends the mode, for a card being torn down.
   */
  armPicking(handlers: PickHandlers, onEnd: () => void = () => {}): () => void {
    this.picking?.end()
    this.picking = { ...handlers, end: onEnd }
    this.canvas.classList.add('picking')
    this.heatmap.setDrawMode(handlers.box !== undefined)
    return () => this.cancelPicking()
  }

  /** End a picking mode. Safe to call when none is in progress. */
  cancelPicking(): void {
    const picking = this.picking
    this.picking = null
    this.canvas.classList.remove('picking')
    this.heatmap.setDrawMode(false)
    picking?.end()
  }

  /** `true` while a click would place a mark rather than navigate. */
  get isPicking(): boolean {
    return this.picking !== null
  }

  /**
   * The right-click menu on the map: copy the picture, or place a mark exactly
   * here.
   *
   * "Here" is the cell under the pointer, which is the thing a right click is
   * *for* — the two ways in that already existed are typing a coordinate you
   * know and arming a mode and clicking, and neither answers "this one, the one
   * I am pointing at". The coordinates go in the menu beside the actions so the
   * reader can see what they are about to mark before they mark it.
   *
   * **Copy this** first: the map's cells alone, as they are drawn here, onto
   * the clipboard (§7.2). The marks only where the file can carry them (§8.5),
   * and the menu only over the data, not over the gutters: a right click on a
   * label is the browser's menu, and taking it over to offer nothing would be
   * worse than leaving it.
   */
  private watchContextMenu(): void {
    const onMenu = (event: MouseEvent): void => {
      const box = this.canvas.getBoundingClientRect()
      const cell = this.heatmap.cellAt(event.clientX - box.left, event.clientY - box.top)
      if (cell === null) return
      event.preventDefault()
      const items: MenuItem[] = [
        { label: 'This map' },
        {
          label: 'Copy this',
          hint: 'PNG',
          title:
            'The map as it is drawn here — the cells alone, with no axis, key, frame or pointer — ' +
            'onto the clipboard as a PNG, at the screen’s resolution',
          run: () => copyPicture('map', this.heatmap.dataImage(FIGURE_BACKGROUND)),
        },
      ]
      const context = this.options.annotations
      const at = this.locusOf(cell)
      if (context === undefined || at === null) {
        openMenu(event.clientX, event.clientY, items)
        return
      }

      const { manual } = context
      const add = (mark: Omit<ManualLine, 'id' | 'colour'> | Omit<ManualArrowhead, 'id' | 'colour'>): void => {
        manual.add({ ...mark, id: mintMarkId(), colour: manual.nextColour() } as ManualMark)
      }
      openMenu(event.clientX, event.clientY, [
        ...items,
        { label: 'Mark this point' },
        {
          label: 'Vertical line',
          hint: formatPosition(at.cols.contig, at.cols.bp),
          run: () => add({ kind: 'line', axis: 'vertical', at: at.cols }),
        },
        {
          label: 'Horizontal line',
          hint: formatPosition(at.rows.contig, at.rows.bp),
          run: () => add({ kind: 'line', axis: 'horizontal', at: at.rows }),
        },
        {
          label: 'Crosshair',
          hint: 'both axes',
          // The row's coordinate, because a crosshair is drawn from one point on
          // both axes and on the diagonal — where these are nearly always placed
          // — the two are the same.
          run: () => add({ kind: 'line', axis: 'both', at: at.rows }),
        },
        {
          // `Arrowhead`, the word §8.1 and the Manual card's own section use
          // for this mark: it can be put at any off-diagonal point, and a
          // reader who marked a *loop* here went looking for it under Loops and
          // found Arrowheads. What it is usually marking is in the hint.
          label: 'Arrowhead',
          hint: `a loop at ${formatPosition(at.rows.contig, at.rows.bp)} × ${formatPosition(at.cols.contig, at.cols.bp)}`,
          run: () => add({ kind: 'arrowhead', a: at.rows, b: at.cols }),
        },
        // The marks the hand is on, and all of them (§8.1): measured on the
        // ink as it is drawn here, square or turned, so what the menu names is
        // what the pointer is over.
        ...marksMenu(
          manual,
          manualMarksAt(this.overlayFrame(), this.locusAxes, manual, {
            x: event.clientX - box.left,
            y: event.clientY - box.top,
          }),
        ),
        { label: 'This cell' },
        {
          label: 'Copy coordinates',
          hint: 'to the clipboard',
          run: () => {
            void navigator.clipboard?.writeText(
              `${formatPoint(at.rows)}\t${formatPoint(at.cols)}`,
            )
          },
        },
      ])
    }
    this.canvas.addEventListener('contextmenu', onMenu)
    this.laneListeners.push(() => this.canvas.removeEventListener('contextmenu', onMenu))
  }

  /**
   * Turn a clicked cell into a point on each axis.
   *
   * The cell's *centre*, not its corner: a click lands somewhere inside a cell,
   * and reporting its left edge would put every hand-placed mark half a bin
   * earlier than where the reader aimed.
   *
   * **Through the square**, exactly as the readout is ({@link describe}) and for
   * the same reason: a turned cell's row is a separation and its column is half a
   * bin, so neither is a coordinate of anything a mark can name. Read off the
   * drawn axes it answered `null` on every turned map — which took `pick on map`
   * and the whole right-click menu away in the presentation a region view opens
   * in, silently, since a click that places nothing looks exactly like a click
   * that missed. The arithmetic is `render/rotate.ts`'s, beside the rotation it
   * inverts.
   */
  private locusOf(cell: { row: number; col: number }): { rows: ManualPoint; cols: ManualPoint } | null {
    const at = cellLoci(this.squareAxes, this.turned, cell)
    if (at === null) return null
    return {
      rows: { contig: at.rows.contig, bp: Math.round(at.rows.bp) },
      cols: { contig: at.cols.contig, bp: Math.round(at.cols.bp) },
    }
  }

  /**
   * A box drawn on the map, as a stretch of genome per axis.
   *
   * The 2D counterpart of {@link bandDragged}: the renderer knows cells and this
   * is the object that knows which sequence and which base pair they are. The
   * conversion is `axisSelection`'s, which is the region selection's own — so a
   * box that opens a region and a box that becomes a mark cannot come to name
   * different stretches, and both clamp to the block's own ends.
   *
   * **The same on both presentations**, because {@link DrawnBox} has already
   * taken the drag back to the square: two rows against two columns, whether the
   * hand moved over a square map or over a band. That is what lets a rectangle
   * be drawn off the diagonal on a turned map, which is the one thing a band
   * selection there cannot say.
   *
   * `null` above bin level, where a cell is a whole sequence: a rectangle whose
   * corners are contigs has no base pairs in it, and inventing some would put a
   * mark on the map at coordinates nobody chose.
   */
  private rectFor(box: DrawnBox): { rows: ManualSpan; cols: ManualSpan } | null {
    const data = this.data
    if (data === null || data.level !== 'bin') return null
    // Through the block the drag *began* in, which is what says which sequence a
    // box laid across a boundary is of — the rule a selection follows too.
    const rowGroup = groupAt(data.rowGroups, box.anchor.row)
    const colGroup = groupAt(data.colGroups, box.anchor.col)
    if (rowGroup === undefined || colGroup === undefined) return null
    const span = (axis: SelectedAxis | null): ManualSpan | null =>
      axis?.range === undefined ? null : orderedSpan(axis.label, axis.range[0], axis.range[1])
    const rows = span(this.axisSelection(rowGroup, box.rows, data.rowExtent[0]))
    const cols = span(this.axisSelection(colGroup, box.cols, data.colExtent[0]))
    if (rows === null || cols === null) return null
    // In the file's coordinates where the map is drawn through an edit (§27.7),
    // as every mark is kept and as a clicked place already is: a box laid across
    // a junction is of the piece the drag began in, as one across an edge is of
    // the sequence.
    const edited = this.options.annotations?.edited?.() ?? null
    if (edited === null) return { rows, cols }
    const binsize = this.options.binsize
    const inFile = {
      rows: stretchInFile(edited, rows, bpWithin(rowGroup, box.anchor.row + 0.5, data.rowExtent[0], binsize)),
      cols: stretchInFile(edited, cols, bpWithin(colGroup, box.anchor.col + 0.5, data.colExtent[0], binsize)),
    }
    return inFile.rows === null || inFile.cols === null ? null : { rows: inFile.rows, cols: inFile.cols }
  }

  private boxDrawn(box: DrawnBox): void {
    const handler = this.picking?.box
    const at = this.rectFor(box)
    if (handler !== undefined && at !== null) handler(at)
  }

  /**
   * The box being drawn, shown as the mark it is about to become.
   *
   * **Only under a turn.** On a square map a rectangle of rows against columns
   * *is* a rectangle on screen, so the renderer's own rubber band already draws
   * it exactly — with the coordinate chips on its edges, which this has nowhere
   * to put. Turned, that same rectangle leans at 45° and folds where it crosses
   * the diagonal ({@link drawManualRects}), so a rubber band would be a box
   * drawn around a shape that is not a box: the preview is the mark itself,
   * through the code that will draw it for good, and what the reader lets go of
   * is exactly what they were looking at.
   *
   * The colour is the one the mark will be given, for the same reason.
   */
  private previewRect(box: DrawnBox | null): void {
    const at = box === null || this.turned === null ? null : this.rectFor(box)
    const next: ManualRect | null =
      at === null
        ? null
        : {
            id: 'drawing',
            kind: 'rect',
            a: at.rows,
            b: at.cols,
            colour: this.options.annotations?.manual.nextColour() ?? MANUAL_PALETTE[0],
          }
    if (next === null && this.pendingRect === null) return
    this.pendingRect = next
    this.schedule()
  }

  /**
   * A Shift-drag on the map, as a locus: onto the clipboard, or into a form.
   *
   * The gesture happens on a picture and the answer has to survive the picture:
   * pan, zoom, change resolution, open the browser, and the string still names
   * the same stretch of the same sequence. Block indices are none of that — they
   * are an offset into whichever block was loaded when the hand moved — so they
   * are resolved here, against the axis the drag was actually measured on. On an
   * on-diagonal block either axis gives the same locus; on a rectangular one
   * they are different sequences, and reading a horizontal drag through the row
   * axis would name somewhere the reader never pointed at.
   *
   * The end takes the *next* bin's start rather than the last bin's, so the span
   * covers the whole of the last bin rather than stopping at its first base.
   */
  private bandDragged(which: 'rows' | 'cols', span: [number, number]): void {
    const at = this.bandLocus(which, span)
    if (at === null) return
    // A form is waiting for this one, so it goes there instead of to the
    // clipboard: the reader pressed a button that said "pick on map", and
    // silently copying a string they would then have to paste would be
    // answering a different request.
    if (isArmed()) {
      pickLocus(at)
      return
    }
    void copyTextToClipboard(locusText(at)).catch(() => {
      // An insecure context, or a browser that will not have it. Not worth a
      // dialog: the zoom the same gesture asked for has already happened, and
      // that is the half the reader is looking at.
    })
  }

  /**
   * The box a selection framed, onto the clipboard.
   *
   * `chrI:1-10000|chrII:40001-50000` — the two axes in the order everything else
   * in this panel names them, rows then columns, and each of them written by
   * {@link locusText} so that one half of a 2D copy is exactly what the same
   * stretch would produce on its own. The bar is a separator no coordinate
   * grammar uses, so a pasted pair can be split on it without ambiguity.
   *
   * Nothing above bin level: a cell there *is* a contig or a genome, and a base
   * pair inside one would be an invention — the same rule
   * {@link describeSelection} follows.
   */
  private copySelection(box: SelectionBox): void {
    const data = this.data
    if (data === null || data.level !== 'bin') return
    const rowGroup = groupAt(data.rowGroups, box.anchor.row)
    const colGroup = groupAt(data.colGroups, box.anchor.col)
    if (rowGroup === undefined || colGroup === undefined) return
    const axes = [
      this.axisSelection(rowGroup, box.rows, data.rowExtent[0]),
      this.axisSelection(colGroup, box.cols, data.colExtent[0]),
    ]
    const written: string[] = []
    for (const axis of axes) {
      if (axis === null || axis.range === undefined) return
      written.push(
        locusText({
          contig: axis.label,
          start: Math.round(axis.range[0]),
          end: Math.round(axis.range[1]),
        }),
      )
    }
    void copyTextToClipboard(written.join('|')).catch(() => {
      // An insecure context, or a browser that will not have it. Not worth a
      // dialog: the selection has already done the thing it was drawn for.
    })
  }

  /** A band of one axis of the block on screen, as a locus, or `null`. */
  private bandLocus(which: 'rows' | 'cols', span: [number, number]): PickedLocus | null {
    const axis = which === 'rows' ? this.ownAxes.rows : this.ownAxes.cols
    // **Above bin level a drag names a unit, not a span.** There is no
    // `LocusAxis` on a genome × genome picture — a cell is a whole MAG and a
    // base pair inside one would be an invention — and until this the gesture
    // simply did nothing there: the reader pressed *Pick on map*, dragged
    // across the only picture a metagenome's 4C is naturally anchored from, and
    // the box stayed empty with the button still lit. The run under the drag is
    // what can honestly be reported, and a bare name is what every range
    // grammar here takes for a whole sequence or a whole genome.
    if (axis === null) return this.unitPick(which, span[0])
    return bandRegion(axis, span)
  }

  /**
   * The unit a drag began on, where the axis has no coordinates inside it.
   *
   * Refused when the axis is **pooled by units**: a slot of a pooled overview
   * holds several genomes and its label carries a `+15` saying so, so naming
   * one of them would be picking whichever the reader did not point at. Refused
   * rather than guessed, which leaves the button lit and the box empty — the
   * same answer the gesture gives anywhere else it cannot be honoured.
   */
  private unitPick(which: 'rows' | 'cols', at: number): PickedLocus | null {
    const data = this.data
    if (data === null || (data.contigsPerCell ?? 1) > 1) return null
    const group = groupAt(which === 'rows' ? data.rowGroups : data.colGroups, at)
    if (group === undefined || group.label === '') return null
    return { contig: group.label, start: 0, end: 0, whole: true }
  }

  /**
   * The lanes' view of the frame about to be drawn.
   *
   * Every number comes from the heatmap rather than from this panel: the scales
   * are the objects the heatmap's pan and zoom write, and the two rects are the
   * ones it draws in. That is the whole of §8.4's "nothing computes a second
   * mapping", stated as one function.
   */
  private laneGeometry(): LaneGeometry {
    const palette = readCanvasPalette(this.canvas)
    return {
      plot: this.heatmap.plotRect,
      data: this.heatmap.dataRect,
      colScale: this.heatmap.scaleX,
      rowScale: this.heatmap.scaleY,
      cssWidth: this.heatmap.cssSize.width,
      cssHeight: this.heatmap.cssSize.height,
      hover: this.hoverCell === null ? null : { row: this.hoverCell.row, col: this.hoverCell.col },
      // Turned, the pointer is over a contact rather than over a column, and the
      // two places it is a contact *between* are two different columns of the
      // track below. One line there would have to be drawn half way between them,
      // where nothing is — see {@link anchorColumns}.
      //
      // …except while the next press would name a stretch of the axis rather
      // than a contact ({@link HeatmapView.spanGuide}). The map draws the edge of
      // that stretch as one vertical line, and a stack answering it with a
      // contact's two anchors is the two halves of one instrument disagreeing
      // about what the hand is doing. `null` puts the ordinary single hairline
      // under the pointer's own column, which is that edge.
      anchors:
        this.turned === null || this.hoverCell === null || this.heatmap.spanGuide
          ? null
          : anchorColumns(this.turned, this.hoverCell.row, this.hoverCell.col),
      crosshair: getPlotOptions().crosshair,
      echo: this.echo,
      // The same conversion, for the same reason, on the mark another panel's
      // pointer leaves: the echoed cell is a contact and its column is the
      // midpoint of two places, so a stack answers it with one tick per anchor.
      echoAnchors:
        this.turned === null || this.echo === null
          ? null
          : anchorColumns(this.turned, this.echo.row, this.echo.col),
      laneEcho: this.laneEcho,
      guide: this.laneGestures.laneHover,
      border: this.laneGestures.laneBorder,
      handles: true,
      grip: this.laneGestures.laneHandle,
      scaling: this.laneGestures.laneScaling,
      palette: {
        guide: palette.labelColor,
        halo: palette.labelHaloColor,
        crosshair: CROSSHAIR_COLOR,
      },
    }
  }

  /**
   * Load a block. `HeatmapView` refits and recomputes the auto range (§7.1).
   *
   * `second` is the same block read from the second open file, and it is merged
   * across the matrix diagonal *here* rather than by the caller: the merge has
   * to happen exactly once per read, because `setMatrix` refits the view, and a
   * view that refitted whenever the colour scale moved would throw away the pan
   * and zoom the reader had arrived at.
   */
  setData(data: MatrixResult, title: string, second?: MatrixResult): void {
    this.data = data
    this.markFirstData()
    this.syncCardsShown()
    // Before the derivation below, which builds the correlation's cache key out
    // of it. A block arriving is the one event the key cannot infer: a reader
    // moving from balanced counts to raw ones is re-read on the identical grid,
    // so every other part of the key matches and the previous quantity's
    // correlation would be drawn under the new one's caption.
    this.derivation.newBlock()
    this.lastTitle = title
    // Blanked rather than left to the next frame: the outgoing block's window
    // under the incoming block's bin count is a line describing two pictures.
    this.viewNote.textContent = ''
    this.exportName = title === '' ? this.exportName : title
    this.titleNode.textContent = title
    const { dense, gauge, presentationMoved, turned } = this.derive(data, second)
    this.turned = turned
    // Two legends for two files' counts — and under a ratio or a difference
    // there are no longer two sets of counts in the square but one derived
    // field, so the second strip would be a second scale for numbers that do
    // not exist.
    this.syncLegendSlots()
    // Both legends redrawn for the new block, even where a *pinned* clip
    // survives a navigation and the scale itself has not moved: the second key
    // comes and goes with the second file, and names it.
    this.painted = null
    // Which edge of the box the band stands on. A band fills its box by
    // construction, so this is not slack being distributed — it is which end of
    // the picture the diagonal is at, and therefore which end the tracks line up
    // with (§17.2). `down` is the mirrored half of a comparison, whose diagonal
    // is its top edge. Centring, which is right for a square map, is what left a
    // band floating half way up its panel with a stripe of paper between it and
    // the profiles it exists to be read against.
    //
    // A **mirrored pair** is centred, and for the same reason read the other way
    // up: its diagonal is the line down the middle rather than either edge, so
    // that is the line to pin. It also decides what a band deeper than its box
    // loses. One band is cut to the box and clipped from the top, where there is
    // nothing to see; two are cut to half of it each, and anchoring the pair by
    // an edge takes the whole surplus off *one* file — which is what a zoom out
    // and back in did, leaving the reader with a sliver of the first map above a
    // whole one of the second.
    this.heatmap.setAnchor(anchorFor(turned))
    // Both drags collapse onto the genomic axis under a turn; see
    // {@link HeatmapView.setSpanGestures}.
    this.heatmap.setSpanGestures(turned !== null)
    // A sideways scroll slides along the diagonal where the picture has one.
    this.heatmap.setDiagonalSlide(slidesAlongDiagonal(data, turned))
    // A band's rows are not a thing to fit: the block is cut to the height of
    // the box it is drawn in, so fitting them is a tautology at every zoom and
    // asking for it makes the zoom a function of a number derived from the zoom.
    this.heatmap.setFitAxis(turned === null ? 'both' : 'cols')
    // Before `setMatrix`, which measures its gutters against the canvas: the box
    // is a CSS size and the canvas has to have it before anything is fitted into
    // it, or the first frame of every turn is drawn at the square map's height.
    //
    // The room is measured again rather than taken from the cache, because *this*
    // is the path a turn arrives by: pressing the toggle re-runs the derivation
    // from the top, and a band drawn to a room measured before the last column
    // was folded is a band in the wrong window. One style read per block.
    this.box.refit()
    // No separators under a turn: `isTurnable` has already refused any block
    // spanning more than one sequence, so there is no boundary to draw — and the
    // square block's own would land at the wrong columns anyway, the axis now
    // being counted in half bins.
    // A navigation is a new view, so the gauge starts again from this block —
    // `setData` is what a reader reaches by *asking* for somewhere else, and the
    // colours of a new place are that place's. {@link regrid} is the path that
    // has to keep them.
    this.gaugeBlock = null
    this.gaugeShown = gauge ?? null
    this.heatmap.setMatrix(
      dense,
      turned === null ? separatorsFor(data) : { rows: [], cols: [] },
      gauge,
    )
    this.gaugeBlock = {
      spanBp: Math.max(data.nrows, data.ncols) * Math.max(1, this.options.binsize),
      dense: this.square ?? dense,
    }
    // A cell is a bin, so a block's span in cells is its length in base pairs:
    // the contigs worth naming in a 300-contig genome are the long ones, and
    // they are named however many short ones surround them. Above bin level a
    // cell *is* a contig or a genome, every block is one cell wide, and the
    // rule has nothing to read — hence 0, which turns it off.
    this.heatmap.setLabelMinSpan(
      data.level === 'bin' ? LABEL_MIN_SPAN_BP / Math.max(1, this.options.binsize) : 0,
    )
    this.heatmap.setAxisCoords(this.axisCoordsOf(data, turned))
    this.heatmap.setAxisSpans(this.axisSpansOf(data, turned))
    // The guides follow the two anchors rather than the two axes while this is
    // set, which is the whole of what the view is told about the turn.
    this.heatmap.setTurn(
      turned === null
        ? null
        : {
            maxSeparation: turned.maxSeparation,
            direction: turned.direction,
            ...(turned.fold === undefined ? {} : { fold: turned.fold }),
          },
    )
    this.heatmap.setTurnLabels(this.bandLabels(turned))
    const axes = this.locusAxesOf(data, turned)
    this.locusAxes = axes.drawn
    this.squareAxes = axes.square
    this.ownAxes = axes.own
    // The presentation a derivation took over, recorded now that the block it
    // was chosen for is actually in. Announced from here rather than from
    // `syncDivergingScale` so the store is not patched — and the router not
    // re-entered — half way through installing a matrix.
    if (presentationMoved) {
      this.options.onScaleChange?.({
        transform: this.transform,
        colormap: this.colormap,
        vmin: this.manualVmin,
        vmax: this.manualVmax,
      })
    }
    this.lanes.setAxes(this.locusAxes)
    this.lanes.setMetaAxes(this.metaAxesOf(data, turned))
    // The caret was measured into a lane of the outgoing block, and the number
    // in it belongs to a picture that no longer exists.
    this.laneEditor?.close()
    this.heatmap.setScale(this.scale())
    this.setBusy(false)
    this.schedule()
  }

  /**
   * Swap in a block read on a **different grid**, keeping the reader's window.
   *
   * The zoom-to-refine entry point, and the third way a block arrives. It does
   * everything {@link setData} does except decide the geometry: the derivation,
   * the compare merge, the turn, the rulers, the lanes and the overlays are all
   * rebuilt against the incoming block — which is why refining works under an
   * O/E map, under a blended pair and under a 45° turn rather than being refused
   * on each — but the picture stays over the same stretch of genome at the same
   * magnification.
   *
   * **The window is carried in base pairs, never in cells.** A cell is a
   * different number of base pairs on every grid, so preserving the transform
   * would preserve the wrong thing: a block read twice as fine would come back
   * showing half as much genome. It is read off the outgoing axes, converted
   * back through the incoming ones, and handed to `HeatmapView.regrid`. That is
   * the same conversion the deck's navigation lock makes between two panels of
   * different resolution (`panels/lock.ts`), for the same reason.
   *
   * Returns `false` when the window could not be carried — an axis with no
   * locus, a contig the incoming block does not cover — and changes nothing when
   * it does. The caller's fallback is {@link setData}, which refits: a picture in
   * the right place at the wrong zoom is recoverable, and one in the wrong place
   * is not.
   */
  regrid(data: MatrixResult, binsize: number, second?: MatrixResult): boolean {
    if (this.data === null) return false
    // Read *before* anything moves, off the axes the picture is currently drawn
    // against. A turned map has no row locus, and that is not a failure: its
    // rows are distance from the diagonal and are decided by the band's own cut.
    const want = {
      rows: this.framedEdges(this.locusAxes.rows, this.heatmap.scaleY),
      cols: this.framedEdges(this.locusAxes.cols, this.heatmap.scaleX),
    }
    if (want.cols === null) return false

    const outgoing = this.data
    const outgoingBinsize = this.options.binsize
    this.data = data
    this.setResolution(binsize)
    const { dense, gauge, presentationMoved, turned } = this.derive(data, second)

    const axes = this.locusAxesOf(data, turned)
    const cols = spanOnAxis(axes.drawn.cols, want.cols, dense.ncols)
    const rows =
      turned === null
        ? spanOnAxis(axes.drawn.rows, want.rows, dense.nrows)
        : ([0, dense.nrows] as const)
    if (cols === null || rows === null) {
      // Put back what was moved. `derive` has already written `this.square`,
      // `this.drawn` and `this.second`, so the caller must re-run it — which
      // `setData` does, and which is exactly what the fallback is.
      this.data = outgoing
      this.setResolution(outgoingBinsize)
      return false
    }

    this.turned = turned
    this.syncLegendSlots()
    this.painted = null
    this.heatmap.setAnchor(anchorFor(turned))
    this.heatmap.setSpanGestures(turned !== null)
    this.heatmap.setDiagonalSlide(slidesAlongDiagonal(data, turned))
    this.heatmap.setFitAxis(turned === null ? 'both' : 'cols')
    this.box.refit()
    this.heatmap.regrid(
      dense,
      { rows: [rows[0], rows[1]], cols: [cols[0], cols[1]] },
      {
        separators: turned === null ? separatorsFor(data) : { rows: [], cols: [] },
        gauge: this.gaugeFor(data, gauge),
      },
    )
    this.heatmap.setLabelMinSpan(
      data.level === 'bin' ? LABEL_MIN_SPAN_BP / Math.max(1, this.options.binsize) : 0,
    )
    this.heatmap.setAxisCoords(this.axisCoordsOf(data, turned))
    this.heatmap.setAxisSpans(this.axisSpansOf(data, turned))
    this.heatmap.setTurn(
      turned === null
        ? null
        : {
            maxSeparation: turned.maxSeparation,
            direction: turned.direction,
            ...(turned.fold === undefined ? {} : { fold: turned.fold }),
          },
    )
    this.heatmap.setTurnLabels(this.bandLabels(turned))
    this.locusAxes = axes.drawn
    this.squareAxes = axes.square
    this.ownAxes = axes.own
    if (presentationMoved) {
      this.options.onScaleChange?.({
        transform: this.transform,
        colormap: this.colormap,
        vmin: this.manualVmin,
        vmax: this.manualVmax,
      })
    }
    this.lanes.setAxes(this.locusAxes)
    this.lanes.setMetaAxes(this.metaAxesOf(data, turned))
    this.laneEditor?.close()
    this.heatmap.setScale(this.scale())
    this.setBusy(false)
    this.schedule()
    return true
  }

  /**
   * What the colour range is measured from, across a change of grid.
   *
   * **The widest block wins, and it keeps winning while the reader zooms in.**
   * That is the whole of what stops a refine from re-brightening the map: coarse
   * cells are sums of bins, so a finer block over the same region holds
   * systematically smaller numbers and a different population of them, and a
   * range re-measured on it would move `vmax` under a reader who changed nothing
   * but the magnification. A loop that was bright at fit zoom has to be the same
   * brightness when the finer data lands, or the picture is arguing with itself.
   *
   * Widening is the one case that re-measures, and it should: a reader zooming
   * out is looking at data that was not in the picture before, and pinning the
   * range to a window they have left is the opposite error.
   *
   * `undefined` leaves whatever the view holds, which is what makes the ordinary
   * refine cost nothing — the memo on the gauge survives (`render/heatmap.ts`).
   */
  private gaugeFor(data: MatrixResult, own: DenseMatrix | undefined): DenseMatrix | null | undefined {
    const spanBp = Math.max(data.nrows, data.ncols) * Math.max(1, this.options.binsize)
    const held = this.gaugeBlock
    if (held === null || spanBp > held.spanBp) {
      // Wider than anything held, or the first block of a view: this is the
      // gauge from now on. `this.square` is what `derive` just produced, before
      // any rotation — the range belongs to the square whether or not the
      // picture is a band cut out of it.
      const dense = this.square ?? { ...toDense(data), values: data.values }
      this.gaugeBlock = { spanBp, dense }
      this.gaugeShown = own ?? null
      return this.gaugeShown
    }
    // Narrower: the range stays the wider block's. Handed over the first time
    // and then left alone, because passing a gauge invalidates the memo on it
    // (`render/heatmap.ts`) and re-measuring is the most expensive thing that
    // class does — which would put the whole cost of this feature back on every
    // step of a zoom, for a number that by construction did not move.
    if (this.gaugeShown === held.dense) return undefined
    this.gaugeShown = held.dense
    return held.dense
  }

  /**
   * The stretch of genome an axis is showing, as its two edges.
   *
   * Two loci rather than a span, because a whole-genome axis crosses sequences
   * and the far edge is not in the same one as the near edge. `null` for an axis
   * with no locus at all — a turned map's rows, an axis of whole contigs — which
   * is a fact about the picture rather than an error.
   */
  private framedEdges(
    axis: LocusAxis | null,
    scale: Scale,
  ): { from: { contig: string; bp: number }; to: { contig: string; bp: number } } | null {
    const windows = this.framedWindows(axis, scale)
    if (windows.length === 0) return null
    const first = windows[0]
    const last = windows[windows.length - 1]
    return {
      from: { contig: first.contig, bp: first.start },
      to: { contig: last.contig, bp: last.end },
    }
  }

  /**
   * The rulers a block wants, per axis.
   *
   * Split out of {@link setData} for {@link regrid}, which installs a block on a
   * different grid and has to write both of these against the incoming one. Two
   * copies of this would be two answers to "how many base pairs is a cell", and
   * the one that is wrong is invisible: a ruler is only ever read against the
   * picture it is drawn on.
   */
  private axisCoordsOf(data: MatrixResult, turned: RotatedBlock | null): AxisCoordSet {
    return {
      // Under a turn the column ruler is a genomic one at half the bin size,
      // and the row ruler is a *distance* rather than a position: a turned map's
      // vertical axis answers "how far apart", so labelling it with coordinates
      // would name places that are not there. See {@link separationCoords}.
      rows: turned === null
        ? axisCoordsFor(data.rowGroups, data.rowExtent, data.level, this.options.binsize)
        : separationCoords(turned, this.options.binsize),
      cols: axisCoordsFor(
        data.colGroups,
        data.colExtent,
        data.level,
        this.options.binsize,
        turned === null ? 1 : BIN_FRACTION,
      ),
    }
  }

  /**
   * The per-sequence rulers for the same two axes, where the axis has no single
   * one.
   *
   * A whole genome, a selection of chromosomes, a `contig × contig` block: the
   * axis is several sequences and {@link axisCoordsFor} refuses it, correctly,
   * because no one line describes it. But the reader looking at it is asking
   * the question they ask of a single chromosome — *where in this one am I* —
   * and until now the answer on those views was the contig names and nothing
   * else. One ruler per sequence answers it, each measured from that sequence's
   * own first base, with the boundaries the axis already draws saying where one
   * stops and the next begins.
   *
   * Empty wherever the single ruler already covers the axis, so the two never
   * both draw, and empty under a turn on both axes: the column axis there is one
   * sequence by {@link isTurnable}'s gate, and the row axis is a distance.
   */
  private axisSpansOf(data: MatrixResult, turned: RotatedBlock | null): AxisSpanSet {
    if (turned !== null) return { rows: [], cols: [] }
    return {
      rows: axisSpansFor(data.rowGroups, data.rowExtent, data.level, this.options.binsize),
      cols: axisSpansFor(data.colGroups, data.colExtent, data.level, this.options.binsize),
    }
  }

  /**
   * The annotations' view of the same two axes.
   *
   * Rebuilt per block rather than patched, so a stale mapping can never be drawn
   * over fresh data — the same rule `setAxisCoords` follows by being cleared in
   * `setMatrix`. Built for *every* block, and not only where there are
   * annotations to draw against it: the lanes were the first reader of §8.4's one
   * coordinate model and the line under the map is the second, and a file with no
   * tracks on it still knows what window it is showing.
   *
   * It is also what a {@link regrid} converts the reader's window through. A
   * window held in base pairs is the only form that survives a change of bin
   * size, and this is the object that turns base pairs back into cells.
   *
   * Two pairs come back, and they are the same object on a square map. The
   * *drawn* pair is the picture's, and under a turn it says out loud that there
   * is no row axis; the *square* pair is the block's, and it is what a pointer is
   * resolved through however the picture is arranged ({@link squareAxes}).
   */
  /**
   * The same two axes as **cells of the file's own tables** (§8.12).
   *
   * Everything a metadata lane needs about a block, and nothing about base
   * pairs: which runs the axis is made of, how many cells it has, which bin it
   * opens at and how many bins one cell holds. All four come off the result the
   * reader already sends, so this is a re-labelling of `MatrixResult` rather
   * than a second read of anything.
   *
   * A **turned** block gets `null` on rows, exactly as the loci do and for a
   * closely related reason: up the side of a turned map is distance from the
   * diagonal, which is not a unit of any table. The columns keep their cells,
   * so a metadata lane survives the turn along the bottom with every track.
   */
  private metaAxesOf(data: MatrixResult, turned: RotatedBlock | null): MetaAxes {
    const binsPerCell = data.binsPerCell ?? 1
    const cols: MetaBlock = {
      level: data.level,
      runs: data.colGroups,
      cells: data.ncols,
      blockStart: data.colExtent[0],
      binsPerCell,
      // A turned map is drawn on the half-bin lattice the rotation produced
      // (`render/rotate.ts`), so the cells of the *block* — which is what the
      // tables are indexed by — are two drawn columns each, counted from the
      // rotation's own origin rather than from the block's. Both facts live in
      // this pair of numbers so that nothing downstream has to know a turn can
      // happen: the same two lanes are drawn by the same two painters.
      ...(turned === null
        ? {}
        : {
            scale: {
              origin: (data.colExtent[0] - turned.originBin) / BIN_FRACTION,
              per: binsPerCell / BIN_FRACTION,
            },
          }),
    }
    if (turned !== null) return { rows: null, cols }
    return {
      rows: {
        level: data.level,
        runs: data.rowGroups,
        cells: data.nrows,
        blockStart: data.rowExtent[0],
        binsPerCell,
      },
      cols,
    }
  }

  private locusAxesOf(
    data: MatrixResult,
    turned: RotatedBlock | null,
  ): { drawn: OverlayAxes; square: OverlayAxes; own: OverlayAxes } {
    const context = this.options.annotations
    const shared = {
      level: data.level,
      binsize: this.options.binsize,
      contigLength: context?.contigLength ?? ((): number | undefined => undefined),
    }
    // Through the edit, where the map is drawn through one: the reader's runs
    // are edited sequences, and the lanes are drawn in the file's (§27.7).
    const edited = context?.edited?.() ?? null
    const ownSquare: OverlayAxes = {
      rows: locusAxisFrom({ ...shared, runs: data.rowGroups, blockStart: data.rowExtent[0] }),
      cols: locusAxisFrom({ ...shared, runs: data.colGroups, blockStart: data.colExtent[0] }),
    }
    const square: OverlayAxes =
      edited === null
        ? ownSquare
        : { rows: axisThroughEdit(ownSquare.rows, edited), cols: axisThroughEdit(ownSquare.cols, edited) }
    // A turned block has one genomic axis and one that is not: x is position,
    // measured in the half-bin columns the rotation produced, and y is distance
    // from the diagonal, which is not a place and has no locus. `null` on rows
    // is exactly right for the lanes — a stack drawn against a genomic axis has
    // nothing to draw itself against up the side, which is why a turn moves
    // every track to the bottom.
    if (turned === null) return { drawn: square, square, own: ownSquare }
    const ownCols = this.turnedLocus(turned, data)
    const turn = {
      maxSeparation: turned.maxSeparation,
      direction: turned.direction,
      binsize: this.options.binsize,
      nrows: turned.nrows,
      ...(turned.fold === undefined ? {} : { fold: turned.fold }),
    }
    return {
      own: { rows: null, cols: ownCols, turn },
      drawn: {
        rows: null,
        cols: axisThroughEdit(ownCols, edited),
        // What an overlay is placed by once there is no row axis to ask: a
        // mark names one locus or two, and the turn is a function of those
        // two (`render/overlays.ts`).
        turn,
      },
      square,
    }
  }

  /** Show or hide the "loading" veil; the canvas keeps its last picture. */
  /**
   * The bin size of the grid actually on screen, when the read decided it.
   *
   * A view builds its panel before it knows how coarse the block will come
   * back — a genome's contig count is not known until the range resolves — so
   * the resolution is set from the result rather than guessed at construction.
   * Every coordinate the panel computes is `binsize` times a cell offset, so
   * this must be called *before* {@link setData} or the first frame is drawn
   * against the previous grid.
   */
  setResolution(binsize: number): void {
    if (binsize > 0) this.options.binsize = binsize
  }

  /**
   * Rename the file an exported figure says it is a picture of.
   *
   * For the one thing that can change it without the panel being rebuilt: a
   * companion moving to another rung of its collection (§16.2) is still the same
   * panel drawing the same place, and the only part of its name that moved is
   * the `::1000` on the end. Written in place, as {@link setResolution} writes
   * the bin size beside it, and for the same reason — the caption is read at
   * draw time, so a stale one is only ever discovered in a figure somebody has
   * already sent.
   */
  setCaptionFile(file: string): void {
    if (this.options.caption === undefined) this.options.caption = { file }
    else this.options.caption = { ...this.options.caption, file }
  }

  /**
   * Rename the maps this panel is drawing.
   *
   * A rename changes every place a map is *named* and nothing about what is in
   * the picture, so it must not go through {@link setData} or {@link rederive}:
   * the first re-reads the block and the second re-derives it, and on a gated
   * whole-genome map (§7.3) rebuilding the view puts a full pixel scan back
   * behind its button — the reader types a name and their map disappears.
   *
   * Written in place, as {@link setResolution} and {@link setCaptionFile} write
   * the two facts beside it, and for the same reason: the readout, the derived
   * label and the colour key all read the name at the moment they are drawn, so
   * the only things that have to be *pushed* are the two that are painted once
   * — the heading and the names on a mirrored pair's two bands.
   *
   * `second` is absent on a map with one file behind it, which is every map but
   * one. The **heading** is not touched here, and that is not an oversight: on
   * this session's own panel it names the *region*, and only a deck companion's
   * heading is the file's name — {@link retitle} is that panel's own door.
   */
  setMapLabels(own: string, second?: string): void {
    if (own !== '') this.setCaptionFile(own)
    const compare = this.options.compare
    if (compare !== undefined && second !== undefined) {
      this.options.compare = { ...compare, labels: [own, second] }
    }
    this.heatmap.setTurnLabels(this.bandLabels(this.turned))
    // The key's title carries the comparison — `rep1 / rep2` under a ratio — and
    // is only rewritten when the colour scale moves. Forgetting what was painted
    // is what makes the next frame write it again.
    this.painted = null
  }


  /**
   * Rewrite the heading, for a panel whose heading is the map's name.
   *
   * A deck companion is the only one: everywhere else the heading names the
   * region, the genome, or the pair of them, and is a fact about the *view*
   * rather than about the file. Kept apart from {@link setMapLabels} for that
   * reason, and it moves `exportName` with it because a figure saved out of a
   * companion is named after the map it is of.
   */
  retitle(title: string): void {
    if (title === '') return
    this.lastTitle = title
    this.exportName = title
    this.titleNode.textContent = title
  }

  /**
   * Say, under the *Map* card's title, which map of a deck the card sets
   * (§16.5), or put the line away with `null`.
   *
   * Told by the deck, which owns the star: `starred` names this map, the
   * starred one, and `every` says nothing is starred and the card is setting
   * every map at once — the one state in which a change here reaches beyond
   * the picture the card was built for.
   */
  setCardFor(target: { kind: 'starred'; name: string } | { kind: 'every'; maps: number } | null): void {
    this.cardFor.classList.toggle('hidden', target === null)
    if (target === null) {
      this.cardFor.replaceChildren()
      return
    }
    const starred = target.kind === 'starred'
    this.cardFor.classList.toggle('is-every', !starred)
    this.cardFor.replaceChildren(
      icon('star', { size: 12, class: starred ? 'map-card-star is-on' : 'map-card-star' }),
      el('span', { text: starred ? target.name : `every map — all ${target.maps}` }),
    )
    this.cardFor.title = starred
      ? `This card sets ${target.name}, the starred map. Star another map to set that one instead.`
      : 'No map is starred, so a change here is made to every map of the deck. Star one to set it alone.'
  }

  /**
   * Turn the block that was read into the block that is drawn.
   *
   * Split out of {@link setData} because it has two callers with opposite needs:
   * a new block refits the view, and a *recomputed* one must not — see
   * {@link rederive}. Everything about the picture except its geometry is
   * decided here.
   */
  private derive(
    data: MatrixResult,
    second: MatrixResult | undefined,
    /**
     * How deep to cut the band, when the caller needs the shape it already has.
     *
     * The band on screen need not be as shallow as the box wants — it is re-cut
     * only when it is too *shallow* (see {@link syncTurnDepth}), so zooming in
     * leaves a deeper one standing. A **derivation** is different numbers in the
     * same grid and is swapped in as one, so a caller on that path has to ask
     * for the grid that is there rather than for the one the box would cut now.
     * Absent, the depth is the box's, which is right for a block being read.
     */
    depth?: number,
  ): {
    dense: DenseMatrix
    /**
     * The square block the band was cut out of, or `undefined` where the picture
     * *is* the whole read.
     *
     * What the colour range is measured from (`render/heatmap.ts`'s
     * {@link HeatmapView.autoRange}). A band holds the near-diagonal separations
     * and drops the rest, so a range measured on it is a range measured on a
     * crop — and on a diverging field the dropped separations are exactly where
     * the extremes live, which halved the scale the moment the map was turned.
     */
    gauge?: DenseMatrix
    presentationMoved: boolean
    turned: RotatedBlock | null
  } {
    // Each file's values first, with any job they wait on started on the way
    // (`ui/MapDerivation.ts`). What follows puts them together and turns them.
    const { mine, theirs, aligned } = this.derivation.derive(data, second)
    this.derived = mine

    const op = this.options.compare?.op ?? 'split'
    this.second = aligned === undefined ? null : { data: aligned }

    // Two aligned blocks with two axes each — under the split the merged values
    // are the first file's above the diagonal and the second's below, and
    // everything else about the block (its extents, its runs, its level) is
    // unchanged, because the two files agree on all of it. That agreement is
    // what the compare gate checks before either read is made. Under a ratio or
    // a difference there are no longer two files in the square at all, but one
    // derived field over the whole of it.
    const merged =
      theirs === undefined
        ? undefined
        : combine(
            { ...data, values: mine.values },
            { ...aligned!, values: theirs.values },
            { op },
          )
    this.neutral = merged === undefined || op === 'split' ? mine.neutral : merged.neutral
    const presentationMoved = this.syncDivergingScale()
    const dense: DenseMatrix =
      merged === undefined
        ? { ...toDense(data), values: mine.values }
        : { ...toDense(data), values: merged.values }
    // Turned last, over whatever the arithmetic produced: the rotation is a
    // change of *geometry* and everything above it is a change of value, so a
    // turned O/E map and a turned ratio cost this one extra pass and no special
    // case anywhere. Reported rather than assumed — whether a block has a
    // diagonal to measure from is a fact about the block.
    const canTurn = isTurnable(data)
    this.options.turn?.onAvailable?.(canTurn)
    // Greyed rather than hidden: a reader looking at a whole metagenome should
    // be able to see that the control exists and find out what it wants of them.
    this.turnButton?.classList.toggle('is-disabled', !canTurn)
    if (this.turnButton instanceof HTMLButtonElement) this.turnButton.disabled = !canTurn
    let out = dense
    // **Two files under a split get two bands.** The square is the first file
    // above the matrix diagonal and the second below it, and turning it keeps
    // only the upper triangle — so the second file, which is the whole reason
    // the picture is split, disappeared the moment the reader turned it.
    // Mirrored, the pair meets at one shared genomic axis and is read against
    // itself at every position (`render/rotate.ts`'s `mirror`).
    //
    // The split alone, and that is not an omission: a ratio or a difference is
    // one derived field over the whole square, so its two triangles are the
    // same numbers twice and the mirror would draw the picture under its own
    // reflection.
    const mirror = merged !== undefined && op === 'split'
    const turned =
      canTurn && this.options.turn?.on === true
        ? rotateBlock(
            { ...data, values: dense.values },
            {
              maxSeparation: depth ?? this.turnDepth(data, mirror),
              ...(this.options.turn.direction === undefined
                ? {}
                : { direction: this.options.turn.direction }),
              ...(mirror ? { mirror: true } : {}),
            },
          )
        : null
    if (turned !== null) out = turnedDense(turned)
    // The recentre control asks a weaker question than the turn: not "are the
    // two axes the same stretch" but "do they meet at all", since a view can be
    // put back on a diagonal that only crosses a corner of the block. Off under
    // a turn, where the picture already is the diagonal.
    this.paintDiagonal(
      turned === null &&
        Math.max(data.rowExtent[0], data.colExtent[0]) <
          Math.min(data.rowExtent[1], data.colExtent[1]),
    )
    this.paintReframeHint(turned !== null)
    // The **square** block's values, even under a turn, because the one reader
    // of this indexes it by square row and column ({@link derivedReading}). It
    // used to be `out`, which on a turned map is a band of a different shape
    // read with the square's stride: the ratio in the tooltip was a real number
    // from a real cell, and not the cell under the pointer.
    this.drawn = dense.values
    // …and kept, so a re-cut of the band costs one rotation rather than the
    // whole derivation again. See {@link syncTurnDepth}.
    this.square = dense
    // The strip is the only place the numbers beside it are named, and a ratio
    // drawn under a caption reading `count` is worse than one with no caption.
    // `count` where nothing was derived, rather than `deriveBlock`'s own word
    // for the identity: the strip has said `count` since before any of this
    // existed and the commonest picture in the app should not have its legend
    // reworded by a feature it is not using.
    const barLabel = this.derivedLabel() ?? this.derived?.label ?? 'counts'
    // Blank where the word would only be said twice. {@link keyFor} puts the
    // picker's own label in front of this, so an entry whose derivation *is*
    // what the picker calls it — `expected`, which names the baseline in both
    // places — would come out as `Expected expected`. `counts` is the same case
    // arrived at from the other side: the strip has said `count` since before
    // any of this existed. A comparison keeps its label, because there the
    // picker's word is suppressed instead and this is all the key has.
    const picked = this.options.scores?.choices.find(
      (entry) => entry.id === this.options.scores?.current,
    )?.label
    this.units = barLabel === 'counts' || barLabel === picked ? '' : barLabel
    return { dense: out, ...(turned === null ? {} : { gauge: dense }), presentationMoved, turned }
  }

  /**
   * What to write in each band of a mirrored pair, or `null` for one band.
   *
   * The two files' own names, which are what the compare card and the readout
   * already call them — so the picture names them the same way rather than
   * inventing a second vocabulary for the same two things.
   */
  private bandLabels(turned: RotatedBlock | null): [string, string] | null {
    if (turned === null || turned.fold === undefined) return null
    const labels = this.options.compare?.labels
    return labels === undefined ? null : [labels[0], labels[1]]
  }

  /**
   * The cell of the *square* block a pointer is over.
   *
   * The identity on a square map, and the rotation's inverse on a turned one.
   * Returned rather than branched on at every use, so the readout below has one
   * coordinate system rather than two — which is the same reason §8.4 gives for
   * the heatmap and the lanes sharing one.
   */
  private squareCell(cell: Cell): Cell {
    const turned = this.turned
    if (turned === null || this.data === null) return cell
    const found = cellAt(turned, cell.row, cell.col)
    if (found === null) return cell
    return { ...cell, row: found.row, col: found.col }
  }

  /**
   * The genomic axis under a turned block, or `null` where it cannot be built.
   *
   * One segment, because {@link isTurnable} refused anything wider than one
   * sequence. The length comes from the annotation context where there is one
   * and from the block otherwise, which is the same fallback `locusAxisFrom`
   * makes for a run whose contig it cannot measure.
   */
  private turnedLocus(turned: RotatedBlock, data: MatrixResult): LocusAxis | null {
    const run = data.rowGroups[0]
    const label = run?.label ?? ''
    const firstBin = run?.unitStart ?? data.rowExtent[0]
    const known = this.options.annotations?.contigLength(label)
    const length = known ?? (data.nrows + (data.rowExtent[0] - firstBin)) * this.options.binsize
    // The runs go through where there is more than one, which is a block read
    // round a circle and nothing else (§8.15): the axis is then the sequence
    // twice, and each stretch has to say which lap it is on.
    return turnedAxis(
      turned,
      { label, firstBin, length },
      this.options.binsize,
      data.rowGroups.length > 1 ? data.rowGroups : [],
    )
  }

  /**
   * How far from the diagonal the turned band reaches, in **bins**.
   *
   * A function of the box and the zoom rather than a number the reader sets, and
   * that is the whole of §17.2's "the box keeps its shape and the distance
   * follows the zoom": the picture is cut to fill the rectangle it is drawn in,
   * so the deepest contact on screen is however many bins of separation fit in
   * that many pixels at this many pixels per cell. Zoom in and the band shows
   * less distance; the rectangle does not move.
   *
   * The rule for turning rows into a separation is `render/rotate.ts`'s, because
   * it is about the geometry rather than about this panel, and so is the clamp:
   * a band cannot be deeper than the block has cells to fill.
   */
  private turnDepth(data: MatrixResult, mirror = false): number {
    // A deck's distance, where a deck has set one. Every panel of a deck cuts
    // the *same* band or the pictures are not comparable, and the box is the one
    // input that cannot deliver that: the cells of a grid are laid out over
    // several frames, so two panels asking their own boxes at their own moments
    // get two answers, and neither is wrong. See {@link setTurnReach}.
    //
    // Per **band**, not per picture, which is why the deck's number needs no
    // halving: what it promises is that every panel reaches the same distance
    // from the diagonal, and a mirrored panel reaches it on both sides.
    const asked = this.deckReach
    if (asked !== null) return turnDepthFor(data, rowsForReach(asked, this.options.binsize) - 1)
    // The box is one box whether it holds one band or two, so a mirrored pair
    // gets half of it each. Without this the two bands are cut for the whole
    // height, drawn to twice it, and the picture leaves its own rectangle —
    // taking the tracks under it with it.
    const rows = this.plotRows()
    return turnDepthFor(data, separationForRows(mirror ? Math.floor(rows / 2) : rows) - 1)
  }

  /**
   * How far this band reaches from the diagonal, in base pairs, or `null` for a
   * map that is not turned.
   *
   * Base pairs, and the same expression the deck's lock compares
   * (`panels/PanelDeck.ts`'s `lockNote`), so a deck that hands this number to
   * every panel makes that comparison pass by construction rather than by
   * hoping two boxes were measured on the same frame. A row of a turned map is
   * half a bin of *height* and a whole bin of *separation* — hence the two —
   * which is `render/rotate.ts`'s lattice seen from here.
   */
  turnReach(): number | null {
    const turned = this.turned
    if (turned === null) return null
    // The **band**, not the picture: a mirrored pair is two bands of this depth
    // meeting at a shared axis, and the distance a deck locks on is how far
    // either of them reaches from the diagonal.
    return reachForRows(turned.maxSeparation + 1, this.options.binsize)
  }

  /**
   * Cut this band to reach `bp` from the diagonal, whatever the box wants.
   *
   * The deck making one distance out of N pictures, and the reason it has to be
   * *told* rather than derived: {@link turnDepth} asks the panel's own box how
   * many rows fit, and a deck lays its cells out over several frames — a
   * companion that measured while the grid was still settling cut a band to a
   * height its cell had for one frame, and {@link syncTurnDepth} only ever
   * grows a band, so nothing brought the two back together. What the reader saw
   * was two bands of visibly different depths, the deck's own lock refusing to
   * move them together, and a refusal blaming the files' resolutions for what
   * was a layout race — cured, mysteriously, by turning the deck off and on,
   * which re-cuts both bands from boxes that have by then settled.
   *
   * `null` gives the panel its box back, which is what a map that has left a
   * deck should have.
   */
  setTurnReach(bp: number | null): void {
    const asked = bp === null || !Number.isFinite(bp) || bp <= 0 ? null : bp
    if (asked === this.deckReach) return
    this.deckReach = asked
    const data = this.data
    if (this.turned === null || this.square === null || data === null) return
    this.recutBand(
      asked === null
        ? this.turnDepth(data, this.turned.fold !== undefined)
        : turnDepthFor(data, rowsForReach(asked, this.options.binsize) - 1),
    )
  }


  /**
   * How many cells tall the plot is, at the zoom in force.
   *
   * Computed from the **box** rather than measured off the canvas, and that is
   * not a shortcut: the box is a CSS size this panel has just written, and the
   * canvas does not have it until the browser has laid out and the resize
   * observer has fired. Measured, the first frame of every turn would be cut for
   * the square map's height and corrected on the frame after — a band that
   * flashes deep and then settles.
   */
  private plotRows(): number {
    const zoom = this.heatmap.zoomLevel
    const margin = this.heatmap.margin
    const height = Math.max(1, this.box.turnBox().height - margin.top - margin.bottom)
    return zoom > 0 ? Math.ceil(height / zoom) : 1
  }

  /**
   * Re-cut the band when the zoom has changed how much of it fits the box.
   *
   * Run once per frame, before the draw, because the two things it depends on —
   * the zoom and the plot's height — are both settled by then and neither
   * announces itself. Cheap when nothing moved, which is every frame of a pan:
   * the wanted depth is an integer function of the zoom, so it is equal to the
   * band's own on any frame the zoom did not change.
   *
   * A *reshape* rather than a re-read or a re-derive: the picture is of the same
   * place at the same zoom over the same stretch of genome, and only the number
   * of rows behind it has changed.
   */
  private syncTurnDepth(): void {
    const turned = this.turned
    const square = this.square
    const data = this.data
    if (turned === null || square === null || data === null) return
    const wanted = this.turnDepth(data, turned.fold !== undefined)
    // Only when the band is too **shallow** for the box. A band deeper than the
    // box needs is not a different picture: it stands on the box's floor either
    // way, and the rows past the top edge are clipped by the same rule that
    // clips the columns past either end. So zooming *in* — which asks for less
    // distance, over and over, at whatever rate the wheel reports — costs
    // nothing at all, where it used to re-cut and re-pool the whole band on
    // every notch.
    if (wanted <= turned.maxSeparation) return
    // And when it is too shallow, cut deeper than asked. A re-cut is a rotation
    // and a fresh pooling; zooming out is a *gesture* rather than a step, so
    // buying twice the distance the box wants right now is one of those instead
    // of the several the rest of the gesture would have asked for. Bounded by
    // the block, which is `turnDepthFor`'s clamp and the reason this cannot run
    // away: past the whole triangle there is nothing left to cut.
    //
    // Not over-cut under a deck's distance: there the depth is a number every
    // panel was given rather than an appetite this one has, and reaching twice
    // as far as it says is exactly the disagreement {@link setTurnReach} exists
    // to end.
    //
    // Nor on a **mirrored pair**, where the spare rows are not spare. One band
    // stands on the box's floor and the rows past the top edge are clipped by
    // the same rule that clips the columns; two bands stand on the fold between
    // them, so buying twice the depth pushes that fold — and the whole of the
    // first file with it — off the top of the picture.
    const cheap = this.deckReach === null && turned.fold === undefined
    this.recutBand(cheap ? turnDepthFor(data, wanted * 2) : wanted)
  }

  /**
   * Re-cut the band to `cut` bins of separation, and move everything measured
   * from it.
   *
   * A *reshape* rather than a re-read or a re-derive: the picture is of the same
   * place at the same zoom over the same stretch of genome, and only the number
   * of rows behind it has changed. Shared by the per-frame sync above and by the
   * deck's {@link setTurnReach}, which is what keeps a band cut one way from
   * being re-labelled the other.
   */
  private recutBand(cut: number): void {
    const turned = this.turned
    const square = this.square
    const data = this.data
    if (turned === null || square === null || data === null) return
    const next = rotateBlock(
      { ...data, values: square.values },
      {
        maxSeparation: cut,
        ...(turned.direction === 'up' ? {} : { direction: turned.direction }),
        // A re-cut is the same picture at another depth, so a mirrored pair
        // stays a mirrored pair: dropping the second band here would put the
        // second file away on the first zoom after it was drawn.
        ...(turned.fold === undefined ? {} : { mirror: true }),
      },
    )
    // Nothing to gain from a band the block could not fill: `rotateBlock` clamps
    // to what it has cells for, so asking for more than the last cut when the
    // last cut was already the whole triangle produces the same array again.
    if (next.maxSeparation === turned.maxSeparation) return
    this.turned = next
    this.heatmap.reshape(turnedDense(next))
    // The depth is half of where the guides go, so it moves with the band.
    this.heatmap.setTurn({
      maxSeparation: next.maxSeparation,
      direction: next.direction,
      ...(next.fold === undefined ? {} : { fold: next.fold }),
    })
    // The ruler up the side is `maxSeparation`'s, so it has to be rewritten with
    // the band — a band re-cut under a ruler measured for the previous depth is
    // a picture labelled with somebody else's distances.
    this.heatmap.setAxisCoords({
      rows: separationCoords(next, this.options.binsize),
      cols: axisCoordsFor(
        data.colGroups,
        data.colExtent,
        data.level,
        this.options.binsize,
        BIN_FRACTION,
      ),
    })
    // The marks are placed by the pair of loci they name, and how far up the
    // band that puts one is a function of the depth (`render/overlays.ts`), so
    // this has to move with the ruler beside it.
    const turn = this.locusAxes.turn
    if (turn !== undefined && turn !== null) {
      turn.maxSeparation = next.maxSeparation
      // And where the band ends, which is how far a line's V reaches.
      turn.nrows = next.nrows
      if (next.fold === undefined) delete turn.fold
      else turn.fold = next.fold
    }
    this.lanes.setAxes(this.locusAxes)
  }

  /**
   * How many legends there are, and how much room they need.
   *
   * A function of {@link second} and {@link neutral}, so it has to run wherever
   * either moves — which is {@link setData} *and* {@link rederive}. Left in
   * `setData` alone, ticking O/E on a compared map kept a second strip on screen
   * labelled in the second file's counts, beside a square that had become one
   * derived field: the exact misreading the rule below exists to prevent, put
   * back by the path that recomputes without re-reading.
   */
  /**
   * Whether the second file's key is on screen.
   *
   * Only under the **split**, where the square really does hold two files'
   * counts, on one scale — which is what the second key, with the first's
   * numbers, says; a second file of another depth is brought to the first's by
   * drawing both to one total (§6.5), not by rescaling its colours. Under a
   * ratio or a difference there is one derived field over the whole square —
   * `neutral` is what says so — and a second key would be a second scale for
   * numbers that no longer exist.
   */
  private syncLegendSlots(): void {
    this.key2.el.classList.toggle('hidden', this.second === null || this.neutral !== null)
  }

  /**
   * What the key says about a scale.
   *
   * The title is **composed**, because a cell has been through up to three
   * things and a reader needs all of them: what was read — the score picker's
   * own word, `count` or `balanced` or `ICE` or a column name — what was then
   * done to it (`O/E`, a ratio against a second file), and how it is drawn. A
   * legend reading `O/E (log2)` over a map whose O/E was measured on balanced
   * counts describes a different picture from the same words over raw ones.
   *
   * The **bounds are the reader's own**, in transformed units, formatted by the
   * same trimmer the clip boxes use — so the two can never print one bound two
   * ways, and a reader who typed `[-1, 1]` reads `-1` and `1` rather than the
   * `0.5` and `2` an inverse transform would have shown them.
   */
  /**
   * The glyph the second file's key is marked with — where it is on the picture.
   *
   * `◣` is the lower-left triangle of a split square, and it stops being true
   * the moment the map is turned into a mirrored pair: the second file is then
   * the band *below the shared axis*, which is what `▼` says. The mark is the
   * one part of the key that is about geometry rather than about numbers, so it
   * has to follow the geometry.
   */
  private secondMark(): string {
    return this.turned?.fold === undefined ? '◣' : '▼'
  }

  /**
   * What the cells hold, in one word: the score picker's, else `balanced` or
   * `count`. The key's title and the readout under the pointer say the same
   * word, because a tooltip reading `count 0.003` under a key reading
   * `Balanced` was two names for one number.
   */
  private scoreWord(): string {
    const scores = this.options.scores
    const choice = scores?.choices.find((entry) => entry.id === scores.current)
    const named = choice?.label ?? this.scoreLabel ?? ''
    if (named !== '') return named
    return this.options.balance === true ? 'balanced' : 'count'
  }

  private keyFor(scale: ColorScale, prefix = ''): KeyContent {
    // The picker's word where there is a picker; otherwise the one fact about
    // the read that is always known. A derived field that has taken over the
    // square — a ratio, a difference — names itself and nothing else, because
    // there is no longer one file's score in the cells to name.
    const base = this.comparisonLabel() !== null ? '' : this.scoreWord()
    const title = keyTitle([base, this.units], scale.transform, prefix)
    return { ...keyContent(scale, title, (value) => trimNumber(value, 3)), ...this.keyNote() }
  }

  /**
   * The cell size, for the corner of the map.
   *
   * It is on the line above the map already, and it is here as well because the
   * two answer at different moments. The line is read once, when the view opens.
   * The key is read *while looking* — and now that a zoom changes the grid under
   * the reader, the number it changes to is the one thing about the picture that
   * cannot be seen by looking at it: two maps of the same locus at 3 kb and at
   * 200 bp are different figures, and nothing in the pixels says which is which.
   *
   * It goes into the exported key too, which is where it matters most: a figure
   * that carries its own resolution needs no caption to say it, and a methods
   * section quoting a number nobody can check against the panel is how the wrong
   * one gets published.
   *
   * Empty where there is nothing to say — a contig-level block whose cells are
   * one sequence each — because a key line that is sometimes blank is better
   * than one that pads itself with `1 sequence per cell`.
   */
  private keyNote(): { note?: string } {
    const data = this.data
    if (data === null) return {}
    const note = resolutionNote(this.baseBinsize, data)
    return note === '' ? {} : { note: note.replace(/^effective resolution: /, '') }
  }

  /**
   * Draw the keys into an export, where the screen draws DOM.
   *
   * Over the picture and inset from its frame, which is where they are on
   * screen — so an exported figure is the same picture at another resolution
   * rather than a rearrangement of it. Skipped where the key is hidden, so a
   * phone exports what a phone shows.
   */
  private renderKeys(
    ctx: CanvasRenderingContext2D,
    scale: number,
    origin: { x: number; y: number },
  ): void {
    if (this.narrow || !this.legendOn) return
    const painted = this.painted
    if (painted === null) return
    const palette = readCanvasPalette(this.canvas)
    const plot = this.heatmap.plotRect
    ctx.setTransform(scale, 0, 0, scale, 0, 0)
    const style = {
      font: 'system-ui, sans-serif',
      textColor: readPageText(this.canvas),
      background: FIGURE_BACKGROUND,
      borderColor: palette.labelColor,
    }
    const right = origin.x + plot.x + plot.width - KEY_INSET
    const box = drawKey(ctx, right, origin.y + plot.y + KEY_INSET, this.keyFor(painted), style)
    if (this.second !== null && this.neutral === null) {
      drawKey(
        ctx,
        right,
        box.y + box.height + 4,
        this.keyFor(painted, this.secondMark()),
        style,
      )
    }
    ctx.setTransform(1, 0, 0, 1, 0, 0)
  }

  /**
   * The colour scale this panel would be drawn on if nothing were derived.
   *
   * What a *new* panel should be seeded with, and not the same thing as the
   * scale on screen: a derivation borrows the transform, the colormap and the
   * clip while it is on ({@link syncDivergingScale}), so the live values may be
   * `log2` and a diverging ramp chosen for a ratio. Handing those to a panel
   * that is going to draw plain counts puts every empty cell — most of a sparse
   * Hi-C block — at `-Infinity` on a ramp whose middle then means nothing.
   *
   * The borrowed presentation is held for exactly this reason, so this is the
   * same answer the panel itself would give back when the derivation is
   * switched off.
   */
  baseScale(): { transform: Transform; colormap: string; vmin?: number; vmax?: number } {
    const base = this.divergingRestore ?? {
      transform: this.transform,
      colormap: this.colormap,
      vmin: this.manualVmin,
      vmax: this.manualVmax,
    }
    return {
      transform: base.transform,
      colormap: base.colormap,
      ...(base.vmin === undefined ? {} : { vmin: base.vmin }),
      ...(base.vmax === undefined ? {} : { vmax: base.vmax }),
    }
  }

  /**
   * The scale a derivation on this panel has taken over, or `null` where none
   * has: what a rebuild of the same map carries to its replacement
   * (`initial.restore`), so the give-back outlives this panel.
   */
  borrowedFrom(): BorrowedScale | null {
    const back = this.divergingRestore
    if (this.divergingApplied === null || back === null) return null
    return {
      transform: back.transform,
      colormap: back.colormap,
      ...(back.vmin === undefined ? {} : { vmin: back.vmin }),
      ...(back.vmax === undefined ? {} : { vmax: back.vmax }),
    }
  }

  /**
   * Record which derivation this panel is drawing, without recomputing.
   *
   * Separate from {@link rederive} because a panel that is *about* to be handed
   * a fresh block needs the setting in place before {@link setData} reads it,
   * and recomputing the outgoing block first would be a pass over cells that are
   * being replaced.
   *
   * @returns `true` when the setting was already what was asked for.
   */
  setDerive(derive: DerivePresentation | undefined): boolean {
    const held = this.options.derive
    const same =
      held?.normalise === derive?.normalise &&
      (held?.expected === true) === (derive?.expected === true) &&
      (held?.smooth ?? 0) === (derive?.smooth ?? 0) &&
      (held?.correlate === true) === (derive?.correlate === true) &&
      (held?.baseline === true) === (derive?.baseline === true) &&
      (held?.alongArms === true) === (derive?.alongArms === true) &&
      armsKey(armsInForce(held)) === armsKey(armsInForce(derive))
    this.options.derive = derive
    this.paintArms(derive?.arms)
    // The toggle holds no state of its own — the setting is the session's, and
    // it can move from the command palette or from a link as easily as from a
    // click — so it is repainted from whatever arrives, exactly as the turn's is.
    // The O/E light follows the correlation, which forces it on: a lit map with
    // an unlit toggle is the picture disagreeing with the control that made it.
    this.paintExpected(
      derive?.baseline !== true && (derive?.expected === true || derive?.correlate === true),
    )
    this.gateExpected(derive?.baseline === true)
    this.paintSmooth(derive?.smooth ?? '0')
    return same
  }

  /**
   * Record which way this panel is turned, without redrawing.
   *
   * {@link setDerive}'s counterpart and its twin in every respect: a panel about
   * to be handed a fresh block needs the setting in place before
   * {@link setData} reads it, and turning the outgoing block first would rotate
   * cells that are being replaced.
   *
   * `undefined` is **nothing said**, not "square". The turn is a shared fact
   * about the deck and a panel is handed it by a thunk that can only fail to
   * produce one before the session has any state at all; reading that as a
   * request to unturn would flatten a companion for one frame on every mount.
   *
   * @returns `true` when the setting was already what was asked for.
   */
  setTurn(turn: TurnPresentation | undefined): boolean {
    if (turn === undefined) return true
    const same = (this.options.turn?.on === true) === (turn.on === true)
    this.options.turn = turn
    // The one piece of the control that is not rebuilt with the picture. It is
    // made once, in the constructor, so without this the button never lights up
    // — the map turns and the thing that turned it looks untouched.
    this.paintTurn(turn.on === true)
    return same
  }

  /**
   * Recompute the picture from the block already in hand.
   *
   * What a change of derivation is: the same cells, in different units. Reading
   * them again would cost a worker round trip at best and, on a gated
   * whole-genome view (§7.3), would put a 26-million-pixel scan back behind its
   * button — so the panel is handed the new presentation and re-runs the
   * arithmetic over the block it is holding.
   *
   * The presentation is *replaced*, not merged, because a stale `derive` object
   * is exactly the bug this exists to avoid: the session builds a fresh one per
   * render and the panel's captured reference does not follow it. Written into
   * `options` in place, as {@link setResolution} writes the bin size — the
   * reference is fixed, the settings on it are not.
   */
  rederive(
    derive: DerivePresentation | undefined,
    compare?: ComparePresentation,
    turn?: TurnPresentation,
  ): void {
    const turnMoved = !this.setTurn(turn)
    const unchanged = this.setDerive(derive) && !turnMoved
    if (compare !== undefined) this.options.compare = compare
    const data = this.data
    // Nothing to recompute, but the setting is recorded either way: the session
    // builds a fresh presentation object on every render and hands it over
    // whether or not a reader touched anything, and recomputing a 16 M-cell
    // block for an equal object would make every unrelated repaint expensive.
    if (data === null || (unchanged && compare === undefined)) return
    // A change of **operation** is a change of grid as surely as a change of
    // turn is: a turned split is two bands and a turned ratio is one, so the
    // values a swap would install are read with a stride they were not computed
    // for. Asked of the block on screen against what the settings now want,
    // rather than of the setting alone, because the same op means one band on a
    // map with a single file behind it.
    const bandsMoved =
      this.turned !== null &&
      (this.turned.fold !== undefined) !==
        (this.second !== null && (this.options.compare?.op ?? 'split') === 'split')
    if (turnMoved || bandsMoved) {
      // A turn is a different *grid*, not different numbers in the same one, so
      // the cheap in-place swap cannot serve it: the block changes shape, its
      // axes change meaning, and the view has to be refitted around them.
      // Re-run from the top, which is one pass over a block already in memory
      // and still costs no read.
      this.setData(data, this.lastTitle, this.second?.data)
      return
    }
    this.redraw()
  }

  /**
   * Re-run the derivation over the block in hand and swap the values in.
   *
   * {@link rederive}'s tail, split out because it has a second caller that
   * cannot go through the front door: a correlation lands *after* the render
   * that asked for it, with every setting exactly as it was, and `rederive`'s
   * own equality gate would correctly conclude that nothing had changed and
   * return. What changed is not a setting — it is that the answer arrived.
   */
  private redraw(): void {
    const data = this.data
    if (data === null) return
    // At the depth the band already has, not the one the box would cut now: this
    // is the in-place swap, and an array of another length read with the grid's
    // stride is rows of the wrong separation with unwritten memory under them.
    const { dense, gauge, presentationMoved } = this.derive(
      data,
      this.second?.data,
      this.turned?.maxSeparation,
    )
    this.syncLegendSlots()
    this.heatmap.setValues(dense.values, gauge?.values)
    // The colourbar is a function of the scale *and* of what the numbers are, and
    // neither the transform nor the clip need have moved for a ratio to want a
    // different bar from a count.
    this.painted = null
    if (presentationMoved) {
      this.options.onScaleChange?.({
        transform: this.transform,
        colormap: this.colormap,
        vmin: this.manualVmin,
        vmax: this.manualVmax,
      })
    }
    this.schedule()
  }

  setBusy(busy: boolean, message = 'loading…'): void {
    // A correlation outlives the read that started it — see
    // {@link MapDerivation.correlationWait} — so a clear arriving from
    // `setData` puts the longer wait back rather than taking the veil away.
    const correlationNote = this.derivation.correlationWait
    if (!busy && correlationNote !== null) {
      this.overlay.textContent = correlationNote
      this.overlay.classList.remove('hidden')
      return
    }
    this.overlay.textContent = message
    this.overlay.classList.toggle('hidden', !busy)
  }

  /**
   * The colour scale as configured. An unclipped bound is `NaN`, which is how
   * {@link HeatmapView} is asked for the `metacooler show` default.
   */
  scale(): ColorScale {
    return {
      vmin: this.manualVmin ?? Number.NaN,
      vmax: this.manualVmax ?? Number.NaN,
      transform: this.transform,
      colormap: this.colormap,
      balanced: this.options.balance === true,
      ...(this.neutral === null ? {} : { neutral: this.neutral }),
    }
  }

  /**
   * Hand the presentation over to a derived field, or hand it back.
   *
   * Driven by the *transform* the derivation wants rather than by a flag, which
   * is what makes the ratio-to-difference move work: both are derived, so a
   * boolean would see no transition and leave a difference — which is signed and
   * centred on zero — being drawn on `log2`.
   */
  private syncDivergingScale(): boolean {
    const wanted = preferredTransform(this.neutral)
    const fresh = this.freshSeed
    this.freshSeed = false
    if (wanted === this.divergingApplied) return false
    if (wanted === null) {
      const back = this.divergingRestore
      this.divergingRestore = null
      this.divergingApplied = null
      if (back === null) return false
      this.transform = back.transform
      this.colormap = back.colormap
      this.manualVmin = back.vmin
      this.manualVmax = back.vmax
      this.syncScaleControls()
      return true
    }
    // A seed that already is the borrowed scale — a link, a reload or Back
    // landing on a ratio carries what the derivation drew with, and not what it
    // took over — has nothing of its own to give back but the map's defaults.
    const defaults = this.options.initial?.defaults
    this.divergingRestore ??=
      fresh && defaults !== undefined && this.transform === wanted && isDivergingColormap(this.colormap)
        ? { transform: defaults.transform, colormap: defaults.colormap, vmin: undefined, vmax: undefined }
        : { transform: this.transform, colormap: this.colormap, vmin: this.manualVmin, vmax: this.manualVmax }
    this.transform = wanted
    // Only where the reader has not already chosen a diverging ramp: somebody
    // who picked one deliberately keeps it across a change of operation.
    if (!isDivergingColormap(this.colormap)) this.colormap = DEFAULT_DIVERGING_COLORMAP
    // The clip goes, and does not come back until the derivation does: it was
    // measured in counts, and there is no reading of it in ratios.
    this.manualVmin = undefined
    this.manualVmax = undefined
    this.divergingApplied = wanted
    this.syncScaleControls()
    return true
  }

  /**
   * What the derived field says at one cell, or `null` where nothing is derived.
   *
   * Read out of the block the heatmap draws *from* rather than recomputed, so
   * the number under the pointer is by construction the number under the
   * colour. In square-block coordinates, which is what every caller has after
   * {@link squareCell} and what a turned band cannot be indexed by. A ratio is
   * written as a multiple (`1.8×`) rather than as its logarithm: the log is how
   * it is *drawn*, because that is what centres the scale, and it is not how
   * anybody says it.
   */
  private derivedReading(row: number, col: number): string | null {
    const label = this.derivedLabel()
    if (label === null) return null
    const values = this.drawn
    if (values === null || this.data === null) return null
    const drawn = values[row * this.data.ncols + col]
    if (drawn === undefined || Number.isNaN(drawn)) return `${label} —`
    if (this.neutral === 1) {
      // `Infinity` is a real answer here — present in one file and absent in the
      // other — and printing it as a multiple would read as a bug rather than as
      // the finding it is.
      if (!Number.isFinite(drawn)) return `${label} ∞`
      return `${label} ${fmt.num(drawn)}×`
    }
    return `${label} ${fmt.num(drawn)}`
  }

  /**
   * What the derived field is called, or `null` when the cells are as read.
   *
   * The comparison wins where there is one, because it is the outermost
   * operation: the cells hold `file1 / file2` *of* whatever each file was
   * derived into, and naming the inner step would describe the operand rather
   * than the value. The caption has room for both and says both.
   */
  private derivedLabel(): string | null {
    // A baseline is called what the picker calls it — `expected`, or `arm decay`
    // for the one along the arms — which is also what keeps the key from saying
    // it twice: the picker's word leads the key, and this is left off when it
    // matches (`derive`).
    if (this.options.derive?.baseline === true) {
      const scores = this.options.scores
      const picked = scores?.choices.find((choice) => choice.id === scores.current)
      return this.comparisonLabel() ?? (picked?.baseline === true ? picked.label : 'expected')
    }
    // Which decay was divided out, where it was not the ordinary one: the two
    // pictures differ by exactly the X a figure of a bacterial map is about.
    // Two words, because the key is one line the width of its two numbers and
    // `Balanced O/E along the arms (log2)` was cut off before the part that
    // said so.
    const held = this.options.derive?.arms
    const arms = held?.refusal === null && armsKey(held) !== ''
    return this.comparisonLabel() ?? (this.options.derive?.expected === true ? (arms ? 'arm O/E' : 'O/E') : null)
  }

  /** How the two open files are being combined, or `null` for one file or a split. */
  private comparisonLabel(): string | null {
    const op = this.options.compare?.op ?? 'split'
    const labels = this.options.compare?.labels
    if (this.second === null || labels === undefined || op === 'split') return null
    return op === 'ratio' ? `${labels[0]} / ${labels[1]}` : `${labels[0]} − ${labels[1]}`
  }

  /**
   * Put the scale on screen. The announcement is the caller's, and
   * {@link setData} makes it once the block is in.
   *
   * Staying silent was tried and is not available: the session calls
   * {@link applyScale} with the *state's* scale on every render of a whole-file
   * view, so a transform this panel chose without recording it is overwritten by
   * the next render for any reason at all — and the reason is usually the very
   * patch that turned the derivation on. Announcing also makes the link right,
   * which is the stronger argument: a shared ratio map reproduces as a ratio map
   * on a diverging ramp rather than as one on `log1p` counts.
   */
  private syncScaleControls(): void {
    this.transformSelect.value = this.transform
    this.colormapSelect.value = this.colormap
    this.paintClipUnits()
    this.heatmap.setScale(this.scale())
  }

  /**
   * Name the units the clip's two boxes are in, in the row's own label.
   *
   * Written here rather than once at build time because the transform is a
   * control: a reader who moves it from `log1p` to `none` has changed what the
   * numbers in the boxes mean, and a label that went on saying `(log1p)` would
   * be the one thing on the card that was wrong rather than merely stale.
   */
  private paintClipUnits(): void {
    this.clipLabel.textContent = this.transform === 'none' ? 'clip' : `clip (${this.transform})`
  }

  /**
   * Adopt a colour scale that came from *outside* this panel — a shared link, a
   * back button, a command — without echoing it back out.
   *
   * The echo is the point of the separation. {@link rescale} is what a control
   * in this card calls, and it announces the change so the URL follows;
   * `applyScale` is what the owning view calls when the URL moved first, and
   * announcing it again would be a loop. Programmatic assignment to a `<select>`
   * fires no `change` event, so the two listeners above stay quiet.
   *
   * This is what lets `App.render` treat a colour-only state change as a repaint
   * rather than as a reason to rebuild the view and re-read the matrix.
   */
  applyScale(scale: {
    transform?: Transform
    colormap?: string
    vmin?: number
    vmax?: number
  }): void {
    this.transform = scale.transform ?? this.transform
    this.colormap = scale.colormap ?? this.colormap
    this.manualVmin = scale.vmin
    this.manualVmax = scale.vmax
    this.transformSelect.value = this.transform
    this.colormapSelect.value = this.colormap
    this.paintClipUnits()
    this.heatmap.setScale(this.scale())
    this.schedule()
  }

  /**
   * The clip this panel is **actually drawing with**, auto rule included.
   *
   * The difference from {@link scale} is the whole of what "fix all scales"
   * needs, and it is the difference between a setting and a picture. `scale`
   * reports what the *reader* has set, and `NaN` is how it spells *nobody has
   * set one* — which is the state of every map that has not had its clip nudged,
   * which is most of them. A deck asked for one map's numbers and was handed two
   * `NaN`s; the ramp and the transform travelled and the range did not, so the
   * press appeared to do nothing at all.
   *
   * What the rasteriser resolved, then, which is the same pair the colourbar
   * prints and the clip boxes offer — §7.1's rule, run once per read
   * (`render/heatmap.ts`'s `autoRange`). Handing *those* to another panel pins
   * it, which is exactly what a reader means by fixing a deck's scales: the
   * numbers under the two keys are then the same numbers.
   *
   * Falls back to the setting where nothing has been drawn, because there is no
   * resolved answer yet and inventing one would be worse than saying `NaN`.
   */
  shownScale(): ColorScale {
    return this.data === null ? this.scale() : this.heatmap.effectiveScale
  }

  private rescale(): void {
    // The reader's own scale, whatever the seed was.
    this.freshSeed = false
    this.paintClipUnits()
    this.heatmap.setScale(this.scale())
    this.options.onScaleChange?.({
      transform: this.transform,
      colormap: this.colormap,
      vmin: this.manualVmin,
      vmax: this.manualVmax,
    })
    this.schedule()
  }

  /**
   * Ask for a frame, from outside.
   *
   * For data that arrived without the store changing — a `/bins` column landing
   * behind a metadata lane (§8.12). Everything else that redraws this panel
   * either changes the store, which the lanes subscribe to, or is a gesture on
   * the panel itself; this is the one road in from a fetch nobody is watching.
   */
  repaint(): void {
    this.schedule()
  }

  /**
   * The three cards that describe the picture, while there is no picture.
   *
   * Absent rather than live (§8.5). Behind the whole-genome gate — a heading,
   * what the read would cost, and a button that starts it — the column showed
   * the whole Map card: a score, eight overlay toggles, a turn, and a clip
   * reading `auto · 1 – 10` over a canvas with nothing on it. A reader who
   * nudged the clip there, pressed the turn and saw neither do anything
   * concluded the card was broken, which is the one thing a control that cannot
   * act must not be allowed to look like. They arrive with the block, and the
   * Groups card stays either way: a list of groups is true with or without a
   * matrix.
   */
  private syncCardsShown(): void {
    const waiting = this.data === null
    for (const card of [this.exportEl, this.controlsEl, this.plotEl]) {
      card.classList.toggle('hidden', waiting)
    }
  }

  /** Coalesce redraws to one per animation frame — the §12 60 fps budget. */
  private schedule(): void {
    if (this.frame !== 0) return
    this.frame = requestAnimationFrame(() => {
      this.frame = 0
      // Before the metrics and the draw: a re-cut band is a different number of
      // rows, which the stacks below it leave room against and the ruler beside
      // it is labelled from, and both are written from here.
      this.syncTurnDepth()
      this.syncLaneMetrics()
      this.heatmap.draw()
      // After the matrix and inside the same frame: the lanes read the scales
      // the heatmap has just written, so drawing them anywhere else would show
      // the previous frame's pan for one frame on every drag.
      this.lanes.draw(this.laneGeometry())
      // …and for the same reason: the scales the heatmap has just written are
      // what this reads, and writing it before the draw would show the previous
      // frame's window for one frame of every drag.
      // The derivation's own caveat rides on the same line, because it is the one
      // thing about the picture a reader cannot see by looking at it: a refused
      // adaptive window draws a fixed one, and a fixed one looks like a map. It
      // was already in the export caption, which is no use to somebody deciding
      // what they are looking at now.
      const caveat = this.derived?.scope ?? null
      const phrase = this.viewPhrase()
      // The *phrase* is what the change detection below compares, and it is the
      // whole window either way; what is shown may be the span alone.
      const shown = this.viewNoteText(phrase)
      this.viewNote.textContent = caveat === null ? shown : `${shown} · ${caveat}`
      // The same string decides both, because it *is* the window: a frame whose
      // phrase is what the last one said is a frame in which nothing anybody
      // outside this panel cares about has moved.
      if (phrase !== this.framedAt) {
        this.framedAt = phrase
        this.options.onViewMoved?.()
        // A pan moves the origin off the middle and a zoom about it does not.
        this.paintCentre()
      }
      this.syncLaneControls()
      // After the draw, because this reads a number the rasteriser resolved.
      // `effectiveScale` is the scale the raster actually used, so this is where
      // the auto rule's numbers become visible — in the colourbar and, equally,
      // in the clip boxes, which is what a reader nudges rather than invents.
      //
      // Guarded, because a pan changes neither. The legend is 256 `fillRect`s
      // and a tick layout; unguarded it redrew all of it every frame of every
      // drag, to produce the same picture it already had.
      const effective = this.heatmap.effectiveScale
      if (!sameColorScale(effective, this.painted)) {
        this.painted = { ...effective }
        this.key.set(this.keyFor(effective))
        // The second file's key carries the same numbers as the first, and is
        // worth drawing for that: what it says is that the two triangles are on
        // one scale, which is exactly the claim the reader is relying on.
        if (this.second !== null) {
          this.key2.set(this.keyFor(effective, this.secondMark()))
        }
        this.placeKey()
      }
      if (Number.isFinite(effective.vmin) && Number.isFinite(effective.vmax)) {
        this.clip.setValues(
          { vmin: effective.vmin, vmax: effective.vmax },
          this.manualVmin === undefined && this.manualVmax === undefined,
        )
      }
      // Last, and only where somebody is listening. A deck of panels follows
      // this (§16.3); a single map has no listener and the line costs nothing.
      // Reported from the frame rather than from the mutators because the
      // mutators are several and this is one place they all end at — which also
      // means a report is at most one per frame however hard the map is dragged.
      if (this.viewportListener !== null && this.data !== null) {
        const window = this.heatmap.cellWindow()
        this.viewportListener(window.rows, window.cols)
      }
      // After the lock's report and from the same frame, for the same reason it
      // is here rather than on the five mutators: this is the one place they all
      // converge, so a refine is considered at most once per frame however hard
      // the map is being dragged.
      if (this.refineListener !== null) {
        const view = this.refineWindow()
        if (view !== null) this.refineListener(view)
      }
    })
  }

  /**
   * Hold the map still while a finer block is read for it.
   *
   * Straight through to the view, because that is where both halves of it live
   * — the gestures it refuses and the spinner it draws. It is a method rather
   * than something the panel infers from its own busy state because the two are
   * different waits: {@link setBusy} veils the map while a *navigation* fetches
   * a different picture, and this holds the picture that is already there while
   * a sharper version of it arrives.
   */
  setFrozen(on: boolean, onCancel?: () => void): void {
    this.heatmap.setFrozen(on, onCancel)
  }

  /**
   * Follow this panel's window in **bins**, so somebody can read them.
   *
   * The counterpart of {@link setViewportListener}, and separate from it because
   * the two answer different questions. A deck's lock asks "where is this panel
   * looking" and wants cells, which it converts to base pairs to move its
   * neighbours. A refine asks "what would I have to read to draw this properly"
   * and wants absolute bins of the open map, which is what a `matrix` request
   * takes.
   *
   * Set from outside rather than taken as an option for the reason the viewport
   * listener is: the panel a view refines is one it did not build, and
   * `MatrixPanel` holds no reader client and must not gain one
   * (`ui/MatrixPanel.ts`, the header). The window goes up; the block comes back
   * down through {@link regrid}.
   */
  setRefineListener(listener: ((view: RefineView) => void) | null): void {
    this.refineListener = listener
  }

  /**
   * What is on screen, in absolute bins of the file — or `null` where the
   * question has no answer.
   *
   * `null` for every axis that is not one of positions: a contig-level or
   * genome-level block, and a block whose cells hold whole sequences
   * (`contigsPerCell > 1`, the whole-metagenome picture). A cell there *is* a
   * sequence, so there is no finer grid to go to and nothing to ask for.
   *
   * A **turned** map answers with the square block's own window: the drawn
   * columns are half-bins of the rotation (`render/rotate.ts`) and the rows are
   * distance from the diagonal rather than a place, so the honest window is the
   * on-diagonal square the band was cut from — which is the block a refine would
   * replace, and which `syncTurnDepth` then re-cuts the band out of.
   */
  private refineWindow(): RefineView | null {
    const data = this.data
    if (data === null || data.level !== 'bin') return null
    if ((data.contigsPerCell ?? 1) > 1) return null
    const k = Math.max(1, data.binsPerCell ?? 1)
    const window = this.heatmap.cellWindow()
    // A block read from a sibling rung describes itself on *that* rung's grid,
    // and the caller of this is deciding what to ask for next in the space it
    // asks in — the open map's. `source` is the window that was asked for, so
    // the cell window is placed proportionally inside it rather than multiplied
    // by a bin size that belongs to another level. Proportional and not exact:
    // a contig's last bin is short by its own amount at every resolution, so
    // this can be a cell out at a sequence boundary. It decides *what to read*,
    // never where anything is drawn — that is the locus axes' job, and they are
    // exact — and every read is padded by half a window anyway.
    const source = data.source
    if (source !== undefined) {
      const spanOf = (
        view: readonly [number, number],
        cells: number,
        into: Extent,
      ): Extent => {
        const width = Math.max(1, into[1] - into[0])
        const per = width / Math.max(1, cells)
        const lo = Math.floor(into[0] + view[0] * per)
        const hi = Math.ceil(into[0] + view[1] * per)
        return [Math.max(into[0], Math.min(lo, into[1])), Math.min(into[1], Math.max(hi, into[0]))]
      }
      const rows = spanOf(window.rows, data.nrows, source.rows)
      const cols = spanOf(window.cols, data.ncols, source.cols)
      // Reported as the grid it *would* be on the open map, so the ladder's
      // "is this coarse enough to be worth replacing" comparison is between two
      // numbers in one unit.
      const scale = Math.max(1, (data.binsize ?? 1) / Math.max(1, this.openBinsize()))
      return { rows, cols, binsPerCell: Math.max(1, Math.round(k * scale)) }
    }
    if (this.turned !== null) {
      const span = binsOf(window.cols, data.colExtent, k * BIN_FRACTION)
      return { rows: span, cols: span, binsPerCell: k }
    }
    return {
      rows: binsOf(window.rows, data.rowExtent, k),
      cols: binsOf(window.cols, data.colExtent, k),
      binsPerCell: k,
    }
  }

  /**
   * The bin size of the map the session has **open**, whatever the block on
   * screen was read at.
   *
   * Captured once, at construction, because `options.binsize` is the *effective*
   * resolution — the read's own bin size times its pooling — and
   * {@link setResolution} overwrites it on every block. Once a block can arrive
   * from a sibling rung there is no way back from the effective number to this
   * one, and the difference between them is the ratio the refine window is
   * scaled by.
   */
  private openBinsize(): number {
    return this.baseBinsize
  }

  // -------------------------------------------------------------------------
  // The shared viewport (§16.3)
  // -------------------------------------------------------------------------

  /**
   * Follow this panel's pan and zoom.
   *
   * Set after construction rather than taken as an option, because the panel a
   * deck locks to is usually one it did not build: the lead panel belongs to
   * whichever view is mounted — a region view, a genome view — and those views
   * have no idea a deck exists and should not gain one. One setter reaches all
   * five of them.
   */
  setViewportListener(listener: ((rows: [number, number], cols: [number, number]) => void) | null): void {
    this.viewportListener = listener
  }

  /**
   * Report which cell the pointer is over, whenever it moves.
   *
   * For a deck, which puts a small mark at the same place on every other panel
   * (§16.3): exactly one map has a pointer over it, and five full crosshairs
   * claim five pointers. Reported in *cells*, as the viewport is, so the deck
   * converts through the same base pairs the lock does.
   */
  setHoverListener(listener: ((cell: { row: number; col: number } | null) => void) | null): void {
    this.hoverListener = listener
  }

  /**
   * Show where another panel's pointer is, or stop showing it.
   *
   * A short cross on the map and a short tick in the lanes, rather than the
   * rules the panel under the pointer draws — see `HeatmapView.setEchoCell`.
   */
  showHoverEcho(cell: { row: number; col: number } | null): void {
    if (this.echo === null && cell === null) return
    this.echo = cell
    this.heatmap.setEchoCell(cell)
    // The lanes are a second canvas and take their geometry from here, so they
    // have to be asked; the map repaints itself off `setEchoCell`.
    this.schedule()
  }

  /**
   * Report which **place** the pointer is over when it is on a track, not a map.
   *
   * {@link setHoverListener}'s counterpart, and a second listener rather than a
   * second shape on the first, because the two carry different facts: a pointer
   * on the map names a contact — two places — and one on a stack names one. A
   * deck that folded them together would have to invent the missing half, and
   * the invention would be drawn on every other panel as though it had been
   * pointed at.
   *
   * Reported in this panel's own matrix units on the axis the stack runs along,
   * which is the same currency the cell report uses and converts through the
   * same base pairs (`panels/PanelDeck.ts`).
   */
  setLaneHoverListener(
    listener: ((at: { axis: 'rows' | 'cols'; unit: number } | null) => void) | null,
  ): void {
    this.laneGestures.laneHoverListener = listener
  }

  /**
   * Show a place another panel's *track* pointer is naming, or stop showing it.
   *
   * A tick in the stacks that measure that axis, and on the map the small form
   * of the guide the panel under the pointer is drawing — two 45° arms off the
   * diagonal where this map is turned, a cross on the diagonal where it is not
   * (`HeatmapView.setLaneEcho`).
   *
   * The map's half is refused where this block has no diagonal: a contig × contig
   * picture is of two places, and there is no point on it that is one of them.
   * The stacks still get their tick, because a track under such a block is drawn
   * against one axis and that axis does carry the position.
   */
  showLaneEcho(at: { axis: 'rows' | 'cols'; unit: number } | null): void {
    if (this.laneEcho === null && at === null) return
    this.laneEcho = at
    const diagonal = this.data !== null && isTurnable(this.data)
    this.heatmap.setLaneEcho(at === null || !diagonal ? null : at.unit)
    this.schedule()
  }

  /**
   * Show a place named by something that is not a map — a bead of a structure
   * cell (§25) — or stop showing it.
   *
   * A bead is *one* genomic place, so it takes the lane-echo shape and not the
   * cell-echo one: the small guide on the diagonal and a tick in the stacks on
   * that axis, which is what a pointer on another panel's track already gets.
   * Converted through the column axis, which is the one that means position in
   * both presentations, and through `locusToUnits`' first answer — a circular
   * sequence panned across its junction is on the axis twice, and one mark is
   * what a place gets.
   */
  /**
   * Answer a box drawn on *another* map as though it had been drawn on this
   * one — a deck's companion that is following the deck, whose box moves the
   * whole deck there by the road a box on this map takes (§16.3). A selection
   * is names and base pairs, so it means the same place on both.
   */
  selectRegion(selection: SelectedRegion): void {
    this.options.onSelectRegion?.(selection)
  }

  /**
   * The contact under one of this block's cells, as two loci, or `null`.
   *
   * For a deck carrying a pointer between two maps whose blocks are **not one
   * place** (§16.3) — a companion reading a window of its own — where the cell
   * arithmetic the lock uses would put the mark as far off as the two blocks'
   * starts are apart.
   */
  contactAt(cell: { row: number; col: number }): { rows: ManualPoint; cols: ManualPoint } | null {
    return this.data === null ? null : this.locusOf(cell)
  }

  /**
   * The cell of this block a contact falls in, or `null` where it falls in none
   * — {@link contactAt}'s other half. Not on a turned map, whose rows are
   * separation rather than a position a locus can land on.
   */
  cellOfContact(contact: { rows: ManualPoint; cols: ManualPoint }): { row: number; col: number } | null {
    if (this.data === null || this.turned !== null) return null
    const rows = this.locusAxes.rows?.locusToUnits(contact.rows.contig, contact.rows.bp) ?? []
    const cols = this.locusAxes.cols?.locusToUnits(contact.cols.contig, contact.cols.bp) ?? []
    if (rows.length === 0 || cols.length === 0) return null
    return { row: Math.floor(rows[0]), col: Math.floor(cols[0]) }
  }

  showLocusEcho(locus: { contig: string; bp: number } | null): void {
    if (locus === null) {
      this.showLaneEcho(null)
      this.heatmap.setLocusEcho(null)
      return
    }
    const units = this.locusAxes.cols?.locusToUnits(locus.contig, locus.bp) ?? []
    this.showLaneEcho(units.length === 0 ? null : { axis: 'cols', unit: units[0] })
    // …and across the heatmap itself, on both axes the place is on: a bead
    // pointed at in the structure cell is a line down and a line across the
    // map, where the tick at the edge alone left the reader to find it.
    const rows = this.locusAxes.rows?.locusToUnits(locus.contig, locus.bp) ?? []
    // Turned, the echo is the V the place makes, and a place just off the side
    // of the block still has an arm reaching into it — placed by extending its
    // stretch, as a line the reader drew is (`drawManualLines`). The tick at the
    // lanes' edge above needs an edge to stand on, and keeps the landing alone.
    const cols =
      units[0] ??
      (this.turned === null ? null : (this.locusAxes.cols?.locusToUnit(locus.contig, locus.bp) ?? null))
    this.heatmap.setLocusEcho(
      cols === null && rows.length === 0 ? null : { rows: rows[0] ?? null, cols },
    )
  }

  /**
   * The stretches of sequence on screen, per axis, for a cell that lights what
   * the deck is looking at (§25).
   *
   * Empty above bin level, where a cell is a whole sequence and a window
   * inside one would be an invention, and empty before a block has arrived.
   */
  framedRanges(): { rows: LocusWindow[]; cols: LocusWindow[] } {
    return {
      rows: this.framedWindows(this.locusAxes.rows, this.heatmap.scaleY),
      cols: this.framedWindows(this.locusAxes.cols, this.heatmap.scaleX),
    }
  }

  /**
   * Report how much room this panel's lane stacks take, whenever it changes.
   *
   * For a deck, which reserves the same room on every panel beside this one so
   * the maps line up (§16.5) — including the room a *gap* takes, since a gap
   * the arithmetic did not know about is a picture pushed down by it. Reported
   * rather than read, because it changes when a track is added and nothing
   * outside this panel can know when that was.
   */
  setLaneListener(listener: ((geometry: PanelGeometry) => void) | null): void {
    this.laneListener = listener
    if (listener !== null) this.reportGeometry()
  }

  /**
   * Tell whoever is laying this panel out beside others how big it came out.
   *
   * The **measured** width, not the rule that produced it. A companion's plot
   * is sized by the same stylesheet from the same variables and still lands
   * somewhere else, because the two are in cells of different content — one
   * `clamp` bottoms out, the other is capped by its column — and chasing that
   * through CSS is chasing a derivation with four inputs. A number the deck can
   * hand to every other panel has one.
   */
  /**
   * The room this panel's own stack takes on one edge, in CSS pixels.
   *
   * The same figure {@link reportGeometry} sends, asked one edge at a time —
   * what a deck needs from a *companion*, which reports nothing because it is
   * not laying anything out. Zero for an empty edge, gap included otherwise,
   * because a stack of one still needs the space between it and the map.
   */
  laneExtent(edge: LaneEdge): number {
    return this.roomOn(edge)
  }

  private reportGeometry(): void {
    this.laneListener?.({
      lanes: {
        top: this.roomOn('top'),
        right: this.roomOn('right'),
        bottom: this.roomOn('bottom'),
        left: this.roomOn('left'),
      },
      plot: this.heatmap.cssSize.width,
      plotHeight: this.heatmap.cssSize.height,
    })
  }

  /**
   * How many pixels this panel's lanes have across, for a cell matching it.
   *
   * A lane's summary level comes off its pixel count, and a pixel count is a
   * fact about the layout rather than about the genome — so a tracks cell three
   * across and the same track beside this map asked for two different levels
   * over one window and autoscaled to two different ceilings (§8.8, §16.2).
   * `annotations/samples.ts` floors every lane at 1024 px, which makes the two
   * agree at every width this application lays out below that; past it — a
   * 1-across deck in a wide window — the lead asks for the finer level it can
   * actually draw, and a cell wanting to be held against it asks for this
   * instead of for its own width. See `BrowserViewProps.sampleWidth`.
   */
  laneAcrossPixels(): number {
    return this.heatmap.cssSize.width
  }

  /** What this panel is showing, in its own cells, or `null` with no block. */
  viewport(): { rows: [number, number]; cols: [number, number] } | null {
    return this.data === null ? null : this.heatmap.cellWindow()
  }

  /**
   * Name the score this panel is drawing, for a panel with no picker of its own.
   *
   * A companion in a deck reads whatever the deck resolved and offers no
   * control over it (§16.2), so the word for it has to arrive from outside —
   * without this the key called a balanced map `Count`, which is a legend
   * describing the wrong quantity beside numbers that are right.
   */
  setScoreLabel(label: string): void {
    if (this.scoreLabel === label) return
    this.scoreLabel = label
    this.painted = null
  }

  /**
   * Point the score picker at what is actually being drawn.
   *
   * The choice does not always come from the picker. A companion's score is its
   * own only while the reader has made it so; the rest of the time it follows
   * the deck (`panels/MapPanel.ts`), and the deck's can move from the lead's own
   * picker, from a link or from the back button. A dropdown left showing the
   * previous answer beside a map drawing the new one is a control that lies
   * about the picture it is over.
   *
   * Assignment fires no `change` event, so this cannot loop back through the
   * listener — the same property {@link applyScale} relies on.
   *
   * **And the panel's own idea of the score with it**, which is more than the
   * dropdown: the key's first word and the framing every analysis of this map
   * runs on are read from it. A score that reads the same cells no longer
   * rebuilds the panel (`Session.render`), so this is where it learns of one —
   * even when the dropdown already shows it, because the reader picked it
   * there.
   */
  syncScoreChoice(id: string): void {
    const scores = this.options.scores
    // Only to a choice it has: a file that fell back to counts because it has
    // no such column would otherwise be left with a blank picker.
    if (scores === undefined || !scores.choices.some((choice) => choice.id === id)) return
    if (scores.current !== id) {
      this.options.scores = { ...scores, current: id }
      this.painted = null
    }
    const select = this.scoreSelect
    if (select !== null && select.value !== id) select.value = id
  }

  /**
   * Offer another list of scores, and point the picker at the one drawn.
   *
   * What the cells can be is a fact about the view as well as the file: a
   * circle ticked on the sequence on screen — by the reader, or by a first
   * open that measured it after the view was built — offers the baseline
   * along its arms, and unticked takes it away (§8.15). The declaration does
   * not rebuild the view, so the picker is told here rather than built again;
   * a list with the same entries leaves the options alone and is
   * {@link syncScoreChoice} exactly.
   */
  offerScores(choices: readonly ScoreChoice[], id: string): void {
    const scores = this.options.scores
    if (scores === undefined) return
    const same =
      scores.choices.length === choices.length &&
      scores.choices.every((choice, i) => choice.id === choices[i].id && choice.label === choices[i].label)
    if (!same) {
      this.options.scores = { ...scores, choices }
      this.painted = null
      this.scoreSelect?.replaceChildren(...choices.map(scoreOption))
    }
    this.syncScoreChoice(id)
  }

  /**
   * Say whether the cells have been through the file's weights.
   *
   * Not cosmetic. A balanced cell is a fraction, so under `log10` every value
   * in the block is *negative* — and the automatic range knows to keep them
   * only because it is told the matrix is balanced (`render/scale.ts`). A
   * companion built without this drew a blank rectangle from a range of
   * `[0, ~0]`, over data that was perfectly good, while its key called the
   * numbers counts.
   */
  setBalanced(balanced: boolean): void {
    if ((this.options.balance === true) === balanced) return
    this.options.balance = balanced
    this.painted = null
  }

  /**
   * Whether the block on screen is a turned band rather than a square.
   *
   * What the panel *found*, not what it was asked for: a block with no diagonal
   * is drawn square however the toggle is set, so the deck has to read this
   * rather than the shared setting when it is deciding what the row axis of
   * this panel means (`panels/PanelDeck.ts`).
   */
  isTurned(): boolean {
    return this.turned !== null
  }

  /**
   * How many cells each axis of the **drawn** grid has — the lock's clamp.
   *
   * The band, on a turned map, and not the square it was rotated out of. Both
   * this and {@link bpPerCell} answer questions about the grid a viewport is
   * expressed in (`panels/lock.ts`), and the viewport this panel reports is the
   * one the reader is looking at. Answering with the square while reporting the
   * band mixes two grids in one conversion: a band is `2n − 1` columns wide, so
   * a whole-band window came back as `2n` cells, was multiplied by a whole bin
   * into twice the base pairs it covers, and was then clamped back to `n` cells
   * at the far end — every turned panel of a deck showing half of what the one
   * beside it was showing, under a bar that says one navigation.
   */
  /**
   * Whether this panel has a block to be compared with.
   *
   * {@link cellCount} answers `1 × 1` for a panel that has not read one, because
   * a divisor of zero is worse than a divisor of one — but *one cell* is also a
   * legitimate answer, so the two cannot be told apart from outside. The deck's
   * lock has to: comparing a companion against a lead that is still reading
   * produced "this block spans 16.6 Mb × 16.6 Mb where the first map spans
   * 1.0 kb × 1.0 kb", which is one bin of the lead's binsize dressed up as a
   * measurement — and the sentence went on to blame the sequences.
   */
  get hasBlock(): boolean {
    return this.data !== null
  }

  cellCount(): { rows: number; cols: number } {
    const turned = this.turned
    if (turned !== null) return { rows: turned.nrows, cols: turned.ncols }
    return { rows: this.data?.nrows ?? 1, cols: this.data?.ncols ?? 1 }
  }

  /**
   * Base pairs one cell covers, after whatever pooling the read chose.
   *
   * Half a bin under a turn, on both axes, because that is what the rotated
   * lattice *is* rather than a scale chosen for it: `b1 + b2` advances by one
   * whenever either end moves by one bin (`render/rotate.ts`). The vertical
   * half-bin is a half-bin of *separation*, which is the axis a turned panel
   * has up its side — so two turned panels lock to each other in distance from
   * the diagonal, which is the only thing they could honestly share there.
   */
  bpPerCell(): number {
    return this.turned === null ? this.options.binsize : this.options.binsize * BIN_FRACTION
  }

  /**
   * What one cell of the drawn block *is* — a stretch of a sequence, a whole
   * sequence, or a whole genome. `null` before anything has been read.
   *
   * Published because {@link bpPerCell} is only a length above bin level by
   * accident. A contig-level cell is a whole chromosome, and the number this
   * panel answers there is the file's bin size, which is a fact about the file
   * and nothing at all about the width of a cell. Everything that multiplies
   * cells by base pairs has to know which of those two worlds it is in first:
   * the deck's lock and its pointer echoes did not, and marked chromosome 3 of
   * a 5 kb map for chromosome 12 of the 1 kb map beside it (`panels/PanelDeck.ts`).
   */
  blockLevel(): 'bin' | 'contig' | 'genome' | null {
    return this.data?.level ?? null
  }

  /**
   * How much sequence each axis of the block covers, and across how many
   * sequences it was rounded to whole cells — the deck's compatibility gate
   * (§16.4, `panels/lock.ts`).
   *
   * `cells × bpPerCell` is the answer **at bin level only**, and using it
   * everywhere is what made two roll-ups of one 16-chromosome genome, at 1 kb
   * and at 5 kb, report spans of 16 kb and 80 kb and accuse each other of
   * having resolved the same names against different sequences. Above bin level
   * a cell is a whole sequence, so the length of the axis is not in the cell
   * count at all: it is in the block's **bin** extent, which an aggregate still
   * reports on the file's own grid, times the bin size — and there
   * `options.binsize` is exactly that, because a roll-up carries no
   * `binsPerCell` for {@link setResolution} to fold in.
   *
   * `sequences` is the width of the tolerance the comparison needs rather than
   * a fact anybody draws. A cell never straddles a sequence
   * (`metacooler/pooling.ts`), so an axis of N sequences rounds N last cells up
   * — the same short-last-bin allowance §3.3 makes, N times over. A one-contig
   * region view answers 1, which is the only case the old one-cell tolerance
   * was ever right for.
   */
  blockSpan(): { rows: number; cols: number; sequences: { rows: number; cols: number } } {
    const data = this.data
    const cells = this.cellCount()
    const bp = this.bpPerCell()
    // A turn only ever cuts a band out of a bin-level square, and its rows are
    // separation rather than position — both of which the cell arithmetic gets
    // right and the extent arithmetic below would not.
    if (data === null || data.level === 'bin' || this.turned !== null) {
      return {
        rows: cells.rows * bp,
        cols: cells.cols * bp,
        sequences: {
          rows: data?.rowContigs ?? data?.rowGroups.length ?? 1,
          cols: data?.colContigs ?? data?.colGroups.length ?? 1,
        },
      }
    }
    const binsize = Math.max(1, this.options.binsize)
    return {
      rows: (data.rowExtent[1] - data.rowExtent[0]) * binsize,
      cols: (data.colExtent[1] - data.colExtent[0]) * binsize,
      sequences: {
        rows: data.rowContigs ?? data.rowGroups.length,
        cols: data.colContigs ?? data.colGroups.length,
      },
    }
  }

  /**
   * Show a cell window that came from outside — the deck's lock.
   *
   * The counterpart of {@link applyScale}, and separate from the panel's own
   * gestures for the same reason: a control in here announces what it did, and
   * this is what the panel is *told*. The listener still fires on the next
   * frame, because a redraw is a redraw; the lock recognises its own broadcast
   * coming back rather than this pretending it did not happen (`panels/lock.ts`).
   */
  showViewport(rows: [number, number], cols: [number, number]): boolean {
    // The return is what the lock needs, not a convenience. A panel with no
    // block cannot move and therefore will never report, and a lock that had
    // already recorded a report as owed would wait for it forever — swallowing
    // this panel's *first* genuine gesture when its block finally arrives.
    if (this.data === null) return false
    this.heatmap.showCellWindow(rows, cols)
    return true
  }

  /**
   * Put a stretch of genome on screen **on the diagonal**, without re-cutting the
   * block — what a bookmark means by "take me there" (§8.10).
   *
   * The distinction from opening `region=chrI:1200000-1260000` is the point of
   * the whole feature: that reads a block cut at those coordinates, so the edges
   * of the picture are the edges of the data and panning off them shows paper.
   * This is a *zoom* over a block that was read whole, so the rest of the
   * chromosome is still behind the window and one drag reaches it.
   *
   * On the diagonal because a locus is one coordinate and a contact map takes
   * two: the square a stretch cuts out of its own chromosome is the only block
   * one locus names, and it is the block the reader means. Which is the same
   * resolution {@link turnedWindow} makes for a drag across a band, arrived at
   * from the other end.
   *
   * Both presentations are served from the same window, and neither is a special
   * case of the other. A **square** map takes the window on both axes, which is
   * literally the on-diagonal square. A **turned** one takes it on the column
   * axis alone and lets the row axis follow ({@link HeatmapView.showCellSpan}):
   * up the side is distance from the diagonal, so there is no row window to ask
   * for and asking for one would pin the zoom to the band's own depth.
   *
   * `false` when the window could not be placed — no block yet, a contig this one
   * does not cover, a locus above bin level — and nothing moves when it cannot.
   * The caller's fallback is the fitted view it already has: §8.4's rule is that
   * a picture in the wrong place is worse than one at the wrong zoom, and a
   * bookmark quietly landing on another chromosome is exactly that.
   */
  showLocus(window: { contig: string; start: number; end: number }): boolean {
    if (this.data === null) return false
    const want = {
      from: { contig: window.contig, bp: window.start },
      to: { contig: window.contig, bp: window.end },
    }
    const cells = this.cellCount()
    const cols = spanOnAxis(this.locusAxes.cols, want, cells.cols)
    if (cols === null) return false
    if (this.turned !== null) {
      this.heatmap.showCellSpan([cols[0], cols[1]])
      return true
    }
    const rows = spanOnAxis(this.locusAxes.rows, want, cells.rows)
    if (rows === null) return false
    this.heatmap.showCellWindow([rows[0], rows[1]], [cols[0], cols[1]])
    return true
  }

  /**
   * The map's own values between one place and many — the row through a
   * pinned bead, for the structure cell to colour by (§25.5).
   *
   * Read out of the block the picture is drawn from, on the square axes, so
   * a bead's colour is by construction the colour of the cell it names; a
   * turned map reads the same square. `NaN` for a place off the block or in
   * an empty cell, and `null` where there is no block, no square axis, or
   * the first place is not on it. Zero I/O: the block is in hand.
   */
  contactsBetween(
    from: { contig: string; bp: number },
    to: ReadonlyArray<{ contig: string; bp: number }>,
  ): Float32Array | null {
    const data = this.data
    const values = this.drawn
    const rows = this.squareAxes.rows
    const cols = this.squareAxes.cols
    if (data === null || values === null || rows === null || cols === null) return null
    const rowUnit = rows.locusToUnit(from.contig, from.bp)
    if (rowUnit === null) return null
    const row = Math.floor(rowUnit)
    if (row < 0 || row >= data.nrows) return null
    const out = new Float32Array(to.length).fill(Number.NaN)
    for (let i = 0; i < to.length; i++) {
      const at = to[i]
      const colUnit = cols.locusToUnit(at.contig, at.bp)
      if (colUnit === null) continue
      const col = Math.floor(colUnit)
      if (col < 0 || col >= data.ncols) continue
      out[i] = values[row * data.ncols + col]
    }
    return out
  }

  /**
   * Put a stretch on the **column** axis and leave the rows where they are —
   * what a tracks cell of the deck asks for when the reader pans it (§25.3).
   *
   * {@link showLocus} is for a locus, which on a square map is the on-diagonal
   * square; a stack of tracks names one axis, and moving both would take a
   * reader looking off the diagonal back onto it for having scrolled a track.
   * On a turned map the column axis is the only one there is, and the two
   * calls are the same. `false` where nothing moved, on {@link showLocus}'s
   * terms.
   */
  showLocusOnColumns(window: { contig: string; start: number; end: number }): boolean {
    if (this.data === null) return false
    const want = {
      from: { contig: window.contig, bp: window.start },
      to: { contig: window.contig, bp: window.end },
    }
    const cells = this.cellCount()
    const cols = spanOnAxis(this.locusAxes.cols, want, cells.cols)
    if (cols === null) return false
    if (this.turned !== null) {
      this.heatmap.showCellSpan([cols[0], cols[1]])
      return true
    }
    const held = this.heatmap.cellWindow()
    this.heatmap.showCellWindow(held.rows, [cols[0], cols[1]])
    return true
  }

  /**
   * The stretch of genome the picture is showing, for something that wants to
   * write it down — the *take a bookmark* button, today.
   *
   * The **column** axis, because that is the one that means position in both
   * presentations: a turned band has no row locus at all, and on a square
   * on-diagonal map the two axes are the same stretch anyway. Off the diagonal
   * they are not, and the honest answer there is still the columns — a
   * contig × contig block is a picture of two places, and a bookmark is one.
   *
   * `null` where the answer would be a guess: no block, no locus axis (a contig
   * or genome level cell is a whole sequence), or a window spanning **more than
   * one contig**. That last is a refusal rather than a truncation: a whole-genome
   * map framed across four chromosomes is not at a location, and saving its first
   * chromosome would be saving somewhere the reader is not looking.
   */
  framedRegion(): FramedRegion | null {
    if (this.data === null) return null
    const windows = this.framedWindows(this.ownAxes.cols, this.heatmap.scaleX)
    // **Two runs of one sequence is one window on a circle**, not two places: a
    // wrapped axis carries the sequence's tail and then its head, with the
    // second run a lap along (§8.15). Reported as the window a reader would
    // type — `chr:4,500,000-150,000` — and flagged, because that is a region
    // only a declared sequence accepts.
    if (windows.length === 2) {
      const [tail, head] = windows
      if (tail.contig !== head.contig || tail.segment === head.segment) return null
      return {
        contig: tail.contig,
        start: tail.start,
        end: head.end,
        length: tail.segment.contigLength,
        wrapped: true,
      }
    }
    if (windows.length !== 1) return null
    const only = windows[0]
    return only.end > only.start
      ? {
          contig: only.contig,
          start: only.start,
          end: only.end,
          // The sequence's own length travels with the window, because the two
          // callers that widen one have nowhere else to learn where it stops: a
          // region view is a window on one contig and carries no assembly.
          length: only.segment.contigLength,
        }
      : null
  }

  /**
   * The sequences the block read runs over along each axis, in axis order —
   * what a deck cell's heading says its map is on (§16.3). Off the block's own
   * runs, so in this map's own names and whatever the window on screen.
   */
  blockSequences(): { rows: string[]; cols: string[] } {
    const names = (groups: MatrixResult['rowGroups'] | undefined): string[] => [
      ...new Set((groups ?? []).map((group) => group.label)),
    ]
    return { rows: names(this.data?.rowGroups), cols: names(this.data?.colGroups) }
  }

  /**
   * Tell the stylesheet how much vertical budget the horizontal stacks take, and
   * re-measure whenever any stack changes thickness.
   *
   * The plot's size is `100vh` minus its furniture, and a stack of tracks above
   * or below it is furniture: without the properties, six tracks push the map
   * off the bottom of the window. The *vertical* stacks need no property — the
   * grid's own `max-width` takes them out of the plot's width, since a
   * percentage written here would resolve against the plot's own track and chase
   * its own tail — but they still have to be watched, because a lane appearing
   * beside the map resizes the map just as surely as one appearing under it.
   *
   * Written only when a thickness changes, because assigning a custom property
   * invalidates layout and this runs on every frame of a drag.
   */
  private syncLaneMetrics(): void {
    const next = {
      top: this.lanes.thicknessOf('top'),
      right: this.lanes.thicknessOf('right'),
      bottom: this.lanes.thicknessOf('bottom'),
      left: this.lanes.thicknessOf('left'),
    }
    const corners = { top: 0, right: 0, bottom: 0, left: 0 }
    for (const edge of LANE_EDGES) corners[CORNER_SIDE[edge]] = this.lanes.cornerOf(edge)
    if (
      LANE_EDGES.every((edge) => next[edge] === this.laneBudget[edge]) &&
      LANE_EDGES.every((side) => corners[side] === this.cornerBudget[side])
    ) {
      return
    }
    this.laneBudget = next
    this.cornerBudget = corners
    this.writeLaneMetrics()
    // …and to whoever is laying this panel out beside others. A deck exists so
    // that N pictures of one place can be compared, and a picture inset by a
    // stack of tracks beside a picture that is not is a comparison the eye has
    // to correct for before it can start (§16).
    this.reportGeometry()
    // Re-measure *now*, in the same frame, rather than waiting for the resize
    // observer. The observer watches the grid, and the grid's width is the wider
    // of the plot and the lane below it — so a plot that has just shrunk under a
    // lane still as wide as the plot used to be leaves the grid's box unchanged,
    // the observer silent, and the two canvases permanently out of step. This is
    // the one forced layout in the draw path, and it happens only when a lane is
    // added, removed or resized.
    this.heatmap.resize()
  }

  /**
   * Reserve room on each edge that this panel's own tracks do not fill.
   *
   * A deck's promise is that its pictures are of one place and can be read
   * against each other, and that survives only if every map is the same size at
   * the same height in its cell. Once a track can be placed on one map and not
   * on the next (§16.8) that stops being free: a companion with a strip above it
   * and a lead without one draw the same window at two heights, and the eye has
   * to correct for the offset before it can start.
   *
   * So the deck reserves the *largest* stack any of its panels has on each edge
   * and hands the figure to all of them; each pads out the difference between
   * that and its own. A panel on its own is never given one, and nothing about
   * its layout changes.
   */
  setLaneFloor(floor: Record<LaneEdge, number>): void {
    if (LANE_EDGES.every((edge) => floor[edge] === this.laneFloor[edge])) return
    this.laneFloor = { ...floor }
    this.writeLaneMetrics()
    // The floor changes the plot's height budget, and the observer on the grid
    // will not see it: the grid's box is unchanged, only what is inside it.
    this.heatmap.resize()
  }

  /**
   * What this panel's own stack takes on one edge, gap included.
   *
   * Zero for an empty edge, because a stack that is not there needs no air
   * between itself and the map.
   */
  private roomOn(edge: LaneEdge): number {
    const thickness = this.laneBudget[edge]
    const stack = thickness <= 0 ? 0 : thickness + LANE_GAP
    // …or the corner on that side, where a stack's names run out wider than
    // the stack beside it (§8.8): the grid's track is the wider of the two.
    return Math.max(stack, this.cornerBudget[edge])
  }

  /**
   * Tell the stylesheet what the stacks cost, this panel's own and the deck's.
   *
   * Two mechanisms, because room above the map does not cost the same thing as
   * room beside it. The **padding** is where the reserved room physically is,
   * which is what puts every picture at the same height in its cell. The two
   * custom properties are the *height budget* the square is computed from —
   * `.heatmap-wrap` is `100vh` minus its furniture — and they carry the deck's
   * figure rather than this panel's, because two squares computed from two
   * different budgets come out two different sizes however they are padded.
   */
  private writeLaneMetrics(): void {
    for (const edge of LANE_EDGES) {
      const pad = Math.max(0, this.laneFloor[edge] - this.roomOn(edge))
      this.grid.style.setProperty(`--lane-pad-${edge}`, `${pad}px`)
    }
    this.grid.style.setProperty(
      '--lane-top',
      `${Math.max(this.roomOn('top'), this.laneFloor.top)}px`,
    )
    this.grid.style.setProperty(
      '--lane-bottom',
      `${Math.max(this.roomOn('bottom'), this.laneFloor.bottom)}px`,
    )
  }

  /**
   * Put each stack's controls where the paint says they go.
   *
   * The offset converts a lane canvas's own pixels into the grid's, which is what
   * the layers are positioned against — `offsetLeft`/`offsetTop` carry the grid
   * gap and the canvas's own margin with them, so nothing here has to know that
   * `.lane-bottom` sits four pixels down.
   */
  private syncLaneControls(): void {
    for (const [edge, controls] of this.laneControls) {
      const canvas = this.lanes.canvasFor(edge)
      if (canvas.classList.contains('hidden')) {
        controls.clear()
        continue
      }
      controls.sync(this.lanes.marksOn(edge), { left: canvas.offsetLeft, top: canvas.offsetTop })
    }
  }

  private emitClick(cell: Cell): void {
    if (this.data === null) return
    // A picking mode owns the click outright. Navigating *and* placing would put
    // the mark on a view the reader can no longer see. The mode stays on after
    // the mark is placed: it ends when the card or Escape says so, not when a
    // click lands.
    //
    // Including a mode that has no use for a click: a form waiting for a box
    // swallows one rather than letting it navigate, because a press that did not
    // travel is a drag the reader gave up on, not a request to go somewhere.
    const picking = this.picking
    if (picking !== null) {
      const point = this.locusOf(cell)
      if (point !== null) picking.point?.(point)
      return
    }
    // Through the square, for the readout's reason: a turned cell's row is a
    // separation, and a view asked to open "the block at row 3" of a band would
    // be handed whichever sequence sits three bins from the diagonal.
    const square = this.squareCell(cell)
    this.options.onCellClick?.(
      square,
      {
        row: groupAt(this.data.rowGroups, square.row),
        col: groupAt(this.data.colGroups, square.col),
      },
      // The same runs the tooltip names the genome from, so what a click opens
      // and what the pointer said it was over cannot come apart.
      {
        row: groupAt(this.data.rowGenomes, square.row)?.label,
        col: groupAt(this.data.colGenomes, square.col)?.label,
      },
    )
  }

  /**
   * Resolve a dragged box to one block per axis, and hand it on.
   *
   * Each axis is resolved through the block the *anchor* sits in on that axis —
   * where the drag began, which is what says which sequence the box is of when
   * it overruns a boundary — and clamped to that block. A box in the trans
   * corner therefore comes back naming both sequences, and the view opens their
   * intersection.
   */
  /**
   * The two spans a drag covers, as the chips on the box write them.
   *
   * Through the same `axisSelection` the *release* commits to, so what the
   * numbers promise is what opens — including the clamp to the sequence's own
   * length, which is what stops a box overrunning a short last bin and naming a
   * coordinate the reader would refuse.
   */
  /**
   * The window on screen as a locus, for a surface that has one axis.
   *
   * What the 1D browser opens at when the map is put down: the row axis, since
   * on the diagonal it is also the column axis and off it the rows are the ones
   * the reader's eye follows down the page. `undefined` where the answer would
   * be a lie — several sequences at once, or a level at which a cell is a whole
   * sequence — and there the browser opens on the whole genome, which is that
   * picture's own analogue of a whole-file map.
   */
  framedLocus(): string | undefined {
    const windows = this.framedWindows(this.ownAxes.rows, this.heatmap.scaleY)
    const only = windows.length === 1 ? windows[0] : undefined
    return only === undefined ? undefined : formatLocus(only)
  }


  /**
   * The stretches of sequence one axis currently shows, on bin edges.
   *
   * The domain is floored and ceiled to whole *units* of the axis, which on a
   * square map is a bin and on a **turned** one is half of one: the rotated
   * lattice counts in half bins (`render/rotate.ts`) and the last bin's right
   * half has no column to be ceiled up to, so the same block came out
   * `IV:1,000,001-1,399,500 · 399.5 kb` turned and `-1,400,000 · 400.0 kb`
   * square — 400 bins of 1 kb reported as 399.5 kb, which is an arithmetic a
   * reader checks. So the window is snapped to the file's own bins afterwards,
   * which is a no-op on every square map and the missing half bin on a band.
   */
  private framedWindows(axis: LocusAxis | null, scale: Scale): LocusWindow[] {
    if (axis === null) return []
    const [d0, d1] = scale.domain
    const lo = Math.max(0, Math.floor(d0))
    const hi = Math.min(axis.unitEnd, Math.ceil(d1))
    if (!(hi > lo)) return []
    return axis.windows([lo, hi]).map((window) => ({
      ...window,
      start: this.snapToBin(window.start, 'down'),
      // Never past the sequence's own end, which `LocusAxis.windows` has
      // already clamped to and which is not on a bin edge when the last bin is
      // short.
      end: Math.min(window.segment.contigLength, this.snapToBin(window.end, 'up')),
    }))
  }

  /**
   * The window on screen, read off the scales the pan and the zoom write.
   *
   * Bin-aligned, because the cells are: what is reported is the window drawn
   * rather than the fractional domain the transform happens to hold. Empty above
   * bin level, where a cell is a whole sequence and a coordinate inside one
   * would be an invention — and empty on an axis whose runs carry no length,
   * which is the same refusal `axisCoordsFor` makes about its ticks.
   */
  private viewPhrase(): string {
    return framedPhrase(
      this.framedWindows(this.ownAxes.rows, this.heatmap.scaleY),
      this.framedWindows(this.ownAxes.cols, this.heatmap.scaleX),
    )
  }

  /**
   * Say that the window is already named in a heading above this panel.
   *
   * The region view's bar printed the locus three times over: as its own `h2`,
   * inside the box beside it, and again in the summary line between the two —
   * `IV:1,000,001-1,400,000` at the top left, in the middle of the sentence
   * under it, and in the box at the top right, all on one bar and all the same
   * string. The summary's own contribution is the *span*, which is the one thing
   * the heading does not say.
   *
   * Set from outside rather than inferred, because this panel does not know what
   * is drawn above it: the same panel is a cell of a deck with no heading of its
   * own, and there the locus is the only place the window is written down.
   */
  setWindowNamedAbove(named: boolean): void {
    this.windowNamedAbove = named
  }

  /** See {@link setWindowNamedAbove}. */
  private windowNamedAbove = false

  /**
   * The summary's own half of the window: the span, where a heading above has
   * already named the place, and the whole phrase otherwise.
   *
   * Only where the two would be *identical*, which is the on-diagonal single
   * window the heading can name. A genome pair, a `contig × contig` block and a
   * multi-sequence frame each say something the heading does not, so they are
   * printed whole.
   */
  private viewNoteText(phrase: string): string {
    if (!this.windowNamedAbove) return phrase
    const heading = this.options.headingLocus?.() ?? null
    if (heading === null || heading === '') return phrase
    return phrase.startsWith(`${heading} · `) ? phrase.slice(heading.length + 3) : phrase
  }

  /**
   * The window a drag over a **turned** map names, in the square block's cells.
   *
   * A band on a turned map is a stretch of the genome and nothing else — up the
   * side is distance from the diagonal, which bounds no window — so what the
   * gesture asks for is the on-diagonal square that stretch cuts out: the same
   * range on both axes, which is exactly what `Shift` gives on a square map
   * (`render/heatmap.ts`'s diagonal lock). Turning it on is therefore not a
   * second gesture to learn; it is the only one of the two that still means
   * anything, and it is what the drag falls back to.
   *
   * The arithmetic is the rotation's, halved: a turned column is half a bin, so
   * a column index divided by two is a bin index into the block the band came
   * out of. `null` where the block is not turned, which is the caller's cue that
   * the ordinary two-axis resolution applies.
   */
  private turnedSpan(box: SelectionBox): [number, number] | null {
    const data = this.data
    if (this.turned === null || data === null) return null
    return binsForColumns(box.cols, Math.min(data.nrows, data.ncols))
  }

  /** One axis of a turned drag, resolved through the block's single sequence. */
  private turnedAxisSelection(box: SelectionBox): SelectedAxis | null {
    const data = this.data
    const span = this.turnedSpan(box)
    if (data === null || span === null) return null
    // `isTurnable` has already refused any block spanning more than one, so the
    // run the span starts in is the run the whole of it is in.
    const group = groupAt(data.rowGroups, span[0])
    return group === undefined ? null : this.axisSelection(group, span, data.rowExtent[0])
  }

  private describeSelection(box: SelectionBox): SelectionText | null {
    const data = this.data
    // Above bin level a cell *is* a contig or a genome, and the axis labels
    // already name it: a base pair inside one would be an invention.
    if (data === null || data.level !== 'bin') return null
    if (this.turned !== null) {
      // One set of chips, on the axis that has coordinates. The band is the full
      // height of the plot, so a second column of numbers beside it would be
      // labelling the panel rather than the selection.
      const only = this.turnedAxisSelection(box)
      return only === null ? null : { rows: null, cols: spanText(only) }
    }
    const rowGroup = groupAt(data.rowGroups, box.anchor.row)
    const colGroup = groupAt(data.colGroups, box.anchor.col)
    const rows = rowGroup === undefined ? null : this.axisSelection(rowGroup, box.rows, data.rowExtent[0])
    const cols = colGroup === undefined ? null : this.axisSelection(colGroup, box.cols, data.colExtent[0])
    if (rows === null && cols === null) return null
    return { rows: rows === null ? null : spanText(rows), cols: cols === null ? null : spanText(cols) }
  }

  private emitSelection(box: SelectionBox): void {
    const emit = this.options.onSelectRegion
    const data = this.data
    if (emit === undefined || data === null) return
    if (this.turned !== null) {
      const span = this.turnedAxisSelection(box)
      if (span === null) return
      // The same window on both axes, and `diagonal` says so: a turned map is
      // one sequence against itself, so the region a band names is the square it
      // was rotated out of — which is the on-diagonal selection, arrived at
      // without the reader having to hold anything down for it.
      emit({
        rows: span,
        cols: span,
        diagonal: true,
        level: data.level,
        anchor: this.squareCell(box.anchor),
      })
      return
    }
    const rowGroup = groupAt(data.rowGroups, box.anchor.row)
    const colGroup = groupAt(data.colGroups, box.anchor.col)
    if (rowGroup === undefined || colGroup === undefined) return

    const level = data.level
    const sameBlock = rowGroup.label === colGroup.label && rowGroup.start === colGroup.start
    if (level !== 'bin') {
      // A cell *is* the unit here, so same block is the whole of same window.
      emit({
        rows: { label: rowGroup.label },
        cols: { label: colGroup.label },
        diagonal: sameBlock,
        level,
        anchor: box.anchor,
      })
      return
    }
    const rows = this.axisSelection(rowGroup, box.rows, data.rowExtent[0])
    const cols = this.axisSelection(colGroup, box.cols, data.colExtent[0])
    if (rows === null || cols === null) return
    emit({ rows, cols, diagonal: sameBlock && onDiagonal(box), level, anchor: box.anchor })
  }

  /**
   * One axis of a selection: the block, and the base pairs of it the box covers.
   *
   * The last bin of a contig is usually a short one, so the bin arithmetic runs
   * past the end of the sequence — `VII` at 2 kb is 546 bins, which is
   * 1,092,000 bp against a chromosome of 1,090,940 — and the region built from
   * that is refused as out of bounds by the very reader that would open it. The
   * contig's own length has the last word wherever the reader has sent one.
   */
  private axisSelection(
    group: AxisGroup,
    span: [number, number],
    blockStart: number,
  ): SelectedAxis | null {
    const lo = Math.max(span[0], group.start)
    const hi = Math.min(span[1], group.end)
    if (!(hi > lo)) return null
    const binsize = this.options.binsize
    const start = Math.max(0, bpWithin(group, lo, blockStart, binsize))
    const raw = bpWithin(group, hi, blockStart, binsize)
    const end = group.unitLength === undefined ? raw : Math.min(raw, group.unitLength)
    return { label: group.label, range: [start, end] }
  }

  /**
   * The place under the pointer, for whatever is not a map (§25.4).
   *
   * Two loci ordinarily — a contact is a pair, and the structure cell lights
   * both of its beads and draws the chord between them. **One** while the span
   * modifier is held, because that is the gesture the reader is in the middle
   * of: the crosshair has already stood up as a single line and the readout has
   * already stopped naming a contact, so a model still joining two beads is the
   * one surface left answering the question the pointer stopped asking. The one
   * place is the position along the diagonal, which is what the line is drawn
   * at and what the readout names.
   */
  private hoverPlaceFor(cell: Cell | null, span: boolean): HoverPlace | null {
    if (cell === null || this.data === null) return null
    if (span) {
      const along = alongAxis(this.squareCell(cell))
      const one = cellLoci(this.squareAxes, null, { row: along, col: along })
      return one === null
        ? null
        : { loci: [{ contig: one.rows.contig, bp: Math.round(one.rows.bp) }], source: HOVER_SOURCE_MAP }
    }
    const at = this.locusOf(cell)
    return at === null
      ? null
      : {
          loci: [
            { contig: at.rows.contig, bp: at.rows.bp },
            { contig: at.cols.contig, bp: at.cols.bp },
          ],
          source: HOVER_SOURCE_MAP,
        }
  }

  private describe(cell: Cell | null, at?: { x: number; y: number; span?: boolean }): void {
    // Recorded whatever happens: the lanes continue the crosshair through the
    // hovered column, and they can only do that if they are told it has moved.
    const moved =
      (this.hoverCell === null) !== (cell === null) ||
      (cell !== null && this.hoverCell !== null && (cell.row !== this.hoverCell.row || cell.col !== this.hoverCell.col))
    this.hoverCell = cell
    if (moved && this.lanes !== null && getPlotOptions().crosshair) this.schedule()
    // The deck puts a small mark at the same place on every other panel, so it
    // has to be told on every move — including the move off the edge, which is
    // what takes the other panels' marks away with the pointer.
    if (moved) this.hoverListener?.(cell === null ? null : { row: cell.row, col: cell.col })
    // …and the *place*, for whatever is not a map: a structure cell lights the
    // beads at both ends of the contact under the pointer (§25). Published as
    // loci rather than cells because a bead has no cell to be converted into,
    // and through the square block so a turned map names the contact it is
    // over rather than a band row and a half-bin.
    if (moved) setHoverPlace(this.hoverPlaceFor(cell, at?.span === true))
    // …and what it is over, in words: on the status line and on the card.
    this.readout.describe(cell, at)
  }
}

/**
 * Whether two resolved scales would paint the same legend.
 *
 * Every field the colourbar reads, and nothing else — a change of matrix with
 * an identical scale draws an identical bar.
 */
function sameColorScale(a: ColorScale, b: ColorScale | null): boolean {
  return (
    b !== null &&
    a.vmin === b.vmin &&
    a.vmax === b.vmax &&
    a.transform === b.transform &&
    a.colormap === b.colormap &&
    a.balanced === b.balanced
  )
}

/** The width below which the plot takes the whole column; `styles.css` agrees. */
const NARROW_QUERY = '(max-width: 34rem)'

/** How far inside the plot frame the key sits, in CSS pixels. */
const KEY_INSET = 6

/**
 * The narrowest picture the key may stand on, in CSS pixels.
 *
 * The key's own `max-width` — 14 rem, about 224 px — plus its inset: below
 * that the box is wider than the plot it is a key to, which is a legend with
 * the data behind it rather than beside it. Stated here rather than measured,
 * because the answer must not depend on how much text this particular key
 * happens to hold.
 */
const KEY_MIN_PLOT = 240

/**
 * Watch a media query, calling back with its state now and on every change.
 * Returns the teardown.
 */
function watchMedia(query: string, onChange: (matches: boolean) => void): () => void {
  const media = window.matchMedia?.(query)
  if (media === undefined) return () => {}
  const listener = (): void => onChange(media.matches)
  media.addEventListener?.('change', listener)
  onChange(media.matches)
  return () => media.removeEventListener?.('change', listener)
}

/**
 * Call `onChange` whenever the effective theme changes: either the explicit
 * `data-theme` override or, in its absence, the system preference. Returns the
 * teardown.
 */
function watchTheme(onChange: () => void): () => void {
  const media = window.matchMedia?.('(prefers-color-scheme: dark)')
  const observer =
    typeof MutationObserver === 'undefined'
      ? null
      : new MutationObserver(() => onChange())
  observer?.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
  const listener = (): void => onChange()
  media?.addEventListener?.('change', listener)
  return () => {
    observer?.disconnect()
    media?.removeEventListener?.('change', listener)
  }
}
