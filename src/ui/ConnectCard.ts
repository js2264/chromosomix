/**
 * Connect a place: a directory on this machine, a bucket, a Drive folder or a
 * Dropbox.
 *
 * One dialog for all four, because to a reader they are one thing — *the
 * place my data is* — and the app's own claim is that it reads them the same
 * way, one level at a time, in the Files column (§20). It is drawn as
 * **providers**: a row of four tiles, and the form of the one pressed under
 * it. The dialog used to stack six sections down one scroll, and two of the
 * six were not places at all — a Google API key and a Google account are
 * settings of *one provider*, and a reader meeting them between a bucket and a
 * Drive folder had to work out which of the two they belonged to. Now they sit
 * under Google Drive, which is the only tile that needs them.
 *
 * ## What the local half offers depends on the browser, and it says so
 *
 * Chromium and the desktop build have `showDirectoryPicker`, so a directory is
 * genuinely **connected**: the page holds a capability, the listing is live, and
 * it is all still there after a reload. Firefox and Safari have no such thing;
 * what they have hands over a flat list of `File` objects, from which the tree
 * is rebuilt. That is a **snapshot** — it does not update and it does not
 * survive a reload. §8.5's doctrine is that a control which cannot keep its
 * promise is absent rather than disabled, and the reading that would hide the
 * local half in Firefox is the wrong one: the gesture works there, and what
 * differs is how long the answer lasts. So the button is offered in both and
 * the sentence under it changes.
 *
 * ## Which providers are offered
 *
 * The standalone build has an opaque origin, so every remote read fails before
 * a byte moves (§19): it offers this machine and nothing else. The desktop
 * build cannot register a Google sign-in against `app://viewer`, so its Drive
 * pane says why there is no sign-in. Each provider's section decides the rest
 * for itself.
 *
 * ## The two panes that sign a reader in
 *
 * Google Drive and Dropbox are each a title, a `?` at the far right of the
 * same line, and one large sign-in button under it (`ui/connectHead.ts`):
 * what the grant is and where the token goes is behind the `?`, and the only
 * things on the pane itself are the ones a reader acts on.
 */

import { Modal } from './Modal'
import { button, el } from './dom'
import { icon, type IconName } from './icons'
import { bucketForm } from './bucketForm'
import { SITE_DEFAULTS } from '../config/siteDefaults'
import {
  GOOGLE_SIGN_IN_AVAILABLE,
  googleState,
  signIn as googleSignIn,
  signOut,
  subscribeGoogle,
} from '../auth/google'
import { announce, connectSnapshot } from '../browse/connected'
import { bucketFolderId } from '../browse/bucket'
import { chooseDirectory, chooseDirectoryFiles, directoryPickerSupported } from '../browse/local'
import { mintDirectoryId, rememberDirectory } from '../state/directories'
import { IS_STANDALONE } from '../version'
import { driveFolderSection } from './DriveFolderSection'
import { connectHead, signInButton, tipCode } from './connectHead'
import { DROPBOX_SIGN_IN_AVAILABLE } from '../auth/dropbox'
import { dropboxSection } from './DropboxSection'

/** The four places, by the id the tiles and the tests name them by. */
export type ProviderId = 'local' | 'bucket' | 'drive' | 'dropbox'

export interface ConnectProps {
  /**
   * A folder was connected. The panel opens on it, which is the only thing
   * worth doing next and is why this carries the id.
   */
  onConnected(id: string): void
  onClose?(): void
  /** The provider to open on. Default: this machine. */
  provider?: ProviderId
}

export function openConnect(props: ConnectProps): Modal {
  return new Modal({
    title: 'Open a local/remote folder',
    variant: 'modal-wide',
    ...(props.onClose === undefined ? {} : { onClose: props.onClose }),
    body: (close) => connectBody(props, close),
  })
}

interface Provider {
  id: ProviderId
  label: string
  mark: IconName
  /** The pane, built when the tile is pressed. */
  pane(done: (id: string) => void): HTMLElement
}

