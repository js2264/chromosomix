/**
 * The stage's export card (SPECS §27.8): the edit written as the files the
 * tools downstream take — the assembly's text files, its sequence, the map and
 * the session's tracks lifted through it — and an AGP or a Juicebox
 * `.assembly` read back as one.
 *
 * Every file leaves through the save dialog (§26.6), asked from the press
 * itself before anything is made for it, and none of them touches a file the
 * session opened. A file read back is one step of the history — *lay out as in*
 * it — so it is undone as any step is.
 */

import { agpOf, chainOf, chromSizesOf, juiceboxAssemblyOf, readAgp, readJuiceboxAssembly, writableEdit, type ExportContext, type ReadBack } from './exports'
import { fastaOf, liftedFeaturesBed, liftedPairsBedpe, liftedSignal, type LiftContext } from './lifted'
import { writeBigWig } from '../analysis/write/bigwig'
import { formatBp } from '../pairs/import'
import type { AnnotationEntry } from '../annotations/types'
import type { AnnotationStore } from '../annotations/store'
import type { AnnotationClient } from '../annotations/worker/client'
import { EditedAssembly, type ReferenceEdit } from '../genome/edit'
import type { EditStore } from '../state/referenceEdit'
import { el } from '../ui/dom'
import { chooseSaveTarget, exportBaseName, type SaveTarget } from '../ui/export'
import { fmt } from '../units'
import { PRODUCER } from '../version'
import type { LiftedExport } from '../worker/protocol'
import type { BinningTable } from './binning'
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

/** A long export in flight, and the way to stop it. */
export interface LiftJob<T> {
  promise: Promise<T>
  cancel(): void
}

export interface ExportCardProps {
  /** The map's name, which every file is named after. */
  title: string
  store: EditStore
  /** The session's tracks, and the client that reads them: the sequence and the tracks lifted. */
  annotations?: { store: AnnotationStore; client?: AnnotationClient }
  /** The map lifted through an edit, every rung, by the reader's worker. */
  liftContacts?: (edit: ReferenceEdit, onProgress: (done: number, total: number, note?: string) => void) => LiftJob<LiftedExport>
  /**
   * On a metagenome (§27.10): the contig → MAG table every genome's edit
   * makes of the file's contigs, as it stands when asked.
   */
  binning?: () => BinningTable
  /** When a file is written, for its header; a clock the tests can hold. */
  now?: () => Date
}

/** What a track is written as, lifted: by its kind. */
function formatOf(entry: AnnotationEntry): { label: string; suffix: string } | null {
  if (entry.status !== 'ready') return null
  if (entry.kind === 'track' && entry.derivedFrom === undefined) return { label: 'bigWig', suffix: 'bw' }
  if (entry.payload?.kind === 'features') return { label: 'BED', suffix: 'bed' }
  if (entry.payload?.kind === 'pairs') return { label: 'BEDPE', suffix: 'bedpe' }
  return null
}

export class ExportCard {
  readonly element: HTMLElement
  private readonly status: HTMLElement
  private readonly picker: HTMLInputElement
  private readonly trackSelect: HTMLSelectElement
  private job: { cancel(): void } | null = null
  private cancelled = false

  constructor(private readonly props: ExportCardProps) {
    this.status = el('p', { class: 'edit-note edit-export-status', attrs: { role: 'status' } })
    this.picker = el('input', {
      class: 'hidden',
      attrs: { type: 'file', accept: '.agp,.assembly,.txt,text/plain' },
      on: { change: () => void this.readPicked() },
    })
    this.trackSelect = el('select', { class: 'select edit-export-track', attrs: { 'aria-label': 'The track to lift' }, on: { change: () => this.paint() } })
    this.element = el('section', { class: 'edit-card edit-export-card' })
    this.paint()
  }

  /** The session's sequence, where it has one ready. */
  private sequenceEntry(): AnnotationEntry | null {
    return this.props.annotations?.store.entries.find((entry) => entry.kind === 'sequence' && entry.status === 'ready') ?? null
  }

  /** The tracks that can be lifted, with what each is written as. */
  private liftable(): Array<{ entry: AnnotationEntry; format: { label: string; suffix: string } }> {
    const out: Array<{ entry: AnnotationEntry; format: { label: string; suffix: string } }> = []
    for (const entry of this.props.annotations?.store.entries ?? []) {
      const format = formatOf(entry)
      if (format !== null) out.push({ entry, format })
    }
    return out
  }

