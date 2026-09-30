/**
 * Splice junctions, read (§8.23).
 *
 * Three shapes and one answer: whichever aligner wrote the file, a junction is
 * the **intron** — 0-based half-open, donor to acceptor — with its read count
 * as the score. What is worth testing hardest is the coordinate arithmetic,
 * because each shape spells the intron differently (STAR 1-based and inclusive,
 * a BED12 as two anchors either side of it, a `.junc` as a BED), and getting any
 * of them wrong by one base still draws a perfectly plausible arc.
 *
 * The second claim is what the sniffer refuses. A BED12 of two blocks is a
 * two-exon transcript as often as it is a junction, so it is read as junctions
 * only where the file says so.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import {
  STAR_MOTIFS,
  junctionCeiling,
  junctionSummary,
  parseJunctions,
  sniffJunctions,
} from '@/annotations/junctions'
import { cardFor, kindFor } from '@/annotations/loader'
import { sniffBarChart } from '@/annotations/barchart'
import { sniffCytoBand } from '@/annotations/cytoband'
import { sniffSignal } from '@/annotations/signal'
import { sniffFormat } from '@/annotations/parse'
import { routeOf } from '@/browse/route'
import { DETAIL_SEP } from '@/annotations/types'

/** STAR's own rows: an annotated forward intron, a reverse one, a novel one. */
const STAR = [
  'X\t193062\t200833\t1\t1\t1\t24\t0\t36',
  'X\t213045\t217624\t2\t2\t1\t0\t1\t32',
  'X\t221865\t224026\t2\t2\t0\t4\t0\t36',
  'X\t300001\t300200\t0\t0\t0\t1\t0\t12',
].join('\n')

/** regtools' BED12 for the first of those: anchors of 51 and 24 bases. */
const REGTOOLS = [
  'X\t193010\t200857\tJUNC00000001\t24\t+\t193010\t200857\t255,0,0\t2\t51,24\t0,7823',
  'X\t221800\t224078\tJUNC00000004\t5\t-\t221800\t224078\t255,0,0\t2\t64,52\t0,2226',
].join('\n')

/** The same shape as a two-exon transcript, which is not a junction. */
const TRANSCRIPT =
  'X\t193010\t200857\tNM_0001\t0\t+\t193100\t200800\t0\t2\t510,240\t0,7607'

/** leafcutter's older `.junc`: a BED6 with the count as its score. */
const JUNC = ['chr1\t17055\t17232\t.\t12\t-', 'chr1\t17368\t17605\t.\t3\t-'].join('\n')

describe('what a junction file is', () => {
  it('is STAR’s table by its columns alone, whatever its name', () => {
    expect(sniffJunctions(STAR)).toBe('star')
    expect(sniffJunctions(STAR, 'sample.tsv')).toBe('star')
  })

  it('is a two-block BED where the file says it holds junctions', () => {
    expect(sniffJunctions(REGTOOLS)).toBe('bed') // every name is JUNC…
    expect(sniffJunctions(REGTOOLS.replace(/JUNC\d+/g, '.'), 'sample.junctions.bed')).toBe('bed')
    expect(sniffJunctions(`track name=junctions description="TopHat junctions"\n${TRANSCRIPT}`)).toBe('bed')
  })

  it('leaves a two-exon transcript alone when nothing says it is a junction', () => {
    expect(sniffJunctions(TRANSCRIPT, 'genes.bed')).toBe(null)
  })

  it('is a BED6 only when it is called `.junc`', () => {
    expect(sniffJunctions(JUNC, 'sample.junc')).toBe('junc')
    expect(sniffJunctions(JUNC, 'peaks.bed')).toBe(null)
  })

  it('leaves a BED9 alone, which is nine columns and not nine integers', () => {
    expect(sniffJunctions('X\t1\t100\tname\t0\t+\t1\t100\t0,0,0')).toBe(null)
  })

  it('refuses a nine-integer row whose codes are not STAR’s', () => {
    expect(sniffJunctions('X\t1\t100\t3\t1\t1\t5\t0\t20')).toBe(null) // strand 3
    expect(sniffJunctions('X\t1\t100\t1\t9\t1\t5\t0\t20')).toBe(null) // motif 9
    expect(sniffJunctions('X\t100\t1\t1\t1\t1\t5\t0\t20')).toBe(null) // backwards
  })

  it('is not claimed by the sniffers asked before it, and claims none of their files', () => {
    expect(sniffBarChart(STAR)).toBe(false)
    expect(sniffCytoBand(STAR)).toBe(false)
    expect(sniffSignal(STAR)).toBe(null)
    expect(sniffJunctions('chr1\t0\t2300000\tp36.33\tgneg')).toBe(null)
  })

  it('would have been read as a BED, which is why it is asked first', () => {
    expect(sniffFormat(STAR)).toBe('bed')
  })
})

