/**
 * A whole text file parsed in the annotations worker without holding it
 * (§8.6, `annotations/parse.ts`).
 *
 * The worker is one thread for every track of a tab: it opens them and answers
 * each lane's request for its window. The landing page's *Human Hi-C data*
 * parses IGV's RefSeq genes — 166,923 transcripts, 54 MB of text — and its ten
 * bigWig lanes, open and asking long before, were answered only when that had
 * finished. So the row parsers are fed a row at a time, by a walk that hands
 * the thread back every few milliseconds, and nothing about what they make of
 * the rows may change: same rows, same numbers, same order.
 *
 * Two of the steps that walk took were also the slowest parts of the parse and
 * are rewritten a character at a time — `isInteger`, asked of every coordinate,
 * and a genePred's exon lists, which used to be read twice a row — so they are
 * held here to exactly what they were.
 */

import { describe, expect, it } from 'vitest'

import { yieldToEventLoop } from '@/async'
import { genePredOffset, genePredParser, parseGenePred } from '@/annotations/genepred'
import {
  bedParser,
  bedpeParser,
  forEachRow,
  forEachRowCooperatively,
  gtfParser,
  isInteger,
  parseBed,
  parseBedpe,
  parseCooperatively,
  parseGtf,
} from '@/annotations/parse'

/** A genePred of `n` transcripts on two contigs, out of order, with comments and blank lines in it. */
function genePredText(n: number): string {
  const lines = ['# a comment', 'track name=genes', '']
  for (let i = 0; i < n; i++) {
    const contig = i % 3 === 0 ? 'chr2' : 'chr1'
    const start = 1000 + ((i * 7919) % 500_000)
    const exons = 1 + (i % 4)
    const starts: number[] = []
    const ends: number[] = []
    for (let e = 0; e < exons; e++) {
      starts.push(start + e * 300)
      ends.push(start + e * 300 + 200)
    }
    const end = ends[ends.length - 1]
    const coding = i % 5 !== 0
    lines.push(
      [
        `NM_${i}`,
        contig,
        i % 2 === 0 ? '+' : '-',
        start,
        end,
        coding ? start + 50 : end,
        coding ? end - 50 : end,
        exons,
        `${starts.join(',')},`,
        `${ends.join(',')},`,
        '0',
        `GENE${i % 97}`,
        'cmpl',
        'cmpl',
        '0,0,',
      ].join('\t'),
    )
  }
  return lines.join('\n') + '\n'
}

describe('walking a file in slices', () => {
  it('visits the same rows, with the same line numbers, as the walk in one stretch', async () => {
    const text = 'a\tb\n# skipped\n\ntrack x\nc d  e\r\nf\tg\th'
    const once: Array<[string[], number]> = []
    forEachRow(text, (columns, line) => once.push([columns, line]))
    const sliced: Array<[string[], number]> = []
    // A slice of nothing at all: the walk yields after every 256 lines it can.
    await forEachRowCooperatively(text, (columns, line) => sliced.push([columns, line]), 0)
    expect(sliced).toEqual(once)
    expect(once.map(([, line]) => line)).toEqual([1, 5, 6])
  })

  it('hands the thread back while it parses, so a request waiting behind it is answered', async () => {
    const text = genePredText(40_000)
    const answered: string[] = []
    // What a lane's sample is to the worker: a task queued after the parse began.
    const lane = yieldToEventLoop().then(() => answered.push('lane'))
    const parse = parseCooperatively(text, genePredParser()).then(() => answered.push('genes'))
    await Promise.all([lane, parse])
    expect(answered).toEqual(['lane', 'genes'])
  })

  it('makes exactly what the parse in one stretch makes, for each of the four formats', async () => {
    const genes = genePredText(3000)
    expect(await parseCooperatively(genes, genePredParser())).toEqual(parseGenePred(genes))

    const bed = 'chrom\tstart\tend\tname\n' + Array.from({ length: 2000 }, (_, i) => `chr${1 + (i % 3)}\t${i * 10}\t${i * 10 + 5}\tf${i}`).join('\n')
    expect(await parseCooperatively(bed, bedParser(bed, 'x.bed'))).toEqual(parseBed(bed, 'x.bed'))

    const gtf = Array.from({ length: 1500 }, (_, i) =>
      [
        'chr1\tsrc\texon',
        `${100 + i * 10}\t${105 + i * 10}\t.\t+\t.`,
        `gene_id "g${i >> 2}"; transcript_id "t${i >> 1}"; gene_name "G${i >> 2}";`,
      ].join('\t'),
    ).join('\n')
    expect(await parseCooperatively(gtf, gtfParser(gtf))).toEqual(parseGtf(gtf))

    const bedpe = Array.from({ length: 2000 }, (_, i) => `chr1\t${i}\t${i + 10}\tchr2\t${i * 3}\t${i * 3 + 10}\tloop${i}\t${i % 7}`).join('\n')
    expect(await parseCooperatively(bedpe, bedpeParser(bedpe))).toEqual(parseBedpe(bedpe))
  })

  it('refuses what the parse in one stretch refuses, in the same words', async () => {
    const text = 'not\ta\tgene\tmodel\n'
    expect(() => parseGenePred(text)).toThrow(/No usable rows/)
    await expect(parseCooperatively(text, genePredParser())).rejects.toThrow(/No usable rows/)
  })
})

