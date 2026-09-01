/**
 * The BAM reader, against files this suite writes byte by byte.
 *
 * Two claims get most of the attention. The first is that the *reference span*
 * of a record is right, because everything else — which bytes are fetched, what
 * a bin holds, where a read is drawn — is computed from it. The second is that
 * a query is **bounded**: an index reader that returns the right reads by
 * fetching the whole file would pass every content assertion here while
 * delivering none of the point, so the byte spans themselves are asserted.
 */

import { describe, expect, it } from 'vitest'

import {
  CIGAR_OPS,
  DEFAULT_EXCLUDE,
  FLAG,
  consumesQuery,
  consumesReference,
  decodeRecord,
  forEachRecord,
  isBam,
  readHeader,
  readNameAt,
  readSequence,
  readTags,
  type RecordCursor,
} from '@/annotations/bam/format'
import {
  chunksFor,
  forecastBytes,
  parseBamIndex,
  reg2bins,
} from '@/annotations/bam/index'
import { coverageOf, eachAlignedBlock } from '@/annotations/bam/pile'

import { baiBytes, bamBytes, bgzfBlock, csiBytes, tagBytes } from './bam-fixtures'

const REFS = [
  { name: 'chrI', length: 230_218 },
  { name: 'chrII', length: 813_184 },
]

describe('the header', () => {
  it('reads the reference table and the sort order', () => {
    const header = readHeader(bamBytes(REFS, []))
    expect(header).not.toBeNull()
    expect(header?.refs).toEqual(REFS)
    expect(header?.sortOrder).toBe('coordinate')
  })

  it('names a name-sorted file as one, so it can be refused by name', () => {
    const bytes = bamBytes(REFS, [], '@HD\tVN:1.6\tSO:queryname\n')
    expect(readHeader(bytes)?.sortOrder).toBe('queryname')
  })

  it('says unknown when there is no @HD line at all', () => {
    expect(readHeader(bamBytes(REFS, [], '@SQ\tSN:chrI\tLN:230218\n'))?.sortOrder).toBe('unknown')
  })

  it('returns null rather than throwing when the buffer stops mid-table', () => {
    // The multi-block header case: a co-assembly's reference table spans many
    // BGZF blocks, so "inflate the first block and parse" must ask for more
    // rather than fail.
    const whole = bamBytes(REFS, [])
    expect(readHeader(whole.subarray(0, whole.length - 6))).toBeNull()
  })

  it('refuses bytes that are not a BAM', () => {
    expect(isBam(new Uint8Array([1, 2, 3, 4]))).toBe(false)
    expect(() => readHeader(new Uint8Array([1, 2, 3, 4]))).toThrow(/not a BAM/)
  })

  it('points at the first record', () => {
    const bytes = bamBytes(REFS, [{ refId: 0, pos: 100, cigar: '10M' }])
    const header = readHeader(bytes)
    let seen = 0
    forEachRecord(bytes, header?.recordsFrom ?? 0, (cursor) => {
      seen++
      expect(cursor.pos).toBe(100)
    })
    expect(seen).toBe(1)
  })
})

describe('CIGAR', () => {
  it('agrees with the specification on what each op consumes', () => {
    const reference = [...'MIDNSHP=X'].map((_, op) => consumesReference(op))
    expect(reference).toEqual([true, false, true, true, false, false, false, true, true])
    const query = [...'MIDNSHP=X'].map((_, op) => consumesQuery(op))
    expect(query).toEqual([true, true, false, false, true, false, false, true, true])
    expect(CIGAR_OPS).toBe('MIDNSHP=X')
  })

  it('computes a reference end from the ops that advance along it', () => {
    const cases: Array<[string, number]> = [
      ['100M', 100],
      ['10S90M', 90],       // soft clip consumes the read, not the reference
      ['50M10D50M', 110],   // a deletion is reference the read spans
      ['50M10I50M', 100],   // an insertion is not
      ['10M200N90M', 300],  // a spliced read reaches past its own intron
      ['20H80M', 80],
    ]
    for (const [cigar, span] of cases) {
      const bytes = bamBytes(REFS, [{ refId: 0, pos: 1000, cigar }])
      const from = readHeader(bytes)?.recordsFrom ?? 0
      forEachRecord(bytes, from, (cursor) => {
        expect(cursor.end - cursor.pos, cigar).toBe(span)
      })
    }
  })
})

