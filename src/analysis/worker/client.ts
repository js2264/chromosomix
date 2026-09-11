/**
 * Main-thread half of the analysis protocol.
 *
 * The correlator itself is the reader client's, down to the id stamping and the
 * pending map, and `worker/client.ts` explains why it is shaped that way. What
 * is worth explaining here is why there is a *third* one of these at all, given
 * that a fourth kind of request could have been added to either of the two
 * clients that already exist.
 *
 * It is a third client because it is a third worker, and it is a third worker
 * because a scan must never get in front of a pan (§18.3). Sharing the reader's
 * client would put a forty-second job in the same queue as the `matrix` request
 * the next frame is waiting on, which is precisely the arrangement §12's first
 * analysis budget row — *0 dropped frames, 0 blocked reader requests* — exists
 * to rule out. A client is the queue, so a separate queue is a separate client.
 *
 * The traffic is different too, and the difference is the whole of §18's opening
 * paragraph. `AnnotationClient` has neither progress nor cancellation because
 * its longest request is a third of a second; here every request may outlive the
 * view that issued it, so both are the norm rather than the exception, and
 * {@link AnalysisClient.cancellable} is the method most callers reach for.
 *
 * The worker is created with the client, but nothing is mounted and no wasm is
 * fetched until the first task that needs a file — the laziness §18.3 promises
 * lives in `analysis.worker.ts`, where the cost actually is.
 */

import { registerThread } from '../../perf/threads'
import { withAccess } from '../../s3/attach'
import type { Cancellable } from '../../worker/client'
import { reviveError } from '../../worker/protocol'
import { spawnAnalysisWorker } from '../../worker/spawn'
import type {
  AnalysisProgressHandler,
  AnalysisRequest,
  AnalysisRequestKind,
  AnalysisRequestOf,
  AnalysisResponse,
  AnalysisResultMap,
} from './protocol'

interface Pending {
  resolve(value: unknown): void
  reject(reason: unknown): void
  onProgress?: AnalysisProgressHandler
}

export class AnalysisClient {
  private readonly worker: Worker
  private readonly pending = new Map<number, Pending>()
  private nextId = 1
  /**
   * This worker's line in the status bar's CPU figure.
   *
   * The line that matters most of the three: an insulation pass over a
   * metagenome pins this thread for minutes while the main thread sits idle, and
   * a meter that did not know this thread existed would report a quiet tab
   * during the one operation the reader is actually waiting on.
   */
  private readonly thread = registerThread('analysis')

  /** Constructed through `worker/spawn.ts`, the seam the standalone build
   * swaps; see there. */
  constructor(worker?: Worker) {
    this.worker = worker ?? spawnAnalysisWorker()
    this.worker.onmessage = (event: MessageEvent<AnalysisResponse>) => this.receive(event.data)
    this.worker.onerror = (event) =>
      this.failAll(new Error(`analysis worker failed: ${event.message}`))
  }

  private receive(response: AnalysisResponse): void {
    // Before the correlation, because it answers no request and carries no id.
    if (response.type === 'busy') {
      this.thread.report(response.fraction)
      return
    }
    const entry = this.pending.get(response.id)
    if (entry === undefined) return
    switch (response.type) {
      case 'progress':
        entry.onProgress?.(response.done, response.total, response.note)
        return
      case 'result':
        this.pending.delete(response.id)
        entry.resolve(response.payload)
        return
      case 'error':
        this.pending.delete(response.id)
        entry.reject(reviveError(response.error))
    }
  }

  private failAll(reason: Error): void {
    for (const [id, entry] of this.pending) {
      this.pending.delete(id)
      entry.reject(reason)
    }
  }

  /** Issue a request and await its single result. */
  request<K extends AnalysisRequestKind>(
    payload: AnalysisRequestOf<K>,
    onProgress?: AnalysisProgressHandler,
  ): Promise<AnalysisResultMap[K]> {
    const id = this.nextId++
    // A second mount of a private bucket's object needs the same key the first
    // one did, and gets it the same way: stamped at the boundary rather than
    // looked up wherever the `SourceSpec` was built. See `s3/attach.ts` — one
    // function serves all three protocols because all three spell the remote arm
    // the same way. Through `unknown` because only one member of the request
    // union carries a `source`, so the spread is not assignable to the union
    // without it; `payload.kind` is the discriminant and is already pinned.
    const message = withAccess({ ...payload, id }) as unknown as AnalysisRequest
    return new Promise<AnalysisResultMap[K]>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject, onProgress })
      this.worker.postMessage(message)
    })
  }

  /**
   * Issue a job the reader can call off.
   *
   * Cancellation is cooperative, exactly as the genome × genome scan's is: the
   * runner checks between chunks, so a job stops at the next check rather than
   * being killed mid-write. The rejection is an `AbortError`, which
   * `isCancellation` already knows to treat as a quiet no-op — a cancelled
   * analysis must not draw an error card saying "cancelled".
   */
  cancellable<K extends AnalysisRequestKind>(
    payload: AnalysisRequestOf<K>,
    onProgress?: AnalysisProgressHandler,
  ): Cancellable<AnalysisResultMap[K]> {
    // Read before `request` increments it, so `cancel` names the job this call
    // is about to start rather than the one after it.
    const id = this.nextId
    const promise = this.request<K>(payload, onProgress)
    return {
      promise,
      cancel: () => {
        void this.request<'cancel'>({ kind: 'cancel', target: id })
      },
    }
  }

  /** Drop the worker entirely. Any job still running rejects. */
  terminate(): void {
    this.failAll(new Error('analysis worker terminated'))
    this.thread.release()
    this.worker.terminate()
  }
}
