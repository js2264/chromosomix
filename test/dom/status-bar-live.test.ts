// @vitest-environment jsdom
/**
 * The status bar's counters move with the map (§12).
 *
 * The bar asked the reader for its counters only when a view was built, so a
 * zoom, which reads its blocks without one, left *read* at the first picture's
 * figure through a hundred megabytes of refines. It asks again every second,
 * shows the requests beside the bytes, never asks twice at once, and adds what
 * the reader holds for the file to the main thread's heap.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { StatusBar } from '@/ui/StatusBar'
import type { ReaderClient } from '@/worker/client'
import type { StatsResult } from '@/worker/protocol'
import { all, setUpDom, type DomTeardown } from '../support/dom'

let teardown: DomTeardown
const bars: StatusBar[] = []

beforeEach(() => {
  teardown = setUpDom()
  vi.useFakeTimers()
})

afterEach(() => {
  for (const bar of bars.splice(0)) bar.destroy()
  vi.useRealTimers()
  vi.restoreAllMocks()
  teardown()
})

/** A reader whose counters grow by `step` each time it is asked, answering when `answer` is called. */
function reader(): { client: ReaderClient; asks: number; answer(): void; bytes: number } {
  const state = {
    asks: 0,
    bytes: 0,
    pending: [] as Array<() => void>,
    answer(): void {
      for (const resolve of state.pending.splice(0)) resolve()
    },
  }
  const client = {
    request: (request: { kind: string }) => {
      if (request.kind !== 'stats') return Promise.reject(new Error(request.kind))
      state.asks++
      return new Promise<StatsResult>((resolve) => {
        state.pending.push(() => {
          state.bytes += 5_000_000
          resolve({
            total: { requests: state.asks * 3, bytes: state.bytes },
            lastOp: { requests: 3, bytes: 5_000_000 },
            calls: state.asks,
            memory: { wasm: 16 << 20, cache: 4 << 20 },
          })
        })
      })
    },
  } as unknown as ReaderClient
  return {
    client,
    get asks() {
      return state.asks
    },
    get bytes() {
      return state.bytes
    },
    answer: () => state.answer(),
  }
}

function readText(bar: StatusBar): string {
  const key = all<HTMLElement>(bar.el, '.status-key').find((node) => node.textContent === 'read')
  return key?.closest('.status-item')?.querySelector('.status-value')?.textContent ?? ''
}

describe('the status bar', () => {
  it('asks the reader again every second, and shows its bytes and requests as they grow', async () => {
    const r = reader()
    const bar = new StatusBar({ client: () => r.client })
    bars.push(bar)
    bar.refresh()
    expect(r.asks).toBe(1)
    r.answer()
    await vi.advanceTimersByTimeAsync(0)
    expect(readText(bar)).toBe('5.0 MB · 3 req')
    await vi.advanceTimersByTimeAsync(1000)
    expect(r.asks).toBe(2)
    r.answer()
    await vi.advanceTimersByTimeAsync(0)
    expect(readText(bar)).toBe('10.0 MB · 6 req')
  })

  it('does not ask again while an ask is out', async () => {
    const r = reader()
    const bar = new StatusBar({ client: () => r.client })
    bars.push(bar)
    bar.refresh()
    await vi.advanceTimersByTimeAsync(3000)
    expect(r.asks).toBe(1)
    r.answer()
    await vi.advanceTimersByTimeAsync(1000)
    expect(r.asks).toBe(2)
  })

  it('counts what the reader holds into the memory beside the heap', async () => {
    vi.spyOn(performance, 'now').mockImplementation(() => Date.now())
    ;(performance as unknown as { memory: unknown }).memory = {
      usedJSHeapSize: 50 << 20,
      jsHeapSizeLimit: 4096 << 20,
      totalJSHeapSize: 60 << 20,
    }
    try {
      const r = reader()
      const bar = new StatusBar({ client: () => r.client })
      bars.push(bar)
      bar.refresh()
      r.answer()
      await vi.advanceTimersByTimeAsync(1000)
      const memory = all<HTMLElement>(bar.el, '.status-key').find((node) => node.textContent === 'memory')
      const value = memory?.closest('.status-item')?.querySelector('.status-value')?.textContent ?? ''
      // 50 MiB of heap and 20 MiB the reader holds.
      expect(value).toBe('73.4 MB')
      expect(bar.el.querySelector('#status-memory-pop')?.textContent).toContain('reader: HDF5 and its cache')
    } finally {
      delete (performance as unknown as { memory?: unknown }).memory
    }
  })
})
