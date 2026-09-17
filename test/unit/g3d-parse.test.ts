/**
 * WashU's g3d text, from the bytes to the beads (§25).
 *
 * Three claims. The first is about what the format can be *mistaken* for: a
 * g3d is five or six columns with an integer in the second, which is the shape
 * of a BED5 — and the sniffer is asked before the BED sniffer, whose last line
 * is `return 'bed'`. If that collision is not held shut, every BED5 in the
 * world opens as a model of its own scores; if the sniffer is asked too late,
 * every g3d opens as a lane of boxes with its coordinates thrown away.
 *
 * The second is that the spacing is **inferred and nothing else**: the file
 * carries no end column and no header, the resolution is the commonest step
 * between consecutive sorted starts, and a file written out of order — which
 * `g3dtools`' own example is — comes out at the spacing its beads are at.
 *
 * The third is that the coordinates survive the *sort*, which is `bars`'
 * argument made again: `FeatureBuilder.finish` orders rows by
 * `(contig, start)`, and a coordinate kept in file order beside a set in
 * genomic order is a bead drawn at the wrong locus — which looks exactly like
 * a model.
 */

import { describe, expect, it } from 'vitest'

import { sniffBarChart } from '@/annotations/barchart'
import {
  G3D_FIELD_HAPLOTYPE,
  g3dSummary,
  isStructureName,
  parseBed3d,
  parseG3d,
  sniffBed3d,
  sniffG3d,
  structureFromBeads,
  widthOf,
  writeBed3d,
} from '@/annotations/g3d'
import { fieldLevels, featureFields } from '@/annotations/fields'
import { featureRange } from '@/annotations/featureset'
import { cardFor, kindFor } from '@/annotations/loader'
import { sniffFormat } from '@/annotations/parse'
import { sniffSignal } from '@/annotations/signal'
import { sniffVcf } from '@/annotations/vcf'
import {
  defaultStyle,
  defaultStructureStyle,
  isIntervalSet,
  isStructure,
  structureStyleOf,
} from '@/annotations/types'

/** Tabs, so a test can be written with spaces and read as the format. */
function rows(lines: string[]): string {
  return lines.map((line) => line.replace(/ +/g, '\t')).join('\n')
}

/**
 * The example `g3dtools` ships, verbatim: two haplotypes, unsorted, 1.04 Mb
 * apart with a gap of eight beads after the fifth.
 */
const EXAMPLE = rows([
  'chr7 16760000 -14.3866688728 -36.3919302029 19.8483965881 m',
  'chr7 16760000 -24.9116268071 50.0521268287 9.91073185128 p',
  'chr7 25160000 -10.1170055526 -34.8975763469 20.2401719179 m',
  'chr7 25160000 -21.8210915649 27.1128556621 13.4856945965 p',
  'chr7 33540000 -4.11059384846 -54.4940083464 4.21321135564 m',
  'chr7 33540000 -12.0040359857 31.5960497183 26.6925954134 p',
  'chr7 41940000 5.75342635105 -55.4976428728 8.65307697332 m',
  'chr7 41940000 -23.7372022413 36.0614692267 31.919119243 p',
  'chr7 50320000 -10.7099779927 -38.0214001171 25.8308473821 m',
  'chr7 50320000 -28.5142098162 26.6468499001 28.8634805533 p',
  'chr7 26200000 -11.5800097945 -37.9903257744 16.2461100893 m',
  'chr7 26200000 -15.9552426623 27.016940724 17.5722080595 p',
  'chr7 27260000 -14.1883124179 -44.7860807973 12.4104162757 m',
  'chr7 27260000 -20.0857754297 30.9204143041 18.4774635708 p',
  'chr7 28300000 -18.0160836669 -39.398544495 12.811858164 m',
  'chr7 28300000 -14.9383020843 39.1464516779 17.3743509519 p',
  'chr7 29360000 -11.8032470923 -47.3595095319 13.2828128833 m',
  'chr7 29360000 -12.2445277916 41.2431968179 14.8844908717 p',
  'chr7 30400000 -12.8674349856 -45.0752589744 9.15498568359 m',
])

