// @vitest-environment jsdom
/**
 * Going back to a figure a second press of Run used to destroy.
 *
 * The runner keeps the results now (`analysis-runner`); this is the control over
 * them, and what is worth pinning is the part a reader touches. It must not
 * exist at all until a task has been run twice — a stepper over one thing is
 * furniture — the words on it must be about *time* rather than about left and
 * right, and stepping must actually change the figures rather than only lighting
 * a button, which is the way this sort of control usually fails.
 */

import { beforeEach, describe, expect, it } from 'vitest'

import { AnalysisDrawer } from '@/ui/AnalysisDrawer'
import type { AnalysisRunner, RunTarget } from '@/analysis/runner'
import type {
  AnalysisContext,
  AnalysisFraming,
  CurveOutput,
  Params,
  TaskResult,
} from '@/analysis/types'

const FRAMING: AnalysisFraming = {
  uri: 'a.mcool',
  rows: [0, 100],
  cols: [0, 100],
  binsize: 1000,
  binsPerCell: 1,
  balance: false,
  value: 'count',
  normalise: null,
  level: 'bin',
  label: 'chrI at 1 kb',
}

const CONTEXT = {
  uri: 'a.mcool',
  layout: 'mcool',
  binsize: 1000,
  nBins: 100,
  hasGenomes: false,
  hasWeights: false,
  scoreColumns: ['count'],
  contigs: [{ name: 'chrI', length: 100_000, startBin: 0, bins: 100, id: 0 }],
  genomes: [],
  entries: [],
  framing: FRAMING,
  blockLoaded: false,
  blockBytes: 0,
} as unknown as AnalysisContext

const TASK_ID = 'apa'

const TASK = {
  id: TASK_ID,
  title: 'Aggregate peak analysis',
  group: 'map',
  venue: 'reader',
  params: [{ kind: 'number', key: 'window', label: 'Half-width', default: 12 }],
  availability: () => ({ state: 'ready' }),
  estimate: () => null,
} as never

function curve(label: string): CurveOutput {
  return {
    kind: 'curve',
    id: 'spectrum',
    label,
    series: [{ name: 'calls', x: Float64Array.from([1, 2]), y: Float64Array.from([3, 4]) }],
    xLabel: 'x',
    yLabel: 'y',
    xScale: 'linear',
    yScale: 'linear',
  }
}

/** One run, as the worker leaves it: a figure, its parameters and its clock. */
function run(label: string, params: Params, at: string): TaskResult {
  return {
    provenance: {
      task: TASK_ID,
      taskVersion: 1,
      params,
      framing: FRAMING,
      createdAt: at,
      app: 'test',
    },
    outputs: [curve(label)],
    notes: [],
    ms: 12,
  } as unknown as TaskResult
}

function targetOf(map: string, label: string): RunTarget {
  return { map, uri: `${map}.mcool`, label } as RunTarget
}

