/**
 * The four promises the runner makes about a job's lifetime (§18.3).
 *
 * All four are about *sequence* rather than about arithmetic — one job at a
 * time, a cancel that lands as a cancel, a cached upstream reused only when its
 * recipe matches, a version stamped on the way out — so they are tested against
 * a worker that answers when this file tells it to, rather than against the real
 * one. That is not a convenience: a fake whose replies are held is the only way
 * to observe the moment where a second run has been asked for and has not been
 * sent, which is exactly the property the queue exists to have.
 *
 * The fake answers `postMessage` with the vocabulary of
 * `analysis/worker/protocol.ts` and nothing else, so a change to that protocol
 * breaks this file rather than quietly passing against a shape the real worker
 * no longer sends.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  AnalysisRunner,
  RUN_HISTORY,
  sameRecipe,
  type RunnerHost,
  type RunTarget,
} from '@/analysis/runner'
import { actions, forgetActions, resetActions } from '@/state/actions'
import { READY } from '@/analysis/types'
import type {
  AnalysisContext,
  AnalysisFraming,
  AnalysisTask,
  Params,
  TaskResult,
} from '@/analysis/types'
import { AnalysisClient } from '@/analysis/worker/client'
import type { AnalysisRequest, AnalysisResponse, BlockInput } from '@/analysis/worker/protocol'

// ---------------------------------------------------------------------------
// The fake worker
// ---------------------------------------------------------------------------

interface HeldRun {
  id: number
  task: string
}

/**
 * A worker that answers `open` at once and holds every `run` until asked.
 *
 * Only the four members `AnalysisClient` touches — `onmessage`, `onerror`,
 * `postMessage`, `terminate` — because the point of the injection seam is to be
 * able to stop there; the cast at the construction site is what stands in for
 * the twenty `EventTarget` members no client has ever called.
 */
class FakeAnalysisWorker {
  onmessage: ((event: { data: AnalysisResponse }) => void) | null = null
  onerror: ((event: { message: string }) => void) | null = null

  readonly seen: AnalysisRequest[] = []
  readonly held: HeldRun[] = []
  /** The most runs that were ever outstanding at once. The queue's whole claim. */
  peak = 0
  terminated = false

  postMessage(message: AnalysisRequest): void {
    this.seen.push(message)
    switch (message.kind) {
      case 'open':
        this.reply({
          type: 'result',
          id: message.id,
          kind: 'open',
          payload: { nBins: 100, binsize: 1000 },
        })
        return
      case 'run':
        this.held.push({ id: message.id, task: message.task })
        this.peak = Math.max(this.peak, this.held.length)
        return
      case 'cancel': {
        this.reply({ type: 'result', id: message.id, kind: 'cancel', payload: null })
        const at = this.held.findIndex((run) => run.id === message.target)
        if (at < 0) return
        const [run] = this.held.splice(at, 1)
        // Exactly what `job.ts`'s `abortError` becomes on the wire: the name is
        // the whole of the signal, and `isCancellation` reads nothing else.
        this.reply({
          type: 'error',
          id: run.id,
          error: { name: 'AbortError', code: null, message: 'cancelled', detail: {} },
        })
        return
      }
      case 'close':
        this.reply({ type: 'result', id: message.id, kind: 'close', payload: null })
    }
  }

  terminate(): void {
    this.terminated = true
  }

  /** The task ids currently on the worker, oldest first. */
  running(): string[] {
    return this.held.map((run) => run.task)
  }

  progress(done: number, total: number, note?: string): void {
    const run = this.held[0]
    if (run === undefined) throw new Error('no run is outstanding')
    this.reply({ type: 'progress', id: run.id, done, total, note })
  }

  /** Answer the oldest outstanding run, as the worker would (§18.4). */
  finish(params: Params = {}, framing: AnalysisFraming = FRAMING): void {
    const run = this.held.shift()
    if (run === undefined) throw new Error('no run is outstanding')
    const payload: TaskResult = {
      outputs: [],
      provenance: {
        task: run.task,
        // The placeholder `analysis.worker.ts` sends and the runner overwrites.
        taskVersion: 0,
        params,
        framing,
        app: '0.0.0-test',
        createdAt: '2026-01-01T00:00:00.000Z',
      },
      notes: [],
      ms: 12,
    }
    this.reply({ type: 'result', id: run.id, kind: 'run', payload })
  }

  private reply(response: AnalysisResponse): void {
    queueMicrotask(() => this.onmessage?.({ data: response }))
  }
}

