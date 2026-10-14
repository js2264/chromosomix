/**
 * Numbers a file declares, refused before they size anything (§10).
 *
 * Two halves. The first pins `sources/untrusted.ts` itself: the three questions
 * a count answers, the span a read is aimed at, and an inflate that stops at
 * its cap instead of producing the bomb. The second is the failures a review of
 * the readers reproduced, each turned into the assertion its fix makes true — a
 * sixteen-byte `.hic` block declaring fifty million records, a footer whose one
 * negative `nValues` read 341 MiB of a 256 MiB file, a `.csi` whose depth would
 * hold the annotations worker for some twenty minutes a query — and the same
 * shape of failure in every other reader that review reached.
 *
 * Each case says what it costs as well as what it answers: bytes read, the
 * largest array made, and for the one that used to hang, how long it took.
 */

import { describe, expect, it } from 'vitest'
import { deflateRawSync, deflateSync, gzipSync } from 'node:zlib'

import { ViewerError } from '@/errors'
import {
  declaredCount,
  declaredSpan,
  inflateCapped,
  inflationCap,
  plausibleCount,
} from '@/sources/untrusted'
import { decodeBlock } from '@/hic/blocks'
import { HicFile } from '@/hic/HicFile'
import { readFooter, type HicHeader } from '@/hic/format'
import { chunksFor, parseBamIndex } from '@/annotations/bam/index'
import { forEachRecord, readTags } from '@/annotations/bam/format'
import { decodeMsgpack } from '@/annotations/msgpack'
import { openTwoBit, recordHeaderBytes } from '@/annotations/twobit'
import { readG3dHeader, readG3dModel } from '@/annotations/g3dBinary'
import { inflateMember, forEachLine } from '@/pairs/stream'
import { inflateBgzf } from '@/annotations/tabix'
import { CountingSource, countingRange, watchAllocations } from '../support/hostile'
import { buildTwoBit } from '../support/twoBitWriter'
import { packMsgpack, writeG3d } from '../support/g3dWriter'
import { writeHic } from '../support/hicWriter'
import { bgzfBlock, csiBytes, recordBytes } from './bam-fixtures'

/** The refusal a reader throws, or a failure if it threw anything else or nothing. */
function refusal(run: () => unknown): ViewerError {
  try {
    run()
  } catch (err) {
    expect(err).toBeInstanceOf(ViewerError)
    return err as ViewerError
  }
  throw new Error('expected a refusal, and the reader answered')
}

async function refusalOf(run: () => Promise<unknown>): Promise<ViewerError> {
  try {
    await run()
  } catch (err) {
    expect(err).toBeInstanceOf(ViewerError)
    return err as ViewerError
  }
  throw new Error('expected a refusal, and the reader answered')
}

/**
 * The largest typed array `run` made, in bytes. `run` catches the refusal it
 * expects itself, so anything that escapes it is a failure and is let through.
 */
async function largestMadeBy(run: () => Promise<unknown> | unknown): Promise<number> {
  const seen = { largest: 0 }
  const stop = watchAllocations(seen)
  try {
    await run()
  } finally {
    stop()
  }
  return seen.largest
}

const FIELD = { format: '.test', field: 'record count' }

describe('a declared count', () => {
  it('passes a count the bytes could hold, unchanged', () => {
    expect(declaredCount(12, { ...FIELD, ceiling: 100, available: 48, bytesPerItem: 4 })).toBe(12)
    expect(declaredCount(12n, { ...FIELD, ceiling: 100 })).toBe(12)
  })

  it('refuses what is not a count: negative, fractional, NaN, or an int64 past 2^53', () => {
    for (const value of [-1, 1.5, Number.NaN, 2n ** 60n, -(2n ** 60n)]) {
      const err = refusal(() => declaredCount(value, { ...FIELD, ceiling: Number.MAX_SAFE_INTEGER }))
      expect(err.code).toBe('format')
      expect(err.message).toMatch(/record count of this \.test reads .*, which is not a count/)
    }
  })

  it('refuses past the ceiling, naming the format, the field and the value', () => {
    const err = refusal(() => declaredCount(1001, { ...FIELD, ceiling: 1000 }))
    expect(err.detail).toMatchObject({ format: '.test', field: 'record count', value: 1001, ceiling: 1000 })
    expect(err.message).toMatch(/more than the 1.000 any real one declares/)
    expect(err.message).toMatch(/truncated, corrupt, or not the format its first bytes claim/)
  })

  it('refuses more items than the bytes left could hold, at the fewest bytes one takes', () => {
    const limits = { ...FIELD, ceiling: 1e9, available: 16, bytesPerItem: 4 }
    expect(declaredCount(4, limits)).toBe(4)
    const err = refusal(() => declaredCount(5, limits))
    expect(err.detail).toMatchObject({ value: 5, available: 16, most: 4 })
    expect(plausibleCount(5, limits)).toBe(false)
    expect(plausibleCount(4, limits)).toBe(true)
  })
})

