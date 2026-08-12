/**
 * Chromosome names across the conventions that write them (§5.9).
 *
 * Two kinds of test here, and the second kind is the one that matters. The
 * first is that the equivalences hold: `chr1`, `1`, `01`, `I` and `NC_000001.11`
 * are one chromosome, and a file that spells it any of those ways can be
 * navigated by a file that spells it another. Those are easy to write and easy
 * to get right.
 *
 * The second is that the equivalences **stop**. Every one of the following is a
 * wrong answer a plausible implementation gives, and each is pinned here
 * because none of them would show on screen — a matcher that draws chromosome
 * ten under the label `X` draws a perfectly good picture of the wrong sequence:
 *
 * - `X` is ten in *S. cerevisiae* and a sex chromosome in *C. elegans*, and the
 *   two files look identical name by name;
 * - `2L` is not `2`, and `1A` is not `1`;
 * - an assembler's `NODE_1` is not anybody's chromosome one;
 * - hg19's `chrM` and hg38's `chrM` are one name and two sequences.
 */

import { describe, expect, it } from 'vitest'

import {
  alignNames,
  canonicalise,
  contextOf,
  describeTier,
  NameIndex,
  renameInto,
  romanValue,
  sequencesOf,
  styleOf,
} from '../../src/genome/naming'

/** The four conventions the same yeast genome is published in. */
const YEAST_ROMAN = [
  'chrI', 'chrII', 'chrIII', 'chrIV', 'chrV', 'chrVI', 'chrVII', 'chrVIII',
  'chrIX', 'chrX', 'chrXI', 'chrXII', 'chrXIII', 'chrXIV', 'chrXV', 'chrXVI', 'chrM',
]
const YEAST_BARE = YEAST_ROMAN.map((name) => name.slice(3))
const YEAST_PADDED = [
  '01', '02', '03', '04', '05', '06', '07', '08',
  '09', '10', '11', '12', '13', '14', '15', '16', 'MT',
]

const HUMAN_UCSC = ['chr1', 'chr2', 'chr21', 'chr22', 'chrX', 'chrY', 'chrM']
const HUMAN_ENSEMBL = ['1', '2', '21', '22', 'X', 'Y', 'MT']

/** *C. elegans*: Roman numerals **and** a sex chromosome, in one list. */
const WORM = ['I', 'II', 'III', 'IV', 'V', 'X', 'MtDNA']

/** *Drosophila*: arms, not chromosomes. */
const FLY = ['2L', '2R', '3L', '3R', '4', 'X', 'Y', 'mitochondrion_genome']

const into = (names: readonly string[]) => NameIndex.ofNames(names)
const found = (names: readonly string[], name: string) => into(names).find(name)?.name ?? null

