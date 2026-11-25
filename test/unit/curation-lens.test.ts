// @dev-feature curate
// @fixtures metacooler
/**
 * The session through a curated binning (SPECS §33.4), held to the reference
 * implementation: a map drawn through a curation is the map `metacooler
 * reassign --layout genome-then-length` writes from the curation's contig →
 * genome table. `npm run fixtures` writes that table for a curation of
 * `basic.metacool` — contigs moved, one recruited from the pool, a genome
 * merged into another and one dissolved, a MAG and an element created, a genome
 * renamed to sort first — and runs `reassign` over it (`curated.metacool`);
 * this suite applies the same steps through `MetaCooler.withCuration` and
 * compares the two maps: the contigs, their genomes, both offset indexes, the
 * genomes' counts, the bins, and every pixel, dense, genome by genome, between
 * genomes and over the whole map.
 */

import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

import type { Hdf5Handle } from '../../src/h5/api'
import { readFileBinning } from '../../src/curate/base'
import { CuratedBinning, emptyCuration, withCurationStep, type Curation, type CurationStep, type FileBinning } from '../../src/genome/curation'
import { MetaCooler } from '../../src/metacooler/MetaCooler'
import type { DenseMatrix } from '../../src/types'
import { fixturePath, openHandle } from './_golden'

/** The curation `scripts/make_fixtures.py` writes `curated_contigs.tsv` for. */
const STEPS: CurationStep[] = [
  { op: 'move', contigs: ['contig_1_012'], to: 'MAG_02' },
  { op: 'move', contigs: ['contig_1_013'], to: 'MAG_03' },
  { op: 'merge', into: 'MAG_09', genomes: ['MAG_10'] },
  { op: 'dissolve', genome: 'MAG_04' },
  { op: 'move', contigs: ['contig_1_035'], to: 'MAG_05' },
  { op: 'create', id: 'curated-1', name: 'basic_curated_001', kind: 'mag', contigs: ['contig_1_010', 'contig_1_039'] },
  { op: 'rename', genome: 'MAG_02', name: 'Acinetobacter_X' },
  { op: 'create', id: 'element-1', name: 'basic_element_001', kind: 'element', contigs: ['contig_1_016'] },
]

function curationOf(file: FileBinning, steps: readonly CurationStep[]): Curation {
  return steps.reduce((held: Curation, step, i) => withCurationStep(held, step, 'reader', i), emptyCuration(file))
}

async function open(name: string, wrap?: (handle: Hdf5Handle) => Hdf5Handle): Promise<MetaCooler> {
  const handle = await openHandle(name)
  return MetaCooler.fromHandle(wrap === undefined ? handle : wrap(handle))
}

/** Every cell of a block as a plain array, for one comparison. */
function cells(m: DenseMatrix): number[] {
  return Array.from(m.values)
}

/** `basic.metacool` through the fixture's curation, and `reassign`'s file of it. */
async function curatedPair(): Promise<{ base: MetaCooler; map: MetaCooler; oracle: MetaCooler; curation: Curation }> {
  const base = await open('basic.metacool')
  const read = readFileBinning(base)
  const curation = curationOf(read.file, STEPS)
  const { map, refusal } = MetaCooler.withCuration(base, curation, read)
  expect(refusal).toBeNull()
  return { base, map, oracle: await open('curated.metacool'), curation }
}

