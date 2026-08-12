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

import { IS_DESKTOP } from '../desktop'
import { IS_STANDALONE } from '../version'
import { iconButton } from './icons'
import { button, el } from './dom'
import { bucketBrowseButton } from './browseButton'
import { credentialOf, type BucketScope } from '../s3/credentials'
import { appMark } from './mark'
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
  /**
   * Several files at once, which is how a genome browser is usually opened.
   *
   * A reader with a map and four bigWigs selects five files and drops them; the
   * old handler took `files[0]` and silently discarded the rest, which reads as
   * the application losing them. The session decides which of them is the view
   * and which are its tracks.
   */
  onOpenFiles(files: readonly File[]): void
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
      el('div', {
        class: 'dropzone-title',
        text: 'Drop a file here',
      }),
      el('div', {
        class: 'dropzone-sub',
        // The second sentence is the genome browser's whole entry point, and it
        // belongs here rather than in a section of its own: to a reader with a
        // bigWig and no map, "this app is not for me" is the wrong conclusion
        // and this is the only place it can be corrected before they leave.
        text:
          'or click to choose one. A contact map — .cool, .mcool, .hic, .metacool, .mmetacool — opens ' +
          'as a map; anything genomic (a chrom.sizes, a FASTA, a bigWig, a bigBed, a GTF, a BED, ' +
          'a BEDPE) opens as a browser over that genome. Drop several at once and they come up ' +
          'together: the first map is the one this tab is of, every other map is a panel beside ' +
          'it, and everything else is a track on top.',
      }),
    )

    const fileInput = el('input', { class: 'hidden-input', type: 'file' })
    fileInput.multiple = true
    fileInput.addEventListener('change', () => {
      const files = Array.from(fileInput.files ?? [])
      if (files.length > 0) this.props.onOpenFiles(files)
      fileInput.value = ''
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
      const files = Array.from(event.dataTransfer?.files ?? [])
      if (files.length > 0) this.props.onOpenFiles(files)
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
    // beside a handful of files would be ceremony.
    const exampleSelect = el('select', { class: 'select select-examples' })
    const exampleNote = el('p', { class: 'hint' })
    if (props.examples && props.examples.length > 0) {
      exampleSelect.appendChild(el('option', { value: '', text: 'choose an example…' }))
      for (const example of props.examples) {
        const option = el('option', { value: example.url, text: example.label })
        option.title = example.note ?? example.url
        exampleSelect.appendChild(option)
      }
      exampleSelect.addEventListener('change', () => {
        const chosen = props.examples?.find((example) => example.url === exampleSelect.value)
        // Snap back to the placeholder before opening, and keep the note of
        // what was chosen. The picker is one long-lived DOM node — going back
        // to it (the brand link, `o`, the palette) re-shows this same element
        // — so a select left holding its last value fires no `change` when
        // that value is picked again, and the most likely second click on the
        // list is the entry you just looked at. Resetting makes every choice a
        // change; the note below is what still says which one it was.
        exampleSelect.value = ''
        exampleNote.textContent = chosen?.note ?? ''
        if (chosen === undefined) return
        this.urlInput.value = chosen.url
        this.openRemote()
      })
    }
    const examples =
      !IS_STANDALONE && props.examples && props.examples.length > 0
        ? el(
            'div',
            { class: 'examples' },
            el('h3', { text: 'Public examples' }),
            el('p', {
              class: 'hint',
              // The same rewording as the privacy claim below, and the same
              // reason. "Beside this page" is true on the website, where the
              // demos are served from the app's own origin, and false in the
              // desktop build, which publishes nothing and reads them over the
              // network. What is true of both is the part that mattered anyway:
              // they take the reader's remote path, so they exercise what a
              // file on your own bucket exercises.
              text: 'Read over the network, exactly as a file on your own bucket would be.',
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
      // The mark and the name, over the drop area: this is the first screen,
      // and until now the first thing on it was an instruction. A file picker
      // that does not say what program it belongs to is a dialog, not a page.
      el(
        'div',
        { class: 'picker-brand' },
        // Mark and name on one line, as a masthead rather than a stack: read
        // together they are the app's name, and a logo on its own line above a
        // word is two things where there is one.
        el('div', { class: 'picker-masthead' }, appMark(), el('h1', { text: '(meta)cooler' })),
        el('p', {
          class: 'picker-tagline',
          text:
            IS_DESKTOP || IS_STANDALONE
              ? '(multi-genome) cool files, on your machine'
              : '(multi-genome) cool files, in the browser',
        }),
      ),
      this.drop,
      fileInput,
      // A single-file page has an opaque origin, so every remote read fails
      // before a byte moves. §8.5's doctrine: a control that cannot keep its
      // promise is absent, not disabled. What replaces it is one sentence
      // saying which build this is and where the other one is, because a
      // reader who wanted a URL box should be told it exists somewhere.
      IS_STANDALONE
        ? el(
            'div',
            { class: 'remote-box' },
            el('h3', { text: 'This copy opens local files only' }),
            el('p', {
              class: 'hint',
              text:
                'It is one HTML file with no server behind it, so the browser gives it no origin ' +
                'and refuses every network read. Nothing it opens can leave this machine, which ' +
                'is the point. For remote files, published datasets and the examples, use the ' +
                'hosted viewer.',
            }),
          )
        : el(
        'div',
        { class: 'remote-box' },
        el('h3', { text: 'Or open a remote file' }),
        el('p', {
          class: 'hint',
          text:
            'The host must serve byte ranges and allow cross-origin GET and HEAD. ' +
            'Add ::entries/<name> to address one entry of an .mmetacool.',
        }),
        el(
          'div',
          { class: 'remote-row' },
          this.urlInput,
          button('open', () => this.openRemote()),
          bucketBrowseButton((url, scope) => this.openPicked(url, scope)),
        ),
        // Beside the URL box rather than in a settings screen, because it is
        // the same gesture as the box: "open a file that is not on this
        // machine". A key configured here also makes the box itself work on a
        // private URL, so a reader who was pasting one and getting 403s finds
        // the fix next to the thing that was failing.
        el(
          'div',
          { class: 'remote-private' },
          button('private buckets…', () => this.openBuckets(), { class: 'btn-link' }),
          el('span', {
            class: 'hint',
            text: 'Add a key for a private prefix, and browse what is under it.',
          }),
        ),
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
        // Reworded once, for both targets, rather than branched on which build
        // this is. The standard this module's own doc sets is that the claim
        // has to be literally true of the code -- and "leaves your browser" is
        // false in the desktop build while "leaves this machine" is true in
        // both. A branch here would also mean two sentences to keep honest,
        // and the one that is read least is the one that would go stale.
        el('strong', { text: 'Nothing you open here leaves this machine.' }),
        el('span', {
          text:
            ' There is no upload, no account and no server: the file is read in place, ' +
            'a few kilobytes at a time, by code running on your own computer. Quit and ' +
            'nothing remains.',
        }),
      ),
      iconButton(
        'x',
        'Dismiss. The About dialog states the same thing, in full, whenever you want it.',
        () => {
          dismissPrivacy()
          note.remove()
        },
        { class: 'btn-close', size: 15 },
      ),
    )
    return note
  }

  /**
   * A file chosen from a bucket listing rather than typed.
   *
   * Carries the scope's own credential, unlike {@link openRemote} below: the
   * lookup at the worker boundary would resolve the same key from the same URL,
   * but a file reached *through* a key should be opened with that key rather
   * than with whatever a second resolution picks. `scope` is `null` when the
   * choice came back through the credentials dialog, where there is no listing
   * behind it — and there the boundary lookup is the right answer.
   */
  private openPicked(url: string, scope: BucketScope | null): void {
    const { path } = splitUri(url)
    this.props.onOpen(url, {
      kind: 'remote',
      url: path,
      ...(scope === null ? {} : { credential: credentialOf(scope) }),
    })
  }

  private openRemote(): void {
    const url = this.urlInput.value.trim()
    if (url === '') return
    const { path } = splitUri(url)
    // No credential attached here on purpose. The lookup happens once, at the
    // worker boundary (`s3/attach.ts`), so a URL typed before a key was added
    // and re-opened after still picks it up — and every other construction site
    // in the app gets the same behaviour without knowing this exists.
    this.props.onOpen(url, { kind: 'remote', url: path })
  }

  /**
   * The buckets dialog, imported on demand.
   *
   * A dynamic import because this is the one screen most readers never open:
   * the dialog and the listing parser are ~8 kB that a session opening a public
   * demo has no use for.
   *
   * It does **not** keep the signer out of the entry chunk, and it was never
   * going to: `worker/client.ts` has to look a credential up on every outbound
   * message and `app/Session.ts` signs the session-config fetch, so the hashing
   * is reachable from the first screen either way. The split is worth having
   * for the dialog; claiming more for it would be claiming something the build
   * output contradicts.
   */
  private openBuckets(): void {
    void import('./BucketsCard').then(({ openBuckets }) => {
      openBuckets({ onOpen: (uri, source) => this.props.onOpen(uri, source) })
    })
  }
}

/**
 * The entry to land on when a *collection* was addressed at its root, or `null`
 * when the error is anything else.
 *
 * Two formats, one shape of answer: an `.mmetacool` keeps complete metacools
 * under `/entries`, an `.mcool` keeps complete coolers under `/resolutions`,
 * and neither is a map at its root. The group comes back with the name because
 * the caller has to build a URI out of both.
 *
 * For a `zoomify` ladder every name is an integer and the one to open is the
 * **smallest** — the base resolution, the finest data, and the level the others
 * are derived from. HDF5 group order is alphabetical, which puts `1000` before
 * `500`, so sorting numerically is not cosmetic.
 *
 * For a sample collection the names are datasets with no order to exploit, so
 * the file's own order wins.
 */
export function firstEntry(
  err: unknown,
  /**
   * A bin size to land on if the collection has one.
   *
   * What a *comparison* needs: the map already open is at some resolution, and
   * an `.mcool` dropped beside it should come up at the same one rather than at
   * its finest and be refused for it. Without this, comparing two five-level
   * files worked only while the reader was looking at the finest level of the
   * first — which is not a rule anybody could infer from the message.
   */
  prefer?: number,
): { group: string; entry: string } | null {
  if (!(err instanceof ViewerError)) return null
  if (err.code !== 'mmetacool-root' && err.code !== 'mcool-root') return null
  const entries = err.detail['entries']
  if (!Array.isArray(entries) || entries.length === 0) return null
  const names = entries as string[]
  const group = typeof err.detail['group'] === 'string' ? (err.detail['group'] as string) : 'entries'
  if (!allIntegers(names)) return { group, entry: names[0] }
  // An mcool's resolutions are always integers, so a name *is* a bin size: the
  // wanted one where it exists, and otherwise the finest level — the same rule
  // that lands an mmetacool ladder on its base resolution.
  if (prefer !== undefined && names.includes(String(prefer))) {
    return { group, entry: String(prefer) }
  }
  return { group, entry: [...names].sort((a, b) => Number(a) - Number(b))[0] }
}

/** `true` when every entry name parses as a positive integer (§3.4). */
export function allIntegers(entries: string[]): boolean {
  return (
    entries.length > 0 &&
    entries.every((entry) => /^\d+$/.test(entry) && Number(entry) > 0)
  )
}
