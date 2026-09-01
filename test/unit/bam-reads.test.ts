/**
 * The read pile: what survives, where it is drawn, and what it disagrees with.
 *
 * Three claims carry most of the weight and each fails silently if it is wrong.
 * **Thinning must be stable**: a read has to keep its place when the window
 * moves and when the lane grows, or reads blink in and out under the reader's
 * hand. **Rows must not overlap**, or two reads are drawn as one. And the
 * **`MD` walk** has to be stepped alongside the CIGAR, because `MD` counts only
 * aligned bases and knows nothing of insertions or clips — the commonest way to
 * get mismatch positions wrong is to walk it against the read instead.
 */

import { describe, expect, it } from 'vitest'

import { readHeader } from '@/annotations/bam/format'
import { DEFAULT_FILTER } from '@/annotations/bam/pile'
import { BASE_LANES, DELETION_LANE, groupsFor, pileOf, thinKey } from '@/annotations/bam/reads'
import { bamBytes, tagBytes, type TestRecord } from './bam-fixtures'

const REFS = [
  { name: 'chrI', length: 230_218 },
  { name: 'chrII', length: 813_184 },
]

const OPTIONS = {
  filter: DEFAULT_FILTER,
  maxRows: 40,
  maxReads: 20_000,
  colourBy: 'strand' as const,
  withNames: true,
}

function pileFor(records: TestRecord[], start = 0, end = 2000, options = {}): ReturnType<typeof pileOf> {
  const bytes = bamBytes(REFS, records)
  const from = readHeader(bytes)?.recordsFrom ?? 0
  return pileOf(bytes, from, 'chrI', 0, start, end, { ...OPTIONS, ...options })
}

describe('what a pile holds', () => {
  it('keeps a read’s aligned extent apart from its soft clips', () => {
    // A clip is drawn, faintly, and it is not alignment: folding it into the
    // extent would say the read covers bases it says nothing about.
    const { pile } = pileFor([{ refId: 0, pos: 500, cigar: '10S80M5S', seq: 'A'.repeat(95) }])
    expect(pile.length).toBe(1)
    expect(pile.refStart[0]).toBe(500)
    expect(pile.refEnd[0]).toBe(580)
    expect(pile.clipStart[0]).toBe(10)
    expect(pile.clipEnd[0]).toBe(5)
  })

  it('carries the CIGAR, so an indel and a gap are three different marks', () => {
    const { pile } = pileFor([{ refId: 0, pos: 100, cigar: '20M5I20M10D20M', seq: 'C'.repeat(65) }])
    const ops = [...pile.opCode.slice(pile.opAt[0], pile.opAt[1])]
    expect(ops).toEqual([0, 1, 0, 2, 0])
    expect([...pile.opLen.slice(pile.opAt[0], pile.opAt[1])]).toEqual([20, 5, 20, 10, 20])
  })

  it('ignores a read on another sequence', () => {
    const { pile } = pileFor([
      { refId: 0, pos: 100, cigar: '50M', seq: 'A'.repeat(50) },
      { refId: 1, pos: 100, cigar: '50M', seq: 'A'.repeat(50) },
    ])
    expect(pile.length).toBe(1)
  })

  it('applies the flag and MAPQ filters the coverage band applies', () => {
    const { pile, total } = pileFor(
      [
        { refId: 0, pos: 100, cigar: '50M', seq: 'A'.repeat(50), mapq: 60 },
        { refId: 0, pos: 100, cigar: '50M', seq: 'A'.repeat(50), mapq: 5 },
        { refId: 0, pos: 100, cigar: '50M', seq: 'A'.repeat(50), flag: 0x100 },
      ],
      0, 2000,
      { filter: { exclude: DEFAULT_FILTER.exclude, minMapq: 30 } },
    )
    expect(total).toBe(1)
    expect(pile.length).toBe(1)
  })
})

