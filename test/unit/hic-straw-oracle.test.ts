/**
 * The `.hic` fixtures, read by somebody else's reader.
 *
 * `hic-roundtrip.test.ts` proves this repo's reader agrees with this repo's
 * writer, which is worth a great deal and is not enough: a mutual
 * misunderstanding of the block numbering, of the byte order or of the v9 width
 * flags would produce a file that round-trips perfectly here and that no tool in
 * the world can open. The failure mode is silent and it is the expensive one —
 * it is discovered by a collaborator, months later, holding a file this app
 * says is fine.
 *
 * So `hic-straw` — the reference implementation, the one `juicebox.js` and
 * `igv.js` read `.hic` with — reads every fixture too, and the three readings
 * must agree. This is exactly the discipline `bigwig-write.test.ts` applies by
 * reading its own bigWigs back through `@gmod/bbi`, and it is here for the same
 * reason: a format is a contract with other programs, and the only test of a
 * contract is another party to it.
 *
 * **A devDependency, never a runtime one.** See `hic/format.ts` for why the
 * reader is written here rather than delegated: the byte layer, the LRU, the
 * §12 request accounting and the S3 signature all belong to `ByteSource`, and a
 * parser that fetches for itself sits outside every one of them.
 */

import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

// The ESM build by path: the package's `main` is a CommonJS bundle with no
// default export under Node's ESM resolver, and its `module` field is not
// consulted by Node. Naming the file is the difference between this working and
// a mystery about export shapes.
import Straw from 'hic-straw/dist/hic-straw.esm.js'

import { HicFile } from '@/hic/HicFile'
import { HicStore } from '@/hic/store'
import { MetaCooler } from '@/metacooler/MetaCooler'
import { planRead } from '@/metacooler/matrix'
import type { ByteSource, Extent, SourceStats } from '@/types'
import { writeHic, type HicRecord } from '../support/hicWriter'

/**
 * The same bytes, as straw's own file abstraction.
 *
 * Straw takes any object with `read(position, length)` returning an
 * `ArrayBuffer`, which is the whole of what it needs from a file — so the
 * fixture never touches a disk and the comparison is over one array of bytes
 * rather than over two copies of it. Its `NodeLocalFile` is not exported from
 * the published bundle in any case.
 */
class StrawBytesFile {
  constructor(private readonly data: Uint8Array) {}
  async read(position: number, length: number): Promise<ArrayBuffer> {
    const n = Math.max(0, Math.min(this.data.byteLength - position, length))
    return this.data.slice(position, position + n).buffer as ArrayBuffer
  }
}

class BytesSource implements ByteSource {
  readonly id = 'oracle.hic'
  readonly size: number
  readonly isRemote = false
  constructor(private readonly data: Uint8Array) {
    this.size = data.byteLength
  }
  async mount(): Promise<string> {
    return this.id
  }
  readBytes(position: number, length: number): Uint8Array {
    const n = Math.max(0, Math.min(this.size - position, length))
    return this.data.subarray(position, position + n).slice()
  }
  stats(): SourceStats {
    return { requests: 0, bytes: 0 }
  }
  close(): void {}
}

const CHROMS = [
  { name: 'chr1', length: 20_000 },
  { name: 'chr2', length: 8_000 },
]
const BIN = 100

function scatter(nx: number, ny: number, step: number, seed: number, intra: boolean): HicRecord[] {
  const out: HicRecord[] = []
  for (let x = 0; x < nx; x += step) {
    for (let y = intra ? x : 0; y < ny; y += step) {
      out.push({ x, y, value: ((x * 31 + y * 17 + seed) % 97) + 1 })
    }
  }
  return out
}

/** `x,y → value`, so a mismatch names the cell rather than the array index. */
function indexOf(records: Iterable<{ x: number; y: number; value: number }>): Map<string, number> {
  const out = new Map<string, number>()
  for (const record of records) out.set(`${record.x},${record.y}`, record.value)
  return out
}

