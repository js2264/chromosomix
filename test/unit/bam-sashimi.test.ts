/**
 * A BAM's own arcs: the introns its reads skip, counted on the depth's pass
 * (§8.23).
 *
 * The claims are the ones that would make a sashimi plot lie without looking
 * wrong. An intron is exactly the reference span of a CIGAR `N`, not a base
 * either side. It is counted from the reads the depth under it counts — the
 * same filter, so a MAPQ floor or a secondary alignment moves both or neither.
 * A read with too many ops for its record carries its CIGAR in a `CG` tag, and
 * the placeholder `N` in the record is the read's whole span: counted, it
 * would be an arc over every such read. And the strand is the aligner's `XS`,
 * or minimap2's `ts` turned over for a reverse read.
 */

import { describe, expect, it } from 'vitest'

import { FLAG, forEachRecord, readHeader, type RecordCursor } from '@/annotations/bam/format'
import { coverageOf, eachIntron, spliceStrand } from '@/annotations/bam/pile'
import type { TrackSampleSet } from '@/annotations/types'
import { junctionsOfSamples } from '@/render/sashimi'
import { bamBytes, tagBytes, type TestRecord } from './bam-fixtures'

const REFS = [{ name: 'chrX', length: 200_000 }]

const from = (bytes: Uint8Array): number => readHeader(bytes)?.recordsFrom ?? 0

/** Every record's first cursor, copied out, with the bytes it points into. */
function cursors(records: TestRecord[]): { bytes: Uint8Array; each: RecordCursor[] } {
  const bytes = bamBytes(REFS, records)
  const each: RecordCursor[] = []
  forEachRecord(bytes, from(bytes), (cursor) => {
    each.push({ ...cursor })
  })
  return { bytes, each }
}

/** The tally `coverageOf` writes, as a plain object. */
function tallyOf(records: TestRecord[], start = 0, end = 200_000, minMapq = 0): Record<string, number> {
  const bytes = bamBytes(REFS, records)
  const introns = new Map<string, number>()
  coverageOf(bytes, from(bytes), 0, start, end, 10, { exclude: 0x904, minMapq }, undefined, introns)
  return Object.fromEntries(introns)
}

describe('an intron', () => {
  it('is exactly the span of a CIGAR N', () => {
    const { bytes, each } = cursors([{ refId: 0, pos: 1000, cigar: '50M300N25M200N25M' }])
    const found: Array<[number, number]> = []
    eachIntron(bytes, each[0], (a, b) => found.push([a, b]))
    // 1,000 + 50 = 1,050 to 1,350; then 25 aligned, 1,375 to 1,575.
    expect(found).toEqual([
      [1050, 1350],
      [1375, 1575],
    ])
  })

  it('steps over what consumes the reference and nothing else', () => {
    // A deletion moves along the reference, an insertion and a soft clip do not.
    const { bytes, each } = cursors([{ refId: 0, pos: 0, cigar: '5S20M3D10M4I10M100N30M' }])
    const found: Array<[number, number]> = []
    eachIntron(bytes, each[0], (a, b) => found.push([a, b]))
    expect(found).toEqual([[43, 143]])
  })

  it('is not read into a read with no N at all', () => {
    const { bytes, each } = cursors([{ refId: 0, pos: 0, cigar: '100M' }])
    let any = false
    eachIntron(bytes, each[0], () => {
      any = true
    })
    expect(any).toBe(false)
  })
})

describe('the strand', () => {
  it('is XS where the aligner wrote one', () => {
    const { bytes, each } = cursors([
      { refId: 0, pos: 0, cigar: '10M100N10M', tags: tagBytes([{ tag: 'NH', type: 'i', value: 1 }, { tag: 'XS', type: 'A', value: '-' }]) },
      { refId: 0, pos: 10, cigar: '10M100N10M', tags: tagBytes([{ tag: 'XS', type: 'A', value: '+' }]) },
      { refId: 0, pos: 20, cigar: '10M100N10M' },
    ])
    expect(each.map((cursor) => spliceStrand(bytes, cursor))).toEqual([-1, 1, 0])
  })

  it('is minimap2’s ts turned over for a reverse read, since ts is the read’s own', () => {
    const { bytes, each } = cursors([
      { refId: 0, pos: 0, cigar: '10M100N10M', tags: tagBytes([{ tag: 'ts', type: 'A', value: '+' }]) },
      { refId: 0, pos: 10, flag: FLAG.REVERSE, cigar: '10M100N10M', tags: tagBytes([{ tag: 'ts', type: 'A', value: '+' }]) },
    ])
    expect(each.map((cursor) => spliceStrand(bytes, cursor))).toEqual([1, -1])
  })
})

