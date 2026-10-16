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

import { AnnotationStore } from '@/annotations/store'
import type { AnnotationClient } from '@/annotations/worker/client'
import { findCorners } from '@/edit/corners'
import { EditStage, type EditStageProps } from '@/edit/EditStage'
import { expectedOf } from '@/edit/method'
import type { Suggested } from '@/edit/suggest'
import { EditStore } from '@/state/referenceEdit'
import type { PictureResult } from '@/worker/protocol'
import { setUpDom, textsOf, type DomTeardown } from '../support/dom'
import { simulate, type TruePiece } from '../support/simulatedMap'

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
/** Rename a sequence from its pencil, Enter committing what is typed. */
const rename = (name: string, to: string): void => {
  ;(document.querySelector(`.edit-sequence-rename[aria-label="Rename ${name}"]`) as HTMLButtonElement).click()
  const input = document.querySelector('.edit-rename-input') as HTMLInputElement
  input.value = to
  input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
}

describe('renaming the sequences in a run (§26.8)', () => {
  it('names one and goes on to the next with Tab, back with Shift+Tab', async () => {
    const { store } = await open()
    ;(document.querySelector('.edit-sequence-rename[aria-label="Rename I"]') as HTMLButtonElement).click()
    const first = document.querySelector('.edit-rename-input') as HTMLInputElement
    first.value = 'chrI'
    first.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }))
    expect(store.edit.history.at(-1)?.step).toEqual({ op: 'rename', sequence: 'I', name: 'chrI' })
    const second = document.querySelector('.edit-rename-input') as HTMLInputElement
    expect(second.value).toBe('II')
    expect(document.activeElement).toBe(second)
    second.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true, cancelable: true }))
    expect((document.querySelector('.edit-rename-input') as HTMLInputElement).value).toBe('chrI')
  })

  it('stops on a name refused, the note saying why, and past the last', async () => {
    await open()
    ;(document.querySelector('.edit-sequence-rename[aria-label="Rename I"]') as HTMLButtonElement).click()
    const first = document.querySelector('.edit-rename-input') as HTMLInputElement
    first.value = 'II'
    first.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }))
    expect(document.querySelector('.edit-rename-input')).toBeNull()
    expect(document.body.textContent).toContain('II is the name of another sequence already.')
    ;(document.querySelector('.edit-sequence-rename[aria-label="Rename II"]') as HTMLButtonElement).click()
    const last = document.querySelector('.edit-rename-input') as HTMLInputElement
    last.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }))
    expect(document.querySelector('.edit-rename-input')).toBeNull()
  })
})

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
    expect(textsOf(document.body, '.edit-act span')).toEqual(['earlier', 'later', 'turn', 'copy', 'own sequence', 'set aside'])
    // The first sequence has no earlier place to go.
    expect(button('earlier').disabled).toBe(true)
    expect(button('later').disabled).toBe(false)
  })

  it('moves a whole sequence one place in the order with ↑ and ↓, joining nothing, the selection with it', async () => {
    const { store } = await open()
    sequence('II').click()
    key('ArrowUp')
    expect(store.edit.history.at(-1)?.step).toEqual({ op: 'place', sequence: 'II', from: 0, to: 5500, before: 'I', strand: 1, whole: true })
    expect(textsOf(document.body, '.edit-sequence-name')).toEqual(['II', 'I'])
    expect(document.querySelector('.edit-sequence.is-selected .edit-sequence-name')?.textContent).toBe('II')
    expect(textsOf(document.body, '.edit-history-button').at(-1)).toBe('1put II before I')
    // Already first: nothing is made, and the readout says so.
    key('ArrowUp')
    expect(store.applied).toBe(1)
    expect(document.querySelector('.edit-readout')?.textContent).toBe('II is first already')
  })

  it('moves a sequence by its grip, dragged or with ↑ ↓ on it', async () => {
    const { store } = await open()
    const proto = HTMLElement.prototype as unknown as Record<string, unknown>
    const held = { set: proto.setPointerCapture, has: proto.hasPointerCapture, release: proto.releasePointerCapture }
    proto.setPointerCapture = () => {}
    proto.hasPointerCapture = () => false
    proto.releasePointerCapture = () => {}
    try {
      const grip = (name: string): HTMLElement => document.querySelector(`.edit-sequence-grip[data-sequence="${name}"]`) as HTMLElement
      // Held by I's grip and let go past the last row: I goes last.
      grip('I').dispatchEvent(new MouseEvent('pointerdown', { button: 0, clientY: -10, bubbles: true }))
      grip('I').dispatchEvent(new MouseEvent('pointermove', { clientY: 400, bubbles: true }))
      grip('I').dispatchEvent(new MouseEvent('pointerup', { clientY: 400, bubbles: true }))
      expect(store.edit.history.at(-1)?.step).toEqual({ op: 'place', sequence: 'I', from: 0, to: 10_000, before: null, strand: 1, whole: true })
      expect(textsOf(document.body, '.edit-sequence-name')).toEqual(['II', 'I'])
      // ↑ on I's grip, which keeps the focus: back where it was.
      grip('I').focus()
      grip('I').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true, cancelable: true }))
      expect(textsOf(document.body, '.edit-sequence-name')).toEqual(['I', 'II'])
      expect((document.activeElement as HTMLElement | null)?.dataset.sequence).toBe('I')
    } finally {
      proto.setPointerCapture = held.set
      proto.hasPointerCapture = held.has
      proto.releasePointerCapture = held.release
    }
  })

  it('puts back a stretch set aside, from its row, as a sequence of its own, last, selected', async () => {
    const { store } = await open()
    store.apply({ op: 'aside', sequence: 'I', from: 2000, to: 5000, why: 'debris' }, 'reader')
    expect(textsOf(document.body, '.edit-aside-locus')).toEqual(['I:2,001-5,000'])
    button('put back').click()
    expect(store.edit.history.at(-1)?.step).toEqual({ op: 'restore', sequence: 'I', start: 2000, end: 5000 })
    expect(textsOf(document.body, '.edit-aside-locus')).toEqual([])
    expect(textsOf(document.body, '.edit-sequence-name')).toEqual(['I_e1', 'II', 'I_e2'])
    expect(document.querySelector('.edit-sequence.is-selected .edit-sequence-name')?.textContent).toBe('I_e2')
    // One step, undone as any is: set aside again.
    store.undo()
    expect(textsOf(document.body, '.edit-aside-locus')).toEqual(['I:2,001-5,000'])
  })

  it('orders its cards selection, sequences, history, suggestions, export and picture — the suggestions first in review', async () => {
    const { stage } = await open()
    void stage
    const order = (): string[] =>
      [...document.querySelectorAll('.edit-side-body > *')].map((card) => {
        const kind = [...card.classList].find((name) => /^edit-(modes|[a-z]+-card)$/.test(name))
        return kind ?? (card.querySelector('.edit-card-head')?.textContent?.split(' ')[0] ?? '')
      })
    expect(order()).toEqual(['edit-modes', 'selection', 'edit-sequences-card', 'history', 'edit-suggestions-card', 'edit-export-card', 'edit-picture-card'])
  })

  it('renames a sequence from its pencil, as a step, and refuses a name another has', async () => {
    const { store } = await open()
    rename('I', 'chrI')
    expect(store.edit.history.at(-1)?.step).toEqual({ op: 'rename', sequence: 'I', name: 'chrI' })
    expect(textsOf(document.body, '.edit-sequence-name')).toEqual(['chrI', 'II'])
    // Another's name, or two words, is refused and said; nothing is made.
    rename('II', 'chrI')
    expect(store.applied).toBe(1)
    expect(document.querySelector('.edit-sequences-note')?.textContent).toBe('chrI is the name of another sequence already.')
    rename('II', 'chr II')
    expect(store.applied).toBe(1)
    expect(document.querySelector('.edit-sequences-note')?.textContent).toMatch(/^A name is one word/)
  })

  it('gives a sequence its own name back, and that name to nothing but that sequence whole', async () => {
    const { store } = await open()
    rename('I', 'chrI')
    // I whole, renamed: its own name is its to take back, as the step allows
    // and the refusal's own words say.
    rename('chrI', 'I')
    expect(store.applied).toBe(2)
    expect(store.edit.history.at(-1)?.step).toEqual({ op: 'rename', sequence: 'chrI', name: 'I' })
    expect(textsOf(document.body, '.edit-sequence-name')).toEqual(['I', 'II'])
    expect(document.querySelector('.edit-sequences-note')).toBeNull()
    // A stretch of it is not it, and nor is another sequence.
    store.apply({ op: 'split', sequence: 'I', at: 4_000 })
    const [left, , other] = textsOf(document.body, '.edit-sequence-name')
    expect(left).not.toBe('I')
    expect(other).toBe('II')
    for (const name of [left, other]) {
      rename(name, 'I')
      expect(store.applied).toBe(3)
      expect(document.querySelector('.edit-sequences-note')?.textContent).toBe(
        'I is a name of the file’s own, for that sequence whole and no other.',
      )
    }
  })

  it('reads the ends and gaps from the file’s own sequence, not from a reference loaded before it (§27.5)', async () => {
    // The theoretical genome first, naming none of the map's sequences, then
    // the assembly's own FASTA: the one the corner plot calls the file's own.
    const lanes = new AnnotationStore(`stage-evidence-${Math.random()}.cool`, { persist: false })
    for (const [id, label, matched] of [
      ['theory', 'theory.fa', 0],
      ['own', 'assembly.fa', 2],
    ] as const) {
      lanes.begin({ card: 'linear', kind: 'sequence', id, label, source: { kind: 'remote', url: `https://data.example/${label}`, name: label } })
      lanes.update(id, { status: 'ready', overlap: { matched, total: 2, missing: [], extra: [] } })
    }
    const asked = new Set<string>()
    const client = {
      request: (payload: { kind: string; entry?: string; regions?: Array<{ contig: string; start: number; end: number }> }) => {
        // Every other read the stage's lanes make is left unanswered.
        if (payload.kind !== 'bases' || payload.regions === undefined) return new Promise(() => {})
        asked.add(payload.entry ?? '')
        return Promise.resolve({
          regions: payload.regions.map((region) => ({ ...region, bases: new TextEncoder().encode('ACGT'.repeat(region.end - region.start).slice(0, region.end - region.start)) })),
        })
      },
      // The corner plot's run, which is not what this is about.
      cancellable: () => ({ promise: new Promise(() => {}), cancel: () => {} }),
    } as unknown as AnnotationClient
    const store = new EditStore('stage|evidence.cool', ORIGINAL)
    const stage = new EditStage({
      title: 'evidence.cool',
      memoryKey: () => 'stage|evidence.cool',
      store,
      readPicture: () => ({ promise: Promise.resolve(picture()), cancel: () => {} }),
      colormap: 'default',
      lanes: { store: lanes, client },
      onClose: () => {},
    })
    opened.push(stage)
    for (let k = 0; k < 8; k++) await new Promise((resolve) => setTimeout(resolve, 0))
    expect([...asked]).toEqual(['own'])
    expect(document.querySelector('.edit-evidence-note')?.textContent).toMatch(/^From assembly\.fa: telomeric repeats at 0 of 4 ends/)
  })

  it('puts the sequences longest first, as one step, and says when they are', async () => {
    const { store } = await open()
    expect(button('longest first').disabled).toBe(true)
    store.apply({ op: 'reorder', names: ['II', 'I'] }, 'reader')
    expect(textsOf(document.body, '.edit-sequence-name')).toEqual(['II', 'I'])
    button('longest first').click()
    expect(store.edit.history.at(-1)?.step).toEqual({ op: 'reorder', names: ['I', 'II'] })
    expect(textsOf(document.body, '.edit-sequence-name')).toEqual(['I', 'II'])
    expect(button('longest first').disabled).toBe(true)
  })
})