describe('walking records', () => {
  const records = [
    { refId: 0, pos: 10, cigar: '10M', name: 'a', mapq: 60 },
    { refId: 0, pos: 20, cigar: '10M', name: 'bb', mapq: 0, flag: FLAG.REVERSE },
    { refId: 1, pos: 30, cigar: '10M', name: 'ccc', mapq: 30 },
  ]

  it('reads the fixed prefix of every record', () => {
    const bytes = bamBytes(REFS, records)
    const from = readHeader(bytes)?.recordsFrom ?? 0
    const seen: Array<Pick<RecordCursor, 'refId' | 'pos' | 'mapq' | 'flag'>> = []
    forEachRecord(bytes, from, (cursor) => {
      seen.push({ refId: cursor.refId, pos: cursor.pos, mapq: cursor.mapq, flag: cursor.flag })
    })
    expect(seen).toEqual([
      { refId: 0, pos: 10, mapq: 60, flag: 0 },
      { refId: 0, pos: 20, mapq: 0, flag: FLAG.REVERSE },
      { refId: 1, pos: 30, mapq: 30, flag: 0 },
    ])
  })

  it('reads the name at variable offsets', () => {
    const bytes = bamBytes(REFS, records)
    const from = readHeader(bytes)?.recordsFrom ?? 0
    const names: string[] = []
    forEachRecord(bytes, from, (cursor) => void names.push(readNameAt(bytes, cursor)))
    expect(names).toEqual(['a', 'bb', 'ccc'])
  })

  it('stops cleanly at a record cut in half', () => {
    // Exactly the shape of every real window: the fetch over-asks by up to a
    // block, so the buffer ends mid-record.
    const bytes = bamBytes(REFS, records)
    const from = readHeader(bytes)?.recordsFrom ?? 0
    let seen = 0
    forEachRecord(bytes.subarray(0, bytes.length - 8), from, () => void seen++)
    expect(seen).toBe(2)
  })

  it('stops early when the visitor says so', () => {
    const bytes = bamBytes(REFS, records)
    const from = readHeader(bytes)?.recordsFrom ?? 0
    let seen = 0
    forEachRecord(bytes, from, () => {
      seen++
      return false
    })
    expect(seen).toBe(1)
  })
})

