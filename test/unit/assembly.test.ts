/**
 * A genome with no contact map behind it.
 *
 * Two of these are worth pinning because they are silent when wrong. The
 * `chrom.sizes` sniffer has to tell a two-column sizes file from a three-column
 * BED *without* ever mistaking one for the other, since reading a peak set as an
 * assembly would invent a genome out of it. And the locus box has to round-trip:
 * what it shows must be what it would accept, or a coordinate copied out of one
 * view and into another moves by a base.
 */

import { describe, expect, it } from 'vitest'

import {
  browsingBinsize,
  assemblyAxis,
  assemblyOf,
  findContig,
  formatLocus,
  lengthsAreExact,
  looksLikeChromSizes,
  parseChromSizes,
  parseLocus,
  rangeToUnits,
  replacesLengths,
  unitsToRange,
} from '../../src/genome/assembly'

const YEAST = assemblyOf({
  uri: 'yeast.chrom.sizes',
  name: 'yeast',
  origin: 'sizes',
  contigs: [
    { name: 'I', length: 230_218 },
    { name: 'II', length: 813_184 },
    { name: 'III', length: 316_620 },
  ],
})

describe('parseChromSizes', () => {
  it('reads the two leading columns, whatever whitespace separates them', () => {
    expect(parseChromSizes('I\t230218\nII 813184\n')).toEqual([
      { name: 'I', length: 230_218 },
      { name: 'II', length: 813_184 },
    ])
  })

  it('skips comments, blank lines and a UCSC header', () => {
    expect(parseChromSizes('# a comment\ntrack name=x\n\nI\t100\n')).toEqual([
      { name: 'I', length: 100 },
    ])
  })

  it('takes a .fai, which is the same two leading columns', () => {
    expect(parseChromSizes('I\t230218\t7\t60\t61\n')).toEqual([{ name: 'I', length: 230_218 }])
  })

  it('refuses a row whose second column is not a length', () => {
    expect(parseChromSizes('I\tchr\n')).toEqual([])
    expect(parseChromSizes('I\t0\n')).toEqual([])
  })

  it('keeps the first of two rows with one name', () => {
    expect(parseChromSizes('I\t100\nI\t200\n')).toEqual([{ name: 'I', length: 100 }])
  })
})

describe('looksLikeChromSizes', () => {
  it('accepts a sizes file', () => {
    expect(looksLikeChromSizes('I\t230218\nII\t813184\n')).toBe(true)
  })

  // The distinction one line cannot always make: `chr1 248956422` is a legal
  // sizes row and an illegal BED row, so the test has to be every row.
  it('refuses a BED, which has three columns', () => {
    expect(looksLikeChromSizes('I\t0\t100\nI\t200\t300\n')).toBe(false)
  })

  it('refuses a two-column file whose second column is not a positive integer', () => {
    expect(looksLikeChromSizes('gene1\t3.5\n')).toBe(false)
    expect(looksLikeChromSizes('gene1\t-4\n')).toBe(false)
  })

  it('refuses an empty file, which declares no genome', () => {
    expect(looksLikeChromSizes('\n# nothing\n')).toBe(false)
  })

  // A `.fai` is a five-column file whose first two columns are a chrom.sizes,
  // so by shape alone it is a BED. Only the name can settle it — the same
  // tiebreak `sniffFormat` uses for narrowPeak against BED9.
  it('takes a .fai on its name, and only on its name', () => {
    const fai = 'I\t230218\t7\t60\t61\nII\t813184\t234249\t60\t61\n'
    expect(looksLikeChromSizes(fai, 'sacCer3.fa.fai')).toBe(true)
    expect(looksLikeChromSizes(fai)).toBe(false)
    expect(parseChromSizes(fai)).toEqual([
      { name: 'I', length: 230_218 },
      { name: 'II', length: 813_184 },
    ])
  })

  it('still refuses a BED that happens to be named .fai', () => {
    expect(looksLikeChromSizes('I\t0\t100\n', 'peaks.fai')).toBe(false)
  })
})

describe('assemblyAxis', () => {
  it('lays the sequences end to end, one unit per base pair', () => {
    const axis = assemblyAxis(YEAST)
    expect(axis.segments.map((segment) => segment.unitStart)).toEqual([0, 230_218, 1_043_402])
    expect(axis.unitEnd).toBe(YEAST.total)
    expect(axis.uniformBpPerUnit).toBe(1)
  })

  it('maps a unit back to the sequence and position it is on', () => {
    const axis = assemblyAxis(YEAST)
    expect(axis.unitToLocus(0)).toEqual({ contig: 'I', bp: 0 })
    expect(axis.unitToLocus(230_218)).toEqual({ contig: 'II', bp: 0 })
    expect(axis.unitToLocus(230_218 + 500)).toEqual({ contig: 'II', bp: 500 })
  })

  it('clips a window to the sequences it touches', () => {
    const axis = assemblyAxis(YEAST)
    const windows = axis.windows([230_000, 231_000])
    expect(windows.map((window) => window.contig)).toEqual(['I', 'II'])
    expect(windows[0].start).toBe(230_000)
    expect(windows[1].end).toBe(782)
  })
})

