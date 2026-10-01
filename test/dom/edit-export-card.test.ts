// @vitest-environment jsdom
/**
 * The stage's export card (SPECS §27.8): each file through the save dialog,
 * named after the map; what cannot be written said before any dialog opens; and
 * a file read back as one step of the history, undone as any step is.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { FeatureBuilder } from '../../src/annotations/featureset'
import type { AnnotationEntry } from '../../src/annotations/types'
import type { AnnotationStore } from '../../src/annotations/store'
import type { AnnotationClient } from '../../src/annotations/worker/client'
import { ExportCard, exportStem, type ExportCardProps } from '../../src/edit/ExportCard'
import { EditStore } from '../../src/state/referenceEdit'

const ORIGINAL = { names: ['I', 'II'], lengths: [1000, 600] }

let saved: Record<string, string>
let asked: string[]

beforeEach(() => {
  localStorage.clear()
  saved = {}
  asked = []
  ;(window as unknown as { showSaveFilePicker: unknown }).showSaveFilePicker = async ({ suggestedName }: { suggestedName: string }) => {
    asked.push(suggestedName)
    return {
      name: suggestedName,
      createWritable: async () => ({
        write: async (blob: Blob) => {
          saved[suggestedName] = await blob.text()
        },
        close: async () => {},
      }),
    }
  }
})

afterEach(() => {
  delete (window as unknown as { showSaveFilePicker?: unknown }).showSaveFilePicker
  document.body.replaceChildren()
})

let files = 0

function card(extra: Partial<ExportCardProps> = {}): { card: ExportCard; store: EditStore } {
  // A file of its own each time: what a store keeps outlives a test.
  files += 1
  const store = new EditStore(`test-${files}.cool`, ORIGINAL, () => 0)
  const exportCard = new ExportCard({ title: 'Yeast_1kb.mcool::/resolutions/1000', store, now: () => new Date('2026-09-30T00:00:00Z'), ...extra })
  document.body.append(exportCard.element)
  return { card: exportCard, store }
}

const BASES: Record<string, string> = { I: 'A'.repeat(500) + 'C'.repeat(500), II: 'G'.repeat(600) }

/**
 * A session with a FASTA and a BED of two features, read through stubs of the
 * store and the client — and `before` them, any other rows, which have no
 * bases of the map's sequences to give. Which rows the bases were asked of is
 * kept in `asked`.
 */
function annotations(before: unknown[] = [], asked: string[] = []): NonNullable<ExportCardProps['annotations']> {
  const genes = new FeatureBuilder()
  genes.add('I', 100, 200, { strand: 1, name: 'g1' })
  genes.add('II', 10, 20, { strand: -1, name: 'g2' })
  const entries = [
    ...before,
    // Naming both of the map's sequences, as its overlap report says.
    { id: 'seq', card: 'linear', kind: 'sequence', label: 'genome.fa', status: 'ready', overlap: { matched: 2, total: 2, missing: [], extra: [] } },
    { id: 'genes', card: 'linear', kind: 'segments', label: 'genes', status: 'ready', payload: { kind: 'features', data: genes.finish() } },
  ] as unknown as AnnotationEntry[]
  const client = {
    request: async (payload: { kind: string; entry: string; regions: Array<{ contig: string; start: number; end: number }> }) => {
      if (payload.kind !== 'bases') throw new Error(`unexpected ${payload.kind}`)
      asked.push(payload.entry)
      return {
        regions: payload.regions.map((region) => ({
          ...region,
          bases: payload.entry === 'seq' ? new TextEncoder().encode(BASES[region.contig].slice(region.start, region.end)) : null,
        })),
      }
    },
  } as unknown as AnnotationClient
  return { store: { entries } as unknown as AnnotationStore, client }
}

const button = (label: string): HTMLButtonElement =>
  [...document.querySelectorAll<HTMLButtonElement>('.edit-export-card button')].find((b) => b.textContent === label) as HTMLButtonElement

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

