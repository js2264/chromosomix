/**
 * The file's own columns, as lanes (§8.12) — the arithmetic half.
 *
 * Three claims are worth a suite of their own, because all three are the kind
 * of thing that is *plausible* when wrong:
 *
 * 1. **The level rule.** A column is drawn where its own table is no finer than
 *    the axis, and nowhere else. A bin weight averaged into a genome cell would
 *    look exactly like a number the file wrote.
 * 2. **Cell → row.** Which row of which table each cell of a block is, on all
 *    three levels, dense and pooled, and through the *bin* rather than the name
 *    wherever a bin is available — a metagenome is entitled to two `contig_1`s.
 * 3. **Discovery.** What is offered is what a reader would recognise as an
 *    annotation: a name is not one, an accession is not one, and a cluster id
 *    written as small integers is a set of labels rather than a measurement.
 */

import { describe, expect, it } from 'vitest'

import {
  binSpansForCells,
  cellsOf,
  classify,
  discoverTable,
  levelsOf,
  metadataId,
  metadataSpec,
  rowsForCells,
  showsAtLevel,
  valuesOf,
  type MetaBlock,
  type MetaRowIndex,
} from '@/annotations/metadata'
import type { Table } from '@/types'

/** A table in the shape the reader hands one over. */
function table(columns: Record<string, string[] | Float64Array>): Table {
  const names = Object.keys(columns)
  const length = names.length === 0 ? 0 : (columns[names[0]] as ArrayLike<unknown>).length
  return {
    length,
    columns: names,
    data: columns as Table['data'],
    get: (column, row) => (columns[column] as ArrayLike<string | number>)?.[row],
    strings: (column) => columns[column] as string[],
    numbers: (column) => Array.from(columns[column] as ArrayLike<number>, Number),
  }
}

/**
 * Three MAGs of two contigs each, every contig four bins long.
 *
 * Small enough to check by hand and shaped like the real thing: contigs
 * numbered from one *inside every genome*, which is what makes a name lookup
 * the wrong answer at bin level.
 */
const INDEX: MetaRowIndex = {
  genomeRow: (name) => ['MAG_1', 'MAG_2', 'MAG_3'].indexOf(name),
  contigRow: (name) =>
    ['contig_1', 'contig_2', 'contig_1', 'contig_2', 'contig_1', 'contig_2'].indexOf(name),
  contigRowOfBin: (bin) => (bin < 0 || bin >= 24 ? -1 : Math.floor(bin / 4)),
  genomeOfContig: (row) => (row < 0 ? -1 : Math.floor(row / 2)),
  binsInContig: (row) => (row < 0 || row > 5 ? 0 : 4),
}

describe('the level rule', () => {
  it('draws a column where its own table is no finer than the axis', () => {
    // A genome's value is exact on every contig and every bin inside it.
    expect(showsAtLevel('genomes', 'genome')).toBe(true)
    expect(showsAtLevel('genomes', 'contig')).toBe(true)
    expect(showsAtLevel('genomes', 'bin')).toBe(true)
    // A contig's is exact on its own bins, and says nothing about a MAG.
    expect(showsAtLevel('contigs', 'genome')).toBe(false)
    expect(showsAtLevel('contigs', 'contig')).toBe(true)
    expect(showsAtLevel('contigs', 'bin')).toBe(true)
    // A bin's is a statement about one bin and nothing else.
    expect(showsAtLevel('bins', 'genome')).toBe(false)
    expect(showsAtLevel('bins', 'contig')).toBe(false)
    expect(showsAtLevel('bins', 'bin')).toBe(true)
  })
})

describe('what is offered', () => {
  it('leaves out the table’s skeleton and keeps everything else', () => {
    const found = discoverTable(
      'genomes',
      table({
        name: ['MAG_1', 'MAG_2', 'MAG_3', 'MAG_4'],
        completeness: Float64Array.from([98.1, 74.2, 91.0, 55.5]),
        n_bins: Float64Array.from([400, 210, 380, 90]),
        taxon: ['Bacteroides', 'Prevotella', 'Bacteroides', 'Faecalibacterium'],
      }),
    )
    // `name` is what the axis is already labelled with; the rest are annotations
    // of it, including the ones the app itself uses for arithmetic.
    expect(found.map((column) => column.column)).toEqual(['completeness', 'n_bins', 'taxon'])
    expect(found.map((column) => column.kind)).toEqual([
      'quantitative',
      'quantitative',
      'qualitative',
    ])
    expect(found[2].levels).toEqual(['Bacteroides', 'Prevotella', 'Faecalibacterium'])
  })

  it('reads small repeated integers as labels and floats as measurements', () => {
    const rows = 40
    const cluster = Float64Array.from({ length: rows }, (_, i) => i % 3)
    const coverage = Float64Array.from({ length: rows }, (_, i) => 3.5 + i / 10)
    expect(classify(cluster)).toBe('qualitative')
    expect(classify(coverage)).toBe('quantitative')
  })

  it('refuses an identifier column, which is not an annotation of anything', () => {
    const accession = Array.from({ length: 40 }, (_, i) => `NODE_${i}_length_${i * 7}`)
    expect(classify(accession)).toBeNull()
    // …and a column with nothing in it at all.
    expect(classify([])).toBeNull()
    expect(classify(new Float64Array(8).fill(Number.NaN))).toBeNull()
  })

  it('numbers the categories in the order the file writes them, blanks aside', () => {
    expect(levelsOf(['phage', '', 'plasmid', 'phage', 'chromosome'])).toEqual([
      'phage',
      'plasmid',
      'chromosome',
    ])
  })
})

