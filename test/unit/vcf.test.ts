/**
 * Reading a VCF: what a record spans, what it is, and what tells one from a BED.
 *
 * Three claims carry the weight, and each fails silently rather than loudly.
 *
 * **The sniffer has to fire without a header.** `tabix.ts` serves one contig's
 * byte span out of a bgzipped file and those spans begin at the first *record*,
 * so the indexed path — the one the index exists for — delivers a VCF with every
 * `#` line left behind. A sniffer that read only `##fileformat` would work on a
 * plain file and fail on the fast one.
 *
 * **The span has to come from `INFO` for a symbolic ALT.** `<DEL>` writes a
 * single `N` in REF however large the deletion is, so `len(REF)` is 1 and a
 * forty-kilobase deletion draws as a one-pixel tick. That is a wrong answer that
 * looks like an answer, which is the only kind this parser can produce.
 *
 * **`.` is not zero.** VCF spells *not recorded* as a dot in QUAL, in ID and in
 * FILTER, and a parser that read it as a number would put a real, low score on
 * every unscored row and sort them to the bottom of something.
 */

import { describe, expect, it } from 'vitest'

import { sniffFormat } from '@/annotations/parse'
import { parseVcf, samplesIn, sniffVcf, variantClass, vcfContigs } from '@/annotations/vcf'
import type { FeatureSet } from '@/annotations/types'

const HEADER = `##fileformat=VCFv4.3
##contig=<ID=chrV,length=20000>
##INFO=<ID=AF,Number=A,Type=Float,Description="Allele Frequency">
#CHROM\tPOS\tID\tREF\tALT\tQUAL\tFILTER\tINFO\tFORMAT\tNA001\tNA002
`

/** Records as a tab-separated body, with or without the header above them. */
function vcf(rows: string[], header = true): string {
  return (header ? HEADER : '') + rows.map((row) => row.replace(/ +/g, '\t')).join('\n') + '\n'
}

const SNV = 'chrV 1000 rs100 A G 60 PASS AF=0.5;DP=30 GT 0/1 1/1'
const INDEL = 'chrV 2000 . CTTT C 40 PASS AF=0.25 GT 0/0 0/1'
const INSERT = 'chrV 2500 . G GAA 35 PASS AF=0.5 GT 0/1 0/1'
const SV = 'chrV 4000 sv1 N <DEL> 99 PASS SVTYPE=DEL;END=4800 GT 0/1 0/1'

function only(text: string): FeatureSet {
  return parseVcf(text)
}

/** `[start, end]` of the one row a single-record file holds. */
function span(text: string): [number, number] {
  const set = only(text)
  expect(set.length).toBe(1)
  return [set.start[0], set.end[0]]
}

