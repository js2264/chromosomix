/**
 * Calling off an annotation request.
 *
 * This worker went without cancellation deliberately, and `client.ts` recorded
 * why: the longest request was a third of a second, and the shortest was the
 * one a pan would cancel a hundred of. Alignments end that argument. A window
 * of records is tens of BGZF blocks to inflate before the first record is
 * decoded — measured at 40–110 ms for eight megabytes, before any decoding —
 * and this thread has no queue, so one slow decode delays every other lane's
 * `sample` behind it.
 *
 * What matters is the correlation: a `cancel` names the id of the request it
 * stops, and getting that wrong is silent — it would cancel a *different* lane's
 * read, or nothing at all, and in both cases the picture is merely late.
 */

import { describe, expect, it, vi } from 'vitest'

import { AnnotationClient, isCancellation } from '@/annotations/worker/client'
import { SampleCache } from '@/annotations/samples'
import type { AnnotationRequest, AnnotationResponse } from '@/annotations/worker/protocol'
import type { LocusAxis } from '@/render/locus'

/** A worker that records what it was sent and answers only when told to. */
class FakeWorker {
  onmessage: ((event: MessageEvent<AnnotationResponse>) => void) | null = null
  onerror: ((event: { message: string }) => void) | null = null
  readonly sent: AnnotationRequest[] = []
  terminated = false

  postMessage(message: AnnotationRequest): void {
    this.sent.push(message)
  }

  terminate(): void {
    this.terminated = true
  }

  /** Answer one request, as the real worker would. */
  reply(response: AnnotationResponse): void {
    this.onmessage?.({ data: response } as MessageEvent<AnnotationResponse>)
  }
}

function clientOn(): { client: AnnotationClient; worker: FakeWorker } {
  const worker = new FakeWorker()
  const client = new AnnotationClient(() => worker as unknown as Worker)
  return { client, worker }
}

describe('cancelling a request', () => {
  it('names the id of the request it is cancelling', () => {
    const { client, worker } = clientOn()
    const first = client.cancellable<'sample'>({
      kind: 'sample',
      entry: 'a',
      regions: [],
      basesPerPixel: 1,
    })
    void first.promise.catch(() => {})
    const asked = worker.sent[0]
    first.cancel()

    const cancel = worker.sent[1]
    expect(cancel.kind).toBe('cancel')
    expect(cancel.kind === 'cancel' ? cancel.target : -1).toBe(asked.id)
  })

  it('cancels the right one when several are in flight', () => {
    // The failure this pins is silent: a cancel naming the wrong id stops
    // another lane's read, and both lanes are merely late.
    const { client, worker } = clientOn()
    const requests = ['a', 'b', 'c'].map((entry) =>
      client.cancellable<'sample'>({ kind: 'sample', entry, regions: [], basesPerPixel: 1 }),
    )
    for (const request of requests) void request.promise.catch(() => {})
    const ids = worker.sent.map((message) => message.id)

    requests[1].cancel()
    const cancel = worker.sent[worker.sent.length - 1]
    expect(cancel.kind === 'cancel' ? cancel.target : -1).toBe(ids[1])
  })

  it('does not start a worker just to tell it to stop', () => {
    // The case is a lane cancelling on its way out: the tab closed, the client
    // was torn down, and the cancel arrives after. Spawning a thread in order
    // to tell it to stop would be a module graph downloaded and parsed for
    // nothing.
    const factory = vi.fn(() => new FakeWorker() as unknown as Worker)
    const client = new AnnotationClient(factory)
    const request = client.cancellable<'sample'>({
      kind: 'sample',
      entry: 'a',
      regions: [],
      basesPerPixel: 1,
    })
    void request.promise.catch(() => {})
    expect(factory).toHaveBeenCalledTimes(1)

    client.destroy()
    request.cancel()
    expect(factory).toHaveBeenCalledTimes(1)
  })
})

describe('what a cancelled request settles as', () => {
  it('rejects as a cancellation rather than as a failure', async () => {
    const { client, worker } = clientOn()
    const request = client.cancellable<'sample'>({
      kind: 'sample',
      entry: 'a',
      regions: [],
      basesPerPixel: 1,
    })
    worker.reply({ type: 'error', id: worker.sent[0].id, message: 'cancelled', cancelled: true })

    await expect(request.promise).rejects.toThrow('cancelled')
    await request.promise.catch((err: unknown) => {
      expect(isCancellation(err)).toBe(true)
    })
  })

  it('leaves a real failure looking like one', async () => {
    // A lane drops a cancellation silently and reports a failure, so the two
    // must not be told apart by the message text.
    const { client, worker } = clientOn()
    const request = client.cancellable<'sample'>({
      kind: 'sample',
      entry: 'a',
      regions: [],
      basesPerPixel: 1,
    })
    worker.reply({ type: 'error', id: worker.sent[0].id, message: 'cancelled' })

    await request.promise.catch((err: unknown) => {
      expect(isCancellation(err)).toBe(false)
    })
  })

  it('still resolves normally when the answer arrives first', async () => {
    const { client, worker } = clientOn()
    const request = client.cancellable<'sample'>({
      kind: 'sample',
      entry: 'a',
      regions: [],
      basesPerPixel: 1,
    })
    worker.reply({
      type: 'result',
      id: worker.sent[0].id,
      payload: { basesPerPixel: 1, regions: [], extent: null },
    })
    await expect(request.promise).resolves.toMatchObject({ basesPerPixel: 1 })
  })
})

describe('who actually calls it off', () => {
  /** A one-contig axis, which is all `samplesFor` needs to ask for a window. */
  const axis = {
    windows: (domain: readonly [number, number]) => [
      { contig: 'chrI', start: domain[0], end: domain[1] },
    ],
    segmentOf: () => null,
  } as unknown as LocusAxis

  function asking(): { worker: FakeWorker; cache: SampleCache } {
    const worker = new FakeWorker()
    const cache = new SampleCache(
      new AnnotationClient(() => worker as unknown as Worker),
      () => undefined,
    )
    cache.samplesFor({ entry: 'a', scope: 'browser', axis, domain: [0, 1000], pixels: 100 })
    return { worker, cache }
  }

  const cancelsIn = (worker: FakeWorker): number[] =>
    worker.sent.filter((m) => m.kind === 'cancel').map((m) => (m.kind === 'cancel' ? m.target : -1))

  it('calls off a read whose track has been dropped', () => {
    // The case worth having: a lane removed while its first window is still
    // decoding has nothing cached, so the read is being done for nobody — and
    // this worker has no queue, so it holds up every other lane behind it.
    const { worker, cache } = asking()
    const asked = worker.sent[0].id
    cache.prune(new Set())
    expect(cancelsIn(worker)).toContain(asked)
  })

  it('leaves a read alone while its track is still there', () => {
    const { worker, cache } = asking()
    cache.prune(new Set(['a']))
    expect(cancelsIn(worker)).toHaveLength(0)
  })

  it('calls off everything when the view goes away', () => {
    const { worker, cache } = asking()
    const asked = worker.sent[0].id
    cache.destroy()
    expect(cancelsIn(worker)).toContain(asked)
  })
})
