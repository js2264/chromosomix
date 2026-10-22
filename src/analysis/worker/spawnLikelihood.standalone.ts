/**
 * pastis-NB's helpers, for a page with no origin.
 *
 * Swapped in for {@link ./spawnLikelihood.ts} by `vite.standalone.config.ts`, as
 * `spawnGram.standalone.ts` is for the correlation's: `?worker&inline` gives a
 * classic worker from a blob URL, the one construction a `file://` page permits.
 */

import LikelihoodWorker from './likelihood.worker.ts?worker&inline'

export function spawnLikelihoodWorker(): Worker {
  return new LikelihoodWorker()
}
