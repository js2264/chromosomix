/**
 * The arm-frame expectation, checked against maps made from the model itself.
 *
 * A map whose every cell is a function of the kind of pair and the longitudinal
 * separation alone must come back as exactly that function, so its ratio is one
 * everywhere; a plaid laid over it must come back as the plaid; and the ordinary
 * diagonal expectation, handed the same map, must leave the X it was built with
 * — which is the whole reason this module exists.
 */

import { describe, expect, it } from 'vitest'

import {
  armExpected,
  armOffsets,
  interArmProfile,
  interArmSummary,
  type ArmFrame,
} from '../../src/analysis/arms'

/** A square over one sequence built from a model of the two kinds of pair. */
function build(
  frame: ArmFrame,
  cell: (kind: 0 | 1, delta: number, sigma: number, i: number, j: number) => number,
): Float64Array {
  const u = armOffsets(frame)
  const out = new Float64Array(frame.n * frame.n)
  for (let i = 0; i < frame.n; i++) {
    for (let j = 0; j < frame.n; j++) {
      const kind = u[i] >= 0 === u[j] >= 0 ? 0 : 1
      out[i * frame.n + j] = cell(
        kind,
        Math.abs(Math.abs(u[i]) - Math.abs(u[j])),
        Math.abs(u[i]) + Math.abs(u[j]),
        i,
        j,
      )
    }
  }
  return out
}

const all = (n: number): Int32Array => Int32Array.from({ length: n }, (_, i) => i)

describe('offsets from the origin', () => {
  it('runs the short way round a circle, and straight along a line', () => {
    expect([...armOffsets({ n: 8, origin: 0, circular: true })]).toEqual([0, 1, 2, 3, -4, -3, -2, -1])
    expect([...armOffsets({ n: 8, origin: 6, circular: true })]).toEqual([2, 3, -4, -3, -2, -1, 0, 1])
    expect([...armOffsets({ n: 5, origin: 2, circular: false })]).toEqual([-2, -1, 0, 1, 2])
  })
})

describe('the arm-frame expectation', () => {
  const frame: ArmFrame = { n: 60, origin: 13, circular: true }
  /** Decay along an arm, and a weaker decay away from the secondary diagonal. */
  const model = (kind: 0 | 1, delta: number): number =>
    kind === 0 ? 100 / (1 + delta) ** 1.2 : 1 + 20 / (1 + delta) ** 1.5

  it('reproduces a map made of nothing but the two decays', () => {
    const map = build(frame, (kind, delta) => model(kind, delta))
    const expected = armExpected(map, all(frame.n), all(frame.n), frame, 0)
    for (let at = 0; at < map.length; at++) expect(map[at] / expected[at]).toBeCloseTo(1, 9)
  })

  // A line is two arms of unequal length, and with the origin at an end it is
  // one arm the length of the sequence: every Δ and Σ it has must be in the
  // table, with or without a window.
  it('reproduces the model on a line whatever side of it the origin is on', () => {
    for (const origin of [0, 10, 59]) {
      const line: ArmFrame = { n: 60, origin, circular: false }
      const map = build(line, (kind, delta) => model(kind, delta))
      for (const window of [0, 8]) {
        const expected = armExpected(map, all(line.n), all(line.n), line, window)
        for (let at = 0; at < map.length; at++) expect(map[at] / expected[at]).toBeCloseTo(1, 9)
      }
    }
  })

  it('follows a slow change along the arms when given a window, and not without one', () => {
    // Alignment strongest at the origin and fading towards the terminus.
    const fade = (sigma: number): number => 1 - sigma / (2 * frame.n)
    const map = build(frame, (kind, delta, sigma) =>
      kind === 0 ? model(0, delta) : 1 + (model(1, delta) - 1) * fade(sigma),
    )
    const local = armExpected(map, all(frame.n), all(frame.n), frame, 4)
    const global = armExpected(map, all(frame.n), all(frame.n), frame, 0)
    let localError = 0
    let globalError = 0
    for (let at = 0; at < map.length; at++) {
      localError += Math.abs(Math.log2(map[at] / local[at]))
      globalError += Math.abs(Math.log2(map[at] / global[at]))
    }
    expect(localError).toBeLessThan(globalError / 3)
  })

  it('leaves a plaid laid over the model for the correlation to find', () => {
    // Alternating stretches of eight bins, the plaid of two compartments.
    const side = (i: number): number => (Math.floor(i / 8) % 2 === 0 ? 1 : -1)
    const map = build(frame, (kind, delta, _sigma, i, j) =>
      model(kind, delta) * (1 + 0.2 * side(i) * side(j)),
    )
    const expected = armExpected(map, all(frame.n), all(frame.n), frame, 0)
    let agree = 0
    let cells = 0
    for (let i = 0; i < frame.n; i++) {
      for (let j = 0; j < frame.n; j++) {
        const ratio = map[i * frame.n + j] / expected[i * frame.n + j]
        if (Math.abs(ratio - 1) < 0.02) continue
        cells++
        if (Math.sign(ratio - 1) === side(i) * side(j)) agree++
      }
    }
    expect(agree / cells).toBeGreaterThan(0.95)
  })

  it('reads a block in any order of its bins, so a map centred on the origin is the same map', () => {
    const map = build(frame, (kind, delta) => model(kind, delta))
    const rotated = Int32Array.from({ length: frame.n }, (_, i) => (i + 30) % frame.n)
    const values = new Float64Array(frame.n * frame.n)
    for (let r = 0; r < frame.n; r++) {
      for (let c = 0; c < frame.n; c++) values[r * frame.n + c] = map[rotated[r] * frame.n + rotated[c]]
    }
    const expected = armExpected(values, rotated, rotated, frame, 0)
    for (let at = 0; at < values.length; at++) expect(values[at] / expected[at]).toBeCloseTo(1, 9)
  })
})

