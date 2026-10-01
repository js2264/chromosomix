/**
 * Base modifications from `MM`/`ML` (SAMtags §1.7), and where they land.
 *
 * Every way of getting these wrong is silent — the calls simply sit on other
 * bases — so each test pins a position, not a count: the skip counts read
 * against the right base, on the read as sequenced (a reverse read counted on
 * the reverse complement of SEQ), `.` against `?`, two codes sharing one
 * cytosine's `ML` bytes, a ChEBI number and the `N` wildcard, and the CIGAR
 * walk that drops calls in clips and insertions and steps over deletions.
 */

import { describe, expect, it } from 'vitest'

import {
  modCallsOf,
  modLabel,
  modStateOf,
  parseMM,
  placeModCalls,
  probabilityOf,
  queryToReference,
  recordModCalls,
  reverseComplement,
} from '@/annotations/bam/basemods'
import { forEachRecord, readHeader, type RecordCursor } from '@/annotations/bam/format'
import { coverageOf, DEFAULT_FILTER, type ModTally } from '@/annotations/bam/pile'
import { pileOf } from '@/annotations/bam/reads'
import { readFilterKey, readStyleOf, defaultReadStyle } from '@/annotations/types'
import { bamBytes, packCigar, tagBytes, type TestRecord } from './bam-fixtures'

//                    0123456789AB
const SEQ = 'ACGTCCAGCATC' // C at 1, 4, 5, 8, 11; A at 0, 6, 9; G at 2, 7

const at = (calls: ReturnType<typeof modCallsOf>): Array<[number, string, number, boolean]> =>
  calls.map((call) => [call.query, call.code, call.prob, call.implicit])

describe('reading MM', () => {
  it('splits groups into base, strand, codes, mode and skips', () => {
    expect(parseMM('C+m?,5,12,0;C+h?,5,12,0;A+a.,0,3;')).toEqual([
      { base: 'C', strand: '+', codes: ['m'], mode: 'explicit', skips: [5, 12, 0] },
      { base: 'C', strand: '+', codes: ['h'], mode: 'explicit', skips: [5, 12, 0] },
      { base: 'A', strand: '+', codes: ['a'], mode: 'implicit', skips: [0, 3] },
    ])
  })

  it('reads two codes run together, a ChEBI number, a minus strand and no mode', () => {
    const [both, chebi, minus, none] = parseMM('C+mh,1;C+76792?,0;G-m,2;N+n,0') ?? []
    expect(both.codes).toEqual(['m', 'h'])
    expect(chebi.codes).toEqual(['76792'])
    expect(minus.strand).toBe('-')
    expect(minus.base).toBe('G')
    // No mode is `.`: the spec makes them the same.
    expect(none.mode).toBe('implicit')
    expect(none.base).toBe('N')
  })

  it('takes a group with no calls and a missing last semicolon, and refuses junk', () => {
    expect(parseMM('C+m?;A+a,1')).toEqual([
      { base: 'C', strand: '+', codes: ['m'], mode: 'explicit', skips: [] },
      { base: 'A', strand: '+', codes: ['a'], mode: 'implicit', skips: [1] },
    ])
    expect(parseMM('C*m,1;')).toBeNull()
    expect(parseMM('X+m,1;')).toBeNull()
  })
})

