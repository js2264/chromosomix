/**
 * Which genome each stretch of a contig axis belongs to.
 *
 * The whole-genome view of a metacool is the one picture whose axes run over
 * the entire file, so it is the one place where "which genome is this contig
 * in" is not already answered by the view you are in. The reader answers it
 * with these runs and the tooltip reads them; they are never drawn (see
 * `separatorsFor`), so nothing about the image would change if they were wrong
 * — which is exactly why they need a test of their own.
 *
 * Checked against the file's own `genome_id` mapping rather than against a
 * golden, because that mapping *is* the oracle: §7.4's "nothing is renumbered"
 * means the contig → genome relation in the file is the answer, and a run
 * encoding of it is right when it agrees bin for bin.
 */

import { describe, expect, it } from 'vitest'

import { MetaCooler } from '@/metacooler/MetaCooler'
import { LocalFileSource } from '@/sources/LocalFileSource'
import { aggregatedGenomeRuns, contigRuns, genomeRuns } from '@/worker/groups'
import { FIXTURE_DIR } from '../support/goldens'

const PATH = `${FIXTURE_DIR}basic.metacool`

async function open(): Promise<MetaCooler> {
  return MetaCooler.open(PATH, await LocalFileSource.open(PATH))
}

describe('genomeRuns', () => {
  it('names, for every bin of the file, the genome its contig is in', async () => {
    const mc = await open()
    try {
      const runs = genomeRuns(mc, [0, mc.nBins])
      expect(runs.length).toBeGreaterThan(1)

      // Walk every bin and check the run covering it names the same genome the
      // file does. This is the property the tooltip depends on, stated directly.
      const contigOfBin = mc.coords.contigsOfBins(0, mc.nBins)
      let run = 0
      for (let bin = 0; bin < mc.nBins; bin++) {
        while (bin >= runs[run].end) run++
        expect(bin, `bin ${bin} falls outside its run`).toBeGreaterThanOrEqual(runs[run].start)
        const expected = mc.genomeNames[mc.contigGenomeIds[contigOfBin[bin]]]
        expect(runs[run].label, `bin ${bin}`).toBe(expected)
      }
    } finally {
      mc.close()
    }
  })

  it('tiles the axis exactly: no gap, no overlap, no empty run', async () => {
    const mc = await open()
    try {
      const runs = genomeRuns(mc, [0, mc.nBins])
      expect(runs[0].start).toBe(0)
      expect(runs[runs.length - 1].end).toBe(mc.nBins)
      for (let i = 0; i < runs.length; i++) {
        expect(runs[i].end).toBeGreaterThan(runs[i].start)
        if (i > 0) expect(runs[i].start).toBe(runs[i - 1].end)
      }
    } finally {
      mc.close()
    }
  })

  it('is coarser than the contig runs, and lines up with their boundaries', async () => {
    const mc = await open()
    try {
      const contigs = contigRuns(mc, [0, mc.nBins])
      const genomes = genomeRuns(mc, [0, mc.nBins])
      // A metacool has more contigs than genomes, and every genome boundary is
      // also a contig boundary — a genome cannot begin partway through a contig.
      expect(genomes.length).toBeLessThan(contigs.length)
      const contigStarts = new Set(contigs.map((run) => run.start))
      for (const run of genomes) expect(contigStarts.has(run.start)).toBe(true)
    } finally {
      mc.close()
    }
  })

  it('answers for a sub-range of the file, in the offsets of that range', async () => {
    const mc = await open()
    try {
      const lo = Math.floor(mc.nBins / 3)
      const hi = Math.floor((2 * mc.nBins) / 3)
      const runs = genomeRuns(mc, [lo, hi])
      expect(runs[0].start).toBe(0)
      expect(runs[runs.length - 1].end).toBe(hi - lo)
      const contigOfBin = mc.coords.contigsOfBins(lo, hi)
      for (const run of runs) {
        const expected = mc.genomeNames[mc.contigGenomeIds[contigOfBin[run.start]]]
        expect(run.label).toBe(expected)
      }
    } finally {
      mc.close()
    }
  })
})

describe('aggregatedGenomeRuns', () => {
  it('names the genome of each contig on a rolled-up axis', async () => {
    const mc = await open()
    try {
      // The axis a contig-level roll-up produces: one slot per contig, in file
      // order, which is grouped by genome (C4).
      const ids = Int32Array.from({ length: mc.chromnames.length }, (_, i) => i)
      const runs = aggregatedGenomeRuns(mc, ids)
      expect(runs[0].start).toBe(0)
      expect(runs[runs.length - 1].end).toBe(ids.length)
      for (const run of runs) {
        for (let slot = run.start; slot < run.end; slot++) {
          expect(runs.length, 'slot outside a run').toBeGreaterThan(0)
          expect(run.label).toBe(mc.genomeNames[mc.contigGenomeIds[ids[slot]]])
        }
      }
    } finally {
      mc.close()
    }
  })

  it('carries no unit start, which an index axis has no meaning for', async () => {
    const mc = await open()
    try {
      const ids = Int32Array.from({ length: mc.chromnames.length }, (_, i) => i)
      for (const run of aggregatedGenomeRuns(mc, ids)) {
        expect(run.unitStart).toBeUndefined()
      }
    } finally {
      mc.close()
    }
  })
})
