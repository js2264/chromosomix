/**
 * The Files column: the places this window is connected to, and what is in them.
 *
 * Every other door to a file in this application asks *which file* once and then
 * closes — the picker, the header's `+`, the modal bucket browser, a URL box.
 * That is the right shape for opening one thing and the wrong shape for the way
 * people actually work with a directory of data, which is to open one, look,
 * open the next, and keep going for an afternoon. A column stays.
 *
 * ## Two verbs on a row, because they are different questions
 *
 * Clicking a file **loads it into the tab that is open**, which is what the `→`
 * says out loud: a second map comes up beside the one that is there and anything
 * else is drawn on top — the same routing a dropped file takes, and the same
 * promise the header's `+` makes. Dragging a file lets the reader say *where*:
 * onto the map's own edge rectangles for a track in a named stack, onto a
 * companion for a track on that map. Both end in `Session`, and neither invents
 * a route of its own.
 *
 * The arrow is on the row rather than being the row because the row is already a
 * button and there is a third thing a reader may want — to see the size, to read
 * the name, to drag it — and a row whose every pixel loads a file makes those
 * three things risky.
 *
 * ## Folders are listed even when they cannot be read
 *
 * A local grant can lapse: the browser drops it, the reader revokes it, the
 * volume is unmounted. That folder stays in the list with a **reconnect** button
 * rather than vanishing, because vanishing is indistinguishable from never
 * having connected it, and the fix — one click, inside a user gesture, which is
 * what `requestPermission` needs — is a thing only the reader can do.
 *
 * ## Nothing here is a fact about the file the session is of
 *
 * Which is what makes this column different from the four beside it (§16.5), and
 * why it survives a tab switch and a file being closed without being told
 * anything. It listens to `browse/connected.ts` and to nothing else.
 */

import { FolderBrowseView } from './folderBrowse'
import { button, el } from './dom'
import { icon, iconButton, type IconName } from './icons'
import {
  connectedFolders,
  disconnectFolder,
  folderUsable,
  subscribeFolders,
} from '../browse/connected'
import { writeFileDrag } from './fileDrag'
import type { ConnectedFolder, FolderEntry, PickedFile } from '../browse/folder'
import { routeOf } from '../browse/route'
import { rowVerbs } from './rowVerbs'

/** Where the panel's last-opened folder is remembered, so a reload comes back to it. */
const LAST_FOLDER = 'metacooler-viewer:files-last'

function readLast(): string | null {
  try {
    return window.localStorage.getItem(LAST_FOLDER)
  } catch {
    return null
  }
}

function writeLast(id: string): void {
  try {
    window.localStorage.setItem(LAST_FOLDER, id)
  } catch {
    /* a browser refusing storage still browses; it just opens on the first folder */
  }
}

/**
 * The mark for a kind of place: a disk on this machine, a bucket, and the two
 * providers' own marks (`scripts/build-icons.mjs`). The one fact about a folder
 * that changes what its rows cost to open and whether they are private, so it
 * is a mark rather than a word — on the row here, and on the tiles of the
 * dialogs that connect and pick from them.
 */
export function folderMark(kind: ConnectedFolder['kind']): IconName {
  return kind === 'local'
    ? 'hard-drive'
    : kind === 'drive'
      ? 'googledrive'
      : kind === 'dropbox'
        ? 'dropbox'
        : 'cloud'
}

export interface FilesCardProps {
  /**
   * Load one file into whatever is on screen — the `+` on the row, and a
   * plain click.
   *
   * The shell routes it: a map beside the map, anything else on top, an empty
   * tab filled rather than added to.
   */
  onLoad(picked: PickedFile): void
  /**
   * Open one file as a session of its own — the second mark on the row
   * (`ui/rowVerbs.ts`). The shell fills the tab in front if it is empty and
   * opens a new one otherwise, which is what a store row does.
   */
  onOpenNew(picked: PickedFile): void
  /** Whether the tab in front holds nothing, which is what the two verbs' tooltips say. */
  tabEmpty(): boolean
  /** Open the Connect dialog. Owned by the shell, because it is a door to a folder. */
  onConnect(): void
}

