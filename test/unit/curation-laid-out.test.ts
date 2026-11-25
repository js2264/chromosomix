// @dev-feature curate
/**
 * The curated map with a genome laid out by its edit of the reference (SPECS
 * §27.10, §33.4), on the demo's mock community MM133: the genome's sequences
 * in its place — named, measured and binned as the edit draws them, its pixels
 * the very ones the genome's own map through that edit shows — every other
 * genome as the curated map draws it without the layout, and the tables, the
 * bins and the pixels of the whole map as a map's must be.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { readFileBinning, type FileBinningRead } from '../../src/curate/base'
import { drawnLayouts, membersInOrder } from '../../src/curate/layouts'
import { CuratedBinning, emptyCuration, withCurationStep, type Curation } from '../../src/genome/curation'
import { EditedAssembly, emptyEdit, withStep, type EditStep, type ReferenceEdit } from '../../src/genome/edit'
import { MetaCooler } from '../../src/metacooler/MetaCooler'
import { LocalFileSource } from '../../src/sources/LocalFileSource'
import type { DenseMatrix } from '../../src/types'

const MAP = new URL('../../demo/metagenomics/mock-community/MM133.metacool', import.meta.url).pathname

let mc: MetaCooler
let read: FileBinningRead
/** A MAG of three contigs or more, and its edit: its two longest joined, its third turned. */
let genome: string
let edit: ReferenceEdit
/** Another MAG, renamed, so that the curation is one and the layout is not alone in it. */
let renamed: string
let curation: Curation

function cells(m: DenseMatrix): number[] {
  return Array.from(m.values)
}

/** The map's own index of genomes, as a reader asks it. */
function genomeOffsetOf(map: MetaCooler): Float64Array {
  return map.handle.readNumeric('indexes/genome_offset')
}

beforeAll(async () => {
  mc = await MetaCooler.open(MAP, await LocalFileSource.open(MAP))
  read = readFileBinning(mc)
  const binning = CuratedBinning.of(read.base, null)
  // The smallest, so that a dense block of it is read in a moment.
  const size = (contigs: readonly number[]): number => contigs.reduce((sum, c) => sum + read.base.lengths[c], 0)
  const mags = binning.genomes
    .map((g, index) => ({ g, index }))
    .filter(({ g }) => g.kind === 'mag' && g.contigs.length >= 3)
    .sort((x, y) => size(x.g.contigs) - size(y.g.contigs))
  genome = mags[0].g.id
  renamed = mags[1].g.id
  const members = membersInOrder(binning, mags[0].index, read.base.names, read.base.lengths)
  const [a, b, c] = members.names
  const steps: EditStep[] = [
    { op: 'join', a, aEnd: 'end', b, bEnd: 'start', gap: 100 },
    { op: 'invert', sequence: c, from: 0, to: members.lengths[2] },
  ]
  edit = steps.reduce((held, step, i) => withStep(held, step, 'reader', i), emptyEdit({ ...members, genome }))
  curation = withCurationStep(emptyCuration(read.file), { op: 'rename', genome: renamed, name: `${renamed}_renamed` }, 'reader', 0)
}, 120_000)

afterAll(() => mc?.close())

