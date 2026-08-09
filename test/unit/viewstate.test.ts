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
  differsOnlyInPresentation,
  differsOnlyInScale,
  matrixLevel,
  overviewLevel,
  parseViewState,
  SCALE_KEYS,
  selectionOf,
  serialiseViewState,
  ViewStore,
  viewStateEquals,
} from '../../src/state/ViewState'
import { WHOLE_FILE_LEVELS } from '../../src/ui/Overview'
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
  // The whole-metagenome scan. It is a view state like the two tables beside it
  // in the root menu, which is what gives it a link, a history entry and a back
  // button; it was a mode the shell held, and had none of the three.
  { uri: 'Hum53.metacool', view: 'overview', level: 'genome' },
  // Several genomes as one map — the plural of `view=genome`, and what makes
  // the pair view a special case of something rather than a thing of its own.
  { uri: 'Hum53.metacool', view: 'selection', genomes: 'MAG_1,MAG_2,MAG_7' },
  { uri: 'yeast.cool', view: 'selection', regions: 'I,II,XVI' },
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

describe('the selection a state carries', () => {
  const state = (partial: Partial<ViewState>): ViewState =>
    ({ uri: 'a.metacool', view: 'selection', ...partial }) as ViewState

  it('reads genomes and contigs out of their own keys', () => {
    expect(selectionOf(state({ genomes: 'a,b' }))).toEqual({ kind: 'genome', names: ['a', 'b'] })
    expect(selectionOf(state({ regions: 'I,II' }))).toEqual({ kind: 'contig', names: ['I', 'II'] })
  })

  it('is null where a state names none, which is what sends a view home', () => {
    expect(selectionOf(state({}))).toBeNull()
    expect(selectionOf(state({ genomes: '' }))).toBeNull()
    // A trailing comma is a typo, not a sequence called `''`.
    expect(selectionOf(state({ genomes: 'a,' }))).toEqual({ kind: 'genome', names: ['a'] })
  })

  it('resolves a hash that names both, rather than refusing it', () => {
    // Genomes win: the coarser choice, and a link that says two things should
    // land somewhere rather than nowhere.
    expect(selectionOf(state({ genomes: 'a', regions: 'I' }))).toEqual({
      kind: 'genome',
      names: ['a'],
    })
  })

  it('survives a name with spaces around it, which a pasted list has', () => {
    expect(selectionOf(state({ genomes: 'a, b ,c' }))).toEqual({
      kind: 'genome',
      names: ['a', 'b', 'c'],
    })
  })
})

