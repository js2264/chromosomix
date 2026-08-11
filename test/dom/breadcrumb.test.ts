// @vitest-environment jsdom
/**
 * The trail, as DOM.
 *
 * `rootTable` already had a unit test — which table a view was reached through
 * is arithmetic over the state — and everything the reader actually touches did
 * not: whether the root crumb is a link *and* a picker rather than a picker
 * alone, whether the current segment is inert, whether a greyed choice says why
 * it is greyed, whether an mmetacool's entry picker precedes the root (it must:
 * switching entry invalidates every crumb after it).
 *
 * Each of those is a decision the module docstring argues for at length and
 * which nothing was checking.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { Breadcrumb, type BreadcrumbProps } from '@/ui/Breadcrumb'
import type { ViewState } from '@/types'
import { all, setUpDom, textsOf, type DomTeardown } from '../support/dom'

let teardown: DomTeardown

beforeEach(() => {
  teardown = setUpDom()
})

afterEach(() => {
  teardown()
})

interface Built {
  crumb: Breadcrumb
  navigated: ViewState[]
  files: number
  entries: string[]
}

function build(over: Partial<BreadcrumbProps> = {}): Built {
  const navigated: ViewState[] = []
  const entries: string[] = []
  let files = 0
  const crumb = new Breadcrumb({
    rootKind: 'genomes',
    rootChoices: ['genomes', 'contigs', 'whole'],
    fileLabel: 'sample.metacool',
    entries: [],
    onNavigate: (state) => navigated.push(state),
    onOpenFile: () => {
      files++
    },
    onSelectEntry: (entry) => entries.push(entry),
    ...over,
  })
  document.body.appendChild(crumb.el)
  return {
    crumb,
    navigated,
    entries,
    get files() {
      return files
    },
  }
}

/** Every crumb, in order, whatever element each turned out to be. */
const trail = (crumb: Breadcrumb): string[] => textsOf(crumb.el, '.crumb')

describe('with no file open', () => {
  it('says so, and offers nothing to click', () => {
    const { crumb } = build()
    crumb.render(null)
    expect(trail(crumb)).toEqual(['open a file'])
    expect(all(crumb.el, 'button')).toHaveLength(0)
  })
})

describe('the file crumb', () => {
  it('leads to the picker, and says that clicking it does', () => {
    const built = build()
    built.crumb.render({ uri: 'sample.metacool', view: 'genomes' })
    const file = built.crumb.el.querySelector('.crumb-file') as HTMLButtonElement
    expect(file.textContent).toBe('sample.metacool')
    expect(file.title).toContain('click to open another file')
    file.click()
    expect(built.files).toBe(1)
  })
})

