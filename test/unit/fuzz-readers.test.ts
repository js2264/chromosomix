/**
 * Every binary reader, handed the files its own writers make — broken (§10, §12).
 *
 * The regression tests (`untrusted.test.ts`) pin the failures somebody found.
 * This looks for the ones nobody has: each format's fixture is written by the
 * repository's own writer, corrupted a few hundred ways, and read back the way
 * the app reads it — open, index, a window, the weights, every resolution —
 * and every case must end one of two ways: an answer, or an `Error`. What it
 * must never do is the three things an assertion on the answer cannot see:
 *
 * - **read past a budget** of a small multiple of the file's size, which a
 *   counting source enforces by throwing — the corrupt index that reads the
 *   rest of the file once per entry;
 * - **allocate past 64 MiB** in one typed array, which a spy on the
 *   constructors records — the count trusted as a size;
 * - **take more than a second and a half**, which the clock records — the
 *   depth that made every query quadratic. A hang proper never returns to be
 *   timed; it is the suite that never finishes, which is a failure CI sees.
 *
 * **Deterministic.** Every case's corruption is drawn from a generator seeded
 * by the suite's seed and the case's number (`makeRandom`, mulberry32), and a
 * failure names both and the corruption itself, so it reproduces exactly.
 *
 * The corruptions are the ways files go wrong — bits flipped, bytes
 * overwritten, the file cut short — and the one that does the most damage:
 * a length-like field (a little-endian word that reads as a small positive
 * number) set to an extreme, `0xFFFFFFFF`, `0x7FFFFFFF`, −1 as an int64 and
 * their kin. A deflate stream is noise and mostly breaks; the structure
 * around it is where the counts are.
 */

import { afterAll, describe, expect, it } from 'vitest'

import { makeRandom, randomInt } from '@/analysis/random'
import { ViewerError } from '@/errors'
import { HicFile } from '@/hic/HicFile'
import { decodeRecord, forEachRecord, readHeader as readBamHeader } from '@/annotations/bam/format'
import { chunksFor, parseBamIndex } from '@/annotations/bam/index'
import { DEFAULT_FILTER, coverageOf } from '@/annotations/bam/pile'
import { pileOf } from '@/annotations/bam/reads'
import { inflateBgzf } from '@/annotations/tabix'
import { dnaByteRange, openTwoBit, unpackDna } from '@/annotations/twobit'
import { readG3dHeader, readG3dModel } from '@/annotations/g3dBinary'
import {
  CountingSource,
  ReadBudgetExceeded,
  caseRandom,
  countingRange,
  lengthLikeOffsets,
  mutate,
  watchAllocations,
  type Mutation,
} from '../support/hostile'
import { writeHic, type HicRecord } from '../support/hicWriter'
import { writeBam } from '../support/bamWriter'
import { buildTwoBit } from '../support/twoBitWriter'
import { writeG3d, type G3dBeads } from '../support/g3dWriter'
import { bamBytes, bgzfBlock, csiBytes, tagBytes, type TestRecord } from './bam-fixtures'

const SEED = 20261011

/**
 * Cases a format, sized so the file runs in about seven seconds alone and well
 * under twenty beside the rest of the suite.
 */
const CASES = { hic: 320, bam: 320, twobit: 300, g3d: 200 } as const

/** Bytes a reader may ask for, as a multiple of the file's size, per open. */
const READ_MULTIPLE = 16

/** The largest typed array one case may make. */
const ALLOCATION_CEILING = 64 << 20

/** The longest one case may take. */
const CASE_MS = 1500

interface Tally {
  cases: number
  answered: number
  refused: number
  /** Errors that are not `ViewerError`, by name — the readers' remaining bare throws. */
  other: Map<string, number>
  slowestMs: number
  largestBytes: number
  /** The most any case read, as a multiple of its file's size. */
  mostRead: number
  failures: string[]
}

const tallies = new Map<string, Tally>()

function tally(format: string): Tally {
  let held = tallies.get(format)
  if (held === undefined) {
    held = { cases: 0, answered: 0, refused: 0, other: new Map(), slowestMs: 0, largestBytes: 0, mostRead: 0, failures: [] }
    tallies.set(format, held)
  }
  return held
}

