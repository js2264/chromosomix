/**
 * The scene's arithmetic: chains, gaps, the bridge from a locus to a bead, and
 * the normalisation that makes one camera fit every model (§25).
 *
 * Every number here is computed by hand from a model small enough to draw on
 * paper, rather than captured from a previous run of the code — the same rule
 * `render.test.ts` holds its LUTs to. The normalised coordinates are `Float32`,
 * so anything read back through them is asserted to five places rather than ten.
 */

import { describe, expect, it } from 'vitest'

import { parseG3d } from '@/annotations/g3d'
import {
  beadsAt,
  beadsIn,
  beadsOf,
  buildStructure,
  centroidOf,
  distanceBetween,
  lociOf,
  telomereBeads,
  type SequenceFacts,
} from '@/structure/scene'

function rows(lines: string[]): string {
  return lines.map((line) => line.replace(/ +/g, '\t')).join('\n')
}

/**
 * Two chromosomes at 10 kb. `chrA` is a straight line of five beads along x
 * with the third bead **missing** (a gap); `chrB` is two beads phased, one
 * homologue above the other.
 */
const MODEL = rows([
  'chrA 0 0 0 0',
  'chrA 10000 1 0 0',
  'chrA 30000 3 0 0',
  'chrA 40000 4 0 0',
  'chrB 0 0 1 0 m',
  'chrB 0 0 -1 0 p',
  'chrB 10000 1 1 0 m',
  'chrB 10000 1 -1 0 p',
])

function scene() {
  const structure = buildStructure(parseG3d(MODEL))
  if (structure === null) throw new Error('no model')
  return structure
}

describe('building the scene', () => {
  it('is null for a set with no model', () => {
    const set = parseG3d(MODEL)
    const bare = { ...set, model: undefined }
    expect(buildStructure(bare)).toBeNull()
  })

  it('strings one chain per contig and haplotype, in genomic order', () => {
    const s = scene()
    // chrA is unphased in a phased file: `shared` is its own category, so the
    // file has three categories and chrA one chain, chrB two.
    expect(s.haplotypes).toEqual(['shared', 'maternal', 'paternal'])
    expect(s.chains.map((chain) => [s.contigs[chain.contig], s.haplotypes[chain.hap]])).toEqual([
      ['chrA', 'shared'],
      ['chrB', 'maternal'],
      ['chrB', 'paternal'],
    ])
    const chrA = s.chains[0]
    expect([...chrA.beads].map((bead) => s.set.start[bead])).toEqual([0, 10000, 30000, 40000])
    expect([...s.along].slice(0, 4)).toEqual([0, 1, 2, 3])
  })

  it('breaks a chain where a bead is more than one spacing on', () => {
    const s = scene()
    // Beads at 0 and 10 kb are neighbours; 30 kb is two spacings on, so the
    // run ends there and another begins.
    expect([...s.chains[0].runs]).toEqual([0, 2, 2, 4])
    expect([...s.chains[1].runs]).toEqual([0, 2])
  })

  it('normalises to the centroid and the radius of gyration, and keeps the factor', () => {
    const s = scene()
    // Eight beads: x = 0,1,3,4,0,0,1,1 (mean 1.25); y = 0,0,0,0,1,-1,1,-1 (mean 0);
    // z = 0. Squared distances to the centroid: (1.5625, 0.0625, 3.0625, 7.5625)
    // + (1.5625+1)×2 + (0.0625+1)×2 = 12.25 + 5.125 + 2.125 = 19.5; /8 = 2.4375.
    const gyration = Math.sqrt(19.5 / 8)
    expect(s.scale).toBeCloseTo(gyration, 10)
    let cx = 0
    for (let i = 0; i < s.set.length; i++) cx += s.x[i]
    expect(cx).toBeCloseTo(0, 5)
    expect(s.x[0]).toBeCloseTo(-1.25 / gyration, 5)
    expect(s.placed).toBe(8)
  })

  it('measures the typical step between neighbours, normalised', () => {
    const s = scene()
    // Every adjacent pair is one file unit apart.
    expect(s.step * s.scale).toBeCloseTo(1, 5)
  })

  it('leaves a bead the file placed at NaN out of everything', () => {
    const set = parseG3d(rows(['chrC 0 0 0 0', 'chrC 10000 1 0 0', 'chrC 20000 2 0 0']))
    const model = set.model
    if (model === undefined) throw new Error('no model')
    model.x[1] = Number.NaN
    const s = buildStructure(set)
    if (s === null) throw new Error('no scene')
    expect(s.placed).toBe(2)
    expect(s.present[1]).toBe(0)
    expect([...s.chains[0].runs]).toEqual([0, 1, 2, 3])
    expect(Number.isNaN(distanceBetween(s, 0, 1))).toBe(true)
  })
})

