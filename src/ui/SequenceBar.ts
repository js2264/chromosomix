/**
 * The 1D browser's header, over a table.
 *
 * The Chromosomes table is where a reader of a cooler lands, and until now the
 * only way out of it into a *window* was to type one: a row click opens a whole
 * chromosome, and a quarter of a gigabase is a large read taken to reach a small
 * one. The box that narrows it was there and it asked for `chrIV:1200000-1210000`
 * — which is a coordinate the reader is usually looking for rather than one they
 * already have.
 *
 * So this is the browser's own bar, mounted above the table: the same locus box
 * with the same gene search behind it, the same **go**, the same switch to the
 * tracks — and the same **ruler**, which is the point. Dragging across a
 * chromosome's band names a window in it, which is the gesture the picture was
 * missing and the one every genome browser has.
 *
 * ## What it deliberately does not have
 *
 * **No zoom, and no track fitting.** The ruler here is not a viewport — it is
 * the whole assembly, always, and it stays that way: a zoom control implies a
 * picture that can be somewhere other than where it is, and there is nothing
 * under this ruler to be zoomed. The three fit buttons are about a stack of
 * tracks that is not on screen either. A bar that carried five controls, three of
 * them inert, would be a bar a reader has to work out.
 *
 * ## The base
 *
 * Every region this emits is **0-based and half-open**, which is what
 * `metacooler/range.ts` reads and what the table's own hint promises. The 1D
 * browser writes 1-based inclusive loci for the same drag, because that is what
 * its own box takes (`genome/assembly.ts`) — the two surfaces genuinely differ
 * and the difference is one line in each, kept where it can be seen rather than
 * shared and got wrong once.
 */

import type { AnnotationStore } from '../annotations/store'
import { assemblyAxis, type Assembly } from '../genome/assembly'
import {
  RULER_FONT,
  TICK_FONT,
  drawGuide,
  drawRuler,
  drawSelection,
  rulerHeightFor,
} from '../render/browser'
import {
  CROSSHAIR_COLOR,
  SELECTION_CHIP,
  SELECTION_FONT,
  SELECTION_PAD,
} from '../render/heatmap'
import type { LocusAxis, LocusSegment } from '../render/locus'
import { Scale } from '../render/scale'
import { button, el, fmt } from './dom'
import { readCanvasPalette } from './MatrixPanel'
import { SearchBox, featureSuggestions } from './SearchBox'
import { getTextScale, scaleFont, scaleLength, subscribeTextScale } from './textScale'

/** Movement below this many pixels is a click rather than a drag. */
const DRAG_SLOP = 3

/**
 * The narrowest window a drag may name, in pixels.
 *
 * Not a floor on the *region* — a two-pixel drag at whole-genome zoom is tens of
 * kilobases and a perfectly reasonable thing to ask for — but on the gesture: a
 * hand that moves four pixels between press and release was aiming at a
 * chromosome, and reading it as a window would answer a click with a region
 * nobody could see themselves select. Below it the press falls through to the
 * click, which opens the whole sequence.
 */
const DRAG_MIN = 6

export interface SequenceBarProps {
  assembly: Assembly
  /**
   * The feature index the box searches, where the file has one.
   *
   * A cooler carries annotations (§8.5), so a gene model dropped on the
   * Annotations panel is searchable from here exactly as it is from the browser
   * — and by both its name and its accession (`annotations/search.ts`). Absent
   * where nothing is loaded, and then the box takes coordinates only.
   */
  store?: AnnotationStore
  /** The map/tracks switch, where the session has one to offer. */
  extraControl?: HTMLElement
  /** A whole sequence: a click on a band, or a bare name typed. */
  onOpenContig(name: string): void
  /** A window inside one, 0-based half-open: a drag, or coordinates typed. */
  onOpenRegion(region: string): void
  /** `*`, which is what the browser's box takes for the whole genome. */
  onOpenWhole?(): void
}

export class SequenceBar {
  readonly el: HTMLElement
  private readonly canvas = el('canvas', { class: 'seqbar-canvas' })
  /**
   * The pointer target, and the only part of this that takes up room.
   *
   * The canvas is taller than the strip and hangs *over* the table below it, so
   * the coordinate chips a drag writes have somewhere to go: they sit under the
   * ruler in the 1D browser, where there are tracks to sit over, and here there
   * is the table. Growing the strip to hold them would leave forty pixels of
   * blank canvas above the table at all times for a gesture nobody is making;
   * pushing the table down when a drag starts would move the thing being aimed
   * at. So the canvas floats, this element keeps the height, and the pointer is
   * followed here — otherwise a transparent canvas would be sitting on the first
   * two rows of the table swallowing clicks.
   */
  private readonly stage = el('div', { class: 'seqbar-stage' })
  private readonly box: SearchBox
  private readonly axis: LocusAxis
  private readonly note = el('p', { class: 'summary hint' })

