/**
 * Two files in one square.
 *
 * The three things worth pinning are the three that are silent when wrong: the
 * split lands on the *matrix* diagonal rather than on the picture's, an
 * off-diagonal block is judged by absolute bins rather than by row and column
 * indices, and two files that do not describe the same sequences are refused
 * before either is drawn. Each of those failures produces a plausible picture of
 * the wrong thing, which is the failure mode this file exists for.
 */

import { describe, expect, it } from 'vitest'

import { alignable, blendAcrossDiagonal } from '../../src/render/compare'
import { compareRefusal } from '../../src/ui/CompareCard'
import { rereading } from '../../src/ui/compare'
import type { ReaderClient } from '../../src/worker/client'
import type { OpenResult } from '../../src/worker/protocol'

function block(
  nrows: number,
  ncols: number,
  fill: (row: number, col: number) => number,
  rowExtent: [number, number] = [0, nrows],
  colExtent: [number, number] = [0, ncols],
): {
  nrows: number
  ncols: number
  values: Float32Array
  rowExtent: [number, number]
  colExtent: [number, number]
} {
  const values = new Float32Array(nrows * ncols)
  for (let r = 0; r < nrows; r++) for (let c = 0; c < ncols; c++) values[r * ncols + c] = fill(r, c)
  return { nrows, ncols, values, rowExtent, colExtent }
}

describe('blendAcrossDiagonal', () => {
  it('gives the lower-left triangle to the second file and keeps the diagonal', () => {
    const a = block(4, 4, () => 1)
    const b = block(4, 4, () => 2)
    const { values, lower, upper } = blendAcrossDiagonal(a, b)

    // 4 x 4 is 6 cells strictly below the diagonal, 4 on it, 6 above.
    expect(lower).toBe(6)
    expect(upper).toBe(10)
    for (let r = 0; r < 4; r++) {
      for (let c = 0; c < 4; c++) {
        expect(values[r * 4 + c]).toBe(r > c ? 2 : 1)
      }
    }
  })

  it('leaves the source arrays alone', () => {
    const a = block(3, 3, () => 1)
    const b = block(3, 3, () => 2)
    blendAcrossDiagonal(a, b)
    expect([...a.values]).toEqual([1, 1, 1, 1, 1, 1, 1, 1, 1])
    expect([...b.values]).toEqual([2, 2, 2, 2, 2, 2, 2, 2, 2])
  })

  it('draws both files on one scale: each triangle holds its own file’s counts', () => {
    // No gain between them, ever (§5.7): two files of different depth are
    // compared by drawing both to one total (§6.5), not by rescaling one.
    const a = block(3, 3, () => 10)
    const b = block(3, 3, () => 4)
    const { values } = blendAcrossDiagonal(a, b)
    expect(values[1 * 3 + 0]).toBe(4) // below the diagonal: the second file, as read
    expect(values[0 * 3 + 1]).toBe(10) // above it: the first
  })

  it('judges an off-diagonal block by absolute bins, not by row and column', () => {
    // Rows are bins 100-104, columns are bins 0-4: every cell of this block is
    // below the diagonal, so all of it is the second file's — even the cells
    // where the *index* comparison would say otherwise.
    const a = block(4, 4, () => 1, [100, 104], [0, 4])
    const b = block(4, 4, () => 2, [100, 104], [0, 4])
    const { values, lower } = blendAcrossDiagonal(a, b)
    expect(lower).toBe(16)
    expect([...values].every((value) => value === 2)).toBe(true)
  })

  it('leaves a block entirely above the diagonal to the first file', () => {
    const a = block(4, 4, () => 1, [0, 4], [100, 104])
    const b = block(4, 4, () => 2, [0, 4], [100, 104])
    const { values, lower } = blendAcrossDiagonal(a, b)
    expect(lower).toBe(0)
    expect([...values].every((value) => value === 1)).toBe(true)
  })

  it('splits a block that straddles the diagonal at the right cell', () => {
    // Rows 4-8, columns 2-6: cell (r, c) is below when 4 + r > 2 + c.
    const a = block(4, 4, () => 1, [4, 8], [2, 6])
    const b = block(4, 4, () => 2, [4, 8], [2, 6])
    const { values } = blendAcrossDiagonal(a, b)
    for (let r = 0; r < 4; r++) {
      for (let c = 0; c < 4; c++) {
        expect(values[r * 4 + c]).toBe(4 + r > 2 + c ? 2 : 1)
      }
    }
  })
})