describe('telling a VCF from everything else', () => {
  it('takes the format at its word where it declares itself', () => {
    expect(sniffVcf(vcf([SNV]))).toBe(true)
  })

  it('recognises one with no header at all, which is the indexed path', () => {
    // A `.vcf.gz` with a `.tbi` reaches the sniffer as bare records: `spansFor`
    // starts at the first record's block, so every `#` line is in the part of
    // the file that was deliberately not fetched. This is the case the index
    // exists for, so a sniffer that needed the header would work only on the
    // slow road.
    expect(sniffVcf(vcf([SNV, INDEL, INSERT, SV], false))).toBe(true)
  })

  it('recognises one whose header lost its first line but kept #CHROM', () => {
    expect(sniffVcf(`#CHROM\tPOS\tID\tREF\tALT\tQUAL\tFILTER\tINFO\n${SNV.replace(/ +/g, '\t')}\n`)).toBe(true)
  })

  it('does not capture a BED, a BEDPE or a GTF', () => {
    // The shape test is where the integers are: a VCF has one in column 1 and a
    // word in column 2, which none of these has. Run against the real sniffer
    // too, so a file that this refuses still lands where it always did.
    const bed = 'chrV\t1000\t2000\tpeak1\t500\t+\n'
    const bedpe = 'chrV\t1000\t2000\tchrV\t9000\t9500\tloop\t3\n'
    const gtf = 'chrV\tSGD\tgene\t1000\t2000\t.\t+\t.\tgene_id "YAL001C";\n'
    for (const [name, text] of [['bed', bed], ['bedpe', bedpe], ['gtf', gtf]] as const) {
      expect(sniffVcf(text), name).toBe(false)
    }
    expect(sniffFormat(bed)).toBe('bed')
    expect(sniffFormat(bedpe)).toBe('bedpe')
    expect(sniffFormat(gtf)).toBe('gtf')
  })

  it('does not capture a BED whose name and score columns look like alleles', () => {
    // The near miss the column-2 test exists for, and the only one that reaches
    // it: eight columns wide, an integer in column 1, and columns 3 and 4 that
    // pass the allele test by coincidence. Everything else about a BED is
    // caught earlier — a six-column one is too narrow, a narrowPeak has a
    // number where ALT would be — so without this row the guard is untested and
    // could be deleted with every other test still green.
    const bed = 'chrV\t1000\t2000\tAGCT\tA\t500\t+\t7.2\n'.repeat(4)
    expect(sniffVcf(bed)).toBe(false)
    // …and a real narrowPeak, which is the ten-column file this would meet.
    const peak = 'chrV\t1000\t2000\tpeak1\t500\t+\t7.2\t3.1\t2.0\t150\n'.repeat(4)
    expect(sniffVcf(peak)).toBe(false)
  })

  it('does not capture a headed TSV whose second column is a word', () => {
    // The near miss the allele test exists for: column 1 an integer, column 2 a
    // word, eight columns wide — and columns 3 and 4 are not alleles.
    const tsv = 'chrV\t1000\tpromoter\tstrong\t0.5\t12\tyes\tnote\n'
    expect(sniffVcf(tsv)).toBe(false)
  })

  it('is not fooled by one lucky row', () => {
    // Four rows, the same number and the same reason `sniffSignal` uses. One
    // VCF-shaped row is a coincidence a real file does not repeat.
    expect(sniffVcf(vcf([SNV], false))).toBe(false)
    expect(sniffVcf(vcf([SNV, INDEL, INSERT, SV], false))).toBe(true)
  })
})

describe('what a record spans', () => {
  it('gives a substitution the one base it is about', () => {
    expect(span(vcf([SNV]))).toEqual([999, 1000])
  })

  it('gives an indel the whole of its REF, padding base and all', () => {
    // `CTTT > C` at 2000 removes three bases and the record spells four, which
    // is what the file says and what every browser draws.
    expect(span(vcf([INDEL]))).toEqual([1999, 2003])
    // …and an insertion's REF is the single padding base, so the box is one
    // base wide however many bases went in.
    expect(span(vcf([INSERT]))).toEqual([2499, 2500])
  })

  it('reads a symbolic deletion’s end out of INFO, not out of REF', () => {
    // THE claim. `<DEL>` writes one `N` in REF whatever its size, so without
    // INFO/END an 800 bp deletion is one base — a wrong answer that looks like
    // an answer.
    const [start, end] = span(vcf([SV]))
    expect(start).toBe(3999)
    expect(end).toBe(4800)
    expect(end - start).toBeGreaterThan(700)
  })

  it('falls back to SVLEN where a symbolic record carries no END', () => {
    // Negative for a deletion by convention, and both signs are in real files.
    const rows = ['chrV 4000 . N <DEL> 99 PASS SVTYPE=DEL;SVLEN=-800 GT 0/1 0/1']
    expect(span(vcf(rows))).toEqual([3999, 4799])
    const positive = ['chrV 4000 . N <DUP> 99 PASS SVTYPE=DUP;SVLEN=800 GT 0/1 0/1']
    expect(span(vcf(positive))).toEqual([3999, 4799])
  })

  it('keeps a symbolic record that carries neither, rather than dropping it', () => {
    // The file says something happened here. Drawing one base is less than the
    // truth; drawing nothing is none of it.
    const rows = ['chrV 4000 . N <INV> 99 PASS SVTYPE=INV GT 0/1 0/1']
    expect(span(vcf(rows))).toEqual([3999, 4000])
  })

  it('does not read END from a record that is not symbolic', () => {
    // `END` is defined for symbolic alleles. A caller that writes it on a plain
    // indel as well must not have it override the REF the record spells out.
    const rows = ['chrV 2000 . CTTT C 40 PASS END=9999 GT 0/0 0/1']
    expect(span(vcf(rows))).toEqual([1999, 2003])
  })
})

