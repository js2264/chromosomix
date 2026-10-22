/**
 * Helper threads for the command line (§22.2, `analysis/likelihoodThreads.ts`).
 *
 * The app's analysis worker starts pastis-NB's likelihood helpers as web
 * workers. Node has no web workers; it has `worker_threads`, and a thread there
 * runs a file. The command line is one file, so a helper is that file again,
 * started with a word in its `workerData` that says *you are a helper*: the
 * bundle's last lines ask {@link serveIfHelper} before anything else, and a
 * helper answers the likelihood's messages and does nothing a command would.
 * One file stays one file — no second entry for `npx chromosomix` to find —
 * and the helper runs the same code the app's helpers do.
 *
 * Results do not depend on the thread count — the likelihood is the same bits
 * on any number (`likelihoodThreads.ts`) — so `--threads` is a question about
 * this machine and is written into no provenance.
 */

import { availableParallelism } from 'node:os'
import { Worker as NodeWorker, isMainThread, parentPort, workerData } from 'node:worker_threads'

import {
  likelihoodHelper,
  useLikelihoodThreads,
  type LikelihoodMessage,
  type LikelihoodRequest,
} from '../analysis/likelihoodThreads'

/** What a helper is told it is. */
const ROLE = 'chromosomix-likelihood-helper'

/** Threads at most, by default: past eight the copies cost more than the cores give back. */
const MOST = 8

/** Every core, up to {@link MOST}: the default for `--threads`. */
export function defaultThreads(): number {
  return Math.max(1, Math.min(MOST, availableParallelism()))
}

/** Let the tasks that share their work use `count` threads, this one included. */
export function useThreads(count: number): void {
  useLikelihoodThreads(spawnHelper, Math.max(0, Math.floor(count) - 1))
}

/**
 * Serve as a helper, if this thread was started as one: `true` then, and the
 * caller does nothing else. The thread lives until the one that started it
 * terminates it.
 */
export function serveIfHelper(): boolean {
  const role = (workerData as { role?: unknown } | null)?.role
  if (isMainThread || role !== ROLE || parentPort === null) return false
  const port = parentPort
  const handle = likelihoodHelper((message, transfer) =>
    port.postMessage(message, (transfer ?? []) as unknown as readonly ArrayBuffer[]),
  )
  port.on('message', (request: LikelihoodRequest) => handle(request))
  return true
}

/**
 * A Node worker thread running this file as a helper, dressed as the web
 * `Worker` the likelihood talks to: `postMessage`, `onmessage`, `onerror` and
 * `terminate`. A thread that exits before it is terminated is an error, so its
 * bands come back to the thread that asked.
 */
function spawnHelper(): Worker {
  const thread = new NodeWorker(new URL(import.meta.url), { workerData: { role: ROLE } })
  let ended = false
  const helper = {
    onmessage: null as ((event: MessageEvent<LikelihoodMessage>) => void) | null,
    onerror: null as ((event: ErrorEvent) => void) | null,
    postMessage(message: LikelihoodRequest, transfer: Transferable[] = []): void {
      thread.postMessage(message, transfer as unknown as readonly ArrayBuffer[])
    },
    terminate(): void {
      ended = true
      void thread.terminate()
    },
  }
  const failed = (message: string): void => {
    if (ended) return
    ended = true
    helper.onerror?.({ message, preventDefault: () => {} } as ErrorEvent)
  }
  thread.on('message', (data: LikelihoodMessage) => helper.onmessage?.({ data } as MessageEvent<LikelihoodMessage>))
  thread.on('error', (error: Error) => failed(error.message))
  thread.on('exit', (code: number) => failed(`a helper thread exited with code ${code}`))
  return helper as unknown as Worker
}
