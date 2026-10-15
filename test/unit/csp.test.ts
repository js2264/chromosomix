/**
 * The Content-Security-Policy the web builds carry and the one the single file
 * computes over itself (`scripts/csp.mjs`, SPECS §11, §19).
 *
 * A policy fails in the browser, silently and late: a clause too strict is a
 * feature that stops working with one line on a console nobody has open, and a
 * clause too loose is a protection that was never there. So the clauses are
 * pinned one by one, against the reason each exists — and against the
 * desktop's, which is the same app's policy delivered as a header, so that the
 * two can differ only where this file says they should.
 */

import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

import {
  WEB_CSP,
  WEB_CSP_DIRECTIVES,
  cspMeta,
  cspMetaTag,
  cspOf,
  hashSource,
  inlineElements,
  standaloneCsp,
  standaloneCspProblems,
  webCspProblems,
  withCsp,
  withStandaloneCsp,
} from '../../scripts/csp.mjs'

/** A policy as a map from directive to its sources. */
function directives(policy: readonly string[] | string): Map<string, string[]> {
  const list = typeof policy === 'string' ? policy.split(';') : policy
  return new Map(
    list.map((directive) => {
      const [name, ...sources] = directive.trim().split(/\s+/)
      return [name, sources]
    }),
  )
}

const WEB = directives(WEB_CSP_DIRECTIVES)

/**
 * The desktop's policy, which delivers the same app's as a header
 * (`electron/protocol.cts`). Read as text, because the main process is a
 * separate TypeScript project; the list there is plain string literals.
 */
