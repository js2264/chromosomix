/**
 * The rules a standalone build has to satisfy, held where they can be asserted
 * without running a build.
 *
 * Every one of them exists because its failure is **silent**, and the tests are
 * written from that end: each names the symptom an operator would see if the
 * rule were missing. A page that references a sibling chunk opens, paints its
 * shell and does nothing. One built with module workers opens and looks
 * completely normal until a file is dropped on it. Neither produces an error
 * anybody is watching for, and the person who finds out is on an air-gapped
 * machine with no way to report it.
 */

import { describe, expect, it } from 'vitest'

import {
  STANDALONE_MAX_BYTES,
  STANDALONE_MIN_BYTES,
  standaloneFileProblems,
  standaloneIndexProblems,
} from '../../scripts/standalone-shape.mjs'

/** The smallest HTML that satisfies every rule, for a test to break one at a time. */
const GOOD =
  '<!doctype html><html><head><title>t</title></head><body>' +
  '<script type="module">const w=new Worker(URL.createObjectURL(b));/*standalone*/</script>' +
  '</body></html>'

describe('the built page', () => {
  it('accepts one that is genuinely self-contained', () => {
    expect(standaloneIndexProblems(GOOD)).toEqual([])
  })

  it('refuses an external script, which is a page that never starts', () => {
    const html = GOOD.replace('<script type="module">', '<script type="module" src="./assets/i.js">')
    expect(standaloneIndexProblems(html).join(' ')).toMatch(/external <script src>/)
  })

  it('refuses an external stylesheet', () => {
    const html = GOOD.replace('</head>', '<link rel="stylesheet" href="./assets/s.css"></head>')
    expect(standaloneIndexProblems(html).join(' ')).toMatch(/external stylesheet/)
  })

  it('refuses a root-absolute reference, which on a disk means the filesystem root', () => {
    const html = GOOD.replace('</head>', '<link rel="icon" href="/icon-192.png"></head>')
    expect(standaloneIndexProblems(html).join(' ')).toMatch(/root-absolute/)
  })

  it('refuses the PWA tags, which point into a public/ this target never emits', () => {
    expect(
      standaloneIndexProblems(GOOD.replace('</head>', '<link rel="manifest" href="m.json"></head>')).join(' '),
    ).toMatch(/manifest/)
    expect(
      standaloneIndexProblems(
        GOOD.replace('</head>', '<link rel="apple-touch-icon" href="a.png"></head>'),
      ).join(' '),
    ).toMatch(/apple-touch-icon/)
  })

  it('refuses a module worker — the failure that looks like a working build', () => {
    // This is the one worth having. Everything else about such a build is
    // correct; it opens, it paints, and it has no reader behind it.
    const html = GOOD.replace(
      'new Worker(URL.createObjectURL(b))',
      'new Worker(u,{type:"module"});URL.createObjectURL',
    )
    expect(standaloneIndexProblems(html).join(' ')).toMatch(/module worker/)
  })

  it('refuses a page with no blob-worker construction in it at all', () => {
    const html = GOOD.replace('URL.createObjectURL(b)', 'u')
    expect(standaloneIndexProblems(html).join(' ')).toMatch(/blob-URL worker/)
  })

  it('refuses a build that does not say which target it is', () => {
    const html = GOOD.replace('/*standalone*/', '')
    expect(standaloneIndexProblems(html).join(' ')).toMatch(/does not identify itself/)
  })

  it('reports every problem, not the first', () => {
    // An operator has to fix them all, and a check that names one of four turns
    // one build into four.
    const html = '<html><head><link rel="manifest" href="m"></head><body><script src="./a.js"></script></body></html>'
    expect(standaloneIndexProblems(html).length).toBeGreaterThanOrEqual(3)
  })
})

describe('the built directory', () => {
  const ok = [{ path: 'index.html', size: 8 * 1024 * 1024 }]

  it('accepts exactly one file of a plausible size', () => {
    expect(standaloneFileProblems(ok)).toEqual([])
  })

  it('refuses a second file, which is the whole promise of the target', () => {
    const problems = standaloneFileProblems([...ok, { path: 'assets/i.js', size: 10 }])
    expect(problems.join(' ')).toMatch(/not one file.*assets\/i\.js/)
  })

  it('refuses one too small to contain the app', () => {
    // h5wasm alone is over four megabytes, so a tidy little file is a build
    // whose inlining silently did nothing.
    const problems = standaloneFileProblems([{ path: 'index.html', size: 400_000 }])
    expect(problems.join(' ')).toMatch(/inlining did not happen/)
    expect(STANDALONE_MIN_BYTES).toBeGreaterThan(1_000_000)
  })

  it('refuses one too large to send anybody', () => {
    const problems = standaloneFileProblems([
      { path: 'index.html', size: STANDALONE_MAX_BYTES + 1 },
    ])
    expect(problems.join(' ')).toMatch(/past the/)
  })

  it('refuses a build with no index.html, and says only that', () => {
    expect(standaloneFileProblems([{ path: 'assets/i.js', size: 10 }])).toEqual([
      'index.html is missing',
    ])
  })
})
