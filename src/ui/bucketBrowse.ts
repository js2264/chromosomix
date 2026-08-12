/**
 * The folder view over a private prefix, and the dialog that offers it anywhere.
 *
 * `BucketsCard` grew this first, and grew it in the wrong place: browsing lived
 * inside the screen where keys are *typed*, so reaching a file meant opening the
 * credentials dialog and scrolling past the secret-key form to a folder list
 * underneath it. That is the right home for the form and the wrong one for the
 * listing — the listing answers "which file", which is a question asked at every
 * box in the application that takes a URL, and not one of them is a place to be
 * looking at an access key.
 *
 * So the view is a component and the dialog around it is thin. `BucketsCard`
 * keeps it inline, where it still doubles as the test that a key just typed
 * works; every URL box opens the same view in a modal through
 * `ui/browseButton.ts`.
 *
 * ## Filtering is filtering, not searching
 *
 * The box above the list narrows **what was listed**, which is one level of one
 * prefix. It is not a bucket search and does not pretend to be: S3 has no such
 * call — `ListObjectsV2` matches a key *prefix*, never a substring — so a search
 * across a collection means walking every sub-prefix, one signed request each,
 * against a key that may be allowed to list some of them and not others. The
 * count under the box says how many of how many are showing, which is the line
 * that keeps "not in this folder" from reading as "not in the bucket".
 *
 * ## Why a picked file is opened rather than typed into the box
 *
 * The box beside the button is for a URL somebody has; this is for one they do
 * not, and handing back a forty-character signed-prefix URL for the reader to
 * press *add* on would be asking them to confirm a string they have no way to
 * check. The pick is the instruction. It carries the scope it was listed under,
 * so the file opens with the key that found it rather than with whatever a
 * second lookup resolves — the same rule `s3/attach.ts` states from the other
 * side.
 */

import { Modal } from './Modal'
import { button, el, fmt } from './dom'
import { icon } from './icons'
import { listPrefix, type BucketListing, type BucketObject } from '../s3/list'
import { addressOf, readScopes, scopeFor, type BucketScope } from '../s3/credentials'

/**
 * What a chosen file is handed back as.
 *
 * The scope is `null` only when the file was chosen through the credentials
 * dialog opened from the empty state, where the caller has a URL and no
 * listing behind it. Every caller treats that as "look the key up" — which is
 * what happens at the worker boundary anyway — so it is a narrowing, not a
 * failure.
 */
export type BucketPick = (url: string, scope: BucketScope | null) => void

export interface BrowseViewProps {
  onPick(object: BucketObject, scope: BucketScope): void
}

/**
 * One level of one prefix, with the way back up and a filter over it.
 *
 * Holds the listing it drew, so typing in the filter repaints from memory
 * rather than re-listing: a signed request per keystroke would be a preflight
 * per keystroke, and the answer would not change.
 */
export class BucketBrowseView {
  readonly el: HTMLElement
  private readonly crumbsEl = el('div', { class: 'bucket-crumbs' })
  private readonly filterRow: HTMLElement
  private readonly filterInput: HTMLInputElement
  private readonly entriesEl = el('div', { class: 'bucket-entries' })
  private readonly noteEl = el('p', { class: 'hint bucket-note-line' })
  /** Bumped on every navigation, so a slow listing cannot overwrite a fast one. */
  private navigation = 0
  private at: { scope: BucketScope; prefix: string } | null = null
  private listing: BucketListing | null = null

  constructor(private readonly props: BrowseViewProps) {
    // Built once and never replaced, because it is where the caret is: a filter
    // input rebuilt on each repaint loses focus on the first character typed
    // into it, which reads as the box refusing to accept typing.
    this.filterInput = el('input', {
      class: 'input input-tiny bucket-filter',
      type: 'text',
      placeholder: 'filter this folder',
    })
    this.filterInput.addEventListener('input', () => this.paint())
    this.filterRow = el('div', { class: 'bucket-filter-row hidden' }, this.filterInput)
    this.el = el(
      'div',
      { class: 'bucket-browse hidden' },
      this.crumbsEl,
      this.filterRow,
      this.entriesEl,
      this.noteEl,
    )
  }

  /** Whether the scope with this id is the one on screen. */
  isShowing(id: string): boolean {
    return this.at?.scope.id === id
  }

