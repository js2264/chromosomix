// @vitest-environment jsdom
/**
 * Where a per-bin result goes on a session that has no Tracks card for it.
 *
 * §18.5 says a profile is a lane rather than a picture, and on a map with its
 * Annotations column that is exactly right: it becomes a row on the Tracks card,
 * marked `*`, and inherits colour, limits, edges, the tooltip and the 1D browser
 * by being the same object a bigWig is. A host with no annotation layer has no
 * such card — which was every `.metacool` until §8.5 gave them the cards, and is
 * still the drawer's other branch (`hasLanes`) — and three of the tasks offered
 * there produce per-bin vectors: coverage and marginals, diamond insulation, and
 * MAG purity's per-contig track.
 *
 * What used to happen there was the worst of the available outcomes. The task
 * was priced, run and reported as finished, and the drawer printed a sentence
 * saying the numbers were "on the Synthetic tracks card in the Annotations
 * panel, with the colour, limits, edges and figure every other track has" — a
 * card that is not on screen, about numbers that had been dropped. §18.7's
 * headline claim, that every output leaves as bigWig, bedGraph, BED, TSV, PNG
 * and vector PDF, was false on that layout.
 *
 * So this pins both halves: with a lane card the sentence is right and the
 * drawer stays out of the way; without one the drawer draws the profile and
 * carries the exports the row would have carried.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { AnalysisRunner } from '@/analysis/runner'
import type {
  AnalysisContext,
  AnalysisFraming,
  AnalysisTask,
  ProfileOutput,
  TaskResult,
} from '@/analysis/types'
import { READY } from '@/analysis/types'
import { FeatureBuilder } from '@/annotations/featureset'
import { AnalysisDrawer } from '@/ui/AnalysisDrawer'
import { buttonLabels, setUpDom, type DomTeardown } from '../support/dom'

let teardown: DomTeardown

beforeEach(() => {
  teardown = setUpDom()
})

afterEach(() => {
  teardown()
})

const TASK: AnalysisTask = {
  id: 'coverage',
  title: 'Coverage and marginals',
  blurb: 'How much contact each bin carries.',
  group: '2d',
  venue: 'analysis',
  version: 1,
  availability: () => READY,
  params: [],
  outputs: ['profile'],
  estimate: () => ({ class: 'free', requests: 0, bytes: 0, note: 'free' }),
}

const FRAMING: AnalysisFraming = {
  uri: 'community.metacool',
  label: 'whole genome at 10 kb',
  binsize: 10_000,
  binsPerCell: 1,
  rows: [0, 400],
  cols: [0, 400],
  balance: false,
  value: '',
  normalise: null,
  level: 'bin',
}

const CONTEXT: AnalysisContext = {
  uri: 'community.metacool',
  layout: 'metacool',
  hasMap: true,
  hasGenomes: true,
  hasWeights: false,
  scoreColumns: [],
  binsize: 10_000,
  nBins: 400,
  contigs: [],
  genomes: null,
  entries: [],
  framing: FRAMING,
  blockLoaded: true,
  blockBytes: 0,
}

function profile(): ProfileOutput {
  const values = new Float32Array(400)
  for (let i = 0; i < values.length; i++) values[i] = Math.sin(i / 20) + 2
  return {
    kind: 'profile',
    id: 'coverage-total',
    label: 'Total coverage',
    values,
    extent: [0, 400],
    binsize: 10_000,
    unit: 'contacts',
  }
}

function result(outputs: TaskResult['outputs']): TaskResult {
  return {
    outputs,
    notes: [],
    ms: 12,
    provenance: {
      task: 'coverage',
      taskVersion: 1,
      params: {},
      framing: FRAMING,
      createdAt: '2026-08-10T00:00:00Z',
      app: 'test',
    },
  }
}

/** A map of a deck, as the runner reports one. */
interface FakeTarget {
  map: string
  uri: string
  label: string
}

/** A runner that has already finished — the drawer only reads from it. */
function runnerWith(finished: TaskResult, deck: readonly FakeTarget[] = []): AnalysisRunner {
  return {
    subscribe: () => () => {},
    resultOf: (taskId: string) => (taskId === finished.provenance.task ? finished : null),
    // One map's worth: this suite is about a `.metacool`, which has one. The
    // deck-tab behaviour is `analysis-maps.test.ts`'s.
    resultsFor: (taskId: string) =>
      taskId === finished.provenance.task && deck.length > 0
        ? [{ target: deck[0], result: finished }]
        : [],
    // One run of it, so no history stepper — that control is `analysis-runs`'s.
    runsOf: (taskId: string) => (taskId === finished.provenance.task ? [finished] : []),
    stateOf: () => ({ status: 'idle' }),
    run: () => {},
    runAll: () => {},
    // Empty is one map, so the drawer offers no batch — see
    // `AnalysisRunner.targets`.
    targets: () => deck,
    // The batch button counts the grid and waits for it; see `AnalysisRunner`.
    targetCount: () => deck.length,
    readyTargets: async () => deck,
    // The starred one, which on this deck is the second.
    target: () => deck[1] ?? null,
    cancel: () => {},
  } as unknown as AnalysisRunner
}

