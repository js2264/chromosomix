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
  EXPORT_FORMATS,
  canvasToPdf,
  canvasToPng,
  captionStamp,
  downloadBlob,
  exportBaseName,
  fileStamp,
  largestDpiThatFits,
  scaleForDpi,
  type ExportFormat,
} from './export'
import { isMac } from './commands'
import { iconButton } from './icons'
import { CROSSHAIR_COLOR } from '../render/heatmap'
import { openLaneMenu, readCanvasPalette } from './MatrixPanel'
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
  /** Something that is not a track was dropped on the view. */
  onDropFile(file: File): void
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
  private exportFormat: ExportFormat = 'pdf'
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
          iconButton('maximize', 'The whole genome (key: 0, or a double click)', () => this.fit()),
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
    this.watchPointer()
    this.watchKeys()
    this.watchDrop()

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
        band: palette.bandColor,
        halo: palette.labelHaloColor,
      },
      dpr: this.dpr,
    }
    this.bands = drawRuler(ctx, ruler)
    drawBoundaries(ctx, ruler, RULER_HEIGHT, height)

    this.layouts.clear()
    const groups = this.groupRanges()
    for (const lane of this.lanes) this.paintLane(ctx, lane, groups, palette)

    if (this.hover !== null) {
      drawGuide(ctx, this.hover.x, 0, height, CROSSHAIR_COLOR, this.dpr)
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
      this.labelLane(
        ctx,
        frame,
        palette,
        lane.profiles.map((row) => row.entry),
        `${formatLimit(limits.min)} – ${formatLimit(limits.max)}`,
      )
    } else if (entry.payload?.kind === 'pairs') {
      const drawn = drawArcs(ctx, frame, this.axis, entry.payload.data, {
        colour: entry.style.colour,
        opacity: entry.style.opacity,
      })
      this.labelLane(ctx, frame, palette, [entry], `${fmt.int(drawn)} in view`)
    } else if (entry.payload?.kind === 'features') {
      const rows = entry.kind === 'gtf' ? rowsThatFit(frame.thickness, 13) : rowsThatFit(frame.thickness)
      const layout = layoutFeatures(frame, this.axis, entry.payload.data, rows)
      this.layouts.set(entry.id, { frame, layout })
      const paint = {
        colour: entry.style.colour,
        guideColour: palette.labelColor,
        haloColour: palette.labelHaloColor,
        font: LANE_FONT,
        opacity: entry.style.opacity,
        labels: true,
      }
      if (entry.kind === 'gtf') drawGenes(ctx, frame, entry.payload.data, layout, paint)
      else drawSegments(ctx, frame, entry.payload.data, layout, paint)
      this.labelLane(
        ctx,
        frame,
        palette,
        [entry],
        layout.dense ? `${fmt.int(layout.total)} in view` : '',
      )
    }
    ctx.restore()
  }

  /** The lane's name — or names, overlaid — and what its value axis spans. */
  private labelLane(
    ctx: CanvasRenderingContext2D,
    frame: LaneFrame,
    palette: ReturnType<typeof readCanvasPalette>,
    entries: AnnotationEntry[],
    detail: string,
  ): void {
    ctx.save()
    ctx.font = LANE_FONT
    ctx.textBaseline = 'middle'
    ctx.textAlign = 'left'
    let at = frame.alongFrom + 4
    for (const entry of entries) {
      // Each name in its own track's colour, which is the whole legend an
      // overlaid lane needs: the line is that colour and so is its name.
      ctx.fillStyle = entries.length > 1 ? entry.style.colour : palette.labelColor
      laneText(ctx, frame, entry.label, at, 9, { halo: palette.labelHaloColor })
      at += ctx.measureText(entry.label).width + 10
    }
    if (detail !== '') {
      ctx.fillStyle = palette.labelColor
      ctx.textAlign = 'right'
      laneText(ctx, frame, detail, frame.alongTo - 4, 9, { halo: palette.labelHaloColor })
    }
    ctx.restore()
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
    // Deliberately *not* including the limits. They are what the two boxes edit,
    // so a commit would always fail the guard and rebuild the row — removing the
    // very input the change event came from, taking the focus with it and, since
    // the pointer is on a control rather than on the lane, hiding the row.
    // The numbers are written back below instead, into the boxes that are
    // already there and are not being typed into.
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
      .join('|')
    if (signature !== this.controlSignature) {
      this.controlSignature = signature
      this.overlays.replaceChildren(
        ...this.lanes.map((lane) => {
          const row = el('div', { class: 'browser-lane-controls' })
          row.style.top = `${lane.frame.acrossFrom}px`
          row.style.height = `${lane.frame.thickness}px`
          const target = lane.profiles[0]?.entry ?? lane.entry
          // A group is an *autoscale* group, so it is offered on the only kind
          // of lane that has a value axis to scale. On a gene model it would be
          // a control with nothing to control.
          if (target.kind === 'track') {
            row.append(this.rangeControl(target), this.groupControl(target))
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
      // What the boxes say, from what the lane is actually drawn with — so an
      // auto-scaled track's numbers follow the view, and the `auto` button
      // reflects the store. Never into a box that has the caret: the reader is
      // mid-number, and half of one is not a value to overwrite them with.
      const first = lane.profiles[0]
      const target = first?.entry ?? lane.entry
      if (target.kind !== 'track') continue
      const extent =
        target.style.group === ''
          ? (first?.profile.extent ?? null)
          : (groups.get(target.style.group) ?? first?.profile.extent ?? null)
      const limits = resolveLimits(target.style.limits, extent)
      const boxes = row.querySelectorAll<HTMLInputElement>('.input-tiny')
      if (boxes[0] !== undefined && boxes[0] !== document.activeElement) {
        boxes[0].value = formatLimit(limits.min)
      }
      if (boxes[1] !== undefined && boxes[1] !== document.activeElement) {
        boxes[1].value = formatLimit(limits.max)
      }
      row.querySelector('.btn-tiny')?.classList.toggle('is-on', target.style.limits.auto)
    }
  }

  /**
   * A track's ceiling, editable in place.
   *
   * Two boxes and an auto button, exactly as the side panel offers them — one
   * implementation of what the numbers mean, because a range edited here and a
   * range edited there are the same range, and two of them would drift.
   */
  private rangeControl(entry: AnnotationEntry): HTMLElement {
    const limits = entry.style.limits
    const min = el('input', {
      class: 'input input-tiny',
      type: 'text',
      value: formatLimit(limits.min),
      title: 'Bottom of this track’s value axis',
    })
    const max = el('input', {
      class: 'input input-tiny',
      type: 'text',
      value: formatLimit(limits.max),
      title: `Top of this track’s value axis. ${CEILING_LABEL} over the lane moves it too.`,
    })
    const commit = (): void => {
      const low = Number(min.value)
      const high = Number(max.value)
      if (!Number.isFinite(low) || !Number.isFinite(high) || !(high > low)) return
      this.props.store.restyle(entry.id, { limits: { auto: false, min: low, max: high } })
    }
    for (const box of [min, max]) {
      box.addEventListener('change', commit)
      box.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') commit()
      })
    }
    // Read from the store at click time, not from the entry this row was built
    // with: the row now outlives changes to the limits, so a captured `auto`
    // would go stale the first time anything else moved them.
    const auto = button('auto', () => {
      const current = this.props.store.byId(entry.id)?.style.limits ?? limits
      this.props.store.restyle(entry.id, { limits: { ...current, auto: !current.auto } })
    }, {
      class: `btn btn-tiny${limits.auto ? ' is-on' : ''}`,
      title: 'Scale to whatever is in view, and follow it as the view moves',
    })
    return el('div', { class: 'browser-range' }, min, el('span', { text: '–' }), max, auto)
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

  private exportCard(): HTMLElement {
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
    const formatSelect = el('select', { class: 'select' })
    for (const format of EXPORT_FORMATS) {
      formatSelect.appendChild(el('option', { value: format, text: format.toUpperCase() }))
    }
    formatSelect.value = this.exportFormat
    formatSelect.addEventListener('change', () => {
      this.exportFormat = formatSelect.value as ExportFormat
    })
    return el(
      'div',
      { class: 'controls-card' },
      el('h3', { class: 'controls-title', text: 'Plot' }),
      el(
        'div',
        { class: 'panel-controls' },
        button('fit to view', () => this.fit(), {
          class: 'btn btn-wide',
          title: 'The whole genome (key: 0, or a double click on the tracks)',
        }),
        el(
          'div',
          { class: 'field field-block' },
          el('span', { class: 'field-label', text: 'export' }),
          el(
            'div',
            { class: 'export-row' },
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
   * The view as a figure, redrawn at the export scale.
   *
   * Redrawn rather than scaled up, which is the same trade the heatmap's export
   * makes: at 300 dpi the track names and the ruler are 300 dpi type rather than
   * a blown-up screenshot of 96 dpi type.
   */
  private async save(): Promise<void> {
    const width = this.scale.pixels
    const height = this.heightOf(this.lanes)
    const scale = scaleForDpi(this.exportDpi)
    const fits = largestDpiThatFits(width, height + CAPTION_HEIGHT)
    if (fits !== null && fits < this.exportDpi) {
      this.exportStatus.textContent = `${fits} dpi is the largest that fits this figure.`
      return
    }
    const out = document.createElement('canvas')
    out.width = Math.max(1, Math.round(width * scale))
    out.height = Math.max(1, Math.round((height + CAPTION_HEIGHT) * scale))
    const ctx = out.getContext('2d')
    if (ctx === null) return
    ctx.setTransform(scale, 0, 0, scale, 0, 0)
    this.paint(ctx, width, height)

    const now = new Date()
    ctx.setTransform(scale, 0, 0, scale, 0, 0)
    ctx.font = '11px system-ui, sans-serif'
    ctx.textAlign = 'left'
    ctx.textBaseline = 'alphabetic'
    ctx.fillStyle = readCanvasPalette(this.canvas).labelColor
    ctx.fillText(
      `${this.props.assembly.name} · ${this.zoomPhrase()} · ${captionStamp(now)}`,
      2,
      height + CAPTION_HEIGHT - 5,
    )
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.globalCompositeOperation = 'destination-over'
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(0, 0, out.width, out.height)
    ctx.globalCompositeOperation = 'source-over'

    const base = `${exportBaseName(this.props.assembly.name)}-${fileStamp(now)}`
    try {
      const blob =
        this.exportFormat === 'png' ? await canvasToPng(out) : await canvasToPdf(out, { dpi: this.exportDpi, title: this.props.assembly.name })
      downloadBlob(blob, `${base}.${this.exportFormat}`)
      this.exportStatus.textContent = ''
    } catch (err) {
      this.exportStatus.textContent = err instanceof Error ? err.message : String(err)
    }
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
      canvas.setPointerCapture(event.pointerId)
      canvas.focus({ preventScroll: true })
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
        canvas.classList.toggle('resizing', this.laneAt(y)?.onBorder === true)
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
        if (to - from > 1) {
          this.scale.setDomain([from, to])
          this.afterMove(true)
          return
        }
      }
      // The end of a gesture is the position worth a history entry.
      if (drag.mode === 'pan') this.afterMove(true)
      this.schedule()
    }

    const onLeave = (): void => {
      this.hover = null
      this.tooltip.classList.add('hidden')
      setReadout('')
      this.schedule()
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
    canvas.addEventListener('wheel', onWheel, { passive: false })
    canvas.addEventListener('dblclick', onDouble)
    canvas.addEventListener('contextmenu', onMenu)
    this.unsubscribes.push(() => {
      canvas.removeEventListener('pointerdown', onDown)
      canvas.removeEventListener('pointermove', onMove)
      canvas.removeEventListener('pointerup', onUp)
      canvas.removeEventListener('pointercancel', onCancel)
      canvas.removeEventListener('pointerleave', onLeave)
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
        const band = this.bands.find((entry) => x >= entry.from && x <= entry.to)
        if (band !== undefined) this.goTo(band.contig)
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

  /**
   * Files dropped anywhere on the browser.
   *
   * A track joins the stack; anything else goes back to the session, which is
   * what turns a dropped `.cool` into a heatmap without a trip through the file
   * picker. Deciding *here* would mean this view knowing what a contact map is,
   * so it does not: it hands over whatever it did not recognise.
   */
  private watchDrop(): void {
    const onOver = (event: DragEvent): void => {
      event.preventDefault()
      this.el.classList.add('over')
    }
    const onLeave = (): void => this.el.classList.remove('over')
    const onDrop = (event: DragEvent): void => {
      event.preventDefault()
      this.el.classList.remove('over')
      const files = Array.from(event.dataTransfer?.files ?? [])
      for (const file of files) this.props.onDropFile(file)
    }
    this.el.addEventListener('dragover', onOver)
    this.el.addEventListener('dragleave', onLeave)
    this.el.addEventListener('drop', onDrop)
    this.unsubscribes.push(() => {
      this.el.removeEventListener('dragover', onOver)
      this.el.removeEventListener('dragleave', onLeave)
      this.el.removeEventListener('drop', onDrop)
    })
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

/** Room under the figure for the one-line caption the export adds. */
const CAPTION_HEIGHT = 18

/** How long a continuous gesture must rest before the locus reaches the URL. */
const REPORT_DELAY = 220

/** Which modifier means "move this track's ceiling" — see the wheel handler. */
const CEILING_MODIFIER = (event: WheelEvent): boolean =>
  isMac() ? event.metaKey && !event.ctrlKey : event.altKey

/** What to call it in a tooltip, on this platform. */
const CEILING_LABEL = isMac() ? '⌘-scroll' : 'Alt-scroll'
