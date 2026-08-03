/**
 * The sidebar record card's field selection.
 *
 * The card quotes a `/genomes` or `/contigs` row beside the heatmap it belongs
 * to, so what is pinned here is that it stays a faithful quotation of a table
 * whose columns nobody has seen:
 *
 * - the guaranteed columns lead, and the binner's own columns follow in file
 *   order — the whole point is that a MAG's completeness and taxonomy show up
 *   without this module knowing those words;
 * - an empty fixed-length string is padding, not a value, exactly as in the
 *   tables (§5.1) — otherwise the card asserts a blank taxonomy;
 * - `name` is the title and never also a field.
 *
 * `recordCard` itself is not exercised: it needs a `document`, and this suite
 * runs in Node.
 */

import { describe, expect, it } from 'vitest'

import { findRow, recordFields } from '../../src/ui/RecordCard'
import type { TablePayload } from '../../src/worker/protocol'

const GENOMES: TablePayload = {
  length: 3,
  // Deliberately not in display order: the extra columns come before two of the
  // core ones, so the reordering is actually observable.
  columns: ['name', 'completeness', 'length', 'taxonomy', 'n_contigs', 'n_bins'],
  data: {
    name: ['MAG_1', 'MAG_2', '__unbinned__'],
    completeness: Float64Array.from([98.25, 41, 0]),
    length: Float64Array.from([4573673, 812000, 91000]),
    taxonomy: ['Bacteroides', '', 'n/a'],
    n_contigs: Float64Array.from([12, 3, 400]),
    n_bins: Float64Array.from([457, 81, 9]),
  },
}

const CONTIGS: TablePayload = {
  length: 2,
  columns: ['name', 'length', 'genome_id'],
  data: {
    name: ['NODE_1', 'NODE_2'],
    length: Float64Array.from([134871, 9000]),
    genome_id: Float64Array.from([0, 1]),
  },
}

describe('findRow', () => {
  it('finds a row by name', () => {
    expect(findRow(GENOMES, 'MAG_2')).toBe(1)
  })

  it('answers -1 for a name the table does not have', () => {
    expect(findRow(GENOMES, 'MAG_9')).toBe(-1)
  })
})

describe('recordFields', () => {
  it('leads with the guaranteed columns and keeps the rest in file order', () => {
    const keys = recordFields(GENOMES, 0).map((field) => field.key)
    expect(keys).toEqual(['length', 'n_contigs', 'n_bins', 'completeness', 'taxonomy'])
  })

  it('formats a length as base pairs and a float as a float', () => {
    const fields = new Map(recordFields(GENOMES, 0).map((f) => [f.key, f.value]))
    expect(fields.get('length')).toMatch(/^4.573.673 bp$/)
    expect(fields.get('completeness')).toMatch(/^98[.,]25$/)
    expect(fields.get('taxonomy')).toBe('Bacteroides')
  })

  it('reads an empty fixed-length string as missing, not as a blank value', () => {
    const fields = new Map(recordFields(GENOMES, 1).map((f) => [f.key, f.value]))
    expect(fields.get('taxonomy')).toBe('—')
  })

  it('skips the columns it is asked to, and leads and trails with the given fields', () => {
    const fields = recordFields(CONTIGS, 0, {
      skip: ['genome_id'],
      lead: [{ key: 'genome', value: 'MAG_1' }],
      extra: [{ key: 'nnz rows', value: '1,093,107' }],
    })
    expect(fields.map((f) => f.key)).toEqual(['genome', 'length', 'nnz rows'])
  })

  it('has no fields for a row that is not in the table', () => {
    expect(recordFields(GENOMES, -1)).toEqual([])
    expect(recordFields(GENOMES, 3)).toEqual([])
  })
})
