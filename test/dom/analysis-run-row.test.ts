// @vitest-environment jsdom
/**
 * The drawer's run row on a deck, for a task that reads a map and one that
 * reads only the tracks (§18.1, §18.4).
 *
 * A deck offers a map task two runs — `run on ★` for the starred map and
 * `run on all N maps` for every one — and a 1D task was offered the same two,
 * though it reads no map: the batch ran the same tracks once per map and filed
 * as many identical lanes, each named after a map it never read. What a task
 * that reads no map is offered instead is one plain `run`; its heading names the
 * tracks rather than the view, so a pan neither marks it stale nor offers to
 * *recompute here* the same answer; and a deck with no map starred, which stops
 * every task that reads a map, does not stop it.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { AnalysisRunner, RunTarget } from '@/analysis/runner'
import type { AnalysisContext, AnalysisFraming, AnalysisTask, TaskResult } from '@/analysis/types'
import { READY } from '@/analysis/types'
import { AnalysisDrawer } from '@/ui/AnalysisDrawer'
import { all, setUpDom, type DomTeardown } from '../support/dom'

let teardown: DomTeardown

beforeEach(() => {
  teardown = setUpDom()
})

afterEach(() => {
  teardown()
})

function framing(rows: [number, number] = [0, 8]): AnalysisFraming {
  return {
    uri: 'rep2.cool',
    label: `chr1:${rows[0] + 1}-${rows[1]} kb at 1 kb`,
    binsize: 1000,
    binsPerCell: 1,
    rows,
    cols: rows,
    balance: false,
    value: 'count',
    normalise: null,
    level: 'bin',
  }
}

/** The starred map's context — `rep2.cool`, the second map — unless named otherwise. */
const contextOf = (uri = 'rep2.cool'): AnalysisContext => ({
  uri,
  layout: 'cool',
  hasMap: true,
  hasGenomes: false,
  hasWeights: false,
  scoreColumns: [],
  binsize: 1000,
  nBins: 8,
  contigs: [],
  genomes: null,
  entries: [],
  framing: framing(),
  blockLoaded: false,
  blockBytes: 0,
}) as unknown as AnalysisContext

function task(over: Partial<AnalysisTask>): AnalysisTask {
  return {
    id: 'task',
    title: 'Task',
    blurb: '',
    group: '2d',
    venue: 'analysis',
    version: 1,
    availability: () => READY,
    params: [],
    outputs: ['curve'],
    // The file it is priced against, so the price says which context it was given.
    estimate: (context) => ({ class: 'free', requests: null, bytes: null, note: `priced on ${context.uri}` }),
    ...over,
  }
}

const PS = task({ id: 'expected', title: 'Contact probability P(s)' })
const METAPLOT = task({ id: 'metaplot', title: 'Metaplot', group: '1d', venue: 'annotations' })

/** Three maps, the star on the second. */
const DECK: RunTarget[] = [
  { map: 'lead', uri: 'lead.cool', label: 'lead.cool' },
  { map: 'p1', uri: 'rep2.cool', label: 'rep2.cool' },
  { map: 'p2', uri: 'rep3.cool', label: 'rep3.cool' },
]

function resultOf(taskId: string, framed: AnalysisFraming): TaskResult {
  return {
    outputs: [],
    notes: ['nothing to draw'],
    ms: 5,
    provenance: {
      task: taskId,
      taskVersion: 1,
      params: {},
      framing: framed,
      createdAt: '2026-10-18T10:00:00Z',
      app: 'test',
    },
  }
}

interface Bench {
  drawer: AnalysisDrawer
  runs: string[]
  batches: string[]
}

/**
 * The drawer over a runner that records what it was asked to run.
 *
 * @param held A result already in hand for the task, framed where the view was.
 * @param blocked The deck's refusal while no map is starred, or `null`.
 */
function open(
  shown: AnalysisTask,
  options: { held?: TaskResult; blocked?: string | null; view?: AnalysisFraming } = {},
): Bench {
  const runs: string[] = []
  const batches: string[] = []
  const held = options.held
  const runner = {
    subscribe: () => () => {},
    resultsFor: (taskId: string) =>
      held !== undefined && taskId === held.provenance.task ? [{ target: DECK[0], result: held }] : [],
    runsOf: (taskId: string) => (held !== undefined && taskId === held.provenance.task ? [held] : []),
    stateOf: () => ({ status: 'idle' }),
    run: (ran: AnalysisTask) => runs.push(ran.id),
    runAll: (ran: AnalysisTask) => batches.push(ran.id),
    targets: () => DECK,
    targetCount: () => DECK.length,
    readyTargets: async () => DECK,
    target: () => DECK[1],
    cancel: () => {},
  } as unknown as AnalysisRunner
  const drawer = new AnalysisDrawer({
    runner,
    // The session's own map for a task that reads none, as the session answers.
    context: (asked) => contextOf(asked?.venue === 'annotations' ? 'lead.cool' : 'rep2.cool'),
    framing: () => options.view ?? framing(),
    blocked: () => options.blocked ?? null,
    onClose: () => {},
    hasLanes: () => true,
    writeProfile: () => Promise.resolve(),
  })
  document.body.appendChild(drawer.el)
  drawer.show(shown)
  return { drawer, runs, batches }
}