describe('the suggestions', () => {
  /**
   * A stage over a simulated map whose first sequence reads `[60, 120)`
   * backwards — the method's one suggestion is to turn it back.
   */
  function openOnATurn(extra: Partial<EditStageProps> = {}): Promise<{ store: EditStore; stage: EditStage }> {
    return openOn([[[0, 0, 60, 1], [0, 60, 120, -1], [0, 120, 180, 1]], [[1, 0, 120, 1]]], extra)
  }

  /** A stage over a map simulated from an assembly of these pieces (`simulate`). */
  async function openOn(pieces: TruePiece[][], extra: Partial<EditStageProps> = {}): Promise<{ store: EditStore; stage: EditStage }> {
    const simulated = await simulate(pieces)
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
      ...extra,
    })
    opened.push(stage)
    await new Promise((resolve) => setTimeout(resolve, 0))
    return { store, stage }
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

  it('says and takes a suggestion as the finer rungs place its points', async () => {
    const asked: number[][] = []
    const { store } = await openOnATurn({
      refine: (request) => {
        asked.push(request.points.map((point) => point.bp))
        const placed = new Map([
          [60_000, { bp: 61_500, binsize: 500, support: 0.1 }],
          [120_000, { bp: 118_000, binsize: 500, support: 0.2 }],
        ])
        return { promise: Promise.resolve(request.points.map((point) => placed.get(point.bp) ?? null)), cancel: () => {} }
      },
    })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(asked).toEqual([[60_000, 120_000]])
    expect(textsOf(document.body, '.edit-suggestion-words')).toEqual(['turn s1:61,501-118,000'])
    expect(textsOf(document.body, '.edit-suggestion .edit-chip')).toContain('refined at 500 bp')
    button('take').click()
    expect(store.edit.history[0].step).toEqual({ op: 'invert', sequence: 's1', from: 61_500, to: 118_000 })
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

  it('puts the suggestions card first in review and auto, and back after the history in manual', async () => {
    await openOnATurn()
    const first = (): string | undefined => [...(document.querySelector('.edit-side-body')?.children ?? [])][1]?.className
    expect(first()).toBe('edit-card')
    button('review').click()
    expect(first()).toBe('edit-card edit-suggestions-card')
    button('auto').click()
    expect(first()).toBe('edit-card edit-suggestions-card')
    button('manual').click()
    expect(first()).toBe('edit-card')
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

  it('frames the next best once one is answered, as it frames the first (§27.6)', async () => {
    // Two turns, one in each sequence: far enough apart that framing either
    // leaves the other off the map.
    const { stage } = await openOn([
      [[0, 0, 60, 1], [0, 60, 120, -1], [0, 120, 180, 1]],
      [[1, 0, 60, 1], [1, 60, 120, -1], [1, 120, 200, 1]],
    ])
    const inside = stage as unknown as {
      current: string | null
      byKey(key: string | null): { extent: [number, number] } | null
      sx: { domain: [number, number] }
    }
    /** Whether the map shows the whole of what the one review is on concerns. */
    const framed = (): boolean => {
      const extent = inside.byKey(inside.current)?.extent
      const [from, to] = inside.sx.domain
      return extent !== undefined && from <= extent[0] && extent[1] <= to
    }
    button('review').click()
    expect(document.querySelector('.edit-review-where')?.textContent).toBe('1 of 2')
    const first = inside.current
    expect(framed()).toBe(true)
    key('n')
    await recount()
    expect(document.querySelector('.edit-review-where')?.textContent).toBe('1 of 1')
    expect(inside.current).not.toBe(first)
    expect(framed()).toBe(true)
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

  it('says it is weighing while the count kept where the picture was read is on its way', async () => {
    let answer: (suggested: Suggested) => void = () => {}
    const store = new EditStore('stage|kept.cool', ORIGINAL)
    const stage = new EditStage({
      title: 'kept.cool',
      memoryKey: () => 'stage|kept.cool',
      store,
      readPicture: () => ({ promise: Promise.resolve({ ...picture(), methodKept: 1 }), cancel: () => {} }),
      suggest: () => ({ promise: new Promise<Suggested>((resolve) => (answer = resolve)), cancel: () => {} }),
      colormap: 'default',
      onClose: () => {},
    })
    opened.push(stage)
    await new Promise((resolve) => setTimeout(resolve, 0))
    const head = (): string | null | undefined => document.querySelector('.edit-suggestions-card .edit-card-head')?.textContent
    expect(head()).toBe('suggestions · weighing…')
    expect(document.querySelector('.edit-suggestions-card .edit-empty')?.textContent).toMatch(/^Weighing the map/)
    answer({ list: [], along: new Float64Array(16).fill(Number.NaN), breakpoints: [], unit: 1 })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(head()).toBe('suggestions · 0')
    expect(document.querySelector('.edit-suggestions-card .edit-empty')?.textContent).toMatch(/^Nothing to suggest/)
  })

  it('applies every one at even odds or more in auto, each a step marked auto', async () => {
    const { store } = await openOnATurn()
    button('auto').click()
    button('apply 1 at 50% or more').click()
    expect(store.edit.history.map((entry) => entry.by)).toEqual(['auto'])
    // Each one taken is counted again before the next, and the count may be
    // another thread's (§27.12): the run settles, then the button says so.
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(document.querySelector('.edit-suggestions-card .edit-acts button')?.textContent).toBe('none at 50% or more')
  })
})
