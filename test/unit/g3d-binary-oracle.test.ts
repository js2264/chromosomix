/**
 * The binary g3d reader against `g3djs`, bead for bead (§25).
 *
 * Every other test of a structure compares this repository to itself: the
 * text reader against a table typed into the test, the builder against the
 * rows it was handed. Both are worth having and neither is this: a shared
 * misunderstanding of where a block starts or which axis is which round-trips
 * perfectly and draws a model that is wrong. So the oracle is the package
 * WashU's own browser reads with, `g3djs`, held over a file `g3dtools` wrote
 * (`scripts/make_g3d_fixtures.py`), and the in-house reader must land on the
 * same chromosome set, the same starts and the same coordinates at every
 * resolution the file has.
 *
 * `g3djs` is given the fixture's bytes through the one seam it has — its
 * `file.read(position, length)` — in place of the HTTPS range request it would
 * otherwise make, which keeps its decoding and its interpretation and removes
 * its network. Its `readData` returns the raw decoded map, so the comparison
 * is between the beads it saw and the beads the `FeatureSet` holds.
 *
 * **Coordinates are compared exactly, after `Math.fround`.** The set stores
 * them as `Float32Array`, so "equal to six decimals" is not a bar a coordinate
 * of `110.0` can meet — a float32 there is only good to about four millionths
 * — while equality with the oracle's float64 rounded to float32 is a stronger
 * claim than any decimal count, and the one the storage actually makes.
 *
 * **Skipped, loudly, when the fixture is absent.** It needs `g3dtools`, which a
 * fresh clone and a CI runner do not have — the same arrangement
 * `test:nofixtures` already makes for every other golden. The two claims that
 * need no fixture — that this runtime has `DecompressionStream`, and that a
 * version-1 header is refused by name — run regardless.
 */

import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'

import { describe, expect, it } from 'vitest'

import { parseG3d } from '@/annotations/g3d'
import {
  G3D_HEADER_LENGTH,
  g3dBinaryNote,
  isG3dBinary,
  readG3dHeader,
  readG3dModel,
  type ReadRange,
} from '@/annotations/g3dBinary'
import type { FeatureSet } from '@/annotations/types'

const DIR = new URL('../fixtures/structure/', import.meta.url).pathname
const TOY = `${DIR}toy.g3d`
const TOY_TEXT = `${DIR}toy.g3d.txt`
const PLAIN = `${DIR}plain.g3d`
const PLAIN_TEXT = `${DIR}plain.g3d.txt`
const MANIFEST = `${DIR}g3d-manifest.json`

/** What `readData` hands back: the block as `@msgpack/msgpack` decodes it, maps as objects. */
type OracleBlock = Record<string, Record<string, { start: number[]; x: number[]; y: number[]; z: number[] }>>

interface Oracle {
  file: { read: (position: number, length: number) => Promise<Uint8Array> }
  readHeader(): Promise<void>
  readData(resolution: number): Promise<OracleBlock | null>
  meta: {
    magic: string
    version: number
    genome: string
    name: string
    resolutions: number[]
    offsets: Record<string, { offset: number; size: number }>
  } | null
}

interface Manifest {
  toy: { beads: Record<string, Record<string, Record<string, number>>> }
  plain: { beads: Record<string, Record<string, Record<string, number>>> }
}

/** A `ReadRange` over a file's bytes, clamped to its end the way a real source is. */
function rangeOver(bytes: Buffer): ReadRange {
  return async (length, position) => {
    const end = Math.min(bytes.length, position + length)
    return new Uint8Array(bytes.buffer, bytes.byteOffset + position, Math.max(0, end - position))
  }
}

/** `g3djs` over the same bytes, its network replaced by a slice. */
function oracleOver(bytes: Buffer): Oracle {
  const require = createRequire(import.meta.url)
  const G3dFile = require('g3djs') as new (config: { url: string }) => Oracle
  const file = new G3dFile({ url: 'https://example.invalid/toy.g3d' })
  file.file = {
    read: async (position, length) => bytes.subarray(position, position + length),
  }
  return file
}