interface Case {
  name: string
  version: 7 | 8 | 9
  shortValues?: boolean
  shortPositions?: boolean
  dense?: boolean
  blockBinCount: number
}

const CASES: Case[] = [
  { name: 'v8 grid blocks, float values', version: 8, blockBinCount: 32 },
  { name: 'v8 grid blocks, short values', version: 8, shortValues: true, blockBinCount: 32 },
  { name: 'v8 dense blocks', version: 8, dense: true, blockBinCount: 32 },
  { name: 'v9 diagonal blocks, int positions', version: 9, blockBinCount: 32 },
  { name: 'v9 diagonal blocks, short positions', version: 9, shortPositions: true, blockBinCount: 32 },
  { name: 'v9 dense blocks', version: 9, dense: true, blockBinCount: 32 },
]

describe.each(CASES)('$name', (spec) => {
  it('is read identically by hic-straw', async () => {
    const n1 = Math.ceil(CHROMS[0].length / BIN)
    const n2 = Math.ceil(CHROMS[1].length / BIN)
    const intra1 = scatter(n1, n1, 7, 1, true)
    const inter = scatter(n1, n2, 11, 3, false)
    const written = await writeHic({
      version: spec.version,
      chroms: CHROMS,
      resolutions: [BIN],
      records: { '1_1': intra1, '1_2': inter },
      blockBinCount: spec.blockBinCount,
      ...(spec.shortValues === undefined ? {} : { shortValues: spec.shortValues }),
      ...(spec.shortPositions === undefined ? {} : { shortPositions: spec.shortPositions }),
      ...(spec.dense === undefined ? {} : { dense: spec.dense }),
    })
    const straw = new Straw({ file: new StrawBytesFile(written.bytes) })
    const meta = await straw.getMetaData()
    // The header, as a third party sees it. `All` is present in the file and
    // straw reports it; this reader drops it, which is the one place the two
    // legitimately differ and is worth pinning rather than hiding.
    expect(meta.chromosomes.map((chrom) => chrom.name)).toEqual(['All', 'chr1', 'chr2'])
    expect(meta.version).toBe(spec.version)
    expect(meta.chromosomes.map((chrom) => chrom.size)).toEqual([
      CHROMS[0].length + CHROMS[1].length,
      CHROMS[0].length,
      CHROMS[1].length,
    ])

    // Straw's regions are base pairs and are *required*: a region with no
    // start and end resolves to NaN and comes back empty, which reads as
    // "the file has no records" rather than as a bad question.
    const whole1 = { chr: 'chr1', start: 0, end: CHROMS[0].length }
    const whole2 = { chr: 'chr2', start: 0, end: CHROMS[1].length }
    for (const [region1, region2, rows, cols] of [
      [whole1, whole1, [0, n1], [0, n1]],
      [whole1, whole2, [0, n1], [n1, n1 + n2]],
    ] as Array<[{ chr: string; start: number; end: number }, { chr: string; start: number; end: number }, Extent, Extent]>) {
      const theirs = indexOf(
        (await straw.getContactRecords('NONE', region1, region2, 'BP', BIN)).map((record) => ({
          // straw reports chromosome-local bins; this reader reports global
          // ones, so the comparison is made in straw's frame by subtracting the
          // offset back off. Comparing in *either* frame is fine; comparing in
          // neither, by assuming they agree, is the mistake.
          x: record.bin1,
          y: record.bin2,
          value: record.counts,
        })),
      )

      const file = HicFile.open(new BytesSource(written.bytes))
      const store = new HicStore(file)
      const ours = new Map<string, number>()
      await store.forEachWindow(
        rows,
        cols,
        planRead(rows, cols, 'symmetric-upper'),
        (chunk) => {
          for (let i = 0; i < chunk.length; i++) {
            const bin1 = chunk.bin1[i]
            const bin2 = chunk.bin2[i]
            const localX = bin1 - file.chromOffset[file.chromAt(bin1)]
            const localY = bin2 - file.chromOffset[file.chromAt(bin2)]
            ours.set(`${localX},${localY}`, chunk.count[i])
          }
        },
      )

      expect(ours.size).toBe(theirs.size)
      for (const [key, value] of theirs) {
        expect(ours.get(key)).toBeCloseTo(value, 5)
      }
    }
  })
})

