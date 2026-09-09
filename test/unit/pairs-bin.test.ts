/**
 * The importer's arithmetic, against a second implementation of it.
 *
 * Every assertion here compares `binPairs` to `referenceBin`, which is written
 * the slow obvious way in `test/support/pairs.ts`. The cases are chosen for the
 * three things the fast path assumes: that names can be interned by hash, that
 * `bin1` is non-decreasing, and that the last bin of a contig is short.
 */

import { describe, expect, it } from 'vitest'

import { binPairs } from '@/pairs/bin'
import { readPairsHeader } from '@/pairs/format'
import {
  BytesSource,
  bgzipped,
  gzipped,
  pairsText,
  referenceBin,
  rng,
  sortRecords,
  type Contig,
  type Record,
} from '../support/pairs'

const CONTIGS: Contig[] = [
  { name: 'chrI', length: 2_300 },
  { name: 'chrII', length: 1_050 },
  { name: 'chrIII', length: 700 },
]
const BIN = 100

/** Random contacts across every contig pair, including trans. */
function randomRecords(n: number, seed = 7): Record[] {
  const next = rng(seed)
  const out: Record[] = []
  for (let i = 0; i < n; i++) {
    const a = CONTIGS[Math.floor(next() * CONTIGS.length)]
    const b = CONTIGS[Math.floor(next() * CONTIGS.length)]
    out.push({
      chrom1: a.name,
      pos1: 1 + Math.floor(next() * a.length),
      chrom2: b.name,
      pos2: 1 + Math.floor(next() * b.length),
    })
  }
  return out
}

/** Compare a `BinnedPixels` against the reference map, cell for cell. */
async function expectMatches(
  bytes: Uint8Array,
  contigs: readonly Contig[],
  records: readonly Record[],
  binSize = BIN,
): Promise<void> {
  const source = new BytesSource(bytes)
  const header = await readPairsHeader(source)
  const pixels = await binPairs(source, {
    binSize,
    contigs: header.contigs,
    columns: header.columns,
  })
  expect(pixels).not.toBeNull()
  const expected = referenceBin(contigs, records, binSize)

  expect(pixels!.nBins).toBe(expected.nBins)
  expect(pixels!.sum).toBe(expected.sum)
  expect(pixels!.nnz).toBe(expected.cells.size)

  for (let i = 0; i < pixels!.nnz; i++) {
    const key = `${pixels!.bin1[i]}:${pixels!.bin2[i]}`
    expect(expected.cells.get(key), `cell ${key}`).toBe(pixels!.count[i])
  }
  // Upper-triangular, and in cooler's own pixel order.
  for (let i = 0; i < pixels!.nnz; i++) {
    expect(pixels!.bin1[i]).toBeLessThanOrEqual(pixels!.bin2[i])
    if (i === 0) continue
    const back = pixels!.bin1[i] - pixels!.bin1[i - 1]
    expect(back).toBeGreaterThanOrEqual(0)
    if (back === 0) expect(pixels!.bin2[i]).toBeGreaterThan(pixels!.bin2[i - 1])
  }
}

