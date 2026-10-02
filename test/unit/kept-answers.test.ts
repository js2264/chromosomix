/**
 * A place visited again is drawn from memory (§12, `worker/answers.ts`).
 *
 * Going back to a chromosome read a minute ago used to read it again — the
 * pixels decompressed, pooled and sent across a second time for an answer that
 * could not differ. The reader's answers are now kept on the page, by question
 * and by the map the worker holds, and these are the rules that keep that from
 * ever answering for a map the worker no longer holds:
 *
 * - the same question is asked of the worker once, and the second asker is
 *   handed the very object the first was;
 * - a question asked while the first is still being read waits for that read;
 * - a request that changes the map — a total drawn to, a cell set, a close, an
 *   open — files later answers under another name, and an answer asked before
 *   such a change and arriving after it is not kept;
 * - an `open` names its map, so a map opened again finds its answers, and two
 *   files of one name are two maps;
 * - a failure is never kept, and a failed open answers nothing from memory.
 */

import { describe, expect, it } from 'vitest'

import { AnswerCache, KeptAnswers, bytesOf, stableKey } from '@/worker/answers'
import { ReaderClient } from '@/worker/client'
import type { MatrixResult, WorkerRequest, WorkerResponse } from '@/worker/protocol'

class FakeWorker {
  onmessage: ((event: MessageEvent<WorkerResponse>) => void) | null = null
  onerror: ((event: { message: string }) => void) | null = null
  readonly sent: WorkerRequest[] = []

  postMessage(message: WorkerRequest): void {
    this.sent.push(message)
  }

  terminate(): void {}

  /** Answer the request sent `at`th, with `payload`. */
  answer(at: number, payload: unknown): void {
    const request = this.sent[at]
    this.onmessage?.({
      data: { type: 'result', id: request.id, kind: request.kind, payload },
    } as MessageEvent<WorkerResponse>)
  }

  refuse(at: number, message = 'no'): void {
    this.onmessage?.({
      data: { type: 'error', id: this.sent[at].id, error: { name: 'Error', message } },
    } as unknown as MessageEvent<WorkerResponse>)
  }

  /** Requests of `kind` the worker has been sent. */
  count(kind: WorkerRequest['kind']): number {
    return this.sent.filter((request) => request.kind === kind).length
  }
}

function reader(): { client: ReaderClient; worker: FakeWorker } {
  const worker = new FakeWorker()
  return { client: new ReaderClient(worker as unknown as Worker), worker }
}

function block(n = 4): MatrixResult {
  return {
    nrows: n,
    ncols: n,
    values: new Float32Array(n * n).fill(1),
    rowExtent: [0, n],
    colExtent: [0, n],
    rowGroups: [],
    colGroups: [],
    level: 'bin',
  }
}

const CHR1 = { kind: 'matrix' as const, rows: [0, 3910] as [number, number], balance: false }
const CHR2 = { kind: 'matrix' as const, rows: [3910, 7553] as [number, number], balance: false }
const MAP_A = { kind: 'open' as const, uri: 'https://host/a.mcool::/resolutions/10000', source: { kind: 'remote' as const, url: 'https://host/a.mcool' } }
const MAP_B = { kind: 'open' as const, uri: 'https://host/a.mcool::/resolutions/20000', source: { kind: 'remote' as const, url: 'https://host/a.mcool' } }

/** Let the promise callbacks queued by a reply run. */
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

async function opened(client: ReaderClient, worker: FakeWorker, map: typeof MAP_A): Promise<void> {
  const open = client.cancellable<'open'>(map)
  worker.answer(worker.sent.length - 1, {})
  await open.promise
}

