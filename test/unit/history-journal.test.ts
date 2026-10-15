/**
 * The record of what this window's history holds (§5.5), which the list
 * beside **back** reads: the browser keeps its stack to itself, so every entry
 * the app writes is numbered in it and carries its number in `history.state`,
 * and a Back or a jump the browser performs says where the record stands.
 */

import { describe, expect, it } from 'vitest'

import { HistoryJournal, MAX_STEPS } from '@/state/historyJournal'
import { historyItems, stepDetail, stepPlace } from '@/ui/historyMenu'
import { parseViewState } from '@/state/ViewState'

/** A `sessionStorage` that holds what it is told. */
function memory(): Pick<Storage, 'getItem' | 'setItem'> & { data: Map<string, string> } {
  const data = new Map<string, string>()
  return {
    data,
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => void data.set(key, value),
  }
}

const hashes = (journal: HistoryJournal): string[] => journal.back().map((b) => b.step.hash)

describe('the record of a window’s history', () => {
  it('lists every step behind the one on screen, the nearest first, with how far back each is', () => {
    const journal = new HistoryJournal(memory(), { hash: '#a', state: null })
    journal.push('#b')
    journal.push('#c')
    expect(journal.back()).toEqual([
      { step: { hash: '#b' }, delta: -1 },
      { step: { hash: '#a' }, delta: -2 },
    ])
  })

  it('follows a Back and a jump the browser made, by the mark on the entry', () => {
    const journal = new HistoryJournal(memory(), { hash: '#a', state: null })
    const a = journal.currentState()
    const b = journal.push('#b')
    journal.push('#c')
    expect(journal.arrived(b, '#b')).toBeNull()
    expect(hashes(journal)).toEqual(['#a'])
    expect(journal.arrived(a, '#a')).toBeNull()
    expect(journal.back()).toEqual([])
  })

  it('lets go of what was ahead when a new step is taken from behind, as the browser does', () => {
    const journal = new HistoryJournal(memory(), { hash: '#a', state: null })
    const b = journal.push('#b')
    journal.push('#c')
    journal.arrived(b, '#b')
    journal.push('#d')
    expect(hashes(journal)).toEqual(['#b', '#a'])
  })

  it('rewrites the step on screen in place when the entry is replaced', () => {
    const journal = new HistoryJournal(memory(), { hash: '#a', state: null })
    journal.push('#b')
    journal.replace('#b2')
    journal.push('#c')
    expect(hashes(journal)).toEqual(['#b2', '#a'])
  })

  it('takes an entry it has no mark for — the address bar edited — as a step after this one', () => {
    const journal = new HistoryJournal(memory(), { hash: '#a', state: null })
    journal.push('#b')
    const fresh = journal.arrived(null, '#typed')
    expect(fresh).not.toBeNull()
    expect(hashes(journal)).toEqual(['#b', '#a'])
  })

  it('is picked up again after a reload, at the entry the browser is on', () => {
    const storage = memory()
    const journal = new HistoryJournal(storage, { hash: '#a', state: null })
    const b = journal.push('#b')
    journal.push('#c')
    // The reload lands on the second entry, which still carries its mark.
    const again = new HistoryJournal(storage, { hash: '#b', state: b })
    expect(hashes(again)).toEqual(['#a'])
  })

  it('starts again where the entry is not one it wrote', () => {
    const storage = memory()
    const journal = new HistoryJournal(storage, { hash: '#a', state: null })
    journal.push('#b')
    const again = new HistoryJournal(storage, { hash: '#elsewhere', state: { chromosomixStep: { journal: 'other', step: 1 } } })
    expect(again.back()).toEqual([])
  })

  it('keeps the newest steps, and finds an entry by its number when the oldest have gone', () => {
    const journal = new HistoryJournal(memory(), { hash: '#0', state: null })
    let kept: Record<string, unknown> = {}
    for (let i = 1; i <= MAX_STEPS + 10; i++) {
      const state = journal.push(`#${i}`)
      if (i === MAX_STEPS) kept = state
    }
    expect(journal.back()).toHaveLength(MAX_STEPS - 1)
    expect(journal.arrived(kept, `#${MAX_STEPS}`)).toBeNull()
    expect(journal.back()[0].step.hash).toBe(`#${MAX_STEPS - 1}`)
  })

  it('works with no storage at all, for the page it is on', () => {
    const journal = new HistoryJournal(null, { hash: '#a', state: null })
    journal.push('#b')
    expect(hashes(journal)).toEqual(['#a'])
  })
})

describe('what the list says about a step', () => {
  const COOL = 'https://example.org/Yeast.mcool::/resolutions/1000'
  const at = (rest: string) => parseViewState(`#uri=${COOL}&${rest}`)!

  it('names the place as a reader reads it, 1-based', () => {
    expect(stepPlace(at('view=region&region=IV:1000000-1400000'))).toBe('IV:1,000,001-1,400,000')
    expect(stepPlace(at('view=region&region=IV:1000000-1200000&region2=V:0-200000'))).toBe(
      'IV:1,000,001-1,200,000 × V:1-200,000',
    )
    expect(stepPlace(at('view=region&region=IV'))).toBe('IV')
    expect(stepPlace(at('view=whole'))).toBe('Whole genome')
    expect(stepPlace(at('view=contigs'))).toBe('Chromosomes')
  })

  it('says beside it the file, the resolution and what the step set', () => {
    expect(stepDetail(at('view=region&region=IV&oe=1'))).toBe('Yeast.mcool · 1 kb · O/E')
    expect(stepDetail(at('view=region&region=IV&coarsen=3000'))).toBe('Yeast.mcool · 3 kb*')
  })

  it('leaves the file out where it is the one on screen, and keeps what the step set', () => {
    expect(stepDetail(at('view=region&region=IV&oe=1'), COOL)).toBe('1 kb · O/E')
    expect(stepDetail(at('view=region&region=IV'), 'https://example.org/Other.cool')).toBe('Yeast.mcool · 1 kb')
  })

  it('makes one row per step, each going straight back to it', () => {
    const went: number[] = []
    const items = historyItems(
      [
        { step: { hash: `#uri=${COOL}&view=region&region=IV` }, delta: -1 },
        { step: { hash: `#uri=${COOL}&view=whole` }, delta: -2 },
      ],
      (delta) => went.push(delta),
    )
    expect(items.map((item) => item.label)).toEqual(['IV', 'Whole genome'])
    items[1].run?.()
    expect(went).toEqual([-2])
  })
})