describe('the whole record', () => {
  it('unpacks the 4-bit sequence', () => {
    const bytes = bamBytes(REFS, [{ refId: 0, pos: 0, cigar: '8M', seq: 'ACGTACGT' }])
    const from = readHeader(bytes)?.recordsFrom ?? 0
    forEachRecord(bytes, from, (cursor) => {
      expect(readSequence(bytes, cursor.seqAt, cursor.seqLength)).toBe('ACGTACGT')
    })
  })

  it('unpacks an odd-length sequence without a trailing base', () => {
    const bytes = bamBytes(REFS, [{ refId: 0, pos: 0, cigar: '5M', seq: 'ACGTA' }])
    const from = readHeader(bytes)?.recordsFrom ?? 0
    forEachRecord(bytes, from, (cursor) => {
      expect(readSequence(bytes, cursor.seqAt, cursor.seqLength)).toBe('ACGTA')
    })
  })

  it('reads the tag types the alignment features need', () => {
    const tags = tagBytes([
      { tag: 'MD', type: 'Z', value: '50A49' },
      { tag: 'NM', type: 'i', value: 1 },
      { tag: 'RG', type: 'Z', value: 'sample-1' },
      { tag: 'SA', type: 'Z', value: 'chrII,300,+,50M50S,60,0;' },
    ])
    const bytes = bamBytes(REFS, [{ refId: 0, pos: 0, cigar: '4M', seq: 'ACGT', tags }])
    const from = readHeader(bytes)?.recordsFrom ?? 0
    forEachRecord(bytes, from, (cursor) => {
      const record = decodeRecord(bytes, cursor)
      expect(record.tags['MD']).toBe('50A49')
      expect(record.tags['NM']).toBe(1)
      expect(record.tags['RG']).toBe('sample-1')
      expect(record.tags['SA']).toBe('chrII,300,+,50M50S,60,0;')
    })
  })

  it('resolves a long CIGAR out of the CG tag', () => {
    // >65,535 ops cannot fit in n_cigar_op, so the record stores
    // `<l_seq>S<ref_len>N` and the real ops in a B,I tag. The reference span is
    // right either way — which is why coverage never has to know — but the
    // shape of the read is not.
    const real = [(50 << 4) | 0, (100 << 4) | 3, (50 << 4) | 0]
    const tags = tagBytes([{ tag: 'CG', type: 'B', subtype: 'I', value: real }])
    const bytes = bamBytes(REFS, [
      { refId: 0, pos: 0, cigar: '4S200N', seq: 'ACGT', tags },
    ])
    const from = readHeader(bytes)?.recordsFrom ?? 0
    forEachRecord(bytes, from, (cursor) => {
      expect(cursor.end - cursor.pos).toBe(200)
      const record = decodeRecord(bytes, cursor)
      expect([...record.cigar]).toEqual(real)
      expect(record.tags['CG']).toBeUndefined()
    })
  })

  it('reports absent qualities as absent rather than as 255s', () => {
    const bytes = bamBytes(REFS, [{ refId: 0, pos: 0, cigar: '4M', seq: 'ACGT' }])
    const from = readHeader(bytes)?.recordsFrom ?? 0
    forEachRecord(bytes, from, (cursor) => {
      expect(decodeRecord(bytes, cursor).qual).toBeNull()
    })
  })

  it('walks off the end of a truncated tag block without throwing', () => {
    const whole = tagBytes([{ tag: 'MD', type: 'Z', value: 'abc' }])
    expect(() => readTags(whole, 0, whole.length - 2)).not.toThrow()
  })
})

describe('reg2bins', () => {
  it('agrees with the worked example in the specification', () => {
    // The C reference implementation for BAI, for a region at the origin.
    expect(reg2bins(0, 1, 14, 5)).toEqual([0, 1, 9, 73, 585, 4681])
  })

  it('widens one level at a time as the region grows', () => {
    const narrow = reg2bins(0, 16_384, 14, 5)
    const wide = reg2bins(0, 32_768, 14, 5)
    expect(wide.length).toBe(narrow.length + 1)
    expect(wide).toContain(4682)
  })

  it('generalises to the shifts CSI allows', () => {
    // CSI's default is min_shift 14, depth 6 — one level deeper, so one more bin.
    expect(reg2bins(0, 1, 14, 6).length).toBe(7)
  })
})

