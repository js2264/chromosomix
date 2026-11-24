// @dev-feature curate
/**
 * The curation of one file's binning, as the session keeps it (SPECS §33.2):
 * steps, undo and redo, back to the file's binning and forward again, what the
 * review taught — and a record made on another binning kept untouched rather
 * than applied.
 */

import { describe, expect, it } from 'vitest'

import { fileBinning, type BaseBinning } from '@/genome/curation'
import { CURATION_LEARNED_SCOPE, CURATION_SCOPE, CurationStore, keptCuration, readCurationLearned } from '@/state/curation'
import { recall, remember } from '@/state/UiMemory'

const BASE: BaseBinning = {
  names: ['c0', 'c1', 'c2', 'c3'],
  lengths: [4000, 3000, 2000, 1000],
  genomeOf: Int32Array.from([0, 0, 1, -1]),
  genomes: [
    { name: 'A', kind: 'mag' },
    { name: 'B', kind: 'mag' },
  ],
  links: [],
}

describe('the store', () => {
  it('makes a step, undoes and redoes it, and keeps each on the way', () => {
    const key = 'curate|a.metacool'
    const store = new CurationStore(key, BASE, fileBinning(BASE), () => 7)
    let heard = 0
    store.subscribe(() => heard++)
    store.apply({ op: 'move', contigs: ['c3'], to: 'B' })
    expect(store.applied).toBe(1)
    expect(store.binning.genomes[1].contigs).toEqual([2, 3])
    expect(keptCuration(key)?.cursor).toBe(1)
    store.undo()
    expect(store.binning.isIdentity).toBe(true)
    store.redo()
    expect(heard).toBe(3)
    const again = new CurationStore(key, BASE, fileBinning(BASE))
    expect(again.applied).toBe(1)
    expect(again.curation.history[0].when).toBe(7)
  })

  it('reverts as one more undo, keeps nothing for an empty history, and applies several steps as one change', () => {
    const key = 'curate|b.metacool'
    const store = new CurationStore(key, BASE, fileBinning(BASE))
    let heard = 0
    store.subscribe(() => heard++)
    store.applyAll([{ step: { op: 'merge', into: 'A', genomes: ['B'] } }, { step: { op: 'rename', genome: 'A', name: 'K_pn' }, by: 'auto', suggestion: 'x' }])
    expect(heard).toBe(1)
    expect(store.curation.history.map((entry) => entry.by)).toEqual(['reader', 'auto'])
    store.revert()
    expect(store.applied).toBe(0)
    expect(keptCuration(key)).toBeNull()
    expect(recall(key, CURATION_SCOPE)).not.toBeNull()
    const fresh = 'curate|c.metacool'
    const empty = new CurationStore(fresh, BASE, fileBinning(BASE))
    empty.apply({ op: 'move', contigs: ['c3'], to: 'A' })
    empty.undo()
    empty.goTo(0)
    expect(recall(fresh, CURATION_SCOPE)).not.toBeNull()
    expect(empty.tentative({ op: 'move', contigs: ['c3'], to: 'A' }).genomes[0].contigs).toEqual([0, 1, 3])
    expect(empty.applied).toBe(0)
  })

  it('undoes and redoes a gesture’s steps together, and keeps it as one through a reload', () => {
    const key = 'curate|gesture.metacool'
    const store = new CurationStore(key, BASE, fileBinning(BASE), () => 9)
    store.apply({ op: 'rename', genome: 'A', name: 'Alpha' })
    store.applyAll([{ step: { op: 'dissolve', genome: 'A' } }, { step: { op: 'dissolve', genome: 'B' } }])
    expect(store.applied).toBe(3)
    store.undo()
    expect(store.applied).toBe(1)
    store.redo()
    expect(store.applied).toBe(3)
    const again = new CurationStore(key, BASE, fileBinning(BASE))
    again.undo()
    expect(again.applied).toBe(1)
    again.undo()
    expect(again.applied).toBe(0)
  })

  it('keeps a curation made on another binning, says so, applies none of it, and leaves it until a new step', () => {
    const key = 'curate|d.metacool'
    const other = new CurationStore(key, { ...BASE, genomeOf: Int32Array.from([0, 1, 1, -1]) }, fileBinning({ ...BASE, genomeOf: Int32Array.from([0, 1, 1, -1]) }))
    other.apply({ op: 'dissolve', genome: 'A' })
    const kept = recall(key, CURATION_SCOPE)
    const store = new CurationStore(key, BASE, fileBinning(BASE))
    expect(store.refusal).toBe('The curation kept for this file was made on another binning: A held 1 contigs when the curation was made and holds 2 here.')
    expect(store.applied).toBe(0)
    expect(recall(key, CURATION_SCOPE)).toEqual(kept)
    // A step of the reader's writes over the record refused: the refusal goes with it.
    store.apply({ op: 'rename', genome: 'A', name: 'Alpha' })
    expect(store.refusal).toBeNull()
    expect(recall(key, CURATION_SCOPE)).not.toEqual(kept)
  })

  it('keeps what the review taught, checked on the way back, and nothing where nothing was', () => {
    const key = 'curate|e.metacool'
    const store = new CurationStore(key, BASE, fileBinning(BASE))
    expect(store.learned).toEqual({ weights: {}, answers: 0, rejected: [] })
    store.keepLearned({ weights: { merge: [0.1, 2, 0.5, -6, -3] }, answers: 1, rejected: ['merge:A+B'] })
    expect(store.learned.rejected).toEqual(['merge:A+B'])
    store.keepLearned({ weights: {}, answers: 0, rejected: [] })
    expect(recall(key, CURATION_LEARNED_SCOPE)).toBeNull()
    remember(key, CURATION_LEARNED_SCOPE, { weights: { merge: ['x'], link: [1, 2] }, answers: -3, rejected: [1, 'k'] })
    expect(readCurationLearned(recall(key, CURATION_LEARNED_SCOPE))).toEqual({ weights: { link: [1, 2] }, answers: 0, rejected: ['k'] })
  })
})
