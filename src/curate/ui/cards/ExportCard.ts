/**
 * The inspector's export card (SPECS §33.8): the curation written as the
 * tables `metacooler` and `metaTOR` take — contig → genome, the genomes with
 * metaTOR's `mge` flag, the elements, the element ↔ host pairs — each a new
 * file through the save dialog (§26.6), named after the map, none of them
 * touching a file the session opened; then the two commands that make the
 * curated binning a map's, each under what it does in plain words, a line an
 * argument as a shell takes it, with a copy button, and over what follows from
 * it: what a reassignment keeps of the file and drops, and why the annotation.
 *
 * The dialog is asked from the press itself, before anything is made, and what
 * cannot be written is said on the button before it is pressed. What was
 * written, or why not, is said in the card: a toast sits under the stage.
 */

import { el } from '../../../ui/dom'
import { icon } from '../../../ui/icons'
import { captionStamp, chooseSaveTarget, copyTextToClipboard, type SaveTarget } from '../../../ui/export'
import { fmt } from '../../../units'
import type { Curation } from '../../../genome/curation'
import type { CurationStore } from '../../../state/curation'
import { contigGenomeTable, elementHostTable, elementsTable, genomesTable, linkDeciders, type CurationTable } from '../../exports'
import type { CurateChange } from '../../model'
import type { CurateContext } from '../context'
import type { CurateLayouts } from '../CurateStage'
import { card } from './card'
import { releaseFocusOnPointerPress } from './keyboard'

export interface ExportOptions {
  /** The stem every file is named from (`exportStem` of the map's label). */
  stem: string
  /** The curation, folded into the binning the tables are written from. */
  store: CurationStore
  /** When a table is written, for the line that says so; a clock the tests can hold. */
  now?: () => Date
  /** The genomes' edits of the reference (§27.10): the genomes' sequences are written as the session draws them. */
  layouts?: CurateLayouts
}

/** The genomes' sequences, in the order the card offers them (§33.8). */
type SequenceKind = 'agp' | 'fasta' | 'sequence-genome'

const SEQUENCE_FILES: ReadonlyArray<{ kind: SequenceKind; label: string; suffix: string }> = [
  { kind: 'agp', label: 'AGP', suffix: 'genomes.agp' },
  { kind: 'fasta', label: 'FASTA', suffix: 'genomes.fa' },
  { kind: 'sequence-genome', label: 'sequence → genome', suffix: 'sequence-genome.tsv' },
]

/** The tables, in the order the card offers them. */
type TableKind = 'contig-genome' | 'genomes' | 'elements' | 'element-hosts'

const TABLES: ReadonlyArray<{ kind: TableKind; label: string; suffix: string; title: string }> = [
  {
    kind: 'contig-genome',
    label: 'contig → genome',
    suffix: 'contig-genome.tsv',
    title: 'Every contig of the file and the genome it is in now, the pool as __unbinned__: what metacooler reassign takes',
  },
  {
    kind: 'genomes',
    label: 'genomes',
    suffix: 'genomes.tsv',
    title: 'Every genome with metaTOR’s mge flag and a MAG’s elements: what metacooler annotate takes once the map is reassigned',
  },
  { kind: 'elements', label: 'elements', suffix: 'elements.tsv', title: 'Every mobile element, its length, its contigs and its hosts' },
  {
    kind: 'element-hosts',
    label: 'element ↔ host',
    suffix: 'element-hosts.tsv',
    title: 'Every element and MAG in contact or linked: their contacts and affinity, whether a link holds, and who decided it',
  },
]

/** How many times a write waits for the count of the binning as it stands, a step made meanwhile. */
const COUNTS_WAITED = 3

