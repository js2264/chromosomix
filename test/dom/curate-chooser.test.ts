// @vitest-environment jsdom
// @dev-feature curate
/**
 * The curation stage's chooser (SPECS §33.3), in a DOM: the genomes it ranks
 * for contigs, for a MAG and for an element, the rows a filter keeps, ↑ ↓ Enter
 * Escape, the step of the row under the keyboard priced before it is made, and
 * the step a choice makes.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { bareAnswer } from '@/curate/answer'
import { CurateModel } from '@/curate/model'
import { Chooser, chooserFrame, chooserPlan, chooserWords, chooseStep, type ChooserKind } from '@/curate/ui/Chooser'
import type { CurateDropTarget } from '@/curate/ui/context'
import { CuratedBinning, fileBinning } from '@/genome/curation'
import { CurationStore } from '@/state/curation'
import { setUpDom, textsOf, type DomTeardown } from '../support/dom'
import { community } from '../support/curateCommunity'
import { testContext, type TestStage } from '../support/curateStage'

let teardown: DomTeardown

beforeEach(() => {
  teardown = setUpDom({ canvas: 'stub' })
  window.sessionStorage.clear()
  window.localStorage.clear()
})

afterEach(() => {
  Chooser.closeOpen()
  teardown()
})

/** The community counted once, a selection made. */
async function stage(select: { genomes?: string[]; contigs?: number[] }): Promise<TestStage> {
  const s = testContext()
  await s.model.settled()
  s.model.select({ genomes: select.genomes ?? [], contigs: select.contigs ?? [] })
  return s
}

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/** The rows a plan lists, as `name: evidence`, the extras by their words. */
function listed(s: TestStage, kind: ChooserKind): string[] {
  const answer = s.model.answer
  if (answer === null) throw new Error('not counted')
  const plan = chooserPlan({ kind, answer, selection: s.model.selection, order: s.model.order, offered: s.model.offered(), names: s.ctx.data.file.names })
  return plan.rows.map((row) => `${row.label ?? answer.genomes[row.genome].name}: ${row.evidence}${row.confidence === null ? '' : ` · ${Math.round(row.confidence * 100)}%`}`)
}

/** Open a chooser at a point, its choices kept. */
function open(s: TestStage, kind: ChooserKind): { chooser: Chooser; chosen: CurateDropTarget[] } {
  const chosen: CurateDropTarget[] = []
  const chooser = Chooser.open(s.ctx, kind, { x: 20, y: 20 }, (target) => chosen.push(target))
  return { chooser, chosen }
}

function key(name: string): void {
  const box = document.querySelector('.curate-chooser-filter') as HTMLInputElement
  box.dispatchEvent(new KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true }))
}

function type(text: string): void {
  const box = document.querySelector('.curate-chooser-filter') as HTMLInputElement
  box.value = text
  box.dispatchEvent(new Event('input', { bubbles: true }))
}

const rowNames = (): string[] => textsOf(document.body, '.curate-chooser-row .curate-chooser-name')
const active = (): string => (document.querySelector('.curate-chooser-row.is-active .curate-chooser-name')?.textContent ?? '').trim()

