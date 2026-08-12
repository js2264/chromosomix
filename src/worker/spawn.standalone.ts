/**
 * The same three workers, for a page with no origin.
 *
 * Swapped in for {@link ./spawn.ts} by `vite.standalone.config.ts`'s alias. Read
 * that file first — it says why there are two of these rather than one with a
 * condition in it.
 *
 * `?worker&inline` asks Vite to bundle the worker and hand it back as a
 * constructor over a **blob URL** rather than an asset path. Combined with
 * `worker: { format: 'iife' }` in the config, that produces a *classic* worker
 * from a blob, which is the one construction a `file://` page permits: no fetch
 * of a sibling file, and no module type.
 *
 * The `&inline` is doing the load-bearing work and is easy to lose. Without it
 * Vite still emits a worker constructor, but one that points at a sibling
 * `.js` — which works everywhere the app is served and nowhere it is opened.
 * `scripts/standalone-shape.mjs` asserts no such sibling exists, because this is
 * exactly the mistake that produces a build that looks right and is not.
 */

import ReaderWorker from './reader.worker.ts?worker&inline'
import AnnotationsWorker from '../annotations/worker/annotations.worker.ts?worker&inline'
import AnalysisWorker from '../analysis/worker/analysis.worker.ts?worker&inline'

export function spawnReaderWorker(): Worker {
  return new ReaderWorker()
}

export function spawnAnnotationsWorker(): Worker {
  return new AnnotationsWorker()
}

export function spawnAnalysisWorker(): Worker {
  return new AnalysisWorker()
}