describe('a genome laid out by its edit, in the curated map', () => {
  it('is drawn where the curated map draws the genome, as its sequences', () => {
    const { map, refusal } = MetaCooler.withCuration(mc, curation, read, new Map([[genome, edit]]))
    expect(refusal).toBeNull()
    expect(map.curation?.laidOut).toBe(1)
    const g = map.genomeNames.indexOf(genome)
    const rows = map.chromnames.slice(genomeOffsetOf(map)[g], genomeOffsetOf(map)[g + 1])
    const assembly = EditedAssembly.of(edit)
    expect(rows).toEqual(assembly.sequences.map((sequence) => sequence.name))
    const genomes = map.fullGenomes()!
    const row = genomes.strings('name').indexOf(genome)
    expect(genomes.get('curation', row)).toBe('laid out')
    expect(genomes.get('n_contigs', row)).toBe(assembly.sequences.length)
    expect(genomes.get('length', row)).toBe(assembly.contigs().reduce((sum, sequence) => sum + sequence.length, 0))
    expect(genomes.get('curation', genomes.strings('name').indexOf(`${renamed}_renamed`))).toBe('as in the file')
    // The map's own index of genomes brackets every row.
    expect(genomeOffsetOf(map)[map.genomeNames.length]).toBe(map.nContigs)
    expect(map.coords.chromOffset[map.nContigs]).toBe(map.nBins)

  })

  it('shows the pixels the genome’s own map through its edit shows', async () => {
    const { map } = MetaCooler.withCuration(mc, curation, read, new Map([[genome, edit]]))
    const own = MetaCooler.withLens(mc, edit)
    expect(own.refusal).toBeNull()
    expect(cells(await map.genomeMatrix(genome))).toEqual(cells(await own.map.matrix({ rows: [0, own.map.nBins] })))

  })

  it('leaves every other genome as the curated map draws it without the layout', async () => {
    const { map } = MetaCooler.withCuration(mc, curation, read, new Map([[genome, edit]]))
    const plain = MetaCooler.withCuration(mc, curation, read).map
    expect(plain.curation?.laidOut).toBe(0)
    const binsOf = (name: string): number => {
      const g = plain.genomeNames.indexOf(name)
      return plain.coords.chromOffset[genomeOffsetOf(plain)[g + 1]] - plain.coords.chromOffset[genomeOffsetOf(plain)[g]]
    }
    const others = plain.genomeNames
      .filter((name) => name !== genome && name !== '__unbinned__')
      .sort((a, b) => binsOf(a) - binsOf(b))
      .slice(0, 3)
    for (const name of others) expect([name, cells(await map.genomeMatrix(name))]).toEqual([name, cells(await plain.genomeMatrix(name))])
    expect(cells(await map.genomePairMatrix(others[0], others[1]))).toEqual(cells(await plain.genomePairMatrix(others[0], others[1])))


  })

  it('counts every bin of a sequence in it, and says what each is made of', () => {
    const { map } = MetaCooler.withCuration(mc, curation, read, new Map([[genome, edit]]))
    const g = map.genomeNames.indexOf(genome)
    const first = genomeOffsetOf(map)[g]
    const chrom = map.handle.readNumeric('bins/chrom')
    const start = map.handle.readNumeric('bins/start')
    const end = map.handle.readNumeric('bins/end')
    expect(chrom.length).toBe(map.nBins)
    for (let r = first; r < genomeOffsetOf(map)[g + 1]; r++) {
      for (let e = map.coords.chromOffset[r]; e < map.coords.chromOffset[r + 1]; e++) {
        expect([e, chrom[e], start[e]]).toEqual([e, r, (e - map.coords.chromOffset[r]) * map.binsize])
      }
      expect(end[map.coords.chromOffset[r + 1] - 1]).toBe(map.coords.contigLengths[r])
    }
    const contigs = map.fullContigs()
    expect(contigs.columns).toContain('parts')
    const joined = contigs.get('parts', first)
    expect(String(joined)).toMatch(/\+ N100 .*\+$/)
    // A sequence made of two contigs is neither's: their columns are left empty.
    const gc = contigs.columns.find((column) => column !== 'name' && column !== 'length' && column !== 'genome_id' && column !== 'parts' && typeof contigs.get(column, first + 2) === 'number')
    if (gc !== undefined) expect(Number.isNaN(Number(contigs.get(gc, first)))).toBe(true)

  })

  it('walks every pixel in the upper triangle', async () => {
    const { map } = MetaCooler.withCuration(mc, null, read, new Map([[genome, edit]]))
    let upper = true
    let pixels = 0
    await map.scanPixels({
      onChunk: (chunk) => {
        for (let i = 0; i < chunk.length; i++) if (chunk.bin1[i] > chunk.bin2[i]) upper = false
        pixels += chunk.length
      },
    })
    expect(upper).toBe(true)
    expect(pixels).toBeGreaterThan(0)

  })

  it('is drawn with no curation at all, and is the file where nothing is laid out', () => {
    const laid = MetaCooler.withCuration(mc, null, read, new Map([[genome, edit]]))
    expect(laid.refusal).toBeNull()
    expect(laid.map).not.toBe(mc)
    expect(laid.map.curation?.steps).toBe(0)

    expect(MetaCooler.withCuration(mc, null, read, new Map()).map).toBe(mc)
    expect(MetaCooler.withCuration(mc, null, read, new Map([[genome, { ...edit, cursor: 0 }]])).map).toBe(mc)
  })

  it('keys the map by what is drawn', () => {
    const binning = CuratedBinning.of(read.base, curation)
    const layouts = drawnLayouts({ binning, names: read.base.names, lengths: read.base.lengths, edits: new Map([[genome, edit]]) })
    const plain = MetaCooler.withCuration(mc, curation, read).map
    const laid = MetaCooler.withCuration(mc, curation, read, new Map([[genome, edit]])).map
    expect(layouts.length).toBe(1)
    expect(laid.curation?.key).not.toBe(plain.curation?.key)
    expect(laid.curation?.key.startsWith(plain.curation?.key ?? '-')).toBe(true)
  })

  it('is balanced by the weight column chosen on the file, as an edit of the reference is (§6.4)', () => {
    // MM133 carries metaTOR's column alone, and opens on its counts.
    expect(MetaCooler.withCuration(mc, curation, read, new Map([[genome, edit]])).map.hasWeights).toBe(false)
    mc.selectWeight('metator_empirical_hit')
    try {
      const stored = mc.handle.readNumeric('bins/weight')
      for (const drawn of [MetaCooler.withCuration(mc, curation, read).map, MetaCooler.withCuration(mc, curation, read, new Map([[genome, edit]])).map]) {
        expect(drawn.hasWeights).toBe(true)
        // Each bin's weight is the stored bin's it shows.
        const weights = drawn.handle.readNumeric('bins/weight')
        const lensed = (drawn.store as unknown as { lens: { toOriginal: Int32Array } }).lens
        for (let e = 0; e < weights.length; e += 997) {
          const bin = lensed.toOriginal[e]
          expect([e, weights[e]]).toEqual([e, bin >= 0 ? stored[bin] : Number.NaN])
        }
      }
    } finally {
      mc.selectWeight(null)
    }
  })
})