function clientOver(fake: FakeAnalysisWorker): AnalysisClient {
  // The one cast in this file, and it is the injection seam: a structural
  // `Worker` would mean writing `dispatchEvent` and friends to satisfy a type
  // nothing in the client reads.
  return new AnalysisClient(fake as unknown as Worker)
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const URI = 'demo.cool'

const FRAMING: AnalysisFraming = {
  uri: URI,
  rows: [0, 100],
  cols: [0, 100],
  binsize: 1000,
  binsPerCell: 1,
  balance: true,
  value: 'count',
  normalise: null,
  level: 'bin',
  label: 'chrI · 1 kb bins · balanced · count',
}

function task(id: string, over: Partial<AnalysisTask> = {}): AnalysisTask {
  return {
    id,
    title: id,
    blurb: '',
    group: 'map',
    venue: 'analysis',
    version: 3,
    availability: () => READY,
    params: [],
    outputs: [],
    estimate: () => ({ class: 'free', requests: null, bytes: null, note: 'free' }),
    ...over,
  }
}

function context(framing: AnalysisFraming | null): AnalysisContext {
  return {
    uri: URI,
    layout: 'cool',
    hasGenomes: false,
    hasWeights: true,
    scoreColumns: ['count'],
    binsize: 1000,
    nBins: 100,
    contigs: [],
    hasMap: true,
    genomes: null,
    entries: [],
    framing,
    blockLoaded: false,
    blockBytes: 0,
  }
}

interface Harness {
  runner: AnalysisRunner
  fake: FakeAnalysisWorker
  finished: Array<{ task: string; result: TaskResult; map: string }>
  catalogue: Map<string, AnalysisTask>
}

/** Three maps on screen, as a deck of a lead and two companions would be. */
const DECK: RunTarget[] = [
  { map: 'lead', uri: URI, source: { kind: 'local', file: new File([], URI) }, label: 'lead.cool' },
  { map: 'p1', uri: 'rep2.cool', source: { kind: 'remote', url: 'rep2.cool' }, label: 'rep2.cool' },
  { map: 'p2', uri: 'rep3.cool', source: { kind: 'remote', url: 'rep3.cool' }, label: 'rep3.cool' },
]

/**
 * The block on screen, sized to be worth copying and matching {@link FRAMING}.
 *
 * `blockMatches` compares extents and a bin size and nothing else, which in a
 * deck is exactly what every panel has in common.
 */
function inViewBlock(): BlockInput {
  return {
    values: new Float32Array(4),
    nrows: 2,
    ncols: 2,
    rowExtent: [0, 100],
    colExtent: [0, 100],
    binsPerCell: 1,
  } as unknown as BlockInput
}

function harness(
  framing: AnalysisFraming | null = FRAMING,
  vectors: Map<string, Float32Array> | null = null,
  targets: readonly RunTarget[] = [],
  onScreen: { block: BlockInput | null; map: string } = { block: null, map: 'lead' },
  /** Whatever this test needs the session to answer differently. */
  over: Partial<RunnerHost> = {},
): Harness {
  const fake = new FakeAnalysisWorker()
  const finished: Array<{ task: string; result: TaskResult; map: string }> = []
  const catalogue = new Map<string, AnalysisTask>()
  const host: RunnerHost = {
    context: () => context(framing),
    source: () => ({ uri: URI, source: { kind: 'local', file: new File([], URI) } }),
    block: () => onScreen.block,
    targetMap: () => onScreen.map,
    payload: () => undefined,
    allTargets: () => targets,
    finished: (ran, result, target) => finished.push({ task: ran.id, result, map: target.map }),
    task: (id) => catalogue.get(id),
    ...(vectors === null
      ? {}
      : { vector: (entryId: string) => Promise.resolve(vectors.get(entryId)) }),
    ...over,
  }
  const client = clientOver(fake)
  return { runner: new AnalysisRunner(host, () => client), fake, finished, catalogue }
}

/** What the *other* worker answers a run with; see the annotations venue. */
function trackResult(id: string): TaskResult {
  return {
    outputs: [],
    provenance: {
      task: id,
      taskVersion: 0,
      params: {},
      framing: FRAMING,
      app: '0.0.0-test',
      createdAt: '2026-01-01T00:00:00.000Z',
    },
    notes: [],
    ms: 7,
  }
}

/** Let every reply and every `await` in the runner land. */
async function settle(): Promise<void> {
  for (let turn = 0; turn < 8; turn++) await new Promise((resolve) => setTimeout(resolve, 0))
}

// ---------------------------------------------------------------------------

describe('the file the analysis worker is asked to mount', () => {
  // This worker opens the file for itself, on its own thread, so everything the
  // reader's map is that is not in the file has to be told to it. There is one
  // such thing, and it is a cell set (§3.8): the same scool with two cells
  // ticked and with four thousand is two different experiments, and a mount that
  // ignored the selection answered a task about the pseudo-bulk every time with
  // nothing on screen to say so.
  const opens = (fake: FakeAnalysisWorker): AnalysisRequest[] =>
    fake.seen.filter((m) => m.kind === 'open')

  it('carries the ticked cells of a single-cell container', async () => {
    const { runner, fake } = harness(FRAMING, null, [], { block: null, map: 'lead' }, {
      source: () => ({
        uri: URI,
        source: { kind: 'local', file: new File([], URI) },
        cells: ['cell_a', 'cell_b'],
      }),
    })
    runner.run(task('coverage'), {})
    await settle()
    expect(opens(fake)).toHaveLength(1)
    expect((opens(fake)[0] as { cells?: readonly string[] }).cells).toEqual(['cell_a', 'cell_b'])
  })

  it('says nothing about cells for a file that has none', async () => {
    // Absent rather than empty: the protocol reads *absent* as "every cell",
    // which is what every other container trivially is.
    const { runner, fake } = harness()
    runner.run(task('coverage'), {})
    await settle()
    expect((opens(fake)[0] as { cells?: readonly string[] }).cells).toBeUndefined()
  })

  it('re-mounts when the selection changes, though the file has not', async () => {
    // The bug a URI-keyed mount cache would have: same file, different map, and
    // the second run silently answered with the first one's cells.
    let cells = ['cell_a']
    const { runner, fake } = harness(FRAMING, null, [], { block: null, map: 'lead' }, {
      source: () => ({ uri: URI, source: { kind: 'local', file: new File([], URI) }, cells }),
    })
    runner.run(task('coverage'), {})
    await settle()
    fake.finish()
    await settle()

    cells = ['cell_a', 'cell_b']
    runner.run(task('insulation'), {})
    await settle()
    expect(opens(fake).map((m) => (m as { cells?: readonly string[] }).cells)).toEqual([
      ['cell_a'],
      ['cell_a', 'cell_b'],
    ])
  })

  it('mounts once when nothing about the target moved', async () => {
    const { runner, fake } = harness()
    runner.run(task('coverage'), {})
    await settle()
    fake.finish()
    await settle()
    runner.run(task('insulation'), {})
    await settle()
    expect(opens(fake)).toHaveLength(1)
  })
})

describe('the analysis queue', () => {
  it('runs one job at a time and starts the second when the first is answered', async () => {
    const { runner, fake } = harness()
    const first = task('insulation')
    const second = task('coverage')

    runner.run(first, {})
    runner.run(second, {})
    // Both are known before anything is awaited, and the second one is *queued*
    // rather than in flight — which is the state that would not exist if `run`
    // simply started what it was given.
    expect(runner.stateOf('insulation').status).toBe('running')
    expect(runner.stateOf('coverage').status).toBe('queued')

    await settle()
    expect(fake.running()).toEqual(['insulation'])
    expect(runner.stateOf('insulation').status).toBe('running')
    expect(runner.stateOf('coverage').status).toBe('queued')
    expect(runner.busy).toBe(true)

    fake.finish()
    await settle()
    expect(runner.stateOf('insulation').status).toBe('done')
    expect(fake.running()).toEqual(['coverage'])

    fake.finish()
    await settle()
    expect(runner.stateOf('coverage').status).toBe('done')
    expect(runner.busy).toBe(false)
    // The whole of §18.3's queue: two scans over one byte source were never in
    // the worker together.
    expect(fake.peak).toBe(1)
    // And the file was mounted once, not once per job.
    expect(fake.seen.filter((request) => request.kind === 'open')).toHaveLength(1)
    runner.destroy()
  })

  it('notifies a subscriber on every state change', async () => {
    const { runner, fake } = harness()
    let calls = 0
    const stop = runner.subscribe(() => {
      calls += 1
    })
    runner.run(task('insulation'), {})
    expect(calls).toBeGreaterThan(0)
    const queued = calls
    await settle()
    fake.finish()
    await settle()
    expect(calls).toBeGreaterThan(queued)
    stop()
    const quiet = calls
    runner.run(task('coverage'), {})
    expect(calls).toBe(quiet)
    runner.destroy()
  })
})

/**
 * One task, every map on screen.
 *
 * The question a deck raises and the star only half answers: four replicates are
 * open because they are being compared, and the comparison is four insulation
 * tracks rather than one. What is worth pinning is not the loop but the three
 * things that make it honest — one file on the worker at a time, each result
 * filed against the map it was measured from, and a cancel that stops the batch
 * where it has reached rather than only the job in flight.
 */
describe('running on every map', () => {
  it('queues one job per map and mounts one file at a time', async () => {
    const { runner, fake, finished } = harness(FRAMING, null, DECK)
    const insulation = task('insulation')

    runner.runAll(insulation, {}, runner.targets())
    await settle()
    // One in flight, two waiting: the worker mounts one file at a time, and
    // three h5wasm instances with three dense blocks live at once is the moment
    // a tab can least afford it.
    expect(fake.running()).toEqual(['insulation'])
    expect(fake.peak).toBe(1)

    fake.finish()
    await settle()
    fake.finish()
    await settle()
    fake.finish()
    await settle()

    expect(runner.stateOf('insulation').status).toBe('done')
    // Each result carries the map it was measured from, so a batch leaves a row
    // per panel rather than three rows on the lead.
    expect(finished.map((entry) => entry.map)).toEqual(['lead', 'p1', 'p2'])
    // Three files, so three mounts — and no more than three.
    expect(fake.seen.filter((request) => request.kind === 'open')).toHaveLength(3)
    runner.destroy()
  })

  /**
   * The regression, and the worst shape a bug of this kind can have.
   *
   * The block on screen belongs to **one** panel — the starred one — and
   * `blockMatches` cannot tell: it compares extents and a bin size, and every
   * panel of a deck is at the same extents at the same bin size, which is the
   * whole point of a deck. So a batch lent the same pixels to all five jobs and
   * five maps came back with one map's answer — only for the chromosome that
   * happened to be in view, because everywhere else there is no block to lend.
   * Every other region was read per file and correct, so the numbers agreed
   * with themselves everywhere a reader would think to check.
   */
  it('lends the block on screen only to the map it is a picture of', async () => {
    const { runner, fake } = harness(FRAMING, null, DECK, { block: inViewBlock(), map: 'lead' })

    runner.runAll(task('insulation'), {}, runner.targets())
    await settle()
    fake.finish()
    await settle()
    fake.finish()
    await settle()
    fake.finish()
    await settle()

    const runs = fake.seen.filter((request) => request.kind === 'run')
    expect(runs).toHaveLength(3)
    // The first job is the lead's, and it is the one the pixels belong to.
    expect(runs[0].inputs?.block).toBeDefined()
    expect(runs[1].inputs?.block).toBeUndefined()
    expect(runs[2].inputs?.block).toBeUndefined()
    runner.destroy()
  })

  it('lends it to the starred companion instead when the star has moved', async () => {
    // The host has one block and it is whichever panel the star is on, so which
    // job may borrow it moves with the star rather than being the first one.
    const { runner, fake } = harness(FRAMING, null, DECK, { block: inViewBlock(), map: 'p1' })

    runner.runAll(task('insulation'), {}, runner.targets())
    await settle()
    fake.finish()
    await settle()
    fake.finish()
    await settle()
    fake.finish()
    await settle()

    const runs = fake.seen.filter((request) => request.kind === 'run')
    expect(runs[0].inputs?.block).toBeUndefined()
    expect(runs[1].inputs?.block).toBeDefined()
    expect(runs[2].inputs?.block).toBeUndefined()
    runner.destroy()
  })

  it('still lends it to a run of one, which is every session without a deck', async () => {
    const { runner, fake } = harness(FRAMING, null, [], { block: inViewBlock(), map: 'lead' })
    runner.run(task('insulation'), {})
    await settle()
    const runs = fake.seen.filter((request) => request.kind === 'run')
    expect(runs[0].inputs?.block).toBeDefined()
    runner.destroy()
  })

  it('says where in the deck it has got to', async () => {
    const { runner, fake } = harness(FRAMING, null, DECK)
    runner.runAll(task('insulation'), {}, runner.targets())
    await settle()

    const first = runner.stateOf('insulation')
    // The percentage is one map's progress; without this a reader would watch it
    // reach 100 twice and read the third as a stall.
    expect(first.status === 'running' && first.batch).toEqual({
      at: 0,
      of: 3,
      label: 'lead.cool',
    })

    fake.finish()
    await settle()
    const second = runner.stateOf('insulation')
    expect(second.status === 'running' && second.batch?.at).toBe(1)
    expect(second.status === 'running' && second.batch?.label).toBe('rep2.cool')
    runner.destroy()
  })

  it('is stopped where it has reached, not only the job in flight', async () => {
    const { runner, fake, finished } = harness(FRAMING, null, DECK)
    runner.runAll(task('insulation'), {}, runner.targets())
    await settle()
    fake.finish()
    await settle()

    runner.cancel('insulation')
    await settle()
    expect(runner.stateOf('insulation').status).toBe('cancelled')
    // The first map's result stands — it was measured before the reader
    // stopped — and the third was never sent.
    expect(finished.map((entry) => entry.map)).toEqual(['lead'])
    expect(runner.busy).toBe(false)
    runner.destroy()
  })

  it('runs one map as a plain run, with no batch to report', async () => {
    const { runner, fake } = harness(FRAMING, null, [DECK[0]])
    runner.runAll(task('insulation'), {}, runner.targets())
    await settle()
    const state = runner.stateOf('insulation')
    expect(state.status === 'running' && state.batch).toBeUndefined()
    fake.finish()
    await settle()
    expect(runner.stateOf('insulation').status).toBe('done')
    runner.destroy()
  })

  /**
   * The **first** press covers the whole grid.
   *
   * A companion opens to draw a picture; the two tables an analysis needs are a
   * further pair of reads it makes only when it is starred or batched
   * (`panels/MapPanel.ts`). So `allTargets` — the synchronous answer, and what
   * the drawer prices and orders results by — leaves out a map that is still
   * reading, and a batch that took it ran on three of four and left the fourth
   * behind. Nothing on screen said so: a result that never came looks exactly
   * like a task that had nothing to report, and pressing Run again worked, which
   * made a question about timing look like a question about the file.
   */
  describe('the maps that are still opening', () => {
    /** A deck whose third map answers only once its tables have been read. */
    function opening(): { host: Partial<RunnerHost>; ready(): void } {
      let read = false
      return {
        host: {
          allTargets: () => (read ? DECK : DECK.slice(0, 2)),
          allTargetsReady: async () => {
            read = true
            return DECK
          },
          targetCount: () => DECK.length,
        },
        ready: () => {
          read = true
        },
      }
    }

    it('are waited for, so the first press runs on all of them', async () => {
      const late = opening()
      const { runner, fake, finished } = harness(
        FRAMING,
        null,
        DECK,
        { block: null, map: 'lead' },
        late.host,
      )
      // What the button says, and what the synchronous list would have run.
      expect(runner.targetCount()).toBe(3)
      expect(runner.targets()).toHaveLength(2)

      runner.runAll(task('insulation'), {}, await runner.readyTargets())
      await settle()
      fake.finish()
      await settle()
      fake.finish()
      await settle()
      fake.finish()
      await settle()

      expect(finished.map((entry) => entry.map)).toEqual(['lead', 'p1', 'p2'])
      runner.destroy()
    })

    it('are counted before they answer, so the button does not undercount', async () => {
      const late = opening()
      const { runner } = harness(FRAMING, null, DECK, { block: null, map: 'lead' }, late.host)
      // "run on all 3 maps" over a deck of three, while only two can answer yet
      // — the batch waits for the third, so counting two would be the button
      // promising the smaller number and delivering the larger.
      expect(runner.targetCount()).toBe(3)
      runner.destroy()
    })

    it('fall back to the synchronous list where a host has nothing to wait for', async () => {
      // Every session with no deck: one map, open, nothing to wait for.
      const { runner } = harness(FRAMING, null, [DECK[0]])
      expect(await runner.readyTargets()).toEqual(runner.targets())
      expect(runner.targetCount()).toBe(1)
      runner.destroy()
    })
  })
})

describe('cancelling a job', () => {
  it('lands in cancelled, not failed, and carries no message', async () => {
    const { runner, fake } = harness()
    runner.run(task('insulation'), {})
    await settle()
    expect(fake.running()).toEqual(['insulation'])

    runner.cancel('insulation')
    await settle()
    const state = runner.stateOf('insulation')
    expect(state.status).toBe('cancelled')
    // The distinction the whole `AbortError` convention exists for: a cancelled
    // analysis must not draw an error card saying "cancelled".
    expect(state).not.toHaveProperty('message')
    expect(runner.resultOf('insulation')).toBeNull()
    expect(runner.busy).toBe(false)
    runner.destroy()
  })

  it('drops a queued job without ever sending it to the worker', async () => {
    const { runner, fake } = harness()
    runner.run(task('insulation'), {})
    runner.run(task('coverage'), {})
    await settle()

    runner.cancel('coverage')
    expect(runner.stateOf('coverage').status).toBe('cancelled')
    fake.finish()
    await settle()
    expect(fake.seen.filter((request) => request.kind === 'run')).toHaveLength(1)
    expect(runner.stateOf('coverage').status).toBe('cancelled')
    runner.destroy()
  })

  it('ends the session as cancelled and takes the thread with it', async () => {
    const { runner, fake } = harness()
    runner.run(task('insulation'), {})
    await settle()
    runner.destroy()
    await settle()
    expect(runner.stateOf('insulation').status).toBe('cancelled')
    expect(fake.terminated).toBe(true)
  })
})

describe('the version stamp', () => {
  it('overwrites the placeholder the worker sends', async () => {
    const { runner, fake, finished } = harness()
    runner.run(task('insulation', { version: 7 }), {})
    await settle()
    fake.finish()
    await settle()

    const result = runner.resultOf('insulation')
    expect(result).not.toBeNull()
    // 0 is what `analysis.worker.ts` sends and what a result that skipped this
    // step would still be carrying.
    expect(result?.provenance.taskVersion).toBe(7)
    expect(finished).toHaveLength(1)
    expect(finished[0]?.result.provenance.taskVersion).toBe(7)
    runner.destroy()
  })
})

describe('composites', () => {
  it('runs each requirement first and hands the results down as upstream', async () => {
    const { runner, fake, catalogue } = harness()
    const expected = task('expected')
    const saddle = task('saddle', { requires: ['expected'] })
    catalogue.set('expected', expected)

    runner.run(saddle, {})
    await settle()
    expect(fake.running()).toEqual(['expected'])
    // The note names the step and carries the worker's own line with it, which
    // together are the honest answer to "why is this taking so long".
    fake.progress(3, 16, 'reading pixels')
    await settle()
    const running = runner.stateOf('saddle')
    expect(running.status === 'running' && running.note).toContain('expected (1/2)')
    expect(running.status === 'running' && running.note).toContain('reading pixels')
    expect(running.status === 'running' && running.done).toBe(3)

    fake.finish()
    await settle()
    expect(fake.running()).toEqual(['saddle'])
    const request = fake.seen.find(
      (message): message is Extract<AnalysisRequest, { kind: 'run' }> =>
        message.kind === 'run' && message.task === 'saddle',
    )
    expect(Object.keys(request?.inputs.upstream ?? {})).toEqual(['expected'])

    fake.finish()
    await settle()
    expect(runner.stateOf('saddle').status).toBe('done')
    // The requirement is cached under its own id and its row says so.
    expect(runner.resultOf('expected')?.provenance.task).toBe('expected')
    runner.destroy()
  })

  it('reuses a cached requirement whose recipe matches, and recomputes one whose does not', async () => {
    const { runner, fake, catalogue } = harness()
    const expected = task('expected')
    catalogue.set('expected', expected)
    const saddle = task('saddle', { requires: ['expected'] })

    runner.run(saddle, {})
    await settle()
    fake.finish() // expected
    await settle()
    fake.finish() // saddle
    await settle()
    expect(fake.seen.filter((message) => message.kind === 'run')).toHaveLength(2)

    // Same framing, same defaults: the second saddle asks the worker for one
    // step, not two.
    runner.run(saddle, {})
    await settle()
    expect(fake.running()).toEqual(['saddle'])
    fake.finish()
    await settle()
    expect(fake.seen.filter((message) => message.kind === 'run')).toHaveLength(3)
    runner.destroy()
  })
})

describe('sameRecipe', () => {
  const provenance = {
    task: 'expected',
    taskVersion: 1,
    params: { window: 100_000, mode: 'log', tracks: ['a', 'b'] },
    framing: FRAMING,
    app: '0.0.0-test',
    createdAt: '2026-01-01T00:00:00.000Z',
  }

  it('accepts the same parameters over the same framing', () => {
    expect(
      sameRecipe(provenance, {
        params: { window: 100_000, mode: 'log', tracks: ['a', 'b'] },
        framing: { ...FRAMING },
      }),
    ).toBe(true)
  })

  it('rejects a changed parameter, a changed list and a missing key', () => {
    expect(
      sameRecipe(provenance, {
        params: { window: 50_000, mode: 'log', tracks: ['a', 'b'] },
        framing: FRAMING,
      }),
    ).toBe(false)
    expect(
      sameRecipe(provenance, {
        params: { window: 100_000, mode: 'log', tracks: ['b', 'a'] },
        framing: FRAMING,
      }),
    ).toBe(false)
    expect(
      sameRecipe(provenance, { params: { window: 100_000, mode: 'log' }, framing: FRAMING }),
    ).toBe(false)
  })

  it('rejects a changed framing, and ignores the framing label', () => {
    const { params } = provenance
    expect(sameRecipe(provenance, { params, framing: { ...FRAMING, rows: [0, 50] } })).toBe(false)
    expect(sameRecipe(provenance, { params, framing: { ...FRAMING, balance: false } })).toBe(false)
    expect(sameRecipe(provenance, { params, framing: { ...FRAMING, binsPerCell: 4 } })).toBe(false)
    expect(sameRecipe(provenance, { params, framing: { ...FRAMING, uri: 'other.cool' } })).toBe(
      false,
    )
    // Prose derived from the fields above it: a change to how a bin size is
    // spelled must not invalidate a cache.
    expect(sameRecipe(provenance, { params, framing: { ...FRAMING, label: 'reworded' } })).toBe(true)
  })
})

describe('a view with no map', () => {
  it('refuses rather than queueing, and never builds a worker', () => {
    const { runner, fake } = harness(null)
    runner.run(task('insulation'), {})
    const state = runner.stateOf('insulation')
    expect(state.status).toBe('failed')
    expect(runner.busy).toBe(false)
    expect(fake.seen).toHaveLength(0)
    runner.destroy()
  })

  /**
   * …and the three tasks that are *not* about a map run there anyway (§18.3).
   *
   * A 1D browser session is where a reader has the bigWigs and not the matrix,
   * which is precisely the session a metaplot, a track correlation and an
   * interval overlap are for. Two things have to be true for one to run: the
   * framing falls back to the tracks, and the *target* — the pair a result is
   * filed under — comes from whatever the session has open, which there is a
   * genome rather than a file. The second was missing, so all three failed as
   * "nothing is open" in the one session shape they exist for.
   */
  it('runs a track-only task against the genome, with no file to mount', async () => {
    const sent: unknown[] = []
    const tracks = {
      request: (payload: unknown) => {
        sent.push(payload)
        return Promise.resolve(trackResult('metaplot'))
      },
    }
    const { runner, fake, finished } = harness(null, null, [], { block: null, map: 'lead' }, {
      // The genome the tracks were loaded against: a bigWig, and not a cooler.
      source: () => ({ uri: 'peaks.bw', source: { kind: 'remote', url: 'peaks.bw' } }),
      annotations: () => tracks as unknown as ReturnType<NonNullable<RunnerHost['annotations']>>,
    })

    runner.run(task('metaplot', { group: 'tracks', venue: 'annotations' }), {})
    await settle()

    expect(runner.stateOf('metaplot').status).toBe('done')
    expect(sent).toHaveLength(1)
    // Filed, and against the map the session named — a browser has one lane
    // list like a map does, and a computed track goes on it.
    expect(finished.map((one) => one.task)).toEqual(['metaplot'])
    // Nothing was opened in the analysis worker: a track-only chain has no file
    // for it to hold, and opening one would be a wasm instance and a range cache
    // for a job that asks them nothing.
    expect(fake.seen).toHaveLength(0)
    runner.destroy()
  })

  it('runs one even where the session can name no file at all', async () => {
    // The other half of the same rule, and the one that keeps it from coming
    // back: what a track task needs is tracks. A target with no byte source is
    // not a broken target here, because nothing in this chain mounts one.
    const tracks = { request: () => Promise.resolve(trackResult('trackcorr')) }
    const { runner } = harness(null, null, [], { block: null, map: 'lead' }, {
      source: () => null,
      annotations: () => tracks as unknown as ReturnType<NonNullable<RunnerHost['annotations']>>,
    })
    runner.run(task('trackcorr', { group: 'tracks', venue: 'annotations' }), {})
    await settle()
    expect(runner.stateOf('trackcorr').status).toBe('done')
    runner.destroy()
  })

  it('refuses a map task that reaches a genome, in the task’s own terms', async () => {
    // `framing` non-null with nothing to mount is not a state the app can reach
    // — a framing comes from a panel and a panel comes from a file — so this is
    // the type being honest rather than a case a reader meets. What matters is
    // that it is a sentence about the task, not "nothing is open".
    const { runner, fake } = harness(FRAMING, null, [], { block: null, map: 'lead' }, {
      source: () => null,
    })
    runner.run(task('insulation', { title: 'Diamond insulation' }), {})
    await settle()
    const state = runner.stateOf('insulation')
    expect(state.status).toBe('failed')
    expect(state.status === 'failed' && state.message).toContain('Diamond insulation')
    expect(fake.seen).toHaveLength(0)
    runner.destroy()
  })
})

/**
 * How a sequence crosses the venue boundary (§18.6, open question 6).
 *
 * The compartments task runs in the analysis worker; a FASTA's residues live in
 * the annotations one and are megabytes. What the task needs is one number per
 * bin, so the main thread asks the *other* worker for the vector and ships it
 * with the job — under the parameter's own key, on the same channel a chosen
 * bigWig arrives on. The alternative was a third venue for one parameter.
 *
 * Two properties, and the second is what stops the fix from costing something:
 * an analysis-venue task gets the vector, and an annotations-venue task does
 * not, because that worker is holding the handle it would be sent a copy of.
 */
describe('a sequence or a track chosen as an input', () => {
  const GC = Float32Array.from([0.31, 0.44, 0.52])

  function sequenceTask(venue: 'analysis' | 'annotations'): AnalysisTask {
    return task('compartments', {
      venue,
      params: [
        {
          kind: 'sequence',
          key: 'phaseSequence',
          label: 'Phase by GC content',
          optional: true,
        },
      ],
    })
  }

  it('reaches an analysis-venue task as a bin vector, under its own key', async () => {
    const { runner, fake } = harness(FRAMING, new Map([['fasta1', GC]]))
    runner.run(sequenceTask('analysis'), { phaseSequence: 'fasta1' })
    await settle()

    const run = fake.seen.find((message) => message.kind === 'run')
    expect(run, 'the job was dispatched').toBeDefined()
    if (run?.kind !== 'run') throw new Error('unreachable')
    expect(run.inputs.vectors?.['phaseSequence']).toEqual(GC)
    runner.destroy()
  })

  it('is left out of an annotations-venue task, which holds the file itself', async () => {
    // Not an oversight: sending it would be handing that worker a copy of what
    // it is about to read, once per run, over the wire.
    const { runner, fake } = harness(FRAMING, new Map([['fasta1', GC]]))
    runner.run(sequenceTask('annotations'), { phaseSequence: 'fasta1' })
    await settle()
    const run = fake.seen.find((message) => message.kind === 'run')
    // The annotations venue has no client in this harness, so the job fails
    // there rather than dispatching — which is itself the check that it never
    // reached the analysis worker.
    expect(run).toBeUndefined()
    expect(runner.stateOf('compartments').status).toBe('failed')
    runner.destroy()
  })

  it('is left out when the row has gone, rather than sent as zeros', async () => {
    const { runner, fake } = harness(FRAMING, new Map())
    runner.run(sequenceTask('analysis'), { phaseSequence: 'dropped' })
    await settle()
    const run = fake.seen.find((message) => message.kind === 'run')
    if (run?.kind !== 'run') throw new Error('the job was not dispatched')
    expect(run.inputs.vectors).toBeUndefined()
    runner.destroy()
  })
})


// ---------------------------------------------------------------------------

/**
 * The console's record of a job (§23).
 *
 * The promise the whole feature rests on is that a line is written **per job**
 * rather than per press, and the case that proves it is *run on all maps*: the
 * drawer shows one result at a time, so the other five commands of a six-map
 * batch exist nowhere but here. The second promise is that a run which produced
 * nothing is still recorded — a failure and a Stop are exactly when a reader
 * wants the parameters back, and both leave the runner without a result to read
 * a provenance off.
 */
describe('the console record of a job', () => {
  beforeEach(() => {
    resetActions()
  })

  afterEach(() => {
    forgetActions()
  })

  const lines = () => actions().filter((entry) => entry.kind === 'run')

  it('writes one line per map of a batch, each naming its own file', async () => {
    const { runner, fake } = harness(FRAMING, null, DECK, { block: null, map: 'lead' })
    runner.runAll(task('coverage'), {}, DECK)
    for (let at = 0; at < DECK.length; at++) {
      await settle()
      fake.finish()
      await settle()
    }
    expect(lines()).toHaveLength(3)
    expect(lines().map((entry) => entry.where)).toEqual(['lead.cool', 'rep2.cool', 'rep3.cool'])
    expect(lines().every((entry) => entry.status === 'ok')).toBe(true)
    runner.destroy()
  })

  it('names the file each job of a batch actually ran on, not the batch\u2019s framing', async () => {
    // A batch shares one framing across every target (§18.4 takes it once, when
    // Run is pressed), and an `AnalysisFraming` carries a uri — so the second
    // job is dispatched against rep2.cool holding a framing that says lead.cool.
    // Invisible in the drawer, which prints the label; not invisible in a
    // command, where it is a reader running the wrong experiment in a shell.
    const { runner, fake } = harness(FRAMING, null, DECK, { block: null, map: 'lead' })
    runner.runAll(task('coverage'), {}, DECK)
    for (let at = 0; at < DECK.length; at++) {
      await settle()
      fake.finish()
      await settle()
    }
    const files = lines().map((entry) => entry.line.split(' ')[2])
    expect(files).toEqual([URI, 'rep2.cool', 'rep3.cool'])
    // The provenance block above the command says the same file it does: a row
    // that quoted two would be worse than either.
    expect(lines()[1].detail.some((line) => line === '# file: rep2.cool')).toBe(true)
    expect(lines()[1].detail.some((line) => line.includes(URI))).toBe(false)
    runner.destroy()
  })

  it('opens the line when the job starts and closes it when the job ends', async () => {
    const { runner, fake } = harness()
    runner.run(task('coverage'), {})
    await settle()
    // On the worker, and on screen: a batch of thirty is only legible while it
    // is in progress, and so is the console.
    expect(lines()[0].status).toBe('running')
    fake.finish()
    await settle()
    expect(lines()[0].status).toBe('ok')
    expect(lines()[0].ms).toBeGreaterThanOrEqual(0)
    runner.destroy()
  })

  it('keeps the line of a run that failed, with the failure on it', async () => {
    // No source to mount: the job fails before it reaches the worker, which is
    // the shape of every failure that has no result to take a provenance from.
    const { runner } = harness(FRAMING, null, [], { block: null, map: 'lead' }, {
      source: () => null,
    })
    runner.run(task('coverage'), {})
    await settle()
    expect(lines()).toHaveLength(1)
    expect(lines()[0].status).toBe('failed')
    expect(lines()[0].error).toContain('contact map')
    // The command is still there, written from the parameters the job was
    // queued with — which is the whole reason a failure is recorded at all.
    expect(lines()[0].line).toContain('metacooler-run coverage')
    runner.destroy()
  })

  it('writes a line for a press of Run that never became a job', async () => {
    // Refused before anything is queued: there is no framing, so there is no
    // command either — a `--window` is written from one. The line is prose with
    // the reason on it, which is the answer to "why did nothing happen when I
    // pressed run at two o'clock".
    const { runner } = harness(null)
    runner.run(task('coverage'), {})
    await settle()
    expect(lines()).toHaveLength(1)
    expect(lines()[0].status).toBe('failed')
    expect(lines()[0].shell).toBe(false)
    expect(lines()[0].error).toContain('no contact map')
    runner.destroy()
  })

  it('says a session-wide refusal once, however many maps the batch was aimed at', async () => {
    // Both pre-flight refusals are about the session rather than the target, so
    // three copies of one fact would be three lines a reader has to read before
    // finding out they are the same line.
    const { runner } = harness(null, null, DECK)
    runner.runAll(task('coverage'), {}, DECK)
    await settle()
    expect(lines()).toHaveLength(1)
    runner.destroy()
  })

  it('names the file rather than its address when there is no map to frame against', async () => {
    // A track task in a 1D browser session (§5.8) is framed against the assembly
    // rather than a block, and the file that declared that assembly is routinely
    // a bucket URL a hundred characters long. The whole of one in the line
    // pushes everything worth reading off the right of the row — and the address
    // is in `# file:` already, which is where it is wanted.
    const url = 'https://rsglab-data.s3.eu-west-3.amazonaws.com/demo/yeast/Yeast_ATAC.bw'
    const tracks = task('trackcorr', {
      venue: 'annotations',
      params: [{ kind: 'track', key: 'tracks', label: 'Tracks', multiple: true }],
    } as Partial<AnalysisTask>)
    const { runner } = harness(null, null, [], { block: null, map: 'lead' }, {
      context: () => ({ ...context(null), uri: url }),
    })
    runner.run(tracks, {})
    await settle()
    expect(lines()).toHaveLength(1)
    // A command, with no map to open as its first argument: `metacooler-run`
    // runs a track task with no positional, over what the tracks declare — so
    // the address is nowhere on the line, and the file's name is where the
    // framing is recorded.
    expect(lines()[0].shell).toBe(true)
    expect(lines()[0].line.startsWith('metacooler-run trackcorr')).toBe(true)
    expect(lines()[0].line).not.toContain('amazonaws.com')
    expect(lines()[0].line).not.toContain('Yeast_ATAC.bw')
    expect(lines()[0].detail.join('\n')).toContain(
      '# framing: Yeast_ATAC.bw · loaded tracks, no contact map',
    )
    runner.destroy()
  })

  it('marks a stopped run as cancelled rather than as a failure', async () => {
    const { runner } = harness()
    runner.run(task('coverage'), {})
    await settle()
    runner.cancel('coverage')
    await settle()
    expect(lines()[0].status).toBe('cancelled')
    expect(lines()[0].error).toBeUndefined()
    runner.destroy()
  })
})

// ---------------------------------------------------------------------------

/**
 * Runs kept, so a reader can go back to a figure Run used to destroy.
 *
 * A pileup over forty thousand anchors is a minute of range requests, and until
 * this the second press of Run overwrote the first result in place: the picture
 * was gone, the parameters that produced it were gone, and the only way back was
 * to remember the settings and pay the minute again. What is checked here is the
 * three things that make the history usable rather than merely present — it is
 * per map, it is newest first, and it is bounded.
 */
describe('the history of a task', () => {
  it('is empty before anything has run, and one deep after the first run', async () => {
    const { runner, fake } = harness()
    expect(runner.runsOf('coverage')).toEqual([])
    runner.run(task('coverage'), {})
    await settle()
    fake.finish({ window: 1 })
    await settle()
    expect(runner.runsOf('coverage')).toHaveLength(1)
    runner.destroy()
  })

  it('keeps the run a second press of Run replaces, newest first', async () => {
    const { runner, fake } = harness()
    runner.run(task('coverage'), { window: 1 })
    await settle()
    fake.finish({ window: 1 })
    await settle()
    runner.run(task('coverage'), { window: 2 })
    await settle()
    fake.finish({ window: 2 })
    await settle()

    const runs = runner.runsOf('coverage')
    expect(runs).toHaveLength(2)
    expect(runs[0].provenance.params).toEqual({ window: 2 })
    expect(runs[1].provenance.params).toEqual({ window: 1 })
    // The newest is still what `resultOf` answers: the history is a view over
    // the same results, not a second store that can drift from them.
    expect(runner.resultOf('coverage')).toBe(runs[0])
    runner.destroy()
  })

  it('is per map, so a deck does not mix one panel’s runs into another’s', async () => {
    const onScreen = { block: null, map: 'lead' }
    const { runner, fake } = harness(FRAMING, null, DECK, onScreen)
    runner.run(task('coverage'), { window: 1 })
    await settle()
    fake.finish({ window: 1 })
    await settle()
    onScreen.map = 'p1'
    runner.run(task('coverage'), { window: 9 })
    await settle()
    fake.finish({ window: 9 })
    await settle()

    expect(runner.runsOf('coverage', 'lead')).toHaveLength(1)
    expect(runner.runsOf('coverage', 'p1')).toHaveLength(1)
    expect(runner.runsOf('coverage', 'lead')[0].provenance.params).toEqual({ window: 1 })
    expect(runner.runsOf('coverage', 'p1')[0].provenance.params).toEqual({ window: 9 })
    runner.destroy()
  })

  it('drops the oldest past the cap rather than growing all afternoon', async () => {
    const { runner, fake } = harness()
    for (let press = 0; press < RUN_HISTORY + 4; press++) {
      runner.run(task('coverage'), { window: press })
      await settle()
      fake.finish({ window: press })
      await settle()
    }
    const runs = runner.runsOf('coverage')
    expect(runs).toHaveLength(RUN_HISTORY + 1)
    // Newest first, and the oldest surviving run is the one `RUN_HISTORY` back.
    expect(runs[0].provenance.params).toEqual({ window: RUN_HISTORY + 3 })
    expect(runs[runs.length - 1].provenance.params).toEqual({ window: 3 })
    runner.destroy()
  })

  it('files a cancelled run nowhere, because it produced no result', async () => {
    const { runner, fake } = harness()
    runner.run(task('coverage'), { window: 1 })
    await settle()
    fake.finish({ window: 1 })
    await settle()
    runner.run(task('coverage'), { window: 2 })
    await settle()
    runner.cancel('coverage')
    await settle()
    const runs = runner.runsOf('coverage')
    expect(runs).toHaveLength(1)
    expect(runs[0].provenance.params).toEqual({ window: 1 })
    runner.destroy()
  })
})
