/**
 * The correlation's helper workers, for a page with no origin.
 *
 * Swapped in for {@link ./spawnGram.ts} by `vite.standalone.config.ts`, as
 * `worker/spawn.standalone.ts` is for the three workers the session starts, and
 * for its reason: `?worker&inline` gives a classic worker from a blob URL, the one
 * construction a `file://` page permits.
 */

import GramWorker from './gram.worker.ts?worker&inline'

export function spawnGramWorker(): Worker {
  return new GramWorker()
}
