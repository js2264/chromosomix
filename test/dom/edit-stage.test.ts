// @vitest-environment jsdom
/**
 * The stage that edits the reference (SPECS §27.3, §27.4), in a DOM.
 *
 * What a DOM can hold the stage to without pixels: the picture it asked for
 * arriving and the sidebar filling from it, a sequence pressed in the list
 * becoming the selection and its acts, an act becoming a step in the history,
 * the keys doing what they print — and **Escape never closing it**, which is
 * the promise that makes a stage holding an hour of work safe to press Escape
 * in. The picture itself is drawn in the gallery (`scripts/ui-edit.mjs`).
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { findCorners } from '@/edit/corners'
import { EditStage } from '@/edit/EditStage'
import { expectedOf } from '@/edit/method'
import { EditStore } from '@/state/referenceEdit'
import type { PictureResult } from '@/worker/protocol'
import { setUpDom, textsOf, type DomTeardown } from '../support/dom'
import { simulate } from '../support/simulatedMap'

let teardown: DomTeardown
/** Every stage a test opened, closed after it — each listens on the window. */
const opened: EditStage[] = []

beforeEach(() => {
  teardown = setUpDom()
  window.localStorage.clear()
  window.sessionStorage.clear()
})

afterEach(() => {
  for (const stage of opened.splice(0)) stage.close()
  teardown()
})

const ORIGINAL = { names: ['I', 'II'], lengths: [10_000, 5_500] }

/** A picture of two sequences, 10 and 6 cells, every cell a little. */
function picture(): PictureResult {
  const n = 16
  const cells = new Uint8Array((n * (n + 1)) / 2).fill(100)
  return {
    rung: null,
    binsize: 1000,
    stride: 1,
    n,
    sequences: [
      { name: 'I', length: 10_000, firstCell: 0, cells: 10 },
      { name: 'II', length: 5_500, firstCell: 10, cells: 6 },
    ],
    levels: [{ n, cells }],
    low: -3,
    high: 0,
    vmin: -2,
    vmax: -1,
    balanced: true,
    pixels: 136,
  }
}

async function open(): Promise<{ stage: EditStage; store: EditStore; closed: () => boolean }> {
  const store = new EditStore('stage|yeast.cool', ORIGINAL)
  let closed = false
  const stage = new EditStage({
    title: 'yeast.cool',
    memoryKey: () => 'stage|yeast.cool',
    store,
    readPicture: () => ({ promise: Promise.resolve(picture()), cancel: () => {} }),
    colormap: 'default',
    onClose: () => {
      closed = true
    },
  })
  opened.push(stage)
  // The picture resolves on the next turn of the loop.
  await new Promise((resolve) => setTimeout(resolve, 0))
  return { stage, store, closed: () => closed }
}

const button = (text: string): HTMLButtonElement => {
  const found = [...document.querySelectorAll<HTMLButtonElement>('button')].find((node) => node.textContent?.includes(text))
  if (found === undefined) throw new Error(`no button “${text}”`)
  return found
}
/** A sequence's row in the sidebar's list, by its exact name. */
const sequence = (name: string): HTMLButtonElement => {
  const found = [...document.querySelectorAll<HTMLButtonElement>('.edit-sequence')].find(
    (node) => node.querySelector('.edit-sequence-name')?.textContent === name,
  )
  if (found === undefined) throw new Error(`no sequence “${name}”`)
  return found
}
const key = (name: string, init: KeyboardEventInit = {}): void => {
  window.dispatchEvent(new KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true, ...init }))
}

describe('the stage', () => {
  it('opens on the file as it is, with its sequences listed', async () => {
    await open()
    expect(document.querySelector('.modal-title')?.textContent).toBe('Edit the reference · yeast.cool')
    expect(textsOf(document.body, '.edit-sequence-name')).toEqual(['I', 'II'])
    expect(textsOf(document.body, '.edit-history-row')).toEqual(['·the file as it is'])
    expect(document.querySelector('.edit-status')?.classList.contains('hidden')).toBe(true)
  })

  it('selects a sequence pressed in the list, and turns it into a step', async () => {
    const { store } = await open()
    sequence('II').click()
    expect(document.querySelector('.edit-card .edit-locus')?.textContent).toBe('II:1-5,500')
    button('turn').click()
    expect(store.applied).toBe(1)
    expect(store.edit.history[0].step).toEqual({ op: 'invert', sequence: 'II', from: 0, to: 5_500 })
    expect(textsOf(document.body, '.edit-history-row')[1]).toBe('1turn II:1-5,500')
    // Turned whole, and in place: the selection follows it under its new name.
    expect(document.querySelector('.edit-card .edit-locus')?.textContent).toBe('II_e1:1-5,500')
  })

  it('undoes and redoes with the keys it prints, and goes back to a row of the history', async () => {
    const { store } = await open()
    sequence('I').click()
    key('i')
    expect(store.applied).toBe(1)
    key('z', { ctrlKey: true })
    expect(store.applied).toBe(0)
    key('z', { ctrlKey: true, shiftKey: true })
    expect(store.applied).toBe(1)
    button('the file as it is').click()
    expect(store.applied).toBe(0)
    expect(store.edit.history).toHaveLength(1)
  })

  it('answers Escape by letting go of the selection, and never by closing', async () => {
    const { closed } = await open()
    sequence('I').click()
    expect(document.querySelector('.edit-card .edit-locus')).not.toBeNull()
    key('Escape')
    expect(document.querySelector('.edit-card .edit-locus')).toBeNull()
    key('Escape')
    expect(closed()).toBe(false)
    expect(document.querySelector('.modal-edit')).not.toBeNull()
    ;(document.querySelector('.modal-panel .btn-close') as HTMLButtonElement).click()
    expect(closed()).toBe(true)
    expect(document.querySelector('.modal-edit')).toBeNull()
  })

  it('offers a whole sequence its own acts, and names what a box would', async () => {
    await open()
    sequence('I').click()
    expect(textsOf(document.body, '.edit-act span')).toEqual(['turn', 'copy', 'own sequence', 'set aside'])
  })
})

