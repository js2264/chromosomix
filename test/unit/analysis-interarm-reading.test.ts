/**
 * Inter-arm alignment read **as the map is drawn** (§18.8).
 *
 * The task takes its reading from the picture — the balancing, whether the
 * counts are divided by an expectation and by which, and the scale — through
 * parameters the picture answers (`tasks/interarm.ts`). What has to hold:
 *
 * - with none of them said, which is a shell's case, it reads what it always
 *   did — the distance-decay O/E on `log2` — to the bit;
 * - the scale goes on the **means**: a band's mean read on `log2` is the `log2`
 *   of the same mean read linearly, bin for bin;
 * - read as counts it reports counts, on the scale asked for, and says so;
 * - divided along both arms the secondary diagonal is part of the expectation,
 *   so the enrichment it was built with is gone;
 * - the balancing is the view's: a raw picture is read raw.
 */

import { describe, expect, it } from 'vitest'

import { armOffsets } from '@/analysis/arms'
import type { JobContext } from '@/analysis/job'
import { runInterArm } from '@/analysis/run/interarm'
import type { AnalysisFraming, Params, ProfileOutput, TableOutput, TaskOutput } from '@/analysis/types'

const BINSIZE = 1000
const N = 160

/** A circle whose arms are held together: its mirror-image pairs touch three times as often. */
function valueAt(row: number, col: number): number {
  const u = armOffsets({ n: N, origin: 0, circular: true })
  const straight = Math.abs(row - col)
  const separation = Math.min(straight, N - straight)
  const opposite = u[row] >= 0 !== u[col] >= 0
  const mirrored = opposite && Math.abs(Math.abs(u[row]) - Math.abs(u[col])) <= 2
  return (400 / (1 + separation)) * (mirrored && separation > 6 ? 3 : 1) + ((row * 7 + col * 13) % 5) * 0.01
}

function framing(balance: boolean): AnalysisFraming {
  return {
    uri: 'arms.cool',
    label: 'whole file',
    binsize: BINSIZE,
    binsPerCell: 1,
    rows: [0, N],
    cols: [0, N],
    balance,
    value: '',
    normalise: null,
    level: 'bin',
    circular: ['chr'],
    origins: { chr: 0 },
  }
}

function job(params: Params, balance = true): { job: JobContext; reads: boolean[]; notes: string[] } {
  const reads: boolean[] = []
  const notes: string[] = []
  const mc = {
    nBins: N,
    nContigs: 1,
    binsize: BINSIZE,
    hasGenomes: false,
    contigGenomeIds: new Int32Array(1),
    chromnames: ['chr'],
    chromsizes: new Map([['chr', N * BINSIZE]]),
    contigExtent: () => [0, N] as [number, number],
    hasContig: (name: string) => name === 'chr',
    contigId: () => 0,
    names: { find: () => null },
    matrix: async (query: { rows: [number, number]; cols: [number, number]; balance: boolean }) => {
      reads.push(query.balance)
      const values = new Float32Array(N * N)
      for (let r = 0; r < N; r++) for (let c = 0; c < N; c++) values[r * N + c] = valueAt(r, c)
      return { values, nrows: N, ncols: N, rowExtent: [0, N] as [number, number], colExtent: [0, N] as [number, number] }
    },
  }
  return {
    reads,
    notes,
    job: {
      mc: mc as never,
      params: { sequences: ['chr'], band: 2, ...params },
      framing: framing(balance),
      inputs: {} as never,
      cancelled: () => false,
      throwIfCancelled: () => {},
      breathe: async () => {},
      progress: () => {},
      note: (text: string) => notes.push(text),
      toBp: (bins: number) => bins * BINSIZE,
      toBins: (bp: number) => Math.max(1, Math.round(bp / BINSIZE)),
    },
  }
}

async function run(params: Params, balance = true) {
  const { job: context, reads, notes } = job(params, balance)
  const outputs: TaskOutput[] = await runInterArm(context)
  const profile = outputs.find((output): output is ProfileOutput => output.kind === 'profile')!
  const table = outputs.find((output): output is TableOutput => output.kind === 'table')!
  return { profile, row: table.rows[0], table, reads, notes }
}

