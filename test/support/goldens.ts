/**
 * Loading the M0 golden oracles, and comparing against them exactly.
 *
 * Every number the M2 tests assert came out of Python — `cooler.Cooler.matrix`,
 * `metacooler.ops.aggregate`, `MetaCooler.pixels_for_genome_pair` — and not out
 * of a previous run of this code. That is the whole point of the goldens: a
 * self-consistent reader that is off by one bin everywhere would pass any test
 * written against itself.
 *
 * **Exact equality is the bar**, never a tolerance. Counts are integers (or, in
 * `floatcount.metacool`, halves), every one of them is exactly representable in
 * `Float32`, and a tolerance would let a silent off-by-one in the symmetry
 * logic through — which is the specific failure M2 exists to prevent.
 */

import { readFileSync } from 'node:fs'
import { expect } from 'vitest'

import { MetaCooler } from '@/metacooler/MetaCooler'
import { LocalFileSource } from '@/sources/LocalFileSource'
import type { DenseMatrix, Extent } from '@/types'

/** Repo-relative directories, resolved from this file so cwd does not matter. */
export const FIXTURE_DIR = new URL('../fixtures/', import.meta.url).pathname
export const GOLDEN_DIR = new URL('../golden/', import.meta.url).pathname

// ---------------------------------------------------------------------------
// The shape of a golden file (scripts/make_golden.py)
// ---------------------------------------------------------------------------

/** One column-oriented table as the exporter writes it. */
export interface GoldenTable {
  length: number
  columns: string[]
  dtypes: Record<string, string>
  rows: Record<string, string | number>[]
}

/**
 * One materialised matrix oracle.
 *
 * `rows`/`cols` are bin ranges for a `level: 'bin'` entry and absent for an
 * aggregate, which covers the whole file and carries `labels` instead.
 */
export interface GoldenMatrix {
  id: string
  level: 'bin' | 'contig' | 'genome'
  rows?: Extent
  cols?: Extent
  values: number[][]
  labels?: string[]
  method: string
  note?: string
  fallback_reason?: string
}

/** One `MetaCooler.pixels_for_genome_pair` oracle: the raw COO triplets. */
export interface GoldenPairPixels {
  g1: string
  g2: string
  n: number
  sum: number
  pixels: { bin1_id: number; bin2_id: number; count: number }[]
}

export interface Golden {
  fixture: string
  uri: string
  group: string
  kind: string
  binsize: number
  shape: [number, number]
  chromnames: string[]
  chromsizes: Record<string, number>
  genomes: GoldenTable
  contigs: GoldenTable
  indexes: { chrom_offset: number[]; genome_offset: number[]; bin1_offset: number[] }
  genome_extent: Record<string, Extent>
  contig_extent: Record<string, Extent>
  displayable_genomes: string[]
  density_proxy: Record<string, number>
  count_dtype_kind: string
  matrices: GoldenMatrix[]
  pixels_for_genome_pair: GoldenPairPixels[]
}

/** A refused fixture, or a collection whose entries carry the real goldens. */
export interface CollectionGolden {
  fixture: string
  kind: string
  refuse?: string
  reason?: string
  entries?: string[]
  entry_uris?: string[]
  entry_golden?: Record<string, Golden>
}

interface ManifestEntry {
  name: string
  kind: string
  expect: string
  coverage: string
  golden: string
  entries?: string[]
}

interface Manifest {
  fixtures: ManifestEntry[]
  metacooler_version?: string
  cooler_version?: string
}

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, 'utf8')) as T
}

/** The golden manifest — the list of every fixture and what to expect of it. */
export function manifest(): Manifest {
  return readJson<Manifest>(`${GOLDEN_DIR}_manifest.json`)
}

/**
 * One openable map with a full Python oracle behind it.
 *
 * An `.mmetacool` contributes one case *per entry*, not one for the file: the
 * root is a container and is refused (§3.4), so the entries are what a reader
 * ever opens, and each carries its own complete golden.
 */
