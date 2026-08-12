/**
 * A computed vector answering the request a bigWig answers (§18.5).
 *
 * The point of `binVector.ts` is that a synthetic lane needs no renderer of its
 * own, and the way that is achieved is by making it produce a `TrackSampleSet`
 * indistinguishable from a real track's. So what is worth testing is not the
 * arithmetic in the abstract but the three places a *lane* would visibly go
 * wrong if this were subtly different from what bbi returns: a gap that becomes
 * a zero, an interval that runs past the end of a chromosome, and a wide window
 * that ships a million intervals instead of summarising.
 */

import { describe, expect, it } from 'vitest'

import { binVectorSamples, type BinVector } from '../../src/annotations/worker/binVector'

/** Two contigs, 1 kb bins: `a` is 5 bins, `b` is 2 bins and ends mid-bin. */
function vector(values: number[]): BinVector {
  return {
    binsize: 1000,
    firstBin: 0,
    values: Float32Array.from(values),
    contigs: [
      { name: 'a', startBin: 0, bins: 5, length: 5000 },
      // 1500 bp is one whole bin and half of a second, which is the ordinary
      // case rather than an edge one: a sequence length is never a multiple of
      // the bin size except by accident.
      { name: 'b', startBin: 5, bins: 2, length: 1500 },
    ],
  }
}

/**
 * A yeast grid, in the convention the map it was computed on used.
 *
 * All sixteen chromosomes, not a convenient three: whether a list is counting
 * in Roman is decided *from the list* (§5.9), and a three-name fixture would be
 * testing a file nobody has while quietly proving the wrong thing.
 */
const ROMAN = [
  'I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII',
  'IX', 'X', 'XI', 'XII', 'XIII', 'XIV', 'XV', 'XVI',
]

function yeastVector(): BinVector {
  const contigs = [...ROMAN.map((numeral) => `chr${numeral}`), 'chrM'].map((name, at) => ({
    name,
    startBin: at * 2,
    bins: 2,
    length: 2000,
  }))
  return {
    binsize: 1000,
    firstBin: 0,
    values: Float32Array.from(contigs.flatMap((_, at) => [at * 2 + 1, at * 2 + 2])),
    contigs,
  }
}

describe('a synthetic track in a deck of two nomenclatures', () => {
  /**
   * The bug this pins: a vector is laid out over the grid of the map it was
   * *computed on*, and a deck then draws it beside every panel — each of which
   * samples through its own block's axis and asks by the name its own file
   * writes. A diamond insulation profile computed on a UCSC-named lead and
   * drawn beside an Ensembl-named companion matched nothing, and the
   * companion's lane stayed empty with nothing on screen to say why (§5.9).
   */
  it('answers a companion asking by its own file’s spelling', () => {
    const set = binVectorSamples(yeastVector(), [{ contig: '1', start: 0, end: 2000 }], 1000)
    expect(set.regions).toHaveLength(1)
    expect(Array.from(set.regions[0].values)).toEqual([1, 2])
    // The reply echoes the name the *caller* used, which is what the caller's
    // axis is keyed on — the same asymmetry a bigWig's reply has.
    expect(set.regions[0].contig).toBe('1')
  })

  it('answers across every convention the deck might hold', () => {
    for (const [asked, values] of [
      ['chrI', [1, 2]],
      ['I', [1, 2]],
      ['01', [1, 2]],
      ['1', [1, 2]],
      ['12', [23, 24]],
      ['chr12', [23, 24]],
      ['chrXII', [23, 24]],
      ['MT', [33, 34]],
      ['chrM', [33, 34]],
    ] as const) {
      const set = binVectorSamples(yeastVector(), [{ contig: asked, start: 0, end: 2000 }], 1000)
      expect(Array.from(set.regions[0]?.values ?? []), asked).toEqual([...values])
    }
  })

  it('still answers nothing for a sequence it does not hold', () => {
    // Yeast has sixteen, so `chr20` is genuinely absent — where `chr7` would
    // resolve to `chrVII`, which is the whole point of the two tests above.
    for (const absent of ['chr20', 'scaffold_9', 'NODE_1']) {
      const set = binVectorSamples(yeastVector(), [{ contig: absent, start: 0, end: 2000 }], 1000)
      expect(set.regions, absent).toEqual([])
    }
  })
})

