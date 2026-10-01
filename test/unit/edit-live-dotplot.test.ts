/**
 * The reference editor's corner dot plot, as arithmetic (SPECS §27.3, §28):
 * which of the session's sequence sets is the file's own, a dot plot's streaks
 * as streaks of the file's sequences, and those streaks through an edit — moved
 * with their pieces, turned with them, cut where the edit cut them, and gone
 * where they were set aside.
 */

import { describe, expect, it } from 'vitest'

import type { DotplotStreaks } from '@/analysis/types'
import type { AnnotationEntry } from '@/annotations/types'
import {
  cornerSide,
  foundFrom,
  grippedSide,
  linesOver,
  pickSets,
  sequenceSets,
  spanAlong,
  stretchOfLine,
  throughEdit,
  type FoundStreaks,
} from '@/edit/dotplotLines'
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

  it('makes the same choice over the session’s rows, for every reader of a sequence on the stage', () => {
    const row = (id: string, matched: number | undefined, extra: Record<string, unknown> = {}): AnnotationEntry =>
      ({
        id,
        kind: 'sequence',
        status: 'ready',
        label: `${id}.fa`,
        ...(matched === undefined ? {} : { overlap: { matched, total: 32, missing: [], extra: [] } }),
        ...extra,
      }) as unknown as AnnotationEntry
    const theory = row('theory', 0)
    const own = row('own', 32)
    // A sequence still loading, and a track naming every sequence, are not sets.
    const picked = sequenceSets([theory, row('loading', 32, { status: 'loading' }), row('track', 32, { kind: 'track' }), own])
    expect(picked.own?.id).toBe('own')
    expect(picked.others.map((set) => set.id)).toEqual(['theory'])
    // A set naming none of the map's sequences is nobody's own, and leaves
    // nothing to set against it.
    expect(sequenceSets([theory])).toEqual({ own: null, others: [] })
    expect(sequenceSets([row('unreported', undefined)])).toEqual({ own: null, others: [] })
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

describe('the link between the map and the corner plot', () => {
  // II first, then I split at 2 kb: II, I_e1, I_e2 along x.
  const lines = throughEdit(FOUND, assemblyAfter({ op: 'reorder', names: ['II', 'I'] }, { op: 'split', sequence: 'I', at: 2000 }))

  it('marks a stretch of the edit at its span along x, kept to its sequence, and nowhere for a sequence the axis lacks', () => {
    expect(lines.x.names).toEqual(['II', 'I_e1', 'I_e2'])
    expect(spanAlong(lines.x, { sequence: 'I_e1', from: 0, to: 2000 })).toEqual([3000, 5000])
    expect(spanAlong(lines.x, { sequence: 'I_e2', from: 500, to: 99_999 })).toEqual([5500, 8000])
    expect(spanAlong(lines.x, { sequence: 'IV', from: 0, to: 10 })).toBeNull()
    expect(spanAlong(lines.x, { sequence: 'II', from: 10, to: 10 })).toBeNull()
  })

  it('lights the lines with any of their extent in that span, and none outside it', () => {
    // I's streak, cut in two — 1-2 kb at the end of I_e1, 2-3 kb at the start of I_e2 — then II's.
    expect(linesOver(lines, [3000, 5000])).toEqual([0])
    expect(linesOver(lines, [4500, 5500])).toEqual([0, 1])
    expect(linesOver(lines, [0, 3000])).toEqual([2])
    expect(linesOver(lines, [6000, 8000])).toEqual([])
  })

  it('names the stretch of the edit a line lies along, and nothing for no line', () => {
    expect(stretchOfLine(lines, 0)).toEqual({ sequence: 'I_e1', from: 1000, to: 2000 })
    expect(stretchOfLine(lines, 1)).toEqual({ sequence: 'I_e2', from: 0, to: 1000 })
    expect(stretchOfLine(lines, 2)).toEqual({ sequence: 'II', from: 0, to: 3000 })
    expect(stretchOfLine(lines, -1)).toBeNull()
    expect(stretchOfLine(lines, 3)).toBeNull()
  })
})

describe('the corner plot’s size', () => {
  it('is a third of the map by itself, up to 220 pixels, and never under 120', () => {
    expect(cornerSide(600, null, 60)).toBe(192)
    expect(cornerSide(1200, null, 60)).toBe(220)
    expect(cornerSide(200, null, 60)).toBe(120)
  })

  it('is what the grip gave it, kept on the map with its picker and its caption', () => {
    expect(cornerSide(600, 400, 60)).toBe(400)
    expect(cornerSide(600, 900, 60)).toBe(524)
    expect(cornerSide(600, 40, 60)).toBe(120)
  })

  it('grows with the grip moved left and down, the corner following a hand along the diagonal', () => {
    expect(grippedSide(200, -30, 30)).toBe(230)
    expect(grippedSide(200, 30, -30)).toBe(170)
    expect(grippedSide(200, -40, 0)).toBe(220)
  })
})
