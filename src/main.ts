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
import { embedded, plotting } from './embed'
import { parseViewState } from './state/ViewState'
import { readShareHash } from './state/shareLink'
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
  // Neither of the next two in an embed, and for one reason with two halves.
  //
  // A worker is for an app somebody keeps: it makes the second visit work with
  // the network out, and it is registered per origin — so an embed would install
  // the app's cache from a page that was only ever showing a figure, on behalf
  // of a reader who never chose to keep it. Nothing an embed does needs it: the
  // frame is a fresh load of a URL that says what to show.
  //
  // And the notice is a bar across the top of the window offering to move to
  // another build. In a frame that top is somebody's figure, and the offer is
  // one only the page's author could sensibly accept — they chose the pinned
  // build in the `src=`, on purpose, so that the embed still renders the same
  // way in five years (docs/deploy.md).
  // Nor in a window `metacooler-plot` is driving (§27): it is served by the
  // command for the length of one run, and a worker installed there would
  // outlive the server it came from.
  if (!embedded() && !plotting()) {
    // Offline, after the first visit. Nothing downstream depends on it: a browser
    // that refuses, or a page served over plain HTTP, simply has no cache.
    registerServiceWorker()

    // Only ever visible in an archived build, and the one thing standing between
    // a stale link and an afternoon's work in a build from July.
    mountPinnedNotice()
  }

  const root = document.getElementById('app')
  if (root !== null) {
    // A hash that carries no `uri` is not a view state; clear it so the picker
    // does not leave a stale fragment in the address bar.
    //
    // A **shared session** is the exception, and it has to be made here rather
    // than downstream: this line runs before `App` exists, so without it a
    // pasted share link is wiped between the page loading and anything being
    // able to read it. The symptom is a link that opens the picker, every time,
    // with no error — which is the hardest possible thing to diagnose from a
    // bug report.
    if (
      window.location.hash !== '' &&
      readShareHash(window.location.hash) === null &&
      parseViewState(window.location.hash) === null
    ) {
      window.history.replaceState(null, '', window.location.pathname + window.location.search)
    }
    new App(root)
  }
}
