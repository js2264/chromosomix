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
 *
 * The third is the **fold on the column itself**: a folded one advertises the
 * way back on its tab, and an open one advertised nothing at all until the
 * chevron beside the key badge, so what is asserted here is the pair of facts a
 * reader depends on — that the chevron points the way its own column travels,
 * and that clicking it is the same fold the header button performs rather than a
 * second path to it.
 */

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  AESTHETICS_PANEL,
  ANALYSIS_PANEL,
  ANNOTATION_PANEL,
  FILES_PANEL,
  GENERAL_PANEL,
  SidePanel,
  type SidePanelSpec,
} from '@/ui/SidePanel'
import { icon } from '@/ui/icons'
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

const foldOf = (panel: SidePanel): HTMLButtonElement | null =>
  panel.el.querySelector<HTMLButtonElement>('.panel-column-fold')

/**
 * Which chevron a control draws, against the icon set's own geometry.
 *
 * The direction is the whole of what this button says, and it is the one thing
 * about it that cannot be read off a class name — the shapes come from upstream
 * through `npm run icons`, so the honest comparison is with `icon()` rather than
 * with a path copied into a test that would then agree with itself forever.
 */
function chevronOf(node: Element | null): 'left' | 'right' | 'neither' {
  const drawn = node?.querySelector('path')?.getAttribute('d') ?? null
  const shapeOf = (name: 'chevron-left' | 'chevron-right'): string | null =>
    icon(name).querySelector('path')?.getAttribute('d') ?? null
  if (drawn !== null && drawn === shapeOf('chevron-left')) return 'left'
  if (drawn !== null && drawn === shapeOf('chevron-right')) return 'right'
  return 'neither'
}

