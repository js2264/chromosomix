// @vitest-environment jsdom
/**
 * `copy CLI command`, beside `copy provenance`, on the run that just finished.
 *
 * `cli/main.ts` exists because clicking stops being the interface at the second
 * file. What it was missing was a way in: `chromosomix tasks` prints the
 * flags a task *takes*, which is a different question from what the reader just
 * did — so the twenty minutes of moving a window and nudging four numbers ended
 * in transcribing those numbers into a shell by eye, once per task. That is the
 * one step in the loop where the numbers in the figure and the numbers in the
 * table can quietly stop being the same numbers.
 *
 * The button is here rather than on a synthetic track's row because the run is
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
import { defaultStyle, emptyPlacement } from '@/annotations/types'
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
  // A track and a feature set, so a task that reads either has a file to name.
  entries: [
    {
      id: 't1',
      card: 'linear',
      kind: 'track',
      label: 'ATAC',
      source: { kind: 'remote', url: 'https://example.org/Yeast_ATAC.bw', name: 'Yeast_ATAC.bw' },
      status: 'ready',
      visible: true,
      placement: emptyPlacement(),
      style: defaultStyle('track', '#000000'),
    },
    {
      id: 'a1',
      card: 'linear',
      kind: 'segments',
      label: 'peaks',
      source: { kind: 'remote', url: 'https://example.org/peaks.bed', name: 'peaks.bed' },
      status: 'ready',
      visible: true,
      placement: emptyPlacement(),
      style: defaultStyle('segments', '#000000'),
    },
  ],
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
    // One run, which is what a suite about the *command* for a result needs:
    // the history stepper appears only past two and is `analysis-runs`'s.
    runsOf: () => [finished],
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
    const view = open(insulation, result('insulation', { window: 10, sequences: ['chrIV'] }))
    view.button.click()
    await Promise.resolve()
    expect(copied).toHaveLength(1)
    const command = commandOf(copied[0])
    expect(command).toContain('chromosomix insulation yeast.mcool::resolutions/1000')
    expect(command).toContain('--window 10')
    // `--sequences`, where this read `--region chrIV`: insulation asks which
    // sequences to run on with the same tick boxes as compartments, and a list
    // is written comma-separated for a shell.
    expect(command).toContain('--sequences chrIV')
    // Balanced, which a shell reads by default wherever the file carries weights
    // and so goes unsaid; only an unbalanced run writes `--no-balance` (§23.1).
    expect(command).not.toContain('balance')
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
  it('carries a caveat on the clipboard, and counts it', async () => {
    // A reproducibility run whose record does not name the maps it compared.
    const hicrep = taskById('hicrep') as AnalysisTask
    const view = open(hicrep, result('hicrep', {}))
    view.button.click()
    await settled()
    expect(copied[0].split('\n')[0].startsWith('# ')).toBe(true)
    expect(copied[0]).toContain('--against')
    expect(view.status()).toMatch(/1 note/)
    view.destroy()
  })
})

describe('a task that reads a track', () => {
  /**
   * Offered like any other. The bigWig reader lived in the annotations worker
   * alone and the button was greyed with a sentence saying so; `cli/tracks.ts`
   * opens the file for the shell now, so the line is copied and it loads the
   * track under the parameter that names it.
   */
  it('is enabled, and copies the track as the flag that loads it', async () => {
    const view = open(metaplot, result('metaplot', { tracks: ['t1'], features: 'a1' }))
    expect(view.button.disabled).toBe(false)
    view.button.click()
    await Promise.resolve()
    expect(copied).toHaveLength(1)
    const command = commandOf(copied[0])
    expect(command.startsWith('chromosomix metaplot yeast.mcool')).toBe(true)
    expect(command).toContain('--tracks Yeast_ATAC.bw')
    expect(command).toContain('--features peaks.bed')
    view.destroy()
  })
})

describe('a run with no contact map behind it', () => {
  /**
   * A 1D browser session (§5.8) has the bigWigs and not the map, so a result
   * there is framed against the assembly over a zero-wide extent. The command
   * used to open a contact map as its first argument and there was none here to
   * name, so the button was greyed. `chromosomix` runs a track task with no
   * positional now, and the line says so by having none.
   */
  const overlap = taskById('overlap') as AnalysisTask

  it('is enabled, and copies a line with no file to open', async () => {
    const view = open(overlap, result('overlap', {}, { rows: [0, 0], cols: [0, 0] }))
    expect(view.button.disabled).toBe(false)
    view.button.click()
    await Promise.resolve()
    expect(copied).toHaveLength(1)
    const command = commandOf(copied[0])
    expect(command.startsWith('chromosomix overlap')).toBe(true)
    expect(command).not.toContain('yeast.mcool')
    view.destroy()
  })

  it('names the file again for the same task over a map', async () => {
    const view = open(overlap, result('overlap', {}))
    view.button.click()
    await Promise.resolve()
    expect(commandOf(copied[0])).toContain('yeast.mcool')
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