describe('the level, which two vocabularies share one key for', () => {
  const state = (level?: 'bin' | 'contig' | 'genome'): ViewState => ({
    uri: 'a.metacool',
    view: 'overview',
    ...(level === undefined ? {} : { level }),
  })

  it('gives a bin-axis view bins unless the state says contigs', () => {
    expect(matrixLevel(state())).toBe('bin')
    expect(matrixLevel(state('bin'))).toBe('bin')
    expect(matrixLevel(state('contig'))).toBe('contig')
  })

  it('gives the overview contigs unless the state says genomes', () => {
    expect(overviewLevel(state())).toBe('contig')
    expect(overviewLevel(state('contig'))).toBe('contig')
    expect(overviewLevel(state('genome'))).toBe('genome')
  })

  // The whole-file view of a metagenome reads all three values of the key,
  // because all three are levels of it — `bin` is the pooled map the shell
  // mounts `WholeView` for, and it has to survive the round trip or the picker
  // offers a place the back button cannot return to.
  it('gives the overview bins when the state says bins', () => {
    expect(overviewLevel(state('bin'))).toBe('bin')
  })

  // The hash is untrusted and the key is shared, so a bin-axis view still meets
  // a value it has no axis for. It lands on that view's default rather than
  // being refused: the rest of the link still names a place, and showing it is
  // closer to what was asked for than an error or the genomes table.
  it('lands a bin-axis view on its own default for the overview`s value', () => {
    expect(matrixLevel(state('genome'))).toBe('bin')
  })

  it('round-trips level=genome, which only the overview reads', () => {
    expect(parseViewState('#uri=a&view=overview&level=genome')).toStrictEqual({
      uri: 'a',
      view: 'overview',
      level: 'genome',
    })
  })

  // The two ends of one choice, tied together. The picker is built in a module
  // this suite has no document for, so what is asserted is the property that
  // makes it routable: every level it offers is one `overviewLevel` returns
  // unchanged, and one the hash carries there and back.
  it('routes and round-trips every level the whole-file picker offers', () => {
    for (const { value } of WHOLE_FILE_LEVELS) {
      expect(overviewLevel(state(value))).toBe(value)
      expect(parseViewState(`#uri=a&view=overview&level=${value}`)).toStrictEqual({
        uri: 'a',
        view: 'overview',
        level: value,
      })
    }
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

/**
 * What a mounted view can be *told* rather than rebuilt for.
 *
 * `maps` is in it and that is the whole of §16.9's affordability: drawing a
 * 2 × 2 deck is four changes to this key in a row, and each one rebuilding the
 * lead would mean four worker round trips and four discarded pans for changes
 * that happened in other panels entirely. The companions are reconciled from
 * the key before this is consulted, so there is nothing left for a rebuild to
 * do.
 */
describe('differsOnlyInPresentation', () => {
  const base: ViewState = { uri: 'a.cool', view: 'region', region: 'chrI:1-1000' }

  it('lets the deck change without rebuilding the map beside it', () => {
    expect(differsOnlyInPresentation(base, { ...base, maps: 'b.cool' })).toBe(true)
    expect(differsOnlyInPresentation({ ...base, maps: 'b.cool|~' }, base)).toBe(true)
  })

  it('still rebuilds for a key that chooses the block', () => {
    expect(differsOnlyInPresentation(base, { ...base, region: 'chrII' })).toBe(false)
    expect(differsOnlyInPresentation(base, { ...base, uri2: 'b.cool' })).toBe(false)
  })

  /** The colour and the derivations were already here; `maps` joins them. */
  it('keeps the scale and the derivations on the repaint road', () => {
    expect(differsOnlyInPresentation(base, { ...base, vmax: 12 })).toBe(true)
    expect(differsOnlyInPresentation(base, { ...base, flip: true })).toBe(true)
  })
})

/**
 * The turn, whose key is a **refusal** rather than a setting.
 *
 * A block with a diagonal opens turned (§17.2), so the state that says nothing
 * says "turned" — and the only thing worth writing to a link is the reader
 * having asked for the square instead. Which puts two things on this key that
 * an ordinary boolean does not have to survive: `false` has to round-trip as
 * `false` rather than collapsing into the absence that means the opposite, and
 * "nothing said" has to stay nothing rather than being helpfully filled in.
 */
describe('the turn in the hash', () => {
  it('says nothing at all for the ordinary case', () => {
    const state: ViewState = { uri: 'a.cool', view: 'region', region: 'I:1-1000' }
    expect(serialiseViewState(state)).not.toContain('flip')
    expect(parseViewState(serialiseViewState(state))?.flip).toBeUndefined()
  })

  it('carries a refusal, which is the whole reason the key exists', () => {
    const state: ViewState = { uri: 'a.cool', view: 'region', region: 'I:1-1000', flip: false }
    expect(serialiseViewState(state)).toContain('flip=false')
    expect(parseViewState(serialiseViewState(state))).toEqual(state)
  })

  it('reads the older spelling of a turn that was asked for', () => {
    // `flip=1` and `flip=true` are what the key meant when it was a setting
    // rather than a refusal; a link written then still means turned now.
    expect(parseViewState('uri=a.cool&flip=1')?.flip).toBe(true)
    expect(parseViewState('uri=a.cool&flip=true')?.flip).toBe(true)
    expect(parseViewState('uri=a.cool&flip=0')?.flip).toBe(false)
  })

  it('is a presentation key, so moving it does not re-read the block', () => {
    const square: ViewState = { uri: 'a.cool', view: 'region', region: 'I:1-1000', flip: false }
    const turned: ViewState = { uri: 'a.cool', view: 'region', region: 'I:1-1000' }
    expect(differsOnlyInPresentation(square, turned)).toBe(true)
  })
})
