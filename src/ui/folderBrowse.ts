/**
 * One level of one folder, with the way back up and a filter over it.
 *
 * This was `ui/bucketBrowse.ts` and was a bucket's, and the day a directory on
 * the machine became a folder too it stopped being able to be: crumbs, a filter,
 * a list of rows, a navigation token and a line saying what is not showing are
 * the same five things over a `ListObjectsV2` answer and over a
 * `FileSystemDirectoryHandle`. So the view took `browse/folder.ts`'s interface
 * instead of a `BucketScope`, and the difference between a bucket and a disk is
 * now entirely inside the two backends. `bucketBrowse.ts` is the bucket-shaped
 * door onto this, unchanged in what it offers.
 *
 * ## Filtering is filtering, not searching
 *
 * The box above the list narrows **what was listed**, which is one level of one
 * folder. It is not a search and does not pretend to be. On a bucket there is no
 * such call — `ListObjectsV2` matches a key *prefix*, never a substring — so a
 * search across a collection means walking every sub-prefix, one signed request
 * each, against a key that may be allowed some of them and not others. On a disk
 * it would be an unbounded walk of somebody's home directory. The count under
 * the box says how many of how many are showing, which is the line that keeps
 * "not in this folder" from reading as "not anywhere".
 *
 * ## A row is a button, and may carry a second one
 *
 * Clicking a row is the plain gesture and it means *this one*: a folder opens, a
 * file is picked. The Files panel needs a second verb on the same row — load it
 * into the tab that is open, without leaving the folder — so a row may be given
 * trailing controls. They are `<button>`s inside the row's own `<button>`,
 * which is invalid HTML, so the row is a `<div role="button">` with its own key
 * handling instead. That is the one piece of DOM ceremony in this file and it
 * buys the whole two-verb arrangement.
 *
 * ## What a row cannot open, it says rather than hides
 *
 * A directory holds `.bam`s and `README`s and this app opens neither. Dropping
 * them from the list would make the folder view disagree with the folder, which
 * is the one thing it is for; so they are drawn dimmed, unclickable, with the
 * reason in the tooltip (`browse/route.ts`).
 */

import { button, el, fmt } from './dom'
import { icon } from './icons'
import { unroutableNote } from '../browse/route'
import { crumbsOf, type ConnectedFolder, type FolderEntry, type FolderListing } from '../browse/folder'

export interface FolderBrowseProps {
  /** The plain click on a file row. */
  onPick(entry: FolderEntry, folder: ConnectedFolder): void
  /**
   * Trailing controls for a file row — the Files panel's load arrow.
   *
   * Given the entry and its folder, and expected to return controls or nothing.
   * A function rather than a flag because the row cannot know what the verbs
   * are, and the host cannot know which rows exist until the listing lands.
   */
  rowExtras?(entry: FolderEntry, folder: ConnectedFolder): HTMLElement[]
  /** Make file rows draggable, and say what a drag carries. */
  onDragStart?(event: DragEvent, entry: FolderEntry, folder: ConnectedFolder): void
  /** Whether a file row the folder offers can be dragged; every one, where this is absent. */
  canDrag?(entry: FolderEntry): boolean
}

/**
 * Holds the listing it drew, so typing in the filter repaints from memory
 * rather than re-listing: a signed request per keystroke would be a preflight
 * per keystroke, and the answer would not change.
 */
export class FolderBrowseView {
  readonly el: HTMLElement
  private readonly crumbsEl = el('div', { class: 'folder-crumbs' })
  private readonly filterRow: HTMLElement
  private readonly filterInput: HTMLInputElement
  private readonly entriesEl = el('div', { class: 'folder-entries' })
  private readonly noteEl = el('p', { class: 'hint folder-note' })
  /** Bumped on every navigation, so a slow listing cannot overwrite a fast one. */
  private navigation = 0
  private at: { folder: ConnectedFolder; path: string } | null = null
  private listing: FolderListing | null = null

