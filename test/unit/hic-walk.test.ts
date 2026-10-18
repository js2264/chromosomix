/**
 * A `.hic` walked pair by pair: what the walk reads, and what it holds up.
 *
 * The census of §6.5 walks every chromosome pair of a `.hic` at its coarsest
 * rung, in the background, on the thread every view reads through — and it
 * starts the moment a `.hic` opens. On a 5 GB 4DN map (4DNFI916JQ1Y: mouse,
 * thirteen rungs, 231 pairs) it read every pair's matrix record **whole**
 * before its first pixel — thirteen resolutions of block index, 70 MB, rounded
 * out to 281 MiB of 1 MiB chunks — synchronously, so the request the loading
 * screen was waiting for sat behind all of it; then it pulled a 1 MiB chunk
 * around each kilobyte block. 436 requests and 500 MiB to count the contacts,
 * and a spinner for as long as the first half took.
 *
 * What is pinned here is what makes that impossible: the pairs are listed from
 * the master index without a read; a record is read only as far as the rung;
 * the walk yields before it reads; and on a remote file it reads exact ranges
 * that neither pay for the chunk around them nor evict a chunk a view wants.
 *
 * And what made the whole genome of a remote `.hic` a minute and a half: read
 * pair by pair, a record's head and then its blocks, a 4DN chicken map's 630
 * pairs were 1,260 round trips. A walk is now planned — every place it reads is
 * known before it reads — and the heads, the blocks past each record and the
 * blocks left over are each read together, as the few stretches of the file
 * they make, in whichever layout the file was written.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { MetaCooler } from '@/metacooler/MetaCooler'
import { RECORD_HEAD_BYTES, blockRuns, findZoom, readZoom, type BlockRef } from '@/hic/blocks'
import { readFooter, readHeader, type HicFooter } from '@/hic/format'
import { HicFile } from '@/hic/HicFile'
import { HicStore } from '@/hic/store'
import { LocalFileSource } from '@/sources/LocalFileSource'
import { RemoteRangeSource } from '@/sources/RemoteRangeSource'
import { createSource, releaseSources } from '@/worker/sources'
import type { ByteSource, PixelChunk, SourceStats } from '@/types'
import { writeHic, type HicRecord } from '../support/hicWriter'

// ---------------------------------------------------------------------------
// The fixture: four chromosomes, contacts at 10 kb, three rungs coarsest first
// ---------------------------------------------------------------------------

const CHROMS = Array.from({ length: 4 }, (_, i) => ({ name: `chr${i + 1}`, length: 3_000_000 + i * 400_000 }))
/** Coarsest first, as Juicer writes them — which is what puts the coarse rung at a record's head. */
const RESOLUTIONS = [1_000_000, 100_000, 10_000]
const FINE = 10_000
const COARSE = 1_000_000

/** A seeded generator, so the fixture is the same file on every run. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/**
 * Contacts at the finest rung, decaying from the diagonal within a chromosome
 * and scattered between two — so the fine rung's block index is many times the
 * size of a record's head, as a real file's is.
 */
function contacts(): { records: Record<string, HicRecord[]>; total: number } {
  const random = mulberry32(7)
  const records: Record<string, HicRecord[]> = {}
  let total = 0
  for (let a = 1; a <= CHROMS.length; a++) {
    for (let b = a; b <= CHROMS.length; b++) {
      const na = Math.ceil(CHROMS[a - 1].length / FINE)
      const nb = Math.ceil(CHROMS[b - 1].length / FINE)
      const cells = new Map<string, HicRecord>()
      const n = a === b ? 3_000 : 1_500
      for (let k = 0; k < n; k++) {
        const x = Math.floor(random() * na)
        const y =
          a === b ? Math.min(na - 1, x + Math.floor(-Math.log(1 - random()) * 20)) : Math.floor(random() * nb)
        const key = `${x}:${y}`
        const held = cells.get(key)
        if (held === undefined) cells.set(key, { x, y, value: 1 })
        else held.value += 1
        total += 1
      }
      // File indices: `All` is index 0, so display chromosome i is file i + 1.
      records[`${a}_${b}`] = [...cells.values()]
    }
  }
  return { records, total }
}

interface Fixture {
  bytes: Uint8Array
  total: number
  pairs: number
}

function fixture(): Promise<Fixture> {
  return laidOut({})
}

/** Each layout, written once: every test of it reads the same bytes. */
const layouts = new Map<string, Promise<Fixture>>()

