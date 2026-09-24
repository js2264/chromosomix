// @vitest-environment jsdom
/**
 * The Analysis column while a deck has **no map starred** (§18.1).
 *
 * A task reads one map and the star is how that map is named, so with none
 * starred there is nothing for a task to run against — and nothing is guessed
 * for the reader. Every row is greyed, the reason is said once above the
 * cards rather than under each of twenty rows, and the drawer's Run refuses
 * with the same sentence. Starring a map puts it all back.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { AnalysisContext, AnalysisFraming } from '@/analysis/types'
import type { BedGraphContig } from '@/analysis/write/bedgraph'
import { AnalysisWorkspace, type AnalysisWorkspaceHost } from '@/analysis/workspace'
import { AnnotationStore } from '@/annotations/store'
import { all, setUpDom, type DomTeardown } from '../support/dom'

let teardown: DomTeardown

beforeEach(() => {
  teardown = setUpDom()
})

afterEach(() => {
  teardown()
})

const CONTIGS: BedGraphContig[] = [{ name: 'chr1', startBin: 0, bins: 8, length: 8000 }]

function framing(): AnalysisFraming {
  return {
    uri: 'lead.cool',
    label: 'chr1 at 1 kb',
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

function context(): AnalysisContext {
  return {
    uri: 'lead.cool',
    layout: 'cool',
    hasMap: true,
    hasGenomes: false,
    hasWeights: false,
    scoreColumns: [],
    binsize: 1000,
    nBins: 8,
    contigs: CONTIGS.map((contig) => ({ ...contig, genome: 0 })),
    genomes: [],
    entries: [],
    framing: framing(),
    blockLoaded: false,
    blockBytes: 0,
  } as unknown as AnalysisContext
}

const SENTENCE = 'No map is starred, so no task can run.'

function bench(): { workspace: AnalysisWorkspace; unstar(on: boolean): void } {
  let blocked = false
  const store = new AnnotationStore(`no-star|${Math.random()}`, { persist: false })
  const host: AnalysisWorkspaceHost = {
    source: () => null,
    context: () => context(),
    framing: () => framing(),
    block: () => null,
    store: () => store,
    annotations: () => null,
    contigs: () => CONTIGS,
    carried: () => [],
    changed: () => {},
    blocked: () => (blocked ? SENTENCE : null),
  }
  const workspace = new AnalysisWorkspace(host)
  document.body.append(workspace.panelEl, workspace.drawerEl)
  return {
    workspace,
    unstar: (on) => {
      blocked = on
      workspace.refresh()
    },
  }
}

function warning(workspace: AnalysisWorkspace): HTMLElement | null {
  return workspace.panelEl.querySelector<HTMLElement>('.analysis-blocked')
}

describe('the Analysis column with no map starred', () => {
  it('says nothing, and greys nothing it would not have, while a map is starred', () => {
    const { workspace } = bench()
    expect(warning(workspace)?.classList.contains('hidden')).toBe(true)
    const rows = all<HTMLElement>(workspace.panelEl, '.analysis-row')
    expect(rows.length).toBeGreaterThan(0)
    expect(rows.some((row) => !row.classList.contains('is-waiting'))).toBe(true)
  })

  it('greys every task and says why, once, above the cards', () => {
    const { workspace, unstar } = bench()
    unstar(true)
    expect(warning(workspace)?.classList.contains('hidden')).toBe(false)
    expect(warning(workspace)?.textContent).toBe(SENTENCE)
    const rows = all<HTMLElement>(workspace.panelEl, '.analysis-row')
    expect(rows.every((row) => row.classList.contains('is-waiting'))).toBe(true)
    expect(rows.every((row) => row.title === SENTENCE)).toBe(true)
    expect(rows.every((row) => row.getAttribute('aria-disabled') === 'true')).toBe(true)
    // Not a second, third and twentieth time under each heading and row.
    const lines = all<HTMLElement>(workspace.panelEl, '.analysis-group-needs, .analysis-row-needs')
    expect(lines.every((line) => line.classList.contains('hidden'))).toBe(true)
  })

  it('refuses Run with the same sentence where a drawer was already open', () => {
    const { workspace, unstar } = bench()
    const row = all<HTMLElement>(workspace.panelEl, '.analysis-row').find(
      (node) => !node.classList.contains('is-waiting'),
    )
    row?.click()
    unstar(true)
    const run = all<HTMLButtonElement>(workspace.drawerEl, 'button').find((node) =>
      (node.textContent ?? '').startsWith('run'),
    )
    expect(run?.disabled).toBe(true)
    expect(workspace.drawerEl.querySelector('.analysis-refusal')?.textContent).toBe(SENTENCE)
  })

  it('puts every task back the moment a map is starred again', () => {
    const { workspace, unstar } = bench()
    unstar(true)
    unstar(false)
    expect(warning(workspace)?.classList.contains('hidden')).toBe(true)
    const rows = all<HTMLElement>(workspace.panelEl, '.analysis-row')
    expect(rows.some((row) => !row.classList.contains('is-waiting'))).toBe(true)
  })
})
