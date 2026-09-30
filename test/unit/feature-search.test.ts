/**
 * Finding a gene by name, for either box.
 *
 * The scan is one function used by two surfaces that write coordinates in two
 * different bases — 1-based inclusive in the 1D browser (`genome/assembly.ts`),
 * 0-based half-open on a map (`metacooler/range.ts`) — so what is pinned here is
 * that it returns *numbers*, in the map's base, and that the string built from
 * them parses back to the same window. A base shifted by one is the kind of
 * mistake nothing reports and everything inherits.
 */

import { describe, expect, it } from 'vitest'

import { FEATURE_MIN_PAD, findFeatures, hitLocus, paddedSpan } from '@/annotations/search'
import { AnnotationStore } from '@/annotations/store'
import { FeatureBuilder } from '@/annotations/featureset'
import { featureSuggestions } from '@/ui/SearchBox'
import { parseRegionString } from '@/metacooler/range'

/** A set with three named genes on one contig. */
function genes(): ReturnType<FeatureBuilder['finish']> {
  const build = new FeatureBuilder()
  build.add('chrI', 1000, 2000, { name: 'GAL4' })
  build.add('chrI', 5000, 5100, { name: 'GAL80' })
  build.add('chrI', 10, 20, { name: 'TINY' })
  build.add('chrI', 20_000, 20_500, {})
  return build.finish()
}

let counter = 0

/** A store holding one ready feature set, as a loaded gene model would be. */
function storeWith(
  data: ReturnType<FeatureBuilder['finish']>,
  label = 'genes',
): { store: AnnotationStore; id: string } {
  const store = new AnnotationStore(`search-${counter++}.cool`)
  store.clear()
  const entry = store.begin({
    card: 'linear',
    kind: 'gtf',
    label,
    source: { kind: 'local', file: null as unknown as File, name: `${label}.gtf` },
  })
  store.update(entry.id, { status: 'ready', payload: { kind: 'features', data } })
  return { store, id: entry.id }
}