function runRow(drawer: AnalysisDrawer): HTMLButtonElement[] {
  return all<HTMLButtonElement>(drawer.el, '.analysis-run button')
}

function runButton(drawer: AnalysisDrawer): HTMLButtonElement {
  const node = runRow(drawer).find((button) => /^run( on)?$/.test((button.textContent ?? '').trim()))
  if (node === undefined) throw new Error('no run button')
  return node
}

function batchButton(drawer: AnalysisDrawer): HTMLButtonElement {
  const node = runRow(drawer).find((button) => (button.textContent ?? '').startsWith('run on all'))
  if (node === undefined) throw new Error('no batch button')
  return node
}

const heading = (drawer: AnalysisDrawer): string =>
  drawer.el.querySelector('.analysis-framing')?.textContent ?? ''

const recompute = (drawer: AnalysisDrawer): HTMLButtonElement | undefined =>
  all<HTMLButtonElement>(drawer.el, '.analysis-drawer-head button').find(
    (button) => (button.textContent ?? '').trim() === 'recompute here',
  )

describe('a task that reads a map, on a deck', () => {
  it('runs on the star, or on every map', () => {
    const { drawer } = open(PS)
    expect(drawer.el.querySelector('.analysis-cost')?.textContent).toBe('priced on rep2.cool')
    expect((runButton(drawer).textContent ?? '').trim()).toBe('run on')
    expect(runButton(drawer).querySelector('svg.run-star')).not.toBeNull()
    expect(batchButton(drawer).classList.contains('hidden')).toBe(false)
    expect(batchButton(drawer).textContent).toBe('run on all 3 maps')
    drawer.destroy()
  })

  it('is refused while no map is starred', () => {
    const { drawer } = open(PS, { blocked: 'No map is starred.' })
    expect(runButton(drawer).disabled).toBe(true)
    expect(drawer.el.querySelector('.analysis-refusal')?.textContent).toBe('No map is starred.')
    drawer.destroy()
  })

  it('offers to recompute a result the view has moved away from', () => {
    const { drawer } = open(PS, { held: resultOf('expected', framing()), view: framing([2, 6]) })
    expect(heading(drawer)).toContain('the view has moved since')
    expect(recompute(drawer)?.classList.contains('hidden')).toBe(false)
    drawer.destroy()
  })
})

describe('a task that reads only the tracks, on a deck', () => {
  it('is one plain run, with no star on it and no batch beside it', () => {
    const { drawer } = open(METAPLOT)
    expect((runButton(drawer).textContent ?? '').trim()).toBe('run')
    expect(runButton(drawer).querySelector('svg')).toBeNull()
    expect(batchButton(drawer).classList.contains('hidden')).toBe(true)
    drawer.destroy()
  })

  it('is priced on the session’s own map, not the starred one', () => {
    const { drawer } = open(METAPLOT)
    expect(drawer.el.querySelector('.analysis-cost')?.textContent).toBe('priced on lead.cool')
    drawer.destroy()
  })

  it('says what it runs on, and that the star is nothing to it', () => {
    const { drawer } = open(METAPLOT)
    const title = runButton(drawer).title
    expect(title).toContain('the loaded tracks')
    expect(title).toContain('runs once')
    expect(title).not.toContain('rep2.cool')
    drawer.destroy()
  })

  it('runs once when pressed, never as a batch', () => {
    const { drawer, runs, batches } = open(METAPLOT)
    runButton(drawer).click()
    expect(runs).toEqual(['metaplot'])
    expect(batches).toEqual([])
    drawer.destroy()
  })

  it('names the tracks in its heading rather than the window on screen', () => {
    const { drawer } = open(METAPLOT)
    expect(heading(drawer)).toBe('reads the loaded tracks, not the map')
    drawer.destroy()
  })

  it('is not stale for a view that moved, so it offers nothing to recompute', () => {
    const { drawer } = open(METAPLOT, { held: resultOf('metaplot', framing()), view: framing([2, 6]) })
    expect(heading(drawer)).toBe('from the loaded tracks, not the map')
    expect(drawer.el.querySelector('.analysis-framing.is-stale')).toBeNull()
    expect(recompute(drawer)?.classList.contains('hidden')).toBe(true)
    drawer.destroy()
  })

  it('runs while no map is starred, having no map to be named', () => {
    const { drawer, runs } = open(METAPLOT, { blocked: 'No map is starred.' })
    expect(runButton(drawer).disabled).toBe(false)
    expect(drawer.el.querySelector('.analysis-refusal')).toBeNull()
    runButton(drawer).click()
    expect(runs).toEqual(['metaplot'])
    drawer.destroy()
  })
})
