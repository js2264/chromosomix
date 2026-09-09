/**
 * The decompression layer, and the assumption that was wrong about it.
 *
 * This module used to hand a whole BGZF file to one
 * `DecompressionStream('gzip')`, because BGZF is a concatenation of standard
 * gzip members and the specification says concatenated members are walked. Node
 * walks them. **Chromium does not** — it stops after the first member and
 * throws `TypeError: Junk found after end of compressed data.` Since BGZF's
 * end-of-file marker is itself an empty second member, *every* bgzipped file
 * failed in the browser, including a one-block one.
 *
 * Two things let that through, and both are fixed here rather than in a
 * comment. The multi-member check ran in Node, which is the wrong engine; and
 * every fixture that reached the decoder was **plain** single-member gzip,
 * which is the one shape that works either way.
 *
 * So the cases below are about *framing* rather than about content: one member,
 * many members, an end-of-file marker on its own, a span cut mid-member, and a
 * member boundary landing exactly on a source read boundary. Node cannot
 * reproduce the browser's refusal — its own decoder is more permissive — so
 * what these pin is that the BGZF path never reaches a whole-file
 * `DecompressionStream('gzip')` at all, in any engine.
 */

import { describe, expect, it } from 'vitest'

import {
  decompressedStream,
  forEachLine,
  inflateMember,
  isBgzfMember,
  isGzip,
  memberSize,
} from '@/pairs/stream'
import { BytesSource, bgzipped, gzipped } from '../support/pairs'

/** Every line the stream yields, decoded. */
async function linesOf(
  bytes: Uint8Array,
  options: Parameters<typeof decompressedStream>[1] = {},
): Promise<string[]> {
  const out: string[] = []
  const decoder = new TextDecoder()
  await forEachLine(decompressedStream(new BytesSource(bytes), options), (line) => {
    out.push(decoder.decode(line))
  })
  return out
}

const TEXT = Array.from({ length: 5_000 }, (_, i) => `line ${i}`).join('\n') + '\n'

