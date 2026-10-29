/**
 * The chromosight kernels, at the edges the demo data never reaches.
 *
 * `analysis-chromosight.test.ts` proves the whole pipeline against the package
 * itself over a real micro-C map, which is the test that matters. It cannot
 * prove the cases that map has none of — a focus of exactly one pixel, a window
 * that runs off the last bin, a correlation with a flat window, an FDR over
 * p-values that are all the same — and every one of those is a place a
 * transcription silently substitutes something reasonable for something exact.
 *
 * So these are hand-built: small matrices with a known answer, and one property
 * per test.
 */

import { describe, expect, it } from 'vitest'

import {
  DiagonalBand,
  correlate,
  correlateAt,
  corrToPvalue,
  denseContacts,
  detectableFromCounts,
  detectableFromWeights,
  detrend,
  distanceLaw,
  fdrCorrection,
  framedMissing,
  pickFoci,
  pileupOf,
  removeNeighbours,
  symmetrise,
  windowAt,
  windowPasses,
  winnowCalls,
  type Kernel,
} from '@/analysis/chromosight'

/** All bins detectable, which is the usual case on a well-covered contig. */
function allDetectable(n: number): Uint8Array {
  return new Uint8Array(n).fill(1)
}

describe('DiagonalBand', () => {
  it('answers zero outside the band rather than throwing', () => {
    // The convolution walks a template across the edge of the scanned region on
    // every pass; the cells past it are the zeros the sparse original does not
    // store, and a throw there would mean bounds checks in the inner loop.
    const band = new DiagonalBand(5, 0, 2)
    band.set(1, 3, 7)
    expect(band.at(1, 3)).toBe(7)
    expect(band.at(1, 4)).toBe(0)
    expect(band.at(3, 1)).toBe(0)
    expect(band.at(-1, 0)).toBe(0)
  })

  it('holds only the diagonals it was asked for', () => {
    const band = new DiagonalBand(100, 0, 3)
    expect(band.values.length).toBe(4 * 100)
  })
})

describe('distanceLaw', () => {
  it('averages the non-zero pixels of each diagonal and nothing else', () => {
    // Both restrictions are upstream's and both change the answer: a mean over
    // every cell would be a mean over the sparsity pattern too.
    const n = 4
    const values = new Float64Array(n * n)
    const put = (r: number, c: number, v: number): void => {
      values[r * n + c] = v
      values[c * n + r] = v
    }
    put(0, 1, 4)
    put(1, 2, 0)
    put(2, 3, 8)
    const law = distanceLaw(denseContacts(values, n), n, allDetectable(n), 3)
    expect(law[1]).toBe(6)
  })

  it('skips pairs where either bin is undetectable', () => {
    const n = 3
    const values = new Float64Array(n * n)
    values[0 * n + 1] = 100
    values[1 * n + 0] = 100
    values[1 * n + 2] = 2
    values[2 * n + 1] = 2
    const detectable = Uint8Array.from([1, 0, 1])
    // Every first-offset pair touches bin 1, so the diagonal has nothing left.
    expect(distanceLaw(denseContacts(values, n), n, detectable, 2)[1]).toBeNaN()
  })
})

