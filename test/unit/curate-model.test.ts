// @dev-feature curate
/**
 * The curation stage's controller (SPECS §33.3) on a small community, counted
 * by the method itself as the worker would count it: a step is counted again,
 * a slow answer never paints over a later step, the order holds across steps,
 * the review's answers are learned, and auto takes the sure suggestions one
 * step at a time.
 */

import { describe, expect, it } from 'vitest'
import { CuratedBinning, fileBinning, type Curation } from '../../src/genome/curation'
import { stateAnswer } from '../../src/curate/answer'
import { AUTO_THRESHOLD, INITIAL_WEIGHTS, OFFER_FLOOR } from '../../src/curate/method'
import { CurateModel, describeSuggestion, displayPercent, queueOrder, type CurateChange, type CurateClient } from '../../src/curate/model'
import type { KindWeights, Suggestion } from '../../src/curate/suggest'
import { CurationStore } from '../../src/state/curation'
import type { CurationStateResult } from '../../src/worker/curateProtocol'
import { community } from '../support/curateCommunity'

let keys = 0

/** A store for the community under a fresh key, and a client that counts at once. */
function setup(options: { hold?: boolean } = {}): {
  model: CurateModel
  store: CurationStore
  asked: Array<{ curation: Curation | null; weights: KindWeights; resolve: () => void }>
  changes: CurateChange[]
} {
  const { base, evidence } = community()
  const store = new CurationStore(`curate-model-${++keys}`, base, fileBinning(base), () => 0)
  const asked: Array<{ curation: Curation | null; weights: KindWeights; resolve: () => void }> = []
  const client: CurateClient = {
    state(curation, weights) {
      const answer = stateAnswer(evidence, CuratedBinning.of(base, curation), weights)
      let resolve: () => void = () => {}
      const promise = new Promise<CurationStateResult>((done) => {
        resolve = () => done(answer)
      })
      asked.push({ curation, weights, resolve })
      if (options.hold !== true) resolve()
      return { promise, cancel: () => {} }
    },
  }
  // Timers run at once: a step is counted as soon as it is made.
  const model = new CurateModel(store, client, { schedule: (run) => (run(), () => {}) })
  const changes: CurateChange[] = []
  model.subscribe((change) => changes.push(change))
  return { model, store, asked, changes }
}

describe('the queue’s order', () => {
  const s = (kind: Suggestion['kind'], confidence: number, key = `${kind}${confidence}`): Suggestion =>
    ({ key, kind, confidence }) as Suggestion
  it('puts the likely first, and among them merges, moves, recruits, then links; the surest first in a kind', () => {
    const list = [s('link', 0.99), s('recruit', 0.6), s('merge', 0.3), s('move', 0.7), s('merge', 0.55), s('unlink', 0.8), s('merge', 0.95)]
    expect(list.sort(queueOrder).map((x) => x.key)).toEqual(['merge0.95', 'merge0.55', 'move0.7', 'recruit0.6', 'link0.99', 'unlink0.8', 'merge0.3'])
  })
})