describe('placing calls on the read', () => {
  it('counts skips over the canonical base and reads ML in order', () => {
    const calls = modCallsOf(SEQ, false, 'C+m?,1,0,1;', [10, 200, 255])
    expect(at(calls)).toEqual([
      [4, 'm', 10, false],
      [5, 'm', 200, false],
      [11, 'm', 255, false],
    ])
  })

  it('makes every skipped base an unmodified call under `.`, and none under `?`', () => {
    const dot = modCallsOf(SEQ, false, 'C+m.,1,0,1;', [10, 200, 255])
    expect(at(dot)).toEqual([
      [1, 'm', 0, true],
      [4, 'm', 10, false],
      [5, 'm', 200, false],
      [8, 'm', 0, true],
      [11, 'm', 255, false],
    ])
    // …and after the last listed base, the rest of that base are unmodified too.
    expect(at(modCallsOf(SEQ, false, 'C+m.,0;', [99]))).toEqual([
      [1, 'm', 99, false],
      [4, 'm', 0, true],
      [5, 'm', 0, true],
      [8, 'm', 0, true],
      [11, 'm', 0, true],
    ])
    expect(at(modCallsOf(SEQ, false, 'C+m?,0;', [99]))).toEqual([[1, 'm', 99, false]])
  })

  it('counts a reverse read on the reverse complement of SEQ, and returns stored indices', () => {
    // As sequenced, the read is the reverse complement: its Cs are SEQ's Gs,
    // met from SEQ's end — stored 7 first, then stored 2.
    expect(reverseComplement(SEQ)).toBe('GATGCTGGACGT')
    expect(at(modCallsOf(SEQ, true, 'C+m?,1;', [230]))).toEqual([[2, 'm', 230, false]])
    expect(at(modCallsOf(SEQ, true, 'C+m,1;', [230]))).toEqual([
      [2, 'm', 230, false],
      [7, 'm', 0, true],
    ])
    // Counted on SEQ as stored, the same tag would have landed on a C.
    expect(SEQ[2]).toBe('G')
  })

  it('matches the letter of a minus-strand group on the read as sequenced', () => {
    // `G-m`: the Gs of the read, whose paired C on the other strand is the 5mC.
    expect(at(modCallsOf(SEQ, false, 'G-m?,1;', [150]))).toEqual([[7, 'm', 150, false]])
  })

  it('gives two codes on one base their bytes position by position', () => {
    const calls = modCallsOf(SEQ, false, 'C+mh?,0,2;', [200, 20, 30, 220])
    expect(at(calls)).toEqual([
      [1, 'm', 200, false],
      [1, 'h', 20, false],
      [8, 'm', 30, false],
      [8, 'h', 220, false],
    ])
  })

  it('carries ML across groups, a ChEBI code and the N wildcard', () => {
    const calls = modCallsOf(SEQ, false, 'C+m?,0;A+a.,1;C+76792?,4;N+n?,2;', [11, 22, 33, 44])
    expect(at(calls)).toEqual([
      [0, 'a', 0, true],
      [1, 'm', 11, false],
      [2, 'n', 44, false],
      [6, 'a', 22, false],
      [9, 'a', 0, true],
      [11, '76792', 33, false],
    ])
  })

  it('treats a missing ML as certain, and refuses tags that do not fit the read', () => {
    expect(at(modCallsOf(SEQ, false, 'C+m?,0;', null))).toEqual([[1, 'm', 255, false]])
    // Skips that run off the end of the read.
    expect(modCallsOf(SEQ, false, 'C+m?,10;', [1])).toEqual([])
    // An ML shorter than the calls MM makes.
    expect(modCallsOf(SEQ, false, 'C+m?,0,0;', [1])).toEqual([])
    expect(modCallsOf('', false, 'C+m?,0;', [1])).toEqual([])
  })
})

describe('placing calls on the reference', () => {
  const cigar = packCigar('2S3M2I3M1D2M')

  it('maps each base of SEQ through the CIGAR', () => {
    expect([...queryToReference(cigar, 100, 12)]).toEqual([
      -1, -1, 100, 101, 102, -1, -1, 103, 104, 105, 107, 108,
    ])
  })

  it('drops calls in a soft clip and an insertion and steps over a deletion', () => {
    const calls = modCallsOf(SEQ, false, 'C+m.,1,0,1;', [10, 200, 255])
    expect(placeModCalls(calls, cigar, 100, 12)).toEqual([
      // query 1 is clipped and query 5 inserted: neither has a column.
      { pos: 102, code: 'm', prob: 10, implicit: false },
      { pos: 104, code: 'm', prob: 0, implicit: true },
      { pos: 108, code: 'm', prob: 255, implicit: false },
    ])
  })
})

describe('probabilities and thresholds', () => {
  it('reads a byte as (p + 0.5) / 256', () => {
    expect(probabilityOf(0)).toBeCloseTo(0.5 / 256)
    expect(probabilityOf(255)).toBeCloseTo(255.5 / 256)
  })

  it('is two-sided: modified above, unmodified below the complement, neither between', () => {
    expect(modStateOf(200, 0.5)).toBe(1)
    expect(modStateOf(127, 0.5)).toBe(0)
    expect(modStateOf(128, 0.5)).toBe(1)
    expect(modStateOf(200, 0.8)).toBe(-1)
    expect(modStateOf(10, 0.8)).toBe(0)
    expect(modStateOf(250, 0.8)).toBe(1)
  })

  it('names codes the way the spec does', () => {
    expect(modLabel('m')).toBe('5mC (m)')
    expect(modLabel('a')).toBe('6mA (a)')
    expect(modLabel('21839')).toBe('4mC (21839)')
    expect(modLabel('99999')).toBe('ChEBI:99999 (99999)')
  })
})

