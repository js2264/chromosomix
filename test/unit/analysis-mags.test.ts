/**
 * The metagenome accumulators, and the one rule that makes them diagnostics.
 *
 * `__unbinned__` is not a genome (§7.4). Its bins map to `-1`, and a `-1` at
 * either end of a pixel drops that pixel entirely rather than counting it as an
 * inter-MAG contact — because counting it would make every real MAG look leakier
 * in proportion to how badly the *rest* of the file was binned, which is the
 * opposite of a per-MAG diagnostic. That is the property most worth pinning
 * here, and it is the one a reimplementation would get wrong by writing the
 * obvious `else` branch.
 */

import { describe, expect, it } from 'vitest'

import {
  binContigIndex,
  binGenomeMap,
  ContigPurityAccumulator,
  GenomeContactAccumulator,
} from '@/analysis/mags'

/** Two MAGs of two contigs each, plus one unassigned contig. */
const CONTIGS = [
  { startBin: 0, bins: 2, genome: 0 },
  { startBin: 2, bins: 2, genome: 0 },
  { startBin: 4, bins: 2, genome: 1 },
  { startBin: 6, bins: 2, genome: 1 },
  { startBin: 8, bins: 2, genome: 2 },
]
const N_BINS = 10
/** Genome 2 stands for `__unbinned__`: real in the file, absent from display. */
const DISPLAYED = new Set([0, 1])

describe('binGenomeMap', () => {
  it('labels every bin with its genome and leaves the rest at -1', () => {
    const map = binGenomeMap(CONTIGS, N_BINS, DISPLAYED)
    expect(Array.from(map)).toEqual([0, 0, 0, 0, 1, 1, 1, 1, -1, -1])
  })

  it('takes every genome when nothing is filtered', () => {
    const map = binGenomeMap(CONTIGS, N_BINS, null)
    expect(Array.from(map).slice(8)).toEqual([2, 2])
  })
})

describe('binContigIndex', () => {
  it('labels every bin with its contig', () => {
    expect(Array.from(binContigIndex(CONTIGS, N_BINS))).toEqual([0, 0, 1, 1, 2, 2, 3, 3, 4, 4])
  })
})

describe('GenomeContactAccumulator', () => {
  it('separates intra from inter, and counts inter for both ends', () => {
    const acc = new GenomeContactAccumulator(3)
    acc.add(0, 0, 5)
    acc.add(0, 1, 3)
    expect(acc.intra[0]).toBe(5)
    expect(acc.inter[0]).toBe(3)
    expect(acc.inter[1]).toBe(3)
    expect(acc.intra[1]).toBe(0)
  })

  it('drops a contact touching a genome that is not displayable', () => {
    // The rule this file exists for. A contact with `__unbinned__` is not an
    // inter-MAG contact of the MAG at the other end.
    const acc = new GenomeContactAccumulator(3)
    acc.add(0, -1, 100)
    acc.add(-1, -1, 100)
    expect(acc.inter[0]).toBe(0)
    expect(acc.intra[0]).toBe(0)
  })

  it('skips a NaN rather than poisoning a genome total', () => {
    const acc = new GenomeContactAccumulator(2)
    acc.add(0, 0, Number.NaN)
    acc.add(0, 0, 2)
    expect(acc.intra[0]).toBe(2)
  })

  it('builds the pair matrix symmetrically, only when asked', () => {
    expect(new GenomeContactAccumulator(2).pairs).toBeNull()
    const acc = new GenomeContactAccumulator(2, { pairs: true })
    acc.add(0, 1, 7)
    acc.add(0, 0, 4)
    expect(acc.pairs?.[0 * 2 + 1]).toBe(7)
    expect(acc.pairs?.[1 * 2 + 0]).toBe(7)
    // The diagonal once, not twice: a genome's self-contact is one number.
    expect(acc.pairs?.[0]).toBe(4)
  })
})

describe('ContigPurityAccumulator', () => {
  /** Contigs 0 and 1 in MAG 0; contigs 2 and 3 in MAG 1; contig 4 unassigned. */
  const genomeOf = Int32Array.from([0, 0, 1, 1, -1])

  it('counts contact inside a MAG as own, for both contigs', () => {
    const acc = new ContigPurityAccumulator(5, genomeOf)
    acc.add(0, 1, 6)
    expect(acc.own[0]).toBe(6)
    expect(acc.own[1]).toBe(6)
    expect(acc.other[0]).toBe(0)
  })

  it('counts a contig’s self-contact once', () => {
    const acc = new ContigPurityAccumulator(5, genomeOf)
    acc.add(0, 0, 9)
    expect(acc.own[0]).toBe(9)
  })

  it('counts contact across MAGs as other, and remembers where it went', () => {
    const acc = new ContigPurityAccumulator(5, genomeOf)
    acc.add(0, 2, 4)
    acc.add(0, 3, 1)
    expect(acc.other[0]).toBe(5)
    expect(acc.topPartner(0)).toEqual({ genome: 1, value: 5 })
    // And the other end sees MAG 0 as its partner.
    expect(acc.topPartner(2)?.genome).toBe(0)
  })

  it('ignores a contig no displayable genome claims', () => {
    const acc = new ContigPurityAccumulator(5, genomeOf)
    acc.add(0, 4, 50)
    expect(acc.own[0]).toBe(0)
    expect(acc.other[0]).toBe(0)
    expect(acc.topPartner(0)).toBeNull()
  })

  it('caps the partner map and says how much it dropped', () => {
    // The one unbounded thing in the module. A contig hitting the cap has its
    // top partner computed from the partners it saw first, which is a real
    // limitation and is reported rather than left for a reader to guess at.
    const many = Int32Array.from([0, ...Array.from({ length: 10 }, (_, i) => i + 1)])
    const acc = new ContigPurityAccumulator(11, many, 3)
    for (let partner = 1; partner <= 10; partner++) acc.add(0, partner, 1)
    expect(acc.droppedPartners).toBeGreaterThan(0)
    // Everything is still counted in the totals; only the breakdown is capped.
    expect(acc.other[0]).toBe(10)
  })
})