describe('inter-arm alignment, read as the map is drawn', () => {
  it('reads the decay’s O/E on log2 where nothing says otherwise, as a shell does', async () => {
    const said = await run({})
    const drawn = await run({ normalise: 'none', expected: 'decay', window: 50, transform: 'log2' })
    expect(said.profile.unit).toBe('log2')
    expect(said.profile.label).toBe('Inter-arm enrichment · O/E · log2 · ±2 bins')
    for (let i = 0; i < N; i++) expect(Object.is(said.profile.values[i], drawn.profile.values[i])).toBe(true)
    expect(said.row.score).toBe(drawn.row.score)
    // The arms are held together, so the enrichment is there to find.
    expect(Number(said.row.score)).toBeGreaterThan(0.5)
    expect(Number(said.row.reach)).toBeGreaterThan(0)
  })

  it('puts the scale on the band’s means, not on its cells', async () => {
    const onLog = await run({ expected: 'decay', transform: 'log2' })
    const linear = await run({ expected: 'decay', transform: 'none' })
    expect(linear.profile.unit).toBe('')
    let compared = 0
    for (let i = 0; i < N; i++) {
      const value = linear.profile.values[i]
      if (!(value > 0)) continue
      expect(onLog.profile.values[i]).toBeCloseTo(Math.log2(value), 5)
      compared++
    }
    expect(compared).toBeGreaterThan(N / 2)
    // No alignment reads as a ratio of one on a linear scale, and the hint says so.
    const hint = linear.table.columns.find((column) => column.key === 'score')?.hint ?? ''
    expect(hint).toMatch(/1\.000 is no alignment/)
  })

  it('reads the contacts themselves where the picture is not divided, on the picture’s scale', async () => {
    const counts = await run({ expected: 'none', transform: 'log10' })
    expect(counts.profile.unit).toBe('log10')
    expect(counts.profile.label).toBe('Inter-arm contacts · log10 · ±2 bins')
    // A logarithm of contacts is all under the lane's zero, so it is drawn as a line.
    expect(counts.profile.mode).toBe('line')
    // log10 of counts in the tens to hundreds.
    expect(Number(counts.row.score)).toBeGreaterThan(0.5)
    expect(Number(counts.row.score)).toBeLessThan(3)
    // Counts have no value that means *no alignment*, and the hint does not claim one.
    const hint = counts.table.columns.find((column) => column.key === 'score')?.hint ?? ''
    expect(hint).toMatch(/balanced contacts, log10, over the arms\.$/)
    expect(counts.notes.join(' ')).toMatch(/read as the map is drawn: balanced · contacts · log10/)
    // Read from the origin, since round the circle they rise again at the terminus.
    expect(Number(counts.row.reach)).toBeGreaterThan(0)
    expect(Number(counts.row.reach)).toBeLessThan(Number(counts.row.armLength))
  })

  it('divides the secondary diagonal out along both arms, leaving little of it', async () => {
    const decay = await run({ expected: 'decay', transform: 'log2' })
    // A window that follows the position along the arms, as the map's does: the
    // whole sequence's (`0`) is one mean per distance along the arms, and keeps
    // the decay from the origin out to the terminus that this circle is built on.
    const arms = await run({ expected: 'arms', window: 5, transform: 'log2' })
    expect(arms.profile.label).toBe('Inter-arm enrichment · O/E along the arms, 5 bins · log2 · ±2 bins')
    expect(Math.abs(Number(arms.row.score))).toBeLessThan(0.1 * Number(decay.row.score))
    expect(Number(arms.row.peak)).toBeLessThan(0.2 * Number(decay.row.peak))
    expect(arms.notes.join(' ')).toMatch(/secondary diagonal is part of the expectation/)
    // Nothing is left to follow outwards, so no reach is claimed for it.
    expect(Number.isNaN(Number(arms.row.reach))).toBe(true)
    const hint = (key: string) => arms.table.columns.find((column) => column.key === key)?.hint ?? ''
    expect(hint('reach')).toMatch(/^Not given along the arms/)
    expect(hint('score')).toMatch(/0 is as aligned as the arms’ own model\.$/)
    // A ratio straddles zero, and keeps the lane's own drawing.
    expect(arms.profile.mode).toBeUndefined()
  })

  it('reads the map balanced or raw as the view does, not as the file would', async () => {
    expect((await run({}, true)).reads).toEqual([true])
    expect((await run({}, false)).reads).toEqual([false])
  })

  it('normalises as the picture does', async () => {
    const plain = await run({ expected: 'none', transform: 'none' })
    const vc = await run({ normalise: 'vc', expected: 'none', transform: 'none' })
    expect(vc.profile.label).toBe('Inter-arm contacts · VC · linear · ±2 bins')
    // Linear counts are all over zero, and fill up from it as a coverage does.
    expect(vc.profile.mode).toBeUndefined()
    expect(vc.row.score).not.toBe(plain.row.score)
  })
})
