/**
 * The Connect dialog’s Dropbox pane: a sign-in, and a way in.
 *
 * Its own file rather than another function in `ui/ConnectCard.ts`, because it
 * is the only pane of that dialog with a **flow** in it — the reader presses
 * a button, reads a code on somebody else’s page, comes back and pastes it — and
 * a flow has states the other panes do not have. The dialog composes it.
 *
 * ## Why the reader is asked to copy a code
 *
 * `auth/dropbox.ts` has the full argument; the short version is that an OAuth
 * redirect needs an address registered in advance, and this application is
 * served from four kinds of place (a site, a fork of it, `app://viewer`, and a
 * file on a disk) of which two have no registrable origin at all. Dropbox will
 * display the code instead of redirecting when asked for no `redirect_uri`, so
 * the same two gestures work everywhere. The pane says this in one line, at
 * the moment the code box appears, because a reader who is handed a code with
 * no explanation reasonably assumes something has gone wrong.
 *
 * ## What is on the pane, and what is behind the `?`
 *
 * A title, a `?` at the far right of the same line, and one large sign-in
 * button (`ui/connectHead.ts`). What the app is granted and where the token
 * lives are behind the `?` — §24.7's sentences, one hover away. Visible are the
 * things a reader acts on: the button, the reason it is disabled on a site
 * built without an app key, the code box once a sign-in has begun, and — once
 * signed in — *browse my Dropbox* and *sign out*, offered only then on §8.5’s
 * rule: a button that opens a folder the account cannot list is a control that
 * cannot keep its promise. The sign-in button is the deliberate exception the
 * Google pane makes too — *disabled with the reason beside it* on a site built
 * without an app key, because the reason names the one thing a reader can do.
 */

import { button, el, field } from './dom'
import { connectHead, signInButton } from './connectHead'
import {
  beginSignIn,
  DROPBOX_PERMISSIONS,
  DROPBOX_SIGN_IN_AVAILABLE,
  dropboxState,
  finishSignIn,
  signOut,
  subscribeDropbox,
} from '../auth/dropbox'
import { DROPBOX_FOLDER_ID } from '../browse/dropbox'

/**
 * The pane, or `null` where a sign-in cannot work at all.
 *
 * `null` in the standalone build only (§19): its origin is opaque, so every
 * request to Dropbox fails before a byte moves. The desktop build keeps the
 * pane, unlike the Google one beside it — nothing here is registered against
 * an origin, so `app://viewer` signs in as well as a website does.
 *
 * `done` is called with the folder id when the reader asks to browse, which is
 * what closes the dialog and opens the panel on it.
 */
