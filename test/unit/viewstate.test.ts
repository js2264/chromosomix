/**
 * View-state round trip (spec §5.5).
 *
 * The property that matters is `parse(serialise(s))` deep-equalling `s`: a
 * shared link that silently drops the colour scale, or turns an absent key into
 * an `undefined` one, is a link that shows a different picture to the person who
 * receives it than to the person who sent it.
 */

import { describe, expect, it } from 'vitest'
import {
  differsOnlyInScale,
  parseViewState,
  SCALE_KEYS,
  serialiseViewState,
  ViewStore,
  viewStateEquals,
} from '../../src/state/ViewState'
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
  // A rectangular contig × contig block: clicking the intersection of two
  // contigs must produce a link that reopens the same off-diagonal block, not
  // one contig's square map.
  {
    uri: 'Hum53.metacool',
    view: 'region',
    genome: 'MAG_1',
    region: 'NODE_7431_len_134871',
    region2: 'NODE_3115_len_927651',
  },
  { uri: 'weird&name=with?chars.metacool', view: 'genomes', vmax: 1e-7 },
]

describe('serialiseViewState / parseViewState', () => {
  for (const state of CASES) {
    it(`round-trips ${JSON.stringify(state)}`, () => {
      expect(parseViewState(serialiseViewState(state))).toStrictEqual(state)
      expect(parseViewState(`#${serialiseViewState(state)}`)).toStrictEqual(state)
    })
  }

  it('carries the second region axis, and distinguishes it from a square block', () => {
    const pair = parseViewState('#uri=a&view=region&region=c1&region2=c2')
    expect(pair).toStrictEqual({ uri: 'a', view: 'region', region: 'c1', region2: 'c2' })
    // Absent, not undefined-valued: a strict deep-equal is the whole contract.
    const square = parseViewState('#uri=a&view=region&region=c1')
    expect(square).toStrictEqual({ uri: 'a', view: 'region', region: 'c1' })
    expect('region2' in (square as object)).toBe(false)
  })

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

describe('the genome-wide view and balanced counts in the hash', () => {
  it('round-trips view=whole', () => {
    const state = { uri: 'yeast.cool', view: 'whole' as const, level: 'bin' as const }
    expect(parseViewState(serialiseViewState(state))).toEqual(state)
  })

  it('round-trips balance, because it is part of the picture', () => {
    const state = { uri: 'yeast.cool', view: 'whole' as const, balance: true }
    const hash = serialiseViewState(state)
    expect(hash).toContain('balance=true')
    expect(parseViewState(hash)).toEqual(state)
  })

  it('omits balance when it is off, so a raw link stays short', () => {
    const state = { uri: 'yeast.cool', view: 'region' as const, region: 'chrI' }
    expect(serialiseViewState(state)).not.toContain('balance')
  })
})

describe('the clip in the hash', () => {
  it('round-trips a negative floor, which log10 of a balanced map needs', () => {
    const state = {
      uri: 'ecoli.cool',
      view: 'whole' as const,
      transform: 'log10' as const,
      vmin: -4.7,
      vmax: -2.1,
      balance: true,
    }
    expect(parseViewState(serialiseViewState(state))).toStrictEqual(state)
  })

  it('carries the two bounds independently', () => {
    expect(parseViewState('#uri=a&view=whole&vmax=3')).toStrictEqual({
      uri: 'a',
      view: 'whole',
      vmax: 3,
    })
    expect(parseViewState('#uri=a&view=whole&vmin=-1')).toStrictEqual({
      uri: 'a',
      view: 'whole',
      vmin: -1,
    })
  })

  it('drops both when the clip goes back to auto', () => {
    const store = new ViewStore({ uri: 'a', view: 'whole', vmin: -4, vmax: -2 })
    store.patch({ vmin: undefined, vmax: undefined })
    expect(store.state).toStrictEqual({ uri: 'a', view: 'whole' })
  })
})

describe('differsOnlyInScale', () => {
  const base: ViewState = { uri: 'f.metacool', view: 'genome', genome: 'MAG_1' }

  it('is true for a change of colour alone, in any of the four keys', () => {
    for (const patch of [
      { transform: 'log10' as const },
      { colormap: 'viridis' },
      { vmin: 0.5 },
      { vmax: 8 },
    ]) {
      expect(differsOnlyInScale(base, { ...base, ...patch })).toBe(true)
    }
  })

  it('is true for a state against itself, which is why the caller needs more', () => {
    // The trap this function sets, recorded here because it cost a regression:
    // "nothing differs" satisfies "only the scale differs". The whole-file
    // overview is a *shell mode* and changes no state at all, so a render path
    // that treats this answer as "repaint, do not rebuild" swallows the request
    // to enter it -- the breadcrumb flipped to Whole genome and the table
    // stayed on screen underneath. `App.render` therefore compares the mode as
    // well; this function cannot, because a mode is not part of a view state.
    expect(differsOnlyInScale(base, base)).toBe(true)
    expect(differsOnlyInScale(base, { ...base })).toBe(true)
  })

  it('is true when a clip bound is removed, which is how "auto" is spelled', () => {
    expect(differsOnlyInScale({ ...base, vmax: 8 }, base)).toBe(true)
  })

  it('is false for anything that selects different data', () => {
    for (const patch of [
      { genome: 'MAG_2' },
      { view: 'region' as const },
      { uri: 'other.metacool' },
      { level: 'contig' as const },
      { balance: true },
      { region: 'NODE_1' },
      { genome2: 'MAG_3' },
    ]) {
      expect(differsOnlyInScale(base, { ...base, ...patch })).toBe(false)
    }
  })

  it('is false when a data key is removed rather than changed', () => {
    expect(differsOnlyInScale(base, { uri: base.uri, view: 'genome' })).toBe(false)
  })

  it('covers every optional key the serialiser knows about', () => {
    // The guarantee this whole optimisation rests on: a key that is neither a
    // scale key nor compared would let the app show the wrong block.
    const known = new Set<string>([...SCALE_KEYS])
    for (const key of ['genome', 'genome2', 'region', 'region2', 'level', 'balance']) {
      if (known.has(key)) continue
      const patched = { ...base, [key]: 'x' } as unknown as ViewState
      expect(differsOnlyInScale(base, patched)).toBe(false)
    }
  })
})