/** The providers this build can offer, in the order the tiles show them. */
export function providers(): Provider[] {
  const out: Provider[] = [
    { id: 'local', label: 'This machine', mark: 'hard-drive', pane: localSection },
  ]
  // A single-file page has an opaque origin, so every remote read fails before
  // a byte moves (§19): a control that cannot keep its promise is absent.
  if (IS_STANDALONE) return out
  out.push({ id: 'bucket', label: 'A bucket', mark: 'cloud', pane: bucketSection })
  out.push({ id: 'drive', label: 'Google Drive', mark: 'googledrive', pane: drivePane })
  // The one provider with an account and no key (§24.9); its section decides
  // for itself where it can be offered.
  if (DROPBOX_SIGN_IN_AVAILABLE) {
    out.push({
      id: 'dropbox',
      label: 'Dropbox',
      mark: 'dropbox',
      pane: (done) => dropboxSection(done) ?? el('div'),
    })
  }
  return out
}

function connectBody(props: ConnectProps, close: () => void): HTMLElement {
  const done = (id: string): void => {
    close()
    props.onConnected(id)
  }
  const list = providers()
  const paneSlot = el('div', { class: 'connect-pane' })
  const tiles = el('div', { class: 'connect-providers', attrs: { role: 'tablist' } })
  let chosen: ProviderId | null = null

  const show = (id: ProviderId): void => {
    const provider = list.find((one) => one.id === id) ?? list[0]
    chosen = provider.id
    for (const tile of tiles.children) {
      const on = tile.getAttribute('data-provider') === provider.id
      tile.classList.toggle('is-on', on)
      tile.setAttribute('aria-selected', String(on))
    }
    paneSlot.replaceChildren(provider.pane(done))
  }

  for (const provider of list) {
    const tile = el(
      'button',
      {
        class: 'connect-provider',
        type: 'button',
        attrs: { role: 'tab', 'data-provider': provider.id, 'aria-selected': 'false' },
      },
      icon(provider.mark, { size: 22 }),
      el('span', { text: provider.label }),
    )
    tile.addEventListener('click', () => show(provider.id))
    tiles.appendChild(tile)
  }
  show(props.provider ?? 'local')
  void chosen

  return el('div', { class: 'modal-body bucket-body connect-body' }, tiles, paneSlot, privacyNote())
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
      // A cancelled picker, which is not an error and needs no message.
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
    connectHead('A folder on this machine', 'hard-drive', localHelp(granted)),
    // The one large button the two sign-in panes have, because this pane is
    // the same shape as theirs: one thing to press, and everything worth
    // knowing before pressing it behind the `?`. What a browser without the
    // picker gives is a snapshot rather than a connection, and the difference
    // is carried by the label — the reader acts on that, so it stays on the
    // pane where the rest of the sentence no longer is.
    el(
      'div',
      { class: 'connect-signin' },
      signInButton(
        granted ? 'choose a folder…' : 'choose a folder (this visit)…',
        'hard-drive',
        () => void connect(),
        { disabled: false },
      ),
    ),
    error,
  )
}

/** Behind the local pane's `?`: what "read in place" means, and how long it lasts. */
function localHelp(granted: boolean): string[] {
  return [
    'Read in place, never uploaded. The folder is listed one level at a time in the Files panel, ' +
      'and no byte of it is sent anywhere.',
    granted
      ? 'The browser keeps permission to list the folder across reloads; take it back any time ' +
        'under About → what is stored.'
      : 'This browser cannot keep that permission, so what you get is a snapshot of the file list ' +
        'for this visit only — it does not update and it does not survive a reload. Chrome, Edge ' +
        'and the desktop app keep the connection.',
  ]
}

/** The bucket half: the shared form, and nothing of its own. */
function bucketSection(done: (id: string) => void): HTMLElement {
  return el(
    'div',
    { class: 'connect-section' },
    connectHead('A bucket', 'cloud', bucketHelp()),
    bucketForm({ onSaved: (scope) => done(bucketFolderId(scope.id)) }),
  )
}

