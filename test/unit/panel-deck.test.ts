/**
 * The deck as a value: the link it round-trips through, the block each view
 * asks a companion for, and the budget N panels share (§15).
 *
 * The three ways a deck goes wrong without anybody noticing, in order of how
 * long it would take to notice:
 *
 * 1. **The link.** A `maps` key that does not round-trip shows the recipient a
 *    different number of maps from the sender, and the sender cannot tell.
 * 2. **The plan.** A companion that resolves a *different* block from the lead
 *    produces two pictures that look like a comparison and are not.
 * 3. **The budget.** N dense blocks against a guard written for one is a killed
 *    tab, at a size that depends on the reader's machine.
 */

import { describe, expect, it } from 'vitest'
import {
  MAPS_SEPARATOR,
  MAX_PANELS,
  VACANT,
  columnsFor,
  moveItem,
  panelBudgetBytes,
  parseMaps,
  sameRefs,
  serialiseMaps,
  type PanelRef,
} from '../../src/panels/deck'
import { planFor } from '../../src/panels/MapPanel'
import { parseViewState, serialiseViewState } from '../../src/state/ViewState'
import type { ViewState } from '../../src/types'

const remote = (uri: string): PanelRef => ({ kind: 'remote', uri })

describe('the maps key', () => {
  it('round-trips a list of remote files', () => {
    const refs = [remote('https://b.example.org/a.cool'), remote('https://b.example.org/c.mcool::resolutions/1000')]
    const encoded = serialiseMaps(refs)
    expect(encoded).toBe(
      `https://b.example.org/a.cool${MAPS_SEPARATOR}https://b.example.org/c.mcool::resolutions/1000`,
    )
    expect(parseMaps(encoded)).toEqual(refs)
  })

  it('has no key at all for an empty deck', () => {
    expect(serialiseMaps([])).toBeUndefined()
    expect(parseMaps(undefined)).toEqual([])
    expect(parseMaps('')).toEqual([])
  })

  /**
   * The whole of "degrades honestly". `uri2` omits its local second file, which
   * is right when there is one slot; with N slots omission moves everything
   * after it one place to the left, and the recipient gets a deck of two with no
   * sign that a map is missing.
   */
  it('keeps the position of a local companion as a vacancy', () => {
    const refs: PanelRef[] = [
      remote('https://b.example.org/a.cool'),
      { kind: 'local', uri: 'rep2.cool' },
      remote('https://b.example.org/c.cool'),
    ]
    expect(serialiseMaps(refs)).toBe(
      `https://b.example.org/a.cool${MAPS_SEPARATOR}${VACANT}${MAPS_SEPARATOR}https://b.example.org/c.cool`,
    )
    const back = parseMaps(serialiseMaps(refs))
    expect(back).toHaveLength(3)
    expect(back[1]).toEqual({ kind: 'vacant' })
    expect(back[0]).toEqual(refs[0])
    expect(back[2]).toEqual(refs[2])
  })

  it('drops empty segments but keeps spelled vacancies', () => {
    expect(parseMaps(`a.cool${MAPS_SEPARATOR}${MAPS_SEPARATOR}b.cool`)).toEqual([
      remote('a.cool'),
      remote('b.cool'),
    ])
  })

  it('refuses to build a deck past the limit from a hand-edited hash', () => {
    const many = Array.from({ length: 20 }, (_, i) => `f${i}.cool`).join(MAPS_SEPARATOR)
    expect(parseMaps(many)).toHaveLength(MAX_PANELS - 1)
  })

  /**
   * The reason the separator is a pipe rather than the comma every other list
   * in the hash uses: a comma is legal in a URI and a pipe is not, so the split
   * cannot be wrong the first time somebody publishes `sample,rep1.cool`.
   */
  it('survives a URI containing a comma', () => {
    const refs = [remote('https://b.example.org/sample,rep1.cool'), remote('https://b.example.org/x.cool')]
    expect(parseMaps(serialiseMaps(refs))).toEqual(refs)
  })
})

describe('the view state carrying a deck', () => {
  const CASES: ViewState[] = [
    { uri: 'a.cool', maps: 'https://b.example.org/b.cool', view: 'region', region: 'chrI' },
    {
      uri: 'https://b.example.org/a.cool',
      uri2: 'https://b.example.org/blend.cool',
      maps: `https://b.example.org/b.cool${MAPS_SEPARATOR}${VACANT}`,
      view: 'region',
      region: 'chrI:20,000-80,000',
      vmax: 8.25,
    },
  ]

  it('round-trips losslessly', () => {
    for (const state of CASES) {
      expect(parseViewState(serialiseViewState(state))).toEqual(state)
    }
  })

  /** Short and readable was a requirement, not a preference (§11). */
  it('leaves the separator legible in the hash', () => {
    const hash = serialiseViewState(CASES[1])
    expect(hash).toContain(`maps=https://b.example.org/b.cool${MAPS_SEPARATOR}${VACANT}`)
    expect(hash).not.toContain('%7C')
  })

  /**
   * The blend and the deck are different claims and compose rather than fight:
   * `uri2` is two files in one square, `maps` is N squares under one
   * navigation, and a reader may have both.
   */
  it('carries a blended square and a deck at once', () => {
    const parsed = parseViewState(serialiseViewState(CASES[1]))
    expect(parsed?.uri2).toBe('https://b.example.org/blend.cool')
    expect(parseMaps(parsed?.maps)).toHaveLength(2)
  })
})

