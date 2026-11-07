/**
 * How the service worker fills its cache, and when it takes over without
 * waiting to be asked.
 *
 * The bug this holds: a worker filled its cache through the browser's HTTP
 * cache, and the app's page, the one file in it that is not content-hashed,
 * came back as the build before's whenever the browser had fetched it in the
 * last ten minutes (GitHub Pages' `max-age`). The worker then answered every
 * ordinary load with a page asking for scripts that had left the site: a blank
 * page, and the app on a hard reload, which skips the worker. So the install
 * asks the server for every file, refuses a page that loads a script this build
 * does not have, and takes over at once from a worker already in that state,
 * whose page cannot start and therefore cannot offer the update.
 *
 * The worker is a plain script with two placeholders the build fills in, run
 * here as the build emits it, against a server and a cache that are maps.
 */

import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'

import { describe, expect, it } from 'vitest'

const SCOPE = 'https://chromosomix.app/'
const CACHE = 'chromosomix-0.22.0-new'

/** A page as the build writes it: the entry module and its stylesheet. */
function page(entry: string, css = 'index-Cy5f_JUV.css', base = '/'): string {
  return `<!doctype html><html><head><meta charset="utf-8" />
    <title>chromosomix</title>
    <link rel="manifest" href="${base}manifest.webmanifest" />
    <script type="module" crossorigin src="${base}assets/${entry}"></script>
    <link rel="stylesheet" crossorigin href="${base}assets/${css}">
  </head><body><noscript><p>It needs JavaScript.</p></noscript><div id="app"></div></body></html>`
}

/** This build: its page leads the list, as `precacheUrls` writes it. */
const PRECACHE = ['/', '/assets/index-NEW.js', '/assets/index-Cy5f_JUV.css', '/assets/reader.worker-R.js', '/icon-192.png']

/** What the server answers, path by path: this build, unless a test says otherwise. */
function site(overrides: Record<string, string | number> = {}): Record<string, string | number> {
  return {
    '/': page('index-NEW.js'),
    '/assets/index-NEW.js': 'console.log("new")',
    '/assets/index-Cy5f_JUV.css': 'body{}',
    '/assets/reader.worker-R.js': 'self.onmessage=()=>{}',
    '/icon-192.png': 'png',
    ...overrides,
  }
}

/** One cache, as the Cache API keeps it: every match is a fresh response. */
class FakeCache {
  entries = new Map<string, { body: string; status: number }>()
  private key(request: string | Request): string {
    return new URL(typeof request === 'string' ? request : request.url, SCOPE).href
  }
  async put(request: string | Request, response: Response): Promise<void> {
    this.entries.set(this.key(request), { body: await response.text(), status: response.status })
  }
  async match(request: string | Request): Promise<Response | undefined> {
    const entry = this.entries.get(this.key(request))
    return entry === undefined ? undefined : new Response(entry.body, { status: entry.status })
  }
  async keys(): Promise<Request[]> {
    return [...this.entries.keys()].map((url) => new Request(url))
  }
  async delete(request: string | Request): Promise<boolean> {
    return this.entries.delete(this.key(request))
  }
}

class FakeStorage {
  caches = new Map<string, FakeCache>()
  async keys(): Promise<string[]> {
    return [...this.caches.keys()]
  }
  async open(name: string): Promise<FakeCache> {
    if (!this.caches.has(name)) this.caches.set(name, new FakeCache())
    return this.caches.get(name)!
  }
  async delete(name: string): Promise<boolean> {
    return this.caches.delete(name)
  }
  async match(request: string | Request): Promise<Response | undefined> {
    for (const cache of this.caches.values()) {
      const found = await cache.match(request)
      if (found !== undefined) return found
    }
    return undefined
  }
  /** A cache an earlier worker filled, from paths to bodies. */
  async seed(name: string, files: Record<string, string>): Promise<void> {
    const cache = await this.open(name)
    for (const [path, body] of Object.entries(files)) await cache.put(path, new Response(body))
  }
}