/** The beads of one category on one chromosome, in the set's own order. */
function beadsOf(set: FeatureSet, category: string, chrom: string): number[] {
  const model = set.model
  if (model === undefined) throw new Error('no model')
  const contig = set.contigs.indexOf(chrom)
  const hap = model.haplotypes.indexOf(category)
  const out: number[] = []
  for (let at = set.contigAt[contig]; at < set.contigAt[contig + 1]; at++) {
    if (model.hap[at] === hap) out.push(at)
  }
  return out
}

/** Hold a set to the oracle's block: same chromosomes, same starts, same coordinates. */
function expectSameBeads(set: FeatureSet, block: OracleBlock, resolution: number): void {
  const model = set.model
  if (model === undefined) throw new Error('no model')
  expect(model.width).toBe(resolution)
  expect(model.haplotypes).toEqual(Object.keys(block))
  const chroms = new Set<string>()
  for (const category of Object.keys(block)) {
    for (const chrom of Object.keys(block[category])) chroms.add(chrom)
  }
  expect(new Set(set.contigs)).toEqual(chroms)
  let seen = 0
  for (const [category, chromosomes] of Object.entries(block)) {
    for (const [chrom, columns] of Object.entries(chromosomes)) {
      const rows = beadsOf(set, category, chrom)
      expect(rows.map((at) => set.start[at])).toEqual(columns.start)
      for (let k = 0; k < rows.length; k++) {
        const at = rows[k]
        expect(set.end[at]).toBe(columns.start[k] + resolution)
        expect(model.x[at]).toBe(Math.fround(columns.x[k]))
        expect(model.y[at]).toBe(Math.fround(columns.y[k]))
        expect(model.z[at]).toBe(Math.fround(columns.z[k]))
      }
      seen += rows.length
    }
  }
  expect(seen).toBe(set.length)
}

/**
 * Hold two sets to each other, field for field, as the text and binary readers
 * must agree.
 *
 * Compared chromosome by chromosome and by *name*, because a contig's id is
 * the order a reader first met it in: the text is shuffled and opens on
 * `chr2`, the writer sorted its chromosomes and the block opens on `chr1`, and
 * a set is the same set either way. Within one chromosome both readers sort
 * by start and then haplotype, so the rows line up one to one.
 */
function expectSameSet(a: FeatureSet, b: FeatureSet): void {
  expect(a.length).toBe(b.length)
  expect(new Set(a.contigs)).toEqual(new Set(b.contigs))
  expect(a.model?.haplotypes).toEqual(b.model?.haplotypes)
  expect(a.model?.width).toBe(b.model?.width)
  const rowsOf = (set: FeatureSet, chrom: string): [number, number] => {
    const contig = set.contigs.indexOf(chrom)
    return [set.contigAt[contig], set.contigAt[contig + 1]]
  }
  for (const chrom of a.contigs) {
    const [aFrom, aTo] = rowsOf(a, chrom)
    const [bFrom, bTo] = rowsOf(b, chrom)
    expect(aTo - aFrom).toBe(bTo - bFrom)
    expect(a.start.subarray(aFrom, aTo)).toEqual(b.start.subarray(bFrom, bTo))
    expect(a.end.subarray(aFrom, aTo)).toEqual(b.end.subarray(bFrom, bTo))
    expect(a.detail.slice(aFrom, aTo)).toEqual(b.detail.slice(bFrom, bTo))
    expect(a.model?.hap.subarray(aFrom, aTo)).toEqual(b.model?.hap.subarray(bFrom, bTo))
    // Both readers store the same float64 as a float32, so the bar is equality.
    expect(a.model?.x.subarray(aFrom, aTo)).toEqual(b.model?.x.subarray(bFrom, bTo))
    expect(a.model?.y.subarray(aFrom, aTo)).toEqual(b.model?.y.subarray(bFrom, bTo))
    expect(a.model?.z.subarray(aFrom, aTo)).toEqual(b.model?.z.subarray(bFrom, bTo))
  }
}

