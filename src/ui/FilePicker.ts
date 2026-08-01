/**
 * The file picker: drag-and-drop for local files, a URL box for remote ones.
 *
 * The privacy claim is on screen, prominently, because it is a headline claim
 * of the paper and because it is *true of the code*: a dropped `File` is handed
 * to the reader worker by reference and mounted into the Emscripten FS. There is
 * no upload, no account and no server (spec §11, §13). Saying so here is not
 * marketing — it is the difference between a user being able to open unpublished
 * patient-derived metagenomes and not.
 *
 * The two paths differ only in the byte source, so everything downstream is
 * identical, and the picker says that too: the same file behaves the same way
 * whether it came off a disk or a bucket.
 */

import { iconButton } from './icons'
import { button, el } from './dom'
import { splitUri } from './labels'
import type { SourceSpec } from '../worker/protocol'
import { ViewerError } from '../errors'

/**
 * Dismissal is remembered across sessions, not just this one: the claim is
 * reassurance, and reassurance you have already read and accepted becomes
 * furniture. The footer states the same thing permanently, so dismissing this
 * removes the repetition rather than the disclosure.
 */
const PRIVACY_DISMISSED = 'metacooler-viewer:privacy-dismissed'

function privacyDismissed(): boolean {
  try {
    return window.localStorage.getItem(PRIVACY_DISMISSED) === '1'
  } catch {
    return false
  }
}

function dismissPrivacy(): void {
  try {
    window.localStorage.setItem(PRIVACY_DISMISSED, '1')
  } catch {
    /* a browser that refuses storage just shows the note again next time */
  }
}

export interface FilePickerProps {
  onOpen(uri: string, source: SourceSpec): void
  /** Optional example files, e.g. from a published catalog (§11). */
  examples?: Array<{ label: string; url: string; note?: string }>
}

export class FilePicker {
  readonly el: HTMLElement
  private readonly drop: HTMLElement
  private readonly urlInput: HTMLInputElement
  private readonly entryBox: HTMLElement

