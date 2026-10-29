/**
 * Base composition, checked against sequences whose answer is known by
 * construction rather than against a second implementation: a replichore made
 * of G-rich and C-rich halves has its skew's sign change exactly where it was
 * built to, and a window that wraps the origin of a circle must see the far end.
 */

import { describe, expect, it } from 'vitest'

import {
  atSkewOf,
  baseCounts,
  cumulativeOf,
  gcContentOf,
  gcSkewOf,
  readBaseCounts,
  windowCounts,
  type BaseCounts,
} from '../../src/annotations/composition'
import { BASE_CODE } from '../../src/annotations/fasta'

function bases(text: string): Uint8Array {
  const out = new Uint8Array(text.length)
  for (let at = 0; at < text.length; at++) out[at] = text.charCodeAt(at)
  return out
}

describe('counting bases per step', () => {
  it('counts each base in its step, case-folded, and leaves N out of every count', () => {
    const counts = baseCounts(bases('AACGgtNNtt'), 4)
    expect(counts.steps).toBe(3)
    expect([...counts.a]).toEqual([2, 0, 0])
    expect([...counts.c]).toEqual([1, 0, 0])
    expect([...counts.g]).toEqual([1, 1, 0])
    expect([...counts.t]).toEqual([0, 1, 2])
  })

  it('makes the last step partial, as the last bin of a map is', () => {
    expect(baseCounts(bases('ACGTACGTAC'), 4).steps).toBe(3)
    expect(baseCounts(bases(''), 4).steps).toBe(0)
  })
})

/**
 * The counts as they were made before they were made a word at a time: a
 * byte's code, one at a time, into one of four counters.
 */
function countedByteByByte(seq: Uint8Array, width: number): BaseCounts {
  const steps = seq.length === 0 ? 0 : Math.ceil(seq.length / width)
  const counts = { step: width, steps, a: new Int32Array(steps), c: new Int32Array(steps), g: new Int32Array(steps), t: new Int32Array(steps) }
  const into = [counts.a, counts.c, counts.g, counts.t]
  for (let i = 0; i < seq.length; i++) {
    const code = BASE_CODE[seq[i]]
    if (code < 4) into[code][Math.floor(i / width)]++
  }
  return counts
}

/** A sequence of every byte, runs of one base long enough to fill a count, and DNA between. */
function mixed(length: number, seed: number): Uint8Array {
  let state = seed
  const next = (): number => {
    state = (state * 1_103_515_245 + 12_345) % 2 ** 31
    return state
  }
  const out = new Uint8Array(length)
  for (let at = 0; at < length; ) {
    const kind = next() % 4
    const run = 1 + (next() % (kind === 0 ? 700 : 40))
    const base = 'ACGTacgtNnUu'.charCodeAt(next() % 12)
    for (let k = 0; k < run && at < length; k++, at++) {
      out[at] = kind === 0 ? base : kind === 1 ? next() % 256 : 'ACGT'.charCodeAt(next() % 4)
    }
  }
  return out
}

describe('counting a word at a time', () => {
  it('counts what a byte at a time counted, at every alignment and every step', () => {
    const backing = mixed(20_011, 3)
    for (let offset = 0; offset < 4; offset++) {
      for (const length of [0, 1, 3, 4, 5, 255, 1_021, 19_999]) {
        const seq = backing.subarray(offset, offset + length)
        for (const step of [1, 2, 3, 4, 5, 7, 63, 64, 252, 253, 1_000, 1_009, 4_096, 50_000]) {
          const label = `offset ${offset}, length ${length}, step ${step}`
          const got = baseCounts(seq, step)
          const want = countedByteByByte(seq, step)
          expect(got.steps, label).toBe(want.steps)
          expect([...got.a], label).toEqual([...want.a])
          expect([...got.c], label).toEqual([...want.c])
          expect([...got.g], label).toEqual([...want.g])
          expect([...got.t], label).toEqual([...want.t])
        }
      }
    }
  })

  it('never lets a count overflow its byte, however long a run of one base is', () => {
    const seq = new Uint8Array(100_003).fill('G'.charCodeAt(0))
    seq.fill('t'.charCodeAt(0), 60_000)
    const counts = baseCounts(seq.subarray(1), 100_000)
    expect([...counts.g]).toEqual([59_999, 0])
    expect([...counts.t]).toEqual([40_001, 2])
    expect([...counts.a, ...counts.c]).toEqual([0, 0, 0, 0])
  })
})

