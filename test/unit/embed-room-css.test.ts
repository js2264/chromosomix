/**
 * A frame's share of the window (SPECS §21.3): every picture sized against the
 * window's height counts out the window's furniture — the header, the tab
 * strip, the breadcrumb row and the status bar — and an embed has one bar in
 * place of the four. With the window's budget, a map in an 850-pixel frame
 * stopped 120 pixels short of the frame's foot, over a band of empty page.
 *
 * A text test, as `embed-bar-css.test.ts` is, because jsdom has no layout: what
 * is pinned is that no budget forgets the frame, and that the frame's values
 * are the ones it measures.
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

const css = readFileSync(fileURLToPath(new URL('../../src/ui/styles.css', import.meta.url)), 'utf8')
const app = readFileSync(fileURLToPath(new URL('../../src/app/App.ts', import.meta.url)), 'utf8')

/** Every declaration, comments removed and whitespace collapsed. */
const declarations = css
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .split(/[;{}]/)
  .map((part) => part.replace(/\s+/g, ' ').trim())
  .filter((part) => part.includes(':'))

/** The body of the first rule whose selector is exactly `selector`, outside any `@media`. */
function rule(selector: string): string {
  const at = css.search(new RegExp(`(^|\\n)${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} \\{`))
  expect(at, `a rule for ${selector}`).toBeGreaterThanOrEqual(0)
  const body = css.slice(css.indexOf('{', at) + 1)
  return body.slice(0, body.indexOf('}'))
}

describe('a frame’s share of the window', () => {
  it('is given back by every budget that counts the window’s furniture', () => {
    const budgets = declarations.filter((part) => part.includes('100vh') && part.includes('var(--tabstrip-h)'))
    expect(budgets.length).toBeGreaterThanOrEqual(5)
    for (const budget of budgets) expect(budget, budget).toContain('+ var(--embed-room)')
  })

  it('is nothing in a window', () => {
    expect(rule(':root')).toMatch(/--embed-room: 0rem;/)
  })

  it('is the header, the breadcrumb row and the status bar, less the embed’s bar, in a frame with no tab strip', () => {
    const frame = rule('.is-embed')
    expect(frame).toMatch(/--tabstrip-h: 0rem;/)
    const room = Number(/--embed-room: ([\d.]+)rem;/.exec(frame)?.[1])
    // 53 + 36 + 34 − 38 pixels, measured: a little over five rem.
    expect(room).toBeGreaterThan(5)
    expect(room).toBeLessThan(5.5)
  })

  it('is asked for by the embed’s own root', () => {
    expect(app).toContain("root.classList.toggle('is-embed', this.embed)")
  })
})
