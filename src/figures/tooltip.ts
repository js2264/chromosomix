/**
 * What the pointer says over a chart, as the markup the chart library parses.
 *
 * The seam where this application writes HTML, and it exists because the
 * library does the writing: ECharts sets a tooltip's content with `innerHTML`
 * (`TooltipHTMLContent.setContent`), so the string a formatter returns is parsed
 * as markup on every hover. Everywhere else a string reaches the page as text —
 * `ui/dom.ts`'s `el()` sets `textContent` — and here that rule has to be kept
 * by hand instead, by the xy figures' formatter (`figures/option.ts`) and the
 * matrix's (`figures/matrixOption.ts`) alike.
 *
 * ## Every piece of text is escaped, by one function
 *
 * What a tooltip names comes out of the file being read. A cis/trans square's
 * ticks are the sequences' own names (`analysis/run/cistrans.ts`), a track
 * correlation's are the tracks', and a curve is named after the sequence or the
 * track it was measured on — so a sequence called `<img src=x onerror=…>` ran
 * its script the moment the pointer crossed its row. Nothing is interpolated
 * into the markup here except through {@link escapeHtml}: the names, the
 * numbers, and a series' colour too, which a workspace file carries
 * (`figures/style.ts`) and which is therefore as foreign as a name. One
 * function, so there is one place to get it right and one place to look.
 *
 * ## And no style attribute, which is why every chart has a formatter
 *
 * The library's own tooltip — what a chart with no formatter shows — escapes
 * its text correctly, and sets every margin, size and colour in it through
 * `style=` attributes. A Content-Security-Policy without `'unsafe-inline'`
 * refuses each of those (§11, §15): one pass of the pointer over P(s) raised
 * seven hundred violations and left a box of bare text, its colour swatches
 * gone. So the markup here carries classes, which `ui/styles.css` styles, and a
 * series' swatch is an SVG circle whose colour is a `fill` — a presentation
 * attribute, which no `style-src` governs. The box around it is the library's
 * and is styled through the CSSOM, which the policy does not govern either.
 */

const ENTITIES: Readonly<Record<string, string>> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
}

/**
 * Text, made safe to stand between two tags or inside a quoted attribute.
 *
 * All five characters, not the two that open a tag: a value interpolated into
 * an attribute — the swatch's `fill` — is closed by a quote, and one escape
 * that is right in both places is the one nobody has to choose between.
 */
export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (char) => ENTITIES[char] ?? char)
}

/** The line a tooltip opens with: the place, or the series, it is about. */
export function tipHead(text: string): string {
  return `<div class="figure-tip-head">${escapeHtml(text)}</div>`
}

/**
 * A series' colour, as a swatch the policy lets through.
 *
 * Absent rather than guessed where the library hands over no string: a
 * gradient arrives as an object, and a summary row — a box's median — is about
 * no one series' colour.
 */
function swatch(colour: unknown): string {
  if (typeof colour !== 'string' || colour === '') return ''
  return (
    '<svg class="figure-tip-swatch" viewBox="0 0 10 10" aria-hidden="true">' +
    `<circle cx="5" cy="5" r="5" fill="${escapeHtml(colour)}"/></svg>`
  )
}

/** One row: a swatch where there is a colour, what it is, and how much. */
export function tipRow(colour: unknown, name: string, value: string): string {
  return (
    `<div class="figure-tip-row">${swatch(colour)}` +
    `<span class="figure-tip-name">${escapeHtml(name)}</span>` +
    `<span class="figure-tip-value">${escapeHtml(value)}</span></div>`
  )
}
