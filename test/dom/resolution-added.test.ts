// @vitest-environment jsdom
/**
 * Resolutions the reader adds to a file's ladder (§3.4), as DOM.
 *
 * Two surfaces and one idea between them. The **picker** has to treat an added
 * rung as a rung — in bin-size order, pickable, marked as current when it is —
 * while still saying, in the label itself, that it is not in the file. The
 * **dialog** has to answer *as the number is typed*, because the one thing a
 * reader cannot be expected to know in advance is which resolutions a given
 * ladder can reach.
 *
 * What is pinned here is the part a reader touches. The arithmetic under it is
 * `test/unit/coarsen.test.ts`, which is where the 2.5 kb refusal is argued.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { Breadcrumb, type BreadcrumbProps } from '@/ui/Breadcrumb'
import { openResolutionDialog } from '@/ui/ResolutionDialog'
import { ladderWith, type DerivedRung } from '@/metacooler/coarsen'
import type { ViewState } from '@/types'
import { all, setUpDom, textsOf, type DomTeardown } from '../support/dom'

let teardown: DomTeardown

beforeEach(() => {
  teardown = setUpDom()
})

afterEach(() => {
  teardown()
})

/** The user's own example: a 1 / 2 / 5 / 10 kb ladder. */
const RUNGS = [1_000, 2_000, 5_000, 10_000].map((binsize) => ({
  name: String(binsize),
  binsize,
}))

const REGION: ViewState = { uri: 'f::resolutions/1000', view: 'region', region: 'I' }

interface Built {
  crumb: Breadcrumb
  entries: string[]
  derived: number[]
  dropped: number[]
  adds: number
}

function build(over: Partial<BreadcrumbProps> = {}): Built {
  const entries: string[] = []
  const derived: number[] = []
  const dropped: number[] = []
  let adds = 0
  const crumb = new Breadcrumb({
    rootKind: 'contigs',
    rootChoices: ['contigs'],
    fileLabel: 'sample.mcool',
    entries: RUNGS.map((rung) => rung.name),
    currentEntry: '1000',
    entryNoun: 'resolution',
    onNavigate: () => {},
    onOpenFile: () => {},
    onSelectEntry: (entry) => entries.push(entry),
    onSelectDerived: (binsize) => derived.push(binsize),
    onDropResolution: (binsize) => dropped.push(binsize),
    onAddResolution: () => {
      adds++
    },
    ...over,
  })
  document.body.appendChild(crumb.el)
  return {
    crumb,
    entries,
    derived,
    dropped,
    get adds() {
      return adds
    },
  }
}

/** A crumb whose ladder carries the reader's own 3 kb. */
function withThreeKb(over: Partial<BreadcrumbProps> = {}): Built {
  return build({ ladder: () => ladderWith(RUNGS, [3_000]), ...over })
}

describe('an added resolution in the picker', () => {
  it('sits where its number says — 3 kb before 5 kb, not in a group at the end', () => {
    const { crumb } = withThreeKb()
    crumb.render(REGION)
    expect(textsOf(crumb.el, '.res-stop span')).toEqual([
      '1 kb',
      '2 kb',
      '3 kb*',
      '5 kb',
      '10 kb',
    ])
  })

  it('wears the star in the label, where a number is quoted from', () => {
    const { crumb } = withThreeKb()
    crumb.render(REGION)
    const added = all(crumb.el, '.res-stop.res-added span').map((node) => node.textContent)
    expect(added).toEqual(['3 kb*'])
    // …and the file's own rungs do not.
    expect(textsOf(crumb.el, '.res-stop span').filter((text) => text.endsWith('*'))).toEqual([
      '3 kb*',
    ])
  })

  it('says in its tooltip what it is made of', () => {
    const { crumb } = withThreeKb()
    crumb.render(REGION)
    const stop = crumb.el.querySelector('.res-stop.res-added') as HTMLElement
    expect(stop.title).toContain('not in this file')
    expect(stop.title).toContain('3 of its 1,000 bp bins')
  })

  it('is picked through its own road, not through the entry picker', () => {
    const built = withThreeKb()
    built.crumb.render(REGION)
    const radios = all<HTMLInputElement>(built.crumb.el, '.res-radio')
    radios[2].checked = true
    radios[2].dispatchEvent(new Event('change'))
    // Re-opening the file at an entry called `3000` would fail: there is no
    // such entry, and there never will be.
    expect(built.entries).toEqual([])
    expect(built.derived).toEqual([3_000])
  })

  it('leaves the file’s own rungs going through the entry picker', () => {
    const built = withThreeKb()
    built.crumb.render(REGION)
    const radios = all<HTMLInputElement>(built.crumb.el, '.res-radio')
    radios[3].checked = true
    radios[3].dispatchEvent(new Event('change'))
    expect(built.entries).toEqual(['5000'])
    expect(built.derived).toEqual([])
  })

  it('is what the slider walks onto too', () => {
    const built = withThreeKb()
    built.crumb.render(REGION)
    const slider = built.crumb.el.querySelector('.res-slider') as HTMLInputElement
    expect(slider.max).toBe('4')
    slider.value = '2'
    slider.dispatchEvent(new Event('change'))
    expect(built.derived).toEqual([3_000])
  })
})

