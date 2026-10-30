/**
 * The score picker's normalisations (§6.4, §7.5), held to cooler and cooltools.
 *
 * Not to a golden: nothing compared here was computed once and committed.
 * `npm run fixtures:reprocessed` (`scripts/reprocess_with_cooltools.py`) has the
 * two packages reprocess the demo yeast Micro-C into `test/fixtures/reprocessed/`
 * — `cooler balance` over a copy of it, the same at 16 kb after `cooler
 * coarsen`, cooltools' iterative correction over its blocks — and CI's goldens
 * job runs that before this suite, as it builds the other fixtures cooler can
 * write, so the reference is whatever those packages make of the map on the
 * day. Without it the suite skips by name.
 *
 * Each block is read by this app from the coolers cooler wrote, normalised as the
 * score picker normalises it (`deriveBlock`, the one function every map calls),
 * and compared with cooler's own `matrix()` over the same bins. Every cell must
 * agree **to Float32's precision**, the type the block is held and drawn in: one
 * unit in its last place, 2⁻²³ relative, of which the rounding to Float32 alone
 * spends half.
 *
 * - **balanced** — the file's weights, as `cooler balance` just rewrote them,
 *   against `matrix(balance='weight')`, `NaN` exactly where cooler's is;
 * - **VC and VC √** — against one round of `cooler balance` from flat weights,
 *   nothing filtered and nothing rescaled, which is each bin's coverage over the
 *   mean (and its square root): the same numbers on the same scale, so no factor
 *   is fitted, and `NaN` on the bins nothing was seen in;
 * - **ICE** — against cooltools' `iterative_correction_symmetric` (and
 *   `_asymmetric` between two sequences), converged far past the app. Balancing
 *   fixes the weights up to one constant, and the two put it in different
 *   places, so one factor is fitted per block; the app goes on to
 *   `BALANCE_PRECISION`, 1e-9, which leaves each cell nothing past its own
 *   rounding. The app's empty bins are `NaN` where cooltools leaves them at 0.
 */

import { existsSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

import { MetaCooler } from '@/metacooler/MetaCooler'
import { deriveBlock, type Normalisation } from '@/render/derive'
import { LocalFileSource } from '@/sources/LocalFileSource'
import type { DenseMatrix, Extent } from '@/types'

const DIR = new URL('../fixtures/reprocessed/', import.meta.url).pathname
const MANIFEST = `${DIR}manifest.json`

type Kind = 'balanced' | 'vc' | 'vcsqrt' | 'ice'

/** One unit in the last place of a Float32, relative: the precision a block is held in. */
const FLOAT32 = 2 ** -23

interface Block {
  cool: string
  region: string
  rows: Extent
  cols: Extent
  kind: Kind
  file: string
}

interface Manifest {
  versions: Record<string, string>
  matrices: Block[]
}

const present = existsSync(MANIFEST)
const manifest: Manifest = present
  ? (JSON.parse(readFileSync(MANIFEST, 'utf8')) as Manifest)
  : { versions: {}, matrices: [] }

/** A block cooler wrote: little-endian float64, row by row. */
function reference(block: Block): Float64Array {
  const bytes = readFileSync(`${DIR}${block.file}`)
  const out = new Float64Array(bytes.byteLength / 8)
  new Uint8Array(out.buffer).set(bytes)
  return out
}

async function withCool<T>(name: string, body: (mc: MetaCooler) => Promise<T>): Promise<T> {
  const path = `${DIR}${name}`
  const mc = await MetaCooler.open(path, await LocalFileSource.open(path))
  try {
    return await body(mc)
  } finally {
    mc.close()
  }
}

/** The block as the score picker draws it under `kind`. */
async function drawn(mc: MetaCooler, block: Block): Promise<{ values: Float32Array; scope: string | null; raw: DenseMatrix }> {
  if (block.kind === 'balanced') {
    const balanced = await mc.matrix({ rows: block.rows, cols: block.cols, balance: true })
    return { values: balanced.values, scope: null, raw: balanced }
  }
  const raw = await mc.matrix({ rows: block.rows, cols: block.cols })
  const derived = deriveBlock(raw, { normalise: block.kind satisfies Normalisation }, { rows: [], cols: [] })
  return { values: derived.values, scope: derived.scope, raw }
}

/**
 * Every cell against cooler's, after `scale`: `NaN` where `missing` says, and
 * within `relative` of it everywhere else. The worst cell is what fails, by its
 * place, so a disagreement says where it is.
 */
function expectCells(
  what: string,
  got: Float32Array,
  want: Float64Array,
  ncols: number,
  relative: number,
  missing: (i: number) => boolean,
  scale = 1,
): void {
  expect(got.length, `${what}: cells`).toBe(want.length)
  let worst = 0
  let where = -1
  for (let i = 0; i < want.length; i++) {
    if (missing(i)) {
      if (!Number.isNaN(got[i])) expect.fail(`${what}: cell [${Math.floor(i / ncols)}, ${i % ncols}] is ${got[i]}, the reference has nothing there`)
      continue
    }
    const target = scale * want[i]
    if (!Number.isFinite(got[i])) expect.fail(`${what}: cell [${Math.floor(i / ncols)}, ${i % ncols}] is ${got[i]}, the reference ${target}`)
    if (target === 0) {
      if (got[i] !== 0) expect.fail(`${what}: cell [${Math.floor(i / ncols)}, ${i % ncols}] is ${got[i]}, the reference 0`)
      continue
    }
    const off = Math.abs(got[i] / target - 1)
    if (off > worst) {
      worst = off
      where = i
    }
  }
  expect(
    worst,
    `${what}: worst cell [${Math.floor(where / ncols)}, ${where % ncols}] is ${got[where]} against ${scale * want[where]}`,
  ).toBeLessThanOrEqual(relative)
}

/** Bins of an axis no contact in the block touches. */
function emptyBins(raw: DenseMatrix): { rows: boolean[]; cols: boolean[] } {
  const rows = new Array<boolean>(raw.nrows).fill(true)
  const cols = new Array<boolean>(raw.ncols).fill(true)
  for (let r = 0; r < raw.nrows; r++) {
    for (let c = 0; c < raw.ncols; c++) {
      if (raw.values[r * raw.ncols + c] > 0) {
        rows[r] = false
        cols[c] = false
      }
    }
  }
  return { rows, cols }
}

const VERSIONS = Object.entries(manifest.versions)
  .map(([name, version]) => `${name} ${version}`)
  .join(', ')

describe.skipIf(!present)(
  `normalisations against cooler and cooltools (${VERSIONS || 'run `npm run fixtures:reprocessed` to reprocess the demo map'})`,
  () => {
    for (const block of manifest.matrices) {
      const what = `${block.cool} ${block.region}, ${block.kind}`

      it(what, async () => {
        await withCool(block.cool, async (mc) => {
          const want = reference(block)
          const { values, scope, raw } = await drawn(mc, block)
          const { ncols } = raw

          if (block.kind !== 'ice') {
            expectCells(what, values, want, ncols, FLOAT32, (i) => Number.isNaN(want[i]))
            return
          }

          // ICE: converged, said so, and cooltools' up to one factor.
          expect(scope, `${what}: the app's ICE stopped before convergence`).toBeNull()
          const empty = emptyBins(raw)
          const missing = (i: number): boolean => empty.rows[Math.floor(i / ncols)] || empty.cols[i % ncols]
          let ours = 0
          let theirs = 0
          for (let i = 0; i < want.length; i++) {
            if (missing(i) || !Number.isFinite(values[i])) continue
            ours += values[i]
            theirs += want[i]
          }
          expect(theirs, `${what}: an empty reference`).toBeGreaterThan(0)
          expectCells(what, values, want, ncols, FLOAT32, missing, ours / theirs)
        })
      })
    }

    it('covers every normalisation the score picker offers, cis, between sequences and genome-wide', () => {
      const kinds = new Set(manifest.matrices.map((m) => m.kind))
      expect([...kinds].sort()).toEqual(['balanced', 'ice', 'vc', 'vcsqrt'])
      const rectangles = manifest.matrices.filter((m) => m.rows[0] !== m.cols[0] || m.rows[1] !== m.cols[1])
      expect(rectangles.map((m) => m.kind).sort()).toEqual(['balanced', 'ice'])
      expect(manifest.matrices.some((m) => m.region === 'genome' && m.kind === 'ice')).toBe(true)
    })
  },
)
