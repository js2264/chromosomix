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

import { Breadcrumb, resolutionLabel, type BreadcrumbProps } from '@/ui/Breadcrumb'
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
    // The last crumb is the **window alone**, under the crumb that names the
    // sequence: it used to repeat the contig, so the row ended
    // `ctg7 › ctg7:100-900` above a heading and a box printing the same string
    // a third and a fourth time. 1-based inclusive and grouped, like every
    // other coordinate a reader reads (§26.1).
    expect(trail(built.crumb)).toEqual(['sample.metacool', 'Genomes', 'MAG_01', 'ctg7', '101-900'])
    const current = all(built.crumb.el, '.crumb.current')
    expect(current).toHaveLength(1)
    expect(current[0].textContent).toBe('101-900')
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

/**
 * A genome browsed as tracks (§5.8): its root picks between its sequence list —
 * where a circle and an origin are declared with no map open (§8.15) — and its
 * whole genome, which is the browser rather than a map.
 */
describe('a genome browsed as tracks', () => {
  const genome = (): Built =>
    build({
      rootKind: 'contigs',
      rootChoices: ['contigs', 'whole'],
      contigNoun: 'Chromosomes',
      browser: true,
      fileLabel: 'PAK.fa',
    })

  it('names the browser the whole genome, and offers the Chromosomes table beside it', () => {
    const built = genome()
    built.crumb.render({ uri: 'PAK.fa', view: 'browser' })
    expect(trail(built.crumb)).toEqual(['PAK.fa', 'Whole genome'])
    const menu = built.crumb.el.querySelector('.crumb-menu') as HTMLElement
    const labels = all<HTMLElement>(menu, '.crumb-menu-item').map((item) => item.firstChild?.textContent ?? '')
    expect(labels).toEqual(['Chromosomes', 'Whole genome'])
    all<HTMLButtonElement>(menu, '.crumb-menu-item')[0].click()
    expect(built.navigated).toEqual([{ uri: 'PAK.fa', view: 'contigs' }])
  })

  it('goes back to the browser, not to a map, from the table', () => {
    const built = genome()
    built.crumb.render({ uri: 'PAK.fa', view: 'contigs' })
    expect(trail(built.crumb)).toEqual(['PAK.fa', 'Chromosomes'])
    const menu = built.crumb.el.querySelector('.crumb-menu') as HTMLElement
    all<HTMLButtonElement>(menu, '.crumb-menu-item')[1].click()
    expect(built.navigated).toEqual([{ uri: 'PAK.fa', view: 'browser' }])
  })

  it('keeps the sequence and the window below the root', () => {
    const built = genome()
    built.crumb.render({ uri: 'PAK.fa', view: 'browser', locus: 'LR657304.1:1-20,000' })
    expect(trail(built.crumb)).toEqual(['PAK.fa', 'Whole genome', 'LR657304.1', '1-20,000'])
    // Off the root, its label leads back to the whole genome.
    const root = all<HTMLButtonElement>(built.crumb.el, 'button.crumb').find((node) => node.textContent === 'Whole genome')
    root?.click()
    expect(built.navigated).toEqual([{ uri: 'PAK.fa', view: 'browser' }])
  })

  it('stays a plain crumb where there is no table to offer', () => {
    const built = build({ rootKind: 'contigs', rootChoices: [], fileLabel: 'x.bw' })
    built.crumb.render({ uri: 'x.bw', view: 'browser' })
    expect(trail(built.crumb)).toEqual(['x.bw', 'Whole genome'])
    expect(built.crumb.el.querySelector('.crumb-menu')).toBeNull()
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

  it('leaves an mcool’s rungs to the resolution picker', () => {
    const { crumb } = build({
      entries: ['1000', '5000'],
      currentEntry: '1000',
      entryNoun: 'resolution',
    })
    crumb.render({ uri: 'f::resolutions/1000', view: 'contigs' })
    // A rung is the same file drawn more or less finely, so it is not a step of
    // the trail and does not take a crumb.
    expect(crumb.el.querySelector('select.crumb-select')).toBeNull()
    expect(crumb.el.querySelector('.crumb-res')).not.toBeNull()
  })

  it('is absent on a plain metacool', () => {
    const { crumb } = build()
    crumb.render({ uri: 'f', view: 'genomes' })
    expect(crumb.el.querySelector('select.crumb-select')).toBeNull()
  })
})

describe('the resolution picker', () => {
  function ladder(over: Partial<BreadcrumbProps> = {}): Built {
    return build({
      entries: ['1000', '10000', '50000', '1000000'],
      currentEntry: '10000',
      entryNoun: 'resolution',
      ...over,
    })
  }

  const REGION: ViewState = { uri: 'f::resolutions/10000', view: 'region', region: 'I:1000-5000' }

  it('comes after the place, not before it', () => {
    const { crumb } = ladder()
    crumb.render(REGION)
    const res = crumb.el.querySelector('.crumb-res') as HTMLElement
    expect(res).not.toBeNull()
    // Every crumb of the trail is before it in document order.
    for (const node of all(crumb.el, '.crumb')) {
      expect(res.compareDocumentPosition(node)).toBe(Node.DOCUMENT_POSITION_PRECEDING)
    }
  })

  it('writes the rungs in bp, kb and Mb rather than in bins', () => {
    const { crumb } = ladder()
    crumb.render(REGION)
    expect(textsOf(crumb.el, '.res-stop span')).toEqual(['1 kb', '10 kb', '50 kb', '1 Mb'])
  })

  it('marks the rung that is open, and only it', () => {
    const { crumb } = ladder()
    crumb.render(REGION)
    expect(textsOf(crumb.el, '.res-stop.current span')).toEqual(['10 kb'])
    const checked = all<HTMLInputElement>(crumb.el, '.res-radio').map((box) => box.checked)
    expect(checked).toEqual([false, true, false, false])
  })

  it('opens the rung a stop is clicked on', () => {
    const built = ladder()
    built.crumb.render(REGION)
    const stop = all<HTMLInputElement>(built.crumb.el, '.res-radio')[2]
    stop.checked = true
    stop.dispatchEvent(new Event('change'))
    expect(built.entries).toEqual(['50000'])
  })

  it('walks the same ladder with the slider, on release rather than per rung', () => {
    const built = ladder()
    built.crumb.render(REGION)
    const slider = built.crumb.el.querySelector('.res-slider') as HTMLInputElement
    expect(slider.min).toBe('0')
    expect(slider.max).toBe('3')
    expect(slider.value).toBe('1')
    slider.value = '3'
    // Dragging across the ladder must not re-open the file at every rung.
    slider.dispatchEvent(new Event('input'))
    expect(built.entries).toEqual([])
    slider.dispatchEvent(new Event('change'))
    expect(built.entries).toEqual(['1000000'])
  })

  it('says nothing about a rung the reader is already on', () => {
    const built = ladder()
    built.crumb.render(REGION)
    const slider = built.crumb.el.querySelector('.res-slider') as HTMLInputElement
    slider.dispatchEvent(new Event('change'))
    expect(built.entries).toEqual([])
  })

  it('is absent where there is nothing to pick between', () => {
    const { crumb } = build({ entries: ['1000'], currentEntry: '1000', entryNoun: 'resolution' })
    crumb.render(REGION)
    expect(crumb.el.querySelector('.crumb-res')).toBeNull()
  })

  it('is absent on a collection of replicates, which is not a ladder', () => {
    const { crumb } = build({ entries: ['rep1', 'rep2'], currentEntry: 'rep1' })
    crumb.render({ uri: 'f::entries/rep1', view: 'genomes' })
    expect(crumb.el.querySelector('.crumb-res')).toBeNull()
    expect(crumb.el.querySelector('select.crumb-select')).not.toBeNull()
  })

  it('does not lose itself on a selection or a pair, which return early', () => {
    const { crumb } = ladder()
    crumb.render({ uri: 'f::resolutions/10000', view: 'selection', regions: 'I,II' })
    expect(crumb.el.querySelector('.crumb-res')).not.toBeNull()
    crumb.render({ uri: 'f::resolutions/10000', view: 'pair', genome: 'a', genome2: 'b' })
    expect(crumb.el.querySelector('.crumb-res')).not.toBeNull()
  })
})

describe('how a rung is written', () => {
  it('trims the places a round number does not need', () => {
    expect(resolutionLabel(1)).toBe('1 bp')
    expect(resolutionLabel(500)).toBe('500 bp')
    expect(resolutionLabel(1_000)).toBe('1 kb')
    expect(resolutionLabel(12_500)).toBe('12.5 kb')
    expect(resolutionLabel(1_000_000)).toBe('1 Mb')
    expect(resolutionLabel(2_500_000)).toBe('2.5 Mb')
  })

  it('answers a dash rather than a number for what is not one', () => {
    expect(resolutionLabel(0)).toBe('—')
    expect(resolutionLabel(Number.NaN)).toBe('—')
  })
})

describe('a ladder with more rungs than fit', () => {
  /** A 4DN-shaped `.mcool`: eleven rungs, which is six hundred pixels of chips. */
  const MANY = [
    '1000', '2000', '5000', '10000', '25000', '50000',
    '100000', '250000', '500000', '1000000', '2500000',
  ]

  /**
   * **A dropdown, not a slider and one chip.**
   *
   * What stood here asserted the thinned row: the slider, whose tooltip listed
   * every rung, and a single chip naming the one being read. Between them they
   * said how many rungs there were and which one you were on, and named the rest
   * only to a reader who hovered the track — so the control that was there to
   * save room was also the one that hid the ladder. The dropdown is the whole
   * list, in the ladder's own order, in about the same width.
   */
  it('collapses to a dropdown of every rung, not eleven chips', () => {
    const { crumb } = build({ entries: MANY, currentEntry: '25000', entryNoun: 'resolution' })
    crumb.render({ uri: 'f::resolutions/25000', view: 'contigs' })
    expect(crumb.el.querySelector('.res-slider')).toBeNull()
    expect(all(crumb.el, '.res-stop')).toHaveLength(0)
    const picker = crumb.el.querySelector('.res-pick') as HTMLSelectElement
    expect([...picker.options].map((option) => option.text)).toEqual([
      '1 kb', '2 kb', '5 kb', '10 kb', '25 kb', '50 kb',
      '100 kb', '250 kb', '500 kb', '1 Mb', '2.5 Mb',
    ])
    expect(picker.options[picker.selectedIndex]?.text).toBe('25 kb')
  })

  it('walks the whole ladder from the dropdown', () => {
    const built = build({ entries: MANY, currentEntry: '25000', entryNoun: 'resolution' })
    built.crumb.render({ uri: 'f::resolutions/25000', view: 'contigs' })
    const picker = built.crumb.el.querySelector('.res-pick') as HTMLSelectElement
    picker.value = '0'
    picker.dispatchEvent(new Event('change'))
    expect(built.entries).toEqual(['1000'])
  })

  it('says what each rung is in bins, on the rung itself', () => {
    const { crumb } = build({ entries: MANY, currentEntry: '25000', entryNoun: 'resolution' })
    crumb.render({ uri: 'f::resolutions/25000', view: 'contigs' })
    const picker = crumb.el.querySelector('.res-pick') as HTMLSelectElement
    expect(picker.options[0]?.title).toContain('1,000 bp per bin')
    expect(picker.options[10]?.title).toContain('2,500,000 bp per bin')
  })
})
