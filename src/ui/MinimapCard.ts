/**
 * The **Genome minimap**: the whole assembly in one compact strip, with where
 * you are marked on it.
 *
 * ## Why this exists when {@link SequenceBar} already draws the same genome
 *
 * `SequenceBar`'s module header is explicit that it is *not* a viewport — "the
 * ruler here is not a viewport … it is the whole assembly, always" — and it is
 * right about itself: it sits above the Chromosomes *table*, and there is
 * nothing under it that could be somewhere other than where it is. A minimap is
 * the other half of that sentence. It is mounted beside a picture that *is*
 * somewhere: a 1D browser standing on ten kilobases of chromosome IV, or a
 * contact map showing one block of a genome. The one question neither the bar
 * nor the breadcrumb answers is **how much of the genome that is**, and it is a
 * question a reader asks constantly and can only answer by arithmetic on two
 * coordinates. So this card draws the same strip, from the same axis, and adds
 * the one mark `SequenceBar` deliberately refuses: a highlight saying *here*.
 *
 * That is the whole delta, and it is why this is a second widget rather than a
 * flag on the first. A bar over a table that showed a viewport would be showing
 * a viewport onto a table — a picture of a thing that is not there.
 *
 * ## Why one strip can carry a two-axis location
 *
 * A contact map has a row range and a column range, and the obvious design for
 * a 2D overview is a little square — a thumbnail of the matrix with a rectangle
 * on it. That is a *different layout* from the 1D one, and the request was
 * explicitly for the same layout in both modes; more importantly a square
 * thumbnail spends a 288-pixel column's width on a picture whose most common
 * state is a rectangle on the diagonal, which is a line.
 *
 * Both of a map's ranges are ranges *of the same genome*. Laid on one strip
 * they coincide exactly when the block is on the diagonal — which is the
 * overwhelmingly common case, and which then draws the identical picture a 1D
 * window draws, correctly, because a 1D window **is** the diagonal. They
 * separate only for an off-diagonal block, and then two marks on one genome is
 * the honest picture: chromosome II against chromosome IX is *two* places, and a
 * square thumbnail's single rectangle hides that they are the same axis twice.
 *
 * So the layout is one strip in both modes, and what differs is only what is
 * highlighted — which is what {@link MinimapWhere} carries and the only thing a
 * caller has to decide.
 *
 * ## The coordinate convention, which is the trap
 *
 * The 1D browser's `state.locus` is **1-based inclusive** (`formatLocus`); the
 * 2D `region`/`region2`/`focus` are **0-based half-open**. This card does not
 * choose between them, because §26.1 already has: {@link MinimapRange} is
 * documented as **0-based half-open**, always, in both modes, and the caller
 * converts on the way in — that is the machine form, and it is what this card
 * *emits*, `contig:first-last` with no thousands separators, so it drops into
 * the plumbing that already exists. What it *writes for a reader* is the display
 * form, through `formatLocus` and nothing hand-rolled, so the readout under the
 * strip and the locus box above it print the same window. Those were a base
 * apart until §26.1 settled it, on one screen, with this card's own tooltip
 * insisting they agreed.
 *
 * ## Geometry
 *
 * The strip is `assemblyAxis(assembly)` across the card's width: one unit per
 * base pair, sequences end to end. That is the mapping §8.4 requires everything
 * to share, and this card derives no second one — every span, every hit test and
 * every pixel below goes through that axis and one {@link Scale}.
 */

import { assemblyAxis, formatLocus, type Assembly } from '../genome/assembly'
import { drawGuide, snap } from '../render/browser'
import { CROSSHAIR_COLOR } from '../render/heatmap'
import type { LocusAxis, LocusSegment } from '../render/locus'
import { Scale } from '../render/scale'
import { el } from './dom'
import { cardTitle } from './icons'
import { readCanvasPalette } from './MatrixPanel'
import { scaleFont, scaleLength, subscribeTextScale } from './textScale'

/** Movement below this many pixels is a click rather than a drag. */
const DRAG_SLOP = 3

/**
 * The narrowest window a drag may name, in pixels — `SequenceBar`'s rule.
 *
 * Not a floor on the region: on a 12 Mb genome in a 260-pixel card a two-pixel
 * drag is ninety kilobases and a perfectly reasonable ask. It is a floor on the
 * *gesture*, because a hand that moved four pixels between press and release was
 * aiming at a chromosome, and answering it with a window nobody could see
 * themselves select is worse than answering it with the sequence.
 */
