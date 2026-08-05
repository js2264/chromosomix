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
import { clipLane, laneRect, laneText, snapTo, type LaneFrame } from '../render/lane'
import type { LocusAxis } from '../render/locus'
import { Scale } from '../render/scale'
import { basesAreDrawable, baseAt, drawSequence } from '../render/sequence'
import { drawTrack, formatLimit, profileOf, resolveLimits, type PixelProfile } from '../render/tracks'
import { button, el, fmt } from './dom'
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
import { isMac } from './commands'
import { iconButton, type IconName } from './icons'
import { CROSSHAIR_COLOR } from '../render/heatmap'
import { transparencyField } from './AnnotationCard'
import { openLaneMenu, readCanvasPalette } from './MatrixPanel'
import {
  PLOT_OPTION_LABELS,
  getPlotOptions,
  setPlotOption,
  subscribePlotOptions,
  type PlotOptionKey,
} from './plotOptions'
import { setReadout } from './readout'

/** How a group of tracks shares the picture. */
export type GroupMode = 'stacked' | 'overlay'

/**
 * How a group resolves its value axis.
 *
 * `shared` is what a group is *for* — one pair of limits over the union of what
 * its members show, which is the only way two tracks can be compared by eye —
 * and it is the default. `each` keeps the grouping (the members still move,
 * stack and overlay together) and gives every track its own axis back, for the
 * case where a group is a way of handling several tracks at once rather than a
 * claim that they are measured in the same units.
 */
export type GroupScaling = 'shared' | 'each'

