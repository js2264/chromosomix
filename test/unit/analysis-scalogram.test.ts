/**
 * The scalogram, against distributions whose quantiles are known by hand.
 *
 * The quantity is a *cumulative distribution over separation*, so the ways to
 * get it wrong are the ways to get a quantile wrong, and every one of them
 * produces a picture that still looks like a scalogram:
 *
 * - counting **both sides** of a bin, since a bin's contacts at separation `d`
 *   are the two cells either side of it and taking one halves every weight
 *   asymmetrically at the two ends of a sequence;
 * - **ordering** — the bands are drawn nested, so a set that is not ascending in
 *   distance at every bin draws ribbons that cross and fill into each other;
 * - the **reach**, because a quantile past the separation that was looked at is
 *   a quantile of something else;
 * - and the **wrap**, which is what makes a plasmid's junction stop being a
 *   place where every bin's contacts appear to run out.
 */

import { describe, expect, it } from 'vitest'

import { squareBand } from '@/analysis/band'
import { scalogram } from '@/analysis/scalogram'

/** A symmetric square from a function of the separation alone. */
function bySeparation(n: number, weight: (d: number) => number, circular = false): Float32Array {
  const values = new Float32Array(n * n)
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      const raw = Math.abs(i - j)
      const d = circular ? Math.min(raw, n - raw) : raw
      values[i * n + j] = weight(d)
    }
  }
  return values
}

const QUANTILES = [0.1, 0.25, 0.5, 0.75, 0.9]

describe('scalogram', () => {
  it('puts every quantile in ascending order at every bin', () => {
    const n = 80
    const band = squareBand(bySeparation(n, (d) => 1 / (1 + d)), n)
    const tracks = scalogram(band, { quantiles: QUANTILES, maxDistance: 30, minValid: 0.5 })
    expect(tracks.map((track) => track.quantile)).toEqual(QUANTILES)
    for (let bin = 0; bin < n; bin++) {
      for (let q = 1; q < tracks.length; q++) {
        const below = tracks[q - 1].distance[bin]
        const above = tracks[q].distance[bin]
        if (Number.isNaN(below) || Number.isNaN(above)) continue
        expect(above).toBeGreaterThanOrEqual(below)
      }
    }
  })

  it('puts the median at the half of a flat distribution', () => {
    const n = 120
    // Equal contact at every separation out to the reach, so the cumulative is a
    // straight line and the median is halfway along it.
    const band = squareBand(bySeparation(n, () => 1), n)
    const tracks = scalogram(band, { quantiles: [0.5], maxDistance: 40, minValid: 0.5 })
    // A bin in the middle, whose window is whole on both sides. Equal weight at
    // separations 1 through 40, so the cumulative reaches exactly half of itself
    // at 20 — which is the separation reported, not the midpoint of the bucket
    // after it: the quantile is where the cumulative *reaches* the threshold.
    expect(tracks[0].distance[60]).toBeCloseTo(20, 6)
  })

  it('reads a bin whose contacts are all local as a small distance', () => {
    const n = 120
    const reach = 40
    const local = squareBand(bySeparation(n, (d) => (d <= 3 ? 100 : 1)), n)
    const spread = squareBand(bySeparation(n, () => 1), n)
    const tight = scalogram(local, { quantiles: [0.5], maxDistance: reach, minValid: 0.5 })
    const loose = scalogram(spread, { quantiles: [0.5], maxDistance: reach, minValid: 0.5 })
    expect(tight[0].distance[60]).toBeLessThan(loose[0].distance[60])
    // And the tight one's median is inside the stretch that carries the weight.
    expect(tight[0].distance[60]).toBeLessThanOrEqual(3)
  })

  it('never reports a separation past the reach it was given', () => {
    const n = 120
    const band = squareBand(bySeparation(n, () => 1), n)
    const tracks = scalogram(band, { quantiles: QUANTILES, maxDistance: 12, minValid: 0.5 })
    for (const track of tracks) {
      for (const value of track.distance) {
        if (Number.isNaN(value)) continue
        expect(value).toBeLessThanOrEqual(12)
      }
    }
  })

  it('leaves a bin with nothing measured as a gap', () => {
    const n = 60
    const values = bySeparation(n, () => 1)
    for (let k = 0; k < n; k++) {
      values[30 * n + k] = Number.NaN
      values[k * n + 30] = Number.NaN
    }
    const tracks = scalogram(squareBand(values, n), {
      quantiles: [0.5],
      maxDistance: 20,
      minValid: 0.5,
    })
    expect(tracks[0].distance[30]).toBeNaN()
    expect(Number.isNaN(tracks[0].distance[20])).toBe(false)
  })

  it('gives a circular sequence the same answer at its junction as anywhere else', () => {
    const n = 100
    const band = squareBand(bySeparation(n, (d) => 1 / (1 + d), true), n, { circular: true })
    const tracks = scalogram(band, { quantiles: [0.5], maxDistance: 20, minValid: 0.5 })
    const middle = tracks[0].distance[50]
    // Bin 0 and bin 99 sit either side of the join. On a circle they are as
    // ordinary as bin 50, and the whole point of the flag is that they read so.
    expect(tracks[0].distance[0]).toBeCloseTo(middle, 6)
    expect(tracks[0].distance[n - 1]).toBeCloseTo(middle, 6)
  })

  it('reads a linear sequence’s last bin as reaching only one way', () => {
    const n = 100
    const band = squareBand(bySeparation(n, () => 1), n)
    const tracks = scalogram(band, { quantiles: [0.5], maxDistance: 20, minValid: 0.5 })
    // Not a gap — one side is a perfectly good distribution — but not the same
    // number as the middle either, because there is genuinely nothing past the
    // end and a circle is the only thing that would say otherwise.
    expect(Number.isNaN(tracks[0].distance[n - 1])).toBe(false)
  })
})
