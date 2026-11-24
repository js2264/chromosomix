// @vitest-environment jsdom
// @dev-feature curate
/**
 * The curation stage's suggestions, history, export and about cards (SPECS
 * §33.3, §33.6, §33.8), in a DOM over the small community: the review's
 * questions in the queue's order, narrowed by kind, a row lighting what it
 * names and drawing the binning as it would be, framed on a press and asked in
 * review, taken and turned down, a question's suggestions answered one by
 * one, auto's run and what it held back, nothing answered twice while a step
 * is counted; the history's rows in words, a gesture one row, a press going
 * back; the tables written through the save dialog and the commands that take
 * them; what the stage read; and a press of the pointer leaving the keyboard on
 * no button, so review's Space is the stage's.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { bareAnswer, stateAnswer } from '@/curate/answer'
import { CurateModel, describeSuggestion, type CurateClient } from '@/curate/model'
import type { Suggestion } from '@/curate/suggest'
import type { CurateContext } from '@/curate/ui/context'
import { AboutCard } from '@/curate/ui/cards/AboutCard'
import { ExportCard, mapArgument } from '@/curate/ui/cards/ExportCard'
import { HistoryCard } from '@/curate/ui/cards/HistoryCard'
import { SuggestionsCard } from '@/curate/ui/cards/SuggestionsCard'
import { CuratedBinning, emptyCuration, fileBinning, withCurationStep } from '@/genome/curation'
import { CURATION_SCOPE, CurationStore } from '@/state/curation'
import { remember } from '@/state/UiMemory'
import type { CurationNetworkResult } from '@/worker/curateProtocol'
import { setUpDom, textsOf, type DomTeardown } from '../support/dom'
import { community } from '../support/curateCommunity'
import { testContext, type TestStage } from '../support/curateStage'

let teardown: DomTeardown
let disposers: Array<() => void> = []
let saved: Record<string, string>
let asked: string[]

beforeEach(() => {
  teardown = setUpDom({ canvas: 'stub' })
  window.sessionStorage.clear()
  window.localStorage.clear()
  saved = {}
  asked = []
})

afterEach(() => {
  for (const dispose of disposers) dispose()
  disposers = []
  delete (window as unknown as { showSaveFilePicker?: unknown }).showSaveFilePicker
  teardown()
})

const frame = (): Promise<void> => new Promise((resolve) => requestAnimationFrame(() => resolve()))
const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/** After a step or an answer: counted again, and drawn. */
async function settle(stage: TestStage): Promise<void> {
  await stage.model.settled()
  await frame()
}

function mounted<T extends { element: HTMLElement; dispose(): void }>(card: T): T {
  document.body.appendChild(card.element)
  disposers.push(() => card.dispose())
  return card
}

/** The save dialog, answered at once with the name offered, or the one `as` gives. */
function saveDialog(as?: (offered: string) => string): void {
  ;(window as unknown as { showSaveFilePicker: unknown }).showSaveFilePicker = async ({ suggestedName }: { suggestedName: string }) => {
    asked.push(suggestedName)
    const name = as === undefined ? suggestedName : as(suggestedName)
    return {
      name,
      createWritable: async () => ({
        write: async (blob: Blob) => {
          saved[name] = await blob.text()
        },
        close: async () => {},
      }),
    }
  }
}

/** A stage counting as the worker does: an answer a while after it is asked, and a step stale until then. */
function slowStage(): TestStage {
  const stage = testContext()
  const { base, evidence } = community()
  const store = new CurationStore(`curate-cards-slow-${Math.random()}`, base, fileBinning(base), () => 0)
  const slow: CurateClient = {
    state: (curation, weights) => ({
      promise: new Promise((resolve) => setTimeout(() => resolve(stateAnswer(evidence, CuratedBinning.of(base, curation), weights)), 15)),
      cancel: () => {},
    }),
  }
  const model = new CurateModel(store, slow, { schedule: (run) => (run(), () => {}) })
  stage.model.dispose()
  return { ...stage, model, store, ctx: { ...stage.ctx, model } }
}

/** A press of the pointer: a click with a count, as a mouse's is (`detail` 0 is a key's). */
function pointerPress(node: HTMLElement): void {
  node.focus()
  node.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, detail: 1 }))
}

/** A stage whose counts read no contacts: the file's binning and its markers alone. */
function bareStage(): TestStage {
  const stage = testContext()
  const { base, evidence } = community()
  const store = new CurationStore(`curate-cards-bare-${Math.random()}`, base, fileBinning(base), () => 0)
  const model = new CurateModel(
    store,
    { state: (curation) => ({ promise: Promise.resolve(bareAnswer(CuratedBinning.of(base, curation), base.lengths, evidence.markers)), cancel: () => {} }) },
    { schedule: (run) => (run(), () => {}) },
  )
  stage.model.dispose()
  return { ...stage, model, store, ctx: { ...stage.ctx, model } }
}

