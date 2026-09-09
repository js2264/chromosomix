/**
 * The two pictures a motif search produces, and the arithmetic behind each.
 *
 * Both builders are pure, and both hold a decision that would be invisible if it
 * were wrong. The feature set decides what a site is *called*, which is what the
 * search box can find and what an exported BED reads like. The density vector
 * decides what an **empty** bin is — and that one is not cosmetic: `NaN` in a
 * `BinVector` draws as a hole, so a stretch of genome with no site in it would
 * come back looking like missing data rather than like the answer, which for a
 * restriction map is the most informative thing on the lane.
 */

import { describe, expect, it } from 'vitest'

import { motifBinsize, motifDensity, motifFeatures, motifLabel } from '@/annotations/motifTrack'
import type { MotifScanResult } from '@/annotations/worker/protocol'

/** A scan result, written the way the wire carries one. */
function scan(
  sites: Record<string, Array<[number, number, number]>>,
  extra: Partial<MotifScanResult> = {},
): MotifScanResult {
  const hits = Object.entries(sites).map(([contig, rows]) => ({
    contig,
    starts: Int32Array.from(rows.map((row) => row[0])),
    ends: Int32Array.from(rows.map((row) => row[1])),
    strands: Int8Array.from(rows.map((row) => row[2])),
  }))
  const total = Object.values(sites).reduce((sum, rows) => sum + rows.length, 0)
  return { hits, total, truncated: false, refusal: null, ...extra }
}

describe('motifFeatures', () => {
  it('makes one interval per site, sorted, with the strand kept', () => {
    const set = motifFeatures(
      scan({ chrI: [[10, 14, 1], [4, 8, -1]], chrII: [[0, 4, 0]] }),
      'gatc',
    )
    expect(set.length).toBe(3)
    // `FeatureBuilder.finish` sorts by contig then start, which is what makes
    // every later query a binary search.
    expect(Array.from(set.start)).toEqual([4, 10, 0])
    expect(Array.from(set.end)).toEqual([8, 14, 4])
    expect(Array.from(set.strand)).toEqual([-1, 1, 0])
    expect(set.contigs).toEqual(['chrI', 'chrII'])
  })

  it('names each site after the pattern and its strand, upper-cased', () => {
    const set = motifFeatures(scan({ chrI: [[0, 4, 1], [10, 14, -1], [20, 24, 0]] }), 'ga tc')
    expect(set.name).toEqual(['GATC +', 'GATC −', 'GATC ±'])
  })

  it('leaves the score empty, because an exact match has none', () => {
    const set = motifFeatures(scan({ chrI: [[0, 4, 1]] }), 'GATC')
    expect(Number.isNaN(set.score[0])).toBe(true)
  })

  it('makes an empty set from an empty scan rather than throwing', () => {
    expect(motifFeatures(scan({}), 'GATC').length).toBe(0)
  })
})

