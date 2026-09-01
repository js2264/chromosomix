/**
 * A file and the index beside it, as one gesture.
 *
 * The pairing rule is small and every one of its failures is silent. A `.tbi`
 * that fails to pair costs a whole-file read of the file it existed to avoid
 * reading — slow, and invisible. A `.bai` that fails to pair costs the file
 * entirely, because a BAM has no whole-file fallback to land in (§8.13). So the
 * shapes a reader actually drops are pinned here: both spellings `samtools
 * index` writes, an index with nothing to index, and — the case that was broken
 * for `.tbi` before a BAM existed — a plain drop of both files onto the window.
 */

// @vitest-environment jsdom

import { beforeEach, describe, expect, it } from 'vitest'

import {
  AnnotationLoader,
  basesForIndex,
  indexNamesFor,
  isIndexName,
  pairIndexes,
  splitIndexFragment,
} from '@/annotations/loader'
import { AnnotationStore } from '@/annotations/store'
import { useMemoryStores } from '@/state/idb'

function freshStore(): AnnotationStore {
  const store = new AnnotationStore(`sidecar-${Math.random()}.cool`)
  store.clear()
  return store
}

/** A loader with no worker behind it: the read fails, the entry is still made. */
function loaderOn(store: AnnotationStore): AnnotationLoader {
  return new AnnotationLoader(store, null as never, [])
}

const file = (name: string): File => new File(['bytes'], name)

beforeEach(() => {
  useMemoryStores()
  ;(globalThis as unknown as { indexedDB: unknown }).indexedDB = {}
})

describe('naming a sidecar', () => {
  it('knows the three suffixes and nothing else', () => {
    expect(isIndexName('reads.bam.bai')).toBe(true)
    expect(isIndexName('reads.bam.csi')).toBe(true)
    expect(isIndexName('genes.gtf.gz.tbi')).toBe(true)
    expect(isIndexName('reads.bam')).toBe(false)
    expect(isIndexName('ATAC.bw')).toBe(false)
  })

  it('offers both spellings samtools writes', () => {
    // `samtools index reads.bam` writes the first; an explicit output path,
    // which is what every pipeline that renames its outputs uses, writes the
    // second. A reader must not have to know which one they have.
    expect(basesForIndex('reads.bam.bai')).toEqual(['reads.bam'])
    expect(basesForIndex('reads.bai')).toEqual(['reads', 'reads.bam'])
    expect(basesForIndex('reads.csi')).toEqual(['reads', 'reads.bam'])
  })

  it('leaves a tabix sidecar naming exactly one file', () => {
    // A `.tbi` indexes whatever it is named after and never a `.bam`, so
    // widening it would pair a GTF's index onto an unrelated alignment file.
    expect(basesForIndex('genes.gtf.gz.tbi')).toEqual(['genes.gtf.gz'])
  })
})

describe('grouping a batch', () => {
  // The rule the plain drop onto the window goes through. It lives in one
  // function because there are two roads into it — the Tracks card and
  // `Session.dropped` — and they used to disagree, so a `.bam` and its `.bai`
  // dropped on the window arrived at the loader one at a time.
  const names = (files: File[]): Array<[string, string | undefined]> =>
    pairIndexes(files).map((pair) => [pair.file.name, pair.index?.name])

  it('pairs each file with the sidecar that names it', () => {
    expect(names([file('reads.bam'), file('reads.bam.bai')])).toEqual([
      ['reads.bam', 'reads.bam.bai'],
    ])
  })

  it('keeps the files in the order they were dropped', () => {
    expect(names([file('b.bw'), file('a.bam'), file('a.bam.bai')])).toEqual([
      ['b.bw', undefined],
      ['a.bam', 'a.bam.bai'],
    ])
  })

  it('does not let one sidecar claim two files', () => {
    // `reads.bai` could name either, and `reads.bam.bai` names one exactly —
    // so a directory holding both spellings pairs each file with its own.
    expect(names([file('reads.bam'), file('reads.bam.bai'), file('reads.bai')])).toEqual([
      ['reads.bam', 'reads.bam.bai'],
      ['reads.bai', undefined],
    ])
  })

  it('returns an orphan sidecar as its own entry', () => {
    expect(names([file('reads.bam.bai')])).toEqual([['reads.bam.bai', undefined]])
  })
})

describe('finding a remembered sidecar', () => {
  it('offers every name a BAM index could have been saved under', () => {
    expect(indexNamesFor('reads.bam')).toEqual([
      'reads.bam.bai',
      'reads.bam.csi',
      'reads.bai',
      'reads.csi',
    ])
  })

  it('offers the tabix name for a bgzipped file', () => {
    expect(indexNamesFor('genes.gtf.gz')).toEqual(['genes.gtf.gz.tbi'])
  })

  it('offers nothing for a file that has no sidecar convention', () => {
    expect(indexNamesFor('ATAC.bw')).toEqual([])
  })
})