describe('STAR’s table, read', () => {
  const set = parseJunctions(STAR, 'SJ.out.tab')

  it('makes the intron 0-based and half-open', () => {
    // STAR's 193062..200833 is the intron's first and last base.
    expect(set.start[0]).toBe(193_061)
    expect(set.end[0]).toBe(200_833)
  })

  it('takes the unique reads as the count', () => {
    expect(Array.from(set.score)).toEqual([24, 0, 4, 1])
  })

  it('reads STAR’s strand codes, and leaves a non-canonical one unstranded', () => {
    expect(Array.from(set.strand)).toEqual([1, -1, -1, 0])
  })

  it('names the motif as the transcript reads it', () => {
    expect(STAR_MOTIFS[1]).toBe('GT/AG')
    expect(STAR_MOTIFS[2]).toBe('GT/AG') // STAR's CT/AC is GT/AG on the minus strand
    const parts = set.detail[1].split(DETAIL_SEP)
    expect(parts).toEqual(['multi 1', 'motif GT/AG', 'annotated yes', 'overhang 32'])
    expect(set.detail[3]).toContain('motif non-canonical')
    expect(set.detail[2]).toContain('annotated no')
  })

  it('says what it holds', () => {
    expect(junctionSummary(set)).toBe('4 junctions · 29 reads · 2 annotated')
    expect(junctionCeiling(set)).toBe(24)
  })
})

describe('a junctions BED, read', () => {
  const set = parseJunctions(REGTOOLS, 'x.junctions.bed')

  it('takes the gap between its two anchors as the intron', () => {
    // 193,010 + 51 to 193,010 + 7,823: the same intron STAR calls 193062..200833.
    expect(set.start[0]).toBe(193_061)
    expect(set.end[0]).toBe(200_833)
  })

  it('keeps the anchors, the one thing a BED says that the intron does not', () => {
    expect(set.detail[0]).toBe('anchors 51/24')
    expect(set.name[0]).toBe('JUNC00000001')
    expect(Array.from(set.score)).toEqual([24, 5])
    expect(Array.from(set.strand)).toEqual([1, -1])
  })
})

describe('a leafcutter .junc, read', () => {
  it('is a BED: the intron as written, the count as its score', () => {
    const set = parseJunctions(JUNC, 'sample.junc')
    expect([set.start[0], set.end[0]]).toEqual([17_055, 17_232])
    expect(Array.from(set.score)).toEqual([12, 3])
    expect(junctionSummary(set)).toBe('2 junctions · 15 reads')
  })
})

describe('where a junction file goes', () => {
  it('is a lane of its own kind', () => {
    expect(cardFor('junctions')).toBe('linear')
    expect(kindFor('linear', 'junctions')).toBe('junctions')
    expect(kindFor('overlay', 'junctions')).toBe(null)
  })

  it('opens at the genome’s door under the names aligners write', () => {
    expect(routeOf('sample.SJ.out.tab')).toBe('genome')
    expect(routeOf('sample.junc')).toBe('genome')
    expect(routeOf('sample.junctions.bed')).toBe('genome')
  })
})

describe('the demo files', () => {
  const human = (name: string): string => readFileSync(join(process.cwd(), 'demo/human', name), 'utf8')

  it('reads STAR’s own tables for all four samples', () => {
    for (const name of [
      'Geuvadis_chrX_GBR_ERR188383.SJ.out.tab',
      'Geuvadis_chrX_GBR_ERR188428.SJ.out.tab',
      'Geuvadis_chrX_YRI_ERR188454.SJ.out.tab',
      'Geuvadis_chrX_YRI_ERR204916.SJ.out.tab',
    ]) {
      const text = human(name)
      expect(sniffJunctions(text, name)).toBe('star')
      const set = parseJunctions(text, name)
      expect(set.length).toBeGreaterThan(2500)
      expect(set.contigs).toEqual(['X'])
    }
  })

  it('agrees with regtools about every intron the two share', () => {
    const star = parseJunctions(human('Geuvadis_chrX_GBR_ERR188428.SJ.out.tab'), 'SJ.out.tab')
    const bed = parseJunctions(
      human('Geuvadis_chrX_GBR_ERR188428.junctions.bed'),
      'Geuvadis_chrX_GBR_ERR188428.junctions.bed',
    )
    const introns = new Set<string>()
    for (let i = 0; i < star.length; i++) introns.add(`${star.start[i]}-${star.end[i]}`)
    // STAR's `--outSJfilterIntronMaxVsReadN 50000 100000 200000`: a junction one,
    // two or three reads strong is kept in its table only over an intron up to
    // 50, 100 or 200 kb. The alignments keep them all.
    const filtered = (reads: number, length: number): boolean =>
      (reads <= 1 && length > 50_000) || (reads === 2 && length > 100_000) || (reads === 3 && length > 200_000)
    let shared = 0
    let explained = 0
    for (let i = 0; i < bed.length; i++) {
      if (introns.has(`${bed.start[i]}-${bed.end[i]}`)) shared++
      else if (filtered(bed.score[i], bed.end[i] - bed.start[i])) explained++
    }
    // Two readings of one alignment, one of them filtered: regtools counts every
    // spliced read in the BAM, and STAR's table is what passes STAR's filters —
    // the intron-length one above accounts for most of the difference, and
    // junctions only multi-mapped reads support for most of the rest. Were the
    // parser's arithmetic off by a base for either shape, nothing would be
    // shared at all.
    expect(shared / bed.length).toBeGreaterThan(0.95)
    expect(explained / (bed.length - shared)).toBeGreaterThan(0.7)
    expect(bed.length).toBeGreaterThan(2500)
  })
})