describe('the integer test, a character at a time', () => {
  it('says what /^[+-]?\\d+$/ says, on the cases that decide it', () => {
    const regex = /^[+-]?\d+$/
    const cases = [
      '', '+', '-', '0', '-0', '+5', '-5', '007', '5a', 'a5', ' 5', '5 ', '1e3', '1.0', '١٢', '++1', '+-1', '12345678901234567890',
      '\n5', '5\n',
    ]
    for (const value of cases) expect(isInteger(value), JSON.stringify(value)).toBe(regex.test(value))
    expect(isInteger(undefined)).toBe(false)
  })

  it('agrees with it on a few thousand strings made of the characters that matter', () => {
    const regex = /^[+-]?\d+$/
    const alphabet = ['0', '7', '9', '+', '-', ' ', 'x', ',', '.']
    let seed = 7
    for (let n = 0; n < 5000; n++) {
      let value = ''
      const length = n % 6
      for (let i = 0; i < length; i++) {
        seed = (seed * 1103515245 + 12345) % 2147483648
        value += alphabet[seed % alphabet.length]
      }
      expect(isInteger(value), JSON.stringify(value)).toBe(regex.test(value))
    }
  })
})

describe('a genePred’s exon lists, read once', () => {
  const row = (starts: string, ends: string): string[] =>
    `NM_1\tchr1\t+\t100\t900\t100\t900\t2\t${starts}\t${ends}`.split('\t')

  it('takes the trailing comma UCSC writes, and an empty part anywhere', () => {
    expect(genePredOffset(row('100,500,', '200,900,'))).toBe(0)
    expect(genePredOffset(row('100,500', '200,900'))).toBe(0)
    expect(genePredOffset(row(',100,,500,', '200,,900'))).toBe(0)
  })

  it('takes a sign the integer test takes, and refuses a negative number', () => {
    expect(genePredOffset(row('+100,500,', '200,+900,'))).toBe(0)
    expect(genePredOffset(row('-100,500,', '200,900,'))).toBe(-1)
  })

  it('refuses a part that is not a number, as the old read did', () => {
    for (const bad of ['100, 500,', '100,5e2,', '100,500.0,', '100,+,', '100,-,', 'x,500,']) {
      expect(genePredOffset(row(bad, '200,900,')), bad).toBe(-1)
    }
    expect(genePredOffset(row(',', ','))).toBe(-1)
  })

  it('reads the exons the parse draws from the same lists the test read', () => {
    const set = parseGenePred(row('100,500,', '200,900,').join('\t'))
    expect([...set.exonStart]).toEqual([100, 500])
    expect([...set.exonEnd]).toEqual([200, 900])
  })
})
