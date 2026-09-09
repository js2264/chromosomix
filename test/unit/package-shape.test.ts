/**
 * What the copy that goes to npm is allowed to look like.
 *
 * The rules `scripts/check-package-build.mjs` applies, held here because each of
 * them exists to catch a change that builds cleanly, packs cleanly and is wrong
 * — and because a published version is the one artifact in this repository that
 * cannot be corrected. An archived build is rebuilt over on the next push and a
 * deploy is redeployed; a tarball is on the registry for ever, mirrored by every
 * CDN that has seen it, and pinned in the lockfile of whoever installed it that
 * week.
 *
 * The expensive one is the base. It is `./` in `vite.package.config.ts` because
 * a tarball is unpacked into paths nobody can know at build time, and the whole
 * value of the channel is that one published version serves all of them. A build
 * that went back to absolute URLs would work perfectly at the site root — which
 * is where it is tested — and 404 everywhere it is actually used.
 *
 * The one behind it is that `dist/` is written by two builds and only one of
 * them may be published, so the rules have to be able to tell a site build from
 * a package build by looking at what came out.
 */

import { describe, expect, it } from 'vitest'

import {
  SIZE_LIMIT,
  packageFileProblems,
  packageIndexProblems,
} from '../../scripts/package-shape.mjs'

/** What the build actually emits today, as the walk reports it. */
const GOOD = [
  { name: 'index.html', size: 3_500 },
  { name: 'icon-192.png', size: 10_600 },
  { name: 'assets/index-C15U3eta.js', size: 371_000 },
  { name: 'assets/index-BlXroeTc.css', size: 45_000 },
  { name: 'assets/hdf5_hl-8FoHa7pu.js', size: 4_784_000 },
  { name: 'assets/reader.worker-Dv1hKUto.js', size: 66_000 },
  { name: 'assets/annotations.worker-DJBECroM.js', size: 99_000 },
]

describe('packageFileProblems', () => {
  it('passes the build as it is emitted today', () => {
    expect(packageFileProblems(GOOD)).toEqual([])
  })

  it('refuses the two things a site build leaves behind', () => {
    // Together, these are the signature of `npm run build` having written this
    // directory — which is the mistake `prepack` exists to make impossible and
    // this exists to catch if it ever stops.
    const problems = packageFileProblems([
      ...GOOD,
      { name: 'sw.js', size: 4_000 },
      { name: 'manifest.webmanifest', size: 500 },
    ])
    expect(problems).toHaveLength(2)
    expect(problems.join(' ')).toContain('scope')
    expect(problems.join(' ')).toContain('installable')
  })

  it('refuses source maps, which are ~20 MB on everybody who installs it', () => {
    expect(packageFileProblems([...GOOD, { name: 'assets/index.js.map', size: 1 }])).toHaveLength(1)
  })

  it('refuses the demo data twice over', () => {
    // `publicDir` left on. Both rules fire — the file is data, and the build is
    // now past the cap — and both are printed, because an operator reading "too
    // big" and one reading "demo/ is data" reach for different fixes.
    const problems = packageFileProblems([...GOOD, { name: 'demo/Ecoli.mcool', size: 45_619_825 }])
    expect(problems).toHaveLength(2)
    expect(problems[0]).toContain('demo')
    expect(problems[1]).toContain('cap')
  })

  it('refuses a data file wherever it is and whatever it is called', () => {
    for (const name of ['Yeast_annotations.gtf', 'assets/loops.tsv', 'x.bw']) {
      expect(packageFileProblems([...GOOD, { name, size: 10 }])).toHaveLength(1)
    }
  })

  it('says what is missing rather than passing an empty build', () => {
    // A build that emitted nothing at all is the failure that reads most like
    // success: no file breaks a rule, because there are no files.
    const problems = packageFileProblems([])
    expect(problems).toHaveLength(2)
    expect(problems[0]).toContain('index.html')
    expect(problems[1]).toContain('icon-192.png')
  })

  it('has a cap that admits the build and refuses one with its maps', () => {
    const built = GOOD.reduce((sum, file) => sum + file.size, 0)
    expect(built).toBeLessThan(SIZE_LIMIT)
    expect(packageFileProblems([...GOOD, { name: 'assets/big', size: SIZE_LIMIT }])).toContainEqual(
      expect.stringContaining('cap'),
    )
  })
})

const HTML =
  '<!doctype html><link rel="icon" href="data:image/svg+xml,%3Csvg/%3E" />' +
  '<script type="module" src="./assets/index-C15U3eta.js"></script>' +
  '<link rel="stylesheet" href="./assets/index-BlXroeTc.css" />'

describe('packageIndexProblems', () => {
  it('passes the document as it is emitted today', () => {
    expect(packageIndexProblems(HTML)).toEqual([])
  })

  it('refuses a document built for the site root', () => {
    // The single most expensive regression available here, and the one that is
    // invisible to whoever makes it: an absolute base is correct on the site,
    // which is the only place a maintainer ever loads it.
    const problems = packageIndexProblems(HTML.replaceAll('./assets/', '/metacooler.js/assets/'))
    expect(problems).toHaveLength(3)
    expect(problems[0]).toContain('relative')
    expect(problems.slice(1).join(' ')).toContain('root-absolute')
  })

  it('refuses a root-absolute reference beside relative ones', () => {
    // How it would actually arrive: not a changed base, but one hand-written
    // path in `index.html`. It resolves — against whatever the *host* site
    // serves there — which is what makes it worse than a 404.
    const problems = packageIndexProblems(`${HTML}<link rel="preload" href="/fonts/x.woff2" />`)
    expect(problems).toHaveLength(1)
    expect(problems[0]).toContain('/fonts/x.woff2')
  })

  it('refuses the manifest and the touch icon a site build links', () => {
    const problems = packageIndexProblems(
      `${HTML}<link rel="manifest" href="./manifest.webmanifest" />` +
        '<link rel="apple-touch-icon" href="./apple-touch-icon.png" />',
    )
    expect(problems).toHaveLength(2)
    expect(problems.join(' ')).toContain('stripPwaTags')
  })

  it('says so when there is no module script at all', () => {
    expect(packageIndexProblems('<!doctype html><title>nothing</title>')).toHaveLength(1)
  })
})
