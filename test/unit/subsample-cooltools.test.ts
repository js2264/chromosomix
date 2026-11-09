/**
 * The contacts box's subsample (§6.5), held to `cooltools random-sample --exact`.
 *
 * Not to a golden: `npm run fixtures:reprocessed`
 * (`scripts/reprocess_with_cooltools.py`) has cooltools draw ten million of the
 * demo yeast Micro-C's 179,175,551 contacts into
 * `test/fixtures/reprocessed/subsample.cool`, and `cooler balance` balance what
 * it drew — in CI's goldens job, beside the other fixtures cooler can write, before
 * it runs this suite. Without it the suite skips by name.
 *
 * §6.5 promises cooltools' distribution and not its generator — a numpy stream
 * is not reproducible from here — so the two maps are two draws, and what is
 * held is that they are draws **from the same distribution**: every subset of
 * `N` of the map's `T` contacts equally likely, so that the contacts any set of
 * pixels keeps are hypergeometric, `N·p` on average with variance
 * `N·p·(1 − p)·(T − N)/(T − 1)`, `p` the set's share of the map. The two draws
 * differ in a set by twice that variance on average, and each comparison below
 * is that difference in its own standard deviations. The app draws from the
 * seed it draws every map from and cooltools from a seeded numpy, so a failure
 * is a number that comes back, not a flake.
 *
 * - the **total**, which `--exact` makes `N` in both, and in the reader's scan
 *   of cooltools' file what cooler says it wrote;
 * - every **pair of sequences**: no |z| past 5 among 136, and their mean square
 *   between 0.6 and 1.5;
 * - every **bin's coverage**, the contacts touching it: no |z| past 6 among
 *   twelve thousand, their mean square within 0.05 of 1;
 * - every **pixel**: the squared differences summed over the map against twice
 *   the variance summed, within 1%. A draw with replacement (a multinomial, or
 *   a Poisson per pixel) has `T/(T − N)` times cooltools' variance, 6% more at
 *   this depth, so the sum comes to 3% over by that count — 4% when the app's
 *   draw was made one with replacement to see;
 * - how many pixels hold **1, 2, … contacts**, each within 5 standard
 *   deviations of cooltools' count, which is what a draw that had every
 *   pixel's mean right and its shape wrong (a rounded `N/T` share, say) would
 *   not survive;
 * - and the **weights**: the file's own, times `√(T/N)`, which is how the app
 *   keeps a balanced subsample on the file's scale, against the weights
 *   `cooler balance` finds on cooltools' draw with the parameters the file's
 *   weights record. The scale must be exact, so the median ratio is held within
 *   half a percent, where no rescaling at all would put it at `√(N/T)`, a
 *   quarter; and bin by bin they differ by what the draw added to each bin's
 *   balanced marginal, worked out from the map in the last test — no |z| past
 *   7 among eleven thousand, their mean square within 0.15 of 1.
 */

import { existsSync, readFileSync } from 'node:fs'
import { beforeAll, describe, expect, it } from 'vitest'

import { MetaCooler } from '@/metacooler/MetaCooler'
import { LocalFileSource } from '@/sources/LocalFileSource'

const REPO = new URL('../../', import.meta.url).pathname
const DIR = new URL('../fixtures/reprocessed/', import.meta.url).pathname
const MANIFEST = `${DIR}manifest.json`

interface Manifest {
  versions: Record<string, string>
  source: { path: string; sum: number; nnz: number }
  subsample: {
    cool: string
    command: string
    contacts: number
    seed: number
    sum: number
    nnz: number
    balance: string
    ignoreDiags: number
  }
}

const present = existsSync(MANIFEST)
const manifest = present ? (JSON.parse(readFileSync(MANIFEST, 'utf8')) as Manifest) : null

async function open(path: string): Promise<MetaCooler> {
  return MetaCooler.open(path, await LocalFileSource.open(path))
}

/** The map's stored pixels, in `(bin1, bin2)` order, and where each row starts. */
interface Stored {
  bin1: Int32Array
  bin2: Int32Array
  count: Float64Array
  rowStart: Int32Array
  nBins: number
  /** First bin of every sequence, and the bin count last. */
  starts: number[]
}