/**
 * Run one corrupted case and record how it ended.
 *
 * `run` returns the most it read as a multiple of the size of the file it read
 * — which for a corrupted index is the BAM it points into, not the index — and
 * a read past the budget arrives here as {@link ReadBudgetExceeded}.
 */
async function trial(
  format: string,
  label: string,
  mutation: Mutation,
  run: (bytes: Uint8Array) => Promise<number>,
): Promise<void> {
  const record = tally(format)
  record.cases++
  const seen = { largest: 0 }
  const stop = watchAllocations(seen)
  const started = performance.now()
  let error: unknown = null
  let read = 0
  try {
    read = await run(mutation.bytes)
  } catch (err) {
    error = err
  } finally {
    stop()
  }
  const ms = performance.now() - started
  const where = `${format} case ${label} (${mutation.how})`
  record.slowestMs = Math.max(record.slowestMs, ms)
  record.largestBytes = Math.max(record.largestBytes, seen.largest)
  record.mostRead = Math.max(record.mostRead, read)

  if (error === null) record.answered++
  else if (error instanceof ViewerError) record.refused++
  else if (error instanceof Error) {
    const name = error instanceof ReadBudgetExceeded ? error.name : `${error.name}: ${error.message.slice(0, 60)}`
    record.other.set(name, (record.other.get(name) ?? 0) + 1)
  }

  if (error !== null && !(error instanceof Error)) record.failures.push(`${where}: threw a non-Error ${String(error)}`)
  if (error instanceof ReadBudgetExceeded) record.failures.push(`${where}: ${error.message}`)
  if (seen.largest > ALLOCATION_CEILING) record.failures.push(`${where}: allocated ${seen.largest} bytes in one array`)
  if (ms > CASE_MS) record.failures.push(`${where}: took ${Math.round(ms)} ms`)
}

afterAll(() => {
  // What the fuzz found and did not fail on, for whoever reads the run: how
  // each format's cases ended, and how close the worst came to each budget.
  for (const [format, held] of tallies) {
    const others = [...held.other].map(([name, n]) => `${n}× ${name}`).join('; ')
    console.info(
      `${format}: ${held.cases} cases — ${held.answered} answered, ${held.refused} refused` +
        (others === '' ? '' : `, other errors: ${others}`) +
        `; slowest ${held.slowestMs.toFixed(0)} ms, largest array ${(held.largestBytes / 2 ** 20).toFixed(2)} MiB, ` +
        `most read ${held.mostRead.toFixed(1)}× the file`,
    )
  }
})

/** Every case of one format, from one fixture set, and the assertion over all of them. */
async function fuzz(
  format: string,
  fixtures: readonly Uint8Array[],
  count: number,
  run: (bytes: Uint8Array, rng: () => number) => Promise<number>,
  pick?: (fixture: Uint8Array) => (rng: () => number) => number,
): Promise<void> {
  const lengthLike = fixtures.map((fixture) => lengthLikeOffsets(fixture))
  for (let n = 0; n < count; n++) {
    const rng = caseRandom(SEED, n)
    const which = randomInt(rng, 0, fixtures.length)
    const mutation = mutate(fixtures[which], rng, lengthLike[which], pick?.(fixtures[which]))
    await trial(format, `${SEED}/${n} of fixture ${which}`, mutation, (bytes) => run(bytes, rng))
  }
  expect(tally(format).failures).toEqual([])
}

// ---------------------------------------------------------------------------
// .hic
// ---------------------------------------------------------------------------

/** A deterministic upper-triangular (for `intra`) scatter of integer counts. */
function scatter(nx: number, ny: number, step: number, intra = false): HicRecord[] {
  const out: HicRecord[] = []
  for (let x = 0; x < nx; x += step) {
    for (let y = intra ? x : 0; y < ny; y += step) out.push({ x, y, value: 1 + ((x * 7 + y * 3) % 50) })
  }
  return out
}

function divisors(length: number): Float64Array {
  return Float64Array.from({ length }, (_, i) => 0.5 + (i % 7) / 10)
}

