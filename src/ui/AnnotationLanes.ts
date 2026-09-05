/**
 * The strips of annotation beside the matrix, and everything that keeps them in
 * step with it.
 *
 * One canvas per edge — four of them, above the map, below it and down either
 * side — holding every lane on that edge stacked. Each canvas is exactly as long
 * as the heatmap's own canvas and drawn in the same coordinates, so a column of
 * the map and the pixel under it are the same pixel — not because anything
 * checks, but because both are drawn through the same `Scale` at the same offset
 * (spec §8.4).
 *
 * The four edges are peers and there is no branch here that says otherwise. A
 * stack is laid out in *stack* coordinates — nearest the map first, growing
 * outward — and turned into canvas coordinates once, in {@link frameOf}; from
 * there `render/lane.ts` is the only module that knows which of along and across
 * is x, and which way each of them points. That is what made the top and left
 * stacks cost a coordinate conversion rather than a second renderer.
 *
 * **Pan and zoom perform no I/O**, which is §2's rule for the matrix and has to
 * be the rule here too, or dragging a whole-genome view would be a burst of
 * range requests per frame. A track fetches a window half again as wide as what
 * is on screen, at a resolution rounded to a power of two, and keeps it; a pan
 * inside that window and a zoom inside that power of two redraw from the cache.
 * When a fetch *is* needed the previous data stays on screen until the new data
 * lands, so a lane never blinks.
 */

import {
  OVERLAY_DIM,
  extentFor,
  planStack,
  resolveGroupExtents,
  type GroupSettings,
} from '../annotations/groups'
import { featureLabel } from '../annotations/featureset'
import { SampleCache } from '../annotations/samples'
import type { AnnotationClient } from '../annotations/worker/client'
import {
  LABEL_BAND,
  featureAt,
  drawGenes,
  drawSegments,
  layoutFeatures,
  rowsThatFit,
  type FeatureLayout,
} from '../render/features'
import {
  BORDER_RULE,
  GRIP_ROOM,
  GROUP_BAR,
  borderRuleAt,
  clipLane,
  drawGrip,
  drawGroupBars,
  gripAcross,
  gripBox,
  groupRuns,
  laneIsHorizontal,
  laneOutward,
  laneX,
  laneY,
  withinGrip,
  type LaneFrame,
} from '../render/lane'
import {
  drawLaneLabel,
  labelEndFor,
  type LaneLabelSpec,
  type LaneLabelStyle,
  type LimitBox,
  type NameBox,
} from '../render/laneLabel'
import type { LocusAxis } from '../render/locus'
import type { OverlayAxes } from '../render/overlays'
import type { Rect } from '../render/heatmap'
import type { Scale } from '../render/scale'
import {
  drawTrack,
  drawTrackScaling,
  profileOf,
  resolveLimits,
  scaledTo,
  type PixelProfile,
  laneNote,
} from '../render/tracks'
import type { ManualPoint, ManualStore } from '../annotations/manual'
import type { AnnotationStore } from '../annotations/store'
import { LEAD_MAP, type MapId } from '../annotations/placement'
import {
  LANE_EDGES,
  drawnFromSamples,
  drawsAProfile,
  hasAMovableAxis,
  isMetadata,
  readsOf,
  type AnnotationEntry,
  type FeatureSet,
  type LaneEdge,
  type TrackSampleSet,
} from '../annotations/types'
import {
  IDENTITY_CELLS,
  cellOfUnit,
  type CellScale,
  type MetaBlock,
  type MetaCells,
} from '../annotations/metadata'
import {
  categoryAt,
  categoryColour,
  drawCategories,
  profileFromCells,
  type CategoryRun,
} from '../render/meta'
import { el, fmt } from './dom'
import type { LaneMark } from './LaneControls'
import { LANE_MIN_SIZE } from './trackControls'
import { getPlotOptions } from './plotOptions'
import { scaleFont, scaleLength } from './textScale'

export type { LaneEdge }

/** Everything the stacks need from the heatmap on the frame they are drawn. */
export interface LaneGeometry {
  plot: Rect
  data: Rect
  colScale: Scale
  rowScale: Scale
  /** The heatmap canvas's CSS size, which the lane canvases match on one axis. */
  cssWidth: number
  cssHeight: number
  /** The cell under the pointer, for the crosshair. */
  hover: { row: number; col: number } | null
  /**
   * Where {@link hover} lands on the **column** axis, when the map is turned.
   *
   * Two positions, not one, and that is the whole reason this is not read off
   * `hover.col`: a turned map's columns are midpoints between two places, so the
   * column under the pointer is a coordinate no track has anything at. What the
   * pointer is naming is the pair of anchors the contact is between, and the
   * stacks answer with a hairline on each — on the diagonal the two are one
   * place and there is one line. `null` on a square map, where the column under
   * the pointer *is* the position and {@link hover} already says it.
   */
  anchors: readonly number[] | null
  crosshair: boolean
  /**
   * A cell being pointed at on **another** map of a deck (§16.3).
   *
   * A short tick across this lane rather than the full hairline {@link hover}
   * draws, and for the same reason the map's mark is a small cross: exactly one
   * picture has a pointer over it, and a rule through every stack of every
   * panel claims otherwise while covering the profiles being compared.
   */
  echo: { row: number; col: number } | null
  /**
   * Where {@link echo} lands on the column axis when **this** map is turned.
   *
   * {@link anchors} for the other panel's pointer, and needed for exactly the
   * same reason: the echoed cell is a contact between two places, so a tick at
   * the column it sits in marks the midpoint of the two, which is a coordinate
   * no track has anything at. Two ticks, one per anchor — one where the two are
   * the same place. `null` on a square map, where the echoed column *is* the
   * position.
   */
  echoAnchors: readonly number[] | null
  /**
   * A place on the genome a pointer is naming from a track beside **another**
   * map of the deck, in this block's matrix units on the axis named.
   *
   * The lane stacks' half of {@link HeatmapView.setLaneEcho}: the deck's promise
   * is that its pictures are of one place, and a hand moving along one profile
   * asking "what is here" is asking it of every profile on screen. A tick, as
   * {@link echo} is and for the same reason — one pointer, one rule.
   */
  laneEcho: { axis: 'rows' | 'cols'; unit: number } | null
  /**
   * A pointer over one of the lane stacks, in that stack's own canvas pixels
   * along the shared axis.
   *
   * Distinct from {@link hover}, which is a *cell* of the matrix and arrives
   * only while the pointer is on the map. This is the position being pointed at
   * from beside it, and it is what the hairline is drawn through.
   */
  guide: { edge: LaneEdge; along: number } | null
  /** The id of the lane whose far border is under the pointer, if any. */
  border: string | null
  /**
   * Whether the lanes draw their handles at all.
   *
   * Chrome rather than picture, so the export path turns it off: a saved figure
   * would otherwise carry a column of grey dots that mean nothing to anyone
   * reading it.
   */
  handles: boolean
  /** The id of the lane under the pointer, whose handle is drawn full strength. */
  grip: string | null
  /**
   * A lane whose ceiling is being dragged, and how far it has moved.
   *
   * `null` in a figure: a gesture in progress is not something a saved plot has
   * any use for, and the faded copy is only there to be compared against by the
   * hand making it.
   */
  scaling: { id: string; factor: number } | null
  palette: { guide: string; halo: string; crosshair: string }
}

/**
 * What the pointer over a lane stack resolves to.
 *
 * Every value track on that edge, not only the lane under the pointer: the
 * question a stack of tracks is there to answer is "what do all of these do
 * here", and answering it one lane at a time means moving the pointer between
 * lanes and remembering the numbers.
 */
export interface LaneReadout {
  /** Where this is, phrased as the matrix readout phrases it. */
  position: string
  /** One per value track on this edge, nearest the map first. */
  rows: Array<{
    label: string
    colour: string
    /** The sampled value, already formatted; `—` where the track has no data. */
    value: string
    /** `true` for the one lane the pointer is actually inside. */
    here: boolean
  }>
  /**
   * The feature under the pointer, when it is over a lane that draws them: its
   * name, then its coordinates, score and attributes.
   *
   * A gene model and a peak set have no value at a position — they have a thing
   * or nothing — so they are not rows above. When the pointer is on one, what it
   * is worth saying is everything about that one feature.
   */
  detail: string[]
}

/** Gap between two stacked lanes, in CSS pixels. */
export const LANE_GAP = 4

/**
 * A lane's position in its stack, resolved per frame.
 *
 * `acrossFrom` is in **stack** coordinates: zero at the map, growing outward,
 * whichever edge the stack is on. {@link AnnotationLanes.frameOf} is the one
 * place that turns those into the canvas coordinates a top or left stack
 * actually draws in.
 */
interface Slot {
  entry: AnnotationEntry
  /** Tracks drawn *into* this lane, when its group is in overlay mode. */
  overlaid: AnnotationEntry[]
  acrossFrom: number
  thickness: number
}

/** One lane, ready to paint: where it goes, and what it is a picture of. */
interface Lane {
  entry: AnnotationEntry
  overlaid: AnnotationEntry[]
  frame: LaneFrame
  /** One per value track in the lane; empty for the feature kinds. */
  profiles: Array<{ entry: AnnotationEntry; profile: PixelProfile }>
  /**
   * The categories to paint, for a qualitative metadata lane (§8.12).
   *
   * Its own field rather than a `profiles` entry with a flag, because it is not
   * a profile: there is no value axis, no limits to resolve and no autoscale
   * group to join, and every one of those is a question `profiles` is asked.
   */
  categories: Extract<MetaCells, { kind: 'qualitative' }> | null
  /**
   * The canvas coordinate of the border a resize drag grabs — the lane's far
   * edge, away from the map.
   */
  border: number
}