/** All five, in the order they stand on the screen: three from the left edge, two from the right. */
const ALL_PANELS = [FILES_PANEL, GENERAL_PANEL, ANNOTATION_PANEL, AESTHETICS_PANEL, ANALYSIS_PANEL]

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

  it('starts folded where its spec says so, until the reader opens it', () => {
    // Annotations and Analysis start folded so a first visit shows a map rather
    // than five columns; the other three start open as they always did.
    expect(mount(ANNOTATION_PANEL).panel.isCollapsed).toBe(true)
    expect(mount(ANALYSIS_PANEL).panel.isCollapsed).toBe(true)
    for (const spec of [FILES_PANEL, GENERAL_PANEL, AESTHETICS_PANEL]) {
      expect(mount(spec).panel.isCollapsed).toBe(false)
    }
    // Opening one is a choice, and it has to be told from never having chosen:
    // the open state is written, and a second window comes back open.
    const first = mount(ANALYSIS_PANEL)
    tabOf(first.panel)?.click()
    expect(first.panel.isCollapsed).toBe(false)
    expect(window.localStorage.getItem(ANALYSIS_PANEL.key)).toBe('0')
    expect(mount(ANALYSIS_PANEL).panel.isCollapsed).toBe(false)
  })

  it('conceals for this window only, leaving the stored choice alone', () => {
    // The landing page's Files column has done its job once a file it offered
    // has opened; folding it then is the shell's doing, not the reader's, so the
    // next window — and the landing page it starts on — still finds it open.
    const { panel, resizes } = mount(FILES_PANEL)
    const before = resizes()
    panel.conceal()
    expect(panel.isCollapsed).toBe(true)
    expect(panel.el.classList.contains('collapsed')).toBe(true)
    expect(resizes()).toBe(before + 1)
    expect(window.localStorage.getItem(FILES_PANEL.key)).toBeNull()
    expect(mount(FILES_PANEL).panel.isCollapsed).toBe(false)
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

/**
 * The shape a workspace file carries.
 *
 * A fold is a *preference* and lives in `localStorage`, which is exactly why it
 * also has to travel: a saved workspace is what somebody was looking at, and a
 * window that restores twelve tracks into a column the reader had folded away
 * has restored the tracks and not the arrangement. The width goes with it
 * because the two are one decision about how much room a column deserves.
 */
describe('a column as a saved workspace carries it', () => {
  it('reports the fold, and the width only where it is not the default', () => {
    const { panel } = mount()
    expect(panel.layout).toEqual({ folded: false })
    panel.toggle.click()
    expect(panel.layout).toEqual({ folded: true })
  })

  it('leaves a column alone where the file says nothing about it', () => {
    // Every config written before the field existed. The importing window keeps
    // whatever it had, rather than being flattened to a default by omission.
    const { panel } = mount()
    panel.toggle.click()
    panel.applyLayout(undefined)
    expect(panel.isCollapsed).toBe(true)
  })

  it('puts a fold back, and writes it where a reload will find it', () => {
    const { panel } = mount()
    panel.applyLayout({ folded: true })
    expect(panel.isCollapsed).toBe(true)
    expect(panel.el.classList.contains('collapsed')).toBe(true)
    // Written through to storage rather than held for this window: a restore
    // that did not would be undone by the next reload, and the reader would
    // watch their arrangement arrive and then leave again.
    expect(new SidePanel(GENERAL_PANEL).isCollapsed).toBe(true)
  })

  it('puts a width back, and hands an absent one to the default', () => {
    const { panel } = mount()
    panel.applyLayout({ folded: false, width: 420 })
    expect(panel.el.style.width).toBe('420px')
    expect(panel.layout).toEqual({ folded: false, width: 420 })

    // Absent is *the default back*, not "leave it alone": a workspace saved from
    // a window nobody had dragged restores to the default width, or the same
    // file would come back at two layouts in two windows.
    panel.applyLayout({ folded: false })
    expect(panel.el.style.width).toBe(`${GENERAL_PANEL.defaultWidth}px`)
  })

  it('clamps a width the bounds have since moved past', () => {
    // Untrusted like every other stored shape, and this one arrives from another
    // machine as well as from another build.
    const { panel } = mount()
    panel.applyLayout({ folded: false, width: 99_999 })
    expect(panel.el.style.width).toBe(`${GENERAL_PANEL.maxWidth}px`)
  })

  it('says nothing about a column that has nothing to show', () => {
    // The conflation the class makes on purpose: a panel with nothing in it is
    // hidden *without touching the stored choice*. Reporting it as folded would
    // write "folded" into a workspace for every column the open file had no use
    // for — and fold Annotations on the next `.cool` restored over it.
    const { panel } = mount()
    panel.setAvailable(false)
    expect(panel.el.classList.contains('collapsed')).toBe(true)
    expect(panel.layout.folded).toBe(false)
  })
})

/**
 * The chevron beside the key badge, which is the fold written on the column.
 *
 * The header's row of marks has always been able to fold a column, but it is two
 * columns away from the thing it acts on and says neither which panel it belongs
 * to nor which way that panel goes. A folded column answers both on its tab; an
 * open one answered neither, and this is the half of the pair that was missing.
 */
describe('a column’s own fold button', () => {
  it('is in every column’s heading, named and carrying its key', () => {
    for (const spec of ALL_PANELS) {
      const { panel } = mount(spec)
      const fold = foldOf(panel)
      expect(fold).not.toBeNull()
      // Named without the key and titled with it, exactly as the tab is: a label
      // read aloud as "(B)" spells a shortcut out to the one reader who cannot
      // watch for it.
      expect(fold?.getAttribute('aria-label')).toBe(`Fold the ${spec.title} panel`)
      expect(fold?.title).toBe(`Fold the ${spec.title} panel (${spec.keys.toUpperCase()})`)
      expect(fold?.getAttribute('type')).toBe('button')
    }
  })

  it('points the way its own column travels, which is the tab’s chevron mirrored', () => {
    // The rule a later reader will get backwards, so it is asserted for both
    // sides at once: the tab offers to *open* and points away from its edge into
    // the window; this offers to *close* and points at the edge the column goes
    // back against. Files, General and Annotations are on the left and fold left;
    // Aesthetics and Analysis are on the right and fold right.
    for (const spec of ALL_PANELS) {
      const { panel } = mount(spec)
      expect(chevronOf(foldOf(panel))).toBe(spec.side)
      const onTheTab = tabOf(panel)?.querySelector('.panel-tab-chevron') ?? null
      expect(chevronOf(onTheTab)).toBe(spec.side === 'left' ? 'right' : 'left')
    }
  })

  it('folds through the same path as the header button, storage and all', () => {
    const { panel, resizes } = mount()
    const before = resizes()
    foldOf(panel)?.click()

    expect(panel.isCollapsed).toBe(true)
    expect(panel.el.classList.contains('collapsed')).toBe(true)
    // The three observable effects of a fold, whichever control did it: the
    // preference is written, the shell is told to re-measure, and a second window
    // opens folded. Anything that duplicated `fold` instead of calling it would
    // miss at least one of these.
    expect(window.localStorage.getItem(GENERAL_PANEL.key)).toBe('1')
    expect(resizes()).toBe(before + 1)
    expect(new SidePanel(GENERAL_PANEL).isCollapsed).toBe(true)
  })

  it('folds and nothing more: a second click on it cannot re-open the column', () => {
    // Not a toggle. The way back is the tab, which is the affordance a folded
    // column already has, and a button that opened what it had just closed would
    // be a chevron pointing the wrong way half the time.
    const { panel } = mount()
    const fold = foldOf(panel)
    fold?.click()
    fold?.click()
    expect(panel.isCollapsed).toBe(true)
  })

  it('goes away with the heading when the column folds, by the rule that hides it', () => {
    // jsdom applies no stylesheet, so the mechanism is asserted in two halves
    // rather than by measuring a hidden box — and in two halves *on purpose*,
    // because the whole point is that there is no second mechanism here. The
    // button carries no state of its own: it is inside the heading, the heading
    // is one of the column's own children, and one rule takes every one of those
    // away when the column collapses.
    const { panel } = mount()
    const fold = foldOf(panel)
    const head = [...panel.el.children].find((child) => child.contains(fold as Node))
    expect(head?.classList.contains('panel-column-head')).toBe(true)
    expect(head?.classList.contains('panel-tab')).toBe(false)
    expect(collapsedHidesEveryChildButTheTab()).toBe(true)

    panel.toggle.click()
    // Still in the DOM and still itself — the stylesheet is what took it off the
    // screen, so nothing here should have changed the button.
    expect(panel.el.contains(fold as Node)).toBe(true)
    expect(fold?.classList.contains('hidden')).toBe(false)
    expect(fold?.disabled).toBe(false)
  })
})

/**
 * The one rule the test above leans on, read out of the stylesheet itself.
 *
 * `ui/styles.css` hides every child of a collapsed column except its tab — `> *`
 * rather than a list, so that a part added later is folded away with the rest
 * instead of appearing edge-on in a 28-pixel strip. The fold button is such a
 * part, and this is how it disappears; deleting the rule would leave a chevron
 * standing in a folded strip, which no test on the DOM alone could see.
 */
function collapsedHidesEveryChildButTheTab(): boolean {
  // From the working directory rather than from `import.meta.url`, which is the
  // road `test/unit/deck-plot-css.test.ts` takes: under jsdom the module's own
  // URL is not a `file:` one, and resolving against it throws.
  const css = readFileSync(resolve(process.cwd(), 'src/ui/styles.css'), 'utf8')
  const rule = /\.panel-column\.collapsed\s*>\s*\*:not\(\.panel-tab\)\s*\{([^}]*)\}/.exec(css)
  return rule !== null && /display:\s*none/.test(rule[1] ?? '')
}
