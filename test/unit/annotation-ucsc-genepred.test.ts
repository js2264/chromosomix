/**
 * `genePred`, `genePredExt` and `refFlat` (§8.19).
 *
 * The thing worth testing hardest is the **offset**, because the same ten
 * columns start at column 0, 1 or 2 depending on whether the file is a refFlat
 * and whether it came out of a MySQL table with its `bin` index in front. Width
 * cannot decide it — eleven columns is a refFlat *or* a binned genePred — so
 * the reader tries each offset and keeps the one where the format agrees with
 * itself: a strand where a strand goes, and two comma lists that tile the
 * transcript they claim to describe.
 *
 * Getting that wrong does not fail loudly. It reads the gene symbol as an
 * accession, or the bin as a gene name, or — at the wrong offset entirely —
 * puts every exon in the wrong place while still producing a plausible lane.
 *
 * The second claim is about the exons themselves: a genePred's two lists are
 * **absolute coordinates**, where a BED12's are a size and an offset from the
 * feature's start. Reusing the BED path would have drawn every transcript's
 * exons starting at the transcript's own start plus its absolute position.
 */

import { describe, expect, it } from 'vitest'

import {
  genePredOffset,
  genePredSummary,
  isGenePredSchema,
  parseGenePred,
  sniffGenePred,
} from '@/annotations/genepred'
import { cardFor, kindFor } from '@/annotations/loader'
import { sniffFormat } from '@/annotations/parse'
import { routeOf } from '@/browse/route'
import type { FeatureSet } from '@/annotations/types'

/** Plain genePred: ten columns, the transcript's exons as absolute spans. */
const GENEPRED =
  'NM_001\tchr1\t+\t1000\t20000\t1200\t19000\t3\t1000,5000,18000,\t2000,6000,20000,'

/** The same rows with UCSC's `bin` index in front, as a table dump carries. */
const BINNED = `585\t${GENEPRED}`

/** refFlat: a gene symbol in front of the ten. */
const REFFLAT = `OR4F5\t${GENEPRED}`

/** genePredExt: five more columns, the symbol among them as `name2`. */
const GENEPRED_EXT = `${GENEPRED}\t0\tOR4F5\tcmpl\tcmpl\t0,1,2,`

/** A non-coding transcript writes an empty CDS, conventionally at `txEnd`. */
const NON_CODING =
  'NR_001\tchr1\t-\t1000\t20000\t20000\t20000\t2\t1000,18000,\t2000,20000,'

function exonsOf(set: FeatureSet, at: number): Array<[number, number]> {
  const out: Array<[number, number]> = []
  for (let i = set.exonAt[at]; i < set.exonAt[at + 1]; i++) {
    out.push([set.exonStart[i], set.exonEnd[i]])
  }
  return out
}

