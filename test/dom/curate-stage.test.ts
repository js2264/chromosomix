// @vitest-environment jsdom
// @dev-feature curate
/**
 * The curation stage's frame (SPECS §33.3), in a DOM, with stand-ins for its
 * pictures and cards: the dialog and its three columns, the large picture and
 * its keys, the running tally, the acts the keys make, the review's band and
 * its price, undo, and Escape never closing it.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { CuratedBinning, fileBinning } from '@/genome/curation'
import { stateAnswer } from '@/curate/answer'
import type { CurateContext, CuratePane } from '@/curate/ui/context'
import { CurateStage, type CurateCard, type CurateParts } from '@/curate/ui/CurateStage'
import { CurationStore } from '@/state/curation'
import type { CurationFocusResult, CurationNetworkResult } from '@/worker/curateProtocol'
import { setUpDom, textsOf, type DomTeardown } from '../support/dom'
import { community } from '../support/curateCommunity'

let teardown: DomTeardown
let stages: CurateStage[] = []
let keys = 0

beforeEach(() => {
  teardown = setUpDom({ canvas: 'stub' })
  window.sessionStorage.clear()
  window.localStorage.clear()
})

afterEach(() => {
  for (const stage of stages) stage.close()
  stages = []
  teardown()
})

/** A picture that draws nothing and says what it was told. */
function pane(name: string, told: string[]): CuratePane {
  return {
    element: Object.assign(document.createElement('div'), { className: `stand-in-${name}` }),
    title: name,
    update: () => {},
    resize: () => {},
    setLarge: (large) => told.push(`${name}:${large ? 'large' : 'small'}`),
    showSuggestion: (s) => told.push(`${name}:${s?.kind ?? 'none'}`),
    key: () => false,
    dropTargetAt: () => null,
    dispose: () => {},
  }
}

function card(name: string): CurateCard {
  const element = document.createElement('section')
  element.className = `edit-card stand-in-${name}`
  return { element, update: () => {} }
}

async function open(): Promise<{ stage: CurateStage; store: CurationStore; told: string[]; ctx: () => CurateContext }> {
  const { base, evidence } = community()
  const store = new CurationStore(`curate-stage-${++keys}`, base, fileBinning(base), () => 0)
  const told: string[] = []
  let held: CurateContext | null = null
  const parts: CurateParts = {
    contacts: (ctx) => {
      held = ctx
      return pane('contacts', told)
    },
    hosts: () => pane('hosts', told),
    scatter: () => pane('scatter', told),
    selection: () => card('selection'),
    suggestions: () => card('suggestions'),
    history: () => card('history'),
    exporting: () => card('export'),
    about: () => card('about'),
    chooser: () => ({ close: () => {} }),
  }
  const summary: CurationNetworkResult = { contigs: base.names.length, pairs: evidence.network.first.length, pixels: 100, within: 0, between: 0, background: evidence.background }
  const stage = new CurateStage({
    title: 'community.metacool',
    stem: 'community',
    store,
    base: { base, file: fileBinning(base), elements: { count: 1, fromRoundOnly: 0 }, gc: null, markerSets: ['Bact4'], pixels: 100, networkHeld: false },
    requests: {
      network: () => ({ promise: Promise.resolve(summary), cancel: () => {} }),
      state: (curation, weights) => ({ promise: Promise.resolve(stateAnswer(evidence, CuratedBinning.of(base, curation), weights)), cancel: () => {} }),
      focus: () => ({ promise: new Promise<CurationFocusResult>(() => {}), cancel: () => {} }),
    },
    parts,
    memoryKey: () => 'community.metacool',
    gate: null,
    onClose: () => {},
    debounce: 0,
  })
  stages.push(stage)
  await settle()
  return { stage, store, told, ctx: () => held as unknown as CurateContext }
}

/** The counts and a frame. */
async function settle(): Promise<void> {
  for (let k = 0; k < 6; k++) await new Promise((resolve) => setTimeout(resolve, 0))
}