interface Window {
  url: string
  navigated: string[]
}

/** The worker, loaded with this build's list, against `server`, `storage` and these windows. */
function worker(server: Record<string, string | number>, storage: FakeStorage, windows: Window[] = []) {
  const listeners: Record<string, (event: unknown) => void> = {}
  const requested: Request[] = []
  let skipped = 0
  const self = {
    location: { href: `${SCOPE}sw.js`, origin: new URL(SCOPE).origin },
    addEventListener: (type: string, listener: (event: unknown) => void) => {
      listeners[type] = listener
    },
    skipWaiting: async () => {
      skipped += 1
    },
    clients: {
      matchAll: async () =>
        windows.map((window) => ({
          url: window.url,
          navigate: async (url: string) => {
            window.navigated.push(url)
            return null
          },
        })),
      claim: async () => {},
    },
  }
  const fetch = async (request: Request): Promise<Response> => {
    requested.push(request)
    const answer = server[new URL(request.url).pathname] ?? 404
    return typeof answer === 'number'
      ? new Response('<!doctype html><h1>404 File not found</h1>', { status: answer })
      : new Response(answer, { status: 200 })
  }
  const source = readFileSync(new URL('../../src/sw.js', import.meta.url), 'utf8')
    .replace('__CACHE_NAME__', JSON.stringify(CACHE))
    .replace('__PRECACHE__', JSON.stringify(PRECACHE))
  runInNewContext(source, { self, caches: storage, fetch, Request: class extends Request {
    constructor(input: string | Request, init?: RequestInit) {
      super(typeof input === 'string' ? new URL(input, SCOPE) : input, init)
    }
  }, Response, URL, Set, Promise })

  const run = async (type: 'install' | 'activate'): Promise<void> => {
    let work: Promise<unknown> = Promise.resolve()
    listeners[type]?.({ waitUntil: (promise: Promise<unknown>) => (work = promise) })
    await work
  }
  return { install: () => run('install'), activate: () => run('activate'), requested, skipped: () => skipped }
}

