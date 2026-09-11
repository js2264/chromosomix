/**
 * The importer's arithmetic, against a second implementation of it.
 *
 * Every assertion here compares `binPairs` to `referenceBin`, which is written
 * the slow obvious way in `test/support/pairs.ts`. The cases are chosen for the
 * three things the fast path assumes: that names can be interned by hash, that
 * `bin1` is non-decreasing, and that the last bin of a contig is short.
 */

import { describe, expect, it } from 'vitest'

import { binPairs, mergeDuplicates, type BinnedPixels } from '@/pairs/bin'
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

/**
 * Flip records into the upper triangle, which is what a real `.pairs` holds.
 *
 * `randomRecords` draws both ends independently, so half its records name the
 * chromosomes the wrong way round — a shape no `pairtools`-produced file has.
 * The sortedness assertions below are about what a *canonical* file looks like,
 * so they have to start from canonical records: `chrom1` before `chrom2` in
 * header order, and `pos1 <= pos2` when the two ends are on one sequence.
 */
function flipped(contigs: readonly Contig[], records: readonly Record[]): Record[] {
  const rank = new Map(contigs.map((contig, i) => [contig.name, i]))
  return records.map((record) => {
    const a = rank.get(record.chrom1) ?? -1
    const b = rank.get(record.chrom2) ?? -1
    const swap = a > b || (a === b && record.pos1 > record.pos2)
    if (!swap) return record
    return {
      chrom1: record.chrom2,
      pos1: record.pos2,
      chrom2: record.chrom1,
      pos2: record.pos1,
    }
  })
}

/** A canonical 4DN file: upper-triangular records in `chr1-chr2-pos1-pos2` order. */
function canonical(records: readonly Record[]): Record[] {
  return sortRecords(CONTIGS, flipped(CONTIGS, records))
}