/**
 * Behind the bucket pane's `?`: how to make a bucket serve this viewer.
 *
 * The only one of the four panes whose subject is a *configuration* somebody
 * has to go and make, rather than a consent they are about to give — so it is
 * the one whose tip carries policies to paste rather than sentences to read,
 * and the reason `tipCode` exists. Both blocks are the whole of what has to be
 * set: everything a reader gets wrong here is one of the two.
 */
function bucketHelp(): Array<string | HTMLElement> {
  return [
    'An https:// or s3:// prefix on S3, R2, MinIO, Google Cloud Storage or anything else that ' +
      'answers ListObjectsV2. Your browser reads it directly, with no server in between, so the ' +
      'bucket — not this page — decides what may be read. Two things have to be set.',
    'CORS first, without which no read starts at all. Range and Content-Range are the pair that ' +
      'matters: a .mcool is read in pieces and never whole, so a bucket that will not expose them ' +
      'serves files this viewer cannot open. Narrow AllowedOrigins to the site once it works.',
    tipCode(
      `[{
  "AllowedOrigins": ["*"],
  "AllowedMethods": ["GET", "HEAD"],
  "AllowedHeaders": ["Range", "Content-Type"],
  "ExposeHeaders": [
    "Accept-Ranges", "Content-Range", "Content-Length", "ETag"
  ]
}]`,
    ),
    'Then the reading. Public data needs s3:GetObject on the objects and s3:ListBucket on the ' +
      'bucket — two different grants, which is why a prefix whose files open by URL may still ' +
      'refuse to be browsed.',
    tipCode(
      `{
  "Effect": "Allow",
  "Principal": "*",
  "Action": ["s3:GetObject", "s3:ListBucket"],
  "Resource": [
    "arn:aws:s3:::BUCKET",
    "arn:aws:s3:::BUCKET/PREFIX/*"
  ]
}`,
    ),
    'For private data, leave that policy off and put a key under Additional settings instead: an ' +
      'IAM user with those same two actions on this prefix and nothing else. The region is part ' +
      'of the signature, so a wrong one is a 403.',
    'A key is kept in this browser and signs requests from this page, so anything able to run ' +
      'script on this origin can read it. There is no server to hide it behind — the same ' +
      'property that makes a dropped file never leave your machine. Never paste an administrator ' +
      'key here.',
  ]
}

/**
 * Google Drive: a title, a `?`, a sign-in, and — once signed in — a folder box.
 *
 * One section, not two. The account and the folder used to be sections of
 * their own, each with a heading and a paragraph, and a reader pressing *sign
 * in* read two consent notices on the way to it. What the pane offers is the
 * sign-in; what it needs to say about the grant is behind the `?` on the same
 * line as the title (`ui/connectHead.ts`); and the folder box is what appears
 * once there is an account to list a folder with (`ui/DriveFolderSection.ts`).
 *
 * Nothing to type. The client id a sign-in goes to is the site's, built in
 * (`config/siteDefaults.ts`), and so is the API key that opens a public Drive
 * link; a site built without the client id says so under the button rather
 * than offering a box only its maintainer could fill.
 */
