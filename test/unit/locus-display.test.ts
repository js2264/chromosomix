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
  formatLocus,
  formatPosition,
  regionLabel,
  typedLocusToRegion,
  windowLabel,
} from '../../src/genome/assembly'

describe('formatPosition', () => {
  it('adds the one and groups the digits, like the window beside it', () => {
    expect(formatPosition('IV', 1_162_000)).toBe('IV:1,162,001')
    expect(formatPosition('chr1', 0)).toBe('chr1:1')
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
