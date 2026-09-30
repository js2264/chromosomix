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
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { MetaCooler } from '@/metacooler/MetaCooler'
import { RECORD_HEAD_BYTES, blockRuns, findZoom, readZoom, type BlockRef } from '@/hic/blocks'
import { readFooter, readHeader, type HicFooter } from '@/hic/format'
import { HicFile } from '@/hic/HicFile'
import { HicStore } from '@/hic/store'
import { RemoteRangeSource } from '@/sources/RemoteRangeSource'
import { createSource, releaseSources } from '@/worker/sources'
import type { ByteSource, SourceStats } from '@/types'
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

let written: Promise<Fixture> | null = null

function fixture(): Promise<Fixture> {
  written ??= (async () => {
    const { records, total } = contacts()
    const file = await writeHic({
      version: 8,
      chroms: CHROMS,
      resolutions: RESOLUTIONS,
      records,
      blockBinCount: 8,
      rebin: true,
    })
    return { bytes: file.bytes, total, pairs: Object.keys(records).length }
  })()
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
  readonly isRemote = true
  readonly size: number
  readonly reads: Array<{ exact: boolean; position: number; length: number }> = []
  /** Exact reads asked for and not yet answered, now and at most. */
  inFlight = 0
  mostInFlight = 0

  constructor(private readonly data: Uint8Array) {
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

  it('has read the pairs in flight, not every pair, when it hands over its first pixels', async () => {
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
    // A record's head and its one block, for each pair read at once.
    expect(atFirst).toBeGreaterThanOrEqual(2)
    expect(atFirst).toBeLessThanOrEqual(2 * file.walkAhead())
    expect(source.reads).toHaveLength(2 * pairs)
  })

  it('keeps several pairs in flight, and hands their pixels over in order', async () => {
    const { bytes } = await fixture()
    const source = new RecordingSource(bytes)
    const file = HicFile.open(source, { binSize: COARSE })
    expect(file.walkAhead()).toBeGreaterThan(1)
    const order: number[] = []
    await new HicStore(file).scanAll({
      chunkSize: 1,
      onChunk: (chunk) => {
        order.push(chunk.bin1[0])
        return true
      },
    })
    expect(source.mostInFlight).toBeGreaterThan(1)
    expect(source.mostInFlight).toBeLessThanOrEqual(file.walkAhead())
    // `indexedPairs` order, which is ascending in the lower chromosome.
    expect(order).toEqual([...order].sort((x, y) => x - y))
  })

  it('reads one pair at a time at a rung where one pair could fill the budget', async () => {
    const written = await writeHic({
      version: 8,
      chroms: [{ name: 'chrBig', length: 250_000_000 }],
      resolutions: [10_000],
      records: { '1_1': [{ x: 0, y: 0, value: 1 }] },
    })
    const file = HicFile.open(new RecordingSource(written.bytes))
    expect(file.walkAhead()).toBe(1)
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

  it('reads one head and one block per pair over the network, exactly, and keeps none of it', async () => {
    const { bytes, pairs } = await fixture()
    const footer = footerOf(bytes)
    // The most the walk may read: each record's head, or the record where it
    // is shorter, and each pair's coarse blocks.
    let bound = 0
    for (const entry of footer.masterIndex.values()) {
      const whole = new RecordingSource(bytes).readBytes(entry.position, entry.size)
      bound += Math.min(entry.size, RECORD_HEAD_BYTES)
      for (const block of findZoom(whole, 'BP', COARSE)?.blocks.values() ?? []) bound += block.size
    }
    const source = await remote()
    const mc = MetaCooler.fromHic(`${URL_UNDER_TEST}::/resolutions/${COARSE}`, source)
    const held = source.cachedChunkCount()
    source.resetStats()
    try {
      await mc.countContacts()
      const { requests, bytes: read } = source.stats()
      expect(requests).toBeLessThanOrEqual(2 * pairs)
      expect(read).toBeLessThanOrEqual(bound)
      // Every read the walk made is its own range; the chunks a view reads
      // through are as the open left them.
      expect(source.cachedChunkCount()).toBe(held)
      // Against the file: reading the records whole would have been more than
      // the walk read in all.
      const records = [...footer.masterIndex.values()].reduce((sum, entry) => sum + entry.size, 0)
      expect(read).toBeLessThan(records)
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
