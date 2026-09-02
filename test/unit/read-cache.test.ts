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

  /**
   * Settle every outstanding `cancel` as a cancellation error.
   *
   * Deliberately *not* a model of the real worker, which cancels cooperatively:
   * `annotations.worker.ts` marks the id and the running handler notices at its
   * next `stillWanted` check, so a request that has already posted its result
   * settles as a result and one that has not settles as `cancelled: true`. What
   * this reproduces is only the second half — enough to drive the `finally`
   * path, which is what these tests are about. The first half is covered
   * separately by the crossed-reply test below.
   */
  settleCancels(): void {
    for (const message of this.sent) {
      if (message.kind !== 'cancel') continue
      this.reply({
        type: 'error',
        id: message.target,
        message: 'cancelled',
        cancelled: true,
      } as AnnotationResponse)
    }
  }

  get reads(): AnnotationRequest[] {
    return this.sent.filter((message) => message.kind === 'reads')
  }

  get cancels(): number[] {
    return this.sent.flatMap((message) => (message.kind === 'cancel' ? [message.target] : []))
  }
}

/**
 * One contig, and a `windows` that honours the pad the way `LocusAxis` does.
 *
 * The pad matters: `ReadCache` fetches `windows(domain, FETCH_PAD)` and records
 * *that* as covered, then tests the unpadded view against it. A stub that
 * ignored the pad recorded the view as covered and made every pan look like a
 * miss — which is the opposite of the contract §2 states.
 */