/** A haploid model at 5 kb over two sequences, written back to front. */
function haploid(): string {
  const lines: string[] = []
  for (const contig of ['chrII', 'chrI']) {
    for (let bead = 19; bead >= 0; bead--) {
      const t = bead / 19
      // A helix: consecutive beads a short step apart, the whole a turn round.
      const x = Math.cos(t * 6) * (contig === 'chrI' ? 10 : 12)
      const y = Math.sin(t * 6) * (contig === 'chrI' ? 10 : 12)
      const z = t * 20 - 10 + (contig === 'chrII' ? 30 : 0)
      lines.push(`${contig}\t${bead * 5000}\t${x.toFixed(4)}\t${y.toFixed(4)}\t${z.toFixed(4)}`)
    }
  }
  return lines.join('\n')
}

describe('what a g3d is not', () => {
  it('leaves a BED5 alone, though five columns and an integer start are its shape', () => {
    // Column 3 is an integer end and column 5 an integer score: nothing
    // fractional, nothing negative, so the shape test refuses it before the
    // chain test is asked.
    const bed5 = rows([
      'chrI 1000 2000 peak1 500',
      'chrI 3000 4000 peak2 300',
      'chrI 5000 6000 peak3 100',
    ])
    expect(sniffG3d(bed5)).toBe(false)
    expect(sniffFormat(bed5)).toBe('bed')
  })

  it('leaves a BED6 alone, because a strand is not a haplotype', () => {
    const bed6 = rows(['chrI 1000 2000 peak1 500 +', 'chrI 3000 4000 peak2 0.5 -'])
    expect(sniffG3d(bed6)).toBe(false)
  })

  it('leaves a bedGraph and a narrowPeak alone by their column counts', () => {
    const bedgraph = rows(['chrI 0 100 4.5', 'chrI 100 200 5.5'])
    expect(sniffG3d(bedgraph)).toBe(false)
    const narrow = rows(['chrI 1000 2000 p1 500 + 3.5 9 4.2 500'])
    expect(sniffG3d(narrow)).toBe(false)
  })

  it('refuses five numeric columns that are not a chain', () => {
    // Fractional, so the shape test passes; scattered, so the chain test does
    // not. Twelve beads whose "coordinates" are unrelated numbers step about
    // half the cloud's extent from one to the next.
    const scatter = rows(
      Array.from({ length: 12 }, (_, at) => {
        const x = (at * 7919) % 101
        const y = (at * 104729) % 97
        const z = (at * 1299709) % 89
        return `chrI ${at * 1000} ${x + 0.5} ${y + 0.5} ${z + 0.5}`
      }),
    )
    expect(sniffG3d(scatter)).toBe(false)
  })

  it('is named .g3d and read as one even when its coordinates are whole numbers', () => {
    const lattice = rows(['chrI 0 1 2 3', 'chrI 5000 2 2 3', 'chrI 10000 3 2 3'])
    expect(sniffG3d(lattice)).toBe(false)
    expect(sniffG3d(lattice, 'lattice.g3d')).toBe(true)
  })

  it('cannot capture the sniffers asked around it, nor they it', () => {
    expect(sniffVcf(EXAMPLE)).toBe(false)
    expect(sniffBarChart(EXAMPLE)).toBe(false)
    expect(sniffSignal(EXAMPLE)).toBe(null)
    const vcf = '##fileformat=VCFv4.3\n' + rows(['chrV 1000 . A G 60 PASS .'])
    expect(sniffG3d(vcf)).toBe(false)
  })

  it('stops once it has seen enough, rather than reading the whole file', () => {
    const head = EXAMPLE.split('\n')
    const junk = Array.from({ length: 300 }, () => 'this is not a row of anything')
    // Two hundred rows are read; the nonsense is past them. A sniffer that read
    // the whole file would say no.
    const text = [...head, ...Array.from({ length: 200 }, (_, at) => head[at % head.length]), ...junk].join('\n')
    expect(sniffG3d(text)).toBe(true)
  })
})

