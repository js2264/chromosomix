/**
 * The `.hic` footer walk, over sections that are actually there.
 *
 * `readFooter` does not decode the expected-value vectors — §18 computes its
 * own expectation and the module head says why — but it has to *walk* them,
 * because the normalisation index sits behind them and there is no other way to
 * reach it in v7 and v8. The walk is therefore byte-exact arithmetic over
 * fields whose widths changed at v9, and arithmetic over an empty section is
 * arithmetic that never runs.
 *
 * That is precisely how the reader shipped walking v9's per-chromosome scale
 * factors at v8's width: every fixture emitted `nExpectedValueVectors = 0`, so
 * the loop body was dead code in the suite and live code in the field. The
 * files below turn the option on, and each of them is one Juicer writes: one
 * expected-value vector per resolution, one normalised vector per resolution
 * per normalisation, one scale factor per chromosome. On v9 the old arithmetic
 * overshoots by four bytes per chromosome per vector, which is enough to lose
 * the normalisation index and with it the file's weights.
 *
 * The assertions are all on what is *behind* the sections — `normType`,
 * `normVectors`, `bins/weight` — because that is the only observable the walk
 * has. A walk that ends one byte off reads its next field from inside the
 * previous one.
 */

import { describe, expect, it } from 'vitest'

import { HicFile } from '@/hic/HicFile'
import { hicHandle } from '@/hic/handle'
import { HicStore } from '@/hic/store'
import { planRead } from '@/metacooler/matrix'
import type { ByteSource, Extent, SourceStats } from '@/types'
import { writeHic, type HicRecord } from '../support/hicWriter'