// ---------------------------------------------------------------------------
// Out of BAM bytes
// ---------------------------------------------------------------------------

const REFS = [{ name: 'chrI', length: 230_218 }]

function cursorsOf(records: TestRecord[]): { bytes: Uint8Array; cursors: RecordCursor[] } {
  const bytes = bamBytes(REFS, records)
  const from = readHeader(bytes)?.recordsFrom ?? 0
  const cursors: RecordCursor[] = []
  forEachRecord(bytes, from, (cursor) => {
    cursors.push({ ...cursor })
  })
  return { bytes, cursors }
}

const tagged = (mm: string, ml: number[], extra: Parameters<typeof tagBytes>[0] = []): Uint8Array =>
  tagBytes([
    { tag: 'NM', type: 'i', value: 0 },
    { tag: 'MM', type: 'Z', value: mm },
    { tag: 'ML', type: 'B', subtype: 'C', value: ml },
    ...extra,
  ])

describe('a record’s tags', () => {
  it('finds MM and ML (B:C) among other tags, and places the calls', () => {
    const { bytes, cursors } = cursorsOf([
      { refId: 0, pos: 100, cigar: '2S3M2I3M1D2M', seq: SEQ, tags: tagged('C+m.,1,0,1;', [10, 200, 255]) },
    ])
    expect(recordModCalls(bytes, cursors[0])).toEqual([
      { pos: 102, code: 'm', prob: 10, implicit: false },
      { pos: 104, code: 'm', prob: 0, implicit: true },
      { pos: 108, code: 'm', prob: 255, implicit: false },
    ])
  })

  it('reads a reverse record on its reverse complement', () => {
    const { bytes, cursors } = cursorsOf([
      { refId: 0, pos: 200, flag: 0x10, cigar: '12M', seq: SEQ, tags: tagged('C+m?,1;', [230]) },
    ])
    expect(recordModCalls(bytes, cursors[0])).toEqual([{ pos: 202, code: 'm', prob: 230, implicit: false }])
  })

  it('reads the draft spellings Mm and Ml', () => {
    const tags = tagBytes([
      { tag: 'Mm', type: 'Z', value: 'C+m?,0;' },
      { tag: 'Ml', type: 'B', subtype: 'C', value: [77] },
    ])
    const { bytes, cursors } = cursorsOf([{ refId: 0, pos: 0, cigar: '12M', seq: SEQ, tags }])
    expect(recordModCalls(bytes, cursors[0])).toEqual([{ pos: 1, code: 'm', prob: 77, implicit: false }])
  })

  it('refuses tags whose MN is not this SEQ — they outlived a hard clip', () => {
    const { bytes, cursors } = cursorsOf([
      {
        refId: 0, pos: 0, cigar: '3H12M', seq: SEQ,
        tags: tagged('C+m?,0;', [77], [{ tag: 'MN', type: 'i', value: 15 }]),
      },
    ])
    expect(recordModCalls(bytes, cursors[0])).toEqual([])
  })

  it('is empty for a record with no MM', () => {
    const { bytes, cursors } = cursorsOf([{ refId: 0, pos: 0, cigar: '12M', seq: SEQ }])
    expect(recordModCalls(bytes, cursors[0])).toEqual([])
  })
})