describe('cell → row', () => {
  it('is the run’s genome at genome level', () => {
    const block: MetaBlock = {
      level: 'genome',
      runs: [
        { label: 'MAG_1', start: 0, end: 1 },
        { label: 'MAG_3', start: 1, end: 2 },
      ],
      cells: 2,
      blockStart: 0,
      binsPerCell: 1,
    }
    expect([...rowsForCells(block, 'genomes', INDEX)]).toEqual([0, 2])
    // A contigs column has nothing to say about a cell that is a whole MAG, and
    // says so with a gap rather than with the first contig of it.
    expect([...rowsForCells(block, 'contigs', INDEX)]).toEqual([-1, -1])
  })

  it('broadcasts a genome’s value onto its contigs', () => {
    const block: MetaBlock = {
      level: 'contig',
      runs: [
        { label: 'contig_1', start: 0, end: 1 },
        { label: 'contig_2', start: 1, end: 2 },
      ],
      cells: 2,
      blockStart: 0,
      binsPerCell: 1,
    }
    expect([...rowsForCells(block, 'contigs', INDEX)]).toEqual([0, 1])
    expect([...rowsForCells(block, 'genomes', INDEX)]).toEqual([0, 0])
  })

  it('resolves a bin-level run by its bin, not by its name', () => {
    // Both runs are called `contig_1`; they are the first contig of MAG_1 and
    // the first contig of MAG_3. A name lookup answers `0` for both, which
    // would draw one MAG's annotation over the other's bins.
    const block: MetaBlock = {
      level: 'bin',
      runs: [
        { label: 'contig_1', start: 0, end: 4, unitStart: 0, unitBin: 0 },
        { label: 'contig_1', start: 4, end: 8, unitStart: 16, unitBin: 16 },
      ],
      cells: 8,
      blockStart: 0,
      binsPerCell: 1,
    }
    expect([...rowsForCells(block, 'contigs', INDEX)]).toEqual([0, 0, 0, 0, 4, 4, 4, 4])
    expect([...rowsForCells(block, 'genomes', INDEX)]).toEqual([0, 0, 0, 0, 2, 2, 2, 2])
  })
})

describe('cell → bins', () => {
  it('is one bin per cell on a dense block, counted from the block’s start', () => {
    const block: MetaBlock = {
      level: 'bin',
      runs: [{ label: 'contig_2', start: 0, end: 3, unitStart: 4, unitBin: 4 }],
      cells: 3,
      blockStart: 5,
      binsPerCell: 1,
    }
    // The block opens one bin into the contig, so its cells are bins 5, 6, 7.
    expect(binSpansForCells(block, INDEX)).toEqual([
      { start: 5, count: 1 },
      { start: 6, count: 1 },
      { start: 7, count: 1 },
    ])
  })

  it('is a run of bins per cell on a pooled block, clamped at the contig’s end', () => {
    // Two bins to a cell over a four-bin contig: two full cells, and a third
    // that would run past the sequence is refused rather than padded.
    const block: MetaBlock = {
      level: 'bin',
      runs: [{ label: 'contig_1', start: 0, end: 3, unitBin: 0 }],
      cells: 3,
      blockStart: 0,
      binsPerCell: 2,
    }
    expect(binSpansForCells(block, INDEX)).toEqual([
      { start: 0, count: 2 },
      { start: 2, count: 2 },
      { start: -1, count: 0 },
    ])
  })

  it('discounts the cells of a sequence that fall before a pooled block', () => {
    // `anchor` in the reader sends `unitStart` on the first run of a pooled
    // block that opens partway along a sequence: the block opens at bin 2, the
    // grid is anchored to the contig's own start, so one cell of it is behind
    // us and `unitStart` is `lo + start − before`.
    const block: MetaBlock = {
      level: 'bin',
      runs: [{ label: 'contig_1', start: 0, end: 1, unitStart: 1, unitBin: 0 }],
      cells: 1,
      blockStart: 2,
      binsPerCell: 2,
    }
    expect(binSpansForCells(block, INDEX)).toEqual([{ start: 2, count: 2 }])
  })
})

