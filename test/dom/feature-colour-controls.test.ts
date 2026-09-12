// @vitest-environment jsdom
/**
 * The controls a lane of intervals has (§8.16).
 *
 * What they assert is the **store**, for `read-controls.test.ts`'s reason: the
 * choice lives in the entry's style, where the session is written and where both
 * drawing surfaces read it, and markup that changed without the style changing
 * would be a control that does nothing.
 *
 * The key is here for the same reason the pile's is. It is built from
 * `featureColouring` — the function the renderer itself calls — so a legend that
 * disagreed with the lane would be a bug in the ink rule rather than a second
 * palette quietly drifting out of step.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { AnnotationStore } from '@/annotations/store'
import { FeatureBuilder } from '@/annotations/featureset'
import { featuresOf } from '@/annotations/fields'
import { defaultStyle, type AnnotationEntry, type AnnotationKind } from '@/annotations/types'
import { NO_ANSWER } from '@/render/featureInk'
import {
  arrowsToggle,
  featureColourField,
  featureLegend,
  fillFeatureLegend,
} from '@/ui/laneSettings'
import { setUpDom, type DomTeardown } from '../support/dom'

let teardown: DomTeardown

beforeEach(() => {
  teardown = setUpDom()
})

afterEach(() => {
  teardown()
})

const LANE = '#0072b2'

interface Made {
  store: AnnotationStore
  entry: AnnotationEntry
}

/** A BED with two strands, a category column and a numeric one. */
function features() {
  const build = new FeatureBuilder()
  build.add('I', 100, 400, { strand: 1, name: 'a', detail: 'biotype protein_coding · signal 3' })
  build.add('I', 500, 900, { strand: -1, name: 'b', detail: 'biotype tRNA · signal 9' })
  build.add('I', 1000, 1400, { strand: 1, name: 'c', detail: 'biotype protein_coding · signal 5' })
  return build.finish()
}

function make(kind: AnnotationKind = 'segments', withPayload = true): Made {
  const store = new AnnotationStore(`features-${Math.random()}.metacool`, { persist: false })
  const entry = store.begin({
    card: 'linear',
    kind,
    id: `bed-${Math.random()}`,
    label: 'peaks.bed',
    source: { kind: 'local', name: 'peaks.bed', file: new File([], 'peaks.bed') },
    placement: { top: false, right: false, bottom: true, left: false },
    style: defaultStyle(kind, LANE),
    visible: true,
  })
  if (withPayload) {
    store.update(entry.id, { payload: { kind: 'features', data: features() } })
  }
  return { store, entry: store.byId(entry.id) ?? entry }
}

function now(made: Made): AnnotationEntry {
  const found = made.store.byId(made.entry.id)
  if (found === undefined) throw new Error('the row went away')
  return found
}

function selectIn(field: HTMLElement): HTMLSelectElement {
  return field.querySelector('select') as HTMLSelectElement
}

describe('colour by, on a lane of intervals', () => {
  it('offers the file’s own columns as well as the two every set has', () => {
    const made = make()
    const field = featureColourField(made.store, made.entry)
    document.body.append(field)
    const values = [...selectIn(field).options].map((option) => option.value)
    expect(values.slice(0, 3)).toEqual(['', 'strand', 'score'])
    expect(values).toContain('biotype')
    expect(values).toContain('signal')
    // Strand is where a feature lane starts.
    expect(selectIn(field).value).toBe('strand')
  })

  it('writes the choice into the lane’s style, and leaves the rest alone', () => {
    const made = make()
    const field = featureColourField(made.store, made.entry)
    document.body.append(field)
    const select = selectIn(field)
    select.value = 'biotype'
    select.dispatchEvent(new Event('change'))
    expect(featuresOf(now(made).style, 'segments').colourBy).toBe('biotype')
    expect(now(made).style.colour).toBe(LANE)
    expect(featuresOf(now(made).style, 'segments').arrows).toBe(true)
  })

  it('keeps a choice the file cannot answer, rather than correcting it away', () => {
    // A session from another assembly. Silently moving the reader somewhere
    // else loses the setting the moment the right file comes back.
    const made = make()
    made.store.restyle(made.entry.id, { features: { colourBy: 'gene_biotype', arrows: true } })
    const field = featureColourField(made.store, now(made))
    document.body.append(field)
    expect(selectIn(field).value).toBe('gene_biotype')
    expect(selectIn(field).selectedOptions[0].text).toContain('not in this file')
  })

  it('offers the built-ins while the worker is still parsing', () => {
    const made = make('segments', false)
    const field = featureColourField(made.store, made.entry)
    document.body.append(field)
    expect([...selectIn(field).options].map((o) => o.value)).toEqual(['', 'strand', 'score'])
  })
})