describe('what the reader needs of its runtime', () => {
  it('has DecompressionStream, in Node 22 and in vitest’s node environment', () => {
    expect(typeof DecompressionStream).toBe('function')
  })

  it('refuses a version-1 header by name, and says how to rewrite it', async () => {
    // fixmap {magic: 'G3D', version: 1}, zero-padded as a header is
    const head = new Uint8Array(64)
    head.set([0x82, 0xa5, 0x6d, 0x61, 0x67, 0x69, 0x63, 0xa3, 0x47, 0x33, 0x44, 0xa7, 0x76, 0x65, 0x72, 0x73, 0x69, 0x6f, 0x6e, 0x01])
    expect(isG3dBinary(head.subarray(0, 16))).toBe(true)
    await expect(readG3dHeader(rangeOver(Buffer.from(head)), head.length)).rejects.toThrow(
      /version-1 .*g3dtools load/,
    )
  })

  it('is not fooled by a short buffer or a file that merely begins with a map', () => {
    expect(isG3dBinary(new Uint8Array(0))).toBe(false)
    expect(isG3dBinary(new Uint8Array([0x87]))).toBe(false)
    expect(isG3dBinary(new Uint8Array([0x87, 0xa5, 0x6d, 0x61, 0x67, 0x69, 0x63]))).toBe(false)
    expect(isG3dBinary(new Uint8Array([0x81, 0xa5, 0x6d, 0x61, 0x67, 0x69, 0x63, 0xa3, 0x47, 0x33, 0x45]))).toBe(false)
  })
})

const available = [TOY, TOY_TEXT, PLAIN, PLAIN_TEXT, MANIFEST].every((path) => existsSync(path))
const suite = available ? describe : describe.skip