describe('what the chooser ranks', () => {
  it('sends a misplaced contig where it meets most, then offers a new genome, the pool and the rest', async () => {
    const s = await stage({ contigs: [3] })
    expect(listed(s, 'move')).toEqual([
      'Y: affinity 1.25 · its own 0 · 97%',
      'a new MAG: of y5',
      'a new element: of y5',
      'unbinned: out of every genome',
      'X2: 150.0 kb · 3 contigs',
      'Z: 200.0 kb · 4 contigs',
      'P: 100.0 kb · 2 contigs',
    ])
  })

  it('ranks contigs by where they meet most — their own genome where they are at home — then where they meet next', async () => {
    // x0, x1, x2 at home in X1; y5 misplaced in X1; u0 unbinned, X's.
    const s = await stage({ contigs: [0, 1, 2, 3, 18] })
    expect(listed(s, 'move').filter((row) => !/^(a new|unbinned)/.test(row))).toEqual([
      'X1: 4 of 5 meet it most · affinity 2.66 · 3 in it already · 98%',
      'Y: 1 of 5 meet it most · affinity 1.25 · 97%',
      'X2: 3 of 5 meet it next · affinity 1.50',
      'Z: 200.0 kb · 4 contigs',
      'P: 100.0 kb · 2 contigs',
    ])
  })

  it('offers a contig at home where it would go next, never where it is', async () => {
    const s = await stage({ contigs: [0] })
    expect(listed(s, 'move')[0]).toBe('X2: meets it next · affinity 1.50 · its own 2.89')
    expect(listed(s, 'move').some((row) => row.startsWith('X1:'))).toBe(false)
  })

  it('says what a choice makes in the names the stage prints', async () => {
    const s = await stage({ contigs: [3] })
    const answer = s.model.answer
    if (answer === null) throw new Error('not counted')
    const short = (id: string): string => `short-${id}`
    const plan = chooserPlan({ kind: 'move', answer, selection: s.model.selection, order: s.model.order, offered: s.model.offered(), names: s.ctx.data.file.names, shortName: short })
    const words = (target: CurateDropTarget): string | null => chooserWords(answer, plan, target, s.ctx.data.file.names, short)
    expect(words({ kind: 'genome', id: 'Y' })).toBe('move y5 into short-Y')
    expect(words({ kind: 'genome', id: 'X1' })).toBeNull()
    expect(words({ kind: 'section', section: 'elements' })).toBe('a new element of y5')
    expect(words({ kind: 'pool' })).toBe('unbin y5')
    s.model.select({ genomes: ['X2', 'X1'], contigs: [] })
    const merge = chooserPlan({ kind: 'merge', answer, selection: s.model.selection, order: s.model.order, offered: s.model.offered(), names: s.ctx.data.file.names, shortName: short })
    expect(chooserWords(answer, merge, { kind: 'genome', id: 'X1' }, s.ctx.data.file.names, short)).toBe('merge short-X2 into short-X1')
  })

  it('ranks a MAG’s merges by pair affinity, of its own kind only', async () => {
    const s = await stage({ genomes: ['X1'] })
    expect(listed(s, 'merge')).toEqual([
      'X2: affinity 1.50 (at least 1.42) · 540 contacts · 100%',
      'Y: affinity 0.46 (at least 0.42) · 300 contacts',
      'Z: affinity 0.0020 (at least 0.00021) · 1 contact',
    ])
  })

  it('lists, with several selected, the one that keeps its name first', async () => {
    const s = await stage({ genomes: ['X2', 'X1'] })
    const rows = listed(s, 'merge')
    expect(rows.slice(0, 2)).toEqual(['X1: 200.0 kb · the others merge into it', 'X2: 150.0 kb · the others merge into it'])
    expect(rows[2]).toMatch(/^Y: affinity 0\.46/)
  })

  it('ranks an element’s hosts, leaving out the MAG it is linked to', async () => {
    const s = await stage({ genomes: ['P'] })
    const rows = listed(s, 'link')
    expect(rows[0]).toBe('Y: affinity 0.53 · 99% of its MAG contacts · 120 contacts · 100%')
    expect(rows.slice(1)).toEqual(['X1: 200.0 kb · 4 contigs', 'X2: 150.0 kb · 3 contigs'])
  })

  it('turns move into merge for genomes, and says why when there is nothing to choose', async () => {
    const s = await stage({ genomes: ['X1', 'P'] })
    const answer = s.model.answer
    if (answer === null) throw new Error('not counted')
    const plan = chooserPlan({ kind: 'move', answer, selection: s.model.selection, order: s.model.order, offered: s.model.offered(), names: s.ctx.data.file.names })
    expect(plan.kind).toBe('merge')
    expect(plan.rows).toEqual([])
    expect(plan.empty).toBe('Merge MAGs or elements, one kind at a time: an element and a MAG are linked.')
  })
})

