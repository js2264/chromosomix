/**
 * `bedMethyl` (§8.20) and `.2bit` (§8.21).
 *
 * ## bedMethyl
 *
 * A bedMethyl's first nine columns are a valid BED9, which is what makes it
 * dangerous: read as one it produces a lane that looks entirely correct — one
 * box per cytosine, in the file's own colours — and is missing the only column
 * anybody opened the file for. So the first claim is that the sniffer takes it
 * before anything else can.
 *
 * The second is about what it refuses to invent. A file may carry two
 * modifications over the same bases, and those are two measurements: the reader
 * draws the most abundant and *says* what it did not draw.
 *
 * ## .2bit
 *
 * Twice over, because neither half is enough on its own.
 *
 * A **fixture written here byte by byte**, which is the only way a test can
 * claim to know the rules: four bases a byte, two bits each, most significant
 * first, `T C A G` for `0 1 2 3` — and then the two things a naive reader gets
 * wrong, which are that the gaps are recorded *outside* the packed bits (so a
 * centromere reads as a convincing run of thymine unless they are applied) and
 * that the mask blocks have to be stepped over even though they are never read.
 * A file written here can exercise both; the demo assembly, being unmasked,
 * cannot.
 *
 * And the **demo `.2bit` itself**, at the end of this file, because a fixture
 * proves nothing about real files: two implementations sharing one
 * misunderstanding of a format agree perfectly with each other and with nothing
 * else. `scripts/make_demo_hub.py` writes that file and checks it with `py2bit`,
 * a wrapper around the C in kent's own tree, so what is being compared here is
 * this reader against a file UCSC's own code has already read back in full.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import {
  bedMethylSummary,
  isBedMethylSchema,
  parseBedMethyl,
  sniffBedMethyl,
} from '@/annotations/bedmethyl'
import {
  contigsOfRecords,
  dnaByteRange,
  looksLikeTwoBit,
  openTwoBit,
  RECORD_GUESS,
  readTwoBitHeader,
  readTwoBitIndex,
  recordHeaderBytes,
  unpackDna,
} from '@/annotations/twobit'
import { parseFasta } from '@/annotations/fasta'
import { cardFor, kindFor } from '@/annotations/loader'
import { sniffFormat } from '@/annotations/parse'
import { sniffSignal } from '@/annotations/signal'
import { routeOf } from '@/browse/route'

// ---------------------------------------------------------------------------
// bedMethyl
// ---------------------------------------------------------------------------

/** modkit's shape: BED9, then depth, percentage and the counts behind them. */
function methylRow(start: number, code: string, depth: number, percent: number): string {
  return [
    'chr1',
    start,
    start + 1,
    code,
    Math.min(depth, 1000),
    '+',
    start,
    start + 1,
    '255,0,0',
    depth,
    percent.toFixed(2),
    Math.round((depth * percent) / 100),
    depth - Math.round((depth * percent) / 100),
    0,
    0,
    0,
    0,
    0,
  ].join('\t')
}

const BEDMETHYL = [
  methylRow(1000, 'm', 20, 90),
  methylRow(1001, 'm', 18, 85),
  methylRow(2000, 'm', 25, 10),
].join('\n')

/** 5mC and 5hmC pileup'd together — two measurements over the same bases. */
const TWO_MODS = [
  methylRow(1000, 'm', 20, 90),
  methylRow(1000, 'h', 20, 5),
  methylRow(2000, 'm', 25, 10),
  methylRow(2000, 'h', 25, 3),
  methylRow(3000, 'm', 30, 55),
].join('\n')

