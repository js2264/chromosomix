/**
 * The two structure tasks through their runners (§25.6), on a map whose
 * contacts fall with distance along a straight-line model — so the model
 * and the map agree by construction, and the tracks are what the geometry
 * says.
 */

import { describe, expect, it } from 'vitest'

import { runReconstruct, runSpatialTracks, runStructureMap } from '@/analysis/run/structure'
import type { JobContext } from '@/analysis/job'
import type { AnalysisFraming, CurveOutput, IntervalsOutput, MatrixOutput, Params, ProfileOutput, TableOutput } from '@/analysis/types'
import { RECONSTRUCT_TASK, SPATIAL_TRACKS_TASK, STRUCTURE_MAP_TASK } from '@/analysis/tasks/structure'
import { parseG3d } from '@/annotations/g3d'

const BINSIZE = 10000
const BINS = 20

const FRAMING: AnalysisFraming = {
  uri: 'test.cool',
  label: 'whole file',
  binsize: BINSIZE,
  binsPerCell: 1,
  rows: [0, BINS],
  cols: [0, BINS],
  balance: false,
  value: '',
  normalise: null,
  level: 'bin',
}

/** A straight chain: one bead per bin, a unit apart. */
const MODEL = Array.from({ length: BINS }, (_, i) => `I ${i * BINSIZE} ${i} 0 0`).join('\n')

function job(params: Params, notes: string[] = []): JobContext {
  const mc = {
    nBins: BINS,
    nContigs: 1,
    binsize: BINSIZE,
    hasGenomes: false,
    contigGenomeIds: new Int32Array(1),
    chromnames: ['I'],
    chromsizes: new Map([['I', BINS * BINSIZE]]),
    contigExtent: () => [0, BINS] as [number, number],
    names: { find: () => null },
    matrix: async (query: { rows: [number, number]; cols: [number, number] }) => {
      const nrows = query.rows[1] - query.rows[0]
      const ncols = query.cols[1] - query.cols[0]
      const values = new Float32Array(nrows * ncols)
      for (let r = 0; r < nrows; r++) {
        for (let c = 0; c < ncols; c++) {
          values[r * ncols + c] = 100 / (1 + Math.abs(query.rows[0] + r - (query.cols[0] + c)))
        }
      }
      return { values, nrows, ncols, rowExtent: [...query.rows] as [number, number], colExtent: [...query.cols] as [number, number] }
    },
  }
  return {
    mc: mc as unknown as JobContext['mc'],
    params,
    framing: FRAMING,
    // Filled the way the runner fills it: only for a chosen row.
    inputs: { features: params.structure === undefined ? {} : { structure: parseG3d(MODEL) }, labels: { s1: 'model.g3d' } },
    cancelled: () => false,
    throwIfCancelled: () => {},
    breathe: async () => {},
    progress: () => {},
    note: (text: string) => {
      notes.push(text)
    },
    toBp: (bins: number) => bins * BINSIZE,
    toBins: (bp: number) => bp / BINSIZE,
  } as unknown as JobContext
}

describe('model versus map', () => {
  it('is listed under map, waiting for a map and then for a structure', () => {
    expect(STRUCTURE_MAP_TASK.group).toBe('map')
    const base = { hasMap: false, entries: [] } as never
    expect(STRUCTURE_MAP_TASK.availability(base).state).toBe('waiting')
    const withMap = { hasMap: true, entries: [] } as never
    expect(STRUCTURE_MAP_TASK.availability(withMap)).toMatchObject({ state: 'waiting', needs: expect.stringMatching(/structure/) })
    const ready = { hasMap: true, entries: [{ kind: 'structure', status: 'ready' }] } as never
    expect(STRUCTURE_MAP_TASK.availability(ready).state).toBe('ready')
    expect(SPATIAL_TRACKS_TASK.availability(ready).state).toBe('ready')
  })

  it('draws the distances and the predicted contacts, the two curves, and a table that agrees', async () => {
    const outputs = await runStructureMap(job({ structure: 's1', alpha: 3 }))
    const matrices = outputs.filter((o): o is MatrixOutput => o.kind === 'matrix')
    expect(matrices.map((m) => m.id)).toEqual(['structure-distance--1', 'structure-predicted--1'])
    expect(matrices[0]?.values[0 * BINS + 5]).toBeCloseTo(5)
    expect(matrices[1]?.values[0 * BINS + 2]).toBeCloseTo(1 / 8)
    const curves = outputs.filter((o): o is CurveOutput => o.kind === 'curve')
    expect(curves.map((c) => c.id)).toEqual(['structure-dvs--1', 'structure-dvs-slope--1', 'structure-ps--1'])
    // A straight chain's distance grows linearly with separation: slope 1.
    const slope = curves[1]?.series[0]
    expect(slope?.y[Math.floor((slope.y.length) / 2)]).toBeCloseTo(1, 1)
    const table = outputs.find((o): o is TableOutput => o.kind === 'table')
    expect(table?.rows).toHaveLength(1)
    expect(table?.rows[0]?.sequence).toBe('I')
    expect(table?.rows[0]?.bins).toBe(BINS)
    expect(table?.rows[0]?.rho).toBeCloseTo(1)
  })

  it('says so when no structure was chosen, or when the names do not meet', async () => {
    const notes: string[] = []
    expect(await runStructureMap(job({}, notes))).toEqual([])
    expect(notes[0]).toMatch(/No structure was chosen/)
    const other: string[] = []
    const stranger = job({ structure: 's1' }, other)
    ;(stranger.inputs as { features: Record<string, unknown> }).features.structure = parseG3d('chrZ 0 0 0 0\nchrZ 10000 1 0 0')
    expect(await runStructureMap(stranger)).toEqual([])
    expect(other[0]).toMatch(/share no sequence/)
  })
})

