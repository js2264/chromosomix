/**
 * BGZF and tabix, against files this suite compresses and indexes itself.
 *
 * The claim being tested is *bounded*, not merely *correct*: it is easy to write
 * an index reader that produces the right features by reading the whole file
 * anyway, and that reader would pass every content assertion while delivering
 * none of the point. So the byte spans are asserted directly, and one test
 * measures what was actually read.
 *
 * The fallbacks get as much attention as the happy path, deliberately. Every one
 * of them is a file somebody really has — a plain `.gz` mislabelled with a
 * `.tbi`, an index for a different assembly, a truncated sidecar — and in every
 * case the right behaviour is the whole-file read that always worked. An index
 * that can *prevent* a track from opening is worse than no index.
 */

import { describe, expect, it } from 'vitest'

import {
  BGZF_MAX_BLOCK,
  blockSize,
  inflateBgzf,
  isBgzf,
  matchNames,
  parseTabix,
  spansFor,
  type TabixIndex,
} from '@/annotations/tabix'

/** Deflate one payload, raw, the way a BGZF member holds it. */
async function deflateRaw(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([bytes as BlobPart])
    .stream()
    .pipeThrough(new CompressionStream('deflate-raw'))
  return new Uint8Array(await new Response(stream).arrayBuffer())
}

/** Wrap a payload as one BGZF member, `BC` subfield and all. */
async function bgzfBlock(payload: Uint8Array): Promise<Uint8Array> {
  const deflated = await deflateRaw(payload)
  const total = 12 + 6 + deflated.length + 8
  const out = new Uint8Array(total)
  const view = new DataView(out.buffer)
  out.set([0x1f, 0x8b, 8, 4, 0, 0, 0, 0, 0, 0xff], 0)
  view.setUint16(10, 6, true) // XLEN: one 6-byte subfield
  out[12] = 66 // 'B'
  out[13] = 67 // 'C'
  view.setUint16(14, 2, true)
  // BSIZE is total size *minus one* — the format's own off-by-one.
  view.setUint16(16, total - 1, true)
  out.set(deflated, 18)
  view.setUint32(18 + deflated.length, 0, true) // CRC32, not checked here
  view.setUint32(18 + deflated.length + 4, payload.length, true)
  return out
}

/** Concatenate several BGZF members, recording where each began. */
async function bgzfFile(payloads: Uint8Array[]): Promise<{ bytes: Uint8Array; offsets: number[] }> {
  const blocks: Uint8Array[] = []
  const offsets: number[] = []
  let at = 0
  for (const payload of payloads) {
    const block = await bgzfBlock(payload)
    offsets.push(at)
    at += block.length
    blocks.push(block)
  }
  const bytes = new Uint8Array(at)
  let offset = 0
  for (const block of blocks) {
    bytes.set(block, offset)
    offset += block.length
  }
  return { bytes, offsets }
}

const encode = (text: string): Uint8Array => new TextEncoder().encode(text)

/**
 * Build a `.tbi` body — the inflated one, since `parseTabix` takes that.
 *
 * Only the fields this reader consults are populated with meaning; the rest are
 * written at their documented defaults so the layout is the real one and an
 * offset mistake shows up.
 */