describe('the popover', () => {
  it('opens on the first row, walks with ↓ ↑, and takes the row under the keyboard with Enter', async () => {
    const s = await stage({ contigs: [3] })
    const { chosen } = open(s, 'move')
    expect(document.querySelector('.curate-chooser-title')?.textContent).toBe('move y5 to…')
    expect(rowNames()).toEqual(['Y', 'a new MAG', 'a new element', 'unbinned', 'X2', 'Z', 'P'])
    expect(active()).toBe('Y')
    expect(document.activeElement).toBe(document.querySelector('.curate-chooser-filter'))
    key('ArrowDown')
    expect(active()).toBe('a new MAG')
    key('ArrowUp')
    key('ArrowUp')
    expect(active()).toBe('P')
    key('Enter')
    expect(chosen).toEqual([{ kind: 'genome', id: 'P' }])
    expect(Chooser.isOpen()).toBe(false)
    expect(document.querySelector('.curate-chooser')).toBeNull()
  })

  it('keeps the rows a filter matches, and never takes a new genome nobody named', async () => {
    const s = await stage({ contigs: [3] })
    const { chosen } = open(s, 'move')
    type('z')
    expect(rowNames()).toEqual(['Z'])
    type('new')
    expect(rowNames()).toEqual(['a new MAG', 'a new element'])
    key('Enter')
    expect(chosen).toEqual([])
    key('ArrowDown')
    key('Enter')
    expect(chosen).toEqual([{ kind: 'section', section: 'mags' }])
  })

  it('finds a row whatever the case typed', async () => {
    const s = await stage({ contigs: [3] })
    open(s, 'move')
    type('MAG')
    expect(rowNames()).toEqual(['a new MAG'])
    type('mag')
    expect(rowNames()).toEqual(['a new MAG'])
    type('UNB')
    expect(rowNames()).toEqual(['unbinned'])
  })

  it('lets go of its own preview on Escape, never puts back a copy of what was held: the stage prices review’s question again', async () => {
    const s = await stage({ contigs: [3] })
    const held = [
      { op: 'move' as const, contigs: ['u0'], to: 'X1' },
      { op: 'merge' as const, into: 'X1', genomes: ['X2'] },
    ]
    s.model.preview(held, false)
    open(s, 'move')
    await wait(120)
    expect(s.model.previewStep).toEqual({ op: 'move', contigs: ['y5'], to: 'Y' })
    key('Escape')
    expect(s.model.previewSteps).toBeNull()
  })

  it('takes one row for Enter held down, and leaves on Tab with the keyboard back where it came from', async () => {
    const s = await stage({ genomes: ['X1'] })
    const opener = document.createElement('button')
    document.body.appendChild(opener)
    opener.focus()
    open(s, 'merge')
    await wait(0)
    const box = document.querySelector('.curate-chooser-filter') as HTMLInputElement
    box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', repeat: true, bubbles: true, cancelable: true }))
    expect(Chooser.isOpen()).toBe(true)
    expect(s.store.applied).toBe(0)
    box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }))
    expect(Chooser.isOpen()).toBe(false)
    expect(s.store.applied).toBe(0)
  })

  it('keeps the caret in its box for a press anywhere in it but the box', async () => {
    const s = await stage({ contigs: [3] })
    open(s, 'move')
    await wait(0)
    const title = document.querySelector('.curate-chooser-title') as HTMLElement
    const press = new MouseEvent('mousedown', { bubbles: true, cancelable: true })
    title.dispatchEvent(press)
    expect(press.defaultPrevented).toBe(true)
    const box = document.querySelector('.curate-chooser-filter') as HTMLInputElement
    const inBox = new MouseEvent('mousedown', { bubbles: true, cancelable: true })
    box.dispatchEvent(inBox)
    expect(inBox.defaultPrevented).toBe(false)
    expect(s.model.selection.contigs).toEqual([3])
  })

  it('prices the row under the keyboard, and lets go of its price on Escape', async () => {
    const s = await stage({ contigs: [3] })
    const held = { op: 'dissolve' as const, genome: 'Z' }
    s.model.preview(held, false)
    open(s, 'move')
    await wait(120)
    await s.model.settled()
    expect(s.model.previewStep).toEqual({ op: 'move', contigs: ['y5'], to: 'Y' })
    await wait(0)
    expect(s.model.previewed).not.toBeNull()
    expect(document.querySelector('.curate-chooser-words')?.textContent).toBe('move y5 into Y')
    // The genome the contig goes to first, then the one it leaves.
    expect(textsOf(document.body, '.curate-card-price-name')).toEqual(['Y', 'X1'])
    expect(textsOf(document.body, '.curate-card-price-line')).toEqual(['complete 100% → 100%', 'redundant 1.00 → 1.00', 'complete 50% → 50%', 'redundant 1.00 → 1.00'])
    key('Escape')
    expect(Chooser.isOpen()).toBe(false)
    // Its own preview let go of: what was held before is not put back.
    expect(s.model.previewStep).toBeNull()
  })

  it('closes when the selection changes, or when the stage closes it', async () => {
    const s = await stage({ genomes: ['X1'] })
    open(s, 'merge')
    expect(Chooser.isOpen()).toBe(true)
    s.model.selectGenomes(['Y'])
    expect(Chooser.isOpen()).toBe(false)
    open(s, 'merge')
    expect(Chooser.closeOpen()).toBe(true)
    expect(Chooser.closeOpen()).toBe(false)
  })

  it('chooses with a press on a row', async () => {
    const s = await stage({ genomes: ['X1'] })
    const { chosen } = open(s, 'merge')
    const row = [...document.querySelectorAll<HTMLElement>('.curate-chooser-row')].find((node) => node.dataset.genome === 'Y')
    row?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    expect(chosen).toEqual([{ kind: 'genome', id: 'Y' }])
  })

  it('closes on a press outside it', async () => {
    const s = await stage({ genomes: ['X1'] })
    open(s, 'merge')
    document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))
    expect(Chooser.isOpen()).toBe(false)
  })

  it('keeps the caret in its box when a row is pressed', async () => {
    const s = await stage({ genomes: ['X1'] })
    open(s, 'merge')
    const row = document.querySelector<HTMLElement>('.curate-chooser-row') as HTMLElement
    const down = new MouseEvent('mousedown', { bubbles: true, cancelable: true })
    row.dispatchEvent(down)
    expect(down.defaultPrevented).toBe(true)
  })

  it('says the genomes are not ranked before the contacts are read', async () => {
    const s = testContext()
    // The answer before the network's pass: the genomes and their links, no pairs.
    const { base, evidence } = community()
    const store = new CurationStore(`curate-bare-${Math.random()}`, base, fileBinning(base), () => 0)
    const model = new CurateModel(
      store,
      { state: (curation) => ({ promise: Promise.resolve(bareAnswer(CuratedBinning.of(base, curation), base.lengths, evidence.markers)), cancel: () => {} }) },
      { schedule: (run) => (run(), () => {}) },
    )
    s.model.dispose()
    const bare: TestStage = { ...s, model, store, ctx: { ...s.ctx, model } }
    await model.settled()
    model.select({ genomes: ['X1'], contigs: [] })
    open(bare, 'merge')
    expect(document.querySelector('.curate-chooser-note')?.textContent).toBe('Not ranked until the contacts are read.')
    expect(rowNames()).toEqual(['X2', 'Y', 'Z'])
    model.dispose()
  })
})