/** Run the importer over a whole `.pairs` text, reading its own header. */
async function bin(text: string, binSize = BIN): Promise<BinnedPixels> {
  const source = new BytesSource(bgzipped(text))
  const header = await readPairsHeader(source)
  const pixels = await binPairs(source, {
    binSize,
    contigs: header.contigs,
    columns: header.columns,
  })
  expect(pixels).not.toBeNull()
  return pixels!
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
    // `-1` for the strands: this header declares five columns and none of them
    // is one, which is a fact about the file rather than a fault (§3.7).
    expect(header.columns).toEqual({
      chrom1: 0,
      chrom2: 1,
      pos1: 2,
      pos2: 3,
      strand1: -1,
      strand2: -1,
    })
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

  it('calls a canonically sorted multi-chromosome file sorted', async () => {
    // The regression this exists for. `chr1-chr2-pos1-pos2` turns `chrom2`
    // over faster than `chrom1`, so `pos1` — and with it `bin1` — restarts at
    // the top of chrI when the (chrI, chrII) block begins. Reading that as
    // "the file is not sorted" fired on every real multi-chromosome import,
    // put `pairs-required-merge` on the info panel and `required-merge-pass`
    // into the written `.mcool`, and said nothing true about the file.
    const records = canonical(randomRecords(4_000, 17))
    const pixels = await bin(pairsText({ contigs: CONTIGS, records }))
    expect(pixels.wasUnsorted, 'a pairtools-sorted file is not unsorted').toBe(false)
    // And the table is still in cooler's order: the reorder has to keep
    // running, only the accusation stops.
    await expectMatches(bgzipped(pairsText({ contigs: CONTIGS, records })), CONTIGS, records)
  })

  it('calls a sorted single-chromosome file sorted', async () => {
    // The one shape the old check already got right — kept so a future fix
    // cannot buy the case above by breaking this one.
    const solo: Contig[] = [CONTIGS[0]]
    const records = flipped(
      CONTIGS,
      randomRecords(500, 19).filter(
        (record) => record.chrom1 === 'chrI' && record.chrom2 === 'chrI',
      ),
    ).sort((a, b) => a.pos1 - b.pos1 || a.pos2 - b.pos2)
    expect(records.length).toBeGreaterThan(20)
    const pixels = await bin(pairsText({ contigs: solo, records }))
    expect(pixels.wasUnsorted).toBe(false)
  })

  it('calls a file shuffled inside one chromosome pair unsorted', async () => {
    // One block, so no `chrom2` turnover can excuse anything: `bin1` going
    // backwards here is the file's own disorder and has to be reported. The
    // false positive above must not be traded for a false negative.
    const records = [...randomRecords(600, 23)].filter(
      (record) => record.chrom1 === 'chrI' && record.chrom2 === 'chrI',
    )
    const pixels = await bin(pairsText({ contigs: [CONTIGS[0]], records }))
    expect(pixels.wasUnsorted, 'shuffled within a block is genuinely unsorted').toBe(true)
  })

  it('calls a file concatenated from two sorted halves unsorted', async () => {
    // Each half is canonically sorted, so no block is ever out of order from
    // the inside — the only evidence is that (chrI, chrI) comes back after it
    // was closed. `cat a.pairs b.pairs` is how this file gets made, and the
    // reader has to be told, because the table is not the one either half
    // describes.
    const records = [...canonical(randomRecords(1_500, 41)), ...canonical(randomRecords(1_500, 43))]
    const pixels = await bin(pairsText({ contigs: CONTIGS, records }))
    expect(pixels.wasUnsorted, 'a block reappearing is disorder no sort explains').toBe(true)
    await expectMatches(bgzipped(pairsText({ contigs: CONTIGS, records })), CONTIGS, records)
  })

  it('reads the same table whatever trails the coordinate columns', async () => {
    // The record scan stops at the last coordinate column, so a pairtools file
    // carrying `pair_type`, the mapqs and two `sam` fields — hundreds of bytes
    // a record — must produce exactly the table the bare layout does. An
    // early exit that stopped one column short would lose `pos2` and count
    // every record as a bad position instead.
    const records = canonical(randomRecords(1_200, 47))
    const bare = await bin(pairsText({ contigs: CONTIGS, records }))

    const lines: string[] = [
      '## pairs format v1.0',
      ...CONTIGS.map((contig) => `#chromsize: ${contig.name} ${contig.length}`),
      '#columns: chrom1 chrom2 pos1 pos2 readID strand1 strand2 pair_type mapq1 mapq2 sam1 sam2',
    ]
    for (const record of records) {
      lines.push(
        `${record.chrom1}\t${record.chrom2}\t${record.pos1}\t${record.pos2}\tSRR.x\t+\t-\tUU\t60\t60\t` +
          `${'M'.repeat(120)}\t${'M'.repeat(120)}`,
      )
    }
    const loaded = await bin(`${lines.join('\n')}\n`)

    expect(loaded.sum).toBe(bare.sum)
    expect(loaded.nnz).toBe(bare.nnz)
    expect(loaded.skippedBadPosition).toBe(0)
    expect(loaded.skippedUnknownContig).toBe(0)
    expect([...loaded.bin1]).toEqual([...bare.bin1])
    expect([...loaded.bin2]).toEqual([...bare.bin2])
    expect([...loaded.count]).toEqual([...bare.count])
  })

  it('skips a record that stops before its last coordinate column', async () => {
    // The scan can only stop early on a record that *has* the columns. A short
    // one runs to end of line, leaves the missing coordinate at -1, and is
    // counted rather than binned as garbage.
    const lines = [
      '## pairs format v1.0',
      ...CONTIGS.map((contig) => `#chromsize: ${contig.name} ${contig.length}`),
      '#columns: readID chr1 pos1 chr2 pos2',
      'a\tchrI\t10\tchrI\t20',
      'b\tchrI\t10',
      'c\tchrI\t10\tchrI',
    ]
    const pixels = await bin(`${lines.join('\n')}\n`)
    expect(pixels.sum).toBe(1)
    // `b` never reaches `chr2`, `c` never reaches `pos2` — and the two land in
    // different counters, which is the distinction the importer keeps.
    expect(pixels.skippedUnknownContig).toBe(1)
    expect(pixels.skippedBadPosition).toBe(1)
  })
})

