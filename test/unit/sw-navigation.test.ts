/**
 * Which navigations the service worker answers with the app, and which it
 * leaves to the network.
 *
 * It answers every navigation in its scope from the cached shell — every view
 * lives in the hash, so one document serves them all — except the addresses
 * that hold a different document under the same scope: an archived build at
 * `v/<commit>/`, a pull request's preview at `pr/<n>/`, and the two rendered
 * notebooks at `evaluation/` and `timings/` (`.github/workflows/notebooks.yml`).
 * Answered with the shell, those show this build at that address, which is the
 * one failure a reader has no symptom to notice by. The notebooks are passed
 * through without their trailing slash too, because that is how a link to one
 * is typed, and Pages' redirect to the slash is a network answer.
 *
 * The worker is a plain script with two placeholders the build fills in, so it
 * is run here as the build emits it, in a context with only what it touches.
 */

import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'

import { describe, expect, it } from 'vitest'

/** The worker as served at `scope`: whether it answers a navigation to `path` itself. */
function worker(scope: string): (path: string) => boolean {
  const listeners: Record<string, (event: unknown) => void> = {}
  const self = {
    location: { href: `${scope}sw.js`, origin: new URL(scope).origin },
    addEventListener: (type: string, listener: (event: unknown) => void) => {
      listeners[type] = listener
    },
  }
  const source = readFileSync(new URL('../../src/sw.js', import.meta.url), 'utf8')
    .replace('__CACHE_NAME__', JSON.stringify('chromosomix-test'))
    .replace('__PRECACHE__', JSON.stringify([new URL('index.html', scope).pathname]))
  runInNewContext(source, {
    self,
    caches: { match: async () => undefined },
    fetch: async () => undefined,
    Response: class {},
    URL,
    Set,
    Promise,
  })
  return (path) => {
    let answered = false
    listeners.fetch?.({
      request: { method: 'GET', mode: 'navigate', url: new URL(path, scope).href },
      respondWith: () => {
        answered = true
      },
    })
    return answered
  }
}

describe('a navigation', () => {
  const answers = worker('https://chromosomix.app/')

  it('into the app is answered with the cached shell', () => {
    for (const path of ['/', '/index.html', '/?config=x', '/evaluations/', '/timingsheet']) {
      expect(answers(path), path).toBe(true)
    }
  })

  it('to an archived build or a preview is left to the network', () => {
    for (const path of ['/v/5bbff1e/', '/v/5bbff1e/index.html', '/pr/12/']) {
      expect(answers(path), path).toBe(false)
    }
  })

  it('to a rendered notebook is left to the network, with or without its slash', () => {
    for (const path of ['/evaluation/', '/evaluation', '/evaluation/index.html', '/timings/', '/timings']) {
      expect(answers(path), path).toBe(false)
    }
  })

  it('is read against the scope the worker is served from', () => {
    const below = worker('https://example.github.io/chromosomix/')
    expect(below('/chromosomix/')).toBe(true)
    expect(below('/chromosomix/evaluation/')).toBe(false)
    expect(below('/chromosomix/timings')).toBe(false)
  })
})
