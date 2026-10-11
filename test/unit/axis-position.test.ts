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

import { bpWithin, separationOf, separatorsFor } from '@/ui/blockAxes'
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
  /** One axis of a cell: its run, where it sits, and where its block starts. */
  const side = (
    group: AxisGroup | undefined,
    offset: number,
    blockStart = 0,
    genome?: string,
  ): Parameters<typeof separationOf>[0] => ({
    group,
    offset,
    blockStart,
    ...(genome === undefined ? {} : { genome }),
  })
  /** One whole contig on both axes: a chromosome view, or a cool of one. */
  const ONE: AxisGroup = { label: 'I', start: 0, end: 100, unitStart: 0 }

  it('is the base pairs between the two ends of an off-diagonal cell', () => {
    expect(separationOf(side(ONE, 10), side(ONE, 40), 'bin', BIN)).toBe(30_000)
    // Symmetric: the upper and lower triangle are the same contact.
    expect(separationOf(side(ONE, 40), side(ONE, 10), 'bin', BIN)).toBe(30_000)
  })

  it('says nothing on the diagonal, where the answer is zero', () => {
    expect(separationOf(side(ONE, 17), side(ONE, 17), 'bin', BIN)).toBeNull()
  })

  it('says nothing across two contigs, where there is no distance to give', () => {
    // Not a large separation — none. A trans contact has no position along one
    // sequence, and reporting a difference of block offsets here would invent a
    // number out of where the two contigs happen to sit in the file.
    const other: AxisGroup = { label: 'II', start: 0, end: 100, unitStart: 100 }
    expect(separationOf(side(ONE, 5), side(other, 5), 'bin', BIN)).toBeNull()
  })

  it('answers within one contig of a multi-contig axis, and not across them', () => {
    // A genome view: several contigs on one axis, and only the cis cells have a
    // separation.
    const c1: AxisGroup = { label: 'c1', start: 0, end: 30, unitStart: 0 }
    const c2: AxisGroup = { label: 'c2', start: 30, end: 100, unitStart: 30 }
    expect(separationOf(side(c1, 2), side(c1, 20), 'bin', BIN)).toBe(18_000)
    expect(separationOf(side(c2, 40), side(c2, 90), 'bin', BIN)).toBe(50_000)
    expect(separationOf(side(c1, 2), side(c2, 90), 'bin', BIN)).toBeNull()
  })

  it('holds across a rectangular block of one contig against itself', () => {
    // `contig × the same contig` over two different windows: the two axes have
    // different block origins and one contig, so each end is measured from the
    // contig and the difference is what is left.
    const rows: AxisGroup = { label: 'I', start: 0, end: 50, unitStart: 0 }
    const cols: AxisGroup = { label: 'I', start: 0, end: 50, unitStart: 0 }
    expect(separationOf(side(rows, 0, 100), side(cols, 0, 400), 'bin', BIN)).toBe(300_000)
  })

  // The regression this arithmetic exists to prevent. Anything larger than the
  // picture is read on a coarser grid, and a coarsened run carries no
  // `unitStart` at all past its first — so the line went quiet on exactly the
  // views that are always pooled, which is most of them.
  it('answers on a coarsened axis, where the runs carry no absolute origin', () => {
    // Three cells of a pooled grid, the second run beginning at cell 40. The
    // caller passes the *effective* cell size, which is what `setResolution`
    // hands the panel after every read.
    const c1: AxisGroup = { label: 'c1', start: 0, end: 40, unitLength: 900 }
    const c2: AxisGroup = { label: 'c2', start: 40, end: 90, unitLength: 700 }
    expect(separationOf(side(c1, 2), side(c1, 20), 'bin', 3 * BIN)).toBe(54_000)
    expect(separationOf(side(c2, 45), side(c2, 60), 'bin', 3 * BIN)).toBe(45_000)
    expect(separationOf(side(c1, 2), side(c2, 60), 'bin', 3 * BIN)).toBeNull()
  })

  // A coarsened axis is anchored to the contig, so its arithmetic origin depends
  // on where that axis's own window opens: two windows of one sequence get two
  // different `unitStart`s. The identity does not move, which is why it is a
  // second number rather than a second use of the first.
  it('joins two windows of one sequence whose origins differ', () => {
    // Both windows are of contig II, which begins at absolute bin 512. Each
    // axis's own origin is where *its* window opens on the coarse grid, so the
    // two differ; the identity does not.
    const rows: AxisGroup = { label: 'II', start: 0, end: 50, unitStart: 700, unitBin: 512 }
    const cols: AxisGroup = { label: 'II', start: 0, end: 50, unitStart: 1000, unitBin: 512 }
    expect(separationOf(side(rows, 0, 700), side(cols, 0, 1300), 'bin', BIN)).toBe(300_000)
    // …and a different sequence is still a different sequence.
    const other: AxisGroup = { label: 'III', start: 0, end: 50, unitStart: 700, unitBin: 2048 }
    expect(separationOf(side(rows, 0, 700), side(other, 4, 700), 'bin', BIN)).toBeNull()
  })

  // Two MAGs may each have a `contig_1`, and with no absolute origin to compare
  // the name is most of what is left — so the genome has to be part of it.
  it('does not join two same-named sequences from different genomes', () => {
    const a: AxisGroup = { label: 'contig_1', start: 0, end: 40, unitLength: 900 }
    const b: AxisGroup = { label: 'contig_1', start: 40, end: 90, unitLength: 900 }
    expect(separationOf(side(a, 2, 0, 'MAG_1'), side(b, 60, 0, 'MAG_2'), 'bin', BIN)).toBeNull()
    expect(separationOf(side(a, 2, 0, 'MAG_1'), side(a, 20, 0, 'MAG_1'), 'bin', BIN)).toBe(18_000)
  })

  // A cell several short sequences share has no position in any one of them, so
  // it can have no distance either: the readout names what it holds instead.
  it('says nothing on a cell that holds more than one sequence', () => {
    const shared: AxisGroup = {
      label: 'c1',
      start: 0,
      end: 1,
      unitStart: 0,
      merged: [
        { label: 'c1', unitLength: 300 },
        { label: 'c2', unitLength: 200 },
      ],
    }
    expect(separationOf(side(shared, 0), side(ONE, 40), 'bin', BIN)).toBeNull()
  })

  it('says nothing above bin level, where a cell is a whole sequence', () => {
    const c1: AxisGroup = { label: 'c1', start: 0, end: 1 }
    const c2: AxisGroup = { label: 'c2', start: 1, end: 2 }
    expect(separationOf(side(c1, 0), side(c2, 1), 'contig', BIN)).toBeNull()
  })

  it('says nothing without a bin size, which a variable-bin file has none of', () => {
    expect(separationOf(side(ONE, 10), side(ONE, 40), 'bin', 0)).toBeNull()
  })
})
