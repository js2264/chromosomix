/**
 * The two tasks that read a bacterial chromosome off its own sequence, run
 * against a genome built so their answers are known.
 *
 * A 200 kb circle whose forward strand is G-rich from 0 to 100 kb and C-rich
 * from 100 kb back round to 0 — replication from an origin at 0, a terminus at
 * 100 kb — with two parS sites planted beside the origin. The composition task
 * must see the skew change sign at both, on the map's own bins; the origin and
 * terminus task must put them there, say the parS step decided it, and hand
 * back loci named so the session can take the origin from them.
 */

import { describe, expect, it } from 'vitest'

import type { SequenceReader, TrackJobContext } from '@/analysis/job'
import { runComposition } from '@/analysis/run/composition'
import { runOriTer } from '@/analysis/run/oriter'
import type {
  AnalysisFraming,
  IntervalsOutput,
  Params,
  ProfileOutput,
  TableOutput,
  TaskOutput,
} from '@/analysis/types'

const LENGTH = 200_000
const PARS = 'TGTTCCACGTGGAACA'

/** A seeded genome: G over C on the first half of the circle, C over G on the second. */
function genome(): Uint8Array {
  let state = 12345
  const next = (): number => {
    state = (state * 1103515245 + 12345) % 2 ** 31
    return state / 2 ** 31
  }
  const out = new Uint8Array(LENGTH)
  for (let i = 0; i < LENGTH; i++) {
    const right = i < LENGTH / 2
    const u = next()
    const g = right ? 0.3 : 0.2
    const c = right ? 0.2 : 0.3
    out[i] = (u < g ? 'G' : u < g + c ? 'C' : u < g + c + 0.25 ? 'A' : 'T').charCodeAt(0)
  }
  for (const at of [1_000, 5_000]) {
    for (let k = 0; k < PARS.length; k++) out[at + k] = PARS.charCodeAt(k)
  }
  return out
}

const BASES = genome()

function reader(): SequenceReader {
  return { contigs: [{ name: 'chr', length: LENGTH }], bases: (name) => (name === 'chr' ? BASES : undefined) }
}

function framing(circular: boolean): AnalysisFraming {
  return {
    uri: 'toy.cool',
    label: 'a toy bacterium',
    binsize: 10_000,
    binsPerCell: 1,
    rows: [0, 20],
    cols: [0, 20],
    balance: false,
    value: '',
    normalise: null,
    level: 'bin',
    ...(circular ? { circular: ['chr'] } : {}),
  }
}

async function run(
  runner: (job: TrackJobContext) => Promise<TaskOutput[]>,
  params: Params,
  circular = true,
): Promise<{ outputs: TaskOutput[]; notes: string[] }> {
  const notes: string[] = []
  const job: TrackJobContext = {
    params: { sequence: 'fa', ...params },
    framing: framing(circular),
    inputs: { contigLengths: { chr: LENGTH } },
    cancelled: () => false,
    throwIfCancelled: () => {},
    progress: () => {},
    note: (text) => notes.push(text),
    sample: () => Promise.reject(new Error('no coverage track in this test')),
    lengthOf: () => LENGTH,
    residues: (entry) => (entry === 'fa' ? reader() : undefined),
  }
  return { outputs: await runner(job), notes }
}

function lane(outputs: TaskOutput[], id: string): ProfileOutput | undefined {
  return outputs.find((one): one is ProfileOutput => one.kind === 'profile' && one.id === id)
}

describe('base composition', () => {
  it('makes four lanes on the map’s own bins, the skew positive then negative', async () => {
    const { outputs } = await run(runComposition, {})
    const skew = lane(outputs, 'composition-gcskew')
    const cumulative = lane(outputs, 'composition-cumulative')
    expect(lane(outputs, 'composition-gc')?.values.length).toBe(20)
    expect(lane(outputs, 'composition-atskew')).toBeDefined()
    expect(skew?.binsize).toBe(10_000)
    expect(skew?.values[2]).toBeGreaterThan(0.1)
    expect(skew?.values[15]).toBeLessThan(-0.1)
    // The cumulative skew turns at the terminus, the tenth bin boundary.
    const values = Array.from(cumulative?.values ?? [])
    expect(values.indexOf(Math.max(...values))).toBe(9)
  })

  it('makes only the lanes ticked', async () => {
    const { outputs } = await run(runComposition, { gc: false, atSkew: false, cumulative: false })
    expect(outputs.map((one) => one.id)).toEqual(['composition-gcskew'])
  })
})

describe('the origin and terminus', () => {
  it('places them where the genome was built with them, by the parS step', async () => {
    const { outputs } = await run(runOriTer, { parSMismatches: 0 })
    const loci = outputs.find(
      (one): one is IntervalsOutput => one.kind === 'intervals' && one.id === 'oriter-loci',
    )
    expect(loci?.payload.kind).toBe('features')
    if (loci?.payload.kind !== 'features') return
    const set = loci.payload.data
    const at: Record<string, number> = {}
    for (let i = 0; i < set.length; i++) at[set.name?.[i] ?? ''] = (set.start[i] + set.end[i]) / 2
    const round = (x: number): number => Math.min(x, LENGTH - x)
    expect(round(at.ori)).toBeLessThan(6_000)
    expect(Math.abs(at.ter - LENGTH / 2)).toBeLessThan(6_000)

    const table = outputs.find((one): one is TableOutput => one.kind === 'table')
    expect(table?.rows[0]).toMatchObject({ sequence: 'chr', parS: 2, parSCluster: 2, topology: 'circular' })
    expect(String(table?.rows[0]?.rule)).toContain('parS')
    // Both planted parS sites, as their own set.
    const pars = outputs.find(
      (one): one is IntervalsOutput => one.kind === 'intervals' && one.id === 'oriter-pars',
    )
    expect(pars?.payload.kind === 'features' ? pars.payload.data.length : 0).toBe(2)
  })

  /**
   * The case the note is for: an origin at the first base, read as a line, is
   * split between the two ends — the cumulative skew's minimum is then either
   * end, and a call made from it cannot be trusted. Said, and the table says
   * what the sequence was read as.
   */
  it('says a linear reading splits an origin at the first base', async () => {
    const { outputs, notes } = await run(runOriTer, {}, false)
    expect(notes.some((note) => note.includes('read as linear'))).toBe(true)
    const table = outputs.find((one): one is TableOutput => one.kind === 'table')
    expect(table?.rows[0]?.topology).toBe('linear')
  })

  it('refuses a motif it cannot read with a note, and skips only that step', async () => {
    const { outputs, notes } = await run(runOriTer, { matS: 'XYZ' })
    expect(notes.some((note) => note.startsWith('matS:'))).toBe(true)
    expect(outputs.some((one) => one.id === 'oriter-loci')).toBe(true)
  })
})
