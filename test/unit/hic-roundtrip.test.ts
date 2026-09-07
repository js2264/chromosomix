/**
 * The `.hic` reader, against files whose contents are known exactly.
 *
 * The bar is the one `test/golden/` sets for the cooler reader and
 * `bigwig-write.test.ts` sets for the writer: **exact equality on every stored
 * record**, for every encoding the format allows, because a contact map that is
 * approximately right is a figure that is wrong.
 *
 * The encodings are enumerated rather than sampled. Nine of the ten fields that
 * differ between versions 7, 8 and 9 are silent when misread — they shift the
 * cursor and produce plausible numbers rather than an error — so a suite that
 * exercised one file would prove nothing about the others.
 */

import { describe, expect, it } from 'vitest'

import { HicFile } from '@/hic/HicFile'
import { hicHandle } from '@/hic/handle'
import { HicStore } from '@/hic/store'
import { isHicMagic, parseHeader } from '@/hic/format'
import { planRead } from '@/metacooler/matrix'
import type { ByteSource, Extent, PixelChunk, SourceStats } from '@/types'
import { writeHic, type HicRecord } from '../support/hicWriter'

/**
 * The bytes as a {@link ByteSource}, with the reads counted.
 *
 * Counting matters as much as reading here: the claim that a `.hic` is opened
 * without touching its data is only worth making if something checks it, and
 * the assertion below is the same shape as the §12 budgets.
 */
class BytesSource implements ByteSource {
  readonly id = 'fixture.hic'
  readonly size: number
  readonly isRemote = false
  requests = 0
  bytesRead = 0

  constructor(private readonly data: Uint8Array) {
    this.size = data.byteLength
  }

  async mount(): Promise<string> {
    return this.id
  }

  readBytes(position: number, length: number): Uint8Array {
    const n = Math.max(0, Math.min(this.size - position, length))
    this.requests += 1
    this.bytesRead += n
    return this.data.subarray(position, position + n).slice()
  }

  stats(): SourceStats {
    return { requests: this.requests, bytes: this.bytesRead }
  }

  close(): void {}
}

const CHROMS = [
  { name: 'chr1', length: 30_000 },
  { name: 'chr2', length: 12_000 },
]
const BIN = 100

/**
 * A deterministic scatter of records, dense enough to cross several blocks.
 *
 * `intra` keeps the upper triangle only, which is what Juicer writes and what
 * the dense block encoding can represent: a dense block is a grid, so it holds
 * one value per cell, and a fixture with both `(a, b)` and `(b, a)` would be
 * asking the format for something no real file contains.
 */
function scatter(nx: number, ny: number, step: number, seed: number, intra = false): HicRecord[] {
  const out: HicRecord[] = []
  for (let x = 0; x < nx; x += step) {
    for (let y = intra ? x : 0; y < ny; y += step) {
      // A value that is distinct per cell, so a misplaced record is visible as
      // a wrong number rather than only as a wrong count.
      out.push({ x, y, value: ((x * 31 + y * 17 + seed) % 97) + 1 })
    }
  }
  return out
}

/** Records keyed by `"x,y"`, for a set comparison that names what differs. */
function indexOf(records: Iterable<{ x: number; y: number; value: number }>): Map<string, number> {
  const out = new Map<string, number>()
  for (const record of records) {
    const key = `${record.x},${record.y}`
    out.set(key, (out.get(key) ?? 0) + record.value)
  }
  return out
}

/** Everything a store hands back for a window, in global bins. */
async function readWindow(
  file: HicFile,
  rows: Extent,
  cols: Extent,
): Promise<Array<{ x: number; y: number; value: number }>> {
  const store = new HicStore(file)
  const out: Array<{ x: number; y: number; value: number }> = []
  await store.forEachWindow(rows, cols, planRead(rows, cols, 'symmetric-upper'), (chunk: PixelChunk) => {
    for (let i = 0; i < chunk.length; i++) {
      out.push({ x: chunk.bin1[i], y: chunk.bin2[i], value: chunk.count[i] })
    }
  })
  return out
}

interface Variant {
  name: string
  version: 7 | 8 | 9
  shortValues?: boolean
  shortPositions?: boolean
  dense?: boolean
  blockBinCount?: number
}

const VARIANTS: Variant[] = [
  { name: 'v8, float values, list of rows', version: 8, blockBinCount: 32 },
  { name: 'v8, short values', version: 8, shortValues: true, blockBinCount: 32 },
  { name: 'v8, dense blocks', version: 8, dense: true, blockBinCount: 32 },
  { name: 'v7, float values', version: 7, blockBinCount: 64 },
  { name: 'v9, int positions, diagonal blocks', version: 9, blockBinCount: 32 },
  { name: 'v9, short positions', version: 9, shortPositions: true, blockBinCount: 32 },
  { name: 'v9, short values and positions', version: 9, shortValues: true, shortPositions: true, blockBinCount: 32 },
  { name: 'v9, dense blocks', version: 9, dense: true, blockBinCount: 32 },
  { name: 'v9, one block per matrix', version: 9, blockBinCount: 4096 },
]