describe('installing', () => {
  it('asks the server for every file, never the HTTP cache, and stores them all', async () => {
    const storage = new FakeStorage()
    const sw = worker(site(), storage)
    await sw.install()
    expect(sw.requested.map((request) => new URL(request.url).pathname)).toEqual(PRECACHE)
    for (const request of sw.requested) expect(request.cache, request.url).toBe('no-cache')
    const cache = storage.caches.get(CACHE)!
    for (const path of PRECACHE) expect(await cache.match(path), path).toBeDefined()
    expect(await (await cache.match('/'))!.text()).toContain('/assets/index-NEW.js')
  })

  it('refuses the build before’s page and stores nothing', async () => {
    const storage = new FakeStorage()
    const sw = worker(site({ '/': page('index-OLD.js') }), storage)
    await expect(sw.install()).rejects.toThrow(/not this build's: it loads \/assets\/index-OLD\.js/)
    expect(await storage.keys()).toEqual([])
  })

  it('refuses a page that loads no script at all, and stores nothing', async () => {
    const storage = new FakeStorage()
    const sw = worker(site({ '/': '<!doctype html><title>Sign in to the network</title><p>Accept</p>' }), storage)
    await expect(sw.install()).rejects.toThrow(/loads no script/)
    expect(await storage.keys()).toEqual([])
  })

  it('fails, and stores nothing, when a file does not answer', async () => {
    const storage = new FakeStorage()
    const sw = worker(site({ '/assets/reader.worker-R.js': 404 }), storage)
    await expect(sw.install()).rejects.toThrow('/assets/reader.worker-R.js answered 404')
    expect(await storage.keys()).toEqual([])
  })

  it('takes a page that loads another origin’s script beside this build’s', async () => {
    const storage = new FakeStorage()
    const shell = page('index-NEW.js').replace('</head>', '<script src="https://example.org/x.js"></script></head>')
    await worker(site({ '/': shell }), storage).install()
    expect(storage.caches.has(CACHE)).toBe(true)
  })

  it('reads the page against the scope it is served from', async () => {
    const scoped = page('index-NEW.js', 'index-Cy5f_JUV.css', '/chromosomix/')
    const storage = new FakeStorage()
    // At the root, this page's script is not this build's.
    await expect(worker(site({ '/': scoped }), storage).install()).rejects.toThrow(/not this build's/)
  })
})

describe('taking over', () => {
  it('waits on a first install, with nothing to replace', async () => {
    const sw = worker(site(), new FakeStorage())
    await sw.install()
    expect(sw.skipped()).toBe(0)
  })

  it('waits when the worker it replaces can start its page', async () => {
    const storage = new FakeStorage()
    await storage.seed('chromosomix-0.21.0-old', {
      '/': page('index-OLD.js'),
      '/assets/index-OLD.js': 'console.log("old")',
      '/assets/index-Cy5f_JUV.css': 'body{}',
    })
    const sw = worker(site(), storage)
    await sw.install()
    expect(sw.skipped()).toBe(0)
  })

  it('takes over at once from a worker whose page loads a script its cache does not hold', async () => {
    // What the HTTP cache made: the worker of build B holding build A's page.
    const storage = new FakeStorage()
    await storage.seed('chromosomix-0.21.0-old', {
      '/': page('index-OLDER.js'),
      '/assets/index-OLD.js': 'console.log("old")',
      '/assets/index-Cy5f_JUV.css': 'body{}',
    })
    const sw = worker(site(), storage)
    await sw.install()
    expect(sw.skipped()).toBe(1)
  })

  it('still waits when it cannot itself be installed', async () => {
    const storage = new FakeStorage()
    await storage.seed('chromosomix-0.21.0-old', { '/': page('index-OLDER.js') })
    const sw = worker(site({ '/': page('index-OLD.js') }), storage)
    await expect(sw.install()).rejects.toThrow()
    expect(sw.skipped()).toBe(0)
  })
})

describe('activating', () => {
  it('reloads the app’s pages it took over from a worker that could not start them, and nothing else', async () => {
    const storage = new FakeStorage()
    await storage.seed('chromosomix-0.21.0-old', { '/': page('index-OLDER.js') })
    const app: Window = { url: `${SCOPE}?config=x#map`, navigated: [] }
    const text: Window = { url: `${SCOPE}llms.txt`, navigated: [] }
    const sw = worker(site(), storage, [app, text])
    await sw.install()
    await sw.activate()
    expect(app.navigated).toEqual([app.url])
    expect(text.navigated).toEqual([])
    expect(await storage.keys()).toEqual([CACHE])
  })

  it('reloads nothing when the worker it replaced was well', async () => {
    const storage = new FakeStorage()
    await storage.seed('chromosomix-0.21.0-old', {
      '/': page('index-OLD.js'),
      '/assets/index-OLD.js': 'console.log("old")',
    })
    const app: Window = { url: SCOPE, navigated: [] }
    const sw = worker(site(), storage, [app])
    await sw.install()
    await sw.activate()
    expect(app.navigated).toEqual([])
    expect(await storage.keys()).toEqual([CACHE])
  })
})

describe('the page the build writes', () => {
  it('loads one script, the entry, so that what the worker reads of the built page is all of it', () => {
    // The worker checks that every same-origin script the page loads is in this
    // build's list. Vite turns this one into a hashed chunk, which always is; a
    // second `<script src>` here — a file from `public/`, say — would not be,
    // and every install would be refused: no offline, and nothing on screen.
    const html = readFileSync(new URL('../../index.html', import.meta.url), 'utf8')
    const scripts = [...html.matchAll(/<script\b[^>]*?\ssrc\s*=\s*["']([^"']+)["']/gi)].map((match) => match[1])
    expect(scripts).toEqual(['/src/main.ts'])
  })
})
