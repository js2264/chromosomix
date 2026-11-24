// @vitest-environment jsdom
// @dev-feature curate
/**
 * The curation stage's genome list (SPECS §33.3), in a DOM: its sections and
 * rows, a press and the keys selecting, a genome opening on its contigs, a
 * filter, a rename refused and taken, and a row dragged onto a genome.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { GenomeList } from '@/curate/ui/GenomeList'
import { setUpDom, textsOf, type DomTeardown } from '../support/dom'
import { testContext, type TestStage } from '../support/curateStage'

let teardown: DomTeardown
let lists: GenomeList[] = []

beforeEach(() => {
  teardown = setUpDom()
  window.sessionStorage.clear()
  window.localStorage.clear()
})

afterEach(() => {
  for (const list of lists) list.dispose()
  lists = []
  teardown()
})

/** A list mounted over the community, its first count in and its rows drawn. */
async function mount(): Promise<TestStage & { list: GenomeList }> {
  const stage = testContext()
  const list = new GenomeList(stage.ctx)
  lists.push(list)
  document.body.appendChild(list.element)
  await stage.model.settled()
  await frame()
  return { ...stage, list }
}

/** A frame: the list draws its rows in one. */
const frame = (): Promise<void> => new Promise((resolve) => requestAnimationFrame(() => resolve()))

const names = (): string[] => textsOf(document.body, '.curate-row:not(.curate-row-section) .curate-row-name')
const row = (key: string): HTMLElement => document.querySelector(`.curate-row[data-key="${key}"]`) as HTMLElement

function press(node: HTMLElement, init: PointerEventInit = {}): void {
  node.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, clientX: 5, clientY: 5, pointerId: 1, ...init }))
  window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, button: 0, clientX: 5, clientY: 5, pointerId: 1, ...init }))
}

function key(name: string, init: KeyboardEventInit = {}): void {
  const scroller = document.querySelector('.curate-list-scroll') as HTMLElement
  scroller.dispatchEvent(new KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true, ...init }))
}

