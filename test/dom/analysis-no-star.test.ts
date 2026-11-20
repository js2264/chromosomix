// @vitest-environment jsdom
/**
 * The Analysis column while a deck has **no map starred** (§18.1).
 *
 * A task that reads a map reads one, and the star is how that map is named, so
 * with none starred a plain Run has nothing to run against — and nothing is
 * guessed for the reader. On a deck of two maps or more, *run on all* names
 * every map, so it runs: no row is greyed, the column says once above the cards
 * that the batch is what runs, and the drawer's `run on ★` is greyed with that
 * sentence. On a deck of one map there is no batch to offer, so every such row
 * is greyed, the reason is said once above the cards rather than under each of
 * twenty rows, and the drawer's Run refuses with the same sentence. The 1D tasks
 * read only the tracks, so the star's absence is nothing to them: they keep
 * their own answer, and run. Starring a map puts it all back.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { RunTarget } from '@/analysis/runner'
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

/** Two bigWigs, which is all Track correlation needs to be ready. */
const TRACKS = [
  { id: 'atac', kind: 'track', label: 'ATAC.bw' },
  { id: 'polii', kind: 'track', label: 'PolII.bw' },
]

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
    entries: TRACKS,
    framing: framing(),
    blockLoaded: false,
    blockBytes: 0,
  } as unknown as AnalysisContext
}

const SENTENCE = 'No map is starred, so no task can run.'
const BATCH = 'No map is starred, so a task that reads a map runs on every map at once.'

/** Two maps, which is what a batch needs to be offered. */
const MAPS: RunTarget[] = [
  { map: 'lead', uri: 'lead.cool', label: 'lead.cool' },
  { map: 'p1', uri: 'rep2.cool', label: 'rep2.cool' },
]

/**
 * A workspace whose deck can lose its star: `unstar(true)` on a deck of one map,
 * where nothing that reads a map runs; `unstar('several')` on a deck of two,
 * where the batch does; `unstar(false)` stars one again.
 */
function bench(): { workspace: AnalysisWorkspace; unstar(on: boolean | 'several'): void } {
  let state: boolean | 'several' = false
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
    blocked: () => (state === true ? SENTENCE : null),
    batchOnly: () => (state === 'several' ? BATCH : null),
    allTargets: () => (state === true ? MAPS.slice(0, 1) : MAPS),
    allTargetsReady: async () => (state === true ? MAPS.slice(0, 1) : MAPS),
    targetCount: () => (state === true ? 1 : MAPS.length),
  }
  const workspace = new AnalysisWorkspace(host)
  document.body.append(workspace.panelEl, workspace.drawerEl)
  return {
    workspace,
    unstar: (on) => {
      state = on
      workspace.refresh()
    },
  }
}

/** The drawer's buttons in its run row. */
function runRow(workspace: AnalysisWorkspace): HTMLButtonElement[] {
  return all<HTMLButtonElement>(workspace.drawerEl, '.analysis-run button')
}

function warning(workspace: AnalysisWorkspace): HTMLElement | null {
  return workspace.panelEl.querySelector<HTMLElement>('.analysis-blocked')
}

/** The rows under the 1D card's heading, and the rows under every other. */
function rowsByCard(workspace: AnalysisWorkspace): { tracks: HTMLElement[]; maps: HTMLElement[] } {
  const tracks: HTMLElement[] = []
  const maps: HTMLElement[] = []
  for (const card of all<HTMLElement>(workspace.panelEl, '.analysis-card')) {
    const heading = card.querySelector('.card-head')?.textContent ?? ''
    ;(heading.startsWith('1D tasks') ? tracks : maps).push(...all<HTMLElement>(card, '.analysis-row'))
  }
  return { tracks, maps }
}

function rowTitled(workspace: AnalysisWorkspace, title: string): HTMLElement | undefined {
  return all<HTMLElement>(workspace.panelEl, '.analysis-row').find(
    (row) => row.querySelector('.analysis-row-title')?.textContent === title,
  )
}

