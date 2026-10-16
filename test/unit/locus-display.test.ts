/**
 * The four coordinate spellings, and the law that keeps them one.
 *
 * This app holds a genome coordinate in three forms, and the whole reason these
 * helpers exist is that only one of them is for a reader. The *machine* form is
 * cooler's — 0-based, half-open, ungrouped, `IV:1000000-1400000` — and it is
 * what the state carries, what a shared link encodes and what
 * `metacooler show --range` takes, so it cannot change. The *display* form is
 * 1-based inclusive with separators, which is what IGV, UCSC, samtools and
 * every paper print, and is therefore what a reader recognises. The *typed*
 * form is whatever they paste into a box, which is the display form plus every
 * spelling anyone has ever used for it.
 *
 * The law is the round trip: what a box shows must be what the box accepts, or
 * pressing Enter on an untouched locus moves the view by a base — which is the
 * bug that is invisible until someone compares a screenshot to a bedtools
 * output and finds the app off by one.
 */

import { describe, expect, it } from 'vitest'
import {
  baseLabel,
  formatLocus,
  formatPosition,
  pairLabel,
  regionLabel,
  typedLociToRegions,
  typedLocusToRegion,
  typedPosition,
  windowLabel,
} from '../../src/genome/assembly'
import { parseRegionString, splitRegionList } from '../../src/metacooler/range'
import { runnerParams } from '../../src/analysis/job'
import { FOURC_TASK } from '../../src/analysis/tasks/fourc'
import { RECONSTRUCT_TASK, SPATIAL_TRACKS_TASK } from '../../src/analysis/tasks/structure'

describe('formatPosition', () => {
  it('adds the one and groups the digits, like the window beside it', () => {
    expect(formatPosition('IV', 1_162_000)).toBe('IV:1,162,001')
    expect(formatPosition('chr1', 0)).toBe('chr1:1')
  })
})

describe('baseLabel', () => {
  it('is formatPosition without the name, for a card that has already said it', () => {
    expect(baseLabel(1_162_000)).toBe('1,162,001')
    expect(baseLabel(0)).toBe('1')
    expect(formatPosition('IV', 1_162_000)).toBe(`IV:${baseLabel(1_162_000)}`)
  })
})

describe('typedPosition', () => {
  it('reads a typed base 1-based, and never lands before the first', () => {
    expect(typedPosition(1_162_001)).toBe(1_162_000)
    expect(typedPosition(1)).toBe(0)
    expect(typedPosition(0)).toBe(0)
  })

  it('is the inverse of the base a reader is shown', () => {
    for (const bp0 of [0, 1, 999, 1_162_000]) {
      expect(typedPosition(Number(baseLabel(bp0).replace(/,/g, '')))).toBe(bp0)
    }
  })
})

describe('regionLabel', () => {
  it('shows a machine region the way a reader reads it', () => {
    expect(regionLabel('IV:1000000-1400000')).toBe('IV:1,000,001-1,400,000')
    expect(regionLabel('chr1:0-1000')).toBe('chr1:1-1,000')
  })

  it('leaves a bare name alone — a sequence, a genome, a MAG', () => {
    expect(regionLabel('chrII')).toBe('chrII')
    expect(regionLabel('MAG_004')).toBe('MAG_004')
    expect(regionLabel('*')).toBe('*')
  })

  it('hands back anything the tokenizer refuses, so the refusal is about what was typed', () => {
    expect(regionLabel('IV:not-a-number')).toBe('IV:not-a-number')
  })

  it('shows a half-open end as open rather than inventing one', () => {
    expect(regionLabel('IV:1000000-')).toBe('IV:1,000,001-')
  })
})

describe('windowLabel', () => {
  it('is the display form without the name, for the crumb that sits under it', () => {
    expect(windowLabel('IV:1000000-1400000')).toBe('1,000,001-1,400,000')
  })

  it('keeps the name where dropping it would leave nothing to read', () => {
    // A bare sequence, and a window whose end the state leaves open: neither is
    // a pair of coordinates, so the crumb says the whole thing rather than a
    // fragment.
    expect(windowLabel('chrII')).toBe('chrII')
    expect(windowLabel('IV:1000000-')).toBe('IV:1,000,001-')
    expect(windowLabel('IV:not-a-number')).toBe('IV:not-a-number')
  })
})

