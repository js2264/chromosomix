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
import { RULER_FONT, TICK_FONT, drawRuler, rulerHeightFor } from '../render/browser'
import type { LocusAxis } from '../render/locus'
import { Scale } from '../render/scale'
import { button, el, fmt } from './dom'
import { readCanvasPalette } from './MatrixPanel'
import { SearchBox, featureSuggestions } from './SearchBox'
import { getTextScale, scaleFont, subscribeTextScale } from './textScale'

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
  private readonly box: SearchBox
  private readonly axis: LocusAxis
  private readonly note = el('p', { class: 'summary hint' })

  private width = 0
  private height = rulerHeightFor(getTextScale())
  private dpr = 1
  /** The drag in progress, in canvas pixels, or `null`. */
  private drag: { from: number; to: number } | null = null

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
      el('div', { class: 'seqbar-stage' }, this.canvas),
    )

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

  destroy(): void {
    this.observer?.disconnect()
    for (const off of this.unsubscribes) off()
    if (this.frame !== 0) cancelAnimationFrame(this.frame)
  }

  /** Re-read the box's width and repaint. Called by the view on a relayout. */
  remeasure(): void {
    const width = this.canvas.parentElement?.clientWidth ?? this.el.clientWidth
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

  private paint(): void {
    const width = this.width
    if (width <= 0) return
    this.dpr = window.devicePixelRatio > 0 ? window.devicePixelRatio : 1
    const canvas = this.canvas as HTMLCanvasElement
    canvas.style.width = `${width}px`
    canvas.style.height = `${this.height}px`
    const wantWidth = Math.max(1, Math.round(width * this.dpr))
    const wantHeight = Math.max(1, Math.round(this.height * this.dpr))
    if (canvas.width !== wantWidth) canvas.width = wantWidth
    if (canvas.height !== wantHeight) canvas.height = wantHeight
    const ctx = canvas.getContext('2d')
    if (ctx === null) return
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0)
    ctx.clearRect(0, 0, width, this.height)

    const scale = this.scale()
    const palette = readCanvasPalette(canvas)
    drawRuler(ctx, {
      x: 0,
      y: 0,
      width,
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

    this.paintMarquee(ctx, palette.plotBorderColor)
  }

  /**
   * The band being dragged out, over the ruler it names a part of.
   *
   * A wash with two edges, exactly as the map's own marquee is drawn: the wash
   * says what is inside and the edges say where it stops, and at a few pixels
   * wide the edges are the whole of what can be seen.
   */
  private paintMarquee(ctx: CanvasRenderingContext2D, colour: string): void {
    const drag = this.drag
    if (drag === null) return
    const lo = Math.min(drag.from, drag.to)
    const hi = Math.max(drag.from, drag.to)
    ctx.save()
    ctx.fillStyle = colour
    ctx.globalAlpha = 0.18
    ctx.fillRect(lo, 0, Math.max(1, hi - lo), this.height)
    ctx.globalAlpha = 1
    ctx.strokeStyle = colour
    ctx.lineWidth = 1
    ctx.beginPath()
    ctx.moveTo(lo + 0.5, 0)
    ctx.lineTo(lo + 0.5, this.height)
    ctx.moveTo(hi - 0.5, 0)
    ctx.lineTo(hi - 0.5, this.height)
    ctx.stroke()
    ctx.restore()
  }

  // -------------------------------------------------------------------------
  // The gesture
  // -------------------------------------------------------------------------

  private watchPointer(): void {
    const canvas = this.canvas as HTMLCanvasElement
    const at = (event: MouseEvent): number => {
      const box = canvas.getBoundingClientRect()
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
      this.schedule()
      if (moved && Math.abs(to - from) >= DRAG_MIN) this.dragged(from, to)
      else this.clicked(from)
    }

    canvas.addEventListener('mousedown', (event) => {
      if (event.button !== 0) return
      event.preventDefault()
      down = at(event)
      moved = false
      host?.addEventListener('mousemove', onMove)
      host?.addEventListener('mouseup', onUp)
    })

    // Escape gets out of a drag, as it does out of every other mode here. The
    // listener is on the canvas rather than the window because a drag holds the
    // pointer and nothing else is listening for it.
    canvas.addEventListener('keydown', (event) => {
      if (event.key !== 'Escape' || this.drag === null) return
      down = null
      this.drag = null
      this.schedule()
    })
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
