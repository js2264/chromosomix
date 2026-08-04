/**
 * Which table the trail leads back to.
 *
 * The root crumb is the way back up, so it has to name the table the reader
 * actually came through. It used to fall back to the file's *default* root
 * below the table views, which meant opening a contig from the Contigs table
 * produced `Genomes › NODE_18007` — a path that does not exist, leading back to
 * a table the reader had never been in.
 *
 * Nothing is remembered to fix it: a contig opened inside a genome carries that
 * genome in the view state and one opened from the contigs table does not, so
 * the answer is already in the URL. Which also means a shared link rebuilds the
 * same trail as the session that produced it — the property a remembered mode
 * would have quietly lost.
 */

import { describe, expect, it } from 'vitest'

import { rootTable } from '@/ui/Breadcrumb'
import type { ViewState } from '@/types'

const uri = 'Hum53.metacool'
const state = (partial: Partial<ViewState>): ViewState =>
  ({ uri, view: 'genomes', ...partial }) as ViewState

describe('rootTable', () => {
  it('names itself on a table view, whatever the file default is', () => {
    expect(rootTable(state({ view: 'genomes' }), 'contigs')).toBe('genomes')
    expect(rootTable(state({ view: 'contigs' }), 'genomes')).toBe('contigs')
  })

  it('sends a bare contig back to the contigs table', () => {
    // The reported bug: this said `genomes` on a metacool.
    expect(rootTable(state({ view: 'region', region: 'NODE_1' }), 'genomes')).toBe('contigs')
  })

  it('sends a contig opened inside a genome back through the genomes table', () => {
    expect(
      rootTable(state({ view: 'region', region: 'NODE_1', genome: 'MAG_1' }), 'genomes'),
    ).toBe('genomes')
  })

  it('puts a genome and a pair under the genomes table', () => {
    expect(rootTable(state({ view: 'genome', genome: 'MAG_1' }), 'contigs')).toBe('genomes')
    expect(
      rootTable(state({ view: 'pair', genome: 'MAG_1', genome2: 'MAG_2' }), 'contigs'),
    ).toBe('genomes')
  })

  it('leaves the whole-file views on the file default', () => {
    // A cooler's whole-genome view is below neither table; it keeps the root
    // the file lands on, which is `contigs` there and `genomes` on a metacool.
    expect(rootTable(state({ view: 'whole' }), 'contigs')).toBe('contigs')
    expect(rootTable(state({ view: 'whole' }), 'genomes')).toBe('genomes')
    // And the metagenome's scan is the same kind of thing: a picture of the
    // file rather than of a row in either table.
    expect(rootTable(state({ view: 'overview' }), 'genomes')).toBe('genomes')
  })

  it('sends a selection back to the table it was ticked in', () => {
    expect(rootTable(state({ view: 'selection', genomes: 'MAG_1,MAG_2' }), 'contigs')).toBe(
      'genomes',
    )
    expect(rootTable(state({ view: 'selection', regions: 'I,II' }), 'genomes')).toBe('contigs')
    // Nothing ticked is not a selection; it falls through to the file default,
    // and the shell redirects it to the whole-file view anyway.
    expect(rootTable(state({ view: 'selection' }), 'genomes')).toBe('genomes')
  })

  it('keeps a cooler on its chromosomes, since it has no genome to carry', () => {
    expect(rootTable(state({ view: 'region', region: 'chr1' }), 'contigs')).toBe('contigs')
  })
})