describe('parseLocus', () => {
  it('takes a bare sequence name as the whole sequence', () => {
    expect(parseLocus('II', YEAST)).toEqual({ contig: 'II', start: 0, end: 813_184 })
  })

  // 1-based inclusive in, 0-based half-open out. Getting this wrong shifts every
  // view by one base in a way nothing on screen would show.
  it('converts a 1-based inclusive window to a 0-based half-open one', () => {
    expect(parseLocus('I:1,001-2,000', YEAST)).toEqual({ contig: 'I', start: 1000, end: 2000 })
  })

  it('widens a bare position into a window around it', () => {
    const parsed = parseLocus('I:100000', YEAST)
    expect(parsed).not.toBeNull()
    if (parsed === null || parsed === 'whole') throw new Error('expected a range')
    expect(parsed.start).toBeLessThan(99_999)
    expect(parsed.end).toBeGreaterThan(100_000)
  })

  it('takes the four spellings of "everything"', () => {
    for (const text of ['*', 'all', 'genome', 'WHOLE']) {
      expect(parseLocus(text, YEAST)).toBe('whole')
    }
  })

  // A position past the end of a sequence is one mistyped digit away, and an
  // inverted range is a `RangeError` out of `Scale.setDomain` — from the locus
  // box an uncaught throw, from a link a blank page.
  it('clamps a position past the end of the sequence rather than inverting', () => {
    const parsed = parseLocus('I:999999999', YEAST)
    if (parsed === null || parsed === 'whole') throw new Error('expected a range')
    expect(parsed.end).toBeGreaterThan(parsed.start)
    expect(parsed.end).toBeLessThanOrEqual(230_218)
  })

  it('refuses a name it has never heard of', () => {
    expect(parseLocus('chrZ', YEAST)).toBeNull()
    expect(parseLocus('II:banana', YEAST)).toBeNull()
    expect(parseLocus('II:900-800', YEAST)).toBeNull()
  })

  it('clamps a window to the sequence it is on', () => {
    expect(parseLocus('I:1-999999999', YEAST)).toEqual({ contig: 'I', start: 0, end: 230_218 })
  })

  // What the box shows must be what the box would accept.
  it('round-trips through its own formatter', () => {
    const range = { contig: 'II', start: 1000, end: 2000 }
    expect(parseLocus(formatLocus(range), YEAST)).toEqual(range)
  })
})

describe('findContig', () => {
  it('matches the whole name first, so a name with a colon survives', () => {
    const odd = assemblyOf({
      uri: 'x',
      name: 'x',
      origin: 'sizes',
      contigs: [{ name: 'NODE_1:2', length: 500 }],
    })
    expect(findContig(odd, 'NODE_1:2')?.name).toBe('NODE_1:2')
    expect(parseLocus('NODE_1:2', odd)).toEqual({ contig: 'NODE_1:2', start: 0, end: 500 })
  })

  it('forgives case, and a chr prefix in either direction', () => {
    expect(findContig(YEAST, 'ii')?.name).toBe('II')
    const ucsc = assemblyOf({
      uri: 'x',
      name: 'x',
      origin: 'sizes',
      contigs: [{ name: 'chr1', length: 100 }],
    })
    expect(findContig(ucsc, '1')?.name).toBe('chr1')
    expect(findContig(YEAST, 'chrII')?.name).toBe('II')
  })
})

describe('units and ranges', () => {
  it('round-trip through the genome-wide axis', () => {
    const units = rangeToUnits(YEAST, { contig: 'II', start: 1000, end: 2000 })
    expect(units).toEqual([231_218, 232_218])
    expect(unitsToRange(YEAST, units as [number, number])).toEqual({
      contig: 'II',
      start: 1000,
      end: 2000,
    })
  })

  // A window spanning a boundary is named by the sequence most of it is on,
  // rather than by whichever end happens to come first.
  it('names a straddling window by its midpoint', () => {
    expect(unitsToRange(YEAST, [230_000, 240_000])?.contig).toBe('II')
    expect(unitsToRange(YEAST, [220_000, 231_000])?.contig).toBe('I')
  })
})