describe('the index', () => {
  it('reads a BAI and resolves a region to its chunks', async () => {
    const index = await parseBamIndex(
      baiBytes([
        { bins: [{ bin: 4681, chunks: [[1000, 2000]] }], linear: [0] },
        { bins: [], linear: [] },
      ]),
    )
    expect(index.format).toBe('bai')
    const spans = chunksFor(index, 0, 0, 16_384, 10_000_000)
    expect(spans).toHaveLength(1)
    expect(spans[0].from).toBe(1000)
    expect(spans[0].lastBlock).toBe(2000)
  })

  it('drops the pseudo-bin rather than fetching a range made of read counts', async () => {
    const index = await parseBamIndex(
      baiBytes([
        {
          bins: [
            { bin: 4681, chunks: [[1000, 2000]] },
            { bin: 37450, chunks: [[0, 0], [12, 34]] },
          ],
          linear: [0],
        },
      ]),
    )
    expect(index.refs[0].bins.has(37450)).toBe(false)
    expect(index.refs[0].bins.has(4681)).toBe(true)
  })

  it('prunes chunks the linear index puts before the region', async () => {
    // The whole value of the linear index: bin 0 spans the reference, and
    // without a floor a 16 kb window would fetch every chunk in it.
    const index = await parseBamIndex(
      baiBytes([
        {
          bins: [
            { bin: 0, chunks: [[100, 200], [5000, 6000]] },
            { bin: 4682, chunks: [[5000, 6000]] },
          ],
          // The second 16 kb window's records start at block 5000.
          linear: [100, 5000],
        },
      ]),
    )
    const spans = chunksFor(index, 0, 16_384, 32_768, 10_000_000)
    expect(spans.every((span) => span.to > 5000)).toBe(true)
    expect(spans.some((span) => span.from === 100)).toBe(false)
  })

  it('prunes chunks that begin after the window, not only those that end before it', async () => {
    // The ceiling, and leaving it out is invisible in every content assertion
    // and enormous in the forecast. A record goes in the smallest bin that
    // wholly contains it, so a bin near the root holds a handful of reads
    // scattered the length of the reference — and without an upper bound those
    // chunks drag a 10 kb window's span out to the end of the file. Here bin 1
    // spans the whole reference and holds a chunk far past the query; bin 4681
    // holds the reads actually under it.
    const index = await parseBamIndex(
      baiBytes([
        {
          bins: [
            { bin: 4681, chunks: [[1000, 1100]] },
            // A read that crosses a boundary and so lives in a bin near the
            // root, sitting late in the file — after everything the query
            // wants, but in a bin whose *range* covers the query.
            { bin: 1, chunks: [[90_000_000, 90_000_100]] },
            // The next 16 kb window along, which is what gives the ceiling
            // something to find: its records start after the query ends, so
            // nothing at or beyond its first chunk can overlap.
            { bin: 4682, chunks: [[50_000_000, 50_000_100]] },
          ],
          linear: [0],
        },
      ]),
    )
    const spans = chunksFor(index, 0, 0, 16_384, 100_000_000)
    expect(spans.every((span) => span.from < 90_000_000)).toBe(true)
    expect(forecastBytes(spans)).toBeLessThan(1 << 20)
  })

  it('finds no ceiling rather than a wrong one, when nothing is after the query', () => {
    // Bins are numbered consecutively *within* a level and the levels run on
    // from one another, so a scan that walks off the end of one level walks
    // into the next — where the numbers mean something else. Level 1 holds
    // eight bins, 1 to 8, and bin 9 is the first of level 2. Reading bin 9 as
    // "the ninth bin of level 1" yields a ceiling from a bin that is not after
    // the query at all, and every chunk beyond it is dropped: reads lost,
    // silently, only near the end of a reference. Here the only populated bins
    // *contain* the query, so the honest answer is no ceiling and every chunk
    // kept.
    return parseBamIndex(
      baiBytes([
        {
          bins: [
            { bin: 4681, chunks: [[1000, 1100]] },
            { bin: 9, chunks: [[80_000_000, 80_000_100]] },
          ],
          linear: [0],
        },
      ]),
    ).then((index) => {
      const spans = chunksFor(index, 0, 0, 16_384, 100_000_000)
      expect(spans.some((span) => span.from === 80_000_000)).toBe(true)
    })
  })

  it('keeps a chunk that begins before the window ends', async () => {
    // The ceiling must not be so eager that it drops the window's own reads:
    // the bound is "starts at or after the query end", not "is near it".
    const index = await parseBamIndex(
      baiBytes([
        { bins: [{ bin: 4681, chunks: [[1000, 2000]] }], linear: [0] },
      ]),
    )
    expect(chunksFor(index, 0, 0, 16_384, 10_000_000)).toHaveLength(1)
  })

  it('merges chunks that touch and keeps distant ones apart', async () => {
    const index = await parseBamIndex(
      baiBytes([
        {
          bins: [{ bin: 4681, chunks: [[0, 100], [200, 300], [50_000_000, 50_000_100]] }],
          linear: [0],
        },
      ]),
    )
    const spans = chunksFor(index, 0, 0, 16_384, 100_000_000)
    expect(spans).toHaveLength(2)
    expect(spans[0].from).toBe(0)
    expect(spans[1].from).toBe(50_000_000)
  })

  it('answers an unindexed reference with nothing rather than an error', async () => {
    const index = await parseBamIndex(baiBytes([{ bins: [], linear: [] }]))
    expect(chunksFor(index, 0, 0, 1000, 1000)).toEqual([])
    expect(chunksFor(index, 7, 0, 1000, 1000)).toEqual([])
  })

  it('forecasts the fetch before anything is fetched', async () => {
    const index = await parseBamIndex(
      baiBytes([{ bins: [{ bin: 4681, chunks: [[0, 1000]] }], linear: [0] }]),
    )
    const spans = chunksFor(index, 0, 0, 16_384, 100_000)
    // The last block has to be read whole, so the forecast includes its slack.
    expect(forecastBytes(spans)).toBe(spans[0].to - spans[0].from)
    expect(forecastBytes(spans)).toBeGreaterThan(1000)
  })

  it('refuses bytes that are neither BAI nor CSI', async () => {
    await expect(parseBamIndex(new Uint8Array([1, 2, 3, 4]))).rejects.toThrow(/not a BAM index/)
  })
})