describe('bedMethyl', () => {
  it('is recognised before the sniffers that would take it', () => {
    expect(sniffBedMethyl(BEDMETHYL)).toBe(true)
    // Where it used to go: a BED9 with the measurement never mentioned.
    expect(sniffFormat(BEDMETHYL)).toBe('bed')
    expect(sniffSignal(BEDMETHYL)).toBe(null)
  })

  it('does not take a BED9, a narrowPeak or a bedGraph', () => {
    expect(sniffBedMethyl('chr1\t1000\t2000\tpeak\t500\t+\t1000\t2000\t255,0,0\t12\t44.2')).toBe(
      false,
    )
    expect(
      sniffBedMethyl('chr1\t1000\t2000\tpeak\t500\t.\t7.2\t12.0\t9.1\t150'),
    ).toBe(false)
    expect(sniffBedMethyl('chr1\t1000\t2000\t3.5')).toBe(false)
  })

  it('reads the percentage column as the track', () => {
    const result = parseBedMethyl(BEDMETHYL)
    expect(result.signal.length).toBe(3)
    expect(result.signal.contigs[0].values[0]).toBeCloseTo(90)
    expect(result.signal.contigs[0].values[2]).toBeCloseTo(10)
    expect(result.drawn).toBe('m')
    expect(result.meanCoverage).toBeCloseTo((20 + 18 + 25) / 3)
  })

  it('drops a call resting on no reads rather than drawing it as zero', () => {
    const result = parseBedMethyl([BEDMETHYL, methylRow(5000, 'm', 0, 0)].join('\n'))
    expect(result.signal.length).toBe(3)
  })

  it('draws the most abundant modification and names the ones it did not', () => {
    const result = parseBedMethyl(TWO_MODS)
    expect(result.drawn).toBe('m')
    expect(result.signal.length).toBe(3)
    const summary = bedMethylSummary(result)
    expect(summary).toContain('3 5mC calls')
    expect(summary).toContain('not drawn: 5hmC (2)')
  })

  it('names its codes as SAMtags §1.7 does, the table a BAM’s MM tag is read by', () => {
    const result = parseBedMethyl(
      [methylRow(1000, 'e', 9, 50), methylRow(1001, 'g', 8, 50), methylRow(1002, 'b', 7, 50), methylRow(1003, '21839', 6, 50)].join('\n'),
    )
    const labels = Object.fromEntries(result.codes.map((code) => [code.code, code.label]))
    expect(labels).toEqual({ e: '5fU', g: '5hmU', b: '5caU', '21839': '4mC' })
  })

  it('becomes a track, with every affordance a bigWig lane has', () => {
    expect(cardFor('bedmethyl')).toBe('linear')
    expect(kindFor('linear', 'bedmethyl')).toBe('track')
  })

  it('is spotted in a bigBed by its schema', () => {
    expect(isBedMethylSchema('table bedMethyl\n( uint validCov; float percentMod; )')).toBe(true)
    expect(isBedMethylSchema('table bigNarrowPeak\n( float signalValue; float pValue; )')).toBe(
      false,
    )
  })

  it('is routed to the genome door', () => {
    expect(routeOf('https://host/sample.bedMethyl')).toBe('genome')
  })
})

// ---------------------------------------------------------------------------
// .2bit
// ---------------------------------------------------------------------------

/** `T C A G` → `0 1 2 3`, four to a byte, most significant pair first. */
const CODE: Record<string, number> = { T: 0, C: 1, A: 2, G: 3 }

function packBases(sequence: string): Uint8Array {
  const out = new Uint8Array(Math.ceil(sequence.length / 4))
  for (let i = 0; i < sequence.length; i++) {
    const letter = sequence[i].toUpperCase()
    // An `N` is not in the two-bit alphabet: kent writes `T` in its place and
    // records the run in the N blocks, so this fixture does the same.
    const code = CODE[letter] ?? 0
    out[i >> 2] |= code << (6 - ((i & 3) << 1))
  }
  return out
}

interface FixtureSequence {
  name: string
  bases: string
  /** Half-open spans that should read back as `N`. */
  gaps?: Array<[number, number]>
  /** Soft-mask spans, written so that stepping over them is exercised. */
  masks?: Array<[number, number]>
}