describe('what a g3d is', () => {
  it('is the example g3dtools ships, phased and unsorted', () => {
    expect(sniffG3d(EXAMPLE)).toBe(true)
    expect(sniffG3d(EXAMPLE, 'model.g3d.gz')).toBe(true)
  })

  it('is a five-column file with no haplotype at all', () => {
    expect(sniffG3d(haploid())).toBe(true)
  })

  it('is a .3dg, whose haplotype is folded into the chromosome name', () => {
    const dipc = rows([
      'chr7(mat) 16760000 -14.38 -36.39 19.84',
      'chr7(pat) 16760000 -24.91 50.05 9.91',
      'chr7(mat) 17800000 -14.10 -36.10 19.50',
      'chr7(pat) 17800000 -24.50 49.80 9.60',
    ])
    expect(sniffG3d(dipc)).toBe(true)
    const set = parseG3d(dipc)
    expect(set.contigs).toEqual(['chr7'])
    expect(set.model?.haplotypes).toEqual(['maternal', 'paternal'])
  })

  it('lands on the Structures card as its own kind', () => {
    expect(cardFor('structure')).toBe('structure')
    expect(kindFor('structure', 'structure')).toBe('structure')
    expect(kindFor('structure', 'bed')).toBe(null)
    expect(kindFor('linear', 'structure')).toBe(null)
    expect(kindFor('overlay', 'structure')).toBe(null)
    expect(isStructure('structure')).toBe(true)
    expect(isIntervalSet('structure')).toBe(true)
  })
})

describe('the spacing', () => {
  it('is the commonest step between sorted starts, not the gap', () => {
    // The example's starts, one haplotype: 16.76, 25.16, 26.20, 27.26, 28.30,
    // 29.36, 30.40, 33.54, 41.94, 50.32 Mb. Six steps of 1,040,000 (some 1.06),
    // and two long gaps — the mode is the bead spacing.
    expect(widthOf([[16760000, 25160000, 33540000, 41940000, 50320000, 26200000, 27260000, 28300000, 29360000, 30400000]])).toBe(1040000)
  })

  it('is counted across every chromosome, so a short one cannot outvote a long one', () => {
    expect(widthOf([[0, 7000], [0, 5000, 10000, 15000, 20000]])).toBe(5000)
  })

  it('goes to the smaller of two equally common steps', () => {
    expect(widthOf([[0, 5000, 15000, 20000, 30000]])).toBe(5000)
  })

  it('is one base where there is nothing to measure', () => {
    expect(widthOf([[100]])).toBe(1)
    expect(widthOf([])).toBe(1)
  })
})

