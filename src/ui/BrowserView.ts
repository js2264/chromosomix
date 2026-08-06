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
import { findFeatures, paddedSpan } from '../annotations/search'
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
import type { AnnotationEntry, BaseRegion, FeatureSet } from '../annotations/types'
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
import { RULER_HEIGHT, drawArcs, drawBoundaries, drawGuide, drawRuler, type RulerBand } from '../render/browser'
import { featureAt, drawGenes, drawSegments, layoutFeatures, rowsThatFit } from '../render/features'
import {
  GRIP_ROOM,
  GROUP_BAR,
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
  type LaneLabelSpec,
  type LaneLabelStyle,
  type LimitBox,
  type NameBox,
} from '../render/laneLabel'
import type { LocusAxis } from '../render/locus'
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
import {
  LANE_MIN_SIZE,
  heightThatFills,
  setTrackHeight,
  smallestLaneSize,
  trackHeightField,
} from './trackControls'
import {
  EXPORT_DPI_CHOICES,
  canvasToPng,
  captionStamp,
  downloadBlob,
  exportBaseName,
  fileStamp,
  largestDpiThatFits,
  scaleForDpi,
} from './export'
import { VectorPage } from './vector'
import { KEYS, withKey } from './commands'
import { searchKey } from './SearchBox'
import { type IconName, cardTitle, iconButton } from './icons'
import {
  CROSSHAIR_COLOR,
  SELECTION_CHIP,
  SELECTION_FONT,
  SELECTION_PAD,
} from '../render/heatmap'
import { transparencyField } from './AnnotationCard'
import { openLaneMenu, readCanvasPalette } from './MatrixPanel'
import {
  PLOT_OPTION_KEYS,
  PLOT_OPTION_LABELS,
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
  /** The one box: a locus, a sequence name or a feature name, all three. */
  private readonly locusInput: HTMLInputElement
  private readonly searchList = el('div', { class: 'browser-hits hidden' })
  private readonly zoomNote = el('span', { class: 'browser-zoom' })
  private readonly groupsCard: GroupsCard
  private readonly exportStatus = el('span', { class: 'clip-note export-note' })
  private readonly cache: SampleCache
  private readonly bases: BaseCache
  private readonly unsubscribes: Array<() => void> = []
  private readonly observer: ResizeObserver | null

  private dpr = 1
  private frameHandle = 0
  private disposed = false
  private bands: RulerBand[] = []
  private lanes: Lane[] = []
  /** Feature layouts from the last draw, for hit testing without a re-layout. */
  private readonly layouts = new Map<string, { frame: LaneFrame; layout: ReturnType<typeof layoutFeatures> }>()
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
    | { mode: 'pan'; x: number }
    | { mode: 'select'; x0: number; x: number }
    | { mode: 'resize'; entry: AnnotationEntry; y0: number; size: number }
    | { mode: 'reorder'; entry: AnnotationEntry; over: number }
    | { mode: 'scale'; lane: Lane; members: AnnotationEntry[]; from: number }
    | { mode: 'press'; x0: number; y0: number; lane: Lane | null; onBorder: boolean }
    | null = null
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
   * What the gutter *wants* to be, measured from the labels last drawn.
   *
   * A frame behind, and unavoidably so: the width depends on the text, the text
   * is measured while drawing it, and the drawing needs the width. It cannot
   * oscillate — a name's width does not depend on where the name is drawn — and
   * a change settles on the next frame, which is the same frame the change
   * itself lands on.
   */
  private wantGutter = DEFAULT_GUTTER
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
          // The same three marks the Plot card uses, because they are the same
          // three actions and a reader should not have to learn them twice.
          iconButton('unfold-horizontal', 'The whole genome (0, or a double click)', () => this.fit()),
          iconButton(
            'stretch-vertical',
            withKey('Stretch every track to fill the height, all to one height', KEYS.stretch),
            () => this.fitTracks(),
          ),
          iconButton(
            'fold-vertical',
            'Shrink every track to the height of the shortest of them',
            () => this.shrinkTracks(),
          ),
          // Autoscale is not here. It is in the Plot card, beside the height
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
            text: lengthsAreExact(props.assembly)
              ? ''
              : ' · lengths inferred from the features in this file, so each sequence ends at ' +
                'its last one rather than at its true end',
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
    this.sideEl = el('aside', { class: 'side' }, this.exportCard(), this.groupsCard.el)

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
    this.unsubscribes.push(props.store.subscribe(() => this.schedule()))
    this.unsubscribes.push(props.groups.subscribe(() => this.schedule()))
    this.unsubscribes.push(subscribePlotOptions(() => this.schedule()))
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
    this.editor.close()
    this.controls.destroy()
    this.groupsCard.destroy()
    if (this.frameHandle !== 0) cancelAnimationFrame(this.frameHandle)
    if (this.clickTimer !== null) clearTimeout(this.clickTimer)
    if (this.reportTimer !== null) clearTimeout(this.reportTimer)
    for (const off of this.unsubscribes) off()
    this.observer?.disconnect()
    this.cache.destroy()
    this.bases.destroy()
    setReadout('')
  }

  /**
   * Save this view as a figure — the `S` key, and the button in the Plot card.
   *
   * The same call either way, in the format and at the resolution the card is
   * set to: a shortcut that exported something *else* than the button beside it
   * would be a second export to keep in step.
   */
  savePlot(): void {
    void this.save()
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
   * Plot card can ask the same question; what stays here is the *measurement* —
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
      RULER_HEIGHT -
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
      if (entry.kind !== 'track' || entry.style.limits.auto) continue
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
    // Both cards, because in one dimension there is no "on the map" to be an
    // overlay of: a BED is boxes and a BEDPE is arcs, and each takes a lane of
    // its own like everything else here.
    const entries = this.props.store.entries.filter(
      (entry) => entry.visible && entry.status === 'ready',
    )
    return planStack(entries, {
      groupOf: (entry) => entry.style.group,
      modeOf: (group) => this.props.groups.modeOf(group),
      sizeOf: (entry) => entry.style.size,
      gap: LANE_GAP,
      from: RULER_HEIGHT + LANE_GAP,
      minimum: LANE_MIN_SIZE,
    }).map((slot) => ({
      entry: slot.host,
      overlaid: slot.overlaid,
      frame: this.frameAt(slot.acrossFrom, slot.thickness),
      profiles: [],
      residues: [],
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

  /** Total canvas height: the ruler, every lane, and the gaps between them. */
  private heightOf(lanes: Lane[]): number {
    const last = lanes[lanes.length - 1]
    return last === undefined
      ? RULER_HEIGHT + LANE_GAP
      : last.frame.acrossFrom + last.frame.thickness + LANE_GAP
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
    const live = new Set(this.props.store.entries.map((entry) => entry.id))
    this.cache.prune(live)
    this.bases.prune(live)
    this.dpr = window.devicePixelRatio > 0 ? window.devicePixelRatio : 1
    const width = Math.max(1, this.stage.clientWidth)
    this.canvasWidth = width
    // The name column, before anything is placed against it: it decides where
    // the axis begins, so it has to be settled before the scale knows how many
    // pixels it has. Capped at a third of the window — a column wider than that
    // is a panel, and the tracks are what this view is.
    const options = getPlotOptions()
    this.nameColumn =
      options.gutter && options.text
        ? Math.min(Math.round(this.wantGutter), Math.floor(width / 3))
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
    const height = this.heightOf(this.lanes)

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
    // export asks it too so that what is saved is what was on screen.
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
    }
    this.bands = drawRuler(ctx, ruler)
    drawBoundaries(ctx, ruler, RULER_HEIGHT, height)

    this.layouts.clear()
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
      { orientation: 'bottom', along: 0, labelAlong: GRIP_MARGIN + 2, text: this.text },
    )

    // Under the shared preference, like everything else drawn over the data: a
    // reader who turned the crosshair off beside a map meant it off.
    if (this.hover !== null && this.crosshair) {
      drawGuide(ctx, this.hover.x, 0, height, CROSSHAIR_COLOR, this.dpr)
    }
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
    const span = Math.abs(this.atUnit(moving) - this.atUnit(anchor))

    ctx.save()
    ctx.font = SELECTION_FONT
    ctx.textBaseline = 'middle'
    ctx.textAlign = 'left'
    // Both edges as hairlines, so the numbers have something exact to belong to.
    ctx.strokeStyle = CROSSHAIR_COLOR
    ctx.lineWidth = 1
    for (const x of [anchor, moving]) {
      ctx.beginPath()
      ctx.moveTo(snapTo(x, this.dpr), RULER_HEIGHT)
      ctx.lineTo(snapTo(x, this.dpr), height)
      ctx.stroke()
    }

    const chip = (text: string, x: number, side: 'left' | 'right', top: number): void => {
      const width = ctx.measureText(text).width + SELECTION_PAD * 2
      // Outside its own edge, and folded back inside at the window's own edges —
      // a coordinate written off the side of the canvas is a coordinate nobody
      // can read, and the edges are exactly where a selection is dragged to.
      let left = side === 'left' ? x - width - 3 : x + 3
      if (left < 0) left = x + 3
      if (left + width > this.canvasWidth) left = x - width - 3
      ctx.fillStyle = palette.labelHaloColor
      ctx.strokeStyle = CROSSHAIR_COLOR
      ctx.lineWidth = 1
      ctx.beginPath()
      if (ctx.roundRect === undefined) ctx.rect(left, top, width, SELECTION_CHIP)
      else ctx.roundRect(left, top, width, SELECTION_CHIP, 3)
      ctx.fill()
      ctx.stroke()
      ctx.fillStyle = CROSSHAIR_COLOR
      ctx.fillText(text, left + SELECTION_PAD, top + SELECTION_CHIP / 2)
    }

    const top = RULER_HEIGHT + 4
    const backwards = moving < anchor
    chip(start, anchor, backwards ? 'right' : 'left', top)
    chip(end, moving, backwards ? 'left' : 'right', top)
    // The span, in the middle of what has been drawn, where the eye already is.
    const middle = (anchor + moving) / 2
    const text = fmt.bp(span)
    const width = ctx.measureText(text).width + SELECTION_PAD * 2
    if (Math.abs(moving - anchor) > width + 8) {
      chip(text, middle - width / 2 - 3, 'right', top + SELECTION_CHIP + 3)
    }
    ctx.restore()
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
    clipLane(ctx, frame)
    if (lane.residues.length > 0) {
      for (const { entry: member, regions } of lane.residues) {
        drawSequence(ctx, frame, this.axis, regions, {
          font: BASE_FONT,
          opacity: member.style.opacity,
          letters: this.text,
        })
      }
      // The name alone. A second line saying how many bases are on screen is
      // what the ruler above it already says, and it would say it *through* the
      // letters — the one thing on this lane that is there to be read.
      if (this.text) {
        label = { entries: lane.residues.map((row) => row.entry), detail: null, at: 'near' }
      }
    } else if (lane.profiles.length > 0) {
      // While a ceiling is being dragged this lane is drawn twice: once as it
      // stood, faded and still, and once as the hand is asking for it.
      const dragged = this.scaling?.id === lane.entry.id ? this.scaling.factor : null
      for (const { entry: member, profile } of lane.profiles) {
        const extent = extentFor(member, profile.extent, groups)
        const limits = resolveLimits(member.style.limits, extent)
        const paint = {
          colour: member.style.colour,
          mode: member.style.mode,
          limits,
          guideColour: palette.labelColor,
          haloColour: palette.labelHaloColor,
          font: LANE_FONT,
          fills: this.fills,
          outline: this.outline,
          baseline: this.baseline,
          flip: member.style.flip,
          // Overlaid tracks are translucent by necessity: two opaque areas in
          // one lane means the second hides the first, which is the opposite of
          // what overlaying them was for.
          opacity:
            lane.profiles.length > 1
              ? member.style.opacity * OVERLAY_DIM
              : member.style.opacity,
        }
        if (dragged === null || member.kind !== 'track') drawTrack(ctx, frame, profile, paint)
        else drawTrackScaling(ctx, frame, profile, paint, scaledTo(limits, dragged))
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
          detail: { kind: 'limits', ...limits },
          at: labelEndFor(frame, limits, first.entry.style.flip),
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
      // Taller rows than beside a map, because each one carries a name under
      // its features. Below that height the band is refused and the names go
      // back inside, which is what a lane dragged very short should do.
      const rows = rowsThatFit(frame.thickness, entry.kind === 'gtf' ? 26 : 22)
      const layout = layoutFeatures(frame, this.axis, entry.payload.data, rows)
      this.layouts.set(entry.id, { frame, layout })
      const paint = {
        colour: entry.style.colour,
        guideColour: palette.labelColor,
        haloColour: palette.labelHaloColor,
        font: LANE_FONT,
        opacity: entry.style.opacity,
        labels: this.text,
        labelsBelow: true,
      }
      if (entry.kind === 'gtf') drawGenes(ctx, frame, entry.payload.data, layout, paint)
      else drawSegments(ctx, frame, entry.payload.data, layout, paint)
      if (this.text) {
        label = {
          entries: [entry],
          detail: layout.dense ? { kind: 'text', text: `${fmt.int(layout.total)} in view` } : null,
          at: 'near',
        }
      }
    }
    ctx.restore()
    if (label !== null) this.labelLane(ctx, lane, palette, label.entries, label.detail, label.at)
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
  ): void {
    const column = this.nameColumn > 0
    const boxes = drawLaneLabel(ctx, lane.frame, {
      names: entries.map((entry) => ({
        id: entry.id,
        text: entry.label,
        colour: entry.style.colour,
      })),
      detail,
      labelAt: at,
      // Where a right-aligned label block ends: clear of the data, and clear of
      // the handle hanging in front of it. Without the handle's room the name ran
      // straight into the dots, which is exactly what a label and a control must
      // not do — the eye reads them as one mark.
      column: column
        ? {
            start: GRIP_MARGIN,
            end: this.gutter - GUTTER_PAD - GRIP_ROOM,
            pad: GUTTER_PAD + GRIP_ROOM,
          }
        : null,
      style: BROWSER_LABEL_STYLE,
      palette: { text: palette.labelColor, halo: palette.labelHaloColor },
    })
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
    if (boxes.auto !== null && entries.some((entry) => entry.kind === 'track')) {
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
    const groups = this.groupRanges()
    for (const lane of this.lanes) {
      const row = lane.profiles.find((profile) => profile.entry.id === id)
      if (row === undefined) continue
      return resolveLimits(row.entry.style.limits, extentFor(row.entry, row.profile.extent, groups))
    }
    return null
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
        continue
      }
      if (member.kind !== 'track' && member.kind !== 'sequence') continue
      const samples = this.cache.samplesFor({
        entry: member.id,
        scope: 'browser',
        axis: this.axis,
        domain: lane.frame.domain,
        pixels: this.scale.pixels,
      })
      lane.profiles.push({ entry: member, profile: profileOf(lane.frame, this.axis, samples) })
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
      this.lanes.flatMap((lane) =>
        lane.profiles.map(({ entry, profile }) => ({
          group: entry.style.group,
          extent: profile.extent,
        })),
      ),
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
   */
  private optionToggle(key: PlotOptionKey, name: IconName): HTMLButtonElement {
    const { label, hint } = PLOT_OPTION_LABELS[key]
    const node = iconButton(
      name,
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
      cardTitle('Plot', 'palette', 'controls-title'),
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
            'stretch-vertical',
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
          el(
            'div',
            { class: 'plot-icon-row' },
            this.optionToggle('text', 'type'),
            this.optionToggle('fills', 'chart-area'),
            this.optionToggle('outline', 'chart-spline'),
            this.optionToggle('baseline', 'align-end-horizontal'),
            this.optionToggle('gutter', 'align-right'),
            this.optionToggle('crosshair', 'crosshair'),
          ),
        ),
        transparencyField(this.props.store),
        el(
          'div',
          { class: 'field field-block' },
          el('span', { class: 'field-label', text: 'export' }),
          el(
            'div',
            { class: 'export-row export-row-flex' },
            dpiSelect,
            formatSelect,
            iconButton('download', withKey('Save the figure, in the format chosen beside this', KEYS.savePlot), () => this.savePlot(), {
              class: 'btn btn-icon',
              size: 15,
            }),
          ),
        ),
        this.exportStatus,
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

  /** The figure as paths and text, at no resolution at all. */
  private async vectorFigure(
    width: number,
    height: number,
    caption: string,
    ink: string,
  ): Promise<Blob> {
    const page = new VectorPage(width, height + CAPTION_HEIGHT)
    const ctx = page.ctx
    // The page under the drawing. The raster path composites this underneath at
    // the end; here it has to be the first thing painted, since a PDF is drawn
    // in order and has no `destination-over`.
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(0, 0, width, height + CAPTION_HEIGHT)
    this.paint(ctx, width, height, false)
    ctx.font = '11px Helvetica, sans-serif'
    ctx.textAlign = 'left'
    ctx.textBaseline = 'alphabetic'
    ctx.fillStyle = ink
    ctx.globalAlpha = 1
    ctx.fillText(caption, 2, height + CAPTION_HEIGHT - 5)
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
    const fits = largestDpiThatFits(width, height + CAPTION_HEIGHT)
    if (fits !== null && fits < this.exportDpi) {
      this.exportStatus.textContent = `${fits} dpi is the largest that fits this figure.`
      return new Blob([])
    }
    const out = document.createElement('canvas')
    out.width = Math.max(1, Math.round(width * scale))
    out.height = Math.max(1, Math.round((height + CAPTION_HEIGHT) * scale))
    const ctx = out.getContext('2d')
    if (ctx === null) throw new Error('Could not open a canvas to draw the figure on.')
    ctx.setTransform(scale, 0, 0, scale, 0, 0)
    this.paint(ctx, width, height, false)

    ctx.setTransform(scale, 0, 0, scale, 0, 0)
    ctx.font = '11px system-ui, sans-serif'
    ctx.textAlign = 'left'
    ctx.textBaseline = 'alphabetic'
    ctx.fillStyle = ink
    ctx.fillText(caption, 2, height + CAPTION_HEIGHT - 5)
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
      // A press on the *ruler* is a range selection, with no modifier. The
      // coordinate strip is where a reader points to say "this much", and
      // asking them to hold a key to say it there — while a drag on the tracks
      // below it means pan, which is the other thing a hand wants — is a
      // keystroke spent on the one gesture that is unambiguous from its
      // position alone.
      if (y < RULER_HEIGHT) {
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
        // Drawn rather than shown as a cursor: the pointer is the arrowhead
        // everywhere on this canvas, so the affordance has to be in the picture.
        const grip = this.laneAt(y)
        this.gripping = grip?.onBorder === true ? grip.lane.entry.id : null
        // …with the exceptions the arrowhead cannot make. Over a limit the
        // pointer *is* the affordance, because "this text is a text box" is a
        // claim only a caret makes; over the ruler it says which of the two
        // things a press there will do — a name is a link to that sequence, and
        // the rest of the band is a range waiting to be dragged out.
        const onRuler = y < RULER_HEIGHT
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
        const onLabel = !onRuler && !onRange && !onGrip && this.nameAt(x, y) !== null
        canvas.classList.toggle('is-grab', onGrip)
        canvas.classList.toggle('is-text', onRange || onLabel)
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
        } else if (event.altKey) {
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
          this.drag = { mode: 'pan', x: drag.x0 }
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
        this.clickAt(x, y)
        return
      }
      if (drag.mode === 'scale') {
        this.commitScaling(drag.members)
        return
      }
      if (drag.mode === 'select') {
        const from = this.atUnit(Math.min(drag.x0, x))
        const to = this.atUnit(Math.max(drag.x0, x))
        if (to - from > 1 && Math.abs(x - drag.x0) > DRAG_SLACK) {
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
      this.gripping = null
      canvas.classList.remove('is-text', 'is-link', 'is-span', 'is-grab')
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
      openLaneMenu(event.clientX, event.clientY, hit.lane.entry, this.props.store)
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
      if (member.kind !== 'track') continue
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
    const row = lane.profiles.find((entry) => entry.entry.id === lane.entry.id) ?? lane.profiles[0]
    const target = row?.entry ?? lane.entry
    if (target.kind !== 'track') return
    const next = nudgedLimits(target.style.limits, row?.profile.extent ?? null, factor)
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
      if (y < RULER_HEIGHT) {
        // The *name*, not the band. A band is as wide as its sequence is on
        // screen, so at whole-genome zoom clicking anywhere in the top sixty
        // pixels would zoom somewhere — including the click that ended a drag
        // a few pixels short of being one. The name is what looks clickable and
        // is the only thing that is.
        const band = this.bandNameAt(x, y) ?? (this.bands.length === 1 ? this.bandAt(x) : null)
        if (band !== null) this.goTo(band.contig)
        return
      }
      const hit = this.featureAtPoint(x, y)
      if (hit === null) return
      const { set, index } = hit
      const contig = set.contigs[set.contig[index]]
      const start = set.start[index]
      const end = set.end[index]
      // The same margin a search hit gets, from the same function: finding a
      // gene by name and double-clicking that gene are two gestures for one
      // intention, and the picture must not shift between them.
      const span = paddedSpan(start, end)
      this.goTo(`${contig}:${Math.max(1, span.start + 1)}-${span.end}`)
    }, DOUBLE_CLICK_MS)
  }

  private featureAtPoint(x: number, y: number): { set: FeatureSet; index: number } | null {
    for (const lane of this.lanes) {
      const cached = this.layouts.get(lane.entry.id)
      const set = lane.entry.payload?.kind === 'features' ? lane.entry.payload.data : null
      if (cached === undefined || set === null) continue
      const hit = featureAt(cached.frame, cached.layout, x, y)
      if (hit !== null) return { set, index: hit.index }
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
    const locus = this.axis.unitToLocus(this.atUnit(x))
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
    const feature = this.featureAtPoint(x, y)
    if (feature !== null) {
      const { set, index } = feature
      const strand = set.strand[index] === 1 ? ' (+)' : set.strand[index] === -1 ? ' (−)' : ''
      const name = set.name[index] === '' ? '' : `${set.name[index]} `
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
    this.tooltip.replaceChildren(
      el('div', { class: 'cell-tip-block' }, el('div', { class: 'cell-tip-pos', text: where }), ...rows),
    )
    this.tooltip.classList.remove('hidden')
    const rect = this.stage.getBoundingClientRect()
    const left = clientX - rect.left
    const top = clientY - rect.top
    this.tooltip.style.left = `${Math.min(left + 14, rect.width - 240)}px`
    this.tooltip.style.top = `${top + 16}px`
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
        label: `${hit.name} · ${hit.contig}:${fmt.int(hit.start)} · ${hit.source}`,
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

/**
 * The sizes this view writes its small print at.
 *
 * Bigger than beside a map, in every field, and that is the difference between
 * the two surfaces rather than an accident: a lane here is ninety pixels and its
 * name is what identifies the row, while a lane beside a map can be sixteen and
 * its text has to fit in one. The block itself is drawn by
 * `render/laneLabel.ts`, which takes these rather than choosing them.
 */
const BROWSER_LABEL_STYLE: LaneLabelStyle = {
  nameFont: NAME_FONT,
  rangeFont: RANGE_FONT,
  swatch: 9,
  nameTop: NAME_TOP,
  nameLine: 13,
  detailDrop: 14,
  inset: 5,
  hitHeight: 15,
  autoSlot: 16,
  grip: LANE_GRIP,
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
  const tracks = lane.profiles
    .map((row) => row.entry)
    .filter((entry) => entry.kind === 'track')
  return tracks.length === 0 ? null : tracks
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
 */
const GRIP_MARGIN = GROUP_BAR + 2 + GRIP_ROOM

/**
 * How strongly a handle nobody is pointing at is drawn.
 *
 * Eight handles at full strength is a column of furniture down the side of the
 * picture. Faint enough to read as controls waiting to be used, solid enough to
 * be seen without hunting.
 */
const GRIP_IDLE = 0.45

/**
 * The width the name column starts at, before anything has been measured.
 *
 * Only ever seen on the first frame after the option is switched on, and chosen
 * to be about right for a track name so that frame does not visibly jump.
 */
const DEFAULT_GUTTER = 110

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
