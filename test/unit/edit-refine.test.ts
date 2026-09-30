/**
 * A suggestion's points placed finer than the picture's cell (SPECS §27.5):
 * the rungs a point steps through, the cut a square of one rung least
 * supports — clean, noisy, and with the balancer's empty rows beside it — a
 * point placed across two rungs from a map whose truth is known to the base,
 * which points a suggestion offers, and the suggestion as the placed points
 * make it: its step, its words, its marks and what it rests on.
 */

import { describe, expect, it } from 'vitest'

import { LensGrid } from '@/edit/grid'
import {
  REFINE_REFUSED,
  binWords,
  leastSupported,
  pointKey,
  pointsOf,
  refineChain,
  refinePoint,
  refinedSuggestion,
  type RefinedPoint,
  type RefinePoint,
  type RefineSquare,
} from '@/edit/refine'
import type { SequenceEvidence } from '@/edit/sequenceEvidence'
import type { Suggestion } from '@/edit/suggest'
import { EditedAssembly, emptyEdit, withStep, type EditStep, type ReferenceEdit } from '@/genome/edit'

/** A seeded uniform generator (mulberry32), so a noisy square is the same square every run. */
function seeded(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Contacts at a distance in bins: a power law, and what two strangers share. */
const law = (d: number): number => 100 / Math.max(1, d)
const TRANS = 0.3

/** A square of `n` bins whose genome breaks at bin edge `at`: across it, strangers. */
function squareWithBreak(n: number, at: number | null, noise?: () => number): RefineSquare {
  const values = new Float64Array(n * n)
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      const apart = at !== null && i < at !== j < at
      const mean = apart ? TRANS : law(Math.abs(i - j))
      values[i * n + j] = noise === undefined ? mean : mean * (0.5 + noise())
    }
  }
  return { n, values }
}

describe('the rungs a point steps through', () => {
  it('goes from the picture’s cell to the finest rung no more than sixteen times finer, in one read where it can', () => {
    expect(refineChain([1000, 2000, 4000, 8000, 16000], 16000, 0)).toEqual([1000])
    expect(refineChain([1000, 2000, 5000, 10000], 1000, 0)).toEqual([])
  })

  it('steps through a coarser rung where the finest is too far, and never below what the map is deep enough for', () => {
    expect(refineChain([1000, 5000, 10000, 25000, 50000, 100000], 200000, 5000)).toEqual([25000, 5000])
    // A rung between is missing: the one there is, in one wider read.
    expect(refineChain([1000], 200000, 0)).toEqual([1000])
    expect(refineChain([1000, 2000], 16000, 4000)).toEqual([])
  })
})

describe('the cut a rung least supports', () => {
  it('is the break, to the bin, in a clean square', () => {
    const found = leastSupported(squareWithBreak(120, 57), 45, 70)
    expect(found?.cut).toBe(57)
    expect(found?.support).toBeLessThan(0.05)
  })

  it('is the break within a bin in a noisy one', () => {
    const found = leastSupported(squareWithBreak(120, 63, seeded(7)), 45, 75)
    expect(Math.abs((found?.cut ?? 0) - 63)).toBeLessThanOrEqual(1)
    expect(found?.support).toBeLessThan(REFINE_REFUSED)
  })

  it('is still found with the balancer’s empty rows beside it', () => {
    const square = squareWithBreak(120, 60)
    const values = square.values as Float64Array
    for (const row of [58, 59]) {
      for (let k = 0; k < 120; k++) {
        values[row * 120 + k] = Number.NaN
        values[k * 120 + row] = Number.NaN
      }
    }
    const found = leastSupported(square, 48, 72)
    expect(found?.cut).toBeGreaterThanOrEqual(58)
    expect(found?.cut).toBeLessThanOrEqual(60)
    expect(found?.support).toBeLessThan(REFINE_REFUSED)
  })

  it('finds every junction of a sequence the genome keeps supported, so none is refused', () => {
    const found = leastSupported(squareWithBreak(120, null), 45, 70)
    expect(found?.support).toBeGreaterThan(0.9)
  })

  it('says nothing where the square holds too little', () => {
    const empty: RefineSquare = { n: 60, values: new Float64Array(3600).fill(Number.NaN) }
    expect(leastSupported(empty, 20, 40)).toBeNull()
  })
})