const DRAG_MIN = 6

/**
 * The narrowest a **highlight** may be drawn, in pixels.
 *
 * The one number this card cannot do without. A 10 kb window on a 12 Mb genome
 * across 260 pixels is a fifth of a pixel: rounded down it is nothing, and the
 * card silently stops answering its only question at exactly the zoom where the
 * reader most needs it answered — which is *deep in*, where the breadcrumb's
 * coordinates have stopped meaning anything without arithmetic. Two pixels is
 * the smallest mark that survives a device-pixel-ratio of 1 and still reads as a
 * position rather than as grit on the screen.
 */
const MIN_SPAN = 2

/**
 * The sequence band's own height, before the text scale.
 *
 * **Why this card does not call `drawRuler`.** It would be the obvious reuse and
 * it is the wrong trade here. `drawRuler`'s `BAND_HEIGHT` is a hard-coded 48 and
 * its header says why — the band is "the one part of a genome browser a hand
 * goes to without being told", sized for a hand rather than for the name in it —
 * and with the scale row under it a ruler is 72 px at the default text scale.
 * In a 288-pixel General column that is a quarter of the card stack's height
 * spent on an overview, and `render/browser.ts` is not mine to parameterise.
 * The scale row is dead weight here too: it draws sequence boundaries, which on
 * a whole-genome strip are the band edges already drawn, and per-contig ticks,
 * which a whole-genome domain never reaches.
 *
 * So the strip is drawn here, in about thirty lines, and it **keeps
 * `drawRuler`'s conventions on purpose** — alternating shading whose parity is
 * taken over the index in the *assembly* rather than over the visible bands
 * (`render/browser.ts` ~120-130: parity over the visible ones inverts every band
 * on screen the moment one leaves an edge), names dropped rather than clipped
 * when they do not fit their own band, and the same four palette entries. A
 * reader who has learned the browser's strip has learned this one.
 */
const BAND_ROW = 22

/**
 * The thin lane above and below the bands where an axis's mark is drawn.
 *
 * Two lanes, always, in both modes — because a location may have two axes and a
 * layout that grew a lane when it did would be two layouts. A 1D window and an
 * on-diagonal block fill both, which is not redundancy: it is the statement that
 * this place is the row range *and* the column range, which for those two cases
 * is exactly true.
 */
const MARK_LANE = 4

/** The band names, at the card's scale: smaller than the browser's ruler font. */
const MINIMAP_FONT = '600 10px system-ui, sans-serif'

/** How tall the strip is at the text scale in force. */
export function minimapHeight(): number {
  return scaleLength(BAND_ROW) + scaleLength(MARK_LANE) * 2
}

/**
 * A stretch of one sequence, **0-based and half-open**.
 *
 * The single convention this card speaks, in both modes, on the way in and on
 * the way out. See the module header: the 1D browser's `locus` is 1-based
 * inclusive and the 2D `region` is not, the two differ on purpose, and the
 * conversion is the caller's one line rather than a guess made here.
 */
export interface MinimapRange {
  contig: string
  start: number
  end: number
}

/**
 * Where the reader is, in the one shape both modes hand over.
 *
 * - `null` — the whole genome, or nothing chosen yet. Nothing is highlighted
 *   and the readout says so in words. Highlighting *everything* was the
 *   alternative and is worse: a wash over the full width is indistinguishable
 *   from a card with a tinted background, so the honest "you are everywhere"
 *   and the accidental "the paint failed" would look identical.
 * - `window` — the 1D browser's viewport.
 * - `block` — a contact map's row and column ranges. Equal ranges are the
 *   diagonal and collapse to one highlight; see {@link MinimapCard.spans}.
 */
export type MinimapWhere =
  | null
  | { kind: 'window'; range: MinimapRange }
  | { kind: 'block'; rows: MinimapRange; columns: MinimapRange }

/**
 * What one highlight is: which axis it belongs to, and where it landed.
 *
 * `window` is both axes at once — a 1D viewport, or a block on the diagonal.
 */
export type MinimapRole = 'window' | 'rows' | 'columns'