describe('spatial tracks', () => {
  it('makes the radial, compaction and distance tracks on the map’s bins', async () => {
    const outputs = await runSpatialTracks(job({ structure: 's1', locus: 'I:1-10,000', window: 1 }))
    const profiles = outputs.filter((o): o is ProfileOutput => o.kind === 'profile')
    expect(profiles.map((p) => p.id)).toEqual(['structure-radial--1', 'structure-compaction--1', 'structure-distance--1'])
    const radial = profiles[0]
    expect(radial?.values).toHaveLength(BINS)
    expect(radial?.binsize).toBe(BINSIZE)
    // The centre of a straight chain of 20 is at 9.5: the ends are 9.5 away.
    expect(radial?.values[0]).toBeCloseTo(9.5)
    expect(radial?.values[10]).toBeCloseTo(0.5)
    expect(profiles[1]?.values[5]).toBeCloseTo(1)
    // Distance to the first bead grows one unit a bin.
    expect(profiles[2]?.values[0]).toBeCloseTo(0)
    expect(profiles[2]?.values[7]).toBeCloseTo(7)
    expect(profiles[2]?.label).toMatch(/Distance to I:1-10,000/)
  })

  it('leaves the distance track out, and says so, for a locus the model has no bead at', async () => {
    const notes: string[] = []
    const outputs = await runSpatialTracks(job({ structure: 's1', locus: 'II:1-100' }, notes))
    expect(outputs.map((o) => o.id)).toEqual(['structure-radial--1', 'structure-compaction--1'])
    expect(notes[0]).toMatch(/No bead of the model lies at II:1-100/)
  })
})

