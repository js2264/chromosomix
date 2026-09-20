/**
 * Pick a file out of a connected place, from anywhere a URL box stands.
 *
 * Four boxes ask for a file the reader may not have the address of — the
 * Tracks card, the Contact maps card, the deck's add row and an empty cell of
 * a deck — and beside each of them this button opens the Files column's own
 * folder view in a dialog: every place the window is connected to, listed one
 * level at a time, and a row that hands back the file. It replaces a browser
 * that could look at buckets and nothing else; a directory on this machine, a
 * Drive folder and a Dropbox are places too, and were browsable one column to
 * the left and nowhere else.
 *
 * ## Why a picked file is opened rather than typed into the box
 *
 * The box beside the button is for a URL somebody has; this is for one they do
 * not, and handing back a forty-character signed-prefix URL for the reader to
 * press *add* on would be asking them to confirm a string they have no way to
 * check. The pick is the instruction. It carries the credential the listing
 * used, so the file opens with the key that found it rather than with whatever
 * a second lookup resolves — `s3/attach.ts`'s rule from the other side.
 */

import { Modal } from './Modal'
import { button, el } from './dom'
import { icon } from './icons'
import { FolderBrowseView } from './folderBrowse'
import { connectedFolders, folderUsable } from '../browse/connected'
import type { ConnectedFolder, PickedFile } from '../browse/folder'
import { folderMark } from './FilesCard'

export interface PickFromFoldersProps {
  onPick(picked: PickedFile): void
  /** What the dialog is for, on its title bar. */
  title?: string
  onClose?(): void
}

/** The dialog. Closes itself on a pick. */
export function pickFromFolders(props: PickFromFoldersProps): Modal {
  return new Modal({
    title: props.title ?? 'Pick a file from a connected place',
    variant: 'modal-wide',
    ...(props.onClose === undefined ? {} : { onClose: props.onClose }),
    body: (close) => new PickBody(props, close).el,
  })
}

class PickBody {
  readonly el: HTMLElement
  private readonly placesEl = el('div', { class: 'pick-places' })
  private readonly noteEl = el('p', { class: 'hint pick-note' })
  private readonly view: FolderBrowseView
  private showing: string | null = null

  constructor(
    private readonly props: PickFromFoldersProps,
    private readonly close: () => void,
  ) {
    this.view = new FolderBrowseView({
      onPick: (entry, folder) => void this.pick(entry, folder),
    })
    this.el = el(
      'div',
      { class: 'modal-body pick-body' },
      el('p', {
        class: 'hint',
        text:
          'The places this window is connected to, one level at a time. Click a file to take it. ' +
          'Connect another place from the Files column.',
      }),
      this.placesEl,
      this.noteEl,
      this.view.el,
    )
    this.paintPlaces()
    const first = connectedFolders()[0]
    if (first !== undefined) void this.show(first)
  }

  private paintPlaces(): void {
    const folders = connectedFolders()
    if (folders.length === 0) {
      this.placesEl.replaceChildren(
        el('p', {
          class: 'hint',
          text:
            'Nothing is connected yet. Connect a folder on this machine, a bucket, a Drive folder ' +
            'or a Dropbox from the Files column’s *Open a local/remote folder*, then come back here.',
        }),
      )
      return
    }
    this.placesEl.replaceChildren(
      ...folders.map((folder) => {
        const node = button(folder.label, () => void this.show(folder), {
          class: `btn pick-place${folder.id === this.showing ? ' is-on' : ''}`,
          title: folder.label,
        })
        node.prepend(icon(folderMark(folder.kind), { size: 13 }))
        return node
      }),
    )
  }

  private async show(folder: ConnectedFolder): Promise<void> {
    this.showing = folder.id
    this.paintPlaces()
    this.noteEl.textContent = ''
    if (!(await folderUsable(folder, { prompt: true }))) {
      this.view.clear()
      this.noteEl.textContent =
        folder.kind === 'drive' || folder.kind === 'dropbox'
          ? `${folder.label} lists with an account this tab is not signed in to. Sign in from the Files column’s *Open a local/remote folder*.`
          : `${folder.label} needs permission again. Press it once more to ask.`
      return
    }
    await this.view.browse(folder, folder.root)
  }

  private async pick(entry: Parameters<ConnectedFolder['pick']>[0], folder: ConnectedFolder): Promise<void> {
    try {
      const picked = await folder.pick(entry)
      this.close()
      this.props.onPick(picked)
    } catch (err) {
      this.noteEl.textContent = err instanceof Error ? err.message : String(err)
    }
  }
}

// **There is no `folderPickButton` any more.** A button that opened this dialog
// used to sit under every card that asks for a file and beside the deck's add
// row — four doors to one room. Browsing a place this window is connected to is
// the Files column's whole job (§20), and a column you open one file from, look,
// and open the next from is a better shape for it than a dialog that closes on
// the first pick. `pickFromFolders` itself stays: it is what a *drag* out of the
// Files column resolves through, and what the landing page's own places row
// opens.
