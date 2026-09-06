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
import { transparencyField } from './AnnotationCard'
import { KEYS, withKey } from './commands'
import { cardTitle, icon, iconButton } from './icons'
import {
  LANE_EDGES,
  drawsAProfile,
  hasAMovableAxis,
  placementOn,
  type AnnotationEntry,
  type FeatureSet,
} from '../annotations/types'
import type { AnnotationClient } from '../annotations/worker/client'
import { LABEL_MIN_SPAN_BP, MAX_CATEGORICAL_TICKS } from '../constants'
import {
  drawKey,
  formatCount,
  keyContent,
  keyTitle,
  type KeyContent,
} from '../render/legend'
import { laneGrowsInward, laneIsHorizontal } from '../render/lane'
import { locusAxisFrom, type LocusAxis, type LocusWindow } from '../render/locus'
import { formatLocus } from '../genome/assembly'
import {
  drawArrowheads,
  drawDiagonalFeatures,
  drawManualLines,
  drawManualRects,
  drawPairs,
  type OverlayAxes,
  type OverlayFrame,
} from '../render/overlays'
import {
  AnnotationLanes,
  LANE_GAP,
  type LaneEdge,
  type LaneGeometry,
  type MetaAxes,
  type MetaSource,
} from './AnnotationLanes'
import type { MetaBlock } from '../annotations/metadata'
import {
  COMPARE_OPS,
  alignable,
  combine,
  depthMatchDefault,
  isCompareOp,
  matchGain,
  type CompareOp,
} from '../render/compare'
import {
  deriveBlock,
  preferredTransform,
  type AxisRun,
  type DerivedValues,
  type Derivation,
  type Normalisation,
} from '../render/derive'
import { SMOOTH_CHOICES } from '../render/smooth'
import type { CorrelationField } from '../analysis/compartments'
import { isCancellation, type Cancellable } from '../worker/client'
import {
  BIN_FRACTION,
  anchorColumns,
  anchorRays,
  bandAt,
  binsForColumns,
  cellAt,
  cellLoci,
  isTurnable,
  rotateBlock,
  rowForSeparation,
  separationCoords,
  reachForRows,
  rowsForReach,
  separationForRows,
  turnDepthFor,
  turnedAxis,
  type RotateDirection,
  type RotatedBlock,
} from '../render/rotate'
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
  type AxisSpan,
  type AxisSpanSet,
  type AxisCoords,
  type Cell,
  type PlotOptions,
  type VerticalAnchor,
  type DrawnBox,
  type SelectionBox,
  type SelectionText,
  type SeparatorSet,
} from '../render/heatmap'
import { rasterStride } from '../render/heatmap'
import {
  refineEnabled,
  setRefineEnabled,
  subscribeRefine,
  type RefineView,
} from './refine'
import { ceilingFactor, nudgedLimits } from '../render/tracks'
import { inverseTransform, transformValue, type Scale } from '../render/scale'
import type { ColorScale, DenseMatrix, Extent, Separator, Transform } from '../types'
import type { AnalysisFraming } from '../analysis/types'
import { BLOCK_COPY_LIMIT_BYTES, type BlockInput } from '../analysis/worker/protocol'
import type { AxisGroup, MatrixResult } from '../worker/protocol'
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
import { Modal } from './Modal'
import { openFeatureDialog } from './FeatureDialog'
import {
  CEILING_LABEL,
  CEILING_MODIFIER,
  CEILING_STEP,
  DRAG_SLACK,
  LaneControls,
  colourInput,
} from './LaneControls'
import { LaneEditor } from './LaneEditor'
import {
  fieldPair,
  heightThatFills,
  laneSize,
  setTrackHeight,
  smallestLaneSize,
  trackHeightField,
} from './trackControls'
import { TRACK_DRAG_TYPE, dragHasFiles, dragHasTrack, el, field, fmt, trimNumber } from './dom'
import { dragHasFileRow } from './fileDrag'
import { filesFrom } from './chooseFiles'
import { MapKey } from './MapKey'
import {
  EXPORT_DPI_CHOICES,
  EXPORT_FORMATS,
  type ExportFormat,
  canvasToPng,
  captionStamp,
  copyPngToClipboard,
  copyTextToClipboard,
  downloadBlob,
  exportBaseName,
  fileStamp,
  largestDpiThatFits,
  readPageBackground,
  scaleForDpi,
} from './export'
import { openMenu, type MenuItem } from './Menu'
import { VectorPage } from './vector'
import { setReadout } from './readout'
import { revealTrack } from './revealTrack'
import {
  MATRIX_OPTIONS,
  PLOT_OPTION_ICONS,
  PLOT_OPTION_KEYS,
  PLOT_OPTION_LABELS,
  TRACK_OPTIONS,
  getPlotOptions,
  setPlotOption,
  subscribePlotOptions,
  type PlotOptionKey,
} from './plotOptions'
import { fitMapSize, getMapSize, setMapSize, subscribeMapSize } from './mapSize'
import { scaleFont, scaleLength, subscribeTextScale, textScaleField } from './textScale'
import {
  MIN_TURN_HEIGHT,
  MIN_TURN_WIDTH,
  fitTurnBox,
  getTurnBox,
  setTurnBox as rememberTurnBox,
  subscribeTurnBox,
  type TurnBox,
} from './turnBox'

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

/** A double arrow along the main diagonal: the line the view is put back on. */
const DIAGONAL_ICON = 'move-diagonal-2'

const DIAGONAL_HINT =
  'Recentre on the diagonal. Slides the view onto the nearest on-diagonal window at the zoom ' +
  'it is already at, without changing the region or the resolution. Every gesture that lands ' +
  'off the diagonal — a pan, a box, a zoom around the pointer — takes several more to come ' +
  'back from, and no drag can say “here, but on the diagonal”. Greyed on a block that has no ' +
  'diagonal, and while the map is turned, where the picture already is one.'

/** The band, as an ordinary dense block the renderer can be handed. */
function turnedDense(turned: RotatedBlock): DenseMatrix {
  return {
    nrows: turned.nrows,
    ncols: turned.ncols,
    values: turned.values,
    // The band's own extents, in the half-bin units its columns are counted in,
    // so anything downstream that measures a span in cells measures it in the
    // grid actually on screen.
    rowExtent: [0, turned.nrows],
    colExtent: [turned.originBin * 2, turned.originBin * 2 + turned.ncols],
  }
}

/** One end of the turned band's box, as a bar a hand can take hold of. */
/** One edge of the picture; see {@link MatrixPanel.grips}. */
type PlotEdge = 'top' | 'bottom' | 'left' | 'right'

/** Whether an edge is dragged along x or along y. */
function edgeAxis(edge: PlotEdge): 'x' | 'y' {
  return edge === 'left' || edge === 'right' ? 'x' : 'y'
}

function plotGrip(edge: PlotEdge): HTMLElement {
  const axis = edgeAxis(edge)
  return el('div', {
    class: `plot-grip plot-grip-${axis} plot-grip-${edge} hidden`,
    attrs: {
      role: 'separator',
      // Which way the *separator* lies, which is across the axis it travels on.
      'aria-orientation': axis === 'x' ? 'vertical' : 'horizontal',
      tabindex: '0',
    },
  })
}

const OE_HINT =
  'Observed over expected. Divide each cell by what its genomic distance predicts — the mean ' +
  'over every pair of bins that far apart, measured on this block, with one scalar between ' +
  'sequences. Contact frequency falls by orders of magnitude from the diagonal outwards and ' +
  'that decay is not what anybody is looking for; dividing it out makes the departures from it ' +
  'the picture. Drawn on a scale centred at 1, with a cell of nothing observed left as paper.'

const OE_ON_BASELINE_HINT =
  'The cells already are the expected values, so there is nothing left to divide by them — ' +
  'observed over expected of the baseline is 1 wherever it is anything. Choose another score to ' +
  'get the toggle back.'

const BASELINE_HINT =
  'The baseline `O/E` divides by, drawn instead of applied: every cell replaced by the mean of ' +
  'this block at that bin separation, with one scalar between each pair of sequences. Nothing ' +
  'but the distance decay is in it, which is what makes it worth a look — an O/E is only as ' +
  'trustworthy as the curve underneath it, and at long separations that curve is averaged over ' +
  'few cells and moves. Computed from the counts, so it is the denominator of `O/E` over ' +
  'counts; over `balanced` the same baseline is measured on those instead.'

/**
 * What a dragged box resolves to: one block, and how much of it.
 *
 * *One* block, not the rectangle the box covers, because that is the view a
 * selection is asking for. A square drawn across the corner of two chromosomes
 * on a whole-genome map is asking to look at a chromosome — it cannot be asking
 * for a region that spans two of them, since no such region exists — so it
 * resolves to the one the drag began in, ending at the edge of the box or at
 * the end of that chromosome, whichever comes first.
 *
 * `range` is absent above bin level, where a cell *is* a contig or a genome and
 * there is no position inside one to name.
 */
export interface SelectedAxis {
  /** The block this axis of the box falls in: a contig, or a genome. */
  label: string
  /** Base pairs within that block, clamped to it; absent above bin level. */
  range?: [number, number]
}

export interface SelectedRegion {
  rows: SelectedAxis
  cols: SelectedAxis
  /**
   * `true` when the box lies *on* the diagonal: the same block on both axes,
   * covering the same stretch of it.
   *
   * Not "the same block" — that was the first version of this and it is the
   * wrong question. A box in the top-right corner of one chromosome is two
   * different windows of the same sequence, and answering it with the row's
   * window alone hands back a square centred on the diagonal: the one place the
   * reader was deliberately not looking. Only when both windows coincide is
   * there a single region to open.
   */
  diagonal: boolean
  level: 'bin' | 'contig' | 'genome'
  /** The cell the drag began on, for a view that resolves blocks its own way. */
  anchor: Cell
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
  caption?: { file: string; genome?: string }
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
   * Put the scale controls **on the picture** rather than in a card.
   *
   * For a panel with no sidebar to put a card in — a companion in a deck (§16).
   * Deliberately not inferred from {@link detachedControls}, which every view
   * in the app sets: those views detach their cards only to move them into the
   * Aesthetics column, and a second copy of the same five fields in the corner
   * of the map would be two controls over one scale.
   */
  cornerControls?: boolean
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
   * Absent on every view of a `.metacool`, which is not a decision this panel
   * makes: the shell only supplies it for a file with no genome layer (§8.5).
   * With it absent the panel is byte for byte the panel it was before
   * annotations existed — no lanes, no listeners, no worker.
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
}

/**
 * The largest square the map will correlate, per axis.
 *
 * The correlation is `m²` correlations of `m` cells each — the one **cubic**
 * step in the viewer, where everything else it draws is linear in the cells on
 * screen. That changes what a limit is for: the other budgets in this file trade
 * detail against milliseconds, and this one is the difference between a wait and
 * a coffee break.
 *
 * Measured on an *E. coli* square, which is the shape the arithmetic cares about
 * and not the organism: **232 bins in 32 ms, 464 in 232 ms, 929 in 2.8 s**. That
 * is the clean eightfold per doubling the exponent promises, and extrapolating
 * it puts this cap at about **twelve seconds** — the most a reader will ever be
 * asked to wait, and only at the very top of the range.
 *
 * Twelve is tolerable here and would not be for a toggle that blocked: the job
 * is on the analysis thread, it reports a percentage, and unticking the box
 * cancels it. What the cap is really protecting against is the other end of the
 * curve — the block cap is 4,096 a side, which is **four minutes**, and a reader
 * who flipped a switch has not agreed to that.
 *
 * The number itself comes from what the picture is *for*. A compartment is a
 * megabase-scale object read at 50–500 kb bins, where a whole human chromosome
 * is 500–5,000 bins and a bacterial genome is well under a thousand; nobody
 * reads compartments at the resolution where this would be slow. Above the cap
 * the control is greyed **and says why**, which is a better answer than a
 * progress bar that never ends.
 *
 * `MAX_CORRELATION_BINS` in the compartments task is 8,192 for the same
 * quantity, and the difference is not an inconsistency: there a reader has
 * asked for a number and is waiting for it on purpose, and here they have
 * flipped a switch on a map they were reading.
 */
export const MAP_CORRELATION_BINS = 1500

const CORRELATE_HINT =
  'Replace the square by the Pearson correlation between its rows — the object a compartment ' +
  'eigenvector is computed from (§18.8). Two bins correlate when they contact the rest of the ' +
  'sequence in the same pattern, so the checkerboard this draws *is* the A/B compartments, and ' +
  'it is the same matrix the Compartments task solves. Implies `O/E`, since a correlation of ' +
  'anything else is a correlation of the distance decay, and balanced counts, since a ' +
  'correlation of unbalanced O/E is a correlation of the coverage bias. One file, square blocks, and up to ' +
  `${MAP_CORRELATION_BINS.toLocaleString()} bins a side: it is the one cubic step in the viewer, ` +
  'so it runs off the main thread — about 3 seconds at a thousand bins a side and eight times ' +
  'that for each doubling. Choosing another score cancels it.'

export interface ComparePresentation {
  /** The two file names, in order: above the diagonal, then below it. */
  labels: [string, string]
  /** How the two are put together — the split, or one derived field. */
  op: CompareOp
  onOpChange(op: CompareOp): void
  /**
   * Whether the second file's counts are scaled to the first's bright end, or
   * `undefined` where the reader has not said and the default stands.
   *
   * Three states rather than two, because the default is not a constant: it
   * depends on the operation and on whether the cells are balanced, and a plain
   * boolean could not tell "the reader wants it off" from "nobody has chosen
   * yet" — which is what made a ratio silently rescale itself. See
   * {@link HeatmapPanel.compareNormalising} for the rule and for why balanced
   * values want the opposite default from raw counts.
   */
  normalise?: boolean
  onNormaliseChange(on: boolean): void
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
   */
  loadOnEdge?(files: readonly File[], edge: LaneEdge): void
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
  pickOnEdge?(event: DragEvent, edge: LaneEdge): void
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
  /** The open feature card, so a second click replaces it rather than stacking. */
  private featureDialog: Modal | null = null
  /**
   * The store the lanes are drawn from.
   *
   * The session's, where the file has one. Where it has not — a file with a
   * genome layer carries no annotations at all (§8.5) — an empty one that
   * nothing persists, so that everything downstream of a store can be built
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
  /**
   * The four edges of the picture, as things a hand can take hold of.
   *
   * Bars rather than strips of live canvas, and visible on approach rather than
   * only under the pointer, because how big the picture is drawn is a decision
   * the reader has to be able to *find* — a gesture nobody can see is a gesture
   * nobody uses.
   *
   * Which of them are shown, and what a drag on one means, is the whole of the
   * difference between the two presentations:
   *
   * - **A square map** shows all four, and every one sets the same number — the
   *   side of the box (`ui/mapSize.ts`). A square block has no shape to choose,
   *   so a box of another shape would be paper down two sides of the picture.
   * - **A band** shows three. Its width and its depth are separate numbers
   *   (`ui/turnBox.ts`), and its fourth edge is the diagonal itself: the band
   *   stands on the axis, so there is nothing to drag there. Which of the
   *   horizontal pair is the far edge follows the direction the band grows in —
   *   up on an ordinary turn, down on the mirrored half of a comparison.
   */
  private readonly grips: Record<PlotEdge, HTMLElement> = {
    top: plotGrip('top'),
    bottom: plotGrip('bottom'),
    left: plotGrip('left'),
    right: plotGrip('right'),
  }
  /** Which presentation the grips are labelled for; see {@link placeGrips}. */
  private gripMode: 'square' | 'band' | null = null
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
  private laneHoverListener:
    | ((at: { axis: 'rows' | 'cols'; unit: number } | null) => void)
    | null = null
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
   * The scale menu on the picture, for a panel with no card in a sidebar.
   *
   * `null` on the session's own map, which has the Aesthetics column: one
   * control over one scale, or the two disagree about which of them the reader
   * last touched.
   */
  private readonly settingsEl: HTMLElement | null
  /** Whether the window is too narrow for a key over the picture. */
  private narrow = false
  private readonly heatmap: HeatmapView
  private readonly tooltip: HTMLElement
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
  private readonly unsubscribeTurnBox: () => void
  private readonly unsubscribeMapSize: () => void
  private readonly themeWatchers: () => void
  private readonly narrowWatcher: () => void
  private readonly observer: ResizeObserver | null
  private readonly exportStatus: HTMLElement
  private exportDpi = 300
  private exportFormat: ExportFormat = 'pdf'
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
   * The second file's block, when one is open, and the factor applied to it.
   *
   * Kept beside the merged values rather than only merged into them, because a
   * reader hovering a cell wants *both* numbers — the whole question a compared
   * map asks is how the two differ here — and after the merge only one of them
   * is still in the matrix.
   */
  private second: { data: MatrixResult; gain: number } | null = null
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
  /** The recentre control, greyed where there is no diagonal to go to. */
  private diagonalButton: HTMLElement | null = null
  /** The adaptive-resolution switch, and its unsubscribe. */
  private refineButton: HTMLElement | null = null
  private stopRefineWatch: (() => void) | null = null
  /** The O/E control, lit from {@link setDerive} rather than from its own click. */
  private expectedButton: HTMLElement | null = null

  /**
   * The despeckle picker, lit from {@link setDerive} for the O/E toggle's
   * reason: the setting is the session's and can move from a link.
   *
   * `null` on a panel that was not given {@link DerivePresentation.onSmoothChange}
   * — a deck companion, which draws the smoothing and does not offer it.
   */
  private smoothSelect: HTMLSelectElement | null = null

  /**
   * Which block the values in {@link correlation} were measured on.
   *
   * Bumped on every {@link setData}, and that is what the counter is *for*: the
   * cache key is otherwise made of shapes and extents, and a reader switching
   * from balanced counts to raw ones is re-read on the identical grid. Every
   * field of the key would match and the correlation of the previous quantity
   * would be drawn under the new one's caption.
   */
  private blockGeneration = 0

  /** The last correlation computed, and the key it answers. */
  private correlation: { key: string; field: CorrelationField } | null = null

  /** The one in flight, if any, and the key it will answer. */
  private correlating: { key: string; job: Cancellable<CorrelationField> } | null = null

  /**
   * The veil's text while a correlation runs, or `null`.
   *
   * Held apart from {@link setBusy}'s own argument because the two waits nest:
   * `setData` clears the veil as it finishes, and the job it started on the way
   * through has seconds still to run. Without this the map came back from a read
   * looking finished and then changed under the reader some seconds later.
   */
  private correlationNote: string | null = null
  /** The last title {@link setData} was given, so a turn can re-run it. */
  private lastTitle = ''
  /** The room the box has, measured once per resize. See {@link measureRoom}. */
  private room: { width: number; height: number } | null = null
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
  private transform: Transform
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
   * Built unconditionally, including on a file that carries no annotations
   * (§8.5), where they stay empty. The gate decides what can be *put* in the
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
   * Held for {@link measureRoom}, which reads the height a square map would have
   * claimed off this element's `max-height`: the one place the layout writes
   * that number as a length rather than as the `clamp()` it comes from.
   */
  private readonly wrap: HTMLElement
  /** The cell under the pointer, so the lanes can continue the crosshair. */
  private hoverCell: Cell | null = null
  /**
   * Where the pointer is over a lane stack, in that stack's canvas pixels.
   *
   * The hairline this drives runs across the lanes *and* the map, which is why
   * it is held here rather than inside {@link lanes}: the map's half is painted
   * through the overlay hook, and both halves have to come from one number or
   * they would meet at a kink.
   */
  private laneHover: { edge: LaneEdge; along: number } | null = null
  /**
   * The lane whose far border the pointer is on, so the rule can be drawn.
   *
   * Drawn rather than shown as a cursor, which is the rule this canvas already
   * follows: the pointer is the arrowhead everywhere here, so an affordance that
   * lived in the cursor would not exist. Same accent rule the 1D browser marks
   * its own lane borders with, because it is the same gesture on the same kind
   * of edge.
   */
  private laneBorder: string | null = null
  /**
   * The lane the pointer is on, which is the one that shows its handle.
   *
   * The whole lane and not the handle's own few pixels: a control nobody can see
   * until they are already on it is one nobody finds. It appears the moment the
   * pointer crosses the track it belongs to, which is also the moment the reader
   * could plausibly want to move that track.
   */
  private laneHandle: string | null = null
  /**
   * Set while a lane is being dragged by its handle.
   *
   * The tooltip reads from `mousemove`, which keeps arriving through a pointer
   * drag: without this, moving a track out to a rectangle carried a readout of
   * the position it started from across the map with it, naming a value on a
   * lane the reader had stopped looking at.
   */
  private laneGripping = false
  /**
   * The two edge rectangles, by the edge they stand for.
   *
   * Kept because two gestures aim at them and only one of them is a DOM event
   * on the zone itself: a file drop is, and a lane dragged off its own stack is
   * not — that drag holds the pointer captured on a canvas, so the zone under
   * the pointer has to be found by arithmetic. Empty when the panel has no
   * annotations and therefore no lanes.
   */
  private readonly edgeZones = new Map<LaneEdge, HTMLElement>()
  /**
   * The layer of controls over each lane stack, and the caret that opens in one.
   *
   * Positioned against {@link grid} rather than given a grid area of their own.
   * `.panel-grid`'s tracks are sized from their content, so a sized child sharing
   * a lane's cell would inflate that track and shrink the map; laid over the grid
   * absolutely, and offset each frame by the canvas's own position in it, they
   * take no space at all. It is the same conversion `placeTooltip` performs, for
   * the same reason.
   */
  private readonly laneLayers = new Map<LaneEdge, HTMLElement>()
  private readonly laneControls = new Map<LaneEdge, LaneControls>()
  private laneEditor: LaneEditor | null = null
  /**
   * The lane whose ceiling is being dragged, and how far it has moved.
   *
   * Held here rather than written to the store on every frame, and that is what
   * makes the gesture readable: the store is what the *faded* copy is drawn
   * from, so it has to stand still while the hand moves. One write, on release.
   */
  private laneScaling: { id: string; factor: number } | null = null
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
  /** The tooltip's fixed nodes; only their text changes (see {@link describe}). */
  private readonly tip: {
    matrix: HTMLElement
    rowGenome: HTMLElement
    genomeTimes: HTMLElement
    colGenome: HTMLElement
    genomes: HTMLElement
    rowName: HTMLElement
    times: HTMLElement
    colName: HTMLElement
    pos: HTMLElement
    distance: HTMLElement
    count: HTMLElement
    /** The lane tooltip's block: a heading and however many lines it has. */
    lane: HTMLElement
    laneTitle: HTMLElement
    laneLines: HTMLElement
  }
  /** Cached geometry for {@link positionTooltip}; never read during a pointer move. */
  private tipSize = { width: 0, height: 0 }
  private hostSize = { width: 0, height: 0 }
  private tipAt: { x: number; y: number } | null = null
  private tipFrame = 0
  /** Teardowns for the lane canvases' own pointer listeners. */
  private readonly laneListeners: Array<() => void> = []
  /** The stack thicknesses the stylesheet was last told about, per edge. */
  private laneBudget: Record<LaneEdge, number> = { top: -1, right: -1, bottom: -1, left: -1 }
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
    this.level = options.initial?.level ?? 'bin'

