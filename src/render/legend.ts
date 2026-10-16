/**
 * The key in the corner of a map: what the numbers are, and where the colour
 * scale begins and ends.
 *
 * It replaces a colourbar — a 256-band strip with `1-2-5` ticks up its side, in
 * a column of its own beside the plot — and the two changes are worth stating
 * apart, because only one of them is about space.
 *
 * **Where it is.** The strip was outside the picture and cost between 5.5 and
 * 7 rem of the width it was standing next to. On one map that is a wide margin;
 * in a deck of four it is four of them, and the maps a reader assembled a deck
 * to compare end up a third narrower than the window could have drawn them. A
 * key in the top-right corner *of* the map costs the map nothing and is where a
 * reader already looks for one — it is where every figure in the literature
 * puts it.
 *
 * **What it says.** The strip was labelled in **untransformed** units, and that
 * was a deliberate old decision: a reader reads contact counts, not `log1p` of
 * contact counts, so the ticks were inverse-transformed on their way out and
 * came out unevenly spaced, the spacing being the transform made visible.
 *
 * It is the wrong decision as soon as the reader has *typed* a bound. The clip
 * boxes have always been in transformed units — `vmax = 8` under `log1p` — and
 * so has the hash. So a reader who set `[-1, 1]` on a `log2` O/E map read a
 * legend saying `0.5` and `2` and had to invert the transform in their head to
 * check that the picture was the one they asked for. Worse in a figure: the
 * caption said `log2` and the numbers beside it were not. The key now says
 * exactly what the boxes say, and the title carries the transform so the two
 * together are still a complete statement of what a colour means.
 *
 * The strip itself is gone with the ticks, and the ramp stays: **short, and
 * between the two numbers it runs between** — `-4.18 ▬ -1.05`. For a while it
 * was two squares, the ramp's two ends, on the argument that the colours
 * between them were information a reader takes out of the picture rather than
 * out of the legend. They are not, on a ramp that is not a straight line: the
 * default runs white, yellow, red, black, and which of the four a cell halfway
 * up is was the one thing the two ends could not say.
 */

import type { ColorScale, Transform } from '../types'
import { colormapCss } from './colormaps'

// ---------------------------------------------------------------------------
// Counts, as a reader reads them
// ---------------------------------------------------------------------------

function trimZeros(s: string): string {
  return s.includes('.') ? s.replace(/\.?0+$/, '') : s
}

function threeSig(x: number): string {
  const a = Math.abs(x)
  return trimZeros(a >= 100 ? x.toFixed(0) : a >= 10 ? x.toFixed(1) : x.toFixed(2))
}

/**
 * Format a contact count for a tick label: plain below 10 000, then `k`/`M`/`G`
 * suffixes. Deterministic and locale-independent, so a screenshot in the paper
 * and a reader's browser produce the same string.
 */
export function formatCount(v: number): string {
  if (!Number.isFinite(v)) return '—'
  const a = Math.abs(v)
  if (a === 0) return '0'
  if (a >= 1e12) return `${threeSig(v / 1e12)}T`
  if (a >= 1e9) return `${threeSig(v / 1e9)}G`
  if (a >= 1e6) return `${threeSig(v / 1e6)}M`
  if (a >= 1e4) return `${threeSig(v / 1e3)}k`
  if (a >= 1) return Number.isInteger(v) ? String(v) : threeSig(v)
  return trimZeros(v.toPrecision(2))
}


/**
 * What the key shows, computed from the scale that is actually drawn.
 *
 * Values are in **transformed** units — the ones the clip boxes and the hash
 * are in — and the labels are formatted by the caller's own number trimmer, so
 * the key and the boxes can never print the same bound two ways.
 */
