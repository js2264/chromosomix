/**
 * Every `var(--x)` in the stylesheet names something that exists.
 *
 * This is the third time the same bug has been found by a reader rather than by
 * a test, and the first two are written up in `styles.css` itself. `--step--2`
 * was asked for by twenty rules and defined by none, so the whole bottom of the
 * type scale silently did not exist. `--tab-rest` was defined in two of the four
 * blocks that carry the light palette and in neither of the others. And six more
 * names — `--line`, `--muted`, `--fg`, `--fg-quiet`, `--bg-inset`, `--warn` —
 * were used across fourteen rules and defined nowhere at all.
 *
 * What makes it worth a test rather than care is that CSS does not fail loudly
 * here. An unresolvable `var()` is *invalid at computed-value time*, which is
 * not "skip this declaration": the property takes its inherited value if it
 * inherits and its initial value if it does not. So
 *
 *     border: 1px solid var(--line);   →  border-style: none   — no border
 *     background: var(--line);         →  transparent          — nothing drawn
 *     color: var(--muted);             →  inherited            — not dimmed
 *
 * and each of those looks, in a screenshot, exactly like a deliberate choice.
 * A ramp with no outline reads as a ramp somebody decided not to outline. That
 * is why it went unfound for so long, and why the check has to be mechanical.
 *
 * A text test, like `deck-plot-css.test.ts` beside it: jsdom has no cascade
 * worth asking and this suite has no browser, but the question — is this name
 * defined anywhere in this file — is answerable from the bytes.
 */

import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

const css = readFileSync(fileURLToPath(new URL('../../src/ui/styles.css', import.meta.url)), 'utf8')

/**
 * Custom properties the *application* writes, with `setProperty`, onto an
 * element at run time: a measured pixel count, a column count, a normalised
 * strength. The stylesheet reads them and must never define them — a default
 * here would be a second opinion about a number somebody measured.
 *
 * Every one is checked against the TypeScript below, so an entry left behind
 * after the code that set it was deleted fails this test rather than quietly
 * widening it.
 */
const SET_FROM_SCRIPT = [
  '--console-height',
  '--deck-columns',
  '--deck-plot',
  '--deck-plot-h',
  '--lane-bottom',
  '--lane-pad-bottom',
  '--lane-pad-left',
  '--lane-pad-right',
  '--lane-pad-top',
  '--lane-top',
  '--map-size',
  '--seq-share',
  '--strength',
  '--text-scale',
  '--turn-height',
  '--turn-width',
] as const

/**
 * The light palette's selector, which four elements share.
 *
 * `.content` is in it only *while it holds a picture*: the pin is what keeps a
 * contact map light whatever the theme, and it used to cover every view mounted
 * in the centre column — the landing page, the tables, the gate — which left a
 * dark-mode reader a white sheet inside a dark frame.
 */
const LIGHT =
  ":root,\n:root[data-theme='light'],\n.content:has(.heatmap-wrap, .browser-stage, .deck-grid),\n.analysis-figure,\n.figure-chart"

/** Every `--name` the sheet defines, anywhere in it. */
function defined(): Set<string> {
  const out = new Set<string>()
  for (const m of css.matchAll(/^\s*(--[a-zA-Z0-9-]+)\s*:/gm)) out.add(m[1])
  return out
}

/** Every `--name` the sheet reads, with the line it is read on. */
function used(): Array<{ name: string; line: number }> {
  const out: Array<{ name: string; line: number }> = []
  css.split('\n').forEach((text, i) => {
    for (const m of text.matchAll(/var\(\s*(--[a-zA-Z0-9-]+)/g)) out.push({ name: m[1], line: i + 1 })
  })
  return out
}

/**
 * The declarations inside one block, as `name: value` strings.
 *
 * Crude on purpose, exactly as the neighbouring CSS test is: it reads to the
 * first `\n}` and strips comments. That is enough for a palette block, which is
 * a flat list of custom properties and nothing else.
 */
function blockOf(selector: string): string[] {
  const at = css.indexOf(`${selector} {`)
  expect(at, `${selector} is in the sheet`).toBeGreaterThan(-1)
  const body = css.slice(at + selector.length + 2, css.indexOf('\n}', at))
  return [
    ...body.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/(--[a-zA-Z0-9-]+)\s*:\s*([^;]+);/g),
  ].map((m) => `${m[1]}: ${m[2].trim()}`)
}

/** The names a block defines, in the order it defines them. */
function namesOf(selector: string): string[] {
  return blockOf(selector).map((d) => d.slice(0, d.indexOf(':')))
}

/** Every TypeScript file under `src/`, concatenated. */
function tsSources(dir = fileURLToPath(new URL('../../src', import.meta.url))): string {
  let out = ''
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) out += tsSources(path)
    else if (entry.name.endsWith('.ts')) out += readFileSync(path, 'utf8')
  }
  return out
}

describe('the stylesheet’s custom properties', () => {
  it('reads no name that nothing defines', () => {
    const known = defined()
    const script = new Set<string>(SET_FROM_SCRIPT)
    const ghosts = used().filter(({ name }) => !known.has(name) && !script.has(name))
    // Reported with their lines, because the failure a reader gets from this
    // test should be the fix: the point is which rule to go and look at.
    expect(ghosts.map(({ name, line }) => `${name} (styles.css:${line})`)).toEqual([])
  })

  it('keeps no allowance for a property the code no longer sets', () => {
    // The sources rather than a manifest: `--lane-pad-top` is written
    // `--lane-pad-${edge}`, so a search for the whole name finds nothing and
    // only the stem before the edge is evidence.
    const ts = tsSources()
    const stale = SET_FROM_SCRIPT.filter(
      (name) => !ts.includes(name) && !ts.includes(name.replace(/-(top|bottom|left|right)$/, '-')),
    )
    expect(stale).toEqual([])
  })

  it('says the same thing in both halves of the dark palette', () => {
    // One copy is inside `@media (prefers-color-scheme: dark)` and the other is
    // not, and a selector list cannot span that — so the only thing holding the
    // two together is this.
    const auto = blockOf(':root:not([data-theme])')
    const chosen = blockOf(":root[data-theme='dark']").filter((d) => !d.startsWith('color-scheme'))
    expect(auto).toEqual(chosen)
  })

  it('gives the light palette every name the dark one has', () => {
    const dark = namesOf(":root[data-theme='dark']").filter((n) => n !== 'color-scheme')
    expect([...new Set(namesOf(LIGHT))].sort()).toEqual([...new Set(dark)].sort())
  })
})
