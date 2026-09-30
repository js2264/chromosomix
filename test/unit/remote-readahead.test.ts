/**
 * A remote file read chunk after chunk fetches ahead; one read here and there
 * does not (§12).
 *
 * HDF5 reads a cooler's pixels a dataset chunk at a time, three streams side by
 * side through one region of the file, and each miss of the source's 1 MiB cache
 * was a round trip of its own: a whole chromosome of a 5 GB `.mcool` was 63 of
 * them. The source now reads ahead once misses keep landing near each other —
 * and only then, because the scattered reads of opening a file are the ones the
 * §12 budgets count, and those must fetch what they ask for.
 */

import { afterEach, describe, expect, it } from 'vitest'

import { RemoteRangeSource } from '@/sources/RemoteRangeSource'

const MiB = 1 << 20
const URL_UNDER_TEST = 'https://bucket.test/big.mcool'
const SIZE = 200 * MiB

/** The byte at `position` of the pretend file. */
const byteAt = (position: number): number => (position * 7 + (position >> 20)) & 0xff

/** Every range the stub was asked for, inclusive at both ends. */
const ranges: Array<[number, number]> = []

/** A synchronous XHR over a file that is computed rather than held. */
class GeneratedXhr {
  status = 0
  response: ArrayBuffer | null = null
  responseType = ''
  private range: [number, number] = [0, 0]
  open(): void {}
  setRequestHeader(name: string, value: string): void {
    if (name.toLowerCase() !== 'range') return
    const match = /^bytes=(\d+)-(\d+)$/.exec(value)!
    this.range = [Number(match[1]), Number(match[2])]
  }
  send(): void {
    const [from, to] = this.range
    const end = Math.min(to, SIZE - 1)
    ranges.push([from, end])
    const body = new Uint8Array(end - from + 1)
    for (let i = 0; i < body.length; i++) body[i] = byteAt(from + i)
    this.status = 206
    this.response = body.buffer
  }
  getResponseHeader(name: string): string | null {
    return name.toLowerCase() === 'content-range' ? `bytes ${this.range[0]}-${Math.min(this.range[1], SIZE - 1)}/${SIZE}` : null
  }
}

const probe = (async () =>
  new Response(null, { status: 200, headers: { 'content-length': String(SIZE), 'accept-ranges': 'bytes' } })) as unknown as typeof fetch

const saved = (globalThis as Record<string, unknown>).XMLHttpRequest

afterEach(() => {
  ;(globalThis as Record<string, unknown>).XMLHttpRequest = saved
  ranges.length = 0
})

async function source(options: { readAhead?: boolean } = {}): Promise<RemoteRangeSource> {
  ;(globalThis as Record<string, unknown>).XMLHttpRequest = GeneratedXhr
  ranges.length = 0
  return RemoteRangeSource.open(URL_UNDER_TEST, { fetchImpl: probe, ...options })
}

function expectBytes(got: Uint8Array, position: number): void {
  for (let i = 0; i < got.length; i += 4099) expect(got[i]).toBe(byteAt(position + i))
  expect(got[got.length - 1]).toBe(byteAt(position + got.length - 1))
}

describe('a remote source reading ahead', () => {
  it('fetches a region read a chunk at a time in a few requests, not one each', async () => {
    const remote = await source()
    for (let at = 10 * MiB; at < 42 * MiB; at += MiB) expectBytes(remote.readBytes(at, MiB), at)
    // Thirty-two chunks: 1, 1, then 2, 4, 8, 16 ahead of what each miss needed.
    expect(ranges.length).toBeLessThanOrEqual(8)
    expect(ranges.length).toBeGreaterThan(1)
  })

  it('follows streams read side by side, each at its own pace', async () => {
    const remote = await source()
    for (let k = 0; k < 24; k++) {
      expectBytes(remote.readBytes(20 * MiB + k * MiB, MiB), 20 * MiB + k * MiB)
      expectBytes(remote.readBytes(120 * MiB + k * MiB, MiB), 120 * MiB + k * MiB)
    }
    expect(ranges.length).toBeLessThanOrEqual(16)
  })

  it('fetches only what scattered reads ask for — an index here, a header there', async () => {
    const remote = await source()
    for (const at of [0, 50, 190, 90, 150, 20, 130, 70]) expectBytes(remote.readBytes(at * MiB + 100, 500), at * MiB + 100)
    expect(ranges).toHaveLength(8)
    for (const [from, to] of ranges) expect(to - from + 1).toBe(MiB)
  })

  it('does not start on two near misses alone', async () => {
    const remote = await source()
    remote.readBytes(30 * MiB, 10)
    remote.readBytes(32 * MiB, 10)
    for (const [from, to] of ranges) expect(to - from + 1).toBe(MiB)
  })

  it('never fetches past the end of the file', async () => {
    const remote = await source()
    for (let at = SIZE - 12 * MiB; at < SIZE; at += MiB) expectBytes(remote.readBytes(at, MiB), at)
    for (const [, to] of ranges) expect(to).toBeLessThanOrEqual(SIZE - 1)
  })

  it('is off for a source opened to read in small pieces', async () => {
    const remote = await source({ readAhead: false })
    for (let at = 0; at < 12 * MiB; at += MiB) remote.readBytes(at, MiB)
    expect(ranges).toHaveLength(12)
  })
})
