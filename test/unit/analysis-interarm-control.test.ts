/**
 * Inter-arm alignment's control column (§18.8).
 *
 * Beside the enrichment read over each sequence's distance decay, the task
 * gives the enrichment after detrend: the same cells over the decay along both
 * arms — the expectation the map's arms and Compartments divide by, which takes
 * the secondary diagonal into itself. On a circle whose arms are held together,
 * what has to hold:
 *
 * - one row per sequence, the control in the column after the enrichment;
 * - the measurement is what it always was, whatever the control's window;
 * - along both arms, with a window that can follow the arms, the enrichment the
 *   measurement found is gone — which is what the column is there to show.
 */

import { describe, expect, it } from 'vitest'

import { armOffsets } from '@/analysis/arms'
import type { JobContext } from '@/analysis/job'
import { runInterArm } from '@/analysis/run/interarm'
import type { AnalysisFraming, CurveOutput, Params, TableOutput, TaskOutput } from '@/analysis/types'

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

const FRAMING: AnalysisFraming = {
  uri: 'arms.cool',
  label: 'whole file',
  binsize: BINSIZE,
  binsPerCell: 1,
  rows: [0, N],
  cols: [0, N],
  balance: true,
  value: '',
  normalise: null,
  level: 'bin',
  circular: ['chr'],
  origins: { chr: 0 },
}