describe('standing on an added resolution', () => {
  it('marks it current rather than the rung the file is open at', () => {
    // The file is open at 1 kb — it has to be, since 3 kb is three of its bins
    // — and the axis says 3 kb. Marking the base would put the highlight on a
    // number nothing on screen is drawn at.
    const { crumb } = withThreeKb({ coarsen: () => 3_000 })
    crumb.render(REGION)
    expect(textsOf(crumb.el, '.res-stop.current span')).toEqual(['3 kb*'])
  })

  it('goes back to the open rung when the reader asks for nothing', () => {
    const { crumb } = withThreeKb()
    crumb.render(REGION)
    expect(textsOf(crumb.el, '.res-stop.current span')).toEqual(['1 kb'])
  })

  it('says nothing when the stop already showing is picked again', () => {
    const built = withThreeKb({ coarsen: () => 3_000 })
    built.crumb.render(REGION)
    const slider = built.crumb.el.querySelector('.res-slider') as HTMLInputElement
    slider.dispatchEvent(new Event('change'))
    expect(built.derived).toEqual([])
    expect(built.entries).toEqual([])
  })
})

describe('taking one back off', () => {
  it('offers a × on an added stop and on no other', () => {
    const { crumb } = withThreeKb()
    crumb.render(REGION)
    expect(all(crumb.el, '.res-drop')).toHaveLength(1)
    const stop = crumb.el.querySelector('.res-stop.res-added') as HTMLElement
    expect(stop.querySelector('.res-drop')).not.toBeNull()
  })

  it('removes rather than selects, though it sits inside the label', () => {
    const built = withThreeKb()
    built.crumb.render(REGION)
    const off = built.crumb.el.querySelector('.res-drop') as HTMLButtonElement
    off.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    expect(built.dropped).toEqual([3_000])
    expect(built.derived).toEqual([])
    expect(built.entries).toEqual([])
  })
})

describe('a ladder too long to chip', () => {
  /** Nine rungs, which is past `MAX_STOPS` — the shape a real `.mcool` has. */
  const MANY = [500, 1_000, 2_000, 5_000, 10_000, 20_000, 50_000, 100_000].map((binsize) => ({
    name: String(binsize),
    binsize,
  }))

  it('still lets the reader take their own resolution back off', () => {
    // Above the cap the picker draws one chip and leaves the walking to the
    // slider. A nine-rung file is exactly the one somebody adds a resolution
    // to, and a stop with no way back off it would be a declaration that could
    // only be undone by clearing storage.
    const built = build({
      ladder: () => ladderWith(MANY, [3_000]),
      coarsen: () => 3_000,
      entries: MANY.map((rung) => rung.name),
    })
    built.crumb.render(REGION)
    expect(textsOf(built.crumb.el, '.res-stop span')).toEqual(['3 kb*'])
    const off = built.crumb.el.querySelector('.res-drop') as HTMLButtonElement
    expect(off).not.toBeNull()
    off.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    expect(built.dropped).toEqual([3_000])
  })

  it('offers no × on the file’s own rung, however it is drawn', () => {
    const built = build({
      ladder: () => ladderWith(MANY, [3_000]),
      entries: MANY.map((rung) => rung.name),
      currentEntry: '2000',
    })
    built.crumb.render(REGION)
    expect(textsOf(built.crumb.el, '.res-stop span')).toEqual(['2 kb'])
    expect(built.crumb.el.querySelector('.res-drop')).toBeNull()
  })
})