describe('the bridge from a locus to its beads', () => {
  it('answers the bead holding a base, on every haplotype', () => {
    const s = scene()
    const beads = beadsAt(s, 'chrB', 12345)
    expect(beads.map((bead) => lociOf(s, bead))).toEqual([
      { contig: 'chrB', start: 10000, end: 20000, haplotype: 'maternal', hap: 1 },
      { contig: 'chrB', start: 10000, end: 20000, haplotype: 'paternal', hap: 2 },
    ])
  })

  it('answers the one bead of an unphased chain, at its first and last base', () => {
    const s = scene()
    expect(beadsAt(s, 'chrA', 0).map((b) => s.set.start[b])).toEqual([0])
    expect(beadsAt(s, 'chrA', 9999).map((b) => s.set.start[b])).toEqual([0])
    expect(beadsAt(s, 'chrA', 10000).map((b) => s.set.start[b])).toEqual([10000])
  })

  it('answers the nearest bead within one spacing of a gap, and nothing further', () => {
    const s = scene()
    // 20–30 kb is the gap on chrA: 21 kb is one base past the 10 kb bead's end,
    // 29 kb is within the 30 kb bead's reach on the other side.
    expect(beadsAt(s, 'chrA', 21000).map((b) => s.set.start[b])).toEqual([10000])
    expect(beadsAt(s, 'chrA', 29000).map((b) => s.set.start[b])).toEqual([30000])
    // Past the end by more than a spacing is nowhere.
    expect(beadsAt(s, 'chrA', 61000)).toEqual([])
    expect(beadsAt(s, 'chrA', 50001).map((b) => s.set.start[b])).toEqual([40000])
  })

  it('answers nothing for a contig the model lacks, or a base that is not one', () => {
    const s = scene()
    expect(beadsAt(s, 'chrZ', 100)).toEqual([])
    expect(beadsAt(s, 'chrA', Number.NaN)).toEqual([])
  })

  it('answers every bead overlapping a stretch, both haplotypes', () => {
    const s = scene()
    expect(beadsIn(s, 'chrA', 5000, 35000).map((b) => s.set.start[b])).toEqual([0, 10000, 30000])
    expect(beadsIn(s, 'chrB', 0, 5000).length).toBe(2)
    expect(beadsIn(s, 'chrB', 20000, 30000)).toEqual([])
    expect(beadsOf(s, 'chrB').length).toBe(4)
    expect(beadsOf(s, 'chrZ')).toEqual([])
  })

  it('measures a distance in the file’s own units', () => {
    const s = scene()
    const [m, p] = beadsAt(s, 'chrB', 0)
    expect(distanceBetween(s, m, p)).toBeCloseTo(2, 5)
    expect(distanceBetween(s, 0, 3)).toBeCloseTo(4, 5)
  })

  it('finds the centre and the reach of a set of beads, for framing', () => {
    const s = scene()
    const chrA = beadsOf(s, 'chrA')
    const sphere = centroidOf(s, chrA)
    if (sphere === null) throw new Error('nothing placed')
    // The four chrA beads, normalised: x = (0,1,3,4 − 1.25)/g, centre at
    // (2 − 1.25)/g, the far bead 2 units off it.
    expect(sphere.x * s.scale).toBeCloseTo(0.75, 5)
    expect(sphere.radius * s.scale).toBeCloseTo(2, 5)
    expect(centroidOf(s, [])).toBeNull()
  })
})


/**
 * The telomeres: the two ends of a linear sequence, and only where the model
 * and the session between them can actually say so (§25.5).
 */
describe('telomeres', () => {
  /** `chrA`'s beads run 0…40 kb; the model's width is 10 kb. */
  const linear = (length: number): SequenceFacts => ({ length, exact: true, circular: false })

  it('marks both ends of a sequence the model covers whole', () => {
    // chrA's last bead starts at 40 kb and is 10 kb wide, so a 50 kb chrA is
    // covered to its end. chrB is two beads of one homologue each.
    const found = telomereBeads(scene(), (name) => (name === 'chrA' ? linear(50000) : linear(20000)))
    const set = scene().set
    const loci = found.map((bead) => `${set.contigs[set.contig[bead]]}:${set.start[bead]}`)
    expect(loci).toContain('chrA:0')
    expect(loci).toContain('chrA:40000')
  })

  it('marks neither end of a sequence the reader declared circular', () => {
    const found = telomereBeads(scene(), () => ({ length: 50000, exact: true, circular: true }))
    expect(found).toEqual([])
  })

  it('leaves the far end alone where the length is a lower bound, and keeps the start', () => {
    // An assembly inferred from a feature file says a chromosome is *at least*
    // as long as its last feature — against which every model ends at a
    // telomere, which is why the far end is not claimed from one.
    const set = scene().set
    const found = telomereBeads(scene(), () => ({ length: 50000, exact: false, circular: false }))
    const loci = found.map((bead) => `${set.contigs[set.contig[bead]]}:${set.start[bead]}`)
    expect(loci).toContain('chrA:0')
    expect(loci).not.toContain('chrA:40000')
  })

  it('leaves the far end alone where the session knows nothing of the sequence', () => {
    const set = scene().set
    const loci = telomereBeads(scene(), () => null).map(
      (bead) => `${set.contigs[set.contig[bead]]}:${set.start[bead]}`,
    )
    expect(loci).toContain('chrA:0')
    expect(loci).not.toContain('chrA:40000')
  })

  it('does not call the edge of a modelled region a telomere', () => {
    // The same beads against a chromosome ten times as long: this model is a
    // fragment of it, and a fragment has no telomere at either end. The start
    // is still base zero, so that one is real; the far end is not.
    const set = scene().set
    const loci = telomereBeads(scene(), () => linear(500000)).map(
      (bead) => `${set.contigs[set.contig[bead]]}:${set.start[bead]}`,
    )
    expect(loci).not.toContain('chrA:40000')
    expect(loci).toContain('chrA:0')
  })

  it('reaches the end within a bead, which is as near as a bead can get', () => {
    const set = scene().set
    const near = telomereBeads(scene(), () => linear(59000)).map(
      (bead) => `${set.contigs[set.contig[bead]]}:${set.start[bead]}`,
    )
    expect(near).toContain('chrA:40000')
    const far = telomereBeads(scene(), () => linear(61000)).map(
      (bead) => `${set.contigs[set.contig[bead]]}:${set.start[bead]}`,
    )
    expect(far).not.toContain('chrA:40000')
  })

  it('gives a one-bead chain one telomere, not the same bead twice', () => {
    const one = buildStructure(parseG3d(rows(['chrC 0 0 0 0'])))
    if (one === null) throw new Error('no model')
    expect(telomereBeads(one, () => linear(10000))).toEqual([0])
  })
})
