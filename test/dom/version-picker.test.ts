// @vitest-environment jsdom
/**
 * The version picker's one new claim: pull-request previews are a group of
 * their own, offered only when the manifest lists one, and never mistaken for
 * a build of the site.
 *
 * The rest of the picker is arithmetic held by `test/unit/versions.test.ts`;
 * what a DOM adds is the shape of the menu, which is what a reviewer looking
 * for "the preview of my pull request" actually reads.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { versionPicker } from '@/ui/VersionPicker'
import { setUpDom, textsOf, type DomTeardown } from '../support/dom'

let teardown: DomTeardown
let heldFetch: unknown

function answering(manifest: unknown): void {
  ;(globalThis as Record<string, unknown>)['fetch'] = () =>
    Promise.resolve({
      ok: true,
      status: 200,
      json: () => Promise.resolve(manifest),
    } as unknown as Response)
}

async function settled(): Promise<void> {
  for (let i = 0; i < 5; i += 1) await Promise.resolve()
}

const BUILDS = [
  { commit: 'a1b2c3d', version: '0.12.0', date: '2026-09-11T10:00:00Z', subject: 'newest', tag: '' },
  { commit: 'b2c3d4e', version: '0.12.0', date: '2026-09-10T10:00:00Z', subject: 'older', tag: '' },
]

beforeEach(() => {
  teardown = setUpDom()
  heldFetch = (globalThis as Record<string, unknown>)['fetch']
})

afterEach(() => {
  ;(globalThis as Record<string, unknown>)['fetch'] = heldFetch
  teardown()
})

describe('the version picker and the previews', () => {
  it('offers the previews in a group of their own, after the builds', async () => {
    answering({
      latest: 'a1b2c3d',
      versions: BUILDS,
      pulls: [
        { number: 12, commit: 'c3d4e5f', title: 'Remote sources', branch: 'claude/remote', date: '2026-09-11T11:00:00Z' },
      ],
    })
    const row = versionPicker()
    expect(row).not.toBeNull()
    await settled()
    const group = row?.querySelector('optgroup[label="Pull request previews"]')
    expect(group).not.toBeNull()
    expect(textsOf(group as HTMLElement, 'option')).toEqual(['PR #12 · c3d4e5f — Remote sources'])
    // The builds stay ungrouped and first: a preview is never a version of the
    // site. The build running *this test* is not in the manifest either, so the
    // picker leads with its disabled "this build" row, which is not a choice
    // and is left out here.
    const options = [...(row?.querySelectorAll('select option:not([disabled])') ?? [])].map(
      (option) => (option as HTMLOptionElement).value,
    )
    expect(options).toEqual(['a1b2c3d', 'b2c3d4e', 'pr:12'])
  })

  it('has no such group when nothing is being previewed', async () => {
    answering({ latest: 'a1b2c3d', versions: BUILDS, pulls: [] })
    const row = versionPicker()
    await settled()
    expect(row?.querySelector('optgroup')).toBeNull()
  })
})