/** A file name or a map in a command, quoted for a shell where it needs to be. */
function shellWord(word: string): string {
  return /^[A-Za-z0-9_./:@%+=,-]+$/.test(word) ? word : `'${word.replace(/'/g, `'\\''`)}'`
}

/**
 * A command as the card prints it and the copy button copies it: the program
 * and its verb on the first line, then each argument on a line of its own — a
 * flag with its value —, indented, ` \` continuing every line but the last,
 * so a shell runs the lines pasted as one command.
 */
export function commandText(lines: ReadonlyArray<readonly string[]>): string {
  return lines.map((words, k) => `${k === 0 ? '' : '  '}${words.map(shellWord).join(' ')}`).join(' \\\n')
}

/** A size as the card says it: its number and its unit kept on one line (`56.5 kB`). */
function sizeText(bytes: number): string {
  return fmt.bytes(bytes).replace(' ', '\u00a0')
}

/**
 * The map as `metacooler` names it, from the stage's label: the file's name, a
 * collection's entry as `file.mmetacool::entries/<name>`; `MAP` where the
 * label is a name the reader gave it.
 */
export function mapArgument(title: string): string {
  const [path, entry] = title.split('::')
  const name = path.split(/[\\/]/).pop() ?? path
  if (/\.mmetacool$/i.test(name) && entry !== undefined && entry !== '') return `${name}::${entry.startsWith('entries/') ? entry : `entries/${entry.replace(/^\/+/, '')}`}`
  if (/\.metacool$/i.test(name) && entry === undefined) return name
  return 'MAP'
}

/**
 * What a table is written from: the binning, by its fingerprint — its genomes,
 * their names and kinds, its links, every contig's genome —, and for the
 * element ↔ host pairs who decided each link as well. An undo and a redo give
 * the same binning, whose tables are as written.
 */
function writtenFrom(kind: TableKind, fingerprint: string, curation: Curation): string {
  return kind === 'element-hosts' ? `${fingerprint}\n${JSON.stringify([...linkDeciders(curation)])}` : fingerprint
}

/** What a table's note says of what it holds: the facts, without the command the card prints whole. */
function facts(note: string): string {
  const at = note.indexOf(': `')
  const said = (at < 0 ? note : note.slice(0, at)).trim()
  return said === '' || /[.!?]$/.test(said) ? said : `${said}.`
}

export class ExportCard {
  readonly element: HTMLElement
  private readonly files: HTMLElement
  private readonly status: HTMLElement
  private readonly stale: HTMLElement
  private readonly recipe: HTMLElement
  private readonly buttons = new Map<TableKind, HTMLButtonElement>()
  /** The genomes' sequences' buttons, where the reference editing is on. */
  private readonly sequenceButtons = new Map<SequenceKind, HTMLButtonElement>()
  private readonly layouts: CurateLayouts | null
  private readonly store: CurationStore
  private readonly stem: string
  private readonly now: () => Date
  /** The names the reader wrote the tables under, which the commands then use. */
  private readonly written = new Map<TableKind, string>()
  /** What each table was written from ({@link writtenFrom}): another binning since makes it old. */
  private readonly writtenOf = new Map<TableKind, string>()
  private busy = false
  private frame = 0
  private disposed = false
  private readonly unsubscribe: Array<() => void> = []

  constructor(
    private readonly ctx: CurateContext,
    options: ExportOptions,
  ) {
    this.store = options.store
    this.stem = options.stem
    this.now = options.now ?? (() => new Date())
    this.layouts = options.layouts ?? null
    const built = card('export')
    this.element = built.element
    this.element.classList.add('curate-export-card')
    this.files = el('div', { class: 'edit-export-files curate-export-files' })
    for (const table of TABLES) {
      const button = el(
        'button',
        {
          class: 'btn edit-export-file curate-export-file',
          attrs: { type: 'button', 'data-format': table.kind },
          on: { click: () => void this.write(table.kind) },
        },
        el('span', { class: 'curate-export-label', text: table.label }),
      )
      this.buttons.set(table.kind, button)
      this.files.appendChild(button)
    }
    this.status = el('p', { class: 'edit-note edit-export-status curate-export-status', attrs: { role: 'status' } })
    this.stale = el('p', { class: 'edit-note curate-export-stale hidden', text: 'The binning has changed since: a table without its tick was written from the binning as it was.' })
    this.recipe = el('ol', { class: 'curate-export-recipe', attrs: { 'aria-label': 'The tables into a map' } })
    // A table pressed keeps no keyboard: review's Space would open the dialog again.
    releaseFocusOnPointerPress(this.element)
    // The genomes' sequences, each laid out as its edit has it (§27.10).
    const sequences =
      this.layouts === null
        ? []
        : [
            el('h4', { class: 'edit-card-sub curate-export-sub', text: 'the genomes’ sequences' }),
            el(
              'div',
              { class: 'edit-export-files curate-export-files curate-export-sequences' },
              ...SEQUENCE_FILES.map((file) => {
                const button = el(
                  'button',
                  {
                    class: 'btn edit-export-file curate-export-file',
                    attrs: { type: 'button', 'data-format': file.kind },
                    on: { click: () => void this.writeSequences(file.kind) },
                  },
                  el('span', { class: 'curate-export-label', text: file.label }),
                )
                this.sequenceButtons.set(file.kind, button)
                return button
              }),
            ),
          ]
    built.body.append(
      el('p', { class: 'edit-note', text: 'Written from the curation; no file the session opened is touched.' }),
      this.files,
      ...sequences,
      this.status,
      this.stale,
      el('h4', { class: 'edit-card-sub curate-export-sub', text: 'then, into a map' }),
      this.recipe,
    )
    this.unsubscribe.push(ctx.model.subscribe((change) => this.update(change)))
    this.unsubscribe.push(this.store.subscribe(() => this.schedule()))
    this.paint()
  }

