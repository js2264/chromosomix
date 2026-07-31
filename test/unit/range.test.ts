/**
 * Range resolution against the Python oracle (spec §5.4).
 *
 * The `ranges` block of every golden is the battery `metacooler.ops.range`
 * itself was driven over, extents and error text included, so this suite is
 * the proof that `contig:1000-1001` selects the same bin in the browser as it
 * does in `metacooler show --range`.
 *
 * Two deliberate divergences from Python are asserted rather than glossed
 * over, both from §7.4:
 *
 * 1. `__unbinned__` resolves to a bin range in Python; the viewer refuses it
 *    with its own `unbinned-not-displayable` code. The *extent* is still
 *    checked against the golden, because refusing to display it must not mean
 *    renumbering it away.
 * 2. The `unknown-label` suggestion list offers only displayable genomes, so
 *    a user cannot be handed a name that the next refusal would reject.
 */

import { describe, expect, it } from 'vitest'

import { UNBINNED_NAME } from '../../src/constants'
import { ViewerError, truncateNames } from '../../src/errors'
import { parseHumanized, parseMetacoolerRange, parseRegionString } from '../../src/metacooler/range'
import type { MetaCooler } from '../../src/metacooler/MetaCooler'
import { goldenMaps, withMap } from './_golden'

const MAPS = goldenMaps({ full: true })

/** One row of a golden's `ranges` block. */
interface GoldenRange {
  range: string
  ok: boolean
  extent?: [number, number]
  error_type?: string
  error_message?: string
}

function capture(body: () => unknown): ViewerError {
  let thrown: unknown
  try {
    body()
  } catch (error) {
    thrown = error
  }
  expect(thrown, 'expected a refusal, got none').toBeInstanceOf(ViewerError)
  return thrown as ViewerError
}

describe('the golden range battery', () => {
  describe.each(MAPS.map((m) => [m.id, m] as const))('%s', (_id, map) => {
    const ranges = map.golden.ranges as GoldenRange[]

    it('has a battery to run', () => {
      expect(ranges.length).toBeGreaterThan(10)
    })

    it.each(ranges.map((r) => [r.range, r] as const))('%j', async (rangeStr, row) => {
      await withMap(map, (mc) => {
        const label = rangeStr.split(':')[0]

        if (label === UNBINNED_NAME) {
          expectUnbinnedRefusal(mc, rangeStr, row)
          return
        }
        if (row.ok) {
          const parsed = parseMetacoolerRange(mc, rangeStr)
          expect([...parsed.extent]).toEqual(row.extent)
          expect(parsed.label).toBe(label)
          expect(parsed.kind).toBe(mc.hasGenome(label) ? 'genome' : 'contig')
          return
        }
        expectRefusal(mc, rangeStr, row)
      })
    })
  })
})

/**
 * `__unbinned__` is a bookkeeping row, not a genome (§7.4).
 *
 * Python happily resolves it — the golden records `ok: true` with a real bin
 * range — so this is the viewer adding a refusal, not reproducing one. The
 * golden extent is still asserted through `genomeExtent`, because §7.4 is
 * "exclude at selection and display time", not "renumber it out of existence":
 * every bin index in the file must stay exactly as written.
 */
function expectUnbinnedRefusal(mc: MetaCooler, rangeStr: string, row: GoldenRange): void {
  const error = capture(() => parseMetacoolerRange(mc, rangeStr))
  expect(error.code).toBe('unbinned-not-displayable')
  expect(error.detail).toEqual({ label: UNBINNED_NAME })
  expect(error.message).toContain('cannot be displayed')
  // Distinct from unknown-label on purpose: the name is real and the user read
  // it off the file, so "not found" would leave them doubting the file.
  expect(error.code).not.toBe('unknown-label')

  if (row.ok) {
    expect([...mc.genomeExtent(UNBINNED_NAME)]).toEqual(row.extent)
  }
  // The row is still in /genomes, at its own index, with its own contigs.
  expect(mc.hasGenome(UNBINNED_NAME)).toBe(true)
  expect(mc.genomeNames[mc.genomeId(UNBINNED_NAME)]).toBe(UNBINNED_NAME)
}