describe('a map drawn through a curation is the map metacooler reassign writes', () => {
  it('folds the steps to the table the fixture was reassigned from', async () => {
    const base = await open('basic.metacool')
    try {
      const read = readFileBinning(base)
      const binning = CuratedBinning.of(read.base, curationOf(read.file, STEPS))
      const table = readFileSync(fixturePath('curated_contigs.tsv'), 'utf8')
        .trim()
        .split('\n')
        .slice(1)
        .map((line) => line.split('\t'))
      const folded = new Map(read.base.names.map((name, c) => [name, binning.genomeOf[c] < 0 ? '__unbinned__' : binning.genomes[binning.genomeOf[c]].name]))
      expect(table.length).toBe(read.base.names.length)
      for (const [contig, genome] of table) expect([contig, folded.get(contig)]).toEqual([contig, genome])
    } finally {
      base.close()
    }
  })

  it('has its contigs, their genomes, both offset indexes and the genomes’ counts', async () => {
    const { map, oracle } = await curatedPair()
    try {
      expect(map.chromnames).toEqual(oracle.chromnames)
      expect(map.genomeNames).toEqual(oracle.genomeNames)
      expect(Array.from(map.contigGenomeIds)).toEqual(Array.from(oracle.contigGenomeIds))
      expect(Array.from(map.coords.chromOffset)).toEqual(Array.from(oracle.coords.chromOffset))
      expect(Array.from(map.handle.readNumeric('indexes/chrom_offset'))).toEqual(Array.from(oracle.handle.readNumeric('indexes/chrom_offset')))
      expect(Array.from(map.handle.readNumeric('indexes/genome_offset'))).toEqual(Array.from(oracle.handle.readNumeric('indexes/genome_offset')))
      for (const column of ['length', 'n_contigs', 'n_bins']) {
        expect([column, map.genomes!.numbers(column)]).toEqual([column, oracle.genomes!.numbers(column)])
      }
      expect(map.contigs.numbers('length')).toEqual(oracle.contigs.numbers('length'))
      expect(map.nBins).toBe(oracle.nBins)
      expect(map.nnz).toBe(oracle.nnz)
      expect(map.info.ngenomes).toBe(oracle.info.ngenomes)
      // §7.4: the pool first, and drawn nowhere.
      expect(map.displayBinExtent()).toEqual(oracle.displayBinExtent())
      expect(map.unassignedStats()).toEqual(oracle.unassignedStats())
    } finally {
      map.close()
      oracle.close()
    }
  })

  it('carries the bins with their contigs, as reassign remaps them', async () => {
    const { map, oracle } = await curatedPair()
    try {
      for (const column of ['chrom', 'start', 'end']) {
        expect([column, Array.from(map.handle.readNumeric(`bins/${column}`))]).toEqual([column, Array.from(oracle.handle.readNumeric(`bins/${column}`))])
      }
      // Each contig's own intra-contig tallies, carried by both.
      const ours = map.fullContigs()
      const theirs = oracle.fullContigs()
      for (const column of ['qc_intra_contig_short', 'qc_intra_contig_long']) {
        expect([column, ours.numbers(column)]).toEqual([column, theirs.numbers(column)])
      }
    } finally {
      map.close()
      oracle.close()
    }
  })

  it('holds every pixel where reassign put it: each genome, between genomes, and the whole map', async () => {
    const { map, oracle } = await curatedPair()
    try {
      for (const name of oracle.genomeNames) {
        expect([name, cells(await map.genomeMatrix(name))]).toEqual([name, cells(await oracle.genomeMatrix(name))])
      }
      const pairs: Array<[string, string]> = [
        ['Acinetobacter_X', 'MAG_09'],
        ['MAG_01', 'basic_curated_001'],
        ['__unbinned__', 'MAG_03'],
        ['basic_element_001', 'Acinetobacter_X'],
        ['MAG_08', 'MAG_03'],
      ]
      for (const [a, b] of pairs) {
        expect([a, b, cells(await map.genomePairMatrix(a, b))]).toEqual([a, b, cells(await oracle.genomePairMatrix(a, b))])
      }
      const whole = await map.matrix({ rows: [0, map.nBins] })
      expect(cells(whole)).toEqual(cells(await oracle.matrix({ rows: [0, oracle.nBins] })))
      // And at genome level, rolled up without a dense block.
      const rolled = await map.aggregateSparse({ rows: [0, map.nBins] }, 'genome')
      const expected = await oracle.aggregateSparse({ rows: [0, oracle.nBins] }, 'genome')
      expect(Array.from(rolled.values)).toEqual(Array.from(expected.values))
    } finally {
      map.close()
      oracle.close()
    }
  })

  it('walks the same pixels as the file stores them, each once', async () => {
    const { map, oracle } = await curatedPair()
    try {
      const tally = async (mc: MetaCooler): Promise<{ pixels: number; sum: number; upper: boolean }> => {
        let pixels = 0
        let sum = 0
        let upper = true
        await mc.scanPixels({
          onChunk: (chunk) => {
            for (let i = 0; i < chunk.length; i++) {
              pixels++
              sum += chunk.count[i]
              if (chunk.bin1[i] > chunk.bin2[i]) upper = false
            }
          },
        })
        return { pixels, sum, upper }
      }
      expect(await tally(map)).toEqual(await tally(oracle))
    } finally {
      map.close()
      oracle.close()
    }
  })
})

