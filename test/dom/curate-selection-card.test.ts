// @vitest-environment jsdom
// @dev-feature curate
/**
 * The curation stage's selection card (SPECS §33.3), in a DOM: what it shows
 * of nothing, a MAG, an element, an element and a MAG, several genomes and
 * contigs; its acts and the hooks they ask the stage for; a row's act making
 * the step its suggestion offers; a hover pricing a step, and the after column
 * it fills; every affinity put against the background and every confidence
 * saying what it is sure of; and the card before the contacts are read.
 */

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { bareAnswer } from '@/curate/answer'
import { CurateModel } from '@/curate/model'
import type { Suggestion } from '@/curate/suggest'
import type { CurateContext } from '@/curate/ui/context'
import { affinityAgainst, affinityNumber, SelectionCard, type SelectionHooks } from '@/curate/ui/cards/SelectionCard'
import { priceList, qualityShift } from '@/curate/ui/cards/card'
import type { Quality } from '@/curate/quality'
import { CuratedBinning, fileBinning } from '@/genome/curation'
import { CurationStore } from '@/state/curation'
import { setUpDom, textsOf, type DomTeardown } from '../support/dom'
import { community } from '../support/curateCommunity'
import { testContext, type TestStage } from '../support/curateStage'

let teardown: DomTeardown
let cards: SelectionCard[] = []

beforeEach(() => {
  teardown = setUpDom({ canvas: 'stub' })
  window.sessionStorage.clear()
  window.localStorage.clear()
})

afterEach(() => {
  for (const card of cards) card.dispose()
  cards = []
  teardown()
})

interface Mounted extends TestStage {
  card: SelectionCard
  asked: string[]
  anchors: Array<HTMLElement | undefined>
}

/** A card over the community, counted once, the hooks it asks kept. */
async function mount(ctxOf: (stage: TestStage) => CurateContext = (stage) => stage.ctx, options: { layOut?: boolean } = {}): Promise<Mounted> {
  const stage = testContext()
  const asked: string[] = []
  const anchors: Array<HTMLElement | undefined> = []
  const hooks: SelectionHooks = {
    rename: (id) => asked.push(`rename ${id}`),
    closeUp: () => asked.push('close-up'),
    choose: (kind, anchor) => {
      asked.push(`choose ${kind}`)
      anchors.push(anchor)
    },
    ...(options.layOut === true ? { layOut: (id: string) => asked.push(`lay out ${id}`) } : {}),
  }
  const card = new SelectionCard(ctxOf(stage), hooks)
  cards.push(card)
  document.body.appendChild(card.element)
  await stage.model.settled()
  await frame()
  return { ...stage, card, asked, anchors }
}

const frame = (): Promise<void> => new Promise((resolve) => requestAnimationFrame(() => resolve()))
const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

async function select(m: Mounted, selection: { genomes?: string[]; contigs?: number[] }): Promise<void> {
  m.model.select({ genomes: selection.genomes ?? [], contigs: selection.contigs ?? [] })
  await frame()
}

/** After a step: counted again, and drawn. */
async function settle(m: TestStage): Promise<void> {
  await m.model.settled()
  await frame()
}

const head = (): string => (document.querySelector('.curate-selection-card .edit-card-head')?.textContent ?? '').trim()
const subs = (): string[] => textsOf(document.body, '.curate-selection-sub')
/** An act by its word, without the key printed after it. */
function act(label: string): HTMLButtonElement {
  const found = [...document.querySelectorAll<HTMLButtonElement>('.edit-act')].find((button) => button.querySelector('.edit-act-label')?.textContent === label)
  if (found === undefined) throw new Error(`no act ${label}: ${actLabels().join(', ')}`)
  return found
}
const actLabels = (): string[] => textsOf(document.body, '.curate-card-acts .edit-act-label')
const actKeys = (): string[] => textsOf(document.body, '.curate-card-acts .edit-act .kbd-inline')
/** The rows of the list under a sub-heading. */
function rowsUnder(sub: string): HTMLElement[] {
  const heading = [...document.querySelectorAll('.curate-selection-sub')].find((node) => node.textContent?.trim().startsWith(sub))
  let next = heading?.nextElementSibling ?? null
  while (next !== null && !next.classList.contains('curate-selection-list')) next = next.nextElementSibling
  return next === null ? [] : [...next.querySelectorAll<HTMLElement>('.curate-selection-row')]
}
const rowText = (row: HTMLElement): string =>
  [row.querySelector('.curate-selection-row-main')?.textContent, row.querySelector('.curate-selection-row-detail')?.textContent].map((t) => (t ?? '').trim()).join(' | ')
/** Words as read, the spaces that keep them on one line read as spaces. */
const words = (text: string): string => text.replace(/\u00a0/g, ' ')
const rowActLabel = (row: HTMLElement): string | null => row.querySelector('.curate-selection-row-act')?.textContent ?? null
const confidences = (): string[] => textsOf(document.body, '.curate-selection-row-confidence')
function rowAct(row: HTMLElement): HTMLButtonElement {
  const button = row.querySelector<HTMLButtonElement>('.curate-selection-row-act')
  if (button === null) throw new Error(`no act on ${rowText(row)}`)
  return button
}

