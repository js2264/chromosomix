// @vitest-environment jsdom
/**
 * A feature lane's right-click menu (§8.16): the rows, the point, and the
 * feature under the pointer.
 *
 * The menu used to offer a feature lane what it offers every lane — its colour,
 * where it is drawn, hide and remove — and nothing about the thing a gene track
 * *is*. So it now carries the three ways of spending the rows every genome
 * browser offers (expanded, squished, collapsed) with a tick on the one in
 * force, the switch for the points, and, when the menu is opened on a feature,
 * that feature: its card, a zoom where the surface has one axis to zoom on, and
 * its name and position to copy.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { featuresOf } from '@/annotations/fields'
import { parseBed } from '@/annotations/parse'
import { AnnotationStore } from '@/annotations/store'
import type { AnnotationEntry, AnnotationKind } from '@/annotations/types'
import { closeMenu } from '@/ui/Menu'
import { laneMenuFeature, openLaneMenu, type LaneMenuFeature } from '@/ui/MatrixPanel'
import { all, setUpDom, textsOf, type DomTeardown } from '../support/dom'

let teardown: DomTeardown

beforeEach(() => {
  teardown = setUpDom()
})

afterEach(() => {
  closeMenu()
  teardown()
  vi.restoreAllMocks()
})

function made(kind: AnnotationKind): { store: AnnotationStore; entry: () => AnnotationEntry } {
  const store = new AnnotationStore(`menu-${Math.random()}.cool`, { persist: false })
  const { id } = store.begin({
    card: 'linear',
    kind,
    label: 'genes',
    source: { kind: 'remote', url: 'genes.bed', name: 'genes.bed' },
  })
  store.update(id, { status: 'ready' })
  return { store, entry: () => store.byId(id)! }
}

/** The row a reader would click, by its label. */
function item(label: string): HTMLButtonElement {
  const found = all<HTMLButtonElement>(document.body, '.crumb-menu-item').find(
    (node) => node.textContent?.replace('✓', '').trim().startsWith(label) === true,
  )
  if (found === undefined) throw new Error(`no menu row "${label}"`)
  return found
}

/** The labels of the rows ticked as in force — the label alone, not its hint. */
function ticked(): string[] {
  return all<HTMLButtonElement>(document.body, '.crumb-menu-item')
    .filter((node) => node.getAttribute('aria-checked') === 'true')
    .map((node) => node.querySelector('.context-menu-check + span')?.textContent ?? '')
}

describe('the rows, from the menu', () => {
  it('offers the three ways a feature lane spends its rows, the one in force ticked', () => {
    const { store, entry } = made('gtf')
    openLaneMenu(10, 10, entry(), store, 'bottom')
    expect(textsOf(document.body, '.context-menu-head')).toContain('Rows')
    for (const label of ['Expanded', 'Squished', 'Collapsed']) {
      expect(item(label).getAttribute('role')).toBe('menuitemcheckbox')
    }
    expect(ticked()).toContain('Expanded')
    expect(ticked()).not.toContain('Squished')
    // What each does is a sentence, and a sentence is the row's tooltip: the
    // hint column is for a value, and cut a sentence off at the menu's edge.
    expect(item('Squished').title).toMatch(/thin rows/i)
    expect(item('Squished').querySelector('.context-menu-hint')).toBeNull()
  })

  it('squishes and collapses the lane it was opened on', () => {
    const { store, entry } = made('segments')
    openLaneMenu(10, 10, entry(), store, 'bottom')
    item('Squished').click()
    expect(featuresOf(entry().style, entry().kind).display).toBe('squished')
    openLaneMenu(10, 10, entry(), store, 'bottom')
    expect(ticked()).toContain('Squished')
    item('Collapsed').click()
    expect(featuresOf(entry().style, entry().kind).display).toBe('collapsed')
  })

  it('turns the points off and on, and says which is in force', () => {
    const { store, entry } = made('gtf')
    openLaneMenu(10, 10, entry(), store, 'bottom')
    expect(ticked()).toContain('Point the way each runs')
    item('Point the way each runs').click()
    expect(featuresOf(entry().style, entry().kind).arrows).toBe(false)
    openLaneMenu(10, 10, entry(), store, 'bottom')
    expect(ticked()).not.toContain('Point the way each runs')
  })

  it('offers a call set its rows but no points, since a variant has no strand', () => {
    const { store, entry } = made('variants')
    openLaneMenu(10, 10, entry(), store, 'bottom')
    expect(textsOf(document.body, '.context-menu-head')).toContain('Rows')
    expect(() => item('Point the way each runs')).toThrow()
  })

  it('offers neither to a signal track or a barChart', () => {
    for (const kind of ['track', 'barchart'] as const) {
      const { store, entry } = made(kind)
      openLaneMenu(10, 10, entry(), store, 'bottom')
      expect(textsOf(document.body, '.context-menu-head')).not.toContain('Rows')
      closeMenu()
    }
  })
})

describe('the feature under the pointer', () => {
  const SET = parseBed('IV\t1049999\t1052228\tDPL1\t0\t-\nIV\t2000\t3000\t.\t0\t+\n', 'genes.bed')

  function feature(zoom?: () => void): { made: LaneMenuFeature; opened: string[] } {
    const opened: string[] = []
    const index = SET.name.indexOf('DPL1')
    return {
      made: laneMenuFeature(SET, index, {
        open: () => opened.push('card'),
        ...(zoom === undefined ? {} : { zoom }),
      }),
      opened,
    }
  }

  it('is named at the top of the menu, with its card a click away', () => {
    const { store, entry } = made('segments')
    const { made: target, opened } = feature()
    openLaneMenu(10, 10, entry(), store, 'bottom', undefined, target)
    const heads = textsOf(document.body, '.context-menu-head')
    expect(heads[0]).toBe('DPL1')
    item('About it').click()
    expect(opened).toEqual(['card'])
  })

  it('zooms only where the surface says it can', () => {
    const { store, entry } = made('segments')
    openLaneMenu(10, 10, entry(), store, 'bottom', undefined, feature().made)
    // Beside a map there is no zoom: its view is a region on two axes.
    expect(() => item('Zoom to it')).toThrow()
    const zoomed: string[] = []
    openLaneMenu(10, 10, entry(), store, null, undefined, feature(() => zoomed.push('zoom')).made)
    item('Zoom to it').click()
    expect(zoomed).toEqual(['zoom'])
  })

  it('copies its name and its position, as the locus box would take them back', async () => {
    const written: string[] = []
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: (text: string) => (written.push(text), Promise.resolve()) },
    })
    const { store, entry } = made('segments')
    openLaneMenu(10, 10, entry(), store, 'bottom', undefined, feature().made)
    item('Copy its name').click()
    openLaneMenu(10, 10, entry(), store, 'bottom', undefined, feature().made)
    item('Copy its position').click()
    await Promise.resolve()
    expect(written).toEqual(['DPL1', 'IV:1,050,000-1,052,228'])
  })

  it('is named by its place where the file gives it no name', () => {
    const unnamed = laneMenuFeature(SET, SET.name.indexOf(''), { open: () => {} })
    expect(unnamed.name).toBe('IV:2,001-3,000')
    expect(unnamed.locus).toBe('IV:2,001-3,000')
  })
})
