// @vitest-environment jsdom
/**
 * What a click on a gene puts in front of the reader.
 *
 * The dialog is the one surface that has room for everything a file said about a
 * feature, so what it *leads* with is the whole of its design. A reader clicking
 * a glyph labelled `VAR` on a *Plasmodium* map is very often clicking it because
 * sixty of them are called that, and the accession is what tells this one from
 * the rest — so the name and the id are the first two lines, above the
 * coordinates, and both are selectable text rather than a title bar.
 *
 * The case worth pinning hardest is the one that has no symbol at all: the
 * display name falls back to the accession there, and a card printing the same
 * string under `gene name` and `gene ID` would be inventing a fact the file does
 * not contain.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { FeatureBuilder } from '@/annotations/featureset'
import { openFeatureDialog } from '@/ui/FeatureDialog'
import { setUpDom, textsOf, type DomTeardown } from '../support/dom'

let teardown: DomTeardown

beforeEach(() => {
  teardown = setUpDom()
})

afterEach(() => {
  teardown()
})

/** The dialog's `key: value` lines, in the order they are shown. */
function rowsOf(root: ParentNode): Array<[string, string]> {
  const keys = textsOf(root, '.feature-key')
  const values = textsOf(root, '.feature-val')
  return keys.map((key, i) => [key, values[i] ?? ''])
}

function openFor(name: string, id: string): { rows: Array<[string, string]>; title: string } {
  const build = new FeatureBuilder()
  build.add('chr13', 624_509, 626_292, { name, id, strand: 1, detail: 'source VEuPathDB' })
  const modal = openFeatureDialog({ set: build.finish(), index: 0, source: 'genes.gff' })
  const panel = document.querySelector('.modal-panel')
  expect(panel).not.toBeNull()
  const out = {
    rows: rowsOf(panel as ParentNode),
    title: (panel?.querySelector('.modal-title')?.textContent ?? '').trim(),
  }
  modal.close()
  return out
}

describe('the feature card', () => {
  it('leads with the gene’s name and its accession, in that order', () => {
    const { rows, title } = openFor('LipL1', 'PF3D7_1314600')
    expect(rows[0]).toEqual(['gene name', 'LipL1'])
    expect(rows[1]).toEqual(['gene ID', 'PF3D7_1314600'])
    // …and only then where it is.
    expect(rows[2][0]).toBe('position')
    expect(title).toBe('LipL1')
  })

  it('prints the accession once when the file gave no symbol', () => {
    const { rows } = openFor('PF3D7_1300100', 'PF3D7_1300100')
    expect(rows[0]).toEqual(['gene ID', 'PF3D7_1300100'])
    expect(rows.filter(([key]) => key === 'gene name')).toEqual([])
  })

  it('says neither for a format that has no accession', () => {
    const { rows, title } = openFor('peak_1', '')
    expect(rows.map(([key]) => key)).not.toContain('gene ID')
    expect(rows.map(([key]) => key)).not.toContain('gene name')
    expect(rows[0][0]).toBe('position')
    // The name is still the heading, which is where it always was.
    expect(title).toBe('peak_1')
  })

  it('closes cleanly, taking its backdrop with it', () => {
    const build = new FeatureBuilder()
    build.add('chrI', 0, 100, { name: 'X', id: 'x1' })
    const modal = openFeatureDialog({ set: build.finish(), index: 0, source: 'genes.gff' })
    expect(document.querySelector('.modal-backdrop')).not.toBeNull()
    modal.close()
    expect(document.querySelector('.modal-backdrop')).toBeNull()
  })
})
