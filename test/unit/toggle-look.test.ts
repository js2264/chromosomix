/**
 * A toggle is drawn one way, and a live control is never dimmed.
 *
 * Five idioms used to say "this is on" and they disagreed: `[aria-pressed]` lit
 * the plot toggles, `.is-on` lit seven others, `[aria-expanded]` lit the map's
 * settings button, and `.is-off` *dimmed* the eyes, the deck's lock and the
 * panel folds. The last of those is the one that mattered, because
 * `.btn:disabled` is also drawn by dimming: a reader who had learned that grey
 * means "you cannot press this" was being told by the same grey that a track's
 * eye was off and should be pressed.
 *
 * A text test, like `css-tokens.test.ts` beside it: jsdom has no cascade worth
 * asking, but the questions here — is there one lit rule, does any rule dim a
 * live control, does every toggle declare its state — are answerable from the
 * bytes of the sheet and the sources.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const ROOT = join(import.meta.dirname, '..', '..')
const CSS = readFileSync(join(ROOT, 'src', 'ui', 'styles.css'), 'utf8')

/** Every selector list that opens a declaration block, with its body. */
function rules(): Array<{ selectors: string[]; body: string }> {
  const out: Array<{ selectors: string[]; body: string }> = []
  // Comments first: a selector quoted inside one is prose, not a rule.
  const clean = CSS.replace(/\/\*[\s\S]*?\*\//g, '')
  for (const match of clean.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const head = match[1].trim()
    if (head.startsWith('@') || head === '') continue
    out.push({ selectors: head.split(',').map((s) => s.trim()), body: match[2] })
  }
  return out
}

describe('the lit look', () => {
  it('is declared in one place for the buttons that carry it', () => {
    const lit = rules().filter((rule) =>
      rule.selectors.some((s) => /^\.btn-(toggle|icon)\[aria-/.test(s)) &&
      /background:\s*var\(--accent-soft\)/.test(rule.body),
    )
    expect(lit).toHaveLength(1)
  })

  it('is the same three colours wherever a control is lit', () => {
    // `.ann-place` is the one variation and it is a segment inside a bordered
    // group, so it takes the fill and the text and cannot take a border. What
    // must not drift is the *pair*: a fill without the matching text colour is
    // how one control ends up lit blue-on-grey and its neighbour blue-on-blue.
    for (const rule of rules()) {
      if (!/background:\s*var\(--accent-soft\)/.test(rule.body)) continue
      if (rule.selectors.some((s) => s.includes(':hover'))) continue
      // Only the rules that light a *control*. A drop target filled with
      // `--accent-soft` is a region of the page saying "let go here", not a
      // toggle saying it is on, and it has no text of its own to colour.
      const litsAControl = rule.selectors.some((s) => /\[aria-pressed|\.is-on\b/.test(s))
      if (!litsAControl) continue
      // A chosen *row* or *tile* is a selection, not a lit toggle: its text is
      // content — a folder's name, a store's name — and stays `--text`, the way
      // a selected row's text does in every list in every application. The
      // fill is what says it is the one. A toggle has no content: its whole
      // text is its label, so the label is what carries the state.
      if (rule.selectors.every((s) => /-tile\b|-row\b|-folder\b/.test(s))) continue
      expect(rule.body).toMatch(/color:\s*var\(--accent\)/)
    }
  })

  it('covers every class a toggle in this app is lit by', () => {
    const lit = rules().find((rule) =>
      rule.selectors.some((s) => s.includes("[aria-pressed='true']")) &&
      /background:\s*var\(--accent-soft\)/.test(rule.body),
    )
    const selectors = new Set(lit?.selectors ?? [])
    for (const wanted of [
      ".btn-toggle[aria-pressed='true']:not(:disabled)",
      ".btn-icon[aria-pressed='true']:not(:disabled)",
      ".btn-icon[aria-expanded='true']:not(:disabled)",
      '.ann-flip.is-on',
      '.structure-select.is-on',
      '.structure-loop.is-on',
      '.structure-measure.is-on',
      '.lane-auto.is-on',
      '.analysis-map.is-on',
      '.deck-star.is-on',
      '.deck-layout.is-on',
      '.deck-share.is-on',
      '.btn-chip.is-on',
      '.portal-mode.is-on',
    ]) {
      expect(selectors).toContain(wanted)
    }
  })

  it('stands down for a control that has become unavailable', () => {
    // A lit-and-dead button says the opposite of what it is, and `:disabled`
    // comes later in the sheet only by luck — so the lit rule excludes it.
    const lit = rules().find((rule) =>
      rule.selectors.some((s) => s.includes("[aria-pressed='true']")) &&
      /background:\s*var\(--accent-soft\)/.test(rule.body),
    )
    for (const selector of lit?.selectors ?? []) {
      if (selector.includes('[aria-')) expect(selector).toContain(':not(:disabled)')
    }
  })
})

describe('nothing live is dimmed', () => {
  it('has no rule that dims a button for being off rather than unavailable', () => {
    for (const rule of rules()) {
      for (const selector of rule.selectors) {
        if (!/\.is-off\b/.test(selector)) continue
        // The two legends are not controls: a series that is not drawn and a
        // sequence that is ghosted are *absent from the picture*, which is what
        // a faded row in a key means and the only thing it can mean.
        if (/\.plot-series|\.structure-key-seq/.test(selector)) continue
        expect(`${selector} { ${rule.body.trim()} }`).toBe('no such rule')
      }
    }
  })
})