    this.canvas = el('canvas', { class: 'heatmap-canvas' })
    // A tooltip follows the pointer with the same three facts as the readout.
    // Both exist on purpose: the tooltip answers "what is under my cursor"
    // without a glance away from the matrix, and the readout keeps the last
    // answer visible after the pointer has moved on.
    // Two shapes in one card: the matrix's row × column × count, and a lane's
    // heading with however many lines the feature under the pointer has. One
    // element rather than two, because there is one pointer and it can only be
    // over one of them — and because the placement logic is fiddly enough that
    // a second copy of it would drift.
    this.tip = {
      matrix: el('div', { class: 'cell-tip-block' }),
      rowGenome: el('span', { class: 'cell-tip-name' }),
      genomeTimes: el('span', { class: 'cell-tip-x', text: '×' }),
      colGenome: el('span', { class: 'cell-tip-name' }),
      genomes: el('div', { class: 'cell-tip-pair cell-tip-genomes hidden' }),
      rowName: el('span', { class: 'cell-tip-name' }),
      times: el('span', { class: 'cell-tip-x', text: '×' }),
      colName: el('span', { class: 'cell-tip-name' }),
      pos: el('div', { class: 'cell-tip-pos' }),
      distance: el('div', { class: 'cell-tip-distance hidden' }),
      count: el('div', { class: 'cell-tip-count' }),
      lane: el('div', { class: 'cell-tip-block hidden' }),
      laneTitle: el('div', { class: 'cell-tip-title' }),
      laneLines: el('div', { class: 'cell-tip-lines' }),
    }
    this.tip.genomes.append(this.tip.rowGenome, this.tip.genomeTimes, this.tip.colGenome)
    this.tip.matrix.append(
      // The genome leads, where there is one: it is the coarser fact, and on a
      // metagenome it is the one that says what you are looking at. The contig
      // under it is the finer answer to the same question.
      this.tip.genomes,
      el('div', { class: 'cell-tip-pair' }, this.tip.rowName, this.tip.times, this.tip.colName),
      this.tip.pos,
      this.tip.distance,
      this.tip.count,
    )
    this.tip.lane.append(this.tip.laneTitle, this.tip.laneLines)
    this.tooltip = el('div', { class: 'cell-tip hidden' }, this.tip.matrix, this.tip.lane)
    this.titleNode = el('h2', { class: 'panel-title', text: '' })
    this.overlay = el('div', { class: 'panel-overlay hidden' })

    // The lanes and the store behind them, before anything that can *ask* about
    // them: the first scheduled frame measures the stacks, and it runs while
    // the constructor is still building the cards below. Only the canvases are
    // made here; where they are mounted and what listens to them comes later.
    //
    // Where the file has no annotation machinery there is still a store, empty
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

    this.clip = new ClipRange({
      onChange: (clip) => {
        this.manualVmin = clip?.vmin
        this.manualVmax = clip?.vmax
        this.rescale()
      },
      // The boxes are in transformed units; the caption says what those are in
      // the units the colourbar and the tooltip use.
      format: (value) => formatCount(inverseTransform(value, this.transform)),
    })

    /**
     * The fields that answer *what are these numbers, and how are they drawn* —
     * the score, the baseline, the transform, the ramp and the clip.
     *
     * Collected apart from the rest because a panel with no card to put a card
     * in carries exactly these and none of the others (see {@link settingsEl}).
     * The same nodes, not copies: a second set of widgets over one scale is two
     * controls that drift.
     */
    const valueFields: HTMLElement[] = []
    const controls: HTMLElement[] = [
      field('transform', transformSelect, 'Value transform, matching `metacooler show --transform`.'),
      field('colormap', colormapSelect, '`afmhot_r` is what `metacooler show` draws (§7.1).'),
      // Not `field()`: that wraps its control in a `<label>`, and a label around
      // four inputs and a button focuses whichever one it feels like.
      el(
        'div',
        {
          class: 'field field-clip',
          title:
            'Where the colourmap starts and saturates, in transformed units. ' +
            'Auto is the §7.1 default: 0 to the 99th percentile of the values in view.',
        },
        el('span', { class: 'field-label', text: 'clip' }),
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
        field(
          'smooth',
          smoothSelect,
          'Replace each cell by the mean of the cells around it, itself included — the box ' +
            'filter Hi-C figures are usually made with. Applied to each file before two are ' +
            'compared, and before the O/E division, so a ratio is ' +
            '`smooth(A) / smooth(B)`: the cells that were empty in one file stop being empty, ' +
            'and the saturated single pixels a sparse ratio is made of are never produced. ' +
            'Single-cell features are averaged away with them, which is why it is off by default. ' +
            'The three adaptive settings size each window separately, widening it where the ' +
            'counts thin out — which is away from the diagonal, where a fixed window averages ' +
            'mostly empty cells and stays noisy. Each starts at the fixed window above it.',
        ),
      )
    }

    valueFields.push(...controls)

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

    // Saving a figure is one question with three parts — how fine, what file,
    // go — so it is one row: resolution, format, and the button that acts on
    // both. Two buttons labelled by format made the choice of file into the
    // action itself, which left the resolution stranded in a row of its own two
    // lines above the thing it applied to.
    const dpiSelect = el('select', {
      class: 'select',
      title: 'Dots per inch of the saved figure. 96 is what is on screen; 300 is print.',
    })
    for (const dpi of EXPORT_DPI_CHOICES) {
      dpiSelect.appendChild(el('option', { value: String(dpi), text: `${dpi} dpi` }))
    }
    dpiSelect.value = String(this.exportDpi)
    dpiSelect.addEventListener('change', () => {
      this.exportDpi = Number(dpiSelect.value)
    })

    const formatSelect = el('select', {
      class: 'select',
      title:
        'PDF is a one-page document holding the figure losslessly, at the size the DPI implies; ' +
        'PNG is the same picture as an image.',
    })
    for (const format of EXPORT_FORMATS) {
      formatSelect.appendChild(el('option', { value: format, text: format.toUpperCase() }))
    }
    formatSelect.value = this.exportFormat
    formatSelect.addEventListener('change', () => {
      this.exportFormat = formatSelect.value as ExportFormat
    })

    this.exportStatus = el('span', { class: 'clip-note export-note' })