describe('the price of the row under the keyboard', () => {
  /** The keyboard on the row a filter finds, its step priced and counted. */
  async function priced(s: TestStage, name: string): Promise<void> {
    type(name)
    expect(active()).toBe(name)
    await wait(120)
    await s.model.settled()
    await wait(0)
  }

  it('prices a MAG that takes an element in whole by its own numbers, the element counted, not summed', async () => {
    // y5 out of X1, and both of the element P's contigs: P is emptied into Y.
    const s = await stage({ contigs: [3, 16, 17] })
    open(s, 'move')
    await priced(s, 'Y')
    expect(document.querySelector('.curate-chooser-words')?.textContent).toBe('move 3 contigs into Y')
    expect(textsOf(document.body, '.curate-card-price-name')).toEqual(['Y', 'X1'])
    // Never its length alone: the genome the contigs go to wears its completeness and redundancy.
    expect(textsOf(document.body, '.curate-card-price-line')).toEqual(['complete 100% + 1 more → 100%', 'redundant 1.00 + 1 more → 1.00', 'complete 50% → 50%', 'redundant 1.00 → 1.00'])
    // What `+ 1 more` is, by its name.
    expect(document.querySelector('.curate-card-price-row')?.getAttribute('title')).toBe('Y: complete 100% + 1 more → 100%, redundant 1.00 + 1 more → 1.00; takes in P whole')
  })

  it('says what the genomes it does not list do under the price, never scrolled away with it', async () => {
    // Too narrow a window for the price beside the list: under it, three genomes.
    Object.defineProperty(window, 'innerWidth', { value: 200, configurable: true })
    try {
      // One contig each out of X1, X2 and Z, into Y: four genomes changed, each a grade lower.
      const s = await stage({ contigs: [0, 4, 12] })
      open(s, 'move')
      expect(document.querySelector('.curate-chooser')?.classList.contains('is-beside')).toBe(false)
      await priced(s, 'Y')
      expect(textsOf(document.body, '.curate-chooser-price .curate-card-price-name')).toEqual(['Y', 'Z', 'X1'])
      const others = document.querySelector('.curate-chooser-others')
      expect(others?.textContent).toBe('and 1 more genome loses contigs · 1 falls a grade')
      expect(others?.querySelector('.is-demoted')?.textContent).toBe('1 falls a grade')
      // Outside the box that scrolls, under it.
      expect(others?.closest('.curate-chooser-price')).toBeNull()
      expect(others?.previousElementSibling?.classList.contains('curate-chooser-price')).toBe(true)
      expect(document.querySelector('.curate-chooser-price .curate-card-price-more')).toBeNull()
    } finally {
      Object.defineProperty(window, 'innerWidth', { value: 1024, configurable: true })
    }
  })

  it('keeps no pane for a link, which moves no contig: its step said under the list', async () => {
    const s = await stage({ genomes: ['P'] })
    open(s, 'link')
    await wait(120)
    expect(document.querySelector('.curate-chooser')?.classList.contains('is-beside')).toBe(false)
    expect(document.querySelector('.curate-chooser-words')?.textContent).toBe('link P to Y')
    expect(document.querySelector('.curate-chooser-price')).toBeNull()
  })

  it('prices five genomes in the pane beside the list, and says so when nothing is under the keyboard', async () => {
    const s = await stage({ contigs: [0, 4, 12] })
    open(s, 'move')
    expect(document.querySelector('.curate-chooser')?.classList.contains('is-beside')).toBe(true)
    await priced(s, 'Y')
    expect(textsOf(document.body, '.curate-chooser-price .curate-card-price-name')).toEqual(['Y', 'Z', 'X1', 'X2'])
    expect(document.querySelector('.curate-chooser-others')).toBeNull()
    type('nothing is named so')
    const foot = document.querySelector('.curate-chooser-foot') as HTMLElement
    expect(foot.classList.contains('hidden')).toBe(false)
    expect(foot.textContent).toBe('The row under the keyboard is priced here.')
  })
})