describe('the genome list', () => {
  it('shows the MAGs, the elements and the pool, a genome’s numbers on its row', async () => {
    await mount()
    expect(textsOf(document.body, '.curate-row-section .curate-section-title')).toEqual(['MAGs', 'elements', 'unbinned'])
    // The MAGs in the stage's order: the two halves of X side by side.
    expect(names()).toEqual(['Y', 'X1', 'X2', 'Z', 'P', 'u0'])
    expect(row('g:Z').querySelector('.curate-row-complete')?.textContent).toBe('100%')
    expect(row('g:P').querySelector('.curate-row-hosts')?.textContent).toBe('→ Z')
  })

  it('selects a row pressed, toggles one with ⌘, and walks with ↓', async () => {
    const { model } = await mount()
    press(row('g:X1'))
    expect(model.selection.genomes).toEqual(['X1'])
    press(row('g:Y'), { metaKey: true })
    expect(model.selection.genomes).toEqual(['X1', 'Y'])
    press(row('g:X1'))
    key('ArrowDown')
    expect(model.selection.genomes).toEqual(['X2'])
    await frame()
    expect(row('g:X2').classList.contains('is-selected')).toBe(true)
  })

  it('opens a genome on its contigs with →, and a filter finds a contig inside one', async () => {
    await mount()
    press(row('g:X2'))
    key('ArrowRight')
    await frame()
    expect(names()).toEqual(['Y', 'X1', 'X2', 'x3', 'x4', 'x5', 'Z', 'P', 'u0'])
    const box = document.querySelector('.curate-filter') as HTMLInputElement
    box.value = 'y5'
    box.dispatchEvent(new Event('input'))
    await frame()
    expect(names()).toEqual(['X1', 'y5'])
    expect(document.querySelector('.curate-filter-note')?.textContent).toContain('1 found')
  })

  it('renames with F2, keeps the caret on a refused name, and takes a good one', async () => {
    const { model, said } = await mount()
    press(row('g:X1'))
    key('F2')
    const input = document.querySelector('.curate-rename') as HTMLInputElement
    expect(input.value).toBe('X1')
    input.value = 'Y'
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    expect(input.classList.contains('is-refused')).toBe(true)
    expect(said.at(-1)).toBe('Another genome is named Y.')
    input.value = 'Xanthomonas'
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    await model.settled()
    await frame()
    expect(names()).toContain('Xanthomonas')
    expect(names()).not.toContain('X1')
  })

  it('drags a contig row onto a genome: the step a drop makes', async () => {
    const { ctx, model, store } = await mount()
    press(row('g:X1'))
    key('ArrowRight')
    await frame()
    const y5 = row('c:3')
    y5.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, clientX: 5, clientY: 5, pointerId: 2 }))
    window.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: 5, clientY: 40, pointerId: 2 }))
    expect(ctx.dragging).toEqual({ kind: 'contigs', contigs: [3] })
    expect(ctx.dropWords({ kind: 'genome', id: 'Y' })).toEqual({ words: 'move y5 into Y', refused: false })
    expect(ctx.drop({ kind: 'genome', id: 'Y' })).toBe(true)
    await model.settled()
    expect(store.binning.genomeOf[3]).toBe(store.binning.indexOfId('Y'))
  })

  it('keeps the name box through a recount, and Tab walks on to the next genome’s', async () => {
    const { model, store } = await mount()
    press(row('g:X1'))
    key('F2')
    const input = document.querySelector('.curate-rename') as HTMLInputElement
    // A step made meanwhile — the count lands while the name is typed.
    store.apply({ op: 'rename', genome: 'Z', name: 'Zeta' })
    await model.settled()
    await frame()
    expect(input.isConnected).toBe(true)
    expect(document.querySelector('.curate-rename')).toBe(input)
    input.value = 'Xanthomonas'
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }))
    await frame()
    // The next genome's box is open at once, and its own rename's count keeps it.
    const next = document.querySelector('.curate-rename') as HTMLInputElement
    expect(next).not.toBeNull()
    expect(next.value).toBe('X2')
    await model.settled()
    await frame()
    expect(next.isConnected).toBe(true)
    expect(names()).toContain('Xanthomonas')
  })

  it('leaves Enter to the stage’s close-up, goes Home and End, and keeps → on a contig', async () => {
    const { model } = await mount()
    press(row('g:X1'))
    const enter = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })
    document.querySelector('.curate-list-scroll')?.dispatchEvent(enter)
    expect(enter.defaultPrevented).toBe(false)
    expect(names()).not.toContain('x0')
    key('End')
    expect(model.selection.contigs).toEqual([18])
    key('Home')
    expect(model.selection.genomes).toEqual(['Y'])
    // A contig is a leaf: → stays on it.
    press(row('g:X1'))
    key('ArrowRight')
    await frame()
    key('ArrowDown')
    const on = model.selection.contigs
    key('ArrowRight')
    expect(model.selection.contigs).toEqual(on)
  })

  it('takes a drop on a contig’s row as its genome’s, and on a pool contig’s as the pool’s', async () => {
    await mount()
    press(row('g:X1'))
    key('ArrowRight')
    await frame()
    expect(row('c:0').dataset.dropGenome).toBe('X1')
    expect(row('c:18').dataset.dropSection).toBe('pool')
    // Heads alone are not selectable: they say nothing of it.
    expect(row('s:mags').hasAttribute('aria-selected')).toBe(false)
    expect(row('g:X1').getAttribute('aria-level')).toBe('2')
    expect(row('c:0').getAttribute('aria-level')).toBe('3')
    expect(document.querySelector('.curate-list-scroll')?.getAttribute('aria-activedescendant')).toBe(row('g:X1').id)
  })

  it('keeps one kind selected: ⌘ on a contig with genomes selected starts again from it', async () => {
    const { model } = await mount()
    press(row('g:X1'))
    key('ArrowRight')
    await frame()
    press(row('c:0'), { metaKey: true })
    expect(model.selection).toEqual({ genomes: [], contigs: [0] })
  })
})