describe('what a record is', () => {
  it('classes the four shapes a reader tells apart by eye', () => {
    expect(variantClass('A', 'G')).toBe('snv')
    expect(variantClass('AT', 'GC')).toBe('snv')
    expect(variantClass('G', 'GAA')).toBe('insertion')
    expect(variantClass('CTTT', 'C')).toBe('deletion')
    expect(variantClass('N', '<DEL>')).toBe('structural')
    expect(variantClass('A', ']chr2:321681]A')).toBe('structural')
  })

  it('takes the class several ALTs agree on, and says mixed where they do not', () => {
    expect(variantClass('A', 'G,T')).toBe('snv')
    expect(variantClass('A', 'G,ATT')).toBe('mixed')
  })

  it('reads past the alleles that are not alleles', () => {
    // `*` is the allele overlapped by an upstream deletion and `.` is a
    // monomorphic record; a gVCF is full of both and neither is an event.
    expect(variantClass('A', '*')).toBe('snv')
    expect(variantClass('A', '.')).toBe('snv')
    expect(variantClass('A', 'G,*')).toBe('snv')
  })
})

describe('the columns a click reads back', () => {
  it('keeps the rsID in both the name and the accession', () => {
    const set = only(vcf([SNV]))
    expect(set.name[0]).toBe('rs100')
    // Both slots: `name` is what the lane writes and `id` is what the search box
    // reads, and `name === id` is how a FeatureSet spells "identified, never
    // named" — which is exactly a variant with an accession and no symbol.
    expect(set.id[0]).toBe('rs100')
  })

  it('leaves an unnamed record unnamed rather than inventing a dot', () => {
    const set = only(vcf([INDEL]))
    expect(set.name[0]).toBe('')
    expect(set.id[0]).toBe('')
  })

  it('opens the detail with REF>ALT, which is what the click asked', () => {
    expect(only(vcf([SNV])).detail[0].startsWith('A>G')).toBe(true)
  })

  it('carries QUAL, FILTER and the two INFO keys every file has', () => {
    const detail = only(vcf([SNV])).detail[0]
    expect(detail).toContain('QUAL 60')
    expect(detail).toContain('filter PASS')
    expect(detail).toContain('AF 0.5')
    expect(detail).toContain('DP 30')
  })

  it('takes QUAL as the score, and leaves an unscored row unscored', () => {
    expect(only(vcf([SNV])).score[0]).toBeCloseTo(60, 6)
    const dotted = ['chrV 5000 . AT A . . DP=9 GT ./. 0/1']
    // `.` is *not recorded*. A zero here would be a real, low quality that sorts
    // and colours like one.
    expect(Number.isNaN(only(vcf(dotted)).score[0])).toBe(true)
  })

  it('does not confuse an INFO key with one that starts the same way', () => {
    // A linear scan over `;`-separated parts has to match the whole key: `AF`
    // must not read `AFR_AF`, which is in every gnomAD-annotated file.
    const rows = ['chrV 1000 . A G 60 PASS AFR_AF=0.9;AF=0.1 GT 0/1 0/1']
    expect(only(vcf(rows)).detail[0]).toContain('AF 0.1')
  })
})

describe('what the file says about itself', () => {
  it('reads the contig lengths a header declares', () => {
    expect(vcfContigs(vcf([SNV]))).toEqual([{ name: 'chrV', length: 20_000 }])
  })

  it('declares none where the header has none', () => {
    expect(vcfContigs(vcf([SNV, INDEL, INSERT, SV], false))).toEqual([])
  })

  it('counts the samples it is not going to draw', () => {
    // The number goes under the lane's name, because a reader who brought a
    // thousand-genome VCF should be told what the lane is showing them.
    expect(samplesIn(vcf([SNV]))).toBe(2)
    expect(samplesIn(`##fileformat=VCFv4.3\n#CHROM\tPOS\tID\tREF\tALT\tQUAL\tFILTER\tINFO\n${SNV.replace(/ +/g, '\t')}\n`)).toBe(0)
  })
})

describe('a file with nothing usable in it', () => {
  it('refuses by naming the test a VCF record failed, not a BED’s', () => {
    // What a VCF used to get: "all 7 lines failed the contig, start, end test
    // that every BED-like format begins with" — a message naming a format the
    // reader never handed over.
    const broken = '##fileformat=VCFv4.3\nchrV\tnotaposition\t.\tA\tG\t60\tPASS\t.\n'.repeat(3)
    expect(() => parseVcf(broken)).toThrow(/contig, position, ID, REF, ALT/)
  })

  it('keeps the good rows of a file with a bad one in it', () => {
    const mixed = vcf([SNV, 'chrV\tbroken\trow', INDEL])
    expect(parseVcf(mixed).length).toBe(2)
  })
})