async function readStored(mc: MetaCooler): Promise<Stored> {
  const n = mc.nnz
  const bin1 = new Int32Array(n)
  const bin2 = new Int32Array(n)
  const count = new Float64Array(n)
  let at = 0
  await mc.scanPixels({
    onChunk: (chunk) => {
      bin1.set(chunk.bin1.subarray(0, chunk.length), at)
      bin2.set(chunk.bin2.subarray(0, chunk.length), at)
      count.set(chunk.count.subarray(0, chunk.length), at)
      at += chunk.length
    },
  })
  expect(at, 'stored pixels scanned').toBe(n)
  const nBins = mc.nBins
  const rowStart = new Int32Array(nBins + 1)
  for (let i = 0; i < n; i++) rowStart[bin1[i] + 1]++
  for (let b = 0; b < nBins; b++) rowStart[b + 1] += rowStart[b]
  const starts = mc.chromnames.map((name) => mc.contigExtent(name)[0])
  starts.push(nBins)
  return { bin1, bin2, count, rowStart, nBins, starts }
}

/**
 * Another map's pixels, each placed at the stored pixel with the same bins —
 * found by bisection in its row, since a subsample has no pixel the map lacks
 * and the suite fails if it finds one.
 */
async function alongside(mc: MetaCooler, stored: Stored, what: string): Promise<{ values: Float64Array; total: number; nnz: number }> {
  const values = new Float64Array(stored.count.length)
  let total = 0
  let nnz = 0
  await mc.scanPixels({
    onChunk: (chunk) => {
      for (let i = 0; i < chunk.length; i++) {
        const b1 = chunk.bin1[i]
        const b2 = chunk.bin2[i]
        let lo = stored.rowStart[b1]
        let hi = stored.rowStart[b1 + 1]
        while (lo < hi) {
          const mid = (lo + hi) >> 1
          if (stored.bin2[mid] < b2) lo = mid + 1
          else hi = mid
        }
        if (lo === stored.rowStart[b1 + 1] || stored.bin2[lo] !== b2) {
          expect.fail(`${what}: pixel (${b1}, ${b2}) is not in the map it was drawn from`)
        }
        values[lo] += chunk.count[i]
        total += chunk.count[i]
        nnz++
      }
    },
  })
  return { values, total, nnz }
}

/** The variance of a hypergeometric draw of `n` of `total` from a set holding `k`. */
function variance(k: number, total: number, n: number): number {
  const p = k / total
  return (n * p * (1 - p) * (total - n)) / (total - 1)
}

/** Two draws' totals over sets, each difference in its standard deviations. */
function zScores(ours: Float64Array, theirs: Float64Array, stored: Float64Array, total: number, n: number): Float64Array {
  const z = new Float64Array(stored.length)
  for (let s = 0; s < stored.length; s++) {
    const v = 2 * variance(stored[s], total, n)
    z[s] = v > 0 ? (ours[s] - theirs[s]) / Math.sqrt(v) : 0
  }
  return z
}

function meanSquare(z: Float64Array, live: (s: number) => boolean): { mean: number; worst: number; sets: number } {
  let sum = 0
  let worst = 0
  let sets = 0
  for (let s = 0; s < z.length; s++) {
    if (!live(s)) continue
    sum += z[s] * z[s]
    worst = Math.max(worst, Math.abs(z[s]))
    sets++
  }
  return { mean: sum / sets, worst, sets }
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b)
  const mid = sorted.length >> 1
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}