describe('the secondary diagonal', () => {
  const frame: ArmFrame = { n: 80, origin: 0, circular: true }

  it('finds the enrichment where the arms were built to touch, and nothing where they were not', () => {
    // Observed/expected by the ordinary decay: one everywhere except within one
    // bin of the secondary diagonal, where it is four until 20 bins from the
    // origin and one after.
    const oe = build(frame, (kind, delta, sigma) =>
      kind === 1 && delta <= 1 && sigma / 2 <= 20 ? 4 : 1,
    )
    const { byDistance, byBin } = interArmProfile(oe, frame, 1)
    expect(byDistance[10]).toBeCloseTo(4, 6)
    expect(byDistance[30]).toBeCloseTo(1, 6)
    expect(byBin[5]).toBeCloseTo(4, 6)
    expect(byBin[30]).toBeCloseTo(1, 6)
    // The terminus, where the secondary diagonal runs into the main one: its
    // cells are neighbours along the DNA, and say nothing about the arms.
    expect(Number.isNaN(byBin[40])).toBe(true)
    expect(Number.isNaN(byDistance[0])).toBe(true)
    const summary = interArmSummary(byDistance)
    expect(summary.peak).toBeCloseTo(2, 6)
    // The plateau ends at 20; the running mean carries a sharp edge one bin on.
    expect(summary.reach).toBe(21)
    expect(summary.score).toBeGreaterThan(0)
  })

  it('does not let one noisy distance carry the reach to the terminus', () => {
    // The plateau of the test above, and one far distance as bright as it: read
    // cell by cell the reach was that distance, which on a flat profile made a
    // chromosome with no aligned arms read as aligned almost end to end.
    const byDistance = new Float64Array(40).fill(1)
    for (let d = 2; d <= 20; d++) byDistance[d] = 4
    byDistance[35] = 4
    expect(interArmSummary(byDistance).reach).toBe(21)
  })

  it('reads the reach where a sloping edge ends, not half-way down it', () => {
    // Four times as close out to 10 bins, falling evenly in log2 to nothing at
    // 30: half-way down is 20, and the alignment runs on to 26 before it is
    // within a fifth of its peak of none.
    const byDistance = new Float64Array(40).fill(1)
    for (let d = 2; d <= 30; d++) byDistance[d] = 2 ** (d <= 10 ? 2 : (2 * (30 - d)) / 20)
    expect(interArmSummary(byDistance).reach).toBe(26)
  })

  it('scores the stretch the enrichment reaches, not the whole arm', () => {
    // Four times as close from 2 to 20 bins out, and as expected beyond: the
    // mean from the origin to the reach is that stretch's, where the mean over
    // the arm would halve it for the eighteen bins of nothing after it.
    const byDistance = new Float64Array(40).fill(1)
    for (let d = 2; d <= 20; d++) byDistance[d] = 4
    const summary = interArmSummary(byDistance)
    expect(summary.reach).toBe(21)
    expect(summary.score).toBeCloseTo((19 * 2) / 22, 9)
  })

  it('reads a control over the stretch it is handed, and the whole arm where nothing reaches', () => {
    // As expected up to the terminus, where it rises: its own peak and reach are
    // there, and over the measurement's stretch it is the nothing it is.
    const byDistance = new Float64Array(40).fill(1)
    for (let d = 35; d < 40; d++) byDistance[d] = 4
    expect(interArmSummary(byDistance).reach).toBe(39)
    expect(interArmSummary(byDistance, 20).score).toBeCloseTo(0, 9)
    expect(interArmSummary(byDistance, Number.NaN).score).toBeCloseTo((5 * 2) / 40, 9)
    // Nothing above zero anywhere: no reach, and the arm's own mean.
    const depleted = new Float64Array(40).fill(0.5)
    const summary = interArmSummary(depleted)
    expect(Number.isNaN(summary.reach)).toBe(true)
    expect(summary.score).toBeCloseTo(-1, 9)
  })

  it('measures a line out to the end of its longer arm', () => {
    // Origin at bin 10 of 80: one arm of 10 bins, one of 69.
    const line: ArmFrame = { n: 80, origin: 10, circular: false }
    const oe = build(line, (kind, delta) => (kind === 1 && delta <= 1 ? 4 : 1))
    const { byDistance } = interArmProfile(oe, line, 1)
    expect(byDistance.length).toBe(70)
  })

  it('scores a chromosome whose arms are not aligned at zero, with no reach', () => {
    const oe = build(frame, () => 1)
    const summary = interArmSummary(interArmProfile(oe, frame, 1).byDistance)
    expect(summary.score).toBeCloseTo(0, 9)
    expect(Number.isNaN(summary.reach)).toBe(true)
  })
})