describe('where the chooser stands', () => {
  const box = (left: number, top: number, width: number, height: number): DOMRect =>
    ({ left, top, width, height, right: left + width, bottom: top + height, x: left, y: top, toJSON: () => ({}) }) as DOMRect

  it('puts the list in the column of the card it opens from, the price beside it where the window has room', () => {
    const list = { own: 368, least: 288 }
    // The inspector's card at 1600 px: the list on the card's edges, the price over the pictures.
    expect(chooserFrame(1600, { left: 1246, width: 341 }, 1258, list, 320)).toEqual({ left: 926, width: 661, beside: true })
    // No room left of the card: the price under the list, the list still on the card's edges.
    expect(chooserFrame(700, { left: 300, width: 341 }, 312, list, 320)).toEqual({ left: 300, width: 341, beside: false })
    // A card narrower than the list's least: the list keeps the card's right edge.
    expect(chooserFrame(1600, { left: 1300, width: 200 }, 1312, list, 320)).toEqual({ left: 892, width: 608, beside: true })
    // Nothing to price: no pane for it.
    expect(chooserFrame(1600, { left: 1246, width: 341 }, 1258, list, 0)).toEqual({ left: 1246, width: 341, beside: false })
    // At a point: from the point, both panes where they fit, else the list alone, inside the window.
    expect(chooserFrame(1600, null, 411, list, 320)).toEqual({ left: 411, width: 688, beside: true })
    expect(chooserFrame(600, null, 411, list, 320)).toEqual({ left: 224, width: null, beside: false })
  })

  it('stands beside the card of the act that opened it, its list on the card’s edges', async () => {
    const s = await stage({ contigs: [3] })
    const card = document.createElement('section')
    card.className = 'edit-card'
    const act = document.createElement('button')
    card.appendChild(act)
    document.body.appendChild(card)
    card.getBoundingClientRect = () => box(660, 100, 340, 400)
    act.getBoundingClientRect = () => box(672, 150, 120, 30)
    Chooser.open(s.ctx, 'move', act, () => {})
    const chooser = document.querySelector('.curate-chooser') as HTMLElement
    expect(chooser.classList.contains('is-beside')).toBe(true)
    const left = parseFloat(chooser.style.left)
    const width = parseFloat(chooser.style.width)
    // Its right edge the card's, the price's pane all that stands left of the card.
    expect(left + width).toBe(1000)
    expect(width - 340).toBe(parseFloat(chooser.style.getPropertyValue('--chooser-price')))
    // Under the act.
    expect(chooser.style.top).toBe('184px')
    Chooser.closeOpen()
    // A card with no room left of it: the list alone, on the card's edges.
    card.getBoundingClientRect = () => box(120, 100, 340, 400)
    act.getBoundingClientRect = () => box(132, 150, 120, 30)
    Chooser.open(s.ctx, 'move', act, () => {})
    const alone = document.querySelector('.curate-chooser') as HTMLElement
    expect(alone.classList.contains('is-beside')).toBe(false)
    expect([alone.style.left, alone.style.width]).toEqual(['120px', '340px'])
  })
})