describe('the selection card, by what is selected', () => {
  it('teaches the gesture with nothing selected, and tallies the map', async () => {
    await mount()
    expect(head()).toBe('selection')
    expect(document.querySelector('.curate-selection-card .edit-empty')?.textContent).toContain('drag along the map’s diagonal')
    const [counts, grades, steps] = textsOf(document.body, '.curate-selection-tally > div')
    expect([counts, words(grades), steps]).toEqual(['4 MAGs · 1 element · 1 unbinned contig (50.0 kb)', '2 high quality · 2 low', 'as in the file'])
    // A count and its grade never parted by a line's end: only the separators break.
    expect(grades.split(' · ').every((chunk) => !chunk.includes(' '))).toBe(true)
  })

  it('counts every MAG in its tally, the ones under 50% complete too: the counts add up to the MAGs', async () => {
    const m = await mount()
    // A MAG of x2 alone, which carries no marker: 0% complete, which metaTOR does not grade.
    m.store.apply({ op: 'create', id: 'curated:1', name: 'E0', kind: 'mag', contigs: ['x2'] })
    await settle(m)
    const [counts, grades] = textsOf(document.body, '.curate-selection-tally > div')
    expect(counts).toMatch(/^5 MAGs · /)
    expect(words(grades)).toBe('2 high quality · 2 low · 1 under 50% complete')
    expect(grades.split(' · ').reduce((sum, part) => sum + Number.parseInt(part, 10), 0)).toBe(5)
  })

  it('shows a MAG: its numbers, its quality, what it meets, what belongs in it and what may not', async () => {
    const m = await mount()
    await select(m, { genomes: ['X1'] })
    expect(head()).toBe('MAG · X1')
    expect(document.querySelector('.curate-selection-facts')?.textContent).toBe('200.0 kb · 4 contigs')
    expect(textsOf(document.body, '.curate-selection-quality .is-value')).toEqual(['50.0%', '50.0%', '1.00', '1.00'])
    expect(document.querySelector('.curate-selection-grade')?.textContent).toBe('Bact4 · 2 of 4 markers · low quality')
    expect(actLabels()).toEqual(['rename', 'merge into…', 'close-up', 'make it an element', 'dissolve'])
    expect(actKeys()).toEqual(['F2', 'M', '⏎', 'E', '⌫'])
    expect(subs()).toEqual(['meets most', 'belong here · 1', 'may belong elsewhere · 1'])
    // Each affinity against the background (0.0062 here): how far its cautious lower bound stands above it, or that it does not.
    expect(rowsUnder('meets most').map(rowText)).toEqual([
      'X299% one organism | affinity 1.50 (at least 228× background) · 540 contacts',
      'Y | affinity 0.46 (at least 68× background) · 300 contacts',
      'Z | affinity below the background · 1 contact',
    ])
    expect(rowsUnder('belong here').map(rowText)).toEqual(['u098% sure | from the pool · affinity 1.95 (at least 285× background) · 180 contacts'])
    // Where it would go opens the second line, so neither name is cut for the other.
    expect(rowsUnder('may belong elsewhere').map(rowText)).toEqual(['y597% sure | →Y · its own 0 · there 1.25 (at least 187× background) · 300 contacts'])
    // What `at least` means, once, under the first list that leans on it.
    expect(textsOf(document.body, '.curate-selection-key')).toEqual(['at least: the cautious lower bound the contacts allow · the background 0.0062'])
    expect(document.querySelector('.curate-selection-key')?.previousElementSibling?.textContent).toBe('meets most')
  })

  it('offers to edit one genome’s sequence first of its acts where the reference editing is on, and says when it is laid out', async () => {
    const m = await mount((stage) => ({ ...stage.ctx, laidOut: (id: string) => id === 'P' }), { layOut: true })
    await select(m, { genomes: ['X1'] })
    expect(actLabels()).toEqual(['edit the sequence…', 'rename', 'merge into…', 'close-up', 'make it an element', 'dissolve'])
    expect(actKeys()).toEqual(['S', 'F2', 'M', '⏎', 'E', '⌫'])
    const sequence = document.querySelector('[data-focus="act:edit the sequence…"]') as HTMLButtonElement
    // Haloed apart from the steps: the door to another tool.
    expect(sequence.classList.contains('curate-act-sequence')).toBe(true)
    expect(sequence.classList.contains('is-laid-out')).toBe(false)
    expect(sequence.title).toMatch(/^Order, turn, join and cut its contigs in the reference editor/)
    sequence.click()
    expect(m.asked).toEqual(['lay out X1'])
    // An element too, first as well; one laid out says so in its title.
    await select(m, { genomes: ['P'] })
    expect(actLabels()[0]).toBe('edit the sequence…')
    const laid = document.querySelector('[data-focus="act:edit the sequence…"]') as HTMLButtonElement
    expect(laid.classList.contains('is-laid-out')).toBe(true)
    expect(laid.title).toMatch(/^Its sequence as laid out, in the reference editor/)
  })

  it('shows an element: its hosts held and offered', async () => {
    const m = await mount()
    await select(m, { genomes: ['P'] })
    expect(head()).toBe('element · P')
    expect(actLabels()).toEqual(['link to…', 'merge into…', 'rename', 'make it a MAG', 'dissolve'])
    // A link's confidence is that the MAG hosts it, an unlink's that it does not.
    expect(rowsUnder('hosts').map(rowText)).toEqual([
      'Zlinked99% not its host | from the file · affinity below the background · 1% of its MAG contacts · 1 contact',
      'Y99% its host | offered · affinity 0.53 (at least 76× background) · 99% of its MAG contacts · 120 contacts',
    ])
    expect(rowsUnder('hosts').map((row) => row.querySelector<HTMLElement>('.curate-selection-row-confidence')?.title)).toEqual([
      'An unlink on offer: the method is 99% sure Z does not host P',
      'A link on offer: the method is 99% sure Y hosts P',
    ])
    expect(document.body.textContent).toContain('No other element meets it.')
  })

  it('shows an element and a MAG as a pair, with link', async () => {
    const m = await mount()
    await select(m, { genomes: ['P', 'Y'] })
    expect(head()).toBe('pair · P ↔ Y')
    expect(textsOf(document.body, '.curate-selection-facts')).toEqual(['not linked'])
    expect(document.querySelector('.curate-selection-numbers')?.textContent).toBe('affinity 0.53 (at least 76× background) · 99% of its MAG contacts · 120 contacts')
    // Not a bare percent beside the share of contacts: what the method is sure of.
    expect(document.querySelector('.curate-selection-offer')?.textContent).toBe('link offered: 99% its host')
    expect(actLabels()).toEqual(['link', 'close-up'])
    act('link').click()
    await settle(m)
    expect(m.model.answer?.links.map((link) => `${link.element}>${link.mag}`)).toEqual(['P>Z', 'P>Y'])
    // Taken as the suggestion it was: the history says so.
    expect(m.store.curation.history.at(-1)?.by).toBe('suggestion')
    expect(actLabels()).toEqual(['unlink', 'close-up'])
  })

  it('shows an element and a MAG it barely meets: the unlink on offer, sure it is not its host', async () => {
    const m = await mount()
    await select(m, { genomes: ['P', 'Z'] })
    expect(document.querySelector('.curate-selection-numbers')?.textContent).toBe('affinity below the background · 1% of its MAG contacts · 1 contact')
    expect(document.querySelector('.curate-selection-offer')?.textContent).toBe('unlink offered: 99% not its host')
    // Nothing leans on the lower bound: no key.
    expect(document.querySelector('.curate-selection-key')).toBeNull()
    expect(actLabels()).toEqual(['unlink', 'close-up'])
  })

  it('shows several genomes: their sum, the acts on them, their affinities with one another', async () => {
    const m = await mount()
    await select(m, { genomes: ['X1', 'X2'] })
    expect(head()).toBe('2 MAGs')
    expect(document.querySelector('.curate-selection-facts')?.textContent).toBe('350.0 kb · 7 contigs')
    expect(actLabels()).toEqual(['merge', 'close-up', 'make them elements', 'dissolve'])
    expect(actKeys()).toEqual(['M', '⏎', 'E', '⌫'])
    expect(textsOf(document.body, '.curate-selection-cell:not(.is-self)')).toEqual(['1.50', '1.50'])
    // The merge on offer between them is marked, as the map marks it; the tint is the map's lower bound.
    const cells = [...document.querySelectorAll<HTMLElement>('.curate-selection-cell:not(.is-self)')]
    expect(cells.map((cell) => cell.classList.contains('is-offered'))).toEqual([true, true])
    expect(cells[0].title).toBe('X1 × X2 · affinity 1.50, at least 1.42 on 540 contacts: 228× the background (0.0062) · a merge on offer, 99% one organism')
    expect(Number(cells[0].style.getPropertyValue('--heat'))).toBeGreaterThan(0.9)
    act('merge').click()
    await settle(m)
    expect(m.model.answer?.genomes.map((genome) => genome.id)).toEqual(['X1', 'Y', 'Z', 'P'])
    expect(head()).toBe('MAG · X1')
  })

  it('holds merge back for a MAG and an element, saying why, and links instead', async () => {
    const m = await mount()
    await select(m, { genomes: ['X1', 'X2', 'P'] })
    expect(head()).toBe('3 genomes')
    expect(document.querySelector('.curate-selection-facts')?.textContent).toBe('2 MAGs · 1 element · 450.0 kb · 9 contigs')
    expect(act('merge').disabled).toBe(true)
    expect(act('merge').title).toBe('Only genomes of one kind merge: an element and a MAG are linked')
    expect(act('link').disabled).toBe(true)
    expect(act('link').title).toBe('Link elements to one MAG at a time')
  })

  it('shows a contig: where it is, where it meets most, and moves it there as the suggestion', async () => {
    const m = await mount()
    await select(m, { contigs: [3] })
    expect(head()).toBe('contig · y5')
    expect(document.querySelector('.curate-selection-facts')?.textContent).toBe('50.0 kb · GC 45.0% · in X1')
    expect(actLabels()).toEqual(['move to…', 'new MAG', 'new element', 'unbin'])
    expect(actKeys()).toEqual(['M', 'B', 'E', '⌫'])
    const rows = rowsUnder('meets most')
    expect(rows.map(rowText)).toEqual(['Y97% belongs there | affinity 1.25 · its own 0'])
    rowAct(rows[0]).click()
    await settle(m)
    expect(m.store.binning.genomeOf[3]).toBe(m.store.binning.indexOfId('Y'))
    expect(m.store.curation.history.at(-1)?.by).toBe('suggestion')
  })

  it('shows contigs of two genomes, and moves the one that belongs elsewhere alone', async () => {
    const m = await mount()
    await select(m, { contigs: [0, 1, 2, 3] })
    expect(head()).toBe('4 contigs')
    expect(document.querySelector('.curate-selection-facts')?.textContent).toBe('200.0 kb · 4 in X1')
    const rows = rowsUnder('meet most')
    // How many meet it most, and how many of those are in it already: what the
    // row's act moves is the difference, never the selection's count in it.
    expect(rows.map(rowText)).toEqual(['X1 | 3 of 4 meet it most, all in it already · affinity 2.90', 'Y97% belongs there | 1 of 4 meets it most · affinity 1.25'])
    expect(rows[1].querySelector<HTMLElement>('.curate-selection-row-confidence')?.title).toBe('A move on offer: the method is 97% sure y5 belongs in Y')
    expect(rows[0].querySelector('.curate-selection-row-act')).toBeNull()
    expect(rowAct(rows[1]).textContent).toBe('move 1')
  })

  it('counts the contigs that meet a genome most and how many of them are in it already: its act moves the rest', async () => {
    const m = await mount()
    // x0 and x1 of X1, and u0 of the pool, which belongs with them.
    await select(m, { contigs: [0, 1, 18] })
    expect(document.querySelector('.curate-selection-facts')?.textContent).toBe('150.0 kb · 1 unbinned · 2 in X1')
    const [row] = rowsUnder('meet most')
    expect(row.querySelector('.curate-selection-row-detail')?.textContent).toMatch(/^3 of 3 meet it most, 2 of them in it already · affinity \d/)
    expect(rowActLabel(row)).toBe('move 1')
    expect(row.querySelector('.curate-selection-row-confidence')?.textContent).toBe('98% belongs there')
  })

  it('holds unbin back for contigs in the pool', async () => {
    const m = await mount()
    await select(m, { contigs: [18] })
    expect(act('unbin').disabled).toBe(true)
    expect(act('unbin').title).toBe('It is unbinned already')
  })
})

