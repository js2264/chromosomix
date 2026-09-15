/**
 * A normalisation vector that is present by name and empty in fact.
 *
 * Juicer writes an index entry for every normalisation it was asked for, and
 * where the balancer did not converge the vector behind it is all `NaN`. The
 * 4DN chicken maps carry exactly that at 1 kb and 2 kb: a `KR` entry for every
 * chromosome, finite values in none, and a whole `VC_SQRT` beside it. Chosen by
 * name alone, `balanced` drew a blank map at those resolutions and a full one
 * at 5 kb. The reader now tries the next normalisation down the preference
 * list for a chromosome whose preferred vector has nothing in it.
 */

import { describe, expect, it } from 'vitest'

import { HicFile } from '@/hic/HicFile'
import type { ByteSource, SourceStats } from '@/types'
import { writeHic, type HicRecord } from '../support/hicWriter'

class BytesSource implements ByteSource {
  readonly id = 'fallback.hic'
  readonly size: number
  readonly isRemote = false
  constructor(private readonly data: Uint8Array) {
    this.size = data.byteLength
  }
  async mount(): Promise<string> {
    return this.id
  }
  readBytes(position: number, length: number): Uint8Array {
    const n = Math.max(0, Math.min(this.size - position, length))
    return this.data.subarray(position, position + n).slice()
  }
  stats(): SourceStats {
    return { requests: 0, bytes: 0 }
  }
  close(): void {}
}

const BIN = 100
const CHROMS = [
  { name: 'chr1', length: 2_000 },
  { name: 'chr2', length: 1_500 },
]
const RECORDS: HicRecord[] = [
  { x: 0, y: 0, value: 3 },
  { x: 0, y: 5, value: 7 },
  { x: 11, y: 19, value: 2 },
]

function divisors(bins: number, fill: (at: number) => number): Float64Array {
  const out = new Float64Array(bins)
  for (let i = 0; i < bins; i++) out[i] = fill(i)
  return out
}

describe.each([8, 9] as const)('a v%i file whose KR vector is all NaN on one chromosome', (version) => {
  async function open(): Promise<HicFile> {
    const written = await writeHic({
      version,
      chroms: CHROMS,
      resolutions: [BIN],
      records: { '1_1': RECORDS, '2_2': RECORDS },
      blockBinCount: 16,
      norms: {
        // chr1: KR did not converge and was written empty; VC_SQRT is whole.
        [`KR/1/${BIN}`]: divisors(20, () => Number.NaN),
        [`VC_SQRT/1/${BIN}`]: divisors(20, (at) => 2 + (at % 3)),
        // chr2: KR converged, so it is the one used there.
        [`KR/2/${BIN}`]: divisors(15, (at) => 4 + (at % 2)),
        [`VC_SQRT/2/${BIN}`]: divisors(15, () => 1),
      },
    })
    return HicFile.open(new BytesSource(written.bytes))
  }

  it('still names KR as the file’s normalisation', async () => {
    const file = await open()
    expect(file.normType).toBe('KR')
  })

  it('serves chr1 from VC_SQRT and chr2 from KR', async () => {
    const file = await open()
    const chr1 = file.weights(0, 20)
    expect(Array.from(chr1).every((w) => Number.isFinite(w))).toBe(true)
    expect(chr1[0]).toBeCloseTo(1 / 2, 12)
    expect(chr1[1]).toBeCloseTo(1 / 3, 12)
    expect(file.normTypeFor(0)).toBe('VC_SQRT')

    const chr2 = file.weights(20, 35)
    expect(chr2[0]).toBeCloseTo(1 / 4, 12)
    expect(chr2[1]).toBeCloseTo(1 / 5, 12)
    expect(file.normTypeFor(1)).toBe('KR')
  })

  it('leaves NaN where no normalisation has a value', async () => {
    const written = await writeHic({
      version,
      chroms: CHROMS,
      resolutions: [BIN],
      records: { '1_1': RECORDS },
      blockBinCount: 16,
      norms: {
        [`KR/1/${BIN}`]: divisors(20, () => Number.NaN),
        [`VC/1/${BIN}`]: divisors(20, () => Number.NaN),
      },
    })
    const file = HicFile.open(new BytesSource(written.bytes))
    expect(file.normType).toBe('KR')
    expect(Array.from(file.weights(0, 20)).every((w) => Number.isNaN(w))).toBe(true)
    expect(file.normTypeFor(0)).toBeNull()
  })
})