const DESKTOP = (() => {
  const source = readFileSync(new URL('../../electron/protocol.cts', import.meta.url), 'utf8')
  const block = /export const CSP = \[([\s\S]*?)\]\.join/.exec(source)?.[1] ?? ''
  return directives([...block.matchAll(/"([^"]+)"/g)].map((match) => match[1]))
})()

/** The repository's own `index.html`, which every web build starts from. */
const SOURCE = readFileSync(new URL('../../index.html', import.meta.url), 'utf8')

describe('the web builds’ policy', () => {
  it('lets h5wasm and the correlation kernel compile, and nothing evaluate', () => {
    expect(WEB.get('script-src')).toContain("'wasm-unsafe-eval'")
    expect(WEB_CSP).not.toContain("'unsafe-eval'")
    expect(WEB_CSP).not.toContain("'unsafe-inline'")
  })

  it('admits Google Identity Services by exactly the sources Google documents', () => {
    expect(WEB.get('script-src')).toContain('https://accounts.google.com/gsi/client')
    expect(WEB.get('style-src')).toContain('https://accounts.google.com/gsi/style')
    expect(WEB.get('frame-src')).toEqual(['https://accounts.google.com/gsi/'])
    expect(WEB.get('connect-src')).toContain('https://accounts.google.com/gsi/')
  })

  it('reaches any https host and the loopback over plain http, and no other http host', () => {
    expect(WEB.get('connect-src')).toEqual([
      "'self'",
      'data:',
      'https:',
      'http://localhost:*',
      'http://127.0.0.1:*',
      'https://accounts.google.com/gsi/',
    ])
    expect(WEB.get('connect-src')).not.toContain('http:')
  })

  it('takes workers, the service worker and the manifest from itself, and no worker from a blob', () => {
    expect(WEB.get('worker-src')).toEqual(["'self'"])
    expect(WEB.get('manifest-src')).toEqual(["'self'"])
    expect(WEB.get('img-src')).toEqual(["'self'", 'data:', 'blob:'])
  })

  it('refuses everything it does not name, and leaves the page frameable', () => {
    expect(WEB.get('default-src')).toEqual(["'none'"])
    for (const shut of ['object-src', 'base-uri', 'form-action']) expect(WEB.get(shut)).toEqual(["'none'"])
    // A meta cannot carry `frame-ancestors` and logs an error for trying, and an
    // embed (§21) is a frame in somebody else's page. `report-uri` and
    // `sandbox` are the other two a meta ignores.
    for (const ignored of ['frame-ancestors', 'report-uri', 'sandbox']) expect(WEB.has(ignored)).toBe(false)
  })

  it('is the desktop’s policy, plus Google’s sign-in, an install prompt and a frame', () => {
    expect(DESKTOP.size).toBeGreaterThan(8)
    const google = (sources: string[]): string[] => sources.filter((one) => !one.startsWith('https://accounts.google.com/'))
    for (const [name, sources] of WEB) {
      if (name === 'frame-src') continue
      if (name === 'manifest-src') {
        // The site is installable; an installed application is not.
        expect([sources, DESKTOP.get(name)]).toEqual([["'self'"], ["'none'"]])
        continue
      }
      expect([name, google(sources)]).toEqual([name, DESKTOP.get(name)])
    }
    // The one directive the desktop has and a meta cannot.
    expect([...DESKTOP.keys()].filter((name) => !WEB.has(name))).toEqual(['frame-ancestors'])
  })
})

describe('the bigWig reader’s wasm', () => {
  // `@gmod/bbi` inlines its inflate wasm as a `data:` URL and fetches it before
  // its first read, in the annotations worker. Wherever a policy reaches that
  // worker — the desktop's header, the single file's meta, which a worker built
  // from a blob inherits — a `connect-src` without `data:` refuses the fetch
  // there, where the page hears nothing, and every bigWig lane says
  // "fetching…" for good while the intervals beside it draw. Should the library
  // stop fetching it, this is the test that says the source can go.
  const loader = readFileSync(
    new URL('../../node_modules/@gmod/bbi/esm/wasm/inflate-wasm-inlined.js', import.meta.url),
    'utf8',
  )

  it('is fetched, from a data: URL', () => {
    const inlined = /const (\w+) = "data:application\/wasm;base64,/.exec(loader)?.[1]
    expect(inlined).toBeDefined()
    expect(loader).toContain(`fetch(${inlined})`)
  })

  it('is let through wherever a policy reaches the worker, and by the site’s, which is the desktop’s', () => {
    expect(DESKTOP.get('connect-src')).toContain('data:')
    expect(directives(standaloneCsp('<script>boot()</script>')).get('connect-src')).toEqual(['data:'])
    expect(WEB.get('connect-src')).toContain('data:')
  })
})

describe('placing it in the page', () => {
  const placed = withCsp(SOURCE, WEB_CSP)

  it('goes in right after the charset, ahead of everything it governs', () => {
    const charset = placed.indexOf('<meta charset="utf-8" />')
    const meta = placed.indexOf(cspMetaTag(WEB_CSP))
    expect(meta).toBeGreaterThan(charset)
    expect(placed.slice(charset, meta).trim()).toBe('<meta charset="utf-8" />')
    expect(meta).toBeLessThan(placed.search(/<(?:script|link|style)\b/))
    expect(cspOf(placed)).toEqual([WEB_CSP])
  })

  it('leaves the repository’s own page one the policy lets run', () => {
    // No inline script, no <style>, no style= — and the favicon's data URI,
    // which is SVG text, is not mistaken for a tag that carries one.
    expect(webCspProblems(placed)).toEqual([])
  })

  it('refuses a page it cannot place a policy in, and a page that has one', () => {
    expect(() => withCsp('<!doctype html><title>t</title>', WEB_CSP)).toThrow(/charset/)
    expect(() => withCsp(placed, WEB_CSP)).toThrow(/already carries/)
  })

  it('refuses a policy that would break out of its attribute', () => {
    expect(() => cspMetaTag('default-src "none"')).toThrow()
  })
})

describe('what a web build’s page may hold', () => {
  const page = withCsp('<!doctype html><head><meta charset="utf-8"></head><body></body>', WEB_CSP)

  it('passes a page with nothing for the policy to refuse', () => {
    expect(webCspProblems(page)).toEqual([])
  })

  it('refuses what the policy would refuse, before the browser does', () => {
    const add = (html: string): string => page.replace('<body>', `<body>${html}`)
    expect(webCspProblems(add('<script>boot()</script>'))).toEqual([
      'index.html has an inline <script>, which its policy refuses',
    ])
    expect(webCspProblems(add('<style>p{}</style>'))).toEqual([
      'index.html has a <style> element, which its policy refuses',
    ])
    expect(webCspProblems(add('<div style="color:red"></div>'))).toEqual([
      'index.html has a style= attribute, which its policy refuses',
    ])
    // An external script is what the policy is for, and passes.
    expect(webCspProblems(add('<script type="module" src="/assets/a.js"></script>'))).toEqual([])
  })

  it('refuses a policy placed after what it governs, or a second one', () => {
    const late = page
      .replace(cspMetaTag(WEB_CSP), '')
      .replace('</head>', `<script src="/a.js"></script>${cspMetaTag(WEB_CSP)}</head>`)
    expect(webCspProblems(late).join(' ')).toMatch(/comes after an element it governs/)
    const twice = page.replace('</head>', `${cspMetaTag("default-src 'none'")}</head>`)
    expect(webCspProblems(twice).join(' ')).toMatch(/2 Content-Security-Policy metas/)
  })
})

describe('the single file’s policy', () => {
  const raw =
    '<!doctype html><html><head><meta charset="utf-8">' +
    '<script type="module">const s = "<style>"; boot()</script>' +
    '<style>body{margin:0}</style></head><body><noscript>no</noscript></body></html>'

  it('names the hash of each inline script and stylesheet, and no origin', () => {
    const policy = directives(standaloneCsp(raw))
    expect(policy.get('script-src')).toEqual([
      hashSource('const s = "<style>"; boot()'),
      "'wasm-unsafe-eval'",
    ])
    expect(policy.get('style-src')).toEqual([hashSource('body{margin:0}')])
    expect(standaloneCsp(raw)).not.toContain("'self'")
    expect(standaloneCsp(raw)).not.toContain("'unsafe-inline'")
  })

  it('builds its workers from blobs, and reaches no host at all', () => {
    const policy = directives(standaloneCsp(raw))
    expect(policy.get('worker-src')).toEqual(['blob:'])
    expect(policy.get('connect-src')).toEqual(['data:'])
    expect(policy.get('img-src')).toEqual(['data:', 'blob:'])
  })

  it('reads a `<style` inside a script as script, not as an element', () => {
    // The single file's script is fourteen megabytes holding both strings.
    expect(inlineElements(raw)).toEqual({ scripts: ['const s = "<style>"; boot()'], styles: ['body{margin:0}'] })
  })

  it('hashes the text the parser hands over, not the bytes in the file', () => {
    // The input stream folds CR LF and a lone CR to LF, and a NUL in a script
    // becomes U+FFFD; a hash of the raw bytes would name a script nobody has.
    expect(hashSource('a\r\nb\rc')).toBe(hashSource('a\nb\nc'))
    expect(hashSource('a\0b')).toBe(hashSource('a\uFFFDb'))
    expect(hashSource('')).toBe("'sha256-47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU='")
  })

  it('passes the page it was computed over, and refuses it once the page moves on', () => {
    const page = withStandaloneCsp(raw)
    expect(standaloneCspProblems(page)).toEqual([])
    expect(standaloneCspProblems(page.replace('boot()', 'boot(1)')).join(' ')).toMatch(/does not name exactly/)
  })
})

describe('the plugin', () => {
  const plugin = cspMeta() as unknown as {
    apply: string
    transformIndexHtml: { handler: (html: string) => string }
    generateBundle: (this: { error: (message: string) => never }, options: unknown, bundle: unknown) => void
  }
  const context = {
    error(message: string): never {
      throw new Error(message)
    },
  }

  it('is a build’s alone: the dev server injects <style> elements and carries no policy', () => {
    expect(plugin.apply).toBe('build')
  })

  it('writes the policy into the page', () => {
    expect(cspOf(plugin.transformIndexHtml.handler(SOURCE))).toEqual([WEB_CSP])
  })

  it('refuses a build whose emitted page breaks it', () => {
    const emitted = (source: string): unknown => ({ 'index.html': { type: 'asset', source } })
    const good = withCsp(SOURCE, WEB_CSP)
    expect(() => plugin.generateBundle.call(context, {}, emitted(good))).not.toThrow()
    expect(() =>
      plugin.generateBundle.call(context, {}, emitted(good.replace('</body>', '<script>x()</script></body>'))),
    ).toThrow(/inline <script>/)
    expect(() => plugin.generateBundle.call(context, {}, {})).toThrow(/no index.html/)
  })
})