export interface FixtureCase {
  /** `basic.metacool`, or `ladder.mmetacool::entries/1000`. */
  label: string
  /** Absolute URI to hand to {@link MetaCooler.open}. */
  uri: string
  /** Absolute path of the file holding the bytes. */
  path: string
  golden: Golden
}

/**
 * Every fixture the reader must reproduce exactly.
 *
 * `coverage: 'partial'` is excluded on purpose: `utf8.metacool` has no matrix
 * oracle because `cooler.Cooler()` cannot open it at all (its contig names are
 * non-ASCII and cooler's `_tableops` does an ASCII decode), so there is nothing
 * to compare a matrix against. `plain.cool`/`plain.mcool` are excluded because
 * they are M7's synthesised single-genome view, not a metacool.
 */
export function fixtureCases(): FixtureCase[] {
  const cases: FixtureCase[] = []
  for (const entry of manifest().fixtures) {
    if (entry.coverage !== 'full') continue
    const path = `${FIXTURE_DIR}${entry.name}`
    if (entry.kind === 'metacool' && entry.expect === 'accept') {
      cases.push({
        label: entry.name,
        uri: path,
        path,
        golden: readJson<Golden>(`${GOLDEN_DIR}${entry.golden}`),
      })
    } else if (entry.kind === 'mmetacool') {
      const collection = readJson<CollectionGolden>(`${GOLDEN_DIR}${entry.golden}`)
      for (const [name, golden] of Object.entries(collection.entry_golden ?? {})) {
        cases.push({
          label: `${entry.name}::entries/${name}`,
          uri: `${path}::entries/${name}`,
          path,
          golden,
        })
      }
    }
  }
  return cases
}

/** Look one case up by label, so a test can name the fixture it needs. */
export function fixtureCase(label: string): FixtureCase {
  const found = fixtureCases().find((c) => c.label === label)
  if (found === undefined) throw new Error(`no golden fixture case labelled ${label}`)
  return found
}

/** Open a case. The caller owns the returned reader and must `close()` it. */
export async function openCase(c: FixtureCase): Promise<MetaCooler> {
  return MetaCooler.open(c.uri, await LocalFileSource.open(c.path))
}

// ---------------------------------------------------------------------------
// Comparison
// ---------------------------------------------------------------------------

/** Flatten a golden's row-major `number[][]` into one array. */
export function flatten(rows: number[][]): number[] {
  const out: number[] = []
  for (const row of rows) out.push(...row)
  return out
}

/**
 * Assert a loaded block equals its oracle cell for cell.
 *
 * Compared with an explicit loop rather than `toEqual` on the whole array
 * because the failure message is the point: a symmetry bug produces one wrong
 * cell in a few hundred thousand, and "expected Float32Array(437k) to equal
 * Float32Array(437k)" says nothing about where.
 */
export function expectMatrixEquals(
  actual: Pick<DenseMatrix, 'nrows' | 'ncols'> & { values: ArrayLike<number> },
  expected: number[][],
  what: string,
): void {
  expect(
    { nrows: actual.nrows, ncols: actual.ncols },
    `${what}: shape`,
  ).toEqual({ nrows: expected.length, ncols: expected.length === 0 ? 0 : expected[0].length })
  for (let r = 0; r < expected.length; r++) {
    for (let c = 0; c < expected[r].length; c++) {
      const got = actual.values[r * actual.ncols + c]
      if (got !== expected[r][c]) {
        expect.fail(
          `${what}: cell [${r}, ${c}] is ${got}, golden says ${expected[r][c]} ` +
            `(first of possibly many; block is ${actual.nrows}×${actual.ncols})`,
        )
      }
    }
  }
}

/** Sum a block, in Float64, so an assertion on the total cannot itself wrap. */
export function total(values: ArrayLike<number>): number {
  let sum = 0
  for (let i = 0; i < values.length; i++) sum += values[i]
  return sum
}