describe('a point placed at the finer rungs', () => {
  /** A genome whose sequence `s` breaks at 403,000 bp, read at any rung as the mean of its kilobase bins. */
  const TRUTH = 403_000
  const read = async (_sequence: string, lo: number, hi: number, size: number): Promise<RefineSquare> => {
    const n = hi - lo
    const k = size / 1000
    const values = new Float64Array(n * n)
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) {
        let sum = 0
        for (let a = 0; a < k; a++) {
          for (let b = 0; b < k; b++) {
            const x = (lo + i) * k + a
            const y = (lo + j) * k + b
            const apart = x < TRUTH / 1000 !== y < TRUTH / 1000
            sum += apart ? TRANS : law(Math.abs(x - y))
          }
        }
        values[i * n + j] = sum
      }
    }
    return { n, values }
  }

  it('lands on the break from the picture’s nearest edge, in one read and in two', async () => {
    const point: RefinePoint = { sequence: 's', bp: 400_000 }
    expect(await refinePoint(point, 1_000_000, 16_000, [1000], read)).toMatchObject({ bp: TRUTH, binsize: 1000 })
    expect(await refinePoint(point, 1_000_000, 16_000, [4000, 1000], read)).toMatchObject({ bp: TRUTH, binsize: 1000 })
  })

  it('stays where the rung above put it when the map supports every cut in reach', async () => {
    const whole = async (_sequence: string, lo: number, hi: number): Promise<RefineSquare> => squareWithBreak(hi - lo, null)
    expect(await refinePoint({ sequence: 's', bp: 400_000 }, 1_000_000, 16_000, [1000], whole)).toBeNull()
  })
})

/** A suggestion of a step, with what the refinement reads of it; the rest as the method would leave it. */
function suggestionOf(step: EditStep, units: Partial<Suggestion> = {}): Suggestion {
  return {
    key: 'k',
    kind: step.op === 'split' ? 'split' : step.op === 'invert' ? 'turn' : step.op === 'move' ? 'move' : 'join',
    step,
    words: '',
    gain: 1,
    confidence: 0.9,
    features: [],
    breaks: [],
    corners: [],
    extent: [0, 0],
    stretch: null,
    target: null,
    evidence: ['map'],
    ...units,
  }
}

describe('the points a suggestion offers the finer rungs', () => {
  const original = { names: ['I', 'II'], lengths: [100_000, 50_000] }
  let edit: ReferenceEdit = emptyEdit(original)
  edit = withStep(edit, { op: 'invert', sequence: 'I', from: 20_000, to: 60_000 }, 'reader', 0)
  const assembly = EditedAssembly.of(edit)
  const evidence: SequenceEvidence = {
    from: 'genome.fa',
    gapsRead: true,
    facts: new Map([['I', { length: 100_000, start: null, end: null, gaps: [[70_000, 70_100]] }]]),
  }

  it('are the points inside a sequence, and not a junction the edit already makes', () => {
    const turn = suggestionOf({ op: 'invert', sequence: 'I_e1', from: 30_000, to: 45_000 })
    expect(pointsOf(turn, assembly, 1000)).toEqual([
      { sequence: 'I_e1', bp: 30_000 },
      { sequence: 'I_e1', bp: 45_000 },
    ])
    expect(pointsOf(suggestionOf({ op: 'split', sequence: 'I_e1', at: 20_000 }), assembly, 1000)).toEqual([])
    expect(pointsOf(suggestionOf({ op: 'join', a: 'I_e1', aEnd: 'end', b: 'II', bEnd: 'start', gap: 0 }), assembly, 1000)).toEqual([])
  })

  it('leaves a point beside a gap of N where the sequence places it', () => {
    expect(pointsOf(suggestionOf({ op: 'split', sequence: 'I_e1', at: 70_500 }), assembly, 1000, evidence)).toEqual([])
    expect(pointsOf(suggestionOf({ op: 'split', sequence: 'I_e1', at: 75_000 }), assembly, 1000, evidence)).toEqual([{ sequence: 'I_e1', bp: 75_000 }])
  })

  it('names where a move puts its stretch on the sequence as it stands', () => {
    const move = suggestionOf({ op: 'move', sequence: 'II', from: 10_000, to: 20_000, into: 'II', at: 30_000, strand: 1 })
    expect(pointsOf(move, assembly, 1000)).toEqual([
      { sequence: 'II', bp: 10_000 },
      { sequence: 'II', bp: 20_000 },
      { sequence: 'II', bp: 40_000 },
    ])
  })
})

