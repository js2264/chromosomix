// @vitest-environment jsdom
/**
 * The box over the Analysis column's task list (§18.1).
 *
 * Thirty tasks in four cards is a list read top to bottom by somebody who
 * already knows the one they want. The box narrows it to the tasks a reader
 * names — by title, by what the task is for, or by another name for it, the
 * descriptor's `keywords` (*TAD* for insulation, *pileup* for APA) — takes away
 * a card with nothing left in it, says so where nothing is left at all, and
 * gives the list back on Escape.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { AnalysisContext, AnalysisFraming } from '@/analysis/types'
import type { BedGraphContig } from '@/analysis/write/bedgraph'
import { AnalysisWorkspace, type AnalysisWorkspaceHost } from '@/analysis/workspace'
import { AnnotationStore } from '@/annotations/store'
import { setUpDom, type DomTeardown } from '../support/dom'

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

function panel(): { el: HTMLElement; box: HTMLInputElement; workspace: AnalysisWorkspace } {
  const store = new AnnotationStore(`filter|${Math.random()}`, { persist: false })
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
    blocked: () => null,
  }
  const workspace = new AnalysisWorkspace(host)
  document.body.append(workspace.panelEl, workspace.drawerEl)
  const box = workspace.panelEl.querySelector<HTMLInputElement>('input.analysis-filter')
  if (box === null) throw new Error('no filter box')
  return { el: workspace.panelEl, box, workspace }
}

const type = (box: HTMLInputElement, text: string): void => {
  box.value = text
  box.dispatchEvent(new Event('input'))
}

/** The titles of the rows left on screen. */
function shown(root: HTMLElement): string[] {
  return [...root.querySelectorAll<HTMLElement>('.analysis-row')]
    .filter((row) => !row.classList.contains('is-filtered-out'))
    .map((row) => row.querySelector('.analysis-row-title')?.textContent ?? '')
}

/** The headings of the cards left on screen. */
function cards(root: HTMLElement): string[] {
  return [...root.querySelectorAll<HTMLElement>('.analysis-card')]
    .filter((card) => !card.classList.contains('is-filtered-out'))
    .map((card) => card.querySelector('.card-title, h3, .card-head')?.textContent?.trim() ?? '')
}

describe('the box over the task list', () => {
  it('is offered with the count it can narrow', () => {
    const { el, box } = panel()
    const rows = el.querySelectorAll('.analysis-row').length
    expect(rows).toBeGreaterThan(10)
    expect(box.placeholder).toBe(`filter ${rows} tasks…`)
    expect(shown(el)).toHaveLength(rows)
  })

  it('narrows the list by a word of the title or of what the task is for', () => {
    const { el, box } = panel()
    type(box, 'insulation')
    expect(shown(el)).toEqual(['Diamond insulation'])
    type(box, 'boundaries')
    expect(shown(el)).toEqual(expect.arrayContaining(['Diamond insulation']))
  })

  it('finds a task by another name for it', () => {
    const { el, box } = panel()
    type(box, 'TAD')
    expect([...shown(el)].sort()).toEqual(['Diamond insulation', 'Directionality index'])
    type(box, 'pileup')
    expect(shown(el)).toEqual(['Aggregate peak analysis'])
    type(box, 'a/b')
    expect(shown(el)).toContain('Compartments')
  })

  it('wants every word typed, and takes away a card with nothing left in it', () => {
    const { el, box } = panel()
    type(box, 'model map')
    expect(shown(el).every((title) => /model/i.test(title) || /map/i.test(title))).toBe(true)
    expect(cards(el).length).toBeLessThan(el.querySelectorAll('.analysis-card').length)
  })

  it('says where nothing is left, and gives the whole list back on Escape', () => {
    const { el, box } = panel()
    const rows = el.querySelectorAll('.analysis-row').length
    type(box, 'nothing like this')
    expect(shown(el)).toEqual([])
    const none = el.querySelector('.analysis-no-match')
    expect(none?.classList.contains('hidden')).toBe(false)
    expect(none?.textContent).toBe('No task matches “nothing like this”.')
    box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    expect(box.value).toBe('')
    expect(shown(el)).toHaveLength(rows)
    expect(none?.classList.contains('hidden')).toBe(true)
  })

  it('keeps the narrowing through a repaint of the list', () => {
    const { el, box, workspace } = panel()
    type(box, 'scalogram')
    workspace.refresh()
    expect(shown(el)).toEqual(['Scalogram'])
  })
})
