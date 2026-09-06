/**
 * Serpentine binning, and the four things that separate it from the filter.
 *
 * `smooth.ts` is tested for its bandwidth. This is tested for the things a
 * *partition* has and a window does not: regions that are not square, a target
 * met with no cap on how far it may grow, and a merge rule that has to be shown
 * not to cascade — because the obvious one does, and it took the whole block
 * into a single region before anybody looked at a picture.
 */

import { describe, expect, it } from 'vitest'

import { deriveBlock } from '@/render/derive'
import { MAX_SAMPLED_CELLS, serpentineBin } from '@/render/serpentine'
import { parseSmooth } from '@/render/smooth'

const EVIDENCE = {
  target: 50,
  merge: 'evidence',
  iterations: 1,
  seed: 1,
  name: 'medium',
} as const
const SAMPLED = { ...EVIDENCE, merge: 'sampled', iterations: 3 } as const

function square(n: number, values: Float32Array) {
  return {
    nrows: n,
    ncols: n,
    values,
    rowExtent: [0, n] as [number, number],
    colExtent: [0, n] as [number, number],
  }
}

/** A sparse map with a steep decay, which is where binning earns its keep. */
function decay(n: number, seed = 5) {
  let a = seed
  const next = (): number => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
  const values = new Float32Array(n * n)
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      const lambda = (1200 / n) * Math.pow(Math.abs(i - j) + 1, -1.1)
      let k = 0
      let p = 1
      const limit = Math.exp(-lambda)
      while (p > limit && k < 60) {
        p *= next()
        k++
      }
      values[i * n + j] = Math.max(0, k - 1)
    }
  }
  return values
}

describe('serpentineBin', () => {
  it('does not collapse the block into one region', async () => {
    // The regression that matters most. Absorbing the richest neighbour is the
    // obvious greedy rule, and because the richest neighbour has almost always
    // met the threshold already, every needy region ate a satisfied one and the
    // whole block cascaded into a single region — 707,281 cells, one value.
    const n = 120
    const values = decay(n)
    const out = await serpentineBin(square(n, values), values, EVIDENCE)
    expect(out.regions).toBeGreaterThan(20)
    expect(out.regions).toBeLessThan(n * n)
    const distinct = new Set(Array.from(out.values).filter((v) => Number.isFinite(v)))
    expect(distinct.size).toBeGreaterThan(20)
  })

  it('grows a region along a stripe rather than across it', async () => {
    // The thing a box window cannot do. A faint stripe over a faint background:
    // a window centred on the stripe averages it with the background either
    // side, while a region grows *along* it, because that is where the evidence
    // is. Both are below the threshold on their own, so the region has to choose
    // a direction — which is the whole question.
    const n = 41
    const values = new Float32Array(n * n).fill(0.05)
    const row = 20
    for (let c = 0; c < n; c++) values[row * n + c] = 1
    const out = (await serpentineBin(square(n, values), values, { ...EVIDENCE, target: 30 })).values

    // Cells along the stripe land in one region together…
    expect(out[row * n + 10]).toBeCloseTo(out[row * n + 11], 6)
    // …and the cell directly above is in a different, fainter one, so the region
    // followed the stripe instead of straddling it.
    expect(out[(row - 1) * n + 10]).toBeLessThan(out[row * n + 10])
    // The stripe still reads as a stripe rather than as its counts spread over a
    // square that is mostly background.
    expect(out[row * n + 10]).toBeGreaterThan(0.5)
  })

  it('is deterministic under the evidence rule, and reproducible under sampling', async () => {
    const n = 90
    const values = decay(n)
    const b = square(n, values)
    const a1 = (await serpentineBin(b, values, EVIDENCE)).values
    const a2 = (await serpentineBin(b, values, EVIDENCE)).values
    expect(Array.from(a1)).toEqual(Array.from(a2))

    // §18.4: same seed, same figure. The sampled rule is random and must still
    // come out the same twice, or nobody can reproduce a panel made with it.
    const b1 = (await serpentineBin(b, values, SAMPLED)).values
    const b2 = (await serpentineBin(b, values, SAMPLED)).values
    expect(Array.from(b1)).toEqual(Array.from(b2))
    // …and a different seed is a different partition, or the seed is decorative.
    const b3 = (await serpentineBin(b, values, { ...SAMPLED, seed: 99 })).values
    expect(Array.from(b3)).not.toEqual(Array.from(b1))
  })

  it('keeps a symmetric block symmetric', async () => {
    // Binned over the whole square, a symmetric matrix would grow two
    // independent partitions of the same data and draw a map that disagreed
    // with its own transpose.
    const n = 70
    const values = decay(n)
    for (let i = 0; i < n; i++) for (let j = 0; j < i; j++) values[j * n + i] = values[i * n + j]
    const out = (await serpentineBin(square(n, values), values, EVIDENCE)).values
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) {
        expect(out[i * n + j]).toBe(out[j * n + i])
      }
    }
  })

  it('averages a second field over the same regions', async () => {
    // What makes the O/E possible: numerator and denominator over exactly the
    // same cells. Given a constant baseline the ratio is that constant
    // everywhere, which is only true if both were binned identically.
    const n = 60
    const values = decay(n)
    const baseline = new Float32Array(n * n).fill(4)
    const out = await serpentineBin(square(n, values), values, EVIDENCE, baseline)
    expect(out.over).not.toBeNull()
    for (let i = 0; i < n * n; i++) {
      if (Number.isFinite(out.values[i])) expect(out.over?.[i]).toBeCloseTo(4, 4)
    }
  })

  it('keeps a missing cell missing, on both sides of the diagonal', async () => {
    const n = 40
    const values = decay(n)
    // In the **lower** triangle, which is the half a symmetric block is binned
    // on: the upper half is written from it, so a hole punched only in the upper
    // half is an inconsistent input and is overwritten by its own mirror.
    const hole = 25 * n + 20
    values[hole] = Number.NaN
    const out = (await serpentineBin(square(n, values), values, EVIDENCE)).values
    expect(Number.isNaN(out[hole])).toBe(true)
    expect(Number.isNaN(out[20 * n + 25])).toBe(true)
  })

  it('refuses a block past the sampled cap and says so', async () => {
    const n = 750
    expect(n * n).toBeGreaterThan(MAX_SAMPLED_CELLS)
    const values = new Float32Array(n * n).fill(1)
    const sampled = parseSmooth('sx50')
    expect(sampled?.kind).toBe('serpentine')
    const out = deriveBlock(square(n, values), { smooth: 'sx50' }, { rows: [], cols: [] })
    expect(out.scope).toBe('serpentine not applied — block too large')
    // …and what is drawn is the local approximation of the same idea, named.
    expect(out.label).toContain('smoothed adaptively')
  })
})

