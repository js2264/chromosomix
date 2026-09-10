// @vitest-environment jsdom
/**
 * `copy CLI command`, beside `copy provenance`, on the run that just finished.
 *
 * `cli/main.ts` exists because clicking stops being the interface at the second
 * file. What it was missing was a way in: `metacooler-run tasks` prints the
 * flags a task *takes*, which is a different question from what the reader just
 * did — so the twenty minutes of moving a window and nudging four numbers ended
 * in transcribing those numbers into a shell by eye, once per task. That is the
 * one step in the loop where the numbers in the figure and the numbers in the
 * table can quietly stop being the same numbers.
 *
 * The button is here rather than on the Synthetic tracks card because the run is
 * what it repeats, not the lane: a task that produces four outputs is one
 * command, and the drawer is the only surface that has the whole result. Its
 * source is the same {@link Provenance} `copy provenance` reads, so the two
 * cannot come to describe different runs.
 *
 * Two things are pinned about the button itself, and the second is the one worth
 * having. It is **disabled with a reason** for a task the command cannot start —
 * the alternative being a button that hands over a line the command then
 * rejects, which the reader finds out somewhere else, later, with the app
 * closed. And the reason is the command's own words, from the predicate the
 * command itself consults, so the two cannot drift.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { cliCannotRun } from '@/analysis/cliCommand'
import { taskById } from '@/analysis/registry'
import type { AnalysisRunner } from '@/analysis/runner'
import type {
  AnalysisContext,
  AnalysisFraming,
  AnalysisTask,
  Params,
  ProfileOutput,
  TaskResult,
} from '@/analysis/types'
import { AnalysisDrawer } from '@/ui/AnalysisDrawer'
import { setUpDom, type DomTeardown } from '../support/dom'

let teardown: DomTeardown
let copied: string[]
let restoreClipboard: () => void

/**
 * What `copyTextToClipboard` would have put on the clipboard.
 *
 * jsdom has no `navigator.clipboard`, and the app's helper falls back to
 * `document.execCommand('copy')` over a hidden textarea — which jsdom does not
 * implement either. Both are replaced, so what is asserted is the text the
 * drawer handed over rather than a browser API.
 */
function captureClipboard(): () => void {
  const nav = navigator as unknown as { clipboard?: { writeText(text: string): Promise<void> } }
  const real = nav.clipboard
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: {
      writeText: (text: string) => {
        copied.push(text)
        return Promise.resolve()
      },
    },
  })
  return () => {
    if (real === undefined) delete nav.clipboard
    else Object.defineProperty(navigator, 'clipboard', { configurable: true, value: real })
  }
}

beforeEach(() => {
  teardown = setUpDom()
  copied = []
  restoreClipboard = captureClipboard()
})

afterEach(() => {
  restoreClipboard()
  teardown()
})

const CONTIGS = [
  { name: 'chrIV', length: 1_531_933, startBin: 0, bins: 1532, genome: -1 },
  { name: 'chrXVI', length: 948_066, startBin: 1532, bins: 949, genome: -1 },
]
const N_BINS = 2481

function framing(patch: Partial<AnalysisFraming> = {}): AnalysisFraming {
  return {
    uri: 'yeast.mcool::resolutions/1000',
    label: 'whole genome at 1.0 kb bins · balanced · count',
    binsize: 1000,
    binsPerCell: 1,
    rows: [0, N_BINS],
    cols: [0, N_BINS],
    balance: true,
    value: 'count',
    normalise: null,
    level: 'bin',
    ...patch,
  }
}

const CONTEXT: AnalysisContext = {
  uri: 'yeast.mcool::resolutions/1000',
  layout: 'cool',
  hasMap: true,
  hasGenomes: false,
  hasWeights: true,
  scoreColumns: [],
  binsize: 1000,
  nBins: N_BINS,
  contigs: CONTIGS,
  genomes: null,
  entries: [],
  framing: framing(),
  blockLoaded: false,
  blockBytes: 0,
}

function profile(): ProfileOutput {
  return {
    kind: 'profile',
    id: 'insulation-w10',
    label: 'Insulation · 10 kb',
    values: Float32Array.from([1, 2, 3]),
    extent: [0, 3],
    binsize: 1000,
    unit: '',
  }
}

function result(task: string, params: Params, patch: Partial<AnalysisFraming> = {}): TaskResult {
  return {
    outputs: [profile()],
    notes: [],
    ms: 12,
    provenance: {
      task,
      taskVersion: 1,
      params,
      framing: framing(patch),
      createdAt: '2026-09-10T00:00:00Z',
      app: 'test',
    },
  }
}

function runnerWith(finished: TaskResult): AnalysisRunner {
  return {
    subscribe: () => () => {},
    // Whatever is asked for: the drawer is shown one task and the result may
    // record another — a session written by a later build is exactly that case,
    // and it is one of the things under test here.
    resultOf: () => finished,
    resultsFor: () => [],
    stateOf: () => ({ status: 'idle' }),
    run: () => {},
    runAll: () => {},
    targets: () => [],
    targetCount: () => 0,
    readyTargets: async () => [],
    target: () => null,
    cancel: () => {},
  } as unknown as AnalysisRunner
}