describe('parsing', () => {
  it('gives every bead its inferred width and sorts them into genomic order', () => {
    const set = parseG3d(EXAMPLE)
    expect(set.length).toBe(19)
    expect(set.model?.width).toBe(1040000)
    for (let at = 0; at < set.length; at++) {
      expect(set.end[at] - set.start[at]).toBe(1040000)
      if (at > 0) expect(set.start[at]).toBeGreaterThanOrEqual(set.start[at - 1])
    }
  })

  it('keeps each coordinate with its own bead through the sort', () => {
    const set = parseG3d(EXAMPLE)
    const model = set.model
    if (model === undefined) throw new Error('no model')
    // The maternal bead at 26,200,000 was the eleventh row of the file and is
    // now somewhere in the middle of the sorted set: find it by locus and
    // haplotype, and its coordinate must be the one the row carried.
    let found = -1
    for (let at = 0; at < set.length; at++) {
      if (set.start[at] === 26200000 && model.haplotypes[model.hap[at]] === 'maternal') found = at
    }
    expect(found).toBeGreaterThanOrEqual(0)
    expect(model.x[found]).toBeCloseTo(-11.5800097945, 5)
    expect(model.y[found]).toBeCloseTo(-37.9903257744, 5)
    expect(model.z[found]).toBeCloseTo(16.2461100893, 5)
  })

  it('names the haplotypes in the words g3dtools writes, and orders the pair at a locus', () => {
    const set = parseG3d(EXAMPLE)
    const model = set.model
    if (model === undefined) throw new Error('no model')
    expect(model.haplotypes).toEqual(['maternal', 'paternal'])
    // Two beads per locus, maternal first, because the sort breaks the tie on
    // the haplotype index and the maternal chain was seen first.
    expect(set.start[0]).toBe(16760000)
    expect(set.start[1]).toBe(16760000)
    expect(model.hap[0]).toBe(0)
    expect(model.hap[1]).toBe(1)
  })

  it('offers the haplotype as a field of the file, on a phased file only', () => {
    const phased = parseG3d(EXAMPLE)
    const keys = featureFields(phased, 'structure').map((field) => field.key)
    expect(keys).toContain(G3D_FIELD_HAPLOTYPE)
    expect(fieldLevels(phased, G3D_FIELD_HAPLOTYPE)).toEqual(['maternal', 'paternal'])
    const plain = parseG3d(haploid())
    expect(featureFields(plain, 'structure').map((field) => field.key)).not.toContain(G3D_FIELD_HAPLOTYPE)
    expect(plain.model?.haplotypes).toEqual(['shared'])
  })

  it('is a feature set a range query answers, like any other', () => {
    const set = parseG3d(haploid())
    expect(set.contigs).toEqual(['chrII', 'chrI'])
    const chrI = set.contigs.indexOf('chrI')
    const [from, to] = featureRange(set, chrI, 20000, 30001)
    const hits: number[] = []
    for (let at = from; at < to; at++) {
      if (set.end[at] > 20000 && set.start[at] < 30001) hits.push(set.start[at])
    }
    expect(hits).toEqual([20000, 25000, 30000])
  })

  it('counts and drops a row whose coordinate is not a number, and refuses a file of them', () => {
    const mixed = EXAMPLE + '\n' + rows(['chr7 31440000 nope -1 2 m'])
    expect(parseG3d(mixed).length).toBe(19)
    expect(() => parseG3d(rows(['chr7 100 x y z', 'chr7 200 a b c']))).toThrow(/chromosome, start, x, y, z/)
    expect(() => parseG3d('')).toThrow(/no rows/)
  })

  it('says what it holds, spacing included, under the row', () => {
    expect(g3dSummary(parseG3d(EXAMPLE))).toBe('19 beads · 1.04 Mb · 2 haplotypes · 1 sequence')
    expect(g3dSummary(parseG3d(haploid()))).toBe('40 beads · 5 kb · 2 sequences')
  })
})

describe('the structure style', () => {
  it('is present on a fresh structure row and on no other kind', () => {
    expect(defaultStyle('structure', '#000').structure).toEqual(defaultStructureStyle())
    expect(defaultStyle('segments', '#000').structure).toBeUndefined()
    expect(defaultStyle('track', '#000').structure).toBeUndefined()
  })

  it('clamps a stored style rather than believing it', () => {
    const read = structureStyleOf({
      representation: 'hologram',
      colourBy: 'track:abc',
      beadRadius: 1e6,
      tubeRadius: -1,
      opacity: 7,
      others: 'nothing',
      gaps: 'dashed',
      labels: false,
      axes: true,
      projection: 'orthographic',
      lit: false,
      haplotype: 'paternal',
    })
    expect(read.representation).toBe('tube')
    expect(read.colourBy).toBe('track:abc')
    expect(read.beadRadius).toBe(3)
    expect(read.tubeRadius).toBe(0.02)
    expect(read.opacity).toBe(1)
    expect(read.others).toBe('ghost')
    expect(read.gaps).toBe('dashed')
    expect(read.labels).toBe(false)
    expect(read.axes).toBe(true)
    expect(read.projection).toBe('orthographic')
    expect(read.lit).toBe(false)
    expect(read.haplotype).toBe('paternal')
    expect(structureStyleOf(null)).toEqual(defaultStructureStyle())
    expect(structureStyleOf('tube')).toEqual(defaultStructureStyle())
  })
})