describe('motifDensity', () => {
  const CONTIGS = [
    { name: 'chrI', length: 1000 },
    { name: 'chrII', length: 250 },
  ]

  it('lays the grid out from the assembly, contigs end to end', () => {
    const vector = motifDensity(scan({}), CONTIGS, 100)
    expect(vector.binsize).toBe(100)
    expect(vector.firstBin).toBe(0)
    expect(vector.contigs).toEqual([
      { name: 'chrI', startBin: 0, bins: 10, length: 1000 },
      // Ceil, not floor: the last 50 bases are a bin of their own, or they are
      // a stretch of sequence the lane cannot draw.
      { name: 'chrII', startBin: 10, bins: 3, length: 250 },
    ])
    expect(vector.values.length).toBe(13)
  })

  /**
   * The decision this file exists to pin. A bin with no site is a *count of
   * zero*, and `NaN` would draw it as a hole — the difference between "there is
   * no site here", which is the answer, and "nothing is known here", which is
   * not.
   */
  it('counts an empty bin as zero, never as a gap', () => {
    const vector = motifDensity(scan({ chrI: [[0, 4, 1]] }), CONTIGS, 100)
    expect(vector.values[0]).toBe(1)
    for (let bin = 1; bin < vector.values.length; bin++) {
      expect(Number.isNaN(vector.values[bin]), `bin ${bin}`).toBe(false)
      expect(vector.values[bin]).toBe(0)
    }
  })

  it('counts a site in the bin its start falls in', () => {
    const vector = motifDensity(
      scan({ chrI: [[0, 4, 1], [50, 54, 1], [150, 154, 1], [999, 1000, 1]] }),
      CONTIGS,
      100,
    )
    expect(Array.from(vector.values.slice(0, 10))).toEqual([2, 1, 0, 0, 0, 0, 0, 0, 0, 1])
  })

  it('keeps the vector’s total equal to the number of sites', () => {
    const sites = scan({
      chrI: [[10, 14, 1], [11, 15, -1], [980, 984, 1]],
      chrII: [[5, 9, 1]],
    })
    const vector = motifDensity(sites, CONTIGS, 100)
    const summed = vector.values.reduce((sum, value) => sum + value, 0)
    expect(summed).toBe(sites.total)
  })

  it('offsets a second contig’s sites onto its own bins', () => {
    const vector = motifDensity(scan({ chrII: [[0, 4, 1]] }), CONTIGS, 100)
    expect(vector.values[10]).toBe(1)
    expect(vector.values[0]).toBe(0)
  })

  it('clamps a site in the ragged last bin rather than writing past the contig', () => {
    // chrII is 250 bp on a 100 bp grid: bin 2 covers 200-250, and a site at 249
    // must land there and not in a fourth bin that does not exist.
    const vector = motifDensity(scan({ chrII: [[249, 253, 1]] }), CONTIGS, 100)
    expect(vector.values[12]).toBe(1)
    expect(vector.values.length).toBe(13)
  })

  it('gives a contig shorter than one bin a bin of its own', () => {
    const vector = motifDensity(scan({}), [{ name: 'tiny', length: 12 }], 1000)
    expect(vector.contigs).toEqual([{ name: 'tiny', startBin: 0, bins: 1, length: 12 }])
  })

  it('drops a sequence the assembly does not list rather than guessing', () => {
    const vector = motifDensity(scan({ chrZ: [[0, 4, 1]] }), CONTIGS, 100)
    expect(vector.values.reduce((sum, value) => sum + value, 0)).toBe(0)
  })
})

describe('motifBinsize', () => {
  it('scales with the genome instead of fixing a number', () => {
    const yeast = motifBinsize(12_100_000)
    const human = motifBinsize(3_100_000_000)
    expect(human).toBeGreaterThan(yeast)
  })

  it('picks a round number a reader recognises', () => {
    for (const total of [1e6, 1.2e7, 1e8, 3.1e9, 5e5]) {
      const step = motifBinsize(total)
      const decade = 10 ** Math.floor(Math.log10(step))
      expect([1, 2, 5, 10]).toContain(Math.round(step / decade))
    }
  })

  it('keeps the bin count in a range a lane can actually draw', () => {
    for (const total of [1e6, 1.2e7, 1e8, 3.1e9]) {
      const bins = total / motifBinsize(total)
      expect(bins).toBeGreaterThan(1_000)
      expect(bins).toBeLessThan(200_000)
    }
  })

  it('never goes below a floor, however small the genome', () => {
    expect(motifBinsize(1000)).toBeGreaterThanOrEqual(100)
    expect(motifBinsize(0)).toBeGreaterThanOrEqual(100)
  })
})

describe('motifLabel', () => {
  it('says the pattern, and says when both strands were searched', () => {
    expect(motifLabel('ga tc', false)).toBe('GATC')
    expect(motifLabel('gatc', true)).toBe('GATC (both strands)')
  })
})
