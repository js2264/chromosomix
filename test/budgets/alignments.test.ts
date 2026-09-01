/**
 * The §12 budgets for an alignment lane, as hard assertions.
 *
 * | Operation | Budget |
 * |---|---|
 * | Open a BAM: header + index | ≤ 2 range requests |
 * | One alignment window | ≤ 5 coalesced range requests |
 * | Pan inside the window already fetched | 0 |
 * | A window above the byte cap | **0 data requests** |
 *
 * ## Why this file exists at all
 *
 * The annotations path has never been measured. §12's numbers are asserted in
 * `requests.test.ts` through `CountingRangeSource`, which drives the *reader
 * worker's* stack — `RemoteRangeSource`, its 1 MiB chunks, its LRU, its counter
 * — and nothing on the annotations side goes through any of it: a bigWig reads
 * through `@gmod/bbi`'s own filehandle, and tabix and BAM read through
 * `generic-filehandle2`. So a budget written for an alignment lane and asserted
 * nowhere would be a paper figure on a repo whose central claim is that the
 * figures are measured. The counter here is the smallest thing that fixes that:
 * a `GenericFilehandle` that records every read.
 *
 * ## The row that is not a request count
 *
 * The index read deliberately is not held to a small number of *bytes*. A BAI
 * for a human WGS file is single-digit megabytes and there is no way to read
 * part of one usefully — so what is asserted is that it costs a bounded number
 * of *requests*, once, at open, and that it is separated from the per-window
 * budget rather than folded into it. Expressing it as a request count alone
 * would hide exactly the cost it exists to police, which is why §12 says so in
 * words beside the number.
 */

import { describe, expect, it } from 'vitest'

import { chunksFor, forecastBytes, parseBamIndex } from '@/annotations/bam/index'
import { readHeader } from '@/annotations/bam/format'
import { inflateBgzf } from '@/annotations/tabix'
import { coverageOf } from '@/annotations/bam/pile'
import { writeBam } from '../support/bamWriter'
import type { TestRecord } from '../unit/bam-fixtures'

/** A filehandle that counts what was asked of it. */
class CountingFile {
  requests = 0
  bytes = 0
  constructor(private readonly data: Uint8Array) {}

  async read(length: number, position: number): Promise<Uint8Array> {
    this.requests += 1
    const n = Math.max(0, Math.min(this.data.byteLength - position, length))
    this.bytes += n
    return this.data.slice(position, position + n)
  }

  async readFile(): Promise<Uint8Array> {
    this.requests += 1
    this.bytes += this.data.byteLength
    return this.data
  }

  async stat(): Promise<{ size: number }> {
    return { size: this.data.byteLength }
  }
}

const REFS = [{ name: 'chrI', length: 60_000_000 }]

/**
 * Forty thousand short reads over ten megabases, packed as `samtools` packs them.
 *
 * Both properties matter and both were learned the hard way.
 *
 * **Short reads.** A record goes in the smallest bin that wholly contains it, so
 * a *long* read crossing a 16 kb boundary lands several levels up the tree — and
 * a coarse bin's chunks are scattered the length of the file. With 4 kb reads,
 * a quarter of them do that, the coarse chunks coalesce across the gaps between
 * them, and a windowed read fetches most of the file. That is correct behaviour
 * and it is what a long-read file genuinely costs; it is not what a ChIP or an
 * RNA-seq file costs, which is the case this budget is about. 150 bp reads
 * almost never cross a boundary, so the coarse bins stay empty and a window's
 * chunks are local.
 *
 * **Many records per block.** One record per block is right for testing offsets
 * and wrong for measuring bytes: it makes a bin's chunks hundreds of tiny spans
 * that merge into one large one. A real block holds tens of kilobytes.
 *
 * **Incompressible sequence.** An expression like `(i * 7 + b * 13) & 3` looks
 * varied and has a period of four, so it deflates to almost nothing and the
 * file never reaches the size this fixture exists to have. `Math.random` is not
 * used because a fixture has to be the same bytes every run.
 */
function manyReads(): TestRecord[] {
  const bases = 'ACGT'
  const out: TestRecord[] = []
  // xorshift32, not a linear congruential generator: an LCG's low and middle
  // bits are strongly periodic, so the sequence deflates to a fraction of its
  // size — which is the opposite of what a fixture sized in megabytes needs.
  let seed = 0x2f6e2b1
  const next = (): number => {
    seed ^= seed << 13
    seed ^= seed >>> 17
    seed ^= seed << 5
    return seed
  }
  for (let i = 0; i < 40_000; i++) {
    let seq = ''
    for (let b = 0; b < 150; b++) seq += bases[next() & 3]
    out.push({ refId: 0, pos: i * 250, cigar: '150M', name: `r${i}`, seq })
  }
  return out
}

/**
 * Written once for the whole file.
 *
 * Several megabytes through `CompressionStream` is seconds, and every test here
 * wants the same bytes — what varies is only what is asked of them.
 */
let fixture: Promise<{ bam: Uint8Array; bai: Uint8Array }> | null = null

function written(): Promise<{ bam: Uint8Array; bai: Uint8Array }> {
  fixture ??= writeBam(REFS, manyReads(), '@HD\tVN:1.6\tSO:coordinate\n', 200)
  return fixture
}

