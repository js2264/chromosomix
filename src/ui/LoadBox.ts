/**
 * The one way files are *loaded*: dropped, chosen, or named by URL.
 *
 * Three doors ask for a file — the landing page, the file crumb's *open a
 * file* and the header's `+` — and they used to be three copies of one page
 * whose only difference was a verb. What they share is here, once: a drop
 * area that also takes a click, and a box for a URL. What differs, *replace or
 * add*, is decided by whoever mounts it, in the two callbacks.
 *
 * ## Two ways in, not three
 *
 * The drop area **is** the file picker: a click on it opens the same dialog a
 * *choose files…* button would, so a button beside it is the same action drawn
 * twice, and a reader deciding between two controls that do one thing is a
 * reader given a choice that does not exist. There is one target, it says both
 * things it does — drop, or click — and the URL box is under it behind a rule
 * reading *or a URL*, which is the one genuinely different way in.
 *
 * What the target says is two lines and no more. It carried a paragraph about
 * what opens as what — a map opens as a map, a bigWig as a browser over its
 * genome — and a file glyph above them, and between the three the landing page
 * did not fit on one screen. A reader who has to scroll to find out that there
 * are three ways in has been told there is one. The sentence is not lost: the
 * About dialog's first sentence names the tracks, genomes and models this
 * viewer opens with or without a map (`ui/dialogs.ts`, §24.2), and dropping a
 * bigWig demonstrates it in less time than reading about it takes.
 *
 * The privacy claim is on the landing page rather than here, because it is
 * about the application and not about this control; and the stores are not
 * here at all, because a store is not a way to load a file the reader has —
 * it is a place to find one they do not (`ui/StoreDrawer.ts`).
 *
 * The two paths differ only in the byte source, so everything downstream is
 * identical: the same file behaves the same way whether it came off a disk or
 * a bucket.
 */

import { IS_STANDALONE } from '../version'
import { devFeature } from '../state/devFeatures'
import { button, el } from './dom'
import { chooseFiles, filesFrom } from './chooseFiles'
import { dragHasFileRow, readFileDrag } from './fileDrag'
import { canonicalUrl } from '../sources/rewrite'
import { splitUri } from './labels'
import type { SourceSpec } from '../worker/protocol'

export interface LoadBoxProps {
  onOpen(uri: string, source: SourceSpec): void
  /**
   * Several files at once, which is how a genome browser is usually opened.
   *
   * A reader with a map and four bigWigs selects five files and drops them; the
   * session decides which of them is the view and which are its tracks.
   */
  onOpenFiles(files: readonly File[]): void
  /** A shallower drop area, for the dialogs. */
  compact?: boolean
}

export class LoadBox {
  readonly el: HTMLElement
  private readonly drop: HTMLElement
  private readonly urlInput: HTMLInputElement | null

  constructor(private readonly props: LoadBoxProps) {
    this.drop = el(
      'div',
      { class: `dropzone${props.compact === true ? ' dropzone-compact' : ''}`, attrs: { tabindex: '0', role: 'button' } },
      el('div', { class: 'dropzone-title', text: 'Drop genomic files here' }),
      el('div', { class: 'dropzone-sub', text: 'or click to choose' }),
    )
    const choose = async (): Promise<void> => {
      const files = await chooseFiles({ multiple: true })
      if (files.length > 0) this.props.onOpenFiles(files)
    }
    this.drop.addEventListener('click', () => void choose())
    this.drop.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') void choose()
    })
    this.drop.addEventListener('dragover', (event) => {
      event.preventDefault()
      this.drop.classList.add('over')
    })
    this.drop.addEventListener('dragleave', () => this.drop.classList.remove('over'))
    this.drop.addEventListener('drop', (event) => {
      event.preventDefault()
      this.drop.classList.remove('over')
      // A row dragged out of the Files column lands where a dropped file lands.
      if (dragHasFileRow(event)) {
        void readFileDrag(event).then((picked) => {
          if (picked !== null) this.props.onOpen(picked.uri, picked.source)
        })
        return
      }
      const files = filesFrom(event.dataTransfer)
      if (files.length > 0) this.props.onOpenFiles(files)
    })

    // A single-file page has an opaque origin, so every remote read fails
    // before a byte moves. §8.5's doctrine: a control that cannot keep its
    // promise is absent, not disabled, and one sentence says where it exists.
    if (IS_STANDALONE) {
      this.urlInput = null
      this.el = el(
        'div',
        { class: 'load-box' },
        this.drop,
        el('p', {
          class: 'hint load-standalone',
          text:
            'This copy opens local files only: it is one HTML file with no server behind it, so ' +
            'the browser refuses every network read. For remote files and the stores, use the ' +
            'hosted viewer.',
        }),
      )
      return
    }

    this.urlInput = el('input', {
      class: 'input input-url',
      type: 'url',
      placeholder: 'https://bucket.example.org/Hum53.mcool',
      attrs: { 'aria-label': 'the URL of a file' },
    })
    this.urlInput.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') this.openRemote()
    })
    this.el = el(
      'div',
      { class: 'load-box' },
      this.drop,
      // A rule with the word set into it, rather than a line of grey text: the
      // box under it is an alternative to the target above it and not a step
      // after it, and only the rule says which.
      el('span', { class: 'load-or', text: 'or a URL' }),
      el(
        'div',
        { class: 'load-row' },
        this.urlInput,
        button('open', () => this.openRemote(), {
          class: 'btn',
          title:
            'Open a file by its address. The host must serve byte ranges and allow a ' +
            'cross-origin GET; a Dropbox, Drive, gs:// or s3:// address is rewritten to the ' +
            'form that works. ' +
            // A collection's entries are the multi-genome container's (§29); an
            // .mcool's resolutions are what every reader can address.
            (devFeature('metacool')
              ? 'Add ::entries/<name> to address one entry of a collection.'
              : 'Add ::resolutions/<bp> to open one resolution of an .mcool.'),
        }),
      ),
    )
  }

  private openRemote(): void {
    if (this.urlInput === null) return
    // Canonicalised at the door, so the hash, the share link and the workspace
    // file all carry the address that works rather than the page a reader
    // copied out of Dropbox (SPECS §24.5).
    const url = canonicalUrl(this.urlInput.value.trim())
    if (url === '') return
    const { path } = splitUri(url)
    // No credential attached here on purpose. The lookup happens once, at the
    // worker boundary (`s3/attach.ts`), so a URL typed before a key was added
    // and re-opened after still picks it up.
    this.props.onOpen(url, { kind: 'remote', url: path })
  }
}

