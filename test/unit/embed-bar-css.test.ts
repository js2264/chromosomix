/**
 * The order an embed's one bar gives way in, as its frame narrows (SPECS §21.3).
 *
 * The bar is the breadcrumb row with the brand before it and three buttons
 * after, and the row scrolled: in a frame of 1,040 pixels the contacts box's
 * example was cut, at 910 — an R Markdown page — the row ended at `con`, and at
 * 720 the resolution and the box were gone with nothing to say they were
 * there. Inside the frame the viewport is the frame, so the bar answers media
 * queries, and what is pinned here is their order:
 *
 * 1. the two controls of how the picture is drawn take a line of their own,
 *    *together* — a zero-height break ordered between the trail and them, since
 *    plain wrapping takes the last item, the box, away from the resolution;
 * 2. then the brand's name goes, its mark staying;
 * 3. then, at a phone's width, the contacts box — never the resolution.
 *
 * A text test, as `deck-plot-css.test.ts` is, because jsdom has no layout.
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

const css = readFileSync(fileURLToPath(new URL('../../src/ui/styles.css', import.meta.url)), 'utf8')

/** Every `@media (max-width: …rem)` block, with its width and its body, braces matched. */
function mediaBlocks(): Array<{ rem: number; body: string }> {
  const out: Array<{ rem: number; body: string }> = []
  const opener = /@media \(max-width: ([\d.]+)rem\) \{/g
  for (let match = opener.exec(css); match !== null; match = opener.exec(css)) {
    let depth = 1
    let at = opener.lastIndex
    while (depth > 0 && at < css.length) {
      if (css[at] === '{') depth++
      else if (css[at] === '}') depth--
      at++
    }
    out.push({ rem: Number(match[1]), body: css.slice(opener.lastIndex, at - 1) })
  }
  return out
}

/** The width of the one block that holds `needle`, which must be exactly one. */
function widthOf(needle: RegExp): number {
  const blocks = mediaBlocks().filter((block) => needle.test(block.body))
  expect(blocks, `one @media block holds ${needle}`).toHaveLength(1)
  return blocks[0].rem
}

/** The declarations of `selector` inside the block of width `rem`. */
function declarationsIn(rem: number, selector: string): string {
  const block = mediaBlocks().find((candidate) => candidate.rem === rem)
  expect(block, `a block at ${rem}rem`).toBeDefined()
  const at = block?.body.indexOf(`${selector} {`) ?? -1
  expect(at, `${selector} at ${rem}rem`).toBeGreaterThanOrEqual(0)
  const body = block?.body.slice(at) ?? ''
  return body.slice(body.indexOf('{') + 1, body.indexOf('}'))
}

describe('the embed’s bar in a narrowing frame', () => {
  const ownLine = widthOf(/\.embed-bar \.breadcrumb::before/)
  const noName = widthOf(/\.embed-brand-name \{\s*display: none/)
  const noBox = widthOf(/\.embed-bar \.breadcrumb > \.crumb-contacts \{\s*display: none/)

  it('gives way in one order: the controls’ own line, then the brand’s name, then the box', () => {
    expect(ownLine).toBeGreaterThan(noName)
    expect(noName).toBeGreaterThan(noBox)
  })

  it('moves the resolution and the box together, after a break that takes the whole line', () => {
    expect(declarationsIn(ownLine, '.embed-bar .breadcrumb')).toMatch(/flex-wrap: wrap/)
    const rule = declarationsIn(ownLine, '.embed-bar .breadcrumb::before')
    expect(rule).toMatch(/order: 1/)
    expect(rule).toMatch(/flex: 0 0 100%/)
    const controls = mediaBlocks().find((block) => block.rem === ownLine)?.body ?? ''
    expect(controls).toMatch(/\.embed-bar \.breadcrumb > \.crumb-res,\s*\.embed-bar \.breadcrumb > \.crumb-contacts \{\s*order: 2/)
  })

  it('never puts the resolution away', () => {
    for (const block of mediaBlocks()) {
      expect(block.body, `@media (max-width: ${block.rem}rem)`).not.toMatch(/\.crumb-res[^{]*\{[^}]*display: none/)
    }
  })
})
