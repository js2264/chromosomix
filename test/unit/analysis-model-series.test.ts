/**
 * A reconstruction **appends**; everything else an analysis calls replaces
 * (§25.3, §25.6).
 *
 * `AnalysisWorkspace.adoptIntervals` gives a called interval set the id of its
 * task and its output and removes the row that had it, which is right for
 * boundaries or domains: running insulation again with a wider window means
 * the reader wants the *new* boundaries, and a card that grows a row per run
 * is a card nobody can read after four of them.
 *
 * A model is not that. Two models of one map — two methods, two exponents, or
 * the same settings twice — are the comparison §25.3 is built for, and the
 * model is not stored anywhere else: a second run that destroyed the first
 * left a reader with nothing to compare and no way back. `freshId` is what
 * makes the series, and it is held here rather than through the workspace
 * because the series is the whole of the rule.
 */

import { describe, expect, it } from 'vitest'

import { AnnotationStore } from '@/annotations/store'
import { freshId } from '@/analysis/workspace'
import { defaultStyle, emptyPlacement } from '@/annotations/types'

const BASE = 'analysis:reconstruct3d:reconstructed-model'

function storeWith(...ids: string[]): AnnotationStore {
  const store = new AnnotationStore(`series-${Math.random()}.cool`)
  store.clear()
  for (const id of ids) {
    store.begin({
      card: 'structure',
      kind: 'structure',
      id,
      label: id,
      source: { kind: 'derived', name: id },
      placement: emptyPlacement(),
      style: defaultStyle('structure', '#1f5fa9'),
    })
  }
  return store
}

describe('the id a computed model takes', () => {
  it('is the bare id while nothing holds it', () => {
    expect(freshId(storeWith(), BASE)).toBe(BASE)
  })

  it('is the next in the series once a model is there, so a second run keeps the first', () => {
    expect(freshId(storeWith(BASE), BASE)).toBe(`${BASE}#2`)
    expect(freshId(storeWith(BASE, `${BASE}#2`), BASE)).toBe(`${BASE}#3`)
  })

  it('fills a gap, so closing the second of three gives that number back', () => {
    // Numbered from what is *there*, which is the answer somebody counting
    // rows on the Structures card would give.
    expect(freshId(storeWith(BASE, `${BASE}#3`), BASE)).toBe(`${BASE}#2`)
  })

  it('does not collide with another task, or with the same task on another map', () => {
    const other = 'analysis:insulation:insulation-boundaries'
    const perMap = 'analysis:p2:reconstruct3d:reconstructed-model'
    const store = storeWith(BASE, other, perMap)
    expect(freshId(store, BASE)).toBe(`${BASE}#2`)
    expect(freshId(store, perMap)).toBe(`${perMap}#2`)
  })
})