suite('the binary g3d reader against g3djs', () => {
  const toy = available ? readFileSync(TOY) : Buffer.alloc(0)
  const plain = available ? readFileSync(PLAIN) : Buffer.alloc(0)
  const manifest: Manifest = available ? (JSON.parse(readFileSync(MANIFEST, 'utf8')) as Manifest) : { toy: { beads: {} }, plain: { beads: {} } }

  it('recognises the file by its first sixteen bytes, and a text g3d by none of them', () => {
    expect(isG3dBinary(new Uint8Array(toy.subarray(0, 16)))).toBe(true)
    expect(isG3dBinary(new Uint8Array(plain.subarray(0, 16)))).toBe(true)
    const text = readFileSync(TOY_TEXT)
    expect(isG3dBinary(new Uint8Array(text.subarray(0, 16)))).toBe(false)
  })

  it('reads the header as g3dtools wrote it and g3djs reads it', async () => {
    const header = await readG3dHeader(rangeOver(toy), toy.length)
    expect(header.version).toBe(2)
    expect(header.genome).toBe('toy')
    expect(header.name).toBe('toy')
    expect(header.resolutions).toEqual([20000, 40000, 80000])
    expect(header.categories).toEqual(['maternal', 'paternal'])
    expect([...header.offsets.keys()]).toEqual([20000, 40000, 80000])
    // The base resolution's block begins where the reserved header ends.
    expect(header.offsets.get(20000)?.offset).toBe(G3D_HEADER_LENGTH)

    const oracle = oracleOver(toy)
    await oracle.readHeader()
    const meta = oracle.meta
    if (meta === null) throw new Error('g3djs read no header')
    expect(meta.magic).toBe('G3D')
    expect(meta.version).toBe(header.version)
    expect(meta.genome).toBe(header.genome)
    expect(meta.name).toBe(header.name)
    expect(meta.resolutions).toEqual(header.resolutions)
    for (const resolution of header.resolutions) {
      expect(header.offsets.get(resolution)).toEqual(meta.offsets[String(resolution)])
    }
    expect(g3dBinaryNote(header)).toBe('binary g3d · 3 resolutions · 2 categories')
  })

  it('reads the header of a file shorter than the reserved block would be', async () => {
    // Asked for at most `size` bytes: the reader must not read past the file.
    let asked = 0
    const read: ReadRange = async (length, position) => {
      asked = length
      return rangeOver(toy)(length, position)
    }
    await readG3dHeader(read, 1000)
    expect(asked).toBe(1000)
  })

  it('lands on the same beads as g3djs at every resolution', async () => {
    const header = await readG3dHeader(rangeOver(toy), toy.length)
    const oracle = oracleOver(toy)
    for (const resolution of header.resolutions) {
      const set = await readG3dModel(rangeOver(toy), header, resolution)
      const block = await oracle.readData(resolution)
      if (block === null) throw new Error(`g3djs has no block at ${resolution}`)
      expectSameBeads(set, block, resolution)
      // And on the counts g3dtools' own `query` reported when the fixture was made.
      for (const [category, chromosomes] of Object.entries(manifest.toy.beads[String(resolution)])) {
        for (const [chrom, count] of Object.entries(chromosomes)) {
          expect(beadsOf(set, category, chrom)).toHaveLength(count)
        }
      }
    }
  })

  it('reads each block in one request, of exactly the size the header promised', async () => {
    const header = await readG3dHeader(rangeOver(toy), toy.length)
    const calls: Array<[number, number]> = []
    const read: ReadRange = async (length, position) => {
      calls.push([length, position])
      return rangeOver(toy)(length, position)
    }
    await readG3dModel(read, header, 40000)
    expect(calls).toEqual([[header.offsets.get(40000)!.size, header.offsets.get(40000)!.offset]])
  })

  it('is indistinguishable from the text reader over the same beads', async () => {
    const header = await readG3dHeader(rangeOver(toy), toy.length)
    const binary = await readG3dModel(rangeOver(toy), header, 20000)
    const text = parseG3d(readFileSync(TOY_TEXT, 'utf8'), 'toy.g3d.txt')
    expect(text.length).toBe(130)
    expectSameSet(binary, text)
    expect(binary.model?.haplotypes).toEqual(['maternal', 'paternal'])
    expect(binary.detail[0]).toBe('haplotype maternal')
    expect(binary.detail[1]).toBe('haplotype paternal')
  })

  it('refuses a resolution the file does not have, naming the ones it does', async () => {
    const header = await readG3dHeader(rangeOver(toy), toy.length)
    await expect(readG3dModel(rangeOver(toy), header, 30000)).rejects.toThrow(/20000, 40000, 80000/)
  })

  it('reads a haploid file as one shared category with no haplotype detail', async () => {
    const header = await readG3dHeader(rangeOver(plain), plain.length)
    expect(header.resolutions).toEqual([10000])
    expect(header.categories).toEqual(['shared'])
    expect(g3dBinaryNote(header)).toBe('binary g3d · 1 resolution · 1 category')

    const set = await readG3dModel(rangeOver(plain), header, 10000)
    expect(set.length).toBe(30)
    expect(set.contigs).toEqual(['chr1'])
    expect(set.model?.haplotypes).toEqual(['shared'])
    expect(set.detail.every((detail) => detail === '')).toBe(true)
    expect(set.model?.hap.every((hap) => hap === 0)).toBe(true)

    const oracle = oracleOver(plain)
    const block = await oracle.readData(10000)
    if (block === null) throw new Error('g3djs has no block at 10000')
    expectSameBeads(set, block, 10000)
    expectSameSet(set, parseG3d(readFileSync(PLAIN_TEXT, 'utf8'), 'plain.g3d.txt'))
  })
})
