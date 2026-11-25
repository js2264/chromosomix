/**
 * Balancing by any weight column a file carries (§6.4).
 *
 * A cooler's `/bins` may hold several: `weight` from `cooler balance`, `normcc`
 * and `hiczin` from `metacooler normalize`, the `metator_empirical_hit` metaTOR
 * stores, the `KR` and `VC` hic2cool converts — the last ones *divisive*, as
 * cooler reads them. The reader balanced by `weight` alone; these are written
 * here, in one small cooler, and read back through every road a balanced read
 * takes, against `raw · w[i] · w[j]` worked out by hand.
 */

import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterAll, describe, expect, it, vi } from 'vitest'

import { main } from '@/cli/main'
import { ViewerError } from '@/errors'
import { getH5 } from '@/h5/bootstrap'
import { MetaCooler } from '@/metacooler/MetaCooler'
import { LocalFileSource } from '@/sources/LocalFileSource'

const workDir = mkdtempSync(join(tmpdir(), 'named-weights-'))
afterAll(() => rmSync(workDir, { recursive: true, force: true }))

/** Two sequences at 1 kb: chrA three bins, chrB two. */
const CHROMS = [
  { name: 'chrA', length: 3000 },
  { name: 'chrB', length: 2000 },
]
const N_BINS = 5
/** The upper triangle, sorted by `(bin1, bin2)`. */
const PIXELS: Array<[number, number, number]> = [
  [0, 0, 4],
  [0, 1, 2],
  [0, 3, 1],
  [1, 2, 6],
  [3, 4, 8],
  [4, 4, 2],
]

interface Column {
  values: number[]
  attrs?: Record<string, string | number | boolean>
}

/**
 * A cooler with `columns` beside its bins' coordinates, written as h5wasm
 * writes one (`pairs/write.ts`) and put on disk to be opened as a reader opens
 * a dropped file.
 */
async function cooler(name: string, columns: Record<string, Column>): Promise<string> {
  const h5 = await getH5()
  const scratch = `${tmpdir()}/named-weights-${name}-${Date.now()}.cool`
  const file = new h5.File(scratch, 'w')
  try {
    const attrs: Record<string, string | number> = {
      format: 'HDF5::Cooler',
      'format-version': 3,
      'bin-type': 'fixed',
      'bin-size': 1000,
      'storage-mode': 'symmetric-upper',
      nchroms: CHROMS.length,
      nbins: N_BINS,
      nnz: PIXELS.length,
      sum: PIXELS.reduce((total, [, , count]) => total + count, 0),
    }
    for (const [key, value] of Object.entries(attrs)) file.create_attribute(key, value)
    const chroms = file.create_group('chroms')
    chroms.create_dataset({ name: 'name', data: CHROMS.map((chrom) => chrom.name) })
    chroms.create_dataset({ name: 'length', data: Int32Array.from(CHROMS, (chrom) => chrom.length), dtype: '<i' })
    const bins = file.create_group('bins')
    bins.create_dataset({ name: 'chrom', data: Int32Array.from([0, 0, 0, 1, 1]), dtype: '<i' })
    bins.create_dataset({ name: 'start', data: Int32Array.from([0, 1000, 2000, 0, 1000]), dtype: '<i' })
    bins.create_dataset({ name: 'end', data: Int32Array.from([1000, 2000, 3000, 1000, 2000]), dtype: '<i' })
    // A whole number per bin, which is a value of the bins and not a weight.
    bins.create_dataset({ name: 'gc_count', data: Int32Array.from([5, 6, 7, 8, 9]), dtype: '<i' })
    for (const [column, { values, attrs: own }] of Object.entries(columns)) {
      const dataset = bins.create_dataset({ name: column, data: Float64Array.from(values), dtype: '<d' })
      for (const [key, value] of Object.entries(own ?? {})) {
        dataset.create_attribute(key, typeof value === 'boolean' ? Number(value) : value)
      }
    }
    const pixels = file.create_group('pixels')
    pixels.create_dataset({ name: 'bin1_id', data: BigInt64Array.from(PIXELS, ([a]) => BigInt(a)), dtype: '<q' })
    pixels.create_dataset({ name: 'bin2_id', data: BigInt64Array.from(PIXELS, ([, b]) => BigInt(b)), dtype: '<q' })
    pixels.create_dataset({ name: 'count', data: Int32Array.from(PIXELS, ([, , count]) => count), dtype: '<i' })
    const indexes = file.create_group('indexes')
    indexes.create_dataset({ name: 'chrom_offset', data: BigInt64Array.from([0n, 3n, 5n]), dtype: '<q' })
    const offsets = new BigInt64Array(N_BINS + 1)
    let at = 0
    for (let bin = 0; bin < N_BINS; bin++) {
      while (at < PIXELS.length && PIXELS[at][0] === bin) at++
      offsets[bin + 1] = BigInt(at)
    }
    indexes.create_dataset({ name: 'bin1_offset', data: offsets, dtype: '<q' })
  } finally {
    file.close()
  }
  const bytes = h5.FS.readFile(scratch)
  h5.FS.unlink(scratch)
  const path = join(workDir, `${name}.cool`)
  writeFileSync(path, bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes))
  return path
}

