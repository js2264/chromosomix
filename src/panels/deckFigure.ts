/**
 * The deck as one figure (§16.5): every cell's picture, placed as the grid
 * places it, written as a PNG or as one vector page.
 *
 * The PDF used to be the PNG on a page — the composed raster, drawn at 300
 * dpi and wrapped in a `VectorPage` — on the argument that a deck is an
 * arrangement of pictures. Every one of those pictures already had a drawing of
 * its own: a map's figure is a page of paths round one image of its cells
 * (`MatrixPanel`), the tracks are paths (`BrowserView`), a model is paths
 * (`structure/painter.ts`). So the deck's PDF threw away exactly the thing each
 * panel's own PDF exists to keep, and a reader assembling a figure of six
 * panels got six photographs of axes and track names in a file that could not
 * be restyled. Now a cell is drawn onto the deck's page as itself.
 *
 * **One composition, two destinations.** The layout — how wide a cell is, how
 * much air between two, where the *n*-th stands — is {@link deckLayout}, and
 * the drawing is {@link paintDeck}, which lays the page down and asks each cell
 * to draw itself at its place. The PNG and the PDF differ only in what *at its
 * place* means: on a canvas a cell is rasterised on its own and drawn in at
 * that offset, since nothing a cell draws with knows where it is on somebody
 * else's canvas; on a page, `VectorPage.setOrigin` puts everything the cell
 * draws there, as itself. So the two files cannot disagree about the
 * arrangement — there is one arrangement, and two ways of putting a cell into
 * it.
 *
 * The deck's own furniture is the page under the cells and nothing else: each
 * cell's picture carries its own caption, key and frame, as on screen, and a
 * cell left empty is left empty rather than closed up — it is part of the
 * arrangement, and a figure that silently reflowed on the way to disk would
 * not be the picture that was on screen.
 */

import { scaleForDpi } from '../ui/export'
import { VectorPage } from '../ui/vector'

/**
 * One cell's picture, as the deck's figure asks for it.
 *
 * Its size first, because the grid is laid out from every cell's before any
 * is drawn; then the two drawings, each from the cell's own top-left.
 */
export interface CellFigure {
  /** The picture's size, in CSS pixels. */
  readonly width: number
  readonly height: number
  /**
   * The picture as pixels at `dpi`, on a canvas of its own — the PNG's, and
   * the clipboard's. `null` where the page will not give it a canvas; it may
   * throw past what a browser will rasterise, which leaves its cell empty.
   */
  raster(dpi: number): HTMLCanvasElement | null
  /**
   * The picture as paths and text — a map's matrix the one image on it — drawn
   * into `ctx` from its origin at 1:1. `ctx` is the deck's page with its
   * origin at the cell's place, so every absolute transform the cell sets is
   * the cell's own.
   */
  vector(ctx: CanvasRenderingContext2D): void
}

/** The air between cells, as a share of a cell's width. */
export const DECK_FIGURE_GAP = 0.02

/** Where everything on the deck's figure goes, in CSS pixels. */
export interface DeckLayout {
  width: number
  height: number
  cellWidth: number
  cellHeight: number
  gap: number
  columns: number
  rows: number
  /** The top-left corner of the cell at `index`, in reading order. */
  at(index: number): { x: number; y: number }
}

/**
 * The grid the reader drew, with every cell the size of the largest so the
 * columns line up.
 *
 * `cells` is in reading order, an empty cell `null` and still a cell.
 */
export function deckLayout(
  cells: ReadonlyArray<{ readonly width: number; readonly height: number } | null>,
  columns: number,
): DeckLayout {
  const across = Math.max(1, Math.floor(columns))
  const cellWidth = Math.max(1, ...cells.map((cell) => cell?.width ?? 0))
  const cellHeight = Math.max(1, ...cells.map((cell) => cell?.height ?? 0))
  const rows = Math.max(1, Math.ceil(cells.length / across))
  const gap = cellWidth * DECK_FIGURE_GAP
  return {
    width: across * cellWidth + (across - 1) * gap,
    height: rows * cellHeight + (rows - 1) * gap,
    cellWidth,
    cellHeight,
    gap,
    columns: across,
    rows,
    at: (index) => ({
      x: (index % across) * (cellWidth + gap),
      y: Math.floor(index / across) * (cellHeight + gap),
    }),
  }
}

/** Where the composition draws: a context in the layout's CSS pixels, and a way to put a cell into it. */
interface DeckSurface {
  ctx: CanvasRenderingContext2D
  place(figure: CellFigure, x: number, y: number): void
}

/**
 * The figure, onto a surface: the page under everything, then every cell at
 * its place. The one drawing both files are made of.
 */
function paintDeck(
  surface: DeckSurface,
  figures: ReadonlyArray<CellFigure | null>,
  layout: DeckLayout,
  background: string,
): void {
  const { ctx } = surface
  ctx.fillStyle = background
  ctx.fillRect(0, 0, layout.width, layout.height)
  figures.forEach((figure, index) => {
    if (figure === null) return
    const { x, y } = layout.at(index)
    surface.place(figure, x, y)
  })
}

/**
 * The deck as one canvas at `dpi` — the PNG, and what ⌘C puts on the
 * clipboard. `null` only where there is no 2d context to draw into, which is a
 * browser that cannot export at all rather than a deck that cannot.
 */
export function rasterDeck(
  figures: ReadonlyArray<CellFigure | null>,
  columns: number,
  background: string,
  dpi: number,
): HTMLCanvasElement | null {
  const layout = deckLayout(figures, columns)
  const scale = scaleForDpi(dpi)
  const out = document.createElement('canvas')
  out.width = Math.max(1, Math.round(layout.width * scale))
  out.height = Math.max(1, Math.round(layout.height * scale))
  const ctx = out.getContext('2d')
  if (ctx === null) return null
  ctx.setTransform(scale, 0, 0, scale, 0, 0)
  paintDeck(
    {
      ctx,
      place: (figure, x, y) => {
        let drawn: HTMLCanvasElement | null = null
        try {
          drawn = figure.raster(dpi)
        } catch {
          // One panel past what a browser will rasterise must not take the
          // other five with it; the gap says which one, and every other cell
          // is right.
          return
        }
        if (drawn === null) return
        ctx.save()
        ctx.setTransform(1, 0, 0, 1, 0, 0)
        ctx.drawImage(drawn, Math.round(x * scale), Math.round(y * scale))
        ctx.restore()
      },
    },
    figures,
    layout,
    background,
  )
  return out
}

/**
 * The deck as one vector page — the PDF. Each cell is drawn as its own PDF
 * would draw it, at its place, so the only raster on the page is each map's
 * cells.
 */
export function vectorDeck(
  figures: ReadonlyArray<CellFigure | null>,
  columns: number,
  background: string,
): VectorPage {
  const layout = deckLayout(figures, columns)
  const page = new VectorPage(layout.width, layout.height)
  const ctx = page.ctx
  paintDeck(
    {
      ctx,
      place: (figure, x, y) => {
        page.setOrigin(x, y)
        // Saved round the cell, so the clip, the alpha and the dash a cell
        // leaves behind are not the next cell's.
        ctx.save()
        ctx.setTransform(1, 0, 0, 1, 0, 0)
        try {
          figure.vector(ctx)
        } catch {
          // As above: a cell that cannot draw is a gap, not a lost figure.
        } finally {
          ctx.restore()
          page.setOrigin(0, 0)
        }
      },
    },
    figures,
    layout,
    background,
  )
  return page
}
