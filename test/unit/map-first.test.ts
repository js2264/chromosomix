/**
 * The map first, then its tracks (§8.6).
 *
 * A session opening a map with its tracks started every track download in the
 * same moment as the map's first read, from the same host — the demo's
 * twelve-megabyte FASTA and ten-megabyte gene model among them — so the map
 * came in when they had, and then moved when the last lane landed beside it.
 * Two things answer that, and this pins both:
 *
 * - the loader **holds its reads** behind a promise the session settles when the
 *   map's first block is drawn: rows are seated at once and read afterwards,
 *   and a row removed while it waited is never read;
 * - a lane stack **reserves room** for the rows still reading, so the picture
 *   beside it is laid out once rather than shrunk as each one lands.
 */

// @vitest-environment jsdom

import { beforeEach, describe, expect, it } from 'vitest'

import { AnnotationLoader } from '@/annotations/loader'
import { LEAD_MAP } from '@/annotations/placement'
import { AnnotationStore } from '@/annotations/store'
import { useMemoryStores } from '@/state/idb'

/** A worker that records which entries were asked for, and answers none. */
class Recorder {
  readonly asked: string[] = []

  request(message: { kind: string; entry?: string }): Promise<unknown> {
    if (message.kind === 'load' && message.entry !== undefined) this.asked.push(message.entry)
    return new Promise(() => {})
  }

  drop(): void {}
}

async function flush(): Promise<void> {
  for (let turn = 0; turn < 6; turn++) await Promise.resolve()
}

function setUp(): { store: AnnotationStore; worker: Recorder; loader: AnnotationLoader } {
  const store = new AnnotationStore(`first-${Math.random()}.cool`, { persist: false })
  const worker = new Recorder()
  return { store, worker, loader: new AnnotationLoader(store, worker as never, []) }
}

beforeEach(() => {
  useMemoryStores()
  ;(globalThis as unknown as { indexedDB: unknown }).indexedDB = {}
})

describe('a loader held behind the map', () => {
  it('seats the rows at once and reads none of them until the map is drawn', async () => {
    const { store, worker, loader } = setUp()
    let drawn = (): void => {}
    loader.holdUntil(new Promise<void>((resolve) => (drawn = resolve)))
    loader.addUrl('https://example.org/genome.fa', 'sequence')
    loader.addUrl('https://example.org/ATAC.bw', 'ATAC')
    await flush()
    expect(store.entries.map((entry) => entry.status)).toEqual(['loading', 'loading'])
    expect(worker.asked).toEqual([])
    drawn()
    await flush()
    expect(worker.asked).toHaveLength(2)
  })

  it('never reads a row removed while it waited', async () => {
    const { store, worker, loader } = setUp()
    let drawn = (): void => {}
    loader.holdUntil(new Promise<void>((resolve) => (drawn = resolve)))
    loader.addUrl('https://example.org/genome.fa', 'sequence')
    loader.addUrl('https://example.org/ATAC.bw', 'ATAC')
    const [gone, kept] = store.entries.map((entry) => entry.id)
    store.remove(gone)
    drawn()
    await flush()
    expect(worker.asked).toEqual([kept])
  })

  it('lets go when the map fails to draw, as it does when it draws', async () => {
    const { worker, loader } = setUp()
    loader.holdUntil(Promise.reject(new Error('no map')))
    loader.addUrl('https://example.org/ATAC.bw', 'ATAC')
    await flush()
    expect(worker.asked).toHaveLength(1)
  })

  it('reads at once when nothing is holding it', async () => {
    const { worker, loader } = setUp()
    loader.addUrl('https://example.org/ATAC.bw', 'ATAC')
    await flush()
    expect(worker.asked).toHaveLength(1)
  })
})

describe('the room a stack reserves', () => {
  it('counts the rows still reading beside the ones drawn, and no others', () => {
    const store = new AnnotationStore(`room-${Math.random()}.cool`, { persist: false })
    const begin = (label: string): string =>
      store.begin({
        card: 'linear',
        kind: 'track',
        label,
        source: { kind: 'remote', url: `${label}.bw`, name: label },
      }).id
    const drawn = begin('drawn')
    const reading = begin('reading')
    const failed = begin('failed')
    const hidden = begin('hidden')
    store.update(drawn, { status: 'ready' })
    store.update(failed, { status: 'error', error: 'refused' })
    store.update(hidden, { visible: false })
    expect(store.drawnOnMap(LEAD_MAP, 'bottom').map((entry) => entry.id)).toEqual([drawn])
    expect(store.drawnOrLoadingOn(LEAD_MAP, 'bottom').map((entry) => entry.id)).toEqual([
      drawn,
      reading,
    ])
    // Any edge, as a turned map asks.
    expect(store.drawnOrLoadingOn(LEAD_MAP, null).map((entry) => entry.id)).toEqual([
      drawn,
      reading,
    ])
  })
})