export class FilesCard {
  readonly el: HTMLElement
  private readonly foldersEl = el('div', { class: 'files-folders' })
  /** Where a folder whose grant has lapsed says so, and offers the one fix. */
  private readonly lapsedEl = el('div', { class: 'files-lapsed hidden' })
  private readonly view: FolderBrowseView
  private readonly unsubscribe: () => void
  /** The folder on screen, so a repaint of the list can keep it marked. */
  private showing: string | null = null

  constructor(private readonly props: FilesCardProps) {
    this.view = new FolderBrowseView({
      onPick: (entry, folder) => void this.load(entry, folder),
      rowExtras: (entry, folder) =>
        rowVerbs({
          label: entry.name,
          kind: routeOf(entry.name),
          tabEmpty: this.props.tabEmpty(),
          onAdd: () => void this.load(entry, folder),
          onNew: () => void this.openNew(entry, folder),
        }),
      onDragStart: (event, entry, folder) => {
        writeFileDrag(event, folder.id, entry.path, entry.name)
      },
    })

    this.el = el(
      'div',
      { class: 'card files-card' },
      this.foldersEl,
      el(
        'div',
        { class: 'files-actions' },
        button('connect a place…', () => this.props.onConnect(), {
          class: 'btn btn-primary',
          title: 'A directory on this machine, a bucket, a Drive folder or a Dropbox — browsed the same way',
        }),
      ),
      this.lapsedEl,
      this.view.el,
    )

    // Rebuilt rather than patched: the list is at most a handful of rows, and
    // the alternative is reconciling a set that four other screens can add to
    // and remove from.
    this.unsubscribe = subscribeFolders(() => this.paintFolders())
    this.paintFolders()
  }

  /**
   * Open on the folder a previous visit left, or the first one there is.
   *
   * Called once, when the durable folders have been read in. It does **not**
   * prompt: this runs on the boot path with no gesture behind it, and
   * `requestPermission` without transient activation resolves without ever
   * showing a dialog — so a folder whose grant has lapsed would be marked dead
   * on every reload for want of a click nobody was asked for. The reader's own
   * click on the row is what asks.
   */
  showFirst(): void {
    const folders = connectedFolders()
    if (folders.length === 0) return
    const last = readLast()
    const chosen = folders.find((folder) => folder.id === last) ?? folders[0]
    void this.show(chosen, { prompt: false })
  }

  /**
   * Open on a folder that has just been connected.
   *
   * Separate from {@link showFirst} in the one way that matters: this one is
   * inside the gesture that connected it, so it may prompt — and for a folder
   * granted a second ago it will not have to.
   */
  showConnected(id: string): void {
    const folder = connectedFolders().find((entry) => entry.id === id)
    if (folder !== undefined) void this.show(folder)
  }

  /** Stop listening. The shell owns one of these for the window's whole life. */
  destroy(): void {
    this.unsubscribe()
  }

  /**
   * Browse one folder, asking for permission where this call may.
   *
   * `prompt` defaults to `true` because all but one caller is a click — a folder
   * row, the reconnect button, the dialog that just connected it — and a click
   * is the transient activation `requestPermission` needs. The boot path passes
   * `false`, and `state/directories.ts` says why that distinction is not
   * optional.
   */
  private async show(folder: ConnectedFolder, options: { prompt?: boolean } = {}): Promise<void> {
    this.showing = folder.id
    writeLast(folder.id)
    this.lapsedEl.classList.add('hidden')
    this.paintFolders()
    if (!(await folderUsable(folder, { prompt: options.prompt ?? true }))) {
      this.showLapsed(folder)
      return
    }
    await this.view.browse(folder, folder.root)
  }