/** Gap between two stacked lanes, in CSS pixels. Same as beside the map. */
const LANE_GAP = 4
/** How close to a lane's lower border counts as being on it. */
const LANE_GRIP = 4
/** How far a press must travel before it is a drag with a direction. */
const DRAG_SLACK = 3
/** The smallest a lane may be dragged to; below this it is a line, not a track. */
const LANE_MIN_SIZE = 14
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
/** A zoomed-to feature keeps this much of its own length as margin on each side. */
const FEATURE_PAD = 0.25
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
  /** The window to open at, from the view state. Absent means the whole genome. */
  locus?: string
  /** The view moved; the hash follows. `undefined` is the whole genome. */
  onLocusChange(locus: string | undefined): void
  /** Per-session memory for the things the URL does not carry. */
  memory: {
    groups: Record<string, GroupMode>
    /** Whether each group resolves one pair of limits; `'shared'` by default. */
    scaling: Record<string, GroupScaling>
    save(groups: Record<string, GroupMode>): void
    saveScaling(scaling: Record<string, GroupScaling>): void
  }
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
  private readonly locusInput: HTMLInputElement
  private readonly searchInput: HTMLInputElement
  private readonly searchList = el('div', { class: 'browser-hits hidden' })
  private readonly zoomNote = el('span', { class: 'browser-zoom' })
  private readonly groupsHost = el('div', { class: 'panel-controls' })
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
  /** Whether each lane gets a rule along its floor — the `baseline` option. */
  private baseline = true
  /** Whether a guide line follows the pointer — the shared `crosshair` option. */
  private crosshair = true
  /**
   * Where each lane's two limits were drawn, from the last frame.
   *
   * Recorded by {@link labelLane} rather than recomputed, because the box a
   * reader is pointing at is the box the text was measured into: any second
   * measurement is a second opinion about the same font, and the difference
   * between the two is exactly the pixel the click misses by.
   */
  private rangeHits: RangeHit[] = []
  /** Where each name's colour chip was drawn, so a picker can sit on it. */
  private swatchHits: SwatchHit[] = []
  /** Where each lane's autoscale button goes: just past its range. */
  private autoSpots: Array<{ entries: AnnotationEntry[]; x: number; y: number }> = []
  /**
   * The limit being typed into, while one is, and the two ways it can end.
   *
   * `cancel` for the cases where the number has nowhere to go — the view is
   * being torn down, or the lane it was measured into has moved — and `commit`
   * for the case where the reader simply moved the caret somewhere else.
   */
  private editor:
    | { input: HTMLInputElement; cancel: () => void; commit: () => void }
    | null = null
  private drag:
    | { mode: 'pan'; x: number }
    | { mode: 'select'; x0: number; x: number }
    | { mode: 'resize'; entry: AnnotationEntry; y0: number; size: number }
    | { mode: 'reorder'; entry: AnnotationEntry; over: number }
    | { mode: 'press'; x0: number; y0: number; lane: Lane | null; onBorder: boolean }
    | null = null
  /** What {@link paintOverlayControls} last built, so a pan does not rebuild it. */
  private controlSignature = ''
  /** Set while a navigation is ticking a sequence on its way — see {@link ensureOnAxis}. */
  private adopting = false
  /**
   * Groups the reader has unfolded, so a repaint does not shut them.
   *
   * A group is a row in a card, exactly as a track is one in the panel beside
   * it: a name, an eye, and everything else behind a chevron. Held here rather
   * than in the store for the reason a card's own `open` set is held in the
   * card — which of them is unfolded is a gesture in progress, not a property of
   * the group.
   */
  private readonly openGroups = new Set<string>()
  /**
   * Width of the column the track names are drawn in; 0 when they are not.
   *
   * The whole of what the `gutter` option does. Every frame starts at it, the
   * ruler starts at it, and every canvas x is turned back into a base pair
   * through it ({@link atUnit}) — one number, applied once, so the ruler and the
   * tracks under it cannot start in different places.
   */
  private gutter = 0
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
  /** Where the last name run ended, for a lane too short to stack under it. */
  private lastNameEnd = 0
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

    this.locusInput = el('input', {
      class: 'input input-region',
      type: 'text',
      placeholder: 'chrI:1,000-20,000, a sequence name, or * for the whole genome',
    })
    this.locusInput.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') this.goTo(this.locusInput.value)
    })

    this.searchInput = el('input', {
      class: 'input input-search',
      type: 'search',
      placeholder: 'find a gene or feature…',
    })
    this.searchInput.addEventListener('input', () => this.search())
    this.searchInput.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') this.closeSearch()
      if (event.key === 'Enter') {
        const first = this.searchList.querySelector<HTMLElement>('.browser-hit')
        first?.click()
      }
    })
    this.searchInput.addEventListener('blur', () => {
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
          this.locusInput,
          button('go', () => this.goTo(this.locusInput.value)),
          iconButton('zoom-out', 'Zoom out (key: −)', () => this.zoomBy(1 / 1.8)),
          iconButton('zoom-in', 'Zoom in (key: +)', () => this.zoomBy(1.8)),
          // The same two marks the Plot card uses, because they are the same two
          // actions and a reader should not have to learn them twice.
          iconButton('unfold-horizontal', 'The whole genome (key: 0, or a double click)', () => this.fit()),
          iconButton('unfold-vertical', 'Fit every track into the height there is', () => this.fitTracks()),
          el('div', { class: 'browser-search' }, this.searchInput, this.searchList),
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

    this.sideEl = el(
      'aside',
      { class: 'side' },
      el(
        'div',
        { class: 'controls-card' },
        el('h3', { class: 'controls-title', text: 'Groups' }),
        this.groupsHost,
      ),
      this.exportCard(),
    )

    this.cache = new SampleCache(props.client, () => this.schedule())
    this.bases = new BaseCache(props.client, () => this.schedule())
    this.unsubscribes.push(
      props.store.subscribe(() => {
        this.paintGroups()
        this.schedule()
      }),
    )
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
    this.paintGroups()
    requestAnimationFrame(() => this.remeasure())
  }

  destroy(): void {
    this.disposed = true
    this.closeRangeEditor()
    if (this.frameHandle !== 0) cancelAnimationFrame(this.frameHandle)
    if (this.clickTimer !== null) clearTimeout(this.clickTimer)
    if (this.reportTimer !== null) clearTimeout(this.reportTimer)
    for (const off of this.unsubscribes) off()
    this.observer?.disconnect()
    this.cache.destroy()
    this.bases.destroy()
    setReadout('')
  }

  /** Put the caret in the locus box — the `l` key, and the palette. */
  focusLocus(): void {
    this.locusInput.focus()
    this.locusInput.select()
  }

  /** Put the caret in the feature search — the `/` key, and the palette. */
  focusSearch(): void {
    this.searchInput.focus()
    this.searchInput.select()
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
    this.closeRangeEditor()
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
   * One button doing both halves of what a reader means by "tidy this up": every
   * lane the same height, and that height the one that fills the window. It used
   * to keep whatever proportions the stack was already in, on the reasoning that
   * a reader who made the gene model three times taller meant it — but a stack
   * that has been dragged about for ten minutes has no proportions worth
   * preserving, and preserving them meant the button could not answer the
   * question actually being asked, which is "make these the same".
   *
   * Bounded below by the lane minimum, so twenty tracks in a short window come
   * out scrollable rather than as twenty two-pixel lines.
   */
  fitTracks(): void {
    const lanes = this.lanes
    if (lanes.length === 0) return
    // Measured against the *host*, from the top of the stage down to the bottom
    // of the column this view was mounted in. Not against `this.el`, which is
    // sized by its own content: asking that how much room there is compares the
    // tracks against themselves and fits them to the height they already have,
    // which is a button that appears to do nothing.
    const host = this.roomHost()
    if (host === null) return
    const padding = Number.parseFloat(window.getComputedStyle(host).paddingBottom)
    const room =
      host.getBoundingClientRect().bottom -
      (Number.isFinite(padding) ? padding : 0) -
      this.stage.getBoundingClientRect().top -
      RULER_HEIGHT -
      LANE_GAP * (lanes.length + 1)
    if (!(room > 0)) return
    const size = Math.max(LANE_MIN_SIZE, Math.floor(room / lanes.length))
    for (const lane of lanes) {
      for (const member of [lane.entry, ...lane.overlaid]) {
        this.props.store.restyle(member.id, { size })
      }
    }
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
    const drawn: Lane[] = []
    const claimed = new Map<string, Lane>()
    let across = RULER_HEIGHT + LANE_GAP
    for (const entry of entries) {
      const group = entry.style.group
      const overlaid = group !== '' && this.modeOf(group) === 'overlay'
      const host = overlaid ? claimed.get(group) : undefined
      if (host !== undefined) {
        host.overlaid.push(entry)
        continue
      }
      const thickness = Math.max(LANE_MIN_SIZE, Math.round(entry.style.size))
      const lane: Lane = {
        entry,
        overlaid: [],
        frame: this.frameAt(across, thickness),
        profiles: [],
        residues: [],
      }
      drawn.push(lane)
      if (overlaid) claimed.set(group, lane)
      across += thickness + LANE_GAP
    }
    return drawn
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

  private modeOf(group: string): GroupMode {
    return this.props.memory.groups[group] ?? 'stacked'
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
    this.gutter =
      options.gutter && options.text
        ? Math.min(Math.round(this.wantGutter), Math.floor(width / 3))
        : 0
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
    this.paintLaneControls()
    this.zoomNote.textContent = this.zoomPhrase()
  }

  /** Everything on the canvas, at whatever scale the context is set to. */
  private paint(ctx: CanvasRenderingContext2D, width: number, height: number): void {
    // Read once for the whole frame: every lane asks the same question, and the
    // export asks it too so that what is saved is what was on screen.
    const options = getPlotOptions()
    this.text = options.text
    this.fills = options.fills
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
    this.swatchHits = []
    this.autoSpots = []
    this.measuredGutter = 0
    const groups = this.groupRanges()
    for (const lane of this.lanes) this.paintLane(ctx, lane, groups, palette)
    // What the labels just drawn would have needed. Used by the *next* frame,
    // which is the only order available: the width depends on the text and the
    // text is measured by drawing it.
    this.wantGutter = Math.max(40, this.measuredGutter)
    this.paintGroupBars(ctx)

    // Under the shared preference, like everything else drawn over the data: a
    // reader who turned the crosshair off beside a map meant it off.
    if (this.hover !== null && this.crosshair) {
      drawGuide(ctx, this.hover.x, 0, height, CROSSHAIR_COLOR, this.dpr)
    }
    // The resize grip, where the pointer is on a lane's lower border. The
    // cursor is the drawn arrowhead everywhere here — it is what points at a
    // base pair — so an affordance that lives in the cursor would not exist.
    const grip = this.lanes.find((lane) => lane.entry.id === this.gripping)
    if (grip !== undefined) {
      ctx.save()
      ctx.strokeStyle = CROSSHAIR_COLOR
      ctx.lineWidth = 2
      ctx.beginPath()
      const edge = grip.frame.acrossFrom + grip.frame.thickness + 1
      ctx.moveTo(0, edge)
      ctx.lineTo(width, edge)
      ctx.stroke()
      ctx.restore()
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

  /**
   * A bar down the left edge marking each autoscale group.
   *
   * A group is a claim that these tracks are comparable — one pair of limits
   * over the union of what they show — and until now the only way to see which
   * tracks were in one was to open each row's settings in turn and read the
   * menu. It is a property of a *set* of lanes, so it is drawn as a set of
   * lanes: one bar spanning them, in the colour of the first, with the name
   * beside it where there is room. Stacked members that are not adjacent get a
   * bar each, because a bar drawn across a lane that is not in the group would
   * be saying something false.
   */
  private paintGroupBars(ctx: CanvasRenderingContext2D): void {
    const runs: Array<{ group: string; colour: string; from: number; to: number }> = []
    for (const lane of this.lanes) {
      const target = lane.profiles[0]?.entry ?? lane.entry
      const group = target.style.group
      const top = lane.frame.acrossFrom
      const bottom = top + lane.frame.thickness
      if (group === '') continue
      const open = runs[runs.length - 1]
      if (open !== undefined && open.group === group && Math.abs(open.to - top) <= LANE_GAP + 1) {
        open.to = bottom
        continue
      }
      runs.push({ group, colour: target.style.colour, from: top, to: bottom })
    }
    if (runs.length === 0) return

    ctx.save()
    for (const run of runs) {
      ctx.fillStyle = run.colour
      ctx.globalAlpha = 0.85
      ctx.beginPath()
      ctx.roundRect?.(0, run.from, GROUP_BAR, run.to - run.from, GROUP_BAR / 2)
      if (ctx.roundRect === undefined) ctx.rect(0, run.from, GROUP_BAR, run.to - run.from)
      ctx.fill()
      // The name, turned a quarter turn to run with the bar — the only
      // orientation that fits a word beside a three-pixel rule.
      const room = run.to - run.from
      if (!this.text || room < 34) continue
      ctx.save()
      ctx.globalAlpha = 0.9
      ctx.font = GROUP_FONT
      ctx.fillStyle = run.colour
      ctx.textAlign = 'center'
      ctx.textBaseline = 'top'
      ctx.translate(GROUP_BAR + 2, (run.from + run.to) / 2)
      ctx.rotate(-Math.PI / 2)
      const text = ctx.measureText(run.group).width > room - 6 ? '' : run.group
      ctx.fillText(text, 0, 0)
      ctx.restore()
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
    let label: { entries: AnnotationEntry[]; detail: string | { limits: { min: number; max: number } } } | null = null
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
      if (this.text) label = { entries: lane.residues.map((row) => row.entry), detail: '' }
    } else if (lane.profiles.length > 0) {
      for (const { entry: member, profile } of lane.profiles) {
        const extent =
          member.style.group === ''
            ? profile.extent
            : (groups.get(member.style.group) ?? profile.extent)
        const limits = resolveLimits(member.style.limits, extent)
        drawTrack(ctx, frame, profile, {
          colour: member.style.colour,
          mode: member.style.mode,
          limits,
          guideColour: palette.labelColor,
          haloColour: palette.labelHaloColor,
          font: LANE_FONT,
          fills: this.fills,
          baseline: this.baseline,
          flip: member.style.flip,
          // Overlaid tracks are translucent by necessity: two opaque areas in
          // one lane means the second hides the first, which is the opposite of
          // what overlaying them was for.
          opacity: lane.profiles.length > 1 ? member.style.opacity * 0.65 : member.style.opacity,
        })
      }
      const first = lane.profiles[0]
      const extent =
        first.entry.style.group === ''
          ? first.profile.extent
          : (groups.get(first.entry.style.group) ?? first.profile.extent)
      const limits = resolveLimits(first.entry.style.limits, extent)
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
          detail: { limits },
        }
      }
    } else if (entry.payload?.kind === 'pairs') {
      const drawn = drawArcs(ctx, frame, this.axis, entry.payload.data, {
        colour: entry.style.colour,
        opacity: entry.style.opacity,
      })
      if (this.text) label = { entries: [entry], detail: `${fmt.int(drawn)} in view` }
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
        label = { entries: [entry], detail: layout.dense ? `${fmt.int(layout.total)} in view` : '' }
      }
    }
    ctx.restore()
    if (label !== null) this.labelLane(ctx, frame, palette, label.entries, label.detail)
  }

  /**
   * The lane's name — or names, overlaid — and what its value axis spans.
   *
   * The range goes **under** the name rather than across the lane at its far
   * right. Two reasons, and the second is the one that matters. A number at the
   * opposite end of a lane from the name it belongs to has to be paired up by
   * eye every time, and with four tracks stacked that is four crossings of the
   * window. And a number that is *under its name* is a number you can put a
   * caret in: the range is the one thing on a lane a reader edits, and it should
   * be edited where it is read (see {@link openRangeEditor}).
   *
   * On a lane too short for a second line the range goes back beside the name,
   * because a clipped lane should lose the *layout* rather than the fact.
   */
  private labelLane(
    ctx: CanvasRenderingContext2D,
    frame: LaneFrame,
    palette: ReturnType<typeof readCanvasPalette>,
    entries: AnnotationEntry[],
    detail: string | { limits: { min: number; max: number } },
  ): void {
    ctx.save()
    ctx.font = NAME_FONT
    ctx.textBaseline = 'middle'
    ctx.textAlign = 'left'
    // A flipped track hangs from the ceiling, so its name and its range move to
    // the floor: at the top they would sit inside the ink they are labelling,
    // which is the one place a caption must not be.
    const inverted = entries.some((entry) => entry.style.flip)
    const column = this.gutter > 0
    // In the column, one name per line — because the column is as wide as the
    // widest of them, and two names side by side would make it as wide as both.
    // Only where the lane has the height for it; a short overlay lane keeps the
    // single row it has always had, and the column simply widens to fit.
    const rows = column && frame.thickness >= NAME_TOP + entries.length * NAME_LINE + 6
      ? entries.length
      : 1
    const block = (rows - 1) * NAME_LINE
    // Under the names when the lane has room for a second line, beside them when
    // it has not: a clipped lane should lose the *layout* rather than the fact.
    const stacked = frame.thickness >= NAME_TOP + block + DETAIL_DROP + 6
    const label = block + (stacked ? DETAIL_DROP : 0)
    // In the column, centred on the lane — because there the label is beside its
    // track rather than on top of it, and a caption in a column of them belongs
    // level with the middle of the thing it names. Over the data it stays at the
    // top, which is the one part of a coverage track that is usually empty; a
    // name centred there would sit across the peaks it is labelling.
    const nameTop = column
      ? Math.max(6, Math.round((frame.thickness - label) / 2))
      : inverted
        ? Math.max(6, frame.thickness - NAME_TOP - DETAIL_DROP - block)
        : NAME_TOP

    // One measured run per row, so both the right edge and the column's width
    // come from the same numbers.
    const widthOf = (entry: AnnotationEntry): number =>
      SWATCH + 5 + ctx.measureText(entry.label).width
    const runs: AnnotationEntry[][] =
      rows === 1 ? [entries] : entries.map((entry) => [entry])
    const runWidth = (run: AnnotationEntry[]): number =>
      run.reduce((total, entry) => total + widthOf(entry), 0) + (run.length - 1) * 12

    for (const [row, run] of runs.entries()) {
      const across = nameTop + row * NAME_LINE
      const total = runWidth(run)
      this.wanted(total + GUTTER_PAD)
      let at = column ? Math.max(2, this.gutter - GUTTER_PAD - total) : frame.alongFrom + 5
      for (const entry of run) {
        // The colour, immediately before the name it belongs to. Drawn on the
        // canvas rather than laid over it, so it is a legend rather than a
        // control: it survives into the exported figure, where a reader who
        // never saw the screen needs to know which line is which. What makes it
        // *clickable* is a transparent colour input positioned over it — see
        // {@link paintLaneControls} — which is the one part of it that is chrome.
        const low = across - SWATCH / 2
        const [sx, sy, sw, sh] = laneRect(frame, at, at + SWATCH, low, low + SWATCH)
        ctx.save()
        ctx.strokeStyle = palette.labelHaloColor
        ctx.lineWidth = 2
        ctx.strokeRect(sx, sy, sw, sh)
        ctx.fillStyle = entry.style.colour
        ctx.fillRect(sx, sy, sw, sh)
        ctx.restore()
        this.swatchHits.push({ entry, x: sx, y: sy, size: SWATCH })
        at += SWATCH + 5
        // Each name in its own track's colour, which is the whole legend an
        // overlaid lane needs: the line is that colour and so is its name.
        ctx.fillStyle = entries.length > 1 ? entry.style.colour : palette.labelColor
        laneText(ctx, frame, entry.label, at, across, { halo: palette.labelHaloColor })
        at += ctx.measureText(entry.label).width + 12
      }
      if (row === runs.length - 1) this.lastNameEnd = at - 12
    }

    ctx.font = RANGE_FONT
    ctx.fillStyle = palette.labelColor
    ctx.textAlign = 'left'
    const across = stacked ? nameTop + block + DETAIL_DROP : nameTop + block
    const along = stacked ? (column ? 2 : frame.alongFrom + 5) : this.lastNameEnd

    if (typeof detail === 'string') {
      if (detail !== '') {
        const width = ctx.measureText(detail).width
        const at = column && stacked ? Math.max(2, this.gutter - GUTTER_PAD - width) : along
        if (column && stacked) this.wanted(width + GUTTER_PAD)
        laneText(ctx, frame, detail, at, across, { halo: palette.labelHaloColor })
      }
      ctx.restore()
      return
    }

    // Each end written separately, so each end has a box of its own to point at.
    const min = formatLimit(detail.limits.min)
    const max = formatLimit(detail.limits.max)
    const top = frame.acrossFrom + across - HIT_HEIGHT / 2
    // The range goes wherever its names went, so the two stay one label — and in
    // the column it is right-aligned like them, with the lane's autoscale button
    // kept inside the column rather than pushed onto the data.
    const range = ctx.measureText(`${min} – ${max}`).width
    const from = column && stacked
      ? Math.max(2, this.gutter - GUTTER_PAD - AUTO_SLOT - range)
      : along
    if (column && stacked) this.wanted(range + AUTO_SLOT + GUTTER_PAD)
    // …but only where the box is clear of the lane's own lower border, which is
    // the resize grip. On a short lane the two overlap, and an overlap is worse
    // than either alone: the canvas draws the resize hairline, promising a drag,
    // and the press opens a text box instead. A lane too short to hold both
    // keeps the gesture and gives up the caret — the range is still drawn, and
    // it is still editable the moment the lane is dragged taller.
    const clear = top + HIT_HEIGHT <= frame.acrossFrom + frame.thickness - LANE_GRIP
    let x = from
    for (const part of ['min', 'max'] as const) {
      const value = part === 'min' ? min : max
      const width = ctx.measureText(value).width
      laneText(ctx, frame, value, x, across, { halo: palette.labelHaloColor })
      if (clear) {
        this.rangeHits.push({ entries, part, value, x, y: top, width, height: HIT_HEIGHT })
      }
      x += width
      if (part === 'min') {
        const dash = ' – '
        laneText(ctx, frame, dash, x, across, { halo: palette.labelHaloColor })
        x += ctx.measureText(dash).width
      }
    }
    // Where the lane's own autoscale button goes: immediately after the number
    // it hands back to the data. Recorded here for the same reason the limits
    // are — the button is placed against text this pass measured, and a second
    // measurement is a second opinion about the same font.
    if (clear) this.autoSpots.push({ entries, x: x + 5, y: top + HIT_HEIGHT / 2 })
    ctx.restore()
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

  /** The min or max box under a track's name at this point, if any. */
  private rangeAt(x: number, y: number): RangeHit | null {
    for (const hit of this.rangeHits) {
      if (x >= hit.x - 2 && x <= hit.x + hit.width + 2 && y >= hit.y && y <= hit.y + hit.height) {
        return hit
      }
    }
    return null
  }

  /**
   * Put a caret in a limit, exactly where the limit is drawn.
   *
   * An `<input>` laid over the canvas at the box the text was measured into, so
   * the number does not move when it becomes editable — which is the whole
   * claim being made by drawing a text cursor over it. Committing sets the pair
   * explicitly and turns autoscale off, because typing a bound *is* the decision
   * that this track's axis is not the data's any more.
   */
  private openRangeEditor(hit: RangeHit): void {
    // The one that is open is *finished*, not abandoned. `onDown` runs on
    // `pointerdown` and calls `preventDefault`, so the press that lands on a
    // second limit never produces the focus change that would have committed the
    // first — and cancelling here would make the natural gesture for setting the
    // same bound on two tracks in a row the one gesture that silently throws the
    // first number away. Clicking anywhere *else* on the canvas already commits
    // it; these two have to agree.
    this.editor?.commit()
    this.closeRangeEditor()
    const named = hit.entries.map((entry) => entry.label).join(', ')
    const input = el('input', {
      class: 'input browser-edit',
      type: 'text',
      value: hit.value,
      title:
        `${hit.part === 'min' ? 'Bottom' : 'Top'} of ${named}’s value axis. ` +
        'Enter commits, Escape leaves it alone.',
    })
    input.style.left = `${Math.max(0, hit.x - 3)}px`
    input.style.top = `${hit.y - 2}px`
    input.style.width = `${Math.max(44, hit.width + 22)}px`

    let closed = false
    const close = (): void => {
      if (closed) return
      closed = true
      input.remove()
      if (this.editor?.input === input) this.editor = null
      this.schedule()
    }
    /** Say no without closing, so the reader can correct what they typed. */
    const refuse = (): void => {
      input.classList.add('is-bad')
      window.setTimeout(() => input.classList.remove('is-bad'), 700)
      input.focus()
      input.select()
    }
    const commit = (typing: boolean): void => {
      // Escape closes by removing the node, and removing a focused node is a
      // blur — so without this guard the blur handler would commit the value
      // the reader had just cancelled, which is the opposite of what Escape is.
      if (closed) return
      const text = input.value.trim()
      // Opening a limit and not changing it is not a decision, and must not be
      // recorded as one. Without this, clicking a limit on an autoscaled track
      // and clicking away again takes it off autoscale for ever — at the
      // *rounded* number the label showed, which is not even the ceiling it had.
      // An emptied box is the same thing said differently: `input.select()` puts
      // the whole number under the first keystroke, so Backspace is how an edit
      // begun by accident is abandoned — and `Number('')` is `0`, which would
      // otherwise store a floor nobody typed.
      if (text === hit.value || text === '') {
        close()
        return
      }
      const typed = Number(text)
      const first = this.props.store.byId(hit.entries[0]?.id ?? '')?.style.limits
      if (!Number.isFinite(typed) || first === undefined) {
        if (typing) refuse()
        else close()
        return
      }
      // Resolved rather than stored: an autoscaled track has no *stored* pair to
      // amend, so the other end has to come from the axis on screen — which is
      // the one the reader was looking at when they typed. (The side panel's own
      // boxes seed from the file's whole-genome extent instead, because a panel
      // is not a view and must not show a number that changes when you pan.)
      const shown = this.shownLimits(hit.entries[0]?.id ?? '') ?? {
        min: first.min,
        max: first.max,
      }
      const next =
        hit.part === 'min' ? { min: typed, max: shown.max } : { min: shown.min, max: typed }
      // An inverted pair is refused rather than swallowed. `resolveLimits` would
      // answer it with `{0, 1}`, which is a lane redrawn against an axis nobody
      // asked for — and the reader would be left looking for the number they
      // typed. Refused *in place*, with the caret still in it.
      if (!(next.max > next.min)) {
        if (typing) refuse()
        else close()
        return
      }
      close()
      // Every track in the lane, not just the one whose numbers were written
      // down: a lane draws one range under however many names it holds.
      for (const entry of hit.entries) {
        this.props.store.restyle(entry.id, { limits: { auto: false, ...next } })
      }
    }
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault()
        commit(true)
      } else if (event.key === 'Escape') {
        event.preventDefault()
        close()
      }
    })
    // A blur is not a keystroke: whatever it carries is either good or gone.
    // Refusing in place would fight for a focus the reader has already moved on
    // from — and the box is closed by then anyway.
    input.addEventListener('blur', () => commit(false))
    this.stage.appendChild(input)
    this.editor = { input, cancel: close, commit: () => commit(false) }
    input.focus()
    input.select()
    this.schedule()
  }

  /**
   * Take the caret away without taking the value.
   *
   * Through the editor's own `close`, not by detaching the node: removing a
   * focused input *is* a blur, so a raw `remove()` would hand the blur handler a
   * live editor and commit a value on the way out — from `destroy()`, that is a
   * store write by a view that no longer exists.
   */
  private closeRangeEditor(): void {
    this.editor?.cancel()
    this.editor = null
  }

  /** The pair a track's axis is drawn with right now, group included. */
  private shownLimits(id: string): { min: number; max: number } | null {
    const groups = this.groupRanges()
    for (const lane of this.lanes) {
      const row = lane.profiles.find((profile) => profile.entry.id === id)
      if (row === undefined) continue
      const extent =
        row.entry.style.group === ''
          ? row.profile.extent
          : (groups.get(row.entry.style.group) ?? row.profile.extent)
      return resolveLimits(row.entry.style.limits, extent)
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
    const groups = new Map<string, { min: number; max: number }>()
    for (const lane of this.lanes) {
      for (const { entry, profile } of lane.profiles) {
        const group = entry.style.group
        // A group set to scale each of its members separately contributes
        // nothing here, and that is the whole of what the setting does: with no
        // entry in this map every lookup falls back to the track's own extent,
        // which is what an ungrouped track uses.
        if (group === '' || profile.extent === null || this.scalingOf(group) === 'each') continue
        const seen = groups.get(group)
        groups.set(
          group,
          seen === undefined
            ? { ...profile.extent }
            : {
                min: Math.min(seen.min, profile.extent.min),
                max: Math.max(seen.max, profile.extent.max),
              },
        )
      }
    }
    return groups
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
   * The two controls that live *on* a lane: its colour, and its autoscale.
   *
   * What used to be here was a row of six — a swatch, two limit boxes, `auto`, a
   * ceiling slider and a group menu — revealed by pointing at a lane. It was a
   * settings panel that appeared under the hand while a reader was trying to
   * read a track, it covered the busiest part of a coverage profile, and every
   * one of its controls exists in the annotations card as well. What is left is
   * the two things that are *about the picture at this moment*: which colour
   * this line is, and give me back the data's own axis.
   *
   * Both are placed against marks the canvas has already drawn — the colour chip
   * before the name, the button just past the range — so the geometry is decided
   * once, by the paint, and these are click targets rather than a second layout.
   */
  private paintLaneControls(): void {
    // Rebuilt only when the *set* of marks changes; a pan moves them, and moving
    // an element is not replacing it. Replacing one under a pointer mid-drag
    // would cancel the drag, and this runs on every frame of one.
    const signature = [
      ...this.swatchHits.map((hit) => `s${hit.entry.id}`),
      ...this.autoSpots.map((spot) => `a${spot.entries.map((entry) => entry.id).join('+')}`),
    ].join('|')
    if (signature !== this.controlSignature) {
      // The same signature an open limit editor is anchored to: a track added,
      // removed or regrouped moves the lane the caret was measured into, and a
      // box hanging over the wrong lane would commit its number to the right
      // one. A pan is not in the signature, which is why the caret survives one.
      if (this.controlSignature !== '') this.closeRangeEditor()
      this.controlSignature = signature
      this.overlays.replaceChildren(
        ...this.swatchHits.map((hit) => this.swatchControl(hit.entry)),
        ...this.autoSpots.map((spot) => this.autoControl(spot.entries)),
      )
    }

    const nodes = this.overlays.children
    const swatches = this.swatchHits.length
    for (let i = 0; i < this.swatchHits.length; i++) {
      const hit = this.swatchHits[i]
      const node = nodes[i]
      if (!(node instanceof HTMLElement)) continue
      node.style.left = `${hit.x}px`
      node.style.top = `${hit.y}px`
      node.style.width = `${hit.size}px`
      node.style.height = `${hit.size}px`
      if (node instanceof HTMLInputElement && node !== document.activeElement) {
        node.value = hit.entry.style.colour
      }
    }
    for (let i = 0; i < this.autoSpots.length; i++) {
      const spot = this.autoSpots[i]
      const node = nodes[swatches + i]
      if (!(node instanceof HTMLElement)) continue
      // Centred on the line the range is written on, not hung from its top: the
      // button is a mark beside two numbers and has to sit on the same baseline
      // as them, which is what "aligned with the range" means.
      node.style.left = `${spot.x}px`
      node.style.top = `${spot.y - AUTO_ICON / 2}px`
      // Lit when the axis on screen is the data's own, which is what the button
      // would otherwise give no way of knowing without pressing it.
      const auto = spot.entries.every(
        (entry) => this.props.store.byId(entry.id)?.style.limits.auto === true,
      )
      node.classList.toggle('is-on', auto)
      node.setAttribute('aria-pressed', String(auto))
    }
  }

  /**
   * A colour picker, transparent, over the chip the canvas drew.
   *
   * Invisible and clickable, which is normally the bug rather than the design —
   * but here the thing being pointed at *is* drawn, a centimetre under the
   * pointer, and this is only the hit target for it. An `<input type=color>`
   * rather than a button that opens one, because `showPicker` is not offered
   * everywhere and the input is the platform's own control.
   */
  private swatchControl(entry: AnnotationEntry): HTMLElement {
    const input = el('input', {
      class: 'browser-swatch',
      type: 'color',
      value: entry.style.colour,
      title: `Colour for ${entry.label}`,
    })
    input.addEventListener('input', () =>
      this.props.store.restyle(entry.id, { colour: input.value }),
    )
    return input
  }

  /**
   * Hand this lane's value axis back to the data.
   *
   * The same mark as the Plot card's "autoscale everything", because it is the
   * same action at a different scope, and a reader who has learnt one should not
   * have to learn the other. It applies to every track in the lane: a lane draws
   * one range under however many names it holds, so handing back half of it
   * would leave two lines at two scales under one label.
   */
  private autoControl(entries: AnnotationEntry[]): HTMLElement {
    const named = entries.map((entry) => entry.label).join(', ')
    return iconButton(
      'chevrons-up-down',
      `Scale ${named} to what is in view, and follow it as the view moves. ` +
        `Typing a limit turns it off; ${CEILING_LABEL} over the lane moves the ceiling.`,
      () => {
        for (const entry of entries) {
          const current = this.props.store.byId(entry.id)?.style.limits ?? entry.style.limits
          this.props.store.restyle(entry.id, { limits: { ...current, auto: true } })
        }
      },
      { class: 'btn btn-icon browser-auto', size: AUTO_ICON },
    )
  }

  /**
   * The Groups card: what is in each group, and the two decisions about it.
   *
   * A group is a claim that these tracks are comparable, and until now the card
   * showed only a count of them — so the claim could be made, and then not
   * checked, from the one place in the application that exists to show it. Each
   * group now lists its members by name and colour, and each name carries the ×
   * that takes it back out.
   *
   * The two decisions are buttons rather than menus because each has exactly two
   * states, and a two-item dropdown is a click, a read and a second click for
   * something a button says outright. Both are labelled with **what pressing
   * does**, not with what is currently true: the current state is visible in the
   * picture, and a control that names its own state leaves a reader guessing
   * whether they are reading a label or an action.
   */
  private paintGroups(): void {
    const groups = this.props.store.scaleGroups()
    if (groups.size === 0) {
      this.groupsHost.replaceChildren(
        el('p', {
          class: 'hint',
          text:
            'Put two tracks in one group — from the settings on each row, or by ticking several ' +
            'and choosing one below them — and they resolve to one pair of limits, which is the ' +
            'only way two tracks can be compared by eye. A group can then be stacked or drawn in ' +
            'a single lane.',
        }),
      )
      return
    }
    const rows: HTMLElement[] = []
    for (const [name, members] of groups) {
      const overlaid = this.modeOf(name) === 'overlay'
      const shared = this.scalingOf(name) === 'shared'
      const open = this.openGroups.has(name)
      // A group is shown when any of its members is: hiding one member by hand
      // and then pressing the group's eye should hide the rest, not reveal the
      // one that was put away.
      const shown = members.some((member) => member.visible)

      const eye = iconButton(
        shown ? 'eye' : 'eye-off',
        shown ? `Hide every track in ${name}` : `Show ${name} again`,
        () => {
          for (const member of members) this.props.store.update(member.id, { visible: !shown })
        },
        { class: `btn btn-icon ann-eye${shown ? '' : ' is-off'}`, size: 14 },
      )
      eye.setAttribute('aria-pressed', String(shown))

      const fold = iconButton(
        open ? 'chevron-down' : 'chevron-right',
        open ? `Fold ${name}` : `What is in ${name}, and how it is drawn`,
        () => {
          if (open) this.openGroups.delete(name)
          else this.openGroups.add(name)
          this.paintGroups()
        },
        { class: 'btn btn-icon ann-fold', size: 14 },
      )
      fold.setAttribute('aria-expanded', String(open))

      const head = el(
        'div',
        { class: 'group-head' },
        el('span', { class: 'group-title', text: name, title: name }),
        el('span', { class: 'hint group-count', text: `${members.length}` }),
        eye,
        fold,
      )

      const body = el(
        'div',
        { class: 'group-body' },
        el(
          'div',
          { class: 'plot-icon-row' },
          // Each of the three is a state the group is *in*, so each is one mark
          // that changes to the other — `layers` for one lane, rows for several;
          // a link for one shared axis, a broken one for each track's own. A word
          // would say the same thing in a column sixteen characters wide that has
          // four other things to fit in it.
          iconButton(
            overlaid ? 'rows-3' : 'layers',
            overlaid
              ? 'Stacked: give each of these a lane of its own again'
              : 'Overlay: draw all of these into one lane, against one axis',
            () => this.setMode(name, overlaid ? 'stacked' : 'overlay'),
            { class: 'btn btn-icon', size: 14 },
          ),
          iconButton(
            shared ? 'unlink' : 'link',
            shared
              ? 'Scale each: let every track here find its own limits, as an ungrouped one does'
              : 'Scale together: one pair of limits over all of them, which is what makes them comparable',
            () => this.setScaling(name, shared ? 'each' : 'shared'),
            { class: 'btn btn-icon', size: 14 },
          ),
          iconButton(
            'stretch-vertical',
            'Give every track in this group the height of its tallest member',
            () => {
              const tallest = Math.max(...members.map((member) => member.style.size))
              for (const member of members) this.props.store.restyle(member.id, { size: tallest })
            },
            { class: 'btn btn-icon', size: 14 },
          ),
        ),
        el(
          'div',
          { class: 'group-members' },
          // One member per row, name left and × right, so the crosses line up as
          // a column: pills wrapping mid-name put every × at a different offset,
          // and a list of things you can remove wants one place to aim at.
          ...members.map((member) =>
            el(
              'div',
              { class: 'group-member', title: member.label },
              el('span', {
                class: 'group-member-chip',
                style: { background: member.style.colour },
              }),
              el('span', { class: 'group-member-name', text: member.label }),
              // The same × the annotations card puts on a row, at the same size:
              // this one takes a track out of a group rather than out of the
              // session, and the two should not be two different marks.
              iconButton('x', `Take ${member.label} out of ${name}`, () =>
                this.props.store.restyle(member.id, { group: '' }),
              { class: 'btn-close group-member-out', size: 14 }),
            ),
          ),
        ),
      )

      rows.push(
        el(
          'div',
          { class: `group-card${shown ? '' : ' is-hidden'}` },
          head,
          ...(open ? [body] : []),
        ),
      )
    }
    this.groupsHost.replaceChildren(...rows)
  }

  private setMode(group: string, mode: GroupMode): void {
    const next = { ...this.props.memory.groups, [group]: mode }
    this.props.memory.groups = next
    this.props.memory.save(next)
    this.paintGroups()
    this.schedule()
  }

  /**
   * Whether this group resolves one pair of limits or lets its members find
   * their own.
   *
   * Redundant with nothing: grouping is *two* claims bundled together — these
   * belong side by side, and these share an axis — and they are not always made
   * at the same time. Two strands of one experiment want the shared axis; four
   * tracks a reader has grouped to move and scale as a unit may each want their
   * own, because one of them is coverage and the rest are ratios.
   */
  private setScaling(group: string, scaling: GroupScaling): void {
    const next = { ...this.props.memory.scaling, [group]: scaling }
    this.props.memory.scaling = next
    this.props.memory.saveScaling(next)
    this.paintGroups()
    this.schedule()
  }

  private scalingOf(group: string): GroupScaling {
    return this.props.memory.scaling[group] ?? 'shared'
  }

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
    const node = iconButton(name, `${label} — ${hint}`, () =>
      setPlotOption(key, !getPlotOptions()[key]),
    { class: 'btn btn-icon btn-toggle', size: 15 })
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
      el('h3', { class: 'controls-title', text: 'Plot' }),
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
          iconButton('unfold-horizontal', 'Fit the whole genome across (key: 0, or a double click on the tracks)', () => this.fit(), {
            class: 'btn btn-icon',
            size: 15,
          }),
          iconButton('unfold-vertical', 'Fit every track into the height there is, in the proportions they are in now', () => this.fitTracks(), {
            class: 'btn btn-icon',
            size: 15,
          }),
          iconButton('chevrons-up-down', 'Autoscale every track to what is in view — a group resolves as a group', () => this.autoscaleAll(), {
            class: 'btn btn-icon',
            size: 15,
          }),
        ),
        el(
          'div',
          { class: 'field field-block' },
          el('span', { class: 'field-label', text: 'overlays' }),
          el(
            'div',
            { class: 'plot-icon-row' },
            this.optionToggle('text', 'type'),
            this.optionToggle('fills', 'chart-area'),
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
            iconButton('download', 'Save the figure, in the format chosen beside this', () => void this.save(), {
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
    this.paint(ctx, width, height)
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
    this.paint(ctx, width, height)

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
        this.openRangeEditor(limit)
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
      // The direction of the first movement decides between the three things a
      // press on a lane can mean — the same rule the lanes beside the map use,
      // and the reason no gesture had to be given up for another.
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
        canvas.classList.toggle('is-text', !onRuler && this.rangeAt(x, y) !== null)
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
        } else if (Math.abs(dy) > Math.abs(dx) && drag.lane !== null) {
          this.drag = {
            mode: 'reorder',
            entry: drag.lane.entry,
            over: this.lanes.indexOf(drag.lane),
          }
        } else if (event.altKey) {
          this.drag = { mode: 'select', x0: drag.x0, x }
        } else {
          this.drag = { mode: 'pan', x: drag.x0 }
        }
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
      canvas.classList.remove('is-text', 'is-link', 'is-span')
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
        this.nudgeCeiling(hit.lane, event.deltaY < 0 ? 1 / 1.25 : 1.25)
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
  private nudgeCeiling(lane: Lane, factor: number): void {
    const row = lane.profiles.find((entry) => entry.entry.id === lane.entry.id) ?? lane.profiles[0]
    const target = row?.entry ?? lane.entry
    if (target.kind !== 'track') return
    const limits = resolveLimits(target.style.limits, row?.profile.extent ?? null)
    const max = limits.max * factor
    if (!Number.isFinite(max) || max <= limits.min) return
    this.props.store.restyle(target.id, { limits: { auto: false, min: limits.min, max } })
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
      const pad = Math.max(50, Math.round((end - start) * FEATURE_PAD))
      this.goTo(`${contig}:${Math.max(1, start + 1 - pad)}-${end + pad}`)
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
   * Find a feature by name across every loaded feature set.
   *
   * A linear scan over the `name` arrays, capped at the first handful of hits.
   * An index would be the right answer for a million-feature set and is the
   * wrong answer here: the arrays are already in memory, the scan stops at ten
   * matches, and building an index on load would cost every reader who never
   * types in this box.
   */
  private search(): void {
    const query = this.searchInput.value.trim().toLowerCase()
    if (query.length < 2) {
      this.closeSearch()
      return
    }
    const hits: Array<{ label: string; locus: string }> = []
    // A sequence name is a search hit too: typing `chrIV` should go there
    // whether or not a gene happens to be called that.
    const contig = findContig(this.props.assembly, query)
    if (contig !== null) hits.push({ label: `${contig.name} · whole sequence`, locus: contig.name })

    // One feature set, the starred one. Searching every loaded annotation at
    // once answers "GAL4" with the same gene four times over, differing only in
    // which file it came from — and the four are usually the same coordinates.
    // Which one is searched is a press on the star beside its name.
    const source = this.props.store.searchSource()
    if (source !== null && source.payload?.kind === 'features') {
      const set = source.payload.data
      for (let i = 0; i < set.length && hits.length < 10; i++) {
        const name = set.name[i]
        if (name === '' || !name.toLowerCase().startsWith(query)) continue
        const pad = Math.max(50, Math.round((set.end[i] - set.start[i]) * FEATURE_PAD))
        hits.push({
          label: `${name} · ${set.contigs[set.contig[i]]}:${fmt.int(set.start[i])} · ${source.label}`,
          locus: `${set.contigs[set.contig[i]]}:${Math.max(1, set.start[i] + 1 - pad)}-${set.end[i] + pad}`,
        })
      }
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
          this.searchInput.value = ''
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

/** How far under the name the value range sits, when the lane is tall enough. */
const DETAIL_DROP = 14

/** Line height for a column of names, one per overlaid track. */
const NAME_LINE = 13

/** The coordinates written at the edges of a selection being dragged. */
const SELECTION_FONT = '600 11px system-ui, sans-serif'
const SELECTION_CHIP = 16
const SELECTION_PAD = 5

/** How wide the group bar in the left gutter is, in CSS pixels. */
const GROUP_BAR = 3
const GROUP_FONT = '600 9px system-ui, sans-serif'

/** How tall a limit's click target is: the text, plus a little either side. */
const HIT_HEIGHT = 15

/** The colour chip before a track's name, in CSS pixels. */
const SWATCH = 9

/**
 * The width the name column starts at, before anything has been measured.
 *
 * Only ever seen on the first frame after the option is switched on, and chosen
 * to be about right for a track name so that frame does not visibly jump.
 */
const DEFAULT_GUTTER = 110

/** Clear space between the end of a name and the start of the data. */
const GUTTER_PAD = 8

/** Room kept at the right of the column for a lane's autoscale button. */
const AUTO_SLOT = 16

/** The autoscale mark beside a lane's range: the glyph, and nothing else. */
const AUTO_ICON = 13

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

/** A track's colour chip, and the square it was drawn in. */
interface SwatchHit {
  entry: AnnotationEntry
  /** Canvas pixels, in the browser's own coordinates. */
  x: number
  y: number
  size: number
}

/** One end of a lane's value axis, and the box it was drawn in. */
interface RangeHit {
  /**
   * Every track the range belongs to — which for an overlay group is all of
   * them, not the one whose limits happened to be written down.
   *
   * A lane draws one range under however many names it holds, and that single
   * pair is a claim about the *lane*: the whole point of overlaying two tracks
   * is that they are drawn against one axis. Committing to only the first would
   * leave two lines at two scales in one lane with one label, which is the exact
   * picture the group exists to prevent.
   */
  entries: AnnotationEntry[]
  part: 'min' | 'max'
  value: string
  /** Canvas pixels, in the browser's own coordinates. */
  x: number
  y: number
  width: number
  height: number
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

/** Which modifier means "move this track's ceiling" — see the wheel handler. */
const CEILING_MODIFIER = (event: WheelEvent): boolean =>
  isMac() ? event.metaKey && !event.ctrlKey : event.altKey

/** What to call it in a tooltip, on this platform. */
const CEILING_LABEL = isMac() ? '⌘-scroll' : 'Alt-scroll'
