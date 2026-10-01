/**
 * A cytoBand, read (§8.22).
 *
 * Three claims. The **sniffer** takes every cytoBand — UCSC's five columns,
 * cytoBandIdeo's rows with an empty name, a whitespace file that collapsed that
 * name away — and nothing that is a BED: the test is a stain word in the last
 * column, which a BED5's numeric score never is. The **bands** carry what a
 * task and the card need: the name as the file writes it, the stain in the
 * detail, and the stain's darkness as the score. And the file **declares a
 * genome** exactly when its bands tile each sequence from its first base, and
 * only then.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import {
  cytoBandLengths,
  cytoBandSummary,
  iscnName,
  parseCytoBand,
  sniffCytoBand,
  stainDarkness,
  stainOf,
} from '@/annotations/cytoband'
import { cardFor, kindFor } from '@/annotations/loader'
import { sniffBarChart } from '@/annotations/barchart'
import { sniffJunctions } from '@/annotations/junctions'
import { sniffSignal } from '@/annotations/signal'
import { routeOf, unroutableNote } from '@/browse/route'

/** chr1's first bands and centromere, as UCSC's hg19 file writes them. */
const HG19 = [
  'chr1\t0\t2300000\tp36.33\tgneg',
  'chr1\t2300000\t5400000\tp36.32\tgpos25',
  'chr1\t5400000\t121500000\tp11.2\tgpos50',
  'chr1\t121500000\t125000000\tp11.1\tacen',
  'chr1\t125000000\t128900000\tq11\tacen',
  'chr1\t128900000\t142600000\tq12\tgvar',
  'chr1\t142600000\t249250621\tq44\tgpos100',
  'chr13\t0\t16300000\tp13\tgvar',
  'chr13\t16300000\t17900000\tp12\tstalk',
  'chr13\t17900000\t115169878\tq34\tgneg',
].join('\n')

/** hg38's cytoBandIdeo: every unplaced sequence is one band with no name. */
const IDEO = [
  'chr1\t0\t2300000\tp36.33\tgneg',
  'chr1_KI270706v1_random\t0\t175055\t\tgneg',
  'chrUn_GL000195v1\t0\t182896\t\tgneg',
].join('\n')

describe('what a cytoBand is', () => {
  it('is five columns ending in a stain', () => {
    expect(sniffCytoBand(HG19)).toBe(true)
  })

  it('takes cytoBandIdeo’s nameless rows, tab-separated or collapsed by spaces', () => {
    expect(sniffCytoBand(IDEO)).toBe(true)
    expect(sniffCytoBand(IDEO.replace(/\t+/g, ' '))).toBe(true)
  })

  it('reads through a header, a comment and a track line', () => {
    expect(sniffCytoBand(`#chrom\tchromStart\tchromEnd\tname\tgieStain\n${HG19}`)).toBe(true)
    expect(sniffCytoBand(`track name=bands\n${HG19}`)).toBe(true)
  })

  it('leaves a BED5 alone, whose fifth column is a score', () => {
    expect(sniffCytoBand('chr1\t0\t100\tpeak1\t960\nchr1\t200\t300\tpeak2\t40')).toBe(false)
  })

  it('leaves a BED6 alone, however it names its features', () => {
    expect(sniffCytoBand('chr1\t0\t100\tgneg\t0\t+')).toBe(false)
  })

  it('is not claimed by the sniffers asked before it, and claims none of their files', () => {
    expect(sniffBarChart(HG19)).toBe(false)
    expect(sniffJunctions(HG19, 'cytoBand.txt')).toBe(null)
    expect(sniffSignal(HG19)).toBe(null)
    expect(sniffCytoBand('chr1\t0\t100\t2.5')).toBe(false)
  })
})

describe('a cytoBand, read', () => {
  const set = parseCytoBand(HG19)

  it('keeps each band’s name as the file writes it', () => {
    expect(set.name.slice(0, 4)).toEqual(['p36.33', 'p36.32', 'p11.2', 'p11.1'])
  })

  it('writes the stain in the detail, where the card and the key read it', () => {
    expect(set.detail.map(stainOf)).toEqual([
      'gneg',
      'gpos25',
      'gpos50',
      'acen',
      'acen',
      'gvar',
      'gpos100',
      'gvar',
      'stalk',
      'gneg',
    ])
  })

  it('scores a band by how dark it stains, and leaves the three that are not a darkness empty', () => {
    expect(stainDarkness('gneg')).toBe(0)
    expect(stainDarkness('gpos25')).toBe(25)
    expect(stainDarkness('gpos33')).toBe(33)
    expect(stainDarkness('gpos')).toBe(100)
    expect(stainDarkness('acen')).toBeNaN()
    expect(stainDarkness('gvar')).toBeNaN()
    expect(stainDarkness('stalk')).toBeNaN()
    expect(Array.from(set.score.slice(0, 3))).toEqual([0, 25, 50])
  })

  it('carries no strand, since a band has none', () => {
    expect(Array.from(set.strand).every((strand) => strand === 0)).toBe(true)
  })

  it('names a band in ISCN, chromosome first and without UCSC’s prefix', () => {
    expect(iscnName('chrX', 'q28')).toBe('Xq28')
    expect(iscnName('1', 'p36.33')).toBe('1p36.33')
    expect(iscnName('chrUn_GL000195v1', '')).toBe('Un_GL000195v1')
  })

  it('says what it holds', () => {
    expect(cytoBandSummary(set)).toBe('10 bands · 2 sequences · 2 centromeric')
    expect(cytoBandSummary(parseCytoBand(IDEO))).toBe('3 bands · 3 sequences · 1 named')
  })
})

