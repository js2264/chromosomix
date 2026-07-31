/**
 * Golden-fixture plumbing shared by the reader-core suites.
 *
 * Every expectation in `test/unit/` comes from `test/golden/*.json`, which
 * `scripts/make_golden.py` produced by driving the **Python** `metacooler`
 * package over the same files. Nothing here invents a number: if a suite wants
 * an expected value it reads it out of a golden, so a JS/Python divergence
 * shows up as a test failure rather than as two implementations that agree
 * only with themselves.
 *
 * Not a `.test.ts` file on purpose — vitest's `include` is `test/**\/*.test.ts`,
 * so this module is imported, never collected.
 */

import { readFileSync } from 'node:fs'

import type { Hdf5Handle } from '../../src/h5/api'
import { openHdf5 } from '../../src/h5/Hdf5File'
import { MetaCooler } from '../../src/metacooler/MetaCooler'
import { LocalFileSource } from '../../src/sources/LocalFileSource'
import { parseUri } from '../../src/uri'

// ---------------------------------------------------------------------------
// Locations
// ---------------------------------------------------------------------------

const FIXTURE_DIR = fileUrlToPath(new URL('../fixtures/', import.meta.url))
const GOLDEN_DIR = fileUrlToPath(new URL('../golden/', import.meta.url))

function fileUrlToPath(url: URL): string {
  return decodeURIComponent(url.pathname)
}

/** Absolute path of a fixture, given the bare file name from the manifest. */
export function fixturePath(name: string): string {
  return `${FIXTURE_DIR}${name}`
}

// ---------------------------------------------------------------------------
// Manifest and goldens
// ---------------------------------------------------------------------------

/** One row of `test/golden/_manifest.json`. */
export interface ManifestEntry {
  name: string
  kind: 'metacool' | 'mmetacool' | 'cool' | 'mcool'
  /** `'accept'` or `'refuse:<ErrorCode>'`. */
  expect: string
  /** `'full'` when a complete Python oracle exists, `'partial'` otherwise. */
  coverage?: string
  golden: string
  description: string
  entries?: string[]
  entry_uris?: string[]
  entry_expect?: string
  note?: string
}

export interface Manifest {
  fixtures: ManifestEntry[]
  info_volatile_keys: string[]
  metadata_volatile_keys: string[]
  unbinned_name: string
  metacooler_version: string
  cooler_version: string
}

/** An arbitrary golden document; every suite narrows what it reads. */
export type Golden = Record<string, any>

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, 'utf8')) as T
}

export const manifest: Manifest = readJson<Manifest>(`${GOLDEN_DIR}_manifest.json`)

/** Load a golden by its manifest file name. */
export function loadGolden(file: string): Golden {
  return readJson<Golden>(`${GOLDEN_DIR}${file}`)
}

/** `expect: 'refuse:bad-ordering'` → `'bad-ordering'`; `null` when accepted. */
export function refusalCode(entry: ManifestEntry): string | null {
  return entry.expect.startsWith('refuse:') ? entry.expect.slice('refuse:'.length) : null
}

// ---------------------------------------------------------------------------
// The map list every suite iterates
// ---------------------------------------------------------------------------

/**
 * One openable contact map with a golden beside it.
 *
 * An `.mmetacool` contributes one of these per entry and none for its root
 * (the root is a refusal, tested in `detect.test.ts`), so a suite that says
 * "for every accepted fixture" gets the entries too without special-casing
 * collections.
 */
export interface GoldenMap {
  /** Stable test name, e.g. `basic.metacool` or `ladder.mmetacool::entries/1000`. */
  id: string
  /** URI **as the golden wrote it** — a bare file name, so error messages match. */
  uri: string
  /** Manifest file name of the fixture the bytes come from. */
  file: string
  /** HDF5 group the map is rooted at. */
  group: string
  golden: Golden
  /** `false` for `utf8.metacool`, whose Python oracle is partial (see manifest). */
  full: boolean
}

/**
 * Every `.metacool` map with a golden: the plain files plus each `.mmetacool`
 * entry. Plain cool/mcool are excluded — §9's synthesised single-genome view is
 * M4 work and `MetaCooler.fromHandle` refuses them with `unsupported` today.
 */
