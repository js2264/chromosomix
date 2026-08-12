/**
 * Where the three workers are constructed, and the one thing that differs
 * between the hosted app and a single HTML file.
 *
 * Every target but one builds these the ordinary way: `new URL(…,
 * import.meta.url)` is the form the bundler rewrites into a real asset URL, and
 * `type: 'module'` is what lets a worker use `import`. That is right for the
 * website, for an archived build and for the desktop renderer, all three of
 * which are served over a real origin.
 *
 * **It is wrong for a `file://` page, twice over**, and both failures are
 * absolute rather than degraded:
 *
 * 1. A module worker cannot be constructed from an opaque origin at all. It
 *    throws, and the app comes up with an interface and no reader behind it.
 * 2. Even as a classic worker, the URL points at a sibling `.js` that a
 *    `file://` page may not fetch — the same CORS refusal that blocks a
 *    code-split chunk.
 *
 * So `vite.standalone.config.ts` aliases this module to
 * {@link ./spawn.standalone.ts}, which imports each worker through Vite's
 * `?worker&inline` and gets a **classic worker from a blob URL** — the one
 * construction a `file://` page allows, verified in Chromium before any of this
 * was written.
 *
 * Two files rather than one module with a build-time branch, and the reason is
 * the bundler rather than taste: `import Worker from './x?worker&inline'` is a
 * static import that Vite acts on whether or not the branch around it survives,
 * so a single module would inline half a megabyte of base64 into the website's
 * bundle to satisfy a condition that is false there.
 */

export function spawnReaderWorker(): Worker {
  return new Worker(new URL('./reader.worker.ts', import.meta.url), { type: 'module' })
}

export function spawnAnnotationsWorker(): Worker {
  return new Worker(new URL('../annotations/worker/annotations.worker.ts', import.meta.url), {
    type: 'module',
  })
}

export function spawnAnalysisWorker(): Worker {
  return new Worker(new URL('../analysis/worker/analysis.worker.ts', import.meta.url), {
    type: 'module',
  })
}
