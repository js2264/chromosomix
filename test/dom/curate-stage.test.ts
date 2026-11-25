// @vitest-environment jsdom
// @dev-feature curate
/**
 * The curation stage's frame (SPECS §33.3), in a DOM, with stand-ins for its
 * pictures and cards: the dialog and its three columns, the large picture and
 * its keys, the running tally, the acts the keys make, the review's band and
 * its price, undo, and Escape never closing it.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { CuratedBinning, fileBinning } from '@/genome/curation'
import { stateAnswer } from '@/curate/answer'
import type { CurateContext, CuratePane } from '@/curate/ui/context'
import { CurateStage, type CurateCard, type CurateLayouts, type CurateParts } from '@/curate/ui/CurateStage'
import { CurationStore } from '@/state/curation'
import type { CurationFocusResult, CurationNetworkResult } from '@/worker/curateProtocol'
import { setUpDom, textsOf, type DomTeardown } from '../support/dom'
import { community } from '../support/curateCommunity'

let teardown: DomTeardown
let stages: CurateStage[] = []
let keys = 0

beforeEach(() => {
  teardown = setUpDom({ canvas: 'stub' })
  window.sessionStorage.clear()
  window.localStorage.clear()
})

afterEach(() => {
  for (const stage of stages) stage.close()
  stages = []
  teardown()
})

/** A picture that draws nothing and says what it was told; `boxed`, it has a box and takes Escape, as a press in flight does. */
function pane(name: string, told: string[], boxed = false): CuratePane {
  const element = Object.assign(document.createElement('div'), { className: `stand-in-${name}` })
  if (boxed) element.getBoundingClientRect = () => ({ left: 0, top: 0, right: 100, bottom: 100, width: 100, height: 100, x: 0, y: 0, toJSON: () => ({}) })
  return {
    element,
    title: name,
    update: () => {},
    resize: () => {},
    setLarge: (large) => told.push(`${name}:${large ? 'large' : 'small'}`),
    showSuggestion: (s) => told.push(`${name}:${s?.kind ?? 'none'}`),
    key: (event) => {
      if (!boxed || event.key !== 'Escape') return false
      told.push(`${name}:escape`)
      return true
    },
    dropTargetAt: () => null,
    dispose: () => {},
  }
}

function card(name: string): CurateCard {
  const element = document.createElement('section')
  element.className = `edit-card stand-in-${name}`
  return { element, update: () => {} }
}

async function open(
  options: { failing?: () => boolean; counting?: () => boolean; boxed?: boolean; layouts?: CurateLayouts } = {},
): Promise<{ stage: CurateStage; store: CurationStore; told: string[]; ctx: () => CurateContext }> {
  const { base, evidence } = community()
  const store = new CurationStore(`curate-stage-${++keys}`, base, fileBinning(base), () => 0)
  const told: string[] = []
  let held: CurateContext | null = null
  const parts: CurateParts = {
    contacts: (ctx) => {
      held = ctx
      return pane('contacts', told, options.boxed === true)
    },
    hosts: () => pane('hosts', told),
    scatter: () => pane('scatter', told),
    selection: () => card('selection'),
    suggestions: () => card('suggestions'),
    history: () => card('history'),
    exporting: () => card('export'),
    about: () => card('about'),
    chooser: () => ({ close: () => {} }),
  }
  const summary: CurationNetworkResult = { contigs: base.names.length, pairs: evidence.network.first.length, pixels: 100, within: 0, between: 0, background: evidence.background }
  const stage = new CurateStage({
    title: 'community.metacool',
    stem: 'community',
    store,
    base: { base, file: fileBinning(base), elements: { count: 1, fromRoundOnly: 0 }, gc: null, markerSets: ['Bact4'], pixels: 100, networkHeld: false },
    requests: {
      network: () => ({ promise: Promise.resolve(summary), cancel: () => {} }),
      state: (curation, weights) => ({
        promise:
          options.counting?.() === true
            ? new Promise(() => {})
            : options.failing?.() === true
              ? Promise.reject(new Error('the worker stopped'))
              : Promise.resolve(stateAnswer(evidence, CuratedBinning.of(base, curation), weights)),
        cancel: () => {},
      }),
      focus: () => ({ promise: new Promise<CurationFocusResult>(() => {}), cancel: () => {} }),
    },
    parts,
    memoryKey: () => 'community.metacool',
    gate: null,
    onClose: () => {},
    debounce: 0,
    ...(options.layouts === undefined ? {} : { layouts: options.layouts }),
  })
  stages.push(stage)
  await settle()
  return { stage, store, told, ctx: () => held as unknown as CurateContext }
}