describe('counting a window at a time', () => {
  const seq = mixed(30_001, 11)
  const reader = async (start: number, end: number): Promise<Uint8Array> =>
    // A fresh array, as a read by range is, rather than a view of the whole.
    seq.slice(Math.max(0, start), Math.min(seq.length, end))

  it('counts what the sequence read whole counts, whatever the window', async () => {
    for (const step of [1, 7, 1_000, 4_096, 40_000]) {
      const want = baseCounts(seq, step)
      for (const window of [1, 6, 999, 1_000, 8_191, 30_001, 1 << 22]) {
        const label = `step ${step}, window ${window}`
        const got = await readBaseCounts(reader, step, window)
        expect(got?.length, label).toBe(seq.length)
        expect(got?.counts.steps, label).toBe(want.steps)
        expect([...(got?.counts.a ?? [])], label).toEqual([...want.a])
        expect([...(got?.counts.c ?? [])], label).toEqual([...want.c])
        expect([...(got?.counts.g ?? [])], label).toEqual([...want.g])
        expect([...(got?.counts.t ?? [])], label).toEqual([...want.t])
      }
    }
  })

  it('ends on a window that comes back short, even an empty one', async () => {
    const asked: Array<[number, number]> = []
    const got = await readBaseCounts(
      async (start, end) => {
        asked.push([start, end])
        return seq.slice(start, Math.min(30_000, end))
      },
      1_000,
      10_000,
    )
    expect(got?.length).toBe(30_000)
    expect(got?.counts.steps).toBe(30)
    expect(asked).toEqual([
      [0, 10_000],
      [10_000, 20_000],
      [20_000, 30_000],
      [30_000, 40_000],
    ])
  })

  it('answers nothing for a sequence the reference has not got', async () => {
    expect(await readBaseCounts(async () => undefined, 1_000)).toBeUndefined()
  })
})

describe('the three ratios', () => {
  it('is GC over every counted base, and a gap has none rather than zero', () => {
    const counts = baseCounts(bases('GGCCAATTNNNN'), 4)
    const gc = gcContentOf(counts)
    expect(gc[0]).toBeCloseTo(1)
    expect(gc[1]).toBeCloseTo(0)
    expect(Number.isNaN(gc[2])).toBe(true)
  })

  it('signs the skews the way the literature does: G over C, A over T', () => {
    const counts = baseCounts(bases('GGGCAAAT'), 4)
    expect(gcSkewOf(counts)[0]).toBeCloseTo(0.5)
    expect(atSkewOf(counts)[1]).toBeCloseTo(0.5)
    // Neither G nor C in the second step: no GC skew there, not a skew of zero.
    expect(Number.isNaN(gcSkewOf(counts)[1])).toBe(true)
  })
})

describe('windows', () => {
  it('sums whole steps centred on each, clipped at the ends of a line', () => {
    const counts = baseCounts(bases('GGGGCCCCGGGG'), 4)
    const wide = windowCounts(counts, 3, false)
    expect([...wide.g]).toEqual([4, 8, 4])
    expect([...wide.c]).toEqual([4, 4, 4])
  })

  /**
   * The case a circular window exists for: the step at the end of the sequence
   * is next to the step at its start, and a window there has to see both.
   */
  it('wraps round the origin of a circle', () => {
    const counts = baseCounts(bases('GGGGAAAACCCC'), 4)
    const round = windowCounts(counts, 3, true)
    expect([...round.g]).toEqual([4, 4, 4])
    expect([...round.c]).toEqual([4, 4, 4])
    const line = windowCounts(counts, 3, false)
    expect([...line.c]).toEqual([0, 4, 4])
  })

  it('never counts a base twice, however wide the window asked for is', () => {
    const counts = baseCounts(bases('GGGGAAAACCCC'), 4)
    const lap = windowCounts(counts, 99, true)
    expect([...lap.g]).toEqual([4, 4, 4])
  })

  it('makes an even span odd rather than centring it half a step off', () => {
    const counts = baseCounts(bases('GGGGCCCCGGGG'), 4)
    expect([...windowCounts(counts, 2, false).g]).toEqual([...windowCounts(counts, 3, false).g])
  })
})

describe('the cumulative skew', () => {
  /**
   * A toy chromosome whose forward strand leads from 0 to 40 (G-rich) and lags
   * from 40 to 80 (C-rich): the cumulative skew climbs to the terminus at 40 and
   * falls back to the origin, which is where every assembly-independent reading
   * of the curve puts them.
   */
  it('turns at the replichore boundary it was built with', () => {
    const genome = `${'GGGCA'.repeat(8)}${'CCCGA'.repeat(8)}`
    const skew = gcSkewOf(baseCounts(bases(genome), 5))
    const cumulative = cumulativeOf(skew)
    let high = 0
    for (let i = 1; i < cumulative.length; i++) if (cumulative[i] > cumulative[high]) high = i
    expect(high).toBe(7)
    expect(cumulative[cumulative.length - 1]).toBeCloseTo(0)
  })

  it('carries the sum across a gap rather than breaking it', () => {
    const out = cumulativeOf(Float32Array.from([1, Number.NaN, 1]))
    expect([...out]).toEqual([1, 1, 2])
  })
})