// ---------------------------------------------------------------------------
// bed3d: the same file with the end written down
// ---------------------------------------------------------------------------

/** A chain of ten 5 kb beads with their ends, and two on a second sequence. */
const BED3D = [
  ...Array.from({ length: 10 }, (_, i) => `chr1\t${i * 5000}\t${(i + 1) * 5000}\t${i * 0.9}\t${i * 0.4 - 1}\t${0.3 * i}`),
  'chr2\t0\t5000\t12.5\t-3.0\t0.25',
  'chr2\t5000\t10000\t13.1\t-2.6\t0.4',
].join('\n')

describe('bed3d', () => {
  it('is chromosome, start, end, x, y, z — a BED3 with a place on each row', () => {
    expect(sniffBed3d(BED3D)).toBe(true)
    // …and not a g3d: a g3d's sixth column is a haplotype, and `5000` is not.
    expect(sniffG3d(BED3D)).toBe(false)
  })

  it('leaves a BED6 alone, whose name and strand are not coordinates', () => {
    const bed6 = ['chr1\t0\t5000\tpeak1\t900\t+', 'chr1\t5000\t10000\tpeak2\t850\t-'].join('\n')
    expect(sniffBed3d(bed6)).toBe(false)
    // A numeric name and score still leave a strand, which is not a number.
    const numeric = ['chr1\t0\t5000\t1\t900\t+', 'chr1\t5000\t10000\t2\t850\t-'].join('\n')
    expect(sniffBed3d(numeric)).toBe(false)
  })

  it('refuses an end that is not after its start', () => {
    const backwards = BED3D.replace('chr1\t5000\t10000', 'chr1\t5000\t5000')
    expect(sniffBed3d(backwards)).toBe(false)
  })

  it('needs a fractional or negative coordinate, unless it is named .bed3d', () => {
    const lattice = ['chr1\t0\t5000\t0\t0\t0', 'chr1\t5000\t10000\t1\t0\t0'].join('\n')
    expect(sniffBed3d(lattice)).toBe(false)
    expect(sniffBed3d(lattice, 'model.bed3d')).toBe(true)
    expect(sniffBed3d(lattice, 'model.bed3d.gz')).toBe(true)
  })

  it('takes each bead\'s end from the file and reports the commonest width', () => {
    const set = parseBed3d(BED3D)
    expect(set.length).toBe(12)
    expect(set.model?.width).toBe(5000)
    expect(set.start[0]).toBe(0)
    expect(set.end[0]).toBe(5000)
    // A bead of another width keeps its own.
    const mixed = parseBed3d(BED3D + '\nchr2\t10000\t12000\t14.0\t-2.0\t0.5')
    const last = mixed.length - 1
    expect(mixed.end[last] - mixed.start[last]).toBe(2000)
    expect(mixed.model?.width).toBe(5000)
    expect(g3dSummary(mixed)).toContain('5 kb')
  })

  it('reads a seventh column as the haplotype, as a g3d reads its sixth', () => {
    const phased = [
      'chr1\t0\t5000\t0.1\t0.2\t0.3\tm',
      'chr1\t0\t5000\t1.1\t1.2\t1.3\tp',
      'chr1\t5000\t10000\t0.4\t0.5\t0.6\tm',
      'chr1\t5000\t10000\t1.4\t1.5\t1.6\tp',
    ].join('\n')
    expect(sniffBed3d(phased)).toBe(true)
    const set = parseBed3d(phased)
    expect(set.model?.haplotypes).toEqual(['maternal', 'paternal'])
    expect(fieldLevels(set, G3D_FIELD_HAPLOTYPE)).toEqual(['maternal', 'paternal'])
  })

  it('is a structure by name, with its gzipped and URL forms', () => {
    expect(isStructureName('model.bed3d')).toBe(true)
    expect(isStructureName('https://x.org/dir/model.bed3d.gz?token=1')).toBe(true)
    expect(isStructureName('model.g3d')).toBe(true)
    expect(isStructureName('model.3dg.txt.gz')).toBe(true)
    expect(isStructureName('model.bed')).toBe(false)
    expect(isStructureName('model.bed3d.bw')).toBe(false)
    expect(cardFor('structure')).toBe('structure')
    expect(kindFor('structure', 'structure')).toBe('structure')
  })

  it('cannot capture the sniffers asked before it', () => {
    expect(sniffBarChart(BED3D)).toBe(false)
    expect(sniffSignal(BED3D)).toBe(null)
    expect(sniffVcf(BED3D)).toBe(false)
  })
})

