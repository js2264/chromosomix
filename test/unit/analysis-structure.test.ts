/**
 * The two structure tasks through their runners (§25.6), on a map whose
 * contacts fall with distance along a straight-line model — so the model
 * and the map agree by construction, and the tracks are what the geometry
 * says.
 */

import { describe, expect, it } from 'vitest'

import { runSpatialTracks, runStructureMap } from '@/analysis/run/structure'
import type { JobContext } from '@/analysis/job'
import type { AnalysisFraming, CurveOutput, MatrixOutput, Params, ProfileOutput, TableOutput } from '@/analysis/types'
import { SPATIAL_TRACKS_TASK, STRUCTURE_MAP_TASK } from '@/analysis/tasks/structure'
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
