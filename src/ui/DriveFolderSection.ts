/**
 * Connect a Google Drive folder (SPECS §20, §24.7).
 *
 * The folder box of the Connect dialog's Google Drive pane, not a section of
 * its own: to a reader a Drive folder is the same thing as a directory or a
 * bucket — *the place my data is* — and the app's claim is that it reads all
 * three the same way. What makes this one different is that it cannot work on
 * its own: a Drive folder is listed with the reader's **own** Google account,
 * so there has to be a sign-in behind it before there is anything here worth
 * pressing. The pane it sits on (`ui/ConnectCard.ts`) draws the title, the `?`
 * that explains the grant, and the sign-in; this is what appears under them.
 *
 * ## Nothing on screen until there is something pressing would do
 *
 * §8.5: a control that cannot keep its promise is absent rather than disabled.
 * Not signed in, this block is empty and hidden — the pane above it is the
 * sign-in button, which is the whole of what a reader can do next, and a
 * sentence here saying "sign in first" would be pointing at the button beside
 * it. It is *not* the sign-in's deliberate exception (a button disabled with
 * its reason beside it): that button is one click from working, while a
 * connect button here is a consent screen and a redirect away, and offering it
 * would be offering a gesture that fails with something Google wrote.
 *
 * It redraws when the sign-in state changes, so a reader who presses *sign in
 * with Google* finds the folder box open when the popup closes, rather than a
 * dialog they have to close and reopen.
 *
 * ## Absent where a sign-in cannot happen at all
 *
 * `GOOGLE_SIGN_IN_AVAILABLE` decides it and this module does not restate why:
 * the standalone build has an opaque origin and the desktop build serves itself
 * from `app://viewer`, and an OAuth client is registered against an http(s)
 * origin. Both are §8.5 again, one build earlier.
 */

import { button, el, field } from './dom'
import { GOOGLE_SIGN_IN_AVAILABLE, googleState, subscribeGoogle } from '../auth/google'
import { announce } from '../browse/connected'
import { addDriveRow, folderIdFrom } from '../state/drives'

/**
 * The folder box, or `null` in a build that cannot sign in to Google.
 *
 * `done` is the dialog's own "a folder was connected": it closes the modal and
 * opens the Files panel on the id, which is why this hands over the row's id
 * rather than the row.
 */
export function driveFolderSection(done: (id: string) => void): HTMLElement | null {
  if (!GOOGLE_SIGN_IN_AVAILABLE) return null

  // Built once and kept across redraws, because a redraw happens when the
  // sign-in above is touched — and a reader who typed a label, then signed in
  // again, should find their label still in the box.
  const nameInput = el('input', { class: 'input', type: 'text', placeholder: 'Run 2024' })
  const linkInput = el('input', {
    class: 'input',
    type: 'text',
    placeholder: 'https://drive.google.com/drive/folders/…',
  })
  const error = el('p', { class: 'hint bucket-error' })
  const controls = el('div', { class: 'drive-controls' })

  const connect = (): void => {
    error.textContent = ''
    const folderId = folderIdFrom(linkInput.value)
    if (folderId === null) {
      // Said here rather than at the listing, which is the difference between
      // being told at the moment of the mistake and being told at the moment of
      // the click three screens later.
      error.textContent =
        'That is not a Drive folder link. Open the folder in Drive and copy the address bar — it ' +
        'looks like https://drive.google.com/drive/folders/<id> — or paste the id on its own. A ' +
        'link to a single file is not a folder; paste that into the file picker instead. Leave ' +
        'the box empty for all of My Drive.'
      return
    }
    // The id as the fallback name, not "Drive folder": two folders connected
    // without labels have to be told apart on the row, and the id is the only
    // thing this app knows about one it has never listed.
    const typed = nameInput.value.trim()
    const named = typed !== '' ? typed : folderId === 'root' ? 'My Drive' : folderId
    const row = addDriveRow({ label: named, folderId })
    nameInput.value = ''
    linkInput.value = ''
    // The panel's list is rebuilt from the stores on demand, but it only
    // repaints when it is told to — the same call the local half makes after a
    // directory grant.
    announce()
    done(row.id)
  }

  const block = el('div', { class: 'drive-folder hidden' }, controls, error)

  const show = (): void => {
    if (!googleState().signedIn) {
      controls.replaceChildren()
      error.textContent = ''
      block.classList.add('hidden')
      return
    }
    block.classList.remove('hidden')
    controls.replaceChildren(
      el('p', { class: 'hint', text: 'A folder of your Drive, browsed in the Files panel:' }),
      field('name', nameInput, 'What this folder is called in the Files panel. Yours, not Drive’s'),
      field(
        'folder link or id',
        linkInput,
        'The address bar of the folder open in Drive, or its id. Empty means all of My Drive.',
      ),
      el(
        'div',
        { class: 'bucket-actions' },
        button('connect this folder', connect, { class: 'btn btn-primary' }),
      ),
    )
  }
  show()

  const off = subscribeGoogle(() => {
    // The dialog is built once and thrown away with the modal, and nothing hands
    // a detached body a teardown. It unsubscribes itself the first time it is
    // spoken to after leaving the document — `ui/ConnectCard.ts`'s idiom, for
    // its reason.
    if (!block.isConnected) {
      off()
      return
    }
    show()
  })

  return block
}