/**
 * Where a metadata lane's numbers come from (§8.12).
 *
 * An interface, and a very small one, because the alternative is this file
 * knowing about the reader's tables. What it hands back is one value per cell
 * of the block, already resolved — the arithmetic is `annotations/metadata.ts`'s
 * and the tables are `annotations/metaIndex.ts`'s, and neither is a drawing
 * concern.
 *
 * `null` is a real answer and a common one: the column is a `/bins` column
 * whose slice has not arrived, or one this level cannot show. The lane draws
 * nothing that frame, exactly as a track with no samples yet does.
 */
export interface MetaSource {
  cellsFor(entry: AnnotationEntry, block: MetaBlock): MetaCells | null
  /**
   * A counter that grows whenever a column arrives or is re-read.
   *
   * What the lane's own cache is keyed on, and the reason it is a *number*
   * rather than a callback: the values behind a metadata lane can improve
   * without the block changing — a `/bins` slice lands, or a wider one replaces
   * the one that was drawn while a reader zoomed out — and a cache keyed on the
   * block alone would go on drawing the first answer for as long as the picture
   * stood still.
   */
  revision(): number
}

/** The two axes of the block, as the metadata lanes read them. */
export interface MetaAxes {
  rows: MetaBlock | null
  cols: MetaBlock | null
}

/**
 * What one frame's paint left behind, per edge, for the pointer to use.
 *
 * The lanes used to draw their label and forget it, which is what made the two
 * numbers under a track's name inert beside the map: a range you cannot find
 * again is a range you cannot put a caret in. Kept exactly as {@link layouts}
 * already keeps the feature layouts, and for the same reason — the box a reader
 * points at must be the box the text was measured into (§8.4).
 */
interface EdgeState {
  /** The value axis each lane was drawn against, by the lane's own entry id. */
  limits: Map<string, { min: number; max: number }>
  /** The line each lane's handle sits on, by the lane's own entry id. */
  gripRows: Map<string, number>
  /** Every limit box on this edge, with the tracks it belongs to. */
  ranges: Array<{ entries: AnnotationEntry[]; hit: LimitBox }>
  /** Every name box on this edge, with the one track each belongs to. */
  names: Array<{ entry: AnnotationEntry; hit: NameBox }>
  /** The colour chips and autoscale buttons this edge wants over it. */
  marks: LaneMark[]
}

function emptyEdgeState(): EdgeState {
  return {
    limits: new Map(),
    gripRows: new Map(),
    ranges: [],
    names: [],
    marks: [],
  }
}

/**
 * How close to a lane's far border counts as being on it.
 *
 * Four pixels either side. The same number the side panels' drag handle is
 * wide, and for the same reason: a border is a line, and a line is not
 * something a hand can be asked to hit.
 */
const LANE_GRIP = 4

/** Every edge, in the order they are drawn. */
const EDGES = LANE_EDGES

/** What one group of tracks does, for a surface that has no group settings. */
const UNGROUPED = {
  modeOf: (): 'stacked' => 'stacked',
  scalingOf: (): 'shared' => 'shared',
}

/** What the lanes read off the reader's own marks. */
type LaneMarks = Pick<ManualStore, 'lines' | 'arrowheads' | 'rects'>

/** No hand-drawn marks, for a file that cannot carry any. */
const EMPTY_MARKS = { lines: [], arrowheads: [], rects: [] } as LaneMarks

/**
 * Every coordinate the marks ask a lane to point at, mark by mark.
 *
 * Grouped by mark rather than flattened, because the "same place twice" rule is
 * per mark: two boxes that happen to share an edge are two marks about it, and
 * collapsing them would take a triangle away from one of them.
 */
function anchorsOf(manual: LaneMarks): Array<{ colour: string; at: ManualPoint[] }> {
  return [
    ...manual.arrowheads.map((mark) => ({ colour: mark.colour, at: [mark.a, mark.b] })),
    ...manual.rects.map((mark) => ({
      colour: mark.colour,
      at: [
        { contig: mark.a.contig, bp: mark.a.from },
        { contig: mark.a.contig, bp: mark.a.to },
        { contig: mark.b.contig, bp: mark.b.from },
        { contig: mark.b.contig, bp: mark.b.to },
      ],
    })),
  ]
}

export class AnnotationLanes {
  /** The four canvases, mounted by the panel. Hidden when their stack is empty. */
  readonly canvases: Record<LaneEdge, HTMLCanvasElement>

  private axes: OverlayAxes = { rows: null, cols: null }
  /**
   * The same two axes as *cells of the file's own tables* (§8.12).
   *
   * Beside {@link axes} rather than inside it, because they are two different
   * coordinate models and the whole point of the metadata lanes is that they
   * use the second one. A genome × genome overview has no `LocusAxis` at all —
   * a cell is a whole MAG and there is no base pair inside it to put a bigWig
   * sample at — and that is exactly the picture a MAG's completeness belongs
   * beside.
   */
  private metaAxes: MetaAxes = { rows: null, cols: null }
  /**
   * This block's cells per entry and scope, so a pan does not re-resolve them.
   *
   * Cleared with the axes, for the reason the feature layouts are: a mapping
   * built for one block drawn over another is the one failure §8.4 exists to
   * prevent.
   */
  private readonly metaCells = new Map<string, MetaCells | null>()
  /** Which revision of the index's values {@link metaCells} was resolved from. */
  private metaRevision = -1
  /** The category runs each lane was painted from, for the readout. */
  private readonly metaRuns = new Map<string, { frame: LaneFrame; runs: CategoryRun[] }>()
  /**
   * The sample cache, or `null` on a file with no annotation worker.
   *
   * A file with a genome layer carries no annotations at all (§8.5), so its
   * stacks stay empty and nothing there ever samples — and building a cache
   * would spawn a thread to answer no questions.
   */
  private readonly cache: SampleCache | null
  /** Feature layouts from the last draw, for hit testing without a re-layout. */
  private readonly layouts = new Map<string, { frame: LaneFrame; layout: FeatureLayout }>()
  /** What each stack's last *screen* paint measured; the export records nothing. */
  private readonly state: Record<LaneEdge, EdgeState> = {
    top: emptyEdgeState(),
    right: emptyEdgeState(),
    bottom: emptyEdgeState(),
    left: emptyEdgeState(),
  }
  private dpr = 1

  constructor(
    private readonly options: {
      store: AnnotationStore
      /** Whose lanes to draw; the session's own map when absent. */
      map?: MapId
      /**
       * The reader's own marks. Drawn *into* the lanes as well as onto the map:
       * a line called out on the matrix is a coordinate, and the tracks beside
       * it are what a coordinate is usually being compared against.
       *
       * Absent on a file that has no manual annotations to draw.
       */
      manual?: ManualStore
      /** Absent where nothing can be sampled; see {@link cache}. */
      client?: AnnotationClient
      /**
       * How each group is drawn and scaled, for this file.
       *
       * The session's instance, shared with the 1D browser: a group overlaid
       * there is overlaid here, because it is the same group of the same tracks
       * (`annotations/groups.ts`). Absent where there are no groups to have.
       */
      groups?: Pick<GroupSettings, 'modeOf' | 'scalingOf'>
      /**
       * Where a metadata lane's values come from (§8.12).
       *
       * Absent on a surface that draws no metadata — a file whose reader has
       * gone, or a panel built before the index was — and then a metadata row
       * simply draws nothing, which is the same thing it does while a column is
       * being read.
       */
      metadata?: MetaSource
      /** Ask for a repaint; the panel coalesces it into its own frame. */
      onChange(): void
    },
  ) {
    this.canvases = {
      top: el('canvas', { class: 'lane-canvas lane-top' }),
      right: el('canvas', { class: 'lane-canvas lane-right' }),
      bottom: el('canvas', { class: 'lane-canvas lane-bottom' }),
      left: el('canvas', { class: 'lane-canvas lane-left' }),
    }
    this.cache =
      options.client === undefined
        ? null
        : new SampleCache(options.client, () => options.onChange())
  }

  /** The canvas one stack is drawn on. */
  canvasFor(edge: LaneEdge): HTMLCanvasElement {
    return this.canvases[edge]
  }

  /** How each group is drawn and scaled — the file's answer, or the empty one. */
  private get groups(): Pick<GroupSettings, 'modeOf' | 'scalingOf'> {
    return this.options.groups ?? UNGROUPED
  }

  /** The marks drawn into every lane; empty where the file carries none. */
  private get manual(): LaneMarks {
    return this.options.manual ?? EMPTY_MARKS
  }

  /** Which of the map's two axes a stack on this edge runs along. */
  private axisFor(edge: LaneEdge): LocusAxis | null {
    return laneIsHorizontal(edge) ? this.axes.cols : this.axes.rows
  }

  /** The same axis, as cells of the file's own tables (§8.12). */
  private metaAxisFor(edge: LaneEdge): MetaBlock | null {
    return laneIsHorizontal(edge) ? this.metaAxes.cols : this.metaAxes.rows
  }

  /** How this edge's cells land on the units the lane is drawn in. */
  private cellScaleFor(edge: LaneEdge): CellScale {
    return this.metaAxisFor(edge)?.scale ?? IDENTITY_CELLS
  }

  /**
   * The cells one metadata row resolves to on one edge, resolved at most once
   * per block.
   *
   * Keyed by *scope* rather than by edge, exactly as the sample cache is: the
   * same column drawn above and below the map is one answer over one axis, and
   * two slots would resolve it twice to draw the same numbers.
   */
  private cellsFor(entry: AnnotationEntry, edge: LaneEdge): MetaCells | null {
    const block = this.metaAxisFor(edge)
    const source = this.options.metadata
    if (block === null || source === undefined) return null
    const revision = source.revision()
    if (revision !== this.metaRevision) {
      this.metaRevision = revision
      this.metaCells.clear()
    }
    const key = `${entry.id}:${laneIsHorizontal(edge) ? 'cols' : 'rows'}`
    if (this.metaCells.has(key)) return this.metaCells.get(key) ?? null
    const cells = source.cellsFor(entry, block)
    this.metaCells.set(key, cells)
    return cells
  }

