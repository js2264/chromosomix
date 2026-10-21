/**
 * Registering the service worker, and telling the user when a new one is ready.
 *
 * Two halves of one bargain. Caching the app is what makes it work with no
 * network — but a cached app is also an app that can go on serving last month's
 * build forever, silently, which is worse than not caching it at all. So the
 * page watches for a waiting worker and offers a reload rather than taking one
 * without asking: an update that swaps the code under a half-read file is not a
 * courtesy.
 *
 * Nothing here is required for the app to work. A browser with no service
 * worker support, a page served over plain HTTP, a failed registration — all of
 * them land on "no offline, everything else normal", which is what the guards
 * below are for. The viewer's job is to open files, and it must not fail to
 * start because a cache could not be filled.
 */

import { el } from './ui/dom'
import { TARGET } from './version'
import {
  ARCHIVE_SEGMENT,
  IS_PINNED,
  IS_PORTABLE,
  NOTEBOOK_SEGMENTS,
  PULL_SEGMENT,
  SITE_BASE,
} from './versions'

/**
 * Register, and watch for a replacement.
 *
 * Dev is skipped: `vite dev` serves unbundled modules, so there is nothing
 * coherent to cache, and a worker holding yesterday's chunks is the classic
 * reason a change "does not show up". The build plugin does not emit `sw.js`
 * there either, so this would 404 anyway.
 */
export function registerServiceWorker(): void {
  if (!import.meta.env.PROD) return
  // A packaged desktop build *is* a production build, so the check above is not
  // the guard people assume it is -- and caching an app that is already on disk
  // buys nothing while costing the one failure mode this whole module exists to
  // avoid: a worker serving a build the installer replaced months ago.
  //
  // One of three, all independent, because this one is the only one a future
  // refactor can delete by accident. The desktop config does not include the
  // plugin, so `sw.js` is never emitted for it to fetch; and the `app` scheme is
  // registered without `allowServiceWorkers`, which Chromium refuses outright --
  // "The URL protocol of the current origin ('app://viewer') is not supported".
  if (TARGET !== 'web') return
  // Guard four, and the only one that is about a *web* build. An archived copy
  // of the site (`…/v/<commit>/`) is deliberately not installable and emits no
  // `sw.js`, so registering here would 404 at best — and at worst, if the file
  // ever were emitted, it would put a second worker under a nested scope,
  // caching a build somebody pinned in July for as long as the browser feels
  // like keeping it. See `vite.pinned.config.ts`. A pull-request preview is
  // the same kind of copy at `pr/<number>/`, and the same rule.
  if (IS_PINNED) return
  // Guard five, and the same argument as guard four seen from the other side.
  // An archived build knows it is not the site; a package build does not know
  // *what* it is under — it was made for a relative base precisely so that one
  // published version can be unpacked anywhere (`src/versions.ts`). A worker
  // registered from there claims a scope over whatever else lives at that path:
  // a lab's own site, or, on a registry CDN, other people's packages.
  if (IS_PORTABLE) return
  if (!('serviceWorker' in navigator)) return

  window.addEventListener('load', () => {
    // Relative to the app's base, not to the origin: a site served from
    // `/chromosomix/` has its worker there too, and a worker registered at
    // the root would claim a scope it has no business in.
    const url = `${import.meta.env.BASE_URL}sw.js`
    // `updateViaCache: 'none'` is what makes an update ever arrive. The browser
    // re-fetches this script on navigation and installs a new worker when the
    // bytes differ -- but by default that fetch may itself be answered from the
    // HTTP cache, and a host that serves `sw.js` with any max-age (GitHub Pages
    // does) then pins the whole app to the build that was live when the user
    // first visited. Found by deploying a second build in a test and watching
    // nothing happen.
    navigator.serviceWorker.register(url, { updateViaCache: 'none' }).then(
      (registration) => watch(registration),
      () => {
        /* No offline. Not worth a word on screen: nothing the user did failed. */
      },
    )
  })

  // The other half of the handshake, and it is only half a handshake on an
  // *update*: a worker that replaced another is serving a page built from the
  // one it replaced, so the page is reloaded once — guarded against the loop a
  // second `controllerchange` would cause.
  //
  // **The first install is not that case, and must not reload.** A page with no
  // controller was served by the network a moment ago and is therefore already
  // the newest build; there is nothing to swap. `clients.claim()` in `sw.js`'s
  // activate fires `controllerchange` at it all the same, and a reload there
  // throws away whatever the first load was in the middle of.
  //
  // Which was not theoretical. A shared session is decoded and then *taken out
  // of the address bar* before the tab it describes has finished opening
  // (`app/App.ts` on `openSharedHash`), so the reload landed on a bare URL and
  // the link opened the picker instead of the session. Only ever on the first
  // visit in a profile — every reload, every second tab, every ordinary visit
  // already has a controller and behaves — which is why it read as a link that
  // did not work rather than as a worker that should not have reloaded.
  const hadController = navigator.serviceWorker.controller !== null
  let reloading = false
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!hadController || reloading) return
    reloading = true
    window.location.reload()
  })
}