describe('finding a feature by name', () => {
  it('matches a prefix, whatever the case', () => {
    const { store } = storeWith(genes())
    expect(findFeatures(store, 'gal').map((hit) => hit.name)).toEqual(['GAL4', 'GAL80'])
    expect(findFeatures(store, 'GAL8').map((hit) => hit.name)).toEqual(['GAL80'])
  })

  // One letter matches everything, and a colon is coordinates: neither is a
  // question this can answer, so neither gets a list saying it failed.
  it('answers nothing to one letter or to a coordinate', () => {
    const { store } = storeWith(genes())
    expect(findFeatures(store, 'g')).toEqual([])
    expect(findFeatures(store, 'chrI:1000-2000')).toEqual([])
    expect(findFeatures(store, '')).toEqual([])
  })

  // A gene drawn edge to edge in the window is a gene with no context, so the
  // hit is the gene plus a quarter of its length either side — and never less
  // than fifty bases, or a 20 bp feature would fill the screen with itself.
  it('pads the window, and clamps it at the start of the sequence', () => {
    const { store } = storeWith(genes())
    const [gal4] = findFeatures(store, 'gal4')
    expect(gal4.start).toBe(1000 - 250)
    expect(gal4.end).toBe(2000 + 250)
    const [tiny] = findFeatures(store, 'tiny')
    expect(tiny.start).toBe(0)
    expect(tiny.end).toBe(20 + FEATURE_MIN_PAD)
  })

  it('skips a feature with no name', () => {
    const { store } = storeWith(genes())
    expect(findFeatures(store, 'chr')).toEqual([])
  })

  it('stops at the limit rather than scanning a whole genome', () => {
    const build = new FeatureBuilder()
    for (let i = 0; i < 30; i++) build.add('chrI', i * 100, i * 100 + 50, { name: `HIS${i}` })
    const { store } = storeWith(build.finish())
    expect(findFeatures(store, 'his')).toHaveLength(10)
    expect(findFeatures(store, 'his', 3)).toHaveLength(3)
  })

  // Searching every loaded annotation answers "GAL4" with the same gene four
  // times over. The star is what picks one, and the search follows it.
  it('reads the starred set, and falls back to the first loaded one', () => {
    const { store } = storeWith(genes(), 'first')
    const second = store.begin({
      card: 'linear',
      kind: 'segments',
      label: 'second',
      source: { kind: 'local', file: null as unknown as File, name: 'peaks.bed' },
    })
    const other = new FeatureBuilder()
    other.add('chrII', 500, 900, { name: 'GAL4' })
    store.update(second.id, { status: 'ready', payload: { kind: 'features', data: other.finish() } })

    expect(findFeatures(store, 'gal4')[0].source).toBe('first')
    store.makePrimary(second.id)
    const [hit] = findFeatures(store, 'gal4')
    expect(hit.source).toBe('second')
    expect(hit.contig).toBe('chrII')
  })

  // Genomics addresses one gene two ways and a reader uses whichever the thing
  // in front of them used: `LipL1` out of a paper, `PF3D7_1314600` out of the
  // supplementary table. It matters most where the symbols are least useful — a
  // Plasmodium annotation has sixty genes called `VAR`, and the accession is the
  // only way to ask for one of them.
  it('matches the accession as well as the symbol', () => {
    const build = new FeatureBuilder()
    build.add('chrI', 1000, 2000, { name: 'LipL1', id: 'PF3D7_1314600' })
    build.add('chrI', 5000, 6000, { name: 'VAR', id: 'PF3D7_1300100' })
    build.add('chrI', 7000, 8000, { name: 'VAR', id: 'PF3D7_1300300' })
    const { store } = storeWith(build.finish())

    expect(findFeatures(store, 'lipl').map((hit) => hit.name)).toEqual(['LipL1'])
    expect(findFeatures(store, 'pf3d7_13146').map((hit) => hit.name)).toEqual(['LipL1'])
    // The symbol finds both; the accession picks out the one.
    expect(findFeatures(store, 'var')).toHaveLength(2)
    expect(findFeatures(store, 'PF3D7_13003').map((hit) => hit.id)).toEqual(['PF3D7_1300300'])
  })

  // `name === id` is how the parser spells a gene the file identifies but never
  // names, and a hit that carried both would print the same string twice.
  it('does not repeat the accession when it is also the name', () => {
    const build = new FeatureBuilder()
    build.add('chrI', 1000, 2000, { name: 'PF_0001', id: 'PF_0001' })
    const { store } = storeWith(build.finish())
    const [hit] = findFeatures(store, 'pf_')
    expect(hit.name).toBe('PF_0001')
    expect(hit.id).toBe('')
  })

  it('says nothing while the set is still loading, or when there is none', () => {
    const store = new AnnotationStore('empty.cool')
    store.clear()
    expect(findFeatures(store, 'gal4')).toEqual([])
    const entry = store.begin({
      card: 'linear',
      kind: 'gtf',
      source: { kind: 'local', file: null as unknown as File, name: 'genes.gtf' },
    })
    expect(entry.status).toBe('loading')
    expect(findFeatures(store, 'gal4')).toEqual([])
  })
})

/**
 * The base. This is the assertion that stops a map's gene windows being off by
 * one — invisibly, and in a direction nothing would ever report.
 */
describe('a hit as a region a map can open', () => {
  it('writes 0-based half-open, and the reader parses back what was written', () => {
    const { store } = storeWith(genes())
    const [suggestion] = featureSuggestions(store, 'gal4')
    expect(suggestion.value).toBe('chrI:750-2250')
    expect(parseRegionString(suggestion.value)).toEqual(['chrI', 750, 2250])
  })

  /**
   * **The label is the gene, not the window.** It printed `hit.start`, which is
   * the padded window's start — `chrI:4,950` for a gene beginning at 5,001 —
   * so the number a biologist reads as the gene's coordinate, and copies into a
   * primer tool or a paper, was a quarter of the gene's length early and a base
   * off the locus box the click then filled. It is the feature's own span, in
   * the display form (§26.1), and the same string in both surfaces' lists.
   */
  it('names the gene, where the gene is, and which file said so', () => {
    const { store } = storeWith(genes())
    expect(featureSuggestions(store, 'gal80')[0].label).toBe('GAL80 · chrI:5,001-5,100 · genes')
  })

  it('carries the feature’s own bounds beside the padded window', () => {
    const { store } = storeWith(genes())
    const [gal80] = findFeatures(store, 'gal80')
    expect([gal80.featureStart, gal80.featureEnd]).toEqual([5000, 5100])
    expect(hitLocus(gal80)).toBe('chrI:5,001-5,100')
    // …and the window it opens is still padded, which is a different question.
    expect([gal80.start, gal80.end]).toEqual([4950, 5150])
  })

  it('prints the accession beside the symbol, where the file gave both', () => {
    const build = new FeatureBuilder()
    build.add('chrI', 1000, 2000, { name: 'LipL1', id: 'PF3D7_1314600' })
    const { store } = storeWith(build.finish(), 'genes')
    expect(featureSuggestions(store, 'lipl')[0].label).toBe(
      'LipL1 (PF3D7_1314600) · chrI:1,001-2,000 · genes',
    )
  })
})