  /**
   * Point the lanes at a new block.
   *
   * The sample cache is *not* cleared: it is keyed on genomic windows, which
   * mean the same thing in every view, so opening a region inside a
   * whole-genome view reuses what the whole-genome view already fetched.
   */
  setAxes(axes: OverlayAxes): void {
    this.axes = axes
    this.layouts.clear()
  }

  /**
   * Point the metadata lanes at the same new block.
   *
   * Separate from {@link setAxes} because the two are read by different lanes
   * and one can exist without the other: a genome-level block has cells and no
   * loci, and a turned block has loci along one axis and no cells this module
   * could put a table row against. Callers that change the block call both.
   */
  setMetaAxes(axes: MetaAxes): void {
    this.metaAxes = axes
    this.metaCells.clear()
    this.metaRuns.clear()
  }


  /**
   * Draw no stacks at all — the map on its own.
   *
   * The third stop of the map/tracks cycle (§16.10), and a *presentation* like
   * the turn rather than an edit: no track is hidden, moved or restyled, and
   * every one of them comes back where it was when the cycle comes round. Which
   * is why it is one flag read by {@link drawnOn} instead of a pass over the
   * store — a reader who has spent ten minutes arranging six tracks and then
   * asks to see the map by itself has not asked to lose the arrangement.
   *
   * The stacks collapse rather than hide: an edge with no lanes has no
   * thickness, so the map takes the whole of the room they were using, which is
   * the point of asking for the map by itself.
   */
  setBare(bare: boolean): void {
    if (this.bare === bare) return
    this.bare = bare
    this.layouts.clear()
  }

  /**
   * `true` while the map is turned 45°, which collapses the four stacks to one.
   *
   * A turned map has one genomic axis, along the bottom, and up its side is
   * distance from the diagonal — which is not a place, so there is nothing for a
   * vertical lane to be drawn against. Every track therefore falls into the
   * stack below the rectangle for as long as the turn lasts.
   *
   * Read from the axes rather than held as a flag of its own, because the axes
   * are what a turn actually *is* here and a second copy of the fact is a second
   * thing to keep in step.
   */
  private get turned(): boolean {
    return (this.axes.turn ?? null) !== null
  }

  /** `true` while the reader has asked for the map without its tracks. */
  private bare = false

  destroy(): void {
    this.cache?.destroy()
    this.layouts.clear()
  }

  /**
   * The lanes on one edge, in load order, nearest the map first.
   *
   * A group in **overlay** mode collapses to one lane, exactly as it does in the
   * 1D browser and through the same `planStack`: the first of its members on
   * this edge keeps its slot and the rest are drawn into it. That is what makes
   * two strands of an RNA-seq experiment one picture rather than two stacked
   * ones a reader has to hold against each other — and because a group already
   * shares one pair of limits, the two are directly comparable by construction.
   */
  private slotsFor(edge: LaneEdge): Slot[] {
    return planStack(this.drawnOn(edge), {
      groupOf: (entry) => entry.style.group,
      modeOf: (group) => this.groups.modeOf(group),
      sizeOf: (entry) => entry.style.size,
      gap: LANE_GAP,
      minimum: LANE_MIN_SIZE,
    }).map((slot) => ({
      entry: slot.host,
      overlaid: slot.overlaid,
      acrossFrom: slot.acrossFrom,
      thickness: slot.thickness,
    }))
  }

  /**
   * The entries this edge can actually draw.
   *
   * The store's own list, minus anything that needs a coordinate system this
   * block has not got. A contig-level or whole-genome block has no `LocusAxis`
   * — one cell is a whole sequence, and there is no base pair inside it to put
   * a bigWig sample at — so a track there would be an empty strip claiming a
   * track's worth of height. There used to be one exception, the 4C lane, whose
   * profile was columns of the block itself; it is gone (§18.9), and with it the
   * only reason this could ever answer with a non-empty list.
   */
  private drawnOn(edge: LaneEdge): AnnotationEntry[] {
    const map = this.options.map ?? LEAD_MAP
    // The map on its own; see {@link setBare}.
    if (this.bare) return []
    // Turned, every track is in the stack below the rectangle whatever edge it
    // was put on, and the other three stacks are empty. A *presentation* of the
    // placement rather than a rewrite of it: the turn is something the reader
    // switches on and off, and a track that came back from it on the bottom
    // edge because it happened to be turned when they pressed the button would
    // be the picture editing their settings behind them. Which means "back
    // where it came from on the way home" costs nothing — the store never moved.
    if (this.turned && edge !== 'bottom') return []
    const entries = this.turned
      ? this.options.store.drawnAnywhereOn(map)
      : this.options.store.drawnOnMap(map, edge)
    // No axis on this edge, no lane — with one exception, which is the whole of
    // §8.12. Every *loaded* kind draws against genomic coordinates, so a
    // contig-level or genome-level block leaves them nothing to place their
    // signal on. A metadata column is indexed by the map's own cells instead,
    // and a genome × genome overview has those even though it has no base pair
    // anywhere in it — which is precisely the picture a MAG's contamination
    // belongs beside.
    const locus = this.axisFor(edge) !== null
    const cells = this.metaAxisFor(edge) !== null
    // A pile is 1D-only (§8.13), whatever axis this edge has. Beside a heatmap
    // the finest unit on the axis is a matrix bin, and a read is not a number
    // of bins — there is nothing here for one to be drawn on. Filtered out
    // before the axis question rather than answered `coverage` by it, because
    // the row that *is* the coverage is a row of its own now and is already in
    // this list.
    const placeable = entries.filter((entry) => entry.kind !== 'reads')
    if (locus && cells) return placeable
    return placeable.filter((entry) => (isMetadata(entry.kind) ? cells : locus))
  }

  /**
   * Extra canvas a vertical stack needs past the map for its handles.
   *
   * Those handles hang *below* the data, where a vertical lane's rotated name
   * begins, and the room for them is whatever the heatmap left under its plot —
   * which in a view with no column labels is a couple of pixels. Rather than
   * back the handle into the signal, the stack takes the few pixels it is short
   * onto the end of its own canvas: added after the data, so no coordinate
   * moves and the map is not touched. Zero whenever the margin is already
   * enough, which is most views, and always zero for a horizontal stack — the
   * space *before* one of those lanes is the plot's left margin, and a canvas
   * cannot grow backwards without shifting everything drawn in it.
   */
  private tailFor(edge: LaneEdge, geometry: LaneGeometry): number {
    if (laneIsHorizontal(edge)) return 0
    const below = geometry.cssHeight - (geometry.data.y + geometry.data.height)
    return Math.max(0, GRIP_ROOM - below)
  }

  /**
   * Room past the last lane for the loop and box anchors, when there are any.
   *
   * The triangles used to be drawn *in* that lane, over the last seven pixels of
   * whatever it is a picture of — which on a coverage track is the busiest part
   * of it, and on a full one is a mark you cannot see at all. A band of their
   * own is the only place a glyph about the axis can go without being ink on
   * somebody's data.
   *
   * Zero while nothing that anchors is marked, so the map keeps those pixels in
   * the session that never places one: the band is the cost of a mark, and it
   * arrives with the mark that needs it.
   */
  private anchorBand(): number {
    const marks = this.manual.arrowheads.length + this.manual.rects.length
    return marks > 0 ? ANCHOR_GAP + ANCHOR_LENGTH : 0
  }

  /**
   * The runs of adjacent lanes on one edge that share a value axis.
   *
   * In **canvas** coordinates, because a bar is a fact about a stretch of the
   * stacking axis rather than about a lane, and there is no `across` for it to
   * be measured in. On a top or left stack the slots run backwards in canvas
   * order, so the list is reversed before the runs are coalesced — otherwise
   * two adjacent members of one group look like two runs a stack apart.
   */
  private runsOn(edge: LaneEdge): ReturnType<typeof groupRuns> {
    const outward = laneOutward(edge)
    const total = this.thicknessOf(edge)
    const lanes = this.slotsFor(edge).map((slot) => ({
      group: slot.entry.style.group,
      colour: slot.entry.style.colour,
      // The rectangle's *low* corner in canvas pixels, which above and to the
      // left of the map is the lane's far edge rather than its near one.
      acrossFrom:
        outward > 0 ? slot.acrossFrom : total - slot.acrossFrom - slot.thickness,
      thickness: slot.thickness,
    }))
    if (outward < 0) lanes.reverse()
    return groupRuns(lanes, LANE_GAP)
  }

  /**
   * Where along the axis a stack's group bars go: the end the handles are not on.
   *
   * A bar marks a *run of lanes*, so it spans the stacking direction and is
   * three pixels thick along the genomic one — which means it has to sit in one
   * of the two margins the plot leaves at the ends of that axis. The handles
   * have already claimed one: they hang before a horizontal lane and after a
   * vertical one ({@link gripFrom}). The bar takes the other, which is the far
   * end under and over the map and the near end beside it — and neither ever
   * touches data.
   */
  private barAlong(frame: LaneFrame): number {
    return laneIsHorizontal(frame.orientation)
      ? frame.alongTo + GROUP_GAP
      : frame.alongFrom - GROUP_GAP - GROUP_BAR
  }

  /** Total thickness one edge needs, or `0` when it has no lanes. */
  thicknessOf(edge: LaneEdge): number {
    const slots = this.slotsFor(edge)
    if (slots.length === 0) return 0
    const last = slots[slots.length - 1]
    return last.acrossFrom + last.thickness + this.anchorBand()
  }