describe('typedLocusToRegion', () => {
  it('reads the box as 1-based inclusive, which is what the box shows', () => {
    expect(typedLocusToRegion('IV:1,000,001-1,400,000')).toBe('IV:1000000-1400000')
    expect(typedLocusToRegion('chr1:1-1,000')).toBe('chr1:0-1000')
  })

  it('takes the spellings other browsers write', () => {
    // An en dash, from a locus copied out of a PDF.
    expect(typedLocusToRegion('IV:1,000,001–1,400,000')).toBe('IV:1000000-1400000')
    // Ensembl's `..`.
    expect(typedLocusToRegion('IV:1000001..1400000')).toBe('IV:1000000-1400000')
    // The units the tokenizer already took.
    expect(typedLocusToRegion('IV:1kb-2kb')).toBe('IV:999-2000')
    expect(typedLocusToRegion('  IV:1,000,001-1,400,000  ')).toBe('IV:1000000-1400000')
  })

  it('passes a name through — there is no coordinate to shift', () => {
    expect(typedLocusToRegion('chrII')).toBe('chrII')
    expect(typedLocusToRegion('MAG_004')).toBe('MAG_004')
    expect(typedLocusToRegion('GAL4')).toBe('GAL4')
    expect(typedLocusToRegion('*')).toBe('*')
  })

  it('never lands before the first base, however far back the one takes it', () => {
    expect(typedLocusToRegion('IV:0-1000')).toBe('IV:0-1000')
  })

  it('leaves what the parser will refuse for the parser to refuse', () => {
    expect(typedLocusToRegion('IV:one-two')).toBe('IV:one-two')
  })

  it('keeps a window that runs backwards over a circle’s origin (§8.15)', () => {
    expect(typedLocusToRegion('chrM:16,000-500')).toBe('chrM:15999-500')
  })
})

describe('the round trip', () => {
  // THE LAW. Pressing Enter on the value a locus box is showing must not move
  // the view. Every box in the app shows `regionLabel` of its region and reads
  // what is typed with `typedLocusToRegion`, so this is the one property that
  // has to hold for all of them at once.
  it('gets back exactly the region it was shown, for every region with coordinates', () => {
    for (const region of [
      'IV:1000000-1400000',
      'chr1:0-1000',
      'chrX:0-155270560',
      'scaffold_1:12-13',
      'II:230218-230218',
      'contig-with-dashes:500-600',
    ]) {
      expect(typedLocusToRegion(regionLabel(region))).toBe(region)
    }
  })

  it('holds for a bare name too, which is the other thing a box can hold', () => {
    for (const name of ['chrII', 'MAG_004', '*', 'GAL4']) {
      expect(typedLocusToRegion(regionLabel(name))).toBe(name)
    }
  })

  it('agrees with formatLocus, which is where the display form was first written', () => {
    expect(regionLabel('IV:1000000-1400000')).toBe(formatLocus({ contig: 'IV', start: 1_000_000, end: 1_400_000 }))
  })
})

/**
 * Two windows typed as one (§5.4): rows, then columns, for the block between
 * them. Everything after the first window used to be dropped without a word,
 * because the tokenizer stops at the end coordinate.
 */
describe('a block of two windows, typed', () => {
  it('reads the three spellings a reader writes, and the box’s own ×', () => {
    for (const typed of [
      'chr1:1000-2000 chr2:3000-4000',
      'chr1:1000-2000 x chr2:3000-4000',
      'chr1:1000-2000 X chr2:3000-4000',
      'chr1:1000-2000|chr2:3000-4000',
      'chr1:1000-2000 | chr2:3000-4000',
      'chr1:1,000-2,000 × chr2:3,000-4,000',
    ]) {
      expect(typedLociToRegions(typed)).toEqual({ region: 'chr1:999-2000', region2: 'chr2:2999-4000' })
    }
  })

  it('reads each window as a single one is read: units, en dashes, a bare name', () => {
    expect(typedLociToRegions('IV:1kb–2kb x V')).toEqual({ region: 'IV:999-2000', region2: 'V' })
    expect(typedLociToRegions('IV V:1-100')).toEqual({ region: 'IV', region2: 'V:0-100' })
    expect(typedLociToRegions('X x Y')).toEqual({ region: 'X', region2: 'Y' })
  })

  it('leaves one window one, a space or an x inside it included', () => {
    expect(typedLociToRegions('IV:1,000 - 20,000')).toEqual({ region: 'IV:999-20000' })
    expect(typedLociToRegions('chrX:1-100')).toEqual({ region: 'chrX:0-100' })
    // Two bare names need a mark: a space alone would split a name holding one.
    expect(typedLociToRegions('I II')).toEqual({ region: 'I II' })
    // A pipe inside a name, as NCBI's older names have, is the name's.
    expect(typedLociToRegions('gi|1|ref|NC_000913.2|:1-100')).toEqual({ region: 'gi|1|ref|NC_000913.2|:0-100' })
    // A mark with nothing after it is not a pair.
    expect(typedLociToRegions('IV:1-100 |').region2).toBeUndefined()
  })

  it('gets back the block it was shown — the round trip, for two windows', () => {
    for (const [region, region2] of [
      ['IV:1000000-1400000', 'V:0-200000'],
      ['chr1:0-1000', 'chr1:5000-6000'],
      ['chrX:0-155270560', 'chrY'],
    ] as const) {
      expect(typedLociToRegions(pairLabel(region, region2))).toEqual({ region, region2 })
    }
  })
})

