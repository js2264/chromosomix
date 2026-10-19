// @vitest-environment jsdom
/**
 * A computed lane on bins of its own (§18.8).
 *
 * Every task but one puts its values on the session's grid. Base composition
 * reads at the bin size it is given — the map's resolution unless changed, and
 * 10 kb in a 1D browser — and lays its lanes out over the same sequences cut at
 * that size. The lane is registered over that grid, and the file written over
 * it: over the session's instead, the second sequence would start at its 1 kb
 * offset in a 10 kb vector and take the first one's values.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type {
  AnalysisContext,
  AnalysisFraming,
  AnalysisTask,
  ProfileOutput,
  TaskResult,
} from '@/analysis/types'
import { gridAt } from '@/analysis/context'
import type { BedGraphContig } from '@/analysis/write/bedgraph'
import { AnalysisWorkspace, type AnalysisWorkspaceHost } from '@/analysis/workspace'
import { AnnotationStore } from '@/annotations/store'
import type { AnnotationClient } from '@/annotations/worker/client'
import type { BinVector } from '@/annotations/worker/binVector'
import { setUpDom, type DomTeardown } from '../support/dom'

let teardown: DomTeardown

beforeEach(() => {
  teardown = setUpDom()
})

afterEach(() => {
  teardown()
})

/** Two sequences on the session's 1 kb grid. */
const SESSION: BedGraphContig[] = [
  { name: 'chrI', startBin: 0, bins: 231, length: 230_218 },
  { name: 'chrII', startBin: 231, bins: 814, length: 813_184 },
]

function framing(): AnalysisFraming {
  return {
    uri: 'yeast.mcool::resolutions/1000',
    label: 'whole file at 1 kb',
    binsize: 1000,
    binsPerCell: 1,
    rows: [0, 1045],
    cols: [0, 1045],
    balance: false,
    value: 'count',
    normalise: null,
    level: 'bin',
  }
}

function context(): AnalysisContext {
  return {
    uri: 'yeast.mcool::resolutions/1000',
    layout: 'cool',
    hasMap: true,
    hasGenomes: false,
    hasWeights: false,
    scoreColumns: [],
    binsize: 1000,
    nBins: 1045,
    contigs: SESSION.map((contig) => ({ ...contig, genome: -1 })),
    genomes: null,
    entries: [],
    framing: framing(),
    blockLoaded: false,
    blockBytes: 0,
  }
}

const TASK = { id: 'composition', title: 'Base composition', params: [] } as unknown as AnalysisTask

/** The seam the runner calls when a task finishes, as `analysis-metacool-lanes` reaches it. */
function finish(workspace: AnalysisWorkspace, result: TaskResult): void {
  ;(
    workspace as unknown as {
      adopt(task: AnalysisTask, result: TaskResult, on: { map: string }): void
    }
  ).adopt(TASK, result, { map: 'lead' })
}

function lane(id: string, binsize: number): ProfileOutput {
  const bins = gridAt(SESSION, binsize).reduce((sum, contig) => sum + contig.bins, 0)
  return {
    kind: 'profile',
    id,
    label: id,
    values: new Float32Array(bins).fill(0.5),
    extent: [0, bins],
    binsize,
    unit: '',
  }
}

function bench(): { workspace: AnalysisWorkspace; registered: Array<[string, BinVector]> } {
  const store = new AnnotationStore(`own-grid|${Math.random()}`)
  store.clear()
  const registered: Array<[string, BinVector]> = []
  const client = {
    request: (message: { kind: string; entry: string; vector: BinVector }) => {
      if (message.kind === 'register') registered.push([message.entry, message.vector])
      return Promise.resolve({})
    },
    drop: () => {},
    destroy: () => {},
  } as unknown as AnnotationClient
  const host: AnalysisWorkspaceHost = {
    source: () => null,
    context,
    framing,
    block: () => null,
    store: () => store,
    annotations: () => client,
    contigs: () => SESSION,
    changed: () => {},
  }
  return { workspace: new AnalysisWorkspace(host), registered }
}

function result(outputs: ProfileOutput[]): TaskResult {
  return {
    outputs,
    provenance: {
      task: 'composition',
      taskVersion: 1,
      params: {},
      framing: framing(),
      createdAt: '2026-09-23T00:00:00Z',
      app: 'test',
    },
    notes: [],
    ms: 1,
  }
}

describe('a lane read at a bin size of its own', () => {
  it('cuts the grid at that size, each sequence from its first base', () => {
    expect(gridAt(SESSION, 10_000)).toEqual([
      { name: 'chrI', startBin: 0, bins: 24, length: 230_218 },
      { name: 'chrII', startBin: 24, bins: 82, length: 813_184 },
    ])
    expect(gridAt([{ name: 'empty', length: 0 }, ...SESSION], 1000)).toEqual(SESSION)
  })

  it('is registered over that grid, and one at the session’s size over the session’s', () => {
    const { workspace, registered } = bench()
    finish(workspace, result([lane('composition-gc', 10_000), lane('composition-gcskew', 1000)]))
    expect(registered).toHaveLength(2)
    const coarse = registered.find(([, vector]) => vector.binsize === 10_000)?.[1]
    expect(coarse?.contigs).toEqual(gridAt(SESSION, 10_000))
    expect(coarse?.values.length).toBe(106)
    const native = registered.find(([, vector]) => vector.binsize === 1000)?.[1]
    expect(native?.contigs).toEqual(SESSION)
    workspace.destroy()
  })

  it('carries that grid with it, for a file written later or at another resolution', () => {
    const { workspace } = bench()
    finish(workspace, result([lane('composition-gc', 10_000)]))
    const [row] = workspace.carry()
    expect(row.profile?.grid).toEqual(gridAt(SESSION, 10_000))
    workspace.destroy()
  })
})
