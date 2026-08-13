// @vitest-environment jsdom
/**
 * The **Metadata** card (§8.12): the file's own columns, offered and drawn.
 *
 * What is worth testing here is the *offer*, because that is where the level
 * rule meets a reader. A genome × genome overview cannot show a bin weight and
 * a bin × bin view can show everything, and the card has to say which is which
 * without either hiding options or offering ones that would draw nothing.
 *
 * The rest is the claim the card exists to make good on: a column that has been
 * added is an ordinary annotation row — colour, name, eye, height, limits,
 * location, export — because it joins the same store a dropped bigWig joins.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { AnnotationStore } from '@/annotations/store'
import { MetadataIndex } from '@/annotations/metaIndex'
import { metadataId, type MetaLevel } from '@/annotations/metadata'
import { MetadataCard } from '@/ui/MetadataCard'
import type { Table } from '@/types'
import { all, buttonNamed, setUpDom, type DomTeardown } from '../support/dom'

let teardown: DomTeardown
const built: MetadataCard[] = []

beforeEach(() => {
  teardown = setUpDom()
  sessionStorage.clear()
})

afterEach(() => {
  for (const card of built.splice(0, built.length)) card.destroy()
  teardown()
  sessionStorage.clear()
})

function table(columns: Record<string, string[] | Float64Array>): Table {
  const names = Object.keys(columns)
  const length = names.length === 0 ? 0 : (columns[names[0]] as ArrayLike<unknown>).length
  return {
    length,
    columns: names,
    data: columns as Table['data'],
    get: (column, row) => (columns[column] as ArrayLike<string | number>)?.[row],
    strings: (column) => columns[column] as string[],
    numbers: (column) => Array.from(columns[column] as ArrayLike<number>, Number),
  }
}

interface Made {
  store: AnnotationStore
  card: MetadataCard
  index: MetadataIndex
}

/** A metagenome of two MAGs, four contigs, with a column on each table. */
function make(level: MetaLevel | null): Made {
  const store = new AnnotationStore(`metadata-${Math.random()}.metacool`, { persist: false })
  const index = new MetadataIndex({
    genomes: table({
      name: ['MAG_1', 'MAG_2'],
      completeness: Float64Array.from([98.1, 74.2]),
    }),
    contigs: table({
      name: ['c1', 'c2', 'c3', 'c4'],
      length: Float64Array.from([4000, 4000, 4000, 4000]),
      genome_id: Float64Array.from([0, 0, 1, 1]),
      mge_class: ['phage', 'chromosome', 'chromosome', 'plasmid'],
    }),
    binsize: 1000,
    binColumns: [
      { name: 'chrom', text: false },
      { name: 'start', text: false },
      { name: 'end', text: false },
      { name: 'weight', text: false },
    ],
    onChange: () => {},
  })
  const card = new MetadataCard({
    store,
    index: () => index,
    level: () => level,
    onExport: () => {},
  })
  built.push(card)
  document.body.append(card.el)
  return { store, card, index }
}

/** Every option of the drop-down, as `label` and whether it can be chosen. */
function options(card: MetadataCard): Array<{ value: string; enabled: boolean }> {
  return all<HTMLOptionElement>(card.el, 'option').map((option) => ({
    value: option.value,
    enabled: !option.disabled,
  }))
}

/** Choose one column and press add. */
function add(made: Made, value: string): void {
  const select = made.card.el.querySelector('select') as HTMLSelectElement
  select.value = value
  buttonNamed(made.card.el, 'add')?.click()
}

describe('what the drop-down offers', () => {
  it('discovers the columns of all three tables, the skeleton aside', () => {
    const made = make('bin')
    expect(options(made.card).map((option) => option.value)).toEqual([
      'genomes/completeness',
      'contigs/length',
      'contigs/mge_class',
      'bins/weight',
    ])
    // `name`, `genome_id`, `chrom`, `start` and `end` are the tables' skeleton:
    // they are what the axis is already labelled with.
    expect(options(made.card).every((option) => option.enabled)).toBe(true)
  })

  it('refuses a finer table than the axis, visibly and with the reason', () => {
    const made = make('genome')
    // A genome × genome overview: one cell is one MAG, so only the genomes
    // table has anything exact to say about it.
    expect(options(made.card).filter((option) => option.enabled).map((o) => o.value)).toEqual([
      'genomes/completeness',
    ])
    // Not hidden — a control that silently holds back half its options is one a
    // reader concludes is broken.
    expect(options(made.card)).toHaveLength(4)
    expect(made.card.el.textContent).toContain('a cell of this view is one genome')
    expect(made.card.el.textContent).toContain('out of reach here')
  })

  it('offers the contigs table at contig level and the bins table nowhere above bin', () => {
    const made = make('contig')
    expect(options(made.card).filter((option) => option.enabled).map((o) => o.value)).toEqual([
      'genomes/completeness',
      'contigs/length',
      'contigs/mge_class',
    ])
  })

  it('says so rather than guessing when no map is mounted', () => {
    const made = make(null)
    expect(made.card.el.textContent).toContain('open a map')
  })
})

