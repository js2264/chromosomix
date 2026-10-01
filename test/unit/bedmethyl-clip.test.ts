/**
 * A bedMethyl opens clipped to 0–100 (§8.20).
 *
 * Its values are percentages, which is a scale before a byte of them is read,
 * and a methylation lane autoscaled to 12–94 % says nothing about how
 * methylated anything is. The worker already hands back a 0–100 extent — but
 * an extent only fills the limits boxes once the reader leaves the autoscale,
 * and the lane opened on the autoscale every other track opens on. What is
 * pinned here is the row as it lands: clipped to 0–100 under either name a
 * bedMethyl arrives by, every other track still on the autoscale, and a row
 * that is *returning* keeping the axis its reader gave it.
 */

// @vitest-environment jsdom

import { beforeEach, describe, expect, it } from 'vitest'

import { AnnotationLoader } from '@/annotations/loader'
import { AnnotationStore } from '@/annotations/store'
import { openingLimits } from '@/annotations/types'
import type { AnnotationEntry, StoredEntry } from '@/annotations/types'
import { useMemoryStores } from '@/state/idb'

/** A worker that answers every `load` as whichever format the test asked for. */
class Fake {
  constructor(private readonly format: string) {}

  request(message: { kind: string }): Promise<unknown> {
    if (message.kind !== 'load') return Promise.resolve(null)
    return Promise.resolve({
      format: this.format,
      contigs: ['chr1'],
      overlap: { matched: 1, total: 1, missing: [] },
      summary: '3 5mC calls',
      ...(this.format === 'bedmethyl' ? { fileExtent: { min: 0, max: 100 } } : {}),
    })
  }

  drop(): void {}
}

/** The loader's `await`, then its `.then`, `.catch` and `.finally`. */
async function flush(): Promise<void> {
  for (let turn = 0; turn < 8; turn++) await Promise.resolve()
}

function setUp(format: string): { store: AnnotationStore; loader: AnnotationLoader } {
  const store = new AnnotationStore(`clip-${Math.random()}.cool`)
  store.clear()
  return { store, loader: new AnnotationLoader(store, new Fake(format) as never, []) }
}

const file = (name: string): File => new File(['bytes'], name)

function only(store: AnnotationStore): AnnotationEntry {
  expect(store.entries).toHaveLength(1)
  return store.entries[0]
}

beforeEach(() => {
  useMemoryStores()
  ;(globalThis as unknown as { indexedDB: unknown }).indexedDB = {}
})

describe('the axis a lane opens on', () => {
  it('is 0–100 for a bedMethyl, and the autoscale for nothing else', () => {
    expect(openingLimits('bedmethyl')).toEqual({ auto: false, min: 0, max: 100 })
    for (const format of ['bigwig', 'bedgraph', 'wig', 'bed', 'fasta', 'bam'] as const) {
      expect(openingLimits(format), format).toBeUndefined()
    }
  })

  it('opens a bedMethyl clipped to 0–100', async () => {
    const { store, loader } = setUp('bedmethyl')
    loader.addFiles([file('calls.bedMethyl')])
    await flush()
    const row = only(store)
    expect(row.kind).toBe('track')
    expect(row.style.limits).toEqual({ auto: false, min: 0, max: 100 })
    // The extent still seeds the boxes, which is all it ever did.
    expect(row.fileExtent).toEqual({ min: 0, max: 100 })
  })

  it('opens one named as a BED the same way, its bytes having said what it is', async () => {
    // The name guessed a peak set and the bytes said a bedMethyl (§8.3): the
    // kind's defaults replace the guess's, and the axis is the format's.
    const { store, loader } = setUp('bedmethyl')
    loader.addFiles([file('pileup.bed')])
    await flush()
    const row = only(store)
    expect(row.kind).toBe('track')
    expect(row.style.limits).toEqual({ auto: false, min: 0, max: 100 })
  })

  it('leaves every other track on the autoscale', async () => {
    const { store, loader } = setUp('bigwig')
    loader.addFiles([file('ATAC.bw')])
    await flush()
    expect(only(store).style.limits.auto).toBe(true)
  })

  it('keeps the axis a returning bedMethyl was given', async () => {
    // A restored row brings the settings a reader chose, and those are never
    // re-derived — the autoscale included, where that is what they chose.
    const { store, loader } = setUp('bedmethyl')
    loader.restore([
      {
        id: 'calls',
        card: 'linear',
        kind: 'track',
        label: 'calls',
        source: { kind: 'remote', name: 'calls.bedMethyl', url: 'https://example.org/calls.bedMethyl' },
        visible: true,
        placement: { top: false, right: false, bottom: true, left: false },
        style: { colour: '#1f5fa9', limits: { auto: true, min: 0, max: 1 } },
      } as unknown as StoredEntry,
    ])
    await flush()
    expect(store.byId('calls')?.style.limits).toEqual({ auto: true, min: 0, max: 1 })
  })
})