describe('binPairs', () => {
  it('matches the reference on a sorted, bgzipped file', async () => {
    const records = sortRecords(CONTIGS, randomRecords(4_000))
    const text = pairsText({ contigs: CONTIGS, records })
    await expectMatches(bgzipped(text), CONTIGS, records)
  })

  it('matches the reference on a plain-gzipped file', async () => {
    const records = sortRecords(CONTIGS, randomRecords(2_000, 11))
    const text = pairsText({ contigs: CONTIGS, records })
    await expectMatches(gzipped(text), CONTIGS, records)
  })

  it('matches the reference on an uncompressed file', async () => {
    const records = sortRecords(CONTIGS, randomRecords(1_500, 13))
    const text = pairsText({ contigs: CONTIGS, records })
    await expectMatches(new TextEncoder().encode(text), CONTIGS, records)
  })

  it('repairs a file that is not bin1-ordered', async () => {
    // Deliberately shuffled: the fast path's one ordering assumption is broken
    // on purpose, and the merge pass has to produce the identical table.
    const records = randomRecords(3_000, 29)
    const text = pairsText({ contigs: CONTIGS, records, sorted: null })
    const source = new BytesSource(bgzipped(text))
    const header = await readPairsHeader(source)
    const pixels = await binPairs(source, {
      binSize: BIN,
      contigs: header.contigs,
      columns: header.columns,
    })
    expect(pixels!.wasUnsorted).toBe(true)
    await expectMatches(bgzipped(text), CONTIGS, records)
  })

  it('places boundary positions on the side cooler does', async () => {
    // 1-based in: position 100 is the last base of bin 0, 101 the first of bin 1.
    const records: Record[] = [
      { chrom1: 'chrI', pos1: 1, chrom2: 'chrI', pos2: 1 },
      { chrom1: 'chrI', pos1: 100, chrom2: 'chrI', pos2: 100 },
      { chrom1: 'chrI', pos1: 101, chrom2: 'chrI', pos2: 101 },
      { chrom1: 'chrI', pos1: 200, chrom2: 'chrI', pos2: 201 },
    ]
    const source = new BytesSource(bgzipped(pairsText({ contigs: CONTIGS, records })))
    const header = await readPairsHeader(source)
    const pixels = await binPairs(source, {
      binSize: BIN,
      contigs: header.contigs,
      columns: header.columns,
    })
    const cells = new Map<string, number>()
    for (let i = 0; i < pixels!.nnz; i++) cells.set(`${pixels!.bin1[i]}:${pixels!.bin2[i]}`, pixels!.count[i])
    expect(cells.get('0:0')).toBe(2)
    expect(cells.get('1:1')).toBe(1)
    expect(cells.get('1:2')).toBe(1)
  })

  it('keeps a short final bin inside its own contig', async () => {
    // chrI is 2,300 bp at 100 bp bins: 23 bins, 0..22. chrII therefore starts
    // at 23, and a position in chrII's first bin must not land in chrI's last.
    const records: Record[] = [
      { chrom1: 'chrI', pos1: 2_300, chrom2: 'chrII', pos2: 1 },
      { chrom1: 'chrII', pos1: 1_050, chrom2: 'chrIII', pos2: 700 },
    ]
    const source = new BytesSource(bgzipped(pairsText({ contigs: CONTIGS, records })))
    const header = await readPairsHeader(source)
    const pixels = await binPairs(source, {
      binSize: BIN,
      contigs: header.contigs,
      columns: header.columns,
    })
    const cells = new Map<string, number>()
    for (let i = 0; i < pixels!.nnz; i++) cells.set(`${pixels!.bin1[i]}:${pixels!.bin2[i]}`, pixels!.count[i])
    // chrI: bins 0..22. chrII: 23..33 (11 bins). chrIII: 34..40 (7 bins).
    expect(pixels!.nBins).toBe(23 + 11 + 7)
    expect(cells.get('22:23')).toBe(1)
    expect(cells.get('33:40')).toBe(1)
  })

  it('honours a declared column order', async () => {
    const records = sortRecords(CONTIGS, randomRecords(800, 31))
    const lines: string[] = [
      '## pairs format v1.0',
      ...CONTIGS.map((c) => `#chromsize: ${c.name} ${c.length}`),
      '#columns: chrom1 chrom2 pos1 pos2 readID',
    ]
    for (const r of records) {
      lines.push(`${r.chrom1}\t${r.chrom2}\t${r.pos1}\t${r.pos2}\tSRR.x`)
    }
    const source = new BytesSource(bgzipped(`${lines.join('\n')}\n`))
    const header = await readPairsHeader(source)
    expect(header.columns).toEqual({ chrom1: 0, chrom2: 1, pos1: 2, pos2: 3 })
    const pixels = await binPairs(source, {
      binSize: BIN,
      contigs: header.contigs,
      columns: header.columns,
    })
    const expected = referenceBin(CONTIGS, records, BIN)
    expect(pixels!.sum).toBe(expected.sum)
    expect(pixels!.nnz).toBe(expected.cells.size)
  })

  it('skips records naming a contig the header does not declare', async () => {
    const records: Record[] = [
      { chrom1: 'chrI', pos1: 10, chrom2: 'chrI', pos2: 20 },
      { chrom1: 'chrZ', pos1: 10, chrom2: 'chrI', pos2: 20 },
    ]
    const source = new BytesSource(bgzipped(pairsText({ contigs: CONTIGS, records })))
    const header = await readPairsHeader(source)
    const pixels = await binPairs(source, {
      binSize: BIN,
      contigs: header.contigs,
      columns: header.columns,
    })
    expect(pixels!.sum).toBe(1)
    expect(pixels!.skippedUnknownContig).toBe(1)
  })

  it('tells an unknown contig apart from an unparsable position', async () => {
    // The two have different causes and different fixes: one is a file about
    // another assembly, the other is a `#columns:` line that does not match the
    // records. Reporting the second as the first sends a reader to fix a header
    // that is already right.
    const lines = [
      '## pairs format v1.0',
      ...CONTIGS.map((c) => `#chromsize: ${c.name} ${c.length}`),
      '#columns: readID chr1 pos1 chr2 pos2',
      'a\tchrI\t10\tchrI\t20',
      'b\tchrZ\t10\tchrI\t20',
      'c\tchrI\tnot-a-number\tchrI\t20',
      'd\tchrI\t10\tchrI\t',
    ]
    const source = new BytesSource(bgzipped(`${lines.join('\n')}\n`))
    const header = await readPairsHeader(source)
    const pixels = await binPairs(source, {
      binSize: BIN,
      contigs: header.contigs,
      columns: header.columns,
    })
    expect(pixels!.sum).toBe(1)
    expect(pixels!.skippedUnknownContig).toBe(1)
    expect(pixels!.skippedBadPosition).toBe(2)
  })

  it('notices a file that was cut off, and says which sequences are absent', async () => {
    // Exactly the shape of `demo/yeast/CH128.pairs.gz`: a BGZF file whose tail
    // was never written, so the sequences that sort last never appear. The map
    // that comes out is not blank and not wrong — every number in it is true of
    // the records that arrived — which is precisely why the file has to be
    // reported as incomplete rather than drawn in silence.
    const bulk: Record[] = []
    for (let i = 0; i < 3_000; i++) {
      bulk.push({ chrom1: 'chrI', pos1: 1 + (i % 2_200), chrom2: 'chrI', pos2: 1 + ((i * 7) % 2_200) })
    }
    // The two that sort last, and that the cut will take with it.
    const tail: Record[] = [
      { chrom1: 'chrII', pos1: 10, chrom2: 'chrII', pos2: 20 },
      { chrom1: 'chrIII', pos1: 10, chrom2: 'chrIII', pos2: 20 },
    ]
    const whole = bgzipped(pairsText({ contigs: CONTIGS, records: [...bulk, ...tail] }), 1 << 10)
    // Enough to take the end-of-file marker and the last few members with it.
    const cut = whole.subarray(0, whole.length - 3_000).slice()
    expect(cut.length).toBeGreaterThan(1 << 12)

    const source = new BytesSource(cut)
    const header = await readPairsHeader(source)
    expect(header.contigs).toEqual(CONTIGS)
    const pixels = await binPairs(source, {
      binSize: BIN,
      contigs: header.contigs,
      columns: header.columns,
    })
    expect(pixels!.truncated, 'a file with no EOF marker is truncated').toBe(true)
    expect(pixels!.sum, 'the records that did arrive are still binned').toBeGreaterThan(0)
    expect(pixels!.contigsWithoutCisContacts).toEqual(['chrII', 'chrIII'])
  })

  it('calls a whole file whole, and names no sequence that has a diagonal', async () => {
    const records: Record[] = [
      // One cis contact each, plus a trans one to show it is the *diagonal*
      // that is being asked about rather than mere presence.
      { chrom1: 'chrI', pos1: 10, chrom2: 'chrI', pos2: 20 },
      { chrom1: 'chrII', pos1: 10, chrom2: 'chrII', pos2: 20 },
      { chrom1: 'chrIII', pos1: 30, chrom2: 'chrIII', pos2: 40 },
      { chrom1: 'chrI', pos1: 10, chrom2: 'chrIII', pos2: 20 },
    ]
    const source = new BytesSource(bgzipped(pairsText({ contigs: CONTIGS, records })))
    const header = await readPairsHeader(source)
    const pixels = await binPairs(source, {
      binSize: BIN,
      contigs: header.contigs,
      columns: header.columns,
    })
    expect(pixels!.truncated).toBe(false)
    expect(pixels!.contigsWithoutCisContacts).toEqual([])
  })

  it('claims nothing about a plain gzip, which carries no framing to check', async () => {
    // Absence of evidence: a plain `.gz` says nothing about whether it is
    // whole, so `truncated` stays false rather than guessing either way. The
    // empty-diagonal report is unaffected — it is about the records.
    const records: Record[] = [{ chrom1: 'chrI', pos1: 10, chrom2: 'chrI', pos2: 20 }]
    const source = new BytesSource(gzipped(pairsText({ contigs: CONTIGS, records })))
    const header = await readPairsHeader(source)
    const pixels = await binPairs(source, {
      binSize: BIN,
      contigs: header.contigs,
      columns: header.columns,
    })
    expect(pixels!.truncated).toBe(false)
    expect(pixels!.contigsWithoutCisContacts).toEqual(['chrII', 'chrIII'])
  })

  it('can be cancelled mid-pass', async () => {
    const records = sortRecords(CONTIGS, randomRecords(20_000, 5))
    const source = new BytesSource(bgzipped(pairsText({ contigs: CONTIGS, records }), 1 << 10))
    const header = await readPairsHeader(source)
    let seen = 0
    const pixels = await binPairs(source, {
      binSize: BIN,
      contigs: header.contigs,
      columns: header.columns,
      cancelled: () => ++seen > 2,
    })
    expect(pixels).toBeNull()
  })
})

