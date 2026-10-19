/**
 * The landing page: the mark, the three things a reader can do, and the claim.
 *
 * Three things, and they are named on the page.
 *
 * **Load files** is the drop area, the *choose files* button and the URL box
 * (`ui/LoadBox.ts`): bytes the reader has, or the address of some. One file,
 * or five.
 *
 * **Connect a local or remote folder** is a row of buttons — a folder on this
 * machine, a bucket, Google Drive, Dropbox — each opening the Connect dialog
 * on that place (`ui/ConnectCard.ts`), after which it is listed one level at a
 * time in the Files column (§20). A reader with a directory of maps does not
 * have *a file* to name; they have a place, and that place was reachable only
 * from a plug in the header of a page they had not landed on yet.
 *
 * **Connect to a data store** is a row of tiles: the lab's own figures, IGV's
 * genomes, 4DN, ENCODE, and any store the reader connected — each a page of
 * its own in the drawer (`ui/StoreDrawer.ts`). For the reader who has no data
 * of their own at all.
 *
 * Nothing else is on the page but one offer beside it. The three are in the
 * order a reader is likely to want them — what you brought, where you keep it,
 * what somebody else published — and everything that used to be here beside
 * them was one of the three wearing a different name: a catalogue was a store,
 * and a hub was a store. The offer is the guided tutorial's (§30), for the
 * reader who has none of the three yet and does not know where to start: a
 * button in the margin left of them, where a wide window has nothing, and over
 * *Load files* where a narrow one has no margin. Never a dialog that opens by
 * itself — a reader who came to open a file is not asked first whether they
 * would like a lesson.
 *
 * The privacy claim is on screen, prominently, because it is a headline claim
 * of the paper and because it is *true of the code*: a dropped `File` is handed
 * to the reader worker by reference and mounted into the Emscripten FS. There is
 * no upload, no account and no server (spec §11, §13). Saying so here is not
 * marketing — it is the difference between a user being able to open unpublished
 * patient-derived metagenomes and not.
 */

import { IS_STANDALONE } from '../version'
import { icon, iconButton, markButton } from './icons'
import type { IconName } from './icons'
import { button, el } from './dom'
import { LoadBox } from './LoadBox'
import { appMark } from './mark'
import { splitUri } from './labels'
import { connectDirectory } from '../browse/connected'
import { CONNECT_FOLDER_TITLE, providerFronts, type ProviderId } from './connectFronts'
import { storeFronts } from './stores/registry'
import { storeTiles } from './stores/tiles'
import { subscribeStores } from '../state/stores'
import { readTourProgress, subscribeTour, tourRunning } from '../state/tour'
import { tutorialButtons, type TutorialStart } from './tutorialOffer'
import type { SourceSpec } from '../worker/protocol'
import type { PickedFile } from '../browse/folder'
import { ViewerError } from '../errors'
import { landingRung } from '../metacooler/detect'

/**
 * Dismissal is remembered across sessions, not just this one: the claim is
 * reassurance, and reassurance you have already read and accepted becomes
 * furniture. The About dialog states the same thing permanently, so dismissing
 * this removes the repetition rather than the disclosure.
 */
const PRIVACY_DISMISSED = 'chromosomix:privacy-dismissed'

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
  onOpenFiles(files: readonly File[]): void
  /** A row of the Files column or a store, dropped on *Load files* (`LoadBox`'s). */
  onPicked?(picked: PickedFile): void
  /**
   * A store tile was pressed. The shell opens the drawer on it.
   *
   * Absent means no stores are offered — an embed, which builds no drawer for
   * a tile to open (§21.2), and a picker in a test that wants none. The
   * standalone build offers none whatever is passed, having no network to
   * read one over (§19).
   */
  onStore?(id: string): void
  /**
   * A place that needs a form or a sign-in was pressed. The shell opens the
   * Connect dialog on it.
   *
   * The shell's rather than this page's for the same reason a store tile is:
   * what a reader connects is a fact about the *window* — the Files column
   * holds it and every tab sees it (§20.4) — and not about the tab they
   * happened to land on. Absent means the whole row is left out, which is what
   * an embed asks for — it mounts no Files column to connect a place into
   * (§21.2) — and a test that wants only the load box.
   */
  onConnect?(provider: ProviderId): void
  /**
   * A folder was connected from this page: *choose a folder…* was pressed and
   * the reader pointed at one.
   *
   * The same call the Connect dialog makes when one of its panes finishes, and
   * it means the same thing — show the Files column and put this folder in
   * front — because a reader who has just connected a place is looking for it.
   */
  onConnected?(id: string): void
  /**
   * The tutorial's button was pressed (§30). The shell plays it.
   *
   * Absent where it cannot be played, which is where there is no store drawer
   * for its first step: an embed, and a picker in a test. The standalone build
   * offers none whatever is passed, for the same reason it offers no store.
   */
  onTutorial?(from: TutorialStart): void
}

