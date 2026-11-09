/**
 * A deck cell's heading wraps its controls under its name rather than running
 * them on into the next cell (§16.9).
 *
 * Four maps across a column with two side panels open are cells of 154 pixels,
 * and a heading of a grip, a name, a sequence, a star, a chain and a × could not
 * be less than 196: the name went to its floor and the controls ran on past the
 * cell's edge, the chain drawn over the next cell's grip and name. The fix is
 * three declarations, and a text test is what this suite can hold them to — it
 * has no layout. The pictures are `scripts/ui-deck-heads.mjs`'s, which measures
 * every heading against its cell in a browser.
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

const css = readFileSync(fileURLToPath(new URL('../../src/ui/styles.css', import.meta.url)), 'utf8')

/** The declarations of the rule whose selector is exactly `selector`. */
function rule(selector: string): Record<string, string> {
  for (const block of css.split('}')) {
    const at = block.lastIndexOf('{')
    if (at < 0) continue
    const head = block.slice(0, at).split('*/').pop()?.replace(/\s+/g, ' ').trim() ?? ''
    if (head !== selector) continue
    const out: Record<string, string> = {}
    for (const line of block.slice(at + 1).split(';')) {
      const colon = line.indexOf(':')
      if (colon < 0) continue
      out[line.slice(0, colon).trim()] = line.slice(colon + 1).replace(/\s+/g, ' ').trim()
    }
    return out
  }
  throw new Error(`no rule for ${selector}`)
}

describe('a deck cell’s heading', () => {
  it('wraps, rather than overflowing its cell', () => {
    expect(rule('.deck-head')['flex-wrap']).toBe('wrap')
  })

  it('sends its controls to a line of their own as one group, at the cell’s right', () => {
    const tools = rule('.deck-tools')
    expect(tools['display']).toBe('flex')
    expect(tools['margin-left']).toBe('auto')
    // A cell too narrow even for the group alone wraps it within itself, to
    // the right, rather than out of the cell.
    expect(tools['flex-wrap']).toBe('wrap')
    expect(tools['justify-content']).toBe('flex-end')
    expect(tools['min-width']).toBe('0')
  })

  it('keeps a readable width for the name before the controls give way, and none after', () => {
    const name = rule('.deck-name')
    // A length, not `auto`: an input's own width is twenty characters, which
    // would wrap the controls under every name in every deck.
    expect(name['flex']).toMatch(/^1 1 \d+(\.\d+)?rem$/)
    expect(name['min-width']).toBe('0')
  })
})