/**
 * The footer's expected-value sections, crossed by both readers.
 *
 * Every fixture above leaves those sections empty, which is legal and which
 * means neither reader has to walk one. Straw does walk them — that is what
 * `skipExpectedValues` is for — and it is the only path it has to the
 * normalisation index when the file carries no pointer to one: always in v7 and
 * v8, and in v9 whenever the pointer is absent. So a fixture that populates the
 * sections is the one place the two implementations can be compared on the
 * width arithmetic itself, and the widths are what changed at v9.
 *
 * The v9 case deliberately zeroes the pointer. With it present straw reads the
 * index directly and never walks, so a v9 fixture that carried it would agree
 * with this reader no matter what the reader did with the scale factors —
 * which is exactly how a v9 walk at v8's width survived a suite that already
 * had an oracle.
 */
describe.each([
  { name: 'v8, walked because the format has no pointer', version: 8 as const, withoutNormIndexPointer: false },
  { name: 'v9, walked because the pointer is absent', version: 9 as const, withoutNormIndexPointer: true },
])('$name', (spec) => {
  it('lands both readers on the same normalisation index', async () => {
    const divisors = new Float64Array(200).fill(2)
    divisors[7] = 5
    const written = await writeHic({
      version: spec.version,
      chroms: CHROMS,
      // Three resolutions, so each section holds three vectors and a per-vector
      // drift accumulates rather than cancelling.
      resolutions: [BIN, 500, 2000],
      records: { '1_1': scatter(200, 200, 9, 5, true) },
      blockBinCount: 32,
      expectedValues: true,
      norms: { [`KR/1/${BIN}`]: divisors },
      // Juicer's layout, and here a precondition rather than a detail: straw's
      // walk re-reads the same range when fewer than a hundred bytes follow the
      // index, so a fixture that ends just past it never terminates.
      normVectorsAfterFooter: true,
      ...(spec.withoutNormIndexPointer ? { withoutNormIndexPointer: true } : {}),
    })

    const straw = new Straw({ file: new StrawBytesFile(written.bytes) })
    await straw.getMetaData()
    // Straw reached the index by walking the sections. If our writer's widths
    // were wrong rather than the reader's, this is the assertion that says so.
    expect(await straw.getNormalizationOptions()).toContain('KR')

    const file = HicFile.open(new BytesSource(written.bytes), { binSize: BIN })
    expect(file.normType).toBe('KR')

    const region = { chr: 'chr1', start: 0, end: CHROMS[0].length }
    const normed = await straw.getContactRecords('KR', region, region, 'BP', BIN)
    const raw = await straw.getContactRecords('NONE', region, region, 'BP', BIN)
    expect(normed.length).toBeGreaterThan(0)
    const weights = file.weights(0, 200)
    const rawAt = indexOf(raw.map((r) => ({ x: r.bin1, y: r.bin2, value: r.counts })))
    for (const record of normed.slice(0, 40)) {
      const before = rawAt.get(`${record.bin1},${record.bin2}`)
      expect(before).toBeDefined()
      const ourNormed = (before as number) * weights[record.bin1] * weights[record.bin2]
      expect(ourNormed).toBeCloseTo(record.counts, 5)
    }
  })
})