/**
 * Make the newest build actually arrive, rather than the one a worker is
 * holding on to.
 *
 * The bug this exists for is worth stating plainly, because everything about it
 * looks like it works. A visitor at the site root is served by a worker whose
 * cache is a build or two old — which is the *designed* behaviour, since an
 * update installs and waits for consent rather than swapping code under a
 * half-read file. They open the version menu, see that they are running 0.6.0
 * and that 0.6.1 is marked "latest", and pick it. The picker sends them to the
 * site root. The worker answers that navigation from the same cache. The page
 * flickers and comes back as 0.6.0, and it will do that for ever, because
 * nothing in the round trip ever asked the network for anything.
 *
 * So going to the newest build cannot be a navigation. It is:
 *
 * 1. **Ask now.** `update()` fetches `sw.js` rather than waiting for whenever
 *    the browser would have. If the site has moved on, a new worker installs.
 * 2. **Take what is waiting**, by the same handshake the update bar uses:
 *    `skip-waiting`, then `controllerchange` above reloads the page. This is
 *    the good path — the cache is replaced rather than dropped, so the visitor
 *    keeps offline throughout.
 * 3. **Otherwise, if we know the shell is stale, drop the worker.** There is
 *    nothing waiting and the page is still not the newest, so the polite
 *    mechanism has no answer: the worker is serving a cache it has no reason to
 *    doubt. Unregistering costs one page load of offline and is the only thing
 *    left that certainly works.
 *
 * `stuck` is what tells step 3 apart from an ordinary click. A reader on an
 * archived build asking for the newest is not evidence that anything is wrong
 * at the root, and dropping a working worker to satisfy them would be a cost
 * with no cause.
 *
 * Returns `true` when a reload is already on its way, so the caller knows not
 * to navigate on top of it.
 */
export async function takeNewestBuild(stuck: boolean): Promise<boolean> {
  if (TARGET !== 'web' || !('serviceWorker' in navigator)) return false
  const registration = await navigator.serviceWorker.getRegistration()
  if (registration === undefined) return false

  try {
    await registration.update()
  } catch {
    /* Offline, or `sw.js` did not answer. There is nothing to take. */
  }
  // `update()` resolving does not guarantee the new worker has finished
  // installing in every browser, and a worker that is still `installing` is not
  // yet `waiting` — reading `waiting` at that moment sees null and falls
  // through to the coarse path for no reason.
  const installing = registration.installing
  if (installing !== null) {
    await new Promise<void>((resolve) => {
      installing.addEventListener('statechange', () => {
        if (installing.state === 'installed' || installing.state === 'redundant') resolve()
      })
    })
  }

  if (registration.waiting !== null) {
    registration.waiting.postMessage('skip-waiting')
    return true
  }
  if (!stuck) return false
  await registration.unregister()
  return false
}

/** Where the one recovery attempt is remembered, so it cannot become a loop. */
const RECOVERED = 'chromosomix:unpinned'