describe('a question asked again (§12)', () => {
  it('is asked of the worker once, and answered with the same object', async () => {
    const { client, worker } = reader()
    const first = client.request<'matrix'>(CHR1)
    worker.answer(0, block())
    const chr1 = await first
    const second = client.request<'matrix'>(CHR2)
    worker.answer(1, block(3))
    await second
    // chr1 → chr2 → chr1: the third is the first, from memory.
    const again = await client.request<'matrix'>(CHR1)
    expect(again).toBe(chr1)
    expect(worker.count('matrix')).toBe(2)
  })

  it('is the same question whatever order its fields were written in', async () => {
    const { client, worker } = reader()
    const first = client.request<'range'>({ kind: 'range', range: 'chr1', rung: '20000' })
    worker.answer(0, { kind: 'contig', label: 'chr1', extent: [0, 9774] })
    await first
    await client.request<'range'>({ rung: '20000', range: 'chr1', kind: 'range' })
    expect(worker.count('range')).toBe(1)
  })

  it('is another question at another balancing, score, grid or rung', async () => {
    const { client, worker } = reader()
    const asks = [
      CHR1,
      { ...CHR1, balance: true },
      { ...CHR1, value: 'balanced' },
      { ...CHR1, binsPerCell: 5 },
      { ...CHR1, rung: '50000' },
    ]
    for (const [at, ask] of asks.entries()) {
      const read = client.request<'matrix'>(ask)
      worker.answer(at, block())
      await read
    }
    expect(worker.count('matrix')).toBe(asks.length)
  })

  it('waits for a read of it already on its way rather than starting a second', async () => {
    const { client, worker } = reader()
    const first = client.request<'matrix'>(CHR1)
    const second = client.request<'matrix'>(CHR1)
    expect(worker.count('matrix')).toBe(1)
    worker.answer(0, block())
    expect(await second).toBe(await first)
  })

  it('is asked again when the first asking failed', async () => {
    const { client, worker } = reader()
    const first = client.request<'matrix'>(CHR1)
    worker.refuse(0)
    await expect(first).rejects.toThrow('no')
    const second = client.request<'matrix'>(CHR1)
    worker.answer(1, block())
    await second
    expect(worker.count('matrix')).toBe(2)
  })

  it('is not joined to a read in flight when it can be called off, and costs nothing once kept', async () => {
    const { client, worker } = reader()
    const plain = client.request<'matrix'>(CHR1)
    const own = client.cancellable<'matrix'>(CHR1)
    // Calling this one off must not call off the read the first is waiting on.
    expect(worker.count('matrix')).toBe(2)
    worker.answer(0, block())
    worker.answer(1, block())
    await Promise.all([plain, own.promise])
    const kept = client.cancellable<'matrix'>(CHR1)
    kept.cancel()
    await kept.promise
    expect(worker.count('matrix')).toBe(2)
    expect(worker.count('cancel')).toBe(0)
  })

  it('is still asked, and answered, when it cannot be named', async () => {
    const { client, worker } = reader()
    // A BigInt has no JSON: the cache cannot key this, and must not be why it fails.
    const odd = { ...CHR1, odd: 1n } as unknown as typeof CHR1
    const first = client.request<'matrix'>(odd)
    worker.answer(0, block())
    await expect(first).resolves.toBeDefined()
    const second = client.request<'matrix'>(odd)
    worker.answer(1, block())
    await second
    expect(worker.count('matrix')).toBe(2)
  })

  it('does not change what is kept when the request changes nothing', async () => {
    const { client, worker } = reader()
    const first = client.request<'matrix'>(CHR1)
    worker.answer(0, block())
    await first
    void client.request<'stats'>({ kind: 'stats' })
    void client.request<'contigs'>({ kind: 'contigs' })
    await client.request<'matrix'>(CHR1)
    expect(worker.count('matrix')).toBe(1)
  })
})

describe('the map the answers are about', () => {
  it('is another map once it is drawn to a total, and an answer from before is not kept', async () => {
    const { client, worker } = reader()
    const first = client.request<'matrix'>(CHR1)
    worker.answer(0, block())
    await first
    // Asked, then the map changes under it, then answered.
    const late = client.request<'matrix'>(CHR2)
    void client.request<'resample'>({ kind: 'resample', contacts: 1e6 })
    worker.answer(1, block(3))
    await late
    const chr1 = client.request<'matrix'>(CHR1)
    const chr2 = client.request<'matrix'>(CHR2)
    expect(worker.count('matrix')).toBe(4)
    worker.answer(3, block())
    worker.answer(4, block(3))
    await Promise.all([chr1, chr2])
  })

  it('does not take an answer asked before a change, even when the map is opened again before it lands', async () => {
    const { client, worker } = reader()
    await opened(client, worker, MAP_A)
    // Asked of the map as opened; the worker may read part of it after the
    // resample below, so what comes back is not a picture of the map as opened.
    const asked = client.request<'matrix'>(CHR1)
    void client.request<'resample'>({ kind: 'resample', contacts: 1e6 })
    await opened(client, worker, MAP_A)
    worker.answer(1, block())
    await asked
    void client.request<'matrix'>(CHR1)
    expect(worker.count('matrix')).toBe(2)
  })

  it('is another map for another cell set', async () => {
    const { client, worker } = reader()
    const first = client.request<'matrix'>(CHR1)
    worker.answer(0, block())
    await first
    void client.request<'selectCells'>({ kind: 'selectCells', names: ['cell_1'] })
    void client.request<'matrix'>(CHR1)
    expect(worker.count('matrix')).toBe(2)
  })

  it('is named by its open, so a resolution left and come back to finds its answers', async () => {
    const { client, worker } = reader()
    await opened(client, worker, MAP_A)
    const atA = client.request<'matrix'>(CHR1)
    worker.answer(1, block())
    const fromA = await atA
    await opened(client, worker, MAP_B)
    const atB = client.request<'matrix'>(CHR1)
    expect(worker.count('matrix')).toBe(2)
    worker.answer(3, block())
    expect(await atB).not.toBe(fromA)
    await opened(client, worker, MAP_A)
    expect(await client.request<'matrix'>(CHR1)).toBe(fromA)
    expect(worker.count('matrix')).toBe(2)
  })

  it('answers nothing from memory after an open that failed', async () => {
    const { client, worker } = reader()
    await opened(client, worker, MAP_A)
    const atA = client.request<'matrix'>(CHR1)
    worker.answer(1, block())
    await atA
    // The same map asked for again and refused: the worker holds nothing now.
    const again = client.cancellable<'open'>(MAP_A)
    worker.refuse(2)
    await expect(again.promise).rejects.toThrow()
    await settle()
    void client.request<'matrix'>(CHR1)
    expect(worker.count('matrix')).toBe(2)
  })

  it('is two maps for two files of one name', async () => {
    const { client, worker } = reader()
    const local = (bytes: string): typeof MAP_A =>
      ({ kind: 'open', uri: 'sample.mcool::/resolutions/10000', source: { kind: 'local', file: new File([bytes], 'sample.mcool') } }) as unknown as typeof MAP_A
    await opened(client, worker, local('one'))
    const first = client.request<'matrix'>(CHR1)
    worker.answer(1, block())
    await first
    await opened(client, worker, local('two'))
    void client.request<'matrix'>(CHR1)
    expect(worker.count('matrix')).toBe(2)
  })

  it('is not trusted at all after a request nobody has classified', async () => {
    const { client, worker } = reader()
    await opened(client, worker, MAP_A)
    const first = client.request<'matrix'>(CHR1)
    worker.answer(1, block())
    await first
    void client.request({ kind: 'somethingNew' } as never)
    await opened(client, worker, MAP_A)
    void client.request<'matrix'>(CHR1)
    expect(worker.count('matrix')).toBe(2)
  })
})