/**
 * One drawn highlight, in base pairs and in pixels.
 *
 * Reported through a getter for the reason `SequenceBar.selection` is: jsdom
 * refuses a 2D context, so the only thing a test can read is the state the paint
 * is driven from. `from`/`to` are the pixels actually painted, {@link MIN_SPAN}
 * already applied, so "a one-base window is still visible" is a question a test
 * can ask rather than one it has to trust.
 */
export interface MinimapSpan extends MinimapRange {
  role: MinimapRole
  /** Left edge in CSS pixels within the strip. */
  from: number
  /** Right edge in CSS pixels. Never closer than {@link MIN_SPAN} to `from`. */
  to: number
}

/**
 * Whether this card should be offered for a file at all.
 *
 * The same gate `ContigsTable` puts on its `assembly` and `Session.paintSequences`
 * puts on the Sequences card, for the same reason and stated once here so the two
 * mount points cannot drift: sixteen chromosomes laid end to end is a picture of
 * a genome a hand can point at, while a hundred thousand contigs from four
 * thousand independently assembled organisms is a *texture* — every band a
 * fraction of a pixel, no name in any of them, and a highlight that cannot be
 * told from the bands around it. There the genomes table is the overview, and
 * this card would be a smear with a coordinate under it.
 *
 * Structural on `hasGenomes` rather than typed to `OpenResult`, so `render/` and
 * the worker protocol stay out of a card's imports; pass the open file's info.
 */
export function suitsMinimap(file: { hasGenomes: boolean }): boolean {
  return !file.hasGenomes
}

export interface MinimapCardProps {
  assembly: Assembly
  /**
   * Where the reader is now. Absent is `null` — the whole genome.
   *
   * Updated afterwards through {@link MinimapCard.update}, never by mutating
   * this.
   */
  where?: MinimapWhere
  /**
   * A whole sequence: a click on a band.
   *
   * The pair `SequenceBar` emits, deliberately, so one wiring serves both. What
   * a name *means* differs by mode — 1D sets a locus, 2D navigates a view state
   * — and that is the session's business, not this card's. Nothing here imports
   * `Session`.
   */
  onOpenContig(name: string): void
  /**
   * A window inside one sequence: a drag. `contig:first-last`, **0-based
   * half-open**, no thousands separators — the exact string `SequenceBar`
   * emits and `metacooler/range.ts` reads.
   */
  onOpenRegion(region: string): void
}

/**
 * The card. Collapsible and open by default, on the same fold every card has.
 *
 * This card had the behaviour first, as a `<details open>` whose summary was its
 * own heading, and said here that there was no per-card collapse idiom in the
 * codebase to follow. There is one now — `cardTitle` gives every card in every
 * panel a chevron on the right of its heading and folds the card on a press
 * anywhere along that line (`ui/icons.ts`) — so what was a `<details>` is an
 * ordinary card, and the marker that used to sit at the *start* of the line in
 * whatever size the browser chose is a mark at the end of it in the size the
 * page did.
 *
 * The choice is still **not remembered**, and that is a decision rather than an
 * omission: the house mechanisms for a per-reader preference are modules of
 * their own over `localStorage` (`ui/textScale.ts`, `ui/mapSize.ts`), a new one
 * would be a new storage scheme invented for one disclosure triangle, and this
 * card is rebuilt on navigation in the 1D browser anyway — so a remembered
 * "closed" would have to survive a rebuild the reader cannot see happening.
 */
export class MinimapCard {
  readonly el: HTMLElement
  private readonly canvas = el('canvas', { class: 'minimap-canvas' })
  /** The pointer target and the thing that has a width worth measuring. */
  private readonly stage = el('div', { class: 'minimap-stage' })
  /** The heading, which is also the fold — see {@link open}. */
  private readonly head: HTMLElement
  /** Where you are, in words — and, while one is out, what the drag would open. */
  private readonly readout = el('p', { class: 'minimap-where' })
  private readonly note = el('p', { class: 'summary hint minimap-note' })
  private readonly axis: LocusAxis

  private where: MinimapWhere
  private width = 0
  private height = minimapHeight()
  private dpr = 1
  /** The drag in progress, in strip pixels, or `null`. */
  private drag: { from: number; to: number } | null = null
  /** Where the pointer is over the strip, or `null` while it is away. */
  private hover: number | null = null

  private readonly observer: ResizeObserver | null
  private readonly unsubscribes: Array<() => void> = []
  private frame = 0
  private dead = false

