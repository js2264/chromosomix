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
    // 200000 × 12000 = 2.4e9 cells: under Python's limit, and past what a
    // single Float32Array can be — so the browser guard answers, and with the
    // one refusal no budget can argue with.
    expect(() =>
      readDenseMatrix(src, { rows: [0, 200_000], cols: [0, 12_000] }, DENSE_HINTS.range),
    ).toThrowError(/single typed array/)
    // 20000 × 12000 = 2.4e8 cells: inside the array limit and outside a laptop's
    // budget, so this is the estimate talking.
    expect(() =>
      readDenseMatrix(src, { rows: [0, 20_000], cols: [0, 12_000] }, DENSE_HINTS.range),
    ).toThrowError(/browser tab/)
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
    // limit refuses and which actually costs about 1.2 GB pessimistically and
    // far less once the file's sparsity is known.
    expect(() => checkBrowserDenseSize(12_100, 12_100, HINT, { budgetBytes: 2e9 })).not.toThrow()
    // And with a real nnz — a few million non-zero pixels — it fits a laptop.
    expect(() =>
      checkBrowserDenseSize(12_100, 12_100, HINT, {
        budgetBytes: 1e9,
        nonZero: () => 8_000_000,
      }),
    ).not.toThrow()
  })

  it('asks the file how sparse it is only when the pessimistic estimate fails', () => {
    let asked = 0
    const nonZero = (): number => {
      asked++
      return 1_000
    }
    // Comfortably inside the budget: decided without touching the file.
    checkBrowserDenseSize(1_000, 1_000, HINT, { budgetBytes: 1e9, nonZero })
    expect(asked).toBe(0)
    // Over it pessimistically, rescued by the real sparsity.
    checkBrowserDenseSize(12_000, 12_000, HINT, { budgetBytes: 1e9, nonZero })
    expect(asked).toBe(1)
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