/**
 * The fixture's contacts, written another way: as Juicer lays out a v8 file —
 * each record before its own blocks — or as a v9 file, or with each pair's
 * record and blocks `padding` bytes from the next.
 */
function laidOut(options: { interleaved?: boolean; padding?: number; version?: 8 | 9 }): Promise<Fixture> {
  const key = JSON.stringify([options.interleaved ?? false, options.padding ?? 0, options.version ?? 8])
  let written = layouts.get(key)
  if (written === undefined) {
    written = (async () => {
      const { records, total } = contacts()
      const file = await writeHic({
        version: options.version ?? 8,
        chroms: CHROMS,
        resolutions: RESOLUTIONS,
        records,
        blockBinCount: 8,
        rebin: true,
        interleaved: options.interleaved,
        padding: options.padding,
      })
      return { bytes: file.bytes, total, pairs: Object.keys(records).length }
    })()
    layouts.set(key, written)
  }
  return written
}

/**
 * Every read a `.hic` makes, and which kind — in memory, with nothing cached.
 *
 * Its exact reads answer a macrotask later, as a request over the network
 * does, so a walk that keeps several in flight can be seen doing it.
 */
class RecordingSource implements ByteSource {
  readonly id = 'walk.hic'
  readonly size: number
  readonly reads: Array<{ exact: boolean; position: number; length: number }> = []
  /** Exact reads asked for and not yet answered, now and at most. */
  inFlight = 0
  mostInFlight = 0

  constructor(
    private readonly data: Uint8Array,
    readonly isRemote = true,
  ) {
    this.size = data.byteLength
  }

  async mount(): Promise<string> {
    return this.id
  }

  readBytes(position: number, length: number): Uint8Array {
    this.reads.push({ exact: false, position, length })
    return this.slice(position, length)
  }

  async readExact(position: number, length: number): Promise<Uint8Array> {
    this.reads.push({ exact: true, position, length })
    this.inFlight += 1
    this.mostInFlight = Math.max(this.mostInFlight, this.inFlight)
    await new Promise((resolve) => setTimeout(resolve, 1))
    this.inFlight -= 1
    return this.slice(position, length)
  }

  private slice(position: number, length: number): Uint8Array {
    const n = Math.max(0, Math.min(this.size - position, length))
    return this.data.subarray(position, position + n).slice()
  }

  stats(): SourceStats {
    return { requests: this.reads.length, bytes: this.reads.reduce((sum, read) => sum + read.length, 0) }
  }

  close(): void {}
}

function footerOf(bytes: Uint8Array): HicFooter {
  const source = new RecordingSource(bytes)
  return readFooter(source, readHeader(source))
}

// ---------------------------------------------------------------------------
// A remote file, over a synchronous XMLHttpRequest that answers from memory
// ---------------------------------------------------------------------------

const URL_UNDER_TEST = 'https://bucket.test/walk.hic'
let served: Uint8Array = new Uint8Array(0)
/** Every range the stub was asked for, inclusive at both ends as `Range` spells it. */
const ranges: Array<[number, number]> = []

class RangeXhr {
  status = 0
  response: ArrayBuffer | null = null
  responseType = ''
  private range: [number, number] = [0, 0]

  open(_method: string, _url: string, _async: boolean): void {}

  setRequestHeader(name: string, value: string): void {
    if (name.toLowerCase() !== 'range') return
    const match = /^bytes=(\d+)-(\d+)$/.exec(value)
    if (match === null) throw new Error(`unsupported Range header: ${value}`)
    this.range = [Number(match[1]), Number(match[2])]
  }

  send(): void {
    const [from, to] = this.range
    const end = Math.min(to, served.byteLength - 1)
    ranges.push([from, end])
    this.status = 206
    this.response = served.slice(from, end + 1).buffer
  }

  getResponseHeader(name: string): string | null {
    if (name.toLowerCase() !== 'content-range') return null
    return `bytes ${this.range[0]}-${Math.min(this.range[1], served.byteLength - 1)}/${served.byteLength}`
  }
}

/**
 * `fetch`: the `HEAD` probe — a length and ranges, which is all an S3 bucket
 * says — and the exact reads, which come through `fetch` rather than the
 * synchronous request and are held to the same rule: a range, or nothing.
 */