describe('the + past the coarse end', () => {
  it('is offered beside the ladder', () => {
    const built = withThreeKb()
    built.crumb.render(REGION)
    const add = built.crumb.el.querySelector('.res-add') as HTMLButtonElement
    expect(add).not.toBeNull()
    add.click()
    expect(built.adds).toBe(1)
  })

  it('is the whole control on a plain .cool, which has one resolution', () => {
    // One rung is not a ladder to walk, and it is a ladder to *add to*: a whole
    // number of 1 kb bins is as reachable as a whole number of any other's.
    const built = build({
      ladder: () => ladderWith([{ name: '1000', binsize: 1_000 }], []),
      entries: [],
    })
    built.crumb.render({ uri: 'f.cool', view: 'region', region: 'I' })
    expect(built.crumb.el.querySelector('.crumb-res')).not.toBeNull()
    expect(built.crumb.el.querySelector('.res-add')).not.toBeNull()
    // …and the slider has nowhere to go, so it does not pretend to.
    const slider = built.crumb.el.querySelector('.res-slider') as HTMLInputElement
    expect(slider.disabled).toBe(true)
  })

  it('is absent where the session offers no way to add one', () => {
    const { crumb } = build({ entries: ['1000'], currentEntry: '1000' })
    delete (crumb as unknown as { props: Record<string, unknown> }).props.onAddResolution
    crumb.render(REGION)
    expect(crumb.el.querySelector('.res-add')).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// The dialog
// ---------------------------------------------------------------------------

function dialog(declared: number[] = []): { added: DerivedRung[] } {
  const added: DerivedRung[] = []
  openResolutionDialog({
    rungs: RUNGS,
    declared,
    fileLabel: 'sample.mcool',
    onConfirm: (derived) => added.push(derived),
  })
  return { added }
}

const box = (): HTMLInputElement => document.querySelector('.res-ask') as HTMLInputElement
const verdict = (): HTMLElement => document.querySelector('.res-verdict') as HTMLElement
const addButton = (): HTMLButtonElement =>
  document.querySelector('.res-body .btn-primary') as HTMLButtonElement

/** Type a number into the box, as a reader does. */
function type(value: string): void {
  box().value = value
  box().dispatchEvent(new Event('input'))
}

describe('asking for a resolution', () => {
  it('opens on something that works, rather than on a refusal', () => {
    dialog()
    // Twice the coarsest rung, which any ladder can reach.
    expect(box().value).toBe('20')
    expect(verdict().classList.contains('is-bad')).toBe(false)
    expect(addButton().disabled).toBe(false)
  })

  it('says which bins a good number is made of, as it is typed', () => {
    dialog()
    type('3')
    expect(verdict().textContent).toContain('3,000 bp')
    expect(verdict().textContent).toContain('3 of this file’s 1 kb bins')
    expect(addButton().disabled).toBe(false)
  })

  it('names what is wrong with one that cannot be reached', () => {
    dialog()
    type('2.5')
    expect(verdict().classList.contains('is-bad')).toBe(true)
    expect(verdict().textContent).toContain('Not a whole number of bins')
    expect(addButton().disabled).toBe(true)
  })

  it('refuses a resolution the file already carries, and says so', () => {
    dialog()
    type('5')
    expect(verdict().textContent).toContain('already carries')
    expect(addButton().disabled).toBe(true)
  })

  it('refuses one the reader has already added', () => {
    dialog([3_000])
    type('3')
    expect(verdict().textContent).toContain('already added')
    expect(addButton().disabled).toBe(true)
  })

  it('reads the unit beside the box, not a suffix in it', () => {
    dialog()
    type('3')
    const units = all<HTMLInputElement>(document.body, '.res-unit-radio')
    expect(units).toHaveLength(3)
    // 3 bp is finer than the file's own bins; 3 kb is three of them.
    units[0].checked = true
    units[0].dispatchEvent(new Event('change'))
    expect(verdict().textContent).toContain('Finer than')
    units[1].checked = true
    units[1].dispatchEvent(new Event('change'))
    expect(verdict().textContent).toContain('3,000 bp')
  })

  it('hands back the arithmetic rather than the number, so nothing re-derives it', () => {
    const { added } = dialog()
    type('3')
    addButton().click()
    expect(added).toEqual([
      { binsize: 3_000, from: { name: '1000', binsize: 1_000 }, factor: 3 },
    ])
  })

  it('takes Enter in the box as the button', () => {
    const { added } = dialog()
    type('4')
    box().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    expect(added.map((rung) => rung.binsize)).toEqual([4_000])
  })

  it('does nothing on Enter over a refusal', () => {
    const { added } = dialog()
    type('2.5')
    box().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    expect(added).toEqual([])
  })

  it('says once that counts add up exactly and balanced values do not', () => {
    dialog()
    const body = document.querySelector('.res-body') as HTMLElement
    expect(body.textContent).toContain('Counts add up exactly')
    expect(body.textContent).toContain('balanced at the finer one')
  })
})
