/**
 * Where the correlation's helper workers are constructed (`analysis/pearsonThreads.ts`).
 *
 * Its own module, beside rather than inside `worker/spawn.ts`, because it is
 * imported by the analysis worker — and `spawn.ts` constructs the analysis worker
 * itself, which would make the worker's own bundle contain a way to build
 * another copy of it. The standalone build swaps this for
 * {@link ./spawnGram.standalone.ts}, for `spawn.ts`'s reason: a `file://` page can
 * start a worker only from a blob.
 */

export function spawnGramWorker(): Worker {
  return new Worker(new URL('./gram.worker.ts', import.meta.url), { type: 'module' })
}