/** A refusal Python also raises; the wording is compared where it is shared. */
function expectRefusal(mc: MetaCooler, rangeStr: string, row: GoldenRange): void {
  const error = capture(() => parseMetacoolerRange(mc, rangeStr))
  const python = row.error_message ?? ''
  expect(row.error_type).toBe('ValueError')

  if (python.includes('is a genome name')) {
    expect(error.code).toBe('genome-coordinate-suffix')
    // Byte-for-byte the Python sentence.
    expect(error.message).toBe(python)
    return
  }

  if (python.includes('out of bounds')) {
    expect(error.code).toBe('bad-range')
    expect(error.message).toBe(python)
    return
  }

  expect(python).toContain('is not a known genome or contig')
  expect(error.code).toBe('unknown-label')
  const label = rangeStr.split(':')[0]
  expect(error.detail).toEqual({ label, region: rangeStr })

  const [head, genomesLine, contigsLine] = error.message.split('\n')
  const [pyHead, , pyContigsLine] = python.split('\n')
  // Head and contig list are shared verbatim, truncation marker included.
  expect(head).toBe(pyHead)
  expect(contigsLine).toBe(pyContigsLine)
  // The genome list is the *displayable* one — see the file header.
  expect(genomesLine).toBe(
    `  Genomes: ${truncateNames(mc.displayGenomes().map((i) => mc.genomeNames[i]))}`,
  )
  expect(genomesLine).not.toContain(UNBINNED_NAME)
}

// ---------------------------------------------------------------------------
// Named properties, spelled out rather than left implicit in the battery
// ---------------------------------------------------------------------------

const BASIC = MAPS.find((m) => m.id === 'basic.metacool')!

describe('coordinates are 0-based half-open, whatever the docstrings say', () => {
  // SPECS §5.4 and metacooler's own docstrings claim "1-based, fully closed".
  // cooler's `parse_region` applies no conversion at all, and these three
  // goldens are the proof: a reader built to the documented convention is off
  // by one bin on every region query.
  it('999-1000, 1000-1001 and the empty 1000-1000', async () => {
    await withMap(BASIC, (mc) => {
      const golden = (BASIC.golden.ranges as GoldenRange[]).filter((r) => r.ok)
      const find = (suffix: string): [number, number] =>
        golden.find((r) => r.range.endsWith(suffix))!.extent!

      expect([...mc.extent('contig_1_005:999-1000')]).toEqual(find(':999-1000'))
      expect([...mc.extent('contig_1_005:1000-1001')]).toEqual(find(':1000-1001'))
      expect([...mc.extent('contig_1_005:1000-1000')]).toEqual(find(':1000-1000'))

      // Restated as arithmetic: base + floor(start/binsize) .. base + ceil(end/binsize).
      const base = mc.contigExtent('contig_1_005')[0]
      expect([...mc.extent('contig_1_005:999-1000')]).toEqual([base, base + 1])
      expect([...mc.extent('contig_1_005:1000-1001')]).toEqual([base + 1, base + 2])
      expect([...mc.extent('contig_1_005:1000-1000')]).toEqual([base + 1, base + 1])
      expect(mc.offset('contig_1_005:1000-2000')).toBe(base + 1)
    })
  })

  it('a bare contig name is the whole contig', async () => {
    await withMap(BASIC, (mc) => {
      for (const name of mc.chromnames) {
        const whole = parseMetacoolerRange(mc, name)
        expect(whole.kind).toBe('contig')
        expect([...whole.extent]).toEqual([...mc.contigExtent(name)])
        expect(whole.extent[1] - whole.extent[0]).toBe(
          Math.ceil(mc.chromsizes.get(name)! / mc.binsize),
        )
      }
    })
  })
})

