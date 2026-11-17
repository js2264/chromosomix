/**
 * The one stylesheet rule this application cannot express in TypeScript, and has
 * now got wrong twice.
 *
 * A `.heatmap-wrap` sits in a grid track sized from its own contents —
 * `.panel-grid`'s middle column is `minmax(min(20rem, 100%), auto)`, because a
 * map has to be able to give width back to the lane stacks beside it. So the box
 * has **no definite containing block**, and a percentage width has nothing to
 * resolve against: CSS falls back to intrinsic sizing, and the only content is a
 * canvas whose pixel size the panel derived *from this box*. The result is a
 * circle that settles wherever the canvas was last left.
 *
 * It is not hypothetical. A deck of two at 1 kb drew 182-pixel maps in 430-pixel
 * cells with the air between them the reader reported; switching resolution moved
 * them to 320 and still never reached the cell; and turning the map — which
 * writes lengths — was the only thing that settled it, which is exactly the shape
 * of a bug report that says "flipping to triangle and back fixes it". The turned
 * half of the same rule had already been fixed once for the same reason, and its
 * comment says so.
 *
 * So the invariant is: **inside a deck, the width of a map's box is one of the
 * numbers somebody measured** — the panel's own (`--map-width`), its band's
 * (`--turn-width`), or the lead's, pushed down by the deck (`--deck-plot`) —
 * with a length as the fallback and never a percentage. A text test, because
 * jsdom has no layout and this suite has no browser: what it can check is that
 * the declaration names a variable rather than a percentage, which is the
 * difference between a definite length and the circle.
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

const css = readFileSync(fileURLToPath(new URL('../../src/ui/styles.css', import.meta.url)), 'utf8')

/** Every rule that sets a `width` on a map's box, with its selector. */
function widthRules(): Array<{ selector: string; width: string }> {
  const out: Array<{ selector: string; width: string }> = []
  // Crude on purpose: a real parser for one property in one stylesheet is a
  // dependency, and the shapes here are hand-written and stable.
  for (const block of css.split('}')) {
    const at = block.lastIndexOf('{')
    if (at < 0) continue
    const selector = block.slice(0, at).split('*/').pop()?.replace(/\s+/g, ' ').trim() ?? ''
    if (!selector.includes('.heatmap-wrap')) continue
    const body = block.slice(at + 1)
    // `width`, not `max-width` or `min-width`: the lookbehind is what excludes
    // them, and both are legitimately percentages here.
    const width = /(?:^|[;{\s])width:\s*([^;]+)/.exec(body)?.[1]
    if (width !== undefined) out.push({ selector, width: width.replace(/\s+/g, ' ').trim() })
  }
  return out
}

describe('the width of a map’s box', () => {
  it('is set somewhere, or this test is checking nothing', () => {
    const rules = widthRules()
    expect(rules.length).toBeGreaterThan(2)
    // The plain rule outside a deck is the one every other rule is a variation
    // of, and it is a length: the size the panel measured, or the budget.
    expect(rules.some((rule) => rule.selector === '.heatmap-wrap')).toBe(true)
  })

  it('is a measured number wherever a deck is what contains it', () => {
    for (const rule of widthRules()) {
      if (!rule.selector.includes('deck')) continue
      expect(
        /var\(--(map-width|turn-width|deck-plot)/.test(rule.width),
        `${rule.selector} sizes a map from ${rule.width}; inside a deck the box has no ` +
          'definite containing block, so this has to be a number somebody measured',
      ).toBe(true)
      expect(
        rule.width.includes('%'),
        `${rule.selector} falls back to a percentage (${rule.width}), which cannot resolve ` +
          'against a content-sized grid track and collapses to the canvas it sized',
      ).toBe(false)
    }
  })

  it('lets the narrow layout use the width it does have', () => {
    // One column, no deck, and the box *does* have a definite containing block
    // there — so `100%` is the honest rule and is deliberately left alone. Stated
    // as a test so the rule above is not read as "no percentage anywhere".
    const narrow = widthRules().filter((rule) => rule.width === '100%')
    expect(narrow.length).toBeGreaterThan(0)
    for (const rule of narrow) expect(rule.selector.includes('deck')).toBe(false)
  })

  it('keeps the window’s share of a deck map above the single view’s floor', () => {
    // A short window less the lane stacks under a map is a few pixels: a deck of
    // two in a 620-pixel notebook frame, three tracks under the map, drew a
    // 42-pixel thumbnail. The share has the single view's 20rem floor, and the
    // measured `--map-width` still bounds it to the cell.
    const deck = widthRules().find((rule) => rule.selector === '.deck .heatmap-wrap')
    expect(deck?.width).toMatch(/^min\( var\(--map-width, 20rem\), max\(20rem, calc\(100vh/)
  })
})

/**
 * …and the height of one the reader has drawn as a rectangle (§7.2).
 *
 * A square's height is its width again, through `aspect-ratio`, so the width
 * rules above are the whole of it. A rectangle's is a number of its own, and the
 * same two mistakes are open to it: a companion that took the height from its
 * own fit would stand beside the first map at another height, and a phone that
 * kept a height dragged on a laptop would draw a strip the width of the screen.
 */
describe('the height of a map drawn as a rectangle', () => {
  /** The declarations of every rule naming exactly this selector, in the order they come. */
  function rules(selector: string): string[] {
    const out: string[] = []
    for (const block of css.split('}')) {
      const at = block.lastIndexOf('{')
      if (at < 0) continue
      const head = block.slice(0, at).split('*/').pop()?.replace(/\s+/g, ' ').trim() ?? ''
      if (head.split(',').map((part) => part.trim()).includes(selector)) out.push(block.slice(at + 1))
    }
    return out
  }
  /** The first of them, which for these selectors is the one outside any `@media`. */
  const rule = (selector: string): string => rules(selector)[0] ?? ''

  it('is the panel’s own number, and only while the box is not a square', () => {
    const shaped = rule('.panel-grid.is-shaped > .heatmap-wrap')
    expect(shaped).toMatch(/height:\s*var\(--map-height\)/)
    // A square is left to the aspect ratio, which keeps it one when something
    // narrows it; only the class turns it off.
    expect(shaped).toMatch(/aspect-ratio:\s*auto/)
    expect(rule('.heatmap-wrap')).toMatch(/aspect-ratio:\s*1 \/ 1/)
    expect(rule('.heatmap-wrap')).not.toMatch(/(?:^|[;{\s])height:/)
  })

  it('is the first map’s measured height on every other map of a deck', () => {
    const companion = rule('.deck-panel:not(.is-lead) .panel-grid.is-shaped > .heatmap-wrap')
    expect(companion).toMatch(/height:\s*var\(--deck-plot-h, var\(--map-height\)\)/)
  })

  it('is given up on a phone, which draws the whole width square', () => {
    // The phone's rule names the plain box and the shaped one together, so it is
    // the one of the shaped selector's rules that sets the whole width.
    const narrow = rules('.panel-grid.is-shaped > .heatmap-wrap').find((body) => /width:\s*100%/.test(body))
    expect(narrow).toBeDefined()
    expect(narrow).toMatch(/aspect-ratio:\s*1 \/ 1/)
    expect(narrow).toMatch(/height:\s*auto/)
  })
})
