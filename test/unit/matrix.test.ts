/**
 * Matrix queries against the Python oracle (spec §5.2, §5.3, §6.2; M2).
 *
 * The M2 exit criterion is that bin-, contig- and genome-level matrices match
 * the golden with **exact integer equality**, so this file runs every
 * materialised block in every fully-goldened fixture through the accessor a
 * view would actually call, and compares cell for cell. Nothing here is
 * tolerant: a single wrong cell fails, because the bug this milestone is
 * guarding against — a mirrored or transposed block placed one bin off — is a
 * handful of wrong cells in a few hundred thousand right ones.
 *
 * The oracles come from `cooler.Cooler.matrix(balance=False)` (bin level) and
 * `metacooler.ops.aggregate` (contig and genome level), via
 * `scripts/make_golden.py`.
 */

import { describe, expect, it } from 'vitest'

import type { MetaCooler } from '@/metacooler/MetaCooler'
import type { DenseMatrix, Extent } from '@/types'
import {
  expectMatrixEquals,
  fixtureCases,
  openCase,
  type FixtureCase,
  type GoldenMatrix,
} from '../support/goldens'

/**
 * Resolve one golden matrix id through the accessor the UI would use.
 *
 * The ids encode *how the selection was made*, not just which bins it covers,
 * and going back through the accessor is what tests the coordinate path rather
 * than only the pixel path: a `genome:` entry exercises `genomeExtent`, a
 * `region:` entry exercises `parse_region`'s 0-based half-open arithmetic, and
 * a `bins:` entry exercises nothing but the raw query, which is the control.
 */
async function loadById(mc: MetaCooler, entry: GoldenMatrix): Promise<DenseMatrix> {
  const id = entry.id
  if (id.startsWith('genome:')) return mc.genomeMatrix(id.slice('genome:'.length))
  if (id.startsWith('pair:')) {
    const [row, col] = id.slice('pair:'.length).split('|')
    return mc.genomePairMatrix(row, col)
  }
  if (id.startsWith('contig:')) {
    return mc.matrix({ rows: mc.contigExtent(id.slice('contig:'.length)) })
  }
  if (id.startsWith('region:')) return mc.matrix({ rows: mc.extent(id.slice('region:'.length)) })
  if (id.startsWith('bins:')) {
    const [rows, cols] = id.slice('bins:'.length).split('x').map(parseExtent)
    return mc.matrix({ rows, cols })
  }
  throw new Error(`unhandled golden matrix id: ${id}`)
}

/** `'621-661'` → `[621, 661]`. */
function parseExtent(text: string): Extent {
  const [lo, hi] = text.split('-').map(Number)
  return [lo, hi]
}

const cases = fixtureCases()

describe('golden fixtures are present', () => {
  it('found the M0 goldens', () => {
    // A missing `test/golden/` would otherwise turn every `describe.each` below
    // into zero tests and a green run.
    expect(cases.length).toBeGreaterThan(0)
    expect(cases.map((c) => c.label)).toContain('basic.metacool')
  })
})

