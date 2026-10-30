/**
 * Arrowhead, held to `juicer_tools arrowhead`'s own output.
 *
 * `scripts/make_arrowhead_golden.py` runs Juicer Tools 1.22.01 over the demo
 * `.hic` at two resolutions, raw and balanced, and writes every domain of each
 * `_blocks.bedpe` with the five scores beside it. Here the runner reads the same
 * file through this app's own `.hic` reader — the road the worker and
 * `chromosomix arrowhead` take — and must call the same domains, at the same
 * corners, with the same scores.
 *
 * Skipped by name where the golden has not been built: it needs Java and the
 * jar, which a fresh clone and a CI runner without them do not have.
 */

import { existsSync, readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

import type { JobContext } from '@/analysis/job'
import { runArrowhead } from '@/analysis/run/arrowhead'
import type { AnalysisFraming, TableOutput } from '@/analysis/types'
import { MetaCooler } from '@/metacooler/MetaCooler'
import { LocalFileSource } from '@/sources/LocalFileSource'

const GOLDEN = new URL('../golden/analysis/arrowhead.json', import.meta.url).pathname
const HIC = new URL('../../demo/yeast/Yeast_hic.hic', import.meta.url).pathname

interface Golden {
  java: string
  matrixSize: number
  runs: Array<{
    resolution: number
    norm: string
    domains: Array<{
      chrom: string
      x1: number
      x2: number
      score: number
      uVarScore: number
      lVarScore: number
      upSign: number
      loSign: number
    }>
  }>
}

const golden: Golden | null = existsSync(GOLDEN) ? (JSON.parse(readFileSync(GOLDEN, 'utf8')) as Golden) : null

/**
 * How far a score may be from Juicer's. The raw counts are read bit for bit as
 * Juicer reads them and every sum is taken in its order, so they agree to the
 * last digit Java prints; a balanced cell is the count over two weights here
 * and over their product in Juicer, which can differ in the last bit of a
 * float32 — and the score is a ratio of sums of millions of such cells.
 */
const TOLERANCE = { NONE: 0, balanced: 1e-9 }

async function open(binsize: number): Promise<MetaCooler> {
  const source = await LocalFileSource.fromPath(HIC)
  await source.mount()
  return MetaCooler.fromHic(`${HIC}::/resolutions/${binsize}`, source)
}

function job(mc: MetaCooler, balance: boolean, matrixSize: number): JobContext {
  return {
    mc,
    params: { sequences: null, matrixSize, balance },
    framing: { value: '' } as AnalysisFraming,
    inputs: {} as never,
    cancelled: () => false,
    throwIfCancelled: () => {},
    breathe: async () => {},
    progress: () => {},
    note: () => {},
    toBp: (bins) => bins * mc.binsize,
    toBins: (bp) => Math.max(1, Math.round(bp / mc.binsize)),
  }
}

describe('Arrowhead against juicer_tools arrowhead', () => {
  if (golden === null) it.skip('needs its golden: npm run fixtures:arrowhead', () => {})
  for (const run of golden?.runs ?? []) {
    it(`calls Juicer's domains at ${run.resolution} bp, ${run.norm}`, async () => {
      const mc = await open(run.resolution)
      const outputs = await runArrowhead(job(mc, run.norm !== 'NONE', golden!.matrixSize))
      const table = outputs.find((output): output is TableOutput => output.kind === 'table')
      const key = (chrom: string, x1: number, x2: number): string => `${chrom}:${x1}-${x2}`
      const ours = new Map((table?.rows ?? []).map((row) => [key(String(row.sequence), Number(row.start), Number(row.end)), row]))
      // Juicer writes the corner's bin starts, and a domain whose last corner is
      // the sequence's last bin ends past the sequence; the app clamps that.
      const length = (chrom: string): number => mc.chromsizes.get(chrom) ?? Number.POSITIVE_INFINITY
      const theirs = run.domains.map((domain) => ({ ...domain, x2: Math.min(domain.x2, length(domain.chrom)) }))
      expect([...ours.keys()].sort()).toEqual(theirs.map((domain) => key(domain.chrom, domain.x1, domain.x2)).sort())
      const tolerance = run.norm === 'NONE' ? TOLERANCE.NONE : TOLERANCE.balanced
      for (const domain of theirs) {
        const row = ours.get(key(domain.chrom, domain.x1, domain.x2))!
        for (const column of ['score', 'uVarScore', 'lVarScore', 'upSign', 'loSign'] as const) {
          const a = Number(row[column])
          const b = domain[column]
          expect(Math.abs(a - b), `${key(domain.chrom, domain.x1, domain.x2)} ${column}`).toBeLessThanOrEqual(
            tolerance * Math.max(1, Math.abs(b)),
          )
        }
      }
    }, 120_000)
  }
})