  /**
   * Where a slot's edge *nearest the map* falls in its canvas.
   *
   * The one conversion between the two coordinate systems this class holds. A
   * stack is laid out from the map outward; a canvas is drawn from its own
   * origin. Below and beside the map those run together; above it and to its
   * left they run opposite, and the stack's total thickness is the mirror. Past
   * here every offset is a `LaneFrame`'s, and `render/lane.ts` owns the rest.
   */
  private nearEdgeOf(edge: LaneEdge, slot: Pick<Slot, 'acrossFrom'>): number {
    return laneOutward(edge) > 0
      ? slot.acrossFrom
      : this.thicknessOf(edge) - slot.acrossFrom
  }

  /**
   * How far out into a stack a point in its canvas is — the same coordinate the
   * slots are laid out in, so a hit test can be a comparison rather than a
   * branch per edge.
   */
  private stackAcross(edge: LaneEdge, x: number, y: number): number {
    const canvas = laneIsHorizontal(edge) ? y : x
    return laneOutward(edge) > 0 ? canvas : this.thicknessOf(edge) - canvas
  }

  /**
   * Draw every stack onto its own canvas.
   *
   * Two passes over the lanes rather than one: every value profile is built
   * first, then the limits are resolved — which is the only order in which an
   * autoscale *group* can exist, since a group's range is a fact about all its
   * members and not about any one of them.
   */
  draw(geometry: LaneGeometry): void {
    this.dpr = window.devicePixelRatio > 0 ? window.devicePixelRatio : 1
    this.layouts.clear()
    const built = this.build(geometry)

    for (const edge of EDGES) {
      const canvas = this.canvases[edge]
      const lanes = built[edge]
      this.state[edge] = emptyEdgeState()
      canvas.classList.toggle('hidden', lanes.length === 0)
      if (lanes.length === 0) continue

      // The lane canvas matches the heatmap canvas on the shared axis exactly,
      // so the two are drawn in one coordinate system rather than in two that
      // agree by arrangement — plus whatever tail a vertical stack's handles
      // need, which is added *after* the data and so moves nothing.
      const total = this.thicknessOf(edge)
      const horizontal = laneIsHorizontal(edge)
      const cssAlong =
        (horizontal ? geometry.cssWidth : geometry.cssHeight) + this.tailFor(edge, geometry)
      const cssWidth = horizontal ? cssAlong : total
      const cssHeight = horizontal ? total : cssAlong
      canvas.style.width = `${cssWidth}px`
      canvas.style.height = `${cssHeight}px`
      const wantWidth = Math.max(1, Math.round(cssWidth * this.dpr))
      const wantHeight = Math.max(1, Math.round(cssHeight * this.dpr))
      if (canvas.width !== wantWidth) canvas.width = wantWidth
      if (canvas.height !== wantHeight) canvas.height = wantHeight

      const ctx = canvas.getContext('2d')
      if (ctx === null) continue
      ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0)
      ctx.clearRect(0, 0, cssWidth, cssHeight)
      this.state[edge] = this.paintEdge(ctx, edge, geometry, lanes, built.groups, this.dpr)
    }
  }

  /** The colour chips and autoscale buttons one stack wants laid over it. */
  marksOn(edge: LaneEdge): readonly LaneMark[] {
    return this.state[edge].marks
  }

  /**
   * The limit box under a point in a stack's canvas, if any.
   *
   * From the boxes the paint measured, not from a second measurement of the same
   * text: any second opinion about the same font differs from the first by
   * exactly the pixel the click misses by.
   */
  limitAt(
    edge: LaneEdge,
    x: number,
    y: number,
  ): { entries: AnnotationEntry[]; hit: LimitBox } | null {
    for (const range of this.state[edge].ranges) {
      const [bx, by, width, height] = range.hit.box
      if (x >= bx - 2 && x <= bx + width + 2 && y >= by - 2 && y <= by + height + 2) return range
    }
    return null
  }

  /**
   * The track name under a point in a stack's canvas, if any.
   *
   * The twin of {@link limitAt}, from the same paint and with the same slack:
   * both are text this lane drew, and both are things the reader changes.
   */
  nameAt(edge: LaneEdge, x: number, y: number): { entry: AnnotationEntry; hit: NameBox } | null {
    for (const found of this.state[edge].names) {
      const [bx, by, width, height] = found.hit.box
      if (x >= bx - 2 && x <= bx + width + 2 && y >= by - 2 && y <= by + height + 2) return found
    }
    return null
  }

  /**
   * The pair a track's axis was last drawn with, group included.
   *
   * The twin of the browser's own `shownLimits`, and what the limit editor seeds
   * the *untouched* end from: an autoscaled track has no stored pair to amend,
   * so the other end has to come from the axis on screen — which is the one the
   * reader was looking at when they typed.
   */
  shownLimits(id: string): { min: number; max: number } | null {
    for (const edge of EDGES) {
      const found = this.state[edge].limits.get(id)
      if (found !== undefined) return found
    }
    return null
  }

  /**
   * The extent one lane's data covers on screen, for a relative ceiling step.
   *
   * The *lane's*, group included, so ⌘-scrolling a member of a shared-axis group
   * moves the axis all of them are drawn against rather than one track's own.
   */
  extentOf(edge: LaneEdge, id: string): { min: number; max: number } | null {
    return this.state[edge].limits.get(id) ?? null
  }

  /** Every track drawn in the lane hosted by `id`, overlaid members included. */
  membersOf(edge: LaneEdge, id: string): AnnotationEntry[] {
    const slot = this.slotsFor(edge).find((each) => each.entry.id === id)
    return slot === undefined ? [] : [slot.entry, ...slot.overlaid]
  }

  /**
   * How far into a lane a point in its stack's canvas falls, in the lane's own
   * across coordinates — zero at the map, growing outward.
   *
   * What a ceiling drag starts from: the gesture is read through
   * {@link ceilingFactor}, which asks the frame which way a larger value is
   * drawn, so both ends of the drag have to be in the units that question is
   * answered in rather than in canvas pixels.
   */
  withinLane(edge: LaneEdge, id: string, x: number, y: number): number {
    const slot = this.slotsFor(edge).find((each) => each.entry.id === id)
    return slot === undefined ? 0 : this.stackAcross(edge, x, y) - slot.acrossFrom
  }

  /** Which way a drag across this stack's canvas moves *outward*, away from the map. */
  outwardOf(edge: LaneEdge): 1 | -1 {
    return laneOutward(edge)
  }

  /**
   * One lane's frame, for a gesture that has to reason in its coordinates.
   *
   * Rebuilt rather than retained, because a frame is cheap and a *stale* one is
   * a gesture answering about a window that has since moved. The drag that wants
   * it is asking one question — which way across this lane is more — and
   * `valueAcross` needs the whole frame to answer it.
   */
  frameFor(edge: LaneEdge, id: string, geometry: LaneGeometry): LaneFrame | null {
    const slot = this.slotsFor(edge).find((each) => each.entry.id === id)
    return slot === undefined ? null : this.frameOf(edge, slot, geometry)
  }

  /**
   * Draw every stack into somebody else's context — the export path.
   *
   * Placed as the screen places them, around a map whose own top-left corner is
   * `origin`: the figure has to leave room for the stacks above and to the left
   * of it, and the only thing that knows how much is the caller doing the
   * layout. Redrawn at the export scale rather than scaled up as images, so a
   * 300 dpi figure has 300 dpi track names, which is the same trade
   * `HeatmapView.renderTo` makes.
   */
  renderInto(
    ctx: CanvasRenderingContext2D,
    geometry: LaneGeometry,
    scale: number,
    origin: { x: number; y: number } = { x: 0, y: 0 },
  ): void {
    const built = this.build(geometry)
    for (const edge of EDGES) {
      const lanes = built[edge]
      if (lanes.length === 0) continue
      // Where the stack's own canvas would sit on the page, relative to the
      // map's: past the far side of it below and to the right, and back by its
      // own thickness above and to the left.
      const total = this.thicknessOf(edge)
      const at = {
        top: { x: origin.x, y: origin.y - total },
        right: { x: origin.x + geometry.cssWidth, y: origin.y },
        bottom: { x: origin.x, y: origin.y + geometry.cssHeight },
        left: { x: origin.x - total, y: origin.y },
      }[edge]
      ctx.save()
      ctx.setTransform(scale, 0, 0, scale, at.x * scale, at.y * scale)
      this.paintEdge(ctx, edge, geometry, lanes, built.groups, scale)
      ctx.restore()
    }
  }

  // -------------------------------------------------------------------------
  // Pass one: geometry, samples, profiles
  // -------------------------------------------------------------------------

  private build(geometry: LaneGeometry): Record<LaneEdge, Lane[]> & {
    groups: Map<string, { min: number; max: number }>
  } {
    this.cache?.prune(new Set(this.options.store.entries.map((entry) => entry.id)))
    const built = {
      top: this.buildEdge('top', geometry),
      right: this.buildEdge('right', geometry),
      bottom: this.buildEdge('bottom', geometry),
      left: this.buildEdge('left', geometry),
    }

    // The group ranges, over every lane on every edge: a group is a claim that
    // these tracks are comparable, and comparing them on two different scales
    // because they happen to be on different edges would defeat it. Through the
    // shared resolver, so a group set to scale each of its members separately is
    // honoured here exactly as it is in the browser — which it was not while
    // this file unioned every group unconditionally.
    const groups = resolveGroupExtents(
      EDGES.flatMap((edge) => built[edge]).flatMap((lane) =>
        lane.profiles.map(({ entry, profile }) => ({
          group: entry.style.group,
          extent: profile.extent,
        })),
      ),
      (group) => this.groups.scalingOf(group),
    )
    return { ...built, groups }
  }

  private buildEdge(edge: LaneEdge, geometry: LaneGeometry): Lane[] {
    const axis = this.axisFor(edge)
    return this.slotsFor(edge).map((slot) => {
      const frame = this.frameOf(edge, slot, geometry)
      const profiles: Lane['profiles'] = []
      let categories: Lane['categories'] = null
      for (const member of [slot.entry, ...slot.overlaid]) {
        // A quantitative metadata column is a profile like any other from here
        // on: one value per cell reduced to one per pixel, and everything after
        // that — limits, groups, the ceiling drag, the figure — is the code the
        // tracks already go through (§8.12).
        if (member.kind === 'metadata') {
          const cells = this.cellsFor(member, edge)
          if (cells?.kind !== 'quantitative') continue
          profiles.push({
            entry: member,
            profile: profileFromCells(frame, cells.values, this.cellScaleFor(edge)),
          })
          continue
        }
        if (member.kind === 'classes') {
          // Only the lane's host is painted, never an overlaid member: two
          // categorical strips in one lane is the second one painted over the
          // first, and there is no transparency that makes two opaque category
          // maps readable together.
          if (member.id !== slot.entry.id) continue
          const cells = this.cellsFor(member, edge)
          if (cells?.kind === 'qualitative') categories = cells
          continue
        }
        // A sequence is a value track from here: beside a map, where a pixel is
        // a whole bin, a FASTA can only ever be its GC content — the residues
        // need a base per pixel and a bin is a thousand of them.
        if (axis === null || !drawnFromSamples(member.kind)) continue
        profiles.push({
          entry: member,
          profile: profileOf(frame, axis, this.samplesFor(member, edge, axis, frame)),
        })
      }
      return {
        entry: slot.entry,
        overlaid: slot.overlaid,
        frame,
        border: this.nearEdgeOf(edge, slot) + laneOutward(edge) * slot.thickness,
        profiles,
        categories,
      }
    })
  }

  private frameOf(edge: LaneEdge, slot: Slot, geometry: LaneGeometry): LaneFrame {
    const { plot, data, colScale, rowScale } = geometry
    const acrossFrom = this.nearEdgeOf(edge, slot)
    const thickness = slot.thickness
    if (laneIsHorizontal(edge)) {
      return {
        orientation: edge,
        toPixel: (unit) => plot.x + colScale.toPixel(unit),
        toUnit: (pixel) => colScale.toUnit(pixel - plot.x),
        domain: colScale.domain,
        alongFrom: data.x,
        alongTo: data.x + data.width,
        acrossFrom,
        thickness,
      }
    }
    return {
      orientation: edge,
      toPixel: (unit) => plot.y + rowScale.toPixel(unit),
      toUnit: (pixel) => rowScale.toUnit(pixel - plot.y),
      domain: rowScale.domain,
      alongFrom: data.y,
      alongTo: data.y + data.height,
      acrossFrom,
      thickness,
    }
  }

  /**
   * The samples to draw, and a fetch if the ones in hand will not do.
   *
   * Returns whatever is cached — possibly at the wrong resolution, possibly
   * nothing — and never waits. A lane showing slightly coarse data for one frame
   * is invisible; a lane that blanks while it waits is not.
   */
  private samplesFor(
    entry: AnnotationEntry,
    edge: LaneEdge,
    axis: LocusAxis,
    frame: LaneFrame,
  ): TrackSampleSet | null {
    // Scoped by *axis* rather than by edge, because that is what the samples
    // actually differ by: the same bigWig drawn above and below the map is one
    // window at one resolution, and giving the two stacks separate slots would
    // fetch it twice to draw the same numbers.
    return (
      this.cache?.samplesFor({
        entry: entry.id,
        scope: laneIsHorizontal(edge) ? 'cols' : 'rows',
        axis,
        domain: frame.domain,
        pixels: Math.abs(frame.alongTo - frame.alongFrom),
        ...(entry.derivedFrom === undefined ? {} : { derived: entry.derivedFrom }),
        // The lane's read controls reach the coverage beside the map too. A
        // MAPQ floor set in the browser is a claim about which alignments count,
        // not about one view of them, and a lane that answered it in one place
        // and not the other would be two different numbers under one name.
        ...(entry.kind === 'alignments' ? { reads: readsOf(entry.style) } : {}),
      }) ?? null
    )
  }

  // -------------------------------------------------------------------------
  // Pass two: ink
  // -------------------------------------------------------------------------

  private paintEdge(
    ctx: CanvasRenderingContext2D,
    edge: LaneEdge,
    geometry: LaneGeometry,
    lanes: Lane[],
    groups: Map<string, { min: number; max: number }>,
    dpr: number,
  ): EdgeState {
    const state = emptyEdgeState()
    const axis = this.axisFor(edge)
    // One read for the whole stack: every lane asks the same question and the
    // store behind it is a module-level one.
    const { text, fills, outline, baseline } = getPlotOptions()

    for (const lane of lanes) {
      const { entry, frame, profiles } = lane
      // What to write on the lane, decided by the branch that drew it and
      // written *after* the clip is released, exactly as the browser does it.
      let label: {
        entries: AnnotationEntry[]
        detail: LaneLabelSpec['detail']
        at: 'near' | 'far'
      } | null = null
      clipLane(ctx, frame)
      if (profiles.length > 0) {
        // While a ceiling is being dragged this lane is drawn twice: once as it
        // stood, faded and still, and once as the hand is asking for it.
        const dragged = geometry.scaling?.id === entry.id ? geometry.scaling.factor : null
        for (const { entry: member, profile } of profiles) {
          const limits = resolveLimits(
            member.style.limits,
            extentFor(member, profile.extent, groups),
          )
          const paint = {
            colour: member.style.colour,
            mode: member.style.mode,
            limits,
            guideColour: geometry.palette.guide,
            haloColour: geometry.palette.halo,
            font: scaleFont(LANE_FONT),
            // Overlaid tracks are translucent by necessity: two opaque areas in
            // one lane means the second hides the first, which is the opposite
            // of what overlaying them was for.
            opacity:
              profiles.length > 1 ? member.style.opacity * OVERLAY_DIM : member.style.opacity,
            fills,
            outline,
            baseline,
            flip: member.style.flip,
          }
          if (dragged === null || !hasAMovableAxis(member.kind)) {
            drawTrack(ctx, frame, profile, paint)
          } else {
            drawTrackScaling(ctx, frame, profile, paint, scaledTo(limits, dragged))
          }
        }
        const first = profiles[0]
        const limits = resolveLimits(
          first.entry.style.limits,
          extentFor(first.entry, first.profile.extent, groups),
        )
        // Every member's axis is the lane's, so one entry per member: the
        // ceiling gesture and the limit editor both act on the lane. The
        // *committed* pair, never the one under a drag — this is what the next
        // gesture starts from, and a half-finished one is not a decision.
        for (const { entry: member } of profiles) state.limits.set(member.id, limits)
        if (text) {
          // Mid-drag the range says where the hand is going, not where it came
          // from: the faded copy behind it is already saying that, and the
          // number a reader is watching is the one they are setting.
          const shown = dragged === null ? limits : scaledTo(limits, dragged)
          label = {
            entries: profiles.map(({ entry: member }) =>
              member.kind === 'sequence'
                ? { ...member, label: `${member.label} · GC` }
                : member,
            ),
            // A note wins the detail line, for the reason `BrowserView` gives
            // at its own copy of this: it is only ever set where the lane drew
            // nothing, and limits under an empty lane read as "there is nothing
            // here" rather than "there is too much here to draw" (§8.13).
            detail: laneNote(profiles) ?? { kind: 'limits', ...shown },
            at: labelEndFor(frame, shown, first.entry.style.flip),
          }
        }
      } else if (lane.categories !== null) {
        // A qualitative column: colour per category, edge to edge, with the
        // names written into the runs that have room for them (§8.12). The
        // palette is the categories' own and not the entry's colour — see
        // `render/meta.ts` for why one swatch cannot describe six categories.
        const runs = drawCategories(
          ctx,
          frame,
          lane.categories,
          {
            levels: lane.categories.levels,
            opacity: entry.style.opacity,
            labels: text,
            font: scaleFont(LANE_FONT),
            haloColour: geometry.palette.halo,
            guideColour: geometry.palette.guide,
            baseline,
          },
          this.cellScaleFor(edge),
        )
        this.metaRuns.set(`${entry.id}:${edge}`, { frame, runs })
        if (text) {
          const shown = new Set(runs.map((run) => run.code))
          label = {
            // Named with a colour that is **in the lane**: the label's swatch is
            // the entry's own colour everywhere else, and on a categorical strip
            // that colour is drawn nowhere at all — a green chip over a lane of
            // blue and orange is a legend for a track that is not there. The
            // first category drawn is the one the chip stands for, and the card
            // carries the full legend.
            entries: [
              {
                ...entry,
                style: {
                  ...entry.style,
                  colour: categoryColour(runs[0]?.code ?? -1),
                },
              },
            ],
            // How many of the column's categories this picture actually holds,
            // which is the one number a reader cannot get from the colours: a
            // lane showing three of eleven taxa looks exactly like a lane of a
            // three-category column.
            detail: {
              kind: 'text',
              text:
                shown.size === lane.categories.levels.length
                  ? `${fmt.int(shown.size)} categories`
                  : `${fmt.int(shown.size)} of ${fmt.int(lane.categories.levels.length)} categories`,
            },
            at: 'near',
          }
        }
      } else if (entry.payload?.kind === 'features' && axis !== null) {
        // The browser's row heights, and for the browser's reason: a name goes
        // *under* its feature on both surfaces, and the band that holds it has
        // to be asked for at the point the rows are counted. `labelBandOf`
        // refuses the band on a row too short to hold both, so a lane dragged
        // down to sixteen pixels still falls back to names inside the wide
        // features — the rule is one rule, and the lane's height decides.
        const rows = rowsThatFit(frame.thickness, scaleLength(entry.kind === 'gtf' ? 26 : 22))
        const layout = layoutFeatures(frame, axis, entry.payload.data, rows)
        this.layouts.set(`${entry.id}:${edge}`, { frame, layout })
        const paint = {
          colour: entry.style.colour,
          guideColour: geometry.palette.guide,
          haloColour: geometry.palette.halo,
          font: scaleFont(LANE_FONT),
          opacity: entry.style.opacity,
          labels: text,
          labelsBelow: true,
          labelBand: scaleLength(LABEL_BAND),
        }
        if (entry.kind === 'gtf') drawGenes(ctx, frame, entry.payload.data, layout, paint)
        else drawSegments(ctx, frame, entry.payload.data, layout, paint)
        if (text) {
          label = {
            entries: [entry],
            detail: layout.dense ? { kind: 'text', text: `${fmt.int(layout.total)} in view` } : null,
            at: 'near',
          }
        }
      }
      ctx.restore()
      if (label !== null) this.labelLane(ctx, lane, geometry, label, state)

      // The handle, outside the clip because it hangs outside the lane: in the
      // plot's own margin, just before the column of the map this track is drawn
      // under. Every lane has one at all times — it costs the picture nothing
      // out there — and the one under the pointer is drawn at full strength.
      //
      // Level with the lane's *name*, wherever the label pass put it: on a
      // flipped track that is the other end of the lane, and a handle left at a
      // constant offset would then belong to nothing in particular.
      //
      // Not under the `text` option: that option is about what the figure
      // carries, and this is a control.
      if (geometry.handles) {
        drawGrip(
          ctx,
          frame,
          gripAcross(frame, state.gripRows.get(entry.id) ?? NAME_ACROSS),
          geometry.palette.guide,
          geometry.grip === entry.id ? 1 : GRIP_IDLE,
        )
      }

      // The map's crosshair, continued into the lane — as the two anchors of the
      // contact under the pointer where the map is turned, and as the one column
      // under it where it is not.
      if (geometry.crosshair && geometry.hover !== null) {
        const units = laneIsHorizontal(edge)
          ? (geometry.anchors ?? [geometry.hover.col + 0.5])
          : [geometry.hover.row + 0.5]
        for (const unit of units) {
          hairline(ctx, frame, frame.toPixel(unit), geometry.palette.crosshair, dpr)
        }
      }
      // ...and another map's, as a tick off the near edge rather than a rule
      // through the profile. Under the same preference as the crosshair it is
      // an echo of: a reader who turned that off has said they want no mark
      // following their pointer, and one that appears only where they are *not*
      // pointing is that answered backwards.
      if (geometry.crosshair && geometry.echo !== null) {
        // The two anchors under a turn, exactly as the reader's own pointer gets
        // them above: an echoed *contact* is between two places, and one tick
        // half way along the axis between them marks neither.
        const units = laneIsHorizontal(edge)
          ? (geometry.echoAnchors ?? [geometry.echo.col + 0.5])
          : [geometry.echo.row + 0.5]
        for (const unit of units) {
          laneTick(ctx, frame, frame.toPixel(unit), geometry.palette.crosshair, dpr)
        }
      }
      // ...and another map's *track* pointer, which names one place rather than
      // a contact and therefore needs no anchors: the position is the position
      // on every axis that measures it. Only on the stacks that run along that
      // axis — a place named on the columns says nothing about a row.
      if (
        geometry.crosshair &&
        geometry.laneEcho !== null &&
        laneIsHorizontal(edge) === (geometry.laneEcho.axis === 'cols')
      ) {
        laneTick(ctx, frame, frame.toPixel(geometry.laneEcho.unit), geometry.palette.crosshair, dpr)
      }
      // ...and the reader's own, from pointing at this stack. Not under the
      // crosshair preference: that option is about what the *map* draws while
      // you move over it, and this line is the direct answer to a gesture being
      // made right now. A pointer over a track with no line under it looks like
      // a track that does not respond.
      if (geometry.guide !== null && geometry.guide.edge === edge) {
        hairline(ctx, frame, geometry.guide.along, geometry.palette.crosshair, dpr)
      }

      // The resize rule, where the pointer is on this lane's far border. The
      // cursor is the drawn arrowhead everywhere on these canvases — it is what
      // points at a base pair — so an affordance that lived in the cursor would
      // not exist. The same rule the 1D browser draws, for the same gesture.
      if (geometry.border === entry.id) {
        ctx.save()
        ctx.strokeStyle = geometry.palette.crosshair
        ctx.lineWidth = BORDER_RULE
        ctx.beginPath()
        const at = borderRuleAt(lane.border, laneOutward(edge), this.thicknessOf(edge))
        if (laneIsHorizontal(edge)) {
          ctx.moveTo(frame.alongFrom, at)
          ctx.lineTo(frame.alongTo, at)
        } else {
          ctx.moveTo(at, frame.alongFrom)
          ctx.lineTo(at, frame.alongTo)
        }
        ctx.stroke()
        ctx.restore()
      }

      // The reader's hand-drawn lines, continued off the map. Only the ones
      // this edge measures: a vertical rule is a column and belongs over and
      // under the map, a horizontal one is a row and belongs beside it. A mark
      // drawn on the axis it does not name would point at the wrong coordinate.
      if (axis !== null) {
        const measures = laneIsHorizontal(edge) ? 'vertical' : 'horizontal'
        for (const line of this.manual.lines) {
          if (line.axis !== 'both' && line.axis !== measures) continue
          const unit = axis.locusToUnit(line.at.contig, line.at.bp)
          if (unit === null) continue
          hairline(ctx, frame, frame.toPixel(unit), line.colour, dpr)
        }
      }
    }

    // Loop anchors, once per stack rather than once per lane: a triangle on the
    // axis says "this coordinate", and one per track would say it four times.
    // Drawn on the stack's outer edge, pointing back at the map, so it reads as
    // a pointer into the picture rather than as another feature in a track.
    //
    // **Both** anchors on **both** axes. A loop is a statement about two loci,
    // and a reader looking at the tracks under one end of it is asking what is
    // at the other — putting the row anchor only beside the map and the column
    // anchor only under it would answer half of that on each edge, and neither
    // half where the comparison is made. A coordinate is a coordinate: each end
    // is drawn wherever the axis in front of it has room for it.
    //
    // A **box** is the same statement four times over — where it starts and
    // stops on each axis — so its edges are anchored the same way. Two triangles
    // under a domain drawn on the diagonal is what a reader comparing it against
    // the tracks is actually asking for: the boundaries, in the coordinate the
    // tracks are drawn in.
    const last = lanes[lanes.length - 1]
    if (last !== undefined) {
      for (const mark of axis === null ? [] : anchorsOf(this.manual)) {
        const drawn = new Set<number>()
        for (const anchor of mark.at) {
          const unit = axis?.locusToUnit(anchor.contig, anchor.bp) ?? null
          // An on-diagonal loop names one place twice, and an on-diagonal box
          // names two places twice; drawing a triangle again only darkens it.
          if (unit === null || drawn.has(unit)) continue
          drawn.add(unit)
          anchorMark(ctx, last.frame, last.frame.toPixel(unit), mark.colour)
        }
      }

      // The bar for each run of lanes that share a value axis. Beside the map a
      // group has always been honoured *numerically* — its members resolve to
      // one pair of limits — and drawn nowhere, so two tracks on one axis and two
      // that happen to agree looked identical, on screen and in the figure.
      //
      // Without the group's **name**, which the browser writes beside its own
      // bar. There the margin is thirteen pixels and can be more; here it is the
      // plot's six, and six pixels cannot hold nine-pixel type. The colour ties a
      // bar to its members, and the Groups card is where the name is read.
      drawGroupBars(ctx, this.runsOn(edge), {
        horizontal: laneIsHorizontal(edge),
        along: this.barAlong(last.frame),
        text: false,
      })
    }
    return state
  }

  /**
   * The lane's name, its colour chip, and what its value axis spans.
   *
   * Inside the lane rather than in a gutter beside it. The gutters belong to the
   * heatmap's block labels and collapse to six pixels when those are off — which
   * is this app's default — so a name outside would have to reopen a band the
   * reader closed. A halo is what keeps it readable over the track's own ink.
   *
   * The drawing is `render/laneLabel.ts`'s, and it is the same call the 1D
   * browser makes: two implementations of one layout is the drift §5.8 exists to
   * prevent, and it is what left these two numbers inert here while the same two
   * were editable there. What the pass hands back is the point of it — the box
   * each end was measured into, the spot for the autoscale button, and the line
   * the name landed on, which is where this lane's handle goes.
   *
   * No name column. `column: null`, always, and not an oversight: the strip
   * before a bottom lane is the heatmap's own left margin, a canvas cannot grow
   * backwards to make one of its own, and a lane that started somewhere else
   * would no longer be under the column it describes.
   */
  private labelLane(
    ctx: CanvasRenderingContext2D,
    lane: Lane,
    geometry: LaneGeometry,
    label: { entries: AnnotationEntry[]; detail: LaneLabelSpec['detail']; at: 'near' | 'far' },
    state: EdgeState,
  ): void {
    const boxes = drawLaneLabel(ctx, lane.frame, {
      names: label.entries.map((entry) => ({
        id: entry.id,
        text: entry.label,
        colour: entry.style.colour,
      })),
      detail: label.detail,
      labelAt: label.at,
      column: null,
      style: laneLabelStyle(),
      palette: { text: geometry.palette.guide, halo: geometry.palette.halo },
    })
    state.gripRows.set(lane.entry.id, boxes.nameAcross)
    // Chrome, not picture: the export asks for no handles, and it must get no
    // hit boxes either — a saved figure has nothing to be pointed at.
    if (!geometry.handles) return
    for (const hit of boxes.limits) state.ranges.push({ entries: label.entries, hit })
    // One name, one track: a lane drawn as an overlay carries a name each, and
    // the id the paint recorded is what keeps a rename on the one pointed at.
    for (const hit of boxes.names) {
      const owner = label.entries.find((entry) => entry.id === hit.id)
      if (owner !== undefined) state.names.push({ entry: owner, hit })
    }
    for (const swatch of boxes.swatches) {
      const owner = label.entries.find((entry) => entry.id === swatch.id)
      if (owner !== undefined) state.marks.push({ kind: 'swatch', entries: [owner], box: swatch.box })
    }
    if (boxes.auto !== null && label.entries.some((entry) => hasAMovableAxis(entry.kind))) {
      state.marks.push({ kind: 'auto', entries: label.entries, at: boxes.auto })
    }
  }

  // -------------------------------------------------------------------------
  // Hover
  // -------------------------------------------------------------------------

  /**
   * Every value track on one edge, read at the position the pointer is at.
   *
   * The coordinates are that edge's own canvas's. Which lane the pointer is
   * *inside* decides only two things — which row is marked `here`, and whose
   * feature is described — because the position along the axis is the same
   * question for every lane in the stack, and reading them all is the whole
   * point of stacking them.
   */
  /**
   * Which lane a point in a stack's canvas is on, and whether it is on the
   * *border* between that lane and the next.
   *
   * The border is what a resize drag grabs, so it is given a few pixels of
   * slack on either side — a one-pixel target is a target nobody hits. Ordering
   * matters: a point in the slack of one lane's far border belongs to that
   * border, not to the lane after it, because the border is what the pointer
   * changed shape for.
   *
   * `null` between lanes and past the last one, so a drag begun in the gap does
   * nothing rather than something arbitrary.
   */
  laneAt(
    edge: LaneEdge,
    x: number,
    y: number,
  ): { entry: AnnotationEntry; members: AnnotationEntry[]; index: number; onBorder: boolean } | null {
    const across = this.stackAcross(edge, x, y)
    const slots = this.slotsFor(edge)
    for (let index = 0; index < slots.length; index++) {
      const slot = slots[index]
      const offset = across - slot.acrossFrom
      if (offset < -LANE_GRIP || offset > slot.thickness + LANE_GRIP) continue
      return {
        entry: slot.entry,
        members: [slot.entry, ...slot.overlaid],
        index,
        onBorder: offset > slot.thickness - LANE_GRIP,
      }
    }
    return null
  }

  /** How many lanes one edge draws — what a stretch divides its room between. */
  slotCount(edge: LaneEdge): number {
    return this.slotsFor(edge).length
  }

  /**
   * Which slot a point in a stack's canvas is over, for a drag reordering them.
   *
   * Clamped rather than `null`, because a reorder drag that has left the last
   * lane is still pointing at the last slot — and answered in stack order, so
   * "first" means nearest the map on every edge.
   */
  slotIndexAt(edge: LaneEdge, x: number, y: number): number {
    const across = this.stackAcross(edge, x, y)
    const slots = this.slotsFor(edge)
    let to = 0
    while (to + 1 < slots.length && across >= slots[to + 1].acrossFrom) to++
    return to
  }

  /**
   * The lanes on one edge, as the tracks each of them draws.
   *
   * What a bulk height write acts on: a *lane* and not a track, so an overlay
   * group sharing one strip is set once between its members rather than once
   * each — which would be the same assignment written three times.
   */
  lanesOn(edge: LaneEdge): Array<{ members: AnnotationEntry[] }> {
    return this.slotsFor(edge).map((slot) => ({ members: [slot.entry, ...slot.overlaid] }))
  }

  /**
   * Move a lane to the slot the pointer is over, by **identity**.
   *
   * A slot index is not a store index, and treating one as the other is what the
   * lane drag used to do: a stack counts the lanes actually *drawn* on this
   * edge — visible, ready, not overlaid into somebody else's slot — while
   * the store's order is every linear entry there is. With one track hidden the
   * drop landed a slot early, and the last slot could not be reached at all. So
   * the slot names a lane, the lane names an entry, and the entry's position in
   * the store is looked up — which is what the 1D browser has always done.
   *
   * The whole lane moves, which for a group drawn in overlay mode is every
   * member of it: they share one slot on screen, and splitting them would put
   * half a group somewhere else.
   */
  moveToSlot(edge: LaneEdge, id: string, slot: number): void {
    const slots = this.slotsFor(edge)
    const target = slots[slot]
    if (target === undefined || target.entry.id === id) return
    const to = this.options.store.entries.findIndex((row) => row.id === target.entry.id)
    if (to < 0) return
    const moving = slots.find((each) => each.entry.id === id)
    if (moving === undefined) return
    const members = [moving.entry, ...moving.overlaid]
    members.forEach((member, offset) => this.options.store.moveTo(member.id, to + offset))
  }

  /**
   * The lane whose handle is under a point in a stack's canvas.
   *
   * Against the row the last paint put the name on, because that is where the
   * handle was drawn: on a flipped track the label — and the handle with it —
   * moves to the other end of the lane, and a hit test at a constant offset
   * would be testing a rectangle nothing is in.
   */
  gripAt(
    edge: LaneEdge,
    x: number,
    y: number,
    geometry: LaneGeometry,
  ): { entry: AnnotationEntry; index: number } | null {
    const slots = this.slotsFor(edge)
    const rows = this.state[edge].gripRows
    for (let index = 0; index < slots.length; index++) {
      const frame = this.frameOf(edge, slots[index], geometry)
      const across = gripAcross(frame, rows.get(slots[index].entry.id) ?? NAME_ACROSS)
      if (withinGrip(gripBox(frame, across), x, y)) {
        return { entry: slots[index].entry, index }
      }
    }
    return null
  }

  /**
   * The feature under a point in a stack's canvas, and which track drew it.
   *
   * Measured against the layout the last paint recorded, exactly as
   * {@link readout} does a few lines below — a feature's box on screen is the
   * *packed* box, decided by how many of its neighbours were in view when the
   * lane was drawn, and recomputing it here would be re-deriving a fact that has
   * already been written down once this frame.
   *
   * Public because a press on a lane has to tell two gestures apart: a feature
   * opens its own card, everything else opens the track's settings. Both live in
   * `MatrixPanel`, which owns the pointer; only the geometry lives here.
   */
  featureAt(
    edge: LaneEdge,
    x: number,
    y: number,
  ): { set: FeatureSet; index: number; source: string } | null {
    for (const slot of this.slotsFor(edge)) {
      const cached = this.layouts.get(`${slot.entry.id}:${edge}`)
      const set = slot.entry.payload?.kind === 'features' ? slot.entry.payload.data : null
      if (cached === undefined || set === null) continue
      const hit = featureAt(cached.frame, cached.layout, x, y)
      if (hit !== null) return { set, index: hit.index, source: slot.entry.label }
    }
    return null
  }

  readout(edge: LaneEdge, x: number, y: number, geometry: LaneGeometry): LaneReadout | null {
    const axis = this.axisFor(edge)
    const slots = this.slotsFor(edge)
    if (slots.length === 0) return null

    const horizontal = laneIsHorizontal(edge)
    const along = horizontal ? x : y
    const across = this.stackAcross(edge, x, y)
    const rows: LaneReadout['rows'] = []
    let detail: string[] = []
    let onALane = false

    for (const slot of slots) {
      const frame = this.frameOf(edge, slot, geometry)
      const offset = across - slot.acrossFrom
      const here = offset >= 0 && offset <= slot.thickness
      if (here) onALane = true

      // Every track in the lane, not only the one that hosts it: an overlay
      // group draws several into one strip, and a readout that named the host
      // alone would answer for one of the lines a reader is looking at.
      const values = [slot.entry, ...slot.overlaid].filter((member) => drawsAProfile(member.kind))
      if (values.length > 0) {
        for (const member of values) {
          // From the samples rather than from the paint: the answer is the
          // file's value at that base, not the mean the pixel happened to be
          // drawn at. A metadata column answers from its cells for the same
          // reason — the number under the pointer is the file's row, not the
          // mean of however many rows that pixel drew (§8.12).
          const value =
            member.kind === 'metadata'
              ? cellValueAt(this.cellsFor(member, edge), frame, along, this.cellScaleFor(edge))
              : axis === null
                ? null
                : valueAtPixel(
                    this.cache?.peek(member.id, horizontal ? 'cols' : 'rows') ?? null,
                    axis,
                    frame,
                    along,
                  )
          rows.push({
            label: member.kind === 'sequence' ? `${member.label} GC` : member.label,
            colour: member.style.colour,
            value: value === null ? '—' : fmt.num(value),
            here,
          })
        }
        continue
      }

      // A categorical strip has a name at a position rather than a number, so
      // it is a row whose "value" is the category — which is what a reader
      // hovering one wants to be told, and the only place the legend is.
      if (slot.entry.kind === 'classes') {
        const painted = this.metaRuns.get(`${slot.entry.id}:${edge}`)
        const cells = this.cellsFor(slot.entry, edge)
        const run =
          painted === undefined || cells?.kind !== 'qualitative'
            ? null
            : categoryAt(
                painted.runs,
                cellOfUnit(this.cellScaleFor(edge), painted.frame.toUnit(along)),
              )
        rows.push({
          label: slot.entry.label,
          colour: run === null ? slot.entry.style.colour : categoryColour(run.code),
          value:
            run === null || cells?.kind !== 'qualitative'
              ? '—'
              : (cells.levels[run.code] ?? '—'),
          here,
        })
        continue
      }

      // A feature lane has no value at a position, so it is not a row. When the
      // pointer is on one, the feature itself is what there is to say.
      if (!here) continue
      const cached = this.layouts.get(`${slot.entry.id}:${edge}`)
      const set = slot.entry.payload?.kind === 'features' ? slot.entry.payload.data : null
      if (cached === undefined || set === null) continue
      const hit = featureAt(cached.frame, cached.layout, x, y)
      if (hit === null) continue
      const at = hit.index
      const strand = set.strand[at] === 1 ? ' (+)' : set.strand[at] === -1 ? ' (−)' : ''
      // The feature's name leads its own block. It is not the lane's name — that
      // one the pointer already gives away — so it belongs in the readout rather
      // than in the heading. With its accession beside it where the file gave
      // both, since that is what tells one `VAR` from the next.
      const label = featureLabel(set, at)
      detail = label === '' ? [] : [label]
      detail.push(
        `${set.contigs[set.contig[at]]}:${fmt.int(set.start[at])}–${fmt.int(set.end[at])}${strand}`,
      )
      if (Number.isFinite(set.score[at])) detail.push(`score ${fmt.num(set.score[at])}`)
      if (set.detail[at] !== '') detail.push(set.detail[at])
    }

    if (rows.length === 0 && detail.length === 0 && !onALane) return null
    const first = this.frameOf(edge, slots[0], geometry)
    const cells = this.metaAxisFor(edge)
    return {
      // A base pair where there is one, and the unit's own name where there is
      // not: above bin level a cell is a whole sequence, so `MAG_12` is the
      // true answer and a coordinate would be an invention.
      position:
        axis !== null
          ? describeAt(axis, first, along)
          : cells === null
            ? '—'
            : describeCell(cells, first, along),
      rows,
      detail,
    }
  }
}

