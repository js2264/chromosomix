/**
 * The map as a figure: the Export card, and every drawing of the picture it
 * saves — a PNG at a resolution, a PDF of paths and text round one image, the
 * map's cell of a deck's figure, and the copy on the clipboard.
 *
 * One measurement of the figure's box serves all four ({@link FigureFrame}), so
 * no two of them can disagree about where a lane, the key or the caption goes;
 * and every part is redrawn at the scale asked for rather than enlarged from the
 * screen, so a 300 dpi figure has 300 dpi track names.
 *
 * Out of `ui/MatrixPanel.ts` because none of it reads the block or changes the
 * picture. It asks the panel's views to draw themselves into another context,
 * asks the panel what the figure is called and what its caption and keys say,
 * and writes the file. The panel keeps the wording, which is read off its state;
 * this keeps the card, the format and resolution chosen in it, the deck an
 * export is routed to, and the drawing.
 */

import type { CellFigure } from '../panels/deckFigure'
import type { HeatmapView } from '../render/heatmap'
import type { AnnotationLanes, LaneEdge, LaneGeometry } from './AnnotationLanes'
import { FIGURE_BACKGROUND, readCanvasPalette } from './canvasPalette'
import { KEYS, withKey } from './commands'
import { el, fmt } from './dom'
import {
  EXPORT_DPI_CHOICES,
  EXPORT_FORMATS,
  type ExportFormat,
  canvasToPng,
  chooseSaveTarget,
  copyPngToClipboard,
  exportBaseName,
  fileStamp,
  largestDpiThatFits,
  scaleForDpi,
} from './export'
import { captionField, getExportPrefs } from './exportPrefs'
import { exportRow } from './exportRow'
import { cardTitle } from './icons'
import type { DeckExport, MatrixPanel } from './MatrixPanel'
import { scaleFont, scaleLength } from './textScale'
import { VectorPage } from './vector'

/**
 * What a figure needs of the panel it is a figure of: the two views that draw
 * themselves into it, the canvas whose ink the caption borrows, and the panel's
 * own say on what the figure is called and what its caption and keys read.
 */
export interface FigureHost {
  /** The map's renderer, which redraws the plot into any context at any scale. */
  readonly heatmap: HeatmapView
  /** The lane stacks, which redraw themselves round it. */
  readonly lanes: AnnotationLanes
  /** The map's canvas, read for the page's colours ({@link readCanvasPalette}). */
  readonly canvas: HTMLCanvasElement
  /** The lanes' view of the frame on screen, which a figure draws without its pointer. */
  laneGeometry(): LaneGeometry
  /** Draw the keys onto the figure where they stand on screen: `MatrixPanel.renderKeys`. */
  renderKeys(ctx: CanvasRenderingContext2D, scale: number, origin: { x: number; y: number }): void
  /** What the figure says it is: {@link MatrixPanel.figureCaption}. */
  caption(now: Date): { title: string; detail: string }
  /** What the figure is called, for the name of the file it is saved as. */
  exportName(): string
}

/** The Export card, and every figure drawn for it. */
export class MapFigure {
  /**
   * The Export card: resolution, format, save, copy — what the panel offers as
   * {@link MatrixPanel.exportEl}.
   */
  readonly card: HTMLElement
  /** Where this panel's export goes while it leads a deck; see {@link setDeckExport}. */
  private deckExport: DeckExport | null = null
  /** The Export card's clipboard button, re-titled when a deck takes the key. */
  private copyButton: HTMLButtonElement | null = null
  /** The Export card's resolution, away while the format is a vector page; see {@link syncExportRow}. */
  private dpiSelect: HTMLSelectElement | null = null
  private readonly exportStatus: HTMLElement
  private exportDpi = 300
  private exportFormat: ExportFormat = 'pdf'
  private readonly heatmap: HeatmapView
  private readonly lanes: AnnotationLanes
  private readonly canvas: HTMLCanvasElement