describe('the key under the picker', () => {
  it('names the strands the file actually has, in the order they are drawn', () => {
    const made = make()
    const key = featureLegend(made.entry)
    document.body.append(key)
    const labels = [...key.querySelectorAll('.ann-key-item')].map((item) => item.textContent)
    expect(labels).toEqual(['forward', 'reverse'])
    const chips = [...key.querySelectorAll('.ann-key-chip')] as HTMLElement[]
    // Forward keeps the colour on the row's own chip.
    expect(chips[0].style.background).toBe('rgb(0, 114, 178)')
    expect(chips[1].style.background).not.toBe(chips[0].style.background)
  })

  it('follows the picker without waiting for the card to rebuild', () => {
    // Picking from a select leaves the focus on it and the card defers while a
    // control has focus, so a key that waited would name the old colours until
    // the reader clicked somewhere else.
    const made = make()
    const key = featureLegend(made.entry)
    const field = featureColourField(made.store, made.entry, (by) =>
      fillFeatureLegend(key, made.entry, by),
    )
    document.body.append(field, key)
    const select = selectIn(field)
    select.value = 'biotype'
    select.dispatchEvent(new Event('change'))
    const labels = [...key.querySelectorAll('.ann-key-item')].map((item) => item.textContent)
    expect(labels).toEqual(['protein_coding', 'tRNA', 'not set'])
    // …and the row that carries no value for the column is the neutral this
    // application already uses for *no answer*.
    const chips = [...key.querySelectorAll('.ann-key-chip')] as HTMLElement[]
    expect(chips.at(-1)?.style.background).toBe(cssColour(NO_ANSWER))
  })

  it('draws a numeric column as a ramp with its two ends written on it', () => {
    const made = make()
    const key = featureLegend(made.entry)
    document.body.append(key)
    fillFeatureLegend(key, made.entry, 'signal')
    expect(key.querySelector('.ann-key-ramp')).not.toBeNull()
    expect([...key.querySelectorAll('.ann-key-end')].map((end) => end.textContent)).toEqual([
      '3',
      '9',
    ])
    // No chips: a hundred thousand p-values have no categories to name.
    expect(key.querySelectorAll('.ann-key-item')).toHaveLength(0)
  })

  it('says nothing where there is nothing to say', () => {
    const made = make()
    const key = featureLegend(made.entry)
    fillFeatureLegend(key, made.entry, '')
    expect(key.childElementCount).toBe(0)
  })
})

describe('pointing the strands', () => {
  it('starts on, and writes the switch into the style', () => {
    const made = make()
    const chip = arrowsToggle(made.store, made.entry).querySelector('button') as HTMLButtonElement
    document.body.append(chip)
    expect(chip.getAttribute('aria-pressed')).toBe('true')
    chip.click()
    expect(featuresOf(now(made).style, 'segments').arrows).toBe(false)
    // …and does not disturb the colouring beside it.
    expect(featuresOf(now(made).style, 'segments').colourBy).toBe('strand')
  })
})

/** `#rrggbb` as the DOM reports a background it was given. */
function cssColour(hex: string): string {
  const value = Number.parseInt(hex.slice(1), 16)
  return `rgb(${(value >> 16) & 255}, ${(value >> 8) & 255}, ${value & 255})`
}