/**
 * A loop's anchor, as a small triangle in the band past the stack.
 *
 * Pointing *inwards*, towards the map: the mark it belongs to is a pixel over
 * there, and a glyph aimed at it is the difference between "this coordinate" and
 * "something else drawn here". Outlined in nothing — it sits past the last lane,
 * where there is no track ink to be lost against, and where it takes none of the
 * picture it is pointing into.
 *
 * Written in lane coordinates throughout, so "past the last lane" and "pointing
 * inwards" are the same two numbers on every edge.
 */
function anchorMark(
  ctx: CanvasRenderingContext2D,
  frame: LaneFrame,
  along: number,
  colour: string,
): void {
  if (along < frame.alongFrom || along > frame.alongTo) return
  // The band begins where the last lane ends, a couple of pixels clear of it.
  const tip = frame.thickness + ANCHOR_GAP
  const base = tip + ANCHOR_LENGTH
  const half = ANCHOR_HALF
  ctx.save()
  ctx.fillStyle = colour
  ctx.beginPath()
  ctx.moveTo(laneX(frame, along, tip), laneY(frame, along, tip))
  ctx.lineTo(laneX(frame, along - half, base), laneY(frame, along - half, base))
  ctx.lineTo(laneX(frame, along + half, base), laneY(frame, along + half, base))
  ctx.closePath()
  ctx.fill()
  ctx.restore()
}