describe('the curated map’s tables', () => {
  it('carries every contig column with its contig, genome_id the curated map’s', async () => {
    const base = await open('metadata.metacool')
    try {
      const read = readFileBinning(base)
      const curation = curationOf(read.file, [{ op: 'move', contigs: ['contig_1_012'], to: 'MAG_02' }])
      const { map, refusal } = MetaCooler.withCuration(base, curation, read)
      expect(refusal).toBeNull()
      const file = base.fullContigs()
      const ours = map.fullContigs()
      expect(ours.columns).toEqual(file.columns)
      const row = new Map(file.strings('name').map((name, r) => [name, r]))
      for (const column of file.columns) {
        if (column === 'genome_id') continue
        for (let l = 0; l < ours.length; l++) {
          const r = row.get(String(ours.get('name', l)))!
          expect([column, l, ours.get(column, l)]).toEqual([column, l, file.get(column, r)])
        }
      }
      for (let l = 0; l < ours.length; l++) expect(map.genomeNames[Number(ours.get('genome_id', l))]).toBe(map.genomeNames[map.contigGenomeIds[l]])
      // A slice and a narrowing, as an open asks for them.
      const slice = map.handle.readTable('contigs', 3, 7, ['name', 'genome_id'])
      expect(slice.columns).toEqual(['name', 'genome_id'])
      expect(slice.strings('name')).toEqual(map.chromnames.slice(3, 7))
      expect(map.handle.readStrings('chroms/name', 3, 7)).toEqual(map.chromnames.slice(3, 7))
      map.close()
    } finally {
      base.close()
    }
  })

  it('keeps a genome’s file columns only where its contigs are the file’s, and drops the tallies', async () => {
    const base = await open('metadata.metacool')
    try {
      const read = readFileBinning(base)
      const curation = curationOf(read.file, [
        { op: 'move', contigs: ['contig_1_012'], to: 'MAG_02' },
        { op: 'rename', genome: 'MAG_06', name: 'Renamed_06' },
        { op: 'create', id: 'n1', name: 'fresh_genome', kind: 'mag', contigs: ['contig_1_010'] },
      ])
      const { map } = MetaCooler.withCuration(base, curation, read)
      const file = base.fullGenomes()!
      const table = map.fullGenomes()!
      const at = (name: string): number => table.strings('name').indexOf(name)
      const fileAt = (name: string): number => file.strings('name').indexOf(name)
      expect(table.columns.slice(0, 6)).toEqual(['name', 'length', 'n_contigs', 'n_bins', 'kind', 'curation'])
      expect(table.columns.some((column) => column.startsWith('qc_'))).toBe(false)
      const extras = file.columns.filter((column) => !['name', 'length', 'n_contigs', 'n_bins'].includes(column) && !column.startsWith('qc_'))
      expect(extras.length).toBeGreaterThan(0)
      for (const column of extras) {
        // Renamed, its contigs as they were: the file's values.
        expect([column, table.get(column, at('Renamed_06'))]).toEqual([column, file.get(column, fileAt('MAG_06'))])
        // Changed and new: nothing the file measured on other contigs.
        for (const name of ['MAG_01', 'MAG_02', 'fresh_genome']) {
          const value = table.get(column, at(name))
          expect([column, name, value === '' || Number.isNaN(value)]).toEqual([column, name, true])
        }
      }
      expect(table.get('curation', at('Renamed_06'))).toBe('as in the file')
      expect(table.get('curation', at('MAG_02'))).toBe('changed')
      expect(table.get('curation', at('fresh_genome'))).toBe('new')
      expect(table.get('kind', at('MAG_02'))).toBe('MAG')
      expect(map.curation?.owned).toEqual(['kind', 'curation'])
      expect(map.curation?.steps).toBe(3)
      map.close()
    } finally {
      base.close()
    }
  })

  it('recomputes miComplete’s numbers from the contigs’ markers, equal to the file’s where nothing changed', async () => {
    // Markers metaTOR would store: a set of four, every contig of MAG_03 one
    // marker each, so moving a contig in changes its numbers.
    const set = { markers: ['m1', 'm2', 'm3', 'm4'], weights: [0.25, 0.25, 0.25, 0.25] }
    const markersOf = (name: string): string => ({ contig_1_029: 'm1', contig_1_019: 'm2', contig_1_027: 'm3', contig_1_013: 'm3' })[name] ?? ''
    const withMarkers = (handle: Hdf5Handle): Hdf5Handle =>
      new Proxy(handle, {
        get(target, property) {
          if (property === 'attrs') {
            return () => {
              const attrs = target.attrs()
              const metadata = JSON.parse(String(attrs['metadata'] ?? '{}')) as Record<string, unknown>
              return { ...attrs, metadata: JSON.stringify({ ...metadata, metator: { markers: { sets: { Test: set } } } }) }
            }
          }
          if (property === 'readTable') {
            return (path: string, lo?: number, hi?: number, columns?: readonly string[]) => {
              const table = target.readTable(path, lo, hi, columns)
              if (path !== 'contigs' || columns !== undefined) return table
              const markers = table.strings('name').map(markersOf)
              return { ...table, columns: [...table.columns, 'markers_Test'], data: { ...table.data, markers_Test: markers }, strings: (c: string) => (c === 'markers_Test' ? markers : table.strings(c)) }
            }
          }
          const value: unknown = Reflect.get(target, property, target)
          return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(target) : value
        },
      })
    const base = await open('basic.metacool', withMarkers)
    try {
      const read = readFileBinning(base)
      expect(read.markers.length).toBe(1)
      const curation = curationOf(read.file, [{ op: 'move', contigs: ['contig_1_013'], to: 'MAG_03' }])
      const { map } = MetaCooler.withCuration(base, curation, read)
      const table = map.fullGenomes()!
      const at = (name: string): number => table.strings('name').indexOf(name)
      expect(map.curation?.recomputed).toEqual(['Completeness', 'Redundancy', 'Weighted completeness', 'Weighted redundancy'])
      // MAG_03: m1, m2, m3 twice — three of four present, four hits.
      expect(table.get('Completeness', at('MAG_03'))).toBe(0.75)
      expect(table.get('Redundancy', at('MAG_03'))).toBeCloseTo(4 / 3, 4)
      expect(table.get('Weighted completeness', at('MAG_03'))).toBe(0.75)
      expect(table.get('Weighted redundancy', at('MAG_03'))).toBeCloseTo((0.25 + 0.75) / 0.75, 4)
      // A MAG with no marker: nought, as miComplete writes it; the pool: nothing.
      expect(table.get('Completeness', at('MAG_06'))).toBe(0)
      expect(Number.isNaN(table.get('Completeness', at('__unbinned__')))).toBe(true)
      map.close()
    } finally {
      base.close()
    }
  })
})