describe('detrend', () => {
  it('divides by the diagonal mean and keeps the upper band only', () => {
    const n = 3
    const values = new Float64Array([1, 2, 3, 2, 1, 4, 3, 4, 1])
    const band = detrend(denseContacts(values, n), n, allDetectable(n), 2)
    // Offset 1 holds 2 and 4, so its mean is 3.
    expect(band.at(0, 1)).toBeCloseTo(2 / 3, 12)
    expect(band.at(1, 2)).toBeCloseTo(4 / 3, 12)
    // Nothing below the diagonal survives `remove_diags`.
    expect(band.at(1, 0)).toBe(0)
  })

  it('clamps an outlier — and a division by an empty diagonal — to one', () => {
    // The clamp reads as an outlier guard and is also the only thing standing
    // between an all-zero diagonal and an infinity in the scanned map.
    const n = 2
    const values = new Float64Array([0, 5, 5, 0])
    const band = detrend(denseContacts(values, n), n, allDetectable(n), 1, 2)
    // 5 / 5 = 1, below the clamp.
    expect(band.at(0, 1)).toBe(1)

    const spiky = new Float64Array([0, 1, 1, 0])
    const first = detrend(denseContacts(spiky, 2), 2, allDetectable(2), 1, 0.5)
    expect(first.at(0, 1)).toBe(1)
  })

  it('leaves a zero pixel at zero rather than dividing it', () => {
    const n = 3
    const values = new Float64Array([0, 0, 6, 0, 0, 0, 6, 0, 0])
    const band = detrend(denseContacts(values, n), n, allDetectable(n), 2)
    expect(band.at(0, 1)).toBe(0)
    expect(band.at(0, 2)).toBe(1)
  })
})

describe('framedMissing', () => {
  const n = 20
  const detectable = allDetectable(n)

  it('masks the sub-diagonal band a template would otherwise straddle', () => {
    expect(framedMissing(5, 4, n, detectable, 10, 7)).toBe(true)
    expect(framedMissing(12, 4, n, detectable, 10, 7)).toBe(false)
    expect(framedMissing(4, 5, n, detectable, 10, 7)).toBe(false)
  })

  it('masks an undetectable bin only inside the scan band', () => {
    const gapped = allDetectable(n)
    gapped[6] = 0
    expect(framedMissing(6, 8, n, gapped, 5, 7)).toBe(true)
    // Past the scan distance nothing is masked, because nothing is scanned.
    expect(framedMissing(6, 18, n, gapped, 5, 7)).toBe(false)
  })

  it('treats the pad below the square as present and the pad above as absent', () => {
    // The asymmetry is upstream's and it is not an oversight: this is an upper
    // triangle scanned within a band, and the corner left unmasked is one no
    // scanned window reaches.
    expect(framedMissing(-1, 3, n, detectable, 5, 7)).toBe(true)
    expect(framedMissing(n + 1, 3, n, detectable, 5, 7)).toBe(false)
  })
})

describe('correlateAt', () => {
  const size = 3
  const kernel: Kernel = { size, values: Float64Array.from([0, 1, 0, 1, 4, 1, 0, 1, 0]) }

  it('is one where the window is a positive multiple of the template', () => {
    // Clear of the diagonal, because a window that straddles it has the
    // sub-diagonal band masked out and is then a correlation over six cells
    // rather than nine — which is `framedMissing`'s job and is tested there.
    const n = 12
    const band = new DiagonalBand(n, 0, 11)
    const row = 3
    const col = 8
    for (let a = 0; a < size; a++) {
      for (let b = 0; b < size; b++) {
        band.set(row - 1 + a, col - 1 + b, kernel.values[a * size + b] * 3)
      }
    }
    const scored = correlateAt(band, n, allDetectable(n), kernel, row, col, {
      maxDist: 11,
      missingTol: 0.75,
    })
    expect(scored.corr).toBeCloseTo(1, 10)
    expect(scored.present).toBe(size * size)
  })

  it('scores zero on a flat window rather than dividing by nothing', () => {
    const n = 12
    const band = new DiagonalBand(n, 0, 11)
    for (let r = 0; r < n; r++) for (let c = r; c < n; c++) band.set(r, c, 2)
    expect(
      correlateAt(band, n, allDetectable(n), kernel, 3, 8, { maxDist: 11, missingTol: 0.75 }).corr,
    ).toBe(0)
  })

  it('refuses a window with more missing pixels than the tolerance allows', () => {
    const n = 12
    const band = new DiagonalBand(n, 0, 11)
    for (let r = 0; r < n; r++) for (let c = r; c < n; c++) band.set(r, c, r + c)
    const gapped = allDetectable(n)
    gapped[7] = 0
    gapped[8] = 0
    gapped[9] = 0
    const scored = correlateAt(band, n, gapped, kernel, 3, 8, { maxDist: 11, missingTol: 0 })
    expect(scored.corr).toBe(0)
    expect(scored.present).toBeLessThan(size * size)
  })
})

