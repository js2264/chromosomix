/**
 * The annotation text parsers, against the published demo files and against the
 * shapes that are easy to get wrong.
 *
 * The demo files are the point: spec §8.3 says detection is by content, and the
 * only way to know that holds is to run it over a real Ensembl GTF, a real MACS
 * narrowPeak and a real headed loop TSV rather than over three lines written to
 * pass. They are committed under `demo/yeast/`, so this needs no fixtures — the
 * same directory `scripts/publish-demo.sh` uploads, so what is parsed here is
 * byte for byte what the site serves.
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath, URL } from 'node:url'
import { describe, expect, it } from 'vitest'

import { featureRange, overlapWith } from '../../src/annotations/featureset'
import {
  decodeAnnotationText,
  parseBed,
  parseBedpe,
  parseGtf,
  readHeader,
  sniffFormat,
} from '../../src/annotations/parse'
import { bgzfBlock } from './bam-fixtures'

function demo(name: string): string {
  return readFileSync(fileURLToPath(new URL(`../../demo/yeast/${name}`, import.meta.url)), 'utf8')
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

  // A gappedPeak is BED12+3, not BED6+3. Every peak format used to read
  // signalValue from column 7, which in this row is thickStart — so the score
  // was the coordinate 1000 and the tooltip read "signal 1000 · -log10 p 2000 ·
  // -log10 q 0", three columns of geometry presented as MACS statistics.
  const GAPPED =
    'chrI\t1000\t2000\tpeak1\t500\t+\t1000\t2000\t0\t2\t200,300\t0,700\t7.75\t12.3\t9.1\n'

  it('takes a gappedPeak signal from column 13, not column 7', () => {
    const set = parseBed(GAPPED, 'sample.gappedPeak')
    expect(set.score[0]).toBeCloseTo(7.75, 3)
    expect(set.detail[0]).toContain('signal 7.75')
    expect(set.detail[0]).toContain('-log10 p 12.3')
    expect(set.detail[0]).toContain('-log10 q 9.1')
    // Column 10 is blockCount here, not a summit offset, so no summit line.
    expect(set.detail[0]).not.toContain('summit')
    // And unlike narrowPeak and broadPeak, a gappedPeak really does carry a
    // thick span in columns 7 and 8, alongside its blocks.
    expect(set.cdsStart[0]).toBe(1000)
    expect(set.cdsEnd[0]).toBe(2000)
    expect(Array.from(set.exonStart)).toEqual([1000, 1700])
    expect(Array.from(set.exonEnd)).toEqual([1200, 2000])
  })

  it('recognises a gappedPeak by its fifteen columns when the name is gone', () => {
    const set = parseBed(GAPPED, '')
    expect(set.score[0]).toBeCloseTo(7.75, 3)
    expect(set.detail[0]).toContain('signal 7.75')
  })

  // Twelve columns is not proof of BED12: this headed table's eleventh and
  // twelfth columns are a gene name and a fold change, and decoding them as
  // blockSizes/blockStarts hung an invented exon at 10002–0 on a peak that has
  // no sub-structure. The shape test is what refuses them.
  it('does not read a headed peak table as BED12 blocks', () => {
    const text =
      'chrom\tstart\tend\tname\tscore\tstrand\tsignalValue\tpValue\tqValue\tpeak\tgene\tlog2FC\tpadj\n' +
      'chrI\t10000\t11000\tpeak1\t500\t+\t7.75\t12.3\t9.1\t480\tMYC\t2.31\t0.001\n'
    const set = parseBed(text, 'peaks_annotated.tsv')
    expect(set.length).toBe(1)
    expect(set.exonStart.length).toBe(0)
    expect(set.exonAt[1] - set.exonAt[0]).toBe(0)
    expect(set.start[0]).toBe(10000)
    expect(set.end[0]).toBe(11000)
  })

  // The same test, on the case a headed table hits by accident: blockCount
  // agrees with the list length and both parts are integers, but the blocks do
  // not tile the feature, so they are two ordinary columns rather than blocks.
  it('refuses blocks that do not tile the feature', () => {
    const set = parseBed('I\t100\t400\tt\t0\t+\t120\t380\t0\t1\t50\t40\n')
    expect(set.exonStart.length).toBe(0)
    // The thick span still parses: only the block decode was in doubt.
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
    // Its CDS *row* starts three bases in, at 8686 one-based; the three before
    // it are the stop codon (a minus-strand gene ends on the left), which the
    // file writes on a row of its own and which is coding (§8.16). So the
    // coding span runs from the transcript's own first base.
    expect(set.cdsStart[at]).toBe(8682)
  })

  it('counts the stop codon as coding, on either strand', () => {
    // Ensembl's convention: the CDS rows stop short of the stop codon, and the
    // stop codon is a row of its own. A genePred's `cdsEnd` includes it, so
    // without this the same gene drew three bases short from a GTF.
    const set = parseGtf(
      [
        'I\tsrc\ttranscript\t100\t400\t.\t+\t.\tgene_id "G1"; transcript_id "T1";',
        'I\tsrc\texon\t100\t400\t.\t+\t.\tgene_id "G1"; transcript_id "T1";',
        'I\tsrc\tCDS\t150\t347\t.\t+\t0\tgene_id "G1"; transcript_id "T1";',
        'I\tsrc\tstop_codon\t348\t350\t.\t+\t0\tgene_id "G1"; transcript_id "T1";',
      ].join('\n') + '\n',
    )
    expect(set.cdsStart[0]).toBe(149)
    expect(set.cdsEnd[0]).toBe(350)
  })

  it('takes a transcript’s exons from its CDS and UTR rows where it writes no exon rows', () => {
    // GFF3 allows a transcript to be spelled as its parts; the gaps between the
    // merged parts are its introns, and a picture with none would be wrong.
    const set = parseGtf(
      [
        '##gff-version 3',
        'I\tsrc\tmRNA\t100\t900\t.\t+\t.\tID=t1;Name=GENE1',
        'I\tsrc\tfive_prime_UTR\t100\t149\t.\t+\t.\tParent=t1',
        'I\tsrc\tCDS\t150\t300\t.\t+\t0\tParent=t1',
        'I\tsrc\tCDS\t601\t850\t.\t+\t2\tParent=t1',
        'I\tsrc\tthree_prime_UTR\t851\t900\t.\t+\t.\tParent=t1',
      ].join('\n') + '\n',
    )
    const first = set.exonAt[0]
    const last = set.exonAt[1]
    expect(last - first).toBe(2)
    expect([set.exonStart[first], set.exonEnd[first]]).toEqual([99, 300])
    expect([set.exonStart[first + 1], set.exonEnd[first + 1]]).toEqual([600, 900])
  })

  it('leaves a transcript of one coding piece as the span it always was', () => {
    // A bacterial gene: one CDS row under a longer transcript row. Taking the
    // CDS as its only exon would drop the rest of the transcript from view.
    const set = parseGtf(
      [
        '##gff-version 3',
        'I\tsrc\tmRNA\t100\t900\t.\t+\t.\tID=t1;Name=GENE1',
        'I\tsrc\tCDS\t150\t850\t.\t+\t0\tParent=t1',
      ].join('\n') + '\n',
    )
    expect(set.exonAt[1] - set.exonAt[0]).toBe(0)
    expect([set.start[0], set.end[0]]).toEqual([99, 900])
    expect([set.cdsStart[0], set.cdsEnd[0]]).toEqual([149, 850])
  })

  it('names a transcript by its gene name, falling back to the id', () => {
    const set = parseGtf(
      'I\tsgd\ttranscript\t10\t20\t.\t+\t.\tgene_id "G1"; transcript_id "T1";\n' +
        'I\tsgd\texon\t10\t20\t.\t+\t.\tgene_id "G1"; transcript_id "T1";\n',
    )
    expect(set.name[0]).toBe('G1')
    // The name fell back to the accession, and saying so is what stops the
    // feature card printing one string under two labels.
    expect(set.id[0]).toBe('G1')
  })

  it('keeps the symbol and the accession apart', () => {
    const set = parseGtf(
      'I\tsgd\tgene\t10\t20\t.\t+\t.\tgene_id "G1"; gene_name "GAL4";\n' +
        'I\tsgd\ttranscript\t10\t20\t.\t+\t.\tgene_id "G1"; transcript_id "T1";\n',
    )
    expect(set.name[0]).toBe('GAL4')
    expect(set.id[0]).toBe('G1')
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

/**
 * The half of the GFF3 world that does not spell anything the way GTF does.
 *
 * A VEuPathDB / PlasmoDB annotation writes `ID` and `Name` where Ensembl writes
 * `gene_id` and `gene_name`, and it types its genes with the Sequence Ontology's
 * specific terms — `protein_coding_gene`, `ncRNA_gene`, `pseudogene` — rather
 * than the bare `gene`. Every one of those is a place the parser looked for
 * something and found nothing, and the whole file came out labelled with
 * systematic ids while its symbols sat unread two lines up.
 */