function open(
  finished: TaskResult,
  hasLanes: boolean,
  deck: readonly FakeTarget[] = [],
): {
  el: HTMLElement
  wrote: Array<[string, string]>
  closes: number
  destroy(): void
} {
  const wrote: Array<[string, string]> = []
  let closes = 0
  const drawer = new AnalysisDrawer({
    runner: runnerWith(finished, deck),
    context: () => CONTEXT,
    framing: () => FRAMING,
    onClose: () => {
      closes++
    },
    hasLanes: () => hasLanes,
    writeProfile: (output, _provenance, format) => {
      wrote.push([output.id, format])
      return Promise.resolve()
    },
  })
  document.body.appendChild(drawer.el)
  drawer.show(TASK)
  return {
    el: drawer.el,
    wrote,
    get closes() {
      return closes
    },
    destroy: () => drawer.destroy(),
  }
}

describe('a profile on a file that has a Tracks card for it', () => {
  it('is described rather than drawn, and points at the card it is on', () => {
    const view = open(result([profile()]), true)
    const said = view.el.querySelector('.analysis-elsewhere')?.textContent ?? ''
    expect(said).toContain('Tracks card')
    expect(said).not.toContain('Synthetic tracks card')
    expect(view.el.querySelectorAll('.analysis-figure')).toHaveLength(0)
    // TSV and nothing else: the row's own export row carries the rest.
    expect(buttonLabels(view.el)).toContain('TSV')
    expect(buttonLabels(view.el)).not.toContain('bigWig')
    view.destroy()
  })
})

describe('a profile on a file that has no annotation layer', () => {
  it('is drawn here instead', () => {
    const view = open(result([profile()]), false)
    expect(view.el.querySelectorAll('.analysis-figure')).toHaveLength(1)
    expect(view.el.querySelector('.analysis-elsewhere')).toBeNull()
    expect(view.el.querySelector('.analysis-figure-title')?.textContent).toBe('Total coverage')
    view.destroy()
  })

  /** §18.7's headline, on the layout where it was false. */
  it('offers every format the card would have offered', () => {
    const view = open(result([profile()]), false)
    const labels = buttonLabels(view.el)
    for (const format of ['bigWig', 'bedGraph', 'TSV', 'PNG', 'PDF', 'Copy']) {
      expect(labels).toContain(format)
    }
    view.destroy()
  })

  it('writes the profile through the workspace, which knows the assembly', () => {
    const view = open(result([profile()]), false)
    const click = (label: string): void => {
      const node = [...view.el.querySelectorAll('button')].find(
        (button) => (button.textContent ?? '').trim() === label,
      )
      node?.click()
    }
    click('bigWig')
    click('bedGraph')
    expect(view.wrote).toEqual([
      ['coverage-total', 'bigwig'],
      ['coverage-total', 'bedgraph'],
    ])
    view.destroy()
  })

  /**
   * A called interval set has no picture either way — its numbers *are* its
   * coordinates — so it keeps the sentence. What it must not keep is the claim
   * about a panel that is not there.
   */
  it('tells the truth about where called intervals went', () => {
    const build = new FeatureBuilder()
    build.add('contig_1', 100, 200, { name: 'boundary' })
    const intervals = result([
      {
        kind: 'intervals',
        id: 'flagged',
        label: 'Contigs to look at',
        payload: { kind: 'features', data: build.finish() },
      },
    ])

    const without = open(intervals, false)
    const said = without.el.querySelector('.analysis-elsewhere')?.textContent ?? ''
    expect(said).toContain('no annotation layer')
    expect(said).not.toContain('Annotations panel')
    expect(buttonLabels(without.el)).toContain('BED')
    without.destroy()

    const with_ = open(intervals, true)
    expect(with_.el.querySelector('.analysis-elsewhere')?.textContent ?? '').toContain(
      'Annotations panel',
    )
    with_.destroy()
  })
})