describe('correlate', () => {
  /** A band of contacts, sparse as a far diagonal is, with values in undetectable rows as a raw map has. */
  function contacts(n: number, hi: number, seed: number): DiagonalBand {
    let state = seed
    const next = (): number => {
      state = (state * 1_103_515_245 + 12_345) % 2 ** 31
      return state / 2 ** 31
    }
    const band = new DiagonalBand(n, 0, hi)
    for (let r = 0; r < n; r++) {
      for (let c = r; c <= Math.min(n - 1, r + hi); c++) if (next() < 0.6) band.set(r, c, next() * 3)
    }
    return band
  }

  it('scores every window exactly as correlateAt does, clean, gapped or at an edge', () => {
    const n = 48
    const kernel: Kernel = { size: 7, values: Float64Array.from({ length: 49 }, (_, i) => Math.sin(i * 1.7) + 0.2) }
    const gapped = allDetectable(n)
    for (const bin of [0, 5, 6, 19, 30, 31, 32, 47]) gapped[bin] = 0
    for (const detectable of [allDetectable(n), gapped]) {
      for (const [maxDist, hi, missingTol] of [
        [40, 47, 0.5],
        [12, 18, 0.5],
        [12, 18, 0.05],
        [3, 9, 0.9],
      ]) {
        const matrix = contacts(n, hi, maxDist + hi)
        const settings = { maxDist, missingTol }
        const band = correlate(matrix, n, detectable, kernel, settings)
        for (let row = 0; row < n; row++) {
          for (let offset = 0; offset <= band.hi && row + offset < n; offset++) {
            const want = correlateAt(matrix, n, detectable, kernel, row, row + offset, settings).corr
            expect(Object.is(band.values[offset * n + row], want), `${maxDist}, ${row}+${offset}`).toBe(true)
          }
        }
      }
    }
  })
})

describe('pickFoci', () => {
  function bandOf(n: number, cells: Array<[number, number, number]>): DiagonalBand {
    const band = new DiagonalBand(n, 0, n - 1)
    for (const [r, c, v] of cells) band.set(r, c, v)
    return band
  }

  it('takes one coordinate per island, at its maximum', () => {
    const band = bandOf(10, [
      [1, 2, 0.4],
      [1, 3, 0.9],
      [2, 3, 0.5],
      [7, 8, 0.8],
      [7, 9, 0.7],
    ])
    const foci = pickFoci(band, 0.3)
    expect(foci.map((focus) => [focus.row, focus.col])).toEqual([
      [1, 3],
      [7, 8],
    ])
  })

  it('drops a focus of a single pixel', () => {
    // `min_size` is 2 upstream, and it is what separates a loop from a bright
    // pixel — which on a correlation map is mostly noise.
    expect(pickFoci(bandOf(10, [[4, 6, 0.95]]), 0.3)).toHaveLength(0)
  })

  it('keeps the first maximum when two pixels tie', () => {
    // Upstream takes the first in row-major order, and a coarse map ties more
    // often than the arithmetic suggests.
    const foci = pickFoci(
      bandOf(10, [
        [1, 2, 0.5],
        [1, 3, 0.5],
      ]),
      0.3,
    )
    expect(foci).toHaveLength(1)
    expect([foci[0].row, foci[0].col]).toEqual([1, 2])
  })
})

