/**
 * The stage's export card (SPECS §27.8): the edit written as the files the
 * tools downstream take, and an AGP or a Juicebox `.assembly` read back as one.
 *
 * Every file leaves through the save dialog (§26.6), asked from the press
 * itself, and none of them touches the file the edit was made on. A file read
 * back is one step of the history — *lay out as in* it — so it is undone as any
 * step is.
 */

import { agpOf, chainOf, chromSizesOf, juiceboxAssemblyOf, readAgp, readJuiceboxAssembly, type ExportContext, type ReadBack } from './exports'
import { EditedAssembly } from '../genome/edit'
import type { EditStore } from '../state/referenceEdit'
import { el } from '../ui/dom'
import { chooseSaveTarget, exportBaseName } from '../ui/export'
import { PRODUCER } from '../version'
import { stepText } from './words'

/** The extensions a map's name ends in, taken off before an export's is put on. */
const MAP_EXTENSIONS = /\.(mcool|cool|hic|mmetacool|metacool|scool|pairs\.gz|pairs|pairs\.bgz)$/i

/** A file's stem: its own name, without a path, a group or the map's extension. */
export function exportStem(title: string): string {
  const name = title.split('::')[0].split(/[\\/]/).pop() ?? title
  return exportBaseName(name.replace(MAP_EXTENSIONS, ''))
}

/** The text files, in the order the card offers them. */
const TEXT_FILES = [
  { label: 'AGP', suffix: 'edited.agp', title: 'The edited assembly as an AGP 2.1: every sequence as the pieces of the original it is built from' },
  { label: 'chrom.sizes', suffix: 'edited.chrom.sizes', title: 'Every sequence of the edited assembly and its length' },
  { label: '.assembly', suffix: 'edited.assembly', title: 'A Juicebox .assembly, for JBAT, 3D-DNA and YaHS' },
  { label: 'chain', suffix: 'to-edited.chain', title: 'A liftOver chain from the original coordinates to the edited ones, for liftOver or CrossMap' },
] as const

type TextFile = (typeof TEXT_FILES)[number]['label']

export interface ExportCardProps {
  /** The map's name, which every file is named after. */
  title: string
  store: EditStore
  /** When a file is written, for its header; a clock the tests can hold. */
  now?: () => Date
}

export class ExportCard {
  readonly element: HTMLElement
  private readonly status: HTMLElement
  private readonly picker: HTMLInputElement

  constructor(private readonly props: ExportCardProps) {
    this.status = el('p', { class: 'edit-note edit-export-status', attrs: { role: 'status' } })
    this.picker = el('input', {
      class: 'hidden',
      attrs: { type: 'file', accept: '.agp,.assembly,.txt,text/plain' },
      on: { change: () => void this.readPicked() },
    })
    this.element = el('section', { class: 'edit-card edit-export-card' })
    this.paint()
  }

  /** Draw the card again: its buttons and the line under them. */
  paint(): void {
    const files = el(
      'div',
      { class: 'edit-export-files' },
      ...TEXT_FILES.map((file) =>
        el('button', {
          class: 'btn edit-export-file',
          text: file.label,
          title: file.title,
          attrs: { type: 'button', 'data-format': file.label },
          on: { click: () => void this.write(file.label) },
        }),
      ),
    )
    const read = el(
      'div',
      { class: 'edit-export-read' },
      el('button', {
        class: 'btn edit-export-file',
        text: 'lay out from an AGP or .assembly…',
        title: 'Lay the assembly out as a file describes it: one step of the history, undone as any step is',
        attrs: { type: 'button' },
        on: { click: () => this.picker.click() },
      }),
    )
    this.element.replaceChildren(
      el('h3', { class: 'edit-card-head', text: 'export' }),
      el('p', { class: 'edit-note', text: 'Written from the edit; the file it was made on is never touched.' }),
      files,
      read,
      this.status,
      this.picker,
    )
  }

  /** What every file's header says about where it came from. */
  private context(): ExportContext {
    const edit = this.props.store.edit
    const now = this.props.now?.() ?? new Date()
    return {
      file: this.props.title,
      by: PRODUCER,
      created: now.toISOString(),
      steps: edit.history.slice(0, edit.cursor).map((entry) => stepText(entry.step)),
    }
  }

  private say(text: string): void {
    this.status.textContent = text
  }

  private async write(format: TextFile): Promise<void> {
    const file = TEXT_FILES.find((candidate) => candidate.label === format)
    if (file === undefined) return
    const assembly = this.props.store.assembly
    // What cannot be written is said before the dialog opens, not after.
    let text: string
    if (format === '.assembly') {
      const written = juiceboxAssemblyOf(assembly)
      if (!written.ok) {
        this.say(`No .assembly: ${written.why}.`)
        return
      }
      text = written.text
    } else if (format === 'AGP') text = agpOf(assembly, this.context())
    else if (format === 'chrom.sizes') text = chromSizesOf(assembly)
    else text = chainOf(assembly, this.context())
    const name = `${exportStem(this.props.title)}.${file.suffix}`
    const target = await chooseSaveTarget(name, 'text/plain')
    if (target === null) return
    try {
      await target.write(new Blob([text], { type: 'text/plain' }))
      this.say(`Wrote ${target.name}.`)
    } catch (err) {
      this.say(`Could not write ${target.name}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  /** The file the reader picked, read back as a step. */
  private async readPicked(): Promise<void> {
    const file = this.picker.files?.[0]
    this.picker.value = ''
    if (file === undefined) return
    this.readText(await file.text(), file.name)
  }

  /**
   * A file's text, read back as a layout of the original and made a step —
   * an AGP or an `.assembly`, told apart by its first line.
   */
  readText(text: string, name: string): ReadBack {
    const original = this.props.store.edit.original
    const first = text.split(/\r?\n/).find((line) => line.trim() !== '' && !line.startsWith('#')) ?? ''
    const read = first.startsWith('>') ? readJuiceboxAssembly(text, original, name) : readAgp(text, original, name)
    if (!read.ok) {
      this.say(`Not read: ${read.why}.`)
      return read
    }
    this.props.store.apply(read.step, 'reader')
    const assembly = EditedAssembly.of(this.props.store.edit)
    const count = assembly.sequences.length
    const aside = assembly.aside.length
    const notes = [...read.notes, ...(aside === 0 ? [] : [`${aside} stretch${aside === 1 ? '' : 'es'} set aside`])]
    this.say(`Laid out as in ${name}: ${count} sequence${count === 1 ? '' : 's'}${notes.length === 0 ? '' : `; ${notes.join('; ')}`}.`)
    return read
  }
}