/** A whole `.2bit` file, little-endian, version 0. */
function buildTwoBit(sequences: readonly FixtureSequence[]): Uint8Array {
  const encoder = new TextEncoder()
  const names = sequences.map((sequence) => encoder.encode(sequence.name))
  const indexBytes = names.reduce((sum, name) => sum + 1 + name.length + 4, 0)
  const bodies = sequences.map((sequence) => {
    const gaps = sequence.gaps ?? []
    const masks = sequence.masks ?? []
    const packed = packBases(sequence.bases)
    const size = 4 + 4 + gaps.length * 8 + 4 + masks.length * 8 + 4 + packed.length
    const body = new Uint8Array(size)
    const view = new DataView(body.buffer)
    let at = 0
    view.setUint32(at, sequence.bases.length, true)
    at += 4
    view.setUint32(at, gaps.length, true)
    at += 4
    for (const [from] of gaps) {
      view.setUint32(at, from, true)
      at += 4
    }
    for (const [from, to] of gaps) {
      view.setUint32(at, to - from, true)
      at += 4
    }
    view.setUint32(at, masks.length, true)
    at += 4
    for (const [from] of masks) {
      view.setUint32(at, from, true)
      at += 4
    }
    for (const [from, to] of masks) {
      view.setUint32(at, to - from, true)
      at += 4
    }
    view.setUint32(at, 0, true) // reserved
    at += 4
    body.set(packed, at)
    return body
  })

  const total = 16 + indexBytes + bodies.reduce((sum, body) => sum + body.length, 0)
  const file = new Uint8Array(total)
  const view = new DataView(file.buffer)
  view.setUint32(0, 0x1a412743, true)
  view.setUint32(4, 0, true) // version
  view.setUint32(8, sequences.length, true)
  view.setUint32(12, 0, true) // reserved

  let indexAt = 16
  let bodyAt = 16 + indexBytes
  sequences.forEach((_, at) => {
    file[indexAt] = names[at].length
    file.set(names[at], indexAt + 1)
    view.setUint32(indexAt + 1 + names[at].length, bodyAt, true)
    indexAt += 1 + names[at].length + 4
    file.set(bodies[at], bodyAt)
    bodyAt += bodies[at].length
  })
  return file
}

/** The whole file in memory, behind the `ReadRange` the reader asks through. */
function readerFor(file: Uint8Array): (length: number, position: number) => Promise<Uint8Array> {
  return async (length, position) => file.subarray(position, Math.min(file.length, position + length))
}

const CHR1 = 'ACGTACGTTTGGCCAANNNNNNNNACGTACGTAC'
const CHR2 = 'GGGGCCCCAAAATTTT'

const FIXTURE = buildTwoBit([
  { name: 'chr1', bases: CHR1, gaps: [[16, 24]], masks: [[0, 4], [28, 32]] },
  { name: 'chr2', bases: CHR2 },
])