describe('the conventions, and that they meet', () => {
  it('reads a UCSC name in an Ensembl file and back', () => {
    expect(found(HUMAN_ENSEMBL, 'chr1')).toBe('1')
    expect(found(HUMAN_ENSEMBL, 'chr21')).toBe('21')
    expect(found(HUMAN_UCSC, '1')).toBe('chr1')
    expect(found(HUMAN_UCSC, '22')).toBe('chr22')
  })

  it('takes every spelling of the chromosome prefix', () => {
    for (const spelling of ['chr1', 'Chr1', 'CHR1', 'chrom1', 'chromosome1', 'chromosome_1']) {
      expect(found(HUMAN_ENSEMBL, spelling)).toBe('1')
    }
  })

  it('drops leading zeros', () => {
    expect(found(HUMAN_ENSEMBL, '01')).toBe('1')
    expect(found(HUMAN_ENSEMBL, 'chr01')).toBe('1')
    expect(found(YEAST_PADDED, '1')).toBe('01')
  })

  it('reads Roman numerals against a numbered file, and back', () => {
    expect(found(YEAST_PADDED, 'chrXII')).toBe('12')
    expect(found(YEAST_PADDED, 'chrXVI')).toBe('16')
    expect(found(YEAST_ROMAN, '12')).toBe('chrXII')
    expect(found(YEAST_ROMAN, 'chr12')).toBe('chrXII')
  })

  it('reads the whole yeast genome from one convention into another', () => {
    const alignment = alignNames(sequencesOf(YEAST_ROMAN), sequencesOf(YEAST_PADDED))
    expect(alignment.unmatched).toEqual([])
    expect(alignment.pairs.get('chrI')?.name).toBe('01')
    expect(alignment.pairs.get('chrX')?.name).toBe('10')
    expect(alignment.pairs.get('chrXVI')?.name).toBe('16')
    expect(alignment.pairs.get('chrM')?.name).toBe('MT')
  })

  it('knows the organelles by every name anybody writes', () => {
    for (const spelling of ['chrM', 'MT', 'chrMT', 'M', 'MtDNA', 'Mito', 'mitochondrion']) {
      expect(found(HUMAN_UCSC, spelling)).toBe('chrM')
    }
    expect(found(FLY, 'chrM')).toBe('mitochondrion_genome')
    // The plant pair, which is the reason `C` is not the Roman hundred.
    const plant = ['Chr1', 'Chr2', 'ChrC', 'ChrM']
    expect(found(plant, 'chloroplast')).toBe('ChrC')
    expect(found(plant, 'Pt')).toBe('ChrC')
    expect(found(plant, 'mitochondria')).toBe('ChrM')
  })

  it('takes the reference organelle accessions, which are organelles first', () => {
    // `NC_012920.1` is the human rCRS. Read as an accession it is a number
    // nothing names; read as an organelle it is `chrM`, which is what it is.
    expect(found(HUMAN_UCSC, 'NC_012920.1')).toBe('chrM')
    expect(found(HUMAN_ENSEMBL, 'NC_012920.1')).toBe('MT')
  })

  it('names a chromosome from its RefSeq accession, for human and for mouse', () => {
    expect(found(HUMAN_UCSC, 'NC_000001.11')).toBe('chr1')
    expect(found(HUMAN_UCSC, 'NC_000022.11')).toBe('chr22')
    expect(found(HUMAN_UCSC, 'NC_000023.11')).toBe('chrX')
    expect(found(HUMAN_UCSC, 'NC_000024.10')).toBe('chrY')
    // Mouse's block starts at NC_000067 and runs to 19, then X, then Y.
    const mouse = ['chr1', 'chr19', 'chrX', 'chrY']
    expect(found(mouse, 'NC_000067.7')).toBe('chr1')
    expect(found(mouse, 'NC_000085.7')).toBe('chr19')
    expect(found(mouse, 'NC_000086.8')).toBe('chrX')
  })

  it('undecorates a FASTA header written by an NCBI tool', () => {
    const accessions = ['NC_001133', 'NC_001134']
    expect(found(accessions, 'ref|NC_001133|')).toBe('NC_001133')
    expect(found(accessions, 'gi|330443391|ref|NC_001133.9|')).toBe('NC_001133')
    expect(found(accessions, 'NC_001133.9 Saccharomyces cerevisiae chromosome I')).toBe('NC_001133')
  })

  it('relates a UCSC scaffold name to the accession it was made from', () => {
    const ucsc = ['chrUn_GL000220v1', 'chr11_KI270733v1_random', 'chr6_GL000250v2_alt']
    expect(found(ucsc, 'GL000220.1')).toBe('chrUn_GL000220v1')
    expect(found(ucsc, 'KI270733.1')).toBe('chr11_KI270733v1_random')
    expect(found(ucsc, 'GL000250.2')).toBe('chr6_GL000250v2_alt')
    // And back, which is the direction an Ensembl-named map asks in.
    const ensembl = ['GL000220.1', 'KI270733.1']
    expect(found(ensembl, 'chrUn_GL000220v1')).toBe('GL000220.1')
  })
})

describe('X, and the list that decides what it is', () => {
  it('reads X as ten where the file counts past nine in Roman', () => {
    expect(contextOf(YEAST_ROMAN)).toEqual({ roman: true, xIsTen: true })
    expect(canonicalise('chrX', contextOf(YEAST_ROMAN)).key).toBe('num:10')
    expect(found(YEAST_ROMAN, '10')).toBe('chrX')
  })

  it('reads X as the sex chromosome where the numerals stop at V', () => {
    // *C. elegans* is I–V and X. There is no chromosome ten to confuse it with,
    // and the absence of `IX` and `XI` is what says so.
    expect(contextOf(WORM)).toEqual({ roman: true, xIsTen: false })
    expect(canonicalise('X', contextOf(WORM)).key).toBe('sex:x')
    expect(found(WORM, 'chrX')).toBe('X')
    expect(found(WORM, '10')).toBeNull()
  })

  it('never reads X as ten in a file that is not counting in Roman', () => {
    expect(contextOf(HUMAN_ENSEMBL).roman).toBe(false)
    expect(found(HUMAN_ENSEMBL, 'chrX')).toBe('X')
    // A human file missing its X must not answer `chrX` with chromosome ten,
    // which is what a context-free Roman reading of `X` would do.
    expect(found(['1', '10', '22'], 'chrX')).toBeNull()
  })

  it('carries the source file’s reading across to a file that has another', () => {
    // The asymmetric pair: yeast in Roman on one side, yeast in digits on the
    // other. Only the *source* list knows its `X` is ten.
    const roman = NameIndex.ofNames(YEAST_ROMAN).context
    expect(into(YEAST_PADDED).find('chrX', { from: roman })?.name).toBe('10')
    // Without it, `X` is the one numeral that must not be guessed.
    expect(into(YEAST_PADDED).find('chrX')).toBeNull()
    // Every other numeral is unambiguous by shape and needs no help.
    expect(into(YEAST_PADDED).find('chrXI')?.name).toBe('11')
  })

  it('reads the bare Roman list too', () => {
    expect(found(YEAST_BARE, 'chrXII')).toBe('XII')
    expect(found(YEAST_BARE, '12')).toBe('XII')
  })

  it('reads only chromosome-shaped numerals', () => {
    expect(romanValue('XII')).toBe(12)
    expect(romanValue('XLVIII')).toBe(48)
    // C, D and M are excluded from the numeral system entirely: no genome has a
    // hundredth chromosome, and `M` has to stay free for the mitochondrion.
    expect(romanValue('M')).toBe(0)
    expect(romanValue('C')).toBe(0)
    expect(romanValue('MT')).toBe(0)
  })
})