describe('windowAt', () => {
  const n = 12
  const size = 5

  function ramp(): DiagonalBand {
    const band = new DiagonalBand(n, 0, n - 1)
    for (let r = 0; r < n; r++) for (let c = r; c < n; c++) band.set(r, c, r * 100 + c)
    return band
  }

  it('is as wide as the template and centred on the call', () => {
    const values = windowAt(ramp(), n, allDetectable(n), size, 6, 8)
    expect(values).not.toBeNull()
    expect(values!.length).toBe(size * size)
    expect(values![2 * size + 2]).toBe(6 * 100 + 8)
  })

  it('gaps the sub-diagonal triangle rather than averaging in its zeros', () => {
    const values = windowAt(ramp(), n, allDetectable(n), size, 6, 6)!
    // Two rows below the diagonal, which for a five-wide window is the
    // bottom-left corner.
    expect(values[4 * size + 0]).toBeNaN()
    expect(values[0 * size + 4]).toBe(4 * 100 + 8)
  })

  it('gaps a whole row and column for an undetectable bin', () => {
    const gapped = allDetectable(n)
    gapped[5] = 0
    const values = windowAt(ramp(), n, gapped, size, 6, 8)!
    for (let b = 0; b < size; b++) expect(values[1 * size + b]).toBeNaN()
  })

  it('drops a call on the last bin, and keeps one on the first', () => {
    // The asymmetry falls out of `half = size // 2 + 1` being one larger than
    // the pad the convolution ran in. It is upstream's, and it is why a pattern
    // at the very end of a contig never appears in either tool's output.
    expect(windowAt(ramp(), n, allDetectable(n), size, 0, 3)).not.toBeNull()
    expect(windowAt(ramp(), n, allDetectable(n), size, 3, n - 1)).toBeNull()
  })
})

describe('windowPasses', () => {
  it('counts gaps against the whole window and zeros against what is left', () => {
    // Two different denominators, which is what upstream does and is easy to
    // collapse into one: a window that is half gaps and half zeros is not 50%
    // zero, it is 100% zero of what could be seen.
    const values = Float64Array.from([Number.NaN, Number.NaN, 0, 4])
    expect(windowPasses(values, { missingTol: 0.75, zeroTol: 0.6 })).toBe(true)
    expect(windowPasses(values, { missingTol: 0.75, zeroTol: 0.4 })).toBe(false)
    expect(windowPasses(values, { missingTol: 0.4, zeroTol: 0.6 })).toBe(false)
  })
})

describe('pileupOf and symmetrise', () => {
  it('averages per cell, so a gap in one window costs only that cell', () => {
    const pileup = pileupOf(
      [
        Float64Array.from([1, Number.NaN, 0, 0]),
        Float64Array.from([3, 5, 0, 0]),
      ],
      2,
    )
    expect(pileup[0]).toBe(2)
    expect(pileup[1]).toBe(5)
  })

  it('folds a diagonal pattern onto itself without doubling the diagonal', () => {
    const values = Float64Array.from([1, 2, Number.NaN, 3])
    const folded = symmetrise(values, 2)
    expect(Array.from(folded)).toEqual([1, 2, 2, 3])
  })
})

describe('corrToPvalue', () => {
  it('is symmetric in the sign of the correlation', () => {
    expect(corrToPvalue(0.5, 289)).toBeCloseTo(corrToPvalue(-0.5, 289), 15)
  })

  it('matches the Fisher transformation at a known point', () => {
    // r = 0.3 over the 289 pixels of a 17x17 template — the commonest test this
    // whole module performs. The reference is scipy's, through chromosight's own
    // `corr_to_pval`, not this code: 1.6547553761888984e-07.
    expect(corrToPvalue(0.3, 289) / 1.6547553761888984e-7).toBeCloseTo(1, 12)
    // And far into the tail, where an approximation to Phi would flatten out.
    expect(corrToPvalue(0.5, 289) / 1.5485494368041547e-20).toBeCloseTo(1, 10)
  })

  it('stays finite far into the tail, where the FDR still has to sort', () => {
    const value = corrToPvalue(0.95, 289)
    expect(value).toBeGreaterThan(0)
    expect(value).toBeLessThan(1e-100)
  })

  it('has no p-value for a window of three pixels or fewer', () => {
    expect(corrToPvalue(0.9, 3)).toBeNaN()
  })
})

