/**
 * The pairix index reader.
 *
 * Two things here are worth more than the rest. The first is that a `.px2` is
 * **not** a `.tbi` despite being tabix-shaped, and the second is that its
 * config block is a raw C struct dump whose size depends on the compiler that
 * wrote it — so `parsePx2` probes candidate layouts and validates each against
 * the name block that follows. A probe that is never given a wrong candidate is
 * a probe that has not been tested, so indexes are written at both plausible
 * struct sizes and both must read identically.
 */

import { describe, expect, it } from 'vitest'

import { inflateBgzf } from '@/annotations/tabix'
import { parsePx2, spansFor, splitKey } from '@/pairs/px2'
import { BytesSource } from '../support/pairs'
import { px2 } from '../support/px2'

const ENTRIES = [
  { key: 'chrI|chrI', from: 0, to: 4_096 },
  { key: 'chrI|chrII', from: 4_096, to: 8_192 },
  { key: 'chrII|chrII', from: 8_192, to: 12_288 },
]

async function parse(bytes: Uint8Array): ReturnType<typeof parsePx2> extends infer T ? Promise<T> : never {
  return parsePx2(await inflateBgzf(bytes)) as never
}

describe('parsePx2', () => {
  it('reads keys, spans and the exact record count', async () => {
    const index = await parse(px2({ entries: ENTRIES, linecount: 1_234_567 }))
    expect(index.keys).toEqual(ENTRIES.map((entry) => entry.key))
    expect(index.linecount).toBe(1_234_567)
    expect(index.splitChar).toBe('|')
    expect(index.metaChar).toBe('#')
    for (const entry of ENTRIES) {
      expect(index.spans.get(entry.key), entry.key).toEqual({ from: entry.from, to: entry.to })
    }
  })

  it('reads a record count past 2^32, which a 32-bit field could not hold', async () => {
    // A human Hi-C library is routinely half a billion pairs and can exceed
    // four billion; the field is 64-bit in `PX2.004` for exactly that reason.
    const index = await parse(px2({ entries: ENTRIES, linecount: 5_000_000_000 }))
    expect(index.linecount).toBe(5_000_000_000)
  })

  it('reads spans past four gigabytes, where a getUint32 pair would wrap', async () => {
    const far = [{ key: 'chrI|chrI', from: 5_000_000_000, to: 6_000_000_000 }]
    const index = await parse(px2({ entries: far, linecount: 10 }))
    expect(index.spans.get('chrI|chrI')).toEqual({ from: 5_000_000_000, to: 6_000_000_000 })
  })

  it('reads the same index whichever way the config struct was padded', async () => {
    const at36 = await parse(px2({ entries: ENTRIES, linecount: 99, confSize: 36 }))
    const at40 = await parse(px2({ entries: ENTRIES, linecount: 99, confSize: 40 }))
    const at44 = await parse(px2({ entries: ENTRIES, linecount: 99, confSize: 44 }))
    for (const index of [at40, at44]) {
      expect(index.keys).toEqual(at36.keys)
      expect(index.linecount).toBe(at36.linecount)
      expect([...index.spans]).toEqual([...at36.spans])
    }
  })

  it('reads the older magics, whose line count is 32-bit', async () => {
    for (const magic of ['PX2.003', 'PX2.002'] as const) {
      const index = await parse(px2({ entries: ENTRIES, linecount: 4_242, magic }))
      expect(index.linecount, magic).toBe(4_242)
      expect(index.keys, magic).toEqual(ENTRIES.map((entry) => entry.key))
    }
  })

  it('honours a split character other than the default', async () => {
    const entries = [{ key: 'chrIchrII', from: 0, to: 16 }]
    const index = await parse(px2({ entries, linecount: 1, splitChar: '' }))
    expect(index.splitChar).toBe('')
    expect(splitKey(index.keys[0], index.splitChar)).toEqual(['chrI', 'chrII'])
  })

  it('refuses a .tbi by name rather than misreading it', async () => {
    await expect(parse(px2({ entries: ENTRIES, linecount: 1, corruptMagic: true }))).rejects.toThrow(
      /not a pairix index/,
    )
  })

  it('refuses an index too short to hold a header', async () => {
    await expect(parse(new Uint8Array(0).slice())).rejects.toThrow()
  })
})

describe('splitKey', () => {
  it('splits a chromosome pair, and survives a key with no separator', () => {
    expect(splitKey('chr1|chr2', '|')).toEqual(['chr1', 'chr2'])
    expect(splitKey('chr1', '|')).toEqual(['chr1', 'chr1'])
    // A chromosome whose own name contains the separator splits at the first
    // one, which is pairix's own rule and the reason names are read from the
    // index rather than reconstructed.
    expect(splitKey('a|b|c', '|')).toEqual(['a', 'b|c'])
  })
})

describe('spansFor', () => {
  /** A BGZF file whose members are a known size, so block ends are checkable. */
  function sourceOf(bytes: Uint8Array): BytesSource {
    return new BytesSource(bytes, 'sample.pairs.gz')
  }

  it('merges spans that touch, and skips keys the index does not have', async () => {
    // The spans are laid out over a real BGZF file so `blockSize` can read the
    // member header at each `to` and turn a 64 KiB over-ask into an exact end.
    const { bgzipped } = await import('../support/pairs')
    const file = bgzipped('x'.repeat(200_000), 1 << 12)
    const source = sourceOf(file)

    const index = await parse(
      px2({
        entries: [
          { key: 'chrI|chrI', from: 0, to: 0 },
          { key: 'chrII|chrII', from: 0, to: 0 },
        ],
        linecount: 1,
      }),
    )
    const spans = spansFor(index, ['chrI|chrI', 'chrII|chrII', 'nope|nope'], source)
    // Both keys start at the same block, so they merge into one read.
    expect(spans.length).toBe(1)
    expect(spans[0].from).toBe(0)
    // The end is the *exact* end of the member at `to`, not a 64 KiB pad.
    expect(spans[0].to).toBeGreaterThan(0)
    expect(spans[0].to).toBeLessThan(1 << 16)
  })

  it('returns nothing for a key set the index does not know', async () => {
    const { bgzipped } = await import('../support/pairs')
    const source = sourceOf(bgzipped('x'.repeat(1_000)))
    const index = await parse(px2({ entries: ENTRIES, linecount: 1 }))
    expect(spansFor(index, ['other|other'], source)).toEqual([])
  })
})