describe('.2bit', () => {
  it('is recognised by its signature, in either byte order', () => {
    expect(looksLikeTwoBit(FIXTURE)).toBe(true)
    const big = new Uint8Array(4)
    new DataView(big.buffer).setUint32(0, 0x1a412743, false)
    expect(looksLikeTwoBit(big)).toBe(true)
    expect(looksLikeTwoBit(new Uint8Array([0x3e, 0x63, 0x68, 0x72]))).toBe(false)
  })

  it('refuses the long variant by name rather than misreading it', () => {
    const long = FIXTURE.slice()
    new DataView(long.buffer).setUint32(4, 1, true)
    expect(() => readTwoBitHeader(long)).toThrow(/version 1/)
  })

  it('reads the index as an assembly, without touching a base', () => {
    return openTwoBit(readerFor(FIXTURE)).then((file) => {
      expect(contigsOfRecords(file.ordered)).toEqual([
        { name: 'chr1', length: CHR1.length },
        { name: 'chr2', length: CHR2.length },
      ])
      expect(file.total).toBe(CHR1.length + CHR2.length)
    })
  })

  it('unpacks a whole sequence, gaps included', async () => {
    const file = await openTwoBit(readerFor(FIXTURE))
    const record = file.records.get('chr1')!
    const range = dnaByteRange(record, 0, record.length)
    const packed = FIXTURE.subarray(range.from, range.to)
    const bases = unpackDna(packed, range.firstBase, record, 0, record.length)
    expect(new TextDecoder().decode(bases)).toBe(CHR1)
  })

  it('steps over the mask blocks to find the packed DNA', async () => {
    // chr1 carries two mask blocks and chr2 none. If the reader did not step
    // over them, chr1's residues would come back shifted by sixteen bytes.
    const file = await openTwoBit(readerFor(FIXTURE))
    for (const [name, bases] of [
      ['chr1', CHR1],
      ['chr2', CHR2],
    ] as const) {
      const record = file.records.get(name)!
      const range = dnaByteRange(record, 0, record.length)
      const got = unpackDna(
        FIXTURE.subarray(range.from, range.to),
        range.firstBase,
        record,
        0,
        record.length,
      )
      expect(new TextDecoder().decode(got)).toBe(bases)
    }
  })

  it('reads a window that starts mid-byte', async () => {
    const file = await openTwoBit(readerFor(FIXTURE))
    const record = file.records.get('chr1')!
    for (const [from, to] of [
      [1, 5],
      [3, 4],
      [6, 30],
      [0, 1],
      [33, 34],
    ]) {
      const range = dnaByteRange(record, from, to)
      const got = unpackDna(
        FIXTURE.subarray(range.from, range.to),
        range.firstBase,
        record,
        from,
        to,
      )
      expect(new TextDecoder().decode(got)).toBe(CHR1.slice(from, to))
    }
  })

  it('paints the gaps over the packed bits rather than trusting them', async () => {
    const file = await openTwoBit(readerFor(FIXTURE))
    const record = file.records.get('chr1')!
    const range = dnaByteRange(record, 14, 26)
    const got = unpackDna(FIXTURE.subarray(range.from, range.to), range.firstBase, record, 14, 26)
    // Two real bases, the eight-base gap, then two more — and the gap must not
    // read as the `T`s the packed bits actually hold.
    expect(new TextDecoder().decode(got)).toBe('AANNNNNNNNAC')
  })

  it('clamps a window that runs off the end', async () => {
    const file = await openTwoBit(readerFor(FIXTURE))
    const record = file.records.get('chr2')!
    const range = dnaByteRange(record, 12, 999)
    const got = unpackDna(FIXTURE.subarray(range.from, range.to), range.firstBase, record, 12, 999)
    expect(new TextDecoder().decode(got)).toBe('TTTT')
  })

  it('is a sequence, as a FASTA is', () => {
    expect(cardFor('twobit')).toBe('linear')
    expect(kindFor('linear', 'twobit')).toBe('sequence')
    expect(routeOf('https://hgdownload.soe.ucsc.edu/goldenPath/hg38/bigZips/hg38.2bit')).toBe(
      'genome',
    )
  })
})

// ---------------------------------------------------------------------------
// …and a soft-masked one, opened without its mask blocks
// ---------------------------------------------------------------------------

/**
 * §8.21: the mask blocks are stepped over by arithmetic and **never fetched**.
 *
 * The fixture above has two of them, which a header read covers whether or not
 * the reader wanted them — so it proved the arithmetic and not the economy. The
 * reader *did* fetch them: it asked for each record's header through to the
 * word after its masks, and on a soft-masked hg38 that is chr1's eight
 * megabytes of offsets and tens of megabytes across the genome, on open. These
 * files carry enough mask blocks that fetching them is a read of its own, and a
 * reader that counts what is asked of it.
 */
