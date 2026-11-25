// @dev-feature edit
/**
 * The edit of one file's reference, as the session keeps it (SPECS §27.2):
 * steps, undo and redo, back to the file and forward again — and a record made
 * on another assembly kept untouched rather than applied.
 */

import { describe, expect, it } from 'vitest'

import { EDIT_SCOPE, EditStore, hasStoredEdit } from '@/state/referenceEdit'
import { recall, remember } from '@/state/UiMemory'

const ORIGINAL = { names: ['I', 'II'], lengths: [1000, 600] }

describe('the store', () => {
  it('makes a step, undoes and redoes it, and keeps each on the way', () => {
    const key = 'store|a.cool'
    const store = new EditStore(key, ORIGINAL, () => 7)
    let heard = 0
    store.subscribe(() => heard++)
    store.apply({ op: 'invert', sequence: 'I', from: 100, to: 300 })
    expect(store.applied).toBe(1)
    expect(store.assembly.sequences[0].name).toBe('I_e1')
    expect(hasStoredEdit(key)).toBe(true)
    store.undo()
    expect(store.assembly.isIdentity).toBe(true)
    expect(store.canRedo).toBe(true)
    store.redo()
    expect(store.assembly.isIdentity).toBe(false)
    expect(heard).toBe(3)
    // A fresh store over the same key reads back where it stood.
    const again = new EditStore(key, ORIGINAL)
    expect(again.applied).toBe(1)
    expect(again.edit.history[0].when).toBe(7)
  })

  it('amends its last step, so a gesture that goes on stays one step, and drops it where it ends where it began', () => {
    const store = new EditStore('store|amend.cool', ORIGINAL)
    store.apply({ op: 'move', sequence: 'I', from: 0, to: 100, into: 'I', at: 100, strand: 1 })
    store.amend({ op: 'move', sequence: 'I', from: 0, to: 100, into: 'I', at: 200, strand: 1 })
    expect(store.edit.history.map((entry) => entry.step)).toEqual([{ op: 'move', sequence: 'I', from: 0, to: 100, into: 'I', at: 200, strand: 1 }])
    expect(store.applied).toBe(1)
    // Back where it began: no step at all.
    store.amend(null)
    expect(store.edit.history).toEqual([])
    expect(store.assembly.isIdentity).toBe(true)
    // With a step undone past the cursor, an amendment is a step made, and the undone one goes.
    store.apply({ op: 'split', sequence: 'II', at: 300 })
    store.undo()
    store.amend({ op: 'invert', sequence: 'I', from: 0, to: 100 })
    expect(store.edit.history.map((entry) => entry.step.op)).toEqual(['invert'])
    // Nothing made: `null` changes nothing, and a step is made.
    const fresh = new EditStore('store|fresh.cool', ORIGINAL)
    fresh.amend(null)
    expect(fresh.applied).toBe(0)
    fresh.amend({ op: 'cut', sequence: 'I', at: 10 })
    expect(fresh.applied).toBe(1)
  })

  it('reverts to the file as one more undo, and a new step drops what was undone', () => {
    const store = new EditStore('store|b.cool', ORIGINAL)
    store.apply({ op: 'cut', sequence: 'I', at: 10 })
    store.apply({ op: 'split', sequence: 'I', at: 500 })
    store.revert()
    expect(store.applied).toBe(0)
    expect(store.edit.history).toHaveLength(2)
    store.goTo(1)
    expect(store.applied).toBe(1)
    store.apply({ op: 'invert', sequence: 'II', from: 0, to: 600 })
    expect(store.edit.history.map((entry) => entry.step.op)).toEqual(['cut', 'invert'])
  })

  it('keeps an edit made on another assembly, says so, and applies none of it', () => {
    const key = 'store|c.cool'
    const foreign = {
      version: 1,
      original: { names: ['I', 'II'], lengths: [1000, 601] },
      history: [{ step: { op: 'cut', sequence: 'I', at: 5 }, by: 'reader', when: 0 }],
      cursor: 1,
    }
    remember(key, EDIT_SCOPE, foreign)
    const store = new EditStore(key, ORIGINAL)
    expect(store.refusal).toMatch(/II is 601 bp in the edit and 600 bp here/)
    expect(store.assembly.isIdentity).toBe(true)
    expect(recall(key, EDIT_SCOPE)).toEqual(foreign)
  })
})