  constructor(private readonly props: FilePickerProps) {
    this.drop = el(
      'div',
      { class: 'dropzone', attrs: { tabindex: '0', role: 'button' } },
      el('div', { class: 'dropzone-title', text: 'Drop a .metacool, .mmetacool, .cool or .mcool file here' }),
      el('div', { class: 'dropzone-sub', text: 'or click to choose one' }),
    )

    const fileInput = el('input', { class: 'hidden-input', type: 'file' })
    fileInput.addEventListener('change', () => {
      const file = fileInput.files?.[0]
      if (file) this.openLocal(file)
    })
    this.drop.addEventListener('click', () => fileInput.click())
    this.drop.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') fileInput.click()
    })
    this.drop.addEventListener('dragover', (event) => {
      event.preventDefault()
      this.drop.classList.add('over')
    })
    this.drop.addEventListener('dragleave', () => this.drop.classList.remove('over'))
    this.drop.addEventListener('drop', (event) => {
      event.preventDefault()
      this.drop.classList.remove('over')
      const file = event.dataTransfer?.files?.[0]
      if (file) this.openLocal(file)
    })

    this.urlInput = el('input', {
      class: 'input input-url',
      type: 'url',
      placeholder: 'https://bucket.example.org/Hum53.metacool',
    })
    this.urlInput.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') this.openRemote()
    })

    this.entryBox = el('div', { class: 'entry-box hidden' })

    // A dropdown rather than a row of buttons: the list is a *catalogue*, and a
    // catalogue grows. Buttons put every entry on screen at equal weight and
    // push the drop target down as the list gets longer; a select stays one
    // line at any length. Choosing opens immediately — a second "go" button
    // beside a list of three files would be ceremony.
    const exampleSelect = el('select', { class: 'select select-examples' })
    const exampleNote = el('p', { class: 'hint' })
    if (props.examples && props.examples.length > 0) {
      exampleSelect.appendChild(el('option', { value: '', text: 'choose an example…' }))
      for (const example of props.examples) {
        const option = el('option', { value: example.url, text: example.label })
        option.title = example.note ?? example.url
        exampleSelect.appendChild(option)
      }
      const describe = (): void => {
        const chosen = props.examples?.find((example) => example.url === exampleSelect.value)
        exampleNote.textContent = chosen?.note ?? ''
      }
      exampleSelect.addEventListener('change', () => {
        const url = exampleSelect.value
        if (url === '') {
          describe()
          return
        }
        describe()
        this.urlInput.value = url
        this.openRemote()
      })
    }
    const examples =
      props.examples && props.examples.length > 0
        ? el(
            'div',
            { class: 'examples' },
            el('h3', { text: 'Public examples' }),
            el('p', {
              class: 'hint',
              text: 'Published beside this page, so they open the same way a bucket does.',
            }),
            exampleSelect,
            exampleNote,
          )
        : null

    // The privacy note comes *last*. It is reassurance about what the controls
    // above do, and reassurance reads better after the thing it is about than
    // as a banner in front of it — which also put a paragraph between the page
    // and the drop target it exists to explain.
    this.el = el(
      'section',
      { class: 'view view-picker' },
      this.drop,
      fileInput,
      el(
        'div',
        { class: 'remote-box' },
        el('h3', { text: 'Or open a remote file' }),
        el('p', {
          class: 'hint',
          text:
            'The host must serve byte ranges and allow cross-origin GET and HEAD. ' +
            'Add ::entries/<name> to address one entry of an .mmetacool.',
        }),
        el('div', { class: 'remote-row' }, this.urlInput, button('open', () => this.openRemote())),
      ),
      examples,
      this.entryBox,
      this.privacyNote(),
    )
  }

  /**
   * Offer the entries of a collection. Opening an `.mmetacool` at its root is an
   * error that lists what is inside (§3.4); this turns that list into buttons
   * rather than leaving the user to retype a `::` URI by hand.
   */
  showEntries(uri: string, entries: string[], source: SourceSpec): void {
    this.entryBox.replaceChildren(
      el('h3', { text: 'This file is a collection — choose an entry' }),
      el('p', {
        class: 'hint',
        text: allIntegers(entries)
          ? 'The entry names are all integers, so this is a zoomify resolution ladder: each entry is the same data at a different bin size.'
          : 'The entry names are not all integers, so this is a sample or replicate collection: each entry is a different dataset.',
      }),
      el(
        'div',
        { class: 'entry-list' },
        ...entries.map((entry) =>
          button(entry, () => this.props.onOpen(`${splitUri(uri).path}::entries/${entry}`, source), {
            class: 'btn',
          }),
        ),
      ),
    )
    this.entryBox.classList.remove('hidden')
  }

  /**
   * The privacy claim, with a dismiss button.
   *
   * Returns an empty placeholder once dismissed rather than skipping the node,
   * so the surrounding layout does not shift depending on whether you have read
   * it before.
   */
  private privacyNote(): HTMLElement {
    if (privacyDismissed()) return el('div', { class: 'privacy-slot' })

    const note = el(
      'div',
      { class: 'privacy' },
      el(
        'div',
        { class: 'privacy-text' },
        el('strong', { text: 'Nothing you drop here leaves your browser.' }),
        el('span', {
          text:
            ' There is no upload, no account and no server: the file is read in place, ' +
            'a few kilobytes at a time, by code running on this page. Close the tab and ' +
            'nothing remains.',
        }),
      ),
      iconButton(
        'x',
        'Dismiss. The footer keeps the same statement.',
        () => {
          dismissPrivacy()
          note.remove()
        },
        { class: 'btn-close', size: 15 },
      ),
    )
    return note
  }

  private openLocal(file: File): void {
    this.props.onOpen(file.name, { kind: 'local', file })
  }

  private openRemote(): void {
    const url = this.urlInput.value.trim()
    if (url === '') return
    const { path } = splitUri(url)
    this.props.onOpen(url, { kind: 'remote', url: path })
  }
}

/**
 * The entry to land on when an `.mmetacool` was addressed at its root, or
 * `null` when the error is anything else.
 *
 * For a `zoomify` ladder every name is an integer and the one to open is the
 * **smallest** — the base resolution, the finest data, and the level the others
 * are derived from. HDF5 group order is alphabetical, which puts `1000` before
 * `500`, so sorting numerically is not cosmetic.
 *
 * For a sample collection the names are datasets with no order to exploit, so
 * the file's own order wins.
 */
export function firstEntry(err: unknown): string | null {
  if (!(err instanceof ViewerError) || err.code !== 'mmetacool-root') return null
  const entries = err.detail['entries']
  if (!Array.isArray(entries) || entries.length === 0) return null
  const names = entries as string[]
  if (!allIntegers(names)) return names[0]
  return [...names].sort((a, b) => Number(a) - Number(b))[0]
}

/** `true` when every entry name parses as a positive integer (§3.4). */
export function allIntegers(entries: string[]): boolean {
  return (
    entries.length > 0 &&
    entries.every((entry) => /^\d+$/.test(entry) && Number(entry) > 0)
  )
}