  private width = 0
  private height = rulerHeightFor(getTextScale())
  private dpr = 1
  /** The drag in progress, in canvas pixels, or `null`. */
  private drag: { from: number; to: number } | null = null
  /**
   * Where the pointer is over the strip, or `null` while it is away.
   *
   * A hairline follows it, which is the whole of what makes this a thing to
   * point *at*: a band is fifty pixels of shading with a name in the middle, and
   * without a line the reader has no way to see where in it they are about to
   * start a drag from. The same line the 1D browser draws under its own pointer,
   * in the same colour, so a hand that has learned one has learned the other.
   */
  private hover: number | null = null

  private readonly observer: ResizeObserver | null
  private readonly unsubscribes: Array<() => void> = []
  private frame = 0

  constructor(private readonly props: SequenceBarProps) {
    const axis = assemblyAxis(props.assembly)
    this.axis = axis

    const store = props.store
    this.box = new SearchBox({
      placeholder: 'chrI:1,000-20,000, a sequence, a gene, or * for the whole genome',
      title:
        'Where do you want to be. A sequence name opens the whole of it; coordinates open a ' +
        'window inside it, 0-based and half-open as in cooler; a gene name is looked up in the ' +
        'annotation the star picks. Or drag across the bar below.',
      inputClass: 'input-region',
      onSubmit: (text) => this.submit(text),
      ...(store === undefined ? {} : { suggest: (text: string) => featureSuggestions(store, text) }),
    })

    this.el = el(
      'div',
      { class: 'seqbar' },
      el(
        'div',
        { class: 'title-bar seqbar-bar' },
        this.box.el,
        button('go', () => this.box.submit()),
        // Whatever the session put here — on a cooler, the way through to the
        // tracks and back. Absent on a file that has no second picture.
        ...(props.extraControl === undefined ? [] : [props.extraControl]),
        // No zoom and no fit buttons. See the module docstring: this ruler is
        // the whole assembly and there is nothing under it to fit.
      ),
      this.note,
      this.stage,
    )
    this.stage.appendChild(this.canvas)
    // Before the first paint, or the table jumps up by the height of the ruler
    // and back down again on the frame after mounting.
    this.stage.style.height = `${this.height}px`

    this.paintNote()
    this.watchPointer()

    this.observer =
      typeof ResizeObserver === 'undefined'
        ? null
        : new ResizeObserver(() => this.remeasure())
    this.observer?.observe(this.el)
    this.unsubscribes.push(
      subscribeTextScale((scale) => {
        this.height = rulerHeightFor(scale)
        this.remeasure()
      }),
    )
    // Without an observer — a test, an old browser — nothing else will ever ask
    // for pixels, so the first measurement is taken by hand.
    if (this.observer === null) this.remeasure()
  }

  /** The `/` key, which means the same thing here as in every other view. */
  focus(): void {
    this.box.focus()
  }

  /**
   * Where the hairline is, or `null` for none.
   *
   * Read rather than drawn by a test: jsdom refuses a 2D context, so what can be
   * seen from outside is the state the paint is driven from. The drawing is
   * `drawGuide`, which the 1D browser has used for as long as it has had a
   * pointer, and there is nothing here for a second opinion about it to check.
   */
  get hairlineAt(): number | null {
    return this.drag === null ? this.hover : null
  }

  /**
   * What the band being dragged out says, or `null` when none is.
   *
   * The three numbers the chips are drawn from: the sequence, where the press
   * landed, and where the pointer is now — **in that order**, so a backwards
   * drag reports its anchor first, which is what the two chips show. Clamped to
   * the press's sequence and 0-based, exactly as the region {@link dragged} will
   * emit on release; a marquee that reads differently from what it is about to
   * open is a picture contradicting the result.
   *
   * Read rather than drawn by a test, for the reason {@link hairlineAt} gives:
   * jsdom refuses a 2D context, and the drawing is `drawSelection`, which the 1D
   * browser has used for as long as it has had a marquee.
   */
  get selection(): { contig: string; start: number; end: number } | null {
    const drag = this.drag
    if (drag === null) return null
    const segment = this.axis.segmentAt(this.scale().toUnit(drag.from))
    if (segment === null) return null
    const start = this.bpAt(drag.from, segment)
    const end = this.bpAt(drag.to, segment)
    return start === null || end === null ? null : { contig: segment.contig, start, end }
  }