describe('genome ranges are whole-genome', () => {
  it('refuses a coordinate suffix instead of ignoring it', async () => {
    await withMap(BASIC, (mc) => {
      const genome = mc.genomeNames[mc.displayGenomes()[0]]
      expect([...parseMetacoolerRange(mc, genome).extent]).toEqual([...mc.genomeExtent(genome)])
      const error = capture(() => parseMetacoolerRange(mc, `${genome}:1-1000`))
      expect(error.code).toBe('genome-coordinate-suffix')
      expect(error.message).toBe(
        `Range '${genome}:1-1000': '${genome}' is a genome name — coordinate suffixes are not ` +
          `allowed for genome ranges. Use just '${genome}'.`,
      )
    })
  })

  it('resolves a genome before a contig of the same name', async () => {
    await withMap(BASIC, (mc) => {
      // The order is Python's; matching contigs first would make the same
      // string mean different things in the two implementations.
      const genome = mc.genomeNames[mc.displayGenomes()[0]]
      expect(mc.hasGenome(genome)).toBe(true)
      expect(parseMetacoolerRange(mc, genome).kind).toBe('genome')
    })
  })
})

describe('the unknown-label refusal lists both namespaces, truncated', () => {
  it('shows 20 names and a remainder count', async () => {
    await withMap(BASIC, (mc) => {
      const error = capture(() => parseMetacoolerRange(mc, 'no_such_label'))
      expect(error.code).toBe('unknown-label')
      const lines = error.message.split('\n')
      expect(lines[0]).toBe("Range 'no_such_label': 'no_such_label' is not a known genome or contig.")
      expect(lines[1]).toBe(`  Genomes: ${truncateNames(mc.displayGenomes().map((i) => mc.genomeNames[i]))}`)
      // 44 contigs, so 20 are named and 24 are counted — Python's `_truncate`.
      expect(mc.nContigs).toBe(44)
      expect(lines[2]).toContain('... (24 more)')
      expect(lines[2].startsWith(`  Contigs: ['${mc.chromnames[0]}', '${mc.chromnames[1]}'`)).toBe(
        true,
      )
      // Python renders lists with repr quoting, not JSON quoting.
      expect(lines[2]).not.toContain('"')
    })
  })

  it('an empty range string is an unknown label, not a crash', async () => {
    await withMap(BASIC, (mc) => {
      const error = capture(() => parseMetacoolerRange(mc, ''))
      expect(error.code).toBe('unknown-label')
      expect(error.message.startsWith("Range '': '' is not a known genome or contig.")).toBe(true)
    })
  })

  it('does not trim, so a padded name is genuinely unknown', async () => {
    await withMap(BASIC, (mc) => {
      // Python splits the raw string; ' MAG_01' is not 'MAG_01'.
      expect(capture(() => parseMetacoolerRange(mc, ' MAG_01')).code).toBe('unknown-label')
    })
  })
})

describe('cooler’s region grammar', () => {
  it('parseHumanized', () => {
    expect(parseHumanized('1000')).toBe(1000)
    expect(parseHumanized('1,000')).toBe(1000)
    expect(parseHumanized('1.5kb')).toBe(1500)
    expect(parseHumanized('2M')).toBe(2_000_000)
    expect(parseHumanized('1G')).toBe(1_000_000_000)
    expect(() => parseHumanized('1k2')).toThrowError(/Unexpected token/)
    expect(() => parseHumanized('10zz')).toThrowError(/Unknown unit/)
  })

  it('parseRegionString', () => {
    expect(parseRegionString('chr1')).toEqual(['chr1', null, null])
    expect(parseRegionString('chr1:100-200')).toEqual(['chr1', 100, 200])
    expect(parseRegionString('chr1:100-')).toEqual(['chr1', 100, null])
    expect(parseRegionString('chr1:1,000-2,000')).toEqual(['chr1', 1000, 2000])
    expect(() => parseRegionString(':100-200')).toThrowError(/Chromosome name cannot be empty/)
    expect(() => parseRegionString('chr1:200-100')).toThrowError(/End coordinate less than start/)
  })

  it('refuses a region past the end of the contig', async () => {
    await withMap(BASIC, (mc) => {
      const name = mc.chromnames[0]
      const length = mc.chromsizes.get(name)!
      expect(() => mc.extent(`${name}:0-${length}`)).not.toThrow()
      const error = capture(() => mc.extent(`${name}:0-${length + 1}`))
      expect(error.code).toBe('bad-range')
      expect(error.message).toBe(`Genomic region out of bounds: [0, ${length + 1})`)
    })
  })
})
