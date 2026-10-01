/**
 * The controls an alignment lane has, and the two cache keys they come to.
 *
 * A `ReadStyle` is unusual among this app's style fields in that it changes the
 * *answer* rather than the drawing: a MAPQ floor decides which records are
 * counted, and a colouring decides how the pile is packed into rows. That makes
 * the pair of key functions load-bearing in a way a colour never is — one too
 * narrow leaves a lane showing the wrong reads until the view moves, and one
 * too wide throws away a whole-genome coverage scan every time somebody tries a
 * different palette.
 *
 * The asymmetry between them is the thing worth pinning: `readFilterKey`
 * deliberately ignores `colourBy`, `pairs` and `splits`, because none of the
 * three can move a depth curve by a pixel.
 */

// @vitest-environment jsdom
// jsdom, and only for the last block: `AnnotationStore` writes through
// `sessionStorage`, which is the whole point of the round trip below.

import { beforeEach, describe, expect, it } from 'vitest'

import {
  COLOUR_BY,
  defaultReadStyle,
  defaultStyle,
  readFilterKey,
  readStyleKey,
  readStyleOf,
  readsOf,
  type ReadStyle,
} from '@/annotations/types'
import { AnnotationStore } from '@/annotations/store'

const base = defaultReadStyle()

function withField<K extends keyof ReadStyle>(key: K, value: ReadStyle[K]): ReadStyle {
  return { ...base, [key]: value }
}

describe('the default', () => {
  it('colours by strand, keeps everything, and joins mates', () => {
    expect(base).toEqual({
      colourBy: 'strand',
      minMapq: 0,
      hideDuplicates: false,
      layout: 'pairs',
      splits: false,
      // A sashimi plot's arcs over the depth, from two reads up (§8.23).
      sashimi: true,
      sashimiFloor: 2,
      // Base modifications: whichever code is most called, every call
      // counted, and the depth drawn as depth (§8.13).
      modCode: '',
      modThreshold: 0.5,
      modFraction: false,
    })
  })

  it('is on both of a BAM’s rows and on no other kind', () => {
    // The depth and the pile carry the same record, because the settings that
    // are about *which reads count* are written through to both (§8.13) — and a
    // depth row with no `reads` would have nowhere for the write to land.
    expect(defaultStyle('alignments', '#123456').reads).toEqual(base)
    expect(defaultStyle('reads', '#123456').reads).toEqual(base)
    expect(defaultStyle('track', '#123456').reads).toBeUndefined()
    expect(defaultStyle('gtf', '#123456').reads).toBeUndefined()
  })

  it('stands in for a style that carries none, so an old session opens', () => {
    expect(readsOf(defaultStyle('track', '#123456'))).toEqual(base)
  })
})

describe('reading a stored style back', () => {
  it('keeps a whole one', () => {
    const stored: ReadStyle = {
      colourBy: 'insert',
      minMapq: 30,
      hideDuplicates: true,
      layout: 'reads',
      splits: true,
      sashimi: false,
      sashimiFloor: 5,
      modCode: 'h',
      modThreshold: 0.8,
      modFraction: true,
    }
    expect(readStyleOf(stored)).toEqual(stored)
  })

  it('opens a style stored before the arcs with them on, from two reads', () => {
    const old = readStyleOf({ colourBy: 'strand', minMapq: 0, hideDuplicates: false, layout: 'pairs', splits: false })
    expect(old.sashimi).toBe(true)
    expect(old.sashimiFloor).toBe(2)
  })

  it('clamps an arc floor that is not a count', () => {
    expect(readStyleOf({ sashimiFloor: 0 }).sashimiFloor).toBe(1)
    expect(readStyleOf({ sashimiFloor: 2.6 }).sashimiFloor).toBe(3)
    expect(readStyleOf({ sashimiFloor: 'many' }).sashimiFloor).toBe(2)
    expect(readStyleOf({ sashimi: 'no' }).sashimi).toBe(true)
  })

  it('refuses a colouring it has never heard of', () => {
    expect(readStyleOf({ ...base, colourBy: 'rainbow' }).colourBy).toBe('strand')
    // The shape a prototype-pollution attempt takes in a share link.
    expect(readStyleOf({ ...base, colourBy: '__proto__' }).colourBy).toBe('strand')
  })

  it('clamps a MAPQ that could not have come from a file', () => {
    expect(readStyleOf({ ...base, minMapq: -5 }).minMapq).toBe(0)
    expect(readStyleOf({ ...base, minMapq: 900 }).minMapq).toBe(255)
    expect(readStyleOf({ ...base, minMapq: 30.7 }).minMapq).toBe(31)
    expect(readStyleOf({ ...base, minMapq: Number.NaN }).minMapq).toBe(0)
    expect(readStyleOf({ ...base, minMapq: 'thirty' }).minMapq).toBe(0)
  })

  it('drops the band thicknesses a session stored before the split', () => {
    // A BAM is two rows now (§8.13) and each has a lane height of its own, so
    // the band a reader used to drag inside one lane has nowhere to be. A
    // session written before that carries the two numbers; they are read past
    // rather than kept, and nothing here answers to them.
    const old = readStyleOf({ coverageBand: 50, consensusBand: 20 })
    expect(old).toEqual(base)
    expect(Object.keys(old).sort()).toEqual(Object.keys(base).sort())
  })

  it('reads the switches as booleans and nothing else', () => {
    // `pairs` defaults *on*, so anything but an explicit `false` keeps it on;
    // the other two default off and want an explicit `true`. Written out
    // because the two directions are easy to get backwards.
    // `pairs` was a boolean before it was a mode, and `false` meant "do not
    // join them" — which is now `reads`. A stored session must not silently
    // change what it draws.
    expect(readStyleOf({ layout: 'nonsense' }).layout).toBe('pairs')
    expect(readStyleOf({ pairs: false }).layout).toBe('reads')
    expect(readStyleOf({ pairs: true }).layout).toBe('pairs')
    expect(readStyleOf({ layout: 'fragments' }).layout).toBe('fragments')
    expect(readStyleOf({ hideDuplicates: 1 }).hideDuplicates).toBe(false)
    expect(readStyleOf({ hideDuplicates: true }).hideDuplicates).toBe(true)
    expect(readStyleOf({ splits: 1 }).splits).toBe(false)
    expect(readStyleOf({ splits: true }).splits).toBe(true)
  })

  it('gives the defaults for something that is not a record at all', () => {
    expect(readStyleOf(null)).toEqual(base)
    expect(readStyleOf('strand')).toEqual(base)
    expect(readStyleOf(undefined)).toEqual(base)
  })
})