describe('the step a choice makes', () => {
  it('moves contigs, merges genomes and links an element, as a drop would', async () => {
    const s = await stage({ contigs: [3] })
    expect(chooseStep(s.ctx, 'move', { kind: 'genome', id: 'Y' })).toBe(true)
    await s.model.settled()
    expect(s.store.binning.genomeOf[3]).toBe(s.store.binning.indexOfId('Y'))
    s.model.select({ genomes: ['X1'], contigs: [] })
    expect(chooseStep(s.ctx, 'merge', { kind: 'genome', id: 'X2' })).toBe(true)
    await s.model.settled()
    expect(s.model.answer?.genomes.map((genome) => genome.id)).not.toContain('X1')
    s.model.select({ genomes: ['P'], contigs: [] })
    expect(chooseStep(s.ctx, 'link', { kind: 'genome', id: 'Y' })).toBe(true)
    await s.model.settled()
    expect(s.model.answer?.links.map((link) => `${link.element}>${link.mag}`)).toContain('P>Y')
  })

  it('links the element chosen to the one MAG selected', async () => {
    const s = await stage({ genomes: ['Y'] })
    const answer = s.model.answer
    if (answer === null) throw new Error('not counted')
    const plan = chooserPlan({ kind: 'link', answer, selection: s.model.selection, order: s.model.order, offered: s.model.offered(), names: s.ctx.data.file.names })
    expect(plan.title).toBe('link Y to…')
    expect(plan.rows.map((row) => answer.genomes[row.genome].name)).toEqual(['P'])
    expect(chooseStep(s.ctx, 'link', { kind: 'genome', id: 'P' })).toBe(true)
    await s.model.settled()
    expect(s.model.answer?.links.map((link) => `${link.element}>${link.mag}`)).toContain('P>Y')
  })
})
