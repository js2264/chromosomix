// @vitest-environment jsdom
/**
 * The controls an alignment lane has that no other kind does (§8.13).
 *
 * These are not styling. A colouring is also a *grouping*, so it decides how
 * the pile is packed into rows; a MAPQ floor and the duplicate switch decide
 * which records are counted at all, and therefore move the coverage band as
 * well as the reads. That is why they live in the entry's style — where the
 * caches are keyed and the session is stored — rather than in the renderer, and
 * it is why what these tests assert is the *store*, not the markup.
 *
 * The legend is here for the same reason. It is built from `groupsFor` and
 * `readPalette` — the two functions the worker and the renderer themselves use
 * — so a key that disagreed with the picture would be a bug in one of those
 * rather than a second, hand-written palette drifting quietly out of step.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { AnnotationStore } from '@/annotations/store'
import {
  defaultStyle,
  readsOf,
  type AnnotationEntry,
  type ReadStyle,
} from '@/annotations/types'
import {
  colourByField,
  colourLegend,
  fillLegend,
  duplicatesToggle,
  mapqField,
  splitsToggle,
} from '@/ui/laneSettings'
import { all, setUpDom, textsOf, type DomTeardown } from '../support/dom'

/** Two controls in one container, since the two switches are now two functions. */
function el2(...parts: HTMLElement[]): HTMLElement {
  const host = document.createElement('div')
  host.append(...parts)
  return host
}

let teardown: DomTeardown

beforeEach(() => {
  teardown = setUpDom()
})

afterEach(() => {
  teardown()
})

interface Made {
  store: AnnotationStore
  entry: AnnotationEntry
}

function make(kind: 'alignments' | 'reads' = 'reads'): Made {
  const store = new AnnotationStore(`reads-${Math.random()}.metacool`, { persist: false })
  const entry = store.begin({
    card: 'linear',
    kind,
    id: `bam-${Math.random()}`,
    label: 'sample.bam',
    source: { kind: 'local', name: 'sample.bam', file: new File([], 'sample.bam') },
    placement: { top: false, right: false, bottom: true, left: false },
    style: defaultStyle(kind, '#0072b2'),
    visible: true,
  })
  return { store, entry }
}

/** A BAM as it actually imports: a depth row and a pile row, pointing at each other. */
function makePair(): { store: AnnotationStore; depth: AnnotationEntry; pile: AnnotationEntry } {
  const store = new AnnotationStore(`bam-${Math.random()}.metacool`, { persist: false })
  const common = {
    card: 'linear' as const,
    source: { kind: 'local' as const, name: 'sample.bam', file: new File([], 'sample.bam') },
    placement: { top: false, right: false, bottom: true, left: false },
    visible: true,
  }
  const depth = store.begin({
    ...common,
    kind: 'alignments',
    id: 'bam-depth',
    label: 'sample',
    style: defaultStyle('alignments', '#0072b2'),
  })
  const pile = store.begin({
    ...common,
    kind: 'reads',
    id: 'bam-pile',
    label: 'sample · reads',
    style: defaultStyle('reads', '#0072b2'),
    partner: depth.id,
  })
  store.update(depth.id, { partner: pile.id })
  return { store, depth, pile }
}

/** The entry as the store now holds it — `begin` returns a snapshot, not a view. */
function now(made: Made): AnnotationEntry {
  const found = made.store.byId(made.entry.id)
  if (found === undefined) throw new Error('the row went away')
  return found
}

describe('colour by', () => {
  it('offers every colouring, starting on strand', () => {
    const made = make()
    const field = colourByField(made.store, made.entry)
    document.body.append(field)
    const select = field.querySelector('select') as HTMLSelectElement
    expect([...select.options].map((option) => option.value)).toEqual([
      'strand',
      'pair',
      'insert',
      'mate',
      'mapq',
      'none',
    ])
    expect(select.value).toBe('strand')
  })

  it('writes the choice into the lane’s style, where the cache is keyed', () => {
    const made = make()
    const field = colourByField(made.store, made.entry)
    document.body.append(field)
    const select = field.querySelector('select') as HTMLSelectElement
    select.value = 'insert'
    select.dispatchEvent(new Event('change'))
    expect(readsOf(now(made).style).colourBy).toBe('insert')
    // …and leaves everything else on the style alone.
    expect(now(made).style.colour).toBe('#0072b2')
    expect(readsOf(now(made).style).minMapq).toBe(0)
  })

  it('says what each colouring means, because four of the six are not obvious', () => {
    const made = make()
    const field = colourByField(made.store, made.entry)
    const titles = all<HTMLOptionElement>(field, 'option').map((option) => option.title)
    expect(titles.every((title) => title.length > 20)).toBe(true)
  })
})