    // Its own card, and the first one, because saving the figure is not a
    // property of the picture — it is the thing a reader does *after* every
    // other control on this panel is where they want it. Buried at the foot of
    // the Plot card it was three folds and a scroll away from the top of a
    // column whose other two cards are settings; a reader who came to export
    // had to walk past everything they had already decided.
    this.exportEl = el(
      'div',
      { class: 'controls-card' },
      cardTitle('Export', 'download', 'controls-title'),
      el(
        'div',
        { class: 'panel-controls' },
        el(
          'div',
          { class: 'export-row' },
          dpiSelect,
          formatSelect,
          iconButton(
            'download',
            withKey(
              'Save the figure, at the resolution and in the format chosen beside this',
              KEYS.savePlot,
            ),
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
        // The same box the browser's Tracks card carries, applying the same rule
        // to the same tracks: the two are one decision taken two ways — fill the
        // window, or this many pixels — and a reader who has just stretched two
        // lanes into two four-hundred-pixel strips reaches for this immediately
        // afterwards.
        ...(options.annotations === undefined
          ? []
          : [trackHeightField((px) => this.setTrackHeight(px))]),
        // The four that draw on the matrix used to sit under these, in the same
        // card, separated by a label — and a label is not a card. They are in
        // Map now, beside the transform and the colourmap they belong with;
        // stored together all the same, so a crosshair turned off here is off in
        // the 1D browser too, since it is the same preference about the same
        // gesture.
        el(
          'div',
          { class: 'field field-block' },
          el('span', { class: 'field-label', text: 'overlays' }),
          el('div', { class: 'plot-icon-row' }, ...TRACK_OPTIONS.map(optionToggle)),
        ),
        // The two legibility numbers on one line, because they are one question
        // asked twice — how easily can this picture be read — and the second is
        // the same control the browser's Tracks card carries, writing the same
        // field of the same store: a reader who faded the tracks beside the map
        // and then closed it finds them faded in the browser, which is what
        // "these are the same tracks" has to mean.
        this.options.annotations === undefined
          ? textScaleField()
          : fieldPair(textScaleField(), transparencyField(this.options.annotations.store)),
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
      // Put away now, not on the next pointer move: a control that needs the
      // hand to twitch before it takes effect reads as not having worked.
      if (!options.tooltip) this.tooltip.classList.add('hidden')
    })
    // Every panel, not only the one whose handle was dragged: the box is the
    // session's, so a deck of bands is one shape (§17.3).
    this.unsubscribeTurnBox = subscribeTurnBox(() => this.applyTurnBox())
    // The square map's own size, on the same terms and through the same call: one
    // reader, one shape, however many pictures are drawn from it.
    this.unsubscribeMapSize = subscribeMapSize(() => this.applyTurnBox())

    // Offered whenever there is more than one answer. A file with no weights and
    // no extra columns has exactly one thing its cells can be, and a dropdown
    // with a single entry is a control that cannot be used — it says "you have a
    // choice here" and then refuses to make one.
    const scores = options.scores
    if (scores !== undefined && scores.choices.length > 1) {
      const select = el('select', { class: 'select' })
      this.scoreSelect = select
      for (const choice of scores.choices) {
        const option = el('option', { value: choice.id, text: choice.label })
        // One entry in this list is a pipeline rather than a reading, and the
        // field's own hint below has no room to say what it does or what it
        // refuses. Per-option, because it is the only one that needs it.
        if (choice.correlate === true) option.title = CORRELATE_HINT
        if (choice.baseline === true) option.title = BASELINE_HINT
        select.appendChild(option)
      }
      select.value = scores.current
      select.addEventListener('change', () => {
        const picked = scores.choices.find((choice) => choice.id === select.value)
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
      const scoreField = field(
        'score',
        select,
        'What the cells are. `counts` is the stored pixel value; `balanced` multiplies each ' +
          'cell by its two bin weights — cooler`s balanced matrix, in which bins the balancer ' +
          'dropped have no weight and show as blank. Below those are the ones computed here ' +
          'from the block on screen — `VC`, `VC √` and `ICE` correct the coverage, `expected` ' +
          'replaces every cell by the distance decay `O/E` divides by, and `correlation` ' +
          'replaces the square by the compartment matrix — each with its own note on hover. ' +
          'Last come any further columns this file carries in /pixels, under their own names.',
      )
      // **First in both**, and not merely first in the card. It leads the Map
      // card because it is the question the other three answer *about* — what
      // the numbers are, before how they are transformed, ramped and clipped —
      // and a corner menu that put it last was the same five fields in a
      // different order on a companion. `unshift` on each, so the two lists
      // cannot drift the next time one of them gains a field.
      valueFields.unshift(scoreField)
      controls.unshift(scoreField)
    }

    if (options.compare !== undefined) {
      const compare = options.compare
      // Under every operation, not only the split. It used to be hidden under a
      // ratio and a difference on the grounds that they force it on — but the
      // force was itself the bug ({@link compareNormalising}), and a rescale a
      // reader can neither see nor switch off is the one kind of arithmetic a
      // viewer must not do to a quantitative field. The setting now starts where
      // the operation and the units say it should and moves when they say so.
      {
        const normalise = el('input', { class: 'checkbox', type: 'checkbox' })
        normalise.checked = this.compareNormalising(compare.op)
        normalise.addEventListener('change', () => compare.onNormaliseChange(normalise.checked))
        controls.unshift(
          field(
            'match depth',
            normalise,
            `Scale ${compare.labels[1]}'s counts so its 99th percentile meets ${compare.labels[0]}'s. ` +
              'Under `split` that makes the two triangles saturate together; off, one colour is one ' +
              'count on both sides of the diagonal — the stronger claim, and wrong to read when the ' +
              'files differ in depth. Under `ratio` and `difference` it divides that difference out ' +
              'of every cell, which raw counts want and balanced values do not: balanced matrices ' +
              'already share ICE`s normalisation, and the factor is measured on the near-diagonal ' +
              'cells where two conditions actually differ — so it shifts the whole map by the ' +
              'finding. On for counts, off for balanced, unless set here.',
          ),
        )
      }

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
          `How the two files are put together. \`split\` draws ${compare.labels[0]} above the ` +
            `diagonal and ${compare.labels[1]} below it, each in its own counts. \`ratio\` and ` +
            '`difference` draw one derived field over the whole square, on a scale centred where ' +
            'the two agree — the disagreement is then the only thing with any colour in it. Both ' +
            'match depth automatically, since otherwise the picture is the depth difference.',
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

    // First of the three, because it is the one that decides what the other two
    // are *of*: the turn changes the geometry and `O/E` changes the units, and
    // both of those are read off whatever grid the picture is on. Off by
    // default (`ui/refine.ts`), so this is the control that turns it on rather
    // than a light that happens to be lit.
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
      // picture of the diagonal and this one *goes to* it, and in a deck the
      // panels' windows are locked together, so one of them moving to the
      // diagonal takes the rest with it. A companion, which draws the turn
      // without owning the control, has no more business owning this one.
      //
      // An action rather than a toggle — there is no state to read off it — so
      // it takes neither `btn-toggle` nor a lit state, and it is the one mark in
      // these rows that means "do this" instead of "this is on".
      const diagonalButton = iconButton(
        DIAGONAL_ICON,
        DIAGONAL_HINT,
        () => {
          this.heatmap.centreOnDiagonal()
        },
        { class: 'btn btn-icon', size: 15 },
      )
      this.diagonalButton = diagonalButton
      // Disabled until a block says otherwise: the panel is built before
      // anything is read, and a control that is live before there is a picture
      // to move is one that does nothing when pressed.
      this.paintDiagonal(false)
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

    // The four marks that draw on the matrix, in the card about the matrix.
    // They spent a release at the bottom of the Tracks card under a label reading
    // "matrix", two rows below four buttons that do nothing to it — which is a
    // card apologising for holding the wrong things.
    //
    // Refit leads the row rather than sitting in a row of its own above it. Five
    // marks fit across the column, and one mark alone under a heading of its own
    // reads as a category with one member in it — the row was mostly the empty
    // space beside the button. It goes first because it is the one that *acts*;
    // the four after it are states.
    controls.push(
      el(
        'div',
        { class: 'field field-block' },
        el('span', { class: 'field-label', text: 'overlays' }),
        el(
          'div',
          { class: 'plot-icon-row' },
          iconButton(
            'maximize',
            'Undo every pan and zoom (0, or a double click on the plot)',
            () => this.fit(),
            { class: 'btn btn-icon', size: 15 },
          ),
          ...MATRIX_OPTIONS.map(optionToggle),
        ),
      ),
    )

    // A panel with no sidebar of its own carries its scale controls **on the
    // picture**: a button in the bottom-left corner of the map, and a menu that
    // opens up over it. What used to be there was a `colour and export` fold
    // *under* the map, which pushed every panel of a deck down by the height of
    // whatever was open in the one beside it and put a second export control on
    // screen for a figure nobody had asked to save. The menu holds the five
    // fields that say what the numbers are and how they are drawn, and nothing
    // else — the overlay marks act on a picture the reader is pointing at, and
    // reaching them through a menu is slower than the row they came from.
    this.settingsEl =
      options.cornerControls !== true
        ? null
        : el(
            'div',
            { class: 'map-settings hidden', attrs: { role: 'dialog' } },
            ...valueFields,
          )
    this.controlsEl = el(
      'div',
      { class: 'controls-card' },
      // "Map", not "View": the card beside it is about the tracks, and both of
      // them are views of something. This one is the matrix.
      cardTitle('Map', 'sliders-horizontal', 'controls-title'),
      // The value fields are in the corner menu where there *is* one, and in
      // this card where there is not — never in both, because a node has one
      // parent. Appending the same five to each moved them into whichever
      // container was built second, which is this one, so the corner menu
      // opened empty and a companion's only scale controls were in a card it
      // never mounts. One set of widgets is still the rule (see
      // {@link settingsEl}); this decides where that one set lives.
      el(
        'div',
        { class: 'panel-controls' },
        ...(this.settingsEl === null
          ? controls
          : controls.filter((node) => !valueFields.includes(node))),
      ),
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
    this.keySlot = el('div', { class: 'map-key-slot' }, this.key.el, this.key2.el)
    const wrap = (this.wrap = el(
      'div',
      { class: 'heatmap-wrap' },
      this.canvas,
      this.overlay,
      this.keySlot,
      this.grips.top,
      this.grips.bottom,
      this.grips.left,
      this.grips.right,
      ...(this.settingsEl === null ? [] : [this.settingsCorner(this.settingsEl)]),
      ...LANE_EDGES.map((edge) => this.edgeZone(edge)),
    ))
    this.watchGrips()

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
      ...this.laneLayers.values(),
      this.tooltip,
    )
    this.laneEditor = new LaneEditor({
      host: this.grid,
      store: this.laneStore,
      shownLimits: (id) => this.lanes.shownLimits(id),
      onChange: () => this.schedule(),
    })
    for (const edge of LANE_EDGES) {
      const canvas = this.lanes.canvasFor(edge)
      // No drawn pointer on a stack, ever, and unconditionally rather than under
      // the crosshair preference. A lane puts a hairline under the pointer the
      // moment it is over the canvas at all — its own, not the map's echo, and
      // deliberately not under that preference, because it is the direct answer
      // to a gesture being made right now (`ui/AnnotationLanes.ts`). So there is
      // always a line here saying where the hand is, and the arrowhead over it
      // is a second mark for the same base pair. The map is the conditional one:
      // it has gutters, and a gutter holds no cell to draw a crosshair at
      // (`render/heatmap.ts`'s `syncGuidedCursor`).
      canvas.classList.add('is-guided')
      this.watchLane(edge, canvas)
    }
    this.watchEdgeDrops()
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
      this.keySlot.classList.toggle('hidden', narrow)
      this.schedule()
    })

    this.observer =
      typeof ResizeObserver === 'undefined'
        ? null
        : new ResizeObserver(() => {
            // The *grid* is what is observed, not the plot: it is the tooltip's
            // positioning parent, and it is the box that changes when a lane
            // appears — which the plot's own size does not.
            this.hostSize = { width: this.grid.clientWidth, height: this.grid.clientHeight }
            // Room *and* box, which is what a lane appearing has to change: the
            // stack beside the map takes from the same width the band is drawn
            // in, and re-measuring without redrawing left the band overlapping
            // the tracks that had just arrived under it.
            this.refit()
            this.heatmap.resize()
            this.placeKey()
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
      this.hostSize = { width: this.grid.clientWidth, height: this.grid.clientHeight }
      this.measureRoom()
      this.heatmap.setPalette(readCanvasPalette(this.canvas))
      this.heatmap.resize()
      this.placeKey()
      this.schedule()
    })
  }

  /**
   * One of the two rectangles inside the map that a track lands on.
   *
   * Three gestures aim at them: a file dropped from the desktop, a row dragged
   * out of the Tracks card, and a lane dragged by the handle on its own picture.
   * All three mean the same thing — *this track, on that edge* — so they are one
   * target rather than three.
   *
   * Invisible and inert until a drag is under way, which is the whole trick: the
   * map's own gestures — pan, the Option-drag selection, the click that opens a
   * cell — happen in the same pixels, and a target that was always live would eat
   * all three along the bottom edge.
   */
  private edgeZone(edge: LaneEdge): HTMLElement {
    const zone = el(
      'div',
      { class: `lane-drop lane-drop-${edge}` },
      el('span', { class: 'lane-drop-label', text: EDGE_WORDS[edge] }),
    )
    this.edgeZones.set(edge, zone)
    zone.addEventListener('dragover', (event) => {
      if (!this.acceptsDrag(event)) return
      // Both, and in this order: the default action for a dropped file is to
      // navigate the window to it, and the panel above is not the one that
      // decides where this file goes.
      event.preventDefault()
      event.stopPropagation()
      // A row dragged out of the Tracks card is being *moved*, and saying so is
      // what stops the pointer showing a copy cursor over the target.
      if (event.dataTransfer !== null && dragHasTrack(event)) {
        event.dataTransfer.dropEffect = 'move'
      }
      zone.classList.add('over')
    })
    zone.addEventListener('dragleave', () => zone.classList.remove('over'))
    zone.addEventListener('drop', (event) => {
      zone.classList.remove('over')
      this.grid.classList.remove('is-dropping')

      // A track already loaded, dragged here by its grip to change which edge it
      // is drawn on. A move rather than a copy: the other edge is cleared, which
      // is what dragging a thing from one place to another means. `location` in
      // the row's settings is the same field, for the reader who wants both.
      const moved = event.dataTransfer?.getData(TRACK_DRAG_TYPE) ?? ''
      if (moved !== '') {
        event.preventDefault()
        if (this.laneStore.byId(moved) !== undefined) {
          // This panel's own map, as the grip drag is: a track carried onto the
          // third replicate's edge belongs on the third replicate.
          this.laneStore.placeAt(moved, this.mapId, placementOn(edge))
        }
        return
      }

      const load = this.options.annotations?.loadOnEdge
      // A row out of the Files panel: the same aim, at a file whose bytes have
      // not been fetched yet. Resolved by the session, because resolving it here
      // would mean this panel knowing how a folder is read.
      if (dragHasFileRow(event)) {
        const pick = this.options.annotations?.pickOnEdge
        if (pick === undefined) return
        event.preventDefault()
        pick(event, edge)
        return
      }
      const files = filesFrom(event.dataTransfer)
      // Untouched where this file cannot carry tracks at all (§8.5). The shell
      // stands aside for a `.lane-drop` target, so claiming a drop we cannot
      // answer would swallow it — and a `.cool` dropped on a metacool's map is
      // still a file the session knows how to open.
      if (files.length === 0 || load === undefined) return
      event.preventDefault()
      // Not stopped: the shell's content-wide handler has to see this drop to
      // put its own highlight away, and it stands aside for a `.lane-drop`
      // target exactly as it does for the picker's zone — so the files are
      // loaded once, here, with the edge the reader aimed at.
      load(files, edge)
    })
    return zone
  }

  /**
   * Whether one of the rectangles will answer for this drag.
   *
   * A lane being moved always: that gesture is about which edge a lane is drawn
   * on, and every file has lanes. A *file* only where one can be loaded — the
   * rectangles are inside the map and the shell hands a drop on them to this
   * panel, so lighting them up for a drag we would ignore is a target that eats
   * the file.
   */
  private acceptsDrag(event: DragEvent): boolean {
    if (dragHasTrack(event)) return true
    if (dragHasFileRow(event)) return this.options.annotations?.pickOnEdge !== undefined
    return dragHasFiles(event) && this.options.annotations?.loadOnEdge !== undefined
  }

  /**
   * Show the two zones while a file is being dragged over the map, and only
   * then.
   *
   * On the grid rather than on the zones themselves, because a zone that is
   * invisible cannot be dragged *onto* — the reader has to see it appear while
   * the pointer is still over the middle of the map, which is where a drag from
   * the desktop arrives.
   *
   * The grid and not `this.el`, for two reasons, and the first one is not a
   * matter of taste: this runs from the constructor, where `this.el` has not
   * been built yet, and reading it there threw — which took the whole panel down
   * for every file that *has* annotations, so a cooler rendered nothing and a
   * metacool, which has none (§8.5), was fine. The grid is also the honest
   * scope: it is the box holding the map, its lanes and these zones, while
   * `this.el` reaches the colourbar and the header, where a drag means nothing.
   */
  private watchEdgeDrops(): void {
    const show = (event: DragEvent): void => {
      if (!this.acceptsDrag(event)) return
      this.grid.classList.add('is-dropping')
    }
    const hide = (event: DragEvent): void => {
      // A drag crossing from the map onto a zone leaves the grid by the letter
      // of the event and not in fact; the related target is what tells the two
      // apart, and `null` (leaving the window) is a real departure.
      const to = event.relatedTarget
      if (to instanceof Node && this.grid.contains(to)) return
      this.grid.classList.remove('is-dropping')
    }
    this.grid.addEventListener('dragenter', show)
    this.grid.addEventListener('dragover', show)
    this.grid.addEventListener('dragleave', hide)
    this.grid.addEventListener('drop', () => this.grid.classList.remove('is-dropping'))
    // A row dragged out of the Tracks card and then abandoned — Escape, or a
    // release over nothing — ends with `dragend` on the row and no event of any
    // kind here, so without this the two rectangles would stay up until the next
    // drag. On the window because the row is not in this panel's tree.
    const done = (): void => this.grid.classList.remove('is-dropping')
    window.addEventListener('dragend', done)
    this.laneListeners.push(() => window.removeEventListener('dragend', done))
  }

  /**
   * Open the card for one feature, replacing any card already open.
   *
   * Held in a field rather than fired and forgotten because this panel is torn
   * down under it on every navigation — a click on a contig name is a new view —
   * and a card left behind would be describing a gene from a picture that is no
   * longer on screen.
   */
  private openFeature(hit: { set: FeatureSet; index: number; source: string }): void {
    this.featureDialog?.close()
    this.featureDialog = openFeatureDialog({
      ...hit,
      onClose: () => {
        this.featureDialog = null
      },
    })
  }

  /**
   * Save the map as a figure — the `S` key, and the button in the Export card.
   *
   * In the format and at the resolution that card is set to, because a shortcut
   * that exported something other than the button beside it would be a second
   * export to keep in step with the first.
   */
  savePlot(): void {
    void this.save(this.exportFormat)
  }

  /**
   * The same figure onto the clipboard — ⌘C, and the button beside the save.
   *
   * PNG whatever the format select says, because a clipboard holds an image: a
   * PDF pasted into a slide arrives as a file attachment rather than a picture,
   * which is the opposite of what the gesture asked for. The resolution *is*
   * honoured — a figure pasted into a manuscript at 300 dpi is the point of
   * having the control at all — and the pre-flight in {@link exportCanvas} still
   * applies, so an impossible size fails the same way it fails on save.
   */
  copyPlot(): void {
    void this.copy()
  }

  private async copy(): Promise<void> {
    this.exportStatus.textContent = 'copying…'
    try {
      const now = new Date()
      // The canvas is drawn *before* the clipboard item is built rather than
      // inside the promise handed to it, because drawing is the part that can
      // throw a message worth showing. What the item waits on is the encode.
      const canvas = this.exportCanvas(this.exportDpi, now)
      await copyPngToClipboard(canvasToPng(canvas))
      this.exportStatus.textContent = `copied · ${canvas.width}×${canvas.height} px`
    } catch (err) {
      this.exportStatus.textContent =
        err instanceof Error ? `copy failed: ${err.message}` : 'copy failed'
    }
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
    for (const entry of this.laneStore.entries) {
      if (!drawsAProfile(entry.kind) || entry.style.limits.auto) continue
      this.laneStore.restyle(entry.id, { limits: { ...entry.style.limits, auto: true } })
    }
  }

  /**
   * The end of a scaling drag: one store write for the whole gesture.
   *
   * From the range that was resolved when the drag began, which is the one the
   * faded copy has been standing at all along — so the axis a reader let go on
   * is the axis they get. Every track in the lane, because they share it.
   */
  private commitLaneScaling(edge: LaneEdge, members: readonly AnnotationEntry[]): void {
    const held = this.laneScaling
    this.laneScaling = null
    this.schedule()
    if (held === null || held.factor === 1) return
    const extent = this.lanes.extentOf(edge, held.id)
    for (const member of members) {
      if (!hasAMovableAxis(member.kind)) continue
      const next = nudgedLimits(member.style.limits, extent, held.factor)
      if (next !== null) this.laneStore.restyle(member.id, { limits: next })
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
    const button = this.diagonalButton
    if (button === null) return
    button.classList.toggle('is-disabled', !possible)
    if (button instanceof HTMLButtonElement) button.disabled = !possible
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
   * Why this block cannot be correlated, or `null` when it can.
   *
   * Three refusals, and each is about the *object* rather than about the cost
   * except the last.
   *
   * A **pair of files** has none: the correlation of a ratio is not a quantity
   * anybody reads, and correlating each file and dividing is worse — a ratio of
   * two correlation coefficients is not a correlation of anything.
   *
   * A block whose **two axes are different stretches** has none either. "The
   * correlation between rows `i` and `j`" is a statement about two bins of one
   * sequence measured against the same set of partners, and on a `contig_A ×
   * contig_B` block the rows and the columns are not the same bins at all.
   *
   * And **size**, which is the one that is only a budget — see
   * {@link MAP_CORRELATION_BINS}. Worded rather than hidden, because a greyed
   * control that does not say what it wants is a control a reader concludes is
   * broken.
   */
  private correlationRefusal(data: MatrixResult, second: MatrixResult | undefined): string | null {
    if (this.options.derive?.correlateBlock === undefined) {
      return 'not available in this view'
    }
    if (second !== undefined && (this.options.compare?.op ?? 'split') !== 'split') {
      return 'one file at a time — the correlation of a ratio is not a correlation'
    }
    const square =
      data.nrows === data.ncols &&
      data.rowExtent[0] === data.colExtent[0] &&
      data.rowExtent[1] === data.colExtent[1]
    if (!square) return 'needs a square block — both axes over the same bins'
    if (data.nrows > MAP_CORRELATION_BINS) {
      return `${data.nrows.toLocaleString()} bins a side is past the ${MAP_CORRELATION_BINS.toLocaleString()}-bin limit — open the file at a coarser resolution`
    }
    return null
  }

  /** What identifies the square a correlation was measured on. */
  private correlationKey(data: MatrixResult, derivation: Derivation): string {
    return [
      this.blockGeneration,
      data.nrows,
      data.rowExtent[0],
      data.rowExtent[1],
      derivation.normalise ?? '',
      String(derivation.expected === true),
      derivation.smooth ?? '0',
    ].join('|')
  }

  /**
   * The correlation of this block if it is already computed, or the block
   * unchanged with a job started to compute it.
   *
   * Returning the operand while the answer is on its way is the deliberate part.
   * The alternative — blank until it lands — throws away a real picture of the
   * same region for several seconds to avoid showing the reader the thing their
   * correlation is *of*, and the veil already says what is happening.
   */
  private correlated(data: MatrixResult, derivation: Derivation, mine: DerivedValues): DerivedValues {
    const key = this.correlationKey(data, derivation)
    const held = this.correlation
    if (held !== null && held.key === key) {
      const { field } = held
      return {
        values: field.values,
        // Centred on zero, not on one: this is a correlation coefficient and its
        // neutral is no correlation. `preferredTransform` reads that and leaves
        // the values linear, which is right — a coefficient on `log2` would be
        // undefined over half its own range.
        neutral: 0,
        label: `${mine.label} · correlation`,
        // What a reader has to know to believe the picture, and the one thing
        // the map itself cannot show: a dropped bin is drawn blank, and blank is
        // also what a sparse corner looks like.
        scope:
          field.dropped > 0
            ? `${field.dropped.toLocaleString()} of ${(field.kept + field.dropped).toLocaleString()} bins had too little data to correlate`
            : mine.scope,
      }
    }
    this.startCorrelation(key, mine.values, data.nrows)
    return mine
  }

  /** Ask for one, unless the same one is already on its way. */
  private startCorrelation(key: string, values: Float32Array, n: number): void {
    if (this.correlating?.key === key) return
    const run = this.options.derive?.correlateBlock
    if (run === undefined) return
    // The block moved under a job that is still running, so its answer is about
    // a square nobody is looking at.
    this.correlating?.job.cancel()

    const job = run(values, n, (done, total) => {
      if (this.correlating?.key !== key) return
      this.showCorrelating(`correlating… ${Math.round((100 * done) / Math.max(1, total))}%`)
    })
    this.correlating = { key, job }
    this.showCorrelating('correlating…')

    job.promise.then(
      (field) => {
        // A late answer to a superseded question. Dropped rather than cached:
        // the key it belongs to may never be asked for again, and holding it
        // would mean the cache answered for a block that is no longer read.
        if (this.correlating?.key !== key) return
        this.correlating = null
        this.correlation = { key, field }
        this.showCorrelating(null)
        this.redraw()
      },
      (err: unknown) => {
        if (this.correlating?.key !== key) return
        this.correlating = null
        this.showCorrelating(null)
        // A cancelled correlation is a reader who moved on, which is not an
        // error and must not draw one (`worker/client.ts`).
        if (!isCancellation(err)) {
          this.options.derive?.onCorrelateChange?.(false)
          this.options.derive?.onCorrelateFailure?.(
            err instanceof Error ? err.message : String(err),
          )
        }
      },
    )
  }

  /** Put the correlation's own wait on the veil, or take it off. */
  private showCorrelating(note: string | null): void {
    this.correlationNote = note
    if (note === null) this.setBusy(false)
    else this.setBusy(true, note)
  }

  /** Drop any held or running correlation — the block it was about has gone. */
  private forgetCorrelation(): void {
    this.correlating?.job.cancel()
    this.correlating = null
    this.correlation = null
    this.showCorrelating(null)
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
  destroy(): void {
    this.stopRefineWatch?.()
    this.stopRefineWatch = null
    // A correlation running for a panel that is going away is seconds of a
    // worker thread spent on a picture nobody will see. Cancelled rather than
    // left to resolve into a dead panel, and the client itself is the session's
    // to close.
    this.forgetCorrelation()
    setReadout('')
    this.featureDialog?.close()
    this.featureDialog = null
    // A picking mode outlives nothing: the plot it was placing marks on is going
    // away. Ended here rather than left to be garbage-collected, because the
    // card that armed it is *not* going away — it lives in the shell — and it
    // learns the mode is over from this call. Without it, navigating with the
    // mode on leaves a button reading "Done" that nothing will ever answer.
    this.cancelPicking()
    this.unsubscribePlotOptions()
    this.unsubscribePick()
    this.unsubscribeTextScale()
    this.unsubscribeTurnBox()
    this.unsubscribeMapSize()
    this.themeWatchers()
    this.narrowWatcher()
    this.observer?.disconnect()
    this.heatmap.detach()
    for (const off of this.laneListeners) off()
    this.laneListeners.length = 0
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
    if (this.tipFrame !== 0) cancelAnimationFrame(this.tipFrame)
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
    this.hostSize = { width: this.grid.clientWidth, height: this.grid.clientHeight }
    this.refit()
    this.heatmap.resize()
    this.placeKey()
    this.schedule()
  }

  /**
   * Take the room again, and redraw the box in it.
   *
   * Every road into this panel from a change of *space* ends here, and there are
   * four of them: the shell folding a column ({@link remeasure}), the view's own
   * `ResizeObserver` for a window resize or a lane appearing, a turn arriving or
   * leaving, and a deck relaying out. They used to end in different places and
   * only some of them redrew the box, so a turned band kept the width of the
   * window it was first drawn in: folding two columns gave the map three hundred
   * pixels it never took, and adding a track under it left the band as wide as it
   * was before the stack was there.
   *
   * A square map needs none of this — its canvas is sized by the stylesheet, and
   * `HeatmapView.resize` reads that — which is exactly why the turned one was
   * missed: it is the one picture in the app whose size is a number this class
   * computes.
   *
   * The band's *depth* follows on the next frame with nothing to arrange:
   * {@link syncTurnDepth} runs before every draw and re-cuts the band whenever
   * the box it has to fill has changed shape.
   *
   * Idempotent, and it has to be: writing the box resizes the grid, which is what
   * the observer is watching. The room is measured against the *panel* and never
   * against the grid the box is in ({@link measureRoom}), so a second pass over
   * the same window computes the same numbers and the loop stops on the first
   * repeat.
   */
  private refit(): void {
    this.measureRoom()
    this.writeTurnBox()
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
    this.placeGrips()
  }

  /**
   * Lay the size handles along the edges of the picture.
   *
   * Placed from the measured rectangles on every frame, exactly as the key is, so
   * they follow a pan and a zoom with nothing to keep in step.
   *
   * The **plot** frame for a square map, on all four edges: the plot is what a
   * reader sees as the map — the canvas around it is the gutter its axis labels
   * live in — and the box being dragged is the canvas, so a handle on the frame
   * is the honest place to take hold of it.
   *
   * The band keeps the rectangle each of its own handles was always on. Its far
   * edge follows the **data**, because a band is as wide as its block while the
   * plot is as wide as the panel, and a bar across the plot would run out past
   * the picture at every zoom that does not fill it. Its two ends follow the
   * *plot*'s height for the opposite reason: a band fills its box vertically by
   * construction, so a handle that stopped at the last column would sit in the
   * middle of the picture pointing at nothing.
   */
  private placeGrips(): void {
    const turned = this.turned
    const plot = this.heatmap.plotRect
    const data = this.heatmap.dataRect
    // `down` is the mirrored half of a comparison, where separation grows towards
    // the bottom of the picture and the far edge is the bottom one. The other
    // horizontal edge is the diagonal the band stands on, and is not a handle.
    //
    // A **mirrored pair** has no idle edge at all: the diagonal is in the middle
    // of the picture, both horizontal edges are far edges, and each of them sets
    // the same one number — how tall the box is — from its own side.
    const idle: PlotEdge | null =
      turned === null || turned.fold !== undefined
        ? null
        : turned.direction === 'up'
          ? 'bottom'
          : 'top'
    for (const edge of ['top', 'bottom', 'left', 'right'] as const) {
      this.grips[edge].classList.toggle('hidden', edge === idle)
    }
    this.labelGrips(turned === null ? 'square' : 'band')

    for (const edge of ['left', 'right'] as const) {
      const grip = this.grips[edge]
      grip.style.top = `${Math.round(plot.y)}px`
      grip.style.height = `${Math.round(plot.height)}px`
      grip.style.left = `${Math.round(edge === 'left' ? plot.x : plot.x + plot.width)}px`
    }
    for (const edge of ['top', 'bottom'] as const) {
      if (edge === idle) continue
      const grip = this.grips[edge]
      // The band's far edge sits on the data; a square map's edges are the frame.
      const box = turned === null ? plot : data
      grip.style.top = `${Math.round(edge === 'top' ? box.y : box.y + box.height)}px`
      grip.style.left = `${Math.round(box.x)}px`
      grip.style.width = `${Math.round(box.width)}px`
    }
  }

  /**
   * What the handles say they do, which is not the same thing in the two
   * presentations.
   *
   * Written when the presentation changes rather than on every frame: a title is
   * a DOM write, and {@link placeGrips} runs before every draw.
   */
  private labelGrips(mode: 'square' | 'band'): void {
    if (mode === this.gripMode) return
    this.gripMode = mode
    const same = 'Double-click for as much room as there is.'
    for (const edge of ['top', 'bottom', 'left', 'right'] as const) {
      this.grips[edge].title =
        mode === 'square'
          ? `Drag to set how big this map is drawn — every edge sets the same size, because a ` +
            `square block has no shape to choose. ${same}`
          : edgeAxis(edge) === 'y'
            ? `Drag to set how tall this band is drawn. The distance from the diagonal it ` +
              `reaches follows from the zoom — the box keeps its shape and the picture fills ` +
              `it. ${same}`
            : `Drag to set how wide this band is drawn. Both ends move, so the box stays ` +
              `centred, and the tracks under it follow. ${same}`
    }
  }

  /**
   * A drag on a handle sets how big the picture is drawn.
   *
   * Pixels, straight through: a handle is on the edge of a box measured in them,
   * so the edge goes exactly where the hand puts it. What each of the four edges
   * *means* is read at the moment of the drag rather than wired once, because the
   * same edge belongs to two pictures — the left edge of a band is one end of its
   * width, and the left edge of a square map is one side of its size — and a
   * panel changes between them under the reader's hand.
   *
   * The **band** keeps the numbers it always had (`ui/turnBox.ts`): its far
   * horizontal edge is the depth, its two ends are the width, and the width moves
   * at twice the hand because the box is centred — the edge under the pointer has
   * to stay under it, so the far end goes out by the same amount.
   *
   * A **square map** has one number and every edge sets it (`ui/mapSize.ts`). The
   * two ends move it at twice the hand, for the same centring reason. The two
   * horizontal edges move it at once: the picture hangs from the stack above it,
   * so its top is where the panel starts and a taller box grows downward. The top
   * handle therefore reads as *out is bigger* rather than as an edge that follows
   * the pointer — which is what an edge handle means anyway, and the alternative
   * is a picture that floats in the middle of a reserved column with its tracks
   * detached from it.
   *
   * Keyboard too, because this is the only way to reach the number without a
   * pointer and a `role="separator"` that answers no keys is a control that says
   * it is one.
   */
  private watchGrips(): void {
    for (const edge of ['top', 'bottom', 'left', 'right'] as const) {
      const axis = edgeAxis(edge)
      // Out of the box: left and up are negative on screen, right and down are
      // positive, and "out" is whichever of them leaves the picture's middle.
      const away = edge === 'left' || edge === 'top' ? -1 : 1
      this.dragEdge(this.grips[edge], {
        axis,
        away: () => away,
        held: () =>
          this.turned === null
            ? this.mapSize()
            : axis === 'x'
              ? this.turnBox().width
              : this.turnBox().height,
        // Both ends of a centred box move; one horizontal edge moves alone.
        gain: axis === 'x' ? 2 : 1,
        set: (value) => {
          if (this.turned === null) setMapSize(value)
          else if (axis === 'x') this.setTurnBox({ width: value })
          else this.setTurnBox({ height: value })
        },
        reset: () => {
          if (this.turned === null) setMapSize(null)
          else if (axis === 'x') this.setTurnBox({ width: null })
          else this.setTurnBox({ height: null })
        },
      })
    }
  }

  /**
   * One edge of the box, as something a hand or a keyboard can move.
   *
   * The four handles differ in three numbers and nothing else — which axis they
   * travel on, which way out of the box is, and how much the box grows per pixel
   * travelled — so they are one gesture parameterised rather than four listeners
   * that have to be kept saying the same thing.
   */
  private dragEdge(
    grip: HTMLElement,
    rule: {
      axis: 'x' | 'y'
      away: () => number
      held: () => number
      gain: number
      set(value: number): void
      reset(): void
    },
  ): void {
    let from: { at: number; size: number } | null = null
    const onDown = (event: PointerEvent): void => {
      // No guard on the presentation any more: both of them have a size for this
      // handle to move, and the one edge that has none — the diagonal a band
      // stands on — is hidden rather than inert ({@link placeGrips}).
      if (event.button !== 0) return
      event.preventDefault()
      event.stopPropagation()
      from = { at: rule.axis === 'x' ? event.clientX : event.clientY, size: rule.held() }
      grip.setPointerCapture(event.pointerId)
      grip.classList.add('is-dragging')
    }
    const onMove = (event: PointerEvent): void => {
      if (from === null) return
      const now = rule.axis === 'x' ? event.clientX : event.clientY
      rule.set(from.size + (now - from.at) * rule.away() * rule.gain)
    }
    const onUp = (event: PointerEvent): void => {
      if (from === null) return
      from = null
      grip.releasePointerCapture(event.pointerId)
      grip.classList.remove('is-dragging')
    }
    const onKey = (event: KeyboardEvent): void => {
      const size = rule.held()
      // A tenth of the box per press, a half with Shift — the step the map's own
      // arrow keys pan by, so one hand learns one rule.
      const step = Math.max(1, Math.round(size * (event.shiftKey ? 0.5 : 0.1)))
      const grow = rule.axis === 'x' ? 'ArrowRight' : 'ArrowUp'
      const shrink = rule.axis === 'x' ? 'ArrowLeft' : 'ArrowDown'
      if (event.key === grow) rule.set(size + step)
      else if (event.key === shrink) rule.set(size - step)
      else if (event.key === 'Home' || event.key === '0') rule.reset()
      else return
      event.preventDefault()
    }

    grip.addEventListener('pointerdown', onDown)
    grip.addEventListener('pointermove', onMove)
    grip.addEventListener('pointerup', onUp)
    grip.addEventListener('pointercancel', onUp)
    grip.addEventListener('keydown', onKey)
    // A double-click puts the default back, which is the way out of an edge
    // dragged somewhere useless.
    grip.addEventListener('dblclick', () => rule.reset())
  }

  /**
   * The corner button and the menu it opens, as one box in the map's foot.
   *
   * Closed by a click anywhere else and by Escape, because it covers the
   * picture: a menu left open over a map is a map the reader cannot read, and
   * the gesture that dismisses it has to be the one they would try first.
   */
  private settingsCorner(menu: HTMLElement): HTMLElement {
    const toggle = iconButton(
      'sliders-horizontal',
      'Colour and values: the score, the baseline, the transform, the ramp and the clip',
      () => {
        const open = menu.classList.toggle('hidden')
        toggle.setAttribute('aria-expanded', String(!open))
      },
      { class: 'btn btn-icon map-settings-toggle', size: 15 },
    )
    toggle.setAttribute('aria-expanded', 'false')
    const box = el('div', { class: 'map-settings-corner' }, menu, toggle)
    const close = (): void => {
      menu.classList.add('hidden')
      toggle.setAttribute('aria-expanded', 'false')
    }
    // On the document, because the thing a reader clicks to dismiss a menu over
    // a map is usually the map — and the map's own handlers stop nothing.
    const onPointer = (event: PointerEvent): void => {
      if (event.target instanceof Node && box.contains(event.target)) return
      close()
    }
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') close()
    }
    document.addEventListener('pointerdown', onPointer)
    window.addEventListener('keydown', onKey)
    this.laneListeners.push(() => {
      document.removeEventListener('pointerdown', onPointer)
      window.removeEventListener('keydown', onKey)
    })
    return box
  }

  /** Refit the block to the canvas, undoing every pan and zoom. */
  fit(): void {
    this.heatmap.fit()
    this.schedule()
  }

  /**
   * The figure as one canvas: the plot with its legend beside it, on an opaque
   * page background, at `dpi` dots per inch.
   *
   * Composed from the two live views rather than copied off the screen — each
   * redraws itself into this canvas at the export scale, so the labels, the
   * hairlines and the tick marks are drawn at that resolution instead of being
   * enlarged. What is *framed* is whatever is framed on screen, pan and zoom
   * included.
   */
  exportCanvas(dpi: number, now = new Date()): HTMLCanvasElement {
    const scale = scaleForDpi(dpi)
    const plot = this.heatmap.cssSize
    // The lanes are part of the figure, so they are part of its box. A track
    // exported without them is a picture of a claim with its evidence cropped
    // off. The two that come *before* the map also move it: everything else on
    // the page is placed against `origin` rather than against the canvas.
    const stacks = this.laneStacks()
    const origin = { x: stacks.left, y: stacks.top }
    // No column for a legend any more: the key is drawn *in* the map's corner,
    // exactly where it is on screen, so an exported figure is the same picture
    // at a different resolution rather than a rearrangement of it.
    const width = stacks.left + plot.width + stacks.right
    const body = stacks.top + plot.height + stacks.bottom

    const out = document.createElement('canvas')
    const ctx = out.getContext('2d')
    if (ctx === null) throw new Error('Could not acquire a 2d context for the export canvas.')

    // Measured before the canvas is sized, because the caption decides how tall
    // it has to be — a long provenance line on a narrow figure wraps rather
    // than running off the edge. Setting `width`/`height` resets the context,
    // so nothing is drawn until after.
    // Aligned with the *drawn* frame, not the canvas: the plot is inset by
    // however much its labels need — and by whatever stack stands to its left —
    // and a caption flush with the canvas edge hangs off the left of the
    // picture it belongs to.
    const left = origin.x + this.heatmap.dataRect.x
    const caption = this.figureCaption(now)
    const lines = captionLines(ctx, caption, Math.max(120, width - left))
    const captionHeight = captionHeightOf(lines)

    // Pre-flight, because the failure mode is silent: past a browser's canvas
    // cap, setting `width`/`height` leaves a blank canvas rather than throwing,
    // so the export lands as a white rectangle with no explanation. Asked here
    // rather than at the top of the method because the caption is part of the
    // height, and a figure that fits without it can fail with it.
    const height = body + captionHeight
    const fits = largestDpiThatFits(width, height)
    if (fits !== null && fits < dpi) {
      throw new Error(
        `${dpi} dpi would need a ${Math.round(width * scale)}×${Math.round(height * scale)} px ` +
          `canvas, which is past what a browser will draw. ${fits} dpi is the largest that fits ` +
          'this figure.',
      )
    }

    out.width = Math.max(1, Math.round(width * scale))
    out.height = Math.max(1, Math.round(height * scale))

    // The plot draws from `origin` and clears as it goes, so it goes first and
    // the background goes on underneath at the end. The caption is *below* the
    // figure, which is where a caption goes.
    this.heatmap.renderTo(ctx, scale, origin)
    // Placed exactly as the grid places them — around the plot, on all four
    // sides — and *redrawn* at the export scale rather than blown up from the
    // screen canvases, so a 300 dpi figure has 300 dpi track names.
    this.lanes.renderInto(ctx, this.figureGeometry(), scale, origin)

    this.renderKeys(ctx, scale, origin)

    if (lines.length > 0) {
      const palette = readCanvasPalette(this.canvas)
      ctx.setTransform(scale, 0, 0, scale, 0, 0)
      ctx.textBaseline = 'alphabetic'
      ctx.textAlign = 'left'
      let y = body + scaleLength(CAPTION_TOP)
      for (const line of lines) {
        const height = scaleLength(line.strong ? CAPTION_TITLE_LINE : CAPTION_DETAIL_LINE)
        ctx.font = scaleFont(line.strong ? CAPTION_TITLE_FONT : CAPTION_DETAIL_FONT)
        ctx.fillStyle = line.strong ? readPageText(this.canvas) : palette.labelColor
        // Baseline a little above the line's foot, so the two lines read as one
        // block rather than as two evenly spaced rows.
        ctx.fillText(line.text, left, y + height - 4)
        y += height
      }
      ctx.setTransform(1, 0, 0, 1, 0, 0)
    }

    // Opaque, and in the theme on screen. A transparent PNG of a white-on-white
    // contact map is a blank rectangle in every viewer that composites onto
    // black, and the labels are drawn in the page's own text colour. Painted
    // *behind* what is already there — `#ffffff` first, so an unreadable
    // custom property leaves a white page rather than a black one.
    ctx.globalCompositeOperation = 'destination-over'
    ctx.fillStyle = '#ffffff'
    ctx.fillStyle = readPageBackground()
    ctx.fillRect(0, 0, out.width, out.height)
    ctx.globalCompositeOperation = 'source-over'
    return out
  }

  /**
   * The same figure as a vector page: the matrix as an image, everything else
   * as paths and text.
   *
   * The honest hybrid, and the reason the browser's page and this one are the
   * same class. A contact matrix *is* a raster — twelve thousand bins are
   * pixels, and writing them as a million rectangles would be a larger, slower
   * file of the same picture — but the axes, the tick labels, the boundary
   * marks, the tracks beside it, the legend and the caption are none of them
   * pixels, and a reader who wants to restyle a figure wants exactly those.
   *
   * Drawn at 1:1 rather than at a DPI, because a vector page has no resolution.
   * The image inside it does, and it is the screen's — which is the resolution
   * the matrix actually has, since a bin is a bin however large the page is.
   */
  private async vectorFigure(now: Date): Promise<Blob> {
    const plot = this.heatmap.cssSize
    const stacks = this.laneStacks()
    const origin = { x: stacks.left, y: stacks.top }
    const width = stacks.left + plot.width + stacks.right
    const body = stacks.top + plot.height + stacks.bottom

    const measure = document.createElement('canvas').getContext('2d')
    if (measure === null) throw new Error('Could not measure the caption.')
    const left = origin.x + this.heatmap.dataRect.x
    const caption = this.figureCaption(now)
    const lines = captionLines(measure, caption, Math.max(120, width - left))
    const height = body + captionHeightOf(lines)

    const page = new VectorPage(width, height)
    const ctx = page.ctx
    // The page under the drawing, first: a PDF is drawn in order and has no
    // `destination-over`.
    ctx.fillStyle = readPageBackground()
    ctx.fillRect(0, 0, width, height)

    this.heatmap.renderTo(ctx, 1, origin)
    this.lanes.renderInto(ctx, this.figureGeometry(), 1, origin)

    this.renderKeys(ctx, 1, origin)

    if (lines.length > 0) {
      const palette = readCanvasPalette(this.canvas)
      ctx.setTransform(1, 0, 0, 1, 0, 0)
      ctx.textBaseline = 'alphabetic'
      ctx.textAlign = 'left'
      let y = body + scaleLength(CAPTION_TOP)
      for (const line of lines) {
        const step = scaleLength(line.strong ? CAPTION_TITLE_LINE : CAPTION_DETAIL_LINE)
        ctx.font = scaleFont(line.strong ? CAPTION_TITLE_FONT : CAPTION_DETAIL_FONT)
        ctx.fillStyle = line.strong ? readPageText(this.canvas) : palette.labelColor
        ctx.fillText(line.text, left, y + step - 4)
        y += step
      }
    }
    return page.toBlob({ title: caption.title, created: now })
  }

  /**
   * What the figure is of, with the coordinates it is *actually framed at*.
   *
   * A view is panned and zoomed before it is exported, and the export keeps
   * that framing — so a figure captioned `XVI` when it shows 200–600 kb of
   * chromosome XVI is wrong in the way that matters, and the reader has no way
   * to tell from the picture. The suffix is written in the region grammar, so
   * it can be pasted back into the region box to return to this exact view.
   *
   * Omitted only where it would add nothing: an axis with no single coordinate
   * system (a genome, whose axis is contigs), a block with two different axes
   * (contig × contig), and a picture that is the whole sequence from base zero.
   */
  private framedSubject(): string {
    const subject = this.exportName
    if (subject.includes(' × ')) return subject
    const range = this.heatmap.framedRange('rows')
    if (range === null || range.whole) return subject
    const name = subject.split(':')[0]
    return `${name}:${fmt.int(Math.round(range.start))}-${fmt.int(Math.round(range.end))}`
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
    if (this.options.binsize > 0) parts.push(`${fmt.bp(this.options.binsize)} bins`)
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
    if (this.options.binsize > 0) parts.push(`${fmt.bp(this.options.binsize * binsPerCell)} bins`)
    if (this.level === 'contig') parts.push('contig level')
    if (balance) parts.push('balanced')
    parts.push(choice?.label ?? value)
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
  analysisBlock(): BlockInput | null {
    const data = this.data
    if (data === null) return null
    if (data.values.byteLength > BLOCK_COPY_LIMIT_BYTES) return null
    return {
      nrows: data.nrows,
      ncols: data.ncols,
      values: data.values.slice(),
      rowExtent: [data.rowExtent[0], data.rowExtent[1]],
      colExtent: [data.colExtent[0], data.colExtent[1]],
      binsPerCell: data.binsPerCell ?? 1,
    }
  }

  /** Save the figure. The status line under the row reports what happened. */
  private async save(format: ExportFormat): Promise<void> {
    const now = new Date()
    // The stamp is in the name because two exports of the same view are the
    // same filename otherwise, and the second one silently becomes
    // `figure (1).png` in a downloads folder nobody can later put in order.
    const name = `${exportBaseName(this.exportName)}-${fileStamp(now)}-${this.exportDpi}dpi.${format}`
    this.exportStatus.textContent = `saving ${name}…`
    try {
      const blob =
        format === 'png'
          ? await canvasToPng(this.exportCanvas(this.exportDpi, now))
          : await this.vectorFigure(now)
      downloadBlob(blob, name)
      this.exportStatus.textContent = `${name} · ${fmt.bytes(blob.size)}`
    } catch (err) {
      // Nothing here is worth an error screen: the view is intact and the user
      // can try a smaller size. Say what failed and stay put.
      this.exportStatus.textContent =
        err instanceof Error ? `export failed: ${err.message}` : 'export failed'
    }
  }

  /**
   * Everything drawn on the data: the overlay card's files, then the hand-drawn
   * marks over them.
   *
   * Files first and marks second, because a mark is what the reader put there
   * and it must not end up underneath a circle from a loop table.
   */
  private paintOverlays(ctx: CanvasRenderingContext2D, frame: OverlayFrame): void {
    const context = this.options.annotations
    if (context === undefined) return
    const palette = readCanvasPalette(this.canvas)

    for (const entry of context.store.overlays()) {
      if (entry.payload?.kind === 'features') {
        drawDiagonalFeatures(ctx, frame, this.locusAxes, entry.payload.data, {
          colour: entry.style.colour,
          opacity: entry.style.opacity,
          shape: entry.style.shape,
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
    this.paintLaneGuide(ctx, frame)
  }

  /**
   * The lane hairline, continued across the map.
   *
   * One line, not a crosshair. A pointer on the bottom stack is naming a
   * *column* and has said nothing about which row, so a horizontal line through
   * it would be an answer to a question nobody asked — and two lines crossing at
   * an arbitrary point read as a cell being pointed at, which is exactly what is
   * not happening.
   *
   * Turned, that one line becomes a **V** standing on the axis under the
   * pointer, and it is the same statement rather than a second one: the reader
   * is naming one place on the genome, and the contacts that place is in are not
   * a column of a turned picture but the two 45° rays leaving it
   * (`render/rotate.ts`). A vertical line there would cross the band through
   * contacts between two *other* places, none of which is the one being pointed
   * at except where the V's own apex is.
   *
   * The coordinate needs no conversion: the lane canvases share the map
   * canvas's grid cell on the axis they run along, so a pixel `x` on the bottom
   * stack is the same `x` here. Clipped to the data rather than the plot, so it
   * stops where the matrix does instead of running out over empty margin.
   */
  private paintLaneGuide(ctx: CanvasRenderingContext2D, frame: OverlayFrame): void {
    const guide = this.laneHover
    if (guide === null) return
    const { data, dpr } = frame
    const at = (Math.round(guide.along * dpr - 0.5) + 0.5) / dpr
    if (guide.edge === 'bottom') {
      if (at < data.x || at > data.x + data.width) return
    } else if (at < data.y || at > data.y + data.height) return

    ctx.save()
    ctx.beginPath()
    ctx.rect(data.x, data.y, data.width, data.height)
    ctx.clip()
    ctx.strokeStyle = CROSSHAIR_COLOR
    ctx.lineWidth = Math.max(1 / dpr, 0.75)
    ctx.globalAlpha = 0.8
    ctx.beginPath()
    const turned = this.turned
    if (turned !== null && laneIsHorizontal(guide.edge)) {
      // The apex is on the diagonal under the pointer — separation zero, which
      // is the bottom row of an ordinary turned band and the top row of the
      // mirrored half — and the rays go from there towards the far edge only.
      // Both ways along the genome, because a place is an anchor of everything
      // to its left as well as everything to its right.
      const col = frame.colScale.toUnit(guide.along - frame.plot.x)
      // One V per band, because a mirrored pair has two diagonals and the place
      // being pointed at is on the genome rather than in a file: it anchors
      // contacts in both maps, and a guide drawn in one of them would say
      // otherwise.
      const arms: Array<{ apex: { col: number; row: number }; far: number }> =
        turned.fold === undefined
          ? [
              {
                apex: { col, row: rowForSeparation(turned, 0) + 0.5 },
                far: turned.direction === 'up' ? 0 : turned.nrows,
              },
            ]
          : [
              { apex: { col, row: rowForSeparation(turned, 0) + 0.5 }, far: 0 },
              { apex: { col, row: turned.fold + 0.5 }, far: turned.nrows },
            ]
      for (const arm of arms) {
        for (const ray of anchorRays(arm.apex, [arm.far])) {
          ctx.moveTo(
            frame.plot.x + frame.colScale.toPixel(ray.from.col),
            frame.plot.y + frame.rowScale.toPixel(ray.from.row),
          )
          ctx.lineTo(
            frame.plot.x + frame.colScale.toPixel(ray.to.col),
            frame.plot.y + frame.rowScale.toPixel(ray.to.row),
          )
        }
      }
    } else if (laneIsHorizontal(guide.edge)) {
      ctx.moveTo(at, data.y)
      ctx.lineTo(at, data.y + data.height)
    } else {
      ctx.moveTo(data.x, at)
      ctx.lineTo(data.x + data.width, at)
    }
    ctx.stroke()
    ctx.restore()
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
   * The right-click menu on the map: place a mark exactly here.
   *
   * "Here" is the cell under the pointer, which is the thing a right click is
   * *for* — the two ways in that already existed are typing a coordinate you
   * know and arming a mode and clicking, and neither answers "this one, the one
   * I am pointing at". The coordinates go in the menu beside the actions so the
   * reader can see what they are about to mark before they mark it.
   *
   * Only where the file can carry marks (§8.5) and only over the data, not over
   * the gutters: a right click on a label is the browser's menu, and taking it
   * over to offer nothing would be worse than leaving it.
   */
  private watchContextMenu(): void {
    const onMenu = (event: MouseEvent): void => {
      const context = this.options.annotations
      if (context === undefined) return
      const box = this.canvas.getBoundingClientRect()
      const cell = this.heatmap.cellAt(event.clientX - box.left, event.clientY - box.top)
      if (cell === null) return
      const at = this.locusOf(cell)
      if (at === null) return
      event.preventDefault()

      const { manual } = context
      const add = (mark: Omit<ManualLine, 'id' | 'colour'> | Omit<ManualArrowhead, 'id' | 'colour'>): void => {
        manual.add({ ...mark, id: mintMarkId(), colour: manual.nextColour() } as ManualMark)
      }
      openMenu(event.clientX, event.clientY, [
        { label: 'Mark this point' },
        {
          label: 'Vertical line',
          hint: formatPoint(at.cols),
          run: () => add({ kind: 'line', axis: 'vertical', at: at.cols }),
        },
        {
          label: 'Horizontal line',
          hint: formatPoint(at.rows),
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
          label: 'Loop',
          hint: `${formatPoint(at.rows)} × ${formatPoint(at.cols)}`,
          run: () => add({ kind: 'arrowhead', a: at.rows, b: at.cols }),
        },
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
  private locusOf(cell: Cell): { rows: ManualPoint; cols: ManualPoint } | null {
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
    return rows === null || cols === null ? null : { rows, cols }
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

  /**
   * The same gesture, made on a lane stack rather than on the map.
   *
   * One conversion for both surfaces ({@link HeatmapView.bandAt}), because §8.4
   * glues their pixels together along the shared axis and two conversions would
   * be two chances to disagree about which stretch was named. Which axis is not
   * read from the hand here — the stack decides it, since a lane along the
   * columns can only ever name columns.
   */
  private bandOnLane(edge: LaneEdge, from: number, to: number): void {
    const axis = laneIsHorizontal(edge) ? 'cols' : 'rows'
    // Before the report, which disarms.
    const zooming = !isArmed()
    const span = this.heatmap.bandAt(axis, from, to)
    if (span !== null) this.bandDragged(axis, span)
    if (zooming) this.heatmap.zoomToBand(axis, from, to)
  }

  /** A band of one axis of the block on screen, as a locus, or `null`. */
  private bandLocus(which: 'rows' | 'cols', span: [number, number]): PickedLocus | null {
    const axis = which === 'rows' ? this.locusAxes.rows : this.locusAxes.cols
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
      guide: this.laneHover,
      border: this.laneBorder,
      handles: true,
      grip: this.laneHandle,
      scaling: this.laneScaling,
      palette: {
        guide: palette.labelColor,
        halo: palette.labelHaloColor,
        crosshair: CROSSHAIR_COLOR,
      },
    }
  }

  /**
   * The same frame, with the pointer taken out of it — what a figure is drawn
   * from.
   *
   * The handles are controls: a column of them down the margin is furniture a
   * reader of the figure has no use for, and so is a gesture in progress. Both
   * are addressed to somebody with a map in front of them, and a saved figure is
   * exactly the reader who has not. Everything else here is the picture and
   * stays.
   */
  private figureGeometry(): LaneGeometry {
    const live = this.laneGeometry()
    return {
      ...live,
      handles: false,
      grip: null,
      scaling: null,
    }
  }

  /**
   * How much room each stack needs, for a figure that has to make room for it.
   *
   * Two of the four move the map rather than merely extending the page, which
   * is why this is one call and not four: everything a figure draws is placed
   * against the plot's own corner, and above the map and to its left that
   * corner is not the canvas's.
   */
  private laneStacks(): Record<LaneEdge, number> {
    return {
      top: this.lanes.thicknessOf('top'),
      right: this.lanes.thicknessOf('right'),
      bottom: this.lanes.thicknessOf('bottom'),
      left: this.lanes.thicknessOf('left'),
    }
  }

  /**
   * Follow the pointer over one lane stack.
   *
   * The lanes get their own listeners rather than sharing the heatmap's, because
   * they are separate canvases and a pointer over one is not over the other.
   * What they share is the tooltip, which is why the coordinates are converted
   * to the grid's — the tooltip is parented there and knows nothing about which
   * canvas asked for it.
   */
  /**
   * Dragging a lane: its handle moves it, its border resizes it, its body pans.
   *
   * All three already existed in the side panel — a grip, a height box — and all
   * three are being asked for *here* because here is where the tracks are being
   * looked at. A reader comparing two profiles moves them next to each other and
   * makes the interesting one taller, and having to cross the window to a list
   * to do either is the reason the card grew a handle in the first place.
   *
   * Pointer capture, and the same reason the panel columns take it: a drag that
   * leaves a 44-pixel strip — which every resize does — must not be dropped on
   * the map underneath, where it would become a pan.
   */
  private dragLane(edge: LaneEdge, canvas: HTMLCanvasElement): void {
    const lanes = this.lanes
    const store = this.laneStore
    const horizontal = laneIsHorizontal(edge)
    /** Which way a pointer displacement on this canvas moves *outward*. */
    const outward = lanes.outwardOf(edge)

    /**
     * Three gestures on one surface, told apart by *where* the press lands.
     *
     * The **handle** moves the track: up and down its own stack to reorder, out
     * onto either rectangle in the map to change which edge it is drawn on. The
     * **border** resizes, because that is the only thing a border can be dragged
     * for. Everything else is a **pan**, which is what dragging a track beside a
     * map has always meant.
     *
     * The body used to reorder as well, by reading the direction of the first
     * movement — along the axis a pan, across it a reorder. It does not any
     * more, and the handle is why. Two meanings for one surface is a rule the
     * reader has to know before their first drag does what they meant, and it
     * was paid for on every pan that wandered a few pixels off the horizontal:
     * the track jumped a slot in the stack, because a gesture that has to be
     * performed *carefully* had been asked for. With a surface of its own for
     * moving, the body can go back to meaning one thing.
     */
    let drag:
      | {
          id: string
          kind: 'size' | 'pan' | 'grip' | 'press' | 'scale' | 'zoom'
          from: number
          along: number
          size: number
          /** Where the press landed, so an undecided drag can catch up. */
          from0: number
          along0: number
          /** For a scaling drag: the across-offset inside the lane it began at. */
          within: number
          /** Every track in the lane, which for an overlay group is all of them. */
          members: AnnotationEntry[]
          /** For a handle drag: the edge under the pointer, if it is on one. */
          to: LaneEdge | null
          /** The slot last dropped into, so a reorder fires once per crossing. */
          over: number
        }
      | null = null

    const start = (
      id: string,
      kind: 'size' | 'grip' | 'press' | 'zoom',
      event: PointerEvent,
      size: number,
      within = 0,
      members: AnnotationEntry[] = [],
    ): void => {
      const across = horizontal ? event.clientY : event.clientX
      const along = horizontal ? event.clientX : event.clientY
      drag = {
        id,
        kind,
        from: across,
        along,
        size,
        from0: across,
        along0: along,
        within,
        members,
        to: null,
        over: -1,
      }
      canvas.setPointerCapture(event.pointerId)
      event.preventDefault()
    }

    const onDown = (event: PointerEvent): void => {
      if (event.button !== 0 || this.picking !== null) return
      const box = canvas.getBoundingClientRect()
      const x = event.clientX - box.left
      const y = event.clientY - box.top
      // Shift first, before any of the three targets below. The same gesture the
      // map has and the 1D browser has, offered on the strip beside them: a
      // reader who can see the peak they want to zoom to should be able to drag
      // across it where they are looking, rather than move to the map and find
      // the same stretch again. Deliberate enough — a held modifier — that it
      // can outrank a caret and a handle without ever being hit by accident.
      // …and unmodified while a form is waiting to be pointed at, for the reason
      // the map itself gives: *Pick on map* is already a mode, and asking for a
      // modifier on top of one is asking twice. `bandOnLane` reports without
      // zooming while it is armed.
      if (event.shiftKey || isArmed()) {
        start('', 'zoom', event, 0)
        return
      }
      // A limit under a track's name is a text box that happens to be painted.
      // Checked before the pointer is captured, so the press never becomes the
      // start of a pan the reader did not ask for.
      const limit = lanes.limitAt(edge, x, y)
      if (limit !== null && this.laneEditor !== null) {
        event.preventDefault()
        this.laneEditor.openLimit(limit, { left: canvas.offsetLeft, top: canvas.offsetTop })
        return
      }
      // The handle next: it sits inside the lane's own rectangle, so the lane
      // hit below would otherwise take the press and read a direction out of it.
      const handle = lanes.gripAt(edge, x, y, this.laneGeometry())
      if (handle !== null) {
        start(handle.entry.id, 'grip', event, handle.entry.style.size)
        canvas.classList.add('grabbing')
        this.laneGripping = true
        this.tooltip.classList.add('hidden')
        // The rectangle comes up with the gesture, because it is where the
        // gesture can end: a drag whose target only appears once you are on it
        // is a drag nobody makes twice.
        //
        // Every rectangle *but this edge's own*. A track dragged out of the
        // bottom stack cannot be moved to the bottom — it is already there — so
        // offering it that target is offering a gesture with no outcome, and a
        // lit rectangle that does nothing when you let go reads as the drag
        // having failed.
        this.edgeZones.get(edge)?.classList.add('away')
        this.grid.classList.add('is-dropping')
        return
      }
      // …and the name last of the three, for the reason the limit is first: it
      // is text on a canvas that a reader changes. After the handle, because the
      // two touch at the near end of a lane and the handle is the smaller target
      // — a caret opening where a reorder was meant is the worse miss.
      const named = lanes.nameAt(edge, x, y)
      if (named !== null && this.laneEditor !== null) {
        event.preventDefault()
        this.laneEditor.openName(named, { left: canvas.offsetLeft, top: canvas.offsetTop })
        return
      }
      const hit = lanes.laneAt(edge, x, y)
      if (hit === null) return
      // A press in the body is not yet a gesture: which way it first travels
      // says whether it is the pan a lane has always been or a drag on that
      // lane's ceiling. The border needs no such reading — a border can be
      // dragged for exactly one thing.
      const within = lanes.withinLane(edge, hit.entry.id, x, y)
      start(
        hit.entry.id,
        hit.onBorder ? 'size' : 'press',
        event,
        hit.entry.style.size,
        within,
        hit.members.filter((member) => hasAMovableAxis(member.kind)),
      )
      if (!hit.onBorder) canvas.classList.add('grabbing')
    }

    const onMove = (event: PointerEvent): void => {
      const box = canvas.getBoundingClientRect()
      if (drag === null) {
        // Not dragging, and the cursor stays the pointer everywhere it is still
        // pointing *at* a base pair: it is the same shape over the map, over the
        // lanes and over the 1D browser, and a hand appearing on the way from
        // one to the other would say they are different surfaces, which is the
        // one thing they are not. It changes only where the thing under it is
        // not a coordinate — a handle to take hold of, a number to type into, a
        // border to drag — and each of those says which by its own shape,
        // alongside the accent rule drawn for it.
        const x = event.clientX - box.left
        const y = event.clientY - box.top
        const hit = lanes.laneAt(edge, x, y)
        canvas.style.cursor = ''
        const border = hit?.onBorder === true ? hit.entry.id : null
        // Over a limit the pointer *is* the affordance, because "this text is a
        // text box" is a claim only a caret makes. Tested before the handle, in
        // the order the press tests them: the two can come within a couple of
        // pixels of each other on a short lane, and a cursor promising one while
        // the press does the other is worse than either.
        const onRange = lanes.limitAt(edge, x, y) !== null
        // The handle is the one thing on these canvases the arrowhead cannot
        // speak for: it is not pointing at a base pair, it is something to take
        // hold of, and the open hand is what says so.
        const onHandle = !onRange && lanes.gripAt(edge, x, y, this.laneGeometry()) !== null
        canvas.classList.toggle('is-grab', onHandle)
        // The far border, where a drag resizes the lane. The same double arrow
        // the map's own box handles carry, on the axis this border moves on:
        // there is a rule drawn under the pointer already, and a rule with no
        // cursor to go with it is a mark the reader has to guess is a control.
        canvas.classList.toggle('is-resize-across', border !== null && horizontal)
        canvas.classList.toggle('is-resize-along', border !== null && !horizontal)
        // The name is a caret too, and last in the same order the press reads.
        const onLabel = !onRange && !onHandle && lanes.nameAt(edge, x, y) !== null
        canvas.classList.toggle('is-text', onRange || onLabel)
        const handle = hit === null ? null : hit.entry.id
        if (border !== this.laneBorder || handle !== this.laneHandle) {
          this.laneBorder = border
          this.laneHandle = handle
          this.schedule()
        }
        return
      }
      const now = horizontal ? event.clientY : event.clientX
      const alongNow = horizontal ? event.clientX : event.clientY

      if (drag.kind === 'zoom') {
        // Drawn on the *map*, because that is what the band is about: the stack
        // has no marquee, and one drawn only inside the lane would say the band
        // stops where the track does.
        const origin = horizontal ? box.left : box.top
        this.heatmap.showBandPreview(
          horizontal ? 'cols' : 'rows',
          drag.along0 - origin,
          alongNow - origin,
        )
        return
      }

      if (drag.kind === 'press') {
        const across = now - drag.from0
        const along = alongNow - drag.along0
        if (Math.abs(across) + Math.abs(along) < DRAG_SLACK) return
        // Across the lane rather than along it, which is the one direction a
        // drag on a track beside the map had no meaning in: a pan only ever
        // forwards the shared axis, so a perpendicular drag moved nothing at
        // all. Read once, at the slack, so a pan that wanders a few pixels off
        // its axis stays the pan it started as.
        drag.kind =
          Math.abs(across) > Math.abs(along) && drag.members.length > 0 ? 'scale' : 'pan'
        // `drag.along` is still where the press landed, so the pan below applies
        // the whole travel in this one event: the gesture catches up rather than
        // starting three pixels late, which on a canvas glued to the map is the
        // difference a reader would feel.
        if (drag.kind === 'scale') {
          this.laneScaling = { id: drag.id, factor: 1 }
          canvas.classList.remove('grabbing')
        }
      }

      if (drag.kind === 'scale') {
        const frame = lanes.frameFor(edge, drag.id, this.laneGeometry())
        if (frame === null) return
        this.laneScaling = {
          id: drag.id,
          factor: ceilingFactor(
            frame,
            drag.within,
            // In the lane's own across coordinates, which run outward from the
            // map — so on a stack above or to the left of it the pointer's
            // displacement is the *negative* of the travel. `ceilingFactor` asks
            // the frame which way a larger value is drawn, and it can only be
            // asked in the units it answers in.
            drag.within + outward * (now - drag.from0),
            drag.members[0]?.style.flip === true,
          ),
        }
        this.schedule()
        return
      }

      if (drag.kind === 'grip') {
        // Over one of the rectangles, the drag is about which edge this track is
        // drawn on and the release decides it. The rectangles are inside the
        // map, so this can never be true while the pointer is over a stack —
        // which is what makes the two halves of the gesture tell themselves
        // apart without a rule about direction.
        const over = this.edgeUnder(event.clientX, event.clientY)
        drag.to = over
        for (const [name, zone] of this.edgeZones) zone.classList.toggle('over', name === over)
        if (over !== null) return
        // Otherwise it is a reorder, and only while the pointer is actually
        // beside the stack: past either end there is no slot being pointed at,
        // and answering anyway would fling the track to the top of the order on
        // the way out to a rectangle.
        const x = event.clientX - box.left
        const y = event.clientY - box.top
        const across = horizontal ? y : x
        const span = horizontal ? canvas.clientHeight : canvas.clientWidth
        if (across < 0 || across > span) return
        const to = lanes.slotIndexAt(edge, x, y)
        // Once per slot *crossed*, not once per pointer move. Without it an
        // overlay group thrashes: moving its host past its own members only
        // re-elects a host, the two orders draw identically, and the move fires
        // again on every event — each one a `sessionStorage` write.
        if (to === drag.over) return
        drag.over = to
        lanes.moveToSlot(edge, drag.id, to)
        return
      }

      if (drag.kind === 'pan') {
        const delta = alongNow - drag.along
        drag.along = alongNow
        if (delta === 0) return
        // `panBy` takes a *canvas* displacement, which is what this is: the lane
        // and the map share their pixels on this axis by construction (§8.4).
        if (horizontal) this.heatmap.panBy(delta, 0)
        else this.heatmap.panBy(0, delta)
        return
      }

      // Thickness grows *away* from the map on every edge, so the delta is the
      // pointer's displacement in the outward direction — which above the map
      // and to its left is the canvas direction reversed.
      // Every track in the lane, because an overlay group shares one strip:
      // resizing the host alone would leave its members claiming a height the
      // stack no longer gives them.
      const next = laneSize(drag.size + outward * (now - drag.from))
      for (const member of lanes.membersOf(edge, drag.id)) {
        store.restyle(member.id, { size: next })
      }
    }

    const onUp = (event: PointerEvent): void => {
      if (drag === null) return
      if (drag.kind === 'zoom') {
        this.heatmap.clearBandPreview()
        const rect = canvas.getBoundingClientRect()
        const origin = horizontal ? rect.left : rect.top
        const alongNow = horizontal ? event.clientX : event.clientY
        this.bandOnLane(edge, drag.along0 - origin, alongNow - origin)
        drag = null
        canvas.style.cursor = ''
        canvas.classList.remove('grabbing')
        canvas.releasePointerCapture(event.pointerId)
        return
      }
      // A press that never became a gesture is a click, and a click on a lane
      // means one of two things depending on what is under it. On a *feature* it
      // means "what is this" — answered by the card, the same card the 1D
      // browser opens for the same gesture on the same gene. On the lane itself
      // it means "this track", the most direct way a reader has of saying so:
      // it opens that track's settings in the card that holds them, rather than
      // leaving them to match a name against a list in a column scrolled
      // somewhere else.
      if (drag.kind === 'press') {
        const box = canvas.getBoundingClientRect()
        const hit = lanes.featureAt(edge, event.clientX - box.left, event.clientY - box.top)
        // No `onGoTo` here, and that is deliberate: the 1D browser's zoom sets a
        // locus on one axis, and this view's navigation is a region on two. A
        // button that framed the gene on one of them would leave the other
        // wherever it was, which is not what "zoom to it" would promise.
        if (hit !== null) this.openFeature(hit)
        else revealTrack(drag.id)
      }
      if (drag.kind === 'scale') this.commitLaneScaling(edge, drag.members)
      // A handle let go over a rectangle draws the track on that edge instead.
      // A *move* and not a copy — the other edge is cleared — because that is
      // what dragging a thing from one place to another means; `location` in the
      // row's settings is the same field, for the reader who wants both.
      if (drag.kind === 'grip' && drag.to !== null) {
        const target = drag.to
        // Every member, because an overlay group is one lane on screen and would
        // otherwise be split across two edges by a single drag.
        for (const member of lanes.membersOf(edge, drag.id)) {
          // **On this panel's own map.** The gesture was made on one picture and
          // it is about that picture: `place` writes the *track's* default and
          // the lead's lane with it, so a drag on a companion moved the track
          // out from under the first map and left the one the hand was over
          // exactly as it was (`annotations/store.ts`'s `placeAt`).
          store.placeAt(member.id, this.mapId, placementOn(target))
        }
      }
      if (drag.kind === 'grip') {
        this.grid.classList.remove('is-dropping')
        for (const zone of this.edgeZones.values()) zone.classList.remove('over', 'away')
        this.laneGripping = false
      }
      drag = null
      canvas.style.cursor = ''
      canvas.classList.remove('grabbing')
      canvas.releasePointerCapture(event.pointerId)
    }

    const onMenu = (event: MouseEvent): void => {
      const box = canvas.getBoundingClientRect()
      const hit = lanes.laneAt(edge, event.clientX - box.left, event.clientY - box.top)
      if (hit === null) return
      event.preventDefault()
      openLaneMenu(event.clientX, event.clientY, hit.entry, store, edge, this.mapId)
    }

    canvas.addEventListener('pointerdown', onDown)
    canvas.addEventListener('pointermove', onMove)
    // A cancel means the gesture was taken *away*, not that it finished. Treated
    // as a release it commits the one decision a drag holds back until then —
    // which edge the track is drawn on — so a drag the system interrupts over a
    // lit rectangle would move the track there anyway.
    const onCancel = (event: PointerEvent): void => {
      if (drag === null) return
      drag.to = null
      onUp(event)
    }
    canvas.addEventListener('pointerup', onUp)
    canvas.addEventListener('pointercancel', onCancel)
    canvas.addEventListener('contextmenu', onMenu)
    this.laneListeners.push(() => {
      canvas.removeEventListener('pointerdown', onDown)
      canvas.removeEventListener('pointermove', onMove)
      canvas.removeEventListener('pointerup', onUp)
      canvas.removeEventListener('pointercancel', onCancel)
      canvas.removeEventListener('contextmenu', onMenu)
    })
  }

  /**
   * Which edge rectangle a point on the page is inside, if either.
   *
   * By arithmetic rather than by `dragover`, because the gesture that asks is a
   * pointer drag with the pointer captured on a lane canvas: every event goes to
   * that canvas, whatever it is over, which is exactly what stops the map
   * underneath reading the drag as a pan.
   */
  private edgeUnder(x: number, y: number): LaneEdge | null {
    for (const [edge, zone] of this.edgeZones) {
      // A rectangle the gesture is not being offered is not a target either;
      // one place decides that, so what lights up and what lands cannot differ.
      if (zone.classList.contains('away')) continue
      const box = zone.getBoundingClientRect()
      if (x >= box.left && x <= box.right && y >= box.top && y <= box.bottom) return edge
    }
    return null
  }

  private watchLane(edge: LaneEdge, canvas: HTMLCanvasElement): void {
    const lanes = this.lanes
    const onMove = (event: MouseEvent): void => {
      // A track being carried to an edge is not a position being pointed at.
      if (this.laneGripping) {
        this.tooltip.classList.add('hidden')
        return
      }
      const box = canvas.getBoundingClientRect()
      const x = event.clientX - box.left
      const y = event.clientY - box.top

      // The hairline first, and through a repaint rather than a second canvas:
      // it crosses the lane stack and the map, and both are redrawn from this
      // one number on the next frame.
      const along = laneIsHorizontal(edge) ? x : y
      const before = this.laneHover
      if (before === null || before.edge !== edge || before.along !== along) {
        this.laneHover = { edge, along }
        this.schedule()
        this.reportLaneHover()
      }

      const readout = lanes.readout(edge, x, y, this.laneGeometry())
      if (readout === null) {
        this.tooltip.classList.add('hidden')
        return
      }
      this.tip.matrix.classList.add('hidden')
      this.tip.lane.classList.remove('hidden')
      // The position, and only the position. Naming the hovered lane here as
      // well was saying what the pointer already says: the tooltip is beside the
      // lane it is about, and the row for that lane is marked below.
      this.tip.laneTitle.textContent = readout.position
      this.tip.laneLines.replaceChildren(
        ...readout.rows.map((row) =>
          el(
            'div',
            { class: row.here ? 'cell-tip-line cell-tip-here' : 'cell-tip-line' },
            el('span', { class: 'cell-tip-chip', style: { background: row.colour } }),
            // In the track's own colour, which is the legend the picture already
            // uses — the lane is drawn in it and so is its name on the lane.
            el('span', {
              class: 'cell-tip-key',
              text: `${row.label}:`,
              style: { color: row.colour },
            }),
            el('span', { class: 'cell-tip-val', text: row.value }),
          ),
        ),
        ...readout.detail.map((line) => el('div', { class: 'cell-tip-line', text: line })),
      )
      // The one gate for the card on this surface. Everything above it still runs
    // — the readout the status line shows is the same measurement — so turning
    // the card off costs a hover nothing and gives back the few hundred square
    // pixels it was covering.
    if (!getPlotOptions().tooltip) {
      this.tooltip.classList.add('hidden')
      return
    }
    this.tooltip.classList.remove('hidden')
      this.placeTooltip(canvas.offsetLeft + x, canvas.offsetTop + y)
    }
    const onLeave = (): void => {
      this.tooltip.classList.add('hidden')
      canvas.classList.remove('is-grab')
      canvas.classList.remove('is-resize-across')
      canvas.classList.remove('is-resize-along')
      if (this.laneBorder !== null || this.laneHandle !== null) {
        this.laneBorder = null
        this.laneHandle = null
        this.schedule()
      }
      if (this.laneHover !== null) {
        this.laneHover = null
        this.schedule()
        // The move off the edge is what takes the other panels' marks away with
        // the pointer, exactly as {@link describe} reports the move off the map.
        this.reportLaneHover()
      }
    }
    canvas.addEventListener('mousemove', onMove)
    canvas.addEventListener('mouseleave', onLeave)
    this.laneListeners.push(() => {
      canvas.removeEventListener('mousemove', onMove)
      canvas.removeEventListener('mouseleave', onLeave)
    })
    this.driveFromLane(edge, canvas)
    this.dragLane(edge, canvas)
  }

  /**
   * Let a lane stack pan and zoom the map.
   *
   * A lane is a picture of the same window the map shows, drawn through the same
   * scales — so dragging one and dragging the map are the same gesture on the
   * same data, and a track you could read but not move was an odd exception a
   * reader has to discover. Dragging a bottom lane sideways scrolls the columns;
   * dragging a right lane up and down scrolls the rows.
   *
   * Only along the shared axis. A bottom lane says nothing about rows, so a
   * vertical drag on one has no meaning to forward — and forwarding it anyway
   * would move the map in a direction the pointer never travelled over anything
   * that represents it.
   *
   * The **zoom is not** restricted that way, because the map's zoom is one
   * scalar for both axes: a wheel over a lane zooms exactly as a wheel over the
   * map does, holding the position under the pointer fixed on the shared axis
   * and the middle of the data on the other. Anchoring the other axis anywhere
   * else would be inventing a row the reader never pointed at.
   */
  private driveFromLane(edge: LaneEdge, canvas: HTMLCanvasElement): void {
    /** The perpendicular anchor: the centre of the data actually on screen. */
    const middle = (): { x: number; y: number } => {
      const data = this.heatmap.dataRect
      return { x: data.x + data.width / 2, y: data.y + data.height / 2 }
    }

    const onWheel = (event: WheelEvent): void => {
      const box = canvas.getBoundingClientRect()
      const x = event.clientX - box.left
      const y = event.clientY - box.top
      // ⌘-scroll over a lane raises or lowers *that lane's* ceiling — the
      // adjustment a reader of a coverage track makes constantly, and the one
      // gesture the 1D browser had that the map's own lanes did not. Never Ctrl:
      // a trackpad pinch arrives as a wheel with `ctrlKey` set, so taking it here
      // would swallow every pinch and run away with a ceiling instead of zooming.
      const lanes = this.lanes
      const store = this.laneStore
      if (CEILING_MODIFIER(event)) {
        const hit = lanes.laneAt(edge, x, y)
        if (hit === null) return
        event.preventDefault()
        // From the range *resolved on screen*, group included, so the first notch
        // on an autoscaled track starts from the axis the reader is looking at
        // rather than from a stored `[0, 1]` nobody chose.
        const extent = lanes.extentOf(edge, hit.entry.id)
        const factor = event.deltaY < 0 ? 1 / CEILING_STEP : CEILING_STEP
        for (const member of hit.members) {
          if (!hasAMovableAxis(member.kind)) continue
          const next = nudgedLimits(member.style.limits, extent, factor)
          if (next !== null) store.restyle(member.id, { limits: next })
        }
        return
      }
      // The same two rules the map's own wheel handler follows: a sideways
      // scroll slides along the picture, and the zoom factor is exponential in
      // the delta so a trackpad's many small events and a wheel's few large ones
      // compose to the same total zoom. A stack is *on* the map's axis, so a
      // gesture over one has to mean what it means over the other — the map
      // moving under the pointer while the profile above it did not would read
      // as the two coming apart.
      if (Math.abs(event.deltaX) > Math.abs(event.deltaY)) {
        event.preventDefault()
        this.heatmap.panBy(-event.deltaX, 0)
        return
      }
      event.preventDefault()
      const at = middle()
      if (laneIsHorizontal(edge)) at.x = x
      else at.y = y
      this.heatmap.zoomAt(at.x, at.y, Math.exp(-event.deltaY * 0.002))
    }

    canvas.addEventListener('wheel', onWheel, { passive: false })
    this.laneListeners.push(() => canvas.removeEventListener('wheel', onWheel))
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
    // Before the derivation below, which builds the correlation's cache key out
    // of it. A block arriving is the one event the key cannot infer: a reader
    // moving from balanced counts to raw ones is re-read on the identical grid,
    // so every other part of the key matches and the previous quantity's
    // correlation would be drawn under the new one's caption.
    this.blockGeneration++
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
    // The second legend is a function of the gain as well as of the colour
    // scale, and the gain is recomputed per block. Without this the legend
    // redraw is skipped whenever a *pinned* clip survives a navigation, and the
    // second file's ticks keep the previous block's numbers.
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
    this.refit()
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
    this.heatmap.setFitAxis(turned === null ? 'both' : 'cols')
    this.refit()
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
  ): { drawn: OverlayAxes; square: OverlayAxes } {
    const context = this.options.annotations
    const shared = {
      level: data.level,
      binsize: this.options.binsize,
      contigLength: context?.contigLength ?? ((): number | undefined => undefined),
    }
    const square: OverlayAxes = {
      rows: locusAxisFrom({ ...shared, runs: data.rowGroups, blockStart: data.rowExtent[0] }),
      cols: locusAxisFrom({ ...shared, runs: data.colGroups, blockStart: data.colExtent[0] }),
    }
    // A turned block has one genomic axis and one that is not: x is position,
    // measured in the half-bin columns the rotation produced, and y is distance
    // from the diagonal, which is not a place and has no locus. `null` on rows
    // is exactly right for the lanes — a stack drawn against a genomic axis has
    // nothing to draw itself against up the side, which is why a turn moves
    // every track to the bottom.
    if (turned === null) return { drawn: square, square }
    return {
      drawn: {
        rows: null,
        cols: this.turnedLocus(turned, data),
        // What an overlay is placed by once there is no row axis to ask: a
        // mark names one locus or two, and the turn is a function of those
        // two (`render/overlays.ts`).
        turn: {
          maxSeparation: turned.maxSeparation,
          direction: turned.direction,
          binsize: this.options.binsize,
        },
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
    // Every derivation is applied to each file *separately* and before the two
    // are put together, because each is a statement about one library: file 2's
    // coverage bias is file 2's, and a baseline measured across a ratio is a
    // baseline of nothing. `runs` is the same for both by construction — the
    // compare gate refused any second file whose sequences differ.
    const runs: { rows: readonly AxisRun[]; cols: readonly AxisRun[] } = {
      rows: data.rowGroups,
      cols: data.colGroups,
    }
    const wantsCorrelation = this.options.derive?.correlate === true
    // Asked before the derivation rather than after, because the answer decides
    // what the derivation *is*: a refused correlation is not a correlation drawn
    // badly, it is O/E with a sentence attached.
    const refusal = wantsCorrelation ? this.correlationRefusal(data, second) : null
    const correlating = wantsCorrelation && refusal === null

    const derivation: Derivation = {
      normalise: this.options.derive?.normalise,
      // A correlation *of* observed-over-expected, always. The distance decay is
      // the largest thing in a contact map by far, so every pair of rows in a
      // raw or balanced square correlates near 1 and the picture is a uniform
      // wash — the correlation is only a compartment object once the decay has
      // been divided out (§18.8). Carried by the score rather than asked for
      // separately (`ui/scores.ts`), and the caption names both steps.
      //
      // On `wantsCorrelation` and not on `correlating`, so a *refused* one still
      // draws the O/E underneath it. That is the nearest true picture to what
      // was asked for, and dropping back to plain counts would change the map
      // twice — once for the refusal and once for a baseline nobody withdrew.
      expected: wantsCorrelation || this.options.derive?.expected === true,
      // Last word, and `deriveBlock` gives it one: a reader who left the toggle
      // on and then asked to see the baseline gets the baseline, not a field of
      // ones. The toggle is greyed to say so rather than silently ignored.
      baseline: this.options.derive?.baseline === true,
      // Applied inside `deriveBlock`, which is what puts it on *each file* and
      // ahead of `combine` — the whole reason a ratio can be smoothed at all
      // (`render/smooth.ts`).
      smooth: this.options.derive?.smooth ?? '0',
    }
    const derived = deriveBlock(data, derivation, runs)
    // The correlation replaces the whole field, which is why it is applied here
    // rather than inside `deriveBlock`: every step in there is synchronous and
    // this one is not, so the panel is the only place that can hold the answer
    // between the request and the frame that draws it.
    const mine = correlating
      ? this.correlated(data, derivation, derived)
      : refusal === null
        ? derived
        : // Said in the caption, which is the only place that survives an export.
          // A correlation the reader picked and did not get has to be visible on
          // the figure: the O/E under it is a real picture and looks like one, so
          // nothing else on screen would betray that it is not what was asked for.
          { ...derived, scope: `correlation not drawn — ${refusal}` }
    if (!correlating && this.correlating !== null) this.forgetCorrelation()
    this.derived = mine
    const aligned = second !== undefined && alignable(data, second) ? second : undefined
    const theirs =
      aligned === undefined ? undefined : deriveBlock(aligned, derivation, runs)

    const op = this.options.compare?.op ?? 'split'
    // Measured on the *derived* blocks, not the raw ones: a normalisation may
    // already have removed the depth difference the gain exists to correct, and
    // matching again on top of it would scale one file for a reason that is no
    // longer there. Where nothing is derived the two are the same array, so this
    // is byte for byte the number it always was.
    const gain =
      aligned !== undefined && this.compareNormalising(op)
        ? matchGain({ ...data, values: mine.values }, { ...aligned, values: theirs!.values })
        : 1
    this.second = aligned === undefined ? null : { data: aligned, gain }

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
            { op, gain },
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
    return turnedAxis(turned, { label, firstBin, length }, this.options.binsize)
  }

  /**
   * The box a turned map is drawn in, in CSS pixels.
   *
   * The reader's, where they have said (`ui/turnBox.ts`), and otherwise a
   * default expressed against the width — a third of it, which is the shape of
   * the figures this is a viewer for. A rule and not a number, which is why what
   * the store holds on an untouched axis is `null`: "as wide as there is room
   * for" cannot be written down as a width, since the room changes with the
   * window and the number would not.
   *
   * Clamped on the way **out** rather than only where the reader drags. What is
   * stored is one box for the session and the panels drawing from it need not
   * have the same room — a deck of four is four narrower panels — so a box the
   * reader shaped beside one map has to be readable as "and as much of that as
   * fits" beside the next. Which is also what makes the size survive a window
   * resize: it is remembered whole and drawn to fit.
   */
  private turnBox(): { width: number; height: number } {
    return fitTurnBox(getTurnBox(), this.turnRoom())
  }

  /**
   * How much room there is to draw the box in, in CSS pixels.
   *
   * Measured against the **panel**, and never against the grid the box is in.
   * The grid is sized by its contents, so a box narrowed by a drag narrows the
   * grid with it — and a ceiling read from there is a ceiling that follows the
   * box down. That is what made the ends of the band a one-way control: every
   * drag inwards lowered the limit to wherever the edge had just got to, so the
   * width could be given away and never taken back.
   *
   * Both numbers are the room a *map* has, which is not the room the panel has:
   * a stack of tracks beside or under the picture is drawn out of the same
   * budget, and a box sized to the whole of it would push its own tracks off the
   * edge. What is left after them is the difference between the grid and the
   * map's own box, which is a fact about the tracks and does not move when the
   * box does.
   *
   * The height is the one a square map would have claimed — `--map-budget`, read
   * back off the grid's `min-height`, which §17.2 already reserves so that
   * turning the map does not resize the panel. Growing past it would push the
   * page down, and the panel would grow again on the next drag: a ceiling that
   * rises as you press on it is not a ceiling.
   */
  private turnRoom(): { width: number; height: number } {
    return this.room ?? this.measureRoom()
  }

  /**
   * Measure it, and keep the answer.
   *
   * Cached because {@link turnBox} is read on every frame — the depth the band
   * is cut to is a function of the box and the zoom — and this is four layout
   * reads and a `getComputedStyle`, which is a synchronous relayout of the
   * document per frame of every pan. Refreshed where the room can actually have
   * changed, which is a resize of the panel, and it is the resize observer that
   * says so.
   */
  private measureRoom(): { width: number; height: number } {
    const body = this.grid.parentElement
    // The stacks themselves, rather than whatever is left of the grid once the
    // map is taken out of it: the grid is held open at the height a square map
    // would have claimed, so "the grid less the map" is mostly *slack*, and a
    // ceiling computed from it would shrink by exactly as much as the box grew.
    // Nothing to subtract on the vertical, where `--map-budget` has already
    // taken the stacks out of the window for itself — subtracting them again is
    // how a map with ten tracks under it got a ceiling below its own floor, and
    // every drag of the top edge collapsed the band to the minimum.
    const beside =
      this.lanes.canvasFor('left').clientWidth + this.lanes.canvasFor('right').clientWidth
    const width = (body?.clientWidth ?? this.hostSize.width) - beside
    // The wrap's `max-height` rather than the custom property it is written
    // from: a custom property comes back as the `clamp()` that was written,
    // unresolved, and the number wanted here is the one the browser worked out
    // from it. It is the height a square map would have claimed, which is the
    // point past which a band has stopped being one.
    const budget = Number.parseFloat(getComputedStyle(this.wrap).maxHeight)
    const height = Number.isFinite(budget) ? budget : this.hostSize.height
    this.room = {
      width: Math.max(MIN_TURN_WIDTH, Math.round(width)),
      height: Math.max(MIN_TURN_HEIGHT, Math.round(height)),
    }
    return this.room
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
    const height = Math.max(1, this.turnBox().height - margin.top - margin.bottom)
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
    if (turn !== undefined && turn !== null) turn.maxSeparation = next.maxSeparation
    this.lanes.setAxes(this.locusAxes)
  }

  /**
   * Write the box onto the grid, and put the handles where its edges are.
   *
   * The size lives in CSS custom properties rather than in inline widths so that
   * the map, the lane stacks under it and the centring are one layout decided in
   * one place — the stacks take their width from the map's canvas, so a box that
   * narrowed only the map would leave the tracks pointing at the wrong base
   * pairs (`ui/AnnotationLanes.ts`).
   */
  private writeTurnBox(): void {
    const turned = this.turned !== null
    this.grid.classList.toggle('is-turned', turned)
    if (!turned) {
      this.grid.style.removeProperty('--turn-width')
      this.grid.style.removeProperty('--turn-height')
      // A square map's side, on the same terms: one number, written where the
      // stylesheet's own default sits so that the default is what an unset size
      // falls back to (`--map-size` defaults to `--map-budget` in `styles.css`).
      // Written on every refit rather than only on a drag, because "as much as
      // there is" is a rule and the room moves under it.
      this.grid.style.setProperty('--map-size', `${Math.round(this.mapSize())}px`)
      return
    }
    this.grid.style.removeProperty('--map-size')
    const box = this.turnBox()
    this.grid.style.setProperty('--turn-width', `${Math.round(box.width)}px`)
    this.grid.style.setProperty('--turn-height', `${Math.round(box.height)}px`)
  }

  /**
   * The side a square map is drawn at, in CSS pixels.
   *
   * {@link turnBox}'s counterpart, and clamped on the way out for the same
   * reasons: what is stored is one number for the session, the panels drawing
   * from it need not have the same room, and "as much as there is" is a rule that
   * has to be re-read whenever the room changes rather than a width remembered
   * from another window.
   */
  private mapSize(): number {
    return fitMapSize(getMapSize(), this.turnRoom())
  }

  /**
   * Resize the box, in CSS pixels. `null` on either axis puts the default back.
   *
   * Written to the store rather than to a field here, so it outlives this panel:
   * a change of resolution or of chromosome destroys the panel and builds
   * another, and a box held on the instance is one the reader loses the first
   * time they go and look at something in it (`ui/turnBox.ts`).
   *
   * Clamped against the panel rather than against the block — the box is a fact
   * about the figure, so what bounds it is how much room there is to draw in —
   * and against *this* panel's room, which is the one the hand is in. Reading it
   * back clamps again, for the panels the hand is not in.
   */
  private setTurnBox(next: { width?: number | null; height?: number | null }): void {
    const room = this.turnRoom()
    const fit = (value: number, low: number, high: number): number =>
      Math.max(low, Math.min(high, Math.round(value)))
    const asked: Partial<TurnBox> = {}
    if (next.width !== undefined) {
      asked.width = next.width === null ? null : fit(next.width, MIN_TURN_WIDTH, room.width)
    }
    if (next.height !== undefined) {
      asked.height = next.height === null ? null : fit(next.height, MIN_TURN_HEIGHT, room.height)
    }
    rememberTurnBox(asked)
  }

  /**
   * Draw the box at whatever size it now is.
   *
   * The subscription's half of the resize, and every panel runs it — the one the
   * hand is in and the others of a deck, which is what keeps a deck of bands one
   * shape (§17.3). Both presentations arrive here: a square map has a size to be
   * drawn at too, and the panel the hand is *not* in has to follow it.
   */
  private applyTurnBox(): void {
    this.writeTurnBox()
    // The canvas has a new CSS size, and nothing else will tell the view: the
    // resize observer watches the *grid*, whose own size need not have changed.
    this.heatmap.resize()
    this.schedule()
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
   * counts and a colour is worth a different number in each. Under a ratio or a
   * difference there is one derived field over the whole square — `neutral` is
   * what says so — and a second key would be a second scale for numbers that no
   * longer exist.
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

  private keyFor(scale: ColorScale, prefix = ''): KeyContent {
    const scores = this.options.scores
    const choice = scores?.choices.find((entry) => entry.id === scores.current)
    // The picker's word where there is a picker; otherwise the one fact about
    // the read that is always known. A derived field that has taken over the
    // square — a ratio, a difference — names itself and nothing else, because
    // there is no longer one file's score in the cells to name.
    const base =
      this.comparisonLabel() !== null
        ? ''
        : (choice?.label ?? this.scoreLabel ?? '') !== ''
          ? (choice?.label ?? this.scoreLabel)
          : this.options.balance === true
            ? 'balanced'
            : 'count'
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
    if (this.narrow) return
    const painted = this.painted
    if (painted === null) return
    const palette = readCanvasPalette(this.canvas)
    const plot = this.heatmap.plotRect
    ctx.setTransform(scale, 0, 0, scale, 0, 0)
    const style = {
      font: 'system-ui, sans-serif',
      textColor: readPageText(this.canvas),
      background: readPageBackground(),
      borderColor: palette.labelColor,
    }
    const right = origin.x + plot.x + plot.width - KEY_INSET
    const box = drawKey(ctx, right, origin.y + plot.y + KEY_INSET, this.keyFor(painted), style)
    if (this.second !== null && this.neutral === null) {
      drawKey(
        ctx,
        right,
        box.y + box.height + 4,
        this.keyFor(rescaledBy(painted, this.second.gain), this.secondMark()),
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
      (held?.baseline === true) === (derive?.baseline === true)
    this.options.derive = derive
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
    // {@link correlationNote} — so a clear arriving from `setData` puts the
    // longer wait back rather than taking the veil away.
    if (!busy && this.correlationNote !== null) {
      this.overlay.textContent = this.correlationNote
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
   * Whether the second file's counts are scaled to the first's bright end.
   *
   * The reader's choice everywhere, and only the *default* differs by operation.
   * Two libraries at different depth differ by roughly a scalar; under the split
   * that scalar is a real reading about two real files and the honest default is
   * to leave it in, while a ratio of raw counts *is* that scalar everywhere — a
   * flat wash whose colour is the depth difference and whose structure is
   * invisible — so there it is divided out unless the reader says otherwise.
   *
   * **Balanced values are the exception, and they are the common case.** ICE
   * puts every bin's marginal at 1, so two balanced matrices already carry one
   * normalisation and there is no depth left in them to correct: on an E. coli
   * pair at 5 kb the two marginals agree to 0.2%, and matching the 99th
   * percentiles on top of that rescaled the second file by 1.48 — a uniform
   * `log2` shift of −0.56 applied to every cell of the ratio. On the ±1 scale a
   * ratio map is drawn with, that is a quarter of the picture's whole range: the
   * near-diagonal band that a separate tool draws at +0.60 came out at +0.04,
   * white instead of red, and the map disagreed with the same comparison made
   * anywhere else.
   *
   * The reason it fails there is worth naming, because it is not a matter of
   * degree. The 99th percentile of a Hi-C map lives entirely in the first few
   * diagonals, which is exactly where two conditions differ — so matching on it
   * does not remove a depth difference, it removes the finding. It is the right
   * statistic for the split, whose question is "can I see both triangles", and
   * the wrong one for a ratio, whose question is "by how much do these differ".
   *
   * Forced off for neither: a reader comparing two raw-count files still has the
   * tickbox, which is now offered under all three operations rather than hidden
   * under two of them.
   */
  private compareNormalising(op: CompareOp): boolean {
    const chosen = this.options.compare?.normalise
    if (chosen !== undefined) return chosen
    return depthMatchDefault(op, this.options.balance === true)
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
    this.divergingRestore ??= {
      transform: this.transform,
      colormap: this.colormap,
      vmin: this.manualVmin,
      vmax: this.manualVmax,
    }
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
    if (this.options.derive?.baseline === true) return this.comparisonLabel() ?? 'expected'
    return this.comparisonLabel() ?? (this.options.derive?.expected === true ? 'O/E' : null)
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
    this.heatmap.setScale(this.scale())
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
      this.viewNote.textContent = this.viewPhrase()
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
        // The second file's key measures the same colours in *its* counts. With
        // no gain the two carry identical numbers, and the second is still
        // worth drawing: what it says then is that the two are on one scale,
        // which is exactly the claim the reader is relying on.
        if (this.second !== null) {
          this.key2.set(this.keyFor(rescaledBy(effective, this.second.gain), this.secondMark()))
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
    this.laneHoverListener = listener
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

  /** Hand the current lane hover to whoever is listening, in matrix units. */
  private reportLaneHover(): void {
    const listen = this.laneHoverListener
    if (listen === null) return
    const guide = this.laneHover
    if (guide === null) {
      listen(null)
      return
    }
    // The same conversion {@link paintLaneGuide} makes, and for the same reason
    // it needs none of its own: §8.4 glues the lane canvases to the map's along
    // the axis they share, so a pixel on the stack is a pixel on the plot.
    const plot = this.heatmap.plotRect
    const horizontal = laneIsHorizontal(guide.edge)
    const unit = horizontal
      ? this.heatmap.scaleX.toUnit(guide.along - plot.x)
      : this.heatmap.scaleY.toUnit(guide.along - plot.y)
    listen({ axis: horizontal ? 'cols' : 'rows', unit })
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
   */
  syncScoreChoice(id: string): void {
    const select = this.scoreSelect
    if (select === null || select.value === id) return
    // Only to an option it has: a file that fell back to counts because it has
    // no such column would otherwise be left with a blank picker.
    if (Array.from(select.options).some((option) => option.value === id)) select.value = id
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
  framedRegion(): { contig: string; start: number; end: number } | null {
    if (this.data === null) return null
    const windows = this.framedWindows(this.locusAxes.cols, this.heatmap.scaleX)
    if (windows.length !== 1) return null
    const only = windows[0]
    return only.end > only.start
      ? { contig: only.contig, start: only.start, end: only.end }
      : null
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
    if (LANE_EDGES.every((edge) => next[edge] === this.laneBudget[edge])) return
    this.laneBudget = next
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
    return thickness <= 0 ? 0 : thickness + LANE_GAP
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
    const windows = this.framedWindows(this.locusAxes.rows, this.heatmap.scaleY)
    const only = windows.length === 1 ? windows[0] : undefined
    return only === undefined ? undefined : formatLocus(only)
  }

  /** The stretches of sequence one axis currently shows. */
  private framedWindows(axis: LocusAxis | null, scale: Scale): LocusWindow[] {
    if (axis === null) return []
    const [d0, d1] = scale.domain
    const lo = Math.max(0, Math.floor(d0))
    const hi = Math.min(axis.unitEnd, Math.ceil(d1))
    return hi > lo ? axis.windows([lo, hi]) : []
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
      this.framedWindows(this.locusAxes.rows, this.heatmap.scaleY),
      this.framedWindows(this.locusAxes.cols, this.heatmap.scaleX),
    )
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

    if (cell === null || this.data === null) {
      setReadout('')
      this.tooltip.classList.add('hidden')
      return
    }
    this.tip.matrix.classList.remove('hidden')
    this.tip.lane.classList.add('hidden')
    const data = this.data
    // A pointer over a turned map is over a band row and a half-bin column, and
    // neither is a coordinate of the block the readout describes. Mapped back
    // first, so everything below — the two names, the positions, the distance,
    // the counts — is the same code reading the same square block it always did.
    const square = this.squareCell(cell)
    const rowGroup = groupAt(data.rowGroups, square.row)
    const colGroup = groupAt(data.colGroups, square.col)
    // Positions are measured in absolute bin space, so each axis needs the bin
    // its own block starts at — they differ on a rectangular two-contig block.
    const rowStart = data.rowExtent[0]
    const colStart = data.colExtent[0]
    const rowLabel = describeAxis(rowGroup, square.row, data.level, this.options.binsize, rowStart)
    const colLabel = describeAxis(colGroup, square.col, data.level, this.options.binsize, colStart)

    // A turned map with a span modifier held is a reader about to name a stretch
    // of the genome, and the whole of what they are pointing at is *where along
    // the bottom* the pointer is. The pair of loci and the distance between them
    // answer the question the pointer was asking a moment ago — they are a fact
    // about the cell under it, and the cell is not what the next drag will
    // select. The crosshair already says so, standing up as one vertical line
    // where the readout went on describing a contact ({@link spanGuide}).
    if (at?.span === true && this.turned !== null) {
      this.describeAlong(square, data, at)
      return
    }
    // `cell.value` is what was *drawn*, which below the diagonal of a compared
    // map is the second file's count with any gain already in it. Neither half
    // of that is what a reader is asking about, so the numbers here come from
    // the blocks themselves: each file's own count, unscaled, at this cell.
    const compare = this.options.compare
    const slot = square.row * data.ncols + square.col
    const mine = this.second === null ? cell.value : data.values[slot]
    const count = Number.isNaN(mine) ? 'NaN (unbalanced)' : fmt.num(mine)
    const counts =
      this.second === null || compare === undefined
        ? `count ${count}`
        : `${compare.labels[0]} ${count}   ·   ${compare.labels[1]} ${
            Number.isNaN(this.second.data.values[slot])
              ? 'NaN (unbalanced)'
              : fmt.num(this.second.data.values[slot])
          }`
    // A derived cell is two questions, and answering only the second is what
    // makes a ratio map unreadable: "1.8× expected" is the reading, and "37
    // contacts" is what tells you whether to believe it. A departure computed
    // from three counts against a baseline of two is noise, and only the raw
    // numbers beside it say so.
    //
    // **Transposed in the mirrored band**, because that is the band's own file:
    // the drawn square holds the first file above the matrix diagonal and the
    // second below it, and a pointer under the shared axis is on the second.
    // Read the untransposed cell there and a reader hovering the lower band is
    // told the upper one's O/E, which is a real number from a real cell and not
    // the cell they are pointing at.
    const lower = this.turned !== null && bandAt(this.turned, cell.row) === 1
    const reading = lower
      ? this.derivedReading(square.col, square.row)
      : this.derivedReading(square.row, square.col)
    // The genome each end belongs to, read before the distance because the
    // distance needs them: two MAGs may each have a `contig_1`, and on a
    // coarsened axis the name is most of what is left to tell them apart.
    const rowGenome = groupAt(data.rowGenomes, square.row)?.label
    const colGenome = groupAt(data.colGenomes, square.col)?.label
    const distance = separationOf(
      { group: rowGroup, offset: square.row, blockStart: rowStart, genome: rowGenome },
      { group: colGroup, offset: square.col, blockStart: colStart, genome: colGenome },
      data.level,
      this.options.binsize,
    )

    // On a turned map the separation *is* the y axis, so it leads: the reader's
    // eye is already on a height and the number under it is what they are asking
    // to have confirmed.
    const apart = distance === null ? '' : `   ${fmt.bp(distance)} apart`
    setReadout(
      (this.turned === null ? `${rowLabel}  ×  ${colLabel}${apart}` : `${rowLabel}${apart}`) +
        (reading === null ? '' : `   ${reading}`) +
        `   ${counts}`,
    )

    // The names in full, unabbreviated, and each name written *once*: the axis
    // labels are elided when the blocks are narrow, so the tooltip is often the
    // only place the pair is spelled out — but on the diagonal of a contig map
    // the old layout printed `NODE_8524_len_441121` four times, and the number
    // the pointer is actually asking about was the last thing on the card.
    const sameBlock = rowGroup !== undefined && colGroup !== undefined && rowGroup.label === colGroup.label
    // `square`, like everything above: a turned cell's own row is a *separation*
    // and its column is a half-bin, so read through the block's own arithmetic
    // they name a position half way along the picture and a distance up it. The
    // two names and the "apart" line were mapped back and these two were not,
    // which is why the card could show the right sequence, the right separation
    // and a pair of coordinates belonging to neither.
    const rowPos = positionIn(rowGroup, square.row, data.level, this.options.binsize, rowStart)
    const colPos = positionIn(colGroup, square.col, data.level, this.options.binsize, colStart)

    // Written in place rather than rebuilt. `replaceChildren` with five fresh
    // elements ran on every pointer move — 4-6 allocations and as many
    // detachments per event, on the highest-frequency path in the app — to
    // produce a card whose *shape* almost never changes. Only the text does.
    const tip = this.tip
    tip.rowName.textContent = sameBlock ? rowGroup.label : (rowGroup?.label ?? '—')
    tip.times.classList.toggle('hidden', sameBlock)
    tip.colName.classList.toggle('hidden', sameBlock)
    if (!sameBlock) tip.colName.textContent = colGroup?.label ?? '—'
    const hasPos = rowPos !== null && colPos !== null
    tip.pos.classList.toggle('hidden', !hasPos)
    if (hasPos) tip.pos.textContent = `${rowPos}  ×  ${colPos}`

    // The genome line, on the same "written once when it is one name" rule as
    // the contigs above it. Absent entirely where the reader sent no genomes —
    // a plain cooler, or any view that already is one genome. Read above, where
    // the separation needed them.
    const hasGenome = rowGenome !== undefined || colGenome !== undefined
    tip.genomes.classList.toggle('hidden', !hasGenome)
    if (hasGenome) {
      const oneGenome = rowGenome === colGenome
      tip.rowGenome.textContent = rowGenome ?? '—'
      tip.genomeTimes.classList.toggle('hidden', oneGenome)
      tip.colGenome.classList.toggle('hidden', oneGenome)
      if (!oneGenome) tip.colGenome.textContent = colGenome ?? '—'
    }

    tip.distance.classList.toggle('hidden', distance === null)
    if (distance !== null) tip.distance.textContent = `${fmt.bp(distance)} apart`

    // With two files open the count line carries both — the whole question a
    // compared map is asked at every position is how the two differ *here*, and
    // answering it with only the visible half would mean reading the picture
    // twice, once on each side of the diagonal, to compare one locus.
    tip.count.classList.remove('hidden')
    tip.count.textContent = counts
    this.showTip(at)
  }

  /**
   * The readout for a pointer naming a **place** rather than a cell.
   *
   * One coordinate, because that is the whole of what the gesture is about: a
   * span drag on a turned map names a stretch of the genome, and where the
   * pointer is along the bottom is the only thing about it that is being chosen.
   * The midpoint of the cell's two ends *is* that position — a turned column
   * stands over the middle of the pair it draws (`render/rotate.ts`) — so this
   * is the same number the ruler under the pointer is printing, and the same one
   * the guide is standing on.
   *
   * No distance and no count. Both are facts about the cell, both were on the
   * card a moment ago, and leaving them there while the crosshair has already
   * become a single vertical line is the card describing a different gesture
   * from the one the hand is making.
   */
  private describeAlong(
    square: { row: number; col: number },
    data: MatrixResult,
    at?: { x: number; y: number },
  ): void {
    const along = alongAxis(square)
    // The group is asked for at a whole cell — a midpoint may land half way
    // between two — while the *position* is measured at the midpoint itself.
    const group = groupAt(data.rowGroups, Math.floor(along))
    const start = data.rowExtent[0]
    const genome = groupAt(data.rowGenomes, Math.floor(along))?.label
    setReadout(describeAxis(group, along, data.level, this.options.binsize, start))

    const tip = this.tip
    tip.rowName.textContent = group?.label ?? '—'
    tip.times.classList.add('hidden')
    tip.colName.classList.add('hidden')
    const pos = positionIn(group, along, data.level, this.options.binsize, start)
    tip.pos.classList.toggle('hidden', pos === null)
    if (pos !== null) tip.pos.textContent = pos
    tip.genomes.classList.toggle('hidden', genome === undefined)
    if (genome !== undefined) {
      tip.rowGenome.textContent = genome
      tip.genomeTimes.classList.add('hidden')
      tip.colGenome.classList.add('hidden')
    }
    tip.distance.classList.add('hidden')
    tip.count.classList.add('hidden')
    this.showTip(at)
  }

  /**
   * Put the card up where the pointer is, or leave it down.
   *
   * The one gate for the card on this surface, and it is deliberately the last
   * thing rather than the first: everything above it still runs, because the
   * readout on the status line is the same measurement, so turning the card off
   * costs a hover nothing and gives back the few hundred square pixels it was
   * covering.
   */
  private showTip(at?: { x: number; y: number }): void {
    if (!getPlotOptions().tooltip) {
      this.tooltip.classList.add('hidden')
      return
    }
    this.tooltip.classList.remove('hidden')
    if (at !== undefined) this.placeTooltip(at.x, at.y)
  }

  /**
   * Keep the tooltip inside the panel.
   *
   * Offset from the pointer so it never sits under it, and flipped to the other
   * side near an edge — a tooltip clipped by the panel border is worse than no
   * tooltip, because it looks like the value is missing.
   *
   * Both measurements it needs are *cached*, and that is the whole point. The
   * old version read `offsetWidth`/`offsetHeight` immediately after writing the
   * card's contents, which forces the browser to lay out the document
   * synchronously — twice per pointer move, at whatever rate the device reports
   * them. The host's size now comes from the `ResizeObserver` that already
   * watches it, and the tooltip's own size is re-measured at most once per
   * frame, inside a `requestAnimationFrame` where layout is already clean.
   */
  private placeTooltip(x: number, y: number): void {
    this.tipAt = { x, y }
    this.positionTooltip()
    if (this.tipFrame !== 0) return
    this.tipFrame = requestAnimationFrame(() => {
      this.tipFrame = 0
      const width = this.tooltip.offsetWidth
      const height = this.tooltip.offsetHeight
      if (width === this.tipSize.width && height === this.tipSize.height) return
      this.tipSize = { width, height }
      this.positionTooltip()
    })
  }

  /** Write the transform from the cached geometry. No reads, no layout. */
  private positionTooltip(): void {
    const at = this.tipAt
    if (at === null) return
    const pad = 14
    const { width, height } = this.tipSize
    const host = this.hostSize
    const left = at.x + pad + width > host.width ? at.x - pad - width : at.x + pad
    const top = at.y + pad + height > host.height ? at.y - pad - height : at.y + pad
    this.tooltip.style.transform = `translate(${Math.max(0, left)}px, ${Math.max(0, top)}px)`
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

/** Which group covers a block-local offset. Absent list, absent answer. */
/**
 * Which edge of its box a turned block is pinned to — see the caller for why it
 * is pinned at all.
 *
 * `middle` for a square map, which is centred like any picture, and for a
 * **mirrored pair**, whose diagonal is the line down the middle of it rather
 * than either edge. `end` and `start` are the one-band cases, standing on
 * whichever edge their own diagonal is.
 *
 * Exported for the test: the whole of the bug it fixes is invisible until a
 * band is deeper than its box, which is two zooms away from any state a test
 * can set up directly.
 */
export function anchorFor(turned: RotatedBlock | null): VerticalAnchor {
  if (turned === null || turned.fold !== undefined) return 'middle'
  return turned.direction === 'down' ? 'start' : 'end'
}

/**
 * Where a cell of a turned map stands on the genomic axis, in cells of the
 * square block it was turned out of.
 *
 * The **midpoint** of the pair it is a contact between, which is what a turned
 * column is: the rotation puts the cell for `(i, j)` over `(i + j) / 2` and its
 * height carries the rest (`render/rotate.ts`). Half-integers are the ordinary
 * case rather than an edge one — a column is half a bin — and are passed on
 * rather than rounded, since the arithmetic below them is linear and the reader
 * is being told a position, not a bin.
 */
export function alongAxis(square: { row: number; col: number }): number {
  return (square.row + square.col) / 2
}

export function groupAt(
  groups: AxisGroup[] | undefined,
  offset: number,
): AxisGroup | undefined {
  if (groups === undefined) return undefined
  let lo = 0
  let hi = groups.length - 1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    const group = groups[mid]
    if (offset < group.start) hi = mid - 1
    else if (offset >= group.end) lo = mid + 1
    else return group
  }
  return undefined
}

/**
 * Base pairs from the start of the **contig** to the start of a cell.
 *
 * `group.start` is block-local, so `(offset - group.start) * binsize` measures
 * from the left edge of the picture rather than from the contig — the same
 * number only when the block begins on a contig boundary. A region view of
 * `contig:139005-199005` begins at bin 139, and the readout used to call that
 * cell 0 bp when it is 139 kb into the contig. `unitStart` is where the contig
 * itself begins, so the absolute bin `blockStart + offset` resolves correctly
 * (§3.3 arithmetic throughout; `/bins` is never consulted).
 */
/**
 * A cell window on one axis, as absolute bins of the file.
 *
 * Outward on both ends, and **clamped to the block**, because a window naming
 * bins the block does not hold is not a window — at fit zoom the plot is wider
 * than the picture and the raw cell window runs off both sides into the margins.
 *
 * Leaving it unclamped, briefly, was a bug with real teeth: a *fitted* view then
 * reported a window wider than its own block, the ladder read that as "the
 * reader has gone outside what they have", and every view that opened fitted
 * immediately asked for a widening read of its own whole domain. On a small file
 * that is a wasted read nobody notices. On a 660 MB mouse cooler it is minutes
 * of scanning, with the map frozen for the duration, before the reader has
 * touched anything.
 *
 * The signal it was standing in for — *the reader wants to go past this block* —
 * is `BlockLadder.atEdge`'s to give, and it gives it from the block and the
 * ceiling rather than from a window that has been allowed to lie.
 *
 * `binsPerCell` may be fractional — a turned column is half a bin — which is why
 * the rounding is done after the multiply rather than on the cell index.
 */
export function binsOf(
  window: readonly [number, number],
  extent: Extent,
  binsPerCell: number,
): Extent {
  const lo = extent[0] + Math.floor(window[0] * binsPerCell)
  const hi = extent[0] + Math.ceil(window[1] * binsPerCell)
  return [
    Math.max(extent[0], Math.min(lo, extent[1])),
    Math.min(extent[1], Math.max(hi, extent[0])),
  ]
}

/**
 * Two loci, as a cell interval on a given axis — the second half of a regrid.
 *
 * `null` where the axis cannot answer: no locus at all, a contig it does not
 * cover, or an interval that came back inverted. Every one of those is a reason
 * to leave the picture alone rather than to place it approximately, because a
 * map drawn over the wrong stretch of genome looks exactly like a map drawn over
 * the right one.
 *
 * Clamped to the block, since the incoming window is padded beyond the view and
 * its edges can fall outside a block that stopped at a sequence end.
 */
export function spanOnAxis(
  axis: LocusAxis | null,
  want: { from: { contig: string; bp: number }; to: { contig: string; bp: number } } | null,
  cells: number,
): readonly [number, number] | null {
  if (axis === null || want === null) return null
  const lo = axis.locusToUnit(want.from.contig, want.from.bp)
  const hi = axis.locusToUnit(want.to.contig, want.to.bp)
  if (lo === null || hi === null) return null
  const from = Math.max(0, Math.min(lo, cells))
  const to = Math.min(cells, Math.max(hi, from))
  return to > from ? [from, to] : null
}

export function bpWithin(
  group: AxisGroup,
  offset: number,
  blockStart: number,
  binsize: number,
): number {
  const first = group.unitStart ?? blockStart + group.start
  return (blockStart + offset - first) * binsize
}

/**
 * What one axis measures in base pairs, or `null` when it measures nothing a
 * position could be expressed in.
 *
 * Both refusals are the ones `_bin_axis` makes in `ops/show.py`. Above bin
 * level a cell *is* a contig or a genome, so a position inside one would be an
 * invention. Across more than one contig there is no single coordinate system:
 * the ticks are the contig names there, and they already are.
 *
 * The line itself is {@link bpWithin} at offset 0, from the same `unitStart`,
 * so a tick and the readout under the pointer cannot disagree.
 *
 * @param fraction How much of a bin one **cell** spans — a half under a turn,
 * where the rotated lattice counts in half bins (`render/rotate.ts`), and one
 * everywhere else. It scales the ruler's step and nothing else: where the block
 * *starts* is a distance from the contig's first bin, measured in whole bins by
 * everything that reads it, and folding the cell size into that offset put the
 * turned map's ruler half of the way into the block behind the picture on it.
 */
export function axisCoordsFor(
  groups: AxisGroup[],
  extent: readonly [number, number],
  level: 'bin' | 'contig' | 'genome',
  binsize: number,
  fraction = 1,
): AxisCoords | null {
  if (level !== 'bin' || groups.length !== 1 || !(binsize > 0)) return null
  const group = groups[0]
  const first = group.unitStart ?? extent[0] + group.start
  return { bpPerCell: binsize * fraction, bpAtOrigin: (extent[0] - first) * binsize }
}

/**
 * A ruler per sequence, for an axis that has no single one.
 *
 * {@link axisCoordsFor}'s complement, and its refusals inverted: it answers for
 * an axis of *one* contig at bin level, this answers for an axis of several,
 * and above bin level neither answers at all — a cell there *is* a contig or a
 * genome, and a position inside one would be an invention.
 *
 * Each stretch's line is stated in the **block's** coordinate frame, which is
 * `axisCoordsFor`'s own arithmetic applied per group: `bpAtOrigin` is what this
 * contig's ruler would read at cell zero of the block, negative for every
 * contig but the first, so a tick's `unit` needs no offsetting to be a matrix
 * coordinate like any other.
 *
 * A cell that several short sequences share is skipped, on {@link describeAxis}'s
 * rule: the pixel is all of them, and a coordinate inside one of them names a
 * place the picture does not show.
 *
 * And nothing at all past {@link MAX_RULED_SPANS}. A metagenome's axis is
 * thousands of contigs, each a pixel or less: there is no room for a position on
 * any of them, the names are already elided for the same reason, and building
 * the list would cost more than the ruler it cannot draw.
 */
export function axisSpansFor(
  groups: AxisGroup[],
  extent: readonly [number, number],
  level: 'bin' | 'contig' | 'genome',
  binsize: number,
): AxisSpan[] {
  if (level !== 'bin' || !(binsize > 0)) return []
  if (groups.length < 2 || groups.length > MAX_RULED_SPANS) return []
  const out: AxisSpan[] = []
  for (const group of groups) {
    if ((group.merged?.length ?? 1) > 1) continue
    if (!(group.end > group.start)) continue
    const first = group.unitStart ?? extent[0] + group.start
    out.push({
      from: group.start,
      to: group.end,
      coords: { bpPerCell: binsize, bpAtOrigin: (extent[0] - first) * binsize },
    })
  }
  return out
}

/**
 * How many sequences an axis may carry and still be ruled one at a time.
 *
 * A genome's worth, generously: sixteen chromosomes, or a few hundred scaffolds.
 * Past that the stretches are narrower than a label and the answer is the same
 * one the block names give — none — so the list is not built at all.
 */
const MAX_RULED_SPANS = 512

/**
 * One side of the hover readout. At bin level the position inside the contig is
 * exact arithmetic from the bin size (§3.3) — `/bins` is never consulted.
 */
function describeAxis(
  group: AxisGroup | undefined,
  offset: number,
  level: 'bin' | 'contig' | 'genome',
  binsize: number,
  blockStart: number,
): string {
  if (group === undefined) return '—'
  // A cell that several small sequences share has no position inside any one of
  // them, so it is named by what it holds rather than by a coordinate. Saying
  // `Contig_184898:0 bp` there names one of two sequences and invents a
  // coordinate for it; the pixel is both, and the readout says so.
  if (group.merged !== undefined && group.merged.length > 1) {
    const [first, ...rest] = group.merged
    return rest.length === 1
      ? `${first.label} + ${rest[0].label}`
      : `${first.label} + ${fmt.int(rest.length)} more`
  }
  if (level !== 'bin') return group.label
  return `${group.label}:${fmt.bp(bpWithin(group, offset, blockStart, binsize))}`
}

/**
 * One axis of the cell under the pointer, as {@link separationOf} needs it.
 *
 * The block's own origin is in it because a *coarsened* axis is measured in
 * cells while its extent is measured in bins, and the only arithmetic that gets
 * both right is {@link bpWithin}'s — which needs the origin. Subtracting the two
 * absolute indices instead is exact on a dense block and wrong by the pooling
 * factor on every other, which is how the line went quiet on the views that are
 * always pooled: anything larger than the picture.
 */
export interface AxisSide {
  group: AxisGroup | undefined
  /** Block-local offset of the cell on this axis — `cell.row` or `cell.col`. */
  offset: number
  /** Where the block starts on this axis — `rowExtent[0]` or `colExtent[0]`. */
  blockStart: number
  /** The genome this sequence belongs to, where the axis names one. */
  genome?: string | undefined
}

/**
 * How far apart the two ends of a cell are along the sequence, in base pairs.
 *
 * The genomic distance is what a cis contact *means* — a Hi-C map is read by
 * how the signal falls off with separation, and without this the tooltip makes
 * you subtract two coordinates to get it. `null` where the question has no
 * answer, and each of those is a refusal rather than a gap:
 *
 * - **above bin level**, where a cell is a whole contig or genome and its two
 *   ends have no positions to subtract;
 * - **across two sequences**, where the contact is trans and a distance along
 *   the sequence does not exist — not a large one, none;
 * - **on a cell several sequences share**, which has no position in any one of
 *   them; the readout says so in words there and must not say it in numbers
 *   here;
 * - **on the diagonal**, where it is zero and saying so is noise on the line
 *   that matters least.
 *
 * The two positions come from {@link bpWithin}, the same function the tooltip's
 * own coordinates come from, so the difference on screen and the difference
 * quoted here cannot disagree — and both are right whether the block is the
 * file's own grid or a coarsened one.
 */
export function separationOf(
  row: AxisSide,
  col: AxisSide,
  level: 'bin' | 'contig' | 'genome',
  binsize: number,
): number | null {
  if (level !== 'bin' || !(binsize > 0)) return null
  const { group: rowGroup } = row
  const { group: colGroup } = col
  if (rowGroup === undefined || colGroup === undefined) return null
  if ((rowGroup.merged?.length ?? 1) > 1 || (colGroup.merged?.length ?? 1) > 1) return null
  if (!sameSequence(row, col)) return null
  const apart = Math.abs(
    bpWithin(rowGroup, row.offset, row.blockStart, binsize) -
      bpWithin(colGroup, col.offset, col.blockStart, binsize),
  )
  return apart === 0 ? null : apart
}

/**
 * Whether two axis runs are the same sequence.
 *
 * `unitBin` first, because it is the only member that is an *identity*: the
 * absolute bin the sequence itself begins at, the same number on both axes
 * however each axis's block opens. It tells two windows of one contig apart
 * from two contigs without trusting a string, which matters on a metagenome
 * where two MAGs may each have a `contig_1`.
 *
 * `unitStart` is an arithmetic *origin* and only coincides with the identity on
 * a dense block: a coarsened axis is anchored to the contig, so its origin
 * depends on where that axis's own window starts, and `contig × the same contig`
 * over two different windows gets two different numbers for one sequence. It is
 * kept as the second test for a block that carries no identity — an older
 * worker answering a newer page.
 *
 * The name, the length and the genome together are the last resort, and as
 * close to identity as a run with neither number can get.
 */
function sameSequence(row: AxisSide, col: AxisSide): boolean {
  const a = row.group
  const b = col.group
  if (a === undefined || b === undefined) return false
  if (a.unitBin !== undefined && b.unitBin !== undefined) return a.unitBin === b.unitBin
  if (a.unitStart !== undefined && b.unitStart !== undefined) return a.unitStart === b.unitStart
  return a.label === b.label && a.unitLength === b.unitLength && row.genome === col.genome
}

/**
 * The offset inside a block, without its name — the tooltip's second line.
 *
 * `null` above bin level, where a cell *is* the block and a position inside it
 * would be an invention.
 */
function positionIn(
  group: AxisGroup | undefined,
  offset: number,
  level: 'bin' | 'contig' | 'genome',
  binsize: number,
  blockStart: number,
): string | null {
  if (group === undefined || level !== 'bin') return null
  return fmt.bp(bpWithin(group, offset, blockStart, binsize))
}

/**
 * The colours the canvas borrows from the stylesheet.
 *
 * Only three: the labels, their halo, and the plot frame. The separator and
 * crosshair colours are `ops/show.py`'s and stay fixed, so a screenshot from
 * the browser and a figure from the CLI remain the same image.
 *
 * Read off `from` — a node inside the centre column — and *not* off the document
 * element. The centre column re-declares the light palette regardless of theme
 * (see `.content` in the stylesheet), because a contact map is a figure and its
 * colormaps are built for ink on white. Reading from the root instead gave a
 * dark-theme plot a black label halo on a white matrix, and exported it that
 * way. The fallbacks are the light values for the same reason: a canvas asked
 * before it is in the document has no computed custom properties, and the right
 * answer for it is the palette it is going to be mounted into.
 */
export function readCanvasPalette(from: Element): {
  labelColor: string
  labelHaloColor: string
  plotBorderColor: string
  /** A wash for alternating blocks — the browser's sequence bands. */
  bandColor: string
} {
  const style = getComputedStyle(from)
  const pick = (name: string, fallback: string): string => {
    const value = style.getPropertyValue(name).trim()
    return value === '' ? fallback : value
  }
  return {
    labelColor: pick('--text-dim', '#5b6169'),
    labelHaloColor: pick('--bg', '#ffffff'),
    plotBorderColor: pick('--border-strong', '#b9bec5'),
    bandColor: pick('--bg-sunken', '#f6f7f8'),
  }
}

/**
 * Body text for the exported caption's first line.
 *
 * From the plot's own box, not the page's: the caption is drawn onto the figure,
 * which is light, so page text in a dark theme would have written it in pale
 * grey on white.
 */
function readPageText(from: Element): string {
  const value = getComputedStyle(from).getPropertyValue('--text').trim()
  return value === '' ? '#16181d' : value
}

/** Caption geometry, in CSS pixels. */
const CAPTION_TOP = 14
const CAPTION_TITLE_LINE = 19
const CAPTION_DETAIL_LINE = 16
const CAPTION_TITLE_FONT = '600 15px system-ui, sans-serif'
const CAPTION_DETAIL_FONT = '12px system-ui, sans-serif'

/** One drawn caption line; `strong` is the subject, the rest is provenance. */
interface CaptionLine {
  text: string
  strong: boolean
}

/** Total height of a caption block, in CSS pixels. */
function captionHeightOf(lines: CaptionLine[]): number {
  if (lines.length === 0) return 0
  return (
    scaleLength(CAPTION_TOP) +
    lines.reduce(
      (sum, line) => sum + scaleLength(line.strong ? CAPTION_TITLE_LINE : CAPTION_DETAIL_LINE),
      0,
    )
  )
}

/**
 * The caption as drawn lines, wrapped to the figure's width.
 *
 * The detail line is a middot-separated list, so it breaks at those separators
 * and nowhere else — a provenance line broken mid-filename reads as two files.
 * The subject line is one name and is left to overflow rather than be cut: a
 * truncated genome name is worse than a wide figure.
 */
function captionLines(
  ctx: CanvasRenderingContext2D,
  caption: { title: string; detail: string },
  width: number,
): CaptionLine[] {
  const lines: CaptionLine[] = []
  if (caption.title !== '') lines.push({ text: caption.title, strong: true })
  if (caption.detail === '') return lines

  ctx.font = scaleFont(CAPTION_DETAIL_FONT)
  const fits = (text: string): boolean => ctx.measureText(text).width <= width
  if (fits(caption.detail)) {
    lines.push({ text: caption.detail, strong: false })
    return lines
  }
  let line = ''
  for (const part of caption.detail.split(' · ')) {
    const candidate = line === '' ? part : `${line} · ${part}`
    if (line !== '' && !fits(candidate)) {
      lines.push({ text: line, strong: false })
      line = part
    } else {
      line = candidate
    }
  }
  if (line !== '') lines.push({ text: line, strong: false })
  return lines
}

/** The width below which the plot takes the whole column; `styles.css` agrees. */
const NARROW_QUERY = '(max-width: 34rem)'

/** How far inside the plot frame the key sits, in CSS pixels. */
const KEY_INSET = 6

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

/**
 * Separator positions: the first row/column of every group after the first.
 *
 * The genome runs become the drawn boundaries only where the reader says so
 * (`genomeBoundaries`), which is the whole-metagenome overview and nothing
 * else. Elsewhere they are a fact the tooltip reports and not a line: a
 * whole-genome view of a metacool is still read contig by contig, and moving
 * its separators out to the genomes would coarsen a picture nobody asked to
 * have coarsened.
 */
export function separatorsFor(data: MatrixResult): SeparatorSet {
  const toSeparators = (groups: AxisGroup[]): Separator[] =>
    groups.map((group) => ({ at: group.start, label: group.label }))

  // A whole-metagenome view is a picture of *genomes*. Where the reader marks
  // its genome runs as the boundaries, those are the only ones drawn: 20,000
  // contig hairlines over 4,000 genome blocks is a grey wash, and it hides the
  // block structure the view exists to show. They go in both sets so the axis
  // is also *labelled* by genome — the fine set is what `labelBlocks` reads —
  // while the heavier stroke, drawn at the same coordinates, is what the eye
  // lands on.
  const draw = data.genomeBoundaries === true
  const rowUnits = (draw ? data.rowGenomes : undefined) ?? data.rowGroups
  const colUnits = (draw ? data.colGenomes : undefined) ?? data.colGroups
  const set: SeparatorSet = {
    rows: toSeparators(rowUnits),
    cols: toSeparators(colUnits),
  }
  // The *same array*, not a second copy of it. Where the genome runs are the
  // boundaries they are both sets, and the renderer skips the fine pass when it
  // recognises the identity — otherwise it stroked several thousand hairlines
  // and then stroked the heavier line over exactly the same coordinates.
  if (draw && data.rowGenomes !== undefined) set.groupRows = set.rows
  if (draw && data.colGenomes !== undefined) set.groupCols = set.cols
  return set
}

/**
 * Whether a box straddles the diagonal, in cells.
 *
 * Compared in cells rather than in base pairs because that is where the
 * question is exact, and with a bin of slack at each end because the marquee is
 * square in *pixels*: the two axes convert those pixels through their own
 * scales, and a plot whose gutters differ by a pixel turns a square on the
 * diagonal into ranges that differ by one cell. A whole bin of tolerance is
 * still far tighter than any box a hand can draw off the diagonal.
 */
export function onDiagonal(box: SelectionBox): boolean {
  return Math.abs(box.rows[0] - box.cols[0]) <= 1 && Math.abs(box.rows[1] - box.cols[1]) <= 1
}

/**
 * A dragged band of one axis, as a locus on the sequence it began in.
 *
 * **Clamped to that sequence, and that is the whole of this function.** A drag
 * is free to run across several — on a whole-metagenome view a cell is a contig
 * or two, so a band of five crosses four boundaries — and the reading used to
 * take the *name* from where the hand went down and the *end* from where it
 * came up, which is one contig's name against another contig's coordinate. On
 * the mock community that produced `NODE_…:1-260,000` for a 200 kb sequence,
 * and the range parser refused it: `Genomic region out of bounds`. The 4C
 * task's anchor, unusable from the picture it was picked on, and a clipboard
 * copy of the same gesture that pasted back as an error.
 *
 * The anchor is where the hand went down — the same rule a marquee follows, for
 * the same reason (`axisSelection`) — and what it names is however much of that
 * sequence the gesture covered. The end never passes the sequence's length,
 * because a contig's last bin is partial in general and a whole-contig drag
 * would otherwise name a coordinate a bin beyond the end of it.
 *
 * Exported for the test that pins those two clamps, beside the three selection
 * helpers below it and for the same reason: the panel needs a canvas and the
 * arithmetic does not.
 */
export function bandRegion(axis: LocusAxis, span: [number, number]): PickedLocus | null {
  const segment = axis.segmentAt(span[0])
  if (segment === null) return null
  const last = Math.min(Math.max(span[0], span[1] - 1), segment.unitEnd - 1)
  const from = axis.unitToLocus(span[0])
  const to = axis.unitToLocus(last)
  if (from === null || to === null) return null
  return {
    contig: from.contig,
    start: Math.max(0, Math.round(from.bp)),
    end: Math.min(segment.contigLength, Math.round(to.bp + segment.bpPerUnit)),
  }
}

/**
 * One axis of a selection as a region string, in the grammar the region box
 * takes.
 *
 * Rounded to whole base pairs and written without separators, so it is both a
 * legal range (§5.4) and something that can be pasted back. Above bin level
 * there is no range to write and the block's own name is the answer.
 */
export function axisRegion(axis: SelectedAxis): string {
  if (axis.range === undefined) return axis.label
  const [start, end] = axis.range
  return `${axis.label}:${Math.round(start)}-${Math.round(end)}`
}

/**
 * The window one axis currently shows, in the grammar the region box takes.
 *
 * `formatLocus` rather than a fourth hand-rolled `contig:start-end`: what the
 * line shows has to be what the box would accept, or copying a coordinate out of
 * the subtitle and into the box moves the picture by a base.
 *
 * A whole-genome axis is several sequences at once and naming sixteen of them is
 * a paragraph, so past two they are counted instead — the same choice
 * `BrowserView.zoomPhrase` makes with "4 of 16 sequences", and for the same
 * reason: the line has to stay a line.
 */
export function windowPhrase(windows: readonly LocusWindow[]): string {
  if (windows.length === 0) return ''
  const span = windows.reduce((total, window) => total + (window.end - window.start), 0)
  const where =
    windows.length === 1
      ? formatLocus(windows[0])
      : windows.length === 2
        ? `${formatLocus(windows[0])} + ${formatLocus(windows[1])}`
        : `${fmt.int(windows.length)} sequences`
  return `${where} · ${fmt.bp(span)}`
}

/**
 * Both axes of what is on screen, said once when they agree.
 *
 * On the diagonal the two windows are one window, and printing it twice says the
 * picture is of two things when it is of one. Off it — a genome pair, a
 * `contig × contig` block, a region against a second region — they are genuinely
 * different and both are named.
 */
export function framedPhrase(
  rows: readonly LocusWindow[],
  cols: readonly LocusWindow[],
): string {
  const rowText = windowPhrase(rows)
  const colText = windowPhrase(cols)
  if (rowText === '') return colText
  if (colText === '' || rowText === colText) return rowText
  return `${rowText} × ${colText}`
}

/**
 * One axis of a dragged box, as the three numbers written *beside* it.
 *
 * Not {@link axisRegion}, and the difference is the audience: that one is a
 * region string, half-open and separator-free because it is pasted back into a
 * box; this one is read, so both ends are 1-based positions and the width is in
 * the reader's units. The wording is the 1D browser's marquee, word for word —
 * one gesture described in two dialects is two gestures as far as anybody can
 * tell.
 *
 * Above bin level there is no range and the block's own name is the answer.
 */
export function spanText(axis: SelectedAxis): { start: string; end: string; span: string } {
  if (axis.range === undefined) return { start: axis.label, end: axis.label, span: '' }
  const [start, end] = axis.range
  return {
    start: `${axis.label}:${fmt.int(Math.round(start) + 1)}`,
    end: `${axis.label}:${fmt.int(Math.round(end))}`,
    span: fmt.bp(end - start),
  }
}

/**
 * What to say when the picture is coarser than the data.
 *
 * A block wider than {@link RASTER_MAX_DIM} is drawn through a pooled raster:
 * one pixel per `stride x stride` block of cells, carrying the strongest value
 * under it. That is the right trade — a 12,975-bin genome at one pixel per bin
 * is 585 MB of RGBA for an image no screen can show, and the *maximum* is what
 * keeps a sparse map's bright cell from being averaged into its empty
 * neighbours — but until now nothing said it was happening. The summary claimed
 * "12,975 x 12,975 cells rendered", the crosshair then reported four different
 * coordinates and four different values inside one visible square, and there
 * was no way to tell which of the two was lying.
 *
 * Two things a reader needs and cannot deduce: that the picture is pooled, and
 * what that means for zooming into it.
 *
 * The second half used to be flat — *zooming does not sharpen it, so the answer
 * is to open a smaller block* — and for a long time that was the truth. It is
 * now a question about a setting: with refinement on (`ui/refine.ts`) a settled
 * zoom reads the window again at a finer grid and the picture does sharpen, down
 * to the file's own bins; with it off, the old sentence holds exactly. So the
 * note says which, rather than asserting one of them at a reader who is looking
 * at the other.
 *
 * `null` when every cell has its own pixel, which is every region and nearly
 * every MAG.
 */
export function poolingNote(
  nrows: number,
  ncols: number,
  refining = refineEnabled(),
): { phrase: string } | null {
  const strideY = rasterStride(nrows)
  const strideX = rasterStride(ncols)
  if (strideX === 1 && strideY === 1) return null
  return {
    phrase: `aggregated ${strideX} × ${strideY} bins to a pixel${
      refining ? ' · zoom in to sharpen' : ' · open a smaller block to sharpen'
    }`,
  }
}

/**
 * What one cell of the picture is worth, in the reader's units.
 *
 * The grid a block is read on is rarely the file's own — anything larger than a
 * picture is summed into coarser cells on the way through — and "30 bins each"
 * asks the reader to do the multiplication. The resolution is the number they
 * would quote in a methods section, so it is the number said here, and the bin
 * count is left to the summary that already gives it.
 *
 * There are two ways for a cell to stop being a bin, and neither has a width to
 * quote. Above one sequence per cell the sequences in it have different lengths
 * and the cell is their sum. Above bin *level* a cell is a whole sequence by
 * construction, and `1 contig per cell` is not news — the axis already says so.
 * Both come back empty and the caller says nothing rather than something false.
 */
export function resolutionNote(
  binsize: number,
  result: {
    binsPerCell?: number
    contigsPerCell?: number
    level?: MatrixResult['level']
    /**
     * The bin size of the map that actually answered, where a read came from a
     * sibling rung (`worker/protocol.ts`). It wins over the caller's, which is
     * the *open* map's — a caller passing its own would caption a block read at
     * 2 kb with the 1 kb the session was opened at, and this is the one number
     * on the line that changes what the picture means.
     */
    binsize?: number
  },
  noun = 'sequence',
): string {
  binsize = result.binsize ?? binsize
  if ((result.level ?? 'bin') !== 'bin') {
    const per = result.contigsPerCell ?? 1
    return per > 1 ? `${fmt.int(per)} ${noun}s per cell, summed` : ''
  }
  // A cell is a capacity of bins, so it has a width even where several small
  // sequences share it — the cell spans that many base pairs of sequence, in
  // more than one piece. Which sequences those are is the readout's to say, and
  // the list beside the map's; it is not a second resolution.
  return `effective resolution: ${fmt.bp(binsize * (result.binsPerCell ?? 1))}`
}

/**
 * The line under a map: how large the picture is, and what one cell of it is
 * worth.
 *
 * Two facts and no third, in one place, because four views draw this line and
 * four wordings of one fact is how they drift. Which sequences are on the axes
 * is the title's job; whether the values are balanced is the colourbar's, which
 * is titled in the units it is drawn in and sits beside the numbers it applies
 * to.
 *
 * **The count is the cells, and they are called bins.** That is the honest
 * pairing: a cell of the picture *is* a bin of the effective resolution, so
 * `4,046 × 4,046 bins` at `3.0 kb` multiplies out to the 12.1 Mb that is on
 * screen. Counting the file's own bins instead would put `5,769 bins` beside
 * `200 bp` for a 577 kb chromosome, and the two numbers on one line would
 * describe something twice its size. Above one sequence per cell there is no bin
 * to speak of and they are cells again.
 */
export function blockSummary(
  binsize: number,
  result: MatrixResult,
  noun = 'sequence',
): Array<string | HTMLElement> {
  // What the cells *are*. At bin level they are bins of the effective
  // resolution, which is the pairing that multiplies out to what is on screen.
  // Above it they are the unit the axis is already drawn in, and a roll-up that
  // had to merge them is cells.
  const unit =
    result.level === 'bin'
      ? 'bins'
      : (result.contigsPerCell ?? 1) > 1
      ? 'cells'
      : `${noun}s`
  const resolution = resolutionNote(binsize, result, noun)
  const parts: Array<string | HTMLElement> = [
    `${fmt.int(result.nrows)} × ${fmt.int(result.ncols)} ${unit}`,
  ]
  if (resolution !== '') {
    parts.push(' · ')
    // Bold because it is the one number here that changes what the picture
    // *means*: the same map at 200 bp and at 3 kb are different figures, and a
    // reader scanning the line is looking for that.
    parts.push(el('strong', { text: resolution }))
  }
  return parts
}

/**
 * The same colours, measured in the second file's counts.
 *
 * A gain of `g` multiplies the second file's values before they are coloured, so
 * a colour standing at transformed level `t` is `T⁻¹(t)` contacts in the first
 * file and `T⁻¹(t) / g` in the second. Converting the *bounds* that way and
 * handing the result to a second colourbar is all it takes: every tick it
 * derives is then in the second file's units, from the one implementation that
 * already knows how to derive them.
 */
function rescaledBy(scale: ColorScale, gain: number): ColorScale {
  if (!(gain > 0) || gain === 1) return scale
  const back = (value: number): number =>
    Number.isFinite(value)
      ? transformValue(inverseTransform(value, scale.transform) / gain, scale.transform)
      : value
  return { ...scale, vmin: back(scale.vmin), vmax: back(scale.vmax) }
}

/** Adapt a worker result to the renderer's {@link DenseMatrix}. */
export function toDense(data: MatrixResult): DenseMatrix {
  return {
    nrows: data.nrows,
    ncols: data.ncols,
    values: data.values,
    rowExtent: data.rowExtent,
    colExtent: data.colExtent,
  }
}


/** What each edge is called, wherever one has to be named to a reader. */
const EDGE_WORDS: Record<LaneEdge, string> = {
  top: 'above the map',
  right: 'beside the map',
  bottom: 'below the map',
  left: 'left of the map',
}

/**
 * The right-click menu on a lane: its colour, its axis, and where it is drawn.
 *
 * The things the side panel offers for a track that a reader beside the map
 * actually reaches for, brought to where the track is. Colour opens the
 * browser's own picker — the same control the card uses, so the two cannot drift
 * — and the range is offered as the choices worth having rather than as two
 * boxes: auto, and the round steps around what is on screen. A number box in a
 * context menu is a form in a menu.
 *
 * The location block and the flip are here because a lane is where a reader is
 * looking when they want them: which edge a track is drawn on and which way its
 * signal grows are both decisions about the *picture*, and sending someone to a
 * list in the sidebar to make one is sending them away from the thing they are
 * deciding about.
 */
export function openLaneMenu(
  x: number,
  y: number,
  entry: AnnotationEntry,
  store: AnnotationStore,
  /**
   * The stack the menu was opened from — what "towards the map" is measured
   * against, and what the location block moves the lane *off*.
   *
   * `null` on a surface with no map to have edges: the 1D browser draws every
   * lane the same way up and its placement means nothing until the reader goes
   * back to a map, so offering four edges there would be offering a control
   * with no visible effect.
   */
  edge: LaneEdge | null,
  /**
   * Which map the stack belongs to, so the location block moves *that* map's
   * lane. The lead when nothing says otherwise, which is every surface with no
   * deck behind it — see `annotations/store.ts`'s `placeAt`.
   */
  map: MapId = LEAD_MAP,
): void {
  const limits = entry.style.limits
  const items: MenuItem[] = [
    { label: entry.label },
    {
      label: 'Colour…',
      hint: entry.style.colour,
      // The same control the lane's own chip is and the side panel's swatch is,
      // through one builder, so the three cannot come to disagree about what a
      // colour is. Built here rather than up front because a menu that is opened
      // and dismissed should leave nothing behind, and taken away again on the
      // commit *or* on the window coming back, which is what a cancelled picker
      // looks like from this side.
      run: () => {
        const swatch = colourInput(entry, store, { class: 'hidden-input' })
        const done = (): void => swatch.remove()
        swatch.addEventListener('change', done, { once: true })
        window.addEventListener('focus', done, { once: true })
        document.body.appendChild(swatch)
        swatch.click()
      },
    },
  ]

  if (hasAMovableAxis(entry.kind)) {
    items.push(
      { label: 'Range' },
      {
        label: 'Auto',
        hint: 'this view',
        disabled: limits.auto,
        run: () => store.restyle(entry.id, { limits: { ...limits, auto: true } }),
      },
      // Not a step, and not a control: the two ways the range is moved *on the
      // lane itself*, said once where a reader who opened this menu looking for
      // them will find them. Both are gestures with nothing on screen to
      // announce them, which is exactly what a menu is for.
      { label: `${CEILING_LABEL} on the lane moves the ceiling; click a limit to type one` },
      ...[1, 5, 10, 50, 100].map((max) => ({
        label: `0 – ${max}`,
        disabled: !limits.auto && limits.min === 0 && limits.max === max,
        run: () => store.restyle(entry.id, { limits: { auto: false, min: 0, max } }),
      })),
    )
  }

  // Where the lane goes, as words. The same field the row's `location` control
  // writes and the same call the drag onto a rectangle makes, so a lane moved
  // three different ways is moved once — including the axis turning to keep
  // facing the map, which is `place`'s and not any caller's.
  if (edge !== null) {
    items.push(
      { label: 'Draw it' },
      ...LANE_EDGES.map((side) => ({
        label: EDGE_WORDS[side],
        disabled:
          entry.placement[side] && LANE_EDGES.filter((each) => entry.placement[each]).length === 1,
        run: () => store.placeAt(entry.id, map, placementOn(side)),
      })),
    )
  }

  if (drawsAProfile(entry.kind)) {
    // Which way the signal currently grows, which is the edge's own reading
    // turned round by the flip — not the flip on its own. A lane above the map
    // and one below it with the same `flip` grow in opposite directions
    // relative to the picture, and "flip" is not a word about a picture.
    const towards = laneGrowsInward(edge ?? 'bottom') !== entry.style.flip
    items.push({
      label: towards ? 'Grow away from the map' : 'Grow towards the map',
      hint: towards ? 'now towards' : 'now away',
      run: () => store.restyle(entry.id, { flip: !entry.style.flip }),
    })
  }

  items.push(
    { label: 'This track' },
    {
      label: entry.visible ? 'Hide' : 'Show',
      run: () => store.update(entry.id, { visible: !entry.visible }),
    },
    { label: 'Remove', run: (): void => store.remove(entry.id) },
  )
  openMenu(x, y, items)
}