describe('readPairsHeader', () => {
  it('reads sizes, assembly and sortedness', async () => {
    const text = pairsText({
      contigs: CONTIGS,
      records: [],
      assembly: 'sacCer3',
      sorted: 'chr1-chr2-pos1-pos2',
    })
    const header = await readPairsHeader(new BytesSource(bgzipped(text)))
    expect(header.contigs).toEqual(CONTIGS)
    expect(header.assembly).toBe('sacCer3')
    expect(header.sorted).toBe('chr1-chr2-pos1-pos2')
    expect(header.columns).toEqual({ chrom1: 1, pos1: 2, chrom2: 3, pos2: 4 })
  })

  it('falls back to an embedded SAM header for sizes', async () => {
    const text = pairsText({ contigs: CONTIGS, records: [], samHeaderSizes: true })
    const header = await readPairsHeader(new BytesSource(bgzipped(text)))
    expect(header.contigs).toEqual(CONTIGS)
  })

  it('refuses a file with no preamble', async () => {
    const text = pairsText({ contigs: CONTIGS, records: [], noPreamble: true })
    await expect(readPairsHeader(new BytesSource(bgzipped(text)))).rejects.toThrow(
      /does not begin with a `## pairs format` line/,
    )
  })

  it('refuses a file with no chromosome sizes', async () => {
    const text = ['## pairs format v1.0', '#columns: readID chr1 pos1 chr2 pos2', 'a\tchrI\t1\tchrI\t2'].join('\n')
    await expect(readPairsHeader(new BytesSource(bgzipped(text)))).rejects.toThrow(
      /declares no `#chromsize:` lines/,
    )
  })
})
