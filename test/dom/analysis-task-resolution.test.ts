// @vitest-environment jsdom
/**
 * A task's own *Resolution* row (§18.4).
 *
 * Every task that reads a map is run at the resolution picked in the crumb
 * row, else at the one the file was opened at — and any task can be run at
 * another rung of the ladder for itself. The row is the first thing in the
 * form, because every setting after it that counts in bins counts in its bins,
 * and it starts on the resolution the task would read anyway.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { taskById } from '@/analysis/registry'
import type { AnalysisContext, AnalysisFraming, AnalysisTask } from '@/analysis/types'
import { AnalysisWorkspace, type AnalysisWorkspaceHost, type TaskResolutions } from '@/analysis/workspace'
import { AnnotationStore } from '@/annotations/store'
import { setUpDom, type DomTeardown } from '../support/dom'

let teardown: DomTeardown

beforeEach(() => {
  teardown = setUpDom()
})

afterEach(() => {
  teardown()
})

function framing(binsize: number): AnalysisFraming {
  return {
    uri: `sample.mcool::resolutions/${binsize}`,
    label: '',
    binsize,
    binsPerCell: 1,
    rows: [0, 100],
    cols: [0, 100],
    balance: false,
    value: 'count',
    normalise: null,
    level: 'bin',
  }
}

/** A task that reads the map, with settings in bins. */
const TASK = taskById('insulation') as AnalysisTask

function bench(): { workspace: AnalysisWorkspace; chosen: number[]; drawer: HTMLElement } {
  const chosen: number[] = []
  let at = 10_000
  const context = (): AnalysisContext => ({
    uri: `sample.mcool::resolutions/${at}`,
    layout: 'cool',
    hasMap: true,
    hasGenomes: false,
    hasWeights: false,
    scoreColumns: [],
    binsize: at,
    nBins: 100,
    contigs: [{ name: 'chr1', startBin: 0, bins: 100, length: 1_000_000, genome: -1 }],
    genomes: null,
    entries: [],
    framing: framing(at),
    blockLoaded: false,
    blockBytes: 0,
  })
  const store = new AnnotationStore(`task-resolution|${Math.random()}`)
  store.clear()
  const resolutions = (): TaskResolutions => ({
    options: [5_000, 10_000, 25_000].map((binsize) => ({
      binsize,
      label: `${binsize / 1000} kb`,
      title: `${binsize} bp per bin`,
    })),
    value: at,
  })
  const host: AnalysisWorkspaceHost = {
    source: () => null,
    context,
    framing: () => framing(at),
    block: () => null,
    store: () => store,
    annotations: () => null,
    contigs: () => [],
    changed: () => {},
    resolutions,
    chooseResolution: (_task, binsize) => {
      chosen.push(binsize)
      at = binsize
    },
  }
  const workspace = new AnalysisWorkspace(host)
  document.body.append(workspace.drawerEl)
  return { workspace, chosen, drawer: workspace.drawerEl }
}

describe('a task’s Resolution row', () => {
  it('is the first row of the form, before every setting in bins', () => {
    const { workspace, drawer } = bench()
    workspace.show(TASK)
    const labels = [...drawer.querySelectorAll('.param-form .field-label')].map((node) => node.textContent)
    expect(labels[0]).toBe('Resolution')
    expect(labels.length).toBeGreaterThan(1)
    workspace.destroy()
  })

  it('starts on the resolution the task would read, and runs it at the one chosen', () => {
    const { workspace, chosen, drawer } = bench()
    workspace.show(TASK)
    const select = drawer.querySelector('select.res-task') as HTMLSelectElement
    expect(select.value).toBe('10000')
    expect([...select.options].map((option) => option.text)).toEqual(['5 kb', '10 kb', '25 kb'])
    select.value = '25000'
    select.dispatchEvent(new Event('change'))
    expect(chosen).toEqual([25_000])
    workspace.destroy()
  })

  it('is not drawn where the host offers no choice', () => {
    const { workspace, drawer } = bench()
    ;(workspace as unknown as { host: AnalysisWorkspaceHost }).host.resolutions = () => null
    workspace.show(TASK)
    expect(drawer.querySelector('select.res-task')).toBeNull()
    workspace.destroy()
  })
})