describe('a declared span', () => {
  it('passes bytes inside the file and refuses bytes past its end', () => {
    expect(() => declaredSpan(10, 90, { ...FIELD, size: 100 })).not.toThrow()
    expect(refusal(() => declaredSpan(10, 91, { ...FIELD, size: 100 })).detail).toMatchObject({ offset: 10, length: 91 })
    expect(refusal(() => declaredSpan(-1, 4, { ...FIELD, size: 100 })).code).toBe('format')
    expect(refusal(() => declaredSpan(0, 64, { ...FIELD, size: 100, ceiling: 32 })).message).toMatch(/more than the 32/)
  })
})

describe('a capped inflate', () => {
  const plain = new TextEncoder().encode('chr1\t100\t200\n'.repeat(1000))

  it('inflates what fits, byte for byte, in every encoding the readers use', async () => {
    for (const [encoding, packed] of [
      ['deflate', deflateSync(plain)],
      ['gzip', gzipSync(plain)],
      ['deflate-raw', deflateRawSync(plain)],
    ] as const) {
      const out = await inflateCapped(new Uint8Array(packed), { ...FIELD, encoding, maxBytes: plain.length })
      expect(out).toEqual(plain)
    }
  })

  it('stops a bomb at its cap, having made little past it', async () => {
    // 64 MiB of zeros in about 64 KB: the shape of every decompression bomb.
    const bomb = new Uint8Array(deflateSync(new Uint8Array(64 << 20)))
    const started = performance.now()
    const largest = await largestMadeBy(async () => {
      const err = await refusalOf(() => inflateCapped(bomb, { ...FIELD, encoding: 'deflate', maxBytes: 1 << 20 }))
      expect(err.detail).toMatchObject({ maxBytes: 1 << 20, compressed: bomb.length })
    })
    expect(largest).toBeLessThan(2 << 20)
    expect(performance.now() - started).toBeLessThan(5_000)
  })

  it('refuses bytes the decompressor rejects, in the same words as a count', async () => {
    const err = await refusalOf(() =>
      inflateCapped(new Uint8Array([1, 2, 3, 4, 5]), { ...FIELD, encoding: 'deflate', maxBytes: 1 << 20 }),
    )
    expect(err.message).toMatch(/record count of this \.test does not inflate/)
  })

  it('caps in proportion to what went in, between a floor and a ceiling', () => {
    const policy = { ratio: 64, floor: 1 << 20, ceiling: 1 << 30 }
    expect(inflationCap(1000, policy)).toBe(1 << 20)
    expect(inflationCap(1 << 20, policy)).toBe(64 << 20)
    expect(inflationCap(1 << 30, policy)).toBe(1 << 30)
  })
})

// ---------------------------------------------------------------------------
// The review's repros, as regressions
// ---------------------------------------------------------------------------

