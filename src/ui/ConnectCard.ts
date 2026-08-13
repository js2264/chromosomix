/**
 * Connect a folder: a directory on this machine, or a bucket.
 *
 * One dialog for both, because to a reader they are one thing — *the place my
 * data is* — and the app's own claim is that it reads them the same way. Two
 * dialogs would be two answers to a question nobody asked, and would put the
 * choice of *which kind of storage this is* before the choice of what to open.
 *
 * ## What the local half offers depends on the browser, and it says so
 *
 * Chromium and the desktop build have `showDirectoryPicker`, so a directory is
 * genuinely **connected**: the page holds a capability, the listing is live, and
 * it is all still there after a reload. Firefox and Safari have no such thing;
 * what they have hands over a flat list of `File` objects, from which the tree
 * is rebuilt. That is a **snapshot** — it does not update and it does not
 * survive a reload.
 *
 * §8.5's doctrine is that a control which cannot keep its promise is absent
 * rather than disabled, and the reading that would hide the local half in
 * Firefox is the wrong one: the gesture works there, and what differs is how
 * long the answer lasts. So the button is offered in both and the sentence under
 * it changes. Hiding it would take a working feature away from two browsers to
 * avoid writing one clause.
 *
 * ## The bucket half is the form, not a copy of it
 *
 * `ui/bucketForm.ts`, shared with the credentials dialog. Public is one field —
 * the link — and a key is behind a switch, because the reader who arrives with a
 * URL out of a paper should not meet six boxes.
 */

import { Modal } from './Modal'
import { button, el } from './dom'
import { icon } from './icons'
import { bucketForm } from './bucketForm'
import { announce, connectSnapshot } from '../browse/connected'
import { bucketFolderId } from '../browse/bucket'
import { chooseDirectory, chooseDirectoryFiles, directoryPickerSupported } from '../browse/local'
import { mintDirectoryId, rememberDirectory } from '../state/directories'
import { IS_STANDALONE } from '../version'

export interface ConnectProps {
  /**
   * A folder was connected. The panel opens on it, which is the only thing
   * worth doing next and is why this carries the id.
   */
  onConnected(id: string): void
  onClose?(): void
}

export function openConnect(props: ConnectProps): Modal {
  return new Modal({
    title: 'Connect a folder',
    variant: 'modal-wide',
    ...(props.onClose === undefined ? {} : { onClose: props.onClose }),
    body: (close) => connectBody(props, close),
  })
}

function connectBody(props: ConnectProps, close: () => void): HTMLElement {
  const done = (id: string): void => {
    close()
    props.onConnected(id)
  }

  return el(
    'div',
    { class: 'modal-body bucket-body' },
    el('p', {
      class: 'hint',
      text:
        'A connected folder is browsed in the Files panel and stays there: open one file, look ' +
        'at it, open the next. A directory on this machine and a bucket are read the same way ' +
        'and behave the same once open — the only difference is where the bytes come from.',
    }),
    localSection(done),
    // A single-file page has an opaque origin, so every remote read fails before
    // a byte moves (§19). §8.5: a control that cannot keep its promise is
    // absent, not disabled.
    IS_STANDALONE ? null : bucketSection(done),
    privacyNote(),
  )
}

/**
 * The local half.
 *
 * The picker where there is one, the input everywhere else, and one sentence
 * about which of the two this reader is getting. Both end in the same place —
 * a folder in the panel — so the button says the same thing.
 */
function localSection(done: (id: string) => void): HTMLElement {
  const granted = directoryPickerSupported()
  const error = el('p', { class: 'hint bucket-error' })

  const connect = async (): Promise<void> => {
    error.textContent = ''
    if (granted) {
      const handle = await chooseDirectory()
      // A cancelled picker, which is not an error and needs no message: the
      // reader changed their mind, and the dialog is still open behind it.
      if (handle === null) return
      const id = mintDirectoryId()
      await rememberDirectory(id, handle, handle.name)
      announce()
      done(id)
      return
    }
    const files = await chooseDirectoryFiles()
    if (files.length === 0) return
    // The first segment of `webkitRelativePath` is the directory's own name and
    // is the only place this path can learn it — there is no handle to ask.
    const name = (files[0].webkitRelativePath ?? '').split('/')[0]
    done(connectSnapshot(name === '' ? 'folder' : name, files).id)
  }

  return el(
    'div',
    { class: 'connect-section' },
    el('h3', {}, icon('hard-drive', { size: 15 }), el('span', { text: 'A folder on this machine' })),
    el('p', {
      class: 'hint',
      text: granted
        ? 'Nothing is uploaded and nothing is copied. This browser keeps permission to list the ' +
          'folder and read what is in it — not the files themselves — so it is still connected ' +
          'after a reload, and you can take that permission back at any time.'
        : 'This browser cannot hold a folder, so what you get is a snapshot of it: the file list ' +
          'as it is right now, for this visit only. It does not update, and it is gone after a ' +
          'reload. Nothing is uploaded either way. Chrome and Edge, and the desktop app, keep ' +
          'the connection properly.',
    }),
    el(
      'div',
      { class: 'bucket-actions' },
      button(granted ? 'choose a folder…' : 'choose a folder (this visit)…', () => void connect(), {
        class: 'btn btn-primary',
      }),
    ),
    error,
  )
}

/** The bucket half: the shared form, and nothing of its own. */
function bucketSection(done: (id: string) => void): HTMLElement {
  return el(
    'div',
    { class: 'connect-section' },
    el('h3', {}, icon('cloud', { size: 15 }), el('span', { text: 'A bucket' })),
    bucketForm({ onSaved: (scope) => done(bucketFolderId(scope.id)) }),
  )
}

/**
 * The claim, restated where the grant is actually being made.
 *
 * The picker says it on the first screen and the About dialog says it in full;
 * this is the one moment a reader hands over something wider than a single file,
 * so it is worth the four lines. It is also literally true of the code, which is
 * the standard `ui/FilePicker.ts` sets for saying it at all.
 */
function privacyNote(): HTMLElement {
  return el(
    'div',
    { class: 'bucket-note' },
    icon('info', { size: 16 }),
    el(
      'div',
      {},
      el('strong', { text: 'Connecting a folder still sends nothing anywhere.' }),
      el('span', {
        text:
          ' A local folder is read in place by code running on your own computer, a few kilobytes ' +
          'at a time, exactly as a dropped file is. A bucket is read by your browser, from the ' +
          'bucket, directly. There is no server in between in either case, because there is no ' +
          'server. Every folder you connect is listed under About → what is stored, with a ' +
          'button that forgets all of it.',
      }),
    ),
  )
}