describe('fdrCorrection', () => {
  it('is Benjamini-Hochberg, monotone from the largest p-value down', () => {
    const q = fdrCorrection([0.01, 0.02, 0.03, 0.04])
    for (const value of q) expect(value).toBeCloseTo(0.04, 12)
  })

  it('never lets a weaker test out-rank a stronger one', () => {
    const q = Array.from(fdrCorrection([0.001, 0.5, 0.9]))
    expect(q[0]).toBeLessThanOrEqual(q[1])
    expect(q[1]).toBeLessThanOrEqual(q[2])
    expect(Math.max(...q)).toBeLessThanOrEqual(1)
  })

  it('gives no q-value to a test that produced no p-value', () => {
    const q = fdrCorrection([0.01, Number.NaN, 0.5])
    expect(q[1]).toBeNaN()
    expect(q[0]).toBeLessThan(1)
  })
})

describe('removeNeighbours', () => {
  it('keeps the best call of a cluster and drops the rest', () => {
    const kept = removeNeighbours(
      [
        { bin1: 10, bin2: 40, score: 0.4 },
        { bin1: 12, bin2: 41, score: 0.9 },
        { bin1: 60, bin2: 90, score: 0.5 },
      ],
      5,
    )
    expect(kept).toEqual([false, true, true])
  })

  it('needs both axes to be close before it calls two patterns one', () => {
    const kept = removeNeighbours(
      [
        { bin1: 10, bin2: 40, score: 0.9 },
        { bin1: 11, bin2: 80, score: 0.4 },
      ],
      5,
    )
    expect(kept).toEqual([true, true])
  })
})

describe('winnowCalls', () => {
  it('suppresses, then filters by distance, then corrects — in that order', () => {
    // The order is the whole reason the function exists: a call about to be
    // dropped for sitting too near the diagonal must not enlarge the correction
    // applied to the ones that survive.
    const calls = [
      { bin1: 0, bin2: 5, score: 0.9, pvalue: 0.01 },
      { bin1: 100, bin2: 400, score: 0.8, pvalue: 0.02 },
      { bin1: 101, bin2: 401, score: 0.5, pvalue: 0.03 },
    ]
    // The floor is a number of **bins** where it was a length in base pairs and
    // a bin size: twenty bins is the 20 kb this asked for on the 1 kb map it
    // asked for it on, and the same call is dropped.
    const { kept, qvalues } = winnowCalls(calls, { separationBins: 5, minDistBins: 20 })
    // The near-diagonal call goes for being five bins from it; the third is a
    // neighbour of the second.
    expect(kept.map((call) => call.bin1)).toEqual([100])
    // One surviving test, so BH leaves its p-value alone.
    expect(qvalues[0]).toBeCloseTo(0.02, 12)
  })
})

describe('detectable bins', () => {
  it('reads the balancer’s own verdict where there is one', () => {
    const weights = Float64Array.from([0.5, Number.NaN, 0.2, 0.1])
    expect(Array.from(detectableFromWeights(weights, 1, 4))).toEqual([0, 1, 1])
  })

  it('falls back to coverage, in median absolute deviations', () => {
    // A row of zeros against three well-covered ones: the MAD rule has to
    // exclude it, and the floor of one non-zero pixel has to exclude an empty
    // bin even where the deviation is large enough to swallow it.
    const n = 4
    const values = new Float64Array(n * n).fill(1)
    for (let i = 0; i < n; i++) {
      values[2 * n + i] = 0
      values[i * n + 2] = 0
    }
    const detectable = detectableFromCounts(values, n, 1)
    expect(detectable[2]).toBe(0)
    expect(detectable[0]).toBe(1)
  })
})