describe('the MAPQ floor', () => {
  function typed(made: Made, value: string): number {
    const field = mapqField(made.store, made.entry)
    document.body.append(field)
    const box = field.querySelector('input') as HTMLInputElement
    box.value = value
    box.dispatchEvent(new Event('change'))
    return readsOf(now(made).style).minMapq
  }

  it('takes a number a pipeline was written against', () => {
    expect(typed(make(), '30')).toBe(30)
    expect(typed(make(), '60')).toBe(60)
  })

  it('clamps rather than refusing, as the height box does', () => {
    expect(typed(make(), '900')).toBe(255)
    expect(typed(make(), '-5')).toBe(0)
  })

  it('leaves the lane alone when what was typed is not a number', () => {
    const made = make()
    expect(typed(made, 'thirty')).toBe(0)
  })
})

describe('the switches', () => {
  function chips(made: Made): HTMLButtonElement[] {
    const row = el2(splitsToggle(made.store, made.entry), duplicatesToggle(made.store, made.entry))
    document.body.append(row)
    expect(row.querySelector('.ann-chips')).not.toBeNull()
    return all<HTMLButtonElement>(row, '.btn-chip')
  }

  it('starts with both switches off', () => {
    const made = make()
    expect(chips(made).map((chip) => chip.getAttribute('aria-pressed'))).toEqual([
      'false',
      'false',
    ])
  })

  it('turns each one over without disturbing the others', () => {
    const cases: Array<[number, Partial<ReadStyle>]> = [
      [0, { splits: true, hideDuplicates: false }],
      [1, { splits: false, hideDuplicates: true }],
    ]
    for (const [at, expected] of cases) {
      // A row of chips each, because the card rebuilds when the store changes.
      const made = make()
      chips(made)[at].click()
      expect(readsOf(now(made).style), `chip ${at}`).toMatchObject(expected)
    }
  })

  it('does not revert the last edit when the card has not rebuilt yet', () => {
    // The trap a nested style field sets. Every other control patches one
    // top-level field and lets the store merge it; a `{ reads: {...} }` write
    // replaces the whole record, so it has to be built from what the store has
    // *now*. `AnnotationCard.render` defers rebuilding while a control holds
    // focus, so the entry a field was built with is routinely older than the
    // store — set a floor, pick a colouring, and the floor was silently gone.
    const made = make()
    const mapq = mapqField(made.store, made.entry)
    const colour = colourByField(made.store, made.entry)
    document.body.append(mapq, colour)

    const box = mapq.querySelector('input') as HTMLInputElement
    box.value = '30'
    box.dispatchEvent(new Event('change'))

    // …and now the *stale* select, built from the pre-edit snapshot.
    const select = colour.querySelector('select') as HTMLSelectElement
    select.value = 'insert'
    select.dispatchEvent(new Event('change'))

    expect(readsOf(now(made).style)).toMatchObject({ colourBy: 'insert', minMapq: 30 })
  })

  it('says that split reads are drawn and never counted', () => {
    const made = make()
    const [splits] = chips(made)
    splits.click()
    expect(readsOf(now(made).style).splits).toBe(true)
    expect(splits.title).toContain('never counted in the depth')
  })
})

/**
 * A BAM's two rows are one file, and the filters have to say so.
 *
 * The depth and the pile are separate rows all the way down — separate lanes,
 * separate heights, either closable without the other (§8.13) — and the one
 * thing that would be a lie if they drifted is *which reads count*. A mapping
 * quality floor set on the pile and not on the depth above it is two pictures
 * of two different files under one name, and the reader has no way of telling:
 * both lanes are drawn, both look plausible, and the curve simply does not
 * match the pile it is over.
 */
