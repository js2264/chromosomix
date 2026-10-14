/**
 * The published demo maps, read by this app and by the public `cooler` package.
 *
 * Every other reader oracle here is built over fixtures that `make_fixtures.py`
 * writes with metacooler, and metacooler is not public: a runner without its
 * repository builds none of them, so the suites that compare against them never
 * ran in CI at all. These maps need nothing private. They are the lab's own, on
 * a public bucket — a `.metacool` and an `.mmetacool` metacooler really wrote,
 * a yeast `.cool` and an E. coli `.mcool` — and `scripts/make_demo_golden.py`
 * read them with `cooler`, which opens every one of them (§9, §3.4).
 *
 * What is compared, and to what bar:
 *
 * - the bin size, the shape and the sequence table — the last through a hash,
 *   because a metagenome has twenty thousand contigs — exactly;
 * - for a metagenome, every genome's bin extent, which this reader derives from
 *   each contig's `genome_id` and the golden from `/indexes/genome_offset`: two
 *   routes to one answer, so a disagreement is the file's or the reader's;
 * - small windows across the diagonal, inside one sequence, over the seam
 *   between two, between two sequences in each orientation and between two
 *   genomes — raw counts **exactly**, balanced values to a relative 1e-6, since
 *   the reader multiplies in Float32 what cooler multiplies in Float64.
 *
 * The files are put in `test/fixtures/demo/` by `npm run fixtures:demo`, from
 * the bucket or from an identical copy under `demo/`; a map that is absent
 * skips by name, which is what a fresh clone that has not run it sees.
 */

import { createHash } from 'node:crypto'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

import { MetaCooler } from '@/metacooler/MetaCooler'
import { LocalFileSource } from '@/sources/LocalFileSource'
import { expectMatrixEquals } from '../support/goldens'

const GOLDEN_DIR = new URL('../golden/demo/', import.meta.url).pathname
const MAP_DIR = new URL('../fixtures/demo/', import.meta.url).pathname

interface Window {
  id: string
  rows: [number, number]
  cols: [number, number]
  balance: boolean
  values: (number | null)[][]
}

interface MapGolden {
  group: string
  binsize: number
  shape: [number, number]
  nnz: number
  weights: boolean
  chroms: { count: number; sha256: string; head: [string, number][]; tail: [string, number][] }
  genomes: { name: string; extent: [number, number] }[] | null
  windows: Window[]
}

interface FileGolden {
  file: string
  bytes: number
  maps: MapGolden[]
}

interface Manifest {
  maps: { file: string; bytes: number; golden: string }[]
}

const manifest = JSON.parse(readFileSync(`${GOLDEN_DIR}_manifest.json`, 'utf8')) as Manifest

async function withMap<T>(path: string, group: string, body: (mc: MetaCooler) => Promise<T> | T): Promise<T> {
  const mc = await MetaCooler.open(group === '' ? path : `${path}::${group}`, await LocalFileSource.open(path))
  try {
    return await body(mc)
  } finally {
    mc.close()
  }
}

/** The golden's hash, over the same `name<TAB>length<LF>` lines. */
function chromHash(mc: MetaCooler): string {
  const hash = createHash('sha256')
  const sizes = mc.chromsizes
  for (const name of mc.chromnames) hash.update(`${name}\t${sizes.get(name)}\n`)
  return hash.digest('hex')
}

/**
 * A balanced block against its oracle: `NaN` where cooler wrote `null`, and a
 * relative 1e-6 everywhere else. Cell by cell, for the reason
 * {@link expectMatrixEquals} gives: the failure has to say where.
 */
function expectBalancedClose(values: ArrayLike<number>, ncols: number, expected: (number | null)[][], what: string): void {
  for (let r = 0; r < expected.length; r++) {
    for (let c = 0; c < expected[r].length; c++) {
      const want = expected[r][c]
      const got = values[r * ncols + c]
      if (want === null) {
        if (!Number.isNaN(got)) expect.fail(`${what}: cell [${r}, ${c}] is ${got}, cooler says NaN`)
      } else if (!(Math.abs(got - want) <= 1e-6 * Math.max(Math.abs(want), 1e-300))) {
        expect.fail(`${what}: cell [${r}, ${c}] is ${got}, cooler says ${want}`)
      }
    }
  }
}

for (const entry of manifest.maps) {
  const path = `${MAP_DIR}${entry.file}`
  const present = existsSync(path) && statSync(path).size === entry.bytes
  const golden = JSON.parse(readFileSync(`${GOLDEN_DIR}${entry.golden}`, 'utf8')) as FileGolden

  describe.skipIf(!present)(`${entry.file} (run \`npm run fixtures:demo\` to fetch it)`, () => {
    for (const map of golden.maps) {
      const label = map.group === '' ? entry.file : `${entry.file}::${map.group}`

      it(`${label}: bin size, shape and sequences are cooler's`, async () => {
        await withMap(path, map.group, (mc) => {
          expect(mc.binsize).toBe(map.binsize)
          expect(mc.shape).toEqual(map.shape)
          expect(mc.chromnames.length).toBe(map.chroms.count)
          const sizes = mc.chromsizes
          const rows = mc.chromnames.map((name) => [name, sizes.get(name)])
          expect(rows.slice(0, map.chroms.head.length)).toEqual(map.chroms.head)
          expect(rows.slice(-map.chroms.tail.length)).toEqual(map.chroms.tail)
          expect(chromHash(mc)).toBe(map.chroms.sha256)
          expect(mc.hasWeights).toBe(map.weights)
        })
      })

      if (map.genomes !== null) {
        const genomes = map.genomes
        it(`${label}: every genome's extent agrees with /indexes/genome_offset`, async () => {
          await withMap(path, map.group, (mc) => {
            expect(mc.genomeNames).toEqual(genomes.map((g) => g.name))
            for (const g of genomes) expect(mc.genomeExtent(g.name), g.name).toEqual(g.extent)
          })
        })
      }

      it(`${label}: every window, cell for cell`, async () => {
        await withMap(path, map.group, async (mc) => {
          for (const w of map.windows) {
            const what = `${label} ${w.id}${w.balance ? ' (balanced)' : ''}`
            const block = await mc.matrix({ rows: w.rows, cols: w.cols, balance: w.balance })
            if (w.balance) {
              expect({ nrows: block.nrows, ncols: block.ncols }, `${what}: shape`).toEqual({
                nrows: w.values.length,
                ncols: w.values[0]?.length ?? 0,
              })
              expectBalancedClose(block.values, block.ncols, w.values, what)
            } else {
              expectMatrixEquals(block, w.values as number[][], what)
            }
          }
        })
      })
    }
  })
}