describe('a column that has been added', () => {
  it('becomes an ordinary annotation row, with the controls a track has', () => {
    const made = make('bin')
    add(made, 'genomes/completeness')
    const entry = made.store.byId(metadataId('genomes', 'completeness'))
    expect(entry).toBeDefined()
    expect(entry?.kind).toBe('metadata')
    expect(entry?.card).toBe('metadata')
    expect(entry?.status).toBe('ready')
    // The lane opens above the map: a loaded track lands at the bottom and a
    // computed one on the left, and a third arriving in either stack would be a
    // new row in the middle of an arrangement somebody has made.
    expect(entry?.placement.top).toBe(true)
    // The controls a lane has, from the one implementation those rows go
    // through: a colour, a name, an eye, a height, limits and the four edges.
    expect(all(made.card.el, '.ann-swatch')).toHaveLength(1)
    expect(all(made.card.el, '.ann-name')).toHaveLength(1)
    expect(all(made.card.el, '.ann-eye')).toHaveLength(1)
    expect(all(made.card.el, '.ann-size')).toHaveLength(1)
    expect(all(made.card.el, '.ann-limits')).toHaveLength(1)
    expect(all(made.card.el, '.ann-field-places')).toHaveLength(1)
  })

  it('is drawn as categories, with a legend and no value axis, when it is text', () => {
    const made = make('contig')
    add(made, 'contigs/mge_class')
    const entry = made.store.byId(metadataId('contigs', 'mge_class'))
    expect(entry?.kind).toBe('classes')
    // No limits and no colour picker: there is no value axis to bound, and one
    // swatch cannot describe three categories.
    expect(all(made.card.el, '.ann-limits')).toHaveLength(0)
    expect(all(made.card.el, '.ann-swatch')).toHaveLength(0)
    // The legend is the one thing a strip of colour cannot carry itself.
    expect(all(made.card.el, '.meta-legend-item').map((node) => node.textContent)).toEqual([
      'phage',
      'chromosome',
      'plasmid',
    ])
  })

  it('lands on the row that is already there when it is added twice', () => {
    const made = make('bin')
    add(made, 'genomes/completeness')
    add(made, 'genomes/completeness')
    expect(made.store.forCard('metadata')).toHaveLength(1)
    // …because the option is disabled once it is on the map, and says why.
    const option = options(made.card).find((it) => it.value === 'genomes/completeness')
    expect(option?.enabled).toBe(false)
  })

  it('says it is not drawn here rather than disappearing when the view coarsens', () => {
    // A bin weight added on a bin × bin view, seen from a genome × genome one:
    // the row stays, with its colour and its edge, and says why it is not on
    // screen. Removing it would be the app editing a reader's panel behind
    // them, and leaving it silent would look like a lane that failed to draw.
    const made = make('genome')
    made.store.begin({
      card: 'metadata',
      kind: 'metadata',
      id: metadataId('bins', 'weight'),
      label: 'weight',
      source: { kind: 'metadata', name: 'bins/weight', table: 'bins', column: 'weight' },
    })
    expect(made.card.el.textContent).toContain('not drawn here')
    expect(made.card.el.textContent).toContain('a cell of this view is one genome')
  })

  it('goes away with a press, and the option comes back', () => {
    const made = make('bin')
    add(made, 'contigs/length')
    const close = made.card.el.querySelector('.btn-close') as HTMLButtonElement
    close.click()
    expect(made.store.forCard('metadata')).toHaveLength(0)
    expect(options(made.card).find((it) => it.value === 'contigs/length')?.enabled).toBe(true)
  })
})

describe('the column itself', () => {
  it('is written out at its own granularity, under a header that names it', () => {
    const made = make('bin')
    const tsv = made.index.exportTsv('genomes', 'completeness', 'gut.metacool')
    expect(tsv).not.toBeNull()
    const lines = (tsv ?? '').trim().split('\n')
    expect(lines[1]).toBe('# file: gut.metacool')
    expect(lines[2]).toBe('# table: /genomes')
    expect(lines[3]).toBe('# column: completeness (quantitative)')
    expect(lines[4]).toBe('genome\tcompleteness')
    // One row per unit of the *source table*, never one per cell of a picture.
    expect(lines.slice(5)).toEqual(['MAG_1\t98.1', 'MAG_2\t74.2'])
  })

  it('writes a category by its name rather than by its code', () => {
    const made = make('contig')
    const lines = (made.index.exportTsv('contigs', 'mge_class', 'gut.metacool') ?? '')
      .trim()
      .split('\n')
    expect(lines.slice(-4)).toEqual([
      'c1\tphage',
      'c2\tchromosome',
      'c3\tchromosome',
      'c4\tplasmid',
    ])
  })
})
