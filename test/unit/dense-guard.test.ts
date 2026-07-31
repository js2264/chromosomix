/**
 * The dense-size refusal (spec §5.2, §10; M2 task 2).
 *
 * `DENSE_MATRIX_BIN_LIMIT` and the sentence that quotes it are part of the
 * *user interface*, not an internal detail: someone who hits the limit in the
 * browser and someone who hits it in `metacooler show` must be able to search
 * for the same string and find the same answer. So every literal below was
 * produced by Python, by calling `metacooler.ops.show._check_dense_size`
 * directly, and pasted in unchanged.
 *
 * The limit is an **element count** (`DENSE_MATRIX_BIN_LIMIT ** 2` cells), not
 * a per-axis bound, so a rectangular selection is judged on what is actually
 * about to be allocated. `50_000 × 50_000` is therefore allowed and
 * `100_000 × 25_001` is not, even though the second is narrower on one axis.
 */

import { describe, expect, it } from 'vitest'

import { DENSE_MATRIX_BIN_LIMIT } from '@/constants'
import { ViewerError } from '@/errors'
import {
  checkDenseSize,
  DENSE_HINTS,
  readDenseMatrix,
  type MatrixSource,
} from '@/metacooler/matrix'
import type { Hdf5Handle } from '@/h5/api'

/**
 * A source large enough to trip the guard, with a handle that throws.
 *
 * The point of the guard is that it refuses *before* allocating and before
 * reading: any read at all on this handle fails the test by throwing something
 * other than a `ViewerError`.
 */
function oversizedSource(nBins: number): MatrixSource {
  const handle = new Proxy(
    {},
    {
      get(_target, property) {
        throw new Error(
          `the dense guard must refuse before touching the file (h5.${String(property)})`,
        )
      },
    },
  ) as Hdf5Handle
  return { handle, nBins, storageMode: 'symmetric-upper' }
}

describe('checkDenseSize', () => {
  it('mirrors the Python constant', () => {
    expect(DENSE_MATRIX_BIN_LIMIT).toBe(50_000)
  })

  it('allows exactly the limit, in either shape', () => {
    // 2.5e9 cells on the nose — `>` in Python, so this is allowed.
    expect(() => checkDenseSize(50_000, 50_000, DENSE_HINTS.range)).not.toThrow()
    expect(() => checkDenseSize(100_000, 25_000, DENSE_HINTS.range)).not.toThrow()
    expect(() => checkDenseSize(0, 0, DENSE_HINTS.range)).not.toThrow()
  })

  it('refuses one cell over the limit, with the CLI wording', () => {
    // Verbatim from `_check_dense_size(100_000, 25_001, ...)`.
    expect(() => checkDenseSize(100_000, 25_001, DENSE_HINTS.contig)).toThrowError(
      'Refusing to allocate a 100000×25001 dense matrix (20.0 GB). ' +
        'Use --level genome, --genomes/--contigs, or a smaller file.',
    )
  })

  it('formats the size the way Python does', () => {
    // `{gb:.1f}` and `toFixed(1)`, over `n_rows * n_cols * 8 / 1e9`.
    expect(() => checkDenseSize(60_000, 60_000, DENSE_HINTS.range)).toThrowError(
      'Refusing to allocate a 60000×60000 dense matrix (28.8 GB). ' +
        'Use a narrower --range/--range2.',
    )
    // The real reference file: 422967 bins, i.e. every bin of Hum53.metacool.
    expect(() => checkDenseSize(422_967, 422_967, DENSE_HINTS.binSelection)).toThrowError(
      'Refusing to allocate a 422967×422967 dense matrix (1431.2 GB). ' +
        'Use --range to select a smaller region, or --level contig.',
    )
  })

  it('carries the typed code and the actual numbers', () => {
    try {
      checkDenseSize(60_000, 60_000, DENSE_HINTS.range)
      expect.fail('expected a refusal')
    } catch (err) {
      expect(err).toBeInstanceOf(ViewerError)
      const error = err as ViewerError
      expect(error.code).toBe('dense-too-large')
      // §10: the refusal names the file's actual state, machine-readably, so
      // the UI does not have to parse the prose it shows the user.
      expect(error.detail).toEqual({ nRows: 60_000, nCols: 60_000, limit: 50_000 })
    }
  })

  it('offers exactly the four hints `ops/show.py` uses', () => {
    expect(DENSE_HINTS).toEqual({
      genome: 'Use a smaller file.',
      contig: 'Use --level genome, --genomes/--contigs, or a smaller file.',
      range: 'Use a narrower --range/--range2.',
      binSelection: 'Use --range to select a smaller region, or --level contig.',
    })
  })
})

describe('readDenseMatrix', () => {
  it('refuses an oversized block before reading a single byte', () => {
    const src = oversizedSource(422_967)
    expect(() =>
      readDenseMatrix(src, { rows: [0, 422_967] }, DENSE_HINTS.binSelection),
    ).toThrowError(
      'Refusing to allocate a 422967×422967 dense matrix (1431.2 GB). ' +
        'Use --range to select a smaller region, or --level contig.',
    )
  })

  it('judges a rectangular selection on its cell count, not its longest axis', () => {
    const src = oversizedSource(200_000)
    // 200000 × 12000 = 2.4e9 cells: under the limit, so the guard passes and
    // the read is attempted — which the proxy handle reports by throwing.
    expect(() => readDenseMatrix(src, { rows: [0, 200_000], cols: [0, 12_000] }, DENSE_HINTS.range))
      .toThrowError(/must refuse before touching the file/)
    // 200000 × 13000 = 2.6e9 cells: over, so it never gets that far.
    expect(() =>
      readDenseMatrix(src, { rows: [0, 200_000], cols: [0, 13_000] }, DENSE_HINTS.range),
    ).toThrowError(/Refusing to allocate a 200000×13000 dense matrix/)
  })

  it('rejects a malformed bin range before the size check', () => {
    const src = oversizedSource(1000)
    expect(() => readDenseMatrix(src, { rows: [500, 100] }, DENSE_HINTS.range)).toThrowError(
      /Bin range for rows is \[500, 100\)/,
    )
    expect(() => readDenseMatrix(src, { rows: [0, 2000] }, DENSE_HINTS.range)).toThrowError(
      /Bin range for rows is \[0, 2000\)/,
    )
  })
})
