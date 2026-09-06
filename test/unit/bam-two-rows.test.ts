/**
 * A BAM imports as two rows, and everything that has to stay true of the pair.
 *
 * The depth and the pile are two pictures with nothing in common — one is a
 * curve against a value axis, drawn at every zoom and on both surfaces; the
 * other is a stack of rectangles that exists only in the 1D browser and only
 * once a read is wider than a pixel (§8.13). They used to share a lane, which
 * made every question about them conditional: how tall is this, what does the
 * ceiling drag do, which band did that click land in. As two rows each is
 * resized, moved, hidden and closed like any other track.
 *
 * What that buys has to be paid for in invariants, and each of these failed at
 * least once while it was being built. The fork must happen *after* the bytes
 * come back, or a file whose name ends in `.bam` and turns out to be something
 * else gets a second row with nothing in it. It must not happen for a row that
 * is *returning* — a reader who closed the pile and kept the depth would be
 * handed the pile again on every reload. And the pile's kind must survive its
 * own load, or every restore folds it back into the depth row it was made
 * beside.
 */

// @vitest-environment jsdom

import { beforeEach, describe, expect, it } from 'vitest'

import { AnnotationLoader } from '@/annotations/loader'
import { AnnotationStore } from '@/annotations/store'
import { useMemoryStores } from '@/state/idb'
import type { AnnotationEntry, StoredEntry } from '@/annotations/types'

/** A worker that answers every `load` as whichever format the test asked for. */
class Fake {
  readonly loaded: string[] = []
  constructor(private readonly format: string) {}

  request(message: { kind: string; entry?: string }): Promise<unknown> {
    if (message.kind !== 'load') return Promise.resolve(null)
    if (message.entry !== undefined) this.loaded.push(message.entry)
    return Promise.resolve({
      format: this.format,
      contigs: ['chrI'],
      overlap: { matched: 1, total: 1, missing: [] },
      summary: '1 reference · BAI',
    })
  }

  drop(): void {}
}

/** Four turns: the loader's `await`, then `.then`, `.catch`, `.finally`. */
async function flush(): Promise<void> {
  for (let turn = 0; turn < 8; turn++) await Promise.resolve()
}

function setUp(format = 'bam'): { store: AnnotationStore; loader: AnnotationLoader; worker: Fake } {
  const store = new AnnotationStore(`two-rows-${Math.random()}.cool`)
  store.clear()
  const worker = new Fake(format)
  return { store, loader: new AnnotationLoader(store, worker as never, []), worker }
}

const file = (name: string): File => new File(['bytes'], name)

const kinds = (store: AnnotationStore): string[] => store.entries.map((entry) => entry.kind)

function rowOf(store: AnnotationStore, kind: string): AnnotationEntry {
  const found = store.entries.find((entry) => entry.kind === kind)
  if (found === undefined) throw new Error(`no ${kind} row: ${kinds(store).join(', ')}`)
  return found
}

beforeEach(() => {
  useMemoryStores()
  ;(globalThis as unknown as { indexedDB: unknown }).indexedDB = {}
})

describe('importing a BAM', () => {
  it('makes a depth row and a pile row over the one file', async () => {
    const { store, loader } = setUp()
    loader.addFiles([file('reads.bam'), file('reads.bam.bai')])
    await flush()

    expect(kinds(store).sort()).toEqual(['alignments', 'reads'])
    const depth = rowOf(store, 'alignments')
    const pile = rowOf(store, 'reads')
    expect(depth.source.name).toBe('reads.bam')
    expect(pile.source.name).toBe('reads.bam')
    // Named apart: the Tracks list is a list of names, and two rows called
    // `reads` differ there only by the picture beside them.
    expect(pile.label).not.toBe(depth.label)
    expect(pile.label).toContain(depth.label)
  })

  it('points the two rows at each other', async () => {
    const { store, loader } = setUp()
    loader.addFiles([file('reads.bam')])
    await flush()

    const depth = rowOf(store, 'alignments')
    const pile = rowOf(store, 'reads')
    expect(depth.partner).toBe(pile.id)
    expect(pile.partner).toBe(depth.id)
  })

  it('opens the pile in the worker too, so it has a file to read', async () => {
    // Two rows, two `load` requests, one shared open file behind them — the
    // worker's `openFiles` record. A pile row that was never loaded answers
    // every `reads` request with "this track is no longer open".
    const { store, loader, worker } = setUp()
    loader.addFiles([file('reads.bam')])
    await flush()

    expect(worker.loaded.sort()).toEqual(
      [rowOf(store, 'alignments').id, rowOf(store, 'reads').id].sort(),
    )
  })

  it('gives the pile the depth row’s colour, since they are one file', async () => {
    const { store, loader } = setUp()
    loader.addFiles([file('reads.bam')])
    await flush()
    expect(rowOf(store, 'reads').style.colour).toBe(rowOf(store, 'alignments').style.colour)
  })

  it('does not fork a file that only looked like a BAM', async () => {
    // The fork happens after the bytes come back (§8.3), so a `.bam` that turns
    // out to be a bigWig is one row — and a bigWig is one row whatever it is
    // called.
    const { store, loader } = setUp('bigwig')
    loader.addFiles([file('reads.bam')])
    await flush()
    expect(kinds(store)).toEqual(['track'])
  })

  it('leaves every other format alone', async () => {
    const { store, loader } = setUp('bigwig')
    loader.addFiles([file('ATAC.bw')])
    await flush()
    expect(store.entries).toHaveLength(1)
  })
})

