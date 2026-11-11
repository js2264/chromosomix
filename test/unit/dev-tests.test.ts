/**
 * The test files a run leaves out (`test/support/suites.ts`), held to what they
 * name.
 *
 * A file of a dev feature's tests is left out of `npm test`, so a mistake in its
 * marker is a mistake nobody sees: a name the registry does not have, as when a
 * feature is made public by deleting its line (§29.1) and its tests stay out
 * for good; or a marker written below the imports, where it is never read and
 * the file runs with the reader's switch on. Both fail here, in the default
 * run, by file.
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath, URL } from 'node:url'

import { describe, expect, it } from 'vitest'

import { DEV_FEATURES } from '../../src/state/devFeatures'
import { markedSuites, selectSuites } from '../support/suites'

const ROOT = fileURLToPath(new URL('../../', import.meta.url))
const suites = markedSuites(ROOT)

describe('the markers', () => {
  it('name only dev features the registry has', () => {
    const unknown = suites.flatMap((suite) =>
      suite.dev.filter((name) => !(name in DEV_FEATURES)).map((name) => `${suite.file}: ${name}`),
    )
    expect(unknown).toEqual([])
  })

  it('are read wherever they are written', () => {
    const unread = suites
      .filter((suite) => {
        const text = readFileSync(`${ROOT}${suite.file}`, 'utf8')
        return (
          (/^\/\/ @dev-feature\b/m.test(text) && suite.dev.length === 0) ||
          (/^\/\/ @fixtures\b/m.test(text) && !suite.fixtures)
        )
      })
      .map((suite) => suite.file)
    expect(unread).toEqual([])
  })

  it('leave a dev feature tested somewhere', () => {
    const tested = new Set(suites.flatMap((suite) => suite.dev))
    expect(Object.keys(DEV_FEATURES).filter((name) => !tested.has(name))).toEqual([])
  })
})

describe('the selection', () => {
  const dev = suites.filter((suite) => suite.dev.length > 0).map((suite) => suite.file)

  it('leaves every dev feature out of a plain run, and says how to run them', () => {
    const plain = selectSuites(ROOT, false)
    expect(dev.length).toBeGreaterThan(0)
    expect(plain.exclude).toEqual(expect.arrayContaining(dev))
    expect(plain.notice).toContain('npm run test:dev')
  })

  it('leaves no dev feature out of a dev run but for want of fixtures', () => {
    const fixtures = new Set(suites.filter((suite) => suite.fixtures).map((suite) => suite.file))
    const left = selectSuites(ROOT, true).exclude.filter((file) => dev.includes(file))
    expect(left.filter((file) => !fixtures.has(file))).toEqual([])
  })

  it('is not itself left out', () => {
    expect(selectSuites(ROOT, false).exclude).not.toContain('test/unit/dev-tests.test.ts')
  })
})
