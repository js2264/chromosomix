/**
 * The correlation map: `correlationMatrix` put back on the grid it came from.
 *
 * Two properties carry the whole thing, and both are about the bins that were
 * *not* correlated rather than the ones that were.
 *
 * **A dropped bin comes back as a gap.** `analysis/compartments.ts` opens by
 * saying why a dropped bin must not be zeroed: a zero row asserts that its bin
 * is uncorrelated with everything, which is a strong and false claim. That
 * argument is about the eigenvector, where a zeroed row bends the component; on
 * a *map* it is more visible and no less wrong — a stripe of "uncorrelated"
 * across a compartment checkerboard, in the one colour that means something
 * definite.
 *
 * **The expansion has to land on the right cells.** The correlation is computed
 * over a packed submatrix of the usable bins, so every value comes back at an
 * index that is not its own. Getting that mapping wrong produces a picture that
 * is entirely plausible — a symmetric matrix with a unit diagonal and structure
 * in it — and is of the wrong bins. A round trip through a block with known
 * holes is the only thing that catches it.
 */

import { describe, expect, it } from 'vitest'

import { correlationField, correlationMatrix, usableBins } from '@/analysis/compartments'

/**
 * A square whose rows fall into two groups that contact the genome in opposite
 * patterns — a two-compartment toy, which is what the map is for.
 */
function checkerboard(n: number, holes: readonly number[] = []): Float32Array {
  const values = new Float32Array(n * n)
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      // Same group contacts more, opposite group less.
      values[r * n + c] = (r % 2) === (c % 2) ? 2 : 0.5
    }
  }
  for (const hole of holes) {
    for (let i = 0; i < n; i++) {
      values[hole * n + i] = Number.NaN
      values[i * n + hole] = Number.NaN
    }
  }
  return values
}

describe('correlationField', () => {
  it('is symmetric with a unit diagonal over the bins that took part', async () => {
    const n = 12
    const field = await correlationField(checkerboard(n), n)
    expect(field.kept).toBe(n)
    expect(field.dropped).toBe(0)
    for (let r = 0; r < n; r++) {
      expect(field.values[r * n + r]).toBe(1)
      for (let c = 0; c < n; c++) {
        expect(field.values[r * n + c]).toBeCloseTo(field.values[c * n + r], 6)
      }
    }
  })

  it('finds the two compartments: same group +1, opposite group −1', async () => {
    const n = 12
    const { values } = await correlationField(checkerboard(n), n)
    // Rows 0 and 2 are the same group; rows 0 and 1 are opposite.
    expect(values[0 * n + 2]).toBeCloseTo(1, 6)
    expect(values[0 * n + 1]).toBeCloseTo(-1, 6)
  })

  it('leaves a dropped bin blank rather than zero, in its row and its column', async () => {
    const n = 12
    const holes = [3, 7]
    const field = await correlationField(checkerboard(n, holes), n)
    expect(field.kept).toBe(n - holes.length)
    expect(field.dropped).toBe(holes.length)

    for (const hole of holes) {
      for (let i = 0; i < n; i++) {
        expect(field.values[hole * n + i]).toBeNaN()
        expect(field.values[i * n + hole]).toBeNaN()
      }
    }
    // Everything else was still correlated — a hole does not blank its neighbours.
    expect(field.values[0 * n + 2]).toBeCloseTo(1, 6)
    expect(field.values[4 * n + 4]).toBe(1)
  })

  it('puts each correlation back on the bins it was measured between', async () => {
    // The expansion is the step that can be plausibly wrong, so it is checked
    // against the packed matrix directly rather than against a property.
    const n = 10
    const holes = [1, 6]
    const values = checkerboard(n, holes)
    const field = await correlationField(values, n)

    const index = usableBins(values, n)
    const m = index.length
    const packed = new Float64Array(m * m)
    for (let r = 0; r < m; r++) {
      for (let c = 0; c < m; c++) packed[r * m + c] = values[index[r] * n + index[c]]
    }
    const direct = await correlationMatrix(packed, m)

    for (let r = 0; r < m; r++) {
      for (let c = 0; c < m; c++) {
        expect(field.values[index[r] * n + index[c]]).toBeCloseTo(direct[r * m + c], 5)
      }
    }
  })

  it('reports progress per row, which is what makes it cancellable', async () => {
    const n = 8
    const rows: number[] = []
    await correlationField(checkerboard(n), n, (row) => {
      rows.push(row)
    })
    expect(rows).toStrictEqual([...Array(n).keys()])
  })

  it('draws nothing rather than throwing when the block has nothing usable', async () => {
    const n = 6
    const field = await correlationField(new Float32Array(n * n).fill(Number.NaN), n)
    expect(field.kept).toBe(0)
    expect(field.dropped).toBe(n)
    expect([...field.values].every(Number.isNaN)).toBe(true)
  })
})