function tabixBody(refs: Array<{ name: string; chunks: Array<[number, number]> }>): Uint8Array {
  const names = refs.map((ref) => ref.name).join('\0') + '\0'
  const nameBytes = encode(names)
  let size = 36 + nameBytes.length
  for (const ref of refs) size += 4 + ref.chunks.length * (4 + 4 + 16) + 4
  const out = new Uint8Array(size)
  const view = new DataView(out.buffer)
  out.set([0x54, 0x42, 0x49, 1], 0) // 'TBI\1'
  view.setInt32(4, refs.length, true)
  view.setInt32(8, 0, true) // format: generic
  view.setInt32(12, 1, true) // col_seq
  view.setInt32(16, 2, true) // col_beg
  view.setInt32(20, 3, true) // col_end
  view.setInt32(24, '#'.charCodeAt(0), true)
  view.setInt32(28, 0, true) // skip
  view.setInt32(32, nameBytes.length, true)
  out.set(nameBytes, 36)
  let at = 36 + nameBytes.length
  for (const ref of refs) {
    view.setInt32(at, ref.chunks.length, true)
    at += 4
    for (const [from, to] of ref.chunks) {
      view.setUint32(at, 4681, true) // bin number; never read
      at += 4
      view.setInt32(at, 1, true) // one chunk in this bin
      at += 4
      // Virtual offsets: block start in the high 48 bits.
      view.setBigUint64(at, BigInt(from) << 16n, true)
      view.setBigUint64(at + 8, BigInt(to) << 16n, true)
      at += 16
    }
    view.setInt32(at, 0, true) // no linear index
    at += 4
  }
  return out
}

describe('BGZF', () => {
  it('recognises a member, and reports its size off the BC subfield', async () => {
    const block = await bgzfBlock(encode('hello'))
    expect(isBgzf(block)).toBe(true)
    expect(blockSize(block)).toBe(block.length)
  })

  it('rejects a plain gzip member, which must keep taking the old path', () => {
    // gzip magic and deflate, but no FEXTRA and no BC subfield: a `bgzip`-less
    // `gzip -c` output, which is most of the `.gz` files in the world.
    const plain = new Uint8Array([0x1f, 0x8b, 8, 0, 0, 0, 0, 0, 0, 0xff, 1, 2])
    expect(isBgzf(plain)).toBe(false)
  })

  it('inflates a run of members into one stream', async () => {
    const { bytes } = await bgzfFile([encode('one\n'), encode('two\n'), encode('three\n')])
    expect(new TextDecoder().decode(await inflateBgzf(bytes))).toBe('one\ntwo\nthree\n')
  })

  it('ignores a trailing partial member rather than failing on it', async () => {
    // Exactly what a bounded read hands back: the span is sized from the index
    // plus a block's slack, so the tail is routinely half a block belonging to
    // the next sequence.
    const { bytes } = await bgzfFile([encode('kept\n'), encode('cut\n')])
    const truncated = bytes.subarray(0, bytes.length - 5)
    expect(new TextDecoder().decode(await inflateBgzf(truncated))).toBe('kept\n')
  })

  it('passes over the empty member a bgzipped file ends with', async () => {
    const { bytes } = await bgzfFile([encode('data\n'), new Uint8Array(0)])
    expect(new TextDecoder().decode(await inflateBgzf(bytes))).toBe('data\n')
  })
})

