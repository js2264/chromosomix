/**
 * The command line's file handle: one descriptor held open, reads that walk
 * forward read ahead, and the bytes of every read exactly `LocalFile`'s.
 *
 * Every pattern a track reader makes is here — a walk forward in small steps
 * with gaps (a metaplot), reads at random (a scattered peak set), a read over
 * the end of the file, and reads that land inside what was read ahead — each
 * held to generic-filehandle2's `LocalFile`, which is what the handle replaced
 * and what the browser's worker still reads a local file through.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { LocalFile } from 'generic-filehandle2'
import { afterAll, describe, expect, it } from 'vitest'

import { FIRST_AHEAD, HeldFile, MOST_AHEAD, MOST_HELD } from '@/cli/heldFile'

const directory = mkdtempSync(join(tmpdir(), 'held-file-'))
afterAll(() => rmSync(directory, { recursive: true, force: true }))

function random(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0
    return state / 2 ** 32
  }
}

/** A file of `size` seeded bytes. */
function file(name: string, size: number, seed: number): string {
  const rng = random(seed)
  const bytes = new Uint8Array(size)
  for (let i = 0; i < size; i++) bytes[i] = Math.floor(rng() * 256)
  const path = join(directory, name)
  writeFileSync(path, bytes)
  return path
}

async function same(path: string, reads: ReadonlyArray<[length: number, position: number]>): Promise<void> {
  const held = new HeldFile(path)
  const local = new LocalFile(path)
  for (const [length, position] of reads) {
    const got = await held.read(length, position)
    const want = await local.read(length, position)
    expect(got.length, `${length} at ${position}`).toBe(want.length)
    expect(Buffer.compare(Buffer.from(got), Buffer.from(want)), `${length} at ${position}`).toBe(0)
  }
}

describe('HeldFile', () => {
  const size = 3 * MOST_AHEAD + 12_345
  const path = file('walk.bin', size, 1)

  it('reads a forward walk with gaps as LocalFile does, through its read-ahead', async () => {
    const rng = random(2)
    const reads: Array<[number, number]> = []
    for (let at = 0; at < size; ) {
      const length = 1 + Math.floor(rng() * 20_000)
      reads.push([length, at])
      at += length + Math.floor(rng() * 60_000)
    }
    await same(path, reads)
  })

  it('reads at random as LocalFile does', async () => {
    const rng = random(3)
    await same(
      path,
      Array.from({ length: 300 }, () => [1 + Math.floor(rng() * 50_000), Math.floor(rng() * size)] as [number, number]),
    )
  })

  it('reads over the end of the file, and inside what it read ahead, as LocalFile does', async () => {
    await same(path, [
      [100, 0],
      [100, 200],
      [5000, 400],
      [FIRST_AHEAD, 6000],
      [10, FIRST_AHEAD],
      [MOST_AHEAD, size - 10],
      [50, size - 40],
      [50, size + 100],
      [0, 7],
      [1, size - 1],
    ])
  })

  it('hands back arrays of their own: a change to one is not in the next', async () => {
    const held = new HeldFile(path)
    await held.read(10, 0)
    const first = await held.read(100, 50)
    const copy = Uint8Array.from(first)
    first.fill(0)
    expect(Array.from(await held.read(100, 50))).toEqual(Array.from(copy))
  })

  it('keeps every array it handed back as it was, though its read-ahead buffer is reused', async () => {
    // A walk forward long enough to refill the read-ahead buffer many times
    // over, every array it returned held to the end: a view into the reused
    // buffer, rather than a copy, would come out as some later stretch's bytes.
    const held = new HeldFile(path)
    const local = new LocalFile(path)
    const kept: Array<[Uint8Array, number, number]> = []
    for (let at = 0; at + 3000 < size; at += 3000 + 17_000) kept.push([await held.read(3000, at), 3000, at])
    expect(kept.length).toBeGreaterThan((2 * MOST_AHEAD) / 20_000)
    for (const [got, length, at] of kept) {
      const want = await local.read(length, at)
      expect(Buffer.compare(Buffer.from(got), Buffer.from(want)), `${length} at ${at}`).toBe(0)
    }
  })

  it('reads more files than it holds descriptors for, round and round', async () => {
    const paths = Array.from({ length: MOST_HELD + 9 }, (_, i) => file(`many-${i}.bin`, 2000, 10 + i))
    const handles = paths.map((p) => new HeldFile(p))
    const locals = paths.map((p) => new LocalFile(p))
    for (let round = 0; round < 3; round++) {
      for (let i = 0; i < paths.length; i++) {
        const at = (round * 300 + i * 7) % 1500
        const got = await handles[i].read(200, at)
        const want = await locals[i].read(200, at)
        expect(Buffer.compare(Buffer.from(got), Buffer.from(want))).toBe(0)
      }
    }
    await Promise.all(handles.map((handle) => handle.close()))
  })

  it('states its size as the file does', async () => {
    expect((await new HeldFile(path).stat()).size).toBe(size)
  })
})
