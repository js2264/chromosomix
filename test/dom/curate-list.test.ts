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

/** A list mounted over the community, its first count in and its rows drawn; `tweak` changes the context first. */
async function mount(tweak?: (stage: TestStage) => void): Promise<TestStage & { list: GenomeList }> {
  const stage = testContext()
  tweak?.(stage)
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
    // High quality in the bar's colour, the bar under the percentage on every row, a changed one's too.
    expect(row('g:Z').querySelector('.curate-bar-fill')?.classList.contains('is-high')).toBe(true)
    expect(textsOf(document.body, '.curate-section-legend')).toEqual(['length · complete · redundant'])
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

  it('closes a name box pressed away from, the focus left where it went, and leaves Tab to an input method mid-composition', async () => {
    const { store } = await mount()
    press(row('g:X1'))
    key('F2')
    const input = document.querySelector('.curate-rename') as HTMLInputElement
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, isComposing: true }))
    expect(document.querySelector('.curate-rename')).toBe(input)
    const filter = document.querySelector('.curate-filter') as HTMLInputElement
    filter.focus()
    expect(document.querySelector('.curate-rename')).toBeNull()
    expect(document.activeElement).toBe(filter)
    expect(store.applied).toBe(0)
  })

  it('closes on the first press a genome the filter shows on its hits, open before or not', async () => {
    await mount()
    press(row('g:X2'))
    key('ArrowRight')
    await frame()
    const box = document.querySelector('.curate-filter') as HTMLInputElement
    box.value = 'x4'
    box.dispatchEvent(new Event('input'))
    await frame()
    expect(names()).toContain('x4')
    press(row('g:X2'))
    key('ArrowLeft')
    await frame()
    expect(names()).not.toContain('x4')
    // The filter gone, X2 is open again as the reader left it.
    box.value = ''
    box.dispatchEvent(new Event('input'))
    await frame()
    expect(names()).toContain('x3')
  })

  it('ignores a double press in the name box, and goes on to the last row from past the end', async () => {
    const { model } = await mount()
    press(row('g:X1'))
    key('F2')
    const input = document.querySelector('.curate-rename') as HTMLInputElement
    input.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
    await frame()
    expect(names()).not.toContain('x0')
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    key('End')
    expect(model.selection.contigs).toEqual([18])
    const box = document.querySelector('.curate-filter') as HTMLInputElement
    box.value = 'Z'
    box.dispatchEvent(new Event('input'))
    await frame()
    key('ArrowDown')
    expect(model.selection.genomes).toEqual(['Z'])
  })

  it('closes what a frame opened when the next frame shows other contigs, or the mode changes, but never what the reader opened', async () => {
    const { ctx, model } = await mount()
    // Review's question on y5, binned in X1: X1 opens on it.
    ctx.frame({ genomes: ['X1', 'Y'], contigs: [3] })
    await frame()
    expect(names()).toContain('y5')
    // The next question, on x3 in X2: X1 closes, X2 opens.
    ctx.frame({ genomes: ['X2', 'X1'], contigs: [4] })
    await frame()
    expect(names()).not.toContain('y5')
    expect(names()).toContain('x3')
    // A genome the reader opens is theirs: no frame closes it.
    press(row('g:Z'))
    key('ArrowRight')
    await frame()
    expect(names()).toContain('z0')
    ctx.frame({ genomes: ['Y'], contigs: [7] })
    await frame()
    expect(names()).toContain('z0')
    expect(names()).not.toContain('x3')
    expect(names()).toContain('y0')
    // A change of mode — review left, or auto — closes what its frames opened.
    model.setMode('auto')
    await frame()
    expect(names()).not.toContain('y0')
    expect(names()).toContain('z0')
  })

  it('marks the genomes holding selected contigs with how many, and the pool’s head with its own', async () => {
    const { model } = await mount()
    // A lasso's catch: two of X1's contigs, one of X2's, the pool's u0.
    model.selectContigs([0, 1, 4, 18])
    await frame()
    expect(row('g:X1').classList.contains('has-held')).toBe(true)
    expect(row('g:X1').querySelector('.curate-row-held')?.textContent).toBe('2')
    expect((row('g:X1').querySelector('.curate-row-held') as HTMLElement).title).toBe('2 of its 4 contigs selected')
    expect(row('g:X2').querySelector('.curate-row-held')?.textContent).toBe('1')
    expect(row('g:Y').classList.contains('has-held')).toBe(false)
    expect(row('g:Y').querySelector('.curate-row-held')?.textContent).toBe('')
    expect(row('s:pool').querySelector('.curate-row-held')?.textContent).toBe('1')
    expect((row('s:pool').querySelector('.curate-row-held') as HTMLElement).title).toBe('1 contig of the pool selected')
    // Genomes selected, no contig: no row holds any.
    model.selectGenomes(['Y'])
    await frame()
    expect(document.querySelectorAll('.has-held')).toHaveLength(0)
  })

  it('says a row’s whole name and numbers on the readout while the pointer is on it, and lets go of them off the list', async () => {
    const { said, model, store } = await mount()
    row('g:Z').dispatchEvent(new PointerEvent('pointerenter'))
    // The unlink of P from Z on offer names Z.
    expect(said.at(-1)).toBe('Z · 200.0 kb · 4 contigs · 100% complete · 1.00 redundant · high quality · 1 suggestion on offer')
    expect(model.hovered.genome).toBe('Z')
    row('g:P').dispatchEvent(new PointerEvent('pointerenter'))
    expect(said.at(-1)).toMatch(/^P · 100\.0 kb · 2 contigs · an element, hosted by Z · \d+ suggestions? on offer$/)
    row('c:18').dispatchEvent(new PointerEvent('pointerenter'))
    expect(said.at(-1)).toMatch(/^u0 · 50\.0 kb · GC \d+% · unbinned · .*recruit into X\d \d+%$/)
    document.querySelector('.curate-list-scroll')?.dispatchEvent(new PointerEvent('pointerleave'))
    expect(said.at(-1)).toBeNull()
    expect(model.hovered.genome).toBeNull()
    // What the curation changed of a genome, the change chip in words.
    store.apply({ op: 'merge', into: 'X1', genomes: ['X2'] })
    await model.settled()
    await frame()
    row('g:X1').dispatchEvent(new PointerEvent('pointerenter'))
    expect(said.at(-1)).toContain(' · merged with X2 · 3 contigs in, 0 out')
  })

  it('counts every head one way, shown of the whole, and keeps a prefix’s ellipsis outside the part that gives way', async () => {
    await mount((stage) => {
      stage.ctx.prefixOf = (kind) => (kind === 'mag' ? 'X' : 'P_')
    })
    const counts = (): string[] => textsOf(document.body, '.curate-row-section .curate-section-count')
    expect(counts()).toEqual(['4', '1', '1 contig · 50.0 kb'])
    const prefix = document.querySelector('.curate-row-section[data-key="s:elements"] .curate-section-prefix') as HTMLElement
    expect(prefix.textContent).toBe('P_…')
    expect(prefix.querySelector('.curate-section-prefix-text')?.textContent).toBe('P_')
    const box = document.querySelector('.curate-filter') as HTMLInputElement
    box.value = 'Z'
    box.dispatchEvent(new Event('input'))
    await frame()
    expect(counts()).toEqual(['1 of 4', '0 of 1', '0 of 1 contig'])
  })
})
