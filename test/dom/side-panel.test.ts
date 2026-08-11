// @vitest-environment jsdom
/**
 * The four columns, and what a *folded* one leaves behind.
 *
 * A folded column used to leave the layout entirely, which left the header's
 * four marks as the only sign it existed — and those say neither which column is
 * folded nor what is in it. It now keeps a strip of itself with a tab standing on
 * the bottom, turned a quarter-turn so the name reads up the side of the window.
 *
 * Two things are worth a test and neither is the rotation, which is a stylesheet
 * and a picture. The first is the **three states**: open, folded, and absent for
 * want of anything to show — the last of which must leave no tab, because a tab
 * that opens an empty column is worse than the column's absence. The second is
 * the **nesting**, which the tabs get from being in the flow rather than from any
 * measurement: `order` puts the columns outermost-first from each edge, so two
 * folded panels stand side by side at the edge and opening the outer one pushes
 * the inner one's tab out against it. That is a fact about the four specs, and it
 * is the one that would break silently if somebody renumbered them.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  AESTHETICS_PANEL,
  ANALYSIS_PANEL,
  ANNOTATION_PANEL,
  GENERAL_PANEL,
  SidePanel,
  type SidePanelSpec,
} from '@/ui/SidePanel'
import { setUpDom, type DomTeardown } from '../support/dom'

let teardown: DomTeardown

beforeEach(() => {
  teardown = setUpDom()
  window.localStorage.clear()
})

afterEach(() => {
  teardown()
  window.localStorage.clear()
})

interface Mounted {
  panel: SidePanel
  resizes: () => number
}

/** A panel in the document, with something in it, as the shell mounts one. */
function mount(spec: SidePanelSpec = GENERAL_PANEL): Mounted {
  let resizes = 0
  const panel = new SidePanel(spec, () => {
    resizes++
  })
  document.body.append(panel.el, panel.toggle)
  panel.setContent([document.createElement('div')])
  panel.setAvailable(true)
  return { panel, resizes: () => resizes }
}

const tabOf = (panel: SidePanel): HTMLElement | null =>
  panel.el.querySelector<HTMLElement>('.panel-tab')

describe('a side panel', () => {
  it('is a column with a heading, a key and no tab while it is open', () => {
    const { panel } = mount()
    expect(panel.isCollapsed).toBe(false)
    expect(panel.el.classList.contains('collapsed')).toBe(false)
    expect(panel.el.querySelector('.panel-column-title')?.textContent).toBe('General')
    expect(panel.el.querySelector('.panel-column-key')?.textContent).toBe('B')
    // The reader's own width, inline, because it is the reader's own drag.
    expect(panel.el.style.width).toBe('288px')
    // The tab is in the DOM either way — the stylesheet shows it — so what is
    // asserted here is the class the stylesheet keys on.
    expect(tabOf(panel)).not.toBeNull()
  })

  it('folds to a strip whose tab names the panel and the key that opens it', () => {
    const { panel, resizes } = mount()
    // From here, not from zero: becoming available is itself a change of width,
    // and the shell is told about that one too.
    const before = resizes()
    panel.toggle.click()

    expect(panel.isCollapsed).toBe(true)
    expect(panel.el.classList.contains('collapsed')).toBe(true)
    expect(panel.el.classList.contains('is-absent')).toBe(false)
    // No inline width: the strip is one number in the stylesheet, and an inline
    // width here would beat it.
    expect(panel.el.style.width).toBe('')
    const tab = tabOf(panel)
    expect(tab?.textContent).toBe('GeneralB')
    expect(tab?.getAttribute('aria-label')).toBe('Show the General panel')
    expect(tab?.title).toBe('Show the General panel (B)')
    // The plot has room it did not have; the shell is told so it can re-measure.
    expect(resizes()).toBe(before + 1)
  })

  it('opens again from the tab, which is the point of having one', () => {
    const { panel, resizes } = mount()
    panel.toggle.click()
    const before = resizes()
    tabOf(panel)?.click()
    expect(panel.isCollapsed).toBe(false)
    expect(panel.el.classList.contains('collapsed')).toBe(false)
    expect(panel.el.style.width).toBe('288px')
    expect(resizes()).toBe(before + 1)
  })

  it('leaves no tab when it has nothing to show', () => {
    // Not the same state as folded, and the difference is the whole reason there
    // are two classes: the picker has no file, so General and Annotations have
    // nothing in them, and a tab there is an invitation to an empty column.
    const { panel } = mount()
    panel.setAvailable(false)
    expect(panel.el.classList.contains('is-absent')).toBe(true)
    expect(panel.el.classList.contains('collapsed')).toBe(true)
    expect(panel.isCollapsed).toBe(false)
    expect(panel.toggle.classList.contains('hidden')).toBe(true)
  })

  it('remembers the fold as a preference about the window, not the file', () => {
    const first = mount()
    first.panel.toggle.click()
    expect(first.panel.isCollapsed).toBe(true)
    // A second window, or the same one after a reload: the stored choice is the
    // one that comes back, and it comes back as a tab rather than as nothing.
    const second = mount()
    expect(second.panel.isCollapsed).toBe(true)
    expect(tabOf(second.panel)?.textContent).toBe('GeneralB')
  })

  it('marks itself with what it holds, on both of its states', () => {
    // `file-cog` for the file and what is read off it, as its three siblings are
    // marked by their own contents rather than by a fold arrow.
    expect(GENERAL_PANEL.openIcon).toBe('file-cog')
    expect(GENERAL_PANEL.closeIcon).toBe('file-cog')
  })
})

describe('the four columns', () => {
  it('are ordered outermost-first from each edge, which is what nests the tabs', () => {
    // A folded strip sits exactly where its column would, so this ordering *is*
    // the rule the user asked for: General stands at the left edge of the screen
    // and Annotations against General, Analysis at the right edge and Aesthetics
    // against Analysis. Break the numbers and the tabs swap sides in silence.
    expect(GENERAL_PANEL.side).toBe('left')
    expect(ANNOTATION_PANEL.side).toBe('left')
    expect(GENERAL_PANEL.order).toBeLessThan(ANNOTATION_PANEL.order)
    expect(ANNOTATION_PANEL.order).toBeLessThan(0)

    expect(AESTHETICS_PANEL.side).toBe('right')
    expect(ANALYSIS_PANEL.side).toBe('right')
    expect(ANALYSIS_PANEL.order).toBeGreaterThan(AESTHETICS_PANEL.order)
    expect(AESTHETICS_PANEL.order).toBeGreaterThan(0)
  })

  it('each answer to one key, and no two to the same', () => {
    const keys = [GENERAL_PANEL, ANNOTATION_PANEL, AESTHETICS_PANEL, ANALYSIS_PANEL].map(
      (spec) => spec.keys,
    )
    expect(keys).toEqual(['b', 'a', 'm', 'j'])
    expect(new Set(keys).size).toBe(keys.length)
  })

  it('put the order on the element, so the DOM order in the shell is free', () => {
    for (const spec of [GENERAL_PANEL, ANNOTATION_PANEL, AESTHETICS_PANEL, ANALYSIS_PANEL]) {
      const { panel } = mount(spec)
      expect(panel.el.style.order).toBe(String(spec.order))
      expect(panel.el.classList.contains(`panel-column-${spec.side}`)).toBe(true)
      expect(panel.el.classList.contains(`panel-${spec.title.toLowerCase()}`)).toBe(true)
    }
  })
})