describe('binVectorSamples', () => {
  it('returns one interval per bin, at bin resolution', () => {
    const set = binVectorSamples(vector([1, 2, 3, 4, 5, 6, 7]), [
      { contig: 'a', start: 0, end: 5000 },
    ], 1000)
    expect(set.regions).toHaveLength(1)
    expect(Array.from(set.regions[0].values)).toEqual([1, 2, 3, 4, 5])
    expect(Array.from(set.regions[0].starts)).toEqual([0, 1000, 2000, 3000, 4000])
    expect(set.regions[0].summary).toBe(false)
  })

  it('clamps the last, partial bin of a contig to the sequence', () => {
    // Reporting bin 1 of `b` as [1000, 2000) would draw signal 500 bp past the
    // end of the chromosome — which on a contact map is signal drawn over the
    // *next* sequence.
    const set = binVectorSamples(vector([1, 2, 3, 4, 5, 6, 7]), [
      { contig: 'b', start: 0, end: 1500 },
    ], 1000)
    expect(Array.from(set.regions[0].ends)).toEqual([1000, 1500])
  })

  it('omits a NaN bin rather than reporting it as a value', () => {
    // The distinction the whole codebase turns on: a gap is drawn as a gap, and
    // a zero would claim the window was measured and found empty.
    const set = binVectorSamples(vector([1, Number.NaN, 3, 4, 5, 6, 7]), [
      { contig: 'a', start: 0, end: 5000 },
    ], 1000)
    expect(Array.from(set.regions[0].values)).toEqual([1, 3, 4, 5])
    expect(Array.from(set.regions[0].starts)).toEqual([0, 2000, 3000, 4000])
  })

  it('reports the extent over every region, ignoring gaps', () => {
    const set = binVectorSamples(vector([1, Number.NaN, 3, 4, 5, 6, 7]), [
      { contig: 'a', start: 0, end: 5000 },
      { contig: 'b', start: 0, end: 1500 },
    ], 1000)
    expect(set.extent).toEqual({ min: 1, max: 7 })
  })

  it('summarises a window too wide to send one interval per bin', () => {
    // Ten thousand bins over one contig, which is past MAX_INTERVALS. A lane a
    // few hundred pixels wide must not be sent ten thousand intervals per frame.
    const bins = 10_000
    const values = new Float32Array(bins)
    for (let i = 0; i < bins; i++) values[i] = i
    const wide: BinVector = {
      binsize: 1000,
      firstBin: 0,
      values,
      contigs: [{ name: 'big', startBin: 0, bins, length: bins * 1000 }],
    }
    const set = binVectorSamples(wide, [{ contig: 'big', start: 0, end: bins * 1000 }], 5000)
    const region = set.regions[0]
    expect(region.summary).toBe(true)
    expect(region.values.length).toBeLessThanOrEqual(4096)
    // A summary carries the band around its mean, exactly as a bigWig zoom
    // level does — the renderer asks whether they are there rather than which
    // kind of track it is looking at.
    expect(region.min).not.toBeNull()
    expect(region.max).not.toBeNull()
    expect(region.values[0]).toBeGreaterThan(0)
    expect(set.extent?.max).toBeLessThanOrEqual(bins - 1)
  })

  it('drops a region on a contig the vector does not carry', () => {
    const set = binVectorSamples(vector([1, 2, 3, 4, 5, 6, 7]), [
      { contig: 'nowhere', start: 0, end: 1000 },
    ], 1000)
    expect(set.regions).toHaveLength(0)
    expect(set.extent).toBeNull()
  })

  it('honours firstBin, so a vector over one contig still lands correctly', () => {
    const partial: BinVector = {
      binsize: 1000,
      firstBin: 5,
      values: Float32Array.from([70, 80]),
      contigs: [{ name: 'b', startBin: 5, bins: 2, length: 1500 }],
    }
    const set = binVectorSamples(partial, [{ contig: 'b', start: 0, end: 1500 }], 1000)
    expect(Array.from(set.regions[0].values)).toEqual([70, 80])
  })
})
