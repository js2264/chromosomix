// @vitest-environment jsdom
/**
 * The door to a folder, named the same wherever the standalone build draws it
 * (§19, §20).
 *
 * The single-file build reaches this machine and nothing else, and its landing
 * page said so — *Connect a folder* over a row of one button — while the Files
 * column's button and the palette's command went on offering *a local or remote
 * folder* in the same window. One name now serves all three, in each build
 * (`ui/connectFronts.ts`).
 *
 * A file of its own, because the build is a module constant: the modules under
 * test are imported fresh against a mocked `@/version`, and a fresh module graph
 * in the middle of another file's tests is a second registry of connected
 * folders that file's own imports never see.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { all, setUpDom, type DomTeardown } from '../support/dom'

let teardown: DomTeardown

beforeEach(() => {
  teardown = setUpDom()
  window.localStorage.clear()
  vi.resetModules()
  vi.doMock('@/version', async () => ({
    ...(await vi.importActual<Record<string, unknown>>('@/version')),
    TARGET: 'standalone',
    IS_STANDALONE: true,
  }))
})

afterEach(() => {
  vi.doUnmock('@/version')
  vi.resetModules()
  teardown()
})

describe('in the standalone build', () => {
  it('calls the door connect a folder, and names the one place behind it', async () => {
    const fronts = await import('@/ui/connectFronts')
    expect(fronts.CONNECT_FOLDER).toBe('connect a folder')
    expect(fronts.CONNECT_FOLDER_TITLE).toBe('Connect a folder')
    expect(fronts.CONNECT_PLACES).toBe('A folder on this machine')
    expect(fronts.providerFronts().map((front) => front.id)).toEqual(['local'])
  })

  it('says so on the Files column’s button, as the landing page does', async () => {
    const { FilesCard } = await import('@/ui/FilesCard')
    const card = new FilesCard({ onLoad: () => {}, onOpenNew: () => {}, tabEmpty: () => false, onConnect: () => {} })
    card.showFirst()
    const connect = all<HTMLButtonElement>(card.el, '.files-actions .btn')[0]
    expect(connect.textContent).toBe('connect a folder')
    expect(connect.title).toBe('A folder on this machine, browsed here.')
    card.destroy()
  })
})