describe('what the curated map refuses and passes through', () => {
  it('refuses a curation made on another binning, naming what differs', async () => {
    const base = await open('basic.metacool')
    try {
      const read = readFileBinning(base)
      const other: FileBinning = { ...read.file, genomes: read.file.genomes.map((genome, g) => (g === 2 ? { ...genome, contigs: genome.contigs + 1 } : genome)) }
      const { map, refusal } = MetaCooler.withCuration(base, curationOf(other, STEPS), read)
      expect(map).toBe(base)
      expect(refusal).toMatch(/^The curation was made on another binning: MAG_03 held 6 contigs when the curation was made and holds 5 here\.$/)
    } finally {
      base.close()
    }
  })

  it('is the map itself where no step is applied', async () => {
    const base = await open('basic.metacool')
    try {
      const read = readFileBinning(base)
      const undone = { ...curationOf(read.file, STEPS), cursor: 0 }
      expect(MetaCooler.withCuration(base, undone, read)).toEqual({ map: base, refusal: null })
    } finally {
      base.close()
    }
  })

  it('refuses a map with no genomes', async () => {
    const plain = await open('plain.cool')
    try {
      const file: FileBinning = { contigs: 0, names: '', assignment: '', genomes: [] }
      const { map, refusal } = MetaCooler.withCuration(plain, curationOf(file, STEPS))
      expect(map).toBe(plain)
      expect(refusal).toBe('A curation is drawn on a map with genomes, and this one has none.')
    } finally {
      plain.close()
    }
  })

  it('hides a weight that depends on the assignment, and keeps one that does not', async () => {
    const weights: Record<string, string[]> = { by_genome: ['pixels', 'genome_id'], by_contig: ['pixels', 'contigs/Hit'] }
    const withWeights = (handle: Hdf5Handle): Hdf5Handle =>
      new Proxy(handle, {
        get(target, property) {
          if (property === 'keys') return (path: string) => (path === 'bins' ? [...target.keys(path), ...Object.keys(weights)] : target.keys(path))
          if (property === 'has') return (path: string) => Object.keys(weights).some((name) => path === `bins/${name}`) || target.has(path)
          if (property === 'attrsAt') return (path: string) => (path.startsWith('bins/') && weights[path.slice(5)] !== undefined ? { depends_on: weights[path.slice(5)] } : target.attrsAt(path))
          if (property === 'dtype') return (path: string) => (path.startsWith('bins/') && weights[path.slice(5)] !== undefined ? '<d' : target.dtype(path))
          const value: unknown = Reflect.get(target, property, target)
          return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(target) : value
        },
      })
    const base = await open('basic.metacool', withWeights)
    try {
      const read = readFileBinning(base)
      const { map } = MetaCooler.withCuration(base, curationOf(read.file, STEPS), read)
      expect(map.handle.keys('bins')).toEqual(['chrom', 'end', 'start', 'by_contig'])
      expect(map.handle.has('bins/by_genome')).toBe(false)
      expect(map.handle.has('bins/by_contig')).toBe(true)
      expect(map.binColumns().map((column) => column.name)).not.toContain('by_genome')
      map.close()
    } finally {
      base.close()
    }
  })

  it('draws a total beneath the lens, and carries every pixel of the draw', async () => {
    const { base, map, oracle } = await curatedPair()
    oracle.close()
    try {
      const total = Number(base.info.sum)
      const plan = await map.resample({ contacts: Math.floor(total / 2), seed: 7 })
      expect(plan?.mode).not.toBe('none')
      // The draw is the file's: the same map underneath, at the same total.
      const drawn = await base.matrix({ rows: [0, base.nBins] })
      const seen = await map.matrix({ rows: [0, map.nBins] })
      const order = new Int32Array(map.nBins)
      for (let c = 0; c < map.nContigs; c++) {
        const [lo, hi] = map.coords.contigBinExtent(c)
        const [from] = base.coords.contigBinExtent(base.contigId(map.chromnames[c]))
        for (let k = 0; k < hi - lo; k++) order[lo + k] = from + k
      }
      const n = map.nBins
      const mismatches: string[] = []
      for (let i = 0; i < n && mismatches.length < 5; i++) {
        for (let j = 0; j < n; j++) {
          const want = drawn.values[order[i] * n + order[j]]
          if (seen.values[i * n + j] !== want) mismatches.push(`[${i}][${j}] ${seen.values[i * n + j]} != ${want}`)
        }
      }
      expect(mismatches).toEqual([])
      let sum = 0
      await map.scanPixels({ onChunk: (chunk) => { for (let i = 0; i < chunk.length; i++) sum += chunk.count[i] } })
      expect(sum).toBe(Math.floor(total / 2))
      expect(await map.takenCensus()).not.toBeNull()
    } finally {
      map.close()
    }
  })
})