function drivePane(done: (id: string) => void): HTMLElement {
  const head = connectHead('Connect to your Google Drive', 'googledrive', driveHelp())

  if (!GOOGLE_SIGN_IN_AVAILABLE) {
    return el(
      'div',
      { class: 'connect-section' },
      head,
      el('p', {
        class: 'hint',
        text:
          'Not on the desktop app: a sign-in is registered against a web address, and this ' +
          'window has none. ' +
          (SITE_DEFAULTS.googleApiKey !== null
            ? 'Public Drive files still open.'
            : 'Public Drive files open on the website.'),
      }),
    )
  }

  const actions = el('div', { class: 'connect-signin' })
  const error = el('p', { class: 'hint bucket-error' })
  const folder = driveFolderSection(done)

  const show = (): void => {
    const state = googleState()
    if (state.signedIn && state.expiresAt !== null) {
      actions.replaceChildren(
        el('span', { class: 'hint', text: `Signed in until ${clock(state.expiresAt)}.` }),
        button('sign out', () => signOut(), { class: 'btn' }),
      )
      return
    }
    const signIn = signInButton(
      state.expiresAt !== null ? 'sign in again' : 'sign in with Google',
      'googledrive',
      () => {
        error.textContent = ''
        signIn.disabled = true
        void googleSignIn()
          .catch((cause: unknown) => {
            error.textContent = cause instanceof Error ? cause.message : String(cause)
          })
          .finally(() => {
            show()
          })
      },
      // Disabled rather than absent where the site has no registration: the
      // sentence under it is the one thing a reader can act on — by asking the
      // site's maintainer — and hiding the button would hide what the sentence
      // is about.
      {
        disabled: !state.configured,
        reason: 'This site was built without a Google client id, so there is no project to sign in to.',
      },
    )
    actions.replaceChildren(
      signIn,
      ...(state.configured
        ? []
        : [
            el('p', {
              class: 'hint',
              text:
                'Signing in to Google is not set up on this site: it needs a Google client id ' +
                'registered for its address, which the site’s maintainer provides as ' +
                'GOOGLE_CLIENT_ID (docs/deploy.md).',
            }),
          ]),
    )
  }
  show()

  const off = subscribeGoogle(() => {
    // The dialog is built once and thrown away with the modal, and nothing hands
    // a detached body a teardown. It unsubscribes itself the first time it is
    // spoken to after leaving the document.
    if (!actions.isConnected) {
      off()
      return
    }
    show()
  })

  return el('div', { class: 'connect-section' }, head, actions, error, ...(folder === null ? [] : [folder]))
}

/**
 * What the `?` says about a Google sign-in.
 *
 * The two sentences §24.7 requires this dialog to say — what `drive.readonly`
 * actually is, and where the token ends up — and it requires them because a
 * consent screen says neither: Google's names the product, and nothing
 * anywhere tells the reader where the token goes. Then what a folder costs in
 * privacy terms (§20.6), because the folder box is on this same pane.
 */
function driveHelp(): string[] {
  return [
    'Sign in with your own Google account to open a Drive file, a Drive folder or a Cloud ' +
      'Storage object that is not public.' +
      (SITE_DEFAULTS.googleApiKey !== null ? ' A public Drive link opens without signing in.' : ''),
    'drive.readonly is read access to all of your Drive, where a bucket key is a grant over ' +
      'one prefix; devstorage.read_only is read access to the Cloud Storage your account can see.',
    'The token lives only in this tab’s memory — never written to storage, gone when the tab ' +
      'closes, and expiring about an hour after you sign in. No address is asked for, so this ' +
      'page does not know which account it is.',
    'A folder is listed with that account, one level at a time, in the Files panel. Paste the ' +
      'address bar of a folder open in Drive — a shared drive works the same way — or its id; ' +
      'an empty box is all of My Drive. Only the folder’s name and id are kept, under About → ' +
      'what is stored.',
  ]
}

/** A time of day, the way the pane says until when a token is good. */
function clock(at: number): string {
  return new Date(at).toLocaleTimeString()
}

/**
 * The claim, restated where the grant is actually being made.
 *
 * The picker says it on the first screen and the About dialog says it in full;
 * this is the one moment a reader hands over something wider than a single file,
 * so it is worth the four lines.
 */
function privacyNote(): HTMLElement {
  return el(
    'div',
    { class: 'bucket-note' },
    icon('info', { size: 16 }),
    el(
      'div',
      {},
      el('strong', { text: 'Nothing is sent anywhere.' }),
      el('span', {
        text:
          ' A folder is read in place, a bucket by your browser directly; there is no server in ' +
          'between. Every place you connect is listed under About → what is stored.',
      }),
    ),
  )
}
