/**
 * Every name a reader of this app takes, against the table that decides which
 * door it belongs to and whether a folder offers it (`browse/route.ts`).
 *
 * The table was taught its names one format at a time, and four kinds were
 * never added: a 3D structure, a saved workspace, the text tables a §8 format
 * is published under when its own suffix is not used, and `.bgz`. A folder drew
 * each of them dimmed — *not a format this viewer opens* — beside the drop that
 * opened it. So the names are listed here as the readers know them, and a
 * format taught to a reader and not to the router fails here rather than being
 * found dimmed in somebody's folder.
 */

import { describe, expect, it } from 'vitest'

import { isTextTableName, routeFor, routeOf, unroutableNote } from '@/browse/route'
import { isStructureName } from '@/annotations/g3d'
import { looksLikeConfig } from '@/state/SessionConfig'
import { kindOf } from '@/state/store'

/** The map door: a matrix, or the contact list one is binned from (§3). */
const MAPS = [
  'rep1.cool',
  'rep1.mcool',
  'cells.scool',
  'rep1.hic',
  'rep1.h5',
  'rep1.hdf5',
  'lib.pairs',
  'lib.pairs.gz',
  'lib.pairs.bgz',
  's_100000.matrix',
  's_100000_iced.matrix.gz',
]

/** The genome door: every track, sequence and annotation of §8, under the names they are published as. */
const GENOME = [
  'atac.bw',
  'atac.bigWig',
  'peaks.bb',
  'peaks.bigBed',
  'cov.bedGraph',
  'cov.bdg.gz',
  'cov.bg',
  'cov.wig',
  'peaks.bed',
  'peaks.bed.gz',
  'peaks.bed.bgz',
  'x.narrowPeak',
  'x.broadPeak.gz',
  'x.gappedPeak',
  'loops.bedpe',
  'loops.bedpe.gz',
  'genes.gtf',
  'genes.gtf.gz',
  'genes.gff',
  'genes.gff3.gz',
  'genes.genePred',
  'refFlat.txt.gz',
  'hg38.refGene.txt.gz',
  'hg38.ncbiRefSeq.txt.gz',
  'knownGene.txt.gz',
  'calls.vcf',
  'calls.vcf.gz',
  'gnomad.chr21.vcf.bgz',
  'reads.bam',
  'genome.fa',
  'genome.fasta.gz',
  'genome.fna',
  'genome.2bit',
  'genome.fa.fai',
  'hg38.chrom.sizes',
  'hg38.sizes',
  'x.genome',
  'gtex.barChart',
  'gtex.bigBarChart',
  'm.bedMethyl',
  'm.bigMethyl',
  'loops.interact',
  'loops.bigInteract',
  'loops.longrange',
  'loops.longrange.txt.gz',
  'loops.longTabix',
  'cytoBand.txt',
  'cytoBandIdeo.txt.gz',
  'Yeast_cytobands.txt',
  'sample.SJ.out.tab',
  'sample.junc',
  'sample.junctions.bed',
]

/** A 3D model (§25): the genome door, and a cell of its own once it is there. */
const STRUCTURES = [
  'model.g3d',
  'model.g3d.gz',
  'model.g3d.txt',
  'model.3dg',
  'model.3dg.txt.gz',
  'model.bed3d',
  'model.bed3d.gz',
  'model.pdb',
  'model.pdb.gz',
]

/** A saved workspace: tabs, through the config road. */
const WORKSPACES = ['Yeast_microC.chromosomix.json', 'workspace.json']

/**
 * Text tables whose name does not say what they hold, which the loader reads by
 * their bytes (§8.3) — a loop table from chromosight, a GEO supplement.
 */
const TABLES = [
  'Yeast_microC_loops.tsv',
  'dots.tsv.gz',
  'peaks.txt',
  'GSE1_peaks.txt.gz',
  'counts.tab',
  'hg38.chrom.sizes.txt',
]