describe('normalisation vectors', () => {
  it('are the reciprocal of what straw divides by', async () => {
    const divisors = new Float64Array(200).fill(2)
    divisors[3] = 4
    const written = await writeHic({
      version: 9,
      chroms: [{ name: 'chr1', length: 20_000 }],
      resolutions: [BIN],
      records: { '1_1': scatter(200, 200, 9, 5, true) },
      blockBinCount: 32,
      norms: { [`KR/1/${BIN}`]: divisors },
    })
    const straw = new Straw({ file: new StrawBytesFile(written.bytes) })
    // `getMetaData` first, and not incidentally: straw's `getNormVectorIndex`
    // reads `normVectorIndexPosition` *before* it initialises the file, so on a
    // fresh instance it is still the constructor's sentinel and the reader falls
    // back to walking the footer from a NaN offset. Every real caller opens the
    // metadata first; the oracle has to as well, or it measures straw rather
    // than the fixture.
    await straw.getMetaData()
    expect(await straw.getNormalizationOptions()).toContain('KR')
    const region = { chr: 'chr1', start: 0, end: 20_000 }
    const normed = await straw.getContactRecords('KR', region, region, 'BP', BIN)
    const raw = await straw.getContactRecords('NONE', region, region, 'BP', BIN)

    const file = HicFile.open(new BytesSource(written.bytes))
    expect(file.normType).toBe('KR')
    const weights = file.weights(0, 200)

    const rawAt = indexOf(raw.map((r) => ({ x: r.bin1, y: r.bin2, value: r.counts })))
    for (const record of normed.slice(0, 40)) {
      const before = rawAt.get(`${record.bin1},${record.bin2}`)
      expect(before).toBeDefined()
      // straw divides by the stored vector; this reader multiplies by its
      // reciprocal, which is cooler's convention and the reason `bins/weight`
      // needs no special case anywhere above the handle.
      const ourNormed = (before as number) * weights[record.bin1] * weights[record.bin2]
      expect(ourNormed).toBeCloseTo(record.counts, 5)
    }
  })
})

/**
 * A file Juicer Tools wrote, read by both.
 *
 * Every case above reads a fixture `test/support/hicWriter` produced, so what
 * the two readers agree on is this repository's idea of the format. That is the
 * idea worth checking first and still not the format: nothing above holds a
 * block Juicer laid out, a ladder of five resolutions, or a vector its balancer
 * wrote. The demo map holds all three — a v8 `.hic` of yeast Hi-C whose header
 * names `Juicer Tools Version 1.9.9`, at 1, 2, 4, 8 and 16 kb, with VC, VC_SQRT
 * and KR — and it is committed, so this runs on every push with nothing to build.
 *
 * Read through `MetaCooler`, because that is the path a view and an analysis
 * take, and compared on every cell of each window, raw and balanced. Raw counts
 * are compared exactly: both readers decode the same float32. Balanced ones to
 * float32 precision, since straw divides by the stored vector and this reader
 * multiplies by its reciprocal.
 */