describe('the export card', () => {
  it('names each file after the map, without its path, group or extension', () => {
    expect(exportStem('Yeast_1kb.mcool::/resolutions/1000')).toBe('Yeast_1kb')
    expect(exportStem('https://host/dir/sample.hic')).toBe('sample')
  })

  it('writes the AGP through the save dialog, with the history in its header', async () => {
    const { store } = card()
    store.apply({ op: 'invert', sequence: 'I', from: 100, to: 300 })
    button('AGP').click()
    await settle()
    await settle()
    expect(asked).toEqual(['Yeast_1kb.edited.agp'])
    expect(saved['Yeast_1kb.edited.agp']).toContain('# 1. turn I:101-300\n')
    expect(saved['Yeast_1kb.edited.agp']).toContain('I_e1\t101\t300\t2\tW\tI\t101\t300\t-\n')
    expect(document.querySelector('.edit-export-status')?.textContent).toMatch(/^Wrote Yeast_1kb\.edited\.agp \(\d+ B\)\.$/)
  })

  it('says why there is no .assembly before any dialog opens', async () => {
    const { store } = card()
    store.apply({ op: 'duplicate', sequence: 'I', from: 100, to: 200, into: 'II', at: 0, strand: 1 })
    button('.assembly').click()
    await settle()
    expect(asked).toEqual([])
    expect(document.querySelector('.edit-export-status')?.textContent).toBe(
      'No .assembly: I is placed twice from 101, and an .assembly lists every fragment once.',
    )
  })

  it('reads an AGP back as one step, undone as any step is', () => {
    const { card: exportCard, store } = card()
    const read = exportCard.readText('scaffold_1\t1\t600\t1\tW\tII\t1\t600\t-\nscaffold_1\t601\t700\t2\tN\t100\tscaffold\tyes\tproximity_ligation\nscaffold_1\t701\t1700\t3\tW\tI\t1\t1000\t+\n', 'yahs.agp')
    expect(read.ok).toBe(true)
    expect(store.edit.history.map((entry) => entry.step.op)).toEqual(['layout'])
    expect(store.assembly.contigs()).toEqual([{ name: 'scaffold_1', length: 1700 }])
    expect(document.querySelector('.edit-export-status')?.textContent).toBe('Laid out as in yahs.agp: 1 sequence.')
    store.undo()
    expect(store.assembly.contigs()).toEqual([
      { name: 'I', length: 1000 },
      { name: 'II', length: 600 },
    ])
  })

  it('writes the edited sequence from the session’s FASTA, a turned piece reverse-complemented', async () => {
    const { store } = card({ annotations: annotations() })
    store.apply({ op: 'invert', sequence: 'I', from: 400, to: 600 })
    button('FASTA').click()
    for (let k = 0; k < 6; k++) await settle()
    const fasta = saved['Yeast_1kb.edited.fa']
    const [head, ...lines] = fasta.split('\n')
    expect(head).toBe('>I_e1')
    const I = lines.join('').split('>')[0]
    // A×400, then the turn: revcomp(A×100 C×100) = G×100 T×100, then C×400.
    expect(I).toBe('A'.repeat(400) + 'G'.repeat(100) + 'T'.repeat(100) + 'C'.repeat(400))
    expect(document.querySelector('.edit-export-status')?.textContent).toMatch(/^Wrote Yeast_1kb\.edited\.fa \(/)
  })

  it('writes it from the file’s own sequence, not from a reference loaded before it (§27.8)', async () => {
    // The theoretical genome a strain was built to be, first in the list and
    // naming none of the map's sequences: written from, it was a file of N.
    const theory = { id: 'theory', card: 'linear', kind: 'sequence', label: 'theory.fa', status: 'ready', overlap: { matched: 0, total: 2, missing: ['I', 'II'], extra: ['chrA'] } }
    const asked: string[] = []
    card({ annotations: annotations([theory], asked) })
    expect(button('FASTA').title).toContain('from genome.fa')
    button('FASTA').click()
    for (let k = 0; k < 6; k++) await settle()
    expect(new Set(asked)).toEqual(new Set(['seq']))
    expect(saved['Yeast_1kb.edited.fa']).not.toContain('N')
    expect(document.querySelector('.edit-export-status')?.textContent).toMatch(/^Wrote Yeast_1kb\.edited\.fa \(/)
  })

  it('says why there is no FASTA where the session has no sequence', () => {
    card()
    expect(button('FASTA').disabled).toBe(true)
    expect(button('FASTA').title).toBe('Load the assembly’s FASTA or .2bit into the session to write the edited sequence')
  })

  it('lifts a track of features as BED, named for the track', async () => {
    const { store } = card({ annotations: annotations() })
    store.apply({ op: 'invert', sequence: 'I', from: 0, to: 1000 })
    const select = document.querySelector('.edit-export-track') as HTMLSelectElement
    expect([...select.options].map((option) => option.textContent)).toEqual(['genes'])
    button('BED').click()
    for (let k = 0; k < 4; k++) await settle()
    expect(saved['genes.edited.bed'].split('\n').slice(1, -1)).toEqual(['I_e1\t800\t900\tg1\t0\t-', 'II\t10\t20\tg2\t0\t-'])
  })

  it('writes the map lifted by the reader’s worker, and says what it carries', async () => {
    let asked: unknown = null
    card({
      liftContacts: (edit) => {
        asked = edit
        return {
          promise: Promise.resolve({ bytes: new Uint8Array([1, 2, 3]), filename: 'x.mcool', rungs: [1000, 5000], contacts: 1234, skipped: [] }),
          cancel: () => {},
        }
      },
    })
    button('contacts (.mcool)').click()
    for (let k = 0; k < 6; k++) await settle()
    expect(saved['Yeast_1kb.edited.mcool']).toBeDefined()
    // The worker is asked for the export's own edit: one layout of the original.
    expect((asked as { history: Array<{ step: { op: string } }> }).history.map((entry) => entry.step.op)).toEqual(['layout'])
    expect(document.querySelector('.edit-export-status')?.textContent).toBe('Wrote Yeast_1kb.edited.mcool (3 B). 2 rungs, 1 kb, 5 kb; 1,234 contacts at the finest.')
  })

  it('refuses a file of another assembly, and makes no step', () => {
    const { card: exportCard, store } = card()
    exportCard.readText('>chrI 1 1000\n1\n', 'other.assembly')
    expect(store.edit.history).toEqual([])
    expect(document.querySelector('.edit-export-status')?.textContent).toBe(
      'Not read: it names chrI (line 1), which the map does not have: it is an .assembly of another assembly.',
    )
  })
})