const probe = (async (_url: string, init?: { method?: string; headers?: HeadersInit }) => {
  if (init?.method === 'HEAD') {
    return new Response(null, {
      status: 200,
      headers: { 'content-length': String(served.byteLength), 'accept-ranges': 'bytes' },
    })
  }
  const range = new Headers(init?.headers).get('range')
  const match = range === null ? null : /^bytes=(\d+)-(\d+)$/.exec(range)
  if (init?.method !== 'GET' || match === null) throw new Error(`unexpected request: ${init?.method} ${range}`)
  const from = Number(match[1])
  const end = Math.min(Number(match[2]), served.byteLength - 1)
  ranges.push([from, end])
  return new Response(served.slice(from, end + 1), {
    status: 206,
    headers: { 'content-range': `bytes ${from}-${end}/${served.byteLength}` },
  })
}) as unknown as typeof fetch

const saved: Record<string, unknown> = {}

function stub(key: string, value: unknown): void {
  const g = globalThis as Record<string, unknown>
  if (!(key in saved)) saved[key] = g[key]
  g[key] = value
}

beforeEach(() => {
  ranges.length = 0
})

afterEach(() => {
  const g = globalThis as Record<string, unknown>
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete g[key]
    else g[key] = value
  }
  for (const key of Object.keys(saved)) delete saved[key]
  releaseSources()
})

async function remote(chunkSize = 64 << 10): Promise<RemoteRangeSource> {
  served = (await fixture()).bytes
  stub('XMLHttpRequest', RangeXhr)
  ranges.length = 0
  return RemoteRangeSource.open(URL_UNDER_TEST, { fetchImpl: probe, chunkSize })
}

// ---------------------------------------------------------------------------

describe('a matrix record, read as far as one resolution', () => {
  it('finds the coarsest rung in the head of the record, in one read', async () => {
    const { bytes } = await fixture()
    const entry = footerOf(bytes).masterIndex.get('1_2')!
    // The fixture is doing its job: this record is several heads long.
    expect(entry.size).toBeGreaterThan(2 * RECORD_HEAD_BYTES)
    const source = new RecordingSource(bytes)
    const found = readZoom((p, l) => source.readBytes(p, l), entry, 'BP', COARSE, RECORD_HEAD_BYTES)
    expect(found.beyondHead).toBe(false)
    expect(found.zoom?.binSize).toBe(COARSE)
    expect(source.reads.map((r) => [r.position, r.length])).toEqual([[entry.position, RECORD_HEAD_BYTES]])
  })

  it('reads the rest of the record for a rung past the head, and says the head was not enough', async () => {
    const { bytes } = await fixture()
    const entry = footerOf(bytes).masterIndex.get('1_2')!
    const source = new RecordingSource(bytes)
    const found = readZoom((p, l) => source.readBytes(p, l), entry, 'BP', FINE, RECORD_HEAD_BYTES)
    expect(found.beyondHead).toBe(true)
    expect(found.zoom?.binSize).toBe(FINE)
    expect(source.reads.map((r) => [r.position, r.length])).toEqual([
      [entry.position, RECORD_HEAD_BYTES],
      [entry.position, entry.size],
    ])
  })

  it('reads the record whole at once when there is no head to try', async () => {
    const { bytes } = await fixture()
    const entry = footerOf(bytes).masterIndex.get('1_2')!
    const source = new RecordingSource(bytes)
    const found = readZoom((p, l) => source.readBytes(p, l), entry, 'BP', FINE, 0)
    expect(found.beyondHead).toBe(false)
    expect(source.reads.map((r) => [r.position, r.length])).toEqual([[entry.position, entry.size]])
  })

  it('answers null for a resolution the pair was not written at, once every header is read', async () => {
    const { bytes } = await fixture()
    const footer = footerOf(bytes)
    for (const entry of footer.masterIndex.values()) {
      const source = new RecordingSource(bytes)
      const found = readZoom((p, l) => source.readBytes(p, l), entry, 'BP', 5_000, RECORD_HEAD_BYTES)
      expect(found.zoom).toBeNull()
    }
  })

  it('gives the same index at every rung, whichever way the record was read', async () => {
    const { bytes } = await fixture()
    const source = new RecordingSource(bytes)
    for (const entry of footerOf(bytes).masterIndex.values()) {
      const whole = source.readBytes(entry.position, entry.size)
      for (const binSize of RESOLUTIONS) {
        const expected = findZoom(whole, 'BP', binSize)
        for (const head of [0, 64, RECORD_HEAD_BYTES]) {
          const found = readZoom((p, l) => source.readBytes(p, l), entry, 'BP', binSize, head)
          expect(found.zoom).toEqual(expected)
        }
      }
    }
  })

  it('never answers from a head that stopped inside a header', async () => {
    const { bytes } = await fixture()
    const entry = footerOf(bytes).masterIndex.get('3_3')!
    const whole = new RecordingSource(bytes).readBytes(entry.position, entry.size)
    // Every cut of the record short of its end either finds what the whole
    // record finds, or throws — the signal to read further — and never
    // reports a rung missing that is there.
    for (let cut = 0; cut < Math.min(whole.byteLength, 400); cut++) {
      for (const binSize of RESOLUTIONS) {
        let found: ReturnType<typeof findZoom> | 'threw'
        try {
          found = findZoom(whole.subarray(0, cut), 'BP', binSize)
        } catch (err) {
          expect(err).toBeInstanceOf(RangeError)
          found = 'threw'
        }
        if (found !== 'threw') expect(found).toEqual(findZoom(whole, 'BP', binSize))
      }
    }
  })
})

