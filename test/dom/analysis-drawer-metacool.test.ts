// @vitest-environment jsdom
/**
 * Where a per-bin result goes on a file that has no Annotations panel.
 *
 * §18.5 says a profile is a lane rather than a picture, and on a `.cool` that is
 * exactly right: it becomes a row on the Synthetic tracks card and inherits
 * colour, limits, edges, the tooltip and the 1D browser by being the same object
 * a bigWig is. A `.metacool` carries no annotations at all (§8.5), so it has no
 * such card — and three of the tasks offered on one produce per-bin vectors:
 * coverage and marginals, diamond insulation, and MAG purity's per-contig track.
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
  group: 'map',
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

/** A runner that has already finished — the drawer only reads from it. */
function runnerWith(finished: TaskResult): AnalysisRunner {
  return {
    subscribe: () => () => {},
    resultOf: (taskId: string) => (taskId === finished.provenance.task ? finished : null),
    stateOf: () => ({ status: 'idle' }),
    run: () => {},
    cancel: () => {},
  } as unknown as AnalysisRunner
}

function open(
  finished: TaskResult,
  hasLanes: boolean,
): { el: HTMLElement; wrote: Array<[string, string]>; destroy(): void } {
  const wrote: Array<[string, string]> = []
  const drawer = new AnalysisDrawer({
    runner: runnerWith(finished),
    context: () => CONTEXT,
    framing: () => FRAMING,
    onClose: () => {},
    hasLanes: () => hasLanes,
    writeProfile: (output, _provenance, format) => {
      wrote.push([output.id, format])
      return Promise.resolve()
    },
  })
  document.body.appendChild(drawer.el)
  drawer.show(TASK)
  return { el: drawer.el, wrote, destroy: () => drawer.destroy() }
}

describe('a profile on a file that has a Synthetic tracks card', () => {
  it('is described rather than drawn, and points at the card it is on', () => {
    const view = open(result([profile()]), true)
    const said = view.el.querySelector('.analysis-elsewhere')?.textContent ?? ''
    expect(said).toContain('Synthetic tracks card')
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
    for (const format of ['bigWig', 'bedGraph', 'TSV', 'PNG', 'PDF']) {
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
