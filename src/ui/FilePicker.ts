/**
 * The landing page: the mark, the two things a reader can do, and the claim.
 *
 * Two things, and they are named on the page. **Load files** is the drop area
 * and the URL box (`ui/LoadBox.ts`): bytes the reader has, or the address of
 * some. **Connect to a store** is a row of tiles: the lab's own figures, IGV's
 * genomes, 4DN, ENCODE, and any store the reader connected — each a page of
 * its own in the drawer (`ui/StoreDrawer.ts`). Nothing else is on the page,
 * because everything else that used to be here was one of those two things
 * wearing a different name: a bucket to browse is a place to connect (the
 * Files column's *Open a local/remote folder*), a catalogue was a store, and a hub was
 * a store.
 *
 * The privacy claim is on screen, prominently, because it is a headline claim
 * of the paper and because it is *true of the code*: a dropped `File` is handed
 * to the reader worker by reference and mounted into the Emscripten FS. There is
 * no upload, no account and no server (spec §11, §13). Saying so here is not
 * marketing — it is the difference between a user being able to open unpublished
 * patient-derived metagenomes and not.
 */

import { IS_DESKTOP } from '../desktop'
import { IS_STANDALONE } from '../version'
import { iconButton } from './icons'
import { button, el } from './dom'
import { LoadBox } from './LoadBox'
import { appMark } from './mark'
import { splitUri } from './labels'
import { storeFronts } from './stores/registry'
import { storeTiles } from './stores/tiles'
import { subscribeStores } from '../state/stores'
import type { SourceSpec } from '../worker/protocol'
import { ViewerError } from '../errors'

/**
 * Dismissal is remembered across sessions, not just this one: the claim is
 * reassurance, and reassurance you have already read and accepted becomes
 * furniture. The About dialog states the same thing permanently, so dismissing
 * this removes the repetition rather than the disclosure.
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
  onOpenFiles(files: readonly File[]): void
  /**
   * A store tile was pressed. The shell opens the drawer on it.
   *
   * Absent means no stores are offered — the standalone build, which has no
   * network to read one over (§19), and a picker in a test that wants none.
   */
  onStore?(id: string): void
}

export class FilePicker {
  readonly el: HTMLElement
  private readonly entryBox: HTMLElement
  private readonly tilesSlot: HTMLElement | null
  private readonly unsubscribe: (() => void) | null

  constructor(private readonly props: FilePickerProps) {
    const load = new LoadBox({
      onOpen: (uri, source) => props.onOpen(uri, source),
      onOpenFiles: (files) => props.onOpenFiles(files),
    })
    this.entryBox = el('div', { class: 'entry-box hidden' })

    const onStore = props.onStore
    this.tilesSlot = IS_STANDALONE || onStore === undefined ? null : el('div', { class: 'picker-stores' })
    this.el = el(
      'section',
      { class: 'view view-picker' },
      el(
        'div',
        { class: 'picker-brand' },
        el('div', { class: 'picker-masthead' }, appMark(), el('h1', { text: '(meta)cooler' })),
        el('p', {
          class: 'picker-tagline',
          text:
            IS_DESKTOP || IS_STANDALONE
              ? '(multi-genome) cool files, on your machine'
              : '(multi-genome) cool files, in the browser',
        }),
      ),
      el(
        'section',
        { class: 'picker-section' },
        el('h2', { class: 'picker-heading', text: 'Load files' }),
        load.el,
      ),
      this.tilesSlot === null
        ? null
        : el(
            'section',
            { class: 'picker-section' },
            el('h2', { class: 'picker-heading', text: 'Connect to a store' }),
            el('p', {
              class: 'hint',
              text:
                'Somebody’s shelf of data, read over the network exactly as a file on your own bucket ' +
                'would be. Nothing is fetched until you open one.',
            }),
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
