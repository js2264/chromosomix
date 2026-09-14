/**
 * The facet arithmetic a store is narrowed by, pinned without a document.
 *
 * Two rules carry the whole feature and both are easy to get quietly wrong: a
 * facet's counts must ignore its *own* selection and honour every other one
 * (otherwise ticking one assay reads every other assay as zero), and ticking
 * two values under one facet must widen rather than narrow. The matrix is the
 * same rule over a pair, and the link is what makes a narrowed store a thing
 * that can be sent to somebody.
 */

import { describe, expect, it } from 'vitest'

import {
  EMPTY_QUERY,
  EMPTY_VIEW,
  clearFacet,
  facetCounts,
  isEmptyQuery,
  isTicked,
  pivot,
  readStoreView,
  select,
  setFacet,
  tickedCount,
  toggleFacet,
  writeStoreView,
  type FacetSelection,
} from '@/state/facets'
import type { StoreColumn, StoreEntry } from '@/state/store'

const COLUMNS: StoreColumn[] = [
  { key: 'assembly', label: 'Assembly' },
  { key: 'assay', label: 'Assay' },
  { key: 'biosample', label: 'Biosample' },
]

function row(label: string, fields: Record<string, string>, note = ''): StoreEntry {
  return { label, uri: `${label}.bw`, kind: 'genome', fields, ...(note === '' ? {} : { note }) }
}

const ROWS: StoreEntry[] = [
  row('a', { assembly: 'GRCh38', assay: 'ChIP-seq', biosample: 'GM12878' }, 'CTCF'),
  row('b', { assembly: 'GRCh38', assay: 'ChIP-seq', biosample: 'K562' }),
  row('c', { assembly: 'GRCh38', assay: 'ATAC-seq', biosample: 'GM12878' }),
  row('d', { assembly: 'hg19', assay: 'ChIP-seq', biosample: 'GM12878' }),
  row('e', { assembly: 'hg19', assay: 'Hi-C' }),
]

function ticked(pairs: Array<[string, string[]]>): FacetSelection {
  return new Map(pairs.map(([key, values]) => [key, new Set(values)]))
}

function labels(entries: StoreEntry[]): string[] {
  return entries.map((entry) => entry.label)
}

describe('selecting rows', () => {
  it('narrows nothing with an empty query', () => {
    expect(labels(select(ROWS, COLUMNS, EMPTY_QUERY))).toEqual(['a', 'b', 'c', 'd', 'e'])
    expect(isEmptyQuery(EMPTY_QUERY)).toBe(true)
  })

  it('is OR within a facet and AND across facets', () => {
    const either = select(ROWS, COLUMNS, {
      text: '',
      facets: ticked([['assay', ['ChIP-seq', 'ATAC-seq']]]),
    })
    expect(labels(either)).toEqual(['a', 'b', 'c', 'd'])
    const both = select(ROWS, COLUMNS, {
      text: '',
      facets: ticked([
        ['assay', ['ChIP-seq', 'ATAC-seq']],
        ['assembly', ['GRCh38']],
      ]),
    })
    expect(labels(both)).toEqual(['a', 'b', 'c'])
  })

  it('searches every word over the label, the note and the cells, in any order', () => {
    expect(labels(select(ROWS, COLUMNS, { ...EMPTY_QUERY, text: 'gm12878 ctcf' }))).toEqual(['a'])
    expect(labels(select(ROWS, COLUMNS, { ...EMPTY_QUERY, text: 'CTCF GM12878' }))).toEqual(['a'])
    expect(labels(select(ROWS, COLUMNS, { ...EMPTY_QUERY, text: 'k562' }))).toEqual(['b'])
    expect(labels(select(ROWS, COLUMNS, { ...EMPTY_QUERY, text: 'nothing like it' }))).toEqual([])
  })

  it('ignores a facet the store has no column for, rather than emptying the table', () => {
    // A link written against last week's columns, or a key another view of
    // the same store keeps for itself: a filter nobody can see must not apply.
    const out = select(ROWS, COLUMNS, { text: '', facets: ticked([['lab', ['Snyder']]]) })
    expect(labels(out)).toEqual(['a', 'b', 'c', 'd', 'e'])
  })

  it('ticks the row that says nothing, under the empty value', () => {
    expect(labels(select(ROWS, COLUMNS, { text: '', facets: ticked([['biosample', ['']]]) }))).toEqual(['e'])
  })
})