describe('packing into rows', () => {
  it('gives overlapping reads different rows', () => {
    const { pile, rows } = pileFor([
      { refId: 0, pos: 100, cigar: '100M', seq: 'A'.repeat(100), name: 'a' },
      { refId: 0, pos: 120, cigar: '100M', seq: 'A'.repeat(100), name: 'b' },
      { refId: 0, pos: 140, cigar: '100M', seq: 'A'.repeat(100), name: 'c' },
    ])
    expect([...pile.row]).toEqual([0, 1, 2])
    expect(rows).toBe(3)
  })

  it('reuses a row once the read before it has ended', () => {
    const { pile, rows } = pileFor([
      { refId: 0, pos: 100, cigar: '100M', seq: 'A'.repeat(100), name: 'a' },
      { refId: 0, pos: 400, cigar: '100M', seq: 'A'.repeat(100), name: 'b' },
    ])
    expect([...pile.row]).toEqual([0, 0])
    expect(rows).toBe(1)
  })

  it('leaves a gap, so two reads in one row do not read as one', () => {
    const { pile } = pileFor([
      { refId: 0, pos: 100, cigar: '100M', seq: 'A'.repeat(100), name: 'a' },
      { refId: 0, pos: 200, cigar: '100M', seq: 'A'.repeat(100), name: 'b' },
    ])
    expect(pile.row[1]).toBe(1)
  })

  it('packs against the clipped extent, so a drawn clip does not overlap', () => {
    const { pile } = pileFor([
      { refId: 0, pos: 100, cigar: '50M', seq: 'A'.repeat(50), name: 'a' },
      { refId: 0, pos: 160, cigar: '20S50M', seq: 'A'.repeat(70), name: 'b' },
    ])
    // The second read's clip reaches back to 140, inside the first read plus
    // the gap — so it cannot share the row.
    expect(pile.row[1]).toBe(1)
  })
})

describe('thinning', () => {
  const many = (n: number): TestRecord[] =>
    Array.from({ length: n }, (_, i) => ({
      refId: 0, pos: 100 + i, cigar: '50M', seq: 'A'.repeat(50), name: `read-${i}`,
    }))

  it('is stable: growing the budget only ever adds reads', () => {
    // The property that stops reads blinking in and out as a lane is resized.
    const small = pileFor(many(400), 0, 2000, { maxRows: 4 })
    const large = pileFor(many(400), 0, 2000, { maxRows: 12 })
    expect(small.capped).toBe(true)
    const kept = (r: ReturnType<typeof pileOf>): Set<string> => new Set(r.pile.names)
    for (const name of kept(small)) {
      expect(kept(large).has(name), `${name} was dropped by a larger budget`).toBe(true)
    }
    expect(large.kept).toBeGreaterThan(small.kept)
  })

  it('is the same choice whatever window the read is seen from', () => {
    // A pan must not reshuffle the pile, so the decision cannot depend on how
    // many other reads happened to be in view.
    const a = pileFor(many(400), 0, 2000, { maxRows: 4 })
    const b = pileFor(many(400), 50, 1900, { maxRows: 4 })
    const inBoth = [...b.pile.names].filter((n) => Number(n.split('-')[1]) >= 0)
    expect(inBoth.length).toBeGreaterThan(0)
    // Every read `b` kept and `a` could also have seen, `a` kept too.
    const keptByA = new Set(a.pile.names)
    for (const name of b.pile.names) expect(keptByA.has(name)).toBe(true)
  })

  it('keeps everything when it fits, and says it was not capped', () => {
    const result = pileFor(many(10))
    expect(result.capped).toBe(false)
    expect(result.kept).toBe(10)
  })

  it('hashes a name to a stable number in [0, 1)', () => {
    const bytes = new TextEncoder().encode('read-1')
    const value = thinKey(bytes, 0, bytes.length)
    expect(value).toBeGreaterThanOrEqual(0)
    expect(value).toBeLessThan(1)
    expect(thinKey(bytes, 0, bytes.length)).toBe(value)
  })
})