describe('CSI, the index a long chromosome must have', () => {
  // BAI cannot address a reference past 2^29 bp, so wheat, axolotl, lungfish
  // and any concatenated pseudo-genome are CSI or nothing. Three things differ
  // and a reader has to get all three right: the geometry is declared rather
  // than fixed, there is no linear index — a `loffset` per bin does its work —
  // and the file is BGZF compressed, which a `.bai` is not.

  /** CSI's default geometry for a long reference: one level deeper than BAI. */
  const MIN_SHIFT = 14
  const DEPTH = 6

  /** The first bin of the deepest level, for `depth` levels of eight. */
  const deepest = (depth: number): number => {
    let offset = 0
    for (let level = 0; level < depth; level++) offset += 1 << (level * 3)
    return offset
  }

  it('reads a CSI through its BGZF wrapper and reports its geometry', async () => {
    const raw = csiBytes([[{ bin: deepest(DEPTH), loffset: 0, chunks: [[1000, 2000]] }]], MIN_SHIFT, DEPTH)
    const index = await parseBamIndex(await bgzfBlock(raw))
    expect(index.format).toBe('csi')
    expect(index.minShift).toBe(MIN_SHIFT)
    expect(index.depth).toBe(DEPTH)
  })

  it('reads one stored flat too, since the two are handed around together', async () => {
    const raw = csiBytes([[{ bin: deepest(DEPTH), loffset: 0, chunks: [[1000, 2000]] }]], MIN_SHIFT, DEPTH)
    expect((await parseBamIndex(raw)).format).toBe('csi')
  })

  it('steps over the auxiliary block rather than reading it as a reference count', async () => {
    // `l_aux` is where a tabix-style header lives in a CSI, and a reader that
    // assumes it is empty reads the aux bytes as `n_ref`.
    const aux = new TextEncoder().encode('some auxiliary data')
    const raw = csiBytes([[{ bin: deepest(DEPTH), loffset: 0, chunks: [[1000, 2000]] }]], MIN_SHIFT, DEPTH, aux)
    const index = await parseBamIndex(await bgzfBlock(raw))
    expect(index.refs).toHaveLength(1)
    expect(index.refs[0].bins.get(deepest(DEPTH))).toHaveLength(1)
  })

  it('resolves a region through the declared geometry', async () => {
    const bin = deepest(DEPTH)
    const index = await parseBamIndex(
      await bgzfBlock(csiBytes([[{ bin, loffset: 0, chunks: [[1000, 2000]] }]], MIN_SHIFT, DEPTH)),
    )
    const spans = chunksFor(index, 0, 0, 16_384, 10_000_000)
    expect(spans).toHaveLength(1)
    expect(spans[0].from).toBe(1000)
  })

  it('uses loffset as its floor, since it has no linear index', async () => {
    // The one thing that makes a CSI query bounded. A bin near the root spans
    // the reference; without a floor a narrow window fetches every chunk in it.
    const bin = deepest(DEPTH)
    const index = await parseBamIndex(
      await bgzfBlock(
        csiBytes(
          [
            [
              // The bin covering the query, whose records start at block 5000.
              { bin: bin + 1, loffset: 5000, chunks: [[5000, 6000]] },
              // A root-level bin holding something long since finished with.
              { bin: 0, loffset: 0, chunks: [[100, 200]] },
            ],
          ],
          MIN_SHIFT,
          DEPTH,
        ),
      ),
    )
    const spans = chunksFor(index, 0, 16_384, 32_768, 10_000_000)
    expect(spans.some((span) => span.from === 100)).toBe(false)
    expect(spans.some((span) => span.from === 5000)).toBe(true)
  })

  it('addresses a coordinate past what BAI can reach', async () => {
    // 2^29 is the whole reason this format is read. The shift for the top level
    // of a depth-6 index is 32, and a JavaScript `>>` takes its count modulo 32
    // — so this is also the regression test for that.
    const far = 600_000_000
    const bins = reg2bins(far, far + 1000, MIN_SHIFT, DEPTH)
    expect(bins).toHaveLength(DEPTH + 1)
    // The root bin is 0 and every level below it is addressed, not wrapped.
    expect(bins[0]).toBe(0)
    expect(new Set(bins).size).toBe(bins.length)
    expect(Math.max(...bins)).toBeGreaterThan(deepest(DEPTH))
  })

  it('does not wrap a shift of 32 back onto the coordinate itself', async () => {
    // The bug directly: `x >> 32` is `x` in JavaScript, so the top level would
    // have produced one bin per base of the window.
    const wide = reg2bins(0, 600_000_000, MIN_SHIFT, DEPTH)
    expect(wide.length).toBeLessThan(100_000)
    expect(wide[0]).toBe(0)
  })
})