/** Tip to base, half the base, and the air between the tip and the last track. */
const ANCHOR_LENGTH = 7
const ANCHOR_HALF = 4
const ANCHOR_GAP = 2

/**
 * One hairline across a lane, at a position along its axis.
 *
 * Snapped to a device pixel, or a 0.75-wide line lands between two and is drawn
 * as a two-pixel grey smear — which on a lane 16 pixels tall is a band, not a
 * mark.
 */
function hairline(
  ctx: CanvasRenderingContext2D,
  frame: LaneFrame,
  along: number,
  colour: string,
  dpr: number,
): void {
  if (along < frame.alongFrom || along > frame.alongTo) return
  ctx.save()
  ctx.strokeStyle = colour
  ctx.lineWidth = Math.max(1 / dpr, 0.75)
  ctx.globalAlpha = 0.8
  ctx.beginPath()
  const snapped = (Math.round(along * dpr - 0.5) + 0.5) / dpr
  ctx.moveTo(laneX(frame, snapped, 0), laneY(frame, snapped, 0))
  ctx.lineTo(
    laneX(frame, snapped, frame.thickness),
    laneY(frame, snapped, frame.thickness),
  )
  ctx.stroke()
  ctx.restore()
}

/**
 * A short tick off the near edge of a lane, where another map's pointer is.
 *
 * The same weight and colour as {@link hairline} — it is the same instrument
 * seen from another panel of a deck — but a fifth of the way across rather than
 * the whole way, so the profile it is marking stays readable underneath. Off
 * the *near* edge, the one facing the map, because that is the side the eye is
 * already crossing between the picture and the track.
 */