  constructor(private readonly host: FigureHost) {
    this.heatmap = host.heatmap
    this.lanes = host.lanes
    this.canvas = host.canvas

    // Saving a figure is one question with three parts — how fine, what file,
    // go — so it is one row: resolution, format, and the button that acts on
    // both. Two buttons labelled by format made the choice of file into the
    // action itself, which left the resolution stranded in a row of its own two
    // lines above the thing it applied to.
    const row = exportRow({
      dpi: {
        choices: EXPORT_DPI_CHOICES,
        value: this.exportDpi,
        onChange: (dpi) => {
          this.exportDpi = dpi
          this.syncExportRow()
        },
      },
      formats: EXPORT_FORMATS,
      format: this.exportFormat,
      formatTitle:
        'PDF is a drawing: the cells as one lossless image, and every axis, label, track, key and ' +
        'caption round them as paths and text, at no resolution at all. PNG is the whole figure as ' +
        'pixels, at the resolution beside it.',
      onFormat: (format) => {
        this.exportFormat = format as ExportFormat
        this.syncExportRow()
      },
      onSave: () => void this.savePlot(),
      onCopy: () => void this.copyPlot(),
      saveTitle: withKey('Save the figure, in the format chosen beside this', KEYS.savePlot),
      copyTitle: withKey('Copy the figure as a PNG, ready to paste', KEYS.copyPlot),
    })
    this.exportStatus = row.note
    this.copyButton = row.parts.copy
    this.dpiSelect = row.parts.dpi
    this.syncExportRow()
    // Under the row it qualifies: whether the saved figure says what it is.
    row.body.append(captionField())

    // Its own card, and the first one, because saving the figure is not a
    // property of the picture — it is the thing a reader does *after* every
    // other control on this panel is where they want it. Buried at the foot of
    // the Plot card it was three folds and a scroll away from the top of a
    // column whose other two cards are settings; a reader who came to export
    // had to walk past everything they had already decided.
    this.card = el(
      'div',
      { class: 'controls-card' },
      cardTitle('Export', 'download', 'controls-title'),
      row.body,
    )
  }

  /**
   * Save the map as a figure — the `S` key, and the button in the Export card.
   *
   * In the format and at the resolution that card is set to, because a shortcut
   * that exported something other than the button beside it would be a second
   * export to keep in step with the first.
   */
  savePlot(): void {
    void this.saveFigure()
  }

  /**
   * With a deck up, the figure is the deck. The hook says whether it took the
   * export — `false` is a deck of one map, which is this panel's own figure.
   */
  private async saveFigure(): Promise<void> {
    if (this.deckExport !== null && (await this.deckExport.save(this.exportFormat, this.exportDpi))) {
      this.exportStatus.textContent = 'saved the deck'
      return
    }
    await this.save(this.exportFormat)
  }

  /**
   * Route this panel's export to the deck it leads, or back to itself.
   *
   * Set by `panels/PanelDeck.ts` on the lead: the Export card and the `S` key
   * are this panel's, and with five maps beside it a reader pressing either
   * wants the arrangement they made, not the first cell of it.
   */
  setDeckExport(hook: DeckExport | null): void {
    this.deckExport = hook
    this.syncExportRow()
  }