describe('a soft-masked .2bit', () => {
  /** Every read the opener makes, and the bytes behind it. */
  function counted(file: Uint8Array): {
    read: (length: number, position: number) => Promise<Uint8Array>
    reads: Array<{ length: number; position: number }>
  } {
    const reads: Array<{ length: number; position: number }> = []
    return {
      reads,
      read: async (length, position) => {
        reads.push({ length, position })
        return file.subarray(position, Math.min(file.length, position + length))
      },
    }
  }

  const decoder = new TextDecoder()
  const bases = 'ACGTTGCA'.repeat(25_000)
  /** 50,000 blocks: 400 KB of offsets, against 50 KB of packed DNA. */
  const masks = Array.from({ length: 50_000 }, (_, i): [number, number] => [i * 4, i * 4 + 2])

  it('reads each record’s header in one small read, and none of its mask blocks', async () => {
    const file = buildTwoBit([
      { name: 'chr1', bases, masks },
      { name: 'chr2', bases: CHR2, masks: [[0, 8]] },
    ])
    const { read, reads } = counted(file)
    const opened = await openTwoBit(read)
    // The first read is the index's, from the top of the file; the rest are the
    // records' headers, one each, at the offset the index gives and no longer
    // than the guess.
    const headers = reads.slice(1)
    const offsets = readTwoBitIndex(file, readTwoBitHeader(file)).entries.map((entry) => entry.offset)
    expect(headers.map((one) => one.position)).toEqual(offsets)
    for (const one of headers) expect(one.length).toBe(RECORD_GUESS)
    // Everything asked for, index included, is less than chr1's masks alone.
    expect(reads.reduce((sum, one) => sum + one.length, 0)).toBeLessThan(400_000)
    // …and stepping over them by arithmetic still lands on the packed DNA.
    for (const [name, want] of [
      ['chr1', bases],
      ['chr2', CHR2],
    ] as const) {
      const record = opened.records.get(name)!
      const range = dnaByteRange(record, 0, record.length)
      const got = unpackDna(file.subarray(range.from, range.to), range.firstBase, record, 0, record.length)
      expect(decoder.decode(got), name).toBe(want)
    }
  })

  it('reads a gappy record in two, the second just long enough for the gaps and the count', async () => {
    // 2,000 gaps are 16 KB of starts and sizes, past the first guess: so the
    // header is read twice — once to learn the count, once for the list and the
    // mask count behind it — and still never as far as the masks themselves.
    const gaps = Array.from({ length: 2_000 }, (_, i): [number, number] => [i * 100, i * 100 + 10])
    const file = buildTwoBit([{ name: 'chr1', bases, gaps, masks }])
    const { read, reads } = counted(file)
    const opened = await openTwoBit(read)
    const headers = reads.slice(1)
    expect(headers.map((one) => one.length)).toEqual([RECORD_GUESS, 8 + 2_000 * 8 + 4])
    expect(new Set(headers.map((one) => one.position)).size).toBe(1)
    const record = opened.records.get('chr1')!
    expect(record.nStarts.length).toBe(2_000)
    // The tenth gap, painted over the packed bits rather than trusted.
    const range = dnaByteRange(record, 900, 920)
    const got = unpackDna(file.subarray(range.from, range.to), range.firstBase, record, 900, 920)
    expect(decoder.decode(got)).toBe(`${'N'.repeat(10)}${bases.slice(910, 920)}`)
  })

  it('asks for nothing past the mask-block count', () => {
    // A header read as far as the count — and not one byte of the blocks — is
    // whole: what is behind the count is stepped over, not read.
    const file = buildTwoBit([{ name: 'chr1', bases: CHR1, gaps: [[16, 24]], masks }])
    const header = readTwoBitHeader(file)
    const [entry] = readTwoBitIndex(file, header).entries
    const countEnds = entry.offset + 8 + 1 * 8 + 4
    expect(recordHeaderBytes(file.subarray(entry.offset, countEnds), 0, true)).toBeNull()
    expect(recordHeaderBytes(file.subarray(entry.offset, countEnds - 1), 0, true)).toBe(8 + 8 + 4)
  })
})

