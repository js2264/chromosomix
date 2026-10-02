/**
 * Main-thread half of the worker protocol.
 *
 * A thin correlator: stamp an id on each request, park a promise, resolve it
 * when the matching response arrives, and revive `ViewerError` so the UI can
 * keep switching on `code`. It holds no reader state of its own — the worker is
 * the only place a file is open — but it does keep the reader's answers, so a
 * question asked again of the same map is answered without asking
 * (`worker/answers.ts`).
 */

import { registerThread } from '../perf/threads'
import { withAccess } from '../s3/attach'
import { devFeature } from '../state/devFeatures'
import { AnswerCache } from './answers'
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
  /** Answers already given about the map the worker holds (`worker/answers.ts`). */
  private readonly answers = new AnswerCache()
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

  /**
   * Issue a request and await its single result.
   *
   * Answered from memory where the same question has been answered about the
   * same map, or is being answered now — a reader stepping back to a place
   * still being read waits for that read rather than starting a second.
   */
  request<K extends RequestKind>(
    payload: RequestOf<K>,
    onProgress?: ProgressHandler,
  ): Promise<ResultMap[K]> {
    const answered = this.answers.answer(payload, true)
    if (answered !== undefined) return answered as Promise<ResultMap[K]>
    const { message, promise } = this.send<K>(payload, onProgress)
    return this.answers.track(message, promise, true)
  }

  /**
   * Issue a request that can be called off. Cancellation is cooperative: the
   * worker checks between pixel chunks, so the scan stops at the next chunk
   * boundary rather than being killed mid-write.
   *
   * An answer already in hand is handed back with nothing to call off. A read
   * still on its way for somebody else is not joined: calling this one off
   * would call off theirs.
   */
  cancellable<K extends RequestKind>(
    payload: RequestOf<K>,
    onProgress?: ProgressHandler,
  ): Cancellable<ResultMap[K]> {
    const answered = this.answers.answer(payload, false)
    if (answered !== undefined) return { promise: answered as Promise<ResultMap[K]>, cancel: () => {} }
    const { message, promise } = this.send<K>(payload, onProgress)
    return {
      promise: this.answers.track(message, promise, false),
      cancel: () => {
        void this.request<'cancel'>({ kind: 'cancel', target: message.id })
      },
    }
  }

  private send<K extends RequestKind>(
    payload: RequestOf<K>,
    onProgress?: ProgressHandler,
  ): { message: WorkerRequest; promise: Promise<ResultMap[K]> } {
    const id = this.nextId++
    // The one place a private bucket's key joins a request to this worker. See
    // `s3/attach.ts`: stamping here rather than where the source was built is
    // what keeps the dozen construction sites ignorant of credentials, and what
    // makes a key edited mid-session apply to the next request rather than to
    // the next reload.
    const message = withDevGate(withAccess({ ...payload, id }) as WorkerRequest)
    const promise = new Promise<ResultMap[K]>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject, onProgress })
      this.worker.postMessage(message)
    })
    return { message, promise }
  }

  /** Drop the worker entirely. Any in-flight request rejects. */
  terminate(): void {
    this.answers.clear()
    this.failAll(new Error('reader worker terminated'))
    this.thread.release()
    this.worker.terminate()
  }
}

/** `true` when a rejection is a user cancellation rather than a failure. */
export function isCancellation(err: unknown): boolean {
  return err instanceof Error && err.name === 'AbortError'
}

/**
 * Stamp the page's *dev features* switch on an open (§29).
 *
 * Here for the reason credentials are stamped here: an open is issued from half
 * a dozen places — a tab, a deck's cell, the compare card — and a worker cannot
 * read `localStorage`, so the one road every open takes is where the answer
 * joins it. Only `open` carries it; every later request is about a map that
 * already passed.
 */
function withDevGate(message: WorkerRequest): WorkerRequest {
  if (message.kind !== 'open') return message
  return { ...message, metacool: devFeature('metacool') }
}