// ---------------------------------------------------------------------------
// The suggestions card.
// ---------------------------------------------------------------------------

interface Suggested extends TestStage {
  card: SuggestionsCard
  /** What the card asked the stage to frame. */
  pressed: Suggestion[]
}

async function suggestions(stage: TestStage = testContext()): Promise<Suggested> {
  const pressed: Suggestion[] = []
  const card = mounted(new SuggestionsCard(stage.ctx, { frame: (s) => pressed.push(s) }))
  await settle(stage)
  return { ...stage, card, pressed }
}

const suggestionsHead = (): string => (document.querySelector('.curate-suggestions-card .edit-card-head')?.textContent ?? '').trim()
const rows = (): HTMLElement[] => [...document.querySelectorAll<HTMLElement>('.curate-suggestions-row')]
const rowOf = (key: string): HTMLElement => document.querySelector(`.curate-suggestions-row[data-key="${key}"]`) as HTMLElement
const wordsOf = (): string[] => textsOf(document.body, '.curate-suggestions-row .curate-suggestions-words')
function answer(row: HTMLElement, label: 'take' | 'turn down'): HTMLButtonElement {
  const found = [...row.querySelectorAll<HTMLButtonElement>(':scope > .curate-suggestions-foot .curate-suggestions-act')].find((button) => button.querySelector('span')?.textContent === label)
  if (found === undefined) throw new Error(`no ${label}`)
  return found
}
const enter = (node: HTMLElement): boolean => node.dispatchEvent(new PointerEvent('pointerenter', { pointerId: 1 }))
const leave = (node: HTMLElement): boolean => node.dispatchEvent(new PointerEvent('pointerleave', { pointerId: 1 }))

