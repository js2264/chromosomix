/**
 * The inspector's export card (SPECS §33.8): the curation written as the
 * tables `metacooler` and `metaTOR` take — contig → genome, the genomes with
 * metaTOR's `mge` flag, the elements, the element ↔ host pairs — each a new
 * file through the save dialog (§26.6), named after the map, none of them
 * touching a file the session opened; then the two commands that make the
 * curated binning a map's, each with a copy button, and what a reassignment
 * keeps of the file.
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
import { contigGenomeTable, elementHostTable, elementsTable, genomesTable, type CurationTable } from '../../exports'
import type { CurateChange } from '../../model'
import type { CurateContext } from '../context'
import { card } from './card'

export interface ExportOptions {
  /** The stem every file is named from (`exportStem` of the map's label). */
  stem: string
  /** The curation, folded into the binning the tables are written from. */
  store: CurationStore
  /** When a table is written, for the line that says so; a clock the tests can hold. */
  now?: () => Date
}

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
  private readonly store: CurationStore
  private readonly stem: string
  private readonly now: () => Date
  /** The names the reader wrote the tables under, which the commands then use. */
  private readonly written = new Map<TableKind, string>()
  /** The curation each table was written from: a step since makes it old. */
  private readonly writtenFrom = new Map<TableKind, Curation>()
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
    this.stale = el('p', { class: 'edit-note curate-export-stale hidden', text: 'The curation has changed since: these tables are of the binning as it was.' })
    this.recipe = el('ol', { class: 'curate-export-recipe', attrs: { 'aria-label': 'The tables into a map' } })
    built.body.append(
      el('p', { class: 'edit-note', text: 'Written from the curation; no file the session opened is touched.' }),
      this.files,
      this.status,
      this.stale,
      el('h4', { class: 'edit-card-sub curate-export-sub', text: 'then, into a map' }),
      this.recipe,
      el('p', {
        class: 'edit-note curate-export-keeps',
        text: 'A reassignment keeps metaTOR’s clustering rounds and a changed genome’s own columns as they were, keeps no weight that depends on the assignment, and starts a renamed or new genome without the file’s columns: the annotation gives each genome its mge flag and its elements back.',
      }),
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
    const now = this.store.curation
    for (const table of TABLES) {
      const button = this.buttons.get(table.kind)
      if (button === undefined) continue
      const why = this.refusal(table.kind)
      button.disabled = this.busy || why !== null
      // Written from the curation as it stands: ticked, under the name it was written as.
      const written = this.writtenFrom.get(table.kind) === now ? this.written.get(table.kind) : undefined
      button.title = why ?? `${table.title} (${written === undefined ? this.name(table.kind) : `written as ${written}`})`
      button.classList.toggle('is-written', written !== undefined)
      const tick = button.querySelector('.curate-export-tick')
      if (written !== undefined && tick === null) button.appendChild(icon('check', { size: 13, class: 'curate-export-tick' }))
      else if (written === undefined) tick?.remove()
    }
    this.stale.classList.toggle('hidden', ![...this.writtenFrom.values()].some((from) => from !== now))
    this.paintRecipe()
  }

  /** The file a table is written as, unless the reader named it otherwise. */
  private name(kind: TableKind): string {
    return `${this.stem}.${TABLES.find((table) => table.kind === kind)?.suffix ?? 'tsv'}`
  }

  /** Why a table cannot be written now, or `null`: said on its button, before any dialog opens. */
  private refusal(kind: TableKind): string | null {
    if (kind !== 'elements' && kind !== 'element-hosts') return null
    const answer = this.ctx.model.answer
    if (answer === null) return 'Once the binning is counted.'
    if (!answer.genomes.some((genome) => genome.kind === 'element')) return 'No mobile element in this binning: there is nothing to write.'
    if (kind === 'element-hosts' && !answer.counted) return 'Once the contacts are read: the table gives each pair’s contacts and affinity.'
    return null
  }

  /** The two commands, each with its copy button: the names the reader wrote the tables under. */
  private paintRecipe(): void {
    const curated = `${this.stem}.curated.metacool`
    const contigs = this.written.get('contig-genome') ?? this.name('contig-genome')
    const genomes = this.written.get('genomes') ?? this.name('genomes')
    const map = mapArgument(this.ctx.data.title)
    const commands = [
      {
        words: ['metacooler', 'reassign', map, '--contigs', contigs, '-o', curated],
        title: `The curated binning made a map’s: a new file, the contigs regrouped by genome${map === 'MAP' ? '; MAP is the map’s file, which its name here does not say' : ''}`,
      },
      {
        words: ['metacooler', 'annotate', curated, '--genomes', genomes, '--replace', '--inplace'],
        title: 'Its genomes’ mge flags and elements, from the genomes table',
      },
    ].map((command) => ({ ...command, words: command.words.map(shellWord) }))
    const signature = commands.map((command) => command.words.join(' ')).join('\n')
    if (this.recipe.dataset.commands === signature) return
    this.recipe.dataset.commands = signature
    this.recipe.replaceChildren(
      ...commands.map((command) => {
        // A word at a time: a line breaks between two, never inside `--inplace`.
        const code = el('code', { class: 'curate-export-command', title: command.title })
        command.words.forEach((word, k) => {
          if (k > 0) code.append(' ')
          code.append(el('span', { class: 'curate-export-word', text: word }))
        })
        return el('li', { class: 'curate-export-step' }, code, this.copyButton(command.words.join(' '), code))
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
      this.writtenFrom.set(kind, from)
      const time = captionStamp(this.now()).slice(11)
      this.say(`Wrote ${target.name} (${fmt.bytes(blob.size)}) at ${time}. ${facts(table.note)}`)
    } catch (err) {
      this.say(`Could not write ${target.name}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  /**
   * A table of the binning as it stands, and the curation it was folded from;
   * the element ↔ host pairs from that binning's own count, waited for.
   */
  private async table(kind: TableKind): Promise<{ table: CurationTable; from: Curation }> {
    const { store } = this
    const { names, lengths } = store.file
    const from = store.curation
    switch (kind) {
      case 'contig-genome':
        return { table: contigGenomeTable(store.binning, names), from }
      case 'genomes':
        return { table: genomesTable(store.binning), from }
      case 'elements':
        return { table: elementsTable(store.binning, names, lengths), from }
      case 'element-hosts': {
        const model = this.ctx.model
        for (let k = 0; k < COUNTS_WAITED; k++) {
          await model.settled()
          const answer = model.answer
          const now = store.curation
          const binning = store.binning
          // The pairs are the count's, by genome index: of this very binning, or none.
          if (answer !== null && answer.counted && answer.fingerprint === binning.fingerprint()) return { table: elementHostTable(binning, answer.hosts, now), from: now }
          if (answer !== null && !answer.counted) break
        }
        throw new Error('the contacts of the binning as it stands are not counted yet; try again in a moment')
      }
    }
  }
}
