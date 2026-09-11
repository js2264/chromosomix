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
 *
 * ## And two more things, neither of which is a folder
 *
 * A Google API key (SPECS §23.7) is not a folder, so it connects nothing and
 * appears in no panel — it is the one credential that has to exist before a
 * *link* works, because the Drive API refuses a public file without one. It is
 * here rather than in a dialog of its own for the reason the bucket half is
 * here: this is the screen a reader opens when the thing they were given will
 * not open, and a second dialog would be a second place to look.
 *
 * A Google **account** is the half a key cannot do: a private Drive file and a
 * private GCS object need a bearer token, and the only way a page with no
 * backend gets one is the reader signing in to Google in their own browser
 * (`auth/google.ts`). It sits *under* the key because that is the order a reader
 * meets the two in — a public link fails first and a private one afterwards —
 * and because the grant it asks for is far wider than the key's, which is worth
 * reading after the cheaper answer has been ruled out rather than instead of it.
 */

import { Modal } from './Modal'
import { button, el, field } from './dom'
import { icon } from './icons'
import { bucketForm } from './bucketForm'
import { clearApiKey, readApiKey, writeApiKey } from '../s3/credentials'
import {
  GOOGLE_SIGN_IN_AVAILABLE,
  clearClientId,
  googleState,
  readClientId,
  signIn,
  signOut,
  subscribeGoogle,
  writeClientId,
} from '../auth/google'
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
    // absent, not disabled. The Google half goes with it for the same reason —
    // a key that authorises a request nothing can make is a box that lies.
    IS_STANDALONE ? null : bucketSection(done),
    IS_STANDALONE ? null : googleSection(),
    // Null again in the desktop build, which the line above has no reason to
    // be: a key is a string sent to a host, and `app://viewer` can send it,
    // while a sign-in is a registration against an origin Google will not
    // accept. `googleAccountSection` decides that for itself — see
    // `auth/google.ts`'s `GOOGLE_SIGN_IN_AVAILABLE`.
    IS_STANDALONE ? null : googleAccountSection(),
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
 * The Google API key: one box, save, forget.
 *
 * Deliberately the smallest section in this dialog, because it is the least
 * interesting thing in it — a string that makes one host answer. It connects no
 * folder and so calls no `done`; what it changes is whether a Drive *link*
 * opens, which the reader finds out by opening one.
 *
 * `type=password`, as the bucket secret is, and for the same reason: this box is
 * opened in front of an audience precisely when somebody is being shown how the
 * feature works.
 *
 * The status line rather than a toast, because the question a reader has when
 * they come back to this dialog is *is there one stored*, and a toast has long
 * since gone. It reports presence and never the key — printing it back would
 * make a screenshot of this dialog a leak.
 */
function googleSection(): HTMLElement {
  const input = el('input', { class: 'input', type: 'password', placeholder: 'AIza…' })
  const status = el('p', { class: 'hint' })
  const show = (): void => {
    status.textContent =
      readApiKey() === null
        ? 'No key stored. Google Drive links will not open without one.'
        : 'A key is stored in this browser. It is listed under About → what is stored.'
  }
  show()

  return el(
    'div',
    { class: 'connect-section' },
    el('h3', {}, icon('link', { size: 15 }), el('span', { text: 'A Google API key' })),
    el('p', {
      class: 'hint',
      text:
        'Needed to open a public Google Drive file: the Drive API refuses a request without a ' +
        'key, even for a file anyone can read. A public Google Cloud Storage object needs none — ' +
        'a gs:// link opens as it is. A private file on either needs the account sign-in below ' +
        'instead, and a key does not stand in for it. Make the key in your own Google Cloud ' +
        'project and restrict it to the Drive API; it is kept in this browser, exactly as a ' +
        'bucket key is.',
    }),
    field('key', input),
    status,
    el(
      'div',
      { class: 'bucket-actions' },
      button(
        'save',
        () => {
          writeApiKey(input.value)
          input.value = ''
          show()
        },
        { class: 'btn btn-primary' },
      ),
      button(
        'forget',
        () => {
          clearApiKey()
          input.value = ''
          show()
        },
        { class: 'btn' },
      ),
    ),
  )
}

/**
 * The Google account: a client id, a sign-in, and what the grant actually is.
 *
 * Two controls that look alike and are not. The **client id** is the lab's, it
 * is public by construction — it ships in the page of every site that uses this
 * flow — and it is stored; saving it changes nothing about what this browser can
 * read, it only names the project a sign-in would go to. The **sign-in** is the
 * reader's, it produces a credential, and it is kept nowhere.
 *
 * §8.5 says a control that cannot keep its promise is absent rather than
 * disabled, and the sign-in button is the deliberate exception: it is *disabled
 * with the reason next to it* because it becomes available by filling in the box
 * directly above it. Hiding it would hide the consequence of the field — the
 * reader would save a client id and have no way to know what it was for — which
 * is the case the doctrine's own wording ("cannot keep its promise") excludes:
 * this one can, in a second, and says what it is waiting for.
 *
 * The whole section is absent where a sign-in cannot work at all: the standalone
 * build (the caller's guard) and the desktop build (`GOOGLE_SIGN_IN_AVAILABLE` —
 * `app://viewer` is not an origin Google's console will register, whatever the
 * desktop CSP admits).
 */
