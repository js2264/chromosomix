/**
 * The two backends behind one folder, and the routing that decides what a row
 * in one is worth clicking.
 *
 * What is worth pinning here is not that a listing parses — `s3-buckets.test.ts`
 * owns the bucket half of that — but the four things a folder abstraction can
 * get wrong while every individual piece of it looks correct:
 *
 * - **The two backends must agree about order.** S3 returns folders and files as
 *   two lexicographic lists; a directory handle returns whatever order the
 *   filesystem feels like. A reader who connects a bucket and a directory of the
 *   same data and sees two different orders has been given two folder views, not
 *   one, and the claim that they are read the same way is false.
 * - **A path handed back must be a path that can be handed in.** Getting the
 *   arithmetic wrong lists the parent again, which looks like a folder that will
 *   not open rather than like a bug — the same failure `bucket-browse.test.ts`
 *   guards on the bucket side, here for a tree rebuilt from `webkitRelativePath`
 *   where there is no server doing the grouping.
 * - **A pick must resolve to the same URI a drop of the same file would.** A
 *   local file opened from a folder and the same file dragged onto the window
 *   have to be one file to `state/handles.ts` and to the session memory, and the
 *   thing that decides that is whether `pick` answers with the bare name.
 * - **The cap has to be reported.** A directory of forty thousand files draws a
 *   thousand rows, and a reader whose file is not among them must be told the
 *   list is not the folder.
 */

import { describe, expect, it } from 'vitest'

import { crumbsOf, ordered, type FolderEntry } from '../../src/browse/folder'
import { handleFolder, snapshotFolder } from '../../src/browse/local'
import { routeOf, unroutableNote } from '../../src/browse/route'

/** A `File` with the relative path a `webkitdirectory` input would give it. */
function fileAt(path: string, size = 10): File {
  const file = new File(['x'.repeat(size)], path.split('/').pop() ?? path)
  Object.defineProperty(file, 'webkitRelativePath', { value: path })
  return file
}

/**
 * A stand-in for `FileSystemDirectoryHandle`, built from a path list.
 *
 * Only the three members `browse/local.ts` touches, because those are the three
 * a browser guarantees and the rest of that interface is write access this app
 * refuses to ask for (§13).
 */
function fakeDirectory(paths: readonly string[], at = ''): FileSystemDirectoryHandle {
  const children = new Map<string, 'file' | 'directory'>()
  for (const path of paths) {
    if (!path.startsWith(at)) continue
    const rest = path.slice(at.length)
    const slash = rest.indexOf('/')
    if (rest === '') continue
    children.set(slash === -1 ? rest : rest.slice(0, slash), slash === -1 ? 'file' : 'directory')
  }
  const handle = {
    kind: 'directory' as const,
    name: at === '' ? 'run2' : at.split('/').filter(Boolean).pop(),
    entries: async function* () {
      for (const [name, kind] of children) {
        yield [name, { kind, name }] as [string, FileSystemHandle]
      }
    },
    async getDirectoryHandle(name: string) {
      return fakeDirectory(paths, `${at}${name}/`)
    },
    async getFileHandle(name: string) {
      const full = `${at}${name}`
      if (!paths.includes(full)) throw new Error('not found')
      return { kind: 'file', name, async getFile() { return fileAt(full) } }
    },
  }
  return handle as unknown as FileSystemDirectoryHandle
}

const PAIRED = ['reads.bam', 'reads.bam.bai', 'genes.gtf.gz', 'genes.gtf.gz.tbi']

const TREE = [
  'hum53/map.mcool',
  'hum53/deep/inner.bw',
  'ATAC_2.bw',
  'ATAC_10.bw',
  'notes.bam',
  '.DS_Store',
]

