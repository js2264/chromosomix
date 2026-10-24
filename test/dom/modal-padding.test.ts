// @vitest-environment jsdom
/**
 * Every dialog's body is inset from its panel, and none has to remember it.
 *
 * Each dialog in this application names its own body class, and each used to set
 * its own padding — which is a rule spelled a dozen times, and the way that
 * shape fails is not subtle: a dialog written without the declaration comes out
 * with its text pressed against the panel's border, looking broken, and nothing
 * anywhere says what was forgotten. The resolution dialog shipped exactly that.
 *
 * So the padding is stated once, against `.modal-panel`'s own children, at a
 * specificity that beats a body class. Two dialogs are flush on purpose — the
 * command palette's search box and the feature card's footer each carry a border
 * across the panel's whole width, which an inset body would cut short of both
 * edges — and they opt out by name.
 *
 * jsdom applies no stylesheet, so what is checked is the **rule**: that it
 * exists, that it is written as a structural selector rather than as a list of
 * body classes anybody could forget to extend, and that the exception list is
 * the two it should be. A DOM test cannot see any of that.
 */

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

// From the working directory rather than from `import.meta.url`, which is the
// road `test/dom/side-panel.test.ts` takes: under jsdom the module's own URL is
// not a `file:` one, and resolving against it throws.
const css = readFileSync(resolve(process.cwd(), 'src/ui/styles.css'), 'utf8')

/** The bodies that are flush on purpose. Everything else is inset. */
const FLUSH = ['palette-body', 'feature-body', 'about-body', 'stage-modal']

describe('the padding every dialog body gets', () => {
  it('is one rule over the panel’s children, not a list of body classes', () => {
    const rule = /\.modal-panel\s*>\s*:not\(\.modal-head\)\s*\{([^}]*)\}/.exec(css)
    expect(rule).not.toBeNull()
    // A padding that is there and a padding that is zero are different rules;
    // this one has to be an inset.
    const padding = /padding:\s*([^;]+);/.exec(rule?.[1] ?? '')
    expect(padding).not.toBeNull()
    expect(Number.parseFloat(padding?.[1] ?? '0')).toBeGreaterThan(0)
  })

  it('reaches a dialog that styles nothing at all', () => {
    // Two classes against one is what makes the guarantee a guarantee: the
    // panel's rule outranks any `.x-body { padding }` a dialog writes, so a
    // dialog that writes nothing — the resolution one has no rule of its own —
    // is inset by the panel and not by luck.
    expect(css).not.toMatch(/^\.res-body\s*\{/m)
    const selector = /\.modal-panel\s*>\s*:not\(\.modal-head\)/.exec(css)?.[0] ?? ''
    expect(selector.split('.').length - 1).toBeGreaterThanOrEqual(2)
  })

  it('exempts the bodies that have to reach the panel’s own edges', () => {
    // Three carry a border across the whole width — the palette's search box, the
    // feature card's footer rule, About's row of tabs — and the stage carries a
    // divider the reader drags, which sizes the settings column from the modal's
    // own right edge and would be a padding out if the body were inset.
    const flush = new RegExp(
      FLUSH.map((name) => `\\.modal-panel\\s*>\\s*\\.${name}`).join(',\\s*') + '\\s*\\{([^}]*)\\}',
    )
    const rule = flush.exec(css)
    expect(rule).not.toBeNull()
    expect(rule?.[1]).toMatch(/padding:\s*0\s*;/)
    // …and each of them pads its own rows, so nothing is edge to edge.
    expect(css).toMatch(/\.palette-body\s*>\s*\.input\s*\{[^}]*padding:/)
    expect(css).toMatch(/\.feature-rows\s*\{[^}]*padding:/)
    expect(css).toMatch(/\.about-tabs\s*\{[^}]*padding:/)
    expect(css).toMatch(/\.about-panels\s*\{[^}]*padding:/)
    expect(css).toMatch(/\.about-foot\s*\{[^}]*padding:/)
    expect(css).toMatch(/\.stage-body\s*\{[^}]*padding:/)
  })

  it('is opted out of by name, and by nothing else', () => {
    // The way this guarantee rots is a dialog quietly writing `padding: 0` into
    // its own body rule, which reads as a layout choice and lands as a panel
    // with its text against the border. Only the two above may say it, and they
    // say it where a reader looking for the exception list will find it.
    for (const match of css.matchAll(/\.([a-z-]*(?:body|modal))\s*\{([^}]*)\}/g)) {
      const [, name, block] = match
      if (FLUSH.includes(name)) continue
      expect(block, name).not.toMatch(/padding:\s*0\s*[;}]/)
    }
  })
})
