// @vitest-environment jsdom
/**
 * When a new service worker takes over, and when it must not.
 *
 * `sw.js` calls `clients.claim()` as it activates, so the page that registered
 * it becomes controlled while it is still running — and `controllerchange`
 * fires whether that worker *replaced* one or was the first ever installed.
 * Only the first of those two is a reason to reload.
 *
 * The bug this is here to keep out was invisible in every ordinary test of it.
 * A share link opened the picker rather than the session, but **only on the
 * first visit in a fresh profile**: the first load registers the worker, the
 * worker claims the page, the page reloads — and by then `openSharedHash` had
 * already taken `#session=…` out of the address bar, so the reload landed on a
 * bare URL. Every reload after that, and every second tab, already had a
 * controller and behaved perfectly, which is what made it read as a broken
 * link instead of a worker that should have stayed quiet.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { registerServiceWorker } from '@/pwa'

/** A `navigator.serviceWorker` that only does the two things this file reads. */
function stubWorkerContainer(controller: object | null): {
  claim: () => void
  registered: string[]
} {
  const target = new EventTarget()
  const registered: string[] = []
  const container = {
    controller,
    register: (url: string) => {
      registered.push(url)
      // Never resolves: `watch` is not what this file is about, and a
      // registration that settles would pull the update machinery in with it.
      return new Promise(() => {})
    },
    addEventListener: target.addEventListener.bind(target),
    removeEventListener: target.removeEventListener.bind(target),
  }
  Object.defineProperty(window.navigator, 'serviceWorker', {
    value: container,
    configurable: true,
  })
  return {
    claim: () => target.dispatchEvent(new Event('controllerchange')),
    registered,
  }
}

let reloads: number

beforeEach(() => {
  reloads = 0
  // `registerServiceWorker` returns early off this; the app does not cache in dev.
  vi.stubEnv('PROD', true)
  Object.defineProperty(window, 'location', {
    value: { ...window.location, reload: () => { reloads++ } },
    configurable: true,
  })
})

afterEach(() => {
  vi.unstubAllEnvs()
})

/** Register, and let the `load` listener the module hangs its registration on fire. */
function boot(): void {
  registerServiceWorker()
  window.dispatchEvent(new Event('load'))
}

describe('a worker taking control', () => {
  it('does not reload the first page it ever claims', () => {
    const worker = stubWorkerContainer(null)
    boot()
    expect(worker.registered).toHaveLength(1)
    worker.claim()
    // Nothing to swap: this page came off the network, not out of the cache
    // the worker has only just filled. A reload here is what ate the fragment.
    expect(reloads).toBe(0)
  })

  it('reloads a page a previous worker was serving', () => {
    const worker = stubWorkerContainer({ scriptURL: 'https://host/sw.js' })
    boot()
    worker.claim()
    // This page *was* built from what the old worker held, so it is the stale
    // one and the whole point of the handshake.
    expect(reloads).toBe(1)
  })

  it('reloads once, whatever a second change says', () => {
    const worker = stubWorkerContainer({ scriptURL: 'https://host/sw.js' })
    boot()
    worker.claim()
    worker.claim()
    worker.claim()
    expect(reloads).toBe(1)
  })
})
