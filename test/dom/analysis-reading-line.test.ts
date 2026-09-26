// @vitest-environment jsdom
/**
 * The drawer's framing line, for a task that reads the map as it is drawn (§18.8).
 *
 * The framing names the score; the inter-arm alignment also reads what the
 * counts are divided by and the scale they are on, from the picture, with no
 * control to show it. So the line says it — before a run, what it will read the
 * map as; after one, what it did — and a result whose reading the picture has
 * since left is marked as having moved, as one whose window has is.
 */

import { beforeEach, describe, expect, it } from 'vitest'

import { INTERARM_TASK } from '@/analysis/tasks/interarm'
import type { AnalysisRunner, RunTarget } from '@/analysis/runner'
import type { AnalysisContext, AnalysisFraming, MapReading, TaskResult } from '@/analysis/types'
import { AnalysisDrawer } from '@/ui/AnalysisDrawer'

function framing(reading: MapReading): AnalysisFraming {
  return {
    uri: 'a.cool',
    rows: [0, 100],
    cols: [0, 100],
    binsize: 1000,
    binsPerCell: 1,
    balance: true,
    value: 'count',
    normalise: null,
    level: 'bin',
    label: 'chr at 1 kb · balanced',
    reading,
  }
}

function contextOf(frame: AnalysisFraming): AnalysisContext {
  return {
    uri: 'a.cool',
    layout: 'cool',
    binsize: 1000,
    nBins: 100,
    hasGenomes: false,
    hasWeights: true,
    hasMap: true,
    scoreColumns: ['count'],
    contigs: [{ name: 'chr', length: 100_000, startBin: 0, bins: 100, genome: -1 }],
    genomes: null,
    entries: [],
    framing: frame,
    blockLoaded: false,
    blockBytes: 0,
  } as unknown as AnalysisContext
}

function runnerWith(result: TaskResult | null): AnalysisRunner {
  const target = { map: 'lead', uri: 'a.cool', label: 'a' } as RunTarget
  const entries = result === null ? [] : [{ target, result }]
  return {
    subscribe: () => () => {},
    resultOf: () => result,
    resultsFor: () => entries,
    runsOf: () => (result === null ? [] : [result]),
    stateOf: () => ({ status: 'idle' }),
    run: () => {},
    runAll: () => {},
    targets: () => entries.map((entry) => entry.target),
    targetCount: () => entries.length,
    readyTargets: async () => entries.map((entry) => entry.target),
    target: () => entries[0]?.target ?? null,
    cancel: () => {},
  } as unknown as AnalysisRunner
}

/** A drawer on the inter-arm task, over a picture whose reading can be changed under it. */
function open(reading: MapReading, result: TaskResult | null = null) {
  let frame = framing(reading)
  const drawer = new AnalysisDrawer({
    runner: runnerWith(result),
    context: () => contextOf(frame),
    framing: () => frame,
    onClose: () => {},
    hasLanes: () => false,
    writeProfile: () => Promise.resolve(),
  })
  document.body.appendChild(drawer.el)
  drawer.show(INTERARM_TASK)
  return {
    drawer,
    line: () => drawer.el.querySelector('.analysis-framing')?.textContent ?? '',
    redraw: (next: MapReading) => {
      frame = framing(next)
      drawer.refresh()
    },
  }
}

const RAN: TaskResult = {
  provenance: {
    task: 'interarm',
    taskVersion: 2,
    params: { sequences: ['chr'], band: 2, normalise: 'none', expected: 'decay', window: 50, transform: 'log2' },
    framing: framing({ expected: 'decay', window: 0, transform: 'log2' }),
    createdAt: '2026-09-26T10:00:00Z',
    app: 'test',
  },
  outputs: [],
  notes: [],
  ms: 3,
} as unknown as TaskResult

beforeEach(() => {
  document.body.replaceChildren()
})

describe('the line over a task that reads the map as drawn', () => {
  it('says what it will read the map as', () => {
    const { line } = open({ expected: 'arms', window: 30, transform: 'log2' })
    expect(line()).toBe('will run on chr at 1 kb · balanced · O/E along the arms, 30 bins · log2')
  })

  it('follows the picture before a run', () => {
    const { line, redraw } = open({ expected: 'decay', window: 0, transform: 'log2' })
    redraw({ expected: 'none', window: 0, transform: 'log10' })
    expect(line()).toBe('will run on chr at 1 kb · balanced · contacts · log10')
  })

  it('says what a result read the map as, and that the picture has moved when it has', () => {
    const { line, redraw } = open({ expected: 'decay', window: 0, transform: 'log2' }, RAN)
    expect(line()).toBe('from chr at 1 kb · balanced · O/E · log2')
    redraw({ expected: 'decay', window: 0, transform: 'log10' })
    expect(line()).toBe('from chr at 1 kb · balanced · O/E · log2 — the view has moved since')
  })
})