async function open(path: string): Promise<MetaCooler> {
  return MetaCooler.open(path, await LocalFileSource.open(path))
}

/** The whole map, balanced by the column in force, as a square of numbers. */
async function balanced(mc: MetaCooler): Promise<number[][]> {
  const block = await mc.matrix({ rows: [0, N_BINS], cols: [0, N_BINS], balance: true, value: 'count' })
  return Array.from({ length: N_BINS }, (_, r) => Array.from(block.values.slice(r * N_BINS, (r + 1) * N_BINS)))
}

/** `raw · w[i] · w[j]` over the whole map, filled symmetrically, by hand. */
function expected(weights: number[]): number[][] {
  const out = Array.from({ length: N_BINS }, () => new Array<number>(N_BINS).fill(0))
  for (const [a, b, count] of PIXELS) {
    out[a][b] = count * weights[a] * weights[b]
    out[b][a] = out[a][b]
  }
  // A cell with no contact under a weight that is not a plain number is that
  // weight's product too: NaN through and through, the bin left out.
  for (let r = 0; r < N_BINS; r++) {
    for (let c = 0; c < N_BINS; c++) {
      if (!Number.isFinite(weights[r]) || !Number.isFinite(weights[c])) out[r][c] = Number.NaN
    }
  }
  return out
}

function expectClose(actual: number[][], wanted: number[][]): void {
  for (let r = 0; r < N_BINS; r++) {
    for (let c = 0; c < N_BINS; c++) {
      if (Number.isNaN(wanted[r][c])) expect(actual[r][c], `cell ${r},${c}`).toBeNaN()
      else expect(actual[r][c], `cell ${r},${c}`).toBeCloseTo(wanted[r][c], 5)
    }
  }
}

const WEIGHT = [1, 0.5, 2, 1, Number.NaN]
const NORMCC = [0.1, 0.2, 0.3, 0.4, 0.5]
const KR = [2, 4, 0.5, 1, 0]
const ALL = {
  weight: { values: WEIGHT },
  normcc: { values: NORMCC, attrs: { normalization: 'normcc', divisive_weights: false } },
  KR: { values: KR },
  custom: { values: [4, 4, 4, 4, 4], attrs: { divisive_weights: true } },
}