  /** What changed: a count says whether there are elements and their contacts. */
  update(change: CurateChange): void {
    if (change === 'state' || change === 'error') this.schedule()
  }

  dispose(): void {
    this.disposed = true
    cancelAnimationFrame(this.frame)
    for (const off of this.unsubscribe) off()
  }

  private schedule(): void {
    if (this.disposed) return
    cancelAnimationFrame(this.frame)
    this.frame = requestAnimationFrame(() => this.paint())
  }

  private paint(): void {
    if (this.disposed) return
    const { binning, curation } = this.store
    const fingerprint = binning.fingerprint()
    const now = new Map(TABLES.map((table) => [table.kind, writtenFrom(table.kind, fingerprint, curation)]))
    for (const table of TABLES) {
      const button = this.buttons.get(table.kind)
      if (button === undefined) continue
      const why = this.refusal(table.kind)
      button.disabled = this.busy || why !== null
      // Written from the binning as it stands: ticked, under the name it was written as.
      const written = this.writtenOf.get(table.kind) === now.get(table.kind) ? this.written.get(table.kind) : undefined
      button.title = why ?? `${table.title} (${written === undefined ? this.name(table.kind) : `written as ${written}`})`
      button.classList.toggle('is-written', written !== undefined)
      const tick = button.querySelector('.curate-export-tick')
      if (written !== undefined && tick === null) button.appendChild(icon('check', { size: 13, class: 'curate-export-tick' }))
      else if (written === undefined) tick?.remove()
    }
    this.stale.classList.toggle('hidden', ![...this.writtenOf].some(([kind, from]) => from !== now.get(kind)))
    this.paintSequences()
    this.paintRecipe()
  }

  /** The genomes' sequences' buttons: what each writes, and the FASTA only where the session holds the sequence. */
  private paintSequences(): void {
    const layouts = this.layouts
    if (layouts === null) return
    const from = layouts.sequenceFrom()
    const titles: Record<SequenceKind, string> = {
      agp: 'Every genome’s sequences as the session draws them, an AGP 2.1: laid out by its edit of the reference where it has one, else its contigs whole; the pool left out',
      fasta:
        from === null
          ? 'Load the assembly’s FASTA or .2bit into the session to write the genomes’ sequences'
          : `Every genome’s sequences from ${from}, as the AGP lays them out: turned stretches reverse-complemented, gaps as N, each record naming its genome`,
      'sequence-genome': 'Every sequence of the AGP and the FASTA, the genome it is of, its length and what it is made of',
    }
    for (const file of SEQUENCE_FILES) {
      const button = this.sequenceButtons.get(file.kind)
      if (button === undefined) continue
      button.disabled = this.busy || (file.kind === 'fasta' && from === null)
      button.title = `${titles[file.kind]} (${this.stem}.${file.suffix})`
    }
  }