describe('a GFF3 that spells its attributes the other way', () => {
  /** One gene, its mRNA, its exons and its CDS — laid out as PlasmoDB writes them. */
  const PLASMODB =
    'C\tVEuPathDB\tprotein_coding_gene\t100\t400\t.\t+\t.\tID=PF_001;Name=LipL1;description=ligase\n' +
    'C\tVEuPathDB\tmRNA\t100\t400\t.\t+\t.\tID=PF_001.1;Parent=PF_001\n' +
    'C\tVEuPathDB\texon\t100\t200\t.\t+\t.\tID=exon1;Parent=PF_001.1;gene_id=PF_001\n' +
    'C\tVEuPathDB\texon\t300\t400\t.\t+\t.\tID=exon2;Parent=PF_001.1;gene_id=PF_001\n' +
    'C\tVEuPathDB\tCDS\t120\t380\t.\t+\t0\tID=cds1;Parent=PF_001.1;gene_id=PF_001\n'

  it('reads a gene named by `ID` and `Name`, through its transcript', () => {
    const set = parseGtf(PLASMODB)
    // One glyph: the gene line is not drawn beside its own mRNA.
    expect(set.length).toBe(1)
    expect(set.name[0]).toBe('LipL1')
    expect(set.id[0]).toBe('PF_001')
    expect(set.exonAt[1] - set.exonAt[0]).toBe(2)
    expect(set.cdsStart[0]).toBe(119)
  })

  // `pseudogenic_transcript`, `ncRNA`, `tRNA`: transcripts by any reading, and
  // each was read as somebody's child and keyed by its `Parent` — which is the
  // gene — while its own exons were keyed by theirs. Two drafts for one thing,
  // the second a nameless box with no exons in it.
  it('draws one glyph for a non-coding transcript, not two', () => {
    const set = parseGtf(
      'C\tdb\tncRNA_gene\t100\t400\t.\t-\t.\tID=g2;Name=SNR17\n' +
        'C\tdb\tncRNA\t100\t400\t.\t-\t.\tID=g2.1;Parent=g2\n' +
        'C\tdb\texon\t100\t400\t.\t-\t.\tID=e;Parent=g2.1\n',
    )
    expect(set.length).toBe(1)
    expect(set.name[0]).toBe('SNR17')
    expect(set.id[0]).toBe('g2')
  })

  it('prefers the gene’s own name to the transcript’s', () => {
    const set = parseGtf(
      'C\tdb\tgene\t100\t400\t.\t+\t.\tID=g3;Name=ACT1\n' +
        'C\tdb\tmRNA\t100\t400\t.\t+\t.\tID=g3.1;Parent=g3;Name=ACT1-201\n',
    )
    expect(set.name[0]).toBe('ACT1')
    expect(set.id[0]).toBe('g3')
  })

  // A gene's `ID` is the gene; a transcript's `ID` is the transcript. Reading
  // the attribute everywhere would file every mRNA under a gene of its own.
  it('does not read a transcript’s own ID as its gene', () => {
    const set = parseGtf(
      'C\tdb\tmRNA\t100\t400\t.\t+\t.\tID=lonely.1\n' +
        'C\tdb\texon\t100\t400\t.\t+\t.\tParent=lonely.1\n',
    )
    expect(set.length).toBe(1)
    expect(set.id[0]).toBe('')
    expect(set.name[0]).toBe('')
  })
})