async function hicFixtures(): Promise<Uint8Array[]> {
  const chroms = [
    { name: 'chr1', length: 30_000 },
    { name: 'chr2', length: 12_000 },
  ]
  const records = {
    '1_1': scatter(300, 300, 9, true),
    '1_2': scatter(300, 120, 13),
    '2_2': scatter(120, 120, 7, true),
  }
  const norms = {
    'VC/1/100': divisors(300),
    'VC/2/100': divisors(120),
    'KR/1/100': divisors(300),
    'VC/1/1000': divisors(30),
    'VC/2/1000': divisors(12),
  }
  const common = { chroms, records, norms, rebin: true, expectedValues: true, blockBinCount: 32 }
  return [
    (await writeHic({ ...common, version: 8, resolutions: [100, 1000] })).bytes,
    (
      await writeHic({
        ...common,
        version: 9,
        resolutions: [100, 1000],
        shortValues: true,
        shortPositions: true,
        normVectorsAfterFooter: true,
      })
    ).bytes,
    (await writeHic({ chroms, records, version: 8, resolutions: [100], dense: true, shortValues: true, blockBinCount: 64 })).bytes,
  ]
}

/**
 * Read a `.hic` as the app does: open at the landing rung and at up to two
 * others, then each of the first few pairs — the window's road and a walk's —
 * the weights, and the file's own total. Windows are bounded as a view bounds
 * them, since a header can claim chromosomes of any length.
 */
async function readHic(bytes: Uint8Array): Promise<number> {
  let read = 0
  const sources: CountingSource[] = []
  const opened = (binSize?: number): HicFile => {
    const source = new CountingSource(bytes, READ_MULTIPLE * bytes.length)
    sources.push(source)
    return HicFile.open(source, binSize === undefined ? {} : { binSize })
  }
  try {
    const first = opened()
    const rungs = [first, ...first.resolutions.filter((r) => r !== first.binSize).slice(0, 2).map((r) => opened(r))]
    for (const file of rungs) {
      file.hasAnyMatrix()
      for (const [a, b] of file.indexedPairs().slice(0, 4)) {
        const rows = window(file.chromExtent(a))
        const cols = window(file.chromExtent(b))
        await file.pairRecords(a, b, rows, cols)
        await file.pairRecords(a, b, rows, cols, true)
      }
      file.weights(0, Math.min(file.nBins, 1000))
      for (let c = 0; c < Math.min(file.chroms.length, 4); c++) file.normTypeFor(c)
      file.totalCount()
    }
  } finally {
    for (const source of sources) read = Math.max(read, source.bytes)
  }
  return read / bytes.length
}

function window([from, to]: readonly [number, number]): [number, number] {
  return [from, Math.min(to, from + 400)]
}

describe('a .hic, corrupted', () => {
  it(`ends every one of ${CASES.hic} cases in an answer or an Error, within budget`, async () => {
    const fixtures = await hicFixtures()
    // The fixtures themselves read cleanly: a fuzz of files that never parsed tests nothing.
    for (const fixture of fixtures) await readHic(fixture)
    await fuzz('.hic', fixtures, CASES.hic, (bytes) => readHic(bytes))
  })
})

// ---------------------------------------------------------------------------
// BAM, BAI and CSI
// ---------------------------------------------------------------------------

const REFS = [
  { name: 'chr1', length: 12_000 },
  { name: 'chr2', length: 12_000 },
]

const REFERENCE = Uint8Array.from({ length: 12_000 }, (_, i) => 'ACGT'.charCodeAt((i * 7 + (i >> 3)) % 4))

/** Reads of every CIGAR shape the walkers branch on, with MD and base-modification tags on some. */
function bamRecords(): TestRecord[] {
  const rng = makeRandom(7)
  const shapes = ['50M', '20M5I25M', '30M10D20M', '10S40M', '20M200N30M', '20=1X29=']
  const out: TestRecord[] = []
  for (let refId = 0; refId < REFS.length; refId++) {
    let pos = 100
    for (let i = 0; i < 90; i++) {
      pos += randomInt(rng, 5, 90)
      const shape = i % shapes.length
      const seq = Array.from({ length: 50 }, () => 'ACGT'[randomInt(rng, 0, 4)]).join('')
      const tags =
        shape === 0
          ? tagBytes([{ tag: 'MD', type: 'Z', value: '20A29' }])
          : shape === 3
            ? tagBytes([
                { tag: 'MM', type: 'Z', value: 'C+m,0,1;' },
                { tag: 'ML', type: 'B', subtype: 'C', value: [200, 40] },
              ])
            : shape === 4
              ? tagBytes([{ tag: 'XS', type: 'A', value: '+' }])
              : undefined
      out.push({
        refId,
        pos,
        cigar: shapes[shape],
        seq,
        name: `read${refId}_${i}`,
        flag: (i % 7 === 0 ? 0x10 : 0) | 0x1 | 0x2,
        nextRefId: refId,
        nextPos: pos + 300,
        tlen: 350,
        ...(tags === undefined ? {} : { tags }),
      })
    }
  }
  return out
}

