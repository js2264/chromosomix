/**
 * When a change to an alignment lane's controls has to go back to the worker.
 *
 * The two caches here are keyed on a window and a resolution, which is the
 * right key for every other kind: a bigWig's samples over a window are the
 * same numbers however the lane is drawn. An alignment lane breaks that. Its
 * controls change what is *counted* and how the pile is *packed*, so a cache
 * that ignored them would leave a reader's click doing nothing at all until
 * they happened to pan.
 *
 * The other half is as important and pulls the opposite way: a refetch of a
 * whole-genome coverage scan is the most expensive read in this application,
 * and it must not be triggered by a change that cannot move the line by a
 * pixel. So the coverage cache watches a deliberately narrower key than the
 * pile cache does — see `readFilterKey` against `readStyleKey`.
 */

import { describe, expect, it } from 'vitest'

import { AnnotationClient } from '@/annotations/worker/client'
import { ReadCache } from '@/annotations/reads'
import { SampleCache } from '@/annotations/samples'
import { defaultReadStyle, type ReadStyle } from '@/annotations/types'
import type { AnnotationRequest, AnnotationResponse } from '@/annotations/worker/protocol'
import type { LocusAxis } from '@/render/locus'

class FakeWorker {
  onmessage: ((event: MessageEvent<AnnotationResponse>) => void) | null = null
  onerror: ((event: { message: string }) => void) | null = null
  readonly sent: AnnotationRequest[] = []

  postMessage(message: AnnotationRequest): void {
    this.sent.push(message)
  }

  terminate(): void {}

  reply(response: AnnotationResponse): void {
    this.onmessage?.({ data: response } as MessageEvent<AnnotationResponse>)
  }

  /** Answer whatever is outstanding with an empty payload of the right shape. */
  settle(payload: unknown): void {
    for (const message of this.sent) {
      if (message.kind === 'cancel' || message.kind === 'drop') continue
      this.reply({ type: 'result', id: message.id, payload } as AnnotationResponse)
    }
  }
}

const axis = {
  windows: (domain: readonly [number, number]) => [
    { contig: 'chrI', start: domain[0], end: domain[1] },
  ],
  segmentOf: () => null,
} as unknown as LocusAxis

const EMPTY_READS = {
  piles: [],
  bases: [],
  total: 0,
  kept: 0,
  capped: false,
  rows: 0,
  diffs: 'none',
}

const EMPTY_SAMPLES = { basesPerPixel: 1, regions: [], extent: null }

const domain: readonly [number, number] = [0, 1000]

function readsOn(): { worker: FakeWorker; cache: ReadCache } {
  const worker = new FakeWorker()
  const cache = new ReadCache(
    new AnnotationClient(() => worker as unknown as Worker),
    () => undefined,
  )
  return { worker, cache }
}

/** Ask once, let the answer land, then ask again with `style`. */
async function askTwice(style: ReadStyle): Promise<AnnotationRequest[]> {
  const { worker, cache } = readsOn()
  const options = { entry: 'a', scope: 'browser', axis, domain, rows: 24, basesPerPixel: 1 }
  cache.readsFor({ ...options, style: defaultReadStyle() })
  worker.settle(EMPTY_READS)
  await Promise.resolve()
  await Promise.resolve()
  cache.readsFor({ ...options, style })
  return worker.sent.filter((message) => message.kind === 'reads')
}