describe('the acts', () => {
  it('asks the stage to rename, to open the chooser under the act, and for the close-up', async () => {
    const m = await mount()
    await select(m, { genomes: ['X1'] })
    act('rename').click()
    act('merge into…').click()
    act('close-up').click()
    expect(m.asked).toEqual(['rename X1', 'choose merge', 'close-up'])
    expect(m.anchors[0]).toBe(act('merge into…'))
    expect(m.card.anchorFor('merge')).toBe(act('merge into…'))
    expect(act('merge into…').title).toBe('Merge X1 into another MAG, which keeps its name (M)')
  })

  it('takes a recruit with its row’s act, as the suggestion', async () => {
    const m = await mount()
    await select(m, { genomes: ['X1'] })
    rowAct(rowsUnder('belong here')[0]).click()
    await settle(m)
    expect(m.store.binning.genomeOf[18]).toBe(m.store.binning.indexOfId('X1'))
    expect(m.store.curation.history.at(-1)?.by).toBe('suggestion')
  })

  it('merges with the genome it meets most, as the suggestion on offer, keeping the merged one selected', async () => {
    const m = await mount()
    await select(m, { genomes: ['X1'] })
    rowAct(rowsUnder('meets most')[0]).click()
    await settle(m)
    expect(m.model.selection.genomes).toEqual(['X1'])
    expect(document.querySelector('.curate-selection-facts')?.textContent).toMatch(/^350\.0 kb · 7 contigs/)
    expect(textsOf(document.body, '.curate-selection-quality .is-value')).toEqual(['100.0%', '100.0%', '1.00', '1.00'])
  })

  it('takes the likely suggestions into a MAG in one press: one step, undone at once, every answer learned', async () => {
    const m = await mount()
    const real = m.model.offered()
    const recruit = real.find((s) => s.kind === 'recruit') as Suggestion
    // A second likely one into X1: x3 of X2, as a move.
    const move: Suggestion = { ...recruit, key: 'move:x3>X1', kind: 'move', step: { op: 'move', contigs: ['x3'], to: 'X1' }, words: 'move x3 from X2 to X1', confidence: 0.6, genomes: [0, 1], contigs: [4] }
    const offered = m.model.offered.bind(m.model)
    m.model.offered = () => [...offered(), move]
    await select(m, { genomes: ['X1'] })
    expect(actLabels()).toContain('take 2 at 50% or more')
    const answers = m.model.answers
    act('take 2 at 50% or more').click()
    await settle(m)
    const x1 = m.store.binning.indexOfId('X1')
    expect([m.store.binning.genomeOf[18], m.store.binning.genomeOf[4]]).toEqual([x1, x1])
    expect(m.store.curation.history).toHaveLength(1)
    expect(m.store.curation.history[0].by).toBe('suggestion')
    expect(m.model.answers).toBe(answers + 2)
    m.model.undo()
    await settle(m)
    expect([m.store.binning.genomeOf[18], m.store.binning.genomeOf[4]]).toEqual([-1, m.store.binning.indexOfId('X2')])
  })

  it('answers nothing while the step just made is counted: a double press makes it once', async () => {
    const m = await mount()
    await select(m, { genomes: ['X1'] })
    const take = rowAct(rowsUnder('belong here')[0])
    take.click()
    expect(m.model.stale).toBe(true)
    expect(m.card.element.classList.contains('is-weighing')).toBe(true)
    take.click()
    act('make it an element').click()
    await settle(m)
    expect(m.store.curation.history).toHaveLength(1)
    expect(m.card.element.classList.contains('is-weighing')).toBe(false)
    // Counted, it answers again.
    act('make it an element').click()
    await settle(m)
    expect(m.store.curation.history).toHaveLength(2)
  })

  it('keeps the keyboard on the act of the same name when the card is drawn again, for a reader at the keys', async () => {
    const m = await mount()
    await select(m, { genomes: ['X1'] })
    act('close-up').focus()
    act('close-up').dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }))
    m.model.selectGenomes(['X2'])
    await frame()
    expect(head()).toBe('MAG · X2')
    expect(document.activeElement).toBe(act('close-up'))
    // After a press of the pointer it falls with the act: a button focused unseen would take the stage's Space and Enter.
    act('close-up').dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))
    act('close-up').focus()
    m.model.selectGenomes(['X1'])
    await frame()
    expect(head()).toBe('MAG · X1')
    expect(m.card.element.contains(document.activeElement)).toBe(false)
  })

  it('prices a step while the pointer rests on its act, fills the after column, and lets go of it', async () => {
    const m = await mount()
    await select(m, { genomes: ['X1'] })
    const merge = rowAct(rowsUnder('meets most')[0])
    merge.dispatchEvent(new PointerEvent('pointerenter'))
    await wait(200)
    await m.model.settled()
    await wait(0)
    await frame()
    expect(m.model.previewStep).toEqual({ op: 'merge', into: 'X1', genomes: ['X2'] })
    // After the step, in the plain numbers' place: the side has room for two columns of numbers.
    expect(textsOf(document.body, '.curate-selection-quality .is-head')).toEqual(['weighted', 'after'])
    expect(textsOf(document.body, '.curate-selection-quality .is-after.is-value')).toEqual(['100.0%', '1.00'])
    expect(document.querySelector('.curate-selection-quality .is-after.is-value')?.classList.contains('is-promoted')).toBe(true)
    merge.dispatchEvent(new PointerEvent('pointerleave'))
    expect(m.model.previewStep).toBeNull()
    await frame()
    expect(textsOf(document.body, '.curate-selection-quality .is-head')).toEqual(['weighted', 'plain'])
  })

  it('lights its rows with the genome under the pointer anywhere, and says a row on hover', async () => {
    const m = await mount()
    await select(m, { genomes: ['X1'] })
    m.model.hover('Y')
    await frame()
    const lit = [...document.querySelectorAll<HTMLElement>('.curate-selection-row.is-lit')].map((row) => row.dataset.genome)
    expect(lit).toEqual(['Y', 'Y'])
    const row = rowsUnder('meets most')[0]
    row.dispatchEvent(new PointerEvent('pointerenter'))
    expect(m.model.hovered.genome).toBe('X2')
    expect(m.said.at(-1)).toBe('X1 × X2 · affinity 1.50 (at least 228× background) · 540 contacts · 99% one organism')
    row.dispatchEvent(new PointerEvent('pointerleave'))
    expect(m.model.hovered.genome).toBeNull()
    expect(m.said.at(-1)).toBeNull()
    row.click()
    expect(m.framed.at(-1)).toEqual({ genomes: ['X2'] })
  })

  it('marks the rows of the question in review, a member of a question of several too', async () => {
    const m = await mount()
    await select(m, { genomes: ['P'] })
    m.model.setMode('review')
    // P's link to Y and its unlink from Z are one question, keyed by the element.
    const question = m.model.queue().find((q) => q.members.some((s) => s.key === 'link:P>Y'))
    expect(question?.members.map((s) => s.key).sort()).toEqual(['link:P>Y', 'unlink:P>Z'])
    m.model.setCurrent(question?.key ?? '')
    await frame()
    const current = [...document.querySelectorAll<HTMLElement>('.curate-selection-row.is-current')].map((row) => row.dataset.suggestion)
    expect(current.sort()).toEqual(['link:P>Y', 'unlink:P>Z'])
  })

  it('draws a price where it moves nothing priced: an act’s over what follows the acts, a row’s at the card’s foot', async () => {
    const m = await mount()
    await select(m, { contigs: [0, 1, 2, 3] })
    const slots = (): Array<string | undefined> => [...document.querySelectorAll<HTMLElement>('.curate-selection-price:not(.hidden)')].map((node) => node.dataset.slot)
    // An act of the card: its price stands over what follows the acts, in the acts' own box.
    act('new MAG').dispatchEvent(new PointerEvent('pointerenter'))
    await wait(200)
    await wait(0)
    await frame()
    expect(slots()).toEqual(['acts'])
    const over = document.querySelector('.curate-selection-price[data-slot="acts"]') as HTMLElement
    expect(over.parentElement?.classList.contains('curate-selection-acts')).toBe(true)
    expect(over.classList.contains('is-over')).toBe(true)
    act('new MAG').dispatchEvent(new PointerEvent('pointerleave'))
    await frame()
    expect(slots()).toEqual([])
    // A row's act: its price at the card's foot, which nothing priced follows.
    const move = rowAct(rowsUnder('meet most')[1])
    move.dispatchEvent(new PointerEvent('pointerenter'))
    await wait(200)
    await wait(0)
    await frame()
    expect(slots()).toEqual(['rows'])
    const body = document.querySelector('.curate-selection-card .curate-card-body') as HTMLElement
    expect(body.lastElementChild?.getAttribute('data-slot')).toBe('rows')
    // The genome that takes the contig in first.
    expect(textsOf(document.body, '.curate-selection-price:not(.hidden) .curate-card-price-name')).toEqual(['Y', 'X1'])
  })

  it('lets go of its own price when the pointer leaves an act, never puts back a copy of what was held', async () => {
    const m = await mount()
    await select(m, { genomes: ['X1'] })
    const held = [
      { op: 'move' as const, contigs: ['u0'], to: 'X1' },
      { op: 'move' as const, contigs: ['y5'], to: 'Y' },
    ]
    m.model.preview(held, false)
    const merge = rowAct(rowsUnder('meets most')[0])
    merge.dispatchEvent(new PointerEvent('pointerenter'))
    await wait(200)
    expect(m.model.previewStep).toEqual({ op: 'merge', into: 'X1', genomes: ['X2'] })
    merge.dispatchEvent(new PointerEvent('pointerleave'))
    // The stage prices review's question again; nothing else is put back.
    expect(m.model.previewSteps).toBeNull()
  })
})