describe('a .hic that lies', () => {
  it('refuses a footer whose expected-value vector is negative long, in two reads (hic-footer.ts)', () => {
    // The review's file: 256 MiB, a v8 footer at byte 1000 declaring a v5 part
    // of 100 bytes, an empty master index, one expected-value vector in BP at
    // 10 kb, and that vector's length read as -1,000,000. It used to be six
    // reads and 341 MiB, ending in a bare RangeError.
    const size = 256 << 20
    const footerPosition = 1000
    const front = new Uint8Array(footerPosition + 64)
    const view = new DataView(front.buffer)
    let at = footerPosition
    view.setInt32(at, 100, true)
    at += 4
    view.setInt32(at, 0, true)
    at += 4
    view.setInt32(at, 1, true)
    at += 4
    front.set([0x42, 0x50, 0], at)
    at += 3
    view.setInt32(at, 10000, true)
    at += 4
    view.setInt32(at, -1_000_000, true)
    const source = new CountingSource(front, 4 << 20, size)
    const err = refusal(() => readFooter(source, { version: 8, footerPosition } as HicHeader))
    expect(err.code).toBe('format')
    expect(err.detail).toMatchObject({ field: 'expected-value vector length', value: -1_000_000 })
    expect(source.requests).toBeLessThanOrEqual(2)
    expect(source.bytes).toBeLessThan(2 << 20)
  })

  it('refuses a sixteen-byte block that declares fifty million records, allocating nothing (hic-block.ts)', async () => {
    const block = new Uint8Array(16)
    const view = new DataView(block.buffer)
    view.setInt32(0, 50_000_000, true) // nRecords
    block[12] = 1 // useFloatContact: float values
    block[13] = 1 // type 1: a list of rows
    view.setInt16(14, 0, true) // no rows
    let err: ViewerError | undefined
    const largest = await largestMadeBy(() => {
      err = refusal(() => decodeBlock(block, 8))
    })
    expect(err?.detail).toMatchObject({ field: 'record count of a block', value: 50_000_000, most: 0 })
    // It used to be 572 MiB of typed arrays.
    expect(largest).toBeLessThan(1 << 10)
  })

  it('refuses a record count in the int32 range just as early', () => {
    const block = new Uint8Array(32)
    new DataView(block.buffer).setInt32(0, 2 ** 31 - 1, true)
    block[13] = 1
    expect(refusal(() => decodeBlock(block, 8)).detail).toMatchObject({ value: 2 ** 31 - 1 })
    new DataView(block.buffer).setInt32(0, -1, true)
    expect(refusal(() => decodeBlock(block, 8)).message).toMatch(/which is not a count/)
  })

  it('still decodes a block holding more records than it declares, as a thresholded dense block does', () => {
    // A dense block of two cells, both present, declaring one record.
    const block = new Uint8Array(4 + 8 + 1 + 1 + 4 + 2 + 4)
    const view = new DataView(block.buffer)
    view.setInt32(0, 1, true)
    view.setInt32(4, 10, true)
    view.setInt32(8, 20, true)
    block[12] = 0 // short values
    block[13] = 2 // dense
    view.setInt32(14, 2, true) // two cells
    view.setInt16(18, 2, true) // two wide
    view.setInt16(20, 5, true)
    view.setInt16(22, 7, true)
    const records = decodeBlock(block, 8)
    expect(records.length).toBe(2)
    expect([...records.x.subarray(0, 2)]).toEqual([10, 11])
    expect([...records.value.subarray(0, 2)]).toEqual([5, 7])
  })

  it('does not keep a block larger than its whole cache', async () => {
    const { bytes } = await writeHic({
      version: 8,
      chroms: [{ name: 'chr1', length: 10_000 }],
      resolutions: [100],
      records: { '1_1': [{ x: 1, y: 2, value: 3 }] },
    })
    const file = HicFile.open(new CountingSource(bytes))
    const big = new Int32Array(20 << 20) // 80 MiB of x alone
    const cache = file as unknown as {
      remember(key: string, records: unknown): void
      blockCache: Map<string, unknown>
      blockCacheBytes: number
    }
    cache.remember('huge', { x: big, y: new Int32Array(0), value: new Float32Array(0), length: 0 })
    expect(cache.blockCache.size).toBe(0)
    expect(cache.blockCacheBytes).toBe(0)
  })
})