  /**
   * A local folder this browser will not read without being asked again.
   *
   * Kept in the list rather than dropped, because a folder that vanishes is
   * indistinguishable from one that was never connected — and the fix is one
   * click that only the reader can make, since `requestPermission` needs a live
   * gesture. A refusal that was *denied* rather than dismissed never reaches
   * here: `state/directories.ts` forgets that row, because a durable refusal
   * asked again on every reload is worse than the folder being gone.
   */
  private showLapsed(folder: ConnectedFolder): void {
    this.view.clear()
    this.lapsedEl.classList.remove('hidden')
    // A Drive folder or a Dropbox is not lapsed the way a directory grant is:
    // it lists with an account, and a reload signs nobody in (§24.9). The fix
    // is the same one click, under a different name, in the Connect dialog.
    const account =
      folder.kind === 'drive'
        ? 'A Google account'
        : folder.kind === 'dropbox'
          ? 'Dropbox'
          : null
    if (account !== null) {
      this.lapsedEl.replaceChildren(
        el('p', {
          class: 'hint',
          text:
            `${folder.label} is listed with an account this tab is not signed in to. Sign in ` +
            `under *connect a place…* → ${account} and it lists again; nothing about the folder has changed.`,
        }),
        button('retry', () => void this.show(folder), { class: 'btn' }),
      )
      return
    }
    this.lapsedEl.replaceChildren(
      el('p', {
        class: 'hint',
        text:
          `${folder.label} needs permission again. Browsers hand a directory back for a while ` +
          'and then ask once more; nothing about the folder or what is in it has changed.',
      }),
      button('reconnect', () => void this.show(folder), { class: 'btn' }),
    )
  }

  private load(entry: FolderEntry, folder: ConnectedFolder): Promise<void> {
    return this.picked(entry, folder, (picked) => this.props.onLoad(picked))
  }

  private openNew(entry: FolderEntry, folder: ConnectedFolder): Promise<void> {
    return this.picked(entry, folder, (picked) => this.props.onOpenNew(picked))
  }

  /** Take the file behind a row and hand it to one of the two verbs. */
  private async picked(
    entry: FolderEntry,
    folder: ConnectedFolder,
    deliver: (picked: PickedFile) => void,
  ): Promise<void> {
    try {
      deliver(await folder.pick(entry))
    } catch (err) {
      // A local file moved or deleted since the folder was listed, or a bucket
      // that answered the listing and refuses the object. Said where the reader
      // is looking rather than thrown: the folder is still browsable, and the
      // next row may well work.
      this.view.el.classList.remove('hidden')
      const line = this.view.el.querySelector('.folder-note')
      if (line !== null) {
        line.textContent = err instanceof Error ? err.message : String(err)
        line.classList.add('folder-error')
      }
    }
  }

  /**
   * The connected list.
   *
   * Each row is the folder's mark, its name, and a × that disconnects it. The
   * mark is which *kind* of place it is — a disk on this machine or a bucket
   * somewhere else — because that is the one fact about a folder that changes
   * what its rows cost to open and whether they are private.
   */
  private paintFolders(): void {
    const folders = connectedFolders()
    if (folders.length === 0) {
      this.foldersEl.replaceChildren(
        el('p', {
          class: 'hint',
          text:
            'Nothing connected. Connect a directory on this machine, a bucket, a Drive folder ' +
            'or a Dropbox, and browse it here without opening anything first.',
        }),
      )
      this.view.clear()
      return
    }

    this.foldersEl.replaceChildren(
      ...folders.map((folder) => {
        const name = el(
          'button',
          {
            class: 'btn-link files-folder-name',
            type: 'button',
            title: folder.durable
              ? folder.label
              : `${folder.label} — a snapshot, taken when you connected it. This browser cannot ` +
                'hold a directory, so it does not update and it is gone after a reload.',
          },
          icon(folderMark(folder.kind), { size: 13 }),
          el('span', { class: 'files-folder-label', text: folder.label }),
          // Said on the row, not only in the tooltip. A reader who connects a
          // directory in Firefox and finds it gone tomorrow has been told at the
          // wrong moment; this is the right one.
          folder.durable ? null : el('span', { class: 'files-folder-note', text: 'this visit' }),
        )
        name.addEventListener('click', () => void this.show(folder))
        return el(
          'div',
          { class: `files-folder${folder.id === this.showing ? ' is-on' : ''}` },
          name,
          iconButton('x', `Disconnect ${folder.label}`, () => void this.disconnect(folder), {
            class: 'btn-close',
            size: 14,
          }),
        )
      }),
    )
  }

  private async disconnect(folder: ConnectedFolder): Promise<void> {
    await disconnectFolder(folder.id)
    // A listing left on screen under a folder that has just been disconnected is
    // a view of a place this app can no longer read.
    if (this.view.isShowing(folder.id)) {
      this.view.clear()
      this.showing = null
    }
    this.paintFolders()
  }
}