describe('the suggestions', () => {
  /**
   * A stage over a simulated map whose first sequence reads `[60, 120)`
   * backwards — the method's one suggestion is to turn it back.
   */
  async function openOnATurn(): Promise<{ store: EditStore }> {
    const simulated = await simulate([[[0, 0, 60, 1], [0, 60, 120, -1], [0, 120, 180, 1]], [[1, 0, 120, 1]]])
    const expected = expectedOf(simulated.contacts, true)
    const n = simulated.contacts.n
    const result: PictureResult = {
      ...picture(),
      n,
      sequences: simulated.names.map((name, i) => ({
        name,
        length: simulated.lengths[i],
        firstCell: simulated.offsets[i],
        cells: simulated.offsets[i + 1] - simulated.offsets[i],
      })),
      levels: [{ n, cells: new Uint8Array((n * (n + 1)) / 2).fill(100) }],
      method: { contacts: simulated.contacts, expected, corners: findCorners(simulated.contacts, expected) },
    }
    const store = new EditStore('stage|turned.cool', { names: simulated.names, lengths: simulated.lengths })
    const stage = new EditStage({
      title: 'turned.cool',
      memoryKey: () => 'stage|turned.cool',
      store,
      readPicture: () => ({ promise: Promise.resolve(result), cancel: () => {} }),
      colormap: 'default',
      onClose: () => {},
    })
    opened.push(stage)
    await new Promise((resolve) => setTimeout(resolve, 0))
    return { store }
  }
  /** Long enough for the stage to count the suggestions again after a step. */
  const recount = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 60))

  it('lists what the method suggests, and takes one as a step the suggestion made', async () => {
    const { store } = await openOnATurn()
    expect(textsOf(document.body, '.edit-suggestion-words')).toEqual(['turn s1:60,001-120,000'])
    button('take').click()
    expect(store.edit.history).toHaveLength(1)
    expect(store.edit.history[0]).toMatchObject({ by: 'suggestion', step: { op: 'invert', sequence: 's1', from: 60_000, to: 120_000 } })
    expect(store.edit.history[0].suggestion).toMatch(/^turn s1:60,001-120,000 · \d+% · map/)
    await recount()
    expect(textsOf(document.body, '.edit-suggestion-words')).toEqual([])
    expect(textsOf(document.body, '.edit-history-by')).toEqual(['suggested'])
  })

  it('turns one down with N while it is lit, keeps it turned down, and learns from it', async () => {
    const { store } = await openOnATurn()
    const row = document.querySelector('.edit-suggestion') as HTMLElement
    row.dispatchEvent(new Event('pointerenter'))
    expect(row.classList.contains('is-lit')).toBe(true)
    key('n')
    await recount()
    expect(textsOf(document.body, '.edit-suggestion-words')).toEqual([])
    expect(textsOf(document.body, '.edit-declined-words')).toEqual(['turn s1:60,001-120,000'])
    expect(store.learned.rejected).toHaveLength(1)
    expect(store.learned.answers).toBe(1)
    expect(store.edit.history).toHaveLength(0)
    // Offered again, from the list of those turned down.
    ;(document.querySelector('.edit-declined-list button') as HTMLButtonElement).click()
    await recount()
    expect(textsOf(document.body, '.edit-suggestion-words')).toEqual(['turn s1:60,001-120,000'])
  })

  it('works through them in review, answering with the keys it prints', async () => {
    const { store } = await openOnATurn()
    button('review').click()
    expect(document.querySelector('.edit-review-where')?.textContent).toBe('1 of 1')
    expect(textsOf(document.body, '.edit-review .kbd')).toEqual(['Y', 'N', '←', '→', 'space'])
    key('y')
    expect(store.edit.history[0].by).toBe('suggestion')
    await recount()
    expect(document.querySelector('.edit-review-words')?.textContent).toBe('review · nothing left to answer')
  })

  it('lets go of the map as it would be when the window loses focus with Space held', async () => {
    await openOnATurn()
    button('review').click()
    key(' ')
    expect(document.querySelector('.edit-review-state')?.textContent).toBe('as it would be')
    // No key-up comes for a key held as the window goes.
    window.dispatchEvent(new Event('blur'))
    expect(document.querySelector('.edit-review-state')).toBeNull()
  })

  it('applies every one at even odds or more in auto, each a step marked auto', async () => {
    const { store } = await openOnATurn()
    button('auto').click()
    button('apply 1 at 50% or more').click()
    expect(store.edit.history.map((entry) => entry.by)).toEqual(['auto'])
    expect(document.querySelector('.edit-suggestions-card .edit-acts button')?.textContent).toBe('none at 50% or more')
  })
})
