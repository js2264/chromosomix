/**
 * The annotation text parsers, against the published demo files and against the
 * shapes that are easy to get wrong.
 *
 * The demo files are the point: spec §8.3 says detection is by content, and the
 * only way to know that holds is to run it over a real Ensembl GTF, a real MACS
 * narrowPeak and a real headed loop TSV rather than over three lines written to
 * pass. They are committed under `public/demo/`, so this needs no fixtures.
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath, URL } from 'node:url'
import { describe, expect, it } from 'vitest'

import { featureRange, overlapWith } from '../../src/annotations/featureset'
import { parseBed, parseBedpe, parseGtf, readHeader, sniffFormat } from '../../src/annotations/parse'

function demo(name: string): string {
  return readFileSync(fileURLToPath(new URL(`../../public/demo/${name}`, import.meta.url)), 'utf8')
}

/** The map these files are aligned to: `Yeast_microC_G2M_1kb.cool`'s chroms. */
const MAP_CONTIGS = [
  'I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII',
  'IX', 'X', 'XI', 'XII', 'XIII-syn40', 'XIV', 'XV', 'XVI',
]

describe('format sniffing', () => {
  it('reads the shape, not the suffix', () => {
    expect(sniffFormat('I\t66\t305\tpeak_1\t1466\n', 'anything.txt')).toBe('bed')
    expect(sniffFormat('IV\tsgd\tgene\t8683\t9756\t.\t-\t.\tgene_id "Y";\n')).toBe('gtf')
    expect(sniffFormat('I\t1000\t2000\tI\t19000\t20000\n')).toBe('bedpe')
  })

  it('recognises a headed loop table as paired', () => {
    const text = 'chrom1\tstart1\tend1\tchrom2\tstart2\tend2\nI\t0\t1000\tI\t9000\t10000\n'
    expect(sniffFormat(text, 'loops.tsv')).toBe('bedpe')
    expect(readHeader(text)?.[3]).toBe('chrom2')
  })

  // A BED9's ninth column is `255,0,0`; a broadPeak's is a q-value. Told apart
  // by the comma, because both have nine columns and a strand in column 6.
  it('does not mistake a BED9 colour for a peak statistic', () => {
    const bed9 = 'I\t10\t20\tx\t0\t+\t10\t20\t255,0,0\n'
    const parsed = parseBed(bed9)
    expect(parsed.length).toBe(1)
    expect(parsed.score[0]).toBe(0)
    expect(parsed.cdsStart[0]).toBe(10)
  })
})

describe('BED family', () => {
  it('parses the demo ATAC narrowPeak and takes signalValue as the score', () => {
    const set = parseBed(demo('Yeast_ATAC.narrowPeak'), 'Yeast_ATAC.narrowPeak')
    expect(set.length).toBe(5105)
    expect(set.contigs.length).toBe(16)
    // `I  66  305  …peak_1  1466  .  11.4414  148.56  146.643  60`
    const first = set.contigAt[set.contigs.indexOf('I')]
    expect(set.start[first]).toBe(66)
    expect(set.end[first]).toBe(305)
    expect(set.score[first]).toBeCloseTo(11.4414, 3)
    expect(set.detail[first]).toContain('summit +60')
  })

  it('parses the demo Pol2 narrowPeak and covers the map exactly', () => {
    const set = parseBed(
      demo('Yeast_ChIP_Pol2-vs-input.narrowPeak'),
      'Yeast_ChIP_Pol2-vs-input.narrowPeak',
    )
    expect(set.length).toBe(527)
    const overlap = overlapWith(set.contigs, MAP_CONTIGS)
    expect(overlap.matched).toBe(16)
    expect(overlap.extra).toEqual([])
  })

  // Grouped by contig *id*, which is first-seen order, and ascending by start
  // within each group. The id order is arbitrary and does not matter: every
  // query looks a contig up by name and reads its own run.
  it('sorts by contig then start, whatever order the file was in', () => {
    const set = parseBed('II\t50\t60\nI\t100\t200\nI\t0\t10\n')
    expect(set.contigs).toEqual(['II', 'I'])
    expect(Array.from(set.start)).toEqual([50, 0, 100])
    const one = set.contigs.indexOf('I')
    expect([set.contigAt[one], set.contigAt[one + 1]]).toEqual([1, 3])
  })

  it('expands BED12 blocks into exons', () => {
    const set = parseBed('I\t100\t400\tt\t0\t+\t120\t380\t0\t2\t50,100,\t0,200,\n')
    expect(set.exonAt[1] - set.exonAt[0]).toBe(2)
    expect(Array.from(set.exonStart)).toEqual([100, 300])
    expect(Array.from(set.exonEnd)).toEqual([150, 400])
    expect(set.cdsStart[0]).toBe(120)
  })
})

