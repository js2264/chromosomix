/**
 * The entry point, and nothing else.
 *
 * Four things have to happen before anything is drawn, in this order, and none
 * of them belongs to the app object: the theme is applied so a user who chose
 * dark gets no flash of light, a page a stale service worker served from the
 * wrong build is put right, the service worker is registered so the second
 * visit works offline, and a hash that is not a view state is cleared so the
 * picker does not open under a stale fragment.
 *
 * The app itself is `app/App.ts` — the window — and `app/Session.ts` — one open
 * file and the views of it. This file used to be both, which worked exactly as
 * long as there was one of the second.
 */

import './ui/styles.css'

import { App } from './app/App'
import { parseViewState } from './state/ViewState'
import { initTheme } from './ui/ThemeToggle'
import { mountPinnedNotice } from './ui/VersionPicker'
import { recoverPinnedNavigation, registerServiceWorker } from './pwa'

// Before the app mounts, so a user who chose dark gets no flash of light.
initTheme()

// Before *anything else* mounts. The case this catches is a document built for
// the site root whose address names an archived build, which only a worker
// published before those existed can produce: the page is already being
// reloaded, and drawing an interface over it would be a flash of the wrong app.
if (!recoverPinnedNavigation()) {
  // Offline, after the first visit. Nothing downstream depends on it: a browser
  // that refuses, or a page served over plain HTTP, simply has no cache.
  registerServiceWorker()

  // Only ever visible in an archived build, and the one thing standing between
  // a stale link and an afternoon's work in a build from July.
  mountPinnedNotice()

  const root = document.getElementById('app')
  if (root !== null) {
    // A hash that carries no `uri` is not a view state; clear it so the picker
    // does not leave a stale fragment in the address bar.
    if (window.location.hash !== '' && parseViewState(window.location.hash) === null) {
      window.history.replaceState(null, '', window.location.pathname + window.location.search)
    }
    new App(root)
  }
}