describe('base composition, which needs no reference', () => {
  it('counts a column', () => {
    const { counts } = pileFor([
      { refId: 0, pos: 100, cigar: '4M', seq: 'ACGT', name: 'a' },
      { refId: 0, pos: 100, cigar: '4M', seq: 'ACGT', name: 'b' },
      { refId: 0, pos: 100, cigar: '4M', seq: 'TCGT', name: 'c' },
    ], 100, 104)
    const column = (at: number): number[] =>
      [...counts.counts.slice(at * BASE_LANES, at * BASE_LANES + BASE_LANES)]
    // Position 100: two A, one T.
    expect(column(0)).toEqual([2, 0, 0, 1, 0, 0])
    expect(column(1)).toEqual([0, 3, 0, 0, 0, 0])
  })

  it('counts a deletion in its own lane, rather than as absence', () => {
    // A column where half the reads have a deletion is exactly what a reader is
    // looking for; folding it into "no coverage" hides it.
    const { counts } = pileFor([
      { refId: 0, pos: 100, cigar: '2M2D2M', seq: 'ACGT', name: 'a' },
    ], 100, 106)
    const at = 2 * BASE_LANES
    expect(counts.counts[at + DELETION_LANE]).toBe(1)
  })

  it('is counted before thinning, so a deep column is not under-reported', () => {
    const many: TestRecord[] = Array.from({ length: 300 }, (_, i) => ({
      refId: 0, pos: 100, cigar: '4M', seq: 'ACGT', name: `r${i}`,
    }))
    const { counts, capped } = pileFor(many, 100, 104, { maxRows: 2 })
    expect(capped).toBe(true)
    expect(counts.counts[0]).toBe(300)
  })

  it('follows the CIGAR, so an insertion does not shift the columns', () => {
    const { counts } = pileFor([
      { refId: 0, pos: 100, cigar: '2M3I2M', seq: 'ACTTTGT', name: 'a' },
    ], 100, 104)
    const column = (at: number): number[] =>
      [...counts.counts.slice(at * BASE_LANES, at * BASE_LANES + BASE_LANES)]
    expect(column(0)).toEqual([1, 0, 0, 0, 0, 0]) // A
    expect(column(1)).toEqual([0, 1, 0, 0, 0, 0]) // C
    expect(column(2)).toEqual([0, 0, 1, 0, 0, 0]) // G, after the insertion
    expect(column(3)).toEqual([0, 0, 0, 1, 0, 0]) // T
  })
})

describe('disagreement with the reference', () => {
  it('reads =/X operations, where the aligner wrote them', () => {
    const { pile, usedCigar } = pileFor([
      { refId: 0, pos: 100, cigar: '2=1X2=', seq: 'ACGTA', name: 'a' },
    ])
    expect(usedCigar).toBe(true)
    expect([...pile.diffPos.slice(pile.diffAt[0], pile.diffAt[1])]).toEqual([102])
    expect([...pile.diffBase.slice(pile.diffAt[0], pile.diffAt[1])]).toEqual([2]) // G
  })

  it('walks an MD tag alongside the CIGAR', () => {
    // `10A9` — ten matches, then the reference has an A where this read does not.
    const tags = tagBytes([{ tag: 'MD', type: 'Z', value: '10A9' }])
    const { pile, usedMd } = pileFor([
      { refId: 0, pos: 100, cigar: '20M', seq: 'A'.repeat(10) + 'G' + 'A'.repeat(9), tags, name: 'a' },
    ])
    expect(usedMd).toBe(true)
    expect([...pile.diffPos.slice(pile.diffAt[0], pile.diffAt[1])]).toEqual([110])
    expect([...pile.diffBase.slice(pile.diffAt[0], pile.diffAt[1])]).toEqual([2]) // G
  })

  it('counts only aligned bases in MD, so a soft clip does not shift it', () => {
    // The commonest way to get this wrong: MD knows nothing of clips, so a walk
    // against the read rather than against the aligned bases lands five early.
    const tags = tagBytes([{ tag: 'MD', type: 'Z', value: '10A9' }])
    const { pile } = pileFor([
      { refId: 0, pos: 100, cigar: '5S20M', seq: 'TTTTT' + 'A'.repeat(10) + 'C' + 'A'.repeat(9), tags, name: 'a' },
    ])
    expect([...pile.diffPos.slice(pile.diffAt[0], pile.diffAt[1])]).toEqual([110])
    expect([...pile.diffBase.slice(pile.diffAt[0], pile.diffAt[1])]).toEqual([1]) // C
  })

  it('steps over a deletion in MD without consuming an aligned base', () => {
    const tags = tagBytes([{ tag: 'MD', type: 'Z', value: '5^AC5T4' }])
    const { pile } = pileFor([
      { refId: 0, pos: 100, cigar: '5M2D10M', seq: 'A'.repeat(5) + 'A'.repeat(5) + 'G' + 'A'.repeat(4), tags, name: 'a' },
    ])
    // Five matches (100–104), a two-base deletion (105–106), five more
    // (107–111), then the mismatch at 112.
    expect([...pile.diffPos.slice(pile.diffAt[0], pile.diffAt[1])]).toEqual([112])
  })

  it('compares against residues when it has them, and only where both are known', () => {
    const reference = { start: 100, bases: new TextEncoder().encode('ACGTACGTAC') }
    const { pile } = pileFor(
      [{ refId: 0, pos: 100, cigar: '10M', seq: 'ACGTTCGTAC', name: 'a' }],
      100, 110,
      { reference },
    )
    expect([...pile.diffPos.slice(pile.diffAt[0], pile.diffAt[1])]).toEqual([104])
  })

  it('does not call an N a variant', () => {
    const reference = { start: 100, bases: new TextEncoder().encode('ACGTNCGTAC') }
    const { pile } = pileFor(
      [{ refId: 0, pos: 100, cigar: '10M', seq: 'ACGTNCGTAC', name: 'a' }],
      100, 110,
      { reference },
    )
    expect(pile.diffAt[1] - pile.diffAt[0]).toBe(0)
  })

  it('finds nothing when there is nothing to compare against', () => {
    const { pile, usedMd, usedCigar } = pileFor([
      { refId: 0, pos: 100, cigar: '10M', seq: 'ACGTACGTAC', name: 'a' },
    ])
    expect(usedMd).toBe(false)
    expect(usedCigar).toBe(false)
    expect(pile.diffAt[1] - pile.diffAt[0]).toBe(0)
  })
})