describe('what must not be equated', () => {
  it('keeps a chromosome arm apart from its chromosome', () => {
    expect(found(FLY, 'chr2L')).toBe('2L')
    expect(found(FLY, '2R')).toBe('2R')
    expect(found(FLY, '2')).toBeNull()
    expect(found(FLY, 'chr2')).toBeNull()
  })

  it('keeps wheat’s three homoeologues apart, and apart from the number', () => {
    const wheat = ['1A', '1B', '1D', '2A']
    expect(found(wheat, 'chr1A')).toBe('1A')
    expect(found(wheat, '1')).toBeNull()
    expect(found(wheat, '1a')).toBe('1A')
  })

  it('keeps a patch, a scaffold and an alt apart from the chromosome', () => {
    const human = ['chr1', 'chr1_KI270706v1_random', 'chr6_GL000250v2_alt']
    expect(found(human, '1')).toBe('chr1')
    expect(found(human, '1_random')).toBeNull()
  })

  it('matches an assembler’s contigs by their spelling and nothing else', () => {
    const mag = ['NODE_1_length_338947_cov_15.4', 'k141_12345', 'tig00000001', 'scaffold_1']
    expect(found(mag, 'NODE_1_length_338947_cov_15.4')).toBe('NODE_1_length_338947_cov_15.4')
    expect(found(mag, 'node_1_length_338947_cov_15.4')).toBe('NODE_1_length_338947_cov_15.4')
    // No numeral, no accession, no organelle table is applied to any of them.
    expect(found(mag, 'scaffold_01')).toBeNull()
    expect(found(mag, '1')).toBeNull()
    expect(found(mag, 'tig1')).toBeNull()
    expect(canonicalise('NODE_1_length_338947_cov_15.4', contextOf(mag)).opaque).toBe(true)
  })

  it('leaves a linkage group a linkage group', () => {
    // A linkage map is numbered by linkage and an assembly by length; the two
    // orders agree only by luck.
    expect(found(['LG1', 'LG2'], '1')).toBeNull()
    expect(found(['LG1', 'LG2'], 'LG01')).toBe('LG1')
  })

  it('keeps a bacterial replicon called “chromosome” whole', () => {
    // Stripping the prefix would leave an empty name that collides with every
    // other file's empty name.
    expect(canonicalise('Chromosome', contextOf(['Chromosome'])).key).toBe('raw:chromosome')
    expect(found(['Chromosome', 'plasmid_1'], 'chr')).toBeNull()
  })

  it('refuses to guess where one file spells a chromosome two ways', () => {
    const muddled = ['1', '01', 'X']
    // Each of the two answers for itself...
    expect(found(muddled, '1')).toBe('1')
    expect(found(muddled, '01')).toBe('01')
    // ...and a third spelling cannot say which of them it meant.
    expect(found(muddled, 'chr1')).toBeNull()
    // Unless a length settles it, which is the only evidence that comes from
    // the sequence rather than from its spelling.
    const sized = NameIndex.of([
      { name: '1', length: 1000 },
      { name: '01', length: 2000 },
    ])
    expect(sized.find('chr1', { length: 2000 })?.name).toBe('01')
    expect(sized.find('chr1', { length: 3000 })).toBeNull()
  })

  it('gives one target to one source, and drops a contested pair', () => {
    const alignment = alignNames(sequencesOf(['chr1', '1']), sequencesOf(['1', 'chr1']))
    // Both are exact matches, crosswise, and each takes its own.
    expect(alignment.pairs.get('chr1')?.name).toBe('chr1')
    expect(alignment.pairs.get('1')?.name).toBe('1')
    expect(alignment.renamed).toBe(0)
  })
})

