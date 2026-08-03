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
  checkBrowserDenseSize,
  checkDenseSize,
  DENSE_HINTS,
  denseBudgetFor,
  estimateBlockBytes,
  PIXEL_CHUNK_BYTES,
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
    // 20000 × 4000 = 8e7 cells and no axis past a canvas's side: it passes both
    // guards, so the read is attempted — which the proxy handle reports by
    // throwing. Its longest axis is still under `DENSE_MATRIX_BIN_LIMIT`, so
    // the cell-count rule is what let it through, not the axis rule.
    expect(() => readDenseMatrix(src, { rows: [0, 20_000], cols: [0, 4_000] }, DENSE_HINTS.range))
      .toThrowError(/must refuse before touching the file/)
    // 200000 × 13000 = 2.6e9 cells: over even the CLI-parity limit, so it never
    // gets that far.
    expect(() =>
      readDenseMatrix(src, { rows: [0, 200_000], cols: [0, 13_000] }, DENSE_HINTS.range),
    ).toThrowError(/Refusing to allocate a 200000×13000 dense matrix/)
    // 200000 × 12000 = 2.4e9 cells: under Python's limit and far past any tab's
    // budget, so the browser guard is what answers.
    expect(() =>
      readDenseMatrix(src, { rows: [0, 200_000], cols: [0, 12_000] }, DENSE_HINTS.range),
    ).toThrowError(/browser tab/)
    // 20000 × 12000 = 2.4e8 cells: 960 MB of values and a raster that has
    // stopped growing, so it is *inside* a 4 GiB machine's budget and the read
    // is attempted. It was refused when the estimate still charged a per-nnz
    // term for a read that is now windowed.
    expect(() => readDenseMatrix(src, { rows: [0, 20_000], cols: [0, 12_000] }, DENSE_HINTS.range))
      .toThrowError(/must refuse before touching the file/)
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

const HINT = DENSE_HINTS.range

describe('the browser guard, which is stricter than the CLI', () => {
  it('refuses what the CLI-parity limit allows', () => {
    // 50,000 x 50,000 is exactly what `checkDenseSize` permits, and it is 40 GB
    // of live bytes on screen plus a raster nine times a canvas's area cap.
    expect(() => checkDenseSize(50_000, 50_000, HINT)).not.toThrow()
    expect(() => checkBrowserDenseSize(50_000, 50_000, HINT)).toThrow(ViewerError)
  })

  it('refuses a human chromosome at 5 kb, which is the case §9 promises to refuse', () => {
    // chr1 is 248,956,422 bp: 49,792 bins, 2.479e9 cells — under Python's limit.
    expect(() => checkDenseSize(49_792, 49_792, HINT)).not.toThrow()
    expect(() => checkBrowserDenseSize(49_792, 49_792, HINT)).toThrow(/Refusing to load/)
  })

  it('allows the largest MAG anyone actually opens', () => {
    // ~6,600 bins is the biggest genome in the Hum53 reference file at 1 kb.
    expect(() => checkBrowserDenseSize(6_600, 6_600, HINT)).not.toThrow()
    expect(() => checkBrowserDenseSize(10_000, 10_000, HINT)).not.toThrow()
  })

  it('allows a whole yeast genome at 1 kb, which is the point of the estimate', () => {
    // 12.1 Mb at 1 kb is 12,100 bins: 1.46e8 cells, which every round fixed
    // limit refuses and which costs 585 MB of values plus a bounded raster.
    expect(() => checkBrowserDenseSize(12_100, 12_100, HINT, { budgetBytes: 1e9 })).not.toThrow()
  })

  it('allows a whole yeast genome at 500 bp on a machine that reports 8 GiB', () => {
    // 24,322 bins, 5.9e8 cells: 2.37 GB of values, ~263 MB of raster and one
    // 36 MB read window. The estimate used to add a per-nnz term for a read that
    // is now windowed, and refused this on every engine.
    expect(() =>
      checkBrowserDenseSize(24_322, 24_322, HINT, { budgetBytes: (8 * 1024 ** 3) / 3 }),
    ).not.toThrow()
  })

  it('never touches the file: the estimate is a closed form in the block shape', () => {
    // The proxy handle throws on any access, and this call has no handle at all
    // — which is the point. The old guard reached for `nnz` to decide.
    expect(estimateBlockBytes(1_000, 1_000)).toBe(
      1_000 * 1_000 * 4 + 1_000 * 1_000 * 16 + PIXEL_CHUNK_BYTES,
    )
  })

  it('charges the raster as a ceiling, not as something that grows', () => {
    // Past the pooling cap the raster term stops moving; only the cells do.
    const a = estimateBlockBytes(20_000, 20_000)
    const b = estimateBlockBytes(40_000, 40_000)
    const rasterA = a - 20_000 * 20_000 * 4 - PIXEL_CHUNK_BYTES
    const rasterB = b - 40_000 * 40_000 * 4 - PIXEL_CHUNK_BYTES
    expect(rasterB).toBeLessThanOrEqual(rasterA * 1.01)
    expect(rasterB).toBeLessThan(300e6)
  })

  it('says what it refused and what the limit is', () => {
    let message = ''
    try {
      checkBrowserDenseSize(20_000, 20_000, HINT)
    } catch (error) {
      message = (error as ViewerError).message
    }
    expect(message).toContain('20000×20000')
    expect(message).toContain('400 million cells')
    expect(message).toMatch(/needs about [\d.]+ GB/)
    expect(message).toMatch(/budgeting [\d.]+ GB/)
    expect(message).toContain(HINT)
  })

  it('does not grant a tiny device more than it has', () => {
    // deviceMemory is bucketed: 0.25 is a real value a small device reports. A
    // floor applied unconditionally handed it 1 GB — four times the machine.
    expect(denseBudgetFor(0.25)).toBeLessThan(0.25 * 1024 ** 3)
    expect(denseBudgetFor(0.5)).toBeLessThan(0.5 * 1024 ** 3)
    expect(denseBudgetFor(1)).toBeLessThan(1024 ** 3)
    // At and above 2 GiB the floor is the correction it was written to be.
    expect(denseBudgetFor(2)).toBe(1e9)
    expect(denseBudgetFor(4)).toBeCloseTo((4 * 1024 ** 3) / 3, 0)
    expect(denseBudgetFor(8)).toBeCloseTo((8 * 1024 ** 3) / 3, 0)
  })

  it('carries the same code, so the UI keeps one refusal screen', () => {
    try {
      checkBrowserDenseSize(50_000, 50_000, HINT)
      expect.unreachable()
    } catch (error) {
      expect((error as ViewerError).code).toBe('dense-too-large')
      expect((error as ViewerError).detail['where']).toBe('browser')
    }
  })
})