describe('the /bins guard over a curated open', () => {
  it('reads no bin to open it, to draw a genome, a pair or the whole map, or to walk every pixel', async () => {
    const reads: string[] = []
    const guard = (handle: Hdf5Handle): Hdf5Handle =>
      new Proxy(handle, {
        get(target, property) {
          const value: unknown = Reflect.get(target, property, target)
          if (typeof value !== 'function') return value
          return (...args: unknown[]) => {
            const path = String(args[0] ?? '').replace(/^\/+/, '')
            if (property !== 'has' && (path === 'bins' || path.startsWith('bins/'))) reads.push(`${String(property)}(${path})`)
            return (value as (...a: unknown[]) => unknown).apply(target, args)
          }
        },
      })
    const base = await open('basic.metacool', guard)
    try {
      const read = readFileBinning(base)
      const { map } = MetaCooler.withCuration(base, curationOf(read.file, STEPS), read)
      await map.genomeMatrix('MAG_03')
      await map.genomePairMatrix('Acinetobacter_X', 'MAG_09')
      await map.matrix({ rows: map.displayBinExtent() })
      await map.scanPixels({ onChunk: () => undefined })
      map.fullGenomes()
      map.fullContigs()
      void map.hasWeights
      expect(reads).toEqual([])
      map.close()
    } finally {
      base.close()
    }
  })
})