describe('lengthsAreExact', () => {
  it('is false only for lengths inferred from features', () => {
    for (const origin of ['sizes', 'bigwig', 'bigbed', 'cooler'] as const) {
      expect(lengthsAreExact({ ...YEAST, origin })).toBe(true)
    }
    expect(lengthsAreExact({ ...YEAST, origin: 'features' })).toBe(false)
  })
})

/**
 * Which file is allowed to put lengths under a browser that guessed them.
 *
 * The Genome card offers *"drop a chrom.sizes or a bigWig to replace them with
 * the real ones"*, and the rule behind that sentence has to be both halves of
 * an inequality: an exact answer replaces a guess, and nothing replaces an
 * exact answer. Getting the second half wrong is the silent one — a second BED
 * dropped after a bigWig would quietly put invented edges back under a genome
 * that was already right, and the card would go on saying so.
 */
describe('replacesLengths', () => {
  const guessed = assemblyOf({
    uri: 'peaks.bed',
    name: 'peaks',
    origin: 'features',
    contigs: [{ name: 'I', length: 231_000 }],
  })
  const real = [{ name: 'I', length: 230_218 }]

  it('takes exact lengths over inferred ones, whichever file states them', () => {
    // Every origin the worker can answer exactly with, not just `sizes`: a
    // bigWig header, a bigBed header, a FASTA, a BAM `@SQ` table and a VCF's
    // `##contig` block each carry a length per sequence (§8.13, §8.14).
    for (const origin of ['sizes', 'bigwig', 'bigbed', 'fasta', 'bam', 'vcf', 'cooler'] as const) {
      expect(replacesLengths(guessed, { origin, contigs: real })).toBe(true)
    }
  })

  it('never puts a guess over an answer', () => {
    // Both directions of the downgrade. A feature file's lower bound replaces
    // nothing, and an assembly that is already exact is never overwritten —
    // including by another exact file, which would otherwise let the second of
    // two bigWigs redraw a genome that was already right.
    expect(replacesLengths(guessed, { origin: 'features', contigs: real })).toBe(false)
    for (const origin of ['sizes', 'bigwig', 'features'] as const) {
      expect(replacesLengths({ ...guessed, origin: 'sizes' }, { origin, contigs: real })).toBe(false)
    }
  })

  it('refuses a file that answered nothing', () => {
    // An empty list is not a smaller genome — an HDF5 is reported with no
    // contigs at all — and adopting it would leave the browser with no axis.
    expect(replacesLengths(guessed, { origin: 'bigwig', contigs: [] })).toBe(false)
  })
})

/**
 * The bin size a genome with no contact map is drawn at.
 *
 * It exists because the placeholder it replaced — a bin size of `0` for a
 * mapless session — was safe only while no per-bin result could be produced
 * without a matrix. A task answering from the *sequence* broke that, and a zero
 * gives every contig zero bins: a lane that is permanently empty rather than one
 * that is visibly wrong, which is the failure nothing reports. So what is
 * asserted here is that the number is always usable, not merely plausible.
 */
describe('browsingBinsize', () => {
  it('is always a positive, usable bin size', () => {
    for (const total of [0, 1, 1_000, 12_100_000, 3_100_000_000]) {
      expect(browsingBinsize(total), `total ${total}`).toBeGreaterThan(0)
      expect(Number.isFinite(browsingBinsize(total))).toBe(true)
      expect(Number.isInteger(browsingBinsize(total))).toBe(true)
    }
  })

  it('scales with the genome rather than fixing a number', () => {
    // 1 kb bins are right for yeast and are three million bins of a human
    // assembly, which is a vector nobody can draw.
    expect(browsingBinsize(3_100_000_000)).toBeGreaterThan(browsingBinsize(12_100_000))
  })

  it('lands on a round number, on the ladder the rulers step by', () => {
    for (const total of [5e5, 1e6, 1.21e7, 1e8, 3.1e9]) {
      const step = browsingBinsize(total)
      const decade = 10 ** Math.floor(Math.log10(step))
      expect([1, 2, 5, 10], `total ${total} gave ${step}`).toContain(Math.round(step / decade))
    }
  })

  it('keeps the bin count in a range a lane can actually draw', () => {
    for (const total of [1e6, 1.21e7, 1e8, 3.1e9]) {
      const bins = total / browsingBinsize(total)
      expect(bins, `total ${total}`).toBeGreaterThan(1_000)
      expect(bins, `total ${total}`).toBeLessThan(200_000)
    }
  })

  it('does not go below a floor, however small the genome', () => {
    // A plasmid is not a reason to bin at one base.
    expect(browsingBinsize(1_000)).toBeGreaterThanOrEqual(100)
    expect(browsingBinsize(0)).toBeGreaterThanOrEqual(100)
  })
})
