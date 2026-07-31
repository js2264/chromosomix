/**
 * Decoding: names, genome 0, and counts (spec §6.2; corrections #2 and #4).
 *
 * Three failure modes that all look like working software until you check:
 *
 * 1. **Names decoded as Latin-1.** metacooler sizes its `S<n>` name columns by
 *    *encoded byte length* so multi-byte characters survive, but h5py stamps
 *    those datatypes ASCII and h5wasm honours that literally — its `slice()`
 *    decodes with `TextDecoder('ascii')`, an alias for windows-1252. Every byte
 *    is still there; only the decoding is wrong, so `contig_ñ_04` comes back as
 *    `contig_Ã±_04` and nothing throws.
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
import { goldenMaps, loadGolden, openMap, withMap } from './_golden'

const MAPS = goldenMaps()
const find = (id: string) => MAPS.find((m) => m.id === id)!

/** At least one code point outside 7-bit ASCII. */
const NON_ASCII = /[^\u0000-\u007F]/

// ---------------------------------------------------------------------------
// UTF-8 names
// ---------------------------------------------------------------------------

describe('utf8.metacool: non-ASCII genome *and* contig names', () => {
  const map = find('utf8.metacool')

  it('round-trips every name as UTF-8', async () => {
    await withMap(map, (mc) => {
      const golden = map.golden
      expect(mc.genomeNames).toEqual(golden.genomes.rows.map((r: any) => r.name))
      expect(mc.chromnames).toEqual(golden.contigs.rows.map((r: any) => r.name))
      // Spelled out, so a regression reads as the actual mojibake rather than
      // as an opaque array diff.
      expect(mc.chromnames).toContain('contig_ñ_04')
      expect(mc.chromnames).toContain('contig_中_03')
      expect(mc.genomeNames).toContain('MAG_αβ')
      expect(mc.genomeNames).toContain('MAG_日本')
    })
  })

  it('is not decoding as Latin-1', async () => {
    await withMap(map, (mc) => {
      // What the h5wasm ASCII path produces for the same bytes. If any of these
      // appear, `readStringSlice` stopped reading raw bytes.
      for (const wrong of ['contig_Ã±_04', 'contig_Ã¸_05', 'MAG_Î±Î²', 'MAG_æ¥æÂ¬']) {
        expect(mc.chromnames).not.toContain(wrong)
        expect(mc.genomeNames).not.toContain(wrong)
      }
      // Every name still has at least one character outside ASCII, so the
      // fixture is actually exercising the path.
      expect(mc.chromnames.every((n) => NON_ASCII.test(n))).toBe(true)
      expect(mc.genomeNames.filter((n) => NON_ASCII.test(n)).length).toBe(2)
    })
  })

  it('the S<n> width is a byte count, not a character count', async () => {
    // The file stores 11-character names in an S13 column because two of the
    // characters are two bytes in UTF-8. A reader that sliced by characters
    // would truncate; one that decoded per fixed-width record and stripped NUL
    // padding gets it right.
    const dtype = map.golden.dtypes.contigs.name as { dtype: string; kind: string }
    expect(dtype.dtype).toBe('|S13')
    expect(dtype.kind).toBe('S')
    await withMap(map, (mc) => {
      for (const name of mc.chromnames) {
        expect(name.length).toBe(11)
        expect(new TextEncoder().encode(name).length).toBeGreaterThan(11)
        // No NUL padding leaked into the decoded string.
        expect(name).not.toContain('\u0000')
        expect(name.trimEnd()).toBe(name)
      }
    })
  })

  it('cooler itself cannot open this file — the golden says so', () => {
    // Recorded by the fixture generator, not asserted against Python here: the
    // point is that the JS reader is the *only* reader for this shape, which is
    // why the golden is partial (see `_manifest.json`).
    const python = map.golden.python_open as { ok: boolean; error_type: string }
    expect(python.ok).toBe(false)
    expect(python.error_type).toBe('UnicodeDecodeError')
    expect(map.full).toBe(false)
  })
})

describe('utf8_genomes.metacool: non-ASCII genome names, ASCII contigs', () => {
  const map = find('utf8_genomes.metacool')

  it('round-trips the genome names and resolves a range by one', async () => {
    await withMap(map, (mc) => {
      expect(mc.genomeNames).toEqual(map.golden.genomes.rows.map((r: any) => r.name))
      expect(mc.displayGenomes().map((i) => mc.genomeNames[i])).toEqual(
        map.golden.displayable_genomes,
      )
      const nonAscii = mc.genomeNames.filter((n) => NON_ASCII.test(n))
      expect(nonAscii.length).toBe(5)
      for (const name of nonAscii) {
        const parsed = parseMetacoolerRange(mc, name)
        expect(parsed.kind).toBe('genome')
        expect(parsed.label).toBe(name)
        expect([...parsed.extent]).toEqual(
          (map.golden.genome_extent as Record<string, [number, number]>)[name],
        )
      }
    })
  })

  it('names a non-ASCII genome correctly in a refusal', async () => {
    await withMap(map, (mc) => {
      const name = mc.genomeNames.find((n) => NON_ASCII.test(n))!
      expect(name).toMatch(NON_ASCII)
      let message = ''
      try {
        parseMetacoolerRange(mc, `${name}:1-1000`)
      } catch (error) {
        message = (error as Error).message
      }
      // Python's repr prints a non-ASCII str as itself, so this is the same
      // sentence the CLI produces.
      expect(message).toBe(
        `Range '${name}:1-1000': '${name}' is a genome name — coordinate suffixes are not ` +
          `allowed for genome ranges. Use just '${name}'.`,
      )
    })
  })
})

// ---------------------------------------------------------------------------
// Genome 0 (correction #4)
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
