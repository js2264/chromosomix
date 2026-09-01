/**
 * The BAM fixtures, read by somebody else's reader.
 *
 * `bam.test.ts` proves this repo's decoders agree with this repo's writer,
 * which is worth a great deal and is not enough. A mutual misunderstanding of
 * the virtual-offset layout, of the bin numbering or of the record prefix would
 * produce a file that round-trips perfectly here and that no tool in the world
 * can open — and the failure is silent, discovered months later by somebody
 * holding a file this app said was fine.
 *
 * So `@gmod/bam` — the reader `jbrowse` uses — opens the same bytes, and the
 * two readings must agree on the reads, their positions, their spans and their
 * CIGARs. Exactly the discipline `hic-straw-oracle.test.ts` applies to `.hic`
 * and `bigwig-write.test.ts` to bigWig, and here for the same reason: a format
 * is a contract with other programs, and the only test of a contract is another
 * party to it.
 *
 * **A devDependency, never a runtime one.** `annotations/bam/format.ts` records
 * why the reader is written here rather than delegated: every read in this app
 * goes through a source that counts its requests, caches its chunks and signs
 * them, and a parser that fetches for itself sits outside all three.
 */

import { describe, expect, it } from 'vitest'
import { BamFile } from '@gmod/bam'

import { forEachRecord, readHeader, readNameAt } from '@/annotations/bam/format'
import { chunksFor, parseBamIndex } from '@/annotations/bam/index'
import { inflateBgzf } from '@/annotations/tabix'
import { coverageOf } from '@/annotations/bam/pile'
import { writeBam } from '../support/bamWriter'
import type { TestRecord } from './bam-fixtures'

/** The bytes as a filehandle, so nothing touches a disk. */
class BytesFile {
  constructor(private readonly data: Uint8Array) {}
  async read(length: number, position: number): Promise<Uint8Array> {
    const n = Math.max(0, Math.min(this.data.byteLength - position, length))
    return this.data.slice(position, position + n)
  }
  async readFile(): Promise<Uint8Array> {
    return this.data
  }
  async stat(): Promise<{ size: number }> {
    return { size: this.data.byteLength }
  }
  async close(): Promise<void> {}
}

const REFS = [
  { name: 'chrI', length: 230_218 },
  { name: 'chrII', length: 813_184 },
]

/** A spread of the shapes that break a decoder: clips, gaps, indels, both refs. */
const RECORDS: TestRecord[] = [
  { refId: 0, pos: 1000, cigar: '100M', name: 'plain', seq: 'A'.repeat(100) },
  { refId: 0, pos: 1050, cigar: '10S90M', name: 'softclip', seq: 'C'.repeat(100) },
  { refId: 0, pos: 1200, cigar: '50M10D50M', name: 'deletion', seq: 'G'.repeat(100) },
  { refId: 0, pos: 1400, cigar: '50M10I40M', name: 'insertion', seq: 'T'.repeat(100) },
  { refId: 0, pos: 2000, cigar: '50M500N50M', name: 'spliced', seq: 'A'.repeat(100) },
  // Crosses a 16 kb bin boundary, so it lands a level up the tree — the case an
  // index reader that only reads the deepest level silently loses.
  { refId: 0, pos: 16_300, cigar: '200M', name: 'crossing', seq: 'C'.repeat(200) },
  { refId: 0, pos: 40_000, cigar: '100M', name: 'far', seq: 'G'.repeat(100) },
  { refId: 1, pos: 500, cigar: '100M', name: 'other-ref', seq: 'T'.repeat(100) },
]

async function open(): Promise<{
  bam: Uint8Array
  bai: Uint8Array
  oracle: BamFile
}> {
  const { bam, bai } = await writeBam(REFS, RECORDS)
  const oracle = new BamFile({
    bamFilehandle: new BytesFile(bam) as never,
    baiFilehandle: new BytesFile(bai) as never,
  })
  await oracle.getHeader()
  return { bam, bai, oracle }
}

/** Every read this repo's reader finds over a region, by the index. */
async function ours(
  bam: Uint8Array,
  bai: Uint8Array,
  refId: number,
  start: number,
  end: number,
): Promise<Array<{ name: string; pos: number; end: number }>> {
  const index = await parseBamIndex(bai)
  const spans = chunksFor(index, refId, start, end, bam.byteLength)
  const out: Array<{ name: string; pos: number; end: number }> = []
  for (const span of spans) {
    const inflated = await inflateBgzf(
      bam.subarray(span.from, span.to),
      span.lastBlock - span.from,
    )
    forEachRecord(inflated, 0, (cursor) => {
      if (cursor.refId !== refId) return
      if (cursor.end <= start || cursor.pos >= end) return
      out.push({ name: readNameAt(inflated, cursor), pos: cursor.pos, end: cursor.end })
    })
  }
  return out.sort((a, b) => a.pos - b.pos || a.name.localeCompare(b.name))
}