describe('a BAM that has been here before', () => {
  /** The two rows as a stored session holds them. */
  function storedPair(): StoredEntry[] {
    const common = {
      card: 'linear' as const,
      source: { kind: 'local' as const, name: 'reads.bam' },
      visible: true,
      placement: { top: false, right: false, bottom: true, left: false },
      style: { colour: '#1f5fa9' },
    }
    return [
      { ...common, id: 'depth', kind: 'alignments', label: 'reads', partner: 'pile' },
      { ...common, id: 'pile', kind: 'reads', label: 'reads · reads', partner: 'depth' },
    ] as StoredEntry[]
  }

  it('comes back as two rows and not three', async () => {
    // The trap: the restored depth row loads, comes back `bam`, and forks
    // again. `guessed` is what stops it — a restored row's shape is not a guess
    // to be corrected.
    const { store, loader } = setUp()
    loader.restore(storedPair())
    await flush()
    expect(kinds(store).sort()).toEqual(['alignments', 'reads'])
  })

  it('keeps the pile a pile through its own load', async () => {
    // `kindFor` says a `bam` is `alignments`, because that is what a *file* of
    // that format is. The pile is the same file read a second way, and
    // re-deriving its kind from the format folds it back into the depth row.
    const { store, loader } = setUp()
    loader.restore(storedPair())
    await flush()
    expect(store.byId('pile')?.kind).toBe('reads')
    expect(store.byId('depth')?.kind).toBe('alignments')
  })

  it('brings the link back with them', async () => {
    const { store, loader } = setUp()
    loader.restore(storedPair())
    await flush()
    expect(store.byId('depth')?.partner).toBe('pile')
    expect(store.byId('pile')?.partner).toBe('depth')
  })

  it('does not hand back a row the reader closed', async () => {
    // A reader who wants only the depth closes the pile. The session that comes
    // back has one row in it, and nothing here may add the other: the fork is
    // for fresh imports.
    const { store, loader } = setUp()
    loader.restore([{ ...storedPair()[0], partner: undefined } as StoredEntry])
    await flush()
    expect(kinds(store)).toEqual(['alignments'])
  })
})

describe('closing one of the two', () => {
  it('leaves the other drawn, and holding no link', async () => {
    const { store, loader } = setUp()
    loader.addFiles([file('reads.bam')])
    await flush()

    store.remove(rowOf(store, 'alignments').id)
    expect(kinds(store)).toEqual(['reads'])
    expect(rowOf(store, 'reads').partner).toBeUndefined()
  })

  it('works the other way round too', async () => {
    const { store, loader } = setUp()
    loader.addFiles([file('reads.bam')])
    await flush()

    store.remove(rowOf(store, 'reads').id)
    expect(kinds(store)).toEqual(['alignments'])
    expect(rowOf(store, 'alignments').partner).toBeUndefined()
  })
})

describe('dropping the file on a detached pair', () => {
  it('reattaches both rows, not the first one found', async () => {
    // Both rows carry the same file name, so a `.find()` here reattached one of
    // them and left the reader pointing at a file they had just pointed at.
    const { store, loader } = setUp()
    loader.restore([
      { id: 'depth', card: 'linear', kind: 'alignments', label: 'reads',
        source: { kind: 'local', name: 'reads.bam' }, visible: true,
        placement: { top: false, right: false, bottom: true, left: false },
        style: { colour: '#1f5fa9' }, partner: 'pile' },
      { id: 'pile', card: 'linear', kind: 'reads', label: 'reads · reads',
        source: { kind: 'local', name: 'reads.bam' }, visible: true,
        placement: { top: false, right: false, bottom: true, left: false },
        style: { colour: '#1f5fa9' }, partner: 'depth' },
    ] as StoredEntry[])
    await flush()
    expect(store.entries.map((entry) => entry.status)).toEqual(['detached', 'detached'])

    loader.addFiles([file('reads.bam'), file('reads.bam.bai')])
    await flush()
    expect(store.entries.map((entry) => entry.status)).toEqual(['ready', 'ready'])
    // …and still two rows: a reattach is not an import, so nothing forks.
    expect(kinds(store).sort()).toEqual(['alignments', 'reads'])
  })
})
