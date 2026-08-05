/**
 * Main-thread half of the annotations protocol.
 *
 * The same thin correlator the reader client is, minus the parts it does not
 * need: annotation requests carry no progress and are never cancelled, because
 * the longest of them is a third of a second and the shortest is the one a pan
 * would cancel a hundred of.
 *
 * The worker is created lazily. Most sessions open a map and never drop an
 * annotation on it, and a worker started at page load is a module graph
 * downloaded, parsed and thrown away for those.
 */

import { registerThread, type ThreadHandle } from '../../perf/threads'
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
    this.pending.delete(response.id)
    if (response.type === 'error') entry.reject(new Error(response.message))
    else entry.resolve(response.payload)
  }

  private failAll(error: Error): void {
    for (const entry of this.pending.values()) entry.reject(error)
    this.pending.clear()
  }

  request<K extends AnnotationRequestKind>(
    payload: AnnotationRequestOf<K>,
  ): Promise<AnnotationResultMap[K]> {
    const worker = this.ensure()
    const id = this.nextId++
    // Through `unknown`: the union's members no longer share a field — only
    // three of the four name an `entry`, since asking what genome a file is on
    // is a question about a file nothing has opened yet — so TypeScript can no
    // longer see the spread as any one member of it. The discriminant is
    // `payload.kind`, which `AnnotationRequestOf<K>` has already pinned.
    const message = { ...payload, id } as unknown as AnnotationRequest
    return new Promise<AnnotationResultMap[K]>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject })
      worker.postMessage(message)
    })
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

/**
 * `new URL(..., import.meta.url)` is the form the bundler rewrites, and the
 * module worker type is what lets the worker use `import` at all — the same
 * two constraints the reader client works under.
 */
function defaultWorker(): Worker {
  return new Worker(new URL('./annotations.worker.ts', import.meta.url), { type: 'module' })
}
