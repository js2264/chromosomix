/**
 * The HiC-Pro parser: two text files, and the four ways they can be written.
 *
 * Everything here is hand-built and hand-checkable, which is the point. The
 * format has no index and no header — a mistake in the 1-based translation or
 * in the triangle normalisation produces a map that is wrong by one bin or
 * doubled off the diagonal, and both look entirely plausible on a heatmap. So
 * the pixels are counted out here in full rather than sampled.
 *
 * The grid: `chr1` 0–250 and `chr2` 0–120 at 100 bp, which is
 *
 *   bin 0 chr1:0-100   bin 1 chr1:100-200   bin 2 chr1:200-250 (short)
 *   bin 3 chr2:0-100   bin 4 chr2:100-120 (short)
 *
 * so it exercises a short last bin on every sequence, which is what a real
 * genome always has and what a naive fixed-grid check refuses.
 */

import { describe, expect, it } from 'vitest'

import { ViewerError } from '@/errors'
import { parseBins, parseMatrix } from '@/hicpro/parse'

const enc = (text: string): Uint8Array => new TextEncoder().encode(text)

const BED = enc(
  [
    'chr1\t0\t100\t1',
    'chr1\t100\t200\t2',
    'chr1\t200\t250\t3',
    'chr2\t0\t100\t4',
    'chr2\t100\t120\t5',
  ].join('\n') + '\n',
)

/** The same five pixels, written the four ways `MATRIX_FORMAT` allows. */
const UPPER = enc('1\t1\t10\n1\t2\t5\n2\t3\t7\n3\t3\t2\n4\t5\t9\n')
const LOWER = enc('1\t1\t10\n2\t1\t5\n3\t2\t7\n3\t3\t2\n5\t4\t9\n')
const COMPLETE = enc(
  '1\t1\t10\n1\t2\t5\n2\t1\t5\n2\t3\t7\n3\t2\t7\n3\t3\t2\n4\t5\t9\n5\t4\t9\n',
)
/** `asis` is unsorted and mixes both triangles — the contacts as observed. */
const ASIS = enc('4\t5\t9\n2\t3\t7\n1\t1\t10\n3\t3\t2\n2\t1\t5\n')

/** `(row, col) → value` for whatever came back, for comparing by hand. */
function cells(p: ReturnType<typeof parseMatrix>): Record<string, number> {
  const out: Record<string, number> = {}
  for (let i = 0; i < p.nnz; i++) out[`${p.bin1[i]},${p.bin2[i]}`] = p.count[i]
  return out
}

const EXPECTED = { '0,0': 10, '0,1': 5, '1,2': 7, '2,2': 2, '3,4': 9 }

describe('the bin file', () => {
  it('becomes a chroms table and a chrom_offset', () => {
    const bins = parseBins(BED, 'x_abs.bed')
    expect(bins.names).toEqual(['chr1', 'chr2'])
    expect([...bins.lengths]).toEqual([250, 120])
    expect([...bins.chromOffset]).toEqual([0, 3, 5])
    expect(bins.nBins).toBe(5)
  })

  it('reads the bin size off the widest interval, not the first or the last', () => {
    // Every sequence ends in a short bin, so first-or-last would answer 50 here
    // and 20 on a genome whose first sequence is shorter than one bin.
    expect(parseBins(BED, 'x').binsize).toBe(100)
    expect(parseBins(BED, 'x').fixed).toBe(true)
  })

  it('calls a fragment-level grid what it is, rather than guessing a bin size', () => {
    const frag = enc('chr1\t0\t137\t1\nchr1\t137\t402\t2\nchr1\t402\t530\t3\n')
    const bins = parseBins(frag, 'frag_abs.bed')
    expect(bins.fixed).toBe(false)
    expect(bins.binsize).toBeNull()
  })

  it('accepts a BED3 of the same grid, since the fourth column is never read', () => {
    const bed3 = enc('chr1\t0\t100\nchr1\t100\t200\nchr1\t200\t250\n')
    expect(parseBins(bed3, 'x').chromOffset).toEqual(Float64Array.from([0, 3]))
  })

  it('skips comments and a track line', () => {
    const noisy = enc('# made by HiC-Pro\ntrack name=bins\nchr1\t0\t100\t1\n')
    expect(parseBins(noisy, 'x').nBins).toBe(1)
  })

  it('refuses an ordinary BED, by what makes it one', () => {
    // A feature BED has a name in column four, so the ids do not run 1…n — and
    // that is the honest thing to say, because such a file *is* valid BED.
    const features = enc('chr1\t0\t100\tgeneA\nchr1\t500\t900\tgeneB\n')
    const error = capture(() => parseBins(features, 'genes.bed'))
    expect(error.message).toContain('drop it as a track instead')
  })

  it('refuses a file whose sequences are interleaved rather than in runs', () => {
    const shuffled = enc('chr1\t0\t100\t1\nchr2\t0\t100\t2\nchr1\t100\t200\t3\n')
    expect(capture(() => parseBins(shuffled, 'x')).message).toContain('two separate runs')
  })
})

