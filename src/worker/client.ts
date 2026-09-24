/**
 * Main-thread half of the worker protocol.
 *
 * A thin correlator: stamp an id on each request, park a promise, resolve it
 * when the matching response arrives, and revive `ViewerError` so the UI can
 * keep switching on `code`. It holds no reader state of its own — the worker is
 * the only place a file is open.
 */

import { beginWork } from '../perf/inflight'
import { registerThread } from '../perf/threads'
import { withAccess } from '../s3/attach'
import { spawnReaderWorker } from './spawn'
import {
  reviveError,
  type ProgressHandler,
  type RequestKind,
  type RequestOf,
  type ResultMap,
  type WorkerRequest,
  type WorkerResponse,
} from './protocol'

interface Pending {
  resolve(value: unknown): void
  reject(reason: unknown): void
  onProgress?: ProgressHandler
}

/** A long-running request that the user can call off (spec §7.3). */
export interface Cancellable<T> {
  promise: Promise<T>
  cancel(): void
}

export class ReaderClient {
  private readonly worker: Worker
  private readonly pending = new Map<number, Pending>()
  private nextId = 1
  /** This worker's line in the status bar's CPU figure. */
  private readonly thread = registerThread('reader')
  /**
   * Progress from a request whose caller did not ask to follow it.
   *
   * Almost every read in this application is bounded and finishes before a
   * reader could want news of it, so the dozen call sites that fetch a block
   * pass no handler and should not have to. One read is not like that: summing
   * a cell set is linear in *cells*, so a four-thousand-cell pseudo-bulk is
   * four thousand small reads behind one veil that would otherwise say
   * `loading…` for a minute and never say more.
   *
   * Rather than thread a handler through every view that asks for a matrix,
   * the shell sets this once and the veil gets the news wherever it came from.
   */
  onNotice: ProgressHandler | null = null

  /** Constructed through `worker/spawn.ts`, which is the seam the standalone
   * build swaps: a `file://` page cannot construct a module worker at all. */
  constructor(worker?: Worker) {
    this.worker = worker ?? spawnReaderWorker()
    this.worker.onmessage = (event: MessageEvent<WorkerResponse>) => this.receive(event.data)
    this.worker.onerror = (event) => this.failAll(new Error(`reader worker failed: ${event.message}`))
  }

  private receive(response: WorkerResponse): void {
    // Before the correlation, because it answers no request and carries no id.
    if (response.type === 'busy') {
      this.thread.report(response.fraction)
      return
    }
    const entry = this.pending.get(response.id)
    if (entry === undefined) return
    switch (response.type) {
      case 'progress':
        // A request that asked to be followed is followed; one that did not
        // still has something worth saying, and {@link ReaderClient.onNotice}
        // is where it goes. See the field.
        if (entry.onProgress !== undefined) entry.onProgress(response.done, response.total, response.note)
        else this.onNotice?.(response.done, response.total, response.note)
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
  request<K extends RequestKind>(
    payload: RequestOf<K>,
    onProgress?: ProgressHandler,
  ): Promise<ResultMap[K]> {
    const id = this.nextId++
    // The one place a private bucket's key joins a request to this worker. See
    // `s3/attach.ts`: stamping here rather than where the source was built is
    // what keeps the dozen construction sites ignorant of credentials, and what
    // makes a key edited mid-session apply to the next request rather than to
    // the next reload.
    const message = withAccess({ ...payload, id }) as WorkerRequest
    // Counted until it settles, whichever way (`perf/inflight.ts`): the one
    // number that says a picture is still waiting on this file.
    const done = beginWork(`reader:${payload.kind}`)
    return new Promise<ResultMap[K]>((resolve, reject) => {
      this.pending.set(id, {
        resolve: (value) => {
          done()
          resolve(value as ResultMap[K])
        },
        reject: (reason) => {
          done()
          reject(reason)
        },
        onProgress,
      })
      this.worker.postMessage(message)
    })
  }

  /**
   * Issue a request that can be called off. Cancellation is cooperative: the
   * worker checks between pixel chunks, so the scan stops at the next chunk
   * boundary rather than being killed mid-write.
   */
  cancellable<K extends RequestKind>(
    payload: RequestOf<K>,
    onProgress?: ProgressHandler,
  ): Cancellable<ResultMap[K]> {
    const id = this.nextId
    const promise = this.request<K>(payload, onProgress)
    return {
      promise,
      cancel: () => {
        void this.request<'cancel'>({ kind: 'cancel', target: id })
      },
    }
  }

  /** Drop the worker entirely. Any in-flight request rejects. */
  terminate(): void {
    this.failAll(new Error('reader worker terminated'))
    this.thread.release()
    this.worker.terminate()
  }
}

/** `true` when a rejection is a user cancellation rather than a failure. */
export function isCancellation(err: unknown): boolean {
  return err instanceof Error && err.name === 'AbortError'
}