describe('the controller', () => {
  it('counts the file’s binning on open, and again after every step', async () => {
    const { model, store } = setup()
    await model.settled()
    expect(model.stale).toBe(false)
    expect(model.answer?.genomes.map((genome) => genome.name)).toEqual(['X1', 'X2', 'Y', 'Z', 'P'])
    store.apply({ op: 'merge', into: 'X1', genomes: ['X2'] })
    expect(model.stale).toBe(true)
    await model.settled()
    expect(model.answer?.genomes.map((genome) => genome.name)).toEqual(['X1', 'Y', 'Z', 'P'])
  })

  it('takes only the answer to the last count asked, whatever order answers arrive in', async () => {
    const { model, store, asked } = setup({ hold: true })
    store.apply({ op: 'merge', into: 'X1', genomes: ['X2'] })
    expect(asked.length).toBe(2)
    // The later count answers first; the first, answering late, is not taken.
    asked[1].resolve()
    await model.settled()
    asked[0].resolve()
    await Promise.resolve()
    await Promise.resolve()
    expect(model.answer?.genomes.length).toBe(4)
  })

  it('lays out the MAGs in the file’s order, then the elements, and keeps the order across a step', async () => {
    const { model, store } = setup()
    await model.settled()
    const order = model.order
    expect(order).toEqual(['X1', 'X2', 'Y', 'Z', 'P'])
    // A new genome made of X2's contigs sits beside X2.
    store.apply({ op: 'create', id: 'curated:1', name: 'half', kind: 'mag', contigs: ['x4', 'x5'] })
    await model.settled()
    expect(model.order.indexOf('curated:1')).toBe(model.order.indexOf('X2') + 1)
    expect(model.order.filter((id) => id !== 'curated:1')).toEqual(order)
  })

  it('tidies on demand: an organism’s fragments side by side, its element beside it', async () => {
    const { model } = setup()
    await model.settled()
    model.tidy()
    const order = model.order
    expect(Math.abs(order.indexOf('X1') - order.indexOf('X2'))).toBe(1)
    expect(order[order.length - 1]).toBe('P')
  })

  it('moves a genome whose kind changes to its kind’s block', async () => {
    const { model, store } = setup()
    await model.settled()
    store.apply({ op: 'retype', genome: 'Z', kind: 'element' })
    await model.settled()
    expect(model.order.slice(-2)).toEqual(['P', 'Z'])
  })

  it('offers the suggestions at the floor or more, the likely merges first, and drops one turned down', async () => {
    const { model } = setup()
    await model.settled()
    const offered = model.offered()
    expect(offered.length).toBeGreaterThan(0)
    expect(offered.every((s) => s.confidence >= OFFER_FLOOR)).toBe(true)
    for (let k = 1; k < offered.length; k++) expect(queueOrder(offered[k - 1], offered[k])).toBeLessThan(0)
    expect(offered[0].kind).toBe('merge')
    const merge = offered.find((s) => s.kind === 'merge')
    expect(merge).toBeDefined()
    if (merge === undefined) return
    model.reject(merge)
    await model.settled()
    expect(model.offered().some((s) => s.key === merge.key)).toBe(false)
    expect(model.declined().map((d) => d.key)).toEqual([merge.key])
    model.restore(merge.key)
    await model.settled()
    expect(model.offered().some((s) => s.key === merge.key)).toBe(true)
  })

  it('learns from an answer: a merge turned down weighs merges less, a taken one is kept in the history', async () => {
    const { model, store } = setup()
    await model.settled()
    const merge = model.offered().find((s) => s.kind === 'merge')
    if (merge === undefined) throw new Error('no merge offered')
    model.reject(merge)
    const learned = store.learned
    expect(learned.answers).toBe(1)
    expect(learned.weights.merge).not.toEqual(INITIAL_WEIGHTS.merge)
    model.restore(merge.key)
    await model.settled()
    const again = model.offered().find((s) => s.key === merge.key)
    expect(again?.confidence ?? 1).toBeLessThan(merge.confidence)
    if (again === undefined) return
    model.accept(again)
    await model.settled()
    const entry = store.curation.history[0]
    expect(entry.by).toBe('suggestion')
    expect(entry.suggestion).toBe(describeSuggestion(again))
    expect(store.learned.answers).toBe(2)
  })

  it('learns an unlink taken as a link turned down', async () => {
    const { model, store } = setup()
    await model.settled()
    const unlink = model.offered().find((s) => s.kind === 'unlink')
    if (unlink === undefined) throw new Error('no unlink offered')
    model.accept(unlink)
    expect(Object.keys(store.learned.weights)).toEqual(['link'])
    await model.settled()
    expect(model.answer?.links.some((link) => link.element === 'P' && link.mag === 'Z')).toBe(false)
  })

  it('reviews one suggestion at a time, the next along after an answer', async () => {
    const { model } = setup()
    await model.settled()
    expect(model.current).toBeNull()
    model.setMode('review')
    const offered = model.offered()
    expect(model.current?.key).toBe(offered[0].key)
    model.moveCurrent(1)
    expect(model.current?.key).toBe(offered[1].key)
    model.moveCurrent(-1)
    model.moveCurrent(-1)
    expect(model.current?.key).toBe(offered[offered.length - 1].key)
    const turnedDown = offered[0]
    model.setCurrent(turnedDown.key)
    model.reject(turnedDown)
    await model.settled()
    expect(model.current?.key).toBe(offered[1].key)
  })

  it('auto takes every sure suggestion, one step each, and stops when none is left', async () => {
    const { model, store } = setup()
    await model.settled()
    const sure = model.sure().length
    expect(sure).toBeGreaterThan(0)
    const steps = await model.runAuto()
    expect(steps).toBeGreaterThanOrEqual(1)
    expect(store.curation.history.every((entry) => entry.by === 'auto')).toBe(true)
    expect(model.sure().every((s) => s.confidence < AUTO_THRESHOLD)).toBe(true)
    // The community's sure steps: X's halves merged, y5 home, P linked to Y.
    const binning = store.binning
    expect(binning.indexOfId('X2')).toBeUndefined()
    expect(binning.genomeOf[3]).toBe(binning.indexOfId('Y'))
    expect(binning.links.some((link) => link.element === 'P' && link.mag === 'Y')).toBe(true)
  })

  it('makes the acts’ steps from the selection, and the selection follows what moved', async () => {
    const { model, store } = setup()
    await model.settled()
    // y5 is contig 3: home to Y.
    model.selectContigs([3])
    expect(model.moveSelected('Y')).toBe(true)
    expect(model.selection).toEqual({ genomes: ['Y'], contigs: [3] })
    await model.settled()
    expect(store.binning.genomeOf[3]).toBe(store.binning.indexOfId('Y'))
    model.selectGenomes(['X1', 'X2'])
    expect(model.mergeSelected()).toBe(true)
    await model.settled()
    expect(model.selection.genomes).toEqual(['X1'])
    // u0, contig 18, as a genome of its own, then back to the pool.
    model.selectContigs([18])
    const id = model.createFromSelected('mag')
    expect(id).toBe('curated:1')
    await model.settled()
    expect(model.answer?.genomes.some((genome) => genome.name === 'curated_MAG_1')).toBe(true)
    model.selectContigs([18])
    model.moveSelected(null)
    await model.settled()
    expect(store.binning.genomeOf[18]).toBe(-1)
    // The genome emptied by the move is gone, and leaves the selection.
    expect(model.selection.genomes).toEqual([])
  })

  it('renames, refusing a taken name and the pool’s', async () => {
    const { model } = setup()
    await model.settled()
    expect(model.rename('X1', 'Y')).toBe('Another genome is named Y.')
    expect(model.rename('X1', '__unbinned__')).toMatch(/unbinned/)
    expect(model.rename('X1', 'NaN')).toMatch(/unbinned/)
    expect(model.rename('X1', 'café')).toMatch(/ASCII/)
    expect(model.rename('X1', 'two words')).toMatch(/without spaces/)
    expect(model.rename('X1', 'a,b')).toMatch(/comma/)
    expect(model.rename('X1', 'Xanthomonas')).toBeNull()
    await model.settled()
    expect(model.answer?.genomes[0].name).toBe('Xanthomonas')
  })

  it('links an element to a MAG, and only an element to a MAG', async () => {
    const { model } = setup()
    await model.settled()
    expect(model.link('X1', 'Y', true)).toBe(false)
    expect(model.link('P', 'Y', true)).toBe(true)
    await model.settled()
    expect(model.link('P', 'Y', true)).toBe(false)
    expect(model.link('P', 'Y', false)).toBe(true)
  })

  it('selects by replacing, adding and toggling', async () => {
    const { model, changes } = setup()
    await model.settled()
    model.selectGenomes(['X1'])
    model.selectGenomes(['Y'], 'add')
    expect(model.selection.genomes).toEqual(['X1', 'Y'])
    model.selectGenomes(['X1'], 'toggle')
    expect(model.selection.genomes).toEqual(['Y'])
    const before = changes.length
    model.selectGenomes(['Y'], 'add')
    expect(changes.length).toBe(before)
    model.hover('Y', 7)
    model.hover('Y', 7)
    expect(changes.filter((c) => c === 'hover').length).toBe(1)
  })

  it('tallies what changed since the file', async () => {
    const { model, store } = setup()
    await model.settled()
    expect(model.tally()).toMatchObject({ steps: 0, contigsMoved: 0, created: 0, gone: 0 })
    store.apply({ op: 'merge', into: 'X1', genomes: ['X2'] })
    store.apply({ op: 'link', element: 'P', mag: 'Y' })
    await model.settled()
    expect(model.tally()).toMatchObject({ steps: 2, contigsMoved: 3, basesMoved: 150_000, gone: 1, changed: 1, linksAdded: 1, linksDropped: 0 })
  })

  it('never shows a suggestion as certain', () => {
    expect(displayPercent(0.999)).toBe(99)
    expect(displayPercent(0.5)).toBe(50)
  })
})

