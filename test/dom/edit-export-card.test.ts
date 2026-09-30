// @vitest-environment jsdom
/**
 * The stage's export card (SPECS §27.8): each file through the save dialog,
 * named after the map; what cannot be written said before any dialog opens; and
 * a file read back as one step of the history, undone as any step is.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { ExportCard, exportStem } from '../../src/edit/ExportCard'
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

function card(): { card: ExportCard; store: EditStore } {
  // A file of its own each time: what a store keeps outlives a test.
  files += 1
  const store = new EditStore(`test-${files}.cool`, ORIGINAL, () => 0)
  const exportCard = new ExportCard({ title: 'Yeast_1kb.mcool::/resolutions/1000', store, now: () => new Date('2026-09-30T00:00:00Z') })
  document.body.append(exportCard.element)
  return { card: exportCard, store }
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
    expect(document.querySelector('.edit-export-status')?.textContent).toBe('Wrote Yeast_1kb.edited.agp.')
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

  it('refuses a file of another assembly, and makes no step', () => {
    const { card: exportCard, store } = card()
    exportCard.readText('>chrI 1 1000\n1\n', 'other.assembly')
    expect(store.edit.history).toEqual([])
    expect(document.querySelector('.edit-export-status')?.textContent).toBe(
      'Not read: it names chrI (line 1), which the map does not have: it is an .assembly of another assembly.',
    )
  })
})