class BytesSource implements ByteSource {
  readonly id = 'footer.hic'
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

/**
 * Eight chromosomes, because the defect is per chromosome per vector.
 *
 * At v9 the wrong width overshoots by `4 B * nChromosomes` for each vector
 * walked, so a two-chromosome fixture drifts by twelve bytes — enough to be
 * wrong, near enough to the truth to land somewhere plausible. A genome-shaped
 * count makes the drift hundreds of bytes and the failure unambiguous, which is
 * what the real files this reader is pointed at look like anyway.
 */
const CHROMS = Array.from({ length: 8 }, (_, at) => ({
  name: `chr${at + 1}`,
  length: 4_000 + at * 500,
}))

/** Divisors for chr1, long enough to cover it at every resolution below. */
function divisorsFor(chromLength: number, binSize: number): Float64Array {
  const out = new Float64Array(Math.ceil(chromLength / binSize))
  for (let i = 0; i < out.length; i++) out[i] = i === 2 ? 0 : 2 + (i % 3)
  return out
}

const RECORDS: HicRecord[] = [
  { x: 0, y: 0, value: 3 },
  { x: 0, y: 5, value: 7 },
  { x: 11, y: 19, value: 2 },
]

const VERSIONS = [7, 8, 9] as const

describe.each(VERSIONS)('a v%i footer whose expected-value sections are populated', (version) => {
  const divisors = divisorsFor(CHROMS[0].length, BIN)

  async function open(extra: Partial<Parameters<typeof writeHic>[0]> = {}): Promise<HicFile> {
    const written = await writeHic({
      version,
      chroms: CHROMS,
      resolutions: [BIN],
      records: { '1_1': RECORDS },
      blockBinCount: 16,
      expectedValues: true,
      norms: { [`KR/1/${BIN}`]: divisors },
      ...extra,
    })
    return HicFile.open(new BytesSource(written.bytes))
  }

  it('is walked to the normalisation index rather than past it', async () => {
    const file = await open()
    // Before the scale-factor width was fixed, v9 arrived here either with an
    // exception out of `parseFooter` or with an empty map, and `normType` is
    // what the Balance control reads: no norm type, no weights, no control, on
    // a file that plainly carries SCALE or KR.
    expect(file.normType).toBe('KR')
  })

  it('reads the weights the file carries, inverted into cooler s convention', async () => {
    const file = await open()
    const handle = hicHandle('footer.hic', file)
    expect(handle.has('bins/weight')).toBe(true)
    const weights = Array.from(handle.readNumeric('bins/weight', 0, 4))
    expect(weights[0]).toBeCloseTo(1 / divisors[0], 5)
    expect(weights[1]).toBeCloseTo(1 / divisors[1], 5)
    // A zero divisor is a bin balancing dropped, and cooler spells that NaN.
    expect(weights[2]).toBeNaN()
    expect(weights[3]).toBeCloseTo(1 / divisors[3], 5)
  })

  it('survives one vector per resolution, which is what a real ladder costs', async () => {
    // Three resolutions is three vectors in each section, so the drift the old
    // arithmetic accumulated is three times the per-vector one. A reader that
    // is nearly right on one vector is visibly wrong on three.
    const file = await open({ resolutions: [BIN, 500, 2500] })
    expect(file.normType).toBe('KR')
    expect(file.binSize).toBe(BIN)
  })

  it('walks a normalised section carrying more than one normalisation', async () => {
    const file = await open({
      norms: {
        [`KR/1/${BIN}`]: divisors,
        [`SCALE/1/${BIN}`]: divisors,
      },
    })
    // The order is the file's, and `normType` is the first offered — the same
    // rule the reader applies to a file with both.
    expect(file.normType).not.toBeNull()
    const handle = hicHandle('footer.hic', file)
    expect(handle.has('bins/weight')).toBe(true)
  })

  it('leaves the master index and the pixels alone', async () => {
    // The master index is parsed *before* the walk, so a drifting cursor cannot
    // corrupt it — which is why the defect this file exists for was invisible
    // to every roundtrip assertion. Pinned so that a future change to the walk
    // that does reach backwards is caught here rather than in a contact map.
    const file = await open()
    const store = new HicStore(file)
    const rows: Extent = [0, 40]
    const seen = new Map<string, number>()
    await store.forEachWindow(rows, rows, planRead(rows, rows, 'symmetric-upper'), (chunk) => {
      for (let i = 0; i < chunk.length; i++) {
        seen.set(`${chunk.bin1[i]},${chunk.bin2[i]}`, chunk.count[i])
      }
    })
    for (const record of RECORDS) {
      expect(seen.get(`${Math.min(record.x, record.y)},${Math.max(record.x, record.y)}`)).toBe(
        record.value,
      )
    }
  })

  it('opens a file that carries the sections and no normalisation vectors', async () => {
    // The walk still has to cross both sections to find out that the index
    // behind them is empty. Getting the widths wrong here is the branch that
    // throws a raw RangeError out of `parseFooter` rather than the one that
    // quietly loses the weights.
    const written = await writeHic({
      version,
      chroms: CHROMS,
      resolutions: [BIN],
      records: { '1_1': RECORDS },
      blockBinCount: 16,
      expectedValues: true,
    })
    const file = HicFile.open(new BytesSource(written.bytes))
    expect(file.normType).toBeNull()
    expect(hicHandle('footer.hic', file).has('bins/weight')).toBe(false)
  })
})

describe('a v9 footer with no pointer to the normalisation index', () => {
  it('is still walked to it, which is the v7/v8 path taken by a v9 file', async () => {
    // v9 added `normVectorIndexPosition` so the sections need not be walked at
    // all, and this reader does not use it (`format.ts` records it for
    // provenance). A file whose pointer is absent or zero — which the format
    // allows and straw handles — therefore has to reach the index the long way
    // at v9 widths, and this is the case that has no v8 fallback behind it.
    const divisors = divisorsFor(CHROMS[0].length, BIN)
    const written = await writeHic({
      version: 9,
      chroms: CHROMS,
      resolutions: [BIN, 500],
      records: { '1_1': RECORDS },
      blockBinCount: 16,
      expectedValues: true,
      withoutNormIndexPointer: true,
      norms: { [`SCALE/1/${BIN}`]: divisors },
    })
    const file = HicFile.open(new BytesSource(written.bytes))
    expect(file.normType).toBe('SCALE')
    expect(Array.from(file.weights(0, 2))[0]).toBeCloseTo(1 / divisors[0], 5)
  })
})