describe('the matrix, however its triangle was stored', () => {
  it.each([
    ['upper', UPPER],
    ['lower', LOWER],
    ['complete', COMPLETE],
    ['asis', ASIS],
  ])('%s gives the same five pixels', (_name, bytes) => {
    const p = parseMatrix(bytes, 5, 'x.matrix')
    expect(cells(p)).toEqual(EXPECTED)
    expect(p.nnz).toBe(5)
    expect(p.sum).toBe(33)
  })

  it('labels an upper file upper, diagonal pixels notwithstanding', () => {
    // A diagonal pixel is in neither triangle. Counting it in both made every
    // real file `mixed` — and every real file has a diagonal — so the label
    // said nothing at all until the comparison was made strict.
    expect(parseMatrix(UPPER, 5, 'x').observed).toBe('upper')
    expect(parseMatrix(LOWER, 5, 'x').observed).toBe('lower')
    expect(parseMatrix(enc('3\t3\t2\n'), 5, 'x').observed).toBe('upper')
  })

  it('does not double the off-diagonal cells of a complete matrix', () => {
    // The failure this exists for: folding both triangles onto one and *adding*
    // them gives 0,1 = 10 and a map that is twice as bright everywhere but the
    // diagonal, which looks like a perfectly ordinary contact map.
    const p = parseMatrix(COMPLETE, 5, 'x.matrix')
    expect(p.count[indexOf(p, 0, 1)]).toBe(5)
    expect(p.count[indexOf(p, 0, 0)]).toBe(10)
    expect(p.observed).toBe('complete')
  })

  it('translates the 1-based ids exactly once', () => {
    // Bin 1 in the file is bin 0 here; the last bin is nBins, not nBins + 1.
    const p = parseMatrix(UPPER, 5, 'x.matrix')
    expect(p.bin1[0]).toBe(0)
    expect(Math.max(...p.bin2)).toBe(4)
  })

  it('sorts into CSR order, so bin1_offset addresses a row band', () => {
    const p = parseMatrix(ASIS, 5, 'x.matrix')
    for (let i = 1; i < p.nnz; i++) {
      expect(p.bin1[i]).toBeGreaterThanOrEqual(p.bin1[i - 1])
      if (p.bin1[i] === p.bin1[i - 1]) expect(p.bin2[i]).toBeGreaterThan(p.bin2[i - 1])
    }
    // Row 0 holds (0,0) and (0,1); row 3 holds (3,4); row 4 holds nothing.
    expect([...p.binOffset]).toEqual([0, 2, 3, 4, 5, 5])
  })

  it('reads the float counts an iced/ matrix carries, exponents included', () => {
    const iced = enc('1\t2\t3.5\n2\t3\t1.25e2\n3\t3\t4e-1\n')
    const p = parseMatrix(iced, 5, 'iced.matrix')
    expect(p.count[indexOf(p, 0, 1)]).toBeCloseTo(3.5, 5)
    expect(p.count[indexOf(p, 1, 2)]).toBeCloseTo(125, 5)
    expect(p.count[indexOf(p, 2, 2)]).toBeCloseTo(0.4, 5)
  })

  it('names the mismatch when the two halves are for different resolutions', () => {
    // The commonest way to hold this format wrong: the 1 Mb matrix beside the
    // 500 kb bed. Both parse; only the pair is nonsense.
    const error = capture(() => parseMatrix(enc('1\t9\t3\n'), 5, 'big.matrix'))
    expect(error.message).toContain('different resolutions')
    expect(error.detail['nBins']).toBe(5)
  })

  it('sums a repeat, and drops a mirror — which are not the same duplicate', () => {
    // Two rows for one cell mean opposite things, and once both are on the
    // upper triangle they look identical. A file holding `(1,2)` twice on the
    // same side is two runs concatenated: that is more evidence, and dropping
    // it loses contacts. A file holding `(1,2)` and `(2,1)` is `complete`:
    // that is one contact stated twice, and adding it doubles the map.
    const repeat = parseMatrix(enc('1\t2\t4\n1\t2\t6\n'), 5, 'x')
    expect(repeat.nnz).toBe(1)
    expect(repeat.count[0]).toBe(10)

    const mirror = parseMatrix(enc('1\t2\t4\n2\t1\t4\n'), 5, 'x')
    expect(mirror.nnz).toBe(1)
    expect(mirror.count[0]).toBe(4)
    expect(mirror.observed).toBe('complete')
  })

  it('tolerates a last line with no newline on it', () => {
    expect(parseMatrix(enc('1\t1\t4\n2\t2\t6'), 5, 'x').nnz).toBe(2)
  })
})

/** Position of a cell in the parsed arrays. */
function indexOf(p: ReturnType<typeof parseMatrix>, row: number, col: number): number {
  for (let i = 0; i < p.nnz; i++) if (p.bin1[i] === row && p.bin2[i] === col) return i
  throw new Error(`no cell ${row},${col}`)
}

function capture(body: () => unknown): ViewerError {
  let thrown: unknown
  try {
    body()
  } catch (error) {
    thrown = error
  }
  expect(thrown, 'expected a refusal, got none').toBeInstanceOf(ViewerError)
  return thrown as ViewerError
}
