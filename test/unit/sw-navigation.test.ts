/**
 * Which navigations the service worker answers with the app, and which it
 * leaves to the network.
 *
 * It answers the app's own address and nothing else: the scope directory, and
 * `index.html` as its alias, whatever query they carry — every view lives in
 * the hash, and every option a link takes in the query, so one document serves
 * them all. Every other address in its scope is a different document, and
 * answered with the shell it shows this build at that address: `llms.txt` and
 * the files beside it, an archived build at `v/<commit>/`, a pull request's
 * preview at `pr/<n>/`, the rendered notebooks, and an address that is nothing,
 * which must be the host's 404 rather than the landing page.
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

  it('into the app is answered with the cached shell, whatever its query', () => {
    for (const path of ['/', '/index.html', '/?config=x', '/?embed=1#map', '/index.html?store=y']) {
      expect(answers(path), path).toBe(true)
    }
  })

  it('to a file beside the app is left to the network', () => {
    for (const path of ['/llms.txt', '/llms-full.txt', '/llms/links.md', '/robots.txt', '/sitemap.xml',
      '/THIRD-PARTY-NOTICES.txt', '/manifest.webmanifest', '/sw.js']) {
      expect(answers(path), path).toBe(false)
    }
  })

  it('to an address that is nothing is left to the network, so the host can say 404', () => {
    for (const path of ['/asdcasdc', '/asdcasdc/', '/index.htm', '/validations/', '/timingsheet']) {
      expect(answers(path), path).toBe(false)
    }
  })

  it('to an archived build or a preview is left to the network', () => {
    for (const path of ['/v/5bbff1e/', '/v/5bbff1e/index.html', '/pr/12/']) {
      expect(answers(path), path).toBe(false)
    }
  })

  it('to a rendered notebook is left to the network, with or without its slash', () => {
    for (const path of ['/validation/', '/validation', '/validation/index.html', '/timings/', '/timings', '/parity/', '/parity',
      '/laptop/', '/laptop']) {
      expect(answers(path), path).toBe(false)
    }
  })

  it('is read against the scope the worker is served from', () => {
    const below = worker('https://example.github.io/chromosomix/')
    expect(below('/chromosomix/')).toBe(true)
    expect(below('/chromosomix/index.html')).toBe(true)
    expect(below('/chromosomix/?config=x')).toBe(true)
    expect(below('/chromosomix')).toBe(false)
    expect(below('/chromosomix/llms.txt')).toBe(false)
    expect(below('/chromosomix/validation/')).toBe(false)
    expect(below('/chromosomix/timings')).toBe(false)
    expect(below('/chromosomix/parity/')).toBe(false)
    expect(below('/chromosomix/laptop')).toBe(false)
    expect(below('/')).toBe(false)
  })
})
