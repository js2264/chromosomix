/**
 * The `/bins` guard (spec §3.3, M1 task 7).
 *
 * **`/bins` is never read.** Refusing variable-bin files (§3.2) bought exactly
 * one thing: with a uniform bin size the whole coordinate model is arithmetic
 * over `indexes/chrom_offset` and `contigs/length`, both of which open already
 * holds, so one of the four large tables in the file is never touched — not on
 * open, not per view, not over the network. On `Hum53.metacool` that table is
 * 422 967 rows × 3 columns; over HTTP it is the difference between a viewer
 * that starts and one that stalls.
 *
 * A grep would not prove this. This suite wraps the `Hdf5Handle` in a proxy
 * that **throws** on any access to a path under `bins`, then drives a complete
 * open, a genome matrix, a genome-pair matrix, a region matrix and both
 * aggregation levels through it — and checks the results against the golden, so
 * the guard cannot be satisfied by a code path that simply does less work.
 */

import { describe, expect, it } from 'vitest'

import type { Hdf5Handle } from '../../src/h5/api'
import { MetaCooler } from '../../src/metacooler/MetaCooler'
import { parseMetacoolerRange } from '../../src/metacooler/range'
import { goldenMaps, openHandle, withHandle,
  requireGenomes,
} from './_golden'

/** Every `Hdf5Handle` method that takes a path as its first argument. */
const PATH_METHODS = [
  'attrsAt',
  'has',
  'keys',
  'isSoftLink',
  'datasetLength',
  'dtype',
  'readNumeric',
  'readStrings',
  'readTable',
] as const

/**
 * The one `/bins` access the reader is allowed: `schema.is_metacooler` lists
 * `bins` among the groups a `.metacool` must carry, so detection asks whether
 * it exists. That is a presence test on the group, not a read of a column.
 */
const ALLOWED_ON_BINS = new Set<string>(['has'])

interface Call {
  method: string
  path: string
}

class BinsAccessError extends Error {}

/** `'/bins/chrom'` → `'bins/chrom'`; the handle resolves paths root-relative. */
function normalise(path: string): string {
  return path.replace(/^\/+/, '')
}

function touchesBins(path: string): boolean {
  const p = normalise(path)
  return p === 'bins' || p.startsWith('bins/')
}

/**
 * Wrap a handle so that reading anything under `/bins` throws.
 *
 * A `Proxy` rather than a hand-written subclass: it covers every method on the
 * interface, including any added later, so the guard cannot rot into a
 * whitelist that a new call site quietly steps around.
 */
function guardBins(handle: Hdf5Handle): { guarded: Hdf5Handle; calls: Call[] } {
  const calls: Call[] = []
  const guarded = new Proxy(handle, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver)
      if (typeof value !== 'function') return value
      const name = String(property)
      if (!(PATH_METHODS as readonly string[]).includes(name)) {
        return (...args: unknown[]) => (value as Function).apply(target, args)
      }
      return (...args: unknown[]) => {
        const path = String(args[0] ?? '')
        if (touchesBins(path)) {
          calls.push({ method: name, path })
          if (!ALLOWED_ON_BINS.has(name)) {
            throw new BinsAccessError(
              `/bins was read: ${name}(${JSON.stringify(path)}). The viewer is fixed-bin ` +
                `only precisely so that this never happens (spec §3.3).`,
            )
          }
        }
        return (value as Function).apply(target, args)
      }
    },
  }) as Hdf5Handle
  return { guarded, calls }
}

const MAPS = goldenMaps()
const BASIC = MAPS.find((m) => m.id === 'basic.metacool')!

describe('the guard itself', () => {
  it('fires on a read and lets the detection presence test through', async () => {
    await withHandle('basic.metacool', (handle) => {
      const { guarded, calls } = guardBins(handle)
      expect(() => guarded.readNumeric('bins/start')).toThrowError(BinsAccessError)
      expect(() => guarded.readNumeric('/bins/start')).toThrowError(BinsAccessError)
      expect(() => guarded.readTable('bins')).toThrowError(BinsAccessError)
      expect(() => guarded.dtype('bins/chrom')).toThrowError(BinsAccessError)
      expect(() => guarded.datasetLength('bins/end')).toThrowError(BinsAccessError)
      // Not a false positive on a name that merely starts with the letters.
      expect(() => guarded.has('bins_not_really')).not.toThrow()
      expect(guarded.has('bins')).toBe(true)
      expect(calls.filter((c) => c.method !== 'has').length).toBe(5)
    })
  })

  it('is not vacuous: /bins is present and populated in the fixture', async () => {
    await withHandle('basic.metacool', (handle) => {
      // If the guard passed because there were no bins to read, it would prove
      // nothing. The golden records the real column lengths.
      const bins = BASIC.golden.dtypes.bins as Record<string, { length: number }>
      expect(Object.keys(bins).sort()).toEqual(['chrom', 'end', 'start'])
      for (const [column, meta] of Object.entries(bins)) {
        expect(handle.datasetLength(`bins/${column}`)).toBe(meta.length)
        expect(meta.length).toBe(BASIC.golden.shape[0])
      }
    })
  })
})

