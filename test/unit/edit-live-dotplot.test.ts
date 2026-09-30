/**
 * The reference editor's corner dot plot, as arithmetic (SPECS §27.3, §28):
 * which of the session's sequence sets is the file's own, a dot plot's streaks
 * as streaks of the file's sequences, and those streaks through an edit — moved
 * with their pieces, turned with them, cut where the edit cut them, and gone
 * where they were set aside.
 */

import { describe, expect, it } from 'vitest'

import type { DotplotStreaks } from '@/analysis/types'
import { foundFrom, pickSets, throughEdit, type FoundStreaks } from '@/edit/dotplotLines'
import { EditedAssembly, emptyEdit, withStep, type EditStep } from '@/genome/edit'

const ORIGINAL = { names: ['I', 'II'], lengths: [5000, 3000] }
function assemblyAfter(...steps: EditStep[]): EditedAssembly {
  let edit = emptyEdit(ORIGINAL)
  steps.forEach((step, i) => {
    edit = withStep(edit, step, 'reader', i)
  })
  return EditedAssembly.of(edit)
}

/** Two streaks: I's 1-3 kb the same way round as the reference's first 2 kb, and II whole the other way round. */
const FOUND: FoundStreaks = {
  xLabel: 'assembly.fa',
  y: { label: 'theory.fa', names: ['chrA'], lengths: [10_000] },
  streaks: [
    { sequence: 'I', from: 1000, to: 3000, y0: 0, y1: 2000, strand: 1, anchors: 200 },
    { sequence: 'II', from: 0, to: 3000, y0: 5000, y1: 8000, strand: -1, anchors: 300 },
  ],
}

describe('the sets', () => {
  it('takes the file’s own for the one that names the most of the map’s sequences, and offers the others', () => {
    const sets = [
      { id: 'theory', matched: 0 },
      { id: 'own', matched: 32 },
      { id: 'other', matched: 1 },
    ]
    const picked = pickSets(sets)
    expect(picked.own?.id).toBe('own')
    expect(picked.others.map((set) => set.id)).toEqual(['theory', 'other'])
    expect(pickSets([{ id: 'theory', matched: 0 }]).own).toBeNull()
  })

  it('reads a dot plot’s streaks as streaks of the file’s own sequences', () => {
    const streaks: DotplotStreaks = {
      x: { label: 'assembly.fa', names: ['I', 'II'], lengths: [5000, 3000] },
      y: { label: 'theory.fa', names: ['chrA'], lengths: [10_000] },
      x0: Float64Array.from([1000, 5000]),
      x1: Float64Array.from([3000, 8000]),
      y0: Float64Array.from([0, 5000]),
      y1: Float64Array.from([2000, 8000]),
      strand: Int8Array.from([1, -1]),
      anchors: Int32Array.from([200, 300]),
    }
    expect(foundFrom(streaks)).toEqual(FOUND)
  })
})

describe('the streaks through an edit', () => {
  it('are where they were, the assembly as it is', () => {
    const lines = throughEdit(FOUND, assemblyAfter())
    expect(lines.x).toEqual({ names: ['I', 'II'], lengths: [5000, 3000] })
    expect([lines.x0, lines.x1, lines.y0, lines.y1, lines.strand]).toEqual([
      [1000, 5000],
      [3000, 8000],
      [0, 5000],
      [2000, 8000],
      [1, -1],
    ])
  })

  it('move with their sequence, and turn with a turned piece', () => {
    // II first, then I with 0-4 kb turned: I's streak now reads the other way round at 2-4 kb of I_e1.
    const lines = throughEdit(
      FOUND,
      assemblyAfter({ op: 'reorder', names: ['II', 'I'] }, { op: 'invert', sequence: 'I', from: 0, to: 4000 }),
    )
    expect(lines.x.names).toEqual(['II', 'I_e1'])
    expect([lines.x0[0], lines.x1[0], lines.strand[0]]).toEqual([3000 + 1000, 3000 + 3000, -1])
    expect([lines.x0[1], lines.x1[1], lines.strand[1]]).toEqual([0, 3000, -1])
  })

  it('are cut where the edit cut them, each part its share along y, and gone where set aside', () => {
    // I split at 2 kb and its second half's first 500 bp set aside.
    const lines = throughEdit(
      FOUND,
      assemblyAfter({ op: 'split', sequence: 'I', at: 2000 }, { op: 'aside', sequence: 'I_e2', from: 0, to: 500, why: 'debris' }),
    )
    expect(lines.x.names).toEqual(['I_e1', 'I_e2', 'II'])
    // I_e1: 1-2 kb of the streak, the first half along y.
    expect([lines.x0[0], lines.x1[0], lines.y0[0], lines.y1[0]]).toEqual([1000, 2000, 0, 1000])
    // I_e2, from 2.5 kb of I, now at its start: the last three quarters along y.
    expect([lines.x0[1], lines.x1[1], lines.y0[1], lines.y1[1]]).toEqual([2000, 2500, 1500, 2000])
    expect(lines.anchors).toEqual([200, 200, 300])
  })
})
