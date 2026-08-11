/**
 * Decoding: names, genome 0, and counts (spec §6.2; corrections #2 and #4).
 *
 * Three failure modes that all look like working software until you check:
 *
 * 1. **A fixed-length string column decoded as Latin-1.** h5py stamps `S<n>`
 *    datatypes ASCII and h5wasm honours that literally — its `slice()` decodes
 *    with `TextDecoder('ascii')`, an alias for windows-1252. Every byte is still
 *    there; only the decoding is wrong, so `Prevotella copri (café strain)`
 *    comes back mojibaked and nothing throws.
 *
 *    **Names are not where this can bite, and deliberately so**: `/contigs`
 *    doubles as cooler's `/chroms` and cooler decodes it with an ASCII
 *    `.astype("U")`, so metacooler refuses to write a non-ASCII name at all and
 *    this viewer does not claim to read one. What a file may still carry is an
 *    extra `/genomes` column — an accented taxonomy is legal metadata cooler
 *    never sees — so the decode is exercised where it can still be wrong, over
 *    the bytes, with no fixture needed to hold them.
 * 2. **Genome 0 assumed to be `__unbinned__`.** `create --drop-unassigned`
 *    omits the row entirely, which makes index 0 an ordinary MAG in exactly the
 *    files that were binned most cleanly (correction #4).
 * 3. **Counts truncated to integers.** `resolve_count_dtype` preserves a float
 *    source column rather than truncating it, so `pixels/count` may be float64
 *    and every value must survive to the canvas unrounded (correction #2).
 */

import { describe, expect, it } from 'vitest'

import { UNBINNED_NAME } from '../../src/constants'
import { parseMetacoolerRange } from '../../src/metacooler/range'
import { decodeFixedStrings } from '../../src/h5/readTable'
import { goldenMaps, loadGolden, openMap, withMap } from './_golden'

const MAPS = goldenMaps()
const find = (id: string) => MAPS.find((m) => m.id === id)!

describe('a fixed-length string column is decoded as UTF-8, not as Latin-1', () => {
  /** One `S<n>` column, as HDF5 stores it: fixed-width records, NUL-padded. */
  function column(values: string[], itemSize: number): Uint8Array {
    const bytes = new Uint8Array(values.length * itemSize)
    const encoder = new TextEncoder()
    values.forEach((value, index) => {
      bytes.set(encoder.encode(value), index * itemSize)
    })
    return bytes
  }

  it('reads a multi-byte character back as itself', () => {
    // What h5wasm's own `slice()` would give for these bytes is `caf├⌐`; the
    // reader takes the raw bytes and decodes them itself for exactly this.
    const values = ['Prevotella', 'Bacteroïdes', '日本のMAG']
    const size = 16
    expect(decodeFixedStrings(column(values, size), size, values.length)).toEqual(values)
  })

  it('strips the NUL padding rather than carrying it into the string', () => {
    const size = 8
    const decoded = decodeFixedStrings(column(['ab'], size), size, 1)
    expect(decoded).toEqual(['ab'])
    expect(decoded[0]).not.toContain('\u0000')
  })

  it('sizes a record by bytes, not by characters', () => {
    // `é` is two bytes, so three of these characters fill a six-byte record and
    // a reader slicing by character would run into its neighbour.
    const size = 6
    const values = ['ééé', 'abc']
    expect(decodeFixedStrings(column(values, size), size, 2)).toEqual(values)
  })
})

// ---------------------------------------------------------------------------

describe('dropped.metacool: genome 0 is an ordinary MAG', () => {
  const map = find('dropped.metacool')

  it('exposes index 0 as a normal, displayable genome', async () => {
    await withMap(map, (mc) => {
      expect(mc.genomeNames[0]).not.toBe(UNBINNED_NAME)
      expect(mc.genomeNames[0]).toBe(map.golden.genomes.rows[0].name)
      expect(mc.hasGenome(UNBINNED_NAME)).toBe(false)

      // Displayable, selectable, and it has a real extent.
      expect(mc.displayGenomes()).toContain(0)
      expect(mc.displayGenomes().length).toBe(mc.nGenomes)
      const name = mc.genomeNames[0]
      expect([...mc.genomeExtent(name)]).toEqual(
        (map.golden.genome_extent as Record<string, [number, number]>)[name],
      )
      const parsed = parseMetacoolerRange(mc, name)
      expect(parsed.kind).toBe('genome')
      expect(parsed.extent[0]).toBe(0)
    })
  })

  it('reports no unassigned statistic rather than inventing one', async () => {
    await withMap(map, (mc) => {
      expect(mc.unassignedStats()).toBeNull()
      expect((map.golden.unbinned as { present: boolean }).present).toBe(false)
    })
  })

  it('the exclusion is by name, and the other fixtures prove it matters', async () => {
    // The same code path on a file that *does* carry the row must exclude
    // index 0 — so `displayGenomes()` cannot be "drop index 0" nor "drop
    // nothing"; it has to be a name match.
    const withRow = find('basic.metacool')
    await withMap(withRow, (mc) => {
      expect(mc.genomeNames[0]).toBe(UNBINNED_NAME)
      expect(mc.displayGenomes()).not.toContain(0)
      expect(mc.displayGenomes()[0]).toBe(1)
    })
  })
})