describe('genePred', () => {
  it('finds the ten columns wherever they start', () => {
    expect(genePredOffset(GENEPRED.split('\t'))).toBe(0)
    expect(genePredOffset(BINNED.split('\t'))).toBe(1)
    expect(genePredOffset(REFFLAT.split('\t'))).toBe(1)
    expect(genePredOffset(GENEPRED_EXT.split('\t'))).toBe(0)
    expect(genePredOffset(`585\t${REFFLAT}`.split('\t'))).toBe(2)
  })

  it('refuses rows where the format does not agree with itself', () => {
    // Exon count disagrees with its own lists.
    expect(
      genePredOffset('NM_1\tchr1\t+\t1000\t20000\t1200\t19000\t9\t1000,\t2000,'.split('\t')),
    ).toBe(-1)
    // The exons do not tile the transcript: the last ends short of txEnd.
    expect(
      genePredOffset('NM_1\tchr1\t+\t1000\t20000\t1200\t19000\t1\t1000,\t2000,'.split('\t')),
    ).toBe(-1)
    // No strand.
    expect(
      genePredOffset('NM_1\tchr1\t.\t1000\t20000\t1200\t19000\t1\t1000,\t20000,'.split('\t')),
    ).toBe(-1)
    expect(genePredOffset('chr1\t100\t200\tpeak\t500\t+'.split('\t'))).toBe(-1)
  })

  it('is recognised before the sniffer that used to mis-route it', () => {
    expect(sniffGenePred(GENEPRED)).toBe(true)
    expect(sniffGenePred(REFFLAT)).toBe(true)
    expect(sniffGenePred(BINNED)).toBe(true)
    // Where they used to go: a ten-column genePred looked like a GTF, and a
    // refFlat like a BED whose every row then failed the contig/start/end test.
    expect(sniffFormat(GENEPRED)).toBe('gtf')
    expect(sniffFormat(REFFLAT)).toBe('bed')
  })

  it('does not take a BED, a GTF or a bedGraph', () => {
    expect(sniffGenePred('chr1\t100\t200\tpeak\t500\t+\t120\t180\t0')).toBe(false)
    expect(
      sniffGenePred('chrIV\tsgd\tgene\t8683\t9756\t.\t+\t.\tgene_id "YDL245C";'),
    ).toBe(false)
    expect(sniffGenePred('chr1\t100\t200\t3.5')).toBe(false)
  })

  it('reads the exons as the absolute spans they are', () => {
    const set = parseGenePred(GENEPRED)
    expect(set.length).toBe(1)
    expect(set.start[0]).toBe(1000)
    expect(set.end[0]).toBe(20000)
    expect(exonsOf(set, 0)).toEqual([
      [1000, 2000],
      [5000, 6000],
      [18000, 20000],
    ])
    expect(set.cdsStart[0]).toBe(1200)
    expect(set.cdsEnd[0]).toBe(19000)
    expect(set.strand[0]).toBe(1)
  })

  it('reads the same transcript through the bin column', () => {
    expect(exonsOf(parseGenePred(BINNED), 0)).toEqual(exonsOf(parseGenePred(GENEPRED), 0))
  })

  it('takes the symbol from refFlat’s leading column', () => {
    const set = parseGenePred(REFFLAT)
    expect(set.name[0]).toBe('OR4F5')
    expect(set.id[0]).toBe('NM_001')
  })

  it('takes the symbol from genePredExt’s name2', () => {
    const set = parseGenePred(GENEPRED_EXT)
    expect(set.name[0]).toBe('OR4F5')
    expect(set.id[0]).toBe('NM_001')
    expect(set.detail[0]).toContain('cds cmpl/cmpl')
  })

  it('does not mistake a bin index for a gene symbol', () => {
    const set = parseGenePred(BINNED)
    // `name === id` is how a FeatureSet says "the file gave no symbol".
    expect(set.name[0]).toBe('NM_001')
    expect(set.id[0]).toBe('NM_001')
  })

  it('gives a non-coding transcript no coding span', () => {
    const set = parseGenePred(NON_CODING)
    expect(set.cdsStart[0]).toBe(-1)
    expect(set.strand[0]).toBe(-1)
    expect(genePredSummary(set)).toContain('0 coding')
  })

  it('counts transcripts and exons, as a GTF does', () => {
    const summary = genePredSummary(parseGenePred([GENEPRED, NON_CODING].join('\n')))
    expect(summary).toContain('2 transcripts')
    expect(summary).toContain('5 exons')
    expect(summary).toContain('1 coding')
  })

  it('reads a concatenated file whose rows are at different offsets', () => {
    const set = parseGenePred([GENEPRED, BINNED, REFFLAT].join('\n'))
    expect(set.length).toBe(3)
  })

  it('is the gene-model kind, as a GTF is', () => {
    expect(cardFor('genepred')).toBe('linear')
    expect(kindFor('linear', 'genepred')).toBe('gtf')
  })

  it('is spotted in a bigBed by its schema', () => {
    expect(
      isGenePredSchema(
        'table bigGenePred\n( string chrom; string name2; string cdsStartStat; int[blockCount] exonFrames; )',
      ),
    ).toBe(true)
    expect(isGenePredSchema('table bigPsl\n( string chrom; uint oChromStart; )')).toBe(false)
  })

  it('routes the names these files are actually published under', () => {
    expect(routeOf('https://host/hg38.refGene.txt.gz')).toBe('genome')
    expect(routeOf('https://host/refFlat.txt.gz')).toBe('genome')
    expect(routeOf('https://host/genes.genePred')).toBe('genome')
  })
})