  constructor(private readonly props: MinimapCardProps) {
    this.axis = assemblyAxis(props.assembly)
    this.where = props.where ?? null

    this.head = cardTitle('Genome minimap', 'scan')
    // The strip, the readout and the note are the card's own children rather
    // than a body element's: what folds is "everything but the heading", and the
    // stylesheet says that for every card at once. A wrapper here would be this
    // card asking for the rule to be written a second time about it.
    this.el = el(
      'section',
      { class: 'card minimap-card' },
      this.head,
      this.stage,
      this.readout,
      this.note,
    )
    this.stage.appendChild(this.canvas)
    // Before the first paint, or the cards below jump by the strip's height on
    // the frame after mounting.
    this.stage.style.height = `${this.height}px`

    this.paintText()
    this.watchPointer()

    this.observer =
      typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(() => this.remeasure())
    this.observer?.observe(this.el)
    this.unsubscribes.push(
      subscribeTextScale(() => {
        // Nothing in the app hands a General-column card a teardown — `setGeneral`
        // just `replaceChildren`s — so a card that has left the document retires
        // itself the first time it is spoken to, exactly as the Sequences card
        // and the text-scale field already do. See {@link destroy}.
        if (!this.el.isConnected) {
          this.destroy()
          return
        }
        this.height = minimapHeight()
        this.remeasure()
      }),
    )
    // Without an observer — a test, an old browser — nothing else will ever ask
    // for pixels, so the first measurement is taken by hand.
    if (this.observer === null) this.remeasure()
  }

  /**
   * Say where the reader is now, and repaint.
   *
   * The card's whole update path. `Session.relayout()` does not reach General-
   * panel cards, so this and the `ResizeObserver` are the only two things that
   * ever move the picture; a third would be a fourth way for it to go stale.
   */
  update(where: MinimapWhere): void {
    this.where = where
    this.paintText()
    this.schedule()
  }

  /** Re-read the card's width and repaint. */
  remeasure(): void {
    const width = this.stage.clientWidth || this.el.clientWidth
    if (width <= 0) return
    this.width = width
    this.schedule()
  }

  /**
   * The highlights as they will be painted — the card's test surface.
   *
   * jsdom refuses a 2D context, so this is read rather than drawn, for the
   * reason `SequenceBar.hairlineAt` and `SequenceBar.selection` are.
   *
   * **A block on the diagonal answers with one span, not two.** Equal ranges are
   * one place: two identical washes drawn on top of each other are one wash, and
   * reporting them as two would be this getter contradicting the picture — while
   * a caller (or a test) asking "how many places is the reader in" would get the
   * wrong answer for the most common state a contact map is ever in. Its role is
   * then `window`, which is the truth: on the diagonal the row range and the
   * column range are the same window, and the 1D browser's viewport is that same
   * case reached from the other mode.
   */
  get spans(): MinimapSpan[] {
    const where = this.where
    if (where === null || this.width <= 0 || this.axis.unitEnd <= 0) return []
    if (where.kind === 'window') return keep(this.spanOf('window', where.range))
    if (sameRange(where.rows, where.columns)) return keep(this.spanOf('window', where.rows))
    return [...keep(this.spanOf('rows', where.rows)), ...keep(this.spanOf('columns', where.columns))]
  }

  /**
   * The sequence bands as they will be painted, in **assembly order**.
   *
   * `drawRuler` reports its bands for the same reason — they are the click
   * targets — and this reports them for that reason and one more: jsdom refuses
   * a 2D context, so a strip whose bands only existed inside a paint would have
   * none to check, and neither would a real browser on its first frame. Every
   * gesture below hit-tests through the same axis these come from, so a test
   * that reads them is reading what the pointer reads.
   */
  get bands(): Array<{ contig: string; from: number; to: number }> {
    if (this.width <= 0 || this.axis.unitEnd <= 0) return []
    const scale = this.scale()
    return this.axis.segments.map((segment) => ({
      contig: segment.contig,
      from: scale.toPixel(segment.unitStart),
      to: scale.toPixel(segment.unitEnd),
    }))
  }

