/**
 * Reads located without an index (`bam/search.ts`).
 *
 * The files are built here and cut into BGZF blocks at arbitrary byte counts,
 * so that records — and the header — span block boundaries the way
 * `bgzf_write` splits them, and they are read through a handle that counts
 * its requests. What is asserted is the one thing that matters: a window
 * walked from the span the search answers holds exactly the reads a walk over
 * the whole file finds overlapping it.
 */

import { describe, expect, it } from 'vitest'

import { forEachRecord, readHeader, readNameAt, type BamHeader } from '@/annotations/bam/format'
import type { ByteSpan } from '@/annotations/bam/index'
import { BamSearch, boundaryIn, keyOf, OVERHANG, reg2bin, UnsortedError } from '@/annotations/bam/search'
import { inflateBgzf } from '@/annotations/tabix'
import { bamBytes, bgzfBlock, concat, recordBytes, tagBytes, type TestRecord } from './bam-fixtures'

const REFS = [
  { name: 'chrI', length: 1_000_000 },
  { name: 'chrII', length: 800_000 },
  { name: 'chrIII', length: 50_000 },
]

const SEQ = 'ACGT'.repeat(12) + 'AC'

/** A deterministic generator, so a failure is the same failure every run. */
function rng(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0
    return state / 2 ** 32
  }
}

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

/**
 * Reads over the first two references in file order, each carrying a tag of
 * random text — so the file has a size a search has to work at, rather than
 * compressing to a block or two.
 */
function sortedReads(count: number, seed: number, tagLength = 60): TestRecord[] {
  const random = rng(seed)
  const out: TestRecord[] = []
  const perRef = [Math.floor(count * 0.6), count - Math.floor(count * 0.6), 0]
  let n = 0
  for (let refId = 0; refId < REFS.length; refId++) {
    const positions: number[] = []
    for (let i = 0; i < perRef[refId]; i++) positions.push(Math.floor(random() * (REFS[refId].length - 200)))
    positions.sort((a, b) => a - b)
    for (const pos of positions) {
      let text = ''
      for (let i = 0; i < tagLength; i++) text += ALPHABET[Math.floor(random() * ALPHABET.length)]
      out.push({
        refId,
        pos,
        cigar: random() < 0.2 ? '30M2D20M' : '50M',
        seq: SEQ,
        name: `r${n++}`,
        tags: tagBytes([{ tag: 'XZ', type: 'Z', value: text }]),
      })
    }
  }
  return out
}

function unplaced(count: number): TestRecord[] {
  return Array.from({ length: count }, (_, i) => ({
    refId: -1,
    pos: -1,
    cigar: '',
    seq: 'ACGTACGT',
    name: `u${i}`,
    flag: 4,
  }))
}

/** The file, cut into blocks of `payload` inflated bytes, with a BGZF end marker. */
async function fileOf(records: TestRecord[], headerText?: string, payload = 3000): Promise<Uint8Array> {
  const whole = bamBytes(REFS, records, headerText)
  const blocks: Uint8Array[] = []
  for (let at = 0; at < whole.length; at += payload) {
    blocks.push(await bgzfBlock(whole.subarray(at, Math.min(whole.length, at + payload))))
  }
  blocks.push(await bgzfBlock(new Uint8Array(0)))
  return concat(blocks)
}

interface Handle {
  read(length: number, position: number): Promise<Uint8Array>
  reads: number
  bytes: number
}

function handleOf(bytes: Uint8Array): Handle {
  const handle: Handle = {
    reads: 0,
    bytes: 0,
    async read(length, position) {
      handle.reads++
      const out = bytes.slice(position, Math.min(bytes.length, position + length))
      handle.bytes += out.length
      return out
    },
  }
  return handle
}

async function headerOf(bytes: Uint8Array): Promise<BamHeader> {
  const header = readHeader(await inflateBgzf(bytes))
  if (header === null) throw new Error('the fixture header does not parse')
  return header
}

async function opened(bytes: Uint8Array): Promise<{ search: BamSearch; handle: Handle }> {
  const handle = handleOf(bytes)
  return { search: await BamSearch.open(handle, bytes.length, await headerOf(bytes)), handle }
}

/** The names of the reads a walk over `spans` finds overlapping the window — the worker's own walk. */
async function walk(bytes: Uint8Array, spans: ByteSpan[], refId: number, start: number, end: number): Promise<string[]> {
  const names: string[] = []
  for (const span of spans) {
    const inflated = await inflateBgzf(bytes.subarray(span.from, span.to), span.lastBlock - span.from)
    forEachRecord(inflated, span.dataFrom, (cursor) => {
      if (cursor.refId > refId || (cursor.refId === refId && cursor.pos >= end)) return false
      if (cursor.refId === refId && cursor.end > start) names.push(readNameAt(inflated, cursor))
      return true
    })
  }
  return names.sort()
}

function refLength(cigar: string): number {
  let n = 0
  for (const m of cigar.matchAll(/(\d+)([MIDNSHP=X])/g)) if ('MDN=X'.includes(m[2])) n += Number(m[1])
  return n
}