async function fixtureFor(variant: Variant): Promise<{
  file: HicFile
  source: BytesSource
  intra1: HicRecord[]
  intra2: HicRecord[]
  inter: HicRecord[]
}> {
  const n1 = Math.ceil(CHROMS[0].length / BIN)
  const n2 = Math.ceil(CHROMS[1].length / BIN)
  const intra1 = scatter(n1, n1, 7, 1, true)
  const intra2 = scatter(n2, n2, 5, 2, true)
  const inter = scatter(n1, n2, 11, 3)
  const written = await writeHic({
    version: variant.version,
    chroms: CHROMS,
    resolutions: [BIN],
    // File indices: `All` is 0, so chr1 is 1 and chr2 is 2.
    records: { '1_1': intra1, '2_2': intra2, '1_2': inter },
    ...(variant.blockBinCount === undefined ? {} : { blockBinCount: variant.blockBinCount }),
    ...(variant.shortValues === undefined ? {} : { shortValues: variant.shortValues }),
    ...(variant.shortPositions === undefined ? {} : { shortPositions: variant.shortPositions }),
    ...(variant.dense === undefined ? {} : { dense: variant.dense }),
  })
  const source = new BytesSource(written.bytes)
  return { file: HicFile.open(source), source, intra1, intra2, inter }
}

describe('the .hic header', () => {
  it('is recognised by its magic bytes and nothing else', async () => {
    const { source } = await fixtureFor(VARIANTS[0])
    expect(isHicMagic(source.readBytes(0, 4))).toBe(true)
    expect(isHicMagic(new Uint8Array([0x89, 0x48, 0x44, 0x46]))).toBe(false)
    expect(isHicMagic(new Uint8Array([0x48, 0x49]))).toBe(false)
  })

  it('refuses a version this reader has not seen, by number', async () => {
    const written = await writeHic({
      version: 8,
      chroms: CHROMS,
      resolutions: [BIN],
      records: { '1_1': [{ x: 0, y: 0, value: 1 }] },
    })
    // Version 6 predates the block index; the message must name the number
    // rather than say "unsupported file".
    new DataView(written.bytes.buffer).setInt32(4, 6, true)
    expect(() => parseHeader(written.bytes)).toThrowError(/version 6 .hic file/)
  })

  it('drops the synthetic All chromosome, and keeps the file indices straight', async () => {
    const { file } = await fixtureFor(VARIANTS[0])
    expect(file.chroms.map((chrom) => chrom.name)).toEqual(['chr1', 'chr2'])
    // The whole reason `All` cannot simply be sliced off and forgotten: every
    // master-index key is written against the file's own numbering.
    expect(file.fileIndexOf(0)).toBe(1)
    expect(file.fileIndexOf(1)).toBe(2)
  })

  it('opens without reading a single block', async () => {
    const written = await writeHic({
      version: 9,
      chroms: CHROMS,
      resolutions: [BIN],
      records: { '1_1': scatter(300, 300, 3, 1) },
      blockBinCount: 16,
    })
    const source = new BytesSource(written.bytes)
    HicFile.open(source)
    // Two reads for the header (probe, and the footer's leading length), plus
    // the footer window. Nothing that scales with the data.
    expect(source.requests).toBeLessThanOrEqual(4)
  })

  it('lays bins out end to end, exactly as a cooler does', async () => {
    const { file } = await fixtureFor(VARIANTS[0])
    expect(file.binSize).toBe(BIN)
    expect(Array.from(file.chromOffset)).toEqual([0, 300, 420])
    expect(file.nBins).toBe(420)
    expect(file.chromAt(0)).toBe(0)
    expect(file.chromAt(299)).toBe(0)
    expect(file.chromAt(300)).toBe(1)
    expect(file.chromsSpanning([250, 350])).toEqual([0, 1])
  })
})

