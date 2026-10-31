import { describe, expect, it } from 'vitest'

import {
  ARROWHEAD_DEFAULTS,
  arrowheadWindows,
  callDomains,
  highScoreHash,
  javaDoubleCompare,
  javaDoubleHash,
  javaHashSetOrder,
  javaPointHash,
  lowSignThresholds,
} from '@/analysis/arrowhead'

const DOMAINS: Array<[number, number]> = [
  [40, 120],
  [150, 200],
  [210, 280],
]

/** A sequence whose contacts fall away with distance and are three times as strong inside each domain. */
function contacts(): (i: number, j: number) => number {
  return (i, j) => {
    let value = 100 / (Math.abs(i - j) + 1)
    for (const [from, to] of DOMAINS) if (i >= from && i < to && j >= from && j < to) value *= 3
    return value
  }
}

function reader() {
  const at = contacts()
  return async (from: number, to: number): Promise<Float32Array> => {
    const n = to - from
    const out = new Float32Array(n * n)
    for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) out[r * n + c] = at(from + r, from + c)
    return out
  }
}

describe('Arrowhead', () => {
  it('slides its windows as BlockBuster does, the last one read from limStart', () => {
    expect(arrowheadWindows(2500, 2000)).toEqual([
      { limStart: 0, limEnd: 2000, n: 2001 },
      { limStart: 1000, limEnd: 2500, n: 2001 },
      { limStart: 2000, limEnd: 2500, n: 2001 },
    ])
    expect(arrowheadWindows(800, 2000)).toEqual([{ limStart: 0, limEnd: 800, n: 801 }])
  })

  it('steps the lenient pass down in Java’s doubles', () => {
    expect(lowSignThresholds(ARROWHEAD_DEFAULTS)).toEqual([
      0.4, 0.30000000000000004, 0.20000000000000004, 0.10000000000000003, 2.7755575615628914e-17,
    ])
  })

  it('finds the domains a synthetic map was built with, at the corner of each', async () => {
    const found = await callDomains(300, 1000, reader(), { ...ARROWHEAD_DEFAULTS, matrixSize: 300 })
    // A corner is the domain's first bin and its last: (from, to − 1), in base pairs.
    const corners = found.map((score) => `${score.i / 1000}-${score.j / 1000}`).sort()
    expect(corners).toEqual(DOMAINS.map(([from, to]) => `${from}-${to - 1}`).sort())
    // Sorted as Juicer writes them: by summed variance, highest first.
    for (let k = 1; k < found.length; k++) {
      expect(found[k - 1].uVarScore + found[k - 1].lVarScore).toBeGreaterThanOrEqual(
        found[k].uVarScore + found[k].lVarScore,
      )
    }
  })

  it('calls nothing on a map with no domains', async () => {
    const flat = async (from: number, to: number): Promise<Float32Array> => {
      const n = to - from
      const out = new Float32Array(n * n)
      for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) out[r * n + c] = 100 / (Math.abs(r - c) + 1)
      return out
    }
    expect(await callDomains(300, 1000, flat, { ...ARROWHEAD_DEFAULTS, matrixSize: 300 })).toEqual([])
  })
})

describe('Java’s hashing, where the order of a HashSet decides a result', () => {
  it('hashes a double as Double.hashCode does', () => {
    // Double.valueOf(1.0).hashCode(), Double.valueOf(-0.0).hashCode(), and 0.5's.
    expect(javaDoubleHash(1)).toBe(1072693248)
    expect(javaDoubleHash(-0)).toBe(-2147483648)
    expect(javaDoubleHash(0)).toBe(0)
    expect(javaDoubleHash(0.5)).toBe(1071644672)
    expect(javaDoubleHash(Number.NaN)).toBe(2146959360)
  })

  it('hashes a HighScore as juicer_tools 1.22.01 does', () => {
    // 7 · (i + j) · (int) ⌊score + uVarScore + lVarScore + upSign + loSign⌋, read off the jar's
    // bytecode; Juicer's own HashSet of chromosome 21's lenient blocks gives 14784 for this one.
    expect(highScoreHash({ i: 521, j: 535, score: 1.2, uVarScore: 0.1, lVarScore: 0.1, upSign: 0.3, loSign: 0.3 })).toBe(14784)
    expect(highScoreHash({ i: 1, j: 2, score: Number.NaN, uVarScore: 0, lVarScore: 0, upSign: 0, loSign: 0 })).toBe(0)
  })

  it('iterates a HashSet whose crowded bucket became a tree as Java does', () => {
    // Nine items in one bucket of a 16-slot table: the ninth makes Java grow the
    // table (a tree needs 64 slots), and it is still a list, in arrival order.
    const items = Array.from({ length: 9 }, (_, k) => k)
    expect(javaHashSetOrder(items, () => 0, String, (a, b) => a - b)).toEqual(items)
  })

  it('hashes a cell as java.awt.Point does', () => {
    // Point2D.hashCode: bits(x) ^ bits(y) · 31 in 64 bits, folded. For (1, 2):
    // 0x4000… · 31 wraps to 0xC000…, and 0x3FF0… ^ 0xC000… = 0xFFF0…, whose
    // high word is the hash.
    expect(javaPointHash(0, 0)).toBe(0)
    expect(javaPointHash(1, 2)).toBe(0xfff00000 | 0)
  })

  it('compares doubles as Double.compare does', () => {
    expect(javaDoubleCompare(-0, 0)).toBe(-1)
    expect(javaDoubleCompare(Number.NaN, Number.POSITIVE_INFINITY)).toBe(1)
    expect(javaDoubleCompare(1, 1)).toBe(0)
  })

  it('iterates a HashSet by bucket, each bucket in the order it was filled', () => {
    // Twelve or fewer items make a table of 16, so the hash's low four bits
    // (after the spread) are the bucket.
    const items = [17, 3, 1, 33, 2]
    const order = javaHashSetOrder(items, (x) => x, String)
    expect(order).toEqual([17, 1, 33, 2, 3])
    // Duplicates after the first are not added.
    expect(javaHashSetOrder([5, 5, 4], (x) => x, String)).toEqual([4, 5])
  })
})