describe.each(cases)('$label', (fixture: FixtureCase) => {
  const binLevel = fixture.golden.matrices.filter((m) => m.level === 'bin')

  it('reproduces every bin-level block exactly', async () => {
    const mc = await openCase(fixture)
    try {
      expect(binLevel.length).toBeGreaterThan(0)
      for (const entry of binLevel) {
        const block = await loadById(mc, entry)
        // The extent the accessor derived must be the extent Python selected;
        // otherwise the values could agree by coincidence on a shifted window.
        expect(block.rowExtent, `${entry.id}: row extent`).toEqual(entry.rows)
        expect(block.colExtent, `${entry.id}: col extent`).toEqual(entry.cols)
        expectMatrixEquals(block, entry.values, `${fixture.label} ${entry.id}`)
      }
    } finally {
      mc.close()
    }
  })

  it('reproduces the contig- and genome-level roll-ups exactly', async () => {
    const mc = await openCase(fixture)
    try {
      const whole = await mc.matrix({ rows: [0, mc.nBins] })
      for (const level of ['contig', 'genome'] as const) {
        const entry = fixture.golden.matrices.find((m) => m.id === `aggregate:${level}`)
        expect(entry, `golden has an aggregate:${level}`).toBeDefined()
        const rolled = mc.aggregate(whole, level)
        expectMatrixEquals(rolled, entry!.values, `${fixture.label} aggregate:${level}`)
        // The labels are the oracle for the *axis*, and they are what the UI
        // draws; ids that were right for the wrong rows would still render a
        // plausible heatmap with every row mislabelled.
        const names = level === 'contig' ? mc.chromnames : mc.genomeNames
        expect(Array.from(rolled.rowIds, (i) => names[i]), `${level} labels`).toEqual(entry!.labels)
      }
    } finally {
      mc.close()
    }
  })

  it('preserves the stored count dtype kind without rounding', async () => {
    const mc = await openCase(fixture)
    try {
      expect(mc.countKind).toBe(fixture.golden.count_dtype_kind)
      const entry = binLevel.find((m) => m.id.startsWith('genome:'))!
      const block = await loadById(mc, entry)
      const integral = Array.from(block.values).every((v) => Number.isInteger(v))
      // A float `count` column must survive to the canvas as stored: rounding
      // it would still produce a plausible-looking heatmap (spec §6.2,
      // correction #2), so the fixture with fractional counts asserts that at
      // least one of them really is fractional.
      expect(integral, 'values are integral').toBe(mc.countKind !== 'f')
    } finally {
      mc.close()
    }
  })
})

describe('bounded reads', () => {
  it('never touches /bins, at any level', async () => {
    const fixture = cases.find((c) => c.label === 'basic.metacool')!
    const mc = await openCase(fixture)
    const touched: string[] = []
    const handle = mc.handle as unknown as Record<string, (path: string) => unknown>
    for (const method of [
      'readNumeric',
      'readInt32',
      'readStrings',
      'readTable',
      'dtype',
      'datasetLength',
    ]) {
      const original = handle[method].bind(mc.handle)
      handle[method] = (path: string, ...rest: unknown[]) => {
        if (/(^|\/)bins(\/|$)/.test(path)) touched.push(`${method}(${path})`)
        return (original as (...args: unknown[]) => unknown)(path, ...rest)
      }
    }
    try {
      const whole = await mc.matrix({ rows: [0, mc.nBins] })
      mc.aggregate(whole, 'contig')
      mc.aggregate(whole, 'genome')
      await mc.genomeMatrix(mc.genomeNames[mc.displayGenomes()[0]])
      expect(touched, 'reads of /bins').toEqual([])
    } finally {
      mc.close()
    }
  })

  it('reads only the three datasets a bounded block needs', async () => {
    const fixture = cases.find((c) => c.label === 'basic.metacool')!
    const mc = await openCase(fixture)
    const paths: string[] = []
    const handle = mc.handle as unknown as Record<
      string,
      (path: string, lo?: number, hi?: number) => unknown
    >
    // Both readers, not just `readNumeric`: the bin id columns are int64 on
    // disk and array indices in use, so they come back through `readInt32`.
    for (const method of ['readNumeric', 'readInt32']) {
      const original = handle[method].bind(mc.handle)
      handle[method] = (path: string, lo?: number, hi?: number) => {
        paths.push(path)
        return original(path, lo, hi)
      }
    }
    try {
      await mc.genomeMatrix('MAG_04')
      // Not `pixels/bin1_id`: each pixel's row is the index's own answer (§6.2).
      expect(paths).toEqual([
        'indexes/bin1_offset',
        'pixels/bin2_id',
        'pixels/count',
      ])
    } finally {
      mc.close()
    }
  })
})