/** The same reads indexed by CSI rather than BAI: BAI's geometry, declared, and BGZF-wrapped. */
async function csiFor(bai: Uint8Array): Promise<Uint8Array> {
  const index = await parseBamIndex(bai)
  const body = csiBytes(
    index.refs.map((ref) =>
      [...ref.bins].map(([bin, chunks]) => ({
        bin,
        loffset: Number(chunks[0].begin >> 16n),
        chunks: chunks.map((chunk): [number, number] => [Number(chunk.begin >> 16n), Number(chunk.end >> 16n)]),
      })),
    ),
    14,
    5,
  )
  return bgzfBlock(body)
}

/** Every decoder a window's inflated bytes go through, as a lane and its dialog use them. */
function walkWindow(inflated: Uint8Array, from: number, refId: number): void {
  const reference = { start: 0, bases: REFERENCE }
  coverageOf(inflated, from, refId, 0, 12_000, 64, DEFAULT_FILTER, reference, new Map(), {
    tally: new Map(),
    threshold: 0.5,
  })
  pileOf(inflated, from, 'chr1', refId, 0, 12_000, {
    filter: DEFAULT_FILTER,
    maxRows: 40,
    maxReads: 400,
    colourBy: 'basemod',
    withNames: true,
    reference,
  })
  let n = 0
  forEachRecord(inflated, from, (cursor) => {
    decodeRecord(inflated, cursor)
    return ++n < 200
  })
}

/** A BAM and its index, read as an alignment lane reads them: header, index, then each window. */
async function readBam(bam: Uint8Array, index: Uint8Array): Promise<number> {
  const { read, stats } = countingRange(bam, READ_MULTIPLE * bam.length)
  try {
    readBamHeader(await inflateBgzf(await read(1 << 16, 0)))
  } catch (err) {
    // A header that does not parse is refused by the worker before any index is
    // read, and the index's road is the one under test here; carry on to it.
    if (!(err instanceof Error)) throw err
  }
  const parsed = await parseBamIndex(index)
  for (let refId = 0; refId < REFS.length; refId++) {
    for (const span of chunksFor(parsed, refId, 0, 12_000, bam.length).slice(0, 4)) {
      const compressed = await read(span.to - span.from, span.from)
      walkWindow(await inflateBgzf(compressed, span.lastBlock - span.from), span.dataFrom, refId)
    }
  }
  return stats.bytes / bam.length
}

describe('a BAM and its index, corrupted', () => {
  it(`ends every one of ${CASES.bam} cases in an answer or an Error, within budget`, async () => {
    const records = bamRecords()
    const { bam, bai } = await writeBam(REFS, records, '@HD\tVN:1.6\tSO:coordinate\n', 16)
    const csi = await csiFor(bai)
    const csiBody = await inflateBgzf(csi)
    const plain = bamBytes(REFS, records)
    const recordsFrom = readBamHeader(plain)?.recordsFrom ?? 0
    // Every road reads the untouched files cleanly first.
    await readBam(bam, bai)
    await readBam(bam, csi)
    await readBam(bam, csiBody)
    walkWindow(plain, recordsFrom, 0)

    // Four targets, a quarter of the cases each: the BAI; the CSI, as stored
    // and — since a flipped bit in its BGZF framing stops it at the magic —
    // inflated, which `parseBamIndex` reads as readily; the compressed BAM;
    // and its records inflated, because a corrupted deflate stream almost
    // always fails the inflate, and the record walkers deserve corruption that
    // reaches them.
    const quarter = Math.ceil(CASES.bam / 4)
    await fuzz('BAI', [bai], quarter, (broken) => readBam(bam, broken))
    await fuzz('CSI', [csi, csiBody], quarter, (broken) => readBam(bam, broken))
    await fuzz('BAM', [bam], quarter, (broken) => readBam(broken, bai))
    await fuzz('BAM records', [plain], quarter, async (broken) => {
      for (let refId = 0; refId < REFS.length; refId++) walkWindow(broken, recordsFrom, refId)
      return 0
    })
  })
})