describe('affinity against the background, and what a confidence is sure of', () => {
  it('puts an affinity against the background: the cautious bound’s multiple, within it, or below it — never an exponent', () => {
    const rho = 0.024
    // 0.39 on 92,787 contacts: its bound hardly lower.
    expect(affinityAgainst(0.39, 92_787, rho)).toEqual({ words: '0.39 (at least 16× background)', bounded: true })
    // 1.18 on one contact: the bound says how little one contact proves.
    expect(affinityAgainst(1.18, 1, rho)).toEqual({ words: '1.18 (at least 5.2× background)', bounded: true })
    // Above it, but on too few contacts for the bound to clear it.
    expect(affinityAgainst(0.05, 1, rho)).toEqual({ words: '0.050 (within the background)', bounded: true })
    // At or under it, no digits: they would be noise printed to a false precision.
    expect(affinityAgainst(0.00064, 83, rho)).toEqual({ words: 'below the background', bounded: false })
    expect(affinityAgainst(rho, 10_000, rho)).toEqual({ words: 'below the background', bounded: false })
    // No contacts to bound it by (a group's least): the number's own multiple.
    expect(affinityAgainst(0.95, null, rho)).toEqual({ words: '0.95 (40× background)', bounded: false })
    expect(affinityAgainst(0, 0, rho)).toEqual({ words: '0', bounded: false })
    // No background known: the number alone, never an exponent; under a ten-thousandth `< 0.0001`, its space unbreakable.
    expect(affinityAgainst(0.00036, 2, null)).toEqual({ words: '0.00036', bounded: false })
    expect(affinityNumber(9.6e-5)).toBe('<\u00a00.0001')
    expect(affinityNumber(0.0013)).toBe('0.0013')
    for (const value of [9.6e-5, 2.1e-5, 0.00036, 0.0075, 0.39, 1.16, 3.64]) expect(affinityAgainst(value, 2, rho).words).not.toMatch(/e-/)
  })

  it('offers merge only where the contacts stand out of the background, or a merge is on offer', async () => {
    const m = await mount()
    await select(m, { genomes: ['X1'] })
    // X2 on offer, Y well above the background; Z on a single contact, below it.
    expect(rowsUnder('meets most').map(rowActLabel)).toEqual(['merge', 'merge', null])
    // Z meets every MAG at most as strangers do: listed, nothing offered, no key to read.
    await select(m, { genomes: ['Z'] })
    const rows = rowsUnder('meets most')
    expect(rows.length).toBeGreaterThan(0)
    expect(rows.map(rowActLabel).every((label) => label === null)).toBe(true)
    expect(rows.map((row) => row.querySelector('.curate-selection-row-detail')?.textContent ?? '').every((detail) => detail.startsWith('affinity below the background'))).toBe(true)
    expect(document.querySelector('.curate-selection-key')).toBeNull()
    // `merge into…` still reaches any genome.
    expect(act('merge into…').disabled).toBe(false)
  })

  it('says what every confidence is sure of, never a bare percent', async () => {
    const m = await mount()
    const seen: string[] = []
    for (const selection of [{ genomes: ['X1'] }, { genomes: ['P'] }, { contigs: [3] }, { contigs: [0, 1, 2, 3] }]) {
      await select(m, selection)
      seen.push(...confidences())
    }
    expect(seen).toEqual(['99% one organism', '98% sure', '97% sure', '99% not its host', '99% its host', '97% belongs there', '97% belongs there'])
    // `sure` alone only under a heading that says of what: `belong here`, `may belong elsewhere`.
    await select(m, { genomes: ['X1'] })
    expect(rowsUnder('belong here')[0].querySelector<HTMLElement>('.curate-selection-row-confidence')?.title).toBe('The method is 98% sure it belongs in X1')
    expect(rowsUnder('meets most')[0].querySelector<HTMLElement>('.curate-selection-row-confidence')?.title).toMatch(/sure the two are fragments of one organism — what the merge does to the grades is its price/)
  })

  it('draws a row’s act the size of the card’s acts: one button size a card', () => {
    // No layout here: the rule is held as text, the pictures by the gallery's measure of both. From the
    // working directory, not `import.meta.url`, which is not a file's address under jsdom.
    const css = readFileSync(resolve(process.cwd(), 'src/curate/ui/cards.css'), 'utf8')
    const rule = (selector: string): Record<string, string> => {
      for (const block of css.split('}')) {
        const at = block.lastIndexOf('{')
        if (at < 0) continue
        if ((block.slice(0, at).split('*/').pop()?.replace(/\s+/g, ' ').trim() ?? '') !== selector) continue
        const out: Record<string, string> = {}
        for (const line of block.slice(at + 1).split(';')) {
          const colon = line.indexOf(':')
          if (colon >= 0) out[line.slice(0, colon).trim()] = line.slice(colon + 1).replace(/\s+/g, ' ').trim()
        }
        return out
      }
      throw new Error(`no rule for ${selector}`)
    }
    const row = rule('.curate-selection-row-act')
    // The button's own type, as the card's acts keep it: no size of the row's.
    expect(row['font-size']).toBeUndefined()
    expect(rule('.curate-card-acts .edit-act')['font-size']).toBeUndefined()
    expect(row['padding']).toBe(rule('.curate-card-acts .edit-act')['padding'])
  })
})