describe('what the status bar says the last view cost (§12)', () => {
  const COUNTED = { total: { requests: 30, bytes: 7e7 }, lastOp: { requests: 9, bytes: 2.1e7 }, calls: 40 }

  async function stats(client: ReaderClient, worker: FakeWorker): Promise<unknown> {
    const asked = client.request<'stats'>({ kind: 'stats' })
    worker.answer(worker.sent.length - 1, COUNTED)
    return asked
  }

  it('is nothing for a view answered from memory, and the worker’s own figure otherwise', async () => {
    const { client, worker } = reader()
    const first = client.request<'matrix'>(CHR1)
    worker.answer(0, block())
    await first
    expect(await stats(client, worker)).toEqual(COUNTED)
    await client.request<'matrix'>(CHR1)
    expect(await stats(client, worker)).toEqual({ ...COUNTED, lastOp: { requests: 0, bytes: 0 } })
    // A range is not a view, and does not move the figure either way.
    const range = client.request<'range'>({ kind: 'range', range: 'chr2' })
    worker.answer(worker.sent.length - 1, { kind: 'contig', label: 'chr2', extent: [3910, 7553] })
    await range
    expect(await stats(client, worker)).toEqual({ ...COUNTED, lastOp: { requests: 0, bytes: 0 } })
    const read = client.request<'matrix'>(CHR2)
    worker.answer(worker.sent.length - 1, block(3))
    await read
    expect(await stats(client, worker)).toEqual(COUNTED)
  })

  it('is the read waited on, for a view that joined one in flight', async () => {
    const { client, worker } = reader()
    const first = client.request<'matrix'>(CHR1)
    worker.answer(0, block())
    await first
    await client.request<'matrix'>(CHR1)
    const read = client.request<'matrix'>(CHR2)
    const joined = client.request<'matrix'>(CHR2)
    worker.answer(1, block(3))
    await Promise.all([read, joined])
    expect(await stats(client, worker)).toEqual(COUNTED)
  })
})

describe('what the answers cost', () => {
  it('is bounded, least recently used out first, and an answer larger than the whole is not kept', () => {
    const store = new KeptAnswers(() => 3 * bytesOf(block(64)))
    store.put('a', block(64), 1)
    store.put('b', block(64), 1)
    store.get('a')
    store.put('c', block(64), 1)
    store.put('d', block(64), 1)
    expect(store.get('a')).toBeDefined()
    expect(store.get('b')).toBeUndefined()
    store.put('huge', block(256), 1)
    expect(store.get('huge')).toBeUndefined()
    expect(store.bytes).toBeLessThanOrEqual(3 * bytesOf(block(64)))
  })

  it('counts a picture twice, for the pooled display kept beside it', () => {
    const picture = block(100)
    expect(bytesOf(picture)).toBeGreaterThanOrEqual(2 * picture.values.byteLength)
    expect(bytesOf({ kind: 'contig', label: 'chr1', extent: [0, 10] })).toBeLessThan(1024)
  })

  it('is given back when the reader is put down', async () => {
    const store = new KeptAnswers()
    const cache = new AnswerCache(store)
    await cache.track(CHR1, Promise.resolve(block()), true)
    expect(store.size).toBe(1)
    cache.clear()
    expect(store.size).toBe(0)
  })

  it('keys a request without its id, its scheduling or its credential', () => {
    expect(stableKey({ id: 4, kind: 'matrix', rows: [0, 1], background: true })).toBe(
      stableKey({ kind: 'matrix', rows: [0, 1] }),
    )
    expect(
      stableKey({ kind: 'open', uri: 'u', source: { kind: 'remote', url: 'u', credential: { a: 1 }, headers: { b: '2' } } }),
    ).toBe(stableKey({ kind: 'open', uri: 'u', source: { kind: 'remote', url: 'u' } }))
  })
})