export interface KeyContent {
  /** e.g. `Balanced O/E (log2)`. */
  title: string
  /**
   * A second, quieter line under the title — the cell size, today.
   *
   * Separate from {@link title} rather than appended to it because the two are
   * different kinds of fact and want different weight: the title says what the
   * numbers *are*, and this says what one square of the picture *covers*. Run
   * together they read as one long name, and the resolution is the half a reader
   * scanning a figure is looking for.
   *
   * Absent where there is nothing to say, which is a block whose cells are one
   * sequence each.
   */
  note?: string
  /** The scale's ends, in transformed units. */
  lo: number
  hi: number
  loLabel: string
  hiLabel: string
  /** The two ends of the ramp, as CSS colours. */
  loColor: string
  hiColor: string
  /**
   * The ramp from the lower end to the upper, as CSS colours evenly spaced
   * along it — {@link KEY_METRICS}`.ramp` of them, one per CSS pixel of the bar,
   * so the export can draw it band by band and the screen as a gradient
   * through the same stops.
   */
  ramp: readonly string[]
}

/**
 * The name of what is in the cells, with the transform on the end.
 *
 * Composed rather than picked, because a cell has been through up to three
 * things and a reader needs all of them: what was read (`count`, `balanced`, a
 * column, a normalisation), what was done to it (`O/E`, a ratio against a
 * second file), and how it is being drawn (`log2`). Naming only the outermost
 * gave `O/E (log2)` for a map whose O/E was measured on balanced counts, which
 * is a different picture from the same words over raw ones.
 *
 * `none` is left off: "no transform" is not a fact a figure needs to carry, and
 * a key that says it on every raw map trains the eye to skip the line.
 */
export function keyTitle(
  parts: readonly string[],
  transform: Transform,
  /**
   * A mark before the name, kept out of the capitalisation.
   *
   * There is one of these per file when two are compared: the two keys carry
   * the same words — they share a colormap, so they share a scale name — and
   * what has to differ is which triangle each measures, which a glyph says in
   * the width a file name would not fit into.
   */
  prefix = '',
): string {
  const body = parts.filter((part) => part !== '').join(' ')
  const named = body === '' ? 'value' : body
  const capitalised = named.charAt(0).toUpperCase() + named.slice(1)
  const withTransform = transform === 'none' ? capitalised : `${capitalised} (${transform})`
  return prefix === '' ? withTransform : `${prefix} ${withTransform}`
}

/**
 * The key for a scale, given what its numbers are called.
 *
 * `vmin`/`vmax` arrive as `NaN` where nothing has clipped them — that is how
 * {@link ColorScale} asks for the default — so a caller passes the *effective*
 * scale, the one the raster was drawn with, rather than the configured one.
 * A non-finite bound is still handled rather than trusted: it would otherwise
 * print `NaN` in the corner of a map that draws perfectly well.
 */
export function keyContent(
  scale: ColorScale,
  title: string,
  format: (value: number) => string,
): KeyContent {
  const lo = Number.isFinite(scale.vmin) ? scale.vmin : 0
  const hi = Number.isFinite(scale.vmax) ? scale.vmax : 1
  return {
    title,
    lo,
    hi,
    loLabel: format(lo),
    hiLabel: format(hi),
    loColor: colormapCss(scale.colormap, 0),
    hiColor: colormapCss(scale.colormap, 1),
    ramp: Array.from({ length: KEY_METRICS.ramp }, (_, i) =>
      colormapCss(scale.colormap, i / (KEY_METRICS.ramp - 1)),
    ),
  }
}

/** How the key is drawn, in CSS pixels, so screen and export agree. */
export const KEY_METRICS = {
  /** The bar's length, in CSS pixels: short, because the numbers carry the scale. */
  ramp: 48,
  /** Its thickness, which is the row's height beside the two numbers. */
  rampHeight: 10,
  gap: 4,
  padding: 5,
  titleSize: 10,
  valueSize: 10,
  /**
   * The resolution line under the title — smaller, because it is a footnote to
   * the name rather than a second name.
   */
  noteSize: 9,
  lineGap: 3,
  /** Between the title and its note. Tighter than {@link lineGap}: the two lines
   * are one block of text, and the ramp under them is a different thing. */
  noteGap: 1,
} as const