describe('blocks read together', () => {
  const ref = (number: number, position: number, size: number): BlockRef => ({ number, position, size })

  it('reads blocks that sit end to end as one stretch, and splits where they do not', () => {
    const runs = blockRuns([ref(3, 300, 100), ref(1, 100, 100), ref(2, 200, 100), ref(9, 10_000, 50)], 0, 1 << 20)
    expect(runs.map((run) => [run.position, run.length, run.refs.map((r) => r.number)])).toEqual([
      [100, 300, [1, 2, 3]],
      [10_000, 50, [9]],
    ])
  })

  it('reads through a gap no wider than it is told to', () => {
    const blocks = [ref(1, 0, 100), ref(2, 150, 100)]
    expect(blockRuns(blocks, 50, 1 << 20)).toHaveLength(1)
    expect(blockRuns(blocks, 49, 1 << 20)).toHaveLength(2)
  })

  it('stops a stretch at the cap', () => {
    const blocks = [ref(1, 0, 100), ref(2, 100, 100), ref(3, 200, 100)]
    expect(blockRuns(blocks, 0, 200).map((run) => run.refs.length)).toEqual([2, 1])
  })
})

describe('an exact read of a remote file', () => {
  it('is one request for exactly the bytes, and is not kept', async () => {
    const source = await remote()
    const got = await source.readExact(100_000, 300)
    expect(Array.from(got)).toEqual(Array.from(served.subarray(100_000, 100_300)))
    expect(ranges).toEqual([[100_000, 100_299]])
    expect(source.cachedChunkCount()).toBe(0)
    // The probe, and the one read.
    expect(source.stats()).toEqual({ requests: 2, bytes: 300 })
  })

  it('is answered from the chunks already held, for nothing', async () => {
    const source = await remote()
    source.readBytes(0, 10)
    ranges.length = 0
    expect(Array.from(await source.readExact(100, 300))).toEqual(Array.from(served.subarray(100, 400)))
    expect(ranges).toEqual([])
  })

  it('stops at the end of the file', async () => {
    const source = await remote()
    const got = await source.readExact(served.byteLength - 10, 100)
    expect(got.byteLength).toBe(10)
  })

  it('reaches a borrower of the worker’s mount, which is how every open reads', async () => {
    served = (await fixture()).bytes
    stub('XMLHttpRequest', RangeXhr)
    stub('fetch', probe)
    const source = await createSource({ kind: 'remote', url: URL_UNDER_TEST })
    expect(source.readExact).toBeTypeOf('function')
    ranges.length = 0
    await source.readExact!(5_000, 64)
    expect(ranges).toEqual([[5_000, 5_063]])
  })
})