export function dropboxSection(done: (id: string) => void): HTMLElement | null {
  if (!DROPBOX_SIGN_IN_AVAILABLE) return null

  const actions = el('div', { class: 'connect-signin' })
  const error = el('p', { class: 'hint bucket-error' })

  // Built once and then only shown or hidden, never rebuilt: it is where the
  // caret is, and a box replaced under a reader halfway through pasting a
  // sixty-character code loses the paste (`ui/folderBrowse.ts`’s filter input,
  // for the same reason).
  const code = el('input', { class: 'input', type: 'text', placeholder: 'the code Dropbox showed' })
  const link = el('a', { class: 'hint', text: 'the Dropbox page' })
  link.setAttribute('target', '_blank')
  link.setAttribute('rel', 'noopener noreferrer')
  const codeRow = el(
    'div',
    { class: 'connect-code hidden' },
    el('p', {
      class: 'hint',
      // Said here rather than only in the docs, because a reader who is sent to
      // another tab and handed a code has every reason to think the sign-in has
      // failed.
      text:
        'Dropbox shows a code instead of sending you back here, because this page has no address ' +
        'to be sent back to. Copy the code into the box and press finish.',
    }),
    el('p', { class: 'hint' }, el('span', { text: 'If no tab opened, open ' }), link, el('span', { text: '.' })),
    field('code', code),
  )

  const show = (): void => {
    const state = dropboxState()
    if (state.signedIn && state.expiresAt !== null) {
      actions.replaceChildren(
        el('span', { class: 'hint', text: `Signed in until ${clock(state.expiresAt)}.` }),
        // Offered only when there is a folder worth opening and something to
        // sign out of — §8.5 on both.
        button('browse my Dropbox', () => done(DROPBOX_FOLDER_ID), { class: 'btn' }),
        button(
          'sign out',
          () => {
            signOut()
            codeRow.classList.add('hidden')
            code.value = ''
          },
          { class: 'btn' },
        ),
      )
      return
    }

    const signIn = signInButton(
      state.expiresAt !== null ? 'sign in again' : 'sign in to Dropbox',
      'dropbox',
      () => {
        error.textContent = ''
        signIn.disabled = true
        void beginSignIn()
          .then(({ url }) => {
            link.setAttribute('href', url)
            // Opened from inside the click handler’s own task, which is what
            // keeps it a user gesture as far as the pop-up blocker is
            // concerned; the link above is the answer for the blockers that
            // refuse it anyway.
            window.open(url, '_blank', 'noopener,noreferrer')
            codeRow.classList.remove('hidden')
          })
          .catch((cause: unknown) => {
            error.textContent = cause instanceof Error ? cause.message : String(cause)
          })
          .finally(() => {
            show()
          })
      },
      {
        disabled: !state.configured,
        reason: 'This site was built without a Dropbox app key, so there is no app to sign in to.',
      },
    )
    actions.replaceChildren(
      signIn,
      // Nothing to type: the app key a sign-in names is the site's, built in
      // (`config/siteDefaults.ts`), and a site built without one says so here
      // rather than offering a box only its maintainer could fill.
      ...(state.configured
        ? []
        : [
            el('p', {
              class: 'hint',
              text:
                'Signing in to Dropbox is not set up on this site: it needs a Dropbox app key, ' +
                'which the site’s maintainer provides as DROPBOX_APP_KEY (docs/deploy.md).',
            }),
          ]),
    )
  }
  show()

  const finish = (): void => {
    error.textContent = ''
    void finishSignIn(code.value)
      .then(() => {
        code.value = ''
        codeRow.classList.add('hidden')
      })
      .catch((cause: unknown) => {
        error.textContent = cause instanceof Error ? cause.message : String(cause)
      })
      .finally(() => {
        show()
      })
  }
  codeRow.appendChild(el('div', { class: 'bucket-actions' }, button('finish', finish, { class: 'btn btn-primary' })))

  const off = subscribeDropbox(() => {
    // The dialog is built once and thrown away with the modal, and nothing hands
    // a detached body a teardown. It unsubscribes itself the first time it is
    // spoken to after leaving the document — `ui/SequenceCard.ts`’s idiom.
    if (!actions.isConnected) {
      off()
      return
    }
    show()
  })

  return el(
    'div',
    { class: 'connect-section' },
    connectHead('Dropbox', 'dropbox', dropboxHelp()),
    actions,
    codeRow,
    error,
  )
}

/**
 * What the `?` says about a Dropbox sign-in: the grant, and where the token
 * lives (§24.7, §24.9). No address is named anywhere on the pane, because
 * nothing here asks for `account_info.read` — saying which account would cost
 * a second permission for a label, which is not a trade this app makes.
 */
function dropboxHelp(): string[] {
  return [
    'Sign in with your own Dropbox account to browse it in the Files panel.',
    `The app is given ${DROPBOX_PERMISSIONS.join(' and ')}: read access to everything in ` +
      'your Dropbox, or to the app’s own folder inside it if the site registered it that way.',
    'The token lives only in this tab’s memory — never written to storage, gone when the tab ' +
      'closes, expiring on its own. A file already open keeps reading for the four hours its ' +
      'link lasts. No account information is asked for, so this page does not know whose ' +
      'Dropbox it is.',
  ]
}

/** A time of day, the way the pane says until when a token is good. */
function clock(at: number): string {
  return new Date(at).toLocaleTimeString()
}
