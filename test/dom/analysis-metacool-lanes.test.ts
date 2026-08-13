// @vitest-environment jsdom
/**
 * Where a computed result goes on a file that has a store and no worker.
 *
 * A new state, and one §8.5 never had to describe: since §8.12 a `.metacool`
 * has an annotation **store**, a placement model and a card — for its own
 * metadata columns, which are drawn from tables the main thread is already
 * holding. It still has no annotation **worker**, because it loads no files.
 *
 * The two computed outputs need different halves of that, so they part company
 * here. A called interval set carries its coordinates on the entry, so a store
 * is all it needs and it becomes an overlay on the map. A profile's values live
 * in the annotations worker and a lane samples them from there, so without one
 * the row would be an empty strip under a drawer sentence pointing at it — and
 * the drawer keeps the profile and draws it itself, exactly as it did before
 * there was any store at all (§18.5).
 *
 * Pinned because the failure is silent in the worst way: the task runs, the
 * drawer says the numbers are on the Annotations panel, and the panel has a row
 * with nothing in it.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type {
  AnalysisContext,
  AnalysisFraming,
  AnalysisTask,
  ProfileOutput,
  TaskResult,
} from '@/analysis/types'
import type { BedGraphContig } from '@/analysis/write/bedgraph'
import { AnalysisWorkspace, type AnalysisWorkspaceHost } from '@/analysis/workspace'
import { FeatureBuilder } from '@/annotations/featureset'
import { AnnotationStore } from '@/annotations/store'
import type { AnnotationClient } from '@/annotations/worker/client'
import { setUpDom, type DomTeardown } from '../support/dom'

let teardown: DomTeardown

beforeEach(() => {
  teardown = setUpDom()
})

afterEach(() => {
  teardown()
})

const CONTIGS: BedGraphContig[] = [
  { name: 'NODE_1', startBin: 0, bins: 8, length: 8000 },
]

function framing(uri: string): AnalysisFraming {
  return {
    uri,
    label: 'the whole metagenome at 1 kb',
    binsize: 1000,
    binsPerCell: 1,
    rows: [0, 8],
    cols: [0, 8],
    balance: false,
    value: 'count',
    normalise: null,
    level: 'bin',
  }
}

function context(uri: string): AnalysisContext {
  return {
    uri,
    layout: 'metacool',
    hasMap: true,
    hasGenomes: true,
    hasWeights: false,
    scoreColumns: [],
    binsize: 1000,
    nBins: 8,
    contigs: CONTIGS.map((contig) => ({ ...contig, genome: 0 })),
    genomes: [{ name: 'MAG_1', extent: [0, 8], contigs: 1 }],
    entries: [],
    framing: framing(uri),
    blockLoaded: false,
    blockBytes: 0,
  }
}

const TASK = { id: 'coverage', title: 'Coverage and marginals' } as unknown as AnalysisTask

/**
 * The seam the runner calls when a task finishes.
 *
 * Reached through a cast because it is private and its only caller is the
 * runner the workspace builds for itself — and standing a real runner up here
 * would be standing up a task, a worker and a block to test one branch about
 * where an output goes. The cast is to the *shape being called*, so a change to
 * the signature still fails the build (`test/unit/transpose.test.ts` reaches an
 * internal the same way).
 */
function finish(workspace: AnalysisWorkspace, result: TaskResult): void {
  ;(
    workspace as unknown as {
      adopt(task: AnalysisTask, result: TaskResult, on: { map: string }): void
    }
  ).adopt(TASK, result, { map: 'lead' })
}

function profile(): ProfileOutput {
  return {
    kind: 'profile',
    id: 'coverage:total',
    label: 'coverage',
    values: Float32Array.from([1, 2, 3, 4, 5, 6, 7, 8]),
    extent: [0, 8],
    binsize: 1000,
    unit: '',
  }
}

function result(withIntervals: boolean): TaskResult {
  const features = new FeatureBuilder()
  features.add('NODE_1', 1000, 2000, { name: 'boundary' })
  return {
    outputs: [
      profile(),
      ...(withIntervals
        ? [
            {
              kind: 'intervals' as const,
              id: 'coverage:calls',
              label: 'boundaries',
              payload: { kind: 'features' as const, data: features.finish() },
            },
          ]
        : []),
    ],
    provenance: {
      task: 'coverage',
      taskVersion: 1,
      params: {},
      framing: framing('gut.metacool'),
      createdAt: '2026-08-13T00:00:00Z',
      app: 'test',
    },
  } as unknown as TaskResult
}

/** A workspace with a store, and with or without an annotations worker. */
function bench(worker: boolean): { workspace: AnalysisWorkspace; store: AnnotationStore } {
  const store = new AnnotationStore(`metacool|${Math.random()}`, { persist: false })
  const host: AnalysisWorkspaceHost = {
    source: () => null,
    context: () => context('gut.metacool'),
    framing: () => framing('gut.metacool'),
    block: () => null,
    store: () => store,
    // The whole of the difference: a metacool has no annotation worker (§8.5).
    annotations: () =>
      worker
        ? ({ request: () => Promise.resolve({}), drop: () => {} } as unknown as AnnotationClient)
        : null,
    contigs: () => CONTIGS,
    carried: () => [],
    changed: () => {},
  }
  return { workspace: new AnalysisWorkspace(host), store }
}

describe('a profile computed on a file with no annotation worker', () => {
  it('is not filed as a row that could never draw', () => {
    const { workspace, store } = bench(false)
    finish(workspace, result(false))
    expect(store.entries.filter((entry) => entry.kind === 'track')).toHaveLength(0)
  })

  it('is filed as a row when there is a worker to hold its values', () => {
    const { workspace, store } = bench(true)
    finish(workspace, result(false))
    const rows = store.entries.filter((entry) => entry.kind === 'track')
    expect(rows).toHaveLength(1)
    expect(rows[0].status).toBe('ready')
  })
})

describe('a called interval set on the same file', () => {
  it('does become an overlay, because its coordinates are on the entry', () => {
    // The half a metacool *can* draw: an overlay is read off the entry's own
    // payload, so it needs the store and nothing else.
    const { workspace, store } = bench(false)
    finish(workspace, result(true))
    const overlays = store.entries.filter((entry) => entry.card === 'overlay')
    expect(overlays).toHaveLength(1)
    expect(overlays[0].payload?.kind).toBe('features')
  })
})
