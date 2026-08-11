/**
 * A `.hic`, driven entirely through `MetaCooler`.
 *
 * The two suites beside this one prove the format is *read* correctly. This one
 * proves the claim that actually matters to somebody using the app: that having
 * read it, nothing downstream can tell. Every assertion here is made through the
 * ordinary cooler surface — `contigs`, `extent`, `matrix`, `pooledMatrix`,
 * `selectionMatrix`, `scanPixels`, `hasWeights` — with no mention of blocks,
 * versions or normalisation vectors, because that is precisely the code path a
 * view, a track and an analysis task take.
 *
 * If one of these fails, a `.hic` has become a second kind of file somewhere
 * above the reader, and the point of `hic/handle.ts` has been lost.
 */

import { describe, expect, it } from 'vitest'

import { MetaCooler } from '@/metacooler/MetaCooler'
import type { ByteSource, SourceStats } from '@/types'
import { writeHic, type HicRecord } from '../support/hicWriter'

class BytesSource implements ByteSource {
  readonly id: string
  readonly size: number
  constructor(
    private readonly data: Uint8Array,
    id = 'sample.hic',
  ) {
    this.size = data.byteLength
    this.id = id
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

const CHROMS = [
  { name: 'chr1', length: 10_000 },
  { name: 'chr2', length: 4_000 },
]
const BIN = 100
const N1 = 100
const N2 = 40

/** A grid of contacts whose value encodes its own coordinates. */
function grid(nx: number, ny: number, step: number, intra: boolean): HicRecord[] {
  const out: HicRecord[] = []
  for (let x = 0; x < nx; x += step) {
    for (let y = intra ? x : 0; y < ny; y += step) out.push({ x, y, value: 1 })
  }
  return out
}

async function openHic(
  options: { resolutions?: number[]; withNorm?: boolean; uri?: string } = {},
): Promise<MetaCooler> {
  const resolutions = options.resolutions ?? [BIN]
  const written = await writeHic({
    version: 9,
    chroms: CHROMS,
    resolutions,
    records: {
      '1_1': grid(N1, N1, 3, true),
      '2_2': grid(N2, N2, 2, true),
      '1_2': grid(N1, N2, 5, false),
    },
    blockBinCount: 16,
    ...(options.withNorm === true
      ? {
          norms: {
            [`SCALE/1/${BIN}`]: new Float64Array(N1).fill(2),
            [`SCALE/2/${BIN}`]: new Float64Array(N2).fill(4),
          },
        }
      : {}),
  })
  return MetaCooler.fromHic(options.uri ?? 'sample.hic', new BytesSource(written.bytes))
}

describe('a .hic opened as a MetaCooler', () => {
  it('presents its chromosomes as the contig table', async () => {
    const mc = await openHic()
    expect(mc.layout.kind).toBe('hic')
    expect(mc.chromnames).toEqual(['chr1', 'chr2'])
    expect(mc.nContigs).toBe(2)
    expect(mc.nBins).toBe(N1 + N2)
    expect(mc.binsize).toBe(BIN)
    expect(mc.storageMode).toBe('symmetric-upper')
    // No genome layer, exactly as for a cooler — which is what makes every
    // `layout.kind === 'metacool'` branch in the app fall the right way with no
    // edit of its own.
    expect(mc.hasGenomes).toBe(false)
    expect(mc.genomes).toBeNull()
    expect(mc.nGenomes).toBe(0)
    expect(mc.genomeNames).toEqual([])
  })

  it('resolves regions through the ordinary coordinate model', async () => {
    const mc = await openHic()
    expect(mc.contigExtent('chr1')).toEqual([0, N1])
    expect(mc.contigExtent('chr2')).toEqual([N1, N1 + N2])
    expect(mc.extent('chr1:0-1000')).toEqual([0, 10])
    expect(mc.hasContig('chr2')).toBe(true)
    expect(mc.hasContig('chrX')).toBe(false)
  })

  it('reads a dense on-diagonal block', async () => {
    const mc = await openHic()
    const block = await mc.matrix({ rows: [0, 20] })
    expect(block.nrows).toBe(20)
    expect(block.ncols).toBe(20)
    // The fixture puts a contact at every third bin on and above the diagonal,
    // and the read mirrors the stored triangle — so a cell is set exactly when
    // both its coordinates are multiples of three.
    const at = (r: number, c: number): number => block.values[r * 20 + c]
    expect(at(0, 0)).toBe(1)
    expect(at(3, 9)).toBe(1)
    expect(at(9, 3)).toBe(1)
    expect(at(1, 4)).toBe(0)
  })

  it('reads the off-diagonal block between two chromosomes', async () => {
    const mc = await openHic()
    const block = await mc.matrix({ rows: [0, N1], cols: [N1, N1 + N2] })
    expect(block.nrows).toBe(N1)
    expect(block.ncols).toBe(N2)
    let filled = 0
    for (const value of block.values) if (value > 0) filled += 1
    // Every fifth bin on each axis.
    expect(filled).toBe(Math.ceil(N1 / 5) * Math.ceil(N2 / 5))
  })

  it('mirrors the transposed read, so the pair view is never blank', async () => {
    const mc = await openHic()
    const forward = await mc.matrix({ rows: [0, N1], cols: [N1, N1 + N2] })
    const back = await mc.matrix({ rows: [N1, N1 + N2], cols: [0, N1] })
    expect(back.nrows).toBe(N2)
    expect(back.ncols).toBe(N1)
    for (let r = 0; r < N1; r++) {
      for (let c = 0; c < N2; c++) {
        expect(back.values[c * N1 + r]).toBe(forward.values[r * N2 + c])
      }
    }
  })

  it('pools a block coarser than the file stores it', async () => {
    const mc = await openHic()
    const pooled = await mc.pooledMatrix(
      { rows: [0, N1 + N2] },
      { binsPerCell: 10, contigsPerCell: 1 },
    )
    expect(pooled.binsPerCell).toBeGreaterThanOrEqual(10)
    let total = 0
    for (const value of pooled.values) total += value
    expect(total).toBeGreaterThan(0)
  })

  it('walks every pixel for the whole-file scan', async () => {
    const mc = await openHic()
    let seen = 0
    let total = 0
    await mc.scanPixels({
      onChunk: (chunk) => {
        seen += chunk.length
        for (let i = 0; i < chunk.length; i++) total += chunk.count[i]
      },
    })
    const expected =
      grid(N1, N1, 3, true).length + grid(N2, N2, 2, true).length + grid(N1, N2, 5, false).length
    expect(seen).toBe(expected)
    expect(total).toBe(expected)
  })

  it('answers a selection of several sequences', async () => {
    const mc = await openHic()
    const selection = await mc.selectionMatrix(
      [
        { id: 0, extent: [0, N1] },
        { id: 1, extent: [N1, N1 + N2] },
      ],
      { binsPerCell: 5, contigsPerCell: 1 },
    )
    let total = 0
    for (const value of selection.values) total += value
    expect(total).toBeGreaterThan(0)
    expect(selection.ids.length).toBeGreaterThan(0)
  })

  it('says it has no weights when the file was never normalised', async () => {
    const mc = await openHic()
    expect(mc.hasWeights).toBe(false)
    await expect(mc.matrix({ rows: [0, 10], balance: true })).rejects.toThrowError(
      /no normalisation vectors|no \/bins\/weight/,
    )
  })

  it('balances through the same toggle a cooler does', async () => {
    const mc = await openHic({ withNorm: true })
    expect(mc.hasWeights).toBe(true)
    const raw = await mc.matrix({ rows: [0, 10] })
    const balanced = await mc.matrix({ rows: [0, 10], balance: true })
    // Divisors of 2 on both axes, so `bins/weight` is 0.5 and a balanced cell is
    // a quarter of the raw one. The arithmetic is cooler's — multiply by both
    // bin weights — and it is applied by `readDenseMatrix`, unchanged.
    for (let i = 0; i < raw.values.length; i++) {
      expect(balanced.values[i]).toBeCloseTo(raw.values[i] * 0.25, 6)
    }
  })

  it('offers one value column, and reports the float kind', async () => {
    const mc = await openHic()
    expect(mc.scoreColumns).toEqual(['count'])
    // Blocks hold int16 counts or float32 values; claiming an integer kind would
    // license rounding the float case.
    expect(mc.countKind).toBe('f')
  })

  it('exposes its resolution ladder as entries, at the finest by default', async () => {
    const mc = await openHic({ resolutions: [100, 500, 2500] })
    expect(mc.entries).toEqual(['100', '500', '2500'])
    expect(mc.entryGroup).toBe('resolutions')
    expect(mc.binsize).toBe(100)
  })

  it('opens the resolution the URI names', async () => {
    const written = await writeHic({
      version: 9,
      chroms: CHROMS,
      resolutions: [100, 500],
      records: { '1_1': grid(N1, N1, 3, true) },
      blockBinCount: 16,
    })
    const mc = MetaCooler.fromHic(
      'sample.hic::/resolutions/500',
      new BytesSource(written.bytes),
    )
    expect(mc.binsize).toBe(500)
    // The bin grid follows, which is the whole reason the resolution belongs in
    // the URI rather than in a setting beside it.
    expect(mc.nBins).toBe(Math.ceil(10_000 / 500) + Math.ceil(4_000 / 500))
  })

  it('refuses a resolution the file does not carry, naming the ones it does', async () => {
    const written = await writeHic({
      version: 9,
      chroms: CHROMS,
      resolutions: [100, 500],
      records: { '1_1': grid(N1, N1, 3, true) },
    })
    expect(() =>
      MetaCooler.fromHic('sample.hic::/resolutions/1234', new BytesSource(written.bytes)),
    ).toThrowError(/no 1234 bp resolution. It offers 100, 500/)
  })

  it('carries the writer s own attributes into the info panel', async () => {
    const written = await writeHic({
      version: 9,
      chroms: CHROMS,
      resolutions: [BIN],
      records: { '1_1': grid(N1, N1, 3, true) },
      genomeId: 'hg38',
      attributes: { software: 'Juicer Tools 2.20', restrictionEnzyme: 'MboI' },
    })
    const mc = MetaCooler.fromHic('sample.hic', new BytesSource(written.bytes))
    expect(mc.info.assembly).toBe('hg38')
    expect(mc.info.format).toBe('HIC')
    expect(mc.info['format-version']).toBe(9)
    // Passed through untouched, which is the provenance a reader of somebody
    // else's `.hic` most wants and the thing a fixed attribute list would drop.
    expect(mc.info.software).toBe('Juicer Tools 2.20')
    expect(mc.info.restrictionEnzyme).toBe('MboI')
  })
})