describe.each(VARIANTS)('$name', (variant) => {
  it('returns every intra-chromosomal record, once, at the right bin', async () => {
    const { file, intra1 } = await fixtureFor(variant)
    const got = await readWindow(file, [0, 300], [0, 300])
    // The writer stores the upper triangle, so the expectation folds the same
    // way. A reader that emitted both halves would show up as doubled values.
    const want = indexOf(
      intra1.map((r) => ({
        x: Math.min(r.x, r.y),
        y: Math.max(r.x, r.y),
        value: r.value,
      })),
    )
    expect(indexOf(got)).toEqual(want)
  })

  it('returns the off-diagonal block between two chromosomes', async () => {
    const { file, inter } = await fixtureFor(variant)
    const got = await readWindow(file, [0, 300], [300, 420])
    const want = indexOf(inter.map((r) => ({ x: r.x, y: 300 + r.y, value: r.value })))
    expect(indexOf(got)).toEqual(want)
  })

  it('is symmetric about the axes: the transposed window reads the same', async () => {
    const { file } = await fixtureFor(variant)
    const forward = indexOf(await readWindow(file, [0, 300], [300, 420]))
    const back = indexOf(await readWindow(file, [300, 420], [0, 300]))
    // Stored orientation is upper-triangular in both directions, so the two
    // reads are the same set — which is what lets `planRead` handle a `.hic`
    // with no case of its own.
    expect(back).toEqual(forward)
  })

  it('clips to a narrow window without losing a record inside it', async () => {
    const { file, intra1 } = await fixtureFor(variant)
    const rows: Extent = [40, 90]
    const cols: Extent = [120, 210]
    const got = indexOf(await readWindow(file, rows, cols))
    const want = indexOf(
      intra1
        .map((r) => ({ x: Math.min(r.x, r.y), y: Math.max(r.x, r.y), value: r.value }))
        .filter(
          (r) =>
            (r.x >= rows[0] && r.x < rows[1] && r.y >= cols[0] && r.y < cols[1]) ||
            (r.y >= rows[0] && r.y < rows[1] && r.x >= cols[0] && r.x < cols[1]),
        ),
    )
    // Every record the window contains is present. The reader may return more
    // — a block is the index's unit, so an edge block comes back whole — and
    // `scatterDense` discards those, so the assertion is containment plus an
    // exact match on the cells inside.
    for (const [key, value] of want) expect(got.get(key)).toBe(value)
  })

  it('finds nothing where the file holds nothing, without failing', async () => {
    const { file } = await fixtureFor(variant)
    const got = await readWindow(file, [0, 5], [0, 5])
    for (const record of got) {
      expect(record.x).toBeLessThan(300)
      expect(record.y).toBeLessThan(300)
    }
  })

  it('scans every stored pixel exactly once', async () => {
    const { file, intra1, intra2, inter } = await fixtureFor(variant)
    const store = new HicStore(file)
    const seen: Array<{ x: number; y: number; value: number }> = []
    await store.scanAll({
      onChunk: (chunk) => {
        for (let i = 0; i < chunk.length; i++) {
          seen.push({ x: chunk.bin1[i], y: chunk.bin2[i], value: chunk.count[i] })
        }
      },
    })
    const want = indexOf([
      ...intra1.map((r) => ({ x: Math.min(r.x, r.y), y: Math.max(r.x, r.y), value: r.value })),
      ...intra2.map((r) => ({
        x: 300 + Math.min(r.x, r.y),
        y: 300 + Math.max(r.x, r.y),
        value: r.value,
      })),
      ...inter.map((r) => ({ x: r.x, y: 300 + r.y, value: r.value })),
    ])
    expect(indexOf(seen)).toEqual(want)
  })
})