/**
 * One of the three headings, with the mark of the thing it heads.
 *
 * The page names three separate ways in and drew all three the same way, so
 * what a reader saw was one column of text with three bold lines in it rather
 * than three doors. Each mark is the one that thing already wears elsewhere in
 * the application — `folder-tree` is the Files column's, `library` the store
 * drawer's — so the heading is a second sighting rather than a new symbol.
 */
function pickerHeading(text: string, mark: IconName): HTMLElement {
  return el(
    'h2',
    { class: 'picker-heading' },
    icon(mark, { size: 18, class: 'picker-heading-mark' }),
    el('span', { text }),
  )
}

export class FilePicker {
  readonly el: HTMLElement
  private readonly entryBox: HTMLElement
  private readonly tilesSlot: HTMLElement | null
  private readonly unsubscribe: (() => void) | null
  /** The tutorial's offer, or `null` where it cannot be played. */
  private readonly tutorialSlot: HTMLElement | null
  private readonly unsubscribeTour: (() => void) | null

  constructor(private readonly props: FilePickerProps) {
    const onPicked = props.onPicked
    const load = new LoadBox({
      onOpen: (uri, source) => props.onOpen(uri, source),
      onOpenFiles: (files) => props.onOpenFiles(files),
      ...(onPicked === undefined ? {} : { onPicked: (picked: PickedFile) => onPicked(picked) }),
    })
    this.entryBox = el('div', { class: 'entry-box hidden' })

    const onStore = props.onStore
    this.tilesSlot = IS_STANDALONE || onStore === undefined ? null : el('div', { class: 'picker-stores' })
    const onTutorial = props.onTutorial
    this.tutorialSlot =
      IS_STANDALONE || onTutorial === undefined
        ? null
        : el('aside', { class: 'picker-tutorial', attrs: { 'aria-label': 'Guided tutorial' } })
    this.el = el(
      'section',
      { class: 'view view-picker' },
      el(
        'div',
        { class: 'picker-brand' },
        el('div', { class: 'picker-masthead' }, appMark(), el('h1', { text: 'chromosomix' })),
      ),
      el(
        'section',
        { class: 'picker-section picker-load' },
        // First in the first section, so that where it cannot stand in the
        // margin it is the first thing under the masthead, and where it can it
        // is placed against the top of *Load files* (`styles.css`).
        this.tutorialSlot,
        pickerHeading('Load files', 'file'),
        load.el,
      ),
      this.placesSection(),
      this.tilesSlot === null
        ? null
        : el(
            'section',
            { class: 'picker-section' },
            pickerHeading('Connect to a data store', 'library'),
            this.tilesSlot,
          ),
      this.entryBox,
      this.privacyNote(),
    )

    if (this.tilesSlot !== null && onStore !== undefined) {
      const paint = (): void => {
        this.tilesSlot?.replaceChildren(
          storeTiles({ fronts: storeFronts(), size: 'large', onPick: (id) => onStore(id) }),
        )
      }
      paint()
      // The row changes under a mounted page — a store remembered in the
      // drawer is a tile here a moment later.
      this.unsubscribe = subscribeStores(paint)
    } else {
      this.unsubscribe = null
    }

    if (this.tutorialSlot !== null && onTutorial !== undefined) {
      const slot = this.tutorialSlot
      const paint = (): void => {
        // Out of the way while a tour is on screen: under its grey, an offer to
        // play it is one more thing to read, and it would count the steps of
        // the tour the reader is in.
        slot.classList.toggle('hidden', tourRunning())
        slot.replaceChildren(
          el('p', { class: 'picker-tutorial-kicker', text: 'New here?' }),
          ...tutorialButtons(readTourProgress(), onTutorial, { class: 'picker-tutorial-play' }),
          el('p', {
            class: 'picker-tutorial-text',
            text: 'A first session on a real Hi-C map from 4DN, one step at a time.',
          }),
        )
      }
      paint()
      this.unsubscribeTour = subscribeTour(paint)
    } else {
      this.unsubscribeTour = null
    }
  }

