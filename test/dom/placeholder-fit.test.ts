// @vitest-environment jsdom
/**
 * The offer a locus box makes, cut to the box it is in.
 *
 * `locusPlaceholder` builds one sentence — `I:1,000-20,000, a sequence, a
 * genome, or a gene` — and the boxes it goes in are between 168 and 700 pixels
 * wide. An input clips a placeholder it cannot fit and says nothing about having
 * done so: no ellipsis, no title, nothing. The map's box was showing
 * `I:1,000-20,000, a sequ` and the browser's `I:1,000-20,000, a sequence, a ge`,
 * each of which reads as a bug rather than as a list.
 *
 * What is pinned here is that the sentence loses whole clauses rather than
 * characters, from the end, and that nothing is lost outright: the full offer is
 * the box's tooltip. The measuring is done on a canvas, so the ruler is stubbed
 * — jsdom has no 2D context — at a flat seven pixels a character, which is close
 * enough to the app's 13px monospace digits to make the arithmetic readable.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { fitPlaceholder, locusPlaceholder } from '@/ui/SearchBox'
import { setUpDom, type DomTeardown } from '../support/dom'

let teardown: DomTeardown

const PER_CHARACTER = 7

beforeEach(() => {
  teardown = setUpDom()
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
    font: '',
    measureText: (text: string) => ({ width: text.length * PER_CHARACTER }),
  } as unknown as CanvasRenderingContext2D)
})

afterEach(() => {
  teardown()
  vi.restoreAllMocks()
})

/** A box of a given inner width, with the padding the app's inputs carry. */
function boxOf(width: number): HTMLInputElement {
  const input = document.createElement('input')
  Object.defineProperty(input, 'clientWidth', { value: width, configurable: true })
  input.style.padding = '0 8px'
  input.style.font = '13px monospace'
  document.body.appendChild(input)
  return input
}

const OFFER = locusPlaceholder({ first: 'I', accepts: { sequence: true, genome: true, gene: true } })

describe('the offer', () => {
  it('is the sentence one builder writes, so every box makes the same promise', () => {
    expect(OFFER).toBe('I:1,000-20,000, a sequence, a genome, or a gene')
  })

  it('stays whole in a box with room for it', () => {
    const input = boxOf(OFFER.length * PER_CHARACTER + 16)
    fitPlaceholder(input, OFFER)
    expect(input.placeholder).toBe(OFFER)
  })

  it('loses its last clause first, and a whole clause at a time', () => {
    const input = boxOf('I:1,000-20,000, a sequence, a genome'.length * PER_CHARACTER + 16)
    fitPlaceholder(input, OFFER)
    expect(input.placeholder).toBe('I:1,000-20,000, a sequence, a genome')
  })

  it('keeps the example when that is all there is room for', () => {
    // The map's box, which is what started this.
    const input = boxOf(168)
    fitPlaceholder(input, OFFER)
    expect(input.placeholder).toBe('I:1,000-20,000')
  })

  it('keeps the example even in a box too narrow for it', () => {
    const input = boxOf(40)
    fitPlaceholder(input, OFFER)
    expect(input.placeholder).toBe('I:1,000-20,000')
  })

  it('never leaves a dangling conjunction', () => {
    for (let width = 40; width <= OFFER.length * PER_CHARACTER + 32; width += 7) {
      const input = boxOf(width)
      fitPlaceholder(input, OFFER)
      expect(input.placeholder.endsWith(', or')).toBe(false)
      expect(input.placeholder.includes(', or ')).toBe(input.placeholder === OFFER)
    }
  })

  it('is the box tooltip in full, so a trimmed clause is still readable', () => {
    const input = boxOf(168)
    fitPlaceholder(input, OFFER)
    expect(input.placeholder).not.toBe(OFFER)
    expect(input.title).toBe(OFFER)
  })

  it('leaves a tooltip the caller wrote alone', () => {
    const input = boxOf(168)
    input.title = 'Where do you want to be.'
    fitPlaceholder(input, OFFER)
    expect(input.title).toBe('Where do you want to be.')
  })

  it('comes back clause by clause as the box widens', () => {
    const observers: Array<() => void> = []
    vi.stubGlobal(
      'ResizeObserver',
      class {
        constructor(callback: () => void) {
          observers.push(callback)
        }
        observe(): void {}
        disconnect(): void {}
      },
    )
    const input = boxOf(168)
    fitPlaceholder(input, OFFER)
    expect(input.placeholder).toBe('I:1,000-20,000')
    Object.defineProperty(input, 'clientWidth', { value: 700, configurable: true })
    observers.forEach((callback) => callback())
    expect(input.placeholder).toBe(OFFER)
    vi.unstubAllGlobals()
  })

  it('watches a box once however often what it takes changes', () => {
    const observed: HTMLInputElement[] = []
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe(element: HTMLInputElement): void {
          observed.push(element)
        }
        disconnect(): void {}
      },
    )
    const input = boxOf(300)
    // A file whose annotation arrives late: the browser bar rebuilds its offer
    // rather than its box, which used to stack up one observer per rebuild.
    fitPlaceholder(input, locusPlaceholder({ first: 'I', accepts: { sequence: true } }))
    fitPlaceholder(input, OFFER)
    fitPlaceholder(input, OFFER)
    expect(observed).toEqual([input])
    vi.unstubAllGlobals()
  })

  it('leaves a placeholder that is not a list alone', () => {
    const input = boxOf(40)
    fitPlaceholder(input, 'II:230,000-240,000')
    expect(input.placeholder).toBe('II:230,000-240,000')
  })
})

describe('the example', () => {
  it('is never the pseudo-contig a metacool lists first', () => {
    // §7.4 refuses to draw `__unbinned__` at any resolution, so a box holding it
    // up as the thing to type was offering the one name that cannot be opened.
    expect(locusPlaceholder({ first: '__unbinned__', accepts: { sequence: true } })).toBe(
      'contig:1,000-20,000, or a sequence',
    )
  })
})
