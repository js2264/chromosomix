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
import { Chooser, chooserPlan, chooserWords, chooseStep, type ChooserKind } from '@/curate/ui/Chooser'
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

  it('gives back the steps of a question priced before it opened, on Escape', async () => {
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
    expect(s.model.previewSteps).toEqual(held)
  })

  it('prices the row under the keyboard, and gives the preview held before back on Escape', async () => {
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
    expect(textsOf(document.body, '.curate-card-price-name')).toEqual(['X1', 'Y'])
    expect(textsOf(document.body, '.curate-card-price-line')).toEqual(['completeness 50% → 50%', 'redundancy 1.00 → 1.00', 'completeness 100% → 100%', 'redundancy 1.00 → 1.00'])
    key('Escape')
    expect(Chooser.isOpen()).toBe(false)
    expect(s.model.previewStep).toEqual(held)
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
