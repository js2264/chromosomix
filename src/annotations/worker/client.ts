/**
 * Main-thread half of the annotations protocol.
 *
 * The same thin correlator the reader client is. It used to be that minus
 * cancellation, on the grounds that the longest request here was a third of a
 * second and the shortest was the one a pan would cancel a hundred of. That
 * held for as long as every answer came from a parsed table or a bigWig's own
 * zoom levels, and alignments ended it: a window of records is tens of BGZF
 * blocks to inflate before the first record is decoded, and this thread has no
 * queue — `onmessage` fires each handler directly — so one slow decode delays
 * every other lane's `sample` behind it.
 *
 * The worker is created lazily. Most sessions open a map and never drop an
 * annotation on it, and a worker started at page load is a module graph
 * downloaded, parsed and thrown away for those.
 */

import { registerThread, type ThreadHandle } from '../../perf/threads'
import { withCredential } from '../../s3/attach'
import { spawnAnnotationsWorker } from '../../worker/spawn'
import type {
  AnnotationRequest,
  AnnotationRequestKind,
  AnnotationRequestOf,
  AnnotationResponse,
  AnnotationResultMap,
} from './protocol'

interface Pending {
  resolve(value: unknown): void
  reject(reason: unknown): void
  /** Only an analysis task reports; every other request is over too fast. */
  onProgress?: (done: number, total: number, note?: string) => void
}

export class AnnotationClient {
  private worker: Worker | null = null
  private readonly pending = new Map<number, Pending>()
  private nextId = 1
  /** This worker's line in the status bar's CPU figure, once it exists. */
  private thread: ThreadHandle | null = null

  constructor(private readonly factory: () => Worker = defaultWorker) {}

  private ensure(): Worker {
    if (this.worker !== null) return this.worker
    const worker = this.factory()
    worker.onmessage = (event: MessageEvent<AnnotationResponse>) => this.receive(event.data)
    worker.onerror = (event) =>
      this.failAll(new Error(`annotations worker failed: ${event.message}`))
    this.worker = worker
    // Registered here rather than in the constructor, because the worker is
    // created lazily: a session that never loads a track has no annotations
    // thread, and listing one in the CPU tooltip would be inventing it.
    this.thread = registerThread('annotations')
    return worker
  }

  private receive(response: AnnotationResponse): void {
    // Before the correlation, because it answers no request and carries no id.
    if (response.type === 'busy') {
      this.thread?.report(response.fraction)
      return
    }
    const entry = this.pending.get(response.id)
    if (entry === undefined) return
    // Progress does not settle the promise — it is a report on a request still
    // running, and only an analysis task sends one (§18.3). Handled before the
    // delete below, which every other response performs.
    if (response.type === 'progress') {
      entry.onProgress?.(response.done, response.total, response.note)
      return
    }
    this.pending.delete(response.id)
    if (response.type === 'error') entry.reject(errorFor(response))
    else entry.resolve(response.payload)
  }

  private failAll(error: Error): void {
    for (const entry of this.pending.values()) entry.reject(error)
    this.pending.clear()
  }

  request<K extends AnnotationRequestKind>(
    payload: AnnotationRequestOf<K>,
    onProgress?: (done: number, total: number, note?: string) => void,
  ): Promise<AnnotationResultMap[K]> {
    const worker = this.ensure()
    const id = this.nextId++
    // Through `unknown`: the union's members no longer share a field — only
    // three of the four name an `entry`, since asking what genome a file is on
    // is a question about a file nothing has opened yet — so TypeScript can no
    // longer see the spread as any one member of it. The discriminant is
    // `payload.kind`, which `AnnotationRequestOf<K>` has already pinned.
    // Stamped with a bucket key here, for the reasons in `s3/attach.ts` — the
    // same boundary treatment the reader worker's client gives its own
    // messages, so a private bigWig and a private cooler need the same nothing
    // of their callers.
    const message = withCredential({ ...payload, id }) as unknown as AnnotationRequest
    return new Promise<AnnotationResultMap[K]>((resolve, reject) => {
      this.pending.set(id, {
        resolve: resolve as (value: unknown) => void,
        reject,
        ...(onProgress === undefined ? {} : { onProgress }),
      })
      worker.postMessage(message)
    })
  }

  /**
   * Issue a request that can be called off.
   *
   * Cooperative, exactly as the reader client's is: the worker checks between
   * units of work, so the read stops at the next boundary rather than being
   * killed mid-write. A cancelled request still settles — it rejects with an
   * `AbortError`, which {@link isCancellation} answers for, so a caller that has
   * moved on drops it silently rather than reporting a failure the reader
   * caused by panning.
   */
  cancellable<K extends AnnotationRequestKind>(
    payload: AnnotationRequestOf<K>,
    onProgress?: (done: number, total: number, note?: string) => void,
  ): { promise: Promise<AnnotationResultMap[K]>; cancel: () => void } {
    // Read before `request` spends it, which is the whole of the correlation:
    // the id the worker will see is the one this cancel has to name.
    const id = this.nextId
    const promise = this.request<K>(payload, onProgress)
    return {
      promise,
      cancel: () => {
        // Only where the worker exists. A cancel that spawned one would start a
        // thread in order to tell it to stop.
        if (this.worker === null) return
        void this.request<'cancel'>({ kind: 'cancel', target: id }).catch(() => {})
      },
    }
  }

  /**
   * Forget one entry's open handle. Fire and forget: a failure here leaks a
   * filehandle in a worker that is about to be told about it again anyway, and
   * an unhandled rejection would be the louder bug.
   */
  drop(entry: string): void {
    if (this.worker === null) return
    void this.request<'drop'>({ kind: 'drop', entry }).catch(() => {})
  }

  /** Tear the worker down. The next request starts a fresh one. */
  destroy(): void {
    this.failAll(new Error('annotations worker closed'))
    this.worker?.terminate()
    this.worker = null
    this.thread?.release()
    this.thread = null
  }
}

/** Constructed through `worker/spawn.ts` — see there for why the standalone
 * build needs a different construction, and only that. */
function defaultWorker(): Worker {
  return spawnAnnotationsWorker()
}

/**
 * The rejection for an error response, named so a cancellation reads as one.
 *
 * `AbortError` rather than a flag on the error, because that is the name every
 * other cancellation in this codebase uses and `isCancellation` is already
 * written against it.
 */
function errorFor(response: { message: string; cancelled?: boolean }): Error {
  const error = new Error(response.message)
  if (response.cancelled === true) error.name = 'AbortError'
  return error
}

/** `true` when a rejection is a cancellation rather than a failure. */
export function isCancellation(err: unknown): boolean {
  return err instanceof Error && err.name === 'AbortError'
}