describe('the root crumb', () => {
  it('is a link back to the table *and* an arrow to switch tables', () => {
    const built = build()
    built.crumb.render({ uri: 'f', view: 'genome', genome: 'MAG_01' })
    const group = built.crumb.el.querySelector('.crumb-group') as HTMLElement
    const [label] = all<HTMLButtonElement>(group, 'button')
    expect(label.textContent).toBe('Genomes')
    // Going up is the common action and stays one click; switching table is the
    // rare one and gets the arrow beside it.
    label.click()
    expect(built.navigated).toEqual([{ uri: 'f', view: 'genomes' }])
    expect(group.querySelector('.crumb-arrow')).not.toBeNull()
  })

  it('marks itself current when the reader is on it', () => {
    const { crumb } = build()
    crumb.render({ uri: 'f', view: 'genomes' })
    const label = crumb.el.querySelector('.crumb-group .crumb') as HTMLElement
    expect(label.classList.contains('current')).toBe(true)
  })

  it('calls a contig table by the file’s own noun', () => {
    const { crumb } = build({ rootKind: 'contigs', contigNoun: 'Chromosomes' })
    crumb.render({ uri: 'f', view: 'contigs' })
    expect(trail(crumb)).toEqual(['sample.metacool', 'Chromosomes'])
  })

  it('names a whole-file view rather than leaving the table’s label on it', () => {
    const { crumb } = build()
    crumb.render({ uri: 'f', view: 'whole' })
    expect(trail(crumb)).toEqual(['sample.metacool', 'Whole genome'])
  })

  it('collapses to plain text where there is only one landing view', () => {
    const { crumb } = build({ rootChoices: ['contigs'], rootKind: 'contigs' })
    crumb.render({ uri: 'f', view: 'contigs' })
    expect(all(crumb.el, '.crumb-arrow')).toHaveLength(0)
  })

  it('opens the table menu on the arrow, and navigates from it', () => {
    const built = build()
    built.crumb.render({ uri: 'f', view: 'genomes' })
    const arrow = built.crumb.el.querySelector('.crumb-arrow') as HTMLButtonElement
    const menu = built.crumb.el.querySelector('.crumb-menu') as HTMLElement
    expect(menu.classList.contains('hidden')).toBe(true)
    arrow.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    expect(menu.classList.contains('hidden')).toBe(false)
    // Each entry carries its key beside the word, so the label is the item's
    // text less the badge's.
    const labels = all<HTMLElement>(menu, '.crumb-menu-item').map(
      (item) => item.firstChild?.textContent ?? '',
    )
    expect(labels).toEqual(['Genomes', 'Contigs', 'Whole genome'])
    expect(all(menu, '.crumb-menu-item .kbd-inline')).toHaveLength(3)

    const contigs = all<HTMLButtonElement>(menu, '.crumb-menu-item')[1]
    contigs.click()
    expect(built.navigated).toEqual([{ uri: 'f', view: 'contigs' }])
    expect(menu.classList.contains('hidden')).toBe(true)
  })

  it('greys a choice this file cannot offer, and says why', () => {
    const { crumb } = build({
      rootKind: 'contigs',
      disabledChoices: { genomes: 'A cooler has one genome, so there is no table of them.' },
    })
    crumb.render({ uri: 'f', view: 'contigs' })
    const arrow = crumb.el.querySelector('.crumb-arrow') as HTMLButtonElement
    arrow.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    const item = all<HTMLButtonElement>(crumb.el, '.crumb-menu-item')[0]
    expect(item.textContent).toBe('Genomes')
    expect(item.disabled).toBe(true)
    expect(item.title).toContain('A cooler has one genome')
    // A shortcut printed beside something that cannot be done is a shortcut that
    // does nothing.
    expect(item.querySelector('.kbd-inline')).toBeNull()
  })

  it('closes the table menu on a click elsewhere', () => {
    const { crumb } = build()
    crumb.render({ uri: 'f', view: 'genomes' })
    const arrow = crumb.el.querySelector('.crumb-arrow') as HTMLButtonElement
    arrow.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    const menu = crumb.el.querySelector('.crumb-menu') as HTMLElement
    expect(menu.classList.contains('hidden')).toBe(false)
    window.dispatchEvent(new MouseEvent('click'))
    expect(menu.classList.contains('hidden')).toBe(true)
  })
})