describe('a BAM index that lies', () => {
  /** The review's twenty-four-byte CSI: magic, min_shift 14, depth `depth`, no aux, one reference, no bins. */
  function csi(depth: number, minShift = 14): Uint8Array {
    const bytes = new Uint8Array(24)
    const view = new DataView(bytes.buffer)
    bytes.set([0x43, 0x53, 0x49, 0x01])
    view.setInt32(4, minShift, true)
    view.setInt32(8, depth, true)
    view.setInt32(12, 0, true)
    view.setInt32(16, 1, true)
    view.setInt32(20, 0, true)
    return bytes
  }

  it('refuses a CSI depth past ten when the index is parsed, not on every query after (csi-depth.ts)', async () => {
    for (const depth of [11, 2000, 1_000_000, -1]) {
      const err = await refusalOf(() => parseBamIndex(csi(depth)))
      expect(err.detail).toMatchObject({ format: 'BAM index', field: 'CSI depth', value: depth })
    }
  })

  it('answers a query against the deepest legal CSI at once', async () => {
    const index = await parseBamIndex(csi(10))
    const started = performance.now()
    expect(chunksFor(index, 0, 1_000_000, 1_001_000, 1 << 30)).toEqual([])
    expect(performance.now() - started).toBeLessThan(100)
  })

  it('names no more bins than the index holds, even at a min_shift of nought', async () => {
    // Depth ten at a minimum interval of one base: a window of a gigabase is a
    // billion candidate bins at the deepest level, and the index holds one.
    const bytes = csiBytes([[{ bin: 0, loffset: 0, chunks: [[0, 100]] }]], 0, 10)
    const index = await parseBamIndex(await bgzfBlock(bytes))
    const started = performance.now()
    expect(chunksFor(index, 0, 0, 1 << 30, 1 << 20)).toHaveLength(1)
    expect(performance.now() - started).toBeLessThan(100)
  })

  it('refuses a BAI linear index of 2^31 - 1 slots, allocating nothing for it', async () => {
    // One reference, no bins, and a slot count of 2^31 - 1: sixteen gigabytes
    // of BigUint64Array, asked for on trust.
    const bai = new Uint8Array(16)
    const view = new DataView(bai.buffer)
    bai.set([0x42, 0x41, 0x49, 0x01])
    view.setInt32(4, 1, true)
    view.setInt32(8, 0, true)
    view.setInt32(12, 2 ** 31 - 1, true)
    let err: ViewerError | undefined
    const largest = await largestMadeBy(async () => {
      err = await refusalOf(() => parseBamIndex(bai))
    })
    expect(err?.detail).toMatchObject({ field: 'linear index size of reference 0', value: 2 ** 31 - 1 })
    expect(largest).toBeLessThan(1 << 10)
  })

  it('refuses an index that ends inside its own tables as truncated, not with a bare RangeError', async () => {
    const bytes = csiBytes([[{ bin: 4681, loffset: 0, chunks: [[0, 100], [100, 200]] }]])
    const err = await refusalOf(() => parseBamIndex(bytes.subarray(0, bytes.length - 20)))
    expect(err.code).toBe('format')
  })
})

describe('a BAM record that lies', () => {
  it('stops at a record whose sequence is longer than the record', () => {
    const record = recordBytes({ refId: 0, pos: 100, cigar: '10M', seq: 'ACGTACGTAC' })
    new DataView(record.buffer).setInt32(4 + 16, 2 ** 31 - 1, true) // l_seq
    let visited = 0
    forEachRecord(record, 0, () => {
      visited++
    })
    expect(visited).toBe(0)
  })

  it('reads no B array longer than its tag block', () => {
    const tags = new Uint8Array([0x58, 0x58, 0x42, 0x49, 0xff, 0xff, 0xff, 0x7f, 1, 0, 0, 0])
    expect(readTags(tags, 0, tags.length)).toEqual({})
  })
})

describe('a .2bit that lies', () => {
  it('refuses an N-block count of 2^32 - 1 before the gap list is read', async () => {
    const file = buildTwoBit([{ name: 'chr1', bases: 'ACGT'.repeat(1000), gaps: [[10, 20]] }])
    // The record follows the 16-byte header and its one index row.
    const recordAt = 16 + 1 + 4 + 4
    new DataView(file.buffer).setUint32(recordAt + 4, 0xffffffff, true)
    const { read, stats } = countingRange(file, 1 << 20)
    const err = await refusalOf(() => openTwoBit(read, file.length))
    expect(err.detail).toMatchObject({ format: '.2bit', field: 'N-block count of chr1', value: 0xffffffff })
    expect(stats.bytes).toBeLessThan(2 * file.length)
  })

  it('refuses the same count with no file size known, by the sequence it belongs to', () => {
    const header = new Uint8Array(12)
    const view = new DataView(header.buffer)
    view.setUint32(0, 4000, true) // dnaSize
    view.setUint32(4, 0xffffffff, true) // nBlockCount
    expect(refusal(() => recordHeaderBytes(header, 0, true)).detail).toMatchObject({ ceiling: 4000 })
  })
})

