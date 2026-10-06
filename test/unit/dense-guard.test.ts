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
  denseCellCap,
  estimateBlockBytes,
  PIXEL_CHUNK_BYTES,
  readDenseMatrix,
  type MatrixSource,
} from '@/metacooler/matrix'
import type { Hdf5Handle } from '@/h5/api'
import { RASTER_MAX_DIM } from '@/render/heatmap'

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
  // The store is proxied for the same reason the handle is: the guard's whole
  // claim is that it refuses before *any* read, and a store that quietly
  // returned nothing would let a regression through as a pass.
  const store = new Proxy(
    {},
    {
      get(_target, property) {
        throw new Error(
          `the dense guard must refuse before touching the file (store.${String(property)})`,
        )
      },
    },
  ) as MatrixSource['store']
  return { handle, nBins, storageMode: 'symmetric-upper', store }
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
  it('refuses an oversized block before reading a single byte', async () => {
    const src = oversizedSource(422_967)
    await expect(
      readDenseMatrix(src, { rows: [0, 422_967] }, DENSE_HINTS.binSelection),
    ).rejects.toThrowError(
      'Refusing to allocate a 422967×422967 dense matrix (1431.2 GB). ' +
        'Use --range to select a smaller region, or --level contig.',
    )
  })

  it('judges a rectangular selection on its cell count, not its longest axis', async () => {
    const src = oversizedSource(200_000)
    // 20000 × 4000 = 8e7 cells and no axis past a canvas's side: it passes both
    // guards, so the read is attempted — which the proxy handle reports by
    // throwing. Its longest axis is still under `DENSE_MATRIX_BIN_LIMIT`, so
    // the cell-count rule is what let it through, not the axis rule.
    await expect(
      readDenseMatrix(src, { rows: [0, 20_000], cols: [0, 4_000] }, DENSE_HINTS.range),
    ).rejects.toThrowError(/must refuse before touching the file/)
    // 200000 × 13000 = 2.6e9 cells: over even the CLI-parity limit, so it never
    // gets that far.
    await expect(
      readDenseMatrix(src, { rows: [0, 200_000], cols: [0, 13_000] }, DENSE_HINTS.range),
    ).rejects.toThrowError(/Refusing to allocate a 200000×13000 dense matrix/)
    // 200000 × 12000 = 2.4e9 cells: under Python's limit and past what one
    // typed array can hold, so the browser guard is what answers — with the
    // ceiling, which is the truer of its two refusals for a block this size.
    await expect(
      readDenseMatrix(src, { rows: [0, 200_000], cols: [0, 12_000] }, DENSE_HINTS.range),
    ).rejects.toThrowError(/single array/)
    // 20000 × 12000 = 2.4e8 cells: 960 MB of values and a raster that has
    // stopped growing, so it is *inside* a 4 GiB machine's budget and the read
    // is attempted. It was refused when the estimate still charged a per-nnz
    // term for a read that is now windowed.
    await expect(
      readDenseMatrix(src, { rows: [0, 20_000], cols: [0, 12_000] }, DENSE_HINTS.range),
    ).rejects.toThrowError(/must refuse before touching the file/)
  })

  it('rejects a malformed bin range before the size check', async () => {
    const src = oversizedSource(1000)
    await expect(
      readDenseMatrix(src, { rows: [500, 100] }, DENSE_HINTS.range),
    ).rejects.toThrowError(/Bin range for rows is \[500, 100\)/)
    await expect(
      readDenseMatrix(src, { rows: [0, 2000] }, DENSE_HINTS.range),
    ).rejects.toThrowError(/Bin range for rows is \[0, 2000\)/)
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
    // limit refuses: 585 MB of values and, drawn a cell per pixel, 1.8 GB of
    // raster — inside the default budget.
    expect(() => checkBrowserDenseSize(12_100, 12_100, HINT)).not.toThrow()
    // A 1 GB machine cannot afford that raster, and is never asked to: its
    // reader pools a window that wide rather than reading it bin for bin.
    expect(denseCellCap(1e9)).toBeLessThan(12_100)
    expect(() =>
      checkBrowserDenseSize(denseCellCap(1e9), denseCellCap(1e9), HINT, { budgetBytes: 1e9 }),
    ).not.toThrow()
  })

  it('allows the largest block one array can hold, on a machine that reports 8 GiB', () => {
    // 23,000 bins, 5.3e8 cells: 2.1 GB of values, ~263 MB of raster and one
    // 36 MB read window. The estimate used to add a per-nnz term for a read that
    // is now windowed, and refused this on every engine.
    expect(() =>
      checkBrowserDenseSize(23_000, 23_000, HINT, { budgetBytes: (8 * 1024 ** 3) / 2 }),
    ).not.toThrow()
  })

  it('refuses a whole yeast genome at 500 bp — one array, not one machine', () => {
    // 24,322 bins is 2.4 GB of values, and no amount of RAM buys that in a
    // single `Float32Array`. Measured in Chrome on a 16 GB Mac:
    // 2,140,000,000 bytes is served, `2 ** 31 - 4` is refused, and four separate
    // 1 GB arrays live side by side — so the wall is the array, not the tab.
    //
    // This test asserted the opposite until the allocation was tried on a real
    // file: the guard it was checking is an estimate against a memory budget,
    // and passing it never meant the array could be made. The view now says so
    // before offering to compute, rather than after.
    expect(() =>
      checkBrowserDenseSize(24_322, 24_322, HINT, { budgetBytes: Number.POSITIVE_INFINITY }),
    ).toThrowError(/single array/)
  })

  it('states the ceiling as a limit of the tab, and says what does fit', () => {
    let message = ''
    try {
      checkBrowserDenseSize(24_322, 24_322, HINT, { budgetBytes: Number.POSITIVE_INFINITY })
    } catch (error) {
      message = (error as ViewerError).message
    }
    expect(message).toContain('2.1 GB in a single array')
    expect(message).toContain('not of this machine')
    // floor(sqrt(2 ** 31 / 4)) — the largest square block that can be allocated.
    expect(message).toContain('23170×23170')
    expect(message).toContain(HINT)
  })

  it('is not overridable, because no confirmation can change the answer', () => {
    // The gate and the "load anyway" button both work by setting the budget
    // aside. Neither may reach past this, and `where` is what tells the UI not
    // to offer a button that cannot work.
    try {
      checkBrowserDenseSize(30_000, 30_000, HINT, { budgetBytes: Number.POSITIVE_INFINITY })
      expect.unreachable()
    } catch (error) {
      expect((error as ViewerError).code).toBe('dense-too-large')
      expect((error as ViewerError).detail['where']).toBe('array-limit')
    }
  })

  it('never touches the file: the estimate is a closed form in the block shape', () => {
    // The proxy handle throws on any access, and this call has no handle at all
    // — which is the point. The old guard reached for `nnz` to decide.
    expect(estimateBlockBytes(1_000, 1_000)).toBe(
      1_000 * 1_000 * 4 + 1_000 * 1_000 * 12 + PIXEL_CHUNK_BYTES,
    )
  })

  it('charges the raster as a ceiling, not as something that grows', () => {
    // Past the raster cap the raster term stops growing; only the cells do. It
    // moves within the ceiling as the stride steps — 20,000 is drawn at 10,000²
    // and 40,000 at 13,334² — but never past the cap's 12 B a pixel.
    const ceiling = 12 * RASTER_MAX_DIM * RASTER_MAX_DIM
    for (const n of [16_384, 20_000, 40_000, 100_000]) {
      const raster = estimateBlockBytes(n, n) - n * n * 4 - PIXEL_CHUNK_BYTES
      expect(raster, `${n}`).toBeLessThanOrEqual(ceiling)
    }
    expect(ceiling).toBeLessThan(3.3e9)
  })

  it('says what it refused and what the limit is', () => {
    let message = ''
    try {
      // 1.6 GB of values: inside the single-array ceiling, so it is the budget
      // that answers — and the budget has to be named, because on the default
      // one this block now loads.
      checkBrowserDenseSize(20_000, 20_000, HINT, { budgetBytes: 1e9 })
    } catch (error) {
      message = (error as ViewerError).message
    }
    expect(message).toContain('20000×20000')
    expect(message).toContain('400 million cells')
    expect(message).toMatch(/needs about [\d.]+ GB/)
    expect(message).toMatch(/budgeting [\d.]+ GB/)
    expect(message).toContain(HINT)
  })

  it('lets a modest desktop block through, which is what the share is for', () => {
    // 20,000 bins on the default budget: three quarters of the 8 GiB fallback
    // is 6.4 GB against an estimate of 2.8. The old third of 4 GiB was 1.4 GB and refused
    // this, on the two engines that report no memory at all — which is most of
    // them.
    expect(() => checkBrowserDenseSize(20_000, 20_000, HINT)).not.toThrow()
  })

  it('does not grant a tiny device more than it has', () => {
    // deviceMemory is bucketed: 0.25 is a real value a small device reports. A
    // floor applied unconditionally handed it 1 GB — four times the machine.
    expect(denseBudgetFor(0.25)).toBeLessThan(0.25 * 1024 ** 3)
    expect(denseBudgetFor(0.5)).toBeLessThan(0.5 * 1024 ** 3)
    expect(denseBudgetFor(1)).toBeLessThan(1024 ** 3)
    // Three quarters of what the device claims, from the bucket where the floor
    // stops binding upwards. A machine reporting 16 — which Chrome now does —
    // gets 12.9 GB, and is stopped by the single-array ceiling long before that.
    expect(denseBudgetFor(2)).toBeCloseTo((2 * 1024 ** 3 * 3) / 4, 0)
    expect(denseBudgetFor(4)).toBeCloseTo((4 * 1024 ** 3 * 3) / 4, 0)
    expect(denseBudgetFor(8)).toBeCloseTo((8 * 1024 ** 3 * 3) / 4, 0)
    expect(denseBudgetFor(16)).toBeCloseTo((16 * 1024 ** 3 * 3) / 4, 0)
    // Never below what any machine can serve, whatever the share becomes.
    expect(denseBudgetFor(2)).toBeGreaterThanOrEqual(1e9)
  })

  it('carries the same code, so the UI keeps one refusal screen', () => {
    try {
      checkBrowserDenseSize(20_000, 20_000, HINT, { budgetBytes: 1e9 })
      expect.unreachable()
    } catch (error) {
      expect((error as ViewerError).code).toBe('dense-too-large')
      expect((error as ViewerError).detail['where']).toBe('browser')
    }
  })
})

/**
 * Which reads the ceiling still governs, now that the largest one has stopped
 * asking for a dense block at all.
 *
 * The whole-genome view reads pooled — the block is summed to the size the
 * renderer draws, so no bin count makes it too large (`pooling.test.ts`). What
 * remains dense is a region, a genome and a pair, and those are the blocks these
 * numbers are about.
 */
describe('what a dense read can still be asked for', () => {
  it('holds a whole yeast genome at 1 kb, which no view now asks for', () => {
    // 12,100 bins, 585 MB of values: allowed, and the whole-genome view no
    // longer requests it — it asks for the same map in 3 kb cells instead.
    expect(() => checkBrowserDenseSize(12_100, 12_100, HINT)).not.toThrow()
  })

  it('holds the largest region a chromosome view can select', () => {
    // A human chromosome at 25 kb is 9,960 bins and one bounded read.
    expect(() => checkBrowserDenseSize(9_960, 9_960, HINT)).not.toThrow()
  })

  it('still refuses one past the single-array ceiling, wherever it is asked from', () => {
    expect(() =>
      checkBrowserDenseSize(24_228, 24_228, HINT, { budgetBytes: Number.POSITIVE_INFINITY }),
    ).toThrowError(/single array/)
  })
})