describe('counting facets', () => {
  it('counts every value of every column when nothing is ticked', () => {
    const counts = facetCounts(ROWS, COLUMNS, EMPTY_QUERY)
    expect(counts.get('assembly')).toEqual([
      { value: 'GRCh38', count: 3, on: false },
      { value: 'hg19', count: 2, on: false },
    ])
    expect(counts.get('assay')).toEqual([
      { value: 'ChIP-seq', count: 3, on: false },
      { value: 'ATAC-seq', count: 1, on: false },
      { value: 'Hi-C', count: 1, on: false },
    ])
    // The empty value is counted and sinks to the end whatever its size.
    expect(counts.get('biosample')?.map((one) => one.value)).toEqual(['GM12878', 'K562', ''])
  })

  it('ignores a facet’s own selection and honours every other one', () => {
    const counts = facetCounts(ROWS, COLUMNS, {
      text: '',
      facets: ticked([['assay', ['ChIP-seq']]]),
    })
    // The assay counts are what ticking each value *would* give: unchanged.
    expect(counts.get('assay')).toEqual([
      { value: 'ChIP-seq', count: 3, on: true },
      { value: 'ATAC-seq', count: 1, on: false },
      { value: 'Hi-C', count: 1, on: false },
    ])
    // The other facets are counted over ChIP-seq rows only.
    expect(counts.get('assembly')).toEqual([
      { value: 'GRCh38', count: 2, on: false },
      { value: 'hg19', count: 1, on: false },
    ])
    expect(counts.get('biosample')).toEqual([
      { value: 'GM12878', count: 2, on: false },
      { value: 'K562', count: 1, on: false },
    ])
  })

  it('keeps a ticked value at zero when another facet took its rows, so it can be unticked', () => {
    const counts = facetCounts(ROWS, COLUMNS, {
      text: '',
      facets: ticked([
        ['assay', ['Hi-C']],
        ['assembly', ['GRCh38']],
      ]),
    })
    // No GRCh38 Hi-C: the ticked assay has no rows and stays on the list, first.
    expect(counts.get('assay')?.[0]).toEqual({ value: 'Hi-C', count: 0, on: true })
    // …and hg19 is what ticking it would add, given Hi-C is ticked.
    expect(counts.get('assembly')).toEqual([
      { value: 'GRCh38', count: 0, on: true },
      { value: 'hg19', count: 1, on: false },
    ])
  })

  it('honours the text the same way every facet does', () => {
    const counts = facetCounts(ROWS, COLUMNS, { ...EMPTY_QUERY, text: 'gm12878' })
    expect(counts.get('assay')).toEqual([
      { value: 'ChIP-seq', count: 2, on: false },
      { value: 'ATAC-seq', count: 1, on: false },
    ])
  })
})

describe('the matrix', () => {
  it('pivots two facets against each other over every other facet', () => {
    const grid = pivot(ROWS, COLUMNS, EMPTY_QUERY, 'assay', 'biosample')
    expect(grid.rows).toEqual(['ChIP-seq', 'ATAC-seq', 'Hi-C'])
    expect(grid.cols).toEqual(['GM12878', 'K562', ''])
    expect(grid.counts.get('ChIP-seq')?.get('GM12878')).toBe(2)
    expect(grid.counts.get('ChIP-seq')?.get('K562')).toBe(1)
    expect(grid.counts.get('Hi-C')?.get('')).toBe(1)
    expect(grid.counts.get('ATAC-seq')?.get('K562')).toBeUndefined()
    expect(grid.total).toBe(5)
  })

  it('ignores the axes’ own selections and honours the rest', () => {
    const grid = pivot(
      ROWS,
      COLUMNS,
      { text: '', facets: ticked([['assay', ['Hi-C']], ['assembly', ['GRCh38']]]) },
      'assay',
      'biosample',
    )
    // The assay tick is on an axis and is ignored; the assembly tick is not.
    expect(grid.rows).toEqual(['ChIP-seq', 'ATAC-seq'])
    expect(grid.total).toBe(3)
  })

  it('caps each axis by population and says how many there were', () => {
    const grid = pivot(ROWS, COLUMNS, EMPTY_QUERY, 'biosample', 'assay', { maxRows: 1, maxCols: 2 })
    expect(grid.rows).toEqual(['GM12878'])
    expect(grid.cols).toEqual(['ChIP-seq', 'ATAC-seq'])
    expect(grid.rowValues).toBe(3)
    expect(grid.colValues).toBe(3)
  })
})

describe('ticking', () => {
  it('toggles a value on and off, and drops an emptied facet', () => {
    let held: FacetSelection = new Map()
    held = toggleFacet(held, 'assay', 'Hi-C')
    expect(isTicked(held, 'assay', 'Hi-C')).toBe(true)
    expect(tickedCount(held)).toBe(1)
    held = toggleFacet(held, 'assay', 'Hi-C')
    expect(held.has('assay')).toBe(false)
  })

  it('sets and clears a whole facet', () => {
    let held = setFacet(new Map(), 'assay', ['a', 'b'])
    expect(tickedCount(held)).toBe(2)
    held = clearFacet(held, 'assay')
    expect(tickedCount(held)).toBe(0)
    expect(clearFacet(held, 'assay')).toBe(held)
  })
})

describe('the link', () => {
  it('round-trips a view through the query string', () => {
    const params = new URLSearchParams('store=encode&embed=1')
    writeStoreView(params, {
      text: 'ctcf',
      facets: ticked([['assay', ['ChIP-seq', 'ATAC-seq']], ['assembly', ['GRCh38']]]),
      mode: 'matrix',
      axes: ['assay', 'biosample'],
    })
    expect(params.toString()).toBe(
      'store=encode&embed=1&q=ctcf&assay=ATAC-seq&assay=ChIP-seq&assembly=GRCh38&view=matrix&axes=assay%2Cbiosample',
    )
    const read = readStoreView(params)
    expect(read.text).toBe('ctcf')
    expect([...(read.facets.get('assay') ?? [])].sort()).toEqual(['ATAC-seq', 'ChIP-seq'])
    expect(read.mode).toBe('matrix')
    expect(read.axes).toEqual(['assay', 'biosample'])
  })

  it('writes nothing for the default view, and clears what a previous view wrote', () => {
    const params = new URLSearchParams('store=4dn&assay=Hi-C&q=old&view=matrix&config=c.json&utm=x')
    writeStoreView(params, EMPTY_VIEW, ['assay'])
    // The facet it wrote before is gone; a parameter it never wrote is kept.
    expect(params.toString()).toBe('store=4dn&config=c.json&utm=x')
  })

  it('never reads a reserved name as a facet, and refuses reserved axes', () => {
    const read = readStoreView(new URLSearchParams('store=x&embed=1&config=c&edges=e.tsv&view=list&axes=store,q&lab=Snyder'))
    expect([...read.facets.keys()]).toEqual(['lab'])
    expect(read.axes).toBeUndefined()
    expect(read.mode).toBe('list')
  })
})
