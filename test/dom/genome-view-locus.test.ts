// @vitest-environment jsdom
/**
 * The genome view's locus box (§5.2), and the one way it differed from every
 * other locus box in the application.
 *
 * It said `contig, or contig:start-end`, had no `go`, and handed what was typed
 * straight to the region reader — which takes the digits as cooler does, 0-based
 * and half-open. So a window copied off a breadcrumb, out of IGV or out of a
 * paper opened one base to the right of the place it names, from this box and
 * from no other. §26.1's law is the round trip: what a box would show for a
 * window, typed back into it, opens that window.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { regionLabel } from '@/genome/assembly'
import { GenomeView } from '@/ui/GenomeView'
import type { ReaderClient } from '@/worker/client'
import { setUpDom, type DomTeardown } from '../support/dom'

let teardown: DomTeardown
const built: GenomeView[] = []

beforeEach(() => {
  // `MatrixPanel` refuses to be built without a context; nothing here is drawn.
  teardown = setUpDom({ canvas: 'stub' })
})

afterEach(() => {
  for (const view of built.splice(0, built.length)) view.destroy()
  teardown()
})

function make(): { view: GenomeView; opened: string[]; box: HTMLInputElement } {
  const opened: string[] = []
  // A reader that never answers: the map under the box stays loading, and the
  // box is all this file is about.
  const client = { request: () => new Promise(() => {}) } as unknown as ReaderClient
  const view = new GenomeView({
    client,
    binsize: 1000,
    genome: 'MAG_1',
    level: 'bin',
    scale: {},
    balance: false,
    hasWeights: false,
    onScoreChange: () => {},
    onScaleChange: () => {},
    onOpenRegion: (region) => opened.push(region),
    onOpenContigPair: () => {},
    onError: () => {},
  })
  built.push(view)
  document.body.append(view.el)
  const box = view.el.querySelector<HTMLInputElement>('.search-input')
  if (box === null) throw new Error('the genome view has no locus box')
  return { view, opened, box }
}

function submit(box: HTMLInputElement, text: string): void {
  box.value = text
  box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
}

describe('the genome view’s locus box (§5.2)', () => {
  it('offers what every locus box offers, in the same words, with a go beside it', () => {
    const { view, box } = make()
    expect(box.placeholder).toBe('contig:1,000-20,000, or a sequence')
    expect(box.title).toMatch(/Coordinates are 1-based and inclusive/)
    const go = Array.from(view.el.querySelectorAll('button')).find((b) => b.textContent === 'go')
    expect(go).toBeDefined()
  })

  it('reads what is typed 1-based and inclusive, and hands on the machine form', () => {
    const { opened, box } = make()
    submit(box, 'NODE_7:1,200,001-1,210,000')
    expect(opened).toEqual(['NODE_7:1200000-1210000'])
  })

  // THE LAW (§26.1): the display form of a window, typed back, is that window.
  it('opens exactly the window whose display form was typed', () => {
    const { opened, box } = make()
    for (const region of ['NODE_7:1200000-1210000', 'NODE_7:0-1000', 'contig_12:230218-230219']) {
      submit(box, regionLabel(region))
      expect(opened.pop()).toBe(region)
    }
  })

  it('opens a contig named alone as itself, and the go button does what Enter does', () => {
    const { view, opened, box } = make()
    box.value = 'NODE_7'
    Array.from(view.el.querySelectorAll('button'))
      .find((b) => b.textContent === 'go')
      ?.click()
    expect(opened).toEqual(['NODE_7'])
  })
})