function job(params: Params): { job: JobContext; notes: string[] } {
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
    matrix: async () => {
      const values = new Float32Array(N * N)
      for (let r = 0; r < N; r++) for (let c = 0; c < N; c++) values[r * N + c] = valueAt(r, c)
      return { values, nrows: N, ncols: N, rowExtent: [0, N] as [number, number], colExtent: [0, N] as [number, number] }
    },
  }
  return {
    notes,
    job: {
      mc: mc as never,
      params: { sequences: ['chr'], band: 2, ...params },
      framing: FRAMING,
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

async function run(params: Params) {
  const { job: context, notes } = job(params)
  const outputs: TaskOutput[] = await runInterArm(context)
  const table = outputs.find((output): output is TableOutput => output.kind === 'table')!
  const curve = outputs.find((output): output is CurveOutput => output.kind === 'curve')!
  const curveOf = (id: string) =>
    outputs.find((output): output is CurveOutput => output.kind === 'curve' && output.id === id)!
  return { table, curve, curveOf, outputs, measured: table.rows[0], notes }
}

describe('inter-arm alignment’s control column', () => {
  it('gives each sequence one row, the control right after the enrichment', async () => {
    const { table } = await run({})
    expect(table.rows).toHaveLength(1)
    const keys = table.columns.map((column) => column.key)
    expect(keys.indexOf('detrended')).toBe(keys.indexOf('enrichment') + 1)
    expect(table.columns[keys.indexOf('detrended')].label).toBe('enrichment after detrend')
    for (const gone of ['expected', 'peak', 'score']) expect(keys).not.toContain(gone)
  })

  it('gives the enrichment as a fold: two to the curve’s mean from the origin out to the reach', async () => {
    const { curve, measured } = await run({})
    // The curve stays on log2, and the table is its linear reading.
    const logs = curve.series[0].y
    const last = Math.floor(Number(measured.reach) / BINSIZE)
    let total = 0
    let counted = 0
    for (let d = 0; d <= last; d++) {
      if (!Number.isFinite(logs[d])) continue
      total += logs[d]
      counted++
    }
    expect(Number(measured.enrichment)).toBeCloseTo(2 ** (total / counted), 9)
    // Enriched, on a scale where 1 is as expected.
    expect(Number(measured.enrichment)).toBeGreaterThan(1)
  })

  it('leaves the measurement as it was, whatever the control’s window', async () => {
    const wide = await run({ armWindow: 0 })
    const narrow = await run({ armWindow: 5 })
    for (const key of ['enrichment', 'reach']) expect(narrow.measured[key]).toBe(wide.measured[key])
    // The arms are held together, so the enrichment is there to find.
    expect(Number(wide.measured.enrichment)).toBeGreaterThan(Math.SQRT2)
    expect(Number(wide.measured.reach)).toBeGreaterThan(0)
    // The window is the control's, and it moves it.
    expect(narrow.measured.detrended).not.toBe(wide.measured.detrended)
  })

  it('divides the secondary diagonal out along both arms, leaving little of it', async () => {
    // A window that follows the position along the arms, as the map's does: the
    // whole sequence's (`0`) is one mean per distance along the arms, and keeps
    // the decay from the origin out to the terminus that this circle is built on.
    const { measured, notes } = await run({ armWindow: 5 })
    // On the log scale the folds are read on, so that a depletion counts as
    // far from 1 as the enrichment it mirrors.
    const log = (value: unknown) => Math.log2(Number(value))
    expect(Math.abs(log(measured.detrended))).toBeLessThan(0.1 * log(measured.enrichment))
    expect(notes.join(' ')).toMatch(/after detrend is the same cells over the decay along both arms, within 5 bins/)
  })
})

describe('inter-arm alignment’s curves', () => {
  it('draws the control as a curve of its own, on the measurement’s axis', async () => {
    const { curve, curveOf, outputs, measured } = await run({ armWindow: 5 })
    // The measurement is still the first curve, and the control comes right after it.
    const ids = outputs.map((output) => output.id)
    expect(ids.indexOf('interarm-detrended-curve')).toBe(ids.indexOf('interarm-curve') + 1)
    const control = curveOf('interarm-detrended-curve')
    expect(control.series.map((series) => series.name)).toEqual(['chr'])
    expect([...control.series[0].x]).toEqual([...curve.series[0].x])
    // One window for both, in whole log2 steps, which holds every value either has.
    expect(control.yDomain).toEqual(curve.yDomain)
    const [low, high] = curve.yDomain!
    expect(Number.isInteger(low) && Number.isInteger(high)).toBe(true)
    // In base pairs, which the axis spells as the app's units.
    expect(control.xLabel).toBe('Distance from the origin (bp)')
    for (const value of [...curve.series[0].y, ...control.series[0].y]) {
      if (Number.isFinite(value)) expect(value >= low && value <= high).toBe(true)
    }
    // Out to the reach, the control is near nothing where the measurement is enriched.
    const last = Math.floor(Number(measured.reach) / BINSIZE)
    const mean = (values: Float64Array) => {
      let total = 0
      let counted = 0
      for (let d = 0; d <= last; d++) {
        if (!Number.isFinite(values[d])) continue
        total += values[d]
        counted++
      }
      return total / counted
    }
    expect(Math.abs(mean(control.series[0].y))).toBeLessThan(0.1 * mean(curve.series[0].y))
  })

  it('gives the decay along the diagonal and along both arms, log-binned as P(s) is', async () => {
    const { curveOf, notes } = await run({})
    const decay = curveOf('interarm-decay')
    expect(decay.series.map((series) => series.name)).toEqual([
      'chr · along the diagonal',
      'chr · within an arm',
      'chr · across the arms',
    ])
    expect(decay.xScale).toBe('log')
    expect(decay.yScale).toBe('log')
    const [diagonal, within, across] = decay.series
    // From one bin away from each diagonal, in base pairs.
    for (const series of decay.series) expect(series.x[0]).toBe(BINSIZE)
    // One bin along the DNA is the same pair either way it is counted.
    expect(within.y[0]).toBeCloseTo(diagonal.y[0], 0)
    // The mirror images touch three times as often within two bins of the
    // secondary diagonal, and the curve across the arms falls away from it.
    expect(across.y[0] / across.y[2]).toBeGreaterThan(2)
    expect(notes.join(' ')).toMatch(/The decay curves are the two expectations/)
  })
})