describe('pairs', () => {
  const pair = (name: string, a: number, b: number): TestRecord[] => [
    { refId: 0, pos: a, cigar: '50M', seq: 'A'.repeat(50), name, flag: 0x1 | 0x2 | 0x40, nextRefId: 0, nextPos: b, tlen: b - a + 50 },
    { refId: 0, pos: b, cigar: '50M', seq: 'A'.repeat(50), name, flag: 0x1 | 0x2 | 0x80 | 0x10, nextRefId: 0, nextPos: a, tlen: -(b - a + 50) },
  ]

  it('joins the two ends of a template that are both in the window', () => {
    const { pile } = pileFor(pair('frag1', 100, 300))
    expect(pile.mate[0]).toBe(1)
    expect(pile.mate[1]).toBe(0)
  })

  it('leaves a read whose mate is elsewhere unjoined, rather than pointing at nothing', () => {
    const { pile } = pileFor([
      { refId: 0, pos: 100, cigar: '50M', seq: 'A'.repeat(50), name: 'alone', flag: 0x1, nextRefId: 1, nextPos: 5000 },
    ])
    expect(pile.mate[0]).toBe(-1)
    expect(pile.mateContig[0]).toBe(1)
    expect(pile.matePos[0]).toBe(5000)
  })

  it('does not join three records wearing one name', () => {
    const records = [...pair('frag1', 100, 300)]
    records.push({ refId: 0, pos: 500, cigar: '50M', seq: 'A'.repeat(50), name: 'frag1', flag: 0x1 })
    const { pile } = pileFor(records)
    expect([...pile.mate]).toEqual([1, 0, -1])
  })
})

describe('colouring', () => {
  it('separates the strands', () => {
    const { pile } = pileFor([
      { refId: 0, pos: 100, cigar: '50M', seq: 'A'.repeat(50), name: 'f', flag: 0 },
      { refId: 0, pos: 300, cigar: '50M', seq: 'A'.repeat(50), name: 'r', flag: 0x10 },
    ])
    expect([...pile.group]).toEqual([0, 1])
    expect(pile.groups).toEqual(['forward', 'reverse'])
  })

  it('bands mapping quality into the three answers a reader wants', () => {
    const { pile } = pileFor([
      { refId: 0, pos: 100, cigar: '50M', seq: 'A'.repeat(50), name: 'a', mapq: 0 },
      { refId: 0, pos: 300, cigar: '50M', seq: 'A'.repeat(50), name: 'b', mapq: 20 },
      { refId: 0, pos: 500, cigar: '50M', seq: 'A'.repeat(50), name: 'c', mapq: 60 },
    ], 0, 2000, { colourBy: 'mapq' })
    expect([...pile.group]).toEqual([0, 1, 2])
  })

  it('names every category it can produce', () => {
    for (const by of ['strand', 'mapq', 'pair', 'mate', 'insert', 'none'] as const) {
      expect(groupsFor(by).length, by).toBeGreaterThan(0)
    }
  })
})