// ---------------------------------------------------------------------------
// Float counts (correction #2)
// ---------------------------------------------------------------------------

describe('floatcount.metacool: float64 counts survive unrounded', () => {
  const map = find('floatcount.metacool')

  it('resolves the count kind from the dtype *kind*', async () => {
    await withMap(map, (mc) => {
      expect(mc.countKind).toBe('f')
      expect(map.golden.dtypes.pixels.count.kind).toBe('f')
      // h5wasm reports C-struct dtype spellings, so the kind cannot come from
      // slicing the string: float64 is '<d' here, not '<f8'.
      expect(mc.handle.dtype('pixels/count')).toBe('<d')
    })
  })

  it('reads every stored pixel at full precision', async () => {
    const mc = await openMap(map)
    try {
      const bin1 = mc.handle.readNumeric('pixels/bin1_id')
      const bin2 = mc.handle.readNumeric('pixels/bin2_id')
      const count = mc.handle.readNumeric('pixels/count')
      expect(count.length).toBe(mc.nnz)

      const stored = new Map<string, number>()
      for (let i = 0; i < count.length; i++) stored.set(`${bin1[i]}:${bin2[i]}`, count[i])

      let fractional = 0
      for (const record of map.golden.pixels_for_genome_pair as PixelRecord[]) {
        let sum = 0
        for (const pixel of record.pixels) {
          const actual = stored.get(`${pixel.bin1_id}:${pixel.bin2_id}`)
          expect(actual, `${record.g1}×${record.g2} @ ${pixel.bin1_id},${pixel.bin2_id}`).toBe(
            pixel.count,
          )
          if (!Number.isInteger(pixel.count)) fractional += 1
          sum += pixel.count
        }
        expect(record.pixels.length).toBe(record.n)
        expect(sum).toBeCloseTo(record.sum, 9)
      }
      // The fixture really does carry fractional counts; without this the
      // equality above would pass on a reader that rounded.
      expect(fractional).toBeGreaterThan(0)
    } finally {
      mc.close()
    }
  })

  it('carries the fraction through to the dense block', async () => {
    await withMap(map, async (mc) => {
      for (const record of map.golden.matrices as GoldenMatrix[]) {
        if (record.level !== 'bin') continue
        const dense = await mc.matrix({ rows: record.rows!, cols: record.cols! })
        let fractional = 0
        for (let r = 0; r < dense.nrows; r++) {
          for (let c = 0; c < dense.ncols; c++) {
            const actual = dense.values[r * dense.ncols + c]
            expect(actual).toBe(record.values[r][c])
            if (!Number.isInteger(actual)) fractional += 1
          }
        }
        if (record.id.startsWith('genome:')) expect(fractional).toBeGreaterThan(0)
      }
    })
  })

  it('an int64 file is read as an integer kind, not as a float', async () => {
    // The other half of correction #2: `binnify` widens counts to int64, whose
    // h5wasm dtype is '<q'. Reading `dtype[1]` would call that kind 'q' and
    // refuse the file.
    const int64 = find('int64.metacool')
    await withMap(int64, (mc) => {
      expect(mc.handle.dtype('pixels/count')).toBe('<q')
      expect(mc.countKind).toBe('i')
      expect(int64.golden.count_dtype_kind).toBe('i')
    })
  })
})

// ---------------------------------------------------------------------------
// The control: integer counts on the base fixture
// ---------------------------------------------------------------------------

describe('integer counts are exact too', () => {
  it('basic.metacool pixel values match the golden pixel records', async () => {
    const map = find('basic.metacool')
    const mc = await openMap(map)
    try {
      const bin1 = mc.handle.readNumeric('pixels/bin1_id')
      const bin2 = mc.handle.readNumeric('pixels/bin2_id')
      const count = mc.handle.readNumeric('pixels/count')
      const stored = new Map<string, number>()
      for (let i = 0; i < count.length; i++) stored.set(`${bin1[i]}:${bin2[i]}`, count[i])
      for (const record of map.golden.pixels_for_genome_pair as PixelRecord[]) {
        for (const pixel of record.pixels) {
          expect(stored.get(`${pixel.bin1_id}:${pixel.bin2_id}`)).toBe(pixel.count)
        }
      }
      // int64 bin ids arrive as BigInt64Array and are narrowed once, at the
      // HDF5 boundary; a BigInt leaking out would throw on the arithmetic above.
      expect(bin1).toBeInstanceOf(Float64Array)
      expect(loadGolden('basic_metacool.json').dtypes.pixels.bin1_id.dtype).toBe('<i8')
    } finally {
      mc.close()
    }
  })
})

interface PixelRecord {
  g1: string
  g2: string
  n: number
  sum: number
  pixels: { bin1_id: number; bin2_id: number; count: number }[]
}

interface GoldenMatrix {
  id: string
  level: string
  rows?: [number, number]
  cols?: [number, number]
  values: number[][]
}
