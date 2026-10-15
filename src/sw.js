/**
 * The service worker: the app, available with no network at all.
 *
 * This is what makes "open it once, then work on a train" true, and it is the
 * honest form of the app's central claim. A viewer that reads your files
 * without uploading them should not need the network to *start* either — and a
 * scientist who has been told not to put patient-derived data on a website can
 * verify the claim by pulling the cable and reloading, which is a far better
 * argument than any privacy notice.
 *
 * Written by hand rather than generated. The whole of it is a precache, a
 * cache-first read for the shell, and an update handshake; a toolchain for that
 * would be a dependency tree and a build step to do what is written below,
 * in an app whose entire claim is that it has no server and little else.
 *
 * **The one rule that matters: it must stay out of the way of the data.** The
 * viewer reads `.metacool` files with HTTP range requests, and a cache is the
 * wrong shape for a 206 — intercepting one and answering from `caches` would
 * hand the reader the whole file where it asked for four kilobytes, or nothing
 * at all. So `fetch` answers *only* for URLs that are in the precache, by exact
 * match, and every other request is left alone: no `respondWith`, no clone, no
 * opinion. Remote datasets, the demo files, range requests and cross-origin
 * reads all go straight to the network as if this file did not exist.
 *
 * The cache name and the precache list are substituted at build time by the
 * plugin in `vite.config.ts` — which is why neither placeholder is named again
 * anywhere in this file, including in prose: the substitution is a text
 * replacement, and a mention in a comment is indistinguishable from the real
 * one. The cache name carries the version and the commit, so a new build is a
 * new cache rather than a merge into an old one.
 */

/* global self, caches, fetch, Response */

const CACHE = __CACHE_NAME__
const PRECACHE = __PRECACHE__
const PRECACHED = new Set(PRECACHE)

/**
 * The archived builds this worker must keep its hands off.
 *
 * The site publishes a copy of every push under `<base>v/<commit>/`, and the
 * whole point of that copy is that opening it runs *that* code. But this worker
 * is registered at `<base>`, so those URLs are inside its scope, and the
 * navigation branch below answers every navigation in scope with the cached
 * shell of the build the worker belongs to. Without this prefix, clicking a
 * pinned version would load the newest app at a pinned address: the right URL,
 * the wrong code, and no symptom to notice it by.
 *
 * Read from `self.location` rather than substituted, because the worker is
 * emitted beside the shell it serves and therefore already knows where it is.
 * `new URL('./', …)` is the directory this file sits in, which is the scope.
 */
const SCOPE_DIR = new URL('./', self.location.href).pathname
// …and the same for pull-request previews under `pr/<number>/`, which are the
// same kind of copy at a different address (docs/deploy.md).
const PINNED_PREFIXES = [`${SCOPE_DIR}v/`, `${SCOPE_DIR}pr/`]

/**
 * Fill the cache, then wait.
 *
 * No `skipWaiting()` here: a worker that takes over immediately swaps the
 * assets under a page that is already running, which is how a half-updated app
 * ends up asking for a chunk that no longer exists. The new worker waits until
 * the page says it is ready — see the message handler — and the page only says
 * so when the user has agreed to reload.
 */
self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(PRECACHE)))
})

/**
 * Take over, and leave exactly this build's files behind.
 *
 * Two sweeps, because there are two ways to be stale. Caches from other builds
 * go by name. Entries *inside* this cache are pruned against the list as well,
 * for the case the name cannot catch: two builds of the same commit — a rebuild
 * between deploys — share a cache, and `addAll` only ever adds, so the old
 * chunks would sit there until the version changed.
 */
self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys()
      await Promise.all(names.filter((name) => name !== CACHE).map((name) => caches.delete(name)))
      const cache = await caches.open(CACHE)
      const stale = (await cache.keys()).filter(
        (request) => !PRECACHED.has(new URL(request.url).pathname),
      )
      await Promise.all(stale.map((request) => cache.delete(request)))
      await self.clients.claim()
    })(),
  )
})

/**
 * Cache-first for the shell, invisible for everything else.
 *
 * Cache-first and not network-first, because every asset in the list is
 * content-hashed and therefore immutable: if the URL is the same, the bytes are
 * the same, and asking the network first would spend a round trip per file to
 * be told so. The one URL that is *not* hashed is the navigation itself, which
 * is why a new build is picked up by the update handshake rather than by
 * revalidation.
 */
self.addEventListener('fetch', (event) => {
  const request = event.request
  if (request.method !== 'GET') return

  // A reload, or a link into the app: answer with the cached shell, and fall
  // back to the network on a cold cache. Every view lives in the URL *hash*, so
  // one entry serves every link the app publishes — with one exception, which
  // is a link to an archived build. That is a different document under the same
  // scope and it has to come from the network, or the reader gets this build
  // wearing that build's address.
  if (request.mode === 'navigate') {
    const pathname = new URL(request.url).pathname
    if (PINNED_PREFIXES.some((prefix) => pathname.startsWith(prefix))) return
    event.respondWith(
      caches.match(PRECACHE[0]).then((cached) => cached ?? fetch(request)),
    )
    return
  }

  // Exact-match only. Anything not precached — a dataset, a range request, a
  // source map, another origin — is not this worker's business.
  const url = new URL(request.url)
  if (url.origin !== self.location.origin || !PRECACHED.has(url.pathname)) return

  event.respondWith(
    caches.match(url.pathname).then((cached) => cached ?? fetch(request)),
  )
})

/**
 * The second half of the update handshake: the page has told the user a new
 * version is waiting and the user has agreed to take it.
 */
self.addEventListener('message', (event) => {
  if (event.data === 'skip-waiting') void self.skipWaiting()
})
