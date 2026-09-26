/**
 * A helper for the correlation matrix (§18.6, `analysis/pearsonThreads.ts`).
 *
 * Sent one stretch of rows and every row after it, it correlates the stretch
 * and sends each band's lines back as it finishes (`runGramJob`). One job per
 * worker: the thread that started it terminates it when the matrix is done, or
 * stopped.
 */

import { runGramJob, type GramJob, type GramMessage } from '../pearsonThreads'

const scope = self as unknown as {
  onmessage: ((event: MessageEvent<GramJob>) => void) | null
  postMessage(message: GramMessage, transfer?: Transferable[]): void
}

scope.onmessage = (event) => {
  runGramJob(event.data, (message, transfer) => scope.postMessage(message, transfer ?? []))
}