describe('alignable', () => {
  const base = block(4, 4, () => 1)

  it('accepts two reads of the same request', () => {
    expect(alignable(base, block(4, 4, () => 2))).toBe(true)
  })

  it('refuses a different shape', () => {
    expect(alignable(base, block(4, 5, () => 2))).toBe(false)
  })

  it('refuses the same shape at a different position', () => {
    expect(alignable(base, block(4, 4, () => 2, [8, 12], [0, 4]))).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// The gate
// ---------------------------------------------------------------------------

function opened(over: Partial<OpenResult> = {}): OpenResult {
  return {
    uri: 'a.cool',
    layout: { kind: 'cool', group: '/' },
    info: {
      format: null,
      'format-url': null,
      'format-version': null,
      'bin-size': 1000,
      'bin-type': 'fixed',
      ordering: null,
      assembly: null,
      'storage-mode': 'symmetric-upper',
      nbins: 10,
      nnz: 10,
      sum: 10,
      ngenomes: null,
      ncontigs: 2,
    },
    metadata: {},
    binsize: 1000,
    shape: [10, 10],
    nGenomes: 0,
    nContigs: 2,
    nBins: 10,
    unassigned: null,
    displayExtent: [0, 100] as [number, number],
    entries: [],
    entryGroup: '',
    cells: [],
    activeCells: [],
    cellNnz: null,
    hasGenomes: false,
    hasWeights: false,
    scoreColumns: ['count'],
    sourceBytes: 1,
    contacts: null,
    sourceKind: 'remote',
    ...over,
  }
}

const CONTIGS: Array<[string, number]> = [
  ['I', 1000],
  ['II', 2000],
]

describe('compareRefusal', () => {
  it('accepts two coolers with the same bins and the same chromosomes', () => {
    expect(
      compareRefusal(opened(), opened({ uri: 'b.cool' }), {
        primary: CONTIGS,
        second: [...CONTIGS],
      }),
    ).toBeNull()
  })

  it('refuses a file with a genome layer, naming the file and the reason', () => {
    const refusal = compareRefusal(opened(), opened({ hasGenomes: true, uri: 'b.metacool' }), {
      primary: CONTIGS,
      second: [...CONTIGS],
    })
    expect(refusal).toContain('genome layer')
    expect(refusal).toContain('b.metacool')
    // And **not** a section number. This string is read in a dialog, and the
    // app never links the document it would point into (§26.4): the sentence
    // after it is what makes the refusal followable — thousands of
    // independently assembled organisms agree about a contig name by
    // coincidence rather than by construction.
    expect(refusal).not.toContain('§')
  })

  it('refuses two bin sizes, naming both', () => {
    const refusal = compareRefusal(opened(), opened({ binsize: 5000 }), {
      primary: CONTIGS,
      second: [...CONTIGS],
    })
    expect(refusal).toContain('1,000')
    expect(refusal).toContain('5,000')
  })

  it('accepts one assembly written in two conventions', () => {
    // The `chr` prefix is a spelling, not a chromosome. Refusing this pair was
    // refusing the commonest thing anybody has: the same genome out of two
    // pipelines (§5.9).
    expect(
      compareRefusal(opened(), opened(), {
        primary: CONTIGS,
        second: [
          ['chrI', 1000],
          ['chrII', 2000],
        ],
      }),
    ).toBeNull()
  })

  it('refuses a genuinely different chromosome, naming both spellings', () => {
    const refusal = compareRefusal(opened(), opened(), {
      primary: CONTIGS,
      second: [
        ['scaffold_7', 1000],
        ['II', 2000],
      ],
    })
    expect(refusal).toContain('I')
    expect(refusal).toContain('scaffold_7')
    expect(refusal).toContain('not two spellings')
  })

  it('refuses two spellings of one name over sequences of different lengths', () => {
    // The check the relaxation must not lose: hg19's `chr1` and hg38's `chr1`
    // are one name and two sequences, and so are `I` and `chrI` here.
    const refusal = compareRefusal(opened(), opened(), {
      primary: CONTIGS,
      second: [
        ['chrI', 1200],
        ['II', 2000],
      ],
    })
    expect(refusal).toContain('1,200')
    expect(refusal).toContain('different sequence')
  })

  it('refuses a chromosome of a different length, which would not line up', () => {
    const refusal = compareRefusal(opened(), opened(), {
      primary: CONTIGS,
      second: [
        ['I', 1000],
        ['II', 2500],
      ],
    })
    expect(refusal).toContain('II')
    expect(refusal).toContain('2,500')
  })

  it('refuses two different chromosome counts', () => {
    const refusal = compareRefusal(opened(), opened(), {
      primary: CONTIGS,
      second: [['I', 1000]],
    })
    expect(refusal).toContain('counts differ')
  })
})

describe('rereading (§5.10)', () => {
  it('asks the same question with the lower reading’s balancing and column', async () => {
    const asked: unknown[] = []
    const client = { request: async (payload: unknown) => (asked.push(payload), payload) } as unknown as ReaderClient
    const again = rereading(client, { balance: false, value: 'expected_dense' })
    await again.request({ kind: 'matrix', rows: [0, 4], balance: true } as never)
    await rereading(client, { balance: true }).request({
      kind: 'matrix',
      rows: [0, 4],
      balance: false,
      value: 'x',
    } as never)
    expect(asked).toEqual([
      { kind: 'matrix', rows: [0, 4], balance: false, value: 'expected_dense' },
      { kind: 'matrix', rows: [0, 4], balance: true },
    ])
  })
})
