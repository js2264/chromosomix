/**
 * The map drawn as two lines (§7.6): which column can split the genomes, which
 * line each genome is on, what is drawn between the lines and where, and what
 * the pointer is over.
 *
 * Arithmetic over hand-built tables and blocks, so every number has a reason a
 * reader can check: a ribbon is the circle's chord between two sections on
 * different lines, and nothing else.
 */

import { describe, expect, it } from 'vitest'
import { levelOf, lineSplit, splitChoices } from '../../src/app/lineSplit'
import {
  hitLines,
  insideRibbonFlat,
  layoutRibbons,
  lineDrop,
  linesGeometry,
  linesModelOf,
  midX,
  type LinesModel,
} from '../../src/render/lines'
import type { AxisGroup, MatrixResult, TablePayload } from '../../src/worker/protocol'

/** A genomes table: the name, a two-valued `step`, a three-valued `kind`, and gaps. */
const TABLE: TablePayload = {
  length: 6,
  columns: ['name', 'length', 'step', 'kind', 'kept'],
  data: {
    name: ['__unbinned__', 'g1', 'g2', 'g3', 'g4', 'g5'],
    length: Float64Array.from([9, 100, 200, 300, 400, 500]),
    step: Float64Array.from([Number.NaN, 0, 1, 0, 1, Number.NaN]),
    kind: ['', 'a', 'b', 'c', 'a', 'b'],
    kept: ['', 'yes', 'no', 'NA', 'no', 'yes'],
  },
}
const DISPLAY = Int32Array.from([1, 2, 3, 4, 5])

describe('the column the genomes are split by', () => {
  it('reads a cell as a level, and the words a table writes for nothing as none', () => {
    expect(levelOf(1)).toBe('1')
    expect(levelOf(Number.NaN)).toBeNull()
    expect(levelOf(' yes ')).toBe('yes')
    for (const missing of ['', 'NA', 'n/a', 'NaN', 'None', 'null']) expect(levelOf(missing)).toBeNull()
  })

  it('offers every column but the name, those of two values with their values and the rest with why not', () => {
    const choices = splitChoices(TABLE, DISPLAY)
    expect(choices.map((choice) => choice.column)).toEqual(['length', 'step', 'kind', 'kept'])
    expect(choices.find((choice) => choice.column === 'step')).toEqual({
      column: 'step',
      levels: ['0', '1'],
      reason: null,
      missing: 1,
    })
    // Words sort as text; a genome with `NA` is left out of the count.
    expect(choices.find((choice) => choice.column === 'kept')?.levels).toEqual(['no', 'yes'])
    expect(choices.find((choice) => choice.column === 'kept')?.missing).toBe(1)
    expect(choices.find((choice) => choice.column === 'kind')?.reason).toBe('3 values')
    expect(choices.find((choice) => choice.column === 'length')?.reason).toBe('5 values')
  })

  it('puts each genome on its value’s line, the first value on top unless the reader chose the other', () => {
    const split = lineSplit(TABLE, DISPLAY, 'step')
    expect(split?.levels).toEqual(['0', '1'])
    expect(split?.counts).toEqual([2, 2])
    expect(split?.missing).toBe(1)
    expect(['g1', 'g2', 'g3', 'g4', 'g5', '__unbinned__'].map((name) => split?.lineOf(name))).toEqual([0, 1, 0, 1, -1, -1])
    const swapped = lineSplit(TABLE, DISPLAY, 'step', '1')
    expect(swapped?.levels).toEqual(['1', '0'])
    expect(swapped?.lineOf('g2')).toBe(0)
    // A value the column does not have puts the first on top.
    expect(lineSplit(TABLE, DISPLAY, 'step', '7')?.levels).toEqual(['0', '1'])
    // Three values, or no such column, is no split.
    expect(lineSplit(TABLE, DISPLAY, 'kind')).toBeNull()
    expect(lineSplit(TABLE, DISPLAY, 'nope')).toBeNull()
  })

  it('sorts text that reads as numbers by value', () => {
    const table: TablePayload = {
      length: 3,
      columns: ['name', 'batch'],
      data: { name: ['a', 'b', 'c'], batch: ['10', '2', '10'] },
    }
    expect(splitChoices(table, null)[0].levels).toEqual(['2', '10'])
  })
})

