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

import { SampleCache } from '../annotations/samples'
import type { AnnotationStore } from '../annotations/store'
import type { AnnotationClient } from '../annotations/worker/client'
import type { AnnotationEntry, FeatureSet } from '../annotations/types'
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
import { RULER_HEIGHT, drawArcs, drawBoundaries, drawGuide, drawRuler, type RulerBand } from '../render/browser'
import { featureAt, drawGenes, drawSegments, layoutFeatures, rowsThatFit } from '../render/features'
import { clipLane, laneText, type LaneFrame } from '../render/lane'
import type { LocusAxis } from '../render/locus'
import { Scale } from '../render/scale'
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
 * The track name, which is the one word on a lane a reader looks for.
 *
 * Bigger than everything else drawn on the lane and heavier, because in a
 * browser the name is what identifies the row — the value range beside it is a
 * fact about the axis and belongs in the small print, not at the same weight.
 */
const NAME_FONT = '600 12px system-ui, sans-serif'
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
  /** The window to open at, from the view state. Absent means the whole genome. */
  locus?: string
  /** The view moved; the hash follows. `undefined` is the whole genome. */
  onLocusChange(locus: string | undefined): void
  /** Per-session memory for the things the URL does not carry. */
  memory: {
    groups: Record<string, GroupMode>
    save(groups: Record<string, GroupMode>): void
  }
}

/** One lane, resolved for a frame: where it goes and what goes in it. */
interface Lane {
  entry: AnnotationEntry
  /** Tracks drawn *into* this lane, when its group is in overlay mode. */
  overlaid: AnnotationEntry[]
  frame: LaneFrame
  profiles: Array<{ entry: AnnotationEntry; profile: PixelProfile }>
}

export class BrowserView {
  readonly el: HTMLElement
  /** The controls column, mounted by the session in the Aesthetics panel. */
  readonly sideEl: HTMLElement