function laneTick(
  ctx: CanvasRenderingContext2D,
  frame: LaneFrame,
  along: number,
  colour: string,
  dpr: number,
): void {
  if (along < frame.alongFrom || along > frame.alongTo) return
  const reach = Math.min(frame.thickness, Math.max(4, frame.thickness * 0.2))
  ctx.save()
  ctx.strokeStyle = colour
  ctx.lineWidth = Math.max(1 / dpr, 0.75)
  ctx.beginPath()
  const snapped = (Math.round(along * dpr - 0.5) + 0.5) / dpr
  ctx.moveTo(laneX(frame, snapped, 0), laneY(frame, snapped, 0))
  ctx.lineTo(laneX(frame, snapped, reach), laneY(frame, snapped, reach))
  ctx.stroke()
  ctx.restore()
}

/** 9 px is what fits in a 16-pixel lane and still reads at a normal distance. */
const LANE_FONT = '9px system-ui, sans-serif'

/**
 * How strongly a handle nobody is pointing at is drawn.
 *
 * Every lane has one, and eight of them at full strength would be a column of
 * furniture down the side of the figure. Faint enough to read as a set of
 * controls waiting to be used, solid enough to be seen without hunting.
 */
const GRIP_IDLE = 0.45

/** Where the name sits in the lane, from the end its label block starts at. */
const NAME_ACROSS = 8