/** Two gestures for one intention: they must land on the same window. */
describe('the window a click on a feature opens', () => {
  it('is the one a search for its name opens', () => {
    const { store } = storeWith(genes())
    const [gal4] = findFeatures(store, 'gal4')
    expect(paddedSpan(1000, 2000)).toEqual({ start: gal4.start, end: gal4.end })
  })
})

/**
 * A karyotype's bands, by the names a cytogeneticist writes (§8.22) — found
 * beside the gene model and never in its place.
 */
describe('finding a band by its ISCN name', () => {
  /** Three bands of Xq13 and one of Xq28, as UCSC's cytoBand writes them. */
  function bands(): ReturnType<FeatureBuilder['finish']> {
    const build = new FeatureBuilder()
    build.add('chrX', 67_800_000, 71_800_000, { name: 'q13.1', score: 0, detail: 'stain gneg' })
    build.add('chrX', 71_800_000, 73_900_000, { name: 'q13.2', score: 50, detail: 'stain gpos50' })
    build.add('chrX', 73_900_000, 76_000_000, { name: 'q13.3', score: 0, detail: 'stain gneg' })
    build.add('chrX', 147_100_000, 155_270_560, { name: 'q28', score: 0, detail: 'stain gneg' })
    return build.finish()
  }

  /** A store holding the given sets, loaded in this order. */
  function storeOf(...sets: Array<[string, ReturnType<FeatureBuilder['finish']>]>): AnnotationStore {
    const store = new AnnotationStore(`bands-${counter++}.cool`)
    store.clear()
    for (const [kind, data] of sets) {
      const entry = store.begin({
        card: 'linear',
        kind: kind as 'gtf',
        label: kind,
        source: { kind: 'local', file: null as unknown as File, name: `${kind}.txt` },
      })
      store.update(entry.id, { status: 'ready', payload: { kind: 'features', data } })
    }
    return store
  }

  it('matches the chromosome and the band together, with or without UCSC’s prefix', () => {
    const store = storeOf(['ideogram', bands()])
    const names = ['Xq13.1', 'Xq13.2', 'Xq13.3']
    expect(findFeatures(store, 'Xq13').map((hit) => hit.name)).toEqual(names)
    expect(findFeatures(store, 'xq13').map((hit) => hit.name)).toEqual(names)
    expect(findFeatures(store, 'chrXq13').map((hit) => hit.name)).toEqual(names)
    // The band's own name is not the question: `q13` is a band on every chromosome.
    expect(findFeatures(store, 'q13')).toEqual([])
  })

  it('opens the band as a gene would open: the band, padded a quarter either side', () => {
    const store = storeOf(['ideogram', bands()])
    const [q28] = findFeatures(store, 'Xq28')
    expect([q28.featureStart, q28.featureEnd]).toEqual([147_100_000, 155_270_560])
    expect(paddedSpan(147_100_000, 155_270_560)).toEqual({ start: q28.start, end: q28.end })
    expect(featureSuggestions(store, 'Xq28')[0].label).toBe('Xq28 · chrX:147,100,001-155,270,560 · ideogram')
  })

  it('lists the genes first, and leaves the gene search with the gene model', () => {
    const build = new FeatureBuilder()
    build.add('chrX', 73_040_000, 73_072_000, { name: 'XIST' })
    build.add('chrX', 70_300_000, 70_400_000, { name: 'Xq13-like' })
    // The karyotype arrives first: it must not become the set a gene is looked
    // up in, or `XIST` would be searched for among `p11` and `q13.1`.
    const store = storeOf(['ideogram', bands()], ['gtf', build.finish()])
    expect(findFeatures(store, 'xist').map((hit) => hit.name)).toEqual(['XIST'])
    expect(findFeatures(store, 'Xq13').map((hit) => hit.name)).toEqual([
      'Xq13-like',
      'Xq13.1',
      'Xq13.2',
      'Xq13.3',
    ])
  })

  it('is never answered from a sample’s junctions', () => {
    const junctions = new FeatureBuilder()
    junctions.add('chrX', 1000, 2000, { name: 'JUNC00000001', score: 12 })
    const store = storeOf(['junctions', junctions.finish()], ['gtf', genes()])
    expect(findFeatures(store, 'junc')).toEqual([])
    expect(findFeatures(store, 'gal4').map((hit) => hit.name)).toEqual(['GAL4'])
  })
})
