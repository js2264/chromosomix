/**
 * The junction test at the rung it is now measured at (§8.15).
 *
 * The session measures each sequence at the coarsest rung that still gives it a
 * hundred bins (`junctionRung`), because at a large file's finest rung the six
 * bins the test reads cost megabytes apiece. That is only right if the answer
 * does not move: on each demo map, every sequence is scored at the finest rung
 * and at the chosen one, and the two must agree on circular or not. And a file
 * opened coarser than that leaves some sequences fewer bins than the test needs,
 * which are then not measured at all: read anyway, the yeast demo's chromosome I
 * at 16 kb would pass for a circle.
 */

import { describe, expect, it } from 'vitest'

import {
  CIRCULAR_SCORE,
  JUNCTION_TARGET_BINS,
  MIN_JUNCTION_SEQUENCE_BINS,
  junctionCandidates,
  junctionRung,
  measureJunctions,
} from '../../src/analysis/circularity'
import type { ViewerError } from '../../src/errors'
import { MetaCooler } from '../../src/metacooler/MetaCooler'
import { LocalFileSource } from '../../src/sources/LocalFileSource'

const DEMOS = [
  new URL('../../demo/ecoli/Ecoli.mcool', import.meta.url).pathname,
  new URL('../../demo/yeast-mpneumoniae/Yeast_mpneumoniae_G2M.mcool', import.meta.url).pathname,
  new URL('../../demo/yeast/Yeast_hic.hic', import.meta.url).pathname,
]

async function scoresAt(path: string, rung: number, names: readonly string[]): Promise<Record<string, number>> {
  const source = await LocalFileSource.fromPath(path)
  await source.mount()
  const mc = await MetaCooler.open(`${path}::/resolutions/${rung}`, source)
  try {
    // Each sequence where this rung's own table puts it: a coarse level may
    // absorb a sequence's last part-bin, so `ceil(length / binsize)` is not
    // its extent everywhere.
    const tested = names.map((name) => {
      const [from, to] = mc.contigExtent(name)
      return { name, from, n: to - from }
    })
    const balance = mc.hasWeights
    const measured = await measureJunctions(tested, async (rows, cols) => (await mc.matrix({ rows, cols, balance })).values)
    return measured?.scores ?? {}
  } finally {
    mc.close()
  }
}

describe('the junction test at a coarse rung', () => {
  it('picks the coarsest rung that leaves a hundred bins, and the open one otherwise', () => {
    const rungs = [1_000, 5_000, 10_000, 50_000, 100_000, 1_000_000]
    expect(junctionRung(4_600_000, 1_000, rungs)).toBe(10_000)
    expect(junctionRung(195_000_000, 1_000, rungs)).toBe(1_000_000)
    expect(junctionRung(50_000, 1_000, rungs)).toBe(1_000)
    // Never finer than the rung open.
    expect(junctionRung(4_600_000, 50_000, rungs)).toBe(50_000)
    expect(Math.ceil(4_600_000 / 10_000)).toBeGreaterThanOrEqual(JUNCTION_TARGET_BINS)
  })

  it.each(DEMOS)('decides every sequence of %s as the finest rung does', async (path) => {
    const source = await LocalFileSource.fromPath(path)
    await source.mount()
    // An .mcool is refused at its root with its ladder; a .hic opens there.
    const ladder = await MetaCooler.open(path, source).then(
      (mc) => { const entries = mc.entries; mc.close(); return entries },
      (err: ViewerError) => err.detail['entries'] as string[],
    )
    const rungs = ladder.filter((e) => /^\d+$/.test(e)).map(Number).sort((a, b) => a - b)
    const probe = await MetaCooler.open(`${path}::/resolutions/${rungs[0]}`, await LocalFileSource.fromPath(path))
    const pairs = probe.chromnames.map((name, i) => [name, Number(probe.contigs.numbers('length')[i])] as const)
    probe.close()
    const finest = rungs[0]
    const names = junctionCandidates(pairs, finest).map((c) => c.name)
    const fine = await scoresAt(path, finest, names)
    const byRung = new Map<number, string[]>()
    for (const [name, length] of pairs) {
      if (!names.includes(name)) continue
      const rung = junctionRung(length, finest, rungs)
      byRung.set(rung, [...(byRung.get(rung) ?? []), name])
    }
    const coarse: Record<string, number> = {}
    for (const [rung, at] of byRung) Object.assign(coarse, await scoresAt(path, rung, at))
    const decided = Object.keys(fine).filter((name) => name in coarse)
    expect(decided.length).toBeGreaterThan(0)
    for (const name of decided) {
      expect({ name, circular: coarse[name] >= CIRCULAR_SCORE }).toEqual({ name, circular: fine[name] >= CIRCULAR_SCORE })
    }
    console.log(
      path.split('/').pop(),
      decided.map((n) => `${n}: ${fine[n].toFixed(3)} → ${coarse[n].toFixed(3)}`).join(', '),
    )
  })
})

describe('a sequence the rung read leaves too few bins', () => {
  /**
   * Chromosome I of the yeast demo is 230 kb, fifteen bins at 16 kb. The cells
   * joining its ends are then fourteen bins apart, not far down the decay, and a
   * yeast chromosome's two telomeres are held together besides: its corner holds
   * most of what its diagonal does, and it scores as a circle. A file opened
   * there does not measure it.
   */
  it('is not measured: the yeast demo opened at 16 kb would read chromosome I as a circle', async () => {
    const path = DEMOS[2]
    const scores = await scoresAt(path, 16_000, ['I'])
    expect(scores.I).toBeGreaterThanOrEqual(CIRCULAR_SCORE)

    const source = await LocalFileSource.fromPath(path)
    await source.mount()
    const mc = await MetaCooler.open(`${path}::/resolutions/16000`, source)
    const pairs = mc.chromnames.map((name, i) => [name, Number(mc.contigs.numbers('length')[i])] as const)
    mc.close()
    const length = pairs.find(([name]) => name === 'I')?.[1] ?? 0
    expect(Math.ceil(length / 16_000)).toBeLessThan(MIN_JUNCTION_SEQUENCE_BINS)
    expect(junctionCandidates(pairs, 16_000).map((one) => one.name)).not.toContain('I')
  })
})
