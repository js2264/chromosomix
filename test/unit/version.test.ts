/**
 * Release hygiene: the three places a version is written must agree.
 *
 * The version lives in `package.json` and is baked into the bundle from there,
 * so the app cannot disagree with the package. What *can* drift is everything
 * around it — a bump with no changelog entry, a changelog entry for a version
 * nobody released, a stamp that reads `0.0.0-dev` on a deployed page because
 * the `define` block was dropped. Each of those is invisible until someone asks
 * "which version am I running" and gets an answer that is not true.
 *
 * The `define` substitution itself is not exercised here: vitest does not apply
 * the app's vite config, so what these assertions see is the *fallback* path —
 * which is the one that has to survive a build with no git and a test run with
 * no defines, and is therefore worth pinning on its own.
 */

import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

import { COMMIT, COMMIT_DATE, PRODUCER, VERSION, buildLine } from '@/version'

const root = new URL('../../', import.meta.url)
const pkg = JSON.parse(readFileSync(new URL('package.json', root), 'utf8')) as {
  version: string
  private?: boolean
  files?: string[]
  bin?: Record<string, string>
  scripts?: Record<string, string>
  license?: string
  repository?: { url?: string }
  engines?: { node?: string }
}
const changelog = readFileSync(new URL('CHANGELOG.md', root), 'utf8')

describe('the package', () => {
  it('carries a semantic version', () => {
    expect(pkg.version).toMatch(/^\d+\.\d+\.\d+(-[\w.]+)?$/)
  })

  it('is publishable, and ships two directories and no more', () => {
    // This was `private: true` until the viewer became embeddable (§21) and the
    // question "whose hosting does an embed depend on" needed a second answer
    // (§22). What replaced the flag is the allowlist, which is doing far more
    // work than the flag ever did: npm's default is *everything not ignored by
    // git*, and this repository carries 250 MB of demo data.
    expect(pkg.private).toBeUndefined()
    expect(pkg.files).toEqual(['dist', 'dist-cli'])
  })

  it('builds what it packs, rather than packing what is there', () => {
    // `dist/` is written by two builds and only one of them may be published.
    // Without this hook, a tarball takes whatever a developer last built — for
    // the site, that is absolute asset URLs that 404 on every mount but the
    // site root, and 20 MB of source maps.
    expect(pkg.scripts?.prepack).toBe('npm run build:package')
    // The package build is one step down the chain: `build:cli` runs it, because
    // `metacooler-plot` serves that same relative-base copy of the viewer
    // (SPECS §27) — and the check runs last, over what the chain wrote.
    const chain = [pkg.scripts?.['build:package'], pkg.scripts?.['build:cli']].join(' && ')
    expect(pkg.scripts?.['build:package']).toContain('npm run build:cli')
    expect(chain).toContain('vite.package.config.ts')
    expect(pkg.scripts?.['build:package']).toContain('check-package-build.mjs')
  })

  it('ships every command it names, each beside the viewer the plot command serves', () => {
    // Two commands (SPECS §27): the second draws with the viewer in `dist/`,
    // so a tarball carrying the command and not the viewer would install a
    // command that refuses to start.
    expect(Object.keys(pkg.bin ?? {}).sort()).toEqual(['metacooler-plot', 'metacooler-run'])
    expect(pkg.files).toContain('dist')
  })

  it('declares no command that the tarball does not carry', () => {
    // A `bin` outside `files` is a symlink to nothing on everybody's PATH, and
    // npm reports it as a successful install.
    for (const target of Object.values(pkg.bin ?? {})) {
      const top = target.replace(/^\.\//, '').split('/')[0] as string
      expect(pkg.files).toContain(top)
    }
  })

  it('carries the licence it claims', () => {
    // npm shows a package's licence, and a tarball that declares MIT without
    // the text is asking to be taken on trust.
    expect(pkg.license).toBe('MIT')
    expect(readFileSync(new URL('LICENSE', root), 'utf8')).toContain('MIT License')
  })

  it('says where it lives and what it needs', () => {
    expect(pkg.repository?.url).toContain('github.com/js2264/metacooler.js')
    expect(pkg.engines?.node).toBeTruthy()
  })
})

describe('the changelog', () => {
  it('documents the version the package claims to be', () => {
    // The same check `npm version` runs before it will make a release commit;
    // here it also catches the reverse mistake, a bump that never happened.
    expect(changelog).toContain(`## [${pkg.version}]`)
  })

  it('has one section per version, newest first', () => {
    const versions = [...changelog.matchAll(/^## \[(\d+\.\d+\.\d+)\]/gm)].map((m) => m[1])
    expect(versions.length).toBeGreaterThan(0)
    expect(versions[0]).toBe(pkg.version)
    expect(new Set(versions).size).toBe(versions.length)
  })
})

describe('the build stamp', () => {
  it('falls back rather than throwing when nothing was substituted', () => {
    // `typeof` on an undeclared identifier is legal and does not throw; this is
    // the property that keeps a test run and a tarball build working.
    expect(VERSION).toBe('0.0.0-dev')
    expect(COMMIT).toBe('')
    expect(COMMIT_DATE).toBe('')
  })

  it('names the producer for anything that has to say what made it', () => {
    expect(PRODUCER).toBe('(meta)cooler 0.0.0-dev')
  })

  it('omits the parts it does not know instead of writing empty ones', () => {
    expect(buildLine()).toBe('0.0.0-dev')
    expect(buildLine()).not.toContain('·')
  })
})
