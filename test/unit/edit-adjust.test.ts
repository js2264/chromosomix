/**
 * A suggestion's ends dragged before it is answered (SPECS §27.6): the stretch
 * it turns begun or ended elsewhere, one dragged past the other, a split's
 * point moved, and a move in its own sequence kept going to the same place.
 */

import { describe, expect, it } from 'vitest'

import { adjustableEnds, adjustSuggestion } from '@/edit/adjust'
import { LensGrid } from '@/edit/grid'
import type { Suggestion } from '@/edit/suggest'
import { EditedAssembly, emptyEdit, type EditStep } from '@/genome/edit'

/** One sequence of 100 kb at 1 kb a cell, as the file has it. */
const grid = LensGrid.of(EditedAssembly.of(emptyEdit({ names: ['s1'], lengths: [100_000] })), {
  binsize: 1000,
  sequences: [{ name: 's1', length: 100_000, firstCell: 0, cells: 100 }],
})

function suggestion(kind: Suggestion['kind'], step: EditStep, stretch: [number, number] | null, breaks: number[], target: number | null = null): Suggestion {
  return {
    key: `${kind}:x`,
    kind,
    step,
    words: 'as found',
    gain: 2,
    confidence: 0.9,
    features: [1, 2],
    breaks,
    corners: [{ row: breaks[0] ?? 0, col: breaks[1] ?? 0, rowSide: 'end', colSide: 'end', score: 1 } as never],
    extent: [breaks[0] ?? 0, breaks[breaks.length - 1] ?? 0],
    stretch,
    target,
    evidence: ['map'],
  }
}

describe('a turn’s ends', () => {
  const turn = suggestion('turn', { op: 'invert', sequence: 's1', from: 30_000, to: 60_000 }, [30, 60], [30, 60])

  it('are the stretch it turns, and follow the hand', () => {
    expect(adjustableEnds(turn)).toEqual([30, 60])
    const moved = adjustSuggestion(grid, turn, 1, 70)
    expect(moved?.step).toEqual({ op: 'invert', sequence: 's1', from: 30_000, to: 70_000 })
    expect(moved?.stretch).toEqual([30, 70])
    expect(moved?.words).toBe('turn s1:30,001-70,000')
    // The method's answer is kept, and whose ends they are is said.
    expect(moved?.key).toBe(turn.key)
    expect(moved?.confidence).toBe(0.9)
    expect(moved?.corners).toEqual([])
    expect(moved?.evidence).toEqual(['map', 'adjusted'])
  })

  it('makes the other end the one held when one is dragged past it', () => {
    const moved = adjustSuggestion(grid, turn, 0, 80)
    expect(moved?.stretch).toEqual([60, 80])
    expect(moved?.step).toEqual({ op: 'invert', sequence: 's1', from: 60_000, to: 80_000 })
  })

  it('names nothing when the two ends meet', () => {
    expect(adjustSuggestion(grid, turn, 1, 30)).toBeNull()
  })
})

describe('a split’s point', () => {
  const split = suggestion('split', { op: 'split', sequence: 's1', at: 50_000 }, null, [50])

  it('moves along its sequence, and not onto either end of it', () => {
    expect(adjustableEnds(split)).toEqual([50])
    expect(adjustSuggestion(grid, split, 0, 42)?.step).toEqual({ op: 'split', sequence: 's1', at: 42_000 })
    expect(adjustSuggestion(grid, split, 0, 0)).toBeNull()
    expect(adjustSuggestion(grid, split, 0, 100)).toBeNull()
  })
})

describe('a move in its own sequence', () => {
  // s1:10-20 kb put after s1:80 kb — `at` measured with the stretch taken out.
  const move = suggestion('move', { op: 'move', sequence: 's1', from: 10_000, to: 20_000, into: 's1', at: 70_000, strand: 1 }, [10, 20], [10, 20], 80)

  it('goes to the same place when its stretch grows', () => {
    const moved = adjustSuggestion(grid, move, 1, 30)
    expect(moved?.step).toEqual({ op: 'move', sequence: 's1', from: 10_000, to: 30_000, into: 's1', at: 60_000, strand: 1 })
    expect(moved?.extent).toEqual([10, 80])
  })

  it('is refused where its stretch would hold the place it goes', () => {
    expect(adjustSuggestion(grid, move, 1, 90)).toBeNull()
  })
})

describe('what cannot be adjusted', () => {
  it('is a join, whose ends are its sequences’', () => {
    const join = suggestion('join', { op: 'join', a: 's1', aEnd: 'end', b: 's2', bEnd: 'start', gap: 100 }, null, [])
    expect(adjustableEnds(join)).toEqual([])
    expect(adjustSuggestion(grid, join, 0, 10)).toBeNull()
  })
})