describe('length corroborates, and never matches', () => {
  it('reports a name match whose two sequences are different lengths', () => {
    // hg19's chrM is NC_001807 at 16,571 bp; hg38's is the rCRS at 16,569. One
    // name, two sequences — and the only thing that can say so is the size.
    const hg38 = NameIndex.of([{ name: 'chrM', length: 16_569 }])
    const match = hg38.find('MT', { length: 16_571 })
    expect(match?.name).toBe('chrM')
    expect(match?.lengths).toBe('differ')
    expect(hg38.find('MT', { length: 16_569 })?.lengths).toBe('agree')
  })

  it('never matches two sequences on their length alone', () => {
    const equal = NameIndex.of([{ name: 'NODE_7', length: 5000 }])
    expect(equal.find('NODE_9', { length: 5000 })).toBeNull()
  })

  it('collects the contested renames rather than hiding them', () => {
    const renaming = renameInto(
      [{ name: 'chr1', length: 249_250_621 }],
      [{ name: '1', length: 248_956_422 }],
    )
    expect(renaming.names).toEqual(['1'])
    expect(renaming.contested).toHaveLength(1)
    expect(renaming.contested[0].asked).toBe('chr1')
  })
})

describe('renaming a track into a map’s vocabulary', () => {
  it('rewrites what matches and leaves what does not', () => {
    const renaming = renameInto(sequencesOf(['chr1', 'chr2', 'chrUnplaced']), sequencesOf(HUMAN_ENSEMBL))
    expect(renaming.names).toEqual(['1', '2', 'chrUnplaced'])
    expect(renaming.renamed).toBe(2)
    // The way back, for a reader that cannot be rewritten — a bigWig's refNames.
    expect(renaming.sourceOf.get('1')).toBe('chr1')
    expect(renaming.sourceOf.has('chrUnplaced')).toBe(false)
  })

  it('renames nothing where a track is about another genome', () => {
    const renaming = renameInto(sequencesOf(['NODE_1', 'NODE_2']), sequencesOf(HUMAN_ENSEMBL))
    expect(renaming.names).toEqual(['NODE_1', 'NODE_2'])
    expect(renaming.renamed).toBe(0)
  })
})

describe('reporting', () => {
  it('names the convention a list is written in', () => {
    expect(styleOf(HUMAN_UCSC)).toBe('ucsc')
    expect(styleOf(HUMAN_ENSEMBL)).toBe('ensembl')
    expect(styleOf(YEAST_ROMAN)).toBe('roman')
    expect(styleOf(WORM)).toBe('roman')
    expect(styleOf(['NC_000001.11', 'NC_000002.12', 'NC_000003.12'])).toBe('accession')
    expect(styleOf(['NODE_1_length_10_cov_2', 'k141_9', 'tig00000001'])).toBe('assembly')
    expect(styleOf([])).toBe('empty')
  })

  it('says which rule reached a match, in words a reader can weigh', () => {
    expect(into(HUMAN_ENSEMBL).find('chr1')?.tier).toBe('prefix')
    expect(into(HUMAN_ENSEMBL).find('chrM')?.tier).toBe('organelle')
    expect(into(YEAST_PADDED).find('chrXII')?.tier).toBe('roman')
    expect(into(HUMAN_UCSC).find('NC_000001.11')?.tier).toBe('accession')
    expect(into(HUMAN_UCSC).find('CHR1')?.tier).toBe('case')
    expect(into(HUMAN_UCSC).find('chr1')?.tier).toBe('exact')
    // Every tier has its own sentence, because the point of carrying one is
    // that `the chr prefix` and `the accession's version` earn different belief.
    expect(describeTier('prefix')).toContain('chr')
    expect(describeTier('version')).toContain('version')
  })

  it('flags an accession matched at another version', () => {
    const match = into(['NC_000001.11']).find('NC_000001.10')
    expect(match?.name).toBe('NC_000001.11')
    expect(match?.tier).toBe('version')
  })

  it('keeps the name that was asked for, beside the one that answered', () => {
    const match = into(HUMAN_ENSEMBL).find('chr1')
    expect(match).toMatchObject({ asked: 'chr1', name: '1' })
  })
})