describe('the drawer as a whole', () => {
  it('says a run produced nothing rather than showing an empty panel', () => {
    const view = open(result([]), false)
    expect(view.el.querySelector('.analysis-elsewhere')?.textContent ?? '').toContain(
      'no output',
    )
    view.destroy()
  })

  it('does not leak its element when it is destroyed', () => {
    const view = open(result([profile()]), false)
    expect(document.body.contains(view.el)).toBe(true)
    view.destroy()
    expect(document.body.contains(view.el)).toBe(false)
  })
})

/**
 * Escape puts the drawer down.
 *
 * Not a modal's Escape, which cancels the question and throws the answer away:
 * this one is the ✕, said with the key every other overlay in the application is
 * dismissed by. Whatever is running keeps running, and the panel row goes on
 * reporting it — which is the whole reason it can be a dismissal at all.
 */
describe('the Escape key', () => {
  const escape = (over?: HTMLElement): void => {
    ;(over ?? document.body).dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
  }

  it('closes the drawer, and tells the owner', () => {
    const view = open(result([profile()]), false)
    expect(view.el.classList.contains('collapsed')).toBe(false)
    escape()
    expect(view.el.classList.contains('collapsed')).toBe(true)
    expect(view.closes).toBe(1)
    view.destroy()
  })

  it('does nothing when the drawer is already down', () => {
    const view = open(result([profile()]), false)
    escape()
    escape()
    expect(view.closes).toBe(1)
    view.destroy()
  })

  it('leaves the key to a field the reader is typing in', () => {
    const view = open(result([profile()]), false)
    const box = document.createElement('input')
    box.type = 'text'
    view.el.appendChild(box)
    box.focus()
    escape(box)
    // A half-typed anchor abandoned with Escape means *that box*, and a panel
    // that vanished from under the reader would take the form with it.
    expect(view.el.classList.contains('collapsed')).toBe(false)
    expect(view.closes).toBe(0)

    // …and with the focus off the field, the same key closes as usual.
    box.blur()
    escape()
    expect(view.closes).toBe(1)
    view.destroy()
  })

  it('leaves the key to whatever handled it first', () => {
    const view = open(result([profile()]), false)
    const event = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
    // A marquee on the map and a caret in the legend both answer Escape before
    // this does; a drawer that closed as well would make one key do two things.
    event.preventDefault()
    document.body.dispatchEvent(event)
    expect(view.closes).toBe(0)
    view.destroy()
  })

  it('stops listening once it is gone', () => {
    const view = open(result([profile()]), false)
    view.destroy()
    escape()
    expect(view.closes).toBe(0)
  })
})

/**
 * What Run says it is about.
 *
 * `run` is a complete sentence beside one map and dangerously incomplete beside
 * five: the reader has one starred and four not, the difference is a small
 * filled star in each heading, and a button saying only `run` gives them nothing
 * to check that against before spending a minute of compute.
 */
describe('the Run button’s label', () => {
  const DECK: FakeTarget[] = [
    { map: 'lead', uri: 'first.cool', label: 'first.cool' },
    { map: 'p1', uri: 'rep2.cool', label: 'rep2.cool' },
  ]

  function runButton(el: HTMLElement): HTMLButtonElement {
    const node = [...el.querySelectorAll<HTMLButtonElement>('button')].find((button) =>
      (button.textContent ?? '').trim().startsWith('run'),
    )
    if (node === undefined) throw new Error('no run button')
    return node
  }

  it('is plain `run` while there is one map', () => {
    // No star on screen for a mark to point at, so a mark would be a control the
    // reader has to go looking for.
    const view = open(result([profile()]), true)
    const node = runButton(view.el)
    expect((node.textContent ?? '').trim()).toBe('run')
    expect(node.querySelector('svg')).toBeNull()
    view.destroy()
  })

  it('carries the deck’s own star once there is more than one', () => {
    const view = open(result([profile()]), true, DECK)
    const node = runButton(view.el)
    expect((node.textContent ?? '').trim()).toBe('run on')
    // The same mark the headings carry, filled — the reader is already reading
    // the deck by it.
    expect(node.querySelector('svg.run-star')).not.toBeNull()
    view.destroy()
  })

  it('names the starred map where there is room for a name', () => {
    const view = open(result([profile()]), true, DECK)
    // The star is on the companion, so that is what a press measures — and the
    // tooltip is where somebody who does not yet know what the mark means looks.
    expect(runButton(view.el).title).toContain('rep2.cool')
    expect(runButton(view.el).title).toContain('starred map')
    view.destroy()
  })
})