  constructor(private readonly props: FolderBrowseProps) {
    // Built once and never replaced, because it is where the caret is: a filter
    // input rebuilt on each repaint loses focus on the first character typed
    // into it, which reads as the box refusing to accept typing.
    this.filterInput = el('input', {
      class: 'input input-tiny folder-filter',
      type: 'text',
      placeholder: 'filter this folder',
    })
    this.filterInput.addEventListener('input', () => this.paint())
    this.filterRow = el('div', { class: 'folder-filter-row hidden' }, this.filterInput)
    this.el = el(
      'div',
      { class: 'folder-browse hidden' },
      this.crumbsEl,
      this.filterRow,
      this.entriesEl,
      this.noteEl,
    )
  }

  /** Whether the folder with this id is the one on screen. */
  isShowing(id: string): boolean {
    return this.at?.folder.id === id
  }

  /** The folder on screen, or `null`. */
  get folder(): ConnectedFolder | null {
    return this.at?.folder ?? null
  }

  /** Put the view back to showing nothing — a folder was removed, or a dialog closed. */
  clear(): void {
    this.navigation++
    this.at = null
    this.listing = null
    this.el.classList.add('hidden')
    this.crumbsEl.replaceChildren()
    this.entriesEl.replaceChildren()
    this.noteEl.textContent = ''
    this.filterRow.classList.add('hidden')
  }

  /** List one level of `path` in `folder`. */
  async browse(folder: ConnectedFolder, path: string): Promise<void> {
    this.at = { folder, path }
    this.listing = null
    // The filter belongs to the folder it was typed in. Carried down into a
    // sub-folder it would hide most of what the reader had just opened, with
    // the reason for it two lines above the list and easy to miss.
    this.filterInput.value = ''
    const token = ++this.navigation

    this.el.classList.remove('hidden')
    this.crumbsEl.replaceChildren(...this.crumbs(folder, path))
    this.filterRow.classList.add('hidden')
    this.entriesEl.replaceChildren()
    this.noteEl.textContent = 'Listing…'
    this.noteEl.classList.remove('folder-error')

    let listing: FolderListing
    try {
      listing = await folder.list(path)
    } catch (err) {
      // A stale failure must not replace a newer view either: clicking two
      // folders quickly and having the first one's 403 land on the second is an
      // error message about a folder that is not on screen.
      if (token !== this.navigation) return
      this.noteEl.textContent = err instanceof Error ? err.message : String(err)
      this.noteEl.classList.add('folder-error')
      return
    }
    if (token !== this.navigation) return
    this.listing = listing
    this.paint()
  }

  /** Re-list what is on screen — a folder reconnected, or a directory that changed. */
  async refresh(): Promise<void> {
    if (this.at === null) return
    await this.browse(this.at.folder, this.at.path)
  }

  private paint(): void {
    const at = this.at
    const listing = this.listing
    if (at === null || listing === null) return
    const { folder, path } = at

    const needle = this.filterInput.value.trim().toLowerCase()
    const shown = (name: string): boolean => needle === '' || name.toLowerCase().includes(needle)

    const rows: HTMLElement[] = []
    for (const entry of listing.entries) {
      if (!shown(entry.name)) continue
      rows.push(entry.kind === 'folder' ? this.folderRow(entry, folder) : this.fileRow(entry, folder))
    }

    const total = listing.entries.length
    // The filter appears only when there is enough to be worth narrowing. Under
    // that, it is a control that costs a line and saves nothing — and one that
    // makes a folder holding three files look like a search screen.
    this.filterRow.classList.toggle('hidden', total < FILTER_FROM)
    this.entriesEl.replaceChildren(...rows)
    this.entriesEl.classList.toggle('hidden', rows.length === 0)
    this.noteEl.classList.remove('folder-error')
    this.noteEl.textContent = note(total, rows.length, needle !== '', listing.truncated, path)
  }

  private folderRow(entry: FolderEntry, folder: ConnectedFolder): HTMLElement {
    const row = el(
      'button',
      { class: 'folder-entry', type: 'button' },
      icon('chevron-right', { size: 14 }),
      el('span', { class: 'folder-entry-name', text: `${entry.name}/` }),
    )
    row.addEventListener('click', () => void this.browse(folder, entry.path))
    return row
  }

