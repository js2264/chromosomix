/**
 * The colours a canvas borrows from the stylesheet it is drawn beside.
 *
 * A canvas cannot read a custom property, so every surface that paints its own
 * pixels — the map and its lanes, the minimap, the sequence bar, a structure
 * cell, the 1D browser — asks for the page's colours here, off an element where
 * it is mounted, and asks again when the theme moves. One reader, so that a
 * label, its halo and a frame are the same three colours on every picture in
 * the app, and a figure exported from any of them is written in the same ink.
 *
 * It lived in `ui/MatrixPanel.ts`, which had four modules that draw nothing of
 * the map's import the map panel to learn what grey a label is.
 */

/**
 * The colours the canvas borrows from the stylesheet.
 *
 * Only three: the labels, their halo, and the plot frame. The separator and
 * crosshair colours are `ops/show.py`'s and stay fixed, so a screenshot from
 * the browser and a figure from the CLI remain the same image.
 *
 * Read off `from` — a node inside the centre column — and *not* off the document
 * element. The centre column re-declares the light palette regardless of theme
 * (see `.content` in the stylesheet), because a contact map is a figure and its
 * colormaps are built for ink on white. Reading from the root instead gave a
 * dark-theme plot a black label halo on a white matrix, and exported it that
 * way. The fallbacks are the light values for the same reason: a canvas asked
 * before it is in the document has no computed custom properties, and the right
 * answer for it is the palette it is going to be mounted into.
 */
export function readCanvasPalette(from: Element): {
  labelColor: string
  labelHaloColor: string
  plotBorderColor: string
  /** A wash for alternating blocks — the browser's sequence bands. */
  bandColor: string
} {
  const style = getComputedStyle(from)
  const pick = (name: string, fallback: string): string => {
    const value = style.getPropertyValue(name).trim()
    return value === '' ? fallback : value
  }
  return {
    labelColor: pick('--text-dim', '#5b6169'),
    labelHaloColor: pick('--bg', '#ffffff'),
    plotBorderColor: pick('--border-strong', '#b9bec5'),
    bandColor: pick('--bg-sunken', '#f6f7f8'),
  }
}

/**
 * Body text for what is written onto a figure.
 *
 * From the plot's own box, not the page's: it is drawn onto the figure, which
 * is light, so page text in a dark theme would have written it in pale grey on
 * white.
 */
export function readPageText(from: Element): string {
  const value = getComputedStyle(from).getPropertyValue('--text').trim()
  return value === '' ? '#16181d' : value
}
