/**
 * A helper for pastis-NB's likelihood (§25.6, `analysis/likelihoodThreads.ts`).
 *
 * Sent its bands' rows once, and then a point per evaluation, it computes its
 * bands' values and gradients and sends them back (`likelihoodHelper`). One fit
 * per worker: the thread that started it terminates it when the fit ends, or
 * stops.
 */

import { likelihoodHelper, type LikelihoodMessage, type LikelihoodRequest } from '../likelihoodThreads'

const scope = self as unknown as {
  onmessage: ((event: MessageEvent<LikelihoodRequest>) => void) | null
  postMessage(message: LikelihoodMessage, transfer?: Transferable[]): void
}

const handle = likelihoodHelper((message, transfer) => scope.postMessage(message, transfer ?? []))
scope.onmessage = (event) => handle(event.data)
