/**
 * Recognising a `.pairs` — on a file big enough for it to be hard.
 *
 * The probe reads a slice rather than the file, and the first version of it got
 * that wrong in a way no small fixture could catch: a slice of a gzip stream
 * ends inside a member, the decoder raises when it reaches the cut, and the
 * `catch` around it threw away the line that had *already been decoded*. Every
 * test fixture was under the cut, so every test passed; every real pairs file
 * is over it, so every real pairs file fell through to h5wasm and failed there
 * with `error - name not defined!`.
 *
 * So the sizes here are the point. `LARGE_RECORDS` is chosen to put the first
 * data far past the probe's cut in both compressions, and the bgzipped case is
 * additionally many members long, which is the shape that made the original bug
 * invisible.
 */

import { describe, expect, it } from 'vitest'

import { MetaCooler } from '@/metacooler/MetaCooler'
import { isPairsFile, readPairsHeader } from '@/pairs/format'
import { BytesSource, bgzipped, gzipped, pairsText, rng, type Contig, type Record as PairRecord } from '../support/pairs'

const CONTIGS: Contig[] = [
  { name: 'chrI', length: 400_000 },
  { name: 'chrII', length: 250_000 },
]

/** Enough records that the file is comfortably past any probe slice. */
const LARGE_RECORDS = 40_000

function records(n: number): PairRecord[] {
  const next = rng(99)
  const out: PairRecord[] = []
  for (let i = 0; i < n; i++) {
    const c = CONTIGS[Math.floor(next() * CONTIGS.length)]
    out.push({
      chrom1: c.name,
      pos1: 1 + Math.floor(next() * c.length),
      chrom2: c.name,
      pos2: 1 + Math.floor(next() * c.length),
    })
  }
  return out
}

const TEXT = pairsText({ contigs: CONTIGS, records: records(LARGE_RECORDS), assembly: 'sacCer3' })

describe('isPairsFile', () => {
  it('recognises a bgzipped file of many blocks', async () => {
    const bytes = bgzipped(TEXT, 1 << 14)
    // Many members, so the probe's cut lands mid-file rather than past its end.
    expect(bytes.length).toBeGreaterThan(1 << 16)
    expect(await isPairsFile(new BytesSource(bytes))).toBe(true)
  })

  it('recognises a plain-gzipped file larger than the probe slice', async () => {
    const bytes = gzipped(TEXT)
    expect(bytes.length).toBeGreaterThan(1 << 16)
    expect(await isPairsFile(new BytesSource(bytes))).toBe(true)
  })

  it('recognises an uncompressed file larger than the probe slice', async () => {
    const bytes = new TextEncoder().encode(TEXT)
    expect(bytes.length).toBeGreaterThan(1 << 16)
    expect(await isPairsFile(new BytesSource(bytes))).toBe(true)
  })

  it('reads the header of a large file', async () => {
    const header = await readPairsHeader(new BytesSource(bgzipped(TEXT, 1 << 14)))
    expect(header.contigs).toEqual(CONTIGS)
    expect(header.assembly).toBe('sacCer3')
  })

  it('says no to a gzip that is not a pairs file', async () => {
    const notPairs = gzipped(`${'chr1\t100\t200\tfeature\n'.repeat(20_000)}`)
    expect(await isPairsFile(new BytesSource(notPairs))).toBe(false)
  })

  it('says no to bytes that are not compressed and not pairs', async () => {
    const bytes = new TextEncoder().encode('#not a pairs file\nchr1\t1\tchr1\t2\n')
    expect(await isPairsFile(new BytesSource(bytes))).toBe(false)
  })
})

describe('MetaCooler.open on a compressed file', () => {
  it('refuses a .pairs by asking for a resolution, with the probe attached', async () => {
    const source = new BytesSource(bgzipped(TEXT, 1 << 14))
    await expect(MetaCooler.open('sample.pairs.gz', source)).rejects.toMatchObject({
      code: 'pairs-binning-needed',
      detail: { contigs: CONTIGS.length, assembly: 'sacCer3' },
    })
  })

  it('refuses a gzip that is not a pairs file by name, not by h5wasm', async () => {
    // h5wasm answers a request for a non-HDF5 file's attributes with
    // `error - name not defined!`, which says nothing about the file that was
    // dropped. The refusal has to come first.
    const source = new BytesSource(gzipped('this is not a contact map at all\n'))
    await expect(MetaCooler.open('mystery.gz', source)).rejects.toThrow(/gzip-compressed/)
  })
})