describe('the demo .hic, which Juicer Tools wrote', () => {
  const HIC = new URL('../../demo/yeast/Yeast_hic.hic', import.meta.url).pathname
  const bytes = new Uint8Array(readFileSync(HIC))
  const straw = new Straw({ file: new StrawBytesFile(bytes) })

  it('has the same sequences and resolutions to both readers', async () => {
    const meta = await straw.getMetaData()
    const file = HicFile.open(new BytesSource(bytes))
    expect(file.header.attributes.software).toBe('Juicer Tools Version 1.9.9')
    expect(meta.version).toBe(8)
    expect(file.header.version).toBe(8)
    expect(file.resolutions).toEqual([...meta.resolutions].sort((a, b) => a - b))
    // Straw reports Juicer's `ALL` first; this reader drops it, as above.
    expect(meta.chromosomes[0].name).toBe('ALL')
    expect(file.chroms).toEqual(
      meta.chromosomes.slice(1).map((chrom) => ({ name: chrom.name, length: chrom.size })),
    )
  })

  interface Side {
    chrom: string
    start: number
    end: number
  }

  // Every start is a multiple of 16 kb, so of every rung, and straw's window
  // and this reader's cover the same bins. Ends at a chromosome's length keep
  // its short last bin in the comparison.
  const WINDOWS: Array<{ name: string; a: Side; b: Side }> = [
    {
      name: 'chromosome I, whole',
      a: { chrom: 'I', start: 0, end: 230_218 },
      b: { chrom: 'I', start: 0, end: 230_218 },
    },
    {
      name: 'a window inside IV',
      a: { chrom: 'IV', start: 992_000, end: 1_392_000 },
      b: { chrom: 'IV', start: 992_000, end: 1_392_000 },
    },
    {
      name: 'IV, a megabase off the diagonal',
      a: { chrom: 'IV', start: 0, end: 160_000 },
      b: { chrom: 'IV', start: 1_200_000, end: 1_360_000 },
    },
    {
      name: 'I against III',
      a: { chrom: 'I', start: 0, end: 230_218 },
      b: { chrom: 'III', start: 0, end: 316_620 },
    },
  ]

  describe.each([1000, 2000, 4000, 8000, 16000])('at %i bp', (binSize) => {
    it.each(WINDOWS)('$name, raw and balanced', async ({ a, b }) => {
      const file = HicFile.open(new BytesSource(bytes), { binSize })
      const mc = MetaCooler.fromHic(`oracle.hic::/resolutions/${binSize}`, new BytesSource(bytes))
      try {
        const extent = (side: Side): Extent => {
          const base = mc.contigExtent(side.chrom)[0]
          return [base + side.start / binSize, base + Math.ceil(side.end / binSize)]
        }
        const rows = extent(a)
        const cols = extent(b)
        const ncols = cols[1] - cols[0]
        const square = a.chrom === b.chrom && a.start === b.start && a.end === b.end

        // Straw's records into the grid this reader returns. Both are the
        // stored upper triangle in straw's frame — chromosome-local bins — so
        // a square window is mirrored, as `MetaCooler.matrix` mirrors it.
        const grid = async (norm: string): Promise<Map<number, number>> => {
          const out = new Map<number, number>()
          const region = (side: Side) => ({ chr: side.chrom, start: side.start, end: side.end })
          const records = await straw.getContactRecords(norm, region(a), region(b), 'BP', binSize)
          for (const record of records) {
            const r = record.bin1 - a.start / binSize
            const c = record.bin2 - b.start / binSize
            out.set(r * ncols + c, record.counts)
            if (square) out.set(c * ncols + r, record.counts)
          }
          return out
        }

        const raw = await mc.matrix({ rows, cols })
        expect([raw.nrows, raw.ncols]).toEqual([rows[1] - rows[0], ncols])
        const theirs = await grid('NONE')
        expect(theirs.size).toBeGreaterThan(0)
        const rawMismatches: string[] = []
        for (let i = 0; i < raw.values.length; i++) {
          const expected = theirs.get(i) ?? 0
          if (raw.values[i] !== expected) rawMismatches.push(`${i}: ${raw.values[i]} ≠ ${expected}`)
        }
        expect(rawMismatches.slice(0, 5)).toEqual([])

        // The normalisation is whichever this reader serves for the two
        // chromosomes, asked of straw by name. The two must agree: a window
        // whose axes were balanced by different vectors is one straw cannot
        // express, and would be a finding here rather than a skip.
        const chromIndex = (side: Side): number => file.chroms.findIndex((c) => c.name === side.chrom)
        const norm = file.normTypeFor(chromIndex(a))
        expect(norm).not.toBeNull()
        expect(file.normTypeFor(chromIndex(b))).toBe(norm)

        const balanced = await mc.matrix({ rows, cols, balance: true })
        const theirsBalanced = await grid(norm as string)
        expect(theirsBalanced.size).toBeGreaterThan(0)
        const balancedMismatches: string[] = []
        for (let i = 0; i < balanced.values.length; i++) {
          const ours = balanced.values[i]
          const expected = theirsBalanced.get(i)
          // Straw drops a record whose bins the balancer threw out; this reader
          // keeps the cell and makes it `NaN`, which is cooler's spelling.
          const agrees =
            expected === undefined
              ? ours === 0 || Number.isNaN(ours)
              : Math.abs(ours - expected) <= 1e-6 * Math.abs(expected)
          if (!agrees) balancedMismatches.push(`${i}: ${ours} ≠ ${expected}`)
        }
        expect(balancedMismatches.slice(0, 5)).toEqual([])
      } finally {
        mc.close()
      }
    })
  })
})