describe('pairing a drop', () => {
  it('makes one row for a BAM dropped with its index', () => {
    const store = freshStore()
    loaderOn(store).addFiles([file('reads.bam'), file('reads.bam.bai')])

    expect(store.entries).toHaveLength(1)
    expect(store.entries[0].source.name).toBe('reads.bam')
    const source = store.entries[0].source
    expect(source.kind === 'local' ? source.index?.name : null).toBe('reads.bam.bai')
  })

  it('pairs the same whichever order they arrive in', () => {
    const store = freshStore()
    loaderOn(store).addFiles([file('reads.bam.bai'), file('reads.bam')])
    expect(store.entries).toHaveLength(1)
    const source = store.entries[0].source
    expect(source.kind === 'local' ? source.index?.name : null).toBe('reads.bam.bai')
  })

  it('pairs a CSI, which is what a long chromosome has instead', () => {
    const store = freshStore()
    loaderOn(store).addFiles([file('reads.bam'), file('reads.bam.csi')])
    const source = store.entries[0].source
    expect(source.kind === 'local' ? source.index?.name : null).toBe('reads.bam.csi')
  })

  it('pairs the bare spelling too', () => {
    const store = freshStore()
    loaderOn(store).addFiles([file('reads.bam'), file('reads.bai')])
    expect(store.entries).toHaveLength(1)
    const source = store.entries[0].source
    expect(source.kind === 'local' ? source.index?.name : null).toBe('reads.bai')
  })

  it('still pairs a tabix sidecar, which is the case that already existed', () => {
    const store = freshStore()
    loaderOn(store).addFiles([file('genes.gtf.gz'), file('genes.gtf.gz.tbi')])
    expect(store.entries).toHaveLength(1)
    const source = store.entries[0].source
    expect(source.kind === 'local' ? source.index?.name : null).toBe('genes.gtf.gz.tbi')
  })

  it('keeps two pairs apart', () => {
    const store = freshStore()
    loaderOn(store).addFiles([
      file('rna.bam'),
      file('rna.bam.bai'),
      file('chip.bam'),
      file('chip.bam.bai'),
    ])
    expect(store.entries.map((entry) => entry.source.name)).toEqual(['rna.bam', 'chip.bam'])
    const indexes = store.entries.map((entry) =>
      entry.source.kind === 'local' ? entry.source.index?.name : null,
    )
    expect(indexes).toEqual(['rna.bam.bai', 'chip.bam.bai'])
  })

  it('passes a lone index through to be refused by name', () => {
    // More use than silently doing nothing: a reader who dropped only the index
    // gets told what happened.
    const store = freshStore()
    loaderOn(store).addFiles([file('reads.bam.bai')])
    expect(store.entries).toHaveLength(1)
    expect(store.entries[0].source.name).toBe('reads.bam.bai')
  })

  it('leaves a file with no index alone', () => {
    const store = freshStore()
    loaderOn(store).addFiles([file('ATAC.bw')])
    const source = store.entries[0].source
    expect(source.kind === 'local' ? source.index : 'wrong-kind').toBeUndefined()
  })
})

describe('naming a remote index', () => {
  it('takes the URL out of an #index= fragment', () => {
    // The only way to name a sidecar for a presigned URL, or one carrying a
    // query string, where appending `.bai` means nothing.
    expect(splitIndexFragment('https://host/reads.bam?X-Amz-Signature=abc#index=https://host/i.bai'))
      .toEqual({ address: 'https://host/reads.bam?X-Amz-Signature=abc', index: 'https://host/i.bai' })
  })

  it('decodes a fragment that had to be escaped', () => {
    expect(splitIndexFragment('https://h/a.bam#index=https%3A%2F%2Fh%2Fb.bai').index).toBe(
      'https://h/b.bai',
    )
  })

  it('leaves a plain URL alone', () => {
    expect(splitIndexFragment('https://host/reads.bam')).toEqual({
      address: 'https://host/reads.bam',
    })
  })

  it('ignores an empty fragment rather than naming an empty index', () => {
    expect(splitIndexFragment('https://host/reads.bam#index=')).toEqual({
      address: 'https://host/reads.bam',
    })
  })

  it('keeps the fragment out of the name shown for the file', () => {
    const store = freshStore()
    loaderOn(store).addUrl('https://host/reads.bam#index=https://host/other.bai')
    expect(store.entries[0].source.name).toBe('reads.bam')
    const source = store.entries[0].source
    expect(source.kind === 'remote' ? source.url : null).toBe('https://host/reads.bam')
    expect(source.kind === 'remote' ? source.index : null).toBe('https://host/other.bai')
  })
})

describe('what a reload keeps', () => {
  it('does not write a derived row as a local file that never existed', () => {
    // A derived row is computed from two others and holds no bytes and no
    // recipe a StoredEntry can carry. It used to fall through to
    // `{ kind: 'local' }`, so a reload offered to re-open a file with the
    // derived row's label that has never been on any disk.
    const uri = `derived-${Math.random()}.cool`
    const store = new AnnotationStore(uri)
    const real = store.begin({
      card: 'linear',
      kind: 'track',
      source: { kind: 'local', file: file('ATAC.bw'), name: 'ATAC.bw' },
    })
    store.update(real.id, { status: 'ready' })
    const derived = store.begin({
      card: 'linear',
      kind: 'track',
      source: { kind: 'derived', name: 'ATAC − input' },
    })
    store.update(derived.id, { status: 'ready' })

    const stored = AnnotationStore.stored(uri)
    expect(stored.map((row) => row.source.name)).toEqual(['ATAC.bw'])
    expect(stored.every((row) => row.source.name !== 'ATAC − input')).toBe(true)
  })
})