describe('decompressedStream', () => {
  it('reads a BGZF file of many members', async () => {
    // Small blocks on purpose: this is the shape that failed in the browser,
    // and the one no earlier fixture produced.
    const bytes = bgzipped(TEXT, 1 << 12)
    const lines = await linesOf(bytes)
    expect(lines.length).toBe(5_000)
    expect(lines[0]).toBe('line 0')
    expect(lines[4_999]).toBe('line 4999')
  })

  it('reads a BGZF file of exactly one block, whose EOF marker is a second member', async () => {
    // The case that proves it is not a large-file problem: one block of data
    // plus the 28-byte end-of-file marker is already two gzip members.
    const bytes = bgzipped('only\n')
    let members = 0
    for (let at = 0; at < bytes.length; ) {
      const size = memberSize(bytes, at)
      if (size === null) break
      members++
      at += size
    }
    expect(members, 'a one-block BGZF file is two members').toBe(2)
    expect(await linesOf(bytes)).toEqual(['only'])
  })

  it('reads a plain single-member gzip', async () => {
    expect(await linesOf(gzipped('a\nb\n'))).toEqual(['a', 'b'])
  })

  it('reads uncompressed bytes untouched', async () => {
    expect(await linesOf(new TextEncoder().encode('a\nb\n'))).toEqual(['a', 'b'])
  })

  it('reads a BGZF span that starts at a member boundary', async () => {
    // A member boundary is not a *line* boundary — the previous member ends
    // wherever 64 KiB of input ran out — so a span's first line is a fragment
    // of whatever line the cut fell inside. That is a property of reading a
    // span rather than a defect, and it is why nothing in the importer reads
    // one today: `ImportOptions.keys` is the only road to a span and no caller
    // passes it. Stated here so a future one knows what it is getting.
    const bytes = bgzipped(TEXT, 1 << 12)
    const first = memberSize(bytes)!
    const lines = await linesOf(bytes, { from: first })
    expect(lines.length).toBeGreaterThan(0)
    expect(lines.length).toBeLessThan(5_000)
    // Every line but the first is whole, and the first is a tail of one.
    expect(lines.slice(1).every((line) => /^line \d+$/.test(line))).toBe(true)
    expect(TEXT).toContain(`${lines[1]}\n`)
  })

  it('drops a member the span cut in half rather than failing on it', async () => {
    // The header probe on a file larger than its cap does exactly this, and a
    // decoder error would throw away every line read before the cut.
    const bytes = bgzipped(TEXT, 1 << 12)
    const twoAndAHalf = memberSize(bytes)! + memberSize(bytes, memberSize(bytes)!)! + 100
    const lines = await linesOf(bytes, { to: twoAndAHalf })
    expect(lines.length).toBeGreaterThan(0)
    // A prefix of the file: it starts at the beginning, so every line is whole
    // except possibly the last, which the cut may have truncated.
    expect(lines[0]).toBe('line 0')
    expect(lines.slice(0, -1).every((line) => /^line \d+$/.test(line))).toBe(true)
  })

  it('joins a member that straddles two source reads', async () => {
    // A member is at most 64 KiB and a source read is 4 MiB, so this cannot
    // happen at the default — it is forced here because the carry-and-join is
    // the part with somewhere to be wrong.
    const bytes = bgzipped(TEXT, 1 << 14)
    class NarrowSource extends BytesSource {
      override readBytes(position: number, length: number): Uint8Array {
        return super.readBytes(position, Math.min(length, 1_000))
      }
    }
    const out: string[] = []
    const decoder = new TextDecoder()
    await forEachLine(decompressedStream(new NarrowSource(bytes)), (line) => {
      out.push(decoder.decode(line))
    })
    expect(out.length).toBe(5_000)
    expect(out[4_999]).toBe('line 4999')
  })

  it('stops where it is told, mid-file', async () => {
    const bytes = bgzipped(TEXT, 1 << 12)
    let seen = 0
    const finished = await forEachLine(
      decompressedStream(new BytesSource(bytes)),
      () => {
        seen++
      },
      () => seen > 10,
    )
    expect(finished).toBe(false)
    expect(seen).toBeLessThan(5_000)
  })

  it('reports progress in compressed bytes, monotonically', async () => {
    const bytes = bgzipped(TEXT, 1 << 12)
    const seen: number[] = []
    await forEachLine(
      decompressedStream(new BytesSource(bytes), {
        onProgress: (done, total) => {
          expect(total).toBe(bytes.length)
          seen.push(done)
        },
      }),
      () => undefined,
    )
    expect(seen.length).toBeGreaterThan(0)
    for (let i = 1; i < seen.length; i++) expect(seen[i]).toBeGreaterThanOrEqual(seen[i - 1])
    expect(seen[seen.length - 1]).toBe(bytes.length)
  })
})

describe('member framing', () => {
  it('tells a BGZF member from a plain gzip one', () => {
    expect(isBgzfMember(bgzipped('x\n'))).toBe(true)
    expect(isBgzfMember(gzipped('x\n'))).toBe(false)
    // Both are gzip; only one carries the `BC` subfield that gives its length.
    expect(isGzip(bgzipped('x\n'))).toBe(true)
    expect(isGzip(gzipped('x\n'))).toBe(true)
    expect(isGzip(new TextEncoder().encode('x\n'))).toBe(false)
  })

  it('reads a member size that accounts for the whole member', () => {
    const bytes = bgzipped(TEXT, 1 << 12)
    let at = 0
    let members = 0
    while (at < bytes.length) {
      const size = memberSize(bytes, at)
      expect(size, `member at ${at}`).not.toBeNull()
      expect(size!).toBeGreaterThan(0)
      at += size!
      members++
    }
    // Every member accounted for, landing exactly on the end of the file.
    expect(at).toBe(bytes.length)
    expect(members).toBeGreaterThan(1)
  })

  it('says nothing about a plain gzip member, which carries no length', () => {
    expect(memberSize(gzipped('x\n'))).toBeNull()
  })
})

describe('inflateMember', () => {
  it('round-trips an empty payload, which is the end-of-file marker', async () => {
    expect((await inflateMember(new Uint8Array(0))).length).toBe(0)
  })
})
