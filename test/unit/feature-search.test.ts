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

import { FEATURE_MIN_PAD, findFeatures, paddedSpan } from '@/annotations/search'
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

  it('names the gene, where it is, and which file said so', () => {
    const { store } = storeWith(genes())
    expect(featureSuggestions(store, 'gal80')[0].label).toBe('GAL80 · chrI:4,950 · genes')
  })

  it('prints the accession beside the symbol, where the file gave both', () => {
    const build = new FeatureBuilder()
    build.add('chrI', 1000, 2000, { name: 'LipL1', id: 'PF3D7_1314600' })
    const { store } = storeWith(build.finish(), 'genes')
    expect(featureSuggestions(store, 'lipl')[0].label).toBe(
      'LipL1 (PF3D7_1314600) · chrI:750 · genes',
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