/** What a folder draws dimmed, and a word its reason must carry. */
const DIMMED: Array<[name: string, reason: string]> = [
  ['hub.txt', 'stores drawer'],
  ['myLab.hub.txt', 'stores drawer'],
  ['genomes.txt', 'hub.txt'],
  ['trackDb.txt', 'hub.txt'],
  ['reads.bam.bai', 'BAM index'],
  ['reads.bai', 'BAM index'],
  ['reads.bam.csi', 'BAM index'],
  ['peaks.bed.gz.tbi', 'tabix index'],
  ['lib.pairs.gz.px2', 'pairix index'],
  ['genome.fa.gz.gzi', 'bgzip index'],
  ['reads.cram', 'samtools view -b'],
  ['reads.cram.crai', 'samtools view -b'],
  ['tracing.csv', 'tab- or space-separated'],
  ['peaks.bed.bz2', 'gzip'],
  ['peaks.bed.xz', 'gzip'],
  ['peaks.bed.zst', 'gzip'],
  ['reads.fastq.gz', 'Not a format this viewer opens.'],
  ['reads.sam', 'Not a format this viewer opens.'],
  ['figure.pdf', 'Not a format this viewer opens.'],
  ['README', 'Not a format this viewer opens.'],
]

const DRIVE = 'https://www.googleapis.com/drive/v3/files/1pq7NDWoDdEJNTTOZEnhoKYYrr66zzD7?alt=media&supportsAllDrives=true'

describe('which door a name belongs to', () => {
  it('sends every map and every contact list to the map', () => {
    for (const name of MAPS) expect([name, routeOf(name)]).toEqual([name, 'map'])
  })

  it('sends every track, sequence and annotation to the genome door', () => {
    for (const name of GENOME) expect([name, routeOf(name)]).toEqual([name, 'genome'])
  })

  it('sends a 3D model to the genome door, by the name that opens its cell', () => {
    for (const name of STRUCTURES) {
      expect([name, routeOf(name), isStructureName(name)]).toEqual([name, 'genome', true])
    }
  })

  it('sends a saved workspace to the config road, by the test that road uses', () => {
    for (const name of WORKSPACES) {
      expect([name, routeOf(name), looksLikeConfig(name)]).toEqual([name, 'workspace', true])
    }
  })

  it('leaves a text table to its bytes, where the name does not say', () => {
    for (const name of TABLES) expect([name, routeOf(name), isTextTableName(name)]).toEqual([name, 'unknown', true])
    // By the last segment of an address, as every other name here is read.
    expect(isTextTableName('https://h.example/GSE1/peaks.txt.gz?sig=1')).toBe(true)
    expect(isTextTableName('https://h.example/peaks.txt/rep1.bw')).toBe(false)
    expect(isTextTableName('notes.md')).toBe(false)
  })

  it('reads the name a Drive folder gave a file whose address is an id', () => {
    expect(routeFor(DRIVE, 'Yeast_microC.chromosomix.json')).toBe('workspace')
    expect(routeFor(DRIVE, 'model.pdb')).toBe('genome')
    expect(routeFor(DRIVE, 'loops.tsv')).toBe('unknown')
  })

  it('agrees with a store about what a structure is', () => {
    // A store row's mark came from this table and called a g3d a contact map.
    expect(kindOf('https://h.example/model.g3d.gz')).toBe('genome')
    expect(kindOf('https://h.example/session.json')).toBe('workspace')
  })
})

describe('what a folder offers', () => {
  it('offers every name the app opens', () => {
    for (const name of [...MAPS, ...GENOME, ...STRUCTURES, ...WORKSPACES, ...TABLES]) {
      expect([name, unroutableNote(name)]).toEqual([name, null])
    }
  })

  it('dims what nothing here opens, each with its own reason', () => {
    for (const [name, reason] of DIMMED) {
      const note = unroutableNote(name)
      expect([name, note?.includes(reason)]).toEqual([name, true])
    }
  })

  it('does not offer a hub file as a table, though it ends in `.txt`', () => {
    // A track hub is a store (§24.10): pasted into the drawer it opens, and as
    // a table it would be refused as a BED with nothing to say why.
    expect(routeOf('hub.txt')).toBe('unknown')
    expect(unroutableNote('hub.txt')).not.toBeNull()
  })
})