describe('the pile', () => {
  it('carries the lane’s controls on the request, rather than configuring the worker', () => {
    // The alternative — a `configure` message setting state per entry — makes a
    // reply depend on the order two messages arrived in, and leaves the cache
    // keyed on nothing that changed. A request states in full what it asks.
    const { worker, cache } = readsOn()
    const style = { ...defaultReadStyle(), colourBy: 'insert' as const, minMapq: 30 }
    cache.readsFor({ entry: 'a', scope: 'browser', axis, domain, rows: 24, basesPerPixel: 1, style })
    const asked = worker.sent[0]
    expect(asked.kind).toBe('reads')
    expect(asked.kind === 'reads' ? asked.reads : null).toEqual(style)
  })

  it('does not ask twice for the same window under the same controls', async () => {
    expect(await askTwice(defaultReadStyle())).toHaveLength(1)
  })

  it('asks again for every field of the style, because every one of them refetches', async () => {
    const base = defaultReadStyle()
    for (const changed of [
      { ...base, colourBy: 'mate' as const },
      { ...base, minMapq: 30 },
      { ...base, hideDuplicates: true },
      { ...base, pairs: false },
      { ...base, splits: true },
    ]) {
      const sent = await askTwice(changed)
      expect(sent, JSON.stringify(changed)).toHaveLength(2)
      expect(sent[1].kind === 'reads' ? sent[1].reads : null).toEqual(changed)
    }
  })

  it('replaces a request in flight rather than waiting behind it', async () => {
    // A reader working the control: settled on strand, switch to insert, then
    // to mate before the insert window has come back. What is decoding was
    // asked under controls nobody is looking at any more and its answer will be
    // discarded on arrival — so leaving it in place means the second click does
    // nothing at all until the reader moves the view.
    const { worker, cache } = readsOn()
    const options = { entry: 'a', scope: 'browser', axis, domain, rows: 24, basesPerPixel: 1 }
    cache.readsFor({ ...options, style: defaultReadStyle() })
    worker.settle(EMPTY_READS)
    await Promise.resolve()
    await Promise.resolve()

    cache.readsFor({ ...options, style: { ...defaultReadStyle(), colourBy: 'insert' } })
    const stale = worker.sent[worker.sent.length - 1].id
    cache.readsFor({ ...options, style: { ...defaultReadStyle(), colourBy: 'mate' } })

    expect(worker.sent.some((m) => m.kind === 'cancel' && m.target === stale)).toBe(true)
    const reads = worker.sent.filter((m) => m.kind === 'reads')
    expect(reads).toHaveLength(3)
    expect(reads[2].kind === 'reads' ? reads[2].reads.colourBy : null).toBe('mate')
  })

  it('waits behind a request that is still the right one', () => {
    // The ordinary case, and it must not be swept up by the rule above: a pan
    // asked for a wider window under the controls the lane still has, and its
    // answer is right — merely late.
    const { worker, cache } = readsOn()
    const options = { entry: 'a', scope: 'browser', axis, domain, rows: 24, basesPerPixel: 1 }
    cache.readsFor({ ...options, style: defaultReadStyle() })
    cache.readsFor({ ...options, style: defaultReadStyle() })
    expect(worker.sent.filter((m) => m.kind === 'reads')).toHaveLength(1)
    expect(worker.sent.some((m) => m.kind === 'cancel')).toBe(false)
  })
})

describe('the coverage beside it', () => {
  async function coverageTwice(reads: ReadStyle | undefined): Promise<AnnotationRequest[]> {
    const worker = new FakeWorker()
    const cache = new SampleCache(
      new AnnotationClient(() => worker as unknown as Worker),
      () => undefined,
    )
    const options = { entry: 'a', scope: 'browser', axis, domain, pixels: 100 }
    cache.samplesFor({ ...options, reads: defaultReadStyle() })
    worker.settle(EMPTY_SAMPLES)
    await Promise.resolve()
    await Promise.resolve()
    cache.samplesFor({ ...options, ...(reads === undefined ? {} : { reads }) })
    return worker.sent.filter((message) => message.kind === 'sample')
  }

  it('sends the controls, so a floor set in the browser reaches the depth', () => {
    const worker = new FakeWorker()
    const cache = new SampleCache(
      new AnnotationClient(() => worker as unknown as Worker),
      () => undefined,
    )
    const reads = { ...defaultReadStyle(), minMapq: 30 }
    cache.samplesFor({ entry: 'a', scope: 'browser', axis, domain, pixels: 100, reads })
    expect(worker.sent[0].kind === 'sample' ? worker.sent[0].reads : null).toEqual(reads)
  })

  it('recounts when the floor or the duplicate switch moves', async () => {
    const base = defaultReadStyle()
    expect(await coverageTwice({ ...base, minMapq: 30 })).toHaveLength(2)
    expect(await coverageTwice({ ...base, hideDuplicates: true })).toHaveLength(2)
  })

  it('does not recount for a change that cannot move the line', async () => {
    // The reason the two keys are different. A colouring is a palette and a
    // packing; the depth is a count, and a count does not care.
    const base = defaultReadStyle()
    expect(await coverageTwice({ ...base, colourBy: 'insert' })).toHaveLength(1)
    expect(await coverageTwice({ ...base, pairs: false })).toHaveLength(1)
    // Splits are drawn and never counted, so they cannot reach a depth curve.
    expect(await coverageTwice({ ...base, splits: true })).toHaveLength(1)
  })

  it('leaves every other kind of lane alone, which sends no controls at all', async () => {
    const worker = new FakeWorker()
    const cache = new SampleCache(
      new AnnotationClient(() => worker as unknown as Worker),
      () => undefined,
    )
    const options = { entry: 'bigwig', scope: 'browser', axis, domain, pixels: 100 }
    cache.samplesFor(options)
    worker.settle(EMPTY_SAMPLES)
    await Promise.resolve()
    await Promise.resolve()
    cache.samplesFor(options)
    const sent = worker.sent.filter((message) => message.kind === 'sample')
    expect(sent).toHaveLength(1)
    expect(sent[0].kind === 'sample' ? 'reads' in sent[0] : true).toBe(false)
  })
})
