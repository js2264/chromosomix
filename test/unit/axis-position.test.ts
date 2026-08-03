/**
 * Base-pair positions in the hover readout (spec §3.3, §5.4).
 *
 * `AxisGroup.start` is block-local, so `(offset - start) * binsize` measures
 * from the left edge of the *picture*. That is a position in the contig only
 * when the block begins on a contig boundary — true for a genome view and for a
 * whole contig, false for `contig:start-end`, where the block begins at
 * `chrom_offset[c] + floor(start / binsize)`. The readout used to report the
 * first cell of `NODE_17248_len_278011:139005-199005` as 2 kb when it is 141 kb
 * into the contig.
 *
 * `unitStart` — the absolute bin the contig itself begins at — is what fixes
 * it, and these are the cases that pin the arithmetic.
 */

import { describe, expect, it } from 'vitest'

import { bpWithin, separationOf, separatorsFor } from '@/ui/MatrixPanel'
import type { Cell } from '@/render/heatmap'
import { idRuns } from '@/worker/groups'
import type { AxisGroup, MatrixResult } from '@/worker/protocol'

const BIN = 1000

describe('bpWithin', () => {
  it('measures from the contig, not from the block, in a sub-contig region', () => {
    // `contig:139005-199005` at 1 kb bins is bins 139..199; the contig starts at
    // bin 0 of the file, so the block starts 139 bins into it.
    const group: AxisGroup = { label: 'NODE_1', start: 0, end: 61, unitStart: 0 }
    expect(bpWithin(group, 0, 139, BIN)).toBe(139_000)
    expect(bpWithin(group, 2, 139, BIN)).toBe(141_000)
    expect(bpWithin(group, 30, 139, BIN)).toBe(169_000)
  })

  it('is unchanged for a whole contig, which starts where its block does', () => {
    const group: AxisGroup = { label: 'NODE_1', start: 0, end: 279, unitStart: 0 }
    expect(bpWithin(group, 0, 0, BIN)).toBe(0)
    expect(bpWithin(group, 25, 0, BIN)).toBe(25_000)
    expect(bpWithin(group, 252, 0, BIN)).toBe(252_000)
  })

  it('restarts at zero for each contig of a genome view', () => {
    // A genome whose block starts at bin 4,000: two contigs, at 4,000 and 4,300.
    const first: AxisGroup = { label: 'c1', start: 0, end: 300, unitStart: 4000 }
    const second: AxisGroup = { label: 'c2', start: 300, end: 500, unitStart: 4300 }
    expect(bpWithin(first, 10, 4000, BIN)).toBe(10_000)
    expect(bpWithin(second, 300, 4000, BIN)).toBe(0)
    expect(bpWithin(second, 305, 4000, BIN)).toBe(5_000)
  })

  it('falls back to the block-local reading when no unit start is known', () => {
    // An aggregated or overview axis carries no `unitStart`; the old behaviour
    // is the right one there, because such a block starts at its own group.
    const group: AxisGroup = { label: 'g', start: 0, end: 10 }
    expect(bpWithin(group, 3, 7, BIN)).toBe(3_000)
  })
})

describe('idRuns', () => {
  const ids = Int32Array.from([5, 5, 5, 6, 6, 7])

  it('collapses runs into block-local offsets', () => {
    const runs = idRuns(ids, (id) => `c${id}`)
    expect(runs).toEqual([
      { label: 'c5', start: 0, end: 3 },
      { label: 'c6', start: 3, end: 5 },
      { label: 'c7', start: 5, end: 6 },
    ])
  })

  it('carries the absolute start of each unit when one is supplied', () => {
    // Contig 5 begins at bin 100, contig 6 at 110, contig 7 at 130 — and the
    // block starts partway through contig 5, which is the case that used to be
    // reported wrongly.
    const starts = new Map([
      [5, 100],
      [6, 110],
      [7, 130],
    ])
    const runs = idRuns(ids, (id) => `c${id}`, (id) => starts.get(id) ?? 0)
    expect(runs.map((r) => r.unitStart)).toEqual([100, 110, 130])
  })

  it('returns nothing for an empty axis', () => {
    expect(idRuns(new Int32Array(0), String)).toEqual([])
  })
})

/**
 * What the dividers mark.
 *
 * Everywhere but the whole-metagenome view an axis is contigs, and its blocks
 * are what gets a line. That view is the exception: its axis is contigs but its
 * *subject* is genomes, and the reader says so by sending a coarser set of
 * groups alongside. Where it does, the fine set is not drawn at all — 20,000
 * hairlines over 4,000 genome blocks is a wash that hides the structure.
 */