describe('the cooler-shaped handle', () => {
  it('answers the questions MetaCooler asks at open', async () => {
    const { file } = await fixtureFor(VARIANTS[0])
    const handle = hicHandle('fixture.hic', file)
    const attrs = handle.attrs()
    expect(attrs['bin-size']).toBe(BIN)
    expect(attrs['bin-type']).toBe('fixed')
    expect(attrs['storage-mode']).toBe('symmetric-upper')
    expect(attrs.ordering).toBe('genome-then-length')
    expect(attrs.nbins).toBe(420)
    expect(attrs.ncontigs).toBe(2)
    // Neither is stated by the format, and `validateLight` skips a declared
    // value that is null rather than comparing against a fabrication.
    expect(attrs.nnz).toBeNull()
    expect(attrs.sum).toBeNull()

    const table = handle.readTable('chroms')
    expect(table.strings('name')).toEqual(['chr1', 'chr2'])
    expect(table.numbers('length')).toEqual([30_000, 12_000])
    expect(Array.from(handle.readNumeric('indexes/chrom_offset'))).toEqual([0, 300, 420])
  })

  it('offers the resolution ladder as entries, so the picker needs no new code', async () => {
    const written = await writeHic({
      version: 9,
      chroms: CHROMS,
      resolutions: [100, 500, 2500],
      records: { '1_1': [{ x: 0, y: 0, value: 5 }] },
    })
    const file = HicFile.open(new BytesSource(written.bytes))
    const handle = hicHandle('fixture.hic', file)
    expect(handle.rootEntries).toEqual(['100', '500', '2500'])
    expect(handle.rootEntryGroup).toBe('resolutions')
  })

  it('refuses the pixel datasets by name rather than inventing them', async () => {
    const { file } = await fixtureFor(VARIANTS[0])
    const handle = hicHandle('fixture.hic', file)
    expect(() => handle.readNumeric('indexes/bin1_offset')).toThrowError(
      /indexed per chromosome pair and per block/,
    )
    expect(() => handle.readInt32('pixels/bin1_id')).toThrowError(/PixelStore/)
  })

  it('serves normalisation vectors as weights, inverted into cooler s convention', async () => {
    // Divisors on the way in; `bins/weight` is a multiplier, so what comes back
    // is the reciprocal. A zero divisor is a dropped bin and becomes NaN, which
    // is what a balanced cooler writes for one.
    const divisors = new Float64Array([2, 4, 0, 1])
    const written = await writeHic({
      version: 8,
      chroms: [{ name: 'chr1', length: 400 }],
      resolutions: [BIN],
      records: { '1_1': [{ x: 0, y: 0, value: 1 }] },
      norms: { [`KR/1/${BIN}`]: divisors },
    })
    const file = HicFile.open(new BytesSource(written.bytes))
    expect(file.normType).toBe('KR')
    const handle = hicHandle('fixture.hic', file)
    expect(handle.has('bins/weight')).toBe(true)
    const weights = Array.from(handle.readNumeric('bins/weight', 0, 4))
    expect(weights[0]).toBeCloseTo(0.5, 12)
    expect(weights[1]).toBeCloseTo(0.25, 12)
    expect(weights[2]).toBeNaN()
    expect(weights[3]).toBeCloseTo(1, 12)
  })

  it('says there are no weights when the file carries none', async () => {
    const { file } = await fixtureFor(VARIANTS[0])
    expect(file.normType).toBeNull()
    const handle = hicHandle('fixture.hic', file)
    expect(handle.has('bins/weight')).toBe(false)
    expect(() => handle.readNumeric('bins/weight')).toThrowError(/no normalisation vectors/)
  })
})

describe('the .hic store', () => {
  it('has no per-bin density index, and says why', async () => {
    const { file } = await fixtureFor(VARIANTS[0])
    expect(() => new HicStore(file).binOffsets()).toThrowError(/no per-bin pixel index/)
  })

  it('refuses a value column the format cannot carry', async () => {
    const { file } = await fixtureFor(VARIANTS[0])
    const store = new HicStore(file)
    await expect(
      store.forEachWindow([0, 10], [0, 10], planRead([0, 10], [0, 10], 'symmetric-upper'), () => {}, {
        value: 'expected',
      }),
    ).rejects.toThrowError(/one value per record/)
  })

  it('reports no record count rather than guessing one', async () => {
    const { file } = await fixtureFor(VARIANTS[0])
    expect(new HicStore(file).nnz).toBeNull()
    expect(new HicStore(file).scoreColumns()).toEqual(['count'])
  })

  it('walks a set of bands without emitting a pair twice', async () => {
    const { file, intra1, inter } = await fixtureFor(VARIANTS[4])
    const store = new HicStore(file)
    const seen: Array<{ x: number; y: number; value: number }> = []
    // Two bands on the same chromosome. The pair they share must be visited
    // once: every accumulator above this is additive, so a second visit is a
    // doubled cell in a picture that still looks like a contact map.
    await store.forEachBands(
      [
        [0, 50],
        [100, 150],
      ],
      (chunk) => {
        for (let i = 0; i < chunk.length; i++) {
          seen.push({ x: chunk.bin1[i], y: chunk.bin2[i], value: chunk.count[i] })
        }
      },
    )
    const folded = indexOf([
      ...intra1.map((r) => ({ x: Math.min(r.x, r.y), y: Math.max(r.x, r.y), value: r.value })),
      ...inter.map((r) => ({ x: r.x, y: 300 + r.y, value: r.value })),
    ])
    for (const [key, value] of indexOf(seen)) {
      expect(folded.get(key)).toBe(value)
    }
  })

  it('stops where a cancel says to', async () => {
    const { file } = await fixtureFor(VARIANTS[0])
    const store = new HicStore(file)
    let chunks = 0
    const finished = await store.forEachWindow(
      [0, 420],
      [0, 420],
      planRead([0, 420], [0, 420], 'symmetric-upper'),
      () => {
        chunks += 1
      },
      { cancelled: () => chunks >= 1 },
    )
    expect(finished).toBe(false)
  })
})