describe('the genome a cytoBand declares', () => {
  it('is each sequence to the end of its last band, when the bands tile it', () => {
    expect(cytoBandLengths(parseCytoBand(HG19))).toEqual([
      { name: 'chr1', length: 249_250_621 },
      { name: 'chr13', length: 115_169_878 },
    ])
  })

  it('is nothing at all when a sequence’s bands leave a gap', () => {
    const gapped = HG19.replace('chr1\t2300000\t5400000', 'chr1\t2400000\t5400000')
    expect(cytoBandLengths(parseCytoBand(gapped))).toBe(null)
  })

  it('is nothing when a sequence’s first band does not start at its first base', () => {
    expect(cytoBandLengths(parseCytoBand('chr1\t100\t200\tp1\tgneg'))).toBe(null)
  })
})

describe('where a cytoBand goes', () => {
  it('is a lane of its own kind', () => {
    expect(cardFor('cytoband')).toBe('linear')
    expect(kindFor('linear', 'cytoband')).toBe('ideogram')
    expect(kindFor('overlay', 'cytoband')).toBe(null)
  })

  it('opens a browser under the names UCSC publishes it by', () => {
    expect(routeOf('https://example.org/hg38/cytoBandIdeo.txt.gz')).toBe('genome')
    expect(routeOf('cytoBand.txt')).toBe('genome')
  })

  it('opens one named in the plural too, as the yeast demo’s is', () => {
    // The demo's own karyotype was a row the Files column dimmed, in a folder
    // whose every other file it offered: the pattern knew UCSC's two table
    // names and not a file named for its bands.
    expect(routeOf('demo/yeast/Yeast_cytobands.txt')).toBe('genome')
    expect(unroutableNote('Yeast_cytobands.txt')).toBeNull()
    expect(routeOf('https://example.org/sample.cytobands.txt.gz')).toBe('genome')
    // …and nothing that merely mentions bands in passing.
    expect(routeOf('cytobands.pdf')).toBe('unknown')
  })
})

describe('the demo files', () => {
  it('reads UCSC’s hg19 bands, which tile the human karyotype', () => {
    const text = readFileSync(join(process.cwd(), 'demo/human/hg19_cytoBand.txt'), 'utf8')
    expect(sniffCytoBand(text)).toBe(true)
    const set = parseCytoBand(text)
    expect(set.length).toBe(862)
    const lengths = cytoBandLengths(set)
    expect(lengths).toHaveLength(24)
    // hg19's chrX, to the base — and the length the Geuvadis BAM's header gives.
    expect(lengths?.find((contig) => contig.name === 'chrX')?.length).toBe(155_270_560)
    const stains = new Set(set.detail.map(stainOf))
    expect([...stains].sort()).toEqual(['acen', 'gneg', 'gpos100', 'gpos25', 'gpos50', 'gpos75', 'gvar', 'stalk'])
  })

  it('reads the yeast karyotype: two arms, a centromere and XII’s rDNA as a stalk', () => {
    const text = readFileSync(join(process.cwd(), 'demo/yeast/Yeast_cytobands.txt'), 'utf8')
    expect(sniffCytoBand(text)).toBe(true)
    const set = parseCytoBand(text)
    const lengths = cytoBandLengths(set)
    expect(lengths).toHaveLength(16)
    expect(lengths?.find((contig) => contig.name === 'IV')?.length).toBe(1_531_933)
    // Two centromeric bands per chromosome, split at the CEN element's middle.
    expect(set.detail.filter((detail) => stainOf(detail) === 'acen')).toHaveLength(32)
    const stalks = set.detail.flatMap((detail, at) => (stainOf(detail) === 'stalk' ? [at] : []))
    expect(stalks).toHaveLength(1)
    expect(set.contigs[set.contig[stalks[0]]]).toBe('XII')
  })
})