describe('the suggestions card', () => {
  it('lists the review’s questions in the queue’s order, numbered, with what each rests on', async () => {
    await suggestions()
    expect(suggestionsHead()).toBe('suggestions · 4 questions')
    expect(wordsOf()).toEqual(['merge X2 into X1', 'move y5 from X1 to Y', 'recruit u0 into X1', 'link P to Y · unlink it from Z'])
    expect(textsOf(document.body, '.curate-suggestions-row .curate-suggestions-n')).toEqual(['1', '2', '3', '4'])
    expect(textsOf(document.body, '.curate-suggestions-row .curate-suggestions-confidence')).toEqual(['99%', '97%', '98%', '99%'])
    expect(textsOf(rowOf('merge:X1+X2'), '.curate-suggestions-chip')).toContain('markers complementary')
    // Counted in questions, one kind lit at a time.
    expect(textsOf(document.body, '.curate-suggestions-kind')).toEqual(['all', 'merge 1', 'move 1', 'recruit 1', 'link 1'])
  })

  it('narrows the list to a kind, and every kind again', async () => {
    await suggestions()
    ;(document.querySelector('.curate-suggestions-kind[data-kind="move"]') as HTMLButtonElement).click()
    await frame()
    expect(wordsOf()).toEqual(['move y5 from X1 to Y'])
    expect(document.querySelector('.curate-suggestions-kind[data-kind="move"]')?.getAttribute('aria-pressed')).toBe('true')
    ;(document.querySelector('.curate-suggestions-kind[data-kind="all"]') as HTMLButtonElement).click()
    await frame()
    expect(rows()).toHaveLength(4)
  })

  it('lights what a row names, draws the binning as it would leave it once the pointer rests, and lets go', async () => {
    const m = await suggestions()
    const row = rowOf('merge:X1+X2')
    enter(row)
    expect(m.model.hovered).toEqual({ genome: 'X1', contig: -1 })
    expect(m.said.at(-1)).toMatch(/^merge X2 into X1 · 99% · affinity/)
    expect(m.model.previewStep).toBeNull()
    await wait(200)
    expect(m.model.previewStep).toEqual({ op: 'merge', into: 'X1', genomes: ['X2'] })
    await frame()
    expect(m.model.previewing).toBe(true)
    expect(m.model.shown?.genomes.some((genome) => genome.id === 'X2')).toBe(false)
    leave(row)
    expect(m.model.previewStep).toBeNull()
    expect(m.model.hovered.genome).toBeNull()
    expect(m.said.at(-1)).toBeNull()
  })

  it('draws a question of several steps whole, as taking it makes them', async () => {
    const m = await suggestions()
    const host = m.model.queue().find((q) => q.key === 'host:P')
    if (host === undefined) throw new Error('no host question')
    expect(host.steps).toHaveLength(2)
    enter(rowOf('host:P'))
    await wait(200)
    expect(m.model.hovered.genome).toBe('P')
    expect(m.model.previewSteps).toEqual(host.steps)
    await frame()
    expect(m.model.previewing).toBe(true)
    leave(rowOf('host:P'))
    expect(m.model.previewSteps).toBeNull()
  })

  it('lets go of what a row drew: review’s question priced again, drawn only while Space is held', async () => {
    const m = await suggestions()
    m.model.setMode('review')
    const asked = m.model.current
    if (asked === null) throw new Error('nothing asked')
    // As the stage does: the question priced, then Space held.
    m.model.preview(asked.steps, false)
    await wait(0)
    m.model.drawPreview(true)
    const row = rowOf('recruit:u0>X1')
    enter(row)
    await wait(200)
    expect(m.model.previewSteps).toEqual([{ op: 'move', contigs: ['u0'], to: 'X1' }])
    expect(m.model.previewing).toBe(true)
    // Space let go, then the row: nothing is drawn, and the preview is let go of for the stage to price its question again.
    m.model.drawPreview(false)
    leave(row)
    expect(m.model.previewing).toBe(false)
    expect(m.model.previewSteps).toBeNull()
    // Review's own question: drawn while the pointer rests on its row, and left priced, undrawn.
    m.model.preview(asked.steps, false)
    await wait(0)
    enter(rowOf(asked.key))
    await wait(200)
    expect(m.model.previewing).toBe(true)
    leave(rowOf(asked.key))
    expect(m.model.previewSteps).toEqual(asked.steps)
    expect(m.model.previewing).toBe(false)
  })

  it('lets go of what a row drew once the pointer leaves it, the mode said to change meanwhile', async () => {
    const m = await suggestions()
    const row = rowOf('recruit:u0>X1')
    enter(row)
    await wait(200)
    expect(m.model.previewSteps).toEqual([{ op: 'move', contigs: ['u0'], to: 'X1' }])
    // An auto run says it starts and ends as a change of mode does, the pointer wherever it rests.
    m.model.setMode('auto')
    leave(row)
    expect(m.model.previewSteps).toBeNull()
  })

  it('answers nothing while the last step is counted: a second press makes no second step', async () => {
    const m = await suggestions(slowStage())
    const take = answer(rowOf('merge:X1+X2'), 'take')
    take.click()
    take.click()
    answer(rowOf('move:y5>Y'), 'turn down').click()
    expect(m.store.curation.history).toHaveLength(1)
    expect(m.model.answers).toBe(1)
    expect(m.store.learned.rejected).toEqual([])
    // The list is of the binning before the step, and says so.
    expect(m.card.element.classList.contains('is-weighing')).toBe(true)
    expect(m.card.element.classList.contains('is-waiting')).toBe(true)
    await settle(m)
    expect(m.card.element.classList.contains('is-weighing')).toBe(false)
    expect(m.card.element.classList.contains('is-waiting')).toBe(false)
    answer(rowOf('move:y5>Y'), 'turn down').click()
    expect(m.store.learned.rejected).toEqual(['move:y5>Y'])
  })

  it('keeps the keyboard among the rows: on a row the count leaves as it was, on the next question once one is taken', async () => {
    const m = await suggestions()
    const main = rowOf('host:P').querySelector('.curate-suggestions-main') as HTMLButtonElement
    main.focus()
    m.model.recount(0)
    await settle(m)
    expect(document.activeElement).toBe(main)
    // Taken by the keys (Enter on its take): the keyboard on the take of the question now in its place.
    const take = answer(rowOf('merge:X1+X2'), 'take')
    take.focus()
    take.click()
    await settle(m)
    expect(rowOf('merge:X1+X2')).toBeNull()
    expect(document.activeElement).toBe(answer(rows()[0], 'take'))
  })

  it('leaves the keyboard on no button the pointer pressed, so Space is review’s, and on one the keys pressed', async () => {
    const m = await suggestions()
    m.model.setMode('review')
    await frame()
    const row = rowOf('recruit:u0>X1')
    const main = row.querySelector('.curate-suggestions-main') as HTMLButtonElement
    enter(row)
    pointerPress(main)
    expect(m.model.currentQuestion?.key).toBe('recruit:u0>X1')
    expect(document.activeElement).not.toBe(main)
    // What the pointer rests on stays lit.
    expect(m.model.hovered.genome).toBe('X1')
    leave(row)
    expect(m.model.hovered.genome).toBeNull()
    // Reached by Tab, a row lights what it names, and keeps the keyboard when Enter presses it.
    main.focus()
    expect(m.model.hovered.genome).toBe('X1')
    main.click()
    expect(document.activeElement).toBe(main)
    main.blur()
    expect(m.model.hovered.genome).toBeNull()
  })

  it('frames a question pressed, and in review asks it, its answers wearing their keys', async () => {
    const m = await suggestions()
    ;(rowOf('recruit:u0>X1').querySelector('.curate-suggestions-main') as HTMLButtonElement).click()
    expect(m.pressed.map((s) => s.key)).toEqual(['recruit:u0>X1'])
    expect(m.model.currentQuestion).toBeNull()
    m.model.setMode('review')
    await frame()
    expect(rowOf('merge:X1+X2').classList.contains('is-current')).toBe(true)
    ;(rowOf('recruit:u0>X1').querySelector('.curate-suggestions-main') as HTMLButtonElement).click()
    await frame()
    expect(m.model.currentQuestion?.key).toBe('recruit:u0>X1')
    expect(rowOf('recruit:u0>X1').classList.contains('is-current')).toBe(true)
    expect(rowOf('merge:X1+X2').classList.contains('is-current')).toBe(false)
    const take = answer(rowOf('recruit:u0>X1'), 'take')
    expect(take.classList.contains('is-keyed')).toBe(true)
    expect(take.title).toMatch(/\(Y\)$/)
    expect(answer(rowOf('merge:X1+X2'), 'take').classList.contains('is-keyed')).toBe(false)
  })

  it('takes a question: its step made as the suggestion’s, the row gone once counted', async () => {
    const m = await suggestions()
    const merge = m.model.queue()[0]
    answer(rowOf('merge:X1+X2'), 'take').click()
    expect(m.store.curation.history.map((entry) => [entry.step, entry.by, entry.suggestion])).toEqual([[{ op: 'merge', into: 'X1', genomes: ['X2'] }, 'suggestion', describeSuggestion(merge)]])
    await settle(m)
    expect(wordsOf()).not.toContain('merge X2 into X1')
    expect(document.querySelector('.curate-suggestions-learned')?.textContent).toBe('ranked by what 1 answer taught it · forget')
  })

  it('turns one down, lists it to offer again, and forgets what the answers taught', async () => {
    const m = await suggestions()
    answer(rowOf('move:y5>Y'), 'turn down').click()
    await settle(m)
    expect(wordsOf()).not.toContain('move y5 from X1 to Y')
    expect(document.querySelector('.curate-suggestions-declined summary')?.textContent).toBe('turned down · 1')
    expect(textsOf(document.body, '.curate-suggestions-declined .edit-declined-words')).toEqual(['move y5 from X1 to Y'])
    ;(document.querySelector('.curate-suggestions-restore') as HTMLButtonElement).click()
    await settle(m)
    expect(wordsOf()).toContain('move y5 from X1 to Y')
    expect(document.querySelector('.curate-suggestions-declined')).toBeNull()
    expect(m.model.answers).toBe(1)
    ;(document.querySelector('.curate-suggestions-learned .btn-link') as HTMLButtonElement).click()
    await settle(m)
    expect(m.model.answers).toBe(0)
    expect(document.querySelector('.curate-suggestions-learned')).toBeNull()
  })

  it('opens a question on its suggestions, each answered alone', async () => {
    const m = await suggestions()
    const row = rowOf('host:P')
    const details = row.querySelector('.curate-suggestions-members') as HTMLDetailsElement
    expect(details.querySelector('summary')?.textContent).toBe('one by one · 2')
    // Each says what the question does not: the element is the question's.
    expect(textsOf(details, '.curate-suggestions-member-words')).toEqual(['unlink from Z', 'link to Y'])
    const link = details.querySelector('.curate-suggestions-member[data-key="link:P>Y"]') as HTMLElement
    // A member under the pointer draws its own step.
    enter(link)
    await wait(200)
    expect(m.model.previewStep).toEqual({ op: 'link', element: 'P', mag: 'Y' })
    ;[...link.querySelectorAll<HTMLButtonElement>('.curate-suggestions-act')].find((button) => button.textContent?.startsWith('take'))?.click()
    expect(m.store.curation.history.map((entry) => entry.step)).toEqual([{ op: 'link', element: 'P', mag: 'Y' }])
    await settle(m)
    // In review, stepping into a question's members marks the one asked.
    m.store.undo()
    await settle(m)
    m.model.setMode('review')
    m.model.setCurrent('host:P')
    m.model.moveMember(1)
    await frame()
    const opened = rowOf('host:P').querySelector('.curate-suggestions-members') as HTMLDetailsElement
    expect(opened.open).toBe(true)
    expect(opened.querySelector('.curate-suggestions-member.is-current')?.getAttribute('data-key')).toBe(m.model.current?.key)
  })

  it('runs auto on the sure questions, says it is applying, and stops', async () => {
    // Counts that take a while, as the worker's do: the run is seen running.
    const m = await suggestions(slowStage())
    m.model.setMode('auto')
    await frame()
    const apply = document.querySelector('.curate-suggestions-apply') as HTMLButtonElement
    expect(apply.textContent).toBe('apply 4 at 80% or more')
    apply.click()
    expect(m.model.running).toBe(true)
    await frame()
    expect(document.querySelector('.curate-suggestions-running')?.textContent).toBe('applying…')
    const stop = document.querySelector('.curate-suggestions-stop') as HTMLButtonElement
    expect(stop.textContent).toBe('stop')
    // Stopped once it has made its first step: it makes no other.
    for (let k = 0; k < 200 && m.store.curation.history.length === 0; k++) await wait(2)
    await frame()
    // The same button through the run's counts: a press begun on it is not dropped by one.
    expect(document.querySelector('.curate-suggestions-stop')).toBe(stop)
    stop.click()
    for (let k = 0; k < 100 && m.model.running; k++) await wait(5)
    await settle(m)
    expect(m.model.running).toBe(false)
    // Stopped after the step it was making, which stays.
    expect(m.store.curation.history.length).toBe(1)
    expect(m.store.curation.history[0].by).toBe('auto')
    // Counted between its steps, a run's list is not dimmed: its own line says it is working.
    expect(m.card.element.classList.contains('is-weighing')).toBe(false)
    expect(document.querySelector('.curate-suggestions-running')).toBeNull()
    expect(document.querySelector('.curate-suggestions-apply')?.textContent).toMatch(/^apply \d at 80% or more$/)
  })

  it('says what auto held back, and why', async () => {
    const stage = testContext()
    const { base, evidence } = community()
    const store = new CurationStore(`curate-cards-held-${Math.random()}`, base, fileBinning(base), () => 0)
    const quality = (wc: number, wr: number) => ({ set: 'Bact4', present: 1, markers: 4, hits: 1, completeness: wc, redundancy: wr, weightedCompleteness: wc, weightedRedundancy: wr, duplicated: [] })
    // As it stands, X1 a high-quality MAG and one sure merge into it; merged, contaminated.
    const client: CurateClient = {
      state(curation) {
        const answered = stateAnswer(evidence, CuratedBinning.of(base, curation))
        const merged = (curation?.history.length ?? 0) > 0
        answered.genomes = answered.genomes.map((genome) => (genome.id === 'X1' ? { ...genome, quality: merged ? quality(0.95, 1.4) : quality(0.95, 1.0) } : genome))
        const sure = answered.suggestions.find((s) => s.kind === 'merge')
        answered.suggestions = merged || sure === undefined ? [] : [{ ...sure, confidence: 0.95 }]
        return { promise: Promise.resolve(answered), cancel: () => {} }
      },
    }
    const model = new CurateModel(store, client, { schedule: (run) => (run(), () => {}) })
    stage.model.dispose()
    const m = await suggestions({ ...stage, model, store, ctx: { ...stage.ctx, model } })
    m.model.setMode('auto')
    await m.model.runAuto()
    await frame()
    expect(store.applied).toBe(0)
    expect(document.querySelector('.curate-suggestions-auto .edit-card-sub')?.textContent).toBe('held back · 1')
    expect(textsOf(document.body, '.curate-suggestions-held-words')).toEqual(['merge X2 into X1'])
    expect(textsOf(document.body, '.curate-suggestions-held-why')).toEqual(['it would make X1 contaminated'])
  })

  it('says the suggestions come with the contacts, before they are read', async () => {
    await suggestions(bareStage())
    expect(suggestionsHead()).toBe('suggestions')
    expect(document.querySelector('.curate-suggestions-empty')?.textContent).toMatch(/^The suggestions come once the contacts are read/)
    expect(rows()).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// The history card.
// ---------------------------------------------------------------------------

const historyHead = (): string => (document.querySelector('.curate-history-card .edit-card-head')?.textContent ?? '').trim()
const historyWords = (): string[] => textsOf(document.body, '.curate-history-row .curate-history-words')
const historyRow = (count: number): HTMLElement => document.querySelector(`.curate-history-row[data-count="${count}"]`) as HTMLElement

describe('the history card', () => {
  it('starts at the binning as in the file, and teaches the press', async () => {
    const stage = testContext()
    mounted(new HistoryCard(stage.ctx, { store: stage.store }))
    await settle(stage)
    expect(historyHead()).toBe('history')
    expect(historyWords()).toEqual(['the binning as in the file'])
    expect(historyRow(0).classList.contains('is-current')).toBe(true)
    expect(document.querySelector('.curate-history-hint')?.classList.contains('hidden')).toBe(false)
  })

  it('says each step in words as it is made, a gesture one row, a suggestion’s marked', async () => {
    const stage = testContext()
    mounted(new HistoryCard(stage.ctx, { store: stage.store }))
    await settle(stage)
    stage.model.moveSelected(null)
    stage.model.selectContigs([3])
    stage.model.moveSelected('Y')
    await frame()
    expect(historyWords()).toEqual(['the binning as in the file', 'move y5 to Y'])
    const host = stage.model.queue().find((q) => q.key === 'host:P')
    if (host === undefined) throw new Error('no host question')
    stage.model.accept(host)
    await frame()
    expect(historyHead()).toBe('history · 3 of 3')
    expect(historyWords()).toEqual(['the binning as in the file', 'move y5 to Y', 'unlink P from Z; link P to Y'])
    const row = historyRow(3)
    expect(row.querySelector('.curate-history-steps')?.textContent?.trim()).toBe('· 2 steps')
    expect(row.querySelector('.edit-history-by')?.textContent).toBe('suggested')
    expect(row.querySelector('.edit-history-by')?.getAttribute('title')).toBe(describeSuggestion(host))
    expect(row.classList.contains('is-current')).toBe(true)
    expect(document.querySelector('.curate-history-hint')?.classList.contains('hidden')).toBe(true)
  })

  it('goes back to a row pressed, the rows after it faint, and forward again', async () => {
    const stage = testContext()
    mounted(new HistoryCard(stage.ctx, { store: stage.store }))
    await settle(stage)
    stage.store.apply({ op: 'rename', genome: 'X1', name: 'Xanthomonas' })
    stage.store.apply({ op: 'merge', into: 'X1', genomes: ['X2'] })
    await frame()
    expect(historyWords()).toEqual(['the binning as in the file', 'rename X1 to Xanthomonas', 'merge X2 into Xanthomonas'])
    ;(historyRow(1).querySelector('button') as HTMLButtonElement).click()
    await frame()
    expect(stage.store.applied).toBe(1)
    expect(historyHead()).toBe('history · 1 of 2')
    expect(historyRow(1).classList.contains('is-current')).toBe(true)
    expect(historyRow(2).classList.contains('is-undone')).toBe(true)
    expect(document.querySelector('.curate-history-undone')?.textContent).toBe('A step is undone: press a row to redo up to it, or make a step to drop it.')
    ;(historyRow(2).querySelector('button') as HTMLButtonElement).click()
    await frame()
    expect(stage.store.applied).toBe(2)
    expect(historyRow(2).classList.contains('is-current')).toBe(true)
    expect(document.querySelector('.curate-history-undone')?.classList.contains('hidden')).toBe(true)
  })

  it('leaves the keyboard on no row the pointer pressed', async () => {
    const stage = testContext()
    mounted(new HistoryCard(stage.ctx, { store: stage.store }))
    await settle(stage)
    stage.store.apply({ op: 'dissolve', genome: 'Z' })
    await frame()
    const back = historyRow(0).querySelector('button') as HTMLButtonElement
    pointerPress(back)
    expect(stage.store.applied).toBe(0)
    expect(document.activeElement).not.toBe(back)
  })

  it('names a curation kept for another binning, held and not applied', async () => {
    const stage = testContext()
    const { base } = community()
    const key = `curate-cards-refused-${Math.random()}`
    const other = { ...fileBinning(base), contigs: 3 }
    remember(key, CURATION_SCOPE, withCurationStep(emptyCuration(other), { op: 'dissolve', genome: 'Z' }, 'reader', 0))
    const store = new CurationStore(key, base, fileBinning(base), () => 0)
    mounted(new HistoryCard(stage.ctx, { store }))
    await frame()
    expect(document.querySelector('.curate-history-refusal')?.textContent).toMatch(/^The curation kept for this file was made on another binning: the curation was made on 3 contigs/)
  })
})

// ---------------------------------------------------------------------------
// The export card.
// ---------------------------------------------------------------------------

const exportButton = (format: string): HTMLButtonElement => document.querySelector(`.curate-export-file[data-format="${format}"]`) as HTMLButtonElement
const status = (): string => (document.querySelector('.curate-export-status')?.textContent ?? '').trim()
const commands = (): string[] => textsOf(document.body, '.curate-export-command')

async function exporting(stage: TestStage = testContext(), stem = 'community'): Promise<TestStage & { card: ExportCard }> {
  const card = mounted(new ExportCard(stage.ctx, { stem, store: stage.store, now: () => new Date(2026, 10, 24, 14, 52) }))
  await settle(stage)
  return { ...stage, card }
}

/** A press, its dialog and its write. */
async function press(button: HTMLButtonElement): Promise<void> {
  button.click()
  for (let k = 0; k < 10; k++) await wait(0)
}

describe('the export card', () => {
  it('offers the four tables, the note, and the two commands that take them', async () => {
    await exporting()
    expect(textsOf(document.body, '.curate-export-file')).toEqual(['contig → genome', 'genomes', 'elements', 'element ↔ host'])
    expect(document.querySelector('.curate-export-card .edit-note')?.textContent).toBe('Written from the curation; no file the session opened is touched.')
    expect(commands()).toEqual([
      'metacooler reassign community.metacool --contigs community.contig-genome.tsv --layout genome-then-length -o community.curated.metacool',
      'metacooler annotate community.curated.metacool --genomes community.genomes.tsv --replace --inplace',
    ])
    expect(exportButton('contig-genome').title).toMatch(/metacooler reassign takes \(community\.contig-genome\.tsv\)$/)
    expect(document.querySelector('.curate-export-keeps')?.textContent).toMatch(/^A reassignment keeps metaTOR’s clustering rounds/)
  })

  it('writes contig → genome through the save dialog, and says what it wrote', async () => {
    saveDialog()
    await exporting()
    await press(exportButton('contig-genome'))
    expect(asked).toEqual(['community.contig-genome.tsv'])
    expect(saved['community.contig-genome.tsv'].split('\n').slice(0, 3)).toEqual(['contig_name\tgenome_name', 'x0\tX1', 'x1\tX1'])
    expect(saved['community.contig-genome.tsv']).toContain('u0\t__unbinned__\n')
    expect(status()).toMatch(/^Wrote community\.contig-genome\.tsv \(\d+ B\) at 14:52\. 19 contigs in 5 genomes, 1 in none\.$/)
  })

  it('writes the genomes with metaTOR’s mge flag, as the binning stands', async () => {
    saveDialog()
    const m = await exporting()
    m.store.apply({ op: 'link', element: 'P', mag: 'Y' })
    await press(exportButton('genomes'))
    expect(saved['community.genomes.tsv']).toBe('genome_name\tmge\tn_mges\tmges\nX1\tFalse\t0\t\nX2\tFalse\t0\t\nY\tFalse\t1\tP\nZ\tFalse\t1\tP\nP\tTrue\t\t\n')
    expect(status()).toMatch(/5 genomes, 1 mobile element, 2 MAGs hosting one or more\.$/)
  })

  it('waits for the count of the binning as it stands before writing the element ↔ host pairs', async () => {
    saveDialog()
    const m = await exporting()
    m.store.apply({ op: 'link', element: 'P', mag: 'Y' }, 'suggestion', 'link P to Y · 99%')
    await press(exportButton('element-hosts'))
    const lines = saved['community.element-hosts.tsv'].split('\n')
    expect(lines[0]).toBe('element\tmag\tcontacts\taffinity\tshare\tconfidence\tlinked\tdecided_by')
    expect(lines.find((line) => line.startsWith('P\tY\t'))).toMatch(/\tyes\tsuggestion$/)
    expect(lines.find((line) => line.startsWith('P\tZ\t'))).toMatch(/\tyes\tfile$/)
  })

  it('takes the names the reader gave the files into the commands, and says when the curation has moved on', async () => {
    saveDialog((offered) => offered.replace('community', 'my_curation'))
    const m = await exporting()
    await press(exportButton('contig-genome'))
    await frame()
    expect(commands()[0]).toBe('metacooler reassign community.metacool --contigs my_curation.contig-genome.tsv --layout genome-then-length -o community.curated.metacool')
    expect(document.querySelector('.curate-export-stale')?.classList.contains('hidden')).toBe(true)
    m.store.apply({ op: 'dissolve', genome: 'Z' })
    await frame()
    expect(document.querySelector('.curate-export-stale')?.classList.contains('hidden')).toBe(false)
  })

  it('holds the element ↔ host pairs back until the contacts are read, and says why on the button', async () => {
    saveDialog()
    await exporting(bareStage())
    const button = exportButton('element-hosts')
    expect(button.disabled).toBe(true)
    expect(button.title).toBe('Once the contacts are read: the table gives each pair’s contacts and affinity.')
    expect(exportButton('elements').disabled).toBe(false)
    await press(button)
    expect(asked).toEqual([])
  })

  it('offers the elements as the binning stands before it is counted, and says why the pairs wait', async () => {
    saveDialog()
    const stage = testContext()
    const { base } = community()
    const store = new CurationStore(`curate-cards-uncounted-${Math.random()}`, base, fileBinning(base), () => 0)
    // A count that has not landed: the tables but the pairs are the store's.
    const model = new CurateModel(store, { state: () => ({ promise: new Promise(() => {}), cancel: () => {} }) }, { schedule: (run) => (run(), () => {}) })
    stage.model.dispose()
    mounted(new ExportCard({ ...stage.ctx, model }, { stem: 'community', store, now: () => new Date(2026, 10, 24, 14, 52) }))
    await frame()
    expect(exportButton('elements').disabled).toBe(false)
    expect(exportButton('element-hosts').disabled).toBe(true)
    expect(exportButton('element-hosts').title).toBe('Once the binning is counted.')
    await press(exportButton('elements'))
    expect(saved['community.elements.tsv']).toBe('element\tlength\tn_contigs\tcontigs\tn_hosts\thosts\nP\t100000\t2\tp0,p1\t1\tZ\n')
    // The element dissolved: said at once, from the binning as it stands.
    store.apply({ op: 'dissolve', genome: 'P' })
    await frame()
    expect(exportButton('elements').disabled).toBe(true)
    expect(exportButton('elements').title).toBe('No mobile element in this binning: there is nothing to write.')
  })

  it('ticks a table written while the binning is the one it was written from, an undo and a redo included', async () => {
    saveDialog()
    const m = await exporting()
    await press(exportButton('genomes'))
    await frame()
    const stale = (): boolean => document.querySelector('.curate-export-stale')?.classList.contains('hidden') === false
    expect(exportButton('genomes').classList.contains('is-written')).toBe(true)
    // A link moves no contig, and changes the genomes table: its mges.
    m.store.apply({ op: 'link', element: 'P', mag: 'Y' })
    await frame()
    expect(exportButton('genomes').classList.contains('is-written')).toBe(false)
    expect(stale()).toBe(true)
    m.store.undo()
    await frame()
    expect(exportButton('genomes').classList.contains('is-written')).toBe(true)
    expect(stale()).toBe(false)
    m.store.redo()
    await frame()
    expect(stale()).toBe(true)
  })

  it('leaves the keyboard on no table the pointer pressed: Space would open the dialog again', async () => {
    saveDialog()
    await exporting()
    const button = exportButton('contig-genome')
    pointerPress(button)
    for (let k = 0; k < 10; k++) await wait(0)
    expect(asked).toEqual(['community.contig-genome.tsv'])
    expect(document.activeElement).not.toBe(button)
  })

  it('copies a command, and names the map as metacooler does', async () => {
    const copied: string[] = []
    Object.defineProperty(navigator, 'clipboard', { value: { writeText: async (text: string) => void copied.push(text) }, configurable: true })
    await exporting()
    const copy = document.querySelector('.curate-export-copy') as HTMLButtonElement
    copy.click()
    await wait(0)
    expect(copied).toEqual([commands()[0]])
    expect(copy.classList.contains('is-copied')).toBe(true)
    expect(mapArgument('MM133.metacool')).toBe('MM133.metacool')
    expect(mapArgument('data/MM133.metacool')).toBe('MM133.metacool')
    expect(mapArgument('MM133.mmetacool::sample1')).toBe('MM133.mmetacool::entries/sample1')
    expect(mapArgument('MM133.mmetacool::entries/sample1')).toBe('MM133.mmetacool::entries/sample1')
    expect(mapArgument('my favourite map')).toBe('MAP')
  })

  it('quotes a name the shell would split', async () => {
    await exporting(testContext(), 'two words')
    expect(commands()[1]).toBe("metacooler annotate 'two words.curated.metacool' --genomes 'two words.genomes.tsv' --replace --inplace")
  })
})

// ---------------------------------------------------------------------------
// The card about the map.
// ---------------------------------------------------------------------------

function facts(): Record<string, string> {
  const out: Record<string, string> = {}
  const labels = [...document.querySelectorAll('.curate-about-label')]
  for (const label of labels) out[label.textContent ?? ''] = (label.nextElementSibling?.textContent ?? '').trim()
  return out
}

describe('the card about the map', () => {
  it('says what the stage read and weighs by', async () => {
    const stage = testContext()
    mounted(new AboutCard(stage.ctx))
    await settle(stage)
    const said = facts()
    expect(said['contacts']).toMatch(/^[\d,]+ contacts read$/)
    expect(said['background']).toMatch(/^0\.\d+the rate of spurious ligation$/)
    expect(said['markers']).toMatch(/^Bact4/)
    expect(said['suggestions']).toBe('offered from 15% · first from 50% · auto from 80%')
  })

  it('says how the background was measured, given the contacts’ read', async () => {
    const stage = testContext()
    const network: CurationNetworkResult = { contigs: 19, pairs: 120, pixels: 4_321, within: 0, between: 2_000, background: { rho: 0.0237, how: 'median', pairs: 6 } }
    mounted(new AboutCard(stage.ctx, { network: () => network }))
    await settle(stage)
    const said = facts()
    expect(said['contacts']).toBe('120 pairs of contigs in contact2,000 contacts, from 4,321 stored pixels')
    expect(said['background']).toBe('0.024the median, over 6 pairs of MAGs, of their contacts over the contacts expected')
  })

  it('says what is missing: the contacts not read, no marker genes stored', async () => {
    const stage = bareStage()
    const ctx: CurateContext = { ...stage.ctx, data: { ...stage.ctx.data, markerSets: [] } }
    mounted(new AboutCard(ctx))
    await settle(stage)
    const said = facts()
    expect(said['contacts']).toBe('not read yetthe maps, the hosts and the suggestions come with them')
    expect(said['markers']).toBe('no marker genes stored: run metator markers')
    expect(said['background']).toBeUndefined()
  })
})