  destroy(): void {
    this.observer?.disconnect()
    for (const off of this.unsubscribes) off()
    if (this.frame !== 0) cancelAnimationFrame(this.frame)
  }

  /** Re-read the box's width and repaint. Called by the view on a relayout. */
  remeasure(): void {
    // The stage, not the canvas: the canvas is absolutely positioned and takes
    // whatever width it is given, so measuring it would measure the last frame.
    const width = this.stage.clientWidth || this.el.clientWidth
    if (width <= 0) return
    this.width = width
    this.schedule()
  }

  // -------------------------------------------------------------------------
  // What was typed
  // -------------------------------------------------------------------------

  /**
   * Act on the box: the whole genome, a sequence, or a window.
   *
   * The order is what makes one box able to take three spellings of one
   * question. `*` first because it is a literal; a bare name that the assembly
   * has next, because a sequence is not a region and opening it as one would
   * put coordinates on a crumb the reader did not type; everything else goes to
   * the region reader, which is where a gene's resolved coordinates arrive too.
   */
  private submit(text: string): void {
    const asked = text.trim()
    if (asked === '') return
    if (asked === '*') {
      this.props.onOpenWhole?.()
      return
    }
    if (this.axis.segmentOf(asked) !== null) {
      this.props.onOpenContig(asked)
      return
    }
    this.props.onOpenRegion(asked)
  }

  // -------------------------------------------------------------------------
  // Drawing
  // -------------------------------------------------------------------------

  private schedule(): void {
    if (this.frame !== 0) return
    this.frame = requestAnimationFrame(() => {
      this.frame = 0
      this.paint()
    })
  }

  private paintNote(): void {
    const count = this.props.assembly.contigs.length
    this.note.textContent =
      `${fmt.int(count)} ${count === 1 ? 'sequence' : 'sequences'} · ` +
      `${fmt.bp(this.props.assembly.total)} · drag a band to open a window in it`
  }

  /**
   * How far the canvas hangs below the strip: two chip rows and their gaps.
   *
   * Derived from the chip metrics rather than fixed, so a reader who has turned
   * the text up does not get the second row clipped off the bottom.
   */
  private marksRoom(): number {
    return 4 + scaleLength(SELECTION_CHIP) * 2 + 5
  }

  private paint(): void {
    const width = this.width
    if (width <= 0) return
    this.dpr = window.devicePixelRatio > 0 ? window.devicePixelRatio : 1
    // The strip's own height is the ruler's; the canvas over it is taller.
    this.stage.style.height = `${this.height}px`
    const canvas = this.canvas as HTMLCanvasElement
    const tall = this.height + this.marksRoom()
    canvas.style.width = `${width}px`
    canvas.style.height = `${tall}px`
    const wantWidth = Math.max(1, Math.round(width * this.dpr))
    const wantHeight = Math.max(1, Math.round(tall * this.dpr))
    if (canvas.width !== wantWidth) canvas.width = wantWidth
    if (canvas.height !== wantHeight) canvas.height = wantHeight
    const ctx = canvas.getContext('2d')
    if (ctx === null) return
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0)
    ctx.clearRect(0, 0, width, tall)

    const scale = this.scale()
    const palette = readCanvasPalette(canvas)
    drawRuler(ctx, {
      x: 0,
      y: 0,
      width,
      height: this.height,
      toPixel: (unit: number) => scale.toPixel(unit),
      axis: this.axis,
      domain: scale.domain,
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
    })