describe('routing a name', () => {
  it('sends contact maps one way and genome files the other', () => {
    expect(routeOf('rep1.mcool')).toBe('map')
    expect(routeOf('https://b.s3.amazonaws.com/x/rep1.hic')).toBe('map')
    expect(routeOf('signal.bw')).toBe('genome')
    expect(routeOf('genes.gtf.gz')).toBe('genome')
  })

  it('answers on the last segment, whatever kind of path it is in', () => {
    // A Windows path arrives from a dropped file's `name` on that platform, and
    // a `::entries/` URI names a map inside a collection.
    expect(routeOf('C:\\data\\rep1.cool')).toBe('map')
    expect(routeOf('rep1.mmetacool::entries/rep1')).toBe('map')
  })

  it('sends a BAM to the genome door', () => {
    // It annotates a genome and its `@SQ` table can declare one, so it is the
    // same door a bigWig goes through (§8.13). Whether the file behind the name
    // opens is a question about its bytes and its index, settled where a
    // refusal can carry a message.
    expect(routeOf('reads.bam')).toBe('genome')
  })

  /**
   * `unknown` is "no route", not "broken", and the row says which.
   *
   * An index in particular is not junk — it is half of the file beside it — so
   * telling a reader it is unopenable without saying that would send them
   * looking for a problem that does not exist.
   */
  it('explains a row it cannot offer, and says nothing about one it can', () => {
    expect(unroutableNote('mystery.xyz')).toBe('Not a format this viewer opens.')
    expect(unroutableNote('genes.bed.gz.tbi')).toContain('tabix index')
    expect(unroutableNote('reads.bam.bai')).toContain('BAM index')
    expect(unroutableNote('reads.bam.csi')).toContain('BAM index')
    expect(unroutableNote('rep1.cool')).toBeNull()
    expect(unroutableNote('reads.bam')).toBeNull()
  })

  it('says what to do with a CRAM rather than only that it cannot be opened', () => {
    // Refused for its own reason and not as collateral: CRAM cannot be read
    // without its exact reference, conventionally from somebody else's
    // registry, which C1 and C5 forbid outright.
    expect(unroutableNote('reads.cram')).toContain('samtools view -b')
  })
})

describe('the shared ordering', () => {
  it('puts folders first and sorts each run naturally', () => {
    const entries: FolderEntry[] = [
      { kind: 'file', name: 'ATAC_10.bw', path: 'ATAC_10.bw', size: 1 },
      { kind: 'file', name: 'ATAC_2.bw', path: 'ATAC_2.bw', size: 1 },
      { kind: 'folder', name: 'zebra', path: 'zebra/', size: null },
      { kind: 'folder', name: 'apple', path: 'apple/', size: null },
    ]
    // Naturally: `ATAC_2` before `ATAC_10`, which a plain string sort inverts —
    // and a run sheet numbers its samples exactly that way.
    expect(ordered(entries).map((entry) => entry.name)).toEqual([
      'apple',
      'zebra',
      'ATAC_2.bw',
      'ATAC_10.bw',
    ])
  })
})

describe('crumbs', () => {
  it('is rooted at the folder’s own root, never above it', () => {
    // A bucket key may not be allowed to list above the prefix it was given, and
    // a directory grant reaches down and never up.
    expect(crumbsOf('collections/', 'collections/hum53/2026-03/')).toEqual(['hum53', '2026-03'])
    expect(crumbsOf('', 'hum53/')).toEqual(['hum53'])
    expect(crumbsOf('collections/', 'collections/')).toEqual([])
  })
})

describe('a granted directory', () => {
  const folder = (): ReturnType<typeof handleFolder> =>
    handleFolder('dir:0', 'run2', fakeDirectory(TREE))

  it('lists one level, folders first, and hides the tooling', () => {
    return folder()
      .list('')
      .then((listing) => {
        expect(listing.entries.map((entry) => entry.name)).toEqual([
          'hum53',
          'ATAC_2.bw',
          'ATAC_10.bw',
          'notes.bam',
        ])
        // `.DS_Store` and `.git` are somebody's tooling, not their data.
        expect(listing.entries.map((entry) => entry.name)).not.toContain('.DS_Store')
      })
  })

  it('hands back a path that lists the folder that was clicked', async () => {
    const at = folder()
    const listing = await at.list('')
    const sub = listing.entries.find((entry) => entry.kind === 'folder')!
    expect(sub.path).toBe('hum53/')
    expect((await at.list(sub.path)).entries.map((entry) => entry.name)).toEqual([
      'deep',
      'map.mcool',
    ])
  })

  /**
   * A picked file is called by its **bare name**, as every other local open is.
   *
   * `state/handles.ts` keys a grant by the URI and `UiMemory` keys a tab's
   * memory by it, so answering with `hum53/map.mcool` here would make a file
   * opened from a connected folder a different file from the same one dropped on
   * the window — two sets of colours, two grants, one file.
   */
  it('picks a file as a local source under its bare name', async () => {
    const at = folder()
    const listing = await at.list('hum53/')
    const entry = listing.entries.find((row) => row.name === 'map.mcool')!
    const picked = await at.pick(entry)
    expect(picked.uri).toBe('map.mcool')
    expect(picked.source.kind).toBe('local')
  })

  it('is durable, which is what makes it a connection rather than a snapshot', () => {
    expect(folder().durable).toBe(true)
  })
})