describe('a locus parameter, on its way to a runner (§18.2)', () => {
  // The form, a result's provenance, a workspace and a `chromosomix` line all
  // hold the typed form; `runnerParams` is the one place it becomes cooler's
  // grammar. So the round trip for an analysis box is: the display form the box
  // is seeded or picked with, read as typed, handed over as the machine form —
  // and shown again as the same display form.
  it('hands the runner the machine form of what the box shows', () => {
    for (const region of ['IV:1000000-1400000', 'chr1:0-1000', 'II:230000-1043000']) {
      const shown = regionLabel(region)
      const handed = runnerParams(FOURC_TASK.params, { anchor: shown })
      expect(handed.anchor).toBe(region)
      expect(regionLabel(handed.anchor as string)).toBe(shown)
    }
  })

  it('reads a list one part at a time, and keeps the list a list', () => {
    const handed = runnerParams(RECONSTRUCT_TASK.params, { region: 'IV:1,000,001-1,400,000, V' })
    expect(handed.region).toBe('IV:1000000-1400000, V')
    expect(splitRegionList(handed.region as string)).toEqual(['IV:1000000-1400000', 'V'])
  })

  it('passes a name through, and every other parameter untouched', () => {
    const params = { structure: 's1', locus: 'chrII', window: 5 }
    const handed = runnerParams(SPATIAL_TRACKS_TASK.params, params)
    expect(handed).toEqual(params)
    // Nothing to convert is nothing copied: the same record goes to the worker.
    expect(handed).toBe(params)
    expect(runnerParams(FOURC_TASK.params, { anchor: '' })).toEqual({ anchor: '' })
  })
})

describe('a list of regions', () => {
  it('splits on its separators and leaves thousands separators alone', () => {
    // The defect this exists for: the reconstruction task's box takes several
    // sequences, comma-separated, and the seed it is given is a locus written the
    // way §26.1 writes one. Split plainly, `IV:1,000,001-1,400,000` is four
    // regions and the run comes back `Expected HYPHEN token missing`.
    expect(splitRegionList('IV:1,000,001-1,400,000')).toEqual(['IV:1,000,001-1,400,000'])
    expect(splitRegionList('I, II')).toEqual(['I', 'II'])
    expect(splitRegionList('I,II')).toEqual(['I', 'II'])
    expect(splitRegionList('IV:1,000-2,000, V')).toEqual(['IV:1,000-2,000', 'V'])
    // Ensembl-style names: a pair of contigs, not one mis-grouped number. Three
    // digits on the right is what makes a comma part of a number.
    expect(splitRegionList('1,2')).toEqual(['1', '2'])
    expect(splitRegionList('1, 2')).toEqual(['1', '2'])
    expect(splitRegionList('')).toEqual([])
    expect(splitRegionList('  ,  ')).toEqual([])
    // A grouped coordinate is still one region when more follow it.
    expect(splitRegionList('chr1:1,500,000-2,000,000,chr2')).toEqual([
      'chr1:1,500,000-2,000,000',
      'chr2',
    ])
  })

  it('hands every part to the range parser unchanged', () => {
    for (const part of splitRegionList('IV:1,000,001-1,400,000, V')) {
      expect(() => parseRegionString(part)).not.toThrow()
    }
  })
})