describe('the trail below the root', () => {
  it('walks genome → contig → region, with only the last one inert', () => {
    const built = build()
    built.crumb.render({ uri: 'f', view: 'region', genome: 'MAG_01', region: 'ctg7:100-900' })
    expect(trail(built.crumb)).toEqual(['sample.metacool', 'Genomes', 'MAG_01', 'ctg7', 'ctg7:100-900'])
    const current = all(built.crumb.el, '.crumb.current')
    expect(current).toHaveLength(1)
    expect(current[0].textContent).toBe('ctg7:100-900')
    expect(current[0].tagName).toBe('SPAN')

    // The contig crumb strips the coordinates off, which is what going up means.
    const contig = all<HTMLButtonElement>(built.crumb.el, 'button').find(
      (node) => node.textContent === 'ctg7',
    )
    contig?.click()
    expect(built.navigated).toEqual([
      { uri: 'f', view: 'region', region: 'ctg7', genome: 'MAG_01' },
    ])
  })

  it('leads a contig opened from the contigs table back to that table', () => {
    const { crumb } = build({ rootKind: 'genomes' })
    // No genome on the state: this contig was opened from the contigs table, and
    // a trail reading "Genomes > NODE_7" is a path that does not exist.
    crumb.render({ uri: 'f', view: 'region', region: 'NODE_7' })
    expect(trail(crumb)).toEqual(['sample.metacool', 'Contigs', 'NODE_7'])
  })

  it('shows a contig × contig block as the pair it is', () => {
    const { crumb } = build()
    crumb.render({
      uri: 'f',
      view: 'region',
      genome: 'MAG_01',
      region: 'ctg1:0-100',
      region2: 'ctg2:0-100',
    })
    expect(trail(crumb).at(-1)).toBe('ctg1 × ctg2')
  })

  it('hangs a pair of genomes off the first of them', () => {
    const built = build()
    built.crumb.render({ uri: 'f', view: 'pair', genome: 'MAG_01', genome2: 'MAG_02' })
    expect(trail(built.crumb)).toEqual([
      'sample.metacool',
      'Genomes',
      'MAG_01',
      'MAG_01 × MAG_02',
    ])
    all<HTMLButtonElement>(built.crumb.el, 'button')
      .find((node) => node.textContent === 'MAG_01')
      ?.click()
    expect(built.navigated).toEqual([{ uri: 'f', view: 'genome', genome: 'MAG_01' }])
  })

  it('names a small selection and counts a large one', () => {
    const { crumb } = build()
    crumb.render({ uri: 'f', view: 'selection', genomes: 'a,b,c' })
    expect(trail(crumb).at(-1)).toBe('a × b × c')
    crumb.render({ uri: 'f', view: 'selection', genomes: 'a,b,c,d' })
    expect(trail(crumb).at(-1)).toBe('4 genomes')
  })

  it('leads a selection of contigs back to the contigs table', () => {
    const { crumb } = build({ contigNoun: 'Chromosomes' })
    crumb.render({ uri: 'f', view: 'selection', regions: 'I,II,III,IV' })
    expect(trail(crumb)).toEqual(['sample.metacool', 'Chromosomes', '4 chromosomes'])
  })
})

describe('the entry picker', () => {
  it('precedes the root, because switching entry invalidates everything after it', () => {
    const built = build({ entries: ['rep1', 'rep2'], currentEntry: 'rep2' })
    built.crumb.render({ uri: 'f::entries/rep2', view: 'genomes' })
    const select = built.crumb.el.querySelector('select.crumb-select') as HTMLSelectElement
    expect(select).not.toBeNull()
    expect(select.value).toBe('rep2')
    expect(textsOf(select, 'option')).toEqual(['rep1', 'rep2'])
    // Before the root crumb in document order.
    expect(select.compareDocumentPosition(built.crumb.el.querySelector('.crumb-group') as Node)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    )

    select.value = 'rep1'
    select.dispatchEvent(new Event('change'))
    expect(built.entries).toEqual(['rep1'])
  })

  it('calls an mcool’s entries resolutions', () => {
    const { crumb } = build({ entries: ['1000', '5000'], currentEntry: '1000', entryNoun: 'resolution' })
    crumb.render({ uri: 'f::resolutions/1000', view: 'contigs' })
    expect((crumb.el.querySelector('select.crumb-select') as HTMLSelectElement).title).toBe(
      'Resolution to view',
    )
  })

  it('is absent on a plain metacool', () => {
    const { crumb } = build()
    crumb.render({ uri: 'f', view: 'genomes' })
    expect(crumb.el.querySelector('select.crumb-select')).toBeNull()
  })
})
