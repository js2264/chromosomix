/**
 * The window a map is currently showing, as the line under it says so.
 *
 * The 1D browser has always said `chrI · 23.6 kb · 23 bp per pixel`; the map
 * said how many bins it held and how wide one was, and nothing at all about
 * *where*. So a reader who zoomed into a heatmap could not read the coordinate
 * range off the screen at any magnification.
 *
 * Asserted through the two exported phrase builders, because the panel that
 * mounts them needs a canvas and this suite runs in Node. The arithmetic behind
 * them is `LocusAxis.windows`, which `locus-axis.test.ts` pins against the
 * readout's own formula — so a drift between what is drawn and what is written
 * fails there, and what is asserted here is only the wording.
 */

import { describe, expect, it } from 'vitest'

import { framedPhrase, windowPhrase } from '@/ui/mapSummary'
import { locusAxisFrom, type AxisRun } from '@/render/locus'
import { parseLocus } from '@/genome/assembly'

const BIN = 1000

/** One chromosome, 400 bins of 1 kb, opening at its own first base. */
const ONE = locusAxisFrom({
  runs: [{ label: 'chrI', start: 0, end: 400, unitStart: 0, unitLength: 400_000 }],
  blockStart: 0,
  level: 'bin',
  binsize: BIN,
  contigLength: () => undefined,
})

/** Three chromosomes end to end, as `view=whole` renders them. */
const WHOLE = locusAxisFrom({
  runs: [
    { label: 'I', start: 0, end: 231, unitStart: 0, unitLength: 230_218 },
    { label: 'II', start: 231, end: 1045, unitStart: 231, unitLength: 813_184 },
    { label: 'IV', start: 1045, end: 2577, unitStart: 1045, unitLength: 1_531_933 },
  ],
  blockStart: 0,
  level: 'bin',
  binsize: BIN,
  contigLength: () => undefined,
})

describe('the window one axis is showing', () => {
  it('names the sequence and how much of it is on screen', () => {
    expect(windowPhrase(ONE!.windows([0, 400]))).toBe('chrI:1-400,000 · 400.0 kb')
  })

  // The whole point: the phrase narrows with the domain, which is what a zoom
  // moves and what the old line could not report at all.
  it('narrows with the zoom', () => {
    expect(windowPhrase(ONE!.windows([100, 140]))).toBe('chrI:100,001-140,000 · 40.0 kb')
  })

  // What is written has to be what the region box would take, or copying a
  // coordinate out of the subtitle and into the box moves the picture.
  it('writes a locus the box parses back to the same window', () => {
    const phrase = windowPhrase(ONE!.windows([100, 140]))
    const assembly = {
      uri: 'x.cool',
      name: 'x',
      contigs: [{ name: 'chrI', length: 400_000, start: 0 }],
      total: 400_000,
      origin: 'cooler' as const,
    }
    expect(parseLocus(phrase.split(' · ')[0], assembly)).toEqual({
      contig: 'chrI',
      start: 100_000,
      end: 140_000,
    })
  })

  // Two is a pair a reader can hold; sixteen is a paragraph. The same choice
  // `BrowserView.zoomPhrase` makes with "4 of 16 sequences".
  it('names two sequences and counts more than two', () => {
    expect(windowPhrase(WHOLE!.windows([200, 400]))).toBe('I:200,001-230,218 + II:1-169,000 · 199.2 kb')
    expect(windowPhrase(WHOLE!.windows([0, 2577]))).toBe('3 sequences · 2.58 Mb')
  })

  it('says nothing about an axis showing nothing', () => {
    expect(windowPhrase([])).toBe('')
  })
})

describe('both axes of what is on screen', () => {
  // On the diagonal the two windows are one window, and printing it twice says
  // the picture is of two things when it is of one.
  it('says it once when the two agree', () => {
    const window = ONE!.windows([100, 140])
    expect(framedPhrase(window, window)).toBe('chrI:100,001-140,000 · 40.0 kb')
  })

  it('names both when they differ, as a two-region block does', () => {
    expect(framedPhrase(ONE!.windows([0, 100]), ONE!.windows([300, 400]))).toBe(
      'chrI:1-100,000 · 100.0 kb × chrI:300,001-400,000 · 100.0 kb',
    )
  })

  // Above bin level a cell *is* a sequence, so there is no axis to describe —
  // and an empty phrase is what leaves the line saying only what it can.
  it('is empty where neither axis has coordinates', () => {
    expect(
      locusAxisFrom({
        runs: [{ label: 'MAG_1', start: 0, end: 1 }] as AxisRun[],
        blockStart: 0,
        level: 'genome',
        binsize: BIN,
        contigLength: () => undefined,
      }),
    ).toBeNull()
    expect(framedPhrase([], [])).toBe('')
  })
})