/** Air between a group bar and the end of the data it is beside. */
const GROUP_GAP = 2

/**
 * The sizes a lane beside the map writes its small print at.
 *
 * Smaller than the browser's in every field, and passed to the shared label
 * block rather than chosen by it: a lane here can be sixteen pixels tall and its
 * text has to fit in one, while a lane in the browser is ninety and its name is
 * what identifies the row. One module draws both; neither set of numbers is the
 * other's default.
 *
 * `swatch` is the one addition. A stack of four lanes used to carry four names
 * in one neutral grey, so an exported figure had no key at all tying a name to
 * the line it belongs to — and recolouring a track meant leaving the picture for
 * a menu. Nine pixels of chip is what buys both.
 */
function laneLabelStyle(): LaneLabelStyle {
  return {
    nameFont: scaleFont(LANE_FONT),
    rangeFont: scaleFont(LANE_FONT),
    // Every length here but the grip is in the same units as the text it is
    // spacing — see the browser's own style factory for why, and why the grip
    // is not: a border does not get easier to hit because the writing grew.
    swatch: scaleLength(9),
    nameTop: scaleLength(NAME_ACROSS),
    nameLine: scaleLength(11),
    detailDrop: scaleLength(11),
    inset: scaleLength(4),
    hitHeight: scaleLength(12),
    autoSlot: scaleLength(13),
    grip: LANE_GRIP,
  }
}

/** `I:412,000` — the same phrasing the matrix readout uses. */
function describeAt(axis: LocusAxis, frame: LaneFrame, along: number): string {
  const locus = axis.unitToLocus(frame.toUnit(along))
  return locus === null ? '—' : `${locus.contig}:${fmt.bp(locus.bp)}`
}

/**
 * `MAG_12` — where the pointer is, on an axis that has no base pairs (§8.12).
 *
 * The run's own label, which is what the axis is written with and what the
 * matrix tooltip says about the same column. A cell above genome level has no
 * position inside anything, so this is the whole of what can honestly be said
 * about where the pointer is — and it is more than the em dash that was there.
 */
function describeCell(block: MetaBlock, frame: LaneFrame, along: number): string {
  const cell = cellOfUnit(block.scale ?? IDENTITY_CELLS, frame.toUnit(along))
  for (const run of block.runs) {
    if (cell >= run.start && cell < run.end) return run.label
  }
  return '—'
}

/** The value of the cell under a pixel, from what the lane resolved. */
function cellValueAt(
  cells: MetaCells | null,
  frame: LaneFrame,
  along: number,
  scale: CellScale,
): number | null {
  if (cells === null || cells.kind !== 'quantitative') return null
  const cell = cellOfUnit(scale, frame.toUnit(along))
  if (cell < 0 || cell >= cells.values.length) return null
  const value = cells.values[cell]
  return Number.isFinite(value) ? value : null
}

/** The sampled value under a pixel, straight from the cache. */
function valueAtPixel(
  samples: TrackSampleSet | null,
  axis: LocusAxis,
  frame: LaneFrame,
  along: number,
): number | null {
  if (samples === null) return null
  const locus = axis.unitToLocus(frame.toUnit(along))
  if (locus === null) return null
  for (const region of samples.regions) {
    if (region.contig !== locus.contig) continue
    // Ascending and non-overlapping, so this is a binary search rather than the
    // linear scan a pointer move cannot afford at base resolution.
    let low = 0
    let high = region.starts.length - 1
    while (low <= high) {
      const mid = (low + high) >> 1
      if (locus.bp < region.starts[mid]) high = mid - 1
      else if (locus.bp >= region.ends[mid]) low = mid + 1
      else return region.values[mid]
    }
  }
  return null
}