describe('before the contacts are read', () => {
  it('shows a MAG’s numbers and quality, and says the rest comes with the contacts', async () => {
    const m = await mount((stage) => {
      const { base, evidence } = community()
      const store = new CurationStore(`curate-bare-${Math.random()}`, base, fileBinning(base), () => 0)
      const model = new CurateModel(
        store,
        { state: (curation) => ({ promise: Promise.resolve(bareAnswer(CuratedBinning.of(base, curation), base.lengths, evidence.markers)), cancel: () => {} }) },
        { schedule: (run) => (run(), () => {}) },
      )
      stage.model.dispose()
      Object.assign(stage, { model, store })
      return { ...stage.ctx, model }
    })
    await m.model.settled()
    await select(m, { genomes: ['X1'] })
    expect(head()).toBe('MAG · X1')
    expect(textsOf(document.body, '.curate-selection-quality .is-value')).toEqual(['50.0%', '50.0%', '1.00', '1.00'])
    expect(document.querySelector('.curate-selection-uncounted')?.textContent).toBe('What it meets most, and what may belong in it, once the contacts are read.')
    expect(subs()).toEqual([])
  })
})

describe('what a step does to a grade', () => {
  const q = (completeness: number, redundancy: number): Quality => ({
    set: 'Bact4',
    present: 0,
    markers: 4,
    hits: 0,
    completeness,
    redundancy,
    weightedCompleteness: completeness,
    weightedRedundancy: redundancy,
    duplicated: [],
  })

  it('marks the number that pulls a grade down, or lifts it to high quality, and no other', () => {
    expect(qualityShift(q(0.95, 1.0), q(0.97, 1.2))).toEqual({ completeness: null, redundancy: 'demoted' })
    expect(qualityShift(q(0.95, 1.0), q(0.85, 1.0))).toEqual({ completeness: 'demoted', redundancy: null })
    expect(qualityShift(q(0.6, 1.0), q(0.95, 1.02))).toEqual({ completeness: 'promoted', redundancy: null })
    expect(qualityShift(q(0.95, 1.08), q(0.95, 1.01))).toEqual({ completeness: null, redundancy: 'promoted' })
    expect(qualityShift(q(0.6, 1.0), q(0.62, 1.0))).toEqual({ completeness: null, redundancy: null })
  })

  it('blames the redundancy for a MAG made contaminated, though the completeness made it graded at all', () => {
    // An ungraded fragment that takes in the rest of its organism and one marker too many.
    expect(qualityShift(q(0.12, 1.16), q(0.84, 1.1003))).toEqual({ completeness: null, redundancy: 'demoted' })
    // A genome the step makes has no grade to fall from.
    expect(qualityShift(null, q(0.97, 1.46))).toEqual({ completeness: null, redundancy: 'demoted' })
    expect(qualityShift(null, q(0.95, 1.0))).toEqual({ completeness: 'promoted', redundancy: null })
    expect(qualityShift(null, q(0.6, 1.0))).toEqual({ completeness: null, redundancy: null })
  })

  it('prices a merge of several genomes, its redundancy in the warning colour where it makes the MAG contaminated', async () => {
    const m = await mount()
    await select(m, { genomes: ['X1', 'X2', 'Y'] })
    m.model.preview({ op: 'merge', into: 'Y', genomes: ['X1', 'X2'] }, false)
    await m.model.settled()
    await wait(0)
    await frame()
    expect(textsOf(document.body, '.curate-selection-price .curate-card-price-name')).toEqual(['Y'])
    expect(textsOf(document.body, '.curate-selection-price .curate-card-price-line')).toEqual(['complete 100% + 50% + 50% → 100%', 'redundant 1.00 + 1.00 + 1.00 → 2.00'])
    expect(textsOf(document.body, '.curate-selection-price .is-demoted')).toEqual(['redundant 1.00 + 1.00 + 1.00 → 2.00'])
    m.model.preview(null)
    await frame()
    expect(document.querySelectorAll('.curate-selection-price:not(.hidden)')).toHaveLength(0)
  })

  it('prices a genome a step makes by its own numbers, and sums three genomes at most', async () => {
    const m = await mount()
    const before = m.model.answer
    if (before === null) throw new Error('not counted')
    // A new MAG of X2's contigs and Z's: two genomes taken whole, and one made.
    const minted = m.model.mint('mag')
    m.model.preview({ op: 'create', id: minted.id, name: minted.name, kind: 'mag', contigs: ['x3', 'x4', 'x5', 'z0', 'z1', 'z2', 'z3'] }, false)
    await wait(0)
    const made = priceList(before, m.model.previewed ?? before, (_, name) => name) as HTMLElement
    expect(textsOf(made, '.curate-card-price-name')).toEqual([`${minted.name}new`])
    expect(textsOf(made, '.curate-card-price-line')).toEqual(['complete 100%', 'redundant 1.50'])
    // Contaminated is its redundancy's doing.
    expect(textsOf(made, '.is-demoted')).toEqual(['redundant 1.50'])
    // Four genomes in one: three summed, the fourth counted.
    m.model.preview({ op: 'merge', into: 'X1', genomes: ['X2', 'Y', 'Z'] }, false)
    await wait(0)
    const merged = priceList(before, m.model.previewed ?? before, (_, name) => name) as HTMLElement
    expect(textsOf(merged, '.curate-card-price-line')[0]).toBe('complete 50% + 100% + 100% + 1 more → 100%')
    // A genome without a marker of the set adds nothing to a sum: counted, not printed as 0%.
    m.store.apply({ op: 'create', id: 'curated:1', name: 'E0', kind: 'mag', contigs: ['x2'] })
    await settle(m)
    const now = m.model.answer
    if (now === null) throw new Error('not counted')
    expect(now.genomes.find((genome) => genome.id === 'curated:1')?.quality?.weightedCompleteness).toBe(0)
    m.model.preview({ op: 'merge', into: 'Y', genomes: ['curated:1', 'X2'] }, false)
    await wait(0)
    const empty = priceList(now, m.model.previewed ?? now, (_, name) => name) as HTMLElement
    expect(textsOf(empty, '.curate-card-price-line')).toEqual(['complete 100% + 50% + 1 more → 100%', 'redundant 1.00 + 1.00 + 1 more → 1.50'])
  })

  it('prices only a step that concerns the selection: the review’s question about other genomes is the band’s', async () => {
    const m = await mount()
    await select(m, { genomes: ['X1', 'X2'] })
    const shown = (): Array<string | undefined> => [...document.querySelectorAll<HTMLElement>('.curate-selection-price:not(.hidden)')].map((node) => node.dataset.slot)
    // A step priced elsewhere is drawn at the card's foot, never over the acts.
    m.model.preview({ op: 'move', contigs: ['y5'], to: 'Y' }, false)
    await wait(0)
    await frame()
    expect(shown()).toEqual(['rows'])
    m.model.preview({ op: 'move', contigs: ['p0'], to: 'Z' }, false)
    await wait(0)
    await frame()
    expect(m.model.previewed).not.toBeNull()
    expect(shown()).toEqual([])
    await select(m, { contigs: [16] })
    expect(shown()).toEqual(['rows'])
  })
})