describe('GTF', () => {
  it('collapses the demo Ensembl GTF to one feature per transcript', () => {
    const set = parseGtf(demo('Yeast_annotations.gtf'))
    // 41,566 lines, 7,071 transcript lines, 7,419 exon lines: one drawn glyph
    // per transcript, not one per line.
    expect(set.length).toBe(7071)
    expect(set.exonStart.length).toBe(7419)
    expect(set.contigs.length).toBe(16)
    expect(overlapWith(set.contigs, MAP_CONTIGS).matched).toBe(16)
  })

  it('converts 1-based inclusive to 0-based half-open', () => {
    // The first transcript in the file: IV  sgd  transcript  8683  9756  .  -
    const set = parseGtf(demo('Yeast_annotations.gtf'))
    const at = indexOfNamed(set, 'SOR2')
    expect(at).toBeGreaterThanOrEqual(0)
    expect(set.start[at]).toBe(8682)
    expect(set.end[at]).toBe(9756)
    expect(set.strand[at]).toBe(-1)
    expect(set.contigs[set.contig[at]]).toBe('IV')
    // Its CDS starts three bases in, at 8686 one-based.
    expect(set.cdsStart[at]).toBe(8685)
  })

  it('names a transcript by its gene name, falling back to the id', () => {
    const set = parseGtf(
      'I\tsgd\ttranscript\t10\t20\t.\t+\t.\tgene_id "G1"; transcript_id "T1";\n' +
        'I\tsgd\texon\t10\t20\t.\t+\t.\tgene_id "G1"; transcript_id "T1";\n',
    )
    expect(set.name[0]).toBe('G1')
  })

  it('assembles a transcript from exon lines alone', () => {
    const set = parseGtf(
      'I\tx\texon\t100\t200\t.\t+\t.\tgene_id "G"; transcript_id "T";\n' +
        'I\tx\texon\t400\t500\t.\t+\t.\tgene_id "G"; transcript_id "T";\n',
    )
    expect(set.length).toBe(1)
    expect(set.start[0]).toBe(99)
    expect(set.end[0]).toBe(500)
    expect(set.exonAt[1] - set.exonAt[0]).toBe(2)
  })

  it('reads GFF3 parentage and percent-encoded values', () => {
    const set = parseGtf(
      'I\tx\tmRNA\t10\t50\t.\t+\t.\tID=t1;Name=A%3BB\n' +
        'I\tx\texon\t10\t20\t.\t+\t.\tParent=t1\n' +
        'I\tx\texon\t40\t50\t.\t+\t.\tParent=t1\n',
    )
    expect(set.length).toBe(1)
    expect(set.name[0]).toBe('A;B')
    expect(set.exonAt[1] - set.exonAt[0]).toBe(2)
  })

  // A minus-strand transcript is listed in transcript order, which runs
  // backwards in genomic coordinates; joining consecutive pairs unsorted draws
  // the introns as overlapping negative spans.
  it('sorts exons into genomic order', () => {
    const set = parseGtf(
      'I\tx\ttranscript\t10\t100\t.\t-\t.\tgene_id "G"; transcript_id "T";\n' +
        'I\tx\texon\t80\t100\t.\t-\t.\tgene_id "G"; transcript_id "T";\n' +
        'I\tx\texon\t10\t30\t.\t-\t.\tgene_id "G"; transcript_id "T";\n',
    )
    expect(Array.from(set.exonStart)).toEqual([9, 79])
  })
})

describe('BEDPE', () => {
  it('parses the demo loop calls through their header', () => {
    const set = parseBedpe(demo('Yeast_microC_loops.tsv'))
    expect(set.length).toBe(1506)
    expect(set.contigs.length).toBe(16)
    expect(set.start1[0]).toBe(1000)
    expect(set.end2[0]).toBe(20000)
    // Columns the six coordinates did not claim are kept for the tooltip.
    expect(set.detail[0]).toContain('qvalue')
    expect(set.detail[0]).toContain('kernel_id')
  })

  it('parses a headerless bedpe', () => {
    const set = parseBedpe('I\t0\t100\tII\t500\t600\tloop_1\t42\n')
    expect(set.length).toBe(1)
    expect(set.contigs).toEqual(['I', 'II'])
    expect(set.name[0]).toBe('loop_1')
    expect(set.score[0]).toBe(42)
  })

  it('refuses a headed file that does not name all six coordinates', () => {
    expect(() => parseBedpe('chrom1\tstart1\tend1\nI\t0\t1\n')).toThrow(/six coordinate/)
  })
})

describe('range queries', () => {
  // The whole point of `maxSpan`: rows are sorted by start, so a feature that
  // begins before the window and ends inside it is invisible to a plain lower
  // bound — and those are exactly the long genes a reader is looking for.
  it('finds a long feature that began before the window', () => {
    const set = parseBed('I\t0\t100000\tlong\nI\t90000\t90100\tshort\n')
    const [from, to] = featureRange(set, 0, 95000, 96000)
    const found: string[] = []
    for (let i = from; i < to; i++) {
      if (set.end[i] > 95000 && set.start[i] < 96000) found.push(set.name[i])
    }
    expect(found).toEqual(['long'])
  })

  it('returns nothing for a contig the file does not have', () => {
    const set = parseBed('I\t0\t10\n')
    expect(featureRange(set, -1, 0, 100)).toEqual([0, 0])
  })

  it('keeps one contig long feature from widening every other contig', () => {
    const set = parseBed('I\t0\t1000000\nII\t500\t600\n')
    const two = set.contigs.indexOf('II')
    const [from, to] = featureRange(set, two, 550, 560)
    expect(to - from).toBe(1)
  })
})

describe('contig overlap (§8.2)', () => {
  it('reports both directions of a naming mismatch', () => {
    const overlap = overlapWith(['chrI', 'chrII'], ['I', 'II'])
    expect(overlap.matched).toBe(0)
    expect(overlap.missing).toEqual(['I', 'II'])
    expect(overlap.extra).toEqual(['chrI', 'chrII'])
  })

  it('reports a partial annotation as partial', () => {
    const overlap = overlapWith(['I'], ['I', 'II', 'III'])
    expect(overlap.matched).toBe(1)
    expect(overlap.extra).toEqual([])
  })
})

/** The index of the first feature with this name, or `-1`. */
function indexOfNamed(set: { length: number; name: string[] }, name: string): number {
  for (let i = 0; i < set.length; i++) if (set.name[i] === name) return i
  return -1
}