/**
 * Draw the key into a canvas, for an export.
 *
 * The screen's key is DOM — its two numbers are editable, and a canvas cannot
 * hold a caret — so this is a second renderer, and the pair is kept honest by
 * both taking a {@link KeyContent} and reading {@link KEY_METRICS}. What must
 * match is the *content*; that a figure's key is drawn a pixel differently from
 * the screen's is not something anybody can be misled by.
 *
 * Drawn from its top-right corner, because that is where it goes and because
 * its width depends on numbers only this function has measured.
 *
 * @returns the box it occupied, so a caller can lay something out beside it.
 */
export function drawKey(
  ctx: CanvasRenderingContext2D,
  right: number,
  top: number,
  content: KeyContent,
  options: { font: string; textColor: string; background: string; borderColor: string },
): { x: number; y: number; width: number; height: number } {
  const m = KEY_METRICS
  ctx.save()
  ctx.textBaseline = 'top'
  ctx.textAlign = 'left'
  ctx.font = `${m.titleSize}px ${options.font}`
  const titleWidth = ctx.measureText(content.title).width
  const note = content.note ?? ''
  ctx.font = `${m.noteSize}px ${options.font}`
  const noteWidth = note === '' ? 0 : ctx.measureText(note).width
  const noteBlock = note === '' ? 0 : m.noteGap + m.noteSize
  ctx.font = `${m.valueSize}px ${options.font}`
  const loWidth = ctx.measureText(content.loLabel).width
  const hiWidth = ctx.measureText(content.hiLabel).width
  const rampWidth = m.ramp
  const rowWidth = loWidth + m.gap + rampWidth + m.gap + hiWidth
  const width = Math.max(titleWidth, noteWidth, rowWidth) + m.padding * 2
  const height =
    m.titleSize + noteBlock + m.lineGap + Math.max(m.rampHeight, m.valueSize) + m.padding * 2
  const x = right - width
  const y = top

  ctx.fillStyle = options.background
  ctx.strokeStyle = options.borderColor
  ctx.lineWidth = 1
  ctx.fillRect(x, y, width, height)
  ctx.strokeRect(x + 0.5, y + 0.5, width - 1, height - 1)

  ctx.fillStyle = options.textColor
  ctx.font = `${m.titleSize}px ${options.font}`
  ctx.fillText(content.title, x + m.padding, y + m.padding)
  if (note !== '') {
    ctx.font = `${m.noteSize}px ${options.font}`
    // The same ink as the title. A greyed line in a figure survives one
    // reproduction and not two, and this is the number a methods section quotes.
    ctx.fillText(note, x + m.padding, y + m.padding + m.titleSize + m.noteGap)
  }

  const rowY = y + m.padding + m.titleSize + noteBlock + m.lineGap
  const mid = rowY + Math.max(m.rampHeight, m.valueSize) / 2
  let cursor = x + m.padding + Math.max(0, (width - m.padding * 2 - rowWidth) / 2)
  ctx.font = `${m.valueSize}px ${options.font}`
  ctx.textBaseline = 'middle'
  ctx.fillText(content.loLabel, cursor, mid)
  cursor += loWidth + m.gap
  // The bar band by band, one per stop: a PDF page has no linear gradient
  // (`ui/vector.ts`), and the same bands in a PNG are the same picture. Each but
  // the last runs a quarter pixel into the next, so no seam of the box's colour
  // shows between two of them at any scale.
  const rampY = mid - m.rampHeight / 2
  const stops = content.ramp.length > 0 ? content.ramp : [content.loColor, content.hiColor]
  const band = rampWidth / stops.length
  stops.forEach((colour, i) => {
    ctx.fillStyle = colour
    ctx.fillRect(cursor + i * band, rampY, band + (i < stops.length - 1 ? 0.25 : 0), m.rampHeight)
  })
  ctx.strokeRect(cursor + 0.5, rampY + 0.5, rampWidth - 1, m.rampHeight - 1)
  cursor += rampWidth + m.gap
  ctx.fillStyle = options.textColor
  ctx.fillText(content.hiLabel, cursor, mid)
  ctx.restore()

  return { x, y, width, height }
}