describe('model from the map', () => {
  /** A job over the block a view holds: `cells` pooled bins to a cell. */
  function blockJob(params: Params, notes: string[], cells = 1, balance = false): JobContext {
    const base = job(params, notes)
    const n = Math.ceil(BINS / cells)
    const values = new Float32Array(n * n)
    for (let r = 0; r < n; r++) {
      for (let c = 0; c < n; c++) values[r * n + c] = r === c ? 0 : 100 / (1 + Math.abs(r - c))
    }
    const framing = { ...FRAMING, binsPerCell: cells, balance }
    const block = { nrows: n, ncols: n, values, rowExtent: [0, BINS], colExtent: [0, BINS], binsPerCell: cells }
    const mc = base.mc as unknown as Record<string, unknown>
    mc['nContigs'] = 1
    mc['hasContig'] = (name: string) => name === 'I'
    mc['contigId'] = () => 0
    return { ...base, framing, inputs: { ...base.inputs, block } } as unknown as JobContext
  }

  it('is listed under map and needs only a map', () => {
    expect(RECONSTRUCT_TASK.group).toBe('map')
    expect(RECONSTRUCT_TASK.availability({ hasMap: false, entries: [] } as never).state).toBe('waiting')
    expect(RECONSTRUCT_TASK.availability({ hasMap: true, entries: [] } as never).state).toBe('ready')
  })

  it('prices the block as drawn, and refuses one with more beads than it solves', () => {
    const context = {
      framing: { ...FRAMING, rows: [0, 6000], cols: [0, 6000], binsPerCell: 2 },
      contigs: [],
      blockLoaded: true,
    } as never
    const estimate = RECONSTRUCT_TASK.estimate(context, {})
    expect(estimate.refusal).toMatch(/3,000 beads/)
    const coarser = { ...(context as object), framing: { ...FRAMING, rows: [0, 6000], cols: [0, 6000], binsPerCell: 4 } } as never
    expect(RECONSTRUCT_TASK.estimate(coarser, {}).refusal).toBeUndefined()
    expect(RECONSTRUCT_TASK.estimate(coarser, {}).note).toMatch(/1,500 beads/)
  })

  it('makes a structure row from the block, one bead per cell, that orders the pairs as the map does', async () => {
    const notes: string[] = []
    const outputs = await runReconstruct(blockJob({ alpha: 3, iterations: 100 }, notes))
    const model = outputs.find((o): o is IntervalsOutput => o.kind === 'intervals')
    expect(model).toBeDefined()
    expect(model?.entryKind).toBe('structure')
    expect(model?.payload.kind).toBe('features')
    if (model === undefined || model.payload.kind !== 'features') return
    const set = model.payload.data
    expect(set.length).toBe(BINS)
    expect(set.model).toBeDefined()
    expect(set.model?.width).toBe(BINSIZE)
    expect(set.contigs).toEqual(['I'])
    expect(set.start[0]).toBe(0)
    expect(set.end[0]).toBe(BINSIZE)
    expect(set.end[BINS - 1]).toBe(BINS * BINSIZE)
    // The map falls as 1/(1+s): the model's distances rise with separation.
    const m = set.model as NonNullable<typeof set.model>
    const d = (i: number, j: number): number => Math.hypot(m.x[i] - m.x[j], m.y[i] - m.y[j], m.z[i] - m.z[j])
    expect(d(0, 1)).toBeLessThan(d(0, 5))
    expect(d(0, 5)).toBeLessThan(d(0, 19))
    const table = outputs.find((o): o is TableOutput => o.kind === 'table')
    // 1/(1+s) read as (1+s)^(1/3) is a chain no three axes hold exactly, and
    // weighting by the count puts the fit where the counts are — the near
    // diagonal — so the rank agreement over *every* pair is good rather than
    // perfect. Every counted pair weighed alike orders the far pairs better
    // and the near ones worse.
    const rho = table?.rows.find((row) => String(row.what).startsWith('Spearman'))?.value
    expect(Number(rho)).toBeGreaterThan(0.75)
    expect(table?.rows.find((row) => row.what === 'Pairs weighted by')?.value).toBe('the contact count')
    expect(notes).toEqual([])
    const equal = await runReconstruct(blockJob({ alpha: 3, iterations: 100, weights: 'equal' }, []))
    const equalTable = equal.find((o): o is TableOutput => o.kind === 'table')
    expect(Number(equalTable?.rows.find((row) => String(row.what).startsWith('Spearman'))?.value)).toBeGreaterThan(0.85)
    expect(equalTable?.rows.find((row) => row.what === 'Pairs weighted by')?.value).toMatch(/alike/)
  })

  it('takes the block as drawn: pooled cells make wider beads', async () => {
    const outputs = await runReconstruct(blockJob({ alpha: 3, iterations: 20 }, [], 2))
    const model = outputs.find((o): o is IntervalsOutput => o.kind === 'intervals')
    if (model === undefined || model.payload.kind !== 'features') throw new Error('no model')
    expect(model.payload.data.length).toBe(BINS / 2)
    expect(model.payload.data.model?.width).toBe(2 * BINSIZE)
    expect(model.payload.data.end[0]).toBe(2 * BINSIZE)
  })

  it('reads the square itself when the block was balanced the other way', async () => {
    const notes: string[] = []
    const outputs = await runReconstruct(blockJob({ alpha: 3, iterations: 20, balance: true }, notes, 2, false))
    const table = outputs.find((o): o is TableOutput => o.kind === 'table')
    expect(table?.rows[0]?.value).toMatch(/read at the file/)
    const model = outputs.find((o): o is IntervalsOutput => o.kind === 'intervals')
    if (model === undefined || model.payload.kind !== 'features') throw new Error('no model')
    // Read at the file's own bin size, so one bead per bin again.
    expect(model.payload.data.length).toBe(BINS)
  })

  it('names a sequence the file lacks rather than modelling nothing', async () => {
    const notes: string[] = []
    const outputs = await runReconstruct(blockJob({ region: 'chrZ' }, notes))
    expect(outputs).toEqual([])
    expect(notes[0]).toMatch(/no sequence called chrZ/)
  })

  it('restricts to a typed range of the sequence', async () => {
    const outputs = await runReconstruct(blockJob({ region: 'I:0-50000', iterations: 10 }, []))
    const model = outputs.find((o): o is IntervalsOutput => o.kind === 'intervals')
    if (model === undefined || model.payload.kind !== 'features') throw new Error('no model')
    expect(model.payload.data.length).toBe(5)
    expect(model.label).toBe('3D model · I:0-50000')
  })

  it('leaves a bead with no counted pair out, and says so', async () => {
    const notes: string[] = []
    const held = blockJob({ iterations: 10 }, notes)
    const block = (held.inputs as { block: { values: Float32Array; nrows: number } }).block
    const n = block.nrows
    for (let c = 0; c < n; c++) {
      block.values[3 * n + c] = 0
      block.values[c * n + 3] = 0
    }
    const outputs = await runReconstruct(held)
    const model = outputs.find((o): o is IntervalsOutput => o.kind === 'intervals')
    if (model === undefined || model.payload.kind !== 'features') throw new Error('no model')
    expect(model.payload.data.length).toBe(BINS - 1)
    expect(notes.some((note) => /1 of 20 cells had no counted pair/.test(note))).toBe(true)
  })
})
