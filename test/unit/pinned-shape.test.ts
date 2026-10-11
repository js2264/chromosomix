/**
 * What an archived build is allowed to look like.
 *
 * The rules `scripts/check-pinned-build.mjs` applies, held here because each of
 * them exists to catch a change that builds cleanly, deploys cleanly and is
 * wrong — and because an archived build is the artifact nobody opens for
 * months, so "wrong" is found by a reader in November rather than by CI in
 * August.
 *
 * The expensive one is `publicDir`. It is off in `vite.pinned.config.ts`, and
 * turning it back on is one line and a plausible fix for a missing icon; what
 * it does is put 250 MB of demo data into every archived commit, which
 * exhausts a 1 GB Pages site several deploys after the change that caused it.
 */

import { describe, expect, it } from 'vitest'

import { SIZE_LIMIT, pinnedFileProblems, pinnedIndexProblems } from '../../scripts/pinned-shape.mjs'

const BASE = '/chromosomix/v/a1b2c3d/'

/** What the build actually emits today, as the walk reports it. */
const GOOD = [
  { name: 'index.html', size: 3_700 },
  { name: 'icon-192.png', size: 10_600 },
  { name: 'assets/index-C15U3eta.js', size: 371_000 },
  { name: 'assets/index-BlXroeTc.css', size: 45_000 },
  { name: 'assets/hdf5_hl-8FoHa7pu.js', size: 4_784_000 },
  { name: 'assets/reader.worker-Dv1hKUto.js', size: 66_000 },
  { name: 'assets/annotations.worker-DJBECroM.js', size: 99_000 },
]

describe('pinnedFileProblems', () => {
  it('passes the build as it is emitted today', () => {
    expect(pinnedFileProblems(GOOD)).toEqual([])
  })

  it('refuses a build with the demo data in it, twice over', () => {
    // `publicDir` left on. Both rules fire — the file is data, and the build is
    // now four times the cap — and both are printed, because an operator
    // reading "too big" and an operator reading "demo/ is data" reach for two
    // different fixes and only the second one is right.
    const problems = pinnedFileProblems([...GOOD, { name: 'demo/Ecoli.mcool', size: 45_619_825 }])
    expect(problems).toHaveLength(2)
    expect(problems[0]).toContain('demo')
    expect(problems[1]).toContain('cap')
  })

  it('refuses a data file wherever it is and whatever it is called', () => {
    // The text formats are the ones to watch: a rule written around "binary is
    // data" takes a `.gtf` and a `.tsv` straight in.
    for (const name of ['Yeast_annotations.gtf', 'assets/loops.tsv', 'x.bw']) {
      expect(pinnedFileProblems([...GOOD, { name, size: 10 }])).toHaveLength(1)
    }
  })

  it('refuses source maps, which are ~13 MB nobody reads from an archive', () => {
    expect(pinnedFileProblems([...GOOD, { name: 'assets/index.js.map', size: 1 }])).toHaveLength(1)
  })

  it('refuses a service worker and a web manifest', () => {
    expect(pinnedFileProblems([...GOOD, { name: 'sw.js', size: 5_500 }])).toHaveLength(1)
    expect(pinnedFileProblems([...GOOD, { name: 'manifest.webmanifest', size: 600 }])).toHaveLength(1)
  })

  it('refuses a build missing the document or the mark', () => {
    expect(pinnedFileProblems(GOOD.filter((f) => f.name !== 'index.html'))).toHaveLength(1)
    // Not cosmetic: `markUrl()` asks for it from this build's own base, and
    // `publicDir` is off, so nothing else would put it there.
    expect(pinnedFileProblems(GOOD.filter((f) => f.name !== 'icon-192.png'))).toHaveLength(1)
  })

  it('refuses a build over the size cap, whatever made it big', () => {
    const problems = pinnedFileProblems([...GOOD, { name: 'assets/big.js', size: SIZE_LIMIT }])
    expect(problems).toHaveLength(1)
    expect(problems[0]).toContain('cap')
  })

  it('leaves room for the build to grow before it complains', () => {
    const total = GOOD.reduce((sum, file) => sum + file.size, 0)
    expect(total).toBeLessThan(SIZE_LIMIT / 2)
  })
})

const INDEX =
  `<!doctype html><html><head>` +
  `<link rel="icon" href="data:image/svg+xml,%3Csvg%3E"/>` +
  `<script type="module" crossorigin src="${BASE}assets/index-C15U3eta.js"></script>` +
  `<link rel="stylesheet" crossorigin href="${BASE}assets/index-BlXroeTc.css">` +
  `</head><body><div id="app"></div></body></html>`

describe('pinnedIndexProblems', () => {
  it('passes the document as it is emitted today', () => {
    expect(pinnedIndexProblems(INDEX, BASE)).toEqual([])
  })

  it('refuses a build made for another base, which is a blank page', () => {
    // What a missing or wrong PINNED_BASE produces. Every asset 404s, and
    // nothing is written anywhere a reader would look.
    const problems = pinnedIndexProblems(INDEX.split(BASE).join('/chromosomix/'), BASE)
    expect(problems.length).toBeGreaterThan(0)
    expect(problems[0]).toContain('module script')
  })

  it('refuses a reference to another build, which would resolve to the newest', () => {
    const problems = pinnedIndexProblems(
      INDEX.replace('</head>', '<link rel="preload" href="/chromosomix/assets/x.js"></head>'),
      BASE,
    )
    expect(problems).toHaveLength(1)
    expect(problems[0]).toContain('outside')
  })

  it('refuses the two tags that would make an archived build installable', () => {
    for (const tag of [
      '<link rel="manifest" href="/manifest.webmanifest">',
      '<link rel="apple-touch-icon" href="/apple-touch-icon.png">',
    ]) {
      // Two problems each: the tag, and its root-absolute reference.
      expect(pinnedIndexProblems(INDEX.replace('</head>', `${tag}</head>`), BASE).length)
        .toBeGreaterThan(0)
    }
  })

  it('keeps the favicon, which is a data URI and needs no file', () => {
    expect(pinnedIndexProblems(INDEX, BASE)).toEqual([])
    expect(INDEX).toContain('rel="icon" href="data:')
  })
})
