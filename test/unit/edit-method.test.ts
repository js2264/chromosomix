/**
 * The method that proposes edits (SPECS §27.5, §27.11), held to a truth known
 * by construction: maps simulated from a genome whose contact law and trans
 * level are chosen here, drawn with Poisson noise, read through the picture's
 * own pass — and then misassembled on purpose. Every misassembly has one right
 * answer, the inverse of how it was made, and the method must find it first; a
 * correct assembly must draw no suggestion a curator would take.
 */

import { describe, expect, it } from 'vitest'

import { findCorners } from '../../src/edit/corners'
import { LensGrid } from '../../src/edit/grid'
import { EditedMap, expectedOf, junctionScore } from '../../src/edit/method'
import { confidenceOf, INITIAL_WEIGHTS, learn, suggest, type Suggested } from '../../src/edit/suggest'
import { EditedAssembly, emptyEdit, withStep } from '../../src/genome/edit'
import { simulate, type TruePiece } from '../support/simulatedMap'

async function suggestionsFor(sequences: TruePiece[][]): Promise<Suggested & { grid: LensGrid }> {
  const { contacts, grid } = await simulate(sequences)
  const expected = expectedOf(contacts, true)
  const corners = findCorners(contacts, expected)
  return { ...suggest({ contacts, expected, corners, grid }), grid }
}

describe('what the map is expected to hold', () => {
  it('is the law it was drawn from, and the trans level', async () => {
    const { contacts } = await simulate([[[0, 0, 300, 1]], [[1, 0, 200, 1]]])
    const expected = expectedOf(contacts, true)
    for (const d of [1, 4, 16, 40]) {
      const truth = 400 * Math.pow(d + 1, -1.1)
      // A trimmed mean runs a little under the mean it trims.
      expect(expected.law[d] / truth, `P(${d})`).toBeGreaterThan(0.85)
      expect(expected.law[d] / truth, `P(${d})`).toBeLessThan(1.05)
    }
    expect(expected.trans).toBeGreaterThan(0.2)
    expect(expected.trans).toBeLessThan(0.35)
    // The law stands eight times the trans level out past two windows: the whole window.
    expect(expected.window).toBe(16)
    for (let d = 1; d < expected.law.length; d++) expect(expected.law[d]).toBeLessThanOrEqual(expected.law[d - 1])
  })
})

describe('the junction score', () => {
  it('says two truly adjacent ends meet, and two strangers do not', async () => {
    // One sequence: the whole first chromosome, then the whole second — a misjoin at 300.
    const { contacts, grid } = await simulate([[[0, 0, 300, 1], [1, 0, 200, 1]]])
    const expected = expectedOf(contacts, true)
    const map = new EditedMap(contacts, expected, grid.cellMap)
    const adjacent = junctionScore(map, { cell: 149, dir: -1, lo: 0, hi: 150 }, { cell: 150, dir: 1, lo: 150, hi: 300 })
    const strangers = junctionScore(map, { cell: 299, dir: -1, lo: 0, hi: 300 }, { cell: 300, dir: 1, lo: 300, hi: 500 })
    expect(adjacent.score).toBeGreaterThan(0)
    expect(strangers.score).toBeLessThan(0)
    expect(strangers.score / expected.unit).toBeLessThan(-0.4)
    // Against the window's own level, an adjacency is about one unit.
    const local = junctionScore(map, { cell: 149, dir: -1, lo: 0, hi: 150 }, { cell: 150, dir: 1, lo: 150, hi: 300 }, 'local')
    expect(local.score / expected.unit).toBeGreaterThan(0.6)
    expect(local.score / expected.unit).toBeLessThan(1.4)
  })
})

