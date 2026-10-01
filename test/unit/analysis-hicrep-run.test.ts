/**
 * Reproducibility, run: what it does with the list of sequences (§18.2).
 *
 * The coefficient is the kernel's and is checked against `hicrep` 0.2.6 in
 * `analysis-new-kernels`. What is pinned here is the runner around it, and the
 * two answers a list can give that are not a comparison at all. **Nothing
 * ticked** is a reader who pressed *none*: it used to come back as every
 * sequence of every map, and is now told so — before a second file is mounted
 * for it, since mounting a remote peer is a metadata walk of its own. **A name
 * the map has not got** is named and left out (§5.9) rather than dropped in
 * silence, and a list of nothing else is said as that, not as nothing ticked.
 */

import { describe, expect, it } from 'vitest'

import type { JobContext } from '@/analysis/job'
import { runHicrep } from '@/analysis/run/hicrep'
import type { AnalysisFraming, Params } from '@/analysis/types'
import type { PeerMap } from '@/analysis/worker/protocol'
import type { MetaCooler } from '@/metacooler/MetaCooler'

const NAMES = ['chrI', 'chrII']
const EXTENT: Array<[number, number]> = [
  [0, 10],
  [10, 16],
]

/** Enough of a map for a list of names to be resolved against it. */
function map(): MetaCooler {
  return {
    nBins: 16,
    nContigs: NAMES.length,
    binsize: 1000,
    chromnames: NAMES,
    contigExtent: (cid: number) => EXTENT[cid],
    hasContig: (name: string) => NAMES.includes(name),
    contigId: (name: string) => NAMES.indexOf(name),
    names: { find: () => null },
  } as unknown as MetaCooler
}

const FRAMING: AnalysisFraming = {
  uri: 'rep1.cool',
  label: 'whole file',
  binsize: 1000,
  binsPerCell: 1,
  rows: [0, 16],
  cols: [0, 16],
  balance: false,
  value: '',
  normalise: null,
  level: 'bin',
}

/** One run against one peer, with what it mounted, closed and said. */
async function run(params: Params): Promise<{
  outputs: number
  opened: string[]
  closed: string[]
  notes: string[]
}> {
  const opened: string[] = []
  const closed: string[] = []
  const notes: string[] = []
  const outputs = await runHicrep({
    mc: map(),
    params,
    framing: FRAMING,
    inputs: {
      peers: [{ label: 'rep2', uri: 'rep2.cool' } as PeerMap],
      mapLabel: 'rep1',
    },
    cancelled: () => false,
    throwIfCancelled: () => {},
    breathe: async () => {},
    progress: () => {},
    note: (text: string) => notes.push(text),
    toBp: (bins: number) => bins * 1000,
    toBins: (bp: number) => Math.max(1, Math.round(bp / 1000)),
    peer: async (peer: PeerMap) => {
      opened.push(peer.label)
      return { mc: map(), close: () => closed.push(peer.label) }
    },
  } as unknown as JobContext)
  return { outputs: outputs.length, opened, closed, notes }
}

describe('a reproducibility run’s sequences', () => {
  it('compares over nothing when nothing is ticked, and mounts no second map for it', async () => {
    const { outputs, opened, notes } = await run({ sequences: [] })
    expect(outputs).toBe(0)
    expect(notes).toEqual(['No sequence is ticked, so there is nothing to compare over.'])
    expect(opened).toEqual([])
  })

  it('names a ticked sequence the map has not got, and closes what it opened', async () => {
    const { outputs, opened, closed, notes } = await run({ sequences: ['chrX'] })
    expect(outputs).toBe(0)
    expect(notes).toHaveLength(1)
    expect(notes[0]).toMatch(/^This file has no sequence called chrX/)
    // The peer was mounted to be compared with, and goes again whatever the
    // run found — a worker that goes on living must not keep it.
    expect(opened).toEqual(['rep2'])
    expect(closed).toEqual(['rep2'])
  })
})