function key(name: string, init: KeyboardEventInit = {}): void {
  window.dispatchEvent(new KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true, ...init }))
}

describe('the curation stage', () => {
  it('opens on the whole window: the list, one large picture and two small, the inspector in its order', async () => {
    await open()
    expect(document.querySelector('.modal-title')?.textContent).toBe('Curate the genomes · community.metacool')
    expect(document.querySelector('.modal-panel')?.classList.contains('modal-curate')).toBe(true)
    expect(document.querySelector('.curate-list')).not.toBeNull()
    expect([...document.querySelectorAll('.curate-slot')].map((slot) => `${(slot as HTMLElement).dataset.slot}:${slot.classList.contains('is-large') ? 'large' : 'small'}`)).toEqual(['contacts:large', 'hosts:small', 'scatter:small'])
    const side = [...document.querySelectorAll('.curate-side-body > section')].map((node) => node.className.replace(/.*stand-in-/, '').replace('edit-card curate-modes-card', 'modes'))
    expect(side).toEqual(['modes', 'selection', 'history', 'suggestions', 'export', 'about'])
    expect(document.querySelector('.curate-stage')?.getAttribute('data-contacts')).toBe('read')
  })

  it('says the tally in the readout, and the steps once one is made', async () => {
    const { store } = await open()
    expect(document.querySelector('.curate-readout')?.textContent).toBe('4 MAGs · 1 element · 1 unbinned contig (50.0 kb) · as in the file')
    store.apply({ op: 'merge', into: 'X1', genomes: ['X2'] })
    await settle()
    expect(document.querySelector('.curate-readout')?.textContent).toBe('MAGs 4 → 3 · 1 element · 1 unbinned contig (50.0 kb) · 1 step · 3 contigs moved')
  })

  it('makes a picture large from its key, and undoes and redoes from theirs', async () => {
    const { store, told } = await open()
    key('2')
    expect(document.querySelector('.curate-slot.is-large')?.getAttribute('data-slot')).toBe('hosts')
    expect(told).toContain('hosts:large')
    store.apply({ op: 'rename', genome: 'Z', name: 'Zeta' })
    await settle()
    key('z', { ctrlKey: true })
    await settle()
    expect(store.applied).toBe(0)
    key('z', { ctrlKey: true, shiftKey: true })
    expect(store.applied).toBe(1)
  })

  it('merges the selected genomes with M, unbins a selected contig with Delete, and lets go of the selection on Escape', async () => {
    const { store, ctx } = await open()
    ctx().model.selectGenomes(['X1', 'X2'])
    key('m')
    expect(store.binning.indexOfId('X2')).toBeUndefined()
    await settle()
    ctx().model.selectContigs([3])
    key('Delete')
    expect(store.binning.genomeOf[3]).toBe(-1)
    await settle()
    ctx().model.selectGenomes(['Y'])
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
    expect(ctx().model.selection.genomes).toEqual([])
    expect(document.querySelector('.modal-panel')).not.toBeNull()
  })

  it('reviews: the band names the suggestion, prices it, takes it on Y and turns the next down on N', async () => {
    const { store, ctx, told } = await open()
    ;(document.querySelector('[data-mode="review"]') as HTMLButtonElement).click()
    await settle()
    const band = document.querySelector('.curate-band') as HTMLElement
    expect(band.classList.contains('hidden')).toBe(false)
    expect(band.querySelector('.curate-band-where')?.textContent).toMatch(/^review · 1 of \d+$/)
    expect(band.querySelector('.curate-band-words')?.textContent).toMatch(/^merge X2 into X1 · \d+%$/)
    expect(textsOf(band, '.curate-band-price-row')[0]).toBe('X1 complete 50% + 50% → 100% · redundant 1.00 + 1.00 → 1.00 · high quality')
    expect(told).toContain('contacts:merge')
    key('y')
    expect(store.curation.history[0].by).toBe('suggestion')
    await settle()
    const next = ctx().model.current
    expect(next).not.toBeNull()
    key('n')
    await settle()
    expect(store.learned.rejected).toContain(next?.key)
  })
})