describe('cells → values', () => {
  const genomeBlock: MetaBlock = {
    level: 'genome',
    runs: [
      { label: 'MAG_1', start: 0, end: 1 },
      { label: 'MAG_2', start: 1, end: 2 },
      { label: 'nowhere', start: 2, end: 3 },
    ],
    cells: 3,
    blockStart: 0,
    binsPerCell: 1,
  }

  it('reads a genome column onto a genome axis, gaps and all', () => {
    const values = valuesOf(Float64Array.from([98.1, 74.2, 91]), 'quantitative', [])
    const cells = cellsOf({ block: genomeBlock, table: 'genomes', values, index: INDEX })
    expect(cells.kind).toBe('quantitative')
    if (cells.kind !== 'quantitative') return
    expect([...cells.values].slice(0, 2)).toEqual([98.1, 74.2])
    // A run the table has never heard of is a gap, not a zero.
    expect(Number.isNaN(cells.values[2])).toBe(true)
    expect(cells.extent).toEqual({ min: 74.2, max: 98.1 })
  })

  it('averages a bin column over the bins a pooled cell covers, skipping NaN', () => {
    const block: MetaBlock = {
      level: 'bin',
      runs: [{ label: 'contig_1', start: 0, end: 2, unitBin: 0 }],
      cells: 2,
      blockStart: 0,
      binsPerCell: 2,
    }
    // A filtered bin's weight is `NaN` and means *no value here*: averaged in
    // as a zero it would draw a filtered region as a low one.
    const values = valuesOf(
      Float64Array.from([1, 3, Number.NaN, 5]),
      'quantitative',
      [],
    )
    const cells = cellsOf({ block, table: 'bins', values, index: INDEX })
    if (cells.kind !== 'quantitative') throw new Error('expected a profile')
    expect([...cells.values]).toEqual([2, 5])
  })

  it('takes the most common category where a cell holds several bins', () => {
    const block: MetaBlock = {
      level: 'bin',
      runs: [{ label: 'contig_1', start: 0, end: 1, unitBin: 0 }],
      cells: 1,
      blockStart: 0,
      binsPerCell: 4,
    }
    const values = valuesOf(
      ['phage', 'plasmid', 'plasmid', ''],
      'qualitative',
      ['phage', 'plasmid'],
    )
    const cells = cellsOf({ block, table: 'bins', values, index: INDEX })
    if (cells.kind !== 'qualitative') throw new Error('expected categories')
    expect(cells.levels[cells.codes[0]]).toBe('plasmid')
  })

  it('offsets a bins column by the range it was read over', () => {
    const block: MetaBlock = {
      level: 'bin',
      runs: [{ label: 'contig_2', start: 0, end: 2, unitStart: 4, unitBin: 4 }],
      cells: 2,
      blockStart: 4,
      binsPerCell: 1,
    }
    // Read from bin 4 onwards, so index 0 of the array is bin 4.
    const values = valuesOf(Float64Array.from([0.5, 0.25]), 'quantitative', [], 4)
    const cells = cellsOf({ block, table: 'bins', values, index: INDEX })
    if (cells.kind !== 'quantitative') throw new Error('expected a profile')
    expect([...cells.values]).toEqual([0.5, 0.25])
  })

  it('refuses to invent a category the column’s levels do not hold', () => {
    const values = valuesOf(['phage', 'unknown-to-the-legend'], 'qualitative', ['phage'])
    expect([...values.kind === 'qualitative' ? values.codes : []]).toEqual([0, -1])
  })
})

describe('a column’s id', () => {
  it('round-trips the table and the column it names', () => {
    expect(metadataSpec(metadataId('contigs', 'mge_class'))).toEqual({
      table: 'contigs',
      column: 'mge_class',
    })
    // A column name is free to hold the separator; only the first one counts.
    expect(metadataSpec(metadataId('bins', 'weight:KR'))).toEqual({
      table: 'bins',
      column: 'weight:KR',
    })
  })

  it('does not answer for an id that is not one of ours', () => {
    // The shape `mintAnnotationId` produces, which must never be mistaken for a
    // metadata row — two rows under one id is one row that deletes twice.
    expect(metadataSpec('a17')).toBeNull()
    expect(metadataSpec('analysis:insulation')).toBeNull()
    expect(metadataSpec('metadata:nosuchtable:x')).toBeNull()
  })
})