describe('the tabix index', () => {
  const index = (): TabixIndex =>
    parseTabix(
      tabixBody([
        { name: 'chr1', chunks: [[0, 500]] },
        { name: 'chr2', chunks: [[600, 900]] },
        { name: 'chr3', chunks: [[1000, 1400]] },
      ]),
    )

  it('reads the sequence names and their byte spans', () => {
    const parsed = index()
    expect(parsed.names).toEqual(['chr1', 'chr2', 'chr3'])
    expect(parsed.spans.get('chr2')).toEqual({ from: 600, to: 900 })
    expect(parsed.meta).toBe('#')
  })

  it('refuses something that is not one, by name', () => {
    expect(() => parseTabix(new Uint8Array(64))).toThrowError(/not a tabix index/)
  })

  it('reads a virtual offset past four gigabytes without wrapping', () => {
    // The reason the shift is done in BigInt. A block offset of 5 GB packed into
    // a virtual offset overflows 2^53 before the shift and a `getUint32` pair
    // would silently truncate — on exactly the files large enough to need an
    // index.
    const huge = 5_000_000_000
    const parsed = parseTabix(tabixBody([{ name: 'chr1', chunks: [[huge, huge + 1000]] }]))
    expect(parsed.spans.get('chr1')?.from).toBe(huge)
  })

  it('spans one sequence, with a block s slack past the last record', () => {
    const spans = spansFor(index(), ['chr2'], 10_000_000)
    expect(spans).toEqual([{ from: 600, to: 900 + BGZF_MAX_BLOCK, lastBlock: 900 }])
  })

  it('merges the spans of neighbouring sequences into one request', () => {
    // chr1 and chr2 are 100 bytes apart and the slack already overlaps them, so
    // two sequences cost one range request rather than two.
    const spans = spansFor(index(), ['chr1', 'chr2'], 10_000_000)
    expect(spans.length).toBe(1)
    expect(spans[0].from).toBe(0)
  })

  it('clamps the slack to the end of the file', () => {
    const spans = spansFor(index(), ['chr3'], 1500)
    expect(spans[0].to).toBe(1500)
  })

  it('asks for nothing when the index names no sequence the caller wants', () => {
    const parsed = parseTabix(tabixBody([{ name: 'chrX', chunks: [[0, 10]] }]))
    // …but `matchNames` has already decided that a file with nothing in common
    // is a file about another assembly, and hands back everything, because
    // reading it whole is what would have happened with no index at all.
    expect(matchNames(parsed, ['chr1'])).toEqual(['chrX'])
    expect(spansFor(parsed, ['chr1'], 1000)).toEqual([])
  })
})

describe('matching sequence names', () => {
  const parsed = (): TabixIndex =>
    parseTabix(
      tabixBody([
        { name: 'chr1', chunks: [[0, 10]] },
        { name: 'chr2', chunks: [[20, 30]] },
        { name: 'chrM', chunks: [[40, 50]] },
      ]),
    )

  it('takes only the sequences the map has', () => {
    expect(matchNames(parsed(), ['chr1']).sort()).toEqual(['chr1'])
  })

  it('sees through the chr prefix, in either direction', () => {
    // Ensembl writes `1`, UCSC writes `chr1`, and a reader with one convention
    // and a file with the other is the most common mismatch there is. Reading
    // the whole file because of it would be the index quietly not working.
    expect(matchNames(parsed(), ['1', '2']).sort()).toEqual(['chr1', 'chr2'])
  })

  it('reads everything when the caller names nothing', () => {
    expect(matchNames(parsed(), [])).toEqual(['chr1', 'chr2', 'chrM'])
  })
})

describe('what a bounded read actually costs', () => {
  it('reads one sequence out of twenty-four, and not the rest', async () => {
    // A file with a chunk of records per sequence, sized so the span arithmetic
    // has something to be wrong about.
    const payloads = Array.from({ length: 24 }, (_, i) =>
      encode(
        Array.from({ length: 50 }, (_, j) => `chr${i + 1}\t${j * 100}\t${j * 100 + 50}\tf${j}`).join(
          '\n',
        ) + '\n',
      ),
    )
    const { bytes, offsets } = await bgzfFile(payloads)
    const index = parseTabix(
      tabixBody(
        offsets.map((offset, i) => ({
          name: `chr${i + 1}`,
          chunks: [[offset, offset]] as Array<[number, number]>,
        })),
      ),
    )

    const spans = spansFor(index, matchNames(index, ['chr7']), bytes.length)
    const read = spans.reduce((sum, span) => sum + (span.to - span.from), 0)
    // The whole point, stated as a number: a fraction of the file, not all of it.
    expect(read).toBeLessThan(bytes.length)

    const text = new TextDecoder().decode(
      await inflateBgzf(
        bytes.subarray(spans[0].from, spans[0].to),
        spans[0].lastBlock - spans[0].from,
      ),
    )
    // Every record for the sequence asked for is present…
    expect(text.split('\n').filter((line) => line.startsWith('chr7\t')).length).toBe(50)
    // …and the sequences at the far end of the file were never touched.
    expect(text).not.toContain('chr24\t')
    expect(text).not.toContain('chr1\t0\t')
  })
})