/**
 * Undo a worker that answered an archived build's URL with the site's shell.
 *
 * A transitional bug with a long tail. Every worker published before archived
 * builds existed answers *every* navigation in its scope from the precache, and
 * `…/v/<commit>/` is in its scope — so a reader carrying one of those workers
 * who follows a pinned link gets this build at that address: the version picker
 * would show the wrong thing, and the whole feature would be silently a lie for
 * as long as that worker lives. The fix is in `src/sw.js`, but a worker only
 * updates when the page it controls is loaded, and this is that page.
 *
 * The symptom is exactly detectable, which is what makes recovery safe rather
 * than a guess: the document's path is under the archive prefix, and the code
 * reading it was built for the site root. Those two cannot both be true of a
 * correctly served page. The rendered notebooks, at `validation/`, `timings/`
 * and `parity/`, are the same case one step further: no build at all lives
 * there, so this app running at any of them is a worker that predates them.
 *
 * Recovery is to unregister and reload — coarse, and deliberately so. The
 * registration is what is serving the wrong document, `update()` would not
 * change what this page already is, and a site whose worker has been dropped
 * simply registers a fresh one on the next visit to the root, which is where
 * the reader is going. It costs one visit of offline and buys the correct code.
 *
 * Once per tab, and recorded before the reload rather than after: if this does
 * not work — a proxy, an extension, a cache doing something unusual — the
 * second attempt would be a reload loop, which is a far worse failure than the
 * one being repaired.
 *
 * Returns `true` when a reload is on the way, so the caller can decline to
 * mount an interface over a page that is about to be replaced.
 */
export function recoverPinnedNavigation(): boolean {
  if (TARGET !== 'web' || IS_PINNED) return false
  const path = window.location.pathname
  const notebook = NOTEBOOK_SEGMENTS.some(
    (segment) => path === `${SITE_BASE}${segment}` || path.startsWith(`${SITE_BASE}${segment}/`),
  )
  if (
    !notebook &&
    !path.startsWith(`${SITE_BASE}${ARCHIVE_SEGMENT}/`) &&
    !path.startsWith(`${SITE_BASE}${PULL_SEGMENT}/`)
  ) {
    return false
  }
  if (!('serviceWorker' in navigator) || navigator.serviceWorker.controller === null) return false
  try {
    if (window.sessionStorage.getItem(RECOVERED) !== null) return false
    window.sessionStorage.setItem(RECOVERED, '1')
  } catch {
    // No storage means no way to stop at one attempt, and a reload loop is
    // worse than an old build at a pinned address.
    return false
  }
  void navigator.serviceWorker
    .getRegistrations()
    .then((registrations) => Promise.all(registrations.map((one) => one.unregister())))
    .then(() => window.location.reload())
  return true
}

/** Offer the reload as soon as a replacement is installed and waiting. */
function watch(registration: ServiceWorkerRegistration): void {
  if (registration.waiting !== null) offerUpdate(registration.waiting)
  registration.addEventListener('updatefound', () => {
    const installing = registration.installing
    if (installing === null) return
    installing.addEventListener('statechange', () => {
      // `installed` *with* a controller means this is a replacement rather than
      // the first install — on a first visit there is nothing to offer, because
      // what is on screen is already the new thing.
      if (installing.state === 'installed' && navigator.serviceWorker.controller !== null) {
        offerUpdate(installing)
      }
    })
  })
}

let prompt: HTMLElement | null = null

/**
 * A small bar, bottom left, with the one button that matters.
 *
 * Not a modal: nothing is wrong, nothing is urgent, and a dialog over a contact
 * map to say "there is a newer version" would be an interruption charging for a
 * courtesy. It is dismissible, and dismissing it keeps the old build running
 * until the next reload, which is a legitimate thing to want in the middle of
 * reading a figure.
 */
function offerUpdate(worker: ServiceWorker): void {
  if (prompt !== null) return
  const dismiss = (): void => {
    prompt?.remove()
    prompt = null
  }
  const reload = el('button', { class: 'btn btn-small', text: 'reload', type: 'button' })
  reload.addEventListener('click', () => {
    // The worker steps forward; `controllerchange` above reloads the page.
    worker.postMessage('skip-waiting')
    dismiss()
  })
  const close = el('button', {
    class: 'btn-quiet update-close',
    text: '×',
    type: 'button',
    title: 'Keep this version until the next reload',
  })
  close.addEventListener('click', dismiss)

  prompt = el(
    'div',
    { class: 'update-bar', attrs: { role: 'status' } },
    el('span', { text: 'A new version of the viewer is ready.' }),
    reload,
    close,
  )
  document.body.appendChild(prompt)
}