  /** Put the view back to showing nothing — a scope was removed, or a dialog closed. */
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

  /** List one level of `prefix`, signed with `scope`. */
  async browse(scope: BucketScope, prefix: string): Promise<void> {
    this.at = { scope, prefix }
    this.listing = null
    // The filter belongs to the folder it was typed in. Carried down into a
    // sub-prefix it would hide most of what the reader had just opened, with
    // the reason for it two lines above the list and easy to miss.
    this.filterInput.value = ''
    const token = ++this.navigation

    this.el.classList.remove('hidden')
    this.crumbsEl.replaceChildren(...this.crumbs(scope, prefix))
    this.filterRow.classList.add('hidden')
    this.entriesEl.replaceChildren()
    this.noteEl.textContent = 'Listing…'
    this.noteEl.classList.remove('bucket-error')

    let listing: BucketListing
    try {
      listing = await listPrefix(scope, prefix)
    } catch (err) {
      // A stale failure must not replace a newer view either: clicking two
      // folders quickly and having the first one's 403 land on the second is an
      // error message about a folder that is not on screen.
      if (token !== this.navigation) return
      this.noteEl.textContent = err instanceof Error ? err.message : String(err)
      this.noteEl.classList.add('bucket-error')
      return
    }
    if (token !== this.navigation) return
    this.listing = listing
    this.paint()
  }

  private paint(): void {
    const at = this.at
    const listing = this.listing
    if (at === null || listing === null) return
    const { scope, prefix } = at

    const needle = this.filterInput.value.trim().toLowerCase()
    const shown = (name: string): boolean => needle === '' || name.toLowerCase().includes(needle)

    // Folders first, then files — S3 returns them as two separate lists and
    // interleaving them by name would be inventing an order the bucket does not
    // have. Within each, S3's order is lexicographic and is left alone.
    const rows: HTMLElement[] = []
    for (const folder of listing.folders) {
      if (!shown(folder.name)) continue
      const row = el(
        'button',
        { class: 'bucket-entry', type: 'button' },
        icon('chevron-right', { size: 14 }),
        el('span', { class: 'bucket-entry-name', text: `${folder.name}/` }),
      )
      row.addEventListener('click', () => void this.browse(scope, folder.prefix))
      rows.push(row)
    }
    for (const object of listing.objects) {
      if (!shown(object.name)) continue
      const row = el(
        'button',
        { class: 'bucket-entry bucket-entry-file', type: 'button' },
        el('span', { class: 'bucket-entry-name', text: object.name }),
        el('span', { class: 'bucket-entry-size', text: fmt.bytes(object.size) }),
      )
      row.addEventListener('click', () => this.props.onPick(object, scope))
      rows.push(row)
    }

    const total = listing.folders.length + listing.objects.length
    // The filter appears only when there is enough to be worth narrowing. Under
    // that, it is a control that costs a line and saves nothing — and one that
    // makes a folder holding three files look like a search screen.
    this.filterRow.classList.toggle('hidden', total < FILTER_FROM)
    this.entriesEl.replaceChildren(...rows)
    this.entriesEl.classList.toggle('hidden', rows.length === 0)
    this.noteEl.classList.remove('bucket-error')
    this.noteEl.textContent = note(total, rows.length, needle !== '', listing.truncated, prefix)
  }