/** Brute force over every record: the reads overlapping the window that begin within the overhang. */
function expected(records: TestRecord[], refId: number, start: number, end: number): string[] {
  return records
    .filter((r) => r.refId === refId && r.pos < end && r.pos + refLength(r.cigar) > start && r.pos >= start - OVERHANG)
    .map((r) => r.name as string)
    .sort()
}

describe('locating a window without an index', () => {
  it('walks to exactly the reads an index would give, across block boundaries', async () => {
    const records = sortedReads(4000, 1)
    const bytes = await fileOf(records)
    const { search } = await opened(bytes)
    const random = rng(2)
    for (let i = 0; i < 40; i++) {
      const refId = random() < 0.5 ? 0 : 1
      const width = Math.floor(100 + random() * 60_000)
      const start = Math.floor(random() * (REFS[refId].length - width))
      const end = start + width
      const spans = await search.spansFor(refId, start, end)
      expect(spans.length, `${refId}:${start}-${end}`).toBeLessThanOrEqual(1)
      expect(await walk(bytes, spans, refId, start, end), `${refId}:${start}-${end}`).toEqual(
        expected(records, refId, start, end),
      )
    }
  })

  it('answers nothing for a reference with no reads, and finds nothing past the last read', async () => {
    const records = sortedReads(1000, 4)
    const bytes = await fileOf(records)
    const { search } = await opened(bytes)
    expect(await search.spansFor(2, 0, 50_000)).toEqual([])
    const spans = await search.spansFor(0, 999_990, 1_000_000)
    expect(await walk(bytes, spans, 0, 999_990, 1_000_000)).toEqual([])
    // Before the first read, too.
    const first = records[0].pos
    if (first > 1) {
      const early = await search.spansFor(0, 0, Math.max(1, first - 1))
      expect(await walk(bytes, early, 0, 0, first - 1)).toEqual([])
    }
  })

  it('keeps its probes, so the next window over the file costs fewer reads', async () => {
    const records = sortedReads(12_000, 5, 200)
    const bytes = await fileOf(records)
    expect(bytes.length).toBeGreaterThan(2 << 20)
    const { search, handle } = await opened(bytes)
    const before = handle.reads
    await search.spansFor(0, 500_000, 510_000)
    const first = handle.reads - before
    expect(search.probeCount).toBeGreaterThan(0)
    await search.spansFor(0, 512_000, 520_000)
    const second = handle.reads - before - first
    expect(second).toBeLessThan(first)
    // And the probes cost what the module says they cost, not the file.
    expect(handle.bytes).toBeLessThan(bytes.length)
  })

  it('lands near the target from the genome position, rather than halving from the middle', async () => {
    const records = sortedReads(12_000, 9, 200)
    const bytes = await fileOf(records)
    const { search, handle } = await opened(bytes)
    const before = handle.reads
    const spans = await search.spansFor(1, 300_000, 302_000)
    expect(await walk(bytes, spans, 1, 300_000, 302_000)).toEqual(expected(records, 1, 300_000, 302_000))
    // Two locates and their walks, with the probes between them interpolated:
    // a bisection of this file would be five probes a locate on its own.
    expect(handle.reads - before).toBeLessThanOrEqual(8)
  })

  it('shares a search between callers asking at the same moment', async () => {
    const records = sortedReads(12_000, 10, 200)
    const bytes = await fileOf(records)
    const { search, handle } = await opened(bytes)
    const alone = handleOf(bytes)
    const single = await BamSearch.open(alone, bytes.length, await headerOf(bytes))
    const cost = alone.reads
    await single.spansFor(0, 700_000, 705_000)
    const one = alone.reads - cost

    const before = handle.reads
    const [a, b] = await Promise.all([search.spansFor(0, 700_000, 705_000), search.spansFor(0, 700_000, 705_000)])
    expect(b).toEqual(a)
    // The second row joined the first row's search: nothing was read twice.
    expect(handle.reads - before).toBe(one)
  })

  it('answers a window over the caller’s cap as over it, after one probe', async () => {
    const records = sortedReads(12_000, 11, 200)
    const bytes = await fileOf(records)
    const { search, handle } = await opened(bytes)
    const cap = 200_000
    const before = handle.reads
    const spans = await search.spansFor(0, 100_000, 900_000, undefined, cap)
    expect(spans).toHaveLength(1)
    expect(spans[0].to - spans[0].from).toBeGreaterThan(cap)
    const gated = handle.reads - before
    // Located to its end, the same window costs the second locate as well.
    const again = await opened(bytes)
    const exact = await again.search.spansFor(0, 100_000, 900_000)
    expect(exact[0].to - exact[0].from).toBeGreaterThan(cap)
    expect(gated).toBeLessThan(again.handle.reads)
    // And a window under the cap is located exactly, gate or no gate.
    const small = await search.spansFor(0, 500_000, 501_000, undefined, cap)
    expect(await walk(bytes, small, 0, 500_000, 501_000)).toEqual(expected(records, 0, 500_000, 501_000))
  })

  it('refuses a file whose header claims an order it does not have, naming the two places', async () => {
    const sorted = sortedReads(6000, 3, 120)
    const swapped = [...sorted.filter((r) => r.refId === 1), ...sorted.filter((r) => r.refId === 0)]
    const bytes = await fileOf(swapped)
    const { search } = await opened(bytes)
    let caught: unknown = null
    try {
      // A window at the far end of chrII: its share of the genome puts the
      // first probe deep in the chrI half, which is where the file gives
      // itself away.
      await search.spansFor(1, 790_000, 791_000)
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(UnsortedError)
    const err = caught as UnsortedError
    expect(err.before.block).toBeLessThan(err.after.block)
    expect(err.before.key).toBeGreaterThan(err.after.key)
    expect(err.before.refId).toBe(1)
    expect(err.after.refId).toBe(0)
  })

  it('refuses a file with no @HD line before a window is asked for, when its reads are out of order', async () => {
    const sorted = sortedReads(6000, 6, 120)
    const swapped = [...sorted.filter((r) => r.refId === 1), ...sorted.filter((r) => r.refId === 0)]
    const bytes = await fileOf(swapped, '@CO\tno HD line\n')
    const handle = handleOf(bytes)
    await expect(BamSearch.open(handle, bytes.length, await headerOf(bytes))).rejects.toBeInstanceOf(UnsortedError)
  })

  it('accepts a file with no @HD line whose reads are in order', async () => {
    const records = sortedReads(3000, 7)
    const bytes = await fileOf(records, '@CO\tno HD line\n')
    const { search, handle } = await opened(bytes)
    // The four probes of the check, and the header's own read.
    expect(handle.reads).toBeGreaterThanOrEqual(5)
    const spans = await search.spansFor(1, 300_000, 320_000)
    expect(await walk(bytes, spans, 1, 300_000, 320_000)).toEqual(expected(records, 1, 300_000, 320_000))
  })

  it('answers nothing over a file that is a header and no reads', async () => {
    const bytes = await fileOf([])
    const { search } = await opened(bytes)
    expect(await search.spansFor(0, 0, 1000)).toEqual([])
  })

  it('finds reads longer than a block', async () => {
    const records: TestRecord[] = []
    for (let i = 0; i < 30; i++) {
      records.push({ refId: 0, pos: i * 30_000, cigar: '20000M', seq: 'A'.repeat(20_000), name: `long${i}` })
    }
    const bytes = await fileOf(records)
    const { search } = await opened(bytes)
    const spans = await search.spansFor(0, 61_000, 61_100)
    expect(await walk(bytes, spans, 0, 61_000, 61_100)).toEqual(['long2'])
    const wide = await search.spansFor(0, 100_000, 200_000)
    expect(await walk(bytes, wide, 0, 100_000, 200_000)).toEqual(expected(records, 0, 100_000, 200_000))
  })

  it('leaves the unplaced tail alone', async () => {
    const records = [...sortedReads(2000, 8), ...unplaced(200)]
    const bytes = await fileOf(records)
    const { search } = await opened(bytes)
    const last = records.filter((r) => r.refId === 1).map((r) => r.pos).sort((a, b) => a - b)
    const end = last[last.length - 1] + 60
    const spans = await search.spansFor(1, end - 5000, end)
    const names = await walk(bytes, spans, 1, end - 5000, end)
    expect(names).toEqual(expected(records, 1, end - 5000, end))
    expect(names.some((name) => name.startsWith('u'))).toBe(false)
  })
})

describe('the pieces', () => {
  it('reg2bin is the six-level scheme', () => {
    expect(reg2bin(0, 1)).toBe(4681)
    expect(reg2bin(16_384, 16_385)).toBe(4682)
    expect(reg2bin(0, 16_385)).toBe(585)
    expect(reg2bin(0, 1 << 29)).toBe(0)
  })

  it('keyOf orders reference-major, then position, unplaced last', () => {
    expect(keyOf(0, 5)).toBeLessThan(keyOf(0, 6))
    expect(keyOf(0, 1_000_000_000)).toBeLessThan(keyOf(1, 0))
    expect(keyOf(0, -1)).toBeLessThan(keyOf(0, 0))
    expect(keyOf(-1, -1)).toBe(Number.POSITIVE_INFINITY)
  })

  it('boundaryIn steps over the tail of a record cut before the buffer', () => {
    const a = recordBytes({ refId: 0, pos: 100, cigar: '50M', seq: SEQ, name: 'first' })
    const b = recordBytes({ refId: 0, pos: 120, cigar: '50M', seq: SEQ, name: 'second' })
    const c = recordBytes({ refId: 0, pos: 130, cigar: '50M', seq: SEQ, name: 'third' })
    expect(boundaryIn(concat([a.subarray(40), b, c]), REFS)).toBe(a.length - 40)
    // A record on its own, with nothing after it, is confirmed by its bin.
    expect(boundaryIn(c, REFS)).toBe(0)
    // A run of bytes that is not records at all.
    expect(boundaryIn(new Uint8Array(500).fill(0x41), REFS)).toBe(-1)
  })
})