describe('the Analysis column with no map starred, on a deck of one map', () => {
  it('says nothing, and greys nothing it would not have, while a map is starred', () => {
    const { workspace } = bench()
    expect(warning(workspace)?.classList.contains('hidden')).toBe(true)
    const rows = all<HTMLElement>(workspace.panelEl, '.analysis-row')
    expect(rows.length).toBeGreaterThan(0)
    expect(rows.some((row) => !row.classList.contains('is-waiting'))).toBe(true)
  })

  it('greys every task that reads a map and says why, once, above the cards', () => {
    const { workspace, unstar } = bench()
    unstar(true)
    expect(warning(workspace)?.classList.contains('hidden')).toBe(false)
    expect(warning(workspace)?.textContent).toBe(SENTENCE)
    const { maps } = rowsByCard(workspace)
    expect(maps.length).toBeGreaterThan(0)
    expect(maps.every((row) => row.classList.contains('is-waiting'))).toBe(true)
    expect(maps.every((row) => row.title === SENTENCE)).toBe(true)
    expect(maps.every((row) => row.getAttribute('aria-disabled') === 'true')).toBe(true)
    // Not a second, third and twentieth time under each heading and row.
    const lines = all<HTMLElement>(workspace.panelEl, '.analysis-group-needs, .analysis-row-needs')
    expect(lines.every((line) => (line.textContent ?? '') !== SENTENCE)).toBe(true)
  })

  it('leaves the 1D tasks their own answer, since they read no map', () => {
    const { workspace, unstar } = bench()
    unstar(true)
    const { tracks } = rowsByCard(workspace)
    expect(tracks.length).toBeGreaterThan(0)
    expect(tracks.every((row) => row.title !== SENTENCE)).toBe(true)
    // Two bigWigs are loaded, which is what a correlation of tracks waits for.
    const correlation = rowTitled(workspace, 'Track correlation')
    expect(correlation?.classList.contains('is-waiting')).toBe(false)
  })

  it('refuses Run with the same sentence where a drawer was already open', () => {
    const { workspace, unstar } = bench()
    const { maps } = rowsByCard(workspace)
    const row = maps.find((node) => !node.classList.contains('is-waiting'))
    row?.click()
    unstar(true)
    const run = all<HTMLButtonElement>(workspace.drawerEl, 'button').find((node) =>
      (node.textContent ?? '').startsWith('run'),
    )
    expect(run?.disabled).toBe(true)
    expect(workspace.drawerEl.querySelector('.analysis-refusal')?.textContent).toBe(SENTENCE)
  })

  it('runs a 1D task all the same, with nothing refused', () => {
    const { workspace, unstar } = bench()
    unstar(true)
    rowTitled(workspace, 'Track correlation')?.click()
    // Both bigWigs ticked: the task's own refusal is that it has fewer than two.
    for (const box of all<HTMLInputElement>(workspace.drawerEl, '.analysis-form input[type=checkbox]')) {
      if (!box.checked) box.click()
    }
    const run = all<HTMLButtonElement>(workspace.drawerEl, '.analysis-run button').find(
      (node) => (node.textContent ?? '').trim() === 'run',
    )
    expect(run?.disabled).toBe(false)
    expect(workspace.drawerEl.querySelector('.analysis-refusal')).toBeNull()
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

describe('the Analysis column with no map starred, on a deck of several maps', () => {
  it('greys no task that reads a map, and says once that the batch is what runs', () => {
    const { workspace, unstar } = bench()
    const before = all<HTMLElement>(workspace.panelEl, '.analysis-row').map((row) =>
      row.classList.contains('is-waiting'),
    )
    unstar('several')
    expect(warning(workspace)?.classList.contains('hidden')).toBe(false)
    expect(warning(workspace)?.textContent).toBe(BATCH)
    const after = all<HTMLElement>(workspace.panelEl, '.analysis-row').map((row) =>
      row.classList.contains('is-waiting'),
    )
    expect(after).toEqual(before)
    const { maps } = rowsByCard(workspace)
    expect(maps.some((row) => row.title === BATCH || row.title === SENTENCE)).toBe(false)
    // Said above the cards, not again under a heading or a row.
    const lines = all<HTMLElement>(workspace.panelEl, '.analysis-group-needs, .analysis-row-needs')
    expect(lines.every((line) => (line.textContent ?? '') !== BATCH)).toBe(true)
  })

  it('greys run on the star with the reason, and runs on every map', async () => {
    const { workspace, unstar } = bench()
    const { maps } = rowsByCard(workspace)
    maps.find((node) => !node.classList.contains('is-waiting'))?.click()
    unstar('several')
    const run = runRow(workspace).find((node) => (node.textContent ?? '').trim() === 'run on')
    const batch = runRow(workspace).find((node) => (node.textContent ?? '').startsWith('run on all'))
    expect(run?.disabled).toBe(true)
    expect(run?.title).toBe(BATCH)
    expect(batch?.classList.contains('hidden')).toBe(false)
    expect(batch?.textContent).toBe('run on all 2 maps')
    expect(batch?.disabled).toBe(false)
    // No refusal in the price's place: the batch is going to happen.
    expect(workspace.drawerEl.querySelector('.analysis-refusal')).toBeNull()
  })

  it('puts the plain run back the moment a map is starred again', () => {
    const { workspace, unstar } = bench()
    const { maps } = rowsByCard(workspace)
    maps.find((node) => !node.classList.contains('is-waiting'))?.click()
    unstar('several')
    unstar(false)
    expect(warning(workspace)?.classList.contains('hidden')).toBe(true)
    const run = runRow(workspace).find((node) => (node.textContent ?? '').trim().startsWith('run on'))
    expect(run?.title).not.toBe(BATCH)
  })
})