  /**
   * What the drag being made would open, or `null` when none is out.
   *
   * The three numbers the readout is written from: the sequence, where the press
   * landed, and where the pointer is now — in that order, so a backwards drag
   * reports its anchor first. Clamped to the press's sequence and 0-based,
   * exactly as {@link dragged} will emit on release; a readout that differs from
   * what release does is the picture contradicting the result.
   */
  get selection(): MinimapRange | null {
    const drag = this.drag
    if (drag === null || this.axis.unitEnd <= 0) return null
    const segment = this.axis.segmentAt(this.scale().toUnit(drag.from))
    if (segment === null) return null
    const start = this.bpAt(drag.from, segment)
    const end = this.bpAt(drag.to, segment)
    return start === null || end === null ? null : { contig: segment.contig, start, end }
  }

  /** Where the hairline is, or `null` for none. Read rather than drawn — see {@link spans}. */
  get hairlineAt(): number | null {
    return this.drag === null ? this.hover : null
  }

  /** Whether the card is expanded. `true` on a fresh mount. */
  get open(): boolean {
    return !this.el.classList.contains('is-folded')
  }

  /**
   * Drop the observer, the frame and the subscriptions.
   *
   * **Idempotent, and safe to never call.** Nothing in the app currently tears
   * down a General-column card, so this card is built to be abandoned: the
   * text-scale subscription retires itself the first time it fires on a card
   * that has left the document (the constructor's `isConnected` check), and the
   * window-level drag listeners are attached on `mousedown` and removed on
   * release, so an abandoned card holds none of them. What is left is a
   * `ResizeObserver` on a detached element, which never fires again. Calling
   * this is still the tidier thing to do wherever a caller has somewhere to call
   * it from, and calling it twice — or after the card has retired itself — does
   * nothing.
   */
  destroy(): void {
    if (this.dead) return
    this.dead = true
    this.observer?.disconnect()
    for (const off of this.unsubscribes) off()
    this.unsubscribes.length = 0
    if (this.frame !== 0) {
      cancelAnimationFrame(this.frame)
      this.frame = 0
    }
  }

  // -------------------------------------------------------------------------
  // Where you are, in words
  // -------------------------------------------------------------------------

  /**
   * The two lines under the strip.
   *
   * The location is written as *text* rather than as chips over the canvas, and
   * that is the one place this card departs from `SequenceBar`'s gesture
   * feedback on purpose: `drawSelection`'s chips need two rows of about
   * twenty-four pixels below the ruler and enough width for two coordinates side
   * by side, and this strip is forty pixels tall in a 288-pixel column with a
   * line of text already under it. So the line under it is the readout, and it
   * says the same three things the chips would.
   *
   * **The note is the gesture, and nothing else.** It led with the assembly's
   * sequence count and total length, which is what the card directly above this
   * one says in its first two rows — the same two facts twice within six
   * centimetres, pushing the one thing a reader could act on onto a third line.
   * The picture under the words is the count and the total.
   */
  private paintText(): void {
    this.note.textContent = 'click a band for a sequence, drag for a window'
    this.readout.textContent = this.describe()
    this.readout.title = 'Positions are 1-based and inclusive, as in every genome browser.'
  }

  private describe(): string {
    const drag = this.selection
    if (drag !== null) return `${span(drag)} — release to open`
    const where = this.where
    if (where === null) return 'the whole genome'
    if (where.kind === 'window') return span(where.range)
    if (sameRange(where.rows, where.columns)) return `${span(where.rows)} · on the diagonal`
    return `rows ${span(where.rows)} · columns ${span(where.columns)}`
  }

  // -------------------------------------------------------------------------
  // Drawing
  // -------------------------------------------------------------------------

  private schedule(): void {
    if (this.frame !== 0 || this.dead) return
    this.frame = requestAnimationFrame(() => {
      this.frame = 0
      this.paint()
    })
  }

  private paint(): void {
    const width = this.width
    if (width <= 0) return
    this.dpr = window.devicePixelRatio > 0 ? window.devicePixelRatio : 1
    const height = this.height
    this.stage.style.height = `${height}px`
    const canvas = this.canvas
    canvas.style.width = `${width}px`
    canvas.style.height = `${height}px`
    const wantWidth = Math.max(1, Math.round(width * this.dpr))
    const wantHeight = Math.max(1, Math.round(height * this.dpr))
    if (canvas.width !== wantWidth) canvas.width = wantWidth
    if (canvas.height !== wantHeight) canvas.height = wantHeight
    // Every canvas path in this app guards on a null context: jsdom refuses one
    // outright, and a real browser can refuse one under memory pressure.
    const ctx = canvas.getContext('2d')
    if (ctx === null) return
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0)
    ctx.clearRect(0, 0, width, height)

