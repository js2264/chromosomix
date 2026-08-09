/**
 * Called intervals leave as BED, and come back through this app's own reader.
 *
 * `TASKS_PLAN.md` §7 asks for exactly one property here and it is not the text:
 * *BED out → the app's own parser in*. A boundary set that a reader downloads
 * and cannot load back — into this app, into bedtools, into IGV — is a file that
 * looks like an export and is not one, and nothing about the string it contains
 * would tell them so before they tried.
 *
 * The other half is that this is the **same writer** the hand-drawn marks use
 * (`annotations/export.ts`). Two BED writers in one repository is two opinions
 * about half-open ends waiting to diverge, and `manual-export.test.ts` and this
 * file now pin the same one.
 */

import { describe, expect, it } from 'vitest'

import { formatIntervals } from '@/annotations/export'
import { FeatureBuilder, PairBuilder } from '@/annotations/featureset'
import { parseBed, parseBedpe, sniffFormat } from '@/annotations/parse'
import type { AnnotationPayload } from '@/annotations/types'

/** Boundaries as `analysis/run/insulation.ts` calls them: one bin wide, scored. */
function boundaries(): AnnotationPayload {
  const builder = new FeatureBuilder()
  builder.add('I', 120_000, 121_000, { score: 0.83, detail: 'insulation -1.402 · prominence 0.83' })
  builder.add('I', 143_000, 144_000, { score: 1.2, detail: 'insulation -2.010 · prominence 1.20' })
  builder.add('XIII-syn40', 4_000, 5_000, { score: 0.41, name: 'named boundary' })
  return { kind: 'features', data: builder.finish() }
}

/** Domains as a loop-shaped output: two anchors, one score. */
function domains(): AnnotationPayload {
  const builder = new PairBuilder()
  builder.add('IV', 10_000, 11_000, 'IV', 40_000, 41_000, { score: 3.5 })
  builder.add('IV', 60_000, 61_000, 'IV', 95_000, 96_000, { score: 2.25 })
  return { kind: 'pairs', data: builder.finish() }
}

/** The rows, with the provenance comment dropped. */
function rows(text: string): string[] {
  return text
    .trim()
    .split('\n')
    .filter((line) => line !== '' && !line.startsWith('#'))
}

describe('formatIntervals, as BED', () => {
  it('writes the coordinates the call was made at, unrounded and half-open', () => {
    expect(rows(formatIntervals(boundaries()))).toEqual([
      'I\t120000\t121000\tregion_1\t0.83\t.',
      'I\t143000\t144000\tregion_2\t1.2\t.',
      'XIII-syn40\t4000\t5000\tnamed_boundary\t0.41\t.',
    ])
  })

  it('carries where it came from as a comment, which every reader skips', () => {
    const text = formatIntervals(boundaries(), {
      label: 'Insulation boundaries',
      file: 'chrIV:1–1,531,933 at 1 kb, balanced',
      created: '2026-08-08T14:52:33',
    })
    const head = text.split('\n')[0]
    expect(head.startsWith('#')).toBe(true)
    expect(head).toContain('Insulation boundaries')
    expect(head).toContain('chrIV:1–1,531,933 at 1 kb, balanced')
  })

  it('never writes an empty name column', () => {
    // A blank column 4 makes a five-column line that a strict parser reads as a
    // four-column one with a blank score — and the strand then lands in the
    // wrong place, silently, in a file that still opens.
    for (const line of rows(formatIntervals(boundaries()))) {
      const fields = line.split('\t')
      expect(fields).toHaveLength(6)
      expect(fields[3]).not.toBe('')
      expect(fields[3]).not.toContain(' ')
    }
  })

  it('is a legal BED with a header only, when there is nothing to write', () => {
    const empty = formatIntervals({ kind: 'features', data: new FeatureBuilder().finish() })
    expect(rows(empty)).toEqual([])
    expect(empty.startsWith('#')).toBe(true)
  })
})

describe('formatIntervals, as BEDPE', () => {
  it('writes both anchors with their own contig', () => {
    expect(rows(formatIntervals(domains()))).toEqual([
      'IV\t10000\t11000\tIV\t40000\t41000\tregion_1\t3.5\t.\t.',
      'IV\t60000\t61000\tIV\t95000\t96000\tregion_2\t2.25\t.\t.',
    ])
  })
})

describe('the round trip', () => {
  it('is sniffed as BED and parsed back to the same intervals', () => {
    const text = formatIntervals(boundaries(), { label: 'Insulation boundaries' })
    expect(sniffFormat(text, 'insulation-boundaries.bed')).toBe('bed')

    const back = parseBed(text, 'insulation-boundaries.bed')
    expect(back.length).toBe(3)
    expect(Array.from(back.start)).toEqual([120_000, 143_000, 4_000])
    expect(Array.from(back.end)).toEqual([121_000, 144_000, 5_000])
    expect(back.contigs).toEqual(['I', 'XIII-syn40'])
    expect(Array.from(back.score).map((v) => Number(v.toPrecision(6)))).toEqual([0.83, 1.2, 0.41])
  })

  it('is sniffed as BEDPE and parsed back to the same anchors', () => {
    const text = formatIntervals(domains(), { label: 'Domains' })
    expect(sniffFormat(text, 'domains.bedpe')).toBe('bedpe')

    const back = parseBedpe(text)
    expect(back.length).toBe(2)
    expect(Array.from(back.start1)).toEqual([10_000, 60_000])
    expect(Array.from(back.end2)).toEqual([41_000, 96_000])
  })

  it('survives a second round trip unchanged, which is what makes it a format', () => {
    // Once is a parser being lenient; twice is the writer and the reader agreeing
    // on a fixed point. A `.` strand read back as 0 and written again as `.` is
    // the case this catches.
    const once = formatIntervals(boundaries())
    const twice = formatIntervals({ kind: 'features', data: parseBed(once, 'x.bed') })
    expect(rows(twice)).toEqual(rows(once))
  })
})