describe('mergeDuplicates', () => {
  it('orders and merges a row whether or not it arrived in order', () => {
    // Both row shapes in one table, because the pass now asks each row whether
    // it needs sorting instead of sorting every one. Row 0 arrives ascending
    // with a repeat — the shape a correctly sorted file produces, where the
    // sort would be pure cost — and row 1 arrives out of order with a repeat
    // of its own. Both have to come out ascending, deduplicated, and summed.
    const table: BinnedPixels = {
      binSize: 100,
      contigs: [{ name: 'chrI', length: 400 }],
      chromOffset: Float64Array.from([0, 4]),
      nBins: 4,
      bin1: Int32Array.from([1, 1, 1, 1, 0, 0, 0]),
      bin2: Int32Array.from([3, 1, 3, 2, 0, 2, 2]),
      count: Int32Array.from([5, 1, 2, 4, 7, 3, 6]),
      nnz: 7,
      sum: 28,
      skippedUnknownContig: 0,
      skippedBadPosition: 0,
      clampedPosition: 0,
      wasUnsorted: true,
      truncated: false,
      contigsWithoutCisContacts: [],
    }
    const merged = mergeDuplicates(table)
    expect([...merged.bin1]).toEqual([0, 0, 1, 1, 1])
    expect([...merged.bin2]).toEqual([0, 2, 1, 2, 3])
    expect([...merged.count]).toEqual([7, 9, 1, 4, 7])
    expect(merged.nnz).toBe(5)
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
    expect(header.columns).toEqual({
      chrom1: 1,
      pos1: 2,
      chrom2: 3,
      pos2: 4,
      strand1: 5,
      strand2: 6,
    })
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

/**
 * The four orientation curves, counted in the import's own pass (§3.7).
 *
 * The one thing this importer reads out of a record beyond its four
 * coordinates, and it is read for a *curve beside* the matrix rather than for
 * anything the matrix is built from — no strand reaches a bin, a pixel or a
 * written `.mcool`. What is asserted here is exactly that: the pixels are
 * unchanged by the strands being there, and the counts land in the right one of
 * the four.
 */
describe('orientation counting', () => {
  /** A pairs file whose records carry strands, in the 4DN default order. */
  function stranded(records: Array<Record & { s1: string; s2: string }>): Uint8Array {
    const lines = [
      '## pairs format v1.0',
      ...CONTIGS.map((c) => `#chromsize: ${c.name} ${c.length}`),
      '#columns: readID chr1 pos1 chr2 pos2 strand1 strand2',
    ]
    for (const r of records) {
      lines.push(`R\t${r.chrom1}\t${r.pos1}\t${r.chrom2}\t${r.pos2}\t${r.s1}\t${r.s2}`)
    }
    return bgzipped(`${lines.join('\n')}\n`)
  }

  /** Total counts in each of the four, from a binned result. */
  function totals(pixels: BinnedPixels): number[] {
    const counts = pixels.orientation?.counts
    if (counts === undefined) return []
    return counts.map((array) => array.reduce((sum, value) => sum + value, 0))
  }

  it('files each record under the pair of strands it carries', async () => {
    const source = new BytesSource(
      stranded([
        { chrom1: 'chrI', pos1: 100, chrom2: 'chrI', pos2: 900, s1: '+', s2: '+' },
        { chrom1: 'chrI', pos1: 200, chrom2: 'chrI', pos2: 950, s1: '+', s2: '-' },
        { chrom1: 'chrI', pos1: 300, chrom2: 'chrI', pos2: 980, s1: '+', s2: '-' },
        { chrom1: 'chrI', pos1: 400, chrom2: 'chrI', pos2: 990, s1: '-', s2: '+' },
        { chrom1: 'chrI', pos1: 500, chrom2: 'chrI', pos2: 999, s1: '-', s2: '-' },
      ]),
    )
    const header = await readPairsHeader(source)
    const pixels = await binPairs(source, {
      binSize: BIN,
      contigs: header.contigs,
      columns: header.columns,
    })
    expect(totals(pixels!)).toEqual([1, 2, 1, 1])
    expect(pixels?.orientation?.total).toBe(5)
  })

  it('counts cis records only, since a trans pair has no separation', async () => {
    const source = new BytesSource(
      stranded([
        { chrom1: 'chrI', pos1: 100, chrom2: 'chrII', pos2: 200, s1: '+', s2: '+' },
        { chrom1: 'chrI', pos1: 100, chrom2: 'chrI', pos2: 200, s1: '+', s2: '+' },
      ]),
    )
    const header = await readPairsHeader(source)
    const pixels = await binPairs(source, {
      binSize: BIN,
      contigs: header.contigs,
      columns: header.columns,
    })
    // One of the two, and the trans record is still a pixel.
    expect(pixels?.orientation?.total).toBe(1)
    expect(pixels?.sum).toBe(2)
  })

  it('counts at the record’s own separation rather than at the grid’s', async () => {
    // Both records land in one bin pair at this resolution, and their
    // separations differ by an order of magnitude. A curve on the map's grid
    // could not tell them apart, which is the whole reason this axis is counted
    // from the records.
    const source = new BytesSource(
      stranded([
        { chrom1: 'chrI', pos1: 10, chrom2: 'chrI', pos2: 20, s1: '+', s2: '+' },
        { chrom1: 'chrI', pos1: 1, chrom2: 'chrI', pos2: 99, s1: '+', s2: '+' },
      ]),
    )
    const header = await readPairsHeader(source)
    const pixels = await binPairs(source, {
      binSize: BIN,
      contigs: header.contigs,
      columns: header.columns,
    })
    const counts = pixels!.orientation!.counts[0]
    const filled = [...counts].filter((value) => value > 0)
    expect(filled).toEqual([1, 1])
  })

  it('leaves the pixels exactly as they were without strands', async () => {
    const records = sortRecords(CONTIGS, randomRecords(400, 19))
    // `#columns:` without the strands, which is what a file trimmed by a
    // pipeline looks like. The records still carry two trailing fields and the
    // importer never reaches them, which is the point.
    const plain = new BytesSource(
      bgzipped(
        pairsText({
          contigs: CONTIGS,
          records,
          columns: ['readID', 'chr1', 'pos1', 'chr2', 'pos2'],
        }),
      ),
    )
    const plainHeader = await readPairsHeader(plain)
    const withoutStrands = await binPairs(plain, {
      binSize: BIN,
      contigs: plainHeader.contigs,
      columns: plainHeader.columns,
    })

    const decorated = new BytesSource(
      stranded(records.map((r, i) => ({ ...r, s1: i % 2 === 0 ? '+' : '-', s2: '+' }))),
    )
    const strandedHeader = await readPairsHeader(decorated)
    const withStrands = await binPairs(decorated, {
      binSize: BIN,
      contigs: strandedHeader.contigs,
      columns: strandedHeader.columns,
    })

    expect([...withStrands!.bin1]).toEqual([...withoutStrands!.bin1])
    expect([...withStrands!.bin2]).toEqual([...withoutStrands!.bin2])
    expect([...withStrands!.count]).toEqual([...withoutStrands!.count])
    expect(withoutStrands?.orientation ?? null).toBeNull()
    expect(withStrands?.orientation).not.toBeNull()
  })

  it('has no curves at all for a file that declares no strand columns', async () => {
    const records = sortRecords(CONTIGS, randomRecords(50, 23))
    const source = new BytesSource(
      bgzipped(
        pairsText({
          contigs: CONTIGS,
          records,
          columns: ['readID', 'chr1', 'pos1', 'chr2', 'pos2'],
        }),
      ),
    )
    const header = await readPairsHeader(source)
    const pixels = await binPairs(source, {
      binSize: BIN,
      contigs: header.contigs,
      columns: header.columns,
    })
    expect(pixels?.orientation ?? null).toBeNull()
  })

  it('skips a record whose strand field is neither + nor −', async () => {
    const source = new BytesSource(
      stranded([
        { chrom1: 'chrI', pos1: 100, chrom2: 'chrI', pos2: 900, s1: '.', s2: '+' },
        { chrom1: 'chrI', pos1: 100, chrom2: 'chrI', pos2: 900, s1: '+', s2: '+' },
      ]),
    )
    const header = await readPairsHeader(source)
    const pixels = await binPairs(source, {
      binSize: BIN,
      contigs: header.contigs,
      columns: header.columns,
    })
    // The record is binned — it is a contact — and it is simply not in a curve.
    expect(pixels?.sum).toBe(2)
    expect(pixels?.orientation?.total).toBe(1)
  })
})
