// @vitest-environment jsdom
/**
 * The app running at a rendered notebook's address, and getting out of it.
 *
 * `validation/` and `timings/` hold the two rendered notebooks
 * (`.github/workflows/notebooks.yml`), and a service worker from before they
 * existed answers a navigation there with this app's shell. The worker is
 * fixed (`src/sw.js`), but it updates only when a page it controls loads, and
 * this is that page: `recoverPinnedNavigation()` unregisters it and reloads,
 * once per tab, exactly as it does for an archived build answered the same way.
 */

import { beforeEach, describe, expect, it } from 'vitest'

import { recoverPinnedNavigation } from '@/pwa'

let reloads: number
let unregistered: number

/** The document at `pathname`, controlled by a worker with one registration. */
function at(pathname: string): void {
  Object.defineProperty(window, 'location', {
    value: {
      ...window.location,
      pathname,
      reload: () => {
        reloads++
      },
    },
    configurable: true,
  })
  Object.defineProperty(window.navigator, 'serviceWorker', {
    value: {
      controller: {},
      getRegistrations: async () => [
        {
          unregister: async () => {
            unregistered++
            return true
          },
        },
      ],
    },
    configurable: true,
  })
}

const settled = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

beforeEach(() => {
  reloads = 0
  unregistered = 0
  window.sessionStorage.clear()
})

describe('the app at a notebook’s address', () => {
  it('drops the worker and reloads, with or without the slash', async () => {
    for (const path of ['/validation/', '/validation', '/timings/', '/timings/index.html']) {
      window.sessionStorage.clear()
      const before = reloads
      at(path)
      expect(recoverPinnedNavigation(), path).toBe(true)
      await settled()
      expect(reloads - before, path).toBe(1)
    }
    expect(unregistered).toBe(4)
  })

  it('tries once per tab', async () => {
    at('/validation/')
    expect(recoverPinnedNavigation()).toBe(true)
    await settled()
    expect(recoverPinnedNavigation()).toBe(false)
    await settled()
    expect(reloads).toBe(1)
  })

  it('stays where it is anywhere else', () => {
    for (const path of ['/', '/validations/', '/timingsheet', '/index.html']) {
      at(path)
      expect(recoverPinnedNavigation(), path).toBe(false)
    }
    expect(reloads).toBe(0)
  })
})