    const palette = readCanvasPalette(canvas)
    this.paintBands(ctx, palette)
    this.paintSpans(ctx)
    // Under nothing, and above the bands: while a drag is out its own edges are
    // what the eye is on and a third line beside one of them is noise.
    if (this.drag === null && this.hover !== null) {
      drawGuide(ctx, this.hover, 0, height, CROSSHAIR_COLOR, this.dpr)
    }
  }

  /**
   * The sequences, end to end, shaded alternately — `drawRuler`'s conventions in
   * a shorter box. See {@link BAND_ROW} for why this is drawn here.
   */
  private paintBands(
    ctx: CanvasRenderingContext2D,
    palette: ReturnType<typeof readCanvasPalette>,
  ): void {
    const bands = this.bands
    if (bands.length === 0) return
    const lane = scaleLength(MARK_LANE)
    const top = lane
    const bandHeight = scaleLength(BAND_ROW)

    ctx.save()
    ctx.beginPath()
    ctx.rect(0, 0, this.width, this.height)
    ctx.clip()

    // Parity over the index in the **assembly**, not over the drawn ones. This
    // strip always draws every sequence so the two agree today, but the rule is
    // `drawRuler`'s and copying it with the difference removed is how the bug it
    // prevents comes back the first time this card learns to show a subset.
    bands.forEach((band, index) => {
      if (index % 2 === 1) {
        ctx.fillStyle = palette.bandColor
        ctx.fillRect(band.from, top, Math.max(1, band.to - band.from), bandHeight)
      }
    })

    // A hairline under and over the band row, so the strip reads as one object
    // rather than as a row of unrelated blocks on the card's background.
    ctx.strokeStyle = palette.plotBorderColor
    ctx.lineWidth = 1 / this.dpr
    ctx.beginPath()
    ctx.moveTo(0, snap(top, this.dpr))
    ctx.lineTo(this.width, snap(top, this.dpr))
    ctx.moveTo(0, snap(top + bandHeight, this.dpr))
    ctx.lineTo(this.width, snap(top + bandHeight, this.dpr))
    ctx.stroke()

    // The names, where there is room. Dropped rather than clipped or shrunk, for
    // `drawRuler`'s reason: a row of half-names is unreadable in a way an empty
    // band is not, and the readout under the strip answers "which one is this"
    // at any density.
    ctx.font = scaleFont(MINIMAP_FONT)
    ctx.textBaseline = 'middle'
    ctx.textAlign = 'center'
    ctx.fillStyle = palette.labelColor
    for (const band of bands) {
      const text = ctx.measureText(band.contig).width
      if (text + 6 > band.to - band.from) continue
      ctx.fillText(band.contig, (band.from + band.to) / 2, top + bandHeight / 2)
    }
    ctx.restore()
  }

  /**
   * The highlight(s), and the drag being made.
   *
   * A wash over the full height for the span, an edge on each side, and a solid
   * tab in the lane the span's axis owns: the top lane for rows, the bottom for
   * columns, **both** for a window — which is what a 1D viewport and an
   * on-diagonal block are. Off the diagonal the two tabs sit at different places
   * on opposite edges of the strip, which is the picture that says *two places*
   * without a legend; the readout under the strip names them.
   *
   * One colour for both, deliberately: they are both *where you are*, and two
   * hues would invite the reader to look for a meaning in the difference beyond
   * the axis, which the lane already carries.
   */
  private paintSpans(ctx: CanvasRenderingContext2D): void {
    const lane = scaleLength(MARK_LANE)
    const height = this.height
    // The drag replaces the location while it is out: what is about to happen is
    // more interesting than where you were, and two washes over each other would
    // read as a third state.
    const drag = this.drag
    const marks: Array<{ role: MinimapRole; from: number; to: number }> =
      drag === null
        ? this.spans
        : [
            {
              role: 'window',
              from: Math.min(drag.from, drag.to),
              to: Math.max(drag.from, drag.to),
            },
          ]

    for (const mark of marks) {
      const width = Math.max(MIN_SPAN, mark.to - mark.from)
      ctx.save()
      ctx.fillStyle = CROSSHAIR_COLOR
      ctx.globalAlpha = 0.16
      ctx.fillRect(mark.from, 0, width, height)
      ctx.globalAlpha = 1
      if (mark.role !== 'columns') ctx.fillRect(mark.from, 0, width, lane)
      if (mark.role !== 'rows') ctx.fillRect(mark.from, height - lane, width, lane)
      ctx.restore()
      drawGuide(ctx, mark.from, 0, height, CROSSHAIR_COLOR, this.dpr)
      drawGuide(ctx, mark.from + width, 0, height, CROSSHAIR_COLOR, this.dpr)
    }
  }

  // -------------------------------------------------------------------------
  // Arithmetic
  // -------------------------------------------------------------------------

  /**
   * The whole assembly across the strip's width.
   *
   * Made per use rather than held, and never zoomed: a minimap that could be
   * somewhere other than the whole genome would be a second viewport to keep in
   * step with the first.
   *
   * Every gesture and every span measures through **this** rather than through
   * anything a paint returned, which is `SequenceBar`'s rule and matters for the
   * same reason: hit-testing that depends on a paint having happened fails on
   * the first frame, in a detached element, and anywhere a canvas refuses a
   * context — which is every test in this suite.
   */
  private scale(): Scale {
    return new Scale([0, this.axis.unitEnd], this.width)
  }

  /** One range, projected onto the strip, never narrower than {@link MIN_SPAN}. */
  private spanOf(role: MinimapRole, range: MinimapRange): MinimapSpan | null {
    const segment = this.axis.segmentOf(range.contig)
    if (segment === null) return null
    const length = segment.contigLength
    const start = clamp(Math.min(range.start, range.end), 0, length)
    const end = clamp(Math.max(range.start, range.end), 0, length)
    const lo = this.axis.locusToUnit(range.contig, start)
    const hi = this.axis.locusToUnit(range.contig, end)
    if (lo === null || hi === null) return null
    const scale = this.scale()
    let from = scale.toPixel(lo)
    let to = scale.toPixel(hi)
    if (to - from < MIN_SPAN) {
      // Grown about its own middle, so the mark stays over the place it names,
      // then pushed back inside the strip at the two ends where that would put
      // half of it off the edge — a window on the first base of the first
      // sequence is the one a reader most often has.
      const middle = (from + to) / 2
      from = middle - MIN_SPAN / 2
      to = middle + MIN_SPAN / 2
      if (from < 0) {
        from = 0
        to = MIN_SPAN
      }
      if (to > this.width) {
        to = this.width
        from = this.width - MIN_SPAN
      }
    }
    return { role, contig: range.contig, start, end, from, to }
  }

  /** Where a pixel falls in one sequence, in that sequence's own base pairs. */
  private bpAt(x: number, segment: LocusSegment): number | null {
    const unit = Math.max(
      segment.unitStart,
      // A hair inside the far edge, or a pixel exactly on a boundary is read as
      // the *next* sequence — the same guard {@link dragged} needs.
      Math.min(segment.unitEnd - 1e-6, this.scale().toUnit(x)),
    )
    const locus = this.axis.unitToLocus(unit)
    return locus === null ? null : Math.round(locus.bp)
  }

  // -------------------------------------------------------------------------
  // The gesture
  // -------------------------------------------------------------------------

  private watchPointer(): void {
    const stage = this.stage
    const at = (event: MouseEvent): number => {
      const box = stage.getBoundingClientRect()
      return Math.max(0, Math.min(this.width, event.clientX - box.left))
    }

    let down: number | null = null
    let moved = false

    const host: Window | undefined = typeof window === 'undefined' ? undefined : window

    /**
     * Let go of the window.
     *
     * All three listeners are attached on `mousedown` and dropped here, which is
     * the one thing this card does differently from `SequenceBar` and it is
     * because of {@link destroy}: nothing tears a General-column card down, so a
     * `keydown` listener attached for the life of the card is one leaked
     * closure per navigation. Attached only while a press is in flight, an
     * abandoned card holds nothing on the window at all.
     */
    const release = (): void => {
      down = null
      host?.removeEventListener('mousemove', onMove)
      host?.removeEventListener('mouseup', onUp)
      host?.removeEventListener('keydown', onAbort, true)
    }

    const onMove = (event: MouseEvent): void => {
      if (down === null) return
      const x = at(event)
      if (!moved && Math.abs(x - down) < DRAG_SLOP) return
      moved = true
      this.drag = { from: down, to: x }
      this.syncCursor()
      this.paintText()
      this.schedule()
    }

    const onUp = (event: MouseEvent): void => {
      if (down === null) return
      const from = down
      const to = at(event)
      release()
      this.drag = null
      this.syncCursor()
      this.paintText()
      this.schedule()
      if (moved && Math.abs(to - from) >= DRAG_MIN) this.dragged(from, to)
      else this.clicked(from)
    }

    /**
     * Escape abandons the drag, opening nothing.
     *
     * **On the window and capturing**, which is the whole of the fix
     * `SequenceBar` carries the scar of: this listener on the canvas takes no
     * focus, so the key goes to whatever the reader last clicked and the drag
     * goes through anyway. The `mouseup` listener goes with it — a drag whose
     * press has been abandoned must not be finished by the release of the same
     * button.
     */
    const onAbort = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape' || down === null) return
      event.preventDefault()
      event.stopPropagation()
      moved = false
      release()
      this.drag = null
      this.syncCursor()
      this.paintText()
      this.schedule()
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
      // A press on the strip must not start a text selection across the card.
      // It cannot fold the card — the heading is the only thing that does that,
      // and it is a sibling — so there is nothing here to stop bubbling for.
      event.preventDefault()
      down = at(event)
      moved = false
      host?.addEventListener('mousemove', onMove)
      host?.addEventListener('mouseup', onUp)
      host?.addEventListener('keydown', onAbort, true)
    })

    // A card torn down mid-drag must not go on listening to the window.
    this.unsubscribes.push(release)
  }

  /**
   * What the pointer says the press would do — `SequenceBar`'s two classes.
   *
   * Written as classes rather than as an inline style so the two answers live in
   * the stylesheet beside the base cursor they qualify, and so a test can read
   * which one is in force without parsing a style attribute.
   */
  private syncCursor(): void {
    const dragging = this.drag !== null
    const overBand =
      !dragging &&
      this.hover !== null &&
      this.axis.unitEnd > 0 &&
      this.axis.segmentAt(this.scale().toUnit(this.hover)) !== null
    this.stage.classList.toggle('is-dragging', dragging)
    this.stage.classList.toggle('is-over-band', overBand)
  }

  /** A press that did not travel: the sequence under it, whole. */
  private clicked(x: number): void {
    if (this.axis.unitEnd <= 0) return
    const segment = this.axis.segmentAt(this.scale().toUnit(x))
    if (segment !== null) this.props.onOpenContig(segment.contig)
  }

  /**
   * A drag: the window it named, inside **one** sequence.
   *
   * `SequenceBar.dragged` line for line, and it must be: a region names one
   * contig — that is what the reader, `parseMetacoolerRange` and the crumb all
   * mean by one — so a drag that runs past the end of a sequence is clamped to
   * the sequence **the press landed in** rather than allowed to name two or
   * refused outright. Taking the start is what makes it predictable: the
   * sequence is decided when the button goes down, where the reader is looking.
   */
  private dragged(from: number, to: number): void {
    if (this.axis.unitEnd <= 0) return
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

/**
 * `chrII:201-600` — the window as a reader reads it (§26.1).
 *
 * Through `formatLocus`, which is the app's one writer of a window, so the
 * readout prints the string the locus box above it prints. It used to write the
 * 0-based half-open range this card thinks in, and the result was the same
 * window shown twice on one screen with two different starts, a base apart,
 * five centimetres from each other — with a tooltip claiming they were the same
 * numbers. What the card *emits* is still the machine form (see `dragged`): the
 * state and the hash carry cooler's grammar, and only this line is read.
 */
function span(range: MinimapRange): string {
  return formatLocus(range)
}

/** Whether a block's two ranges are the same place — that is, on the diagonal. */
function sameRange(a: MinimapRange, b: MinimapRange): boolean {
  return a.contig === b.contig && a.start === b.start && a.end === b.end
}

function keep(mark: MinimapSpan | null): MinimapSpan[] {
  return mark === null ? [] : [mark]
}

function clamp(value: number, low: number, high: number): number {
  return value < low ? low : value > high ? high : value
}