describe('a suggestion as its placed points make it', () => {
  const original = { names: ['I'], lengths: [100_000] }
  const grid = LensGrid.of(EditedAssembly.of(emptyEdit(original)), {
    binsize: 1000,
    sequences: [{ name: 'I', length: 100_000, firstCell: 0, cells: 100 }],
  })
  const placements = (entries: Array<[RefinePoint, RefinedPoint]>) => {
    const byKey = new Map(entries.map(([point, placed]) => [pointKey(point), placed]))
    return (point: RefinePoint): RefinedPoint | undefined => byKey.get(pointKey(point))
  }

  it('takes the placed step, its words, its marks, and says to what bin', () => {
    const turn = suggestionOf(
      { op: 'invert', sequence: 'I', from: 30_000, to: 45_000 },
      { breaks: [30, 45], extent: [30, 45], stretch: [30, 45], corners: [{ row: 30, col: 45, rowSide: -1, colSide: 1, score: 3 }] },
    )
    const placed = refinedSuggestion(
      grid,
      turn,
      placements([
        [{ sequence: 'I', bp: 30_000 }, { bp: 31_000, binsize: 250, support: 0.1 }],
        [{ sequence: 'I', bp: 45_000 }, { bp: 44_250, binsize: 250, support: 0.2 }],
      ]),
    )
    expect(placed.step).toEqual({ op: 'invert', sequence: 'I', from: 31_000, to: 44_250 })
    expect(placed.words).toBe('turn I:31,001-44,250')
    expect(placed.stretch).toEqual([31, 44])
    expect(placed.breaks).toEqual([31, 44])
    expect(placed.corners[0]).toMatchObject({ row: 31, col: 44 })
    expect(placed.evidence).toEqual(['map', 'refined at 250 bp'])
    // The method weighed it at the picture's cells: that stays.
    expect(placed.confidence).toBe(turn.confidence)
    expect(placed.key).toBe(turn.key)
  })

  it('measures a move’s place with the stretch taken out again', () => {
    const move = suggestionOf({ op: 'move', sequence: 'I', from: 10_000, to: 20_000, into: 'I', at: 50_000, strand: -1 }, { stretch: [10, 20], target: 60 })
    const placed = refinedSuggestion(
      grid,
      move,
      placements([
        [{ sequence: 'I', bp: 10_000 }, { bp: 10_500, binsize: 500, support: 0.1 }],
        [{ sequence: 'I', bp: 20_000 }, { bp: 19_500, binsize: 500, support: 0.1 }],
        [{ sequence: 'I', bp: 60_000 }, { bp: 61_000, binsize: 1000, support: 0.3 }],
      ]),
    )
    expect(placed.step).toEqual({ op: 'move', sequence: 'I', from: 10_500, to: 19_500, into: 'I', at: 52_000, strand: -1 })
    expect(placed.evidence.at(-1)).toBe('refined at 1 kb')
  })

  it('keeps the suggestion as the method made it where the points would name no step, or none moved', () => {
    const turn = suggestionOf({ op: 'invert', sequence: 'I', from: 30_000, to: 31_000 }, { stretch: [30, 31] })
    const crossed = refinedSuggestion(
      grid,
      turn,
      placements([
        [{ sequence: 'I', bp: 30_000 }, { bp: 31_500, binsize: 500, support: 0.1 }],
        [{ sequence: 'I', bp: 31_000 }, { bp: 30_500, binsize: 500, support: 0.1 }],
      ]),
    )
    expect(crossed).toBe(turn)
    expect(refinedSuggestion(grid, turn, () => undefined)).toBe(turn)
  })

  it('says a point the finer rung put where the picture did was placed too', () => {
    const split = suggestionOf({ op: 'split', sequence: 'I', at: 40_000 }, { breaks: [40], extent: [40, 40] })
    const placed = refinedSuggestion(grid, split, placements([[{ sequence: 'I', bp: 40_000 }, { bp: 40_000, binsize: 1000, support: 0.2 }]]))
    expect(placed.step).toEqual(split.step)
    expect(placed.evidence).toEqual(['map', 'refined at 1 kb'])
  })

  it('says a bin in words', () => {
    expect([binWords(1000), binWords(2500), binWords(500), binWords(1_000_000)]).toEqual(['1 kb', '2.5 kb', '500 bp', '1 Mb'])
  })
})