describe('a snapshot directory', () => {
  const folder = (): ReturnType<typeof snapshotFolder> =>
    snapshotFolder('snap:0', 'run2', TREE.map((path) => fileAt(`run2/${path}`)))

  /**
   * The tree is rebuilt from strings, and the first segment is the directory's
   * own name — dropped, or the whole folder would be one node containing itself.
   */
  it('rebuilds the same tree the granted one lists', async () => {
    const listing = await folder().list('')
    expect(listing.entries.map((entry) => entry.name)).toEqual([
      'hum53',
      'ATAC_2.bw',
      'ATAC_10.bw',
      'notes.bam',
    ])
  })

  it('names a sub-folder once however many files are under it', async () => {
    const at = folder()
    const listing = await at.list('hum53/')
    // `deep/` is named by exactly one file here and would be named by twenty in
    // a real directory; a set is what keeps it one row either way.
    expect(listing.entries.map((entry) => entry.name)).toEqual(['deep', 'map.mcool'])
    expect((await at.list('hum53/deep/')).entries.map((entry) => entry.name)).toEqual(['inner.bw'])
  })

  it('picks under the bare name too, so the two backends agree', async () => {
    const at = folder()
    const listing = await at.list('hum53/')
    const picked = await at.pick(listing.entries.find((row) => row.name === 'map.mcool')!)
    expect(picked.uri).toBe('map.mcool')
    expect(picked.source.kind).toBe('local')
  })

  /**
   * It says it will not survive a reload, because it will not.
   *
   * A `File[]` is bytes the page was handed rather than permission to fetch
   * them, so there is nothing to store. The panel prints this on the row; a
   * reader who finds out tomorrow has been told at the wrong moment.
   */
  it('is not durable, and says so rather than being quietly different', () => {
    expect(folder().durable).toBe(false)
  })

  it('refuses a pick for an entry that is no longer in the snapshot', async () => {
    await expect(
      folder().pick({ kind: 'file', name: 'gone.bw', path: 'gone.bw', size: null }),
    ).rejects.toThrow(/no longer/)
  })
})

describe('the listing cap', () => {
  /**
   * Truncation is reported, not silently applied.
   *
   * "My file is not here" and "my file is past the cap" look identical on
   * screen, and only one of them is something a reader can act on.
   */
  it('stops at a thousand entries and says the list is not the folder', async () => {
    const many = Array.from({ length: 1200 }, (_, at) => `run2/f${String(at).padStart(5, '0')}.bw`)
    const snap = await snapshotFolder('s', 'run2', many.map((path) => fileAt(path))).list('')
    expect(snap.entries).toHaveLength(1000)
    expect(snap.truncated).toBe(true)

    const granted = await handleFolder(
      'd',
      'run2',
      fakeDirectory(many.map((path) => path.slice('run2/'.length))),
    ).list('')
    expect(granted.entries.length).toBeLessThanOrEqual(1000)
    expect(granted.truncated).toBe(true)
  })
})

describe('picking a file that comes in a pair', () => {
  // A `.bam` picked out of a listing whose `.bai` is one row down and drawn
  // inert should not then be refused for want of an index (§8.13) — and a
  // bgzipped feature file should not quietly read itself whole.
  /** Both folder shapes answer this the same way, so both are asked. */
  const pickIn = async (
    names: string[],
    want: string,
  ): Promise<Array<string | undefined>> => {
    const paths = names.map((name) => `run2/${name}`)
    const snap = snapshotFolder('s', 'run2', paths.map((path) => fileAt(path)))
    const granted = handleFolder('dir:0', 'run2', fakeDirectory(names))
    const out: Array<string | undefined> = []
    for (const at of [snap, granted]) {
      const listing = await at.list('')
      const entry = listing.entries.find((row) => row.name === want)
      expect(entry, want).toBeDefined()
      out.push((await at.pick(entry as FolderEntry)).index?.name)
    }
    return out
  }

  it('hands over the index sitting beside a BAM', async () => {
    expect(await pickIn(PAIRED, 'reads.bam')).toEqual(['reads.bam.bai', 'reads.bam.bai'])
  })

  it('hands over a tabix sidecar the same way', async () => {
    expect(await pickIn(PAIRED, 'genes.gtf.gz')).toEqual([
      'genes.gtf.gz.tbi',
      'genes.gtf.gz.tbi',
    ])
  })

  it('offers nothing for a file that has no pair in the folder', async () => {
    expect(await pickIn(['reads.bam', 'ATAC.bw'], 'ATAC.bw')).toEqual([undefined, undefined])
    expect(await pickIn(['reads.bam', 'ATAC.bw'], 'reads.bam')).toEqual([undefined, undefined])
  })

  it('takes the bare spelling where that is what the folder holds', async () => {
    expect(await pickIn(['reads.bam', 'reads.bai'], 'reads.bam')).toEqual([
      'reads.bai',
      'reads.bai',
    ])
  })
})