  /**
   * The Export card's row, said again after a change of format, resolution or
   * deck.
   *
   * A vector page has no resolution, so the resolution *goes* while PDF is
   * chosen rather than sitting there greyed out — the 1D browser's card has
   * always done this, and this one kept it on screen for a PDF it said was an
   * image. The clipboard takes a PNG whatever the format beside it says, so
   * while the resolution is away the copy's tooltip names the one it will use:
   * a reader pasting into a slide is otherwise rasterised at a number they can
   * no longer see.
   *
   * And the key moves with the act. `Ctrl+C` copies the whole deck once there
   * is one (`Session`'s map-copy), so the clipboard button — which copies *this
   * map* — stopped being the thing the key does, while still printing it. Two
   * buttons on screen claiming one shortcut and doing different things is
   * worse than one of them going unlabelled.
   */
  private syncExportRow(): void {
    const vector = this.exportFormat === 'pdf'
    if (this.dpiSelect !== null) this.dpiSelect.hidden = vector
    if (this.copyButton === null) return
    const png = vector ? `as a PNG at ${this.exportDpi} dpi` : 'as a PNG'
    this.copyButton.title =
      this.deckExport === null
        ? withKey(`Copy the figure ${png}, ready to paste`, KEYS.copyPlot)
        : `Copy this map ${png}, ready to paste. Ctrl+C copies the whole deck.`
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
      if (this.deckExport !== null && (await this.deckExport.copy(this.exportDpi))) {
        this.exportStatus.textContent = 'copied the deck'
        return
      }
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
   * The figure's box, measured once for every drawing of it — the PNG, the PDF
   * and the deck's cell of it — so no two of them can disagree about where
   * anything goes.
   *
   * The lanes are part of the figure, so they are part of its box. A track
   * exported without them is a picture of a claim with its evidence cropped
   * off. The two that come *before* the map also move it: everything else on
   * the page is placed against `origin` rather than against the page. No column
   * for a legend: the key is drawn *in* the map's corner, exactly where it is
   * on screen, so an exported figure is the same picture at a different
   * resolution rather than a rearrangement of it.
   *
   * The caption is measured here because it decides how tall the figure is — a
   * long provenance line on a narrow figure wraps rather than running off the
   * edge — against the *drawn* frame rather than the page: the plot is inset by
   * however much its labels need, and by whatever stack stands to its left, and
   * a caption flush with the page's edge hangs off the left of the picture it
   * belongs to. None at all where the Export card's *caption* is off: the figure
   * then ends at the foot of its lowest lane.
   */
  private figureFrame(now: Date, measure: CanvasRenderingContext2D): FigureFrame {
    const plot = this.heatmap.cssSize
    const stacks = this.laneStacks()
    const origin = { x: stacks.left, y: stacks.top }
    const width = stacks.left + plot.width + stacks.right
    const body = stacks.top + plot.height + stacks.bottom
    const left = origin.x + this.heatmap.dataRect.x
    const caption = this.host.caption(now)
    const lines = getExportPrefs().caption ? captionLines(measure, caption, Math.max(120, width - left)) : []
    return { origin, width, body, height: body + captionHeightOf(lines), left, caption, lines }
  }

  /**
   * The figure, drawn from the context's own origin at `scale` device pixels
   * per CSS pixel: the plot, the lanes round it, the key in its corner and the
   * caption under it. Everything but the page under it, which the two
   * destinations lay differently — see {@link exportCanvas} and
   * {@link drawVector}.
   *
   * Every part is *redrawn* at the scale rather than blown up from the screen's
   * canvases, so a 300 dpi figure has 300 dpi track names; and every part sets
   * an absolute transform from the origin, which is what lets a vector page
   * place the whole figure anywhere on itself (`VectorPage.setOrigin`).
   */
  private paintFigure(ctx: CanvasRenderingContext2D, scale: number, frame: FigureFrame): void {
    // The plot draws from `origin` and clears its own box as it goes, so it
    // goes before anything that could share that box.
    this.heatmap.renderTo(ctx, scale, frame.origin)
    // Placed exactly as the grid places them — around the plot, on all four
    // sides.
    this.lanes.renderInto(ctx, this.figureGeometry(), scale, frame.origin)

    this.host.renderKeys(ctx, scale, frame.origin)

    // The caption is *below* the figure, which is where a caption goes.
    if (frame.lines.length > 0) {
      const palette = readCanvasPalette(this.canvas)
      ctx.setTransform(scale, 0, 0, scale, 0, 0)
      ctx.textBaseline = 'alphabetic'
      ctx.textAlign = 'left'
      let y = frame.body + scaleLength(CAPTION_TOP)
      for (const line of frame.lines) {
        const height = scaleLength(line.strong ? CAPTION_TITLE_LINE : CAPTION_DETAIL_LINE)
        ctx.font = scaleFont(line.strong ? CAPTION_TITLE_FONT : CAPTION_DETAIL_FONT)
        ctx.fillStyle = palette.labelColor
        // Baseline a little above the line's foot, so the two lines read as one
        // block rather than as two evenly spaced rows.
        ctx.fillText(line.text, frame.left, y + height - 4)
        y += height
      }
    }
    ctx.setTransform(1, 0, 0, 1, 0, 0)
  }

  /**
   * The figure as one canvas: the plot with its lanes, key and caption, on an
   * opaque page background, at `dpi` dots per inch.
   *
   * Composed from the live views rather than copied off the screen — each
   * redraws itself into this canvas at the export scale, so the labels, the
   * hairlines and the tick marks are drawn at that resolution instead of being
   * enlarged. What is *framed* is whatever is framed on screen, pan and zoom
   * included.
   */
  exportCanvas(dpi: number, now = new Date()): HTMLCanvasElement {
    const scale = scaleForDpi(dpi)
    const out = document.createElement('canvas')
    const ctx = out.getContext('2d')
    if (ctx === null) throw new Error('Could not acquire a 2d context for the export canvas.')

    // Measured before the canvas is sized: setting `width`/`height` resets the
    // context, so nothing is drawn until after.
    const frame = this.figureFrame(now, ctx)
    const { width, height } = frame

    // Pre-flight, because the failure mode is silent: past a browser's canvas
    // cap, setting `width`/`height` leaves a blank canvas rather than throwing,
    // so the export lands as a white rectangle with no explanation. Asked once
    // the caption is measured, because the caption is part of the height, and
    // a figure that fits without it can fail with it.
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

    this.paintFigure(ctx, scale, frame)

    // Opaque, and white whatever the theme on screen (§7.2). A transparent PNG
    // of a white-on-white contact map is a blank rectangle in every viewer
    // that composites onto black, and the ink is the light palette's — the
    // centre column wears it in either theme. Painted *behind* what is
    // already there, since the plot cleared its own box.
    ctx.globalCompositeOperation = 'destination-over'
    ctx.fillStyle = FIGURE_BACKGROUND
    ctx.fillRect(0, 0, out.width, out.height)
    ctx.globalCompositeOperation = 'source-over'
    return out
  }

  /**
   * The figure as one cell of the deck's (§16.5): the canvas above for its
   * PNG, at the deck's resolution, and the vector drawing below for its PDF —
   * the matrix the one image, everything round it paths and text — from one
   * measurement of its box.
   */
  deckFigure(now: Date): CellFigure {
    const measure = document.createElement('canvas').getContext('2d')
    if (measure === null) throw new Error('Could not measure the caption.')
    const frame = this.figureFrame(now, measure)
    return {
      width: frame.width,
      height: frame.height,
      raster: (dpi) => this.exportCanvas(dpi, now),
      vector: (ctx) => this.drawVector(ctx, frame),
    }
  }

  /**
   * The figure onto a vector page, from the context's origin: the page under
   * it first — a PDF is drawn in order and has no `destination-over` — then
   * the figure at 1:1.
   */
  private drawVector(ctx: CanvasRenderingContext2D, frame: FigureFrame): void {
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.fillStyle = FIGURE_BACKGROUND
    ctx.fillRect(0, 0, frame.width, frame.height)
    this.paintFigure(ctx, 1, frame)
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
    const measure = document.createElement('canvas').getContext('2d')
    if (measure === null) throw new Error('Could not measure the caption.')
    const frame = this.figureFrame(now, measure)
    const page = new VectorPage(frame.width, frame.height)
    this.drawVector(page.ctx, frame)
    return page.toBlob({ title: frame.caption.title, created: now })
  }

  /** Save the figure. The status line under the row reports what happened. */
  private async save(format: ExportFormat): Promise<void> {
    const now = new Date()
    // The stamp is in the name because two exports of the same view are the
    // same filename otherwise, and the second one silently becomes
    // `figure (1).png` in a downloads folder nobody can later put in order. The
    // resolution is in a PNG's name and not a PDF's: a vector page has none.
    const dpi = format === 'png' ? `-${this.exportDpi}dpi` : ''
    const name = `${exportBaseName(this.host.exportName())}-${fileStamp(now)}${dpi}.${format}`
    // Where it goes first, while the press is still the reader's (`ui/export.ts`).
    const target = await chooseSaveTarget(name, format === 'png' ? 'image/png' : 'application/pdf')
    if (target === null) return
    this.exportStatus.textContent = `saving ${target.name}…`
    try {
      const blob =
        format === 'png'
          ? await canvasToPng(this.exportCanvas(this.exportDpi, now))
          : await this.vectorFigure(now)
      await target.write(blob)
      this.exportStatus.textContent = `${target.name} · ${fmt.bytes(blob.size)}`
    } catch (err) {
      // Nothing here is worth an error screen: the view is intact and the user
      // can try a smaller size. Say what failed and stay put.
      this.exportStatus.textContent =
        err instanceof Error ? `export failed: ${err.message}` : 'export failed'
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
    const live = this.host.laneGeometry()
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
}

/**
 * Caption geometry, in CSS pixels.
 *
 * Quiet on purpose: the caption says what the figure is and where it came from,
 * and it is read once, after the picture. At fifteen pixels and semibold in the
 * page's own ink the region was the largest type on the page — larger than the
 * axis it names — so the eye went to the words under the map before the map.
 * Now it is set just under the axis labels and in their grey, the subject a
 * little heavier than the provenance under it; still read without leaning in.
 */
const CAPTION_TOP = 10
const CAPTION_TITLE_LINE = 15
const CAPTION_DETAIL_LINE = 13
const CAPTION_TITLE_FONT = '600 11px system-ui, sans-serif'
const CAPTION_DETAIL_FONT = '10px system-ui, sans-serif'

/**
 * A figure's box and what is written under it, measured once for the PNG, the
 * PDF and the deck's cell alike — see `MapFigure.figureFrame`.
 */
interface FigureFrame {
  /** Where the plot's own top-left goes: past the lane stacks above and to its left. */
  origin: { x: number; y: number }
  width: number
  /** The plot and its lanes, without the caption. */
  body: number
  /** The whole figure, caption included. */
  height: number
  /** Where the caption's lines start: under the data, not under the page's edge. */
  left: number
  caption: { title: string; detail: string }
  lines: CaptionLine[]
}

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