describe('the reads key', () => {
  it('separates every field the worker reads, because each one refetches', () => {
    const keys = new Set<string>([readStyleKey(base)])
    for (const by of COLOUR_BY) keys.add(readStyleKey(withField('colourBy', by)))
    keys.add(readStyleKey(withField('minMapq', 30)))
    keys.add(readStyleKey(withField('hideDuplicates', true)))
    keys.add(readStyleKey(withField('splits', true)))
    // Six colourings and three switches, and the default is one of the six.
    expect(keys.size).toBe(COLOUR_BY.length + 3)
  })

  it('does not confuse two switches with one another', () => {
    expect(readStyleKey(withField('hideDuplicates', true))).not.toBe(
      readStyleKey(withField('splits', true)),
    )
  })
})

describe('the coverage key', () => {
  it('moves with the two fields that change what is counted', () => {
    expect(readFilterKey(withField('minMapq', 30))).not.toBe(readFilterKey(base))
    expect(readFilterKey(withField('hideDuplicates', true))).not.toBe(readFilterKey(base))
  })

  it('ignores the three that cannot move a depth curve', () => {
    // The whole reason this key exists: trying a colouring must not discard a
    // whole-genome coverage scan, which is the most expensive read here.
    for (const by of COLOUR_BY) {
      expect(readFilterKey(withField('colourBy', by))).toBe(readFilterKey(base))
    }
    expect(readFilterKey(withField('layout', 'reads'))).toBe(readFilterKey(base))
    // Splits are drawn and never counted — see `pileFilterOf` in the worker.
    expect(readFilterKey(withField('splits', true))).toBe(readFilterKey(base))
  })
})

describe('surviving a stored session', () => {
  beforeEach(() => {
    sessionStorage.clear()
  })

  function roundTrip(reads: unknown): ReadStyle | undefined {
    const uri = `reads-store-${Math.random()}.metacool`
    const store = new AnnotationStore(uri)
    const entry = store.begin({
      card: 'linear',
      kind: 'alignments',
      source: { kind: 'local', file: new File([], 'sample.bam'), name: 'sample.bam' },
    })
    store.update(entry.id, { status: 'ready' })
    store.restyle(entry.id, { reads: reads as ReadStyle })
    return AnnotationStore.stored(uri)[0]?.style.reads
  }

  it('keeps what the reader set', () => {
    const set: ReadStyle = {
      colourBy: 'mate',
      minMapq: 30,
      hideDuplicates: true,
      layout: 'reads',
      splits: true,
      sashimi: false,
      sashimiFloor: 4,
      modCode: '21839',
      modThreshold: 0.66,
      modFraction: true,
    }
    expect(roundTrip(set)).toEqual(set)
  })

  it('clamps a row that came back malformed rather than dropping it', () => {
    // Stored state outlives the build that wrote it and arrives from a share
    // link. The guard checks only that `style` is an object, which is enough to
    // hand a renderer a negative floor — but refusing the row over it would
    // cost the reader the file, which is the wrong trade.
    expect(roundTrip({ colourBy: 'rainbow', minMapq: -20, pairs: 'yes' })).toEqual({
      colourBy: 'strand',
      minMapq: 0,
      hideDuplicates: false,
      layout: 'pairs',
      splits: false,
      sashimi: true,
      sashimiFloor: 2,
      modCode: '',
      modThreshold: 0.5,
      modFraction: false,
    })
  })

  it('leaves a lane that never had one without one', () => {
    const uri = `reads-none-${Math.random()}.metacool`
    const store = new AnnotationStore(uri)
    const entry = store.begin({
      card: 'linear',
      kind: 'track',
      source: { kind: 'local', file: new File([], 'signal.bw'), name: 'signal.bw' },
    })
    store.update(entry.id, { status: 'ready' })
    expect(AnnotationStore.stored(uri)[0]?.style.reads).toBeUndefined()
  })
})

describe('the cache keys, once more, against the two roads to a count', () => {
  it('leaves the one switch the worker never reads out of the reads key', () => {
    // Toggling mate threads is a renderer decision over columns the pile
    // already carries, so putting it in the key would spend a window of BGZF
    // decoding on a change the reply cannot express.
    expect(readStyleKey(withField('layout', 'reads'))).toBe(readStyleKey(base))
    expect(readStyleKey(withField('layout', 'fragments'))).toBe(readStyleKey(base))
  })

  it('keeps the split switch in it, since that changes which reads come back', () => {
    expect(readStyleKey(withField('splits', true))).not.toBe(readStyleKey(base))
  })
})