describe('the pile and the depth', () => {
  const records: TestRecord[] = [
    { refId: 0, pos: 100, cigar: '12M', seq: SEQ, name: 'a', tags: tagged('C+m?,1,0,1;C+h?,1;', [10, 200, 255, 90]) },
    { refId: 0, pos: 100, cigar: '12M', seq: SEQ, name: 'b', tags: tagged('C+m?,1,0;', [250, 240]) },
    { refId: 0, pos: 400, cigar: '12M', seq: SEQ, name: 'c' },
  ]

  it('carries the calls on a pile coloured by them, most-called code first', () => {
    const bytes = bamBytes(REFS, records)
    const from = readHeader(bytes)?.recordsFrom ?? 0
    const { pile } = pileOf(bytes, from, 'chrI', 0, 0, 1000, {
      filter: DEFAULT_FILTER, maxRows: 40, maxReads: 1000, colourBy: 'basemod', withNames: true,
    })
    const mods = pile.mods
    expect(mods).toBeDefined()
    if (mods === undefined) return
    expect(mods.codes).toEqual(['m', 'h'])
    // Ranked by calls at p ≥ ½: four of m, none of h.
    expect(mods.counts).toEqual([4, 0])
    expect([...mods.at]).toEqual([0, 4, 6, 6])
    expect([...mods.pos.slice(0, 4)]).toEqual([104, 104, 105, 111])
    // …and none at all under any other colouring: the tags are not read.
    const plain = pileOf(bytes, from, 'chrI', 0, 0, 1000, {
      filter: DEFAULT_FILTER, maxRows: 40, maxReads: 1000, colourBy: 'strand', withNames: true,
    })
    expect(plain.pile.mods).toBeUndefined()
  })

  it('ranks codes by modified calls, so a `.` group’s implicit ones do not win', () => {
    // `A+a.` makes an unmodified call on every A it steps over — three here,
    // against one sure 5mC — and the 5mC is still what an unset choice draws.
    const bytes = bamBytes(REFS, [
      { refId: 0, pos: 0, cigar: '12M', seq: SEQ, tags: tagged('C+m?,0;A+a.,2;', [250, 30]) },
    ])
    const from = readHeader(bytes)?.recordsFrom ?? 0
    const { pile } = pileOf(bytes, from, 'chrI', 0, 0, 100, {
      filter: DEFAULT_FILTER, maxRows: 40, maxReads: 100, colourBy: 'basemod', withNames: true,
    })
    expect(pile.mods?.codes).toEqual(['m', 'a'])
  })

  it('tallies the fraction modified per bin, on the depth’s own pass', () => {
    const bytes = bamBytes(REFS, records)
    const from = readHeader(bytes)?.recordsFrom ?? 0
    const tally: ModTally = new Map()
    coverageOf(bytes, from, 0, 100, 112, 12, DEFAULT_FILTER, undefined, undefined, { tally, threshold: 0.5 })
    const m = tally.get('m')
    expect(m).toBeDefined()
    if (m === undefined) return
    // 104: read a says 10 (unmodified), read b says 250 (modified).
    expect(m.calls[4]).toBe(2)
    expect(m.modified[4]).toBe(1)
    // 105: both modified; 111: one read, modified.
    expect([m.calls[5], m.modified[5]]).toEqual([2, 2])
    expect([m.calls[11], m.modified[11]]).toEqual([1, 1])
    expect(m.calls[0]).toBe(0)
    // A stricter threshold leaves the uncertain call out of both counts.
    const strict: ModTally = new Map()
    coverageOf(bytes, from, 0, 100, 112, 12, DEFAULT_FILTER, undefined, undefined, { tally: strict, threshold: 0.9 })
    expect([strict.get('m')?.calls[5], strict.get('m')?.modified[5]]).toEqual([1, 1])
  })
})

describe('the lane’s stored controls', () => {
  it('clamps what came back from a share link', () => {
    const style = readStyleOf({ ...defaultReadStyle(), colourBy: 'basemod', modCode: 'm; drop', modThreshold: 7, modFraction: 'yes' })
    expect(style.colourBy).toBe('basemod')
    expect(style.modCode).toBe('')
    expect(style.modThreshold).toBe(1)
    expect(style.modFraction).toBe(false)
    expect(readStyleOf({ modCode: '21839', modThreshold: 0.1 }).modCode).toBe('21839')
    expect(readStyleOf({ modThreshold: 0.1 }).modThreshold).toBe(0.5)
  })

  it('keys the depth on the modification only while the depth draws it', () => {
    const off = { ...defaultReadStyle(), modCode: 'h' }
    expect(readFilterKey(off)).toBe(readFilterKey(defaultReadStyle()))
    const on = { ...off, modFraction: true }
    expect(readFilterKey(on)).not.toBe(readFilterKey({ ...on, modCode: 'm' }))
    expect(readFilterKey(on)).not.toBe(readFilterKey({ ...on, modThreshold: 0.8 }))
  })
})