describe('serpentine through the picker', () => {
  it('offers both merge rules, and tells them apart', async () => {
    expect(parseSmooth('s50')).toMatchObject({ kind: 'serpentine', merge: 'evidence', target: 50 })
    expect(parseSmooth('sx50')).toMatchObject({
      kind: 'serpentine',
      merge: 'sampled',
      iterations: 3,
    })
  })

  it('asks for a binning rather than computing one, and draws the unbinned map', async () => {
    // The binning runs on the analysis thread, so `deriveBlock` cannot do it: it
    // hands back the arrays a binning would need and carries on with the honest
    // unbinned field. The caption must not claim otherwise while it waits.
    const n = 60
    const values = decay(n)
    const b = square(n, values)
    const out = deriveBlock(b, { smooth: 's50' }, { rows: [], cols: [] })

    expect(out.label).toBe('counts')
    expect(out.values).toBe(values)
    expect(out.pending).toBeDefined()
    expect(out.pending?.spec).toMatchObject({ merge: 'evidence', target: 50 })
    expect(out.pending?.counts).toBe(values)
    expect(out.pending?.over).toBeNull()
    expect(out.pending?.nrows).toBe(n)
  })

  it('sends the baseline to be binned too, when the O/E is on', async () => {
    const n = 60
    const values = decay(n)
    const out = deriveBlock(square(n, values), { smooth: 's50', expected: true }, { rows: [], cols: [] })
    // Both halves of the ratio, so the regions that average one average the
    // other — the matched-window property, carried through the worker.
    expect(out.pending?.over).not.toBeNull()
    expect(out.pending?.over?.length).toBe(n * n)
  })

  it('falls back, with the reason, where a binning cannot be run', async () => {
    // Two of them. A panel with no analysis thread behind it, and either file of
    // a compared pair — the partition is grown on one block, so binning the lead
    // and not its companion would draw a binned map over an unbinned one and
    // call the result a ratio.
    const n = 60
    const values = decay(n)
    for (const why of [
      'serpentine not applied — no analysis thread',
      'serpentine not applied — two files compared',
    ]) {
      const out = deriveBlock(
        square(n, values),
        { smooth: 's50', binningUnavailable: why },
        { rows: [], cols: [] },
      )
      expect(out.scope).toBe(why)
      // The setting is not silently dropped: what is drawn is the local
      // approximation of the same idea, and the caption names it.
      expect(out.label).toContain('smoothed adaptively')
      expect(out.pending).toBeUndefined()
    }
  })

  it('uses a binning that has come back, and says how many regions it drew', async () => {
    const n = 60
    const values = decay(n)
    const b = square(n, values)
    const asked = deriveBlock(b, { smooth: 's50' }, { rows: [], cols: [] })
    const field = await serpentineBin(
      { ...b, values: asked.pending!.values },
      asked.pending!.counts,
      asked.pending!.spec,
    )

    const out = deriveBlock(
      b,
      { smooth: 's50', binned: { values: field.values, over: field.over, regions: field.regions } },
      { rows: [], cols: [] },
    )
    expect(out.label).toBe('counts · binned into serpentine regions (medium)')
    expect(out.scope).toMatch(/^\d[\d,]* regions$/)
    expect(out.pending).toBeUndefined()
    expect(out.values).toBe(field.values)
  })
})