describe.skipIf(manifest === null)(
  manifest === null
    ? 'subsample against cooltools (run `npm run fixtures:reprocessed` to reprocess the demo map)'
    : `subsample to ${manifest.subsample.contacts.toLocaleString('en')} contacts against \`${manifest.subsample.command}\` ` +
        `(${Object.entries(manifest.versions).map(([k, v]) => `${k} ${v}`).join(', ')})`,
  () => {
    // Collected even when skipped, so nothing here reads the manifest until a
    // test runs.
    const m = manifest!
    let N = 0
    let T = 0
    let stored: Stored
    let ours: { values: Float64Array; total: number; nnz: number }
    let theirs: { values: Float64Array; total: number; nnz: number }
    let weights: { ours: Float64Array; theirs: Float64Array }

    beforeAll(async () => {
      const source = await open(`${REPO}${m.source.path}`)
      const reference = await open(`${DIR}${m.subsample.cool}`)
      try {
        N = m.subsample.contacts
        T = source.info.sum as number
        stored = await readStored(source)
        theirs = await alongside(reference, stored, 'cooltools')
        // The app's draw, at the seed it draws every map from.
        const plan = await source.resample({ contacts: N })
        expect(plan?.mode).toBe('sub')
        ours = await alongside(source, stored, 'chromosomix')
        weights = {
          ours: source.binColumn('weight', 0, stored.nBins) as Float64Array,
          theirs: reference.binColumn('weight', 0, stored.nBins) as Float64Array,
        }
      } finally {
        source.close()
        reference.close()
      }
    }, 300_000)

    it('draws exactly N contacts, as cooltools does, and never more of a pixel than it held', () => {
      expect(T).toBe(m.source.sum)
      expect(ours.total).toBe(N)
      expect(theirs.total).toBe(N)
      // The reader read the whole of what cooltools wrote.
      expect(theirs.total).toBe(m.subsample.sum)
      expect(theirs.nnz).toBe(m.subsample.nnz)
      for (let p = 0; p < stored.count.length; p++) {
        if (ours.values[p] > stored.count[p]) expect.fail(`pixel ${p} drew ${ours.values[p]} of ${stored.count[p]}`)
      }
    })

    it('gives every pair of sequences cooltools’ share, within the noise of two draws', () => {
      const k = stored.starts.length - 1
      const seqOf = new Int32Array(stored.nBins)
      for (let s = 0; s < k; s++) seqOf.fill(s, stored.starts[s], stored.starts[s + 1])
      const pair = (p: number): number => seqOf[stored.bin1[p]] * k + seqOf[stored.bin2[p]]
      const held = new Float64Array(k * k)
      const a = new Float64Array(k * k)
      const b = new Float64Array(k * k)
      for (let p = 0; p < stored.count.length; p++) {
        const s = pair(p)
        held[s] += stored.count[p]
        a[s] += ours.values[p]
        b[s] += theirs.values[p]
      }
      const z = zScores(a, b, held, T, N)
      const { mean, worst, sets } = meanSquare(z, (s) => held[s] > 0)
      expect(sets).toBe((k * (k + 1)) / 2)
      expect(worst, 'the worst pair, in standard deviations').toBeLessThan(5)
      expect(mean, 'mean square z over the pairs').toBeGreaterThan(0.6)
      expect(mean, 'mean square z over the pairs').toBeLessThan(1.5)
    })

    it('gives every bin cooltools’ coverage, within the noise of two draws', () => {
      const held = new Float64Array(stored.nBins)
      const a = new Float64Array(stored.nBins)
      const b = new Float64Array(stored.nBins)
      for (let p = 0; p < stored.count.length; p++) {
        const b1 = stored.bin1[p]
        const b2 = stored.bin2[p]
        held[b1] += stored.count[p]
        a[b1] += ours.values[p]
        b[b1] += theirs.values[p]
        if (b2 !== b1) {
          held[b2] += stored.count[p]
          a[b2] += ours.values[p]
          b[b2] += theirs.values[p]
        }
      }
      const z = zScores(a, b, held, T, N)
      const { mean, worst } = meanSquare(z, (s) => held[s] > 0)
      expect(worst, 'the worst bin, in standard deviations').toBeLessThan(6)
      expect(Math.abs(mean - 1), 'mean square z over the bins, less 1').toBeLessThan(0.05)
    })

    it('spreads each pixel as a draw without replacement does', () => {
      let squares = 0
      let expected = 0
      for (let p = 0; p < stored.count.length; p++) {
        const d = ours.values[p] - theirs.values[p]
        squares += d * d
        expected += 2 * variance(stored.count[p], T, N)
      }
      const ratio = squares / expected
      expect(Math.abs(ratio - 1), `Σ(ours − cooltools)² over its expectation, ${ratio.toFixed(4)}, less 1`).toBeLessThan(0.01)
      // Where a draw with replacement would have put it: its variance and
      // cooltools' over twice cooltools'.
      expect((T / (T - N) - 1) / 2).toBeGreaterThan(0.02)
    })

    it('leaves as many pixels holding each count as cooltools does', () => {
      const bins = 12
      const a = new Float64Array(bins + 1)
      const b = new Float64Array(bins + 1)
      for (let p = 0; p < stored.count.length; p++) {
        a[Math.min(ours.values[p], bins)]++
        b[Math.min(theirs.values[p], bins)]++
      }
      // Pixels with nothing are what is left: the same test, from the other side.
      expect(a[0] + ours.nnz).toBe(stored.count.length)
      for (let v = 1; v <= bins; v++) {
        const sd = Math.sqrt(a[v] + b[v])
        expect(Math.abs(a[v] - b[v]) / sd, `pixels holding ${v === bins ? `${v} or more` : v} contacts: ${a[v]} against ${b[v]}`).toBeLessThan(5)
      }
    })

    it('balances on the file’s scale: the file’s weights times √(T/N) are cooler’s for the draw', () => {
      expect(weights.ours.length).toBe(stored.nBins)
      const ratios: number[] = []
      let ourBins = 0
      let theirBins = 0
      for (let b = 0; b < stored.nBins; b++) {
        const mine = Number.isFinite(weights.ours[b])
        const its = Number.isFinite(weights.theirs[b])
        if (mine) ourBins++
        if (its) theirBins++
        if (mine && its) ratios.push(weights.ours[b] / weights.theirs[b])
      }
      // Balancing the draw drops a few bins the file kept, and never many.
      expect(ratios.length / Math.max(ourBins, theirBins)).toBeGreaterThan(0.98)
      const middle = median(ratios)
      expect(Math.abs(middle - 1), `median weight ratio ${middle.toFixed(5)}, less 1`).toBeLessThan(0.005)
      // No rescaling at all would have put it here.
      expect(1 - Math.sqrt(N / T)).toBeGreaterThan(0.7)
    })

    it('balances bin by bin as cooler does, within what the draw adds to each bin', () => {
      // At the fixed point a bin's weight times its balanced marginal,
      // Σⱼ wᵢ·cᵢⱼ·wⱼ over the pixels the balance counts, is the same for every
      // bin. Noise in one bin's marginal alone moves its weight by all of it —
      // its partners each hold a sliver of that noise, so their weights barely
      // move to share it — where a change to every marginal at once moves each
      // weight by half, which is what √(T/N) takes out. Drawn, each pixel keeps
      // N/T of its contacts on average with variance N/T·(1 − N/T) of them, so
      // the marginal's relative variance, and the weight's, is
      // Σⱼ wⱼ²·cᵢⱼ / (Σⱼ wⱼ·cᵢⱼ)² · (1 − N/T)/(N/T), over the pixels outside the
      // diagonals the balance ignores and between bins it kept.
      const f = N / T
      const w = weights.ours
      const ignore = m.subsample.ignoreDiags
      const k = stored.starts.length - 1
      const seqOf = new Int32Array(stored.nBins)
      for (let s = 0; s < k; s++) seqOf.fill(s, stored.starts[s], stored.starts[s + 1])
      const first = new Float64Array(stored.nBins)
      const second = new Float64Array(stored.nBins)
      for (let p = 0; p < stored.count.length; p++) {
        const b1 = stored.bin1[p]
        const b2 = stored.bin2[p]
        if (seqOf[b1] === seqOf[b2] && b2 - b1 < ignore) continue
        if (!(Number.isFinite(w[b1]) && Number.isFinite(w[b2]))) continue
        const c = stored.count[p]
        first[b1] += w[b2] * c
        second[b1] += w[b2] * w[b2] * c
        first[b2] += w[b1] * c
        second[b2] += w[b1] * w[b1] * c
      }
      const z = new Float64Array(stored.nBins)
      const live = (b: number): boolean => Number.isFinite(w[b]) && Number.isFinite(weights.theirs[b]) && first[b] > 0
      for (let b = 0; b < stored.nBins; b++) {
        if (!live(b)) continue
        const sd = Math.sqrt((second[b] / (first[b] * first[b])) * ((1 - f) / f))
        z[b] = Math.log(w[b] / weights.theirs[b]) / sd
      }
      const { mean, worst } = meanSquare(z, live)
      expect(worst, 'the worst bin, in standard deviations').toBeLessThan(7)
      expect(Math.abs(mean - 1), 'mean square z over the bins, less 1').toBeLessThan(0.15)
    })
  },
)