// ---------------------------------------------------------------------------
// …and against a real file
// ---------------------------------------------------------------------------

/**
 * The demo `.2bit`, read back and compared with the FASTA it was packed from.
 *
 * Everything above is a fixture this file wrote, which pins the *rules* and
 * proves nothing about real files — two implementations sharing one
 * misunderstanding of a format agree perfectly with each other and with nothing
 * else. So the loop is closed three ways: `scripts/make_demo_hub.py` writes the
 * file, `py2bit` — a wrapper around the C in kent's own tree — reads every base
 * of it back and is checked by that script, and this reads the same bytes
 * through the reader the browser uses and compares them with the FASTA.
 *
 * The windows are chosen to land where the arithmetic is hardest: on the gaps,
 * across them, off a byte boundary, and at the very end of a sequence.
 */
describe('the demo .2bit', () => {
  const root = process.cwd()
  const packed = readFileSync(join(root, 'demo/yeast/Yeast_reference.2bit'))
  const bytes = new Uint8Array(packed.buffer, packed.byteOffset, packed.byteLength)
  const fasta = parseFasta(new Uint8Array(readFileSync(join(root, 'demo/yeast/S288c_syn40-XIII.fa'))))

  const read = async (length: number, position: number): Promise<Uint8Array> =>
    bytes.subarray(position, Math.min(bytes.length, position + length))

  it('declares the same assembly the FASTA does', async () => {
    const file = await openTwoBit(read)
    expect(contigsOfRecords(file.ordered)).toEqual(fasta.contigs)
  })

  it('unpacks every base of every sequence', async () => {
    const file = await openTwoBit(read)
    const decoder = new TextDecoder()
    for (const record of file.ordered) {
      const range = dnaByteRange(record, 0, record.length)
      const got = unpackDna(
        bytes.subarray(range.from, range.to),
        range.firstBase,
        record,
        0,
        record.length,
      )
      const want = fasta.bases.get(record.name)
      expect(want).toBeDefined()
      // Upper-cased on both sides: this assembly carries no soft-masking, and
      // what is checked here is the residues rather than the case (§8.21).
      expect(decoder.decode(got)).toBe(decoder.decode(want as Uint8Array).toUpperCase())
    }
  })

  it('reads a window off a byte boundary, and one that runs to the end', async () => {
    const file = await openTwoBit(read)
    const record = file.ordered[0]
    const want = fasta.bases.get(record.name) as Uint8Array
    const decoder = new TextDecoder()
    for (const [from, to] of [
      [1, 7],
      [3, 4],
      [1023, 2049],
      [record.length - 3, record.length],
    ]) {
      const range = dnaByteRange(record, from, to)
      const got = unpackDna(bytes.subarray(range.from, range.to), range.firstBase, record, from, to)
      expect(decoder.decode(got)).toBe(decoder.decode(want.subarray(from, to)).toUpperCase())
    }
  })

  it('carries the assembly’s real gaps, and paints them rather than trusting the bits', async () => {
    const file = await openTwoBit(read)
    const withGaps = file.ordered.filter((record) => record.nStarts.length > 0)
    // The demo assembly has 5,095 Ns; a reader that dropped the N blocks would
    // return a convincing run of thymine over every one of them.
    expect(withGaps.length).toBeGreaterThan(0)
    const record = withGaps[0]
    const from = Math.max(0, record.nStarts[0] - 4)
    const to = Math.min(record.length, record.nEnds[0] + 4)
    const range = dnaByteRange(record, from, to)
    const got = unpackDna(bytes.subarray(range.from, range.to), range.firstBase, record, from, to)
    const window = new TextDecoder().decode(got)
    expect(window).toContain('N')
    expect(window.slice(4, -4)).toMatch(/^N+$/)
  })
})
