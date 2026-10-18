/**
 * A dropped file is read a slice at a time, not whole.
 *
 * The remote source has always worked this way; the local one read the entire
 * file into an ArrayBuffer and then copied it again into the FS, so opening a
 * 5 GB file to look at one region cost 5 GB of reading and up to 10 GB of heap
 * before a byte of HDF5 was parsed — and a large enough file could not be opened
 * at all. These are the properties of the slice path, driven through
 * `readBytes`, which is the accessor the FS stream op is built on.
 *
 * `FileReaderSync` exists only in a worker, so it is stubbed here; the blob is a
 * real `Blob` subclass so the source's own type test is the one that runs. The
 * stub counts slices, which is most of what these tests are asserting.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { LocalFileSource } from '@/sources/LocalFileSource'

const MIB = 1 << 20

/** A `Blob` whose bytes are synchronously reachable, which Node's is not. */
class SyncBlob extends Blob {
  readonly content: Uint8Array
  constructor(content: Uint8Array) {
    super([])
    this.content = content
  }
  override get size(): number {
    return this.content.length
  }
  override slice(from = 0, to = this.content.length): Blob {
    return new SyncBlob(this.content.subarray(from, to)) as unknown as Blob
  }
  /** What a `.hic` walk's exact reads read through, counted as a slice of its own. */
  override async arrayBuffer(): Promise<ArrayBuffer> {
    exact.push(this.content.length)
    return this.content.slice().buffer
  }
}

/** Slices the stub served, so the cache can be asserted on. */
let slices: number[] = []
/** Exact reads made, by their length. */
let exact: number[] = []

beforeEach(() => {
  slices = []
  exact = []
  ;(globalThis as Record<string, unknown>)['FileReaderSync'] = class {
    readAsArrayBuffer(part: Blob): ArrayBuffer {
      slices.push(part.size)
      const bytes = (part as SyncBlob).content
      return bytes.slice().buffer
    }
  }
})

afterEach(() => {
  delete (globalThis as Record<string, unknown>)['FileReaderSync']
})

/** A blob whose byte at offset `i` is `i % 251`. */
function patterned(size: number): Blob {
  const whole = new Uint8Array(size)
  for (let i = 0; i < size; i++) whole[i] = i % 251
  return new SyncBlob(whole) as unknown as Blob
}

describe('a dropped file is read lazily', () => {
  it('returns the right bytes for reads that straddle slice boundaries', () => {
    const size = 5 * MIB + 1234
    const source = new LocalFileSource(patterned(size), { name: 'f.metacool' })
    for (const [at, length] of [
      [0, 16],
      [MIB - 8, 32],
      [3 * MIB + 100, MIB],
      [size - 10, 10],
    ] as Array<[number, number]>) {
      const got = source.readBytes(at, length)
      const want = Uint8Array.from({ length }, (_, i) => (at + i) % 251)
      // One assertion rather than a million: `expect` per byte is correct and
      // takes ten seconds on the 1 MiB case.
      expect(got).toEqual(want)
    }
  })

  it('clamps a read that runs past the end', () => {
    const size = 2 * MIB
    const source = new LocalFileSource(patterned(size), { name: 'f.metacool' })
    expect(source.readBytes(size - 5, 100)).toHaveLength(5)
    expect(source.readBytes(size, 100)).toHaveLength(0)
  })

  it('reads each slice once, however many times its bytes are asked for', () => {
    const source = new LocalFileSource(patterned(4 * MIB), { name: 'f.metacool' })
    source.readBytes(0, 64)
    expect(slices).toHaveLength(1)
    for (let i = 0; i < 50; i++) source.readBytes(i * 8, 64)
    expect(slices).toHaveLength(1)
    expect(source.cachedChunkCount()).toBe(1)
  })

  it('reads a slice at a time rather than the whole file', () => {
    const size = 64 * MIB
    const source = new LocalFileSource(patterned(size), { name: 'big.metacool' })
    // The HDF5 metadata walk: a few dozen bytes from a handful of places.
    source.readBytes(0, 512)
    source.readBytes(48 * MIB, 512)
    expect(slices).toHaveLength(2)
    for (const slice of slices) expect(slice).toBeLessThanOrEqual(MIB)
    // Two megabytes touched for a 64 MB file, which is the whole claim.
    expect(source.stats().bytes).toBeLessThanOrEqual(2 * MIB)
    expect(source.stats().bytes).toBeLessThan(size / 8)
  })

  it('bounds what it retains, and keeps serving correct bytes past the bound', () => {
    const size = 200 * MIB
    const source = new LocalFileSource(patterned(size), { name: 'big.metacool' })
    for (let i = 0; i < 100; i++) source.readBytes(i * MIB, 16)
    // 64 MiB of 1 MiB slices.
    expect(source.cachedChunkCount()).toBeLessThanOrEqual(64)
    const got = source.readBytes(3 * MIB, 8)
    for (let i = 0; i < 8; i++) expect(got[i]).toBe((3 * MIB + i) % 251)
  })

  it('reports its size without touching a byte', () => {
    const source = new LocalFileSource(patterned(9 * MIB), { name: 'f.metacool' })
    expect(source.size).toBe(9 * MIB)
    expect(slices).toHaveLength(0)
    expect(source.stats()).toEqual({ requests: 0, bytes: 0 })
  })
})

describe('a dropped file read exactly, as a .hic walk reads it', () => {
  it('reads the range asked for and nothing round it, and keeps none of it', async () => {
    const size = 8 * MIB
    const source = new LocalFileSource(patterned(size), { name: 'walk.hic' })
    const got = await source.readExact!(5 * MIB + 7, 300)
    expect(got).toEqual(Uint8Array.from({ length: 300 }, (_, i) => (5 * MIB + 7 + i) % 251))
    expect(exact).toEqual([300])
    expect(slices).toEqual([])
    expect(source.cachedChunkCount()).toBe(0)
    expect(source.stats()).toEqual({ requests: 1, bytes: 300 })
  })

  it('is answered from the slices already held, for nothing', async () => {
    const source = new LocalFileSource(patterned(4 * MIB), { name: 'walk.hic' })
    source.readBytes(0, 16)
    const got = await source.readExact!(100, 50)
    expect(got).toEqual(Uint8Array.from({ length: 50 }, (_, i) => (100 + i) % 251))
    expect(exact).toEqual([])
    expect(slices).toHaveLength(1)
  })

  it('stops at the end of the file', async () => {
    const source = new LocalFileSource(patterned(MIB), { name: 'walk.hic' })
    expect(await source.readExact!(MIB - 10, 100)).toHaveLength(10)
    expect(await source.readExact!(MIB, 100)).toHaveLength(0)
  })

  it('is a dropped file’s only: bytes in memory are read exactly already', () => {
    expect(new LocalFileSource(new Uint8Array(16)).readExact).toBeUndefined()
  })
})