  /** Write the genomes' sequences: the dialog first, from the press; the file made once there is somewhere to put it. */
  private async writeSequences(kind: SequenceKind): Promise<void> {
    const layouts = this.layouts
    if (layouts === null || this.busy) return
    if (kind === 'fasta' && layouts.sequenceFrom() === null) {
      this.say('Load the assembly’s FASTA or .2bit into the session to write the genomes’ sequences.')
      return
    }
    const suffix = SEQUENCE_FILES.find((file) => file.kind === kind)?.suffix ?? 'txt'
    const target = await chooseSaveTarget(`${this.stem}.${suffix}`, kind === 'sequence-genome' ? 'text/tab-separated-values' : 'text/plain')
    if (target === null || this.disposed) return
    this.busy = true
    this.paint()
    try {
      let blob: Blob
      let said = ''
      if (kind === 'agp') {
        const agp = layouts.agp()
        blob = new Blob([agp.text], { type: 'text/plain' })
        said = `${fmt.int(agp.sequences)} ${agp.sequences === 1 ? 'sequence' : 'sequences'}, ${fmt.int(agp.laidOut)} ${agp.laidOut === 1 ? 'genome' : 'genomes'} laid out by ${agp.laidOut === 1 ? 'its edit' : 'their edits'}.`
      } else if (kind === 'sequence-genome') {
        const table = layouts.sequences()
        blob = new Blob([table.text], { type: 'text/tab-separated-values' })
        said = `${fmt.int(table.rows)} ${table.rows === 1 ? 'sequence' : 'sequences'}.`
      } else {
        const out = await layouts.fasta(
          (done, total) => this.say(`Writing the FASTA · ${Math.floor((100 * done) / Math.max(1, total))}%`),
          () => this.disposed,
        )
        if (out === null) {
          this.say('FASTA: not written.')
          return
        }
        blob = out.blob
        if (out.missing.length > 0) said = `${layouts.sequenceFrom() ?? 'The sequence'} has no ${out.missing.slice(0, 3).join(', ')}${out.missing.length > 3 ? ' and others' : ''}: written as N.`
      }
      await target.write(blob)
      const time = captionStamp(this.now()).slice(11)
      this.say(`Wrote ${target.name} (${sizeText(blob.size)}) at ${time}. ${said}`.trim())
    } catch (err) {
      this.say(`Could not write ${target.name}: ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      this.busy = false
      this.paint()
    }
  }

  /** The file a table is written as, unless the reader named it otherwise. */
  private name(kind: TableKind): string {
    return `${this.stem}.${TABLES.find((table) => table.kind === kind)?.suffix ?? 'tsv'}`
  }

  /**
   * Why a table cannot be written now, or `null`: said on its button, before
   * any dialog opens. The binning is the store's, as the tables are — a step
   * just made counts before it is counted —; only the element ↔ host pairs
   * wait for the count, whose contacts they give.
   */
  private refusal(kind: TableKind): string | null {
    if (kind !== 'elements' && kind !== 'element-hosts') return null
    if (!this.store.binning.genomes.some((genome) => genome.kind === 'element')) return 'No mobile element in this binning: there is nothing to write.'
    if (kind === 'elements') return null
    const answer = this.ctx.model.answer
    if (answer === null) return 'Once the binning is counted.'
    if (!answer.counted) return 'Once the contacts are read: the table gives each pair’s contacts and affinity.'
    return null
  }

  /**
   * The two commands, each under what it does in plain words and over what
   * follows from it, with its copy button: the names the reader wrote the
   * tables under.
   */
  private paintRecipe(): void {
    const curated = `${this.stem}.curated.metacool`
    const contigs = this.written.get('contig-genome') ?? this.name('contig-genome')
    const genomes = this.written.get('genomes') ?? this.name('genomes')
    const map = mapArgument(this.ctx.data.title)
    const commands = [
      {
        does: 'Write the curated map',
        // Regrouped as the session drew it, whatever order the file kept: `auto` keeps a map's own when it was not grouped by genome.
        lines: [['metacooler', 'reassign'], [map], ['--contigs', contigs], ['--layout', 'genome-then-length'], ['-o', curated]],
        title: `The curated binning made a map’s: a new file, the contigs regrouped by genome, longest first, as the session draws them${map === 'MAP' ? '; MAP is the map’s file, which its name here does not say' : ''}`,
        // What a reassignment keeps of the file, and what it drops (§33.8).
        then: 'A new file. It keeps metaTOR’s clustering rounds and each genome’s own columns as they were, even where its contigs changed, and drops the normalisation weights tied to the old binning.',
        note: 'curate-export-keeps',
      },
      {
        does: 'Restore the elements',
        lines: [['metacooler', 'annotate'], [curated], ['--genomes', genomes], ['--replace'], ['--inplace']],
        title: 'Its genomes’ mge flags and elements, from the genomes table',
        then: 'A renamed or new genome starts without the file’s columns: this gives every genome its mobile-element flag, and every MAG its elements.',
        note: 'curate-export-why',
      },
    ].map((command) => ({ ...command, text: commandText(command.lines) }))
    const signature = commands.map((command) => command.text).join('\n\n')
    if (this.recipe.dataset.commands === signature) return
    this.recipe.dataset.commands = signature
    this.recipe.replaceChildren(
      ...commands.map((command) => {
        const code = el('code', { class: 'curate-export-command', title: command.title })
        command.lines.forEach((words, k) => {
          // A line an argument, its text the command's own. A line too long for
          // the card breaks between a flag and its value, the value under the
          // flag, indented; never inside a name, nor before its ` \`.
          const last = k === command.lines.length - 1
          const line = el('span', { class: 'curate-export-line' }, k === 0 ? null : '  ')
          words.map(shellWord).forEach((word, w) => {
            if (w > 0) line.append(' ')
            line.append(el('span', { class: 'curate-export-word', text: w === words.length - 1 && !last ? `${word} \\` : word }))
          })
          if (!last) line.append('\n')
          code.append(line)
        })
        return el(
          'li',
          { class: 'curate-export-step' },
          el('span', { class: 'curate-export-does', text: command.does }),
          this.copyButton(command.text, code),
          code,
          el('p', { class: `edit-note curate-export-then ${command.note}`, text: command.then }),
        )
      }),
    )
  }

  /**
   * A button that puts a command on the clipboard, and says so with a tick for
   * a moment; where the browser will not write to it, the command is selected
   * instead, a copy one key away.
   */
  private copyButton(text: string, code: HTMLElement): HTMLButtonElement {
    const label = 'Copy the command'
    const button = el('button', { class: 'btn btn-icon curate-export-copy', title: label, attrs: { type: 'button', 'aria-label': label } }, icon('copy', { size: 13 }))
    let reset: ReturnType<typeof setTimeout> | null = null
    button.addEventListener('click', () => {
      copyTextToClipboard(text).then(
        () => {
          button.classList.add('is-copied')
          button.replaceChildren(icon('check', { size: 13 }))
          button.title = 'Copied'
          if (reset !== null) clearTimeout(reset)
          reset = setTimeout(() => {
            button.classList.remove('is-copied')
            button.replaceChildren(icon('copy', { size: 13 }))
            button.title = label
          }, 1400)
        },
        () => {
          window.getSelection()?.selectAllChildren(code)
          button.title = 'Selected: copy it with the keyboard'
        },
      )
    })
    return button
  }

  private say(text: string): void {
    this.status.textContent = text
  }

  /** Write one table: the dialog first, from the press; the table made once there is somewhere to put it. */
  private async write(kind: TableKind): Promise<void> {
    if (this.busy) return
    const refused = this.refusal(kind)
    if (refused !== null) {
      this.say(refused)
      return
    }
    const target = await chooseSaveTarget(this.name(kind), 'text/tab-separated-values')
    if (target === null || this.disposed) return
    this.busy = true
    this.paint()
    try {
      await this.save(kind, target)
    } finally {
      this.busy = false
      this.paint()
    }
  }

  private async save(kind: TableKind, target: SaveTarget): Promise<void> {
    try {
      const { table, from } = await this.table(kind)
      const blob = new Blob([table.text], { type: 'text/tab-separated-values' })
      await target.write(blob)
      this.written.set(kind, target.name)
      this.writtenOf.set(kind, from)
      const time = captionStamp(this.now()).slice(11)
      this.say(`Wrote ${target.name} (${sizeText(blob.size)}) at ${time}. ${facts(table.note)}`)
    } catch (err) {
      this.say(`Could not write ${target.name}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  /**
   * A table of the binning as it stands, and what it was written from
   * ({@link writtenFrom}); the element ↔ host pairs from that binning's own
   * count, waited for.
   */
  private async table(kind: TableKind): Promise<{ table: CurationTable; from: string }> {
    const { store } = this
    const { names, lengths } = store.file
    if (kind === 'element-hosts') return this.hostTable()
    const binning = store.binning
    const from = writtenFrom(kind, binning.fingerprint(), store.curation)
    switch (kind) {
      case 'contig-genome':
        return { table: contigGenomeTable(binning, names), from }
      case 'genomes':
        return { table: genomesTable(binning), from }
      case 'elements':
        return { table: elementsTable(binning, names, lengths), from }
    }
  }

  /** The element ↔ host pairs: the count's, by genome index, so of the binning that count is of, waited for, or none. */
  private async hostTable(): Promise<{ table: CurationTable; from: string }> {
    const { store } = this
    const model = this.ctx.model
    for (let k = 0; k < COUNTS_WAITED; k++) {
      await model.settled()
      const answer = model.answer
      const { binning, curation } = store
      const fingerprint = binning.fingerprint()
      if (answer !== null && answer.counted && answer.fingerprint === fingerprint) {
        return { table: elementHostTable(binning, answer.hosts, curation), from: writtenFrom('element-hosts', fingerprint, curation) }
      }
      if (answer !== null && !answer.counted) break
    }
    throw new Error('the contacts of the binning as it stands are not counted yet; try again in a moment')
  }
}