describe('sameRefs', () => {
  it('separates a held local file from the vacancy that stands for it', () => {
    expect(sameRefs([{ kind: 'local', uri: 'a.cool' }], [{ kind: 'vacant' }])).toBe(false)
  })

  it('is order-sensitive, because the order is what a reader arranged', () => {
    expect(sameRefs([remote('a'), remote('b')], [remote('b'), remote('a')])).toBe(false)
    expect(sameRefs([remote('a'), remote('b')], [remote('a'), remote('b')])).toBe(true)
  })
})

describe('moveItem', () => {
  it('moves one place either way', () => {
    expect(moveItem(['a', 'b', 'c'], 0, 1)).toEqual(['b', 'a', 'c'])
    expect(moveItem(['a', 'b', 'c'], 2, 1)).toEqual(['a', 'c', 'b'])
  })

  it('is inert off either end, so the arrow on the first panel does nothing', () => {
    expect(moveItem(['a', 'b'], 0, -1)).toEqual(['a', 'b'])
    expect(moveItem(['a', 'b'], 1, 2)).toEqual(['a', 'b'])
  })
})

describe('columnsFor', () => {
  it('lays a row out as a row and a column as a column', () => {
    expect(columnsFor(4, 'row')).toBe(4)
    expect(columnsFor(4, 'column')).toBe(1)
  })

  /** `ceil`, not `floor`: three in two columns leaves one alone on a second row. */
  it('rounds a grid up to the near square', () => {
    expect([1, 2, 3, 4, 5, 6].map((n) => columnsFor(n, 'grid'))).toEqual([1, 2, 2, 2, 3, 3])
  })
})

describe('the shared budget', () => {
  const DEVICE = 4e9

  it('gives one panel the whole allowance', () => {
    expect(panelBudgetBytes(1, DEVICE)).toBe(DEVICE)
  })

  /**
   * The property that matters: however many panels there are, they cannot
   * together cost more than the single map the deck replaced.
   */
  it('never lets a deck cost more than one map did', () => {
    for (let n = 1; n <= MAX_PANELS; n++) {
      expect(panelBudgetBytes(n, DEVICE) * n).toBeCloseTo(DEVICE, 0)
    }
  })

  it('shrinks every panel’s share as maps are added', () => {
    expect(panelBudgetBytes(4, DEVICE)).toBeLessThan(panelBudgetBytes(3, DEVICE))
  })
})

describe('what a companion is asked for', () => {
  it('reads a region, and a two-contig block as two names', () => {
    expect(planFor({ uri: 'a', view: 'region', region: 'chrI:1-1000' })).toEqual({
      kind: 'names',
      rows: 'chrI:1-1000',
    })
    expect(planFor({ uri: 'a', view: 'region', region: 'chrI', region2: 'chrII' })).toEqual({
      kind: 'names',
      rows: 'chrI',
      cols: 'chrII',
    })
  })

  it('reads a genome and a genome pair the same way', () => {
    expect(planFor({ uri: 'a', view: 'genome', genome: 'MAG_7' })).toEqual({
      kind: 'names',
      rows: 'MAG_7',
    })
    expect(planFor({ uri: 'a', view: 'pair', genome: 'MAG_7', genome2: 'MAG_9' })).toEqual({
      kind: 'names',
      rows: 'MAG_7',
      cols: 'MAG_9',
    })
  })

  it('reads a selection by its names, so each file resolves its own bins', () => {
    expect(planFor({ uri: 'a', view: 'selection', genomes: 'MAG_1,MAG_2' })).toEqual({
      kind: 'selection',
      unit: 'genome',
      names: ['MAG_1', 'MAG_2'],
    })
  })

  it('reads the whole file as the file’s own extent', () => {
    expect(planFor({ uri: 'a', view: 'whole' })).toEqual({ kind: 'whole' })
  })

  /**
   * The three views that are pictures of a *file* rather than of a place in
   * one. A second file's genomes table is not this one with more rows in it.
   */
  it('has nothing to draw beside a table or a whole-metagenome scan', () => {
    for (const view of ['genomes', 'contigs', 'overview', 'browser'] as const) {
      expect(planFor({ uri: 'a', view }).kind).toBe('none')
    }
  })

  it('refuses an incomplete selection rather than guessing at one', () => {
    expect(planFor({ uri: 'a', view: 'region' }).kind).toBe('none')
    expect(planFor({ uri: 'a', view: 'pair', genome: 'MAG_7' }).kind).toBe('none')
    expect(planFor({ uri: 'a', view: 'selection' }).kind).toBe('none')
  })
})
