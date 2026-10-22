/**
 * Where pastis-NB's helpers are constructed (`analysis/likelihoodThreads.ts`).
 *
 * Its own module, for `spawnGram.ts`'s reasons: imported by the analysis worker,
 * and swapped by the standalone build for {@link ./spawnLikelihood.standalone.ts},
 * since a `file://` page can start a worker only from a blob.
 */

export function spawnLikelihoodWorker(): Worker {
  return new Worker(new URL('./likelihood.worker.ts', import.meta.url), { type: 'module' })
}