  /** Draw the card again: its buttons and the line under them. */
  paint(): void {
    const busy = this.job !== null
    const button = (label: string, title: string, run: () => void, disabled = false, format = label): HTMLButtonElement =>
      el('button', {
        class: 'btn edit-export-file',
        text: label,
        title,
        attrs: { type: 'button', 'data-format': format, ...(disabled || busy ? { disabled: '' } : {}) },
        on: { click: run },
      })
    const files = el(
      'div',
      { class: 'edit-export-files' },
      ...TEXT_FILES.map((file) => button(file.label, file.title, () => void this.write(file.label))),
      ...(this.props.binning === undefined
        ? []
        : [
            button(
              'contig → MAG',
              'Every contig of the metagenome and the genome it is in, every genome’s edit applied: the two columns DAS_Tool, anvi’o and metacooler create take',
              () => void this.writeBinning(),
              false,
              'binning',
            ),
          ]),
    )
    const sequence = this.sequenceEntry()
    const data = el(
      'div',
      { class: 'edit-export-files' },
      button(
        'FASTA',
        sequence === null
          ? 'Load the assembly’s FASTA or .2bit into the session to write the edited sequence'
          : `The edited sequence from ${sequence.label}: turned pieces reverse-complemented, gaps as N`,
        () => void this.writeFasta(),
        sequence === null || this.props.annotations?.client === undefined,
      ),
      button(
        'contacts (.mcool)',
        'The map lifted through the edit, every rung it has: raw counts, bins moved whole',
        () => void this.writeContacts(),
        this.props.liftContacts === undefined,
        'mcool',
      ),
    )
    const liftable = this.liftable()
    const chosen = this.trackSelect.value
    this.trackSelect.replaceChildren(...liftable.map(({ entry }) => el('option', { text: entry.label, attrs: { value: entry.id } })))
    if (liftable.some(({ entry }) => entry.id === chosen)) this.trackSelect.value = chosen
    const current = liftable.find(({ entry }) => entry.id === this.trackSelect.value) ?? liftable[0]
    const tracks =
      liftable.length === 0
        ? null
        : el(
            'div',
            { class: 'edit-export-files edit-export-tracks' },
            this.trackSelect,
            button(
              current?.format.label ?? 'BED',
              'The track lifted through the edit: a signal as bigWig, features as BED, pairs as BEDPE',
              () => void this.writeTrack(),
              current === undefined,
              'track',
            ),
          )
    const read = el(
      'div',
      { class: 'edit-export-read' },
      button('lay out from an AGP or .assembly…', 'Lay the assembly out as a file describes it: one step of the history, undone as any step is', () => this.picker.click(), false, 'read'),
    )
    const cancel = busy
      ? el('button', { class: 'btn-link edit-export-cancel', text: 'cancel', attrs: { type: 'button' }, on: { click: () => this.cancel() } })
      : null
    this.element.replaceChildren(
      el('h3', { class: 'edit-card-head', text: 'export' }),
      el('p', { class: 'edit-note', text: 'Written from the edit; no file the session opened is touched.' }),
      files,
      data,
      ...(tracks === null ? [] : [tracks]),
      read,
      el('div', { class: 'edit-export-line' }, this.status, ...(cancel === null ? [] : [cancel])),
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

  private liftContext(what: string): LiftContext {
    const context = this.context()
    return { what, file: context.file, by: context.by, created: context.created }
  }

  private say(text: string): void {
    this.status.textContent = text
  }

  private name(suffix: string): string {
    // One genome's files say whose they are (§27.10).
    const genome = this.props.store.edit.original.genome
    return `${exportStem(this.props.title)}${genome === undefined ? '' : `.${exportBaseName(genome)}`}.${suffix}`
  }

  /** Write what `make` makes to where the reader chose, saying so; `make` may be long, and is asked after the dialog. */
  private async save(target: SaveTarget, what: string, make: () => Promise<Blob | null>): Promise<void> {
    this.cancelled = false
    this.job = { cancel: () => (this.cancelled = true) }
    this.paint()
    try {
      const blob = await make()
      if (blob === null || this.cancelled) {
        this.say(`${what}: cancelled.`)
        return
      }
      await target.write(blob)
      this.say(`Wrote ${target.name} (${fmt.bytes(blob.size)}).${this.note === '' ? '' : ` ${this.note}`}`)
    } catch (err) {
      this.say(`Could not write ${target.name}: ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      this.note = ''
      this.job = null
      this.paint()
    }
  }

  /** A line the next write adds to what it says. */
  private note = ''

  private cancel(): void {
    this.cancelled = true
    this.job?.cancel()
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
    const target = await chooseSaveTarget(this.name(file.suffix), 'text/plain')
    if (target === null) return
    await this.save(target, format, async () => new Blob([text], { type: 'text/plain' }))
  }

  /** The contig → MAG table of the whole metagenome, every genome's edit applied (§27.10). */
  private async writeBinning(): Promise<void> {
    const binning = this.props.binning
    if (binning === undefined) return
    const table = binning()
    const target = await chooseSaveTarget(`${exportStem(this.props.title)}.contig-mag.tsv`, 'text/tab-separated-values')
    if (target === null) return
    const count = (n: number, one: string, many: string): string => `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`
    this.note =
      `${count(table.contigs, 'contig', 'contigs')} in ${count(table.genomes, 'genome', 'genomes')}, ${count(table.moved, 'moved', 'moved')} by the edits.` +
      (table.notes.length === 0 ? '' : ` ${table.notes.join('; ')}.`)
    await this.save(target, 'contig → MAG', async () => new Blob([table.text], { type: 'text/tab-separated-values' }))
  }

  /** The edited sequence, piece by piece through the annotation worker's ranged reads. */
  private async writeFasta(): Promise<void> {
    const entry = this.sequenceEntry()
    const client = this.props.annotations?.client
    if (entry === null || client === undefined) return
    const target = await chooseSaveTarget(this.name('edited.fa'), 'text/plain')
    if (target === null) return
    const assembly = this.props.store.assembly
    await this.save(target, 'FASTA', async () => {
      const out = await fastaOf(
        assembly,
        async (sequence, start, end) => {
          const got = await client.request<'bases'>({ kind: 'bases', entry: entry.id, regions: [{ contig: sequence, start, end }] })
          return got.regions[0]?.bases ?? null
        },
        {
          onProgress: (done, total) => this.say(`Writing the FASTA · ${Math.floor((100 * done) / Math.max(1, total))}%`),
          cancelled: () => this.cancelled,
        },
      )
      if (out === null) return null
      if (out.missing.length > 0) {
        this.note = `${entry.label} has no ${out.missing.slice(0, 3).join(', ')}${out.missing.length > 3 ? ' and others' : ''}: written as N.`
      }
      return new Blob(out.parts as BlobPart[], { type: 'text/plain' })
    })
  }

  /** The map lifted through the edit, by the reader's worker. */
  private async writeContacts(): Promise<void> {
    const lift = this.props.liftContacts
    if (lift === undefined) return
    const target = await chooseSaveTarget(this.name('edited.mcool'), 'application/octet-stream')
    if (target === null) return
    const edit = writableEdit(this.props.store.edit)
    await this.save(target, 'contacts', async () => {
      const job = lift(edit, (done, total, note) =>
        this.say(`${note === undefined ? 'Lifting the map' : note[0].toUpperCase() + note.slice(1)} · ${Math.floor((100 * done) / Math.max(1, total))}%`),
      )
      const previous = this.job
      this.job = { cancel: () => { previous?.cancel(); job.cancel() } }
      const lifted = await job.promise
      const rungs = lifted.rungs.map((size) => formatBp(size)).join(', ')
      this.note = `${lifted.rungs.length} rung${lifted.rungs.length === 1 ? '' : 's'}, ${rungs}; ${lifted.contacts.toLocaleString('en-US')} contacts at the finest.${
        lifted.skipped.length === 0 ? '' : ` Left out: ${lifted.skipped.map((skip) => `${formatBp(skip.rung)} (${skip.why})`).join('; ')}.`
      }`
      return new Blob([lifted.bytes as BlobPart], { type: 'application/octet-stream' })
    })
  }

  /** The chosen track lifted through the edit, in the format its kind is written in. */
  private async writeTrack(): Promise<void> {
    const chosen = this.liftable().find(({ entry }) => entry.id === this.trackSelect.value) ?? this.liftable()[0]
    const client = this.props.annotations?.client
    if (chosen === undefined) return
    const { entry, format } = chosen
    const target = await chooseSaveTarget(`${exportBaseName(entry.label)}.edited.${format.suffix}`, format.label === 'bigWig' ? 'application/octet-stream' : 'text/plain')
    if (target === null) return
    const assembly = this.props.store.assembly
    await this.save(target, entry.label, async () => {
      const payload = entry.payload
      if (payload?.kind === 'features') {
        const { text, count } = liftedFeaturesBed(payload.data, assembly, this.liftContext(entry.label))
        this.note = liftNote(count.dropped, count.split, 'feature')
        return new Blob([text], { type: 'text/plain' })
      }
      if (payload?.kind === 'pairs') {
        const { text, count } = liftedPairsBedpe(payload.data, assembly, this.liftContext(entry.label))
        this.note = liftNote(count.dropped, 0, 'pair')
        return new Blob([text], { type: 'text/plain' })
      }
      if (client === undefined) return null
      const signal = await liftedSignal(
        assembly,
        async (sequence, start, end) => {
          const got = await client.request<'sample'>({ kind: 'sample', entry: entry.id, regions: [{ contig: sequence, start, end }], basesPerPixel: 1, exact: true })
          const region = got.regions[0]
          return region === undefined ? null : { starts: region.starts, ends: region.ends, values: region.values, summary: region.summary }
        },
        {
          onProgress: (done, total) => this.say(`Lifting ${entry.label} · ${Math.floor((100 * done) / Math.max(1, total))}%`),
          cancelled: () => this.cancelled,
        },
      )
      if (signal === null) return null
      if (signal.summary) this.note = 'Some of it came from the file’s zoom levels rather than its own resolution.'
      return writeBigWig({ contigs: signal.contigs, spans: signal.spans })
    })
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

/** What a lift left out, in words, or nothing. */
function liftNote(dropped: number, split: number, noun: string): string {
  const parts: string[] = []
  if (dropped > 0) parts.push(`${dropped.toLocaleString('en-US')} ${noun}${dropped === 1 ? '' : 's'} lay on what was set aside and ${dropped === 1 ? 'is' : 'are'} not written`)
  if (split > 0) parts.push(`${split.toLocaleString('en-US')} ${noun}${split === 1 ? '' : 's'} an edit cut through, written once per piece`)
  return parts.length === 0 ? '' : `${parts.join('; ')}.`
}