/** A runner holding a history of one map's runs, newest first. */
function runnerWith(runs: TaskResult[]): AnalysisRunner {
  const entries = runs.length === 0 ? [] : [{ target: targetOf('lead', 'rep1'), result: runs[0] }]
  return {
    subscribe: () => () => {},
    resultOf: (taskId: string) => (taskId === TASK_ID ? (runs[0] ?? null) : null),
    resultsFor: (taskId: string) => (taskId === TASK_ID ? entries : []),
    runsOf: (taskId: string) => (taskId === TASK_ID ? runs : []),
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

function open(runs: TaskResult[]): AnalysisDrawer {
  const drawer = new AnalysisDrawer({
    runner: runnerWith(runs),
    context: () => CONTEXT,
    framing: () => FRAMING,
    onClose: () => {},
    hasLanes: () => false,
    writeProfile: () => Promise.resolve(),
  })
  document.body.appendChild(drawer.el)
  drawer.show(TASK)
  return drawer
}

const stepper = (drawer: AnalysisDrawer): HTMLElement | null =>
  drawer.el.querySelector('.analysis-runs')

const buttonNamed = (drawer: AnalysisDrawer, text: string): HTMLButtonElement | undefined =>
  [...(stepper(drawer)?.querySelectorAll('button') ?? [])].find(
    (node) => node.textContent === text,
  )

const titles = (drawer: AnalysisDrawer): string[] =>
  [...drawer.el.querySelectorAll('.analysis-figure-title')].map((node) => node.textContent ?? '')

const click = (node: Element | null | undefined): void => {
  ;(node as HTMLElement | undefined)?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
}

beforeEach(() => {
  document.body.replaceChildren()
})

const NEWEST = run('window 20', { window: 20 }, '2026-08-12T10:05:00Z')
const MIDDLE = run('window 12', { window: 12 }, '2026-08-12T10:03:00Z')
const OLDEST = run('window 4', { window: 4 }, '2026-08-12T10:01:00Z')

describe('a task that has run once', () => {
  it('offers no stepper, because there is nothing to step to', () => {
    const drawer = open([NEWEST])
    expect(stepper(drawer)?.classList.contains('hidden')).toBe(true)
    drawer.destroy()
  })

  it('and none at all before it has run', () => {
    const drawer = open([])
    expect(stepper(drawer)?.classList.contains('hidden')).toBe(true)
    drawer.destroy()
  })
})

describe('a task that has run three times', () => {
  it('opens on the latest, and says so', () => {
    const drawer = open([NEWEST, MIDDLE, OLDEST])
    expect(stepper(drawer)?.classList.contains('hidden')).toBe(false)
    expect(titles(drawer)).toEqual(['window 20'])
    expect(stepper(drawer)?.querySelector('.analysis-run-at')?.textContent).toBe(
      'latest of 3 runs',
    )
    drawer.destroy()
  })

  it('names its buttons for time rather than for direction', () => {
    const drawer = open([NEWEST, MIDDLE, OLDEST])
    const words = [...(stepper(drawer)?.querySelectorAll('button') ?? [])].map(
      (node) => node.textContent,
    )
    expect(words).toEqual(['older', 'newer', 'latest'])
    drawer.destroy()
  })

  it('cannot step past either end', () => {
    const drawer = open([NEWEST, MIDDLE, OLDEST])
    expect(buttonNamed(drawer, 'newer')?.disabled).toBe(true)
    expect(buttonNamed(drawer, 'latest')?.disabled).toBe(true)
    expect(buttonNamed(drawer, 'older')?.disabled).toBe(false)
    click(buttonNamed(drawer, 'older'))
    click(buttonNamed(drawer, 'older'))
    expect(buttonNamed(drawer, 'older')?.disabled).toBe(true)
    drawer.destroy()
  })

  it('draws the older run’s own figures', () => {
    const drawer = open([NEWEST, MIDDLE, OLDEST])
    click(buttonNamed(drawer, 'older'))
    expect(titles(drawer)).toEqual(['window 12'])
    click(buttonNamed(drawer, 'older'))
    expect(titles(drawer)).toEqual(['window 4'])
    drawer.destroy()
  })

  it('counts from the oldest, so “run 1” is the first one made', () => {
    const drawer = open([NEWEST, MIDDLE, OLDEST])
    click(buttonNamed(drawer, 'older'))
    expect(stepper(drawer)?.querySelector('.analysis-run-at')?.textContent).toContain('run 2 of 3')
    click(buttonNamed(drawer, 'older'))
    expect(stepper(drawer)?.querySelector('.analysis-run-at')?.textContent).toContain('run 1 of 3')
    drawer.destroy()
  })

  it('says in its tooltip which parameter the two runs differ in', () => {
    const drawer = open([NEWEST, MIDDLE, OLDEST])
    click(buttonNamed(drawer, 'older'))
    const title = stepper(drawer)?.querySelector('.analysis-run-at')?.getAttribute('title') ?? ''
    expect(title).toContain('Half-width: 12')
    expect(title).toContain('latest: 20')
    drawer.destroy()
  })

  it('comes back to the newest in one press', () => {
    const drawer = open([NEWEST, MIDDLE, OLDEST])
    click(buttonNamed(drawer, 'older'))
    click(buttonNamed(drawer, 'older'))
    click(buttonNamed(drawer, 'latest'))
    expect(titles(drawer)).toEqual(['window 20'])
    expect(buttonNamed(drawer, 'latest')?.disabled).toBe(true)
    drawer.destroy()
  })
})