describe('a structure written out (§25.7)', () => {
  it('writes a bed3d that reads straight back, beads and places alike', () => {
    const beads = [
      { contig: 'chrII', start: 0, end: 5000, x: 0.5, y: -1.25, z: 2 },
      { contig: 'chrI', start: 5000, end: 10000, x: 1, y: 2, z: 3.000000049 },
      { contig: 'chrI', start: 0, end: 5000, x: -0.1234567, y: 0, z: 0 },
    ]
    const set = structureFromBeads(beads, 5000)
    expect(set.length).toBe(3)
    expect(set.contigs).toEqual(['chrII', 'chrI'])
    expect(set.model?.width).toBe(5000)
    expect(set.model?.haplotypes).toEqual(['shared'])
    const text = writeBed3d(set, { label: '3D model · chrI', file: 'chrI at 5 kb' })
    const lines = text.trimEnd().split('\n')
    expect(lines[0]).toMatch(/^# metacooler 3D model · chrI from chrI at 5 kb · bed3d: chrom start end x y z$/)
    expect(lines).toHaveLength(4)
    expect(lines.slice(1)).toEqual([
      'chrII\t0\t5000\t0.5\t-1.25\t2',
      'chrI\t0\t5000\t-0.123457\t0\t0',
      'chrI\t5000\t10000\t1\t2\t3',
    ])
    expect(sniffBed3d(text, 'model.bed3d')).toBe(true)
    const back = parseBed3d(text, 'model.bed3d')
    expect(back.length).toBe(3)
    expect(Array.from(back.start)).toEqual(Array.from(set.start))
    expect(Array.from(back.end)).toEqual(Array.from(set.end))
    expect(back.model?.width).toBe(5000)
    expect(back.model?.x[1]).toBeCloseTo(-0.123457, 6)
    expect(back.model?.y[0]).toBeCloseTo(-1.25, 9)
  })

  it('writes the haplotype column for a phased model only', () => {
    const phased = parseG3d('chr1 0 0 0 0 m\nchr1 0 1 1 1 p\nchr1 1000 2 2 2 m\nchr1 1000 3 3 3 p')
    const text = writeBed3d(phased)
    expect(text.split('\n')[0]).toMatch(/haplotype$/)
    expect(text.split('\n')[1]).toBe('chr1\t0\t1000\t0\t0\t0\tmaternal')
    expect(parseBed3d(text).model?.haplotypes).toEqual(['maternal', 'paternal'])
    const plain = parseG3d('chr1 0 0 0 0\nchr1 1000 1 1 1')
    expect(writeBed3d(plain).split('\n')[1].split('\t')).toHaveLength(6)
  })
})