describe('the census of a .hic, walked pair by pair (§6.5)', () => {
  it('lists the pairs it will walk without reading a byte', async () => {
    const { bytes, pairs } = await fixture()
    const source = new RecordingSource(bytes)
    const file = HicFile.open(source, { binSize: COARSE })
    source.reads.length = 0
    expect(file.indexedPairs()).toHaveLength(pairs)
    expect(source.reads).toEqual([])
  })

  it('reads nothing before it first yields, so a request already queued is answered first', async () => {
    const { bytes } = await fixture()
    const source = new RecordingSource(bytes)
    const mc = MetaCooler.fromHic(`walk.hic::/resolutions/${COARSE}`, source)
    source.reads.length = 0
    const counting = mc.countContacts()
    // Synchronously, straight after the census was started: the reads under it
    // are synchronous on the worker, so anything read here is time every other
    // request to the reader spends waiting — the loading screen's included.
    expect(source.reads).toEqual([])
    await counting
    mc.close()
  })

  it('stands aside for as long as it is told to, and reads nothing meanwhile (§12)', async () => {
    const { bytes, total } = await fixture()
    const source = new RecordingSource(bytes)
    const mc = MetaCooler.fromHic(`walk.hic::/resolutions/${COARSE}`, source)
    source.reads.length = 0
    // A view is reading: every step waits until it is let go.
    let release: () => void = () => undefined
    let held = true
    let asked = 0
    const counting = mc.countContacts({
      pause: () => {
        asked += 1
        return held ? new Promise<void>((resolve) => (release = resolve)) : Promise.resolve()
      },
    })
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(asked).toBe(1)
    expect(source.reads).toEqual([])
    held = false
    release()
    expect(await counting).toBe(total)
    expect(asked).toBeGreaterThan(1)
    mc.close()
  })

  it('stops standing aside once a resample is waiting on it, which would otherwise never end', async () => {
    const { bytes, total } = await fixture()
    const mc = MetaCooler.fromHic(`walk.hic::/resolutions/${COARSE}`, new RecordingSource(bytes))
    // A pause that only a wait on the census can end: the resample below is a
    // request somebody is waiting for, so the views are never quiet while it runs.
    const counting = mc.countContacts({
      pause: (wanted) =>
        new Promise<void>((resolve) => {
          const poll = setInterval(() => {
            if (!wanted()) return
            clearInterval(poll)
            resolve()
          }, 2)
        }),
    })
    await new Promise((resolve) => setTimeout(resolve, 10))
    await mc.resample({ contacts: Math.floor(total / 2), seed: 1 })
    expect(await counting).toBe(total)
    mc.close()
  })

  it('reads a plan’s records together, then its blocks, before it hands over its first pixels', async () => {
    const { bytes, pairs } = await fixture()
    const source = new RecordingSource(bytes)
    const file = HicFile.open(source, { binSize: COARSE })
    const store = new HicStore(file)
    source.reads.length = 0
    let atFirst = -1
    await store.scanAll({
      chunkSize: 1,
      onChunk: () => {
        if (atFirst < 0) atFirst = source.reads.length
        return true
      },
    })
    // Every pair is one plan at this rung. This layout keeps every record after
    // every block: one read for the heads, which lie end to end, and one for
    // the blocks — where pair by pair it was a head and a block for each.
    expect(file.walkPlans(file.indexedPairs())).toHaveLength(1)
    expect(pairs).toBe(10)
    expect(source.reads).toHaveLength(2)
    expect(source.reads.every((read) => read.exact)).toBe(true)
    expect(atFirst).toBe(source.reads.length)
  })

  it('reads a record’s coarse blocks with its head, where Juicer put them just past it', async () => {
    const { bytes, pairs, total } = await laidOut({ interleaved: true, padding: 1 << 20 })
    const source = new RecordingSource(bytes)
    const file = HicFile.open(source, { binSize: COARSE })
    source.reads.length = 0
    let sum = 0
    await new HicStore(file).scanAll({
      onChunk: (chunk) => {
        for (let i = 0; i < chunk.length; i++) sum += chunk.count[i]
        return true
      },
    })
    expect(sum).toBe(total)
    // A megabyte between pairs is not read through: one read a pair, from its
    // record's first byte to the bytes past its end, and none for its blocks.
    expect(source.reads).toHaveLength(pairs)
    const records = new Map([...footerOf(bytes).masterIndex.values()].map((entry) => [entry.position, entry]))
    for (const read of source.reads) {
      expect(read.exact).toBe(true)
      expect(read.length).toBe(records.get(read.position)!.size + (4 << 10))
    }
  })

  it('keeps no more reads out than a census may, and hands the pixels over in order', async () => {
    const { bytes } = await laidOut({ interleaved: true, padding: 1 << 20 })
    const source = new RecordingSource(bytes)
    const file = HicFile.open(source, { binSize: COARSE })
    expect(file.walkAhead()).toBe(4)
    const order: number[] = []
    await new HicStore(file).scanAll({
      chunkSize: 1,
      onChunk: (chunk) => {
        order.push(chunk.bin1[0])
        return true
      },
      // The census is told to stand aside while a view reads: that is what makes it one.
      pause: () => Promise.resolve(),
    })
    // Pairs a megabyte apart are read apart, several at once and never more.
    expect(source.mostInFlight).toBeGreaterThan(1)
    expect(source.mostInFlight).toBeLessThanOrEqual(file.walkAhead())
    // `indexedPairs` order, which is ascending in the lower chromosome.
    expect(order).toEqual([...order].sort((x, y) => x - y))
  })

  it('lets a picture’s walk have every connection a browser opens to one host', async () => {
    const { bytes } = await laidOut({ interleaved: true, padding: 1 << 20 })
    const source = new RecordingSource(bytes)
    const file = HicFile.open(source, { binSize: COARSE })
    await new HicStore(file).forEachWindow([0, file.nBins], [0, file.nBins], {} as never, () => undefined)
    expect(source.mostInFlight).toBeGreaterThan(file.walkAhead())
    expect(source.mostInFlight).toBeLessThanOrEqual(6)
  })

  it('reads one pair at a time at a rung where one pair could fill the budget', async () => {
    const written = await writeHic({
      version: 8,
      chroms: [
        { name: 'chrBig', length: 250_000_000 },
        { name: 'chrSmall', length: 1_000_000 },
        { name: 'chrSmaller', length: 500_000 },
      ],
      resolutions: [10_000],
      records: { '1_1': [{ x: 0, y: 0, value: 1 }] },
    })
    const file = HicFile.open(new RecordingSource(written.bytes))
    expect(file.walkAhead()).toBe(1)
    // And plans each such pair on its own — a plan is held, decoded, until its
    // last pair is handed over — and the small ones after it together.
    expect(file.walkPlans(file.indexedPairs()).map((plan) => plan.length)).toEqual([1])
    const pairs: Array<readonly [number, number]> = [[0, 0], [0, 1], [1, 1], [1, 2], [2, 2]]
    expect(file.walkPlans(pairs).map((plan) => plan.length)).toEqual([1, 1, 3])
  })

  it('counts the same contacts at the coarsest rung as at the finest, which are the ones written', async () => {
    const { bytes, total } = await fixture()
    const coarse = MetaCooler.fromHic(`walk.hic::/resolutions/${COARSE}`, new RecordingSource(bytes))
    const fine = MetaCooler.fromHic(`walk.hic::/resolutions/${FINE}`, new RecordingSource(bytes))
    try {
      expect(await coarse.countContacts()).toBe(total)
      expect(await fine.countContacts()).toBe(total)
    } finally {
      coarse.close()
      fine.close()
    }
  })

  it('reads over the network in exact ranges, a few for the whole genome, and keeps none of it', async () => {
    const { bytes, pairs } = await fixture()
    const source = await remote()
    const mc = MetaCooler.fromHic(`${URL_UNDER_TEST}::/resolutions/${COARSE}`, source)
    const held = source.cachedChunkCount()
    source.resetStats()
    try {
      await mc.countContacts()
      const { requests, bytes: read } = source.stats()
      // The heads together and the blocks together, where pair by pair it was
      // two requests a pair.
      expect(requests).toBeLessThanOrEqual(2)
      expect(requests).toBeLessThan(pairs)
      expect(read).toBeLessThan(bytes.byteLength)
      // Every read the walk made is its own range; the chunks a view reads
      // through are as the open left them.
      expect(source.cachedChunkCount()).toBe(held)
    } finally {
      mc.close()
    }
  })

  it('does not read through the distance between records far apart, over the network', async () => {
    const padded = await laidOut({ interleaved: true, padding: 1 << 20 })
    const footer = footerOf(padded.bytes)
    // The most the walk may read: each record, its head through to the bytes
    // past its end, and nothing of the megabyte after them.
    const bound = [...footer.masterIndex.values()].reduce((sum, entry) => sum + entry.size + (4 << 10), 0)
    served = padded.bytes
    stub('XMLHttpRequest', RangeXhr)
    const source = await RemoteRangeSource.open(URL_UNDER_TEST, { fetchImpl: probe, chunkSize: 64 << 10 })
    const mc = MetaCooler.fromHic(`${URL_UNDER_TEST}::/resolutions/${COARSE}`, source)
    source.resetStats()
    try {
      expect(await mc.countContacts()).toBe(padded.total)
      const { requests, bytes: read } = source.stats()
      // One request a pair at most: the open's chunks may already hold a record.
      expect(requests).toBeLessThanOrEqual(padded.pairs)
      expect(read).toBeLessThanOrEqual(bound)
    } finally {
      mc.close()
    }
  })

  it('reads a window inside one chromosome through the chunks a pan comes back to', async () => {
    const { bytes } = await fixture()
    const source = new RecordingSource(bytes)
    const file = HicFile.open(source, { binSize: FINE })
    source.reads.length = 0
    const store = new HicStore(file)
    const extent = file.chromExtent(2)
    await store.forEachWindow(extent, extent, {} as never, () => undefined)
    expect(source.reads.length).toBeGreaterThan(0)
    expect(source.reads.every((read) => !read.exact)).toBe(true)
  })

  it('reads a window across chromosomes as a walk, in exact ranges', async () => {
    const { bytes } = await fixture()
    const source = new RecordingSource(bytes)
    const file = HicFile.open(source, { binSize: COARSE })
    source.reads.length = 0
    let sum = 0
    await new HicStore(file).forEachWindow([0, file.nBins], [0, file.nBins], {} as never, (chunk) => {
      for (let i = 0; i < chunk.length; i++) sum += chunk.count[i]
    })
    expect(sum).toBe((await fixture()).total)
    expect(source.reads.length).toBeGreaterThan(0)
    expect(source.reads.every((read) => read.exact)).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// A walk read a plan at a time draws what one read pair by pair draws
// ---------------------------------------------------------------------------

/** The same file with no exact reads: what a walk read pair by pair, through the ordinary reads, saw. */
class PlainSource implements ByteSource {
  readonly id = 'plain.hic'
  readonly isRemote = false
  readonly size: number

  constructor(private readonly data: Uint8Array) {
    this.size = data.byteLength
  }

  async mount(): Promise<string> {
    return this.id
  }

  readBytes(position: number, length: number): Uint8Array {
    return this.data.subarray(position, Math.min(this.size, position + length)).slice()
  }

  stats(): SourceStats {
    return { requests: 0, bytes: 0 }
  }

  close(): void {}
}

/** Every chunk a read hands over, flattened in order, so two reads can be compared pixel for pixel. */
async function drawn(
  source: ByteSource,
  binSize: number,
  read: (store: HicStore, file: HicFile, onChunk: (chunk: PixelChunk) => void) => Promise<unknown>,
): Promise<Array<[number, number, number]>> {
  const file = HicFile.open(source, { binSize })
  const out: Array<[number, number, number]> = []
  await read(new HicStore(file), file, (chunk) => {
    for (let i = 0; i < chunk.length; i++) out.push([chunk.bin1[i], chunk.bin2[i], chunk.count[i]])
  })
  return out
}

describe('a walk read a plan at a time', () => {
  const layouts = [
    { name: 'records after blocks, v8', options: {} },
    { name: 'records before their blocks, v8 (Juicer)', options: { interleaved: true } },
    { name: 'records before their blocks, far apart', options: { interleaved: true, padding: 300 << 10 } },
    { name: 'records after blocks, v9', options: { version: 9 as const } },
  ]
  const reads: Array<[string, (store: HicStore, file: HicFile, onChunk: (chunk: PixelChunk) => void) => Promise<unknown>]> = [
    ['the whole genome', (store, file, onChunk) => store.forEachWindow([0, file.nBins], [0, file.nBins], {} as never, onChunk)],
    [
      'a rectangle across chromosomes',
      (store, file, onChunk) =>
        store.forEachWindow([file.chromExtent(0)[0] + 3, file.chromExtent(2)[1] - 2], [file.chromExtent(1)[0], file.nBins], {} as never, onChunk),
    ],
    [
      'bands on two chromosomes',
      (store, file, onChunk) => store.forEachBands([file.chromExtent(1), [file.chromExtent(3)[0], file.chromExtent(3)[0] + 4]], onChunk),
    ],
    ['the census', (store, _file, onChunk) => store.scanAll({ onChunk: (chunk) => void onChunk(chunk) })],
  ]

  for (const layout of layouts) {
    for (const binSize of RESOLUTIONS) {
      for (const [what, read] of reads) {
        it(`hands over the same pixels: ${what}, at ${binSize} bp, ${layout.name}`, async () => {
          const { bytes } = await laidOut(layout.options)
          const planned = new RecordingSource(bytes)
          const expected = await drawn(new PlainSource(bytes), binSize, read)
          expect(expected.length).toBeGreaterThan(0)
          expect(await drawn(planned, binSize, read)).toEqual(expected)
          // And read nothing but exact ranges to do it, the open's aside.
          expect(planned.reads.filter((one) => one.exact).length).toBeGreaterThan(0)
        })
      }
    }
  }

  it('reads a rung past the records’ heads as whole records, together, and the blocks after them', async () => {
    const { bytes, total, pairs } = await laidOut({})
    const source = new RecordingSource(bytes)
    const file = HicFile.open(source, { binSize: FINE })
    source.reads.length = 0
    let sum = 0
    await new HicStore(file).scanAll({
      onChunk: (chunk) => {
        for (let i = 0; i < chunk.length; i++) sum += chunk.count[i]
        return true
      },
    })
    expect(sum).toBe(total)
    // Pair by pair it was a head, the record, and its blocks for each.
    expect(source.reads.length).toBeLessThan(pairs)
  })

  it('stops between its reads when the walk is cancelled, and reads no further', async () => {
    const { bytes } = await laidOut({ interleaved: true, padding: 1 << 20 })
    const source = new RecordingSource(bytes)
    const file = HicFile.open(source, { binSize: COARSE })
    source.reads.length = 0
    let stop = false
    const reading = new HicStore(file).forEachWindow([0, file.nBins], [0, file.nBins], {} as never, () => undefined, {
      cancelled: () => stop,
    })
    await new Promise((resolve) => setTimeout(resolve, 0))
    stop = true
    expect(await reading).toBe(false)
    const after = source.reads.length
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(source.reads.length).toBe(after)
    // What was out when it stopped — a picture's walk has six out — and no more.
    expect(after).toBeLessThanOrEqual(6)
  })
})

describe('a dropped .hic, walked', () => {
  /** A `Blob` whose bytes are synchronously reachable, as `local-lazy.test.ts` has it. */
  class SyncBlob extends Blob {
    constructor(readonly content: Uint8Array) {
      super([])
    }
    override get size(): number {
      return this.content.length
    }
    override slice(from = 0, to = this.content.length): Blob {
      return new SyncBlob(this.content.subarray(from, to)) as unknown as Blob
    }
    override async arrayBuffer(): Promise<ArrayBuffer> {
      return this.content.slice().buffer
    }
  }

  beforeEach(() => {
    stub(
      'FileReaderSync',
      class {
        readAsArrayBuffer(part: Blob): ArrayBuffer {
          return (part as SyncBlob).content.slice().buffer
        }
      },
    )
  })

  it('reads each record and the blocks past it exactly, not a megabyte of the disk round each', async () => {
    const { bytes, pairs, total } = await laidOut({ interleaved: true, padding: 1 << 20 })
    const source = new LocalFileSource(new SyncBlob(bytes) as unknown as Blob, { name: 'walk.hic' })
    const file = HicFile.open(source, { binSize: COARSE })
    source.resetStats()
    let sum = 0
    await new HicStore(file).scanAll({
      onChunk: (chunk) => {
        for (let i = 0; i < chunk.length; i++) sum += chunk.count[i]
        return true
      },
    })
    expect(sum).toBe(total)
    const { requests, bytes: read } = source.stats()
    // A read a pair at most — the open's slices may hold one — where through
    // the slice cache each was a 1 MiB slice of the disk.
    expect(requests).toBeLessThanOrEqual(pairs)
    expect(read).toBeLessThan(pairs * (64 << 10))
  })
})

describe('a census standing aside for a view that walks the same file', () => {
  it('holds none of the reads the view needs while it waits, so both finish', async () => {
    const { bytes, total } = await laidOut({ interleaved: true, padding: 1 << 20 })
    const source = new RecordingSource(bytes)
    const file = HicFile.open(source, { binSize: COARSE })
    const store = new HicStore(file)
    // The census goes first, and stands aside from its second step on — once it
    // is reading, which is when it could be holding reads the view waits for.
    let viewing: Promise<unknown> | null = null
    let steps = 0
    const counted: number[] = []
    const census = store.scanAll({
      onChunk: (chunk) => {
        for (let i = 0; i < chunk.length; i++) counted.push(chunk.count[i])
        return true
      },
      pause: async () => {
        steps += 1
        if (steps === 2) {
          let sum = 0
          viewing = store.forEachWindow([0, file.nBins], [0, file.nBins], {} as never, (chunk) => {
            for (let i = 0; i < chunk.length; i++) sum += chunk.count[i]
          }).then(() => sum)
        }
        if (viewing !== null) await viewing
      },
    })
    const finished = await Promise.race([
      census.then(() => 'finished'),
      new Promise((resolve) => setTimeout(() => resolve('stuck'), 5_000)),
    ])
    expect(finished).toBe('finished')
    expect(await viewing).toBe(total)
    expect(counted.reduce((sum, value) => sum + value, 0)).toBe(total)
  })
})
