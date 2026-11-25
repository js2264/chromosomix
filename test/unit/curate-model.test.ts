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
function setup(options: { hold?: boolean; amend?: (answer: CurationStateResult, declined: readonly string[]) => CurationStateResult } = {}): {
  model: CurateModel
  store: CurationStore
  asked: Array<{ curation: Curation | null; weights: KindWeights; declined: readonly string[]; resolve: () => void }>
  changes: CurateChange[]
} {
  const { base, evidence } = community()
  const store = new CurationStore(`curate-model-${++keys}`, base, fileBinning(base), () => 0)
  const asked: Array<{ curation: Curation | null; weights: KindWeights; declined: readonly string[]; resolve: () => void }> = []
  const client: CurateClient = {
    state(curation, weights, declined = []) {
      const counted = stateAnswer(evidence, CuratedBinning.of(base, curation), weights, declined)
      const answer = options.amend === undefined ? counted : options.amend(counted, declined)
      let resolve: () => void = () => {}
      const promise = new Promise<CurationStateResult>((done) => {
        resolve = () => done(answer)
      })
      asked.push({ curation, weights, declined, resolve })
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

  it('lays out the MAGs an organism’s fragments side by side, then the elements, and keeps the order across a step', async () => {
    const { model, store } = setup()
    await model.settled()
    const order = model.order
    expect(Math.abs(order.indexOf('X1') - order.indexOf('X2'))).toBe(1)
    expect(order[order.length - 1]).toBe('P')
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

  it('reviews one question at a time, the next along after an answer, a question’s members one by one', async () => {
    const { model, store } = setup()
    await model.settled()
    expect(model.current).toBeNull()
    model.setMode('review')
    const queue = model.queue()
    expect(model.current?.key).toBe(queue[0].key)
    model.moveCurrent(1)
    expect(model.current?.key).toBe(queue[1].key)
    model.moveCurrent(-1)
    model.moveCurrent(-1)
    expect(model.current?.key).toBe(queue[queue.length - 1].key)
    // The element's two answers — link P to Y, unlink it from Z — are one question.
    const host = queue.find((q) => q.key === 'host:P')
    expect(host?.members.map((m) => m.kind).sort()).toEqual(['link', 'unlink'])
    model.setCurrent('host:P')
    expect(model.moveMember(1)).toBe(true)
    expect(model.member).toEqual({ at: 0, of: 2 })
    expect(model.current?.key).toBe(host?.members[0].key)
    expect(model.moveMember(-1)).toBe(true)
    expect(model.member).toBeNull()
    // Taken whole: both steps, one gesture, one undo.
    model.accept(model.current as NonNullable<typeof model.current>)
    expect(store.curation.history.map((entry) => entry.step.op).sort()).toEqual(['link', 'unlink'])
    store.undo()
    expect(store.applied).toBe(0)
    await model.settled()
    const turnedDown = model.queue()[0]
    model.setCurrent(turnedDown.key)
    model.reject(turnedDown)
    await model.settled()
    expect(model.queue().some((q) => q.key === turnedDown.key)).toBe(false)
    expect(model.current?.key).not.toBe(turnedDown.key)
    // The first turned down, the queue as the answer left it: the question now first is next, whatever it ranked before.
    expect(model.current?.key).toBe(model.queue()[0].key)
  })

  it('moves on by place once an answer is counted, so a question the answer brings is asked where it ranks', async () => {
    // Once a suggestion is turned down, the count brings a merge of Y and Z: merges rank first.
    const amend = (answer: CurationStateResult, declined: readonly string[]): CurationStateResult => {
      if (declined.length === 0) return answer
      const y = answer.genomes.findIndex((genome) => genome.id === 'Y')
      const z = answer.genomes.findIndex((genome) => genome.id === 'Z')
      const brought: Suggestion = { key: 'merge:Y+Z', kind: 'merge', step: { op: 'merge', into: 'Y', genomes: ['Z'] }, words: 'merge Z into Y', confidence: 0.9, genomes: [y, z], contigs: [], evidence: [] } as unknown as Suggestion
      return { ...answer, suggestions: [...answer.suggestions, brought] }
    }
    const { model } = setup({ amend })
    await model.settled()
    model.setMode('review')
    const first = model.queue()[0]
    const second = model.queue()[1]
    model.reject(first)
    await model.settled()
    // Not the old second, by its key: the question now at the first's place, the merge the answer brought.
    expect(model.queue()[0].key).toBe('merge:Y+Z')
    expect(model.current?.key).toBe('merge:Y+Z')
    expect(model.current?.key).not.toBe(second.key)
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
    expect(model.rename('X1', 'chr1:5')).toMatch(/colon/)
    expect(model.rename('X1', 'u0')).toMatch(/A contig is named u0/)
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
    // One kind at a time: a contig added lets the genomes go, and a genome added the contigs.
    model.selectContigs([3], 'add')
    expect(model.selection).toEqual({ genomes: [], contigs: [3] })
    model.selectContigs([5], 'toggle')
    expect(model.selection).toEqual({ genomes: [], contigs: [3, 5] })
    model.selectGenomes(['Z'], 'toggle')
    expect(model.selection).toEqual({ genomes: ['Z'], contigs: [] })
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

describe('the preview, drawn or priced', () => {
  it('prices a step without drawing it until asked, and counts the file’s binning once a step is made', async () => {
    const { model, store } = setup()
    await model.settled()
    expect(model.fileAnswer).toBe(model.answer)
    model.preview({ op: 'merge', into: 'X1', genomes: ['X2'] }, false)
    await Promise.resolve()
    await Promise.resolve()
    expect(model.previewed).not.toBeNull()
    expect(model.shown).toBe(model.answer)
    model.drawPreview(true)
    expect(model.shown).toBe(model.previewed)
    expect(model.previewing).toBe(true)
    store.apply({ op: 'merge', into: 'X1', genomes: ['X2'] })
    await model.settled()
    expect(model.fileAnswer?.genomes.length).toBe(5)
    expect(model.answer?.genomes.length).toBe(4)
  })
})

describe('auto, holding back', () => {
  it('holds back a step that would lower a MAG’s grade, and names why', async () => {
    const { base, evidence } = community()
    const store = new CurationStore(`curate-model-${++keys}`, base, fileBinning(base), () => 0)
    const quality = (wc: number, wr: number) => ({ set: 'S', present: 1, markers: 4, hits: 1, completeness: wc, redundancy: wr, weightedCompleteness: wc, weightedRedundancy: wr, duplicated: [] })
    const client: CurateClient = {
      state(curation) {
        const answer = stateAnswer(evidence, CuratedBinning.of(base, curation))
        const merged = (curation?.cursor ?? 0) > 0 || (curation?.history.length ?? 0) > 0
        // As it stands: X1 a high-quality MAG and one sure merge into it; merged, contaminated.
        answer.genomes = answer.genomes.map((genome) => (genome.id === 'X1' ? { ...genome, quality: merged ? quality(0.95, 1.4) : quality(0.95, 1.0) } : genome))
        if (!merged) {
          const sure = answer.suggestions.find((s) => s.kind === 'merge')
          answer.suggestions = sure === undefined ? [] : [{ ...sure, confidence: 0.95 }]
        } else answer.suggestions = []
        return { promise: Promise.resolve(answer), cancel: () => {} }
      },
    }
    const model = new CurateModel(store, client, { schedule: (run) => (run(), () => {}) })
    await model.settled()
    const steps = await model.runAuto()
    expect(steps).toBe(0)
    expect(store.applied).toBe(0)
    expect(model.heldBack).toEqual([{ key: expect.stringMatching(/^merge:/), words: 'merge X2 into X1', why: 'it would make X1 contaminated' }])
  })
})

describe('what the review answers while a step is counted (§33.3)', () => {
  it('answers nothing until the step is counted: a second Y never takes the question twice', async () => {
    const { model, store, asked } = setup({ hold: true })
    asked[0].resolve()
    await model.settled()
    model.setMode('review')
    const head = model.current
    if (head === null) throw new Error('nothing in review')
    model.accept(head)
    expect(model.stale).toBe(true)
    // The queue is the binning's before the step: what it shows is not asked.
    expect(model.current).toBeNull()
    const before = store.curation.history.length
    if (model.current !== null) model.accept(model.current)
    expect(store.curation.history.length).toBe(before)
    for (const ask of asked) ask.resolve()
    await model.settled()
    expect(model.current).not.toBeNull()
    expect(model.queue().some((q) => q.key === head.key)).toBe(false)
  })

  it('leaves the rest of a question after one member is turned down, and moves on after one taken whole', async () => {
    const { model } = setup()
    await model.settled()
    model.setMode('review')
    model.setCurrent('host:P')
    expect(model.moveMember(1)).toBe(true)
    const first = model.current
    if (first === null) throw new Error('no member')
    const other = model.currentQuestion?.members.find((m) => m.key !== first.key)
    model.reject(first)
    await model.settled()
    // The member left is in review, not the queue's head.
    expect(model.current?.members.map((m) => m.key)).toEqual([other?.key])
    // A question taken whole: the one after it along.
    const queue = model.queue()
    model.setCurrent(queue[0].key)
    const next = queue[1]?.key
    model.accept(queue[0])
    await model.settled()
    if (next !== undefined && model.queue().some((q) => q.key === next)) expect(model.currentQuestion?.key).toBe(next)
  })

  it('steps out of a member when its question leaves the queue', async () => {
    const { model, store } = setup()
    await model.settled()
    model.setMode('review')
    model.setCurrent('host:P')
    model.moveMember(1)
    model.moveMember(1)
    expect(model.member).toEqual({ at: 1, of: 2 })
    // P linked to Y and unlinked from Z by hand: the question is answered.
    store.applyAll([{ step: { op: 'link', element: 'P', mag: 'Y' } }, { step: { op: 'unlink', element: 'P', mag: 'Z' } }])
    await model.settled()
    expect(model.queue().some((q) => q.key === 'host:P')).toBe(false)
    expect(model.member).toBeNull()
  })

  it('previews a question’s every step together, and lets go of the price on leaving review', async () => {
    const { model } = setup()
    await model.settled()
    model.setMode('review')
    model.setCurrent('host:P')
    const question = model.current
    if (question === null) throw new Error('no question')
    model.preview(question.steps, false)
    expect(model.previewSteps).toEqual(question.steps)
    expect(model.previewStep).toBeNull()
    await Promise.resolve()
    await Promise.resolve()
    // Both steps drawn: P hosted by Y, and by Z no longer.
    expect(model.previewed?.links.map((link) => `${link.element}>${link.mag}`)).toEqual(['P>Y'])
    model.setMode('manual')
    expect(model.previewSteps).toBeNull()
  })
})

describe('auto, against the reader’s own steps', () => {
  it('stops on an undo, and never takes a question priced on a binning changed since', async () => {
    const { model, store, asked } = setup({ hold: true })
    asked[0].resolve()
    await model.settled()
    const run = model.runAuto()
    // Auto is pricing its first question; the reader undoes nothing and makes a step meanwhile.
    await Promise.resolve()
    await Promise.resolve()
    store.apply({ op: 'rename', genome: 'Z', name: 'Zeta' })
    model.undo()
    for (const ask of asked) ask.resolve()
    await Promise.resolve()
    expect(await run).toBe(0)
    expect(store.curation.history.every((entry) => entry.by === 'reader')).toBe(true)
  })
})

describe('the acts refuse what would make nothing', () => {
  it('merges one kind at a time, unbins only what is binned, and never renames to an emptied genome’s name', async () => {
    const { model, store } = setup()
    await model.settled()
    model.selectGenomes(['P', 'Y'])
    expect(model.mergeSelected()).toBe(false)
    expect(store.applied).toBe(0)
    // u0, contig 18, is in the pool already.
    model.selectContigs([18])
    expect(model.moveSelected(null)).toBe(false)
    expect(store.applied).toBe(0)
    // Only the contigs not in Y already move.
    model.selectContigs([3, 7])
    expect(model.moveSelected('Y')).toBe(true)
    expect(store.curation.history[0].step).toEqual({ op: 'move', contigs: ['y5'], to: 'Y' })
    // X2 emptied by moves, not merged: its name stays taken.
    store.apply({ op: 'move', contigs: ['x3', 'x4', 'x5'], to: 'X1' })
    await model.settled()
    expect(model.answer?.genomes.some((genome) => genome.id === 'X2')).toBe(false)
    expect(model.rename('Y', 'X2')).toBe('Another genome is named X2.')
  })

  it('mints a genome id once: a turned-down suggestion of an undone genome never holds for a new one', async () => {
    const { model, store } = setup()
    await model.settled()
    model.selectContigs([18])
    expect(model.createFromSelected('mag')).toBe('curated:1')
    await model.settled()
    // u0 is X's: the new genome is offered to merge with X's halves; turned down.
    const merge = model.offered().find((s) => s.key.includes('curated:1'))
    if (merge === undefined) throw new Error('no suggestion names the new genome')
    model.reject(merge)
    model.undo()
    store.apply({ op: 'rename', genome: 'Z', name: 'Zeta' })
    expect(store.curation.history.some((entry) => entry.step.op === 'create')).toBe(false)
    model.selectContigs([18])
    expect(model.createFromSelected('mag')).toBe('curated:2')
  })
})

describe('what auto and the cards may answer (§33.3, §33.6)', () => {
  it('auto teaches nothing: its takes are not the reader’s answers', async () => {
    const { model, store } = setup()
    await model.settled()
    expect(await model.runAuto()).toBeGreaterThan(0)
    expect(store.learned).toEqual({ weights: {}, answers: 0, rejected: [] })
    expect(store.curation.history.every((entry) => entry.by === 'auto')).toBe(true)
  })

  it('answers nothing from a card while a step is counted: a double press takes once', async () => {
    const { model, store, asked } = setup({ hold: true })
    asked[0].resolve()
    await model.settled()
    const first = model.offered().find((s) => s.kind === 'merge')
    if (first === undefined) throw new Error('no merge offered')
    expect(model.accept(first)).toBe(true)
    expect(model.accept(first)).toBe(false)
    expect(model.reject(first)).toBe(false)
    expect(store.curation.history.length).toBe(1)
    expect(store.learned.answers).toBe(1)
  })

  it('answers nothing after a count that failed: review offers no question from the binning before the step', async () => {
    const { base, evidence } = community()
    const store = new CurationStore(`curate-model-${++keys}`, base, fileBinning(base), () => 0)
    let fail = false
    const client: CurateClient = {
      state(curation, weights) {
        if (fail) return { promise: Promise.reject(new Error('the worker stopped')), cancel: () => {} }
        return { promise: Promise.resolve(stateAnswer(evidence, CuratedBinning.of(base, curation), weights)), cancel: () => {} }
      },
    }
    const model = new CurateModel(store, client, { schedule: (run) => (run(), () => {}) })
    await model.settled()
    model.setMode('review')
    const head = model.current
    if (head === null) throw new Error('nothing in review')
    fail = true
    model.accept(head)
    await model.settled()
    expect(model.error).toBe('the worker stopped')
    expect(model.current).toBeNull()
    expect(model.accept(head)).toBe(false)
    expect(store.curation.history.length).toBe(1)
  })

  it('stays on a question when one of its members is taken from its card', async () => {
    const { model } = setup()
    await model.settled()
    model.setMode('review')
    model.setCurrent('host:P')
    const question = model.currentQuestion
    if (question === null || question.members.length < 2) throw new Error('no host question of two')
    const [one, other] = question.members
    model.accept(one)
    await model.settled()
    expect(model.current?.members.map((m) => m.key)).toEqual([other.key])
  })

  it('never mints an id twice while the stage is open, a create undone and dropped included', async () => {
    const { model, store } = setup()
    await model.settled()
    model.selectContigs([18])
    expect(model.createFromSelected('mag')).toBe('curated:1')
    await model.settled()
    model.undo()
    store.apply({ op: 'rename', genome: 'Z', name: 'Zeta' })
    expect(store.curation.history.some((entry) => entry.step.op === 'create')).toBe(false)
    model.selectContigs([18])
    expect(model.createFromSelected('mag')).toBe('curated:2')
  })
})

describe('an element is never graded (§33.5)', () => {
  it('prices a MAG by its markers and an element by none, once the contacts are read as before', async () => {
    const { model } = setup()
    await model.settled()
    const answer = model.answer
    expect(answer?.counted).toBe(true)
    expect(answer?.genomes.find((genome) => genome.id === 'P')?.quality).toBeNull()
    expect(answer?.genomes.find((genome) => genome.id === 'Z')?.quality).not.toBeNull()
  })
})

describe('a suggestion turned down', () => {
  it('goes to the worker with every count, so a move turned down explains no contact (§33.5)', async () => {
    const { model, asked } = setup()
    await model.settled()
    const move = model.offered().find((s) => s.kind === 'move')
    expect(move?.words).toBe('move y5 from X1 to Y')
    // Its move on offer, y5 explains its contacts with Y: X1 and Y are not offered as one organism.
    expect(model.offered().some((s) => s.key === 'merge:X1+Y')).toBe(false)
    if (move !== undefined) model.reject(move)
    await model.settled()
    expect(asked[asked.length - 1].declined).toContain(move?.key)
    // Turned down, y5 is X1's, and its contacts with Y count for X1 and Y.
    expect(model.offered().some((s) => s.key === 'merge:X1+Y')).toBe(true)
    // Offered again, it explains them again.
    if (move !== undefined) model.restore(move.key)
    await model.settled()
    expect(asked[asked.length - 1].declined).not.toContain(move?.key)
    expect(model.offered().some((s) => s.key === 'merge:X1+Y')).toBe(false)
  })
})
