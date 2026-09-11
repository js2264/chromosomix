/**
 * Connect a Google Drive folder (SPECS §20, §23.7).
 *
 * A section of the Connect dialog rather than a dialog of its own, because to a
 * reader a Drive folder is the same thing as a directory or a bucket — *the
 * place my data is* — and the app's claim is that it reads all three the same
 * way. What makes this one different is that it cannot work on its own: a Drive
 * folder is listed with the reader's **own** Google account, so the account
 * section above has to have a client id in it and a sign-in behind it before
 * there is anything here worth pressing.
 *
 * ## Nothing to click until there is something clicking would do
 *
 * §8.5: a control that cannot keep its promise is absent rather than disabled.
 * Not signed in, this section is two sentences saying what it needs and where
 * that is — one section up, in the same dialog, which is why it can afford to
 * say "above" rather than explaining OAuth. It is *not* the account section's
 * deliberate exception (a sign-in button disabled with its reason beside it):
 * that button is one field away from working, while a connect button here is a
 * consent screen and a redirect away, and offering it would be offering a
 * gesture that fails with something Google wrote.
 *
 * It redraws when the sign-in state changes, so a reader who presses *sign in
 * with Google* one section up finds the folder box open when the popup closes,
 * rather than a dialog they have to close and reopen.
 *
 * ## Absent where a sign-in cannot happen at all
 *
 * `GOOGLE_SIGN_IN_AVAILABLE` decides it and this module does not restate why:
 * the standalone build has an opaque origin and the desktop build serves itself
 * from `app://viewer`, and an OAuth client is registered against an http(s)
 * origin. Both are §8.5 again, one build earlier.
 */

import { button, el, field } from './dom'
import { icon } from './icons'
import { GOOGLE_SIGN_IN_AVAILABLE, googleState, subscribeGoogle } from '../auth/google'
import { announce } from '../browse/connected'
import { addDriveRow, folderIdFrom } from '../state/drives'

/**
 * The section, or `null` in a build that cannot sign in to Google.
 *
 * `done` is the dialog's own "a folder was connected": it closes the modal and
 * opens the Files panel on the id, which is why this hands over the row's id
 * rather than the row.
 */
export function driveFolderSection(done: (id: string) => void): HTMLElement | null {
  if (!GOOGLE_SIGN_IN_AVAILABLE) return null

  // Built once and kept across redraws, because a redraw happens when the
  // account section above is touched — and a reader who typed a label, then
  // signed in, should find their label still in the box.
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

  const show = (): void => {
    const state = googleState()
    if (!state.signedIn) {
      controls.replaceChildren(
        el('p', {
          class: 'hint',
          text: state.configured
            ? 'Not signed in. A Drive folder is listed with your own Google account, so press ' +
              'sign in with Google in the section above first; this box opens as soon as you are ' +
              'signed in.'
            : 'Not signed in, and no client id is stored. A Drive folder needs both: save your ' +
              'lab’s client id in the section above, sign in with it, and this box opens.',
        }),
      )
      return
    }
    controls.replaceChildren(
      field('name', nameInput, 'What this folder is called in the Files panel. Yours, not Drive’s'),
      field('folder link or id', linkInput, 'Empty means all of My Drive.'),
      el('p', {
        class: 'hint',
        text:
          'Paste the address bar from the folder in Drive, or the id on its own. Leave it empty ' +
          'for all of My Drive. A folder on a shared drive works the same way.',
      }),
      el('div', { class: 'bucket-actions' }, button('connect this folder', connect, {
        class: 'btn btn-primary',
      })),
    )
  }
  show()

  const section = el(
    'div',
    { class: 'connect-section' },
    el('h3', {}, icon('folder-tree', { size: 15 }), el('span', { text: 'A Google Drive folder' })),
    el('p', {
      class: 'hint',
      text:
        'Browse a folder of your Drive in the Files panel, one level at a time, and open what is ' +
        'in it. The folder is listed with your own Google account — the same sign-in as above, ' +
        'read-only — and the token that does it lives only in this tab: nothing here is kept ' +
        'but the folder’s name and its id.',
    }),
    controls,
    error,
  )

  const off = subscribeGoogle(() => {
    // The dialog is built once and thrown away with the modal, and nothing hands
    // a detached body a teardown. It unsubscribes itself the first time it is
    // spoken to after leaving the document — `ui/ConnectCard.ts`'s idiom, for
    // its reason.
    if (!section.isConnected) {
      off()
      return
    }
    show()
  })

  return section
}
