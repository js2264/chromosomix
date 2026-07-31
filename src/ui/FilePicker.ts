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

import { button, el } from './dom'
import { splitUri } from './labels'
import type { SourceSpec } from '../worker/protocol'

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

    const examples =
      props.examples && props.examples.length > 0
        ? el(
            'div',
            { class: 'examples' },
            el('h3', { text: 'Public examples' }),
            ...props.examples.map((example) => {
              const node = button(example.label, () => {
                this.urlInput.value = example.url
                this.openRemote()
              }, { class: 'btn btn-quiet', title: example.note ?? example.url })
              return node
            }),
          )
        : null

    this.el = el(
      'section',
      { class: 'view view-picker' },
      el(
        'div',
        { class: 'privacy' },
        el('strong', { text: 'Nothing you drop here leaves your browser.' }),
        el('span', {
          text:
            ' There is no upload, no account and no server: the file is read in place, ' +
            'a few kilobytes at a time, by code running on this page. Close the tab and ' +
            'nothing remains.',
        }),
      ),
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
      this.entryBox,
      examples,
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

/** `true` when every entry name parses as a positive integer (§3.4). */
export function allIntegers(entries: string[]): boolean {
  return (
    entries.length > 0 &&
    entries.every((entry) => /^\d+$/.test(entry) && Number(entry) > 0)
  )
}