describe('a binary g3d that lies', () => {
  async function toy(): Promise<Uint8Array> {
    const beads = { start: [0, 20000, 40000], x: [0, 1, 2], y: [0, 1, 2], z: [0, 1, 2] }
    return writeG3d({
      models: new Map([[20000, new Map([['shared', new Map([['chr1', beads]])]])]]),
    })
  }

  it('reads a well-formed one', async () => {
    const file = await toy()
    const { read } = countingRange(file)
    const header = await readG3dHeader(read, file.length)
    const model = await readG3dModel(read, header, 20000)
    expect(model.contigs).toEqual(['chr1'])
  })

  /** A header naming one block of `size` bytes at 64,000, in a file of 64,100. */
  function claiming(size: number): Uint8Array {
    const bytes = packMsgpack(new Map<string, unknown>([
      ['magic', 'G3D'],
      ['version', 2],
      ['offsets', new Map([[20000, new Map([['offset', 64000], ['size', size]])]])],
      ['resolutions', [20000]],
      ['categories', ['shared']],
    ]))
    const file = new Uint8Array(64100)
    file.set(bytes)
    return file
  }

  it('refuses, from the header, a block larger than any could inflate to', async () => {
    const { read } = countingRange(claiming(2 ** 40))
    const err = await refusalOf(() => readG3dHeader(read, 64100))
    expect(err.detail).toMatchObject({ format: 'binary g3d', field: 'size of the 20000 bp block', value: 2 ** 40 })
  })

  it('refuses a block past the end of the file before reading it', async () => {
    const file = claiming(1 << 20)
    const { read, stats } = countingRange(file)
    const header = await readG3dHeader(read, file.length)
    const err = await refusalOf(() => readG3dModel(read, header, 20000))
    expect(err.detail).toMatchObject({ format: 'binary g3d', field: '20000 bp block', length: 1 << 20 })
    // The header's 64,000 bytes, and not one byte of the block.
    expect(stats.bytes).toBe(64000)
  })

  it('refuses a block that inflates past its cap', async () => {
    // An 80 KB block that inflates to 80 MiB of zeros: past the 64 MiB floor,
    // and far past sixty-four times its own size.
    const block = new Uint8Array(deflateSync(new Uint8Array(80 << 20)))
    const header = packMsgpack(new Map<string, unknown>([
      ['magic', 'G3D'],
      ['version', 2],
      ['offsets', new Map([[20000, new Map([['offset', 64000], ['size', block.length]])]])],
      ['resolutions', [20000]],
      ['categories', ['shared']],
    ]))
    const file = new Uint8Array(64000 + block.length)
    file.set(header)
    file.set(block, 64000)
    const { read } = countingRange(file)
    const parsed = await readG3dHeader(read, file.length)
    const started = performance.now()
    const err = await refusalOf(() => readG3dModel(read, parsed, 20000))
    expect(err.detail).toMatchObject({ format: 'binary g3d', maxBytes: 64 << 20 })
    expect(performance.now() - started).toBeLessThan(5_000)
  })

  it('refuses a MessagePack array longer than its bytes, and nesting past sixty-four deep', () => {
    expect(refusal(() => decodeMsgpack(new Uint8Array([0xdd, 0xff, 0xff, 0xff, 0xff, 0x01]))).message).toMatch(
      /array length at offset 5 of this MessagePack value reads 4.294.967.295/,
    )
    const deep = new Uint8Array(64000).fill(0x91)
    expect(refusal(() => decodeMsgpack(deep)).message).toMatch(/nests deeper than 64 levels/)
  })
})

describe('compressed streams that lie', () => {
  it('refuses a BGZF member that inflates past the format’s 64 KiB', async () => {
    const member = new Uint8Array(deflateRawSync(new Uint8Array(1 << 20)))
    const err = await refusalOf(() => inflateMember(member))
    expect(err.detail).toMatchObject({ format: 'BGZF file', field: 'member', maxBytes: 1 << 16 })
  })

  it('refuses a BGZF span past the cap its caller can hold', async () => {
    const block = await bgzfBlock(new Uint8Array(60_000))
    const span = new Uint8Array(block.length * 4)
    for (let i = 0; i < 4; i++) span.set(block, i * block.length)
    expect((await inflateBgzf(span)).length).toBe(240_000)
    const err = await refusalOf(() => inflateBgzf(span, Number.POSITIVE_INFINITY, 100_000))
    expect(err.detail).toMatchObject({ field: 'span read', maxBytes: 100_000 })
  })

  it('refuses a .pairs line with no end, at 64 MiB and in linear time', async () => {
    const chunk = new Uint8Array(1 << 20).fill(0x41)
    let sent = 0
    const endless = new ReadableStream<Uint8Array>({
      pull(controller) {
        sent++
        if (sent > 80) controller.close()
        else controller.enqueue(chunk)
      },
    })
    const started = performance.now()
    const err = await refusalOf(() => forEachLine(endless, () => undefined))
    expect(err.detail).toMatchObject({ maxLineBytes: 64 << 20 })
    expect(performance.now() - started).toBeLessThan(5_000)
  })
})