/** The counts and a frame. */
async function settle(): Promise<void> {
  for (let k = 0; k < 6; k++) await new Promise((resolve) => setTimeout(resolve, 0))
}

function key(name: string, init: KeyboardEventInit = {}): void {
  window.dispatchEvent(new KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true, ...init }))
}

describe('the curation stage', () => {
  it('opens on the whole window: the list, one large picture and two small, the inspector in its order', async () => {
    await open()
    expect(document.querySelector('.modal-title')?.textContent).toBe('Curate the genomes · community.metacool')
    expect(document.querySelector('.modal-panel')?.classList.contains('modal-curate')).toBe(true)
    expect(document.querySelector('.curate-list')).not.toBeNull()
    expect([...document.querySelectorAll('.curate-slot')].map((slot) => `${(slot as HTMLElement).dataset.slot}:${slot.classList.contains('is-large') ? 'large' : 'small'}`)).toEqual(['contacts:large', 'hosts:small', 'scatter:small'])
    const side = [...document.querySelectorAll('.curate-side-body > section')].map((node) => node.className.replace(/.*stand-in-/, '').replace('edit-card curate-modes-card', 'modes'))
    expect(side).toEqual(['modes', 'selection', 'history', 'suggestions', 'export', 'about'])
    expect(document.querySelector('.curate-stage')?.getAttribute('data-contacts')).toBe('read')
  })

  it('says the tally in the readout, and the steps once one is made', async () => {
    const { store } = await open()
    expect(document.querySelector('.curate-readout')?.textContent).toBe('4 MAGs · 1 element · 1 unbinned · as in the file')
    store.apply({ op: 'merge', into: 'X1', genomes: ['X2'] })
    await settle()
    expect(document.querySelector('.curate-readout')?.textContent).toBe('MAGs 4 → 3 · 1 element · 1 unbinned · 1 step · 3 contigs moved')
  })

  it('makes a picture large from its key, and undoes and redoes from theirs', async () => {
    const { store, told } = await open()
    key('2')
    expect(document.querySelector('.curate-slot.is-large')?.getAttribute('data-slot')).toBe('hosts')
    expect(told).toContain('hosts:large')
    store.apply({ op: 'rename', genome: 'Z', name: 'Zeta' })
    await settle()
    key('z', { ctrlKey: true })
    await settle()
    expect(store.applied).toBe(0)
    key('z', { ctrlKey: true, shiftKey: true })
    expect(store.applied).toBe(1)
  })

  it('merges the selected genomes with M, unbins a selected contig with Delete, and lets go of the selection on Escape', async () => {
    const { store, ctx } = await open()
    ctx().model.selectGenomes(['X1', 'X2'])
    key('m')
    expect(store.binning.indexOfId('X2')).toBeUndefined()
    await settle()
    ctx().model.selectContigs([3])
    key('Delete')
    expect(store.binning.genomeOf[3]).toBe(-1)
    await settle()
    ctx().model.selectGenomes(['Y'])
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
    expect(ctx().model.selection.genomes).toEqual([])
    expect(document.querySelector('.modal-panel')).not.toBeNull()
  })

  it('reviews: the band names the suggestion, prices it, takes it on Y and turns the next down on N', async () => {
    const { store, ctx, told } = await open()
    ;(document.querySelector('[data-mode="review"]') as HTMLButtonElement).click()
    await settle()
    const band = document.querySelector('.curate-band') as HTMLElement
    expect(band.classList.contains('hidden')).toBe(false)
    expect(band.querySelector('.curate-band-where')?.textContent).toMatch(/^1 of \d+ likely$/)
    expect(band.querySelector('.curate-band-words')?.textContent).toBe('merge X2 into X1')
    expect(band.querySelector('.curate-band-confidence')?.textContent).toMatch(/^· \d+%$/)
    // Each genome it names after its swatch, a MAG's disc.
    expect([...band.querySelectorAll('.curate-band-name')].map((node) => `${node.textContent}:${node.querySelector('.curate-swatch-mag') === null ? 'ring' : 'disc'}`)).toEqual(['X2:disc', 'X1:disc'])
    expect(textsOf(band, '.curate-band-price-row')[0]).toBe('X1 complete 50% + 50% → 100% · redundant 1.00 + 1.00 → 1.00 · high quality')
    // Coloured as the cards colour a price: the completeness made it high quality, the redundancy did not move it.
    expect(textsOf(band, '.curate-band-price-number.is-promoted')).toEqual(['complete 50% + 50% → 100%'])
    expect(textsOf(band, '.curate-band-price-name.is-promoted, .curate-band-price-verdict.is-promoted')).toEqual(['X1', 'high quality'])
    expect(told).toContain('contacts:merge')
    key('y')
    expect(store.curation.history[0].by).toBe('suggestion')
    await settle()
    const next = ctx().model.current
    expect(next).not.toBeNull()
    key('n')
    await settle()
    expect(store.learned.rejected).toContain(next?.key)
  })

  it('answers once for a key held down, and nothing while the step just taken is counted', async () => {
    const { store } = await open()
    ;(document.querySelector('[data-mode="review"]') as HTMLButtonElement).click()
    await settle()
    // The head question, merge X2 into X1, is one step.
    key('y')
    key('y', { repeat: true })
    key('y')
    expect(store.curation.history.map((entry) => entry.step.op)).toEqual(['merge'])
    await settle()
    expect(document.querySelector('.curate-band-words')?.textContent).not.toMatch(/weighing/)
  })

  it('ends a drag the browser took over, dropping nothing', async () => {
    const { ctx, store } = await open()
    ctx().startDrag({ kind: 'genomes', ids: ['X2'] }, new PointerEvent('pointerdown', { clientX: 10, clientY: 10 }))
    expect(document.querySelector('.curate-ghost')).not.toBeNull()
    window.dispatchEvent(new PointerEvent('pointercancel'))
    expect(document.querySelector('.curate-ghost')).toBeNull()
    expect(ctx().dragging).toBeNull()
    window.dispatchEvent(new PointerEvent('pointerup', { clientX: 10, clientY: 10 }))
    expect(store.applied).toBe(0)
  })

  it('closes on Escape the innermost thing: the keys sheet, then a field’s text, and only then the selection', async () => {
    const { ctx } = await open()
    const escape = (): void => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
    }
    ctx().model.selectGenomes(['Y'])
    key('?')
    expect(document.querySelector('.curate-keys')).not.toBeNull()
    escape()
    expect(document.querySelector('.curate-keys')).toBeNull()
    expect(ctx().model.selection.genomes).toEqual(['Y'])
    const filter = document.querySelector('.curate-filter') as HTMLInputElement
    filter.focus()
    filter.value = 'X'
    escape()
    expect(filter.value).toBe('')
    expect(ctx().model.selection.genomes).toEqual(['Y'])
    escape()
    expect(document.activeElement).not.toBe(filter)
    escape()
    expect(ctx().model.selection.genomes).toEqual([])
  })

  it('says a count that failed, with a press to count again, and drops it once counted', async () => {
    let failing = false
    const { store } = await open({ failing: () => failing })
    ;(document.querySelector('[data-mode="review"]') as HTMLButtonElement).click()
    await settle()
    failing = true
    store.apply({ op: 'rename', genome: 'Z', name: 'Zeta' })
    await settle()
    const status = document.querySelector('.curate-status') as HTMLElement
    expect(status.classList.contains('hidden')).toBe(false)
    expect(status.textContent).toMatch(/counting the binning failed: the worker stopped/)
    // Review asks nothing of the binning before the step, and says why, in the band's three lines.
    expect(document.querySelector('.curate-band-where')?.textContent).toBe('review')
    expect(document.querySelector('.curate-band-words')?.textContent).toBe('the count failed: count again')
    expect(document.querySelector('.curate-band')?.childElementCount).toBe(3)
    failing = false
    ;(status.querySelector('button') as HTMLButtonElement).click()
    await settle()
    expect(status.classList.contains('hidden')).toBe(true)
    expect(document.querySelector('.curate-band-words')?.textContent).not.toMatch(/failed|nothing left/)
  })

  it('makes nothing with a key the card prints while a step is counted or after its count failed, as the card’s act', async () => {
    let failing = false
    let counting = false
    const { ctx, store } = await open({ failing: () => failing, counting: () => counting })
    // P is linked to Z, and the contacts say it should not be: an unlink on offer.
    const offered = (): boolean => ctx().model.offered().some((s) => s.step.op === 'unlink' && s.step.element === 'P' && s.step.mag === 'Z')
    expect(offered()).toBe(true)
    const waiting = (): boolean => document.querySelector('.stand-in-selection')?.classList.contains('is-waiting') === true
    for (const state of ['failed', 'counted'] as const) {
      failing = state === 'failed'
      counting = state === 'counted'
      store.apply({ op: 'rename', genome: 'Y', name: `Y-${state}` })
      await settle()
      expect(ctx().model.answerable).toBe(false)
      const applied = store.applied
      ctx().model.selectGenomes(['P', 'Z'])
      for (const name of ['Delete', 'l', 'm', 'b', 'e']) key(name)
      ctx().model.selectContigs([3])
      for (const name of ['Delete', 'm', 'b']) key(name)
      // Nothing made: neither the unlink on offer nor, as before, P and Z dissolved.
      expect(store.applied).toBe(applied)
      expect(waiting()).toBe(true)
      expect(store.binning.links).toContainEqual(expect.objectContaining({ element: 'P', mag: 'Z' }))
      document.querySelector('.stand-in-selection')?.classList.remove('is-waiting')
      counting = false
      failing = false
      if (state === 'failed') {
        ;(document.querySelector('.curate-status button') as HTMLButtonElement).click()
        await settle()
      }
    }
  })

  it('says on review and auto why they are off: the contacts unread, or nothing left on offer', async () => {
    const { ctx } = await open()
    const review = document.querySelector('[data-mode="review"]') as HTMLButtonElement
    const auto = document.querySelector('[data-mode="auto"]') as HTMLButtonElement
    expect(review.disabled).toBe(false)
    expect(auto.title).toMatch(/in the queue’s order — merges first/)
    // Turned down one by one, till nothing is left — one turned down may bring another on offer.
    for (let k = 0; k < 20 && ctx().model.offered().length > 0; k++) {
      ctx().model.reject(ctx().model.offered()[0])
      await settle()
    }
    expect(review.disabled).toBe(true)
    expect(review.title).toBe('Nothing on offer: every suggestion is answered, turned down or under 15%.')
    expect(auto.title).toBe(review.title)
  })

  it('says why M and L make nothing: two kinds to merge, contigs to link', async () => {
    const { ctx, store } = await open()
    ctx().model.selectGenomes(['P', 'Y'])
    key('m')
    expect(store.applied).toBe(0)
    expect(document.querySelector('.curate-readout')?.textContent).toBe('Merge MAGs with MAGs and elements with elements.')
    ctx().model.selectContigs([3])
    key('l')
    expect(document.querySelector('.curate-readout')?.textContent).toMatch(/^Select an element/)
  })

  it('in review, gives the arrows to the review even while the list has the keyboard', async () => {
    const { ctx } = await open()
    ;(document.querySelector('[data-mode="review"]') as HTMLButtonElement).click()
    await settle()
    const first = ctx().model.current?.key
    const scroller = document.querySelector('.curate-list-scroll') as HTMLElement
    scroller.focus()
    scroller.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true }))
    await settle()
    expect(ctx().model.current?.key).not.toBe(first)
    expect(ctx().model.selection.genomes).toEqual([])
  })

  it('opens a new genome’s name for typing once B has made it and it is counted', async () => {
    const { ctx } = await open()
    // The stage hands the list the keyboard a frame after it opens: past that.
    await new Promise((resolve) => requestAnimationFrame(() => resolve(null)))
    ctx().model.selectContigs([18])
    key('b')
    // Counted, then drawn: a few frames at most.
    let input: HTMLInputElement | null = null
    for (let k = 0; k < 20 && input === null; k++) {
      await settle()
      await new Promise((resolve) => requestAnimationFrame(() => resolve(null)))
      input = document.querySelector('.curate-rename')
    }
    expect(input?.value).toBe('curated_MAG_1')
  })

  it('makes a picture large from the key its digit is printed on, whatever the layout types there', async () => {
    await open()
    // AZERTY: the key with 3 on it types a double quote.
    key('"', { code: 'Digit3' })
    expect(document.querySelector('.curate-slot.is-large')?.getAttribute('data-slot')).toBe('scatter')
    key('&', { code: 'Digit1' })
    expect(document.querySelector('.curate-slot.is-large')?.getAttribute('data-slot')).toBe('contacts')
  })

  it('keeps the band at three lines and the same five keys from one question to the next, an element named after its ring', async () => {
    const { ctx } = await open()
    ;(document.querySelector('[data-mode="review"]') as HTMLButtonElement).click()
    await settle()
    const band = document.querySelector('.curate-band') as HTMLElement
    const seen = new Set<string>()
    for (let k = 0; k < 12 && !seen.has(ctx().model.current?.key ?? ''); k++) {
      seen.add(ctx().model.current?.key ?? '')
      // Where the question stands with the keys; the question; its price — whatever is asked.
      expect([...band.children].map((line) => line.className)).toEqual(['curate-band-head', 'curate-band-question', 'curate-band-price'])
      expect(textsOf(band, '.curate-band-key')).toEqual(['Ytake', 'Nturn down', '←→others', '↓↑one by one', 'holdSpacetopreview'])
      // ↓ ↑ dimmed where there is nothing to answer one by one.
      const members = ctx().model.currentQuestion?.members.length ?? 0
      expect(band.querySelectorAll('.curate-band-key')[3].classList.contains('is-off')).toBe(members < 2)
      const current = ctx().model.current
      if (current?.kind === 'link' || current?.kind === 'unlink') {
        // P is an element: its ring before its name, so its name is not read as a MAG's.
        const element = [...band.querySelectorAll('.curate-band-name')].find((node) => node.textContent === 'P')
        expect(element?.classList.contains('is-element')).toBe(true)
        expect(element?.querySelector('.curate-swatch-element')).not.toBeNull()
        expect(band.querySelector('.curate-band-price')?.textContent).toBe('no genome’s quality changes')
      }
      if (current?.kind === 'move' && current.genomes.length === 2) {
        // y5 moved from X1 to Y: the genome taking it in first, worded; the one it leaves in numbers only, never summed with the first.
        const rows = textsOf(band, '.curate-band-price-row')
        expect(rows[0]).toMatch(/^Y complete \d+% → \d+% · redundant \d\.\d+ → \d\.\d+/)
        expect(rows[1]).toMatch(/^X1 \d+% → \d+% · \d\.\d+ → \d\.\d+/)
        seen.add('move seen')
      }
      key('ArrowRight')
      await settle()
    }
    expect([...seen].some((key) => key.startsWith('host:'))).toBe(true)
    expect(seen.has('move seen')).toBe(true)
  })

  it('says while Space is held that the pictures draw the binning as it would be, and its tally then', async () => {
    const { ctx } = await open()
    ;(document.querySelector('[data-mode="review"]') as HTMLButtonElement).click()
    await settle()
    const readout = document.querySelector('.curate-readout') as HTMLElement
    expect(readout.querySelector('.curate-readout-pill')).toBeNull()
    key(' ')
    await settle()
    expect(ctx().model.previewing).toBe(true)
    // The head question merges X2 into X1: one MAG fewer, if taken.
    expect(readout.querySelector('.curate-readout-pill')?.textContent).toBe('as it would be')
    expect(readout.textContent).toBe('as it would beMAGs 4 → 3 · 1 element · 1 unbinned · if taken')
    expect(document.querySelector('.curate-centre')?.classList.contains('is-previewing')).toBe(true)
    expect(document.querySelectorAll('.curate-band-key')[4].classList.contains('is-held')).toBe(true)
    window.dispatchEvent(new KeyboardEvent('keyup', { key: ' ', bubbles: true }))
    await settle()
    expect(readout.querySelector('.curate-readout-pill')).toBeNull()
    expect(document.querySelector('.curate-centre')?.classList.contains('is-previewing')).toBe(false)
    expect(readout.textContent).toBe('4 MAGs · 1 element · 1 unbinned · as in the file')
  })

  it('keeps its controls in the title bar: the tabs in its middle, the tools before its ✕, no row of their own', async () => {
    await open()
    const head = document.querySelector('.modal-curate .modal-head') as HTMLElement
    expect(head.classList.contains('has-centre')).toBe(true)
    expect([...head.children].map((node) => node.className)).toEqual(['modal-title is-name', 'modal-head-centre', 'modal-head-end'])
    // Whole under the pointer, where a narrow bar cuts it short.
    expect(head.querySelector('.modal-title')?.getAttribute('title')).toBe('Curate the genomes · community.metacool')
    expect(textsOf(head.querySelector('.modal-head-centre') as HTMLElement, '[data-pane-tab] > span')).toEqual(['contacts', 'hosts', 'scatter'])
    const end = head.querySelector('.modal-head-end') as HTMLElement
    expect([...end.children].map((node) => node.className)).toEqual(['curate-tools', 'btn-close'])
    // Tidy, undo, redo, the keys, then the inspector's toggle.
    const tools = [...(end.querySelector('.curate-tools') as HTMLElement).children] as HTMLElement[]
    // Each named by its word, or an icon by its label without the key it is bound to.
    expect(tools.map((node) => (node.textContent === '' ? (node.getAttribute('aria-label') ?? '').replace(/ \(.*\)$/, '') : node.textContent))).toEqual([
      'tidy',
      'Undo the last step',
      'Redo it',
      'Keys on this stage',
      'Hide the inspector',
    ])
    // The centre starts with the readout: nothing of a toolbar is left in it.
    expect((document.querySelector('.curate-centre') as HTMLElement).firstElementChild?.classList.contains('curate-readout')).toBe(true)
    expect(document.querySelector('.curate-toolbar')).toBeNull()
    // A tab in the bar still chooses the large picture.
    ;(head.querySelector('[data-pane-tab="scatter"]') as HTMLButtonElement).click()
    expect(document.querySelector('.curate-slot.is-large')?.getAttribute('data-slot')).toBe('scatter')
    expect(head.querySelector('[data-pane-tab="scatter"]')?.getAttribute('aria-pressed')).toBe('true')
    ;(head.querySelector('[data-pane-tab="contacts"]') as HTMLButtonElement).click()
  })

  it('docks the inspector’s toggle in the title bar, named for the inspector, and words the modes by what they apply', async () => {
    await open()
    const toggle = document.querySelector('.modal-head-end .curate-tools .stage-side-toggle') as HTMLButtonElement
    expect(toggle).not.toBeNull()
    // Not floating over the inspector's cards any more.
    expect(document.querySelector('.stage-modal > .stage-side-toggle')).toBeNull()
    expect(toggle.title).toBe('Hide the inspector')
    toggle.click()
    expect(document.querySelector('.stage-side')?.classList.contains('hidden')).toBe(true)
    expect(toggle.title).toBe('Show the inspector')
    expect(toggle.getAttribute('aria-label')).toBe('Show the inspector')
    toggle.click()
    expect(toggle.title).toBe('Hide the inspector')
    // The shell's grip named for what it moves here, as the list's is.
    expect(document.querySelector('.stage-side-grip')?.getAttribute('aria-label')).toBe('Resize the inspector')
    expect(document.querySelector('.curate-list-grip')?.getAttribute('aria-label')).toBe('Resize the genome list')
    expect(document.querySelector('.curate-modes-card .edit-card-head')?.textContent).toBe('apply suggestions')
  })

  it('prints Enter and Delete in the keys sheet as every other part prints them', async () => {
    await open()
    key('?')
    const caps = textsOf(document.querySelector('.curate-keys') as HTMLElement, 'kbd')
    expect(caps).toContain('⏎')
    expect(caps.some((cap) => cap === 'Shift+⏎' || cap === '⇧⏎')).toBe(true)
    expect(caps).toContain('⌫')
    expect(caps).not.toContain('enter')
    expect(caps).not.toContain('delete')
  })

  it('lets a picture’s Escape be the innermost thing: a press let go of, the selection kept', async () => {
    const { ctx, told } = await open({ boxed: true })
    // The stage hands the list the keyboard a frame after it opens: past that, under any load.
    await new Promise((resolve) => requestAnimationFrame(() => resolve(null)))
    ctx().model.selectGenomes(['Y'])
    document.querySelector('.curate-stage')?.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: 10, clientY: 10 }))
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
    expect(told).toContain('contacts:escape')
    expect(ctx().model.selection.genomes).toEqual(['Y'])
    // The next Escape, nothing in flight but the picture still under the pointer, is its again;
    // moved off it, the stage's: the selection let go of.
    document.querySelector('.curate-stage')?.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: 500, clientY: 500 }))
    await Promise.resolve()
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
    expect(ctx().model.selection.genomes).toEqual([])
  })

  it('lays one selected genome out with S, over the stage, and marks it in the list once its edit has closed', async () => {
    const opened: string[] = []
    let closed: (() => void) | null = null
    let laid: ReadonlySet<string> = new Set()
    const layouts: CurateLayouts = {
      kept: () => new Set(),
      laidOut: () => laid,
      open: (id, onClosed) => {
        opened.push(id)
        closed = onClosed
      },
      agp: () => ({ text: '', sequences: 0, laidOut: 0 }),
      sequences: () => ({ text: '', rows: 0 }),
      sequenceFrom: () => null,
      fasta: async () => null,
    }
    const { ctx } = await open({ layouts })
    ctx().model.selectGenomes(['X1', 'X2'])
    key('s')
    // Two genomes are no one genome to lay out.
    expect(opened).toEqual([])
    ctx().model.selectGenomes(['X1'])
    key('s')
    expect(opened).toEqual(['X1'])
    expect(ctx().laidOut('X1')).toBe(false)
    laid = new Set(['X1'])
    ;(closed as unknown as () => void)()
    await settle()
    expect(ctx().laidOut('X1')).toBe(true)
    expect(document.querySelector('[data-genome="X1"] .curate-laid-out')).not.toBeNull()
    expect(document.querySelector('[data-genome="X2"] .curate-laid-out')).toBeNull()
  })

  it('prints S in the keys sheet only where the reference editing is on, and takes it only then', async () => {
    const { ctx } = await open()
    key('?')
    expect(textsOf(document, '.curate-keys-row').some((row) => row.includes('lay the selected genome out'))).toBe(false)
    ctx().model.selectGenomes(['X1'])
    const event = new KeyboardEvent('keydown', { key: 's', bubbles: true, cancelable: true })
    window.dispatchEvent(event)
    expect(event.defaultPrevented).toBe(false)
  })
})