describe('a drop through the controller', () => {
  it('makes its steps and selects what they leave', async () => {
    const { model, store } = setup()
    await model.settled()
    expect(model.drop({ kind: 'genomes', ids: ['X2'] }, { kind: 'genome', id: 'X1' })).toBe(true)
    expect(model.selection).toEqual({ genomes: ['X1'], contigs: [] })
    await model.settled()
    expect(model.drop({ kind: 'contigs', contigs: [18] }, { kind: 'section', section: 'mags' })).toBe(true)
    expect(model.selection).toEqual({ genomes: ['curated:1'], contigs: [18] })
    await model.settled()
    expect(model.drop({ kind: 'genomes', ids: ['Y'] }, { kind: 'genome', id: 'P' })).toBe(false)
    expect(store.applied).toBe(2)
  })
})

describe('as it would be', () => {
  it('counts one more step without making it, and lets go of it when a step is made', async () => {
    const { model, store } = setup()
    await model.settled()
    model.preview({ op: 'merge', into: 'X1', genomes: ['X2'] })
    expect(model.previewStep).toEqual({ op: 'merge', into: 'X1', genomes: ['X2'] })
    await Promise.resolve()
    await Promise.resolve()
    expect(model.previewed?.genomes.map((genome) => genome.name)).toEqual(['X1', 'Y', 'Z', 'P'])
    expect(model.shown).toBe(model.previewed)
    expect(store.applied).toBe(0)
    store.apply({ op: 'rename', genome: 'Z', name: 'Zeta' })
    expect(model.previewStep).toBeNull()
    await model.settled()
    expect(model.shown).toBe(model.answer)
  })
})