export function goldenMaps(options: { full?: boolean } = {}): GoldenMap[] {
  const out: GoldenMap[] = []
  for (const entry of manifest.fixtures) {
    const golden = loadGolden(entry.golden)
    if (entry.kind === 'metacool' && refusalCode(entry) === null) {
      out.push({
        id: entry.name,
        uri: golden.uri as string,
        file: entry.name,
        group: (golden.group as string) ?? '/',
        golden,
        full: entry.coverage !== 'partial',
      })
    }
    if (entry.kind === 'mmetacool') {
      for (const [name, sub] of Object.entries(golden.entry_golden ?? {})) {
        const child = sub as Golden
        out.push({
          id: `${entry.name}::entries/${name}`,
          uri: child.uri as string,
          file: entry.name,
          group: child.group as string,
          golden: child,
          full: true,
        })
      }
    }
  }
  return options.full === true ? out.filter((m) => m.full) : out
}

// ---------------------------------------------------------------------------
// Opening
// ---------------------------------------------------------------------------

/**
 * Open a raw HDF5 handle on a fixture.
 *
 * `uri` and the byte source are deliberately independent: the source points at
 * the absolute path on disk, while the URI is the *bare* name the golden
 * recorded. That is what lets a refusal message be compared byte-for-byte with
 * the Python one, which naturally contains no absolute paths.
 */
export async function openHandle(file: string, uri: string = file): Promise<Hdf5Handle> {
  const source = await LocalFileSource.open(fixturePath(file))
  return openHdf5(uri, source, parseUri(uri).group)
}

/** Open a {@link GoldenMap} as a `MetaCooler`. */
export async function openMap(map: GoldenMap): Promise<MetaCooler> {
  const source = await LocalFileSource.open(fixturePath(map.file))
  return MetaCooler.open(map.uri, source)
}

/** Run `body` against an open map and always close it. */
export async function withMap<T>(map: GoldenMap, body: (mc: MetaCooler) => T | Promise<T>): Promise<T> {
  const mc = await openMap(map)
  try {
    return await body(mc)
  } finally {
    mc.close()
  }
}

/** Run `body` against an open handle and always close it. */
export async function withHandle<T>(
  file: string,
  body: (h: Hdf5Handle) => T | Promise<T>,
  uri: string = file,
): Promise<T> {
  const h = await openHandle(file, uri)
  try {
    return await body(h)
  } finally {
    h.close()
  }
}

// ---------------------------------------------------------------------------
// Comparison helpers
// ---------------------------------------------------------------------------

/**
 * Compare a JS value with a golden JSON value.
 *
 * JSON has no NaN, so `make_golden.py` encodes it as `null` (see the manifest's
 * `reader_notes.non_finite`). An optional `/genomes` column carries NaN for
 * every genome absent from the creator's `--genomes` table — `__unbinned__`
 * always is — so this is not an edge case, it is the normal shape of
 * `metadata.metacool`.
 */
export function goldenEquals(actual: unknown, expected: unknown): boolean {
  if (expected === null) return actual === null || actual === undefined || Number.isNaN(actual)
  return actual === expected
}

/** Golden tables are row-oriented; the reader is column-oriented. Transpose. */
export function tableRows(table: {
  length: number
  columns: string[]
  get(column: string, row: number): unknown
}): Record<string, unknown>[] {
  const rows: Record<string, unknown>[] = []
  for (let i = 0; i < table.length; i++) {
    const row: Record<string, unknown> = {}
    for (const column of table.columns) row[column] = table.get(column, i)
    rows.push(row)
  }
  return rows
}

/**
 * Strip the fixture directory out of every string, deeply.
 *
 * The mirror of `make_golden.py`'s `deep_scrub`. metacooler's provenance is not
 * confined to `metadata['commands']`: `binnify` records the *absolute* source
 * path in `metadata['binnify'][0]['source']` and `zoomify` copies it into every
 * entry, so the goldens were made location-independent by removing the fixture
 * directory prefix. Comparing against them means doing the same to the value
 * read out of the file — the alternative is a suite that only passes in the
 * checkout it was generated in.
 */
export function deepScrub<T>(value: T): T {
  if (typeof value === 'string') return value.split(FIXTURE_DIR).join('') as unknown as T
  if (Array.isArray(value)) return value.map(deepScrub) as unknown as T
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(value)) out[key] = deepScrub(item)
    return out as unknown as T
  }
  return value
}

/** Drop the keys a golden marks volatile (timestamps, provenance). */
export function withoutKeys<T extends Record<string, unknown>>(
  value: T,
  keys: readonly string[],
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...value }
  for (const key of keys) delete out[key]
  return out
}