const axis = {
  windows: (domain: readonly [number, number], pad = 0) => {
    const margin = (domain[1] - domain[0]) * pad
    return [{ contig: 'chrI', start: domain[0] - margin, end: domain[1] + margin }]
  },
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

/**
 * Let a settled request finish unwinding.
 *
 * `.then` → `.catch` → `.finally` is three microtasks, and the slot is released
 * in the last of them. Two ticks leaves a settled request still holding its
 * key, which is not a bug — the next frame merely cancels an id the worker has
 * already finished with — but it is noise a test should not be reading as
 * signal.
 */
async function flush(): Promise<void> {
  for (let i = 0; i < 4; i++) await Promise.resolve()
}

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
  await flush()
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

  it('asks again for every field the worker actually reads', async () => {
    const base = defaultReadStyle()
    for (const changed of [
      { ...base, colourBy: 'mate' as const },
      { ...base, minMapq: 30 },
      { ...base, hideDuplicates: true },
      { ...base, splits: true },
    ]) {
      const sent = await askTwice(changed)
      expect(sent, JSON.stringify(changed)).toHaveLength(2)
      expect(sent[1].kind === 'reads' ? sent[1].reads : null).toEqual(changed)
    }
  })

  it('does not refetch for the fields the worker never reads', async () => {
    // The layout decides how the renderer packs and joins columns the pile
    // already carries. The reply is byte-identical either way, so spending a
    // window of BGZF decoding on it would buy nothing at all.
    expect(await askTwice({ ...defaultReadStyle(), layout: 'fragments' })).toHaveLength(1)
    expect(await askTwice({ ...defaultReadStyle(), layout: 'reads' })).toHaveLength(1)
  })

  it('does not re-issue on every frame while a new style is still decoding', async () => {
    // The failure this pins is a starvation loop, and it is invisible: the lane
    // keeps drawing, one style behind. `Held.style` is what last *landed*, so a
    // guard written against it is permanently unequal to the new style between
    // the control change and the first landing — and a pointer moving over the
    // canvas schedules a frame each time, so every frame cancelled the request
    // the frame before had issued. On a real BAM the new pile never arrives.
    const { worker, cache } = readsOn()
    const options = { entry: 'a', scope: 'browser', axis, domain, rows: 24, basesPerPixel: 1 }
    cache.readsFor({ ...options, style: defaultReadStyle() })
    worker.settle(EMPTY_READS)
    await flush()

    const changed = { ...defaultReadStyle(), colourBy: 'mate' as const }
    for (let frame = 0; frame < 20; frame++) {
      cache.readsFor({ ...options, style: changed })
      worker.settleCancels()
      await Promise.resolve()
    }
    // One for the first window, one for the change, and nothing for the other
    // nineteen frames.
    expect(worker.reads).toHaveLength(2)
    expect(worker.cancels).toHaveLength(0)
  })

  it('replaces a request whose style nobody is waiting for, even before one has landed', async () => {
    // The mirror image, and the case the code exists for: a reader working the
    // control faster than the first window comes back. Nothing has landed, so a
    // guard written against the held window would leave the stale decode in
    // place — and this worker has no queue, so it holds up every other lane.
    const { worker, cache } = readsOn()
    const options = { entry: 'a', scope: 'browser', axis, domain, rows: 24, basesPerPixel: 1 }
    cache.readsFor({ ...options, style: defaultReadStyle() })
    const stale = worker.sent[0].id
    cache.readsFor({ ...options, style: { ...defaultReadStyle(), colourBy: 'mate' } })
    expect(worker.cancels).toContain(stale)
    expect(worker.reads).toHaveLength(2)
  })

  it('keeps the replacement in flight when the cancelled one finally settles', async () => {
    // Two requests share a key for as long as it takes a cancelled one to
    // reject. A `finally` that deletes by key alone removes the *replacement's*
    // entry, and the next frame then issues a third without even cancelling —
    // which is how one control change became twenty decodes.
    const { worker, cache } = readsOn()
    const options = { entry: 'a', scope: 'browser', axis, domain, rows: 24, basesPerPixel: 1 }
    cache.readsFor({ ...options, style: defaultReadStyle() })
    const changed = { ...defaultReadStyle(), colourBy: 'mate' as const }
    cache.readsFor({ ...options, style: changed })
    worker.settleCancels()
    await flush()

    cache.readsFor({ ...options, style: changed })
    expect(worker.reads).toHaveLength(2)
  })

  it('throws away an answer that arrived after it was superseded', async () => {
    // A cancel and a reply can cross: the worker posts, the cancel is sent, and
    // the reply lands anyway. Storing it would file the old style's window under
    // the new key, and the lane would draw it until the view moved.
    const { worker, cache } = readsOn()
    const options = { entry: 'a', scope: 'browser', axis, domain, rows: 24, basesPerPixel: 1 }
    cache.readsFor({ ...options, style: defaultReadStyle() })
    const first = worker.sent[0]
    const changed = { ...defaultReadStyle(), colourBy: 'mate' as const }
    cache.readsFor({ ...options, style: changed })
    // The superseded request answers anyway.
    worker.reply({ type: 'result', id: first.id, payload: EMPTY_READS } as AnnotationResponse)
    await flush()

    // The distinguishing observation is what the cache now *holds*: with the
    // guard nothing was stored, so `peek` is null and the next frame is still
    // waiting. Without it the superseded window is filed under the new style and
    // handed straight back — and asserting only the request count cannot see
    // that, because the second request is in flight either way.
    expect(cache.peek('a', 'browser')).toBeNull()
    expect(cache.readsFor({ ...options, style: changed })).toBeNull()
    expect(worker.reads).toHaveLength(2)
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
    await flush()

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

describe('zooming inside the window already in hand', () => {
  // The pile is *thinned* in the worker against the row budget, over the window
  // that was fetched — three view-widths. So a window fetched for a wide view
  // holds about a third of a narrow view's reads, and answering a zoom from it
  // draws a third of the pile while the caption reports the wide window's
  // numbers. Measured on a uniform 20x pile: 103 kept of 581, of which 29 fall
  // in the visible middle third, against 106 for a fetch scoped to that third.
  const spanning = (from: number, to: number) => ({
    entry: 'a',
    scope: 'browser',
    axis,
    domain: [from, to] as readonly [number, number],
    rows: 24,
    basesPerPixel: 1,
    style: defaultReadStyle(),
  })

  it('refetches when the view has zoomed by an octave', async () => {
    const { worker, cache } = readsOn()
    cache.readsFor(spanning(0, 8000))
    worker.settle(EMPTY_READS)
    await flush()
    // Well inside what was fetched, so `covers` passes — and the old rule
    // stopped there.
    cache.readsFor(spanning(3000, 4000))
    expect(worker.reads).toHaveLength(2)
  })

  it('does not refetch for a pan, however far it goes inside the pad', async () => {
    // §2: a pan performs no read. The bucket is over the span, so it cannot
    // change when only the position does.
    const { worker, cache } = readsOn()
    cache.readsFor(spanning(0, 8000))
    worker.settle(EMPTY_READS)
    await flush()
    cache.readsFor(spanning(1000, 9000))
    cache.readsFor(spanning(2000, 10_000))
    expect(worker.reads).toHaveLength(1)
  })

  it('does not refetch for a zoom too small to change the thinning', async () => {
    // Bounded refetches on a continuous zoom: one per halving, not one per
    // frame. A ten per cent nudge stays in the same octave.
    const { worker, cache } = readsOn()
    cache.readsFor(spanning(0, 8000))
    worker.settle(EMPTY_READS)
    await flush()
    cache.readsFor(spanning(0, 7600))
    expect(worker.reads).toHaveLength(1)
  })
})

describe('letting go of a lane', () => {
  // `prune` and `destroy` were written, documented and never called from
  // anywhere — the view reconciled its two other caches every frame and not
  // this one. A BAM removed mid-decode left the worker inflating BGZF blocks
  // for a lane that no longer existed, in front of every other lane's `sample`,
  // and left the largest payload this worker sends alive for the life of the
  // tab. These pin the behaviour; `BrowserView.draw`/`destroy` are what call it.
  it('cancels a decode nobody is waiting for any more', () => {
    const { worker, cache } = readsOn()
    cache.readsFor({
      entry: 'a',
      scope: 'browser',
      axis,
      domain,
      rows: 24,
      basesPerPixel: 1,
      style: defaultReadStyle(),
    })
    const asked = worker.sent[0].id
    cache.prune(new Set())
    expect(worker.cancels).toContain(asked)
  })

  it('leaves a decode alone while its lane is still there', () => {
    const { worker, cache } = readsOn()
    cache.readsFor({
      entry: 'a',
      scope: 'browser',
      axis,
      domain,
      rows: 24,
      basesPerPixel: 1,
      style: defaultReadStyle(),
    })
    cache.prune(new Set(['a']))
    expect(worker.cancels).toHaveLength(0)
  })

  it('drops the window it was holding, so the reads do not outlive the lane', async () => {
    const { worker, cache } = readsOn()
    const options = { entry: 'a', scope: 'browser', axis, domain, rows: 24, basesPerPixel: 1 }
    cache.readsFor({ ...options, style: defaultReadStyle() })
    worker.settle(EMPTY_READS)
    await flush()
    expect(cache.peek('a', 'browser')).not.toBeNull()
    cache.prune(new Set())
    expect(cache.peek('a', 'browser')).toBeNull()
  })

  it('calls off everything when the view goes away', () => {
    const { worker, cache } = readsOn()
    cache.readsFor({
      entry: 'a',
      scope: 'browser',
      axis,
      domain,
      rows: 24,
      basesPerPixel: 1,
      style: defaultReadStyle(),
    })
    const asked = worker.sent[0].id
    cache.destroy()
    expect(worker.cancels).toContain(asked)
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
    await flush()
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
    expect(await coverageTwice({ ...base, layout: 'reads' })).toHaveLength(1)
    // Splits are drawn and never counted, so they cannot reach a depth curve.
    expect(await coverageTwice({ ...base, splits: true })).toHaveLength(1)
  })

  it('does not re-issue on every frame while a new filter is still counting', async () => {
    // The same starvation loop as the pile's, over the most expensive read in
    // the application: a whole-genome coverage scan, cancelled and reissued
    // once per pointer move.
    const worker = new FakeWorker()
    const cache = new SampleCache(
      new AnnotationClient(() => worker as unknown as Worker),
      () => undefined,
    )
    const options = { entry: 'a', scope: 'browser', axis, domain, pixels: 100 }
    cache.samplesFor({ ...options, reads: defaultReadStyle() })
    worker.settle(EMPTY_SAMPLES)
    await flush()

    const floored = { ...defaultReadStyle(), minMapq: 30 }
    for (let frame = 0; frame < 20; frame++) {
      cache.samplesFor({ ...options, reads: floored })
      worker.settleCancels()
      await Promise.resolve()
    }
    expect(worker.sent.filter((m) => m.kind === 'sample')).toHaveLength(2)
    expect(worker.cancels).toHaveLength(0)
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
    await flush()
    cache.samplesFor(options)
    const sent = worker.sent.filter((message) => message.kind === 'sample')
    expect(sent).toHaveLength(1)
    expect(sent[0].kind === 'sample' ? 'reads' in sent[0] : true).toBe(false)
  })
})
