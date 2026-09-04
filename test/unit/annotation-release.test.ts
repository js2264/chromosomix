/**
 * A row that leaves the store leaves the worker too.
 *
 * `AnnotationStore.remove` drops the row, its lanes and its placements, and
 * says nothing to the thread holding the file. So `AnnotationClient.drop` had
 * exactly one caller — the path that refuses an unreadable format — and closing
 * a track that had loaded *fine* released nothing at all: a bigWig kept its open
 * handle, a BAM kept its parsed index, for the life of the tab.
 *
 * Invisible by construction, which is why it survived: the lane goes, the card
 * goes, and the only evidence is a number in a memory profile. Pinned here on
 * the loader's own channel rather than on the worker, because the worker's
 * `drop` handler was always correct — nobody was calling it.
 */

// @vitest-environment jsdom

import { beforeEach, describe, expect, it } from 'vitest'

import { AnnotationLoader } from '@/annotations/loader'
import { AnnotationStore } from '@/annotations/store'
import { useMemoryStores } from '@/state/idb'
import type { StoredEntry } from '@/annotations/types'

/**
 * A worker that answers `load` when told to and records every `drop`.
 *
 * The answer is withheld by default: "removed while its own load is still in
 * flight" is one of the cases that has to release, and a client that resolves
 * immediately cannot express it.
 */
class Recorder {
  readonly dropped: string[] = []
  private readonly waiting = new Map<string, (result: unknown) => void>()

  request(message: { kind: string; entry?: string }): Promise<unknown> {
    if (message.kind !== 'load' || message.entry === undefined) return Promise.resolve(null)
    const entry = message.entry
    return new Promise((resolve) => this.waiting.set(entry, resolve))
  }

  /** Let one in-flight `load` land, as a readable file. */
  land(entry: string): Promise<void> {
    const resolve = this.waiting.get(entry)
    if (resolve === undefined) throw new Error(`${entry} is not loading`)
    this.waiting.delete(entry)
    resolve({
      format: 'bigwig',
      contigs: ['chr1'],
      overlap: { shared: 1, trackOnly: [], mapOnly: [], renamed: [] },
      summary: '1 contig',
    })
    return flush()
  }

  drop(entry: string): void {
    this.dropped.push(entry)
  }
}

/** Four turns: the loader's `await`, then `.then`, `.catch`, `.finally`. */
async function flush(): Promise<void> {
  for (let turn = 0; turn < 4; turn++) await Promise.resolve()
}

function freshStore(): AnnotationStore {
  const store = new AnnotationStore(`release-${Math.random()}.cool`)
  store.clear()
  return store
}

function setUp(): { store: AnnotationStore; worker: Recorder; loader: AnnotationLoader } {
  const store = freshStore()
  const worker = new Recorder()
  const loader = new AnnotationLoader(store, worker as never, [])
  return { store, worker, loader }
}

const file = (name: string): File => new File(['bytes'], name)

beforeEach(() => {
  useMemoryStores()
  ;(globalThis as unknown as { indexedDB: unknown }).indexedDB = {}
})

describe('closing a track', () => {
  it('tells the worker to let go of the file', async () => {
    const { store, worker, loader } = setUp()
    loader.addFiles([file('ATAC.bw')])
    const id = store.entries[0].id
    await worker.land(id)
    expect(worker.dropped).toEqual([])

    store.remove(id)
    expect(worker.dropped).toEqual([id])
  })

  it('leaves the tracks that are still open alone', async () => {
    const { store, worker, loader } = setUp()
    loader.addFiles([file('one.bw'), file('two.bw')])
    const [one, two] = store.entries.map((entry) => entry.id)
    await worker.land(one)
    await worker.land(two)

    store.remove(one)
    expect(worker.dropped).toEqual([one])
  })

  it('releases a row closed while its own load is still in flight', () => {
    // The reply may never come — a file the reader closed a second after
    // dropping it is exactly the read that gets cancelled — so the id has to be
    // held from the moment the request goes out, not from the moment it lands.
    const { store, worker, loader } = setUp()
    loader.addFiles([file('slow.bw')])
    const id = store.entries[0].id

    store.remove(id)
    expect(worker.dropped).toEqual([id])
  })

  it('holds a row that came back under the id it went away with', async () => {
    // Which is why this is a set of ids and not a reference count: a detached
    // local row keeps its id, and dropping the same file on it re-issues `load`
    // for that id (§8.6). A count would have gone to zero on the removal that
    // never happened and stayed there.
    const { store, worker, loader } = setUp()
    loader.restore([
      {
        id: 'a1',
        card: 'linear',
        kind: 'track',
        label: 'ATAC',
        source: { kind: 'local', name: 'ATAC.bw' },
        visible: true,
        placement: { bottom: true },
        style: { colour: '#1f5fa9' },
      } as StoredEntry,
    ])
    expect(store.byId('a1')?.status).toBe('detached')

    loader.addFiles([file('ATAC.bw')])
    await worker.land('a1')
    expect(store.byId('a1')?.status).toBe('ready')

    store.remove('a1')
    expect(worker.dropped).toEqual(['a1'])
  })

  it('says it once, however many times the store then changes', async () => {
    const { store, worker, loader } = setUp()
    loader.addFiles([file('ATAC.bw')])
    const id = store.entries[0].id
    await worker.land(id)

    store.remove(id)
    loader.addFiles([file('other.bw')])
    expect(worker.dropped).toEqual([id])
  })
})