async function open(): Promise<{
  bam: CountingFile
  bai: CountingFile
  size: number
  index: Awaited<ReturnType<typeof parseBamIndex>>
}> {
  const made = await written()
  const bam = new CountingFile(made.bam)
  const bai = new CountingFile(made.bai)
  const index = await parseBamIndex(await bai.readFile())
  return { bam, bai, size: made.bam.byteLength, index }
}

/** Read one window the way `alignmentSamples` does, and report what it cost. */
async function window(
  bam: CountingFile,
  index: Awaited<ReturnType<typeof parseBamIndex>>,
  size: number,
  start: number,
  end: number,
): Promise<{ requests: number; kept: number }> {
  const before = bam.requests
  const spans = chunksFor(index, 0, start, end, size)
  let kept = 0
  for (const span of spans) {
    const compressed = await bam.read(span.to - span.from, span.from)
    const inflated = await inflateBgzf(compressed, span.lastBlock - span.from)
    kept += coverageOf(inflated, 0, 0, start, end, 1).kept
  }
  return { requests: bam.requests - before, kept }
}

describe('§12: opening a BAM', () => {
  it('reads the header and the index in at most two requests', async () => {
    const made = await written()
    const bam = new CountingFile(made.bam)
    const bai = new CountingFile(made.bai)

    const header = readHeader(await inflateBgzf(await bam.read(1 << 18, 0)))
    await parseBamIndex(await bai.readFile())

    expect(header?.refs).toEqual(REFS)
    expect(bam.requests + bai.requests, `${bam.requests + bai.requests} requests to open`).toBeLessThanOrEqual(2)
  })
})

describe('§12: one alignment window', () => {
  it('costs at most five coalesced range requests', async () => {
    const { bam, index, size } = await open()
    const cost = await window(bam, index, size, 1_000_000, 1_010_000)
    expect(cost.kept).toBeGreaterThan(0)
    expect(cost.requests, `${cost.requests} requests for one window`).toBeLessThanOrEqual(5)
  })

  it('costs the same on a file with far more in it', async () => {
    // The claim that is *bounded* rather than merely correct, stated the way it
    // is actually true. It is deliberately **not** "reads a small fraction of
    // the file": `chunksFor` merges spans that come within a mebibyte, because
    // the sources below read in 1 MiB chunks and a smaller gap costs more to
    // skip than to read across — so on any file near that size a window reads
    // most of it, and that is the right trade rather than a regression.
    //
    // What must hold, and what a reader actually feels, is that the cost of a
    // window does not grow with the file: the same locus on a 30 GB alignment
    // must cost what it costs on a 300 MB one. So the same window is forecast
    // against two files that differ only in how much data lies elsewhere.
    const near = await writeBam(REFS, manyReads(), undefined, 200)
    const far = await writeBam(
      REFS,
      [...manyReads(), ...manyReads().map((r) => ({ ...r, pos: r.pos + 40_000_000 }))],
      undefined,
      200,
    )
    const nearIndex = await parseBamIndex(near.bai)
    const farIndex = await parseBamIndex(far.bai)

    const a = forecastBytes(chunksFor(nearIndex, 0, 1_000_000, 1_010_000, near.bam.byteLength))
    const b = forecastBytes(chunksFor(farIndex, 0, 1_000_000, 1_010_000, far.bam.byteLength))
    expect(far.bam.byteLength).toBeGreaterThan(near.bam.byteLength * 1.8)
    expect(b, `${b} bytes against ${a} on a file half the size`).toBeLessThanOrEqual(a * 1.1)
  })

  it('coalesces rather than issuing one request per chunk', async () => {
    // A 10 kb window at 250 bp spacing is forty reads, spread over a handful of
    // blocks and bins. Without the merge that would be one request per chunk.
    const { index, size } = await open()
    const spans = chunksFor(index, 0, 1_000_000, 1_010_000, size)
    expect(spans.length).toBeLessThanOrEqual(5)
  })
})

describe('§12: panning inside what is in hand', () => {
  it('costs nothing, because the window already fetched covers it', async () => {
    // The cache is `SampleCache`'s and is tested there; what is asserted here is
    // the property it rests on — that a padded window's byte spans contain a
    // narrower window's, so no second fetch is *needed*.
    const { index, size } = await open()
    const wide = chunksFor(index, 0, 1_000_000, 1_020_000, size)
    const narrow = chunksFor(index, 0, 1_005_000, 1_015_000, size)
    for (const span of narrow) {
      const covered = wide.some((outer) => outer.from <= span.from && outer.to >= span.to)
      expect(covered, `${span.from}-${span.to} not inside the padded fetch`).toBe(true)
    }
  })
})

describe('§12: a window above the cap', () => {
  it('is refused from the index alone, at zero data requests', async () => {
    // The whole point of forecasting: the number that decides whether a lane
    // can draw is knowable before a byte of alignment data is read.
    const { bam, index, size } = await open()
    const before = bam.requests

    const spans = chunksFor(index, 0, 0, 60_000_000, size)
    const forecast = forecastBytes(spans)
    expect(forecast).toBeGreaterThan(0)
    // Whatever the cap is, deciding against it costs nothing.
    expect(bam.requests - before, 'requests spent forecasting').toBe(0)
  })

  it('forecasts more for a wider window, so the cap means something', async () => {
    const { index, size } = await open()
    const narrow = forecastBytes(chunksFor(index, 0, 1_000_000, 1_010_000, size))
    const wide = forecastBytes(chunksFor(index, 0, 0, 60_000_000, size))
    expect(wide).toBeGreaterThan(narrow)
  })
})
