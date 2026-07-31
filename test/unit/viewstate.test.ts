/**
 * View-state round trip (spec §5.5).
 *
 * The property that matters is `parse(serialise(s))` deep-equalling `s`: a
 * shared link that silently drops the colour scale, or turns an absent key into
 * an `undefined` one, is a link that shows a different picture to the person who
 * receives it than to the person who sent it.
 */

import { describe, expect, it } from 'vitest'
import { parseViewState, serialiseViewState, ViewStore, viewStateEquals } from '../../src/state/ViewState'
import type { ViewState } from '../../src/types'

const CASES: ViewState[] = [
  { uri: 'Hum53.metacool', view: 'genomes' },
  { uri: 'Hum53.mmetacool::entries/1000', view: 'genome', genome: 'MetaTOR_1_1' },
  {
    uri: 'https://bucket.example.org/a b/Hum53.metacool',
    view: 'pair',
    genome: 'MAG_1',
    genome2: 'MAG_2',
    level: 'contig',
  },
  {
    uri: 'x.metacool',
    view: 'region',
    region: 'NODE_1:1-50,000',
    transform: 'log10',
    colormap: 'cividis',
    vmax: 12.5,
  },
  { uri: 'x.metacool', view: 'contigs', genome: '' },
  { uri: 'weird&name=with?chars.metacool', view: 'genomes', vmax: 1e-7 },
]

describe('serialiseViewState / parseViewState', () => {
  for (const state of CASES) {
    it(`round-trips ${JSON.stringify(state)}`, () => {
      expect(parseViewState(serialiseViewState(state))).toStrictEqual(state)
      expect(parseViewState(`#${serialiseViewState(state)}`)).toStrictEqual(state)
    })
  }

  it('returns null for a hash with no uri', () => {
    expect(parseViewState('')).toBeNull()
    expect(parseViewState('#view=genome&genome=MAG_1')).toBeNull()
  })

  it('drops values that are not part of the type rather than repairing them', () => {
    const parsed = parseViewState('#uri=a.metacool&view=banana&level=quark&transform=sqrt')
    expect(parsed).toStrictEqual({ uri: 'a.metacool', view: 'genomes' })
  })

  it('keeps an explicitly empty optional value distinct from an absent one', () => {
    expect(parseViewState('#uri=a&view=genome&genome=')).toStrictEqual({
      uri: 'a',
      view: 'genome',
      genome: '',
    })
    expect(parseViewState('#uri=a&view=genome')).toStrictEqual({ uri: 'a', view: 'genome' })
  })
})

describe('viewStateEquals', () => {
  it('is structural and handles null on either side', () => {
    expect(viewStateEquals(null, null)).toBe(true)
    expect(viewStateEquals(null, CASES[0])).toBe(false)
    expect(viewStateEquals({ ...CASES[0] }, { ...CASES[0] })).toBe(true)
  })
})

describe('ViewStore', () => {
  it('notifies subscribers only when the state actually changes', () => {
    const store = new ViewStore({ uri: 'a', view: 'genomes' })
    let calls = 0
    store.subscribe(() => calls++)
    store.set({ uri: 'a', view: 'genomes' })
    expect(calls).toBe(0)
    store.set({ uri: 'a', view: 'genome', genome: 'MAG_1' })
    expect(calls).toBe(1)
  })

  it('removes a key when a patch sets it to undefined', () => {
    const store = new ViewStore({ uri: 'a', view: 'genome', genome: 'MAG_1', vmax: 3 })
    store.patch({ vmax: undefined })
    expect(store.state).toStrictEqual({ uri: 'a', view: 'genome', genome: 'MAG_1' })
  })
})