describe('coverage', () => {
  const from = (bytes: Uint8Array): number => readHeader(bytes)?.recordsFrom ?? 0

  it('reports mean depth, not a count of reads touching the bin', () => {
    // One 100 bp read across a 1000 bp window drawn as one bin is depth 0.1 —
    // the count-the-reads implementation would say 1, an order of magnitude out.
    const bytes = bamBytes(REFS, [{ refId: 0, pos: 0, cigar: '100M' }])
    const result = coverageOf(bytes, from(bytes), 0, 0, 1000, 1)
    expect(result.depth[0]).toBeCloseTo(0.1, 6)
  })

  it('stacks overlapping reads', () => {
    const bytes = bamBytes(REFS, [
      { refId: 0, pos: 0, cigar: '100M' },
      { refId: 0, pos: 0, cigar: '100M' },
      { refId: 0, pos: 50, cigar: '50M' },
    ])
    const result = coverageOf(bytes, from(bytes), 0, 0, 100, 2)
    expect(result.depth[0]).toBeCloseTo(2, 6)
    expect(result.depth[1]).toBeCloseTo(3, 6)
    expect(result.max).toBeCloseTo(3, 6)
  })

  it('does not count an intron as covered', () => {
    // The claim that decides whether an RNA-seq gene reads as a gene or a block.
    const bytes = bamBytes(REFS, [{ refId: 0, pos: 0, cigar: '50M100N50M' }])
    const result = coverageOf(bytes, from(bytes), 0, 0, 200, 4)
    expect(result.depth[0]).toBeCloseTo(1, 6)   // 0-50 aligned
    expect(result.depth[1]).toBeCloseTo(0, 6)   // 50-100 intron
    expect(result.depth[2]).toBeCloseTo(0, 6)   // 100-150 intron
    expect(result.depth[3]).toBeCloseTo(1, 6)   // 150-200 aligned
  })

  it('counts a deletion as covered', () => {
    const bytes = bamBytes(REFS, [{ refId: 0, pos: 0, cigar: '50M10D50M' }])
    const result = coverageOf(bytes, from(bytes), 0, 0, 110, 1)
    expect(result.depth[0]).toBeCloseTo(1, 6)
  })

  it('excludes secondary, supplementary, unmapped and QC-fail by default', () => {
    const bytes = bamBytes(REFS, [
      { refId: 0, pos: 0, cigar: '100M' },
      { refId: 0, pos: 0, cigar: '100M', flag: FLAG.SECONDARY },
      { refId: 0, pos: 0, cigar: '100M', flag: FLAG.SUPPLEMENTARY },
      { refId: 0, pos: 0, cigar: '100M', flag: FLAG.QC_FAIL },
      { refId: 0, pos: 0, cigar: '100M', flag: FLAG.UNMAPPED },
    ])
    const result = coverageOf(bytes, from(bytes), 0, 0, 100, 1)
    expect(result.total).toBe(5)
    expect(result.kept).toBe(1)
    expect(result.depth[0]).toBeCloseTo(1, 6)
  })

  it('keeps duplicates unless asked otherwise, so it agrees with samtools', () => {
    const bytes = bamBytes(REFS, [
      { refId: 0, pos: 0, cigar: '100M' },
      { refId: 0, pos: 0, cigar: '100M', flag: FLAG.DUPLICATE },
    ])
    expect(coverageOf(bytes, from(bytes), 0, 0, 100, 1).depth[0]).toBeCloseTo(2, 6)
    const filtered = coverageOf(bytes, from(bytes), 0, 0, 100, 1, {
      exclude: DEFAULT_EXCLUDE | FLAG.DUPLICATE,
      minMapq: 0,
    })
    expect(filtered.depth[0]).toBeCloseTo(1, 6)
  })

  it('applies a mapping-quality floor', () => {
    const bytes = bamBytes(REFS, [
      { refId: 0, pos: 0, cigar: '100M', mapq: 60 },
      { refId: 0, pos: 0, cigar: '100M', mapq: 0 },
    ])
    const result = coverageOf(bytes, from(bytes), 0, 0, 100, 1, {
      exclude: DEFAULT_EXCLUDE,
      minMapq: 30,
    })
    expect(result.depth[0]).toBeCloseTo(1, 6)
  })

  it('ignores records belonging to another reference', () => {
    // A fetched span is BGZF blocks, and a block routinely holds the tail of
    // one reference and the head of the next.
    const bytes = bamBytes(REFS, [
      { refId: 0, pos: 0, cigar: '100M' },
      { refId: 1, pos: 0, cigar: '100M' },
    ])
    const result = coverageOf(bytes, from(bytes), 0, 0, 100, 1)
    expect(result.kept).toBe(1)
    expect(result.depth[0]).toBeCloseTo(1, 6)
  })

  it('clips a read that hangs off both ends of the window', () => {
    const bytes = bamBytes(REFS, [{ refId: 0, pos: 0, cigar: '1000M' }])
    const result = coverageOf(bytes, from(bytes), 0, 400, 600, 1)
    expect(result.depth[0]).toBeCloseTo(1, 6)
  })

  it('is empty, not undefined, for a window with nothing in it', () => {
    const bytes = bamBytes(REFS, [{ refId: 0, pos: 0, cigar: '100M' }])
    const result = coverageOf(bytes, from(bytes), 0, 5000, 6000, 4)
    expect(result.kept).toBe(0)
    expect(result.max).toBe(0)
    expect([...result.depth]).toEqual([0, 0, 0, 0])
  })

  it('counts a long-CIGAR read, rather than reading its placeholder as an intron', () => {
    // A record with >65,535 ops keeps `<l_seq>S<ref_len>N` in the record and
    // the truth in a CG tag. Measuring the span works either way; walking it
    // does not — the S consumes no reference and the N is a skip, so a
    // spliced-aware pass emits nothing and the read contributes no depth while
    // still being counted as kept.
    const real = [(50 << 4) | 0, (100 << 4) | 3, (50 << 4) | 0]
    const tags = tagBytes([{ tag: 'CG', type: 'B', subtype: 'I', value: real }])
    const bytes = bamBytes(REFS, [
      { refId: 0, pos: 0, cigar: '4S200N', seq: 'ACGT', tags },
    ])
    const result = coverageOf(bytes, from(bytes), 0, 0, 200, 4)
    expect(result.kept).toBe(1)
    expect(result.depth[0]).toBeCloseTo(1, 6)   // 0-50 aligned
    expect(result.depth[1]).toBeCloseTo(0, 6)   // 50-100 the real intron
    expect(result.depth[2]).toBeCloseTo(0, 6)   // 100-150 the real intron
    expect(result.depth[3]).toBeCloseTo(1, 6)   // 150-200 aligned
  })

  it('emits the aligned blocks a spliced read is made of', () => {
    const bytes = bamBytes(REFS, [{ refId: 0, pos: 100, cigar: '50M100N50M' }])
    const blocks: Array<[number, number]> = []
    forEachRecord(bytes, from(bytes), (cursor) => {
      eachAlignedBlock(bytes, cursor, (a, b) => void blocks.push([a, b]))
    })
    expect(blocks).toEqual([
      [100, 150],
      [250, 300],
    ])
  })
})