function googleAccountSection(): HTMLElement | null {
  if (!GOOGLE_SIGN_IN_AVAILABLE) return null

  const input = el('input', {
    class: 'input',
    type: 'text',
    placeholder: '…apps.googleusercontent.com',
  })
  const stored = el('p', { class: 'hint' })
  const account = el('p', { class: 'hint' })
  const error = el('p', { class: 'hint bucket-error' })
  const actions = el('div', { class: 'bucket-actions' })

  const show = (): void => {
    const state = googleState()
    const id = readClientId()
    stored.textContent =
      id === null
        ? 'No client id stored. Signing in needs one; it is not a secret, and it is the only ' +
          'part of this that is kept.'
        : // Printed rather than withheld, which is the opposite of the key box
          // above and is the right answer for a value that is public: what a
          // reader coming back here needs to know is *which project*, and a
          // status line saying "one is stored" would not tell them.
          `Client id stored: ${id}`
    account.textContent = accountLine(state)

    const signInLabel = state.expiresAt !== null && !state.signedIn ? 'sign in again' : 'sign in with Google'
    const signInButton = button(
      signInLabel,
      () => {
        error.textContent = ''
        signInButton.disabled = true
        void signIn()
          .catch((cause: unknown) => {
            error.textContent = cause instanceof Error ? cause.message : String(cause)
          })
          .finally(() => {
            // Redrawn either way: a success has already announced and redrawn
            // this row out from under us, and a failure has to put the button
            // back or the reader cannot try again.
            show()
          })
      },
      {
        class: 'btn btn-primary',
        ...(state.configured
          ? {}
          : {
              title:
                'Save a client id above first: a sign-in is a request from this origin to one ' +
                'Google project, and the client id is what names the project.',
            }),
      },
    )
    signInButton.disabled = !state.configured
    actions.replaceChildren(
      signInButton,
      // Offered only when there is something to sign out *of*, on §8.5's rule —
      // and this one really is a control that could not keep its promise, unlike
      // the button beside it.
      ...(state.signedIn ? [button('sign out', () => signOut(), { class: 'btn' })] : []),
    )
  }
  show()

  const off = subscribeGoogle(() => {
    // The dialog is built once and thrown away with the modal, and nothing hands
    // a detached body a teardown. It unsubscribes itself the first time it is
    // spoken to after leaving the document — `ui/SequenceCard.ts`'s idiom, for
    // its reason.
    if (!stored.isConnected) {
      off()
      return
    }
    show()
  })

  return el(
    'div',
    { class: 'connect-section' },
    // `plug` and not a person: the icon set is Lucide's, copied verbatim by
    // `npm run icons`, and it carries no account mark. This section is a
    // connection to a service, which is what the mark says.
    el('h3', {}, icon('plug', { size: 15 }), el('span', { text: 'A Google account' })),
    el('p', {
      class: 'hint',
      text:
        'For a Drive file or a Cloud Storage object that is not public. Signing in gets this tab ' +
        'a token, which rides every request to Drive and to the GCS JSON API until it expires. ' +
        'The client id is your lab’s, registered in its own Google Cloud project against the ' +
        'exact address this page is served from — docs/hosting.md has the four steps.',
    }),
    // The two sentences §23.7 requires this dialog to say, and it requires them
    // because a consent screen says neither: Google's names the product, and
    // nothing anywhere tells the reader where the token ends up.
    el('p', {
      class: 'hint',
      text:
        'Read what you are granting. drive.readonly is read access to all of your Drive — every ' +
        'file in it, not the one you are opening — where a bucket key is a grant over one ' +
        'prefix of one bucket. The other scope, devstorage.read_only, is read access to the ' +
        'Cloud Storage your account can see.',
    }),
    el('p', {
      class: 'hint',
      text:
        'The token lives only in this tab’s memory. It is never written to storage, so it is ' +
        'not in the list under About → what is stored, it is gone when this tab closes, and it ' +
        'expires about an hour after you sign in — which is why nothing here can keep you ' +
        'signed in and nothing claims to.',
    }),
    field('client id', input),
    stored,
    el(
      'div',
      { class: 'bucket-actions' },
      button(
        'save',
        () => {
          error.textContent = ''
          writeClientId(input.value)
          input.value = ''
          show()
        },
        { class: 'btn btn-primary' },
      ),
      button(
        'forget',
        () => {
          error.textContent = ''
          // The id only. A token already granted is the reader's own and still
          // opens the file they are reading; `auth/google.ts` says why taking it
          // away here would answer a question nobody asked.
          clearClientId()
          input.value = ''
          show()
        },
        { class: 'btn' },
      ),
    ),
    account,
    actions,
    error,
  )
}

/** What this page can honestly say about the account, in one line. */
function accountLine(state: { signedIn: boolean; expiresAt: number | null }): string {
  const when = (at: number): string => new Date(at).toLocaleTimeString()
  if (state.signedIn && state.expiresAt !== null) {
    // No address, because no `userinfo` scope was asked for (§23.7). Saying
    // which account would cost a second grant for a label, so the line says
    // what it actually knows and says why it knows no more.
    return `Signed in. The token is good until ${when(state.expiresAt)}; no address was asked ` +
      'for, so this page does not know which account it is.'
  }
  if (state.expiresAt !== null) {
    return `Signed in earlier; the token expired at ${when(state.expiresAt)}. A private file ` +
      'will answer 401 until you sign in again.'
  }
  return 'Not signed in. Public files open without this; a private Drive file or GCS object ' +
    'will not.'
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