interface Opened {
  el: HTMLElement
  button: HTMLButtonElement
  status(): string
  destroy(): void
}

function open(task: AnalysisTask, finished: TaskResult): Opened {
  const drawer = new AnalysisDrawer({
    runner: runnerWith(finished),
    context: () => CONTEXT,
    framing: () => framing(),
    onClose: () => {},
    hasLanes: () => true,
    writeProfile: () => Promise.resolve(),
  })
  document.body.appendChild(drawer.el)
  drawer.show(task)
  const button = Array.from(drawer.el.querySelectorAll('button')).find(
    (node) => node.textContent?.trim() === 'copy CLI command',
  )
  expect(button, 'the drawer has no copy CLI command button').toBeTruthy()
  return {
    el: drawer.el,
    button: button as HTMLButtonElement,
    // Three elements share the class — the estimate, the record line and the
    // status — and only the one carrying a message is visible, so the text of
    // whatever is not hidden is what a reader is actually being told.
    status: () =>
      Array.from(drawer.el.querySelectorAll('.analysis-note'))
        .filter((node) => !node.classList.contains('hidden'))
        .map((node) => node.textContent ?? '')
        .join(' '),
    destroy: () => drawer.destroy(),
  }
}

/**
 * Let the copy settle.
 *
 * A macrotask rather than a drained microtask queue: `copyTextToClipboard` is an
 * `async` function awaiting the clipboard write, and the status is set in a
 * `.then` on top of that, so counting the turns by hand is counting an
 * implementation detail of the thing under test.
 */
function settled(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

/** The command line, without the `#` notes above it. */
function commandOf(text: string): string {
  return text.split('\n').filter((line) => !line.startsWith('#'))[0] ?? ''
}

const insulation = taskById('insulation') as AnalysisTask
const metaplot = taskById('metaplot') as AnalysisTask

describe('the button', () => {
  it('is beside copy provenance, on the same row', () => {
    const view = open(insulation, result('insulation', { window: 10 }))
    const row = view.button.parentElement
    const labels = Array.from(row?.querySelectorAll('button') ?? []).map((node) =>
      node.textContent?.trim(),
    )
    expect(labels).toEqual(['copy provenance', 'copy CLI command'])
    view.destroy()
  })

  it('copies a command that names the task, the file and the parameters', async () => {
    const view = open(insulation, result('insulation', { window: 10, region: 'chrIV' }))
    view.button.click()
    await Promise.resolve()
    expect(copied).toHaveLength(1)
    const command = commandOf(copied[0])
    expect(command).toContain('metacooler-run insulation yeast.mcool::resolutions/1000')
    expect(command).toContain('--window 10')
    expect(command).toContain('--region chrIV')
    expect(command).toContain('--balance')
    view.destroy()
  })

  it('says it copied', async () => {
    const view = open(insulation, result('insulation', { window: 10 }))
    view.button.click()
    await settled()
    expect(view.status()).toContain('copied')
    view.destroy()
  })

  /**
   * The caveats travel with the command, as `#` lines a shell reads as nothing
   * — so a reader pasting into a script keeps the note next to the line it is
   * about. The status line counts them rather than repeating them, which is
   * what stops the drawer becoming a second place they can go stale.
   */
  it('carries what a shell cannot be told on the clipboard, and counts it', async () => {
    const view = open(
      insulation,
      result('insulation', { window: 10 }, { uri: 'https://example.org/yeast.mcool' }),
    )
    view.button.click()
    await settled()
    expect(copied[0].split('\n')[0].startsWith('# ')).toBe(true)
    expect(copied[0]).toContain('remote')
    expect(view.status()).toMatch(/1 note/)
    view.destroy()
  })
})

describe('a task the command cannot start', () => {
  it('is offered, disabled, in the command’s own words', () => {
    const refusal = cliCannotRun(metaplot)
    expect(refusal, 'metaplot reads a track and should be refused').not.toBeNull()
    const view = open(metaplot, result('metaplot', {}))
    expect(view.button.disabled).toBe(true)
    expect(view.button.title).toBe(refusal)
    view.destroy()
  })

  it('copies nothing when it is pressed anyway', async () => {
    const view = open(metaplot, result('metaplot', {}))
    view.button.click()
    await Promise.resolve()
    expect(copied).toHaveLength(0)
    view.destroy()
  })
})

describe('a task this build has never heard of', () => {
  /**
   * A result restored from a session a later build wrote. The flags are the
   * descriptor's, and there is no descriptor — so the button goes quiet rather
   * than guessing at them.
   */
  it('leaves the button disabled and says why', () => {
    const view = open(insulation, result('some-future-task', {}))
    expect(view.button.disabled).toBe(true)
    expect(view.button.title).toContain('some-future-task')
    view.destroy()
  })
})
