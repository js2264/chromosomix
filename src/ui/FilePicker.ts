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
import { chooseFiles, filesFrom } from './chooseFiles'
import { dragHasFileRow, readFileDrag } from './fileDrag'
import { bucketBrowseButton } from './browseButton'
import { credentialOf, type BucketScope } from '../s3/credentials'
import { appMark } from './mark'
import { canonicalUrl } from '../sources/rewrite'
import { splitUri } from './labels'
import { HubTable } from './HubTable'
import { registerShelf } from './examples'
import { addHubRow } from '../state/hubs'
import type { HubEntry, HubRef } from '../state/hub'
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
  /**
   * The hubs to offer, or none for a picker that should not offer any (§24.2).
   *
   * This is the *built-in* list — `ui/examples.ts` owns what is in it. Hubs the
   * reader has connected are read from storage by the table itself, because
   * they change while it is mounted.
   *
   * Optional for the reason the examples list was: the header's "add a file"
   * dialog adds to the tab you are in, and every hub row is a whole session or
   * a whole file — offering one there would offer to throw the reader's tab
   * away from the one control whose promise is that it will not.
   */
  hubs?: readonly HubRef[]
}

export class FilePicker {
  readonly el: HTMLElement
  private readonly drop: HTMLElement
  private readonly urlInput: HTMLInputElement
  private readonly entryBox: HTMLElement
  /** `null` in the standalone build and wherever no hubs were offered. */
  private readonly hubs: HubTable | null

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
          'as a map, and a .pairs.gz is binned into one at a resolution you choose; anything genomic ' +
          '(a chrom.sizes, a FASTA, a bigWig, a bigBed, a GTF, a BED, ' +
          'a BEDPE, a VCF, an indexed BAM) opens as a browser over that genome. Drop several at once and ' +
          'they come up together: the first map is the one this tab is of, every other map is a ' +
          'panel beside it, and everything else is a track on top — and a file dropped with its ' +
          'index beside it, a .bam with its .bai, a .gz with its .tbi or a .pairs.gz with its .px2, is ' +
          'one track and not two.',
      }),
    )

    // `chooseFiles` rather than an `<input>` held in the tree, so that a file
    // *chosen* is remembered as readily as one dropped: in Chromium it goes
    // through the picker that hands back a grant, and everywhere else it falls
    // back to exactly the input this used to be. It also takes a focusable
    // hidden node out of the page's tab order for the whole of its life.
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
      // A row dragged out of the Files panel onto this zone. It lands where a
      // dropped file lands — `onOpen`, which *replaces* — because this zone is
      // the landing page and replacing is what it has always meant: there is
      // nothing here to add to. The panel's own arrow is the add.
      if (dragHasFileRow(event)) {
        void readFileDrag(event).then((picked) => {
          if (picked !== null) this.props.onOpen(picked.uri, picked.source)
        })
        return
      }
      const files = filesFrom(event.dataTransfer)
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

    // A *table*, and not the `<select>` this used to be. Four published demos
    // fit in a dropdown; a hub is six hundred rows chosen by assembly and
    // biosource, which no list of labels can be narrowed by (§24.1). The table
    // owns its own selector, because which hub and which row of it are one
    // question asked twice and splitting them across two components would mean
    // the picker knowing what "loading" looks like.
    //
    // Absent in the standalone build for the reason the URL box is: a
    // single-file page has an opaque origin and every remote read fails before
    // a byte moves, so a control that cannot keep its promise is not shown
    // (§8.5, §19).
    this.hubs =
      IS_STANDALONE || props.hubs === undefined || props.hubs.length === 0
        ? null
        : new HubTable({
            hubs: props.hubs,
            onPick: (entry) => this.openHubEntry(entry),
            // Written straight to storage here rather than handed up to the
            // app: remembering a hub is a fact about this browser, exactly as a
            // bucket scope is, and there is nothing for a session to decide
            // about it. The table hears the change back through
            // `subscribeHubs` and puts the new row in its own menu.
            onRemember: (ref) => {
              if (ref.url !== undefined) addHubRow({ label: ref.label, url: ref.url })
            },
          })
    const hubs =
      this.hubs === null
        ? null
        : el(
            'div',
            { class: 'examples hubs-box' },
            el('h3', { text: 'Hubs' }),
            el('p', {
              class: 'hint',
              // The same rewording as the privacy claim below, and the same
              // reason. "Beside this page" is true on the website, where the
              // demos are served from the app's own origin, and false in the
              // desktop build, which publishes nothing and reads them over the
              // network. What is true of both is the part that mattered anyway:
              // they take the reader's remote path, so they exercise what a
              // file on your own bucket exercises.
              text:
                'A catalogue of maps, genomes and saved sessions on somebody’s bucket, read ' +
                'over the network exactly as a file on your own would be. Nothing is fetched ' +
                'until you choose one.',
            }),
            this.hubs.el,
          )

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
                'is the point. For remote files, published datasets and the hubs, use the ' +
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
      hubs,
      this.entryBox,
      this.privacyNote(),
    )
  }

  /**
   * Let go of what this picker is listening to.
   *
   * One subscription — the hub table's, on the remembered list — and it would
   * otherwise outlive the element: every *Open a file* dialog builds its own
   * picker and throws it away on close, so a table left subscribed would repaint
   * a `<select>` in a document fragment nobody can see, once per dialog ever
   * opened, for the life of the page.
   */
  destroy(): void {
    this.hubs?.destroy()
  }

  /**
   * Land on a hub, from a `?hub=` link or from anywhere else that has one.
   *
   * A link *is* a gesture (§24.2), which is what licenses the fetch: nothing
   * happens on load, and what happens here happened because somebody clicked a
   * URL that named this shelf. Silently nothing in the standalone build and in
   * a picker that was offered no hubs, because there is no table to land in.
   */
  loadHub(ref: HubRef): void {
    void this.hubs?.load(ref)
  }

  /**
   * Open what a hub row names — which is the same door the URL box uses.
   *
   * A map or a genome file opens as one; a `.json` row is a *workspace*, and
   * `Session.openWithConfig` already routes a remote `.json` to
   * `openConfigUrl`, so there is one road to a published session and this is
   * not a second one. The entry's `kind` is deliberately not consulted for the
   * routing: it says what the publisher meant the row to be, and the app routes
   * by name everywhere else (`browse/route.ts`) — two routers that could
   * disagree about one URL is the failure this whole codebase avoids.
   */
  private openHubEntry(entry: HubEntry): void {
    // The shelf the row brought with it, if any, answered later through the
    // same question the demo map's annotations are answered through
    // (`ui/examples.ts`). Registered before the open, because the Tracks card
    // is built while the file is opening.
    if (entry.tracks !== undefined && entry.tracks.length > 0) {
      registerShelf(splitUri(entry.uri).path, entry.tracks)
    }
    this.props.onOpen(entry.uri, { kind: 'remote', url: splitUri(entry.uri).path })
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
    // Two ways to have no credential and one behaviour for both: no scope at
    // all, and a public scope that carries no key. Either way the field is left
    // off rather than set to `null`, so the message on the wire is the one every
    // other unsigned open sends.
    const credential = scope === null ? null : credentialOf(scope)
    this.props.onOpen(url, {
      kind: 'remote',
      url: path,
      ...(credential === null ? {} : { credential }),
    })
  }

  private openRemote(): void {
    // Canonicalised at the door, so the hash, the share link and the workspace
    // file all carry the address that works rather than the page a reader copied
    // out of Dropbox (SPECS §24.5). A URL the table does not recognise — which
    // is nearly all of them — comes back exactly as it was typed.
    const url = canonicalUrl(this.urlInput.value.trim())
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