describe('the two rows a BAM imports as', () => {
  it('carries a mapping-quality floor from either row to the other', () => {
    for (const from of ['depth', 'pile'] as const) {
      const bam = makePair()
      const entry = from === 'depth' ? bam.depth : bam.pile
      const field = mapqField(bam.store, entry)
      document.body.append(field)
      const box = field.querySelector('input') as HTMLInputElement
      box.value = '30'
      box.dispatchEvent(new Event('change'))

      expect(readsOf(bam.store.byId('bam-depth')!.style).minMapq, `set on the ${from}`).toBe(30)
      expect(readsOf(bam.store.byId('bam-pile')!.style).minMapq, `set on the ${from}`).toBe(30)
    }
  })

  it('carries the duplicate switch across too', () => {
    const bam = makePair()
    const chip = duplicatesToggle(bam.store, bam.pile).querySelector('button') as HTMLButtonElement
    document.body.append(chip)
    chip.click()
    expect(readsOf(bam.store.byId('bam-depth')!.style).hideDuplicates).toBe(true)
    expect(readsOf(bam.store.byId('bam-pile')!.style).hideDuplicates).toBe(true)
  })

  it('keeps the pile’s own drawing settings to itself', () => {
    // A colouring and a pairing describe a stack of rectangles and mean nothing
    // to a depth curve; `splits` is one-sided on purpose, since a supplementary
    // alignment is drawn and never counted. Writing any of the three through
    // would refetch the depth for a change it cannot show.
    const bam = makePair()
    const colour = colourByField(bam.store, bam.pile)
    document.body.append(colour)
    const select = colour.querySelector('select') as HTMLSelectElement
    select.value = 'insert'
    select.dispatchEvent(new Event('change'))

    const splits = splitsToggle(bam.store, bam.pile).querySelector('button') as HTMLButtonElement
    document.body.append(splits)
    splits.click()

    expect(readsOf(bam.store.byId('bam-pile')!.style)).toMatchObject({
      colourBy: 'insert',
      splits: true,
    })
    expect(readsOf(bam.store.byId('bam-depth')!.style)).toMatchObject({
      colourBy: 'strand',
      splits: false,
    })
  })

  it('writes only its own row once the other has been closed', () => {
    // Closing one row clears the survivor's link (`AnnotationStore.remove`), so
    // a write-through has nothing to chase. Without that this throws or, worse,
    // restyles an id the store has minted to something else since.
    const bam = makePair()
    bam.store.remove(bam.depth.id)
    const field = mapqField(bam.store, bam.pile)
    document.body.append(field)
    const box = field.querySelector('input') as HTMLInputElement
    box.value = '30'
    box.dispatchEvent(new Event('change'))

    expect(bam.store.byId('bam-depth')).toBeUndefined()
    expect(bam.store.byId('bam-pile')?.partner).toBeUndefined()
    expect(readsOf(bam.store.byId('bam-pile')!.style).minMapq).toBe(30)
  })
})

describe('the key', () => {
  it('names every category the current colouring can produce', () => {
    const made = make()
    made.store.restyle(made.entry.id, {
      reads: { ...readsOf(made.entry.style), colourBy: 'mate' },
    })
    const key = colourLegend(now(made))
    document.body.append(key)
    expect(textsOf(document.body, '.ann-key-item')).toEqual([
      'unpaired',
      'mate unmapped',
      'same sequence',
      'another sequence',
    ])
  })

  it('gives the lane’s own colour to the first category, so the two agree', () => {
    const made = make()
    const key = colourLegend(now(made))
    document.body.append(key)
    const chips = all<HTMLElement>(key, '.ann-key-chip')
    expect(chips).toHaveLength(2)
    // `rgb(0, 114, 178)` is `#0072b2` as jsdom normalises it.
    expect(chips[0].style.background).toBe('rgb(0, 114, 178)')
    expect(chips[1].style.background).not.toBe(chips[0].style.background)
  })

  it('draws nothing where there is one colour, since that is not a key', () => {
    const made = make()
    made.store.restyle(made.entry.id, {
      reads: { ...readsOf(made.entry.style), colourBy: 'none' },
    })
    expect(colourLegend(now(made)).children).toHaveLength(0)
  })

  it('is refreshed by the picker, since the card will not rebuild under focus', () => {
    // The card defers its own rebuild while a control holds focus, and picking
    // from a select leaves the focus on it — so the lane repainted in the new
    // colours while the legend under the picker went on naming the old ones,
    // until the reader happened to click somewhere else.
    const made = make()
    const key = colourLegend(made.entry)
    const field = colourByField(made.store, made.entry, (by) =>
      fillLegend(key, made.entry.style.colour, by),
    )
    document.body.append(field, key)
    expect(textsOf(key, '.ann-key-item')).toEqual(['forward', 'reverse'])

    const select = field.querySelector('select') as HTMLSelectElement
    select.value = 'mate'
    select.dispatchEvent(new Event('change'))
    expect(textsOf(key, '.ann-key-item')).toEqual([
      'unpaired',
      'mate unmapped',
      'same sequence',
      'another sequence',
    ])
  })
})