  /**
   * A file row: the name, its size, and whatever verbs the host added.
   *
   * A `div` with `role="button"` rather than a `<button>`, because the load
   * arrow is a button and a button inside a button is invalid HTML that browsers
   * resolve by dropping one of them. The keyboard handling a real button would
   * have brought is written out below; there is no third option that keeps both
   * verbs reachable.
   */
  private fileRow(entry: FolderEntry, folder: ConnectedFolder): HTMLElement {
    const why = unroutableNote(entry.name)
    const extras = why === null ? (this.props.rowExtras?.(entry, folder) ?? []) : []
    const row = el(
      'div',
      {
        class: why === null ? 'folder-entry folder-entry-file' : 'folder-entry folder-entry-inert',
        title: why ?? '',
        attrs: why === null ? { role: 'button', tabindex: '0' } : {},
      },
      el('span', { class: 'folder-entry-name', text: entry.name }),
      entry.size === null ? null : el('span', { class: 'folder-entry-size', text: fmt.bytes(entry.size) }),
      ...extras,
    )
    if (why !== null) return row

    const pick = (): void => this.props.onPick(entry, folder)
    row.addEventListener('click', (event) => {
      // A click that landed on one of the trailing verbs is that verb's, not the
      // row's. Without this, pressing the load arrow would also pick the file.
      //
      // `Element`, not `HTMLElement`, and that distinction is the whole of the
      // guard: the arrow's visible pixels are an inline `<svg>`, which is an
      // `SVGElement` — so a test against `HTMLElement` passes for a click on the
      // button's padding and fails for a click on the glyph in the middle of it,
      // which is where a hand actually lands. `App.ts` records the same mistake
      // costing a deck edge its drop.
      if (event.target instanceof Element && event.target.closest('button') !== null) return
      pick()
    })
    row.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' && event.key !== ' ') return
      if (event.target !== row) return
      event.preventDefault()
      pick()
    })

    const drag = this.props.onDragStart
    if (drag !== undefined && (this.props.canDrag?.(entry) ?? true)) {
      row.draggable = true
      row.addEventListener('dragstart', (event) => drag(event, entry, folder))
    }
    return row
  }

  /**
   * The path back up, as clickable segments.
   *
   * Rooted at the folder's **own** root rather than at the top of the bucket or
   * the disk: a bucket key may well not be allowed to list above the prefix it
   * was given, and a directory grant reaches down and never up, so a crumb
   * leading there would be a click that fails.
   */
  private crumbs(folder: ConnectedFolder, path: string): HTMLElement[] {
    const nodes: HTMLElement[] = [
      button(folder.label, () => void this.browse(folder, folder.root), { class: 'btn-link' }),
    ]
    let walked = folder.root
    for (const part of crumbsOf(folder.root, path)) {
      walked = `${walked}${part}/`
      const target = walked
      nodes.push(el('span', { class: 'folder-crumb-sep', text: '/' }))
      // A backend whose paths are ids rather than names says what to print.
      const label = folder.labelOf?.(target) ?? part
      nodes.push(button(label, () => void this.browse(folder, target), { class: 'btn-link' }))
    }
    return nodes
  }
}

/** Below this many entries a folder is read rather than searched. */
const FILTER_FROM = 8

/**
 * The line under the list: what is showing, and what is not.
 *
 * Three facts compete for it and only one can be wrong in a way that costs
 * anybody an afternoon, so truncation wins whenever it applies: "my file is not
 * here" and "my file is past the cap" look identical otherwise, and the second
 * is not a thing a reader can guess.
 */
export function note(
  total: number,
  showing: number,
  filtered: boolean,
  truncated: boolean,
  path: string,
): string {
  if (truncated) {
    return (
      `Only the first 1,000 entries of ${path === '' ? 'this folder' : path} are listed and there ` +
      'are more. Open a sub-folder, or name the file directly.'
    )
  }
  if (total === 0) return 'Nothing in this folder.'
  if (!filtered) return ''
  if (showing === 0) {
    return `Nothing here matches. ${total} ${total === 1 ? 'entry' : 'entries'} in this folder.`
  }
  return `${showing} of ${total} in this folder. The filter reads this level, not the whole tree.`
}