    this.paintMarquee(ctx, palette.labelHaloColor)
    // Under the marquee, because while a drag is in progress the edges are what
    // the eye is on and a third line beside one of them is noise.
    if (this.drag === null && this.hover !== null) {
      drawGuide(ctx, this.hover, 0, this.height, CROSSHAIR_COLOR, this.dpr)
    }
  }

  /**
   * The band being dragged out, over the ruler it names a part of.
   *
   * The 1D browser's marquee exactly — a wash the width of the drag, both edges
   * as hairlines, and three chips: where the drag started, where it is now, and
   * how much lies between. Not a second look for the same gesture: the drawing
   * is `render/browser.ts`'s {@link drawSelection}, and a hand that has learned
   * to aim by those numbers in the browser aims by the same ones here.
   *
   * What differs is the **base**, and it differs on purpose. The browser writes
   * 1-based inclusive positions because that is what its own box takes; this bar
   * emits, and its box reads, 0-based half-open regions as `metacooler/range.ts`
   * does — so the chips are the numbers that will actually appear in the crumb.
   *
   * The ends are also **clamped to the sequence the press landed in**, exactly
   * as {@link dragged} clamps them. A drag that runs off the end of chromosome
   * IV opens a window in chromosome IV, and a chip reading `chrV:…` while that
   * is what is about to happen would be the picture contradicting the result.
   */
  private paintMarquee(ctx: CanvasRenderingContext2D, halo: string): void {
    const drag = this.drag
    if (drag === null) return
    const lo = Math.min(drag.from, drag.to)
    const hi = Math.max(drag.from, drag.to)
    ctx.save()
    ctx.fillStyle = CROSSHAIR_COLOR
    ctx.globalAlpha = 0.15
    ctx.fillRect(lo, 0, Math.max(1, hi - lo), this.height + this.marksRoom())
    ctx.restore()

    const marks = this.selection
    if (marks === null) return
    drawSelection(ctx, {
      anchor: drag.from,
      moving: drag.to,
      start: `${marks.contig}:${fmt.int(marks.start)}`,
      end: `${marks.contig}:${fmt.int(marks.end)}`,
      span: fmt.bp(Math.abs(marks.end - marks.start)),
      top: 0,
      bottom: this.height + this.marksRoom(),
      chipTop: this.height + 4,
      width: this.width,
      dpr: this.dpr,
      chipHeight: scaleLength(SELECTION_CHIP),
      chipPad: scaleLength(SELECTION_PAD),
      font: scaleFont(SELECTION_FONT),
      colour: CROSSHAIR_COLOR,
      halo,
    })
  }

  /** Where a pixel falls in one sequence, in that sequence's own base pairs. */
  private bpAt(x: number, segment: LocusSegment): number | null {
    const unit = Math.max(
      segment.unitStart,
      // A hair inside the far edge, or a drag that ends exactly on a boundary
      // is read as the *next* sequence — the same guard {@link dragged} needs.
      Math.min(segment.unitEnd - 1e-6, this.scale().toUnit(x)),
    )
    const locus = this.axis.unitToLocus(unit)
    return locus === null ? null : Math.round(locus.bp)
  }

  // -------------------------------------------------------------------------
  // The gesture
  // -------------------------------------------------------------------------

  private watchPointer(): void {
    // The *stage* and not the canvas: the canvas is a floating overlay with
    // `pointer-events: none`, or the part of it hanging over the table would eat
    // the first two rows' clicks. See {@link stage}.
    const stage = this.stage
    const at = (event: MouseEvent): number => {
      const box = stage.getBoundingClientRect()
      return Math.max(0, Math.min(this.width, event.clientX - box.left))
    }

    let down: number | null = null
    let moved = false

    // The drag is followed on the *window*, as every other drag in this app is:
    // a hand that leaves the strip on its way to the end of a chromosome has not
    // changed its mind, and a gesture abandoned at the edge is a gesture that
    // fails exactly where it is most often made.
    const host: Window | undefined = typeof window === 'undefined' ? undefined : window
    const onMove = (event: MouseEvent): void => {
      if (down === null) return
      const x = at(event)
      if (!moved && Math.abs(x - down) < DRAG_SLOP) return
      moved = true
      this.drag = { from: down, to: x }
      this.syncCursor()
      this.schedule()
    }
    const onUp = (event: MouseEvent): void => {
      if (down === null) return
      const from = down
      const to = at(event)
      down = null
      host?.removeEventListener('mousemove', onMove)
      host?.removeEventListener('mouseup', onUp)
      this.drag = null
      this.syncCursor()
      this.schedule()
      if (moved && Math.abs(to - from) >= DRAG_MIN) this.dragged(from, to)
      else this.clicked(from)
    }

    // The hairline follows the pointer whether or not a button is down; the
    // *drag* is followed on the window, so this one stays on the strip and stops
    // the moment the pointer leaves it.
    stage.addEventListener('mousemove', (event) => {
      const x = at(event)
      if (this.hover === x) return
      this.hover = x
      this.syncCursor()
      this.schedule()
    })
    stage.addEventListener('mouseleave', () => {
      if (this.hover === null) return
      this.hover = null
      this.syncCursor()
      this.schedule()
    })

    stage.addEventListener('mousedown', (event) => {
      if (event.button !== 0) return
      event.preventDefault()
      down = at(event)
      moved = false
      host?.addEventListener('mousemove', onMove)
      host?.addEventListener('mouseup', onUp)
    })

    /**
     * Escape abandons the drag, opening nothing.
     *
     * The way out of a marquee dragged in the wrong place, and the same key
     * doing the same thing in the 1D browser and on the contact map. A region is
     * committed on release and a release cannot be taken back, so without this
     * the only way out of a drag begun by accident was to let it navigate
     * somewhere and come back.
     *
     * **On the window and capturing**, which is the whole of the bug fix: this
     * listener used to be on the canvas, and a canvas takes no focus, so the key
     * went to whatever the reader last clicked on and the drag went through. The
     * `mouseup` listener goes with it — a drag whose press has been abandoned
     * must not be finished by the release of the same button.
     */
    const onAbort = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape' || down === null) return
      event.preventDefault()
      event.stopPropagation()
      down = null
      moved = false
      this.drag = null
      this.syncCursor()
      host?.removeEventListener('mousemove', onMove)
      host?.removeEventListener('mouseup', onUp)
      this.schedule()
    }
    host?.addEventListener('keydown', onAbort, true)
    this.unsubscribes.push(() => {
      host?.removeEventListener('keydown', onAbort, true)
      host?.removeEventListener('mousemove', onMove)
      host?.removeEventListener('mouseup', onUp)
    })
  }

  /**
   * What the pointer says the press would do.
   *
   * A hand over a band, because a press there opens *that sequence* — which is
   * the gesture a reader arrives with, and a caret over a row of named blocks
   * says nothing about it. The caret is still right once the hand is travelling:
   * a drag names a stretch, which is what selecting text does, and swapping back
   * mid-gesture is what keeps the two from reading as one control that cannot
   * make up its mind.
   *
   * Written as classes rather than as an inline style so the two answers live in
   * the stylesheet beside the base cursor they qualify, and so a test can read
   * which one is in force without parsing a style attribute.
   */
  private syncCursor(): void {
    const dragging = this.drag !== null
    const overBand =
      !dragging && this.hover !== null && this.axis.segmentAt(this.scale().toUnit(this.hover)) !== null
    this.stage.classList.toggle('is-dragging', dragging)
    this.stage.classList.toggle('is-over-band', overBand)
  }

  /**
   * The whole assembly across the strip's width.
   *
   * Made per use rather than held, and never zoomed: there is no viewport here
   * to be somewhere other than where it is, which is why there is no zoom
   * control above it.
   *
   * Every gesture below measures through **this** rather than through what
   * `drawRuler` returned, and that is deliberate: hit-testing that depends on a
   * paint having happened is hit-testing that fails on the first frame, in a
   * detached element, and anywhere a canvas refuses a context. The bands are a
   * function of the axis and the width, so they are computed from those.
   */
  private scale(): Scale {
    return new Scale([0, this.axis.unitEnd], this.width)
  }

  /** A press that did not travel: the sequence under it, whole. */
  private clicked(x: number): void {
    const segment = this.axis.segmentAt(this.scale().toUnit(x))
    if (segment !== null) this.props.onOpenContig(segment.contig)
  }

  /**
   * A drag: the window it named, inside **one** sequence.
   *
   * Clamped to the sequence the press landed in rather than refused when it runs
   * past the end of it. A region names one contig — that is what the reader,
   * `parseMetacoolerRange` and the crumb all mean by one — and a hand that
   * overshoots chromosome III's right-hand edge by a few pixels has still said
   * what it meant. Taking the *start* is what makes it predictable: the
   * sequence is decided when the button goes down, where the reader is looking.
   */
  private dragged(from: number, to: number): void {
    const scale = this.scale()
    const lo = scale.toUnit(Math.min(from, to))
    const hi = scale.toUnit(Math.max(from, to))
    const segment = this.axis.segmentAt(lo)
    if (segment === null) return
    const clip = (unit: number): number =>
      Math.max(segment.unitStart, Math.min(segment.unitEnd, unit))
    const start = this.axis.unitToLocus(clip(lo))
    // A hair inside the far edge, or `unitToLocus` answers with the *next*
    // sequence for a drag that ends exactly on a boundary.
    const end = this.axis.unitToLocus(Math.max(segment.unitStart, clip(hi) - 1e-6))
    if (start === null || end === null) return
    const first = Math.max(0, Math.round(Math.min(start.bp, end.bp)))
    const last = Math.min(segment.contigLength, Math.round(Math.max(start.bp, end.bp)))
    if (last <= first) {
      this.props.onOpenContig(segment.contig)
      return
    }
    // No thousands separators and a plain hyphen: this string is read back by
    // `metacooler/range.ts` and pasted into other tools, and the app's display
    // format — grouped digits, an en dash — is for reading rather than for that.
    this.props.onOpenRegion(`${segment.contig}:${first}-${last}`)
  }
}