describe('a cooler with several weight columns', () => {
  it('lists every floating-point column of its bins as a weight, and balances by weight first', async () => {
    const mc = await open(await cooler('several', ALL))
    try {
      // Every float column but the coordinates; the whole-number one is not.
      expect([...mc.weightColumns].sort()).toEqual(['KR', 'custom', 'normcc', 'weight'])
      expect(mc.weightColumn).toBe('weight')
      expect(mc.hasWeights).toBe(true)
      expectClose(await balanced(mc), expected(WEIGHT))
    } finally {
      mc.close()
    }
  })

  it('balances by the column chosen by name, multiplying as it multiplies by weight', async () => {
    const mc = await open(await cooler('chosen', ALL))
    try {
      mc.selectWeight('normcc')
      expect(mc.weightColumn).toBe('normcc')
      expectClose(await balanced(mc), expected(NORMCC))
      // And back: `null`, or `weight` by name, is the file's default again.
      mc.selectWeight(null)
      expect(mc.weightColumn).toBe('weight')
      expectClose(await balanced(mc), expected(WEIGHT))
    } finally {
      mc.close()
    }
  })

  it('inverts a column cooler reads as divisive, by its name or by its attribute', async () => {
    const mc = await open(await cooler('divisive', ALL))
    try {
      // KR by name: raw / (KR[i] · KR[j]), and a zero is a bin left out.
      mc.selectWeight('KR')
      expectClose(await balanced(mc), expected(KR.map((w) => (w === 0 ? Number.NaN : 1 / w))))
      // Any name, by its `divisive_weights` attribute.
      mc.selectWeight('custom')
      expectClose(await balanced(mc), expected([0.25, 0.25, 0.25, 0.25, 0.25]))
    } finally {
      mc.close()
    }
  })

  it('draws a lane of weight as the file stores it while another column is chosen', async () => {
    const mc = await open(await cooler('lane', ALL))
    try {
      mc.selectWeight('normcc')
      expect(Array.from(mc.binColumn('weight', 0, N_BINS) as Float64Array)).toEqual(WEIGHT)
      expect(Array.from(mc.binColumn('normcc', 0, N_BINS) as Float64Array)).toEqual(NORMCC)
    } finally {
      mc.close()
    }
  })

  it('refuses a column that is not one of its weights, naming the ones there are', async () => {
    const mc = await open(await cooler('refused', ALL))
    try {
      for (const name of ['gc_count', 'start', 'nope']) {
        let thrown: unknown
        try {
          mc.selectWeight(name)
        } catch (error) {
          thrown = error
        }
        expect(thrown, name).toBeInstanceOf(ViewerError)
        expect((thrown as ViewerError).code).toBe('unsupported')
        expect((thrown as ViewerError).message).toContain('its weight columns are')
      }
      // A refusal leaves the column in force as it was.
      expect(mc.weightColumn).toBe('weight')
    } finally {
      mc.close()
    }
  })
})

describe('a map whose only weights are another tool’s', () => {
  it('opens on its counts, and is balanced by that column when it is chosen', async () => {
    // A metaTOR map's `metator_empirical_hit`: offered, never the default.
    const mc = await open(await cooler('metator', { metator_empirical_hit: { values: NORMCC } }))
    try {
      expect(mc.weightColumns).toEqual(['metator_empirical_hit'])
      expect(mc.weightColumn).toBeNull()
      expect(mc.hasWeights).toBe(false)
      mc.selectWeight('metator_empirical_hit')
      expect(mc.hasWeights).toBe(true)
      expectClose(await balanced(mc), expected(NORMCC))
    } finally {
      mc.close()
    }
  })

  it('carries the chosen column into a resolution it is summed to', async () => {
    const mc = await open(await cooler('coarse', { metator_empirical_hit: { values: NORMCC } }))
    try {
      mc.selectWeight('metator_empirical_hit')
      const { map, refusal } = MetaCooler.coarsened(mc, 2)
      expect(refusal).toBeNull()
      expect(map.hasWeights).toBe(true)
      // A coarse bin's weight is the harmonic mean of its fine bins' (§3.4):
      // chrA's first two bins, 0.1 and 0.2, give 2 / (1/0.1 + 1/0.2).
      const coarse = map.binColumn('weight', 0, 1) as Float64Array
      expect(coarse[0]).toBeCloseTo(2 / (1 / 0.1 + 1 / 0.2), 12)
    } finally {
      mc.close()
    }
  })
})

describe('the command line, balanced by a column by name', () => {
  /** Run a line, with what it prints kept rather than shown. */
  async function run(argv: string[]): Promise<{ code: number; said: string }> {
    const out: string[] = []
    const write = (chunk: unknown): boolean => {
      out.push(String(chunk))
      return true
    }
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(write)
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(write)
    try {
      return { code: await main(argv), said: out.join('') }
    } finally {
      stdout.mockRestore()
      stderr.mockRestore()
    }
  }

  it('balances by the column --weight names, and records it', async () => {
    const path = await cooler('cli', ALL)
    const where = join(workDir, 'cli-normcc')
    const { code } = await run(['coverage', path, '--balance', '--weight', 'normcc', '--out', where, '--quiet'])
    expect(code).toBe(0)
    const table = readdirSync(where).find((name) => name.endsWith('.tsv'))
    expect(table).toBeDefined()
    const text = readFileSync(join(where, table as string), 'utf8')
    expect(text).toMatch(/^# framing: .*balanced by normcc/m)
  })

  it('refuses a column the file has not got, naming the ones it has', async () => {
    const path = await cooler('cli-refused', ALL)
    const { code, said } = await run(['coverage', path, '--balance', '--weight', 'hiczin', '--out', join(workDir, 'x'), '--quiet'])
    expect(code).not.toBe(0)
    expect(said).toMatch(/no weight column \/bins\/hiczin; its weight columns are/)
  })
})