describe('a full open never reads /bins', () => {
  it.each(MAPS.map((m) => [m.id, m] as const))('%s', async (_id, map) => {
    const handle = await openHandle(map.file, map.uri)
    const { guarded, calls } = guardBins(handle)
    try {
      const mc = MetaCooler.fromHandle(guarded)

      // Everything the open path and the info panel need.
      expect(mc.shape).toEqual(map.golden.shape)
      expect(mc.chromnames).toEqual(map.golden.chromnames)
      expect(requireGenomes(mc).length).toBe(map.golden.genomes.length)
      expect(mc.contigs.length).toBe(map.golden.contigs.length)
      expect(mc.countKind).toBe(map.golden.count_dtype_kind)
      expect(mc.nnz).toBe(map.golden.info.nnz)

      // Coordinates: contig extents, bin → contig, bin → bp. All arithmetic.
      for (const [name, expected] of Object.entries(
        map.golden.contig_extent as Record<string, [number, number]>,
      )) {
        expect([...mc.contigExtent(name)]).toEqual(expected)
      }
      for (const [name, expected] of Object.entries(
        map.golden.genome_extent as Record<string, [number, number]>,
      )) {
        expect([...mc.genomeExtent(name)]).toEqual(expected)
      }
      for (const row of map.golden.ranges as { range: string; ok: boolean }[]) {
        if (!row.ok || row.range.split(':')[0] === '__unbinned__') continue
        expect(() => parseMetacoolerRange(mc, row.range)).not.toThrow()
      }
      // The density proxy reads indexes/bin1_offset, never /bins.
      for (const name of Object.keys(map.golden.density_proxy as Record<string, number>)) {
        expect(mc.genomeDensity(name)).toBe(
          (map.golden.density_proxy as Record<string, number>)[name],
        )
      }

      expect(binsReads(calls)).toEqual([])
    } finally {
      handle.close()
    }
  })
})

describe('matrix loads and aggregation never read /bins', () => {
  it('genome, pair, region and raw-bin blocks match the golden', async () => {
    const handle = await openHandle(BASIC.file, BASIC.uri)
    const { guarded, calls } = guardBins(handle)
    try {
      const mc = MetaCooler.fromHandle(guarded)
      for (const record of BASIC.golden.matrices as GoldenMatrix[]) {
        if (record.level !== 'bin') continue
        const dense = await mc.matrix({ rows: record.rows!, cols: record.cols! })
        expectDense(dense, record)
      }
      expect(binsReads(calls)).toEqual([])
    } finally {
      handle.close()
    }
  })

  it('contig and genome roll-ups match the golden', async () => {
    const handle = await openHandle(BASIC.file, BASIC.uri)
    const { guarded, calls } = guardBins(handle)
    try {
      const mc = MetaCooler.fromHandle(guarded)
      // The whole matrix, then rolled up — the §4 "free" operation. The bin →
      // contig mapping comes from chrom_offset; `_bin_to_level_mapping` in
      // Python reads /bins/chrom for the same thing, and that is precisely the
      // read this reader must not make.
      const whole = await mc.matrix({ rows: [0, mc.nBins] })
      for (const record of BASIC.golden.matrices as GoldenMatrix[]) {
        if (record.level === 'bin') continue
        const level = record.level as 'contig' | 'genome'
        const rolled = mc.aggregate(whole, level)
        const labels =
          level === 'contig'
            ? Array.from(rolled.rowIds, (id) => mc.chromnames[id])
            : Array.from(rolled.rowIds, (id) => mc.genomeNames[id])
        expect(labels).toEqual(record.labels)
        expect([rolled.nrows, rolled.ncols]).toEqual([
          record.values.length,
          record.values[0].length,
        ])
        const mismatches: string[] = []
        for (let r = 0; r < rolled.nrows; r++) {
          for (let c = 0; c < rolled.ncols; c++) {
            const actual = rolled.values[r * rolled.ncols + c]
            const expected = record.values[r][c]
            if (actual !== expected) mismatches.push(`[${r}][${c}] ${actual} != ${expected}`)
          }
        }
        expect(mismatches).toEqual([])
      }
      expect(binsReads(calls)).toEqual([])
    } finally {
      handle.close()
    }
  })

  it('the full pixel scan never reads /bins either', async () => {
    const handle = await openHandle(BASIC.file, BASIC.uri)
    const { guarded, calls } = guardBins(handle)
    try {
      const mc = MetaCooler.fromHandle(guarded)
      let seen = 0
      let sum = 0
      await mc.scanPixels({
        chunkSize: 4096,
        onChunk: (chunk) => {
          seen += chunk.length
          for (let i = 0; i < chunk.length; i++) sum += chunk.count[i]
        },
      })
      expect(seen).toBe(mc.nnz)
      expect(sum).toBe(mc.info.sum)
      expect(binsReads(calls)).toEqual([])
    } finally {
      handle.close()
    }
  })
})

// ---------------------------------------------------------------------------

interface GoldenMatrix {
  id: string
  level: string
  labels?: string[]
  rows?: [number, number]
  cols?: [number, number]
  values: number[][]
}

/** Calls that reached `/bins` by anything other than the allowed presence test. */
function binsReads(calls: Call[]): Call[] {
  return calls.filter((c) => !ALLOWED_ON_BINS.has(c.method))
}

function expectDense(
  dense: { nrows: number; ncols: number; values: Float32Array },
  record: GoldenMatrix,
): void {
  expect([dense.nrows, dense.ncols], record.id).toEqual([
    record.values.length,
    record.values[0].length,
  ])
  const mismatches: string[] = []
  for (let r = 0; r < dense.nrows; r++) {
    for (let c = 0; c < dense.ncols; c++) {
      const actual = dense.values[r * dense.ncols + c]
      const expected = record.values[r][c]
      if (actual !== expected) mismatches.push(`${record.id} [${r}][${c}] ${actual} != ${expected}`)
    }
  }
  expect(mismatches).toEqual([])
}
