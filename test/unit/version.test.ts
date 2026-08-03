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
  repository?: { url?: string }
  engines?: { node?: string }
}
const changelog = readFileSync(new URL('CHANGELOG.md', root), 'utf8')

describe('the package', () => {
  it('carries a semantic version', () => {
    expect(pkg.version).toMatch(/^\d+\.\d+\.\d+(-[\w.]+)?$/)
  })

  it('is private, because what ships is a site and not a library', () => {
    expect(pkg.private).toBe(true)
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