describe('the tally on the depth’s pass', () => {
  it('counts each intron once per read that skips it, by strand', () => {
    const xs = (value: string): Uint8Array => tagBytes([{ tag: 'XS', type: 'A', value }])
    const tally = tallyOf([
      { refId: 0, pos: 1000, cigar: '50M300N50M', tags: xs('+') },
      { refId: 0, pos: 1010, cigar: '40M300N60M', tags: xs('+') },
      { refId: 0, pos: 1020, cigar: '30M300N70M', tags: xs('+') },
      { refId: 0, pos: 1020, cigar: '30M500N70M', tags: xs('+') },
    ])
    expect(tally).toEqual({ '1050:1350:1': 3, '1050:1550:1': 1 })
  })

  it('counts nothing the depth does not: a MAPQ floor and a secondary alignment reach both', () => {
    const tally = tallyOf(
      [
        { refId: 0, pos: 1000, mapq: 60, cigar: '50M300N50M' },
        { refId: 0, pos: 1000, mapq: 3, cigar: '50M300N50M' },
        { refId: 0, pos: 1000, mapq: 60, flag: FLAG.SECONDARY, cigar: '50M300N50M' },
      ],
      0,
      200_000,
      10,
    )
    expect(tally).toEqual({ '1050:1350:0': 1 })
  })

  it('keeps an intron that reaches into the window, and drops one that does not', () => {
    const records: TestRecord[] = [
      { refId: 0, pos: 1000, cigar: '50M300N50M' },
      { refId: 0, pos: 5000, cigar: '50M300N50M' },
    ]
    // A window from 1,300 to 1,400 holds the first intron's end and none of the second.
    expect(tallyOf(records, 1300, 1400)).toEqual({ '1050:1350:0': 1 })
  })

  it('reads a long CIGAR from its CG tag rather than the placeholder N', () => {
    // `<l_seq>S<ref_len>N` in the record, the truth in `CG`: 20M100N20M.
    const truth = [(20 << 4) | 0, (100 << 4) | 3, (20 << 4) | 0]
    const tally = tallyOf([
      {
        refId: 0,
        pos: 1000,
        seq: 'A'.repeat(40),
        cigar: '40S140N',
        tags: tagBytes([{ tag: 'CG', type: 'B', subtype: 'I', value: truth }]),
      },
    ])
    expect(tally).toEqual({ '1020:1120:0': 1 })
  })
})

describe('arcs from a sample set', () => {
  it('turns every region’s tally into one set of junctions, a spanning one once', () => {
    const samples: TrackSampleSet = {
      basesPerPixel: 1,
      extent: null,
      regions: [
        {
          contig: 'chrX',
          start: 0,
          end: 2000,
          starts: new Int32Array(0),
          ends: new Int32Array(0),
          values: new Float32Array(0),
          min: null,
          max: null,
          variant: null,
          summary: false,
          junctions: {
            starts: Int32Array.from([1050, 1500]),
            ends: Int32Array.from([1350, 1900]),
            counts: Float32Array.from([3, 7]),
            strands: Int8Array.from([1, -1]),
          },
        },
        {
          contig: 'chrX',
          start: 1800,
          end: 4000,
          starts: new Int32Array(0),
          ends: new Int32Array(0),
          values: new Float32Array(0),
          min: null,
          max: null,
          variant: null,
          summary: false,
          junctions: {
            starts: Int32Array.from([1500]),
            ends: Int32Array.from([1900]),
            counts: Float32Array.from([7]),
            strands: Int8Array.from([-1]),
          },
        },
      ],
    }
    const set = junctionsOfSamples(samples)!
    expect(set.length).toBe(2)
    expect(Array.from(set.start)).toEqual([1050, 1500])
    expect(Array.from(set.score)).toEqual([3, 7])
    expect(Array.from(set.strand)).toEqual([1, -1])
    // Built once per sample set.
    expect(junctionsOfSamples(samples)).toBe(set)
  })

  it('is nothing for a window of unspliced reads', () => {
    const empty: TrackSampleSet = { basesPerPixel: 1, extent: null, regions: [] }
    expect(junctionsOfSamples(empty)).toBe(null)
    expect(junctionsOfSamples(null)).toBe(null)
  })
})