  /**
   * The places: one button per provider, and what each press leads to.
   *
   * **This machine opens the directory picker itself.** It is one gesture and
   * the browser draws it, so putting a dialog in front of it would be asking
   * the reader to press *choose a folder…* twice; the call is made from inside
   * the click for that reason and for a harder one — both pickers need
   * transient user activation, and anything awaited first can cost it
   * (`browse/connected.ts`'s `connectDirectory`). What comes back is a folder
   * id, handed up because a connected folder belongs to the window rather than
   * to this tab.
   *
   * **The other three open the Connect dialog** on their own pane, which is
   * the same grammar as the store tiles under them — a tile opens the drawer
   * on that store — and for the reason that grammar exists: what follows a
   * press there is a form to fill or a sign-in with a code to paste, and both
   * already live on the dialog's panes with the sentences §24.7 requires
   * beside them. The ellipsis on every label covers both cases: something is
   * about to be asked, here or in a dialog.
   *
   * Which places are offered is `ui/connectFronts.ts`'s, and it is the one
   * thing this section decides for itself: a button is only drawn where
   * pressing it reaches something that can act, which is §8.5. That is why the
   * desktop build has no Google button here, and why a site built without a
   * provider's registration (§24.7) has neither sign-in button, while the
   * dialog keeps every tile and its pane explains.
   */
  private placesSection(): HTMLElement | null {
    const onConnect = this.props.onConnect
    if (onConnect === undefined) return null
    const fronts = providerFronts().filter((front) => front.works)
    if (fronts.length === 0) return null
    return el(
      'section',
      { class: 'picker-section' },
      // One verb for one act. *Mount* was this heading's word alone — jargon
      // nowhere else in the app — while the dialog it opens said *open* and
      // every button in the row and every sentence about the result said
      // *connect*. A file is opened; a folder is connected (§26.4).
      //
      // The standalone build reaches no remote place at all (§19), so it does
      // not offer a heading naming two kinds and a row holding one — and the
      // name is the one the Files column and the palette use (`CONNECT_FOLDER`).
      pickerHeading(CONNECT_FOLDER_TITLE, 'folder-tree'),
      el(
        'div',
        { class: 'picker-providers' },
        ...fronts.map((front) => {
          const node = markButton(
            front.verb,
            front.mark,
            front.id === 'local' ? () => void this.pickDirectory() : () => onConnect(front.id),
            {
              class: 'btn btn-mark picker-provider',
              title: `${front.label}, listed one level at a time in the Files column.`,
            },
          )
          // The same attribute the dialog's tiles carry, for the same reason:
          // a button is named by a verb that may be reworded, and what says
          // *which place this is* should not be the wording.
          node.setAttribute('data-provider', front.id)
          return node
        }),
      ),
    )
  }

  /** The directory picker, and the folder it answers with. `null` is a cancel. */
  private async pickDirectory(): Promise<void> {
    const id = await connectDirectory()
    if (id !== null) this.props.onConnected?.(id)
  }

  /**
   * Let go of what this picker is listening to.
   *
   * Every *Open a file* dialog used to build its own picker; now the dialogs
   * build a `LoadBox` and this element is the landing page alone, owned by one
   * session for its life. Still worth a door, for the session that is closed.
   */
  destroy(): void {
    this.unsubscribe?.()
    this.unsubscribeTour?.()
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
        // "Leaves this machine" rather than "leaves your browser": the claim
        // has to be literally true of the code, and the second is false in the
        // desktop build while the first is true in both.
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
 * rung {@link landingRung} names — a third of the way up from the finest, not
 * the finest itself, whose reads are the largest the file has. HDF5 group order
 * is alphabetical, which puts `1000` before `500`, so the ladder is ordered by
 * number before it is counted.
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
   * its finest and be refused for it.
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
  // wanted one where it exists, and otherwise the landing rung — the same rule
  // for an mmetacool ladder.
  if (prefer !== undefined && names.includes(String(prefer))) {
    return { group, entry: String(prefer) }
  }
  return { group, entry: String(landingRung(names.map(Number))) }
}

/** `true` when every entry name parses as a positive integer (§3.4). */
export function allIntegers(entries: string[]): boolean {
  return (
    entries.length > 0 &&
    entries.every((entry) => /^\d+$/.test(entry) && Number(entry) > 0)
  )
}