/**
 * The GFF3 with no hierarchy in it at all, which is what a bacterial annotation
 * is.
 *
 * Prokka, Bakta and DFAST write **one row per feature** — its own `ID`, its own
 * `locus_tag`, and not one `Parent` anywhere in the file — because a bacterial
 * gene is a single uninterrupted CDS, so there is no sub-structure for a parent
 * to hold together and the gene and mRNA rows Ensembl writes would each be a
 * second copy of the same span.
 *
 * Read as fragments of a transcript they had never named, every CDS row in such
 * a file was dropped. What came through was the rows whose *type* ends in `rna`
 * and which were therefore read as transcripts of their own: a 6.4 Mb
 * Pseudomonas annotation arrived as **87 features out of 5,870**, every one of
 * them an RNA and not one of them a protein.
 */
describe('a GFF3 with no hierarchy in it', () => {
  /** Four rows as Prokka writes them, copied from a real `PAK.gff`. */
  const PROKKA =
    'L1\tProdigal:002006\tCDS\t7\t1545\t.\t+\t0\tID=T_00001;Name=dnaA;gene=dnaA;locus_tag=T_00001;product=Chromosomal replication initiator protein DnaA\n' +
    'L1\tProdigal:002006\tCDS\t6525\t7298\t.\t-\t0\tID=T_00005;locus_tag=T_00005;product=hypothetical protein\n' +
    'L1\tAragorn:001002\ttRNA\t286539\t286615\t.\t-\t.\tID=T_00259;locus_tag=T_00259;product=tRNA-Arg(ccg)\n' +
    'L1\tbarrnap:0.9\trRNA\t706360\t707890\t0\t+\t.\tID=T_00667;locus_tag=T_00667;product=16S ribosomal RNA\n'

  it('draws every row, not only the ones whose type ends in RNA', () => {
    const set = parseGtf(PROKKA)
    expect(set.length).toBe(4)
    // The shape of the bug, stated the way the file showed it: the two RNAs
    // came through and the two CDS rows did not.
    expect(indexOfNamed(set, 'dnaA')).toBeGreaterThanOrEqual(0)
  })

  it('converts a standalone row to 0-based half-open like any other', () => {
    const set = parseGtf(PROKKA)
    const at = indexOfNamed(set, 'dnaA')
    expect(set.start[at]).toBe(6)
    expect(set.end[at]).toBe(1545)
    expect(set.strand[at]).toBe(1)
  })

  it('takes the accession from `locus_tag` and the symbol from `gene`', () => {
    const set = parseGtf(PROKKA)
    const at = indexOfNamed(set, 'dnaA')
    expect(set.id[at]).toBe('T_00001')
  })

  // 2,643 of the file's 5,783 proteins are `hypothetical protein` and carry no
  // symbol at all. `name === id` is how a nameless feature is spelled.
  it('falls back to the accession where a row carries no symbol', () => {
    const set = parseGtf(PROKKA)
    const at = indexOfNamed(set, 'T_00005')
    expect(at).toBeGreaterThanOrEqual(0)
    expect(set.id[at]).toBe('T_00005')
  })

  // The whole informational content of a bacterial annotation. Without it the
  // card on a Prokka CDS reads `source Prodigal:002006` and stops.
  it('keeps `product` for the card and the colour picker', () => {
    const set = parseGtf(PROKKA)
    expect(set.detail[indexOfNamed(set, 'dnaA')]).toContain(
      'product Chromosomal replication initiator protein DnaA',
    )
    expect(set.detail[indexOfNamed(set, 'T_00259')]).toContain('product tRNA-Arg(ccg)')
  })

  // GFF3 asks for an `ID` only on a row something else points at, so a file
  // where nothing points anywhere is entitled to leave every one of them out.
  it('draws a row that does not even name itself', () => {
    const set = parseGtf(
      'L1\tx\tCDS\t100\t200\t.\t+\t0\tproduct=one\n' +
        'L1\tx\tCDS\t400\t500\t.\t+\t0\tproduct=two\n',
    )
    // Two rows, two features — not one feature keyed on the empty string.
    expect(set.length).toBe(2)
    expect(set.start[0]).toBe(99)
    expect(set.start[1]).toBe(399)
  })

  // GFF3's way of writing one feature with a gap in it: the same `ID` twice.
  it('joins two rows that share an ID into one feature', () => {
    const set = parseGtf(
      'L1\tx\tCDS\t100\t200\t.\t+\t0\tID=split;locus_tag=split\n' +
        'L1\tx\tCDS\t400\t500\t.\t+\t0\tID=split;locus_tag=split\n',
    )
    expect(set.length).toBe(1)
    expect(set.start[0]).toBe(99)
    expect(set.end[0]).toBe(500)
  })

  // NCBI opens every contig with one of these. It names no parent either, so it
  // arrives by the same door the CDS rows now do — and it is not a feature.
  it('does not draw the row that describes the sequence itself', () => {
    const set = parseGtf(
      'L1\t.\tregion\t1\t6395872\t.\t+\t.\tID=L1:1..6395872;Is_circular=true\n' +
        'L1\tx\tCDS\t100\t200\t.\t+\t0\tID=c1;locus_tag=c1\n',
    )
    expect(set.length).toBe(1)
    expect(set.id[0]).toBe('c1')
  })

  // The other half of the same rule: where a file *does* say what a row belongs
  // to, that still decides, and a CDS never becomes a feature beside its own
  // transcript.
  it('still folds a CDS into its parent where the file names one', () => {
    const set = parseGtf(
      'L1\tdb\tgene\t100\t400\t.\t+\t.\tID=g;Name=ACT1;locus_tag=b0001\n' +
        'L1\tdb\tmRNA\t100\t400\t.\t+\t.\tID=g.1;Parent=g\n' +
        'L1\tdb\texon\t100\t400\t.\t+\t.\tParent=g.1\n' +
        'L1\tdb\tCDS\t120\t380\t.\t+\t0\tParent=g.1\n',
    )
    expect(set.length).toBe(1)
    expect(set.name[0]).toBe('ACT1')
    expect(set.cdsStart[0]).toBe(119)
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

describe('un-gzipping a whole file', () => {
  /** `bgzip`'s own output shape: a member per block, then the empty end marker. */
  async function bgzipped(parts: string[]): Promise<Uint8Array> {
    const blocks: Uint8Array[] = []
    for (const part of parts) blocks.push(await bgzfBlock(new TextEncoder().encode(part)))
    blocks.push(await bgzfBlock(new Uint8Array(0)))
    const total = blocks.reduce((sum, block) => sum + block.length, 0)
    const out = new Uint8Array(total)
    let at = 0
    for (const block of blocks) {
      out.set(block, at)
      at += block.length
    }
    return out
  }

  async function gzipped(text: string): Promise<Uint8Array> {
    const stream = new Blob([text]).stream().pipeThrough(new CompressionStream('gzip'))
    return new Uint8Array(await new Response(stream).arrayBuffer())
  }

  /**
   * Run `work` on a platform whose `gzip` decompressor refuses a second member.
   *
   * Which is a platform this app has actually met: CI read a two-block BGZF and
   * threw `Trailing junk found after the end of the compressed stream`, Node's
   * own `ERR_TRAILING_JUNK_AFTER_STREAM_END`. Concatenated members are what
   * BGZF *is*, and the Compression Streams spec says trailing data after a
   * stream's end is a `TypeError` rather than the next member — so a reader that
   * hands a whole bgzipped file to one `gzip` stream is relying on something it
   * was never promised. Stubbed rather than waited for, because the runtime that
   * refuses is not the one these tests run on.
   */
  async function withStrictGzip<T>(work: () => Promise<T>): Promise<{ result: T; modes: string[] }> {
    const real = globalThis.DecompressionStream
    const modes: string[] = []
    function Strict(this: unknown, format: string): unknown {
      modes.push(format)
      if (format === 'gzip') {
        throw new TypeError('Trailing junk found after the end of the compressed stream')
      }
      return new real(format as CompressionFormat)
    }
    globalThis.DecompressionStream = Strict as unknown as typeof DecompressionStream
    try {
      return { result: await work(), modes }
    } finally {
      globalThis.DecompressionStream = real
    }
  }

  it('reads every block of a bgzipped file without asking for multi-member gzip', async () => {
    const parts = ['chrI\t1\t100\tone\n', 'chrI\t200\t300\ttwo\n', 'chrI\t400\t500\tthree\n']
    const bytes = await bgzipped(parts)
    const { result, modes } = await withStrictGzip(() => decodeAnnotationText(bytes))
    expect(result).toBe(parts.join(''))
    // The point of the stub: had the whole file gone to one `gzip` stream it
    // would have thrown, and the three blocks would never have been walked.
    expect(modes).not.toContain('gzip')
  })

  it('still un-gzips a plain `.gz`, which is one member and not BGZF', async () => {
    // The other half of the branch: `isBgzf` is a test, not an assumption, and a
    // file that fails it must keep taking the road it always did.
    const text = 'chrI\t1\t100\tplain\n'
    expect(await decodeAnnotationText(await gzipped(text))).toBe(text)
  })

  it('leaves bytes that are not gzipped alone', async () => {
    const text = 'chrI\t1\t100\traw\n'
    expect(await decodeAnnotationText(new TextEncoder().encode(text))).toBe(text)
  })
})
