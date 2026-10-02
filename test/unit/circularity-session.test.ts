/**
 * The check a session runs when a file is first opened, reading each sequence
 * where the file puts it (§8.15).
 *
 * `junctionCandidates` places a sequence by `ceil(length / binsize)`, and a
 * level written by flooring each sequence's last part-bin does not: the yeast
 * and *M. pneumoniae* demo at 2 kb starts every sequence after the first a bin
 * earlier for each one before it. The session asks the reader for each
 * sequence's extent and measures it there — the reader here is the file itself,
 * answering as the worker does.
 */

import { describe, expect, it } from 'vitest'

import {
  JUNCTION_BINS,
  MIN_JUNCTION_SEQUENCE_BINS,
  junctionCandidates,
  measureJunctions,
} from '../../src/analysis/circularity'
import { Session } from '../../src/app/Session'
import { MetaCooler } from '../../src/metacooler/MetaCooler'
import { LocalFileSource } from '../../src/sources/LocalFileSource'

const DEMO = new URL('../../demo/yeast-mpneumoniae/Yeast_mpneumoniae_G2M.mcool', import.meta.url).pathname
const URI = `${DEMO}::/resolutions/2000`

interface Detecting {
  detectCircular(uri: string): Promise<void>
}

/** What the session recorded, and the rows of every block it read. */
interface Run {
  scores: Record<string, number> | null
  rows: Array<readonly [number, number]>
}

/**
 * `detectCircular` on a session holding the demo at 2 kb, its reader answering
 * from the file; `unresolved` are names the reader cannot look up.
 */
async function detect(mc: MetaCooler, unresolved: readonly string[] = []): Promise<Run> {
  const run: Run = { scores: null, rows: [] }
  const file = {
    uri: URI,
    info: {
      hasGenomes: false,
      binsize: mc.binsize,
      hasWeights: mc.hasWeights,
      // One rung, so each sequence is read at the open one.
      entryGroup: 'resolutions',
      entries: ['2000'],
    },
  }
  const client = {
    async request(message: { kind: string; range?: string; rows?: [number, number]; cols?: [number, number] }) {
      if (message.kind === 'range') {
        if (unresolved.includes(message.range ?? '')) throw new Error(`no sequence ${message.range}`)
        return { extent: mc.contigExtent(message.range ?? '') }
      }
      if (message.kind === 'matrix' && message.rows !== undefined && message.cols !== undefined) {
        run.rows.push(message.rows)
        return mc.matrix({ rows: message.rows, cols: message.cols, balance: mc.hasWeights })
      }
      throw new Error(`not asked here: ${message.kind}`)
    },
  }
  const session = {
    file,
    destroyed: false,
    sessionKey: () => 'demo',
    memoryKey: () => 'demo',
    circularStore: () => ({
      evidence: () => null,
      detected: (scores: Record<string, number>) => {
        run.scores = scores
      },
      has: () => false,
    }),
    contigs: async () => ({
      table: {
        data: {
          name: [...mc.chromnames],
          length: Float64Array.from(mc.coords.contigLengths),
        },
      },
    }),
    clientOf: () => client,
    adoptCircular: () => {},
    say: () => {},
  }
  await (Session.prototype as unknown as Detecting).detectCircular.call(session, URI)
  return run
}

/** The scores of every sequence of fifty bins or more, each read at the file's own extent. */
async function oracle(mc: MetaCooler): Promise<Record<string, number>> {
  const placed = mc.chromnames.flatMap((name) => {
    const [from, to] = mc.contigExtent(name)
    return to - from >= MIN_JUNCTION_SEQUENCE_BINS ? [{ name, from, n: to - from }] : []
  })
  const measured = await measureJunctions(
    placed,
    async (rows, cols) => (await mc.matrix({ rows, cols, balance: mc.hasWeights })).values,
  )
  return measured?.scores ?? {}
}

describe('the check a session runs on opening a file', () => {
  it('reads each sequence where the file puts it, on a level that floors its part-bins', async () => {
    const source = await LocalFileSource.fromPath(DEMO)
    await source.mount()
    const mc = await MetaCooler.open(URI, source)
    try {
      // The level the arithmetic gets wrong: the last sequence, a bin out for
      // each part-bin floored before it.
      const listed = junctionCandidates(
        mc.chromnames.map((name, id) => [name, mc.coords.contigLengths[id]] as const),
        mc.binsize,
      )
      const last = listed.find((one) => one.name === 'Mpneumo')
      expect(last?.from).not.toBe(mc.contigExtent('Mpneumo')[0])

      const run = await detect(mc)
      const expected = await oracle(mc)
      expect(Object.keys(expected).length).toBeGreaterThan(0)
      expect(Object.keys(run.scores ?? {}).sort()).toEqual(Object.keys(expected).sort())
      for (const [name, score] of Object.entries(expected)) expect(run.scores?.[name]).toBeCloseTo(score, 9)
      // Its head read from the file's first bin of it, not the arithmetic's.
      const [from] = mc.contigExtent('Mpneumo')
      expect(run.rows).toContainEqual([from, from + 2 * JUNCTION_BINS])
      expect(run.rows).not.toContainEqual([last?.from, (last?.from ?? 0) + 2 * JUNCTION_BINS])
    } finally {
      mc.close()
    }
  })

  it('passes over a sequence the reader cannot place, and measures the rest', async () => {
    const source = await LocalFileSource.fromPath(DEMO)
    await source.mount()
    const mc = await MetaCooler.open(URI, source)
    try {
      const run = await detect(mc, ['XI'])
      const expected = await oracle(mc)
      delete expected['XI']
      expect(run.scores).not.toBeNull()
      expect(Object.keys(run.scores ?? {}).sort()).toEqual(Object.keys(expected).sort())
    } finally {
      mc.close()
    }
  })
})
