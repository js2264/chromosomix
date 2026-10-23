// @vitest-environment jsdom
/**
 * The `?` on the Analysis column's rows (`ui/taskReference.ts`): on a task that
 * re-implements something, green where the validation agrees and the text's
 * colour where it is untested, absent elsewhere; a mark rather than a control,
 * whose tip names the method and links its DOI, and a press on which opens no
 * task.
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

function panel(): HTMLElement {
  const store = new AnnotationStore(`refs|${Math.random()}`, { persist: false })
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
  return workspace.panelEl
}

function row(root: HTMLElement, title: string): HTMLElement {
  const found = [...root.querySelectorAll<HTMLElement>('.analysis-row')].find(
    (one) => one.querySelector('.analysis-row-title')?.textContent === title,
  )
  if (found === undefined) throw new Error(`no row ${title}`)
  return found
}

const tip = (): HTMLElement | null => document.querySelector<HTMLElement>('.task-ref-tip:not(.hidden)')

describe('the ? on a task’s row', () => {
  it('is green where the validation agrees, plain where untested, and absent where nothing is re-implemented', () => {
    const root = panel()
    const insulation = row(root, 'Diamond insulation').querySelector('.task-ref')
    // Lucide's drawn mark, not a typed `?`, which a font sets off-centre.
    expect(insulation?.querySelector('svg.icon')).not.toBeNull()
    expect(insulation?.classList.contains('is-validated')).toBe(true)
    // In the cell beside the chip, last, so it keeps the row's right edge.
    expect(insulation?.parentElement?.lastElementChild).toBe(insulation)
    expect(row(root, 'Scalogram').querySelector('.task-ref')?.classList.contains('is-validated')).toBe(false)
    expect(row(root, 'Model versus map').querySelector('.task-ref')).toBeNull()
    // Its width kept, empty, so the chips above and below stand in one column.
    expect(row(root, 'Model versus map').querySelector('.task-ref-blank')?.getAttribute('aria-hidden')).toBe('true')
  })

  it('is a mark, not a control', () => {
    const mark = row(panel(), 'Diamond insulation').querySelector<HTMLElement>('.task-ref')
    expect(mark?.tagName).toBe('SPAN')
    expect(mark?.hasAttribute('tabindex')).toBe(false)
    expect(mark?.getAttribute('aria-label')).toBe(
      'Diamond insulation (Crane et al. 2015), as cooltools computes it. Identical in the validation.',
    )
  })

  it('names the method in a tip, with its DOI as a link', () => {
    const mark = row(panel(), 'Scalogram').querySelector<HTMLElement>('.task-ref')
    mark?.dispatchEvent(new Event('pointerenter'))
    expect(tip()?.textContent).toBe('The scalogram of Lioy et al. 2018.Not validated yet · doi:10.1016/j.cell.2017.12.027')
    const link = tip()?.querySelector('a')
    expect(link?.getAttribute('href')).toBe('https://doi.org/10.1016/j.cell.2017.12.027')
    expect(link?.getAttribute('target')).toBe('_blank')
    // Outside the row, which is a button a link cannot sit inside.
    expect(tip()?.closest('.analysis-row')).toBeNull()
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    expect(tip()).toBeNull()
  })

  it('opens no task when pressed, and shows its tip for a finger', () => {
    const root = panel()
    const compartments = row(root, 'Compartments')
    compartments.querySelector<HTMLElement>('.task-ref')?.click()
    expect(compartments.classList.contains('is-active')).toBe(false)
    expect(tip()?.textContent).toMatch(/^The first eigenvector \(Lieberman-Aiden et al\. 2009\)/)
    // And a press on the row itself still opens it.
    compartments.click()
    expect(compartments.classList.contains('is-active')).toBe(true)
  })
})