describe('separatorsFor', () => {
  const groups: AxisGroup[] = [
    { label: 'c1', start: 0, end: 10 },
    { label: 'c2', start: 10, end: 25 },
    { label: 'c3', start: 25, end: 40 },
  ]
  const genomes: AxisGroup[] = [
    { label: 'g1', start: 0, end: 25 },
    { label: 'g2', start: 25, end: 40 },
  ]
  const result = (extra: Partial<MatrixResult> = {}): MatrixResult =>
    ({
      nrows: 40,
      ncols: 40,
      values: new Float32Array(0),
      rowExtent: [0, 40],
      colExtent: [0, 40],
      rowGroups: groups,
      colGroups: groups,
      level: 'contig',
      ...extra,
    }) as MatrixResult

  it('marks every block when the axis has only one set', () => {
    const set = separatorsFor(result())
    expect(set.rows.map((s) => s.at)).toEqual([0, 10, 25])
    expect(set.groupRows).toBeUndefined()
  })

  it('marks genomes, and only genomes, when the reader says to draw them', () => {
    const set = separatorsFor(
      result({ rowGenomes: genomes, colGenomes: genomes, genomeBoundaries: true }),
    )
    expect(set.rows.map((s) => s.at)).toEqual([0, 25])
    expect(set.rows.map((s) => s.label)).toEqual(['g1', 'g2'])
    expect(set.cols.map((s) => s.at)).toEqual([0, 25])
    // Also as the heavier set, drawn over the same coordinates.
    expect(set.groupRows?.map((s) => s.at)).toEqual([0, 25])
  })

  // The whole-genome view of a metacool sends genome runs for the *tooltip* and
  // does not ask for them to be drawn. Without this distinction, turning on the
  // genome line in the tooltip would silently coarsen the picture underneath it
  // from 20,566 contigs to 49 genomes.
  it('keeps the contig lines when the genomes are for naming only', () => {
    const set = separatorsFor(result({ rowGenomes: genomes, colGenomes: genomes }))
    expect(set.rows.map((s) => s.at)).toEqual([0, 10, 25])
    expect(set.cols.map((s) => s.at)).toEqual([0, 10, 25])
    expect(set.groupRows).toBeUndefined()
    expect(set.groupCols).toBeUndefined()
  })
})

/**
 * The genomic distance across a cell (§5.4).
 *
 * A Hi-C map is read by how contact falls off with separation, so the number a
 * pointer on an off-diagonal cell is usually asking for is how far apart its two
 * ends are — and until this existed the tooltip made you subtract its own two
 * coordinates to get it. What matters here is the three cases where there is no
 * answer, because each is a refusal and not a gap: above bin level a cell has no
 * ends to subtract, across two contigs the contact is trans and a distance along
 * the sequence does not exist at all, and on the diagonal it is zero.
 */
describe('separationOf', () => {
  const cell = (row: number, col: number, rowBin = row, colBin = col): Cell => ({
    row,
    col,
    rowBin,
    colBin,
    value: 1,
  })
  /** One whole contig on both axes: a chromosome view, or a cool of one. */
  const ONE: AxisGroup = { label: 'I', start: 0, end: 100, unitStart: 0 }

  it('is the base pairs between the two ends of an off-diagonal cell', () => {
    expect(separationOf(ONE, ONE, cell(10, 40), 'bin', BIN)).toBe(30_000)
    // Symmetric: the upper and lower triangle are the same contact.
    expect(separationOf(ONE, ONE, cell(40, 10), 'bin', BIN)).toBe(30_000)
  })

  it('says nothing on the diagonal, where the answer is zero', () => {
    expect(separationOf(ONE, ONE, cell(17, 17), 'bin', BIN)).toBeNull()
  })

  it('says nothing across two contigs, where there is no distance to give', () => {
    // Not a large separation — none. A trans contact has no position along one
    // sequence, and reporting `|rowBin - colBin| * binsize` here would invent a
    // number out of where the two contigs happen to sit in the file.
    const other: AxisGroup = { label: 'II', start: 0, end: 100, unitStart: 100 }
    expect(separationOf(ONE, other, cell(5, 5, 5, 105), 'bin', BIN)).toBeNull()
  })

  it('answers within one contig of a multi-contig axis, and not across them', () => {
    // A genome view: several contigs on one axis, and only the cis cells have a
    // separation.
    const c1: AxisGroup = { label: 'c1', start: 0, end: 30, unitStart: 0 }
    const c2: AxisGroup = { label: 'c2', start: 30, end: 100, unitStart: 30 }
    expect(separationOf(c1, c1, cell(2, 20), 'bin', BIN)).toBe(18_000)
    expect(separationOf(c2, c2, cell(40, 90), 'bin', BIN)).toBe(50_000)
    expect(separationOf(c1, c2, cell(2, 90), 'bin', BIN)).toBeNull()
  })

  it('holds across a rectangular block of one contig against itself', () => {
    // `contig × the same contig` over two different windows: the two axes have
    // different block origins and one contig, so the absolute bins are what the
    // arithmetic must use — `unitStart` is equal and cancels.
    const rows: AxisGroup = { label: 'I', start: 0, end: 50, unitStart: 0 }
    const cols: AxisGroup = { label: 'I', start: 0, end: 50, unitStart: 0 }
    expect(separationOf(rows, cols, cell(0, 0, 100, 400), 'bin', BIN)).toBe(300_000)
  })

  it('says nothing above bin level, where a cell is a whole sequence', () => {
    const c1: AxisGroup = { label: 'c1', start: 0, end: 1 }
    const c2: AxisGroup = { label: 'c2', start: 1, end: 2 }
    expect(separationOf(c1, c2, cell(0, 1), 'contig', BIN)).toBeNull()
  })

  it('says nothing without a bin size, which a variable-bin file has none of', () => {
    expect(separationOf(ONE, ONE, cell(10, 40), 'bin', 0)).toBeNull()
  })
})
