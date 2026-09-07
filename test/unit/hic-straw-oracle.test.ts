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

import { describe, expect, it } from 'vitest'

// The ESM build by path: the package's `main` is a CommonJS bundle with no
// default export under Node's ESM resolver, and its `module` field is not
// consulted by Node. Naming the file is the difference between this working and
// a mystery about export shapes.
import Straw from 'hic-straw/dist/hic-straw.esm.js'

import { HicFile } from '@/hic/HicFile'
import { HicStore } from '@/hic/store'
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