/** A genome × genome block: g1 … g4, a cell each, `values[r][c]` symmetric. */
function genomeBlock(rows: number[][]): MatrixResult {
  const n = rows.length
  const groups: AxisGroup[] = rows.map((_, i) => ({ label: `g${i + 1}`, start: i, end: i + 1 }))
  return {
    nrows: n,
    ncols: n,
    values: Float32Array.from(rows.flat()),
    rowExtent: [0, n],
    colExtent: [0, n],
    rowGroups: groups,
    colGroups: groups,
    level: 'genome',
  }
}

const BLOCK = genomeBlock([
  [50, 9, 4, 1],
  [9, 60, 7, 3],
  [4, 7, 70, 2],
  [1, 3, 2, 80],
])
// g1 and g3 on top, g2 and g4 below.
const SIDE: Record<string, -1 | 0 | 1> = { g1: 0, g2: 1, g3: 0, g4: 1 }
const resolver = { genomeLength: (genome: string) => ({ g1: 100, g2: 200, g3: 300, g4: 400 })[genome] }

function lines(side: Record<string, -1 | 0 | 1> = SIDE): LinesModel {
  const model = linesModelOf(BLOCK, (unit) => side[unit.name] ?? -1, resolver)
  if (model === null) throw new Error('no lines')
  return model
}

describe('the sections on two lines', () => {
  it('keeps only the chords that cross, each weighing what the circle’s does', () => {
    const { model, side, leftOut } = lines()
    expect(model.units.map((unit) => unit.name)).toEqual(['g1', 'g2', 'g3', 'g4'])
    expect(Array.from(side)).toEqual([0, 1, 0, 1])
    expect(leftOut).toBe(0)
    // g1–g2 9, g2–g3 7, g3–g4 2, g1–g4 1 cross; g1–g3 and g2–g4 do not.
    expect(model.chords.map((chord) => `${chord.a}-${chord.b}:${chord.weight}`)).toEqual(['0-1:9', '1-2:7', '2-3:2', '0-3:1'])
    expect(model.pairs).toBe(4)
    // A section's contacts with the others are with the other line only.
    expect(Array.from(model.inter)).toEqual([10, 16, 9, 3])
    expect(Array.from(model.intra)).toEqual([50, 60, 70, 80])
  })

  it('leaves out a genome with no line, and every contact it would have added', () => {
    const { model, leftOut } = lines({ g1: 0, g2: 1, g3: -1, g4: 1 })
    expect(model.units.map((unit) => unit.name)).toEqual(['g1', 'g2', 'g4'])
    expect(leftOut).toBe(1)
    expect(model.chords.map((chord) => chord.weight)).toEqual([9, 1])
  })

  it('is nothing where a line would be empty', () => {
    expect(linesModelOf(BLOCK, () => 0, resolver)).toBeNull()
  })
})