describe('the suggestions', () => {
  it('offer nothing a curator would take on a correct assembly', async () => {
    const found = await suggestionsFor([[[0, 0, 300, 1]], [[1, 0, 200, 1]]])
    expect(found.breakpoints).toEqual([])
    expect(found.list.filter((s) => s.confidence >= 0.5)).toEqual([])
  })

  it('turn a turned stretch back, first', async () => {
    const found = await suggestionsFor([[[0, 0, 100, 1], [0, 100, 160, -1], [0, 160, 300, 1]], [[1, 0, 200, 1]]])
    expect(found.breakpoints).toEqual([100, 160])
    const [first] = found.list
    expect(first.kind).toBe('turn')
    expect(first.step).toEqual({ op: 'invert', sequence: 's1', from: 100_000, to: 160_000 })
    expect(first.confidence).toBeGreaterThan(0.8)
    // Its two corners are the bow-tie's arms, both at (100, 160).
    expect(first.corners.map((c) => [c.row, c.col, c.rowSide, c.colSide])).toEqual([
      [100, 160, -1, -1],
      [100, 160, 1, 1],
    ])
    expect(first.breaks).toEqual([100, 160])
  })

  it('split a sequence made of two chromosomes where they were joined', async () => {
    const found = await suggestionsFor([[[0, 0, 300, 1], [1, 0, 200, 1]]])
    const [first] = found.list
    expect(first.kind).toBe('split')
    expect(first.step).toEqual({ op: 'split', sequence: 's1', at: 300_000 })
    expect(first.confidence).toBeGreaterThan(0.5)
  })

  it('move a stretch back where it came from', async () => {
    // The first chromosome's [80, 120) sits inside the second.
    const found = await suggestionsFor([
      [[0, 0, 80, 1], [0, 120, 300, 1]],
      [[1, 0, 100, 1], [0, 80, 120, 1], [1, 100, 200, 1]],
    ])
    const [first] = found.list
    expect(first.kind).toBe('move')
    expect(first.step).toEqual({ op: 'move', sequence: 's2', from: 100_000, to: 140_000, into: 's1', at: 80_000, strand: 1 })
    expect(first.confidence).toBeGreaterThan(0.8)
    expect(first.target).toBe(80)
  })

  it('join a chromosome the assembly left in two', async () => {
    const found = await suggestionsFor([[[0, 0, 150, 1]], [[0, 150, 300, 1]], [[1, 0, 200, 1]]])
    const [first] = found.list
    expect(first.kind).toBe('join')
    expect(first.step).toMatchObject({ op: 'join', a: 's1', aEnd: 'end', b: 's2', bEnd: 'start' })
    expect(first.confidence).toBeGreaterThan(0.5)
  })

  it('move a stretch the reader dropped by a masked end back where it came from', async () => {
    // The second sequence's last twenty cells are masked, as a subtelomere is:
    // the junction a move makes there cannot be measured, and is the hand's.
    const masked = Array.from({ length: 20 }, (_, k) => 480 + k)
    const { contacts, names, lengths, offsets } = await simulate([[[0, 0, 300, 1]], [[1, 0, 200, 1]]], 7, masked)
    let edit = emptyEdit({ names, lengths })
    edit = withStep(edit, { op: 'move', sequence: 's1', from: 100_000, to: 160_000, into: 's2', at: 200_000, strand: 1 }, 'reader', 0)
    const grid = LensGrid.of(EditedAssembly.of(edit), {
      binsize: 1000,
      sequences: names.map((name, i) => ({ name, length: lengths[i], firstCell: offsets[i], cells: offsets[i + 1] - offsets[i] })),
    })
    const expected = expectedOf(contacts, true)
    const [first] = suggest({ contacts, expected, corners: findCorners(contacts, expected), grid }).list
    expect(first.kind).toBe('move')
    expect(first.step).toEqual({ op: 'move', sequence: 's2_e1', from: 200_000, to: 260_000, into: 's1_e1', at: 100_000, strand: 1 })
  })

  it('are keyed by the file’s own cells, so one stays turned down after the edit moves it', async () => {
    const found = await suggestionsFor([[[0, 0, 100, 1], [0, 100, 160, -1], [0, 160, 300, 1]], [[1, 0, 200, 1]]])
    expect(found.list[0].key).toMatch(/^turn:/)
    const again = await suggestionsFor([[[0, 0, 100, 1], [0, 100, 160, -1], [0, 160, 300, 1]], [[1, 0, 200, 1]]])
    expect(again.list[0].key).toBe(found.list[0].key)
  })
})

describe('the confidence, and what it learns', () => {
  it('rises with the gain and falls with a corner brighter than any adjacency', () => {
    expect(confidenceOf([Math.log2(2), 0, 0, 0])).toBeGreaterThan(confidenceOf([Math.log2(1.2), 0, 0, 0]))
    expect(confidenceOf([Math.log2(8), 0, 0, -2])).toBeLessThan(0.5)
  })

  it('moves towards each answer, and three answers do not overturn the map', () => {
    const features = [2, 0, 0, 0]
    const before = confidenceOf(features)
    let weights = [...INITIAL_WEIGHTS]
    for (let k = 0; k < 3; k++) weights = learn(weights, features, false)
    const after = confidenceOf(features, weights)
    expect(after).toBeLessThan(before)
    expect(after).toBeGreaterThan(0.5)
    for (let k = 0; k < 30; k++) weights = learn(weights, features, false)
    expect(confidenceOf(features, weights)).toBeLessThan(0.5)
  })
})