  private readonly axis: LocusAxis
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
    this.axis = assemblyAxis(props.assembly)
    this.scale = new Scale([0, Math.max(1, props.assembly.total)], 1)

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
          el('h2', { class: 'region-title', text: props.assembly.name }),
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
    this.unsubscribes.push(
      props.store.subscribe(() => {
        this.paintGroups()
        this.schedule()
      }),
    )
    this.unsubscribes.push(subscribePlotOptions(() => this.schedule()))
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
    this.scale.setPixels(width)
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
    const units = rangeToUnits(this.props.assembly, parsed)
    if (units === null) return
    this.scale.setDomain(units)
    this.afterMove(false)
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
    const units = rangeToUnits(this.props.assembly, parsed)
    if (units === null) return
    this.scale.setDomain(units)
    this.afterMove(true)
  }

  private fit(): void {
    this.scale.reset()
    this.afterMove(true)
  }

  /**
   * Share the available height between the tracks.
   *
   * In the proportions they are already in, rather than equally: a reader who
   * gave the gene model three times the height of a coverage track meant it, and
   * "fit" is a request about the *stack* running off the bottom of the window,
   * not about the relative sizes inside it. Equal heights is the other thing,
   * and the Groups card offers it per group.
   *
   * Bounded below by the lane minimum, so twenty tracks in a short window come
   * out scrollable rather than as twenty two-pixel lines.
   */
  private fitTracks(): void {
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
    const current = lanes.reduce((sum, lane) => sum + lane.frame.thickness, 0)
    if (!(room > 0) || !(current > 0)) return
    const factor = room / current
    for (const lane of lanes) {
      const size = Math.max(LANE_MIN_SIZE, Math.round(lane.frame.thickness * factor))
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
  private autoscaleAll(): void {
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
    this.scale.zoomAt(atPixel ?? this.scale.pixels / 2, factor)
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
    return unitsToRange(this.props.assembly, this.scale.domain as [number, number])
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
      }
      drawn.push(lane)
      if (overlaid) claimed.set(group, lane)
      across += thickness + LANE_GAP
    }
    return drawn
  }

  private frameAt(acrossFrom: number, thickness: number): LaneFrame {
    return {
      orientation: 'bottom',
      toPixel: (unit) => this.scale.toPixel(unit),
      toUnit: (pixel) => this.scale.toUnit(pixel),
      domain: this.scale.domain,
      alongFrom: 0,
      alongTo: this.scale.pixels,
      acrossFrom,
      thickness,
    }
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
    this.cache.prune(new Set(this.props.store.entries.map((entry) => entry.id)))
    this.dpr = window.devicePixelRatio > 0 ? window.devicePixelRatio : 1
    const width = Math.max(1, this.stage.clientWidth)
    this.scale.setPixels(width)
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
    this.paintOverlayControls()
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
    const ruler = {
      x: 0,
      y: 0,
      width,
      toPixel: (unit: number) => this.scale.toPixel(unit),
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
    const groups = this.groupRanges()
    for (const lane of this.lanes) this.paintLane(ctx, lane, groups, palette)

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
    }
  }

  private paintLane(
    ctx: CanvasRenderingContext2D,
    lane: Lane,
    groups: Map<string, { min: number; max: number }>,
    palette: ReturnType<typeof readCanvasPalette>,
  ): void {
    const { entry, frame } = lane
    clipLane(ctx, frame)
    if (lane.profiles.length > 0) {
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
        this.labelLane(
          ctx,
          frame,
          palette,
          lane.profiles.map((row) => row.entry),
          { limits },
        )
      }
    } else if (entry.payload?.kind === 'pairs') {
      const drawn = drawArcs(ctx, frame, this.axis, entry.payload.data, {
        colour: entry.style.colour,
        opacity: entry.style.opacity,
      })
      if (this.text) this.labelLane(ctx, frame, palette, [entry], `${fmt.int(drawn)} in view`)
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
        this.labelLane(
          ctx,
          frame,
          palette,
          [entry],
          layout.dense ? `${fmt.int(layout.total)} in view` : '',
        )
      }
    }
    ctx.restore()
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
    const nameTop = inverted ? Math.max(6, frame.thickness - NAME_TOP - DETAIL_DROP) : NAME_TOP
    let at = frame.alongFrom + 5
    for (const entry of entries) {
      // Each name in its own track's colour, which is the whole legend an
      // overlaid lane needs: the line is that colour and so is its name.
      ctx.fillStyle = entries.length > 1 ? entry.style.colour : palette.labelColor
      laneText(ctx, frame, entry.label, at, nameTop, { halo: palette.labelHaloColor })
      at += ctx.measureText(entry.label).width + 12
    }

    ctx.font = LANE_FONT
    ctx.fillStyle = palette.labelColor
    ctx.textAlign = 'left'
    const stacked = frame.thickness >= NAME_TOP + DETAIL_DROP + 6
    const across = stacked ? nameTop + DETAIL_DROP : nameTop
    const along = stacked ? frame.alongFrom + 5 : at

    if (typeof detail === 'string') {
      if (detail !== '') {
        laneText(ctx, frame, detail, along, across, { halo: palette.labelHaloColor })
      }
      ctx.restore()
      return
    }

    // Each end written separately, so each end has a box of its own to point at.
    const min = formatLimit(detail.limits.min)
    const max = formatLimit(detail.limits.max)
    const top = frame.acrossFrom + across - HIT_HEIGHT / 2
    // …but only where the box is clear of the lane's own lower border, which is
    // the resize grip. On a short lane the two overlap, and an overlap is worse
    // than either alone: the canvas draws the resize hairline, promising a drag,
    // and the press opens a text box instead. A lane too short to hold both
    // keeps the gesture and gives up the caret — the range is still drawn, and
    // it is still editable the moment the lane is dragged taller.
    const clear = top + HIT_HEIGHT <= frame.acrossFrom + frame.thickness - LANE_GRIP
    let x = along
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
    ctx.restore()
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
      if (member.kind !== 'track') continue
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
        if (group === '' || profile.extent === null) continue
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
    const where =
      range === null || span >= this.scale.full[1] - this.scale.full[0]
        ? `${fmt.int(this.props.assembly.contigs.length)} sequences · ${fmt.bp(span)}`
        : `${range.contig} · ${fmt.bp(span)}`
    return `${where} · ${fmt.bp(perPixel)} per pixel`
  }

  // -------------------------------------------------------------------------
  // The inline editors
  // -------------------------------------------------------------------------

  /**
   * One row of controls per lane, laid over the canvas at the lane's own height.
   *
   * HTML rather than more canvas, and deliberately: these are *inputs*. A range
   * you can type into and a group you can pick from a list are what the side
   * panel already offers, brought to where the track is so that adjusting six
   * tracks is six gestures rather than six trips to a card and back.
   */
  private paintOverlayControls(): void {
    // Rebuilt only when something they *describe* has changed — never on a pan
    // frame. These are inputs: replacing the element under a caret loses the
    // half-typed number in it, and a pan redraws sixty times a second.
    // Deliberately *not* including the limits, which the ceiling slider moves
    // continuously: a commit would fail the guard and rebuild the row, removing
    // the control the event came from mid-drag.
    const signature = this.lanes
      .map((lane) => {
        const target = lane.profiles[0]?.entry ?? lane.entry
        return [
          target.id,
          target.kind,
          lane.frame.acrossFrom,
          lane.frame.thickness,
          target.style.group,
        ].join('/')
      })
      // The `text` option is in it because it decides whether the row carries
      // the limit boxes: with the words off there is no drawn number to click,
      // and the boxes are the only way left to type one.
      .concat(this.text ? 'text' : 'no-text')
      .join('|')
    if (signature !== this.controlSignature) {
      // The same signature the rows are rebuilt on is the one an open limit
      // editor is anchored to: a track added, removed, resized or regrouped
      // moves the lane the caret was measured into, and a box hanging over the
      // wrong lane would commit its number to the right one. A pan is not in the
      // signature and does not move it, which is why the caret survives one.
      if (this.controlSignature !== '') this.closeRangeEditor()
      this.controlSignature = signature
      this.overlays.replaceChildren(
        ...this.lanes.map((lane) => {
          const row = el('div', { class: 'browser-lane-controls' })
          // Under the name, not beside the data. The name is drawn at the top
          // left of the lane, so this is where a reader is already looking when
          // they want to change something about *that* track — and it keeps the
          // busiest part of a coverage profile, which grows from the baseline,
          // clear of a row of inputs.
          // Clear of the range, which now sits directly under the name and is
          // typed into where it is drawn: a row of controls over it would be a
          // row of controls over a text box. Clamped to stay *inside* the lane,
          // because the row is only revealed while the pointer is in the lane it
          // belongs to — a row that hangs below its own lane is a row you have
          // to point somewhere else to see and cannot then reach.
          const inset = Math.min(NAME_TOP + DETAIL_DROP + 8, lane.frame.thickness - CONTROL_ROW)
          row.style.top = `${lane.frame.acrossFrom + Math.max(2, inset)}px`
          const target = lane.profiles[0]?.entry ?? lane.entry
          row.appendChild(this.colourControl(target))
          if (target.kind === 'track') {
            // The boxes come back only when the words are off, because then the
            // range is not drawn and there is nothing on the lane to click.
            if (!this.text) row.appendChild(this.rangeControl(target))
            row.append(this.autoControl(target), this.ceilingSlider(target), this.groupControl(target))
          }
          return row
        }),
      )
    }
    // Revealed by pointing at the lane they belong to, so the picture is clean
    // until a hand is on its way to one of them — and stay revealed while one
    // has the focus, or tabbing into a range box would hide it.
    const rows = this.overlays.children
    const groups = this.groupRanges()
    for (let i = 0; i < rows.length; i++) {
      const lane = this.lanes[i]
      const row = rows[i]
      const over =
        this.hover !== null &&
        lane !== undefined &&
        this.hover.y >= lane.frame.acrossFrom &&
        this.hover.y <= lane.frame.acrossFrom + lane.frame.thickness
      row.classList.toggle('is-active', over || row.contains(document.activeElement))
      if (lane === undefined) continue
      // What the slider and the `auto` button say, from what the lane is
      // actually drawn with — so an autoscaled track's handle follows the view.
      // Never into a control that has the grab: the reader is mid-drag, and half
      // a drag is not a value to overwrite them with.
      const first = lane.profiles[0]
      const target = first?.entry ?? lane.entry
      if (target.kind !== 'track') continue
      const extent =
        target.style.group === ''
          ? (first?.profile.extent ?? null)
          : (groups.get(target.style.group) ?? first?.profile.extent ?? null)
      const limits = resolveLimits(target.style.limits, extent)
      const slider = row.querySelector<HTMLInputElement>('.browser-slider')
      if (slider !== null && slider !== document.activeElement) {
        const auto = resolveLimits({ auto: true, min: 0, max: 1 }, extent).max
        slider.value = String(auto > 0 ? Math.round(clampPercent((limits.max / auto) * 100)) : 100)
      }
      // …and the two limit boxes, where the `text` option put them. They are
      // built once and the row is not rebuilt when the limits move, so without
      // this they show whatever the axis was the last time the stack changed
      // shape — a number that contradicts the track drawn right beside it.
      for (const part of ['min', 'max'] as const) {
        const box = row.querySelector<HTMLInputElement>(`[data-limit="${part}"]`)
        if (box === null || box === document.activeElement) continue
        box.value = formatLimit(part === 'min' ? limits.min : limits.max)
      }
      row.querySelector('.btn-tiny')?.classList.toggle('is-on', target.style.limits.auto)
    }
  }

  /**
   * The track's colour, one click away.
   *
   * The browser's own swatch is the colour input itself rather than a button
   * that opens one: `showPicker` is not offered everywhere, and an `<input
   * type=color>` styled down to a swatch *is* the control — clicking it opens
   * the platform picker, which is the same picker the side panel's card uses.
   */
  private colourControl(entry: AnnotationEntry): HTMLElement {
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
   * The ceiling, as a slider.
   *
   * Against the track's *own* data rather than an absolute scale: 100 is what
   * autoscaling would choose for what is in view, and the handle runs from a
   * tenth of that to three times it. An absolute slider would need a maximum
   * nobody can name — a coverage track and a log ratio share no units — and
   * would move by a different amount on every track it was dragged on.
   */
  private ceilingSlider(entry: AnnotationEntry): HTMLElement {
    const input = el('input', { class: 'browser-slider', type: 'range' })
    input.min = '10'
    input.max = '300'
    input.step = '1'
    const auto = this.autoCeiling(entry)
    const limits = entry.style.limits
    input.value = String(
      limits.auto || !(auto > 0) ? 100 : Math.round(clampPercent((limits.max / auto) * 100)),
    )
    input.title = 'Ceiling of this track’s value axis, as a percentage of what autoscale would pick'
    input.addEventListener('input', () => {
      const reference = this.autoCeiling(entry)
      if (!(reference > 0)) return
      const min = this.props.store.byId(entry.id)?.style.limits.min ?? 0
      this.props.store.restyle(entry.id, {
        limits: { auto: false, min, max: (reference * Number(input.value)) / 100 },
      })
    })
    return input
  }

  /** What autoscaling would choose for this track right now, or 0. */
  private autoCeiling(entry: AnnotationEntry): number {
    for (const lane of this.lanes) {
      const row = lane.profiles.find((profile) => profile.entry.id === entry.id)
      if (row === undefined) continue
      return resolveLimits({ auto: true, min: 0, max: 1 }, row.profile.extent).max
    }
    return 0
  }

  /**
   * The two limits as boxes, for the one case where they cannot be typed on the
   * lane: the `text` option is off, so there is no drawn number to click.
   *
   * Not offered otherwise. The range is edited where it is read — that is the
   * whole point of §5.8's arrangement — and a second pair of boxes on hover
   * would be three hundred pixels of every track that a drag cannot pan.
   */
  private rangeControl(entry: AnnotationEntry): HTMLElement {
    const shown = this.shownLimits(entry.id) ?? { min: entry.style.limits.min, max: entry.style.limits.max }
    const box = (part: 'min' | 'max'): HTMLInputElement =>
      el('input', {
        class: 'input input-tiny',
        type: 'text',
        value: formatLimit(part === 'min' ? shown.min : shown.max),
        title: `${part === 'min' ? 'Bottom' : 'Top'} of ${entry.label}’s value axis`,
        attrs: { 'data-limit': part },
      })
    const min = box('min')
    const max = box('max')
    /**
     * One box commits **one** bound.
     *
     * The other comes from the axis on screen at commit time, exactly as the
     * drawn range does — never from the sibling box. These two are built once
     * and deliberately not rebuilt when the limits move (the ceiling slider
     * drags continuously, and a rebuild mid-drag would remove the control the
     * event came from), so the sibling's text is only ever as fresh as the last
     * time the row happened to be built. Reading it back would republish a
     * number nobody typed: zoom in, type a floor, and the ceiling would silently
     * revert to whatever it was two views ago.
     */
    const commitOne = (node: HTMLInputElement, part: 'min' | 'max'): void => {
      const typed = Number(node.value.trim())
      const current = this.props.store.byId(entry.id)?.style.limits
      if (current === undefined) return
      const live = this.shownLimits(entry.id) ?? { min: current.min, max: current.max }
      if (node.value.trim() === '' || !Number.isFinite(typed)) {
        node.value = formatLimit(part === 'min' ? live.min : live.max)
        return
      }
      const next = part === 'min' ? { min: typed, max: live.max } : { min: live.min, max: typed }
      if (!(next.max > next.min)) {
        node.classList.add('is-bad')
        window.setTimeout(() => node.classList.remove('is-bad'), 700)
        return
      }
      this.props.store.restyle(entry.id, { limits: { auto: false, ...next } })
    }
    for (const [node, part] of [[min, 'min'], [max, 'max']] as const) {
      node.addEventListener('change', () => commitOne(node, part))
      node.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') commitOne(node, part)
      })
    }
    return el('div', { class: 'browser-range' }, min, el('span', { text: '–' }), max)
  }

  /**
   * Hand the value axis back to the data.
   *
   * All that is normally left of the range control here: the two numbers moved
   * onto the lane itself, where they are read (see {@link labelLane}), and
   * typing one is what turns this off. So the button's only job is turning it
   * back on — and saying, by being lit, that the axis on screen is the data's
   * rather than somebody's.
   */
  private autoControl(entry: AnnotationEntry): HTMLElement {
    // Read from the store at click time, not from the entry this row was built
    // with: the row outlives changes to the limits, so a captured `auto` would
    // go stale the first time anything else moved them.
    return button('auto', () => {
      const current = this.props.store.byId(entry.id)?.style.limits ?? entry.style.limits
      this.props.store.restyle(entry.id, { limits: { ...current, auto: !current.auto } })
    }, {
      class: `btn btn-tiny${entry.style.limits.auto ? ' is-on' : ''}`,
      title:
        'Scale to whatever is in view, and follow it as the view moves. ' +
        `Typing a limit under the track name turns it off; ${CEILING_LABEL} over the lane moves ` +
        'the ceiling.',
    })
  }

  /**
   * The track's autoscale group, as a menu of the groups that exist.
   *
   * Sharing a group is what makes two tracks comparable — one pair of limits
   * over the union of what they show — and in a browser that is a thing you
   * decide while looking at them, not before.
   */
  private groupControl(entry: AnnotationEntry): HTMLElement {
    const select = el('select', {
      class: 'select select-tiny',
      title: 'Autoscale group: tracks sharing one resolve to one pair of limits',
    })
    const names = new Set<string>(['', ...this.props.store.scaleGroups().keys()])
    if (entry.style.group !== '') names.add(entry.style.group)
    for (const name of names) {
      select.appendChild(el('option', { value: name, text: name === '' ? 'no group' : name }))
    }
    select.appendChild(el('option', { value: ' new', text: 'new group…' }))
    select.value = entry.style.group
    select.addEventListener('change', () => {
      if (select.value === ' new') {
        const name = window.prompt('Name for the new autoscale group')?.trim()
        select.value = entry.style.group
        if (name === undefined || name === '') return
        this.props.store.restyle(entry.id, { group: name })
        return
      }
      this.props.store.restyle(entry.id, { group: select.value })
    })
    return select
  }

  /** The Groups card: how each group shares the picture, and its members. */
  private paintGroups(): void {
    const groups = this.props.store.scaleGroups()
    if (groups.size === 0) {
      this.groupsHost.replaceChildren(
        el('p', {
          class: 'hint',
          text:
            'Put two tracks in one group — from the menu on each lane — and they resolve to one ' +
            'pair of limits, which is the only way two tracks can be compared by eye. A group ' +
            'can then be stacked or drawn in a single lane.',
        }),
      )
      return
    }
    const rows: HTMLElement[] = []
    for (const [name, members] of groups) {
      const mode = el('select', { class: 'select' })
      for (const option of ['stacked', 'overlay'] as GroupMode[]) {
        mode.appendChild(el('option', { value: option, text: option }))
      }
      mode.value = this.modeOf(name)
      mode.addEventListener('change', () => {
        const next = { ...this.props.memory.groups, [name]: mode.value as GroupMode }
        this.props.memory.groups = next
        this.props.memory.save(next)
        this.schedule()
      })
      rows.push(
        el(
          'div',
          { class: 'field field-block' },
          el(
            'span',
            { class: 'field-label' },
            el('span', { text: name }),
            el('span', { class: 'hint', text: ` ${members.length} tracks` }),
          ),
          el(
            'div',
            { class: 'group-row' },
            mode,
            button('equal heights', () => {
              const tallest = Math.max(...members.map((member) => member.style.size))
              for (const member of members) this.props.store.restyle(member.id, { size: tallest })
            }, {
              class: 'btn btn-quiet',
              title: 'Give every track in this group the height of its tallest member',
            }),
          ),
        ),
      )
    }
    this.groupsHost.replaceChildren(...rows)
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
            this.optionToggle('crosshair', 'crosshair'),
          ),
        ),
        el(
          'div',
          { class: 'field field-block' },
          el('span', { class: 'field-label', text: 'export' }),
          el(
            'div',
            { class: 'export-row export-row-flex' },
            dpiSelect,
            formatSelect,
            button('Save', () => void this.save(), { class: 'btn' }),
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
    const width = this.scale.pixels
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
      if (over.entry.card !== drag.entry.card || over.entry.id === drag.entry.id) return
      const list = this.props.store.forCard(drag.entry.card)
      const to = list.findIndex((row) => row.id === over.entry.id)
      if (to < 0) return
      // The whole lane moves, which for a group drawn in overlay mode is every
      // member of it: they share one slot on screen and splitting them would
      // put half a group somewhere else.
      const members = [drag.entry, ...(this.laneOf(drag.entry)?.overlaid ?? [])]
      members.forEach((member, offset) => this.props.store.move(member.id, to + offset))
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
        const from = this.scale.toUnit(Math.min(drag.x0, x))
        const to = this.scale.toUnit(Math.max(drag.x0, x))
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
      this.scale.zoomAt(x, Math.exp(-event.deltaY * 0.002))
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
  private describe(x: number, y: number, clientX: number, clientY: number): void {
    const locus = this.axis.unitToLocus(this.scale.toUnit(x))
    if (locus === null) {
      this.tooltip.classList.add('hidden')
      setReadout('')
      return
    }
    const where = `${locus.contig}:${fmt.bp(locus.bp)}`
    const rows: HTMLElement[] = []
    const parts: string[] = []
    for (const lane of this.lanes) {
      for (const { entry, profile } of lane.profiles) {
        const slot = Math.round(x) - profile.from
        const value = slot >= 0 && slot < profile.mean.length ? profile.mean[slot] : Number.NaN
        const text = Number.isNaN(value) ? '—' : fmt.num(value)
        rows.push(
          el(
            'div',
            { class: 'cell-tip-row' },
            el('span', { class: 'cell-tip-chip', style: { background: entry.style.colour } }),
            el('span', { class: 'cell-tip-key', text: `${entry.label}:` }),
            el('span', { class: 'cell-tip-val', text }),
          ),
        )
        parts.push(`${entry.label} ${text}`)
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

    for (const entry of this.props.store.entries) {
      if (entry.payload?.kind !== 'features') continue
      const set = entry.payload.data
      for (let i = 0; i < set.length && hits.length < 10; i++) {
        const name = set.name[i]
        if (name === '' || !name.toLowerCase().startsWith(query)) continue
        const pad = Math.max(50, Math.round((set.end[i] - set.start[i]) * FEATURE_PAD))
        hits.push({
          label: `${name} · ${set.contigs[set.contig[i]]}:${fmt.int(set.start[i])} · ${entry.label}`,
          locus: `${set.contigs[set.contig[i]]}:${Math.max(1, set.start[i] + 1 - pad)}-${set.end[i] + pad}`,
        })
      }
      if (hits.length >= 10) break
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

/** Keep a slider's percentage inside the range its track can be drawn at. */
function clampPercent(value: number): number {
  return Number.isFinite(value) ? Math.max(10, Math.min(300, value)) : 100
}

/** Where the track name sits inside its lane, from the lane's top edge. */
const NAME_TOP = 9

/** How far under the name the value range sits, when the lane is tall enough. */
const DETAIL_DROP = 12

/** How tall a limit's click target is: the text, plus a little either side. */
const HIT_HEIGHT = 13

/**
 * How tall a lane's hover-control row is, for keeping it inside its lane.
 *
 * Measured rather than derived: the swatch, the `auto` button, the slider and
 * the group menu are four controls of three different heights, and the row is as
 * tall as the tallest — which the stylesheet pins, precisely so this number can
 * be relied on. A lane shorter than the row plus the two lines of label above it
 * cannot hold both; the clamp then keeps the row inside the lane and lets it
 * cover the range, because a row that hangs into the *next* lane disappears the
 * moment a hand moves toward it.
 */
const CONTROL_ROW = 20

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