describe('the layout', () => {
  const options = {
    width: 600,
    height: 400,
    left: 100,
    lanes: [{ id: 'a', size: 30 }],
    measure: (text: string) => text.length * 6,
    fontPx: 10,
  }

  it('lays each line across the whole width, its sections as long as their share of it', () => {
    const drawn = lines()
    const geometry = linesGeometry(drawn, options)
    expect(geometry.x0).toBe(100)
    // g1 (100 bp) and g3 (300 bp) on top, a gap between them: 1 to 3.
    const top = (u: number): number => geometry.arcs[2 * u + 1] - geometry.arcs[2 * u]
    expect(top(2) / top(0)).toBeCloseTo(3, 5)
    expect(geometry.arcs[0]).toBe(geometry.x0)
    expect(geometry.arcs[2 * 2 + 1]).toBeCloseTo(geometry.x1, 5)
    expect(geometry.arcs[2 * 3 + 1]).toBeCloseTo(geometry.x1, 5)
    expect(Array.from(geometry.members[0])).toEqual([0, 2])
    expect(Array.from(geometry.members[1])).toEqual([1, 3])
  })

  it('stacks the lanes away from the ribbons, the first nearest its line', () => {
    const geometry = linesGeometry(lines(), options)
    const [top, bottom] = geometry.rows
    const lane = geometry.lanes[0].rows
    expect(lane[0].y1).toBeLessThanOrEqual(top.sections.y0)
    expect(lane[1].y0).toBeGreaterThanOrEqual(bottom.sections.y1)
    expect(lane[0].y1 - lane[0].y0).toBe(30)
    expect(geometry.ribbons).toEqual({ y0: top.sections.y1, y1: bottom.sections.y0 })
    // Four names, each section wide enough to name: room for them both sides.
    expect(geometry.names).toBe(true)
    expect(top.labelAt).toBeLessThan(lane[0].y0)
  })

  it('seats a ribbon’s ends on its two sections, and finds it under the pointer', () => {
    const drawn = lines()
    const geometry = linesGeometry(drawn, { ...options, lanes: [] })
    const ribbons = layoutRibbons(drawn.model, geometry, { limit: Number.POSITIVE_INFINITY, transform: 'none', colormap: 'default' })
    expect(ribbons.drawn).toBe(4)
    // The strongest, g1–g2, is drawn last.
    const slot = ribbons.drawn - 1
    expect(drawn.model.chords[ribbons.order[slot]].weight).toBe(9)
    const [aMid, , bMid] = [ribbons.ends[slot * 4], ribbons.ends[slot * 4 + 1], ribbons.ends[slot * 4 + 2]]
    expect(aMid).toBeGreaterThanOrEqual(geometry.arcs[0])
    expect(aMid).toBeLessThanOrEqual(geometry.arcs[1])
    expect(bMid).toBeGreaterThanOrEqual(geometry.arcs[2])
    expect(bMid).toBeLessThanOrEqual(geometry.arcs[3])
    // Halfway down, the ribbon is halfway across.
    const y = (geometry.ribbons.y0 + geometry.ribbons.y1) / 2
    expect(insideRibbonFlat(geometry, [aMid, ribbons.ends[slot * 4 + 1], bMid, ribbons.ends[slot * 4 + 3]], (aMid + bMid) / 2, y)).toBe(true)
    expect(hitLines(drawn, geometry, ribbons, (aMid + bMid) / 2, y)).toEqual({ kind: 'chord', slot })
    // On a section's bar, the section.
    const bar = geometry.rows[1].sections
    expect(hitLines(drawn, geometry, ribbons, midX(geometry, 3), (bar.y0 + bar.y1) / 2)).toEqual({ kind: 'section', unit: 3 })
  })
})

describe('a section carried along its line', () => {
  // Four sections along one line, 10 px each, 2 px apart.
  const arcs = Float64Array.from([0, 1, 2, 3].flatMap((k) => [12 * k, 12 * k + 10]))

  it('lands beside the edge nearest the hand, before the one after the gap', () => {
    expect(lineDrop(arcs, [0, 1, 2, 3], 0, 23)).toEqual({ index: 2, side: 'before', at: 23 })
    expect(lineDrop(arcs, [0, 1, 2, 3], 0, 100)).toEqual({ index: 3, side: 'after', at: 46 })
    expect(lineDrop(arcs, [0, 1, 2, 3], 3, -5)).toEqual({ index: 0, side: 'before', at: 0 })
  })

  it('goes nowhere beside itself, nor among sections it may not land among', () => {
    expect(lineDrop(arcs, [0, 1, 2, 3], 1, 11)).toBeNull()
    expect(lineDrop(arcs, [0, 1, 2, 3], 1, 23)).toBeNull()
    // A contig among its genome's, the hand far off: after the last it may use.
    expect(lineDrop(arcs, [1, 2], 1, 100)).toEqual({ index: 2, side: 'after', at: 34 })
    expect(lineDrop(arcs, [1], 1, 100)).toBeNull()
  })
})