async function theirs(
  oracle: BamFile,
  contig: string,
  start: number,
  end: number,
): Promise<Array<{ name: string; pos: number; end: number }>> {
  const records = await oracle.getRecordsForRange(contig, start, end)
  return records
    .map((record) => ({
      name: record.name as string,
      pos: record.start as number,
      end: record.end as number,
    }))
    .sort((a, b) => a.pos - b.pos || a.name.localeCompare(b.name))
}

describe('against @gmod/bam', () => {
  it('reads the same header', async () => {
    const { bam, oracle } = await open()
    const header = readHeader(await inflateBgzf(bam.subarray(0, 65_536)))
    // The oracle exposes the reference table it parsed; the names and lengths
    // must be the same table.
    const theirRefs = (oracle as unknown as { indexToChr: Array<{ refName: string; length: number }> })
      .indexToChr
    expect(header?.refs.map((ref) => ref.name)).toEqual(theirRefs.map((ref) => ref.refName))
    expect(header?.refs.map((ref) => ref.length)).toEqual(theirRefs.map((ref) => ref.length))
  })

  it('finds the same reads over a narrow window', async () => {
    const { bam, bai, oracle } = await open()
    expect(await ours(bam, bai, 0, 1000, 1500)).toEqual(await theirs(oracle, 'chrI', 1000, 1500))
  })

  it('agrees on where each read ends, across every CIGAR shape', async () => {
    const { bam, bai, oracle } = await open()
    const mine = await ours(bam, bai, 0, 0, 50_000)
    const other = await theirs(oracle, 'chrI', 0, 50_000)
    expect(mine).toEqual(other)
    // And the spans are the ones the CIGARs imply, not merely the same wrong ones.
    const spanOf = (name: string): number => {
      const found = mine.find((read) => read.name === name)
      return found === undefined ? -1 : found.end - found.pos
    }
    expect(spanOf('plain')).toBe(100)
    expect(spanOf('softclip')).toBe(90)
    expect(spanOf('deletion')).toBe(110)
    expect(spanOf('insertion')).toBe(90)
    expect(spanOf('spliced')).toBe(600)
  })

  it('finds a read that crosses a bin boundary', async () => {
    // It lives several levels up the tree, so a query for the window it starts
    // in must climb rather than read the deepest bin alone.
    const { bam, bai, oracle } = await open()
    const mine = await ours(bam, bai, 0, 16_384, 16_500)
    expect(mine.map((read) => read.name)).toContain('crossing')
    expect(mine).toEqual(await theirs(oracle, 'chrI', 16_384, 16_500))
  })

  it('finds a spliced read from a window inside its own intron', async () => {
    const { bam, bai, oracle } = await open()
    const mine = await ours(bam, bai, 0, 2200, 2300)
    expect(mine.map((read) => read.name)).toEqual(['spliced'])
    expect(mine).toEqual(await theirs(oracle, 'chrI', 2200, 2300))
  })

  it('keeps the two references apart', async () => {
    const { bam, bai, oracle } = await open()
    expect(await ours(bam, bai, 1, 0, 1000)).toEqual(await theirs(oracle, 'chrII', 0, 1000))
    expect((await ours(bam, bai, 1, 0, 1000)).map((r) => r.name)).toEqual(['other-ref'])
  })

  it('reads a window without reading the whole file', async () => {
    // The claim that is bounded rather than merely correct: a reader that
    // fetched everything would satisfy every assertion above.
    const { bam, bai } = await open()
    const index = await parseBamIndex(bai)
    const spans = chunksFor(index, 0, 1000, 1200, bam.byteLength)
    const fetched = spans.reduce((sum, span) => sum + (span.to - span.from), 0)
    expect(fetched).toBeLessThan(bam.byteLength)
  })

  it('computes depth over the same reads the oracle returns', async () => {
    const { bam, bai, oracle } = await open()
    const index = await parseBamIndex(bai)
    const spans = chunksFor(index, 0, 1000, 1100, bam.byteLength)
    let kept = 0
    let depth = 0
    for (const span of spans) {
      const inflated = await inflateBgzf(
        bam.subarray(span.from, span.to),
        span.lastBlock - span.from,
      )
      const result = coverageOf(inflated, 0, 0, 1000, 1100, 1)
      kept += result.kept
      depth += result.depth[0]
    }
    const other = await theirs(oracle, 'chrI', 1000, 1100)
    expect(kept).toBe(other.length)
    // `plain` covers 1000-1100 whole. `softclip` starts at 1050 — a soft clip
    // consumes the read, not the reference, so `pos` is already its first
    // aligned base — and 50 of its 90 aligned bases fall inside the window.
    expect(depth).toBeCloseTo(1 + 50 / 100, 6)
  })
})