  /**
   * The path back up, as clickable segments.
   *
   * Rooted at the scope's *own* prefix rather than at the bucket root: the key
   * may well not be allowed to list above it, so offering a crumb that leads
   * there would be offering a click that 403s.
   */
  private crumbs(scope: BucketScope, prefix: string): HTMLElement[] {
    const root = addressOf(scope.base)?.prefix ?? ''
    const rest = prefix.slice(root.length).split('/').filter((part) => part !== '')
    const nodes: HTMLElement[] = [
      button(scope.label, () => void this.browse(scope, root), { class: 'btn-link' }),
    ]
    let walked = root
    for (const part of rest) {
      walked = `${walked}${part}/`
      const target = walked
      nodes.push(el('span', { class: 'bucket-crumb-sep', text: '/' }))
      nodes.push(button(part, () => void this.browse(scope, target), { class: 'btn-link' }))
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
 * here" and "my file is past the first thousand keys" look identical otherwise,
 * and the second is not a thing a reader can guess.
 */
export function note(
  total: number,
  showing: number,
  filtered: boolean,
  truncated: boolean,
  prefix: string,
): string {
  if (truncated) {
    return (
      `S3 returned the first 1,000 entries of ${prefix === '' ? 'this prefix' : prefix} and there ` +
      'are more. Open a sub-folder, or paste the file URL into the box.'
    )
  }
  if (total === 0) return 'Nothing under this prefix.'
  if (!filtered) return ''
  if (showing === 0) {
    return `Nothing here matches. ${total} ${total === 1 ? 'entry' : 'entries'} in this folder.`
  }
  return `${showing} of ${total} in this folder. The filter reads this level, not the whole bucket.`
}

/**
 * The browser as a dialog, for the URL boxes.
 *
 * Opens on the first stored scope rather than asking which — one is the common
 * case and the chooser above the list moves between them in a click, so
 * demanding the answer first would be a screen everybody passes through to get
 * to the screen they wanted.
 */
export function openBucketBrowser(props: { onPick: BucketPick; onClose?(): void }): Modal {
  return new Modal({
    title: 'Open from a bucket',
    variant: 'modal-wide',
    ...(props.onClose === undefined ? {} : { onClose: props.onClose }),
    body: (close) => browserBody(props.onPick, close),
  })
}

function browserBody(onPick: BucketPick, close: () => void): HTMLElement {
  const scopes = readScopes()
  if (scopes.length === 0) return emptyBody(onPick, close)

  const view = new BucketBrowseView({
    onPick: (object, scope) => {
      close()
      onPick(object.url, scope)
    },
  })
  const root = el('div', { class: 'modal-body bucket-body' })
  if (scopes.length > 1) root.append(chooser(scopes, view))
  root.append(view.el)
  void view.browse(scopes[0], addressOf(scopes[0].base)?.prefix ?? '')
  return root
}

/**
 * Which bucket, when there is more than one.
 *
 * Absent at one scope, because a row of one button is a label that can be
 * pressed. The marked button is the one being browsed, updated here rather than
 * from the view: clicking one of these is the only way the scope changes, so
 * there is nothing else to hear from.
 */
function chooser(scopes: readonly BucketScope[], view: BucketBrowseView): HTMLElement {
  const buttons = scopes.map((scope) =>
    button(scope.label, () => {}, { class: 'btn bucket-pick', title: scope.base }),
  )
  const mark = (chosen: BucketScope): void => {
    for (const [at, node] of buttons.entries()) {
      node.classList.toggle('is-on', scopes[at].id === chosen.id)
    }
  }
  for (const [at, node] of buttons.entries()) {
    const scope = scopes[at]
    node.addEventListener('click', () => {
      mark(scope)
      void view.browse(scope, addressOf(scope.base)?.prefix ?? '')
    })
  }
  mark(scopes[0])
  return el('div', { class: 'bucket-picks' }, ...buttons)
}

/**
 * What the dialog says with no key stored.
 *
 * A sentence and one button, rather than the credentials form inlined here: the
 * form belongs to one screen, and two copies of six fields that write the same
 * `localStorage` key is two places for the validation to drift apart.
 */
function emptyBody(onPick: BucketPick, close: () => void): HTMLElement {
  return el(
    'div',
    { class: 'modal-body bucket-body' },
    el('p', {
      class: 'hint',
      text:
        'No private buckets are set up yet. A bucket entry is a URL prefix and a read-only key: ' +
        'everything under that prefix is then listed and read signed, and nothing else changes. ' +
        'A file on a public URL needs none of this — paste it into the box instead.',
    }),
    el(
      'div',
      { class: 'bucket-actions' },
      button(
        'add a bucket…',
        () => {
          close()
          void import('./BucketsCard').then(({ openBuckets }) => {
            // The credentials dialog browses too, so a reader who came here for
            // a file gets one from there without a second trip: whatever they
            // open is handed to the same caller, with the scope looked up from
            // the key they have just saved.
            openBuckets({ onOpen: (uri) => onPick(uri, scopeFor(uri)) })
          })
        },
        { class: 'btn btn-primary' },
      ),
    ),
  )
}