// ---------------------------------------------------------------------------
// .2bit
// ---------------------------------------------------------------------------

function sequence(length: number, seed: number): string {
  const rng = makeRandom(seed)
  return Array.from({ length }, () => 'ACGT'[randomInt(rng, 0, 4)]).join('')
}

/** Open a `.2bit` and read a window of each sequence, with the file's size known or not. */
async function readTwoBit(bytes: Uint8Array, withSize: boolean): Promise<number> {
  const { read, stats } = countingRange(bytes, READ_MULTIPLE * bytes.length)
  const file = await openTwoBit(read, withSize ? bytes.length : undefined)
  for (const record of file.ordered.slice(0, 8)) {
    const to = Math.min(record.length, 2000)
    const range = dnaByteRange(record, 0, to)
    unpackDna(await read(range.to - range.from, range.from), range.firstBase, record, 0, to)
  }
  return stats.bytes / bytes.length
}

describe('a .2bit, corrupted', () => {
  it(`ends every one of ${CASES.twobit} cases in an answer or an Error, within budget`, async () => {
    const fixture = buildTwoBit([
      { name: 'chr1', bases: sequence(5000, 1), gaps: [[100, 200], [1000, 1010], [4000, 4500]], masks: [[0, 50], [300, 400]] },
      { name: 'chr2', bases: sequence(3000, 2), gaps: [[0, 10]] },
      { name: 'chrM', bases: sequence(500, 3), masks: [[10, 20]] },
    ])
    await readTwoBit(fixture, true)
    await readTwoBit(fixture, false)
    await fuzz('.2bit', [fixture], CASES.twobit, (bytes, rng) => readTwoBit(bytes, rng() < 0.5))
  })
})

// ---------------------------------------------------------------------------
// Binary g3d
// ---------------------------------------------------------------------------

function beads(n: number, seed: number, resolution: number): G3dBeads {
  const rng = makeRandom(seed)
  return {
    start: Array.from({ length: n }, (_, i) => i * resolution),
    x: Array.from({ length: n }, () => rng() * 10),
    y: Array.from({ length: n }, () => rng() * 10),
    z: Array.from({ length: n }, () => rng() * 10),
  }
}

async function g3dFixture(): Promise<Uint8Array> {
  const model = (resolution: number): Map<string, Map<string, G3dBeads>> =>
    new Map([
      ['maternal', new Map([['chr1', beads(40, resolution + 1, resolution)], ['chr2', beads(20, resolution + 2, resolution)]])],
      ['paternal', new Map([['chr1', beads(40, resolution + 3, resolution)]])],
    ])
  return writeG3d({ models: new Map([[20000, model(20000)], [40000, model(40000)]]) })
}

async function readG3d(bytes: Uint8Array, withSize: boolean): Promise<number> {
  const { read, stats } = countingRange(bytes, READ_MULTIPLE * bytes.length)
  const header = await readG3dHeader(read, withSize ? bytes.length : undefined)
  for (const resolution of header.resolutions.slice(0, 3)) await readG3dModel(read, header, resolution)
  return stats.bytes / bytes.length
}

describe('a binary g3d, corrupted', () => {
  it(`ends every one of ${CASES.g3d} cases in an answer or an Error, within budget`, async () => {
    const fixture = await g3dFixture()
    await readG3d(fixture, true)
    // The header map, then the blocks: the 64,000 bytes between are padding,
    // and a corruption landing there tests nothing.
    let headerEnd = 64000
    while (headerEnd > 0 && fixture[headerEnd - 1] === 0) headerEnd--
    const live = (rng: () => number): number => {
      const blocks = fixture.length - 64000
      const at = randomInt(rng, 0, headerEnd + blocks)
      return at < headerEnd ? at : 64000 + (at - headerEnd)
    }
    await fuzz('binary g3d', [fixture], CASES.g3d, (bytes, rng) => readG3d(bytes, rng() < 0.5), () => live)
  })
})
