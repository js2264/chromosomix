// @vitest-environment jsdom
/**
 * What the Chromosomes table puts above its rows.
 *
 * Two shapes, and which one you get is whether the file has an assembly this
 * view can draw as a picture.
 *
 * **With one** — a cooler — the head is the 1D browser's bar and nothing else.
 * The title and the sentence under it are what a view needs when the reader has
 * to be told where they are and what the box is for; with the bar there they are
 * told by better means, since the breadcrumb says which table, the ruler *is* the
 * genome and the summary line says how much of it. Two lines of furniture
 * restating the screen is two lines of scrolling on every visit.
 *
 * **Without one** — a metacool's per-genome contig list — the head keeps both,
 * because there they are all the reader has: no ruler, no summary, and a box
 * whose syntax is worth a sentence.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { assemblyOf } from '@/genome/assembly'
import { ContigsTable } from '@/ui/ContigsTable'
import type { ContigsResult } from '@/worker/protocol'
import { setUpDom, textsOf, type DomTeardown } from '../support/dom'

let teardown: DomTeardown

beforeEach(() => {
  teardown = setUpDom()
})

afterEach(() => {
  teardown()
})

const NAMES = ['I', 'II', 'III']
const LENGTHS = [1000, 2000, 3000]

const DATA: ContigsResult = {
  table: {
    length: NAMES.length,
    columns: ['name', 'length'],
    data: { name: [...NAMES], length: Float64Array.from(LENGTHS) },
  },
}

const GENOME = assemblyOf({
  uri: 'test.cool',
  name: 'test',
  origin: 'cooler',
  contigs: NAMES.map((name, i) => ({ name, length: LENGTHS[i] })),
})

function table(options: { assembly?: boolean } = {}): ContigsTable {
  const view = new ContigsTable({
    data: DATA,
    title: 'Chromosomes',
    hint: 'One genome, its chromosomes.',
    ...(options.assembly === true ? { assembly: GENOME } : {}),
    onOpenContig: () => {},
    onOpenRegion: () => {},
  })
  document.body.appendChild(view.el)
  return view
}

describe('a table with an assembly to draw', () => {
  it('is the bar and nothing above it', () => {
    const view = table({ assembly: true })
    expect(textsOf(view.el, '.view-head h2')).toEqual([])
    expect(textsOf(view.el, '.view-head > .hint')).toEqual([])
    const head = view.el.querySelector('.view-head')
    expect(head?.firstElementChild?.classList.contains('seqbar')).toBe(true)
    view.destroy()
  })

  it('marks the head so the missing title’s space can be given back', () => {
    const view = table({ assembly: true })
    expect(view.el.querySelector('.view-head')?.classList.contains('view-head-bare')).toBe(true)
    view.destroy()
  })

  it('carries the ruler, and only one locus box', () => {
    const view = table({ assembly: true })
    expect(view.el.querySelectorAll('.seqbar-canvas')).toHaveLength(1)
    // The plain box is gone rather than sitting beside the bar's own.
    expect(view.el.querySelectorAll('.view-head .search-box')).toHaveLength(1)
    view.destroy()
  })
})

describe('a table with none', () => {
  it('keeps the title, the sentence and the plain box', () => {
    const view = table()
    expect(textsOf(view.el, '.view-head h2')).toEqual(['Chromosomes'])
    expect(textsOf(view.el, '.view-head > .hint')).toEqual(['One genome, its chromosomes.'])
    expect(view.el.querySelector('.seqbar')).toBeNull()
    expect(view.el.querySelectorAll('.view-head .search-box')).toHaveLength(1)
    view.destroy()
  })
})
