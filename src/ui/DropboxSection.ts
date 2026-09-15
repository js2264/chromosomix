/**
 * The Connect dialog’s Dropbox section: a sign-in, and a way in.
 *
 * Its own file rather than another function in `ui/ConnectCard.ts`, because it
 * is the only section of that dialog with a **flow** in it — the reader presses
 * a button, reads a code on somebody else’s page, comes back and pastes it — and
 * a flow has states the other sections do not have. The dialog composes it.
 *
 * ## Why the reader is asked to copy a code
 *
 * `auth/dropbox.ts` has the full argument; the short version is that an OAuth
 * redirect needs an address registered in advance, and this application is
 * served from four kinds of place (a site, a fork of it, `app://viewer`, and a
 * file on a disk) of which two have no registrable origin at all. Dropbox will
 * display the code instead of redirecting when asked for no `redirect_uri`, so
 * the same two gestures work everywhere. The section says this in one line,
 * because a reader who is handed a code with no explanation reasonably assumes
 * something has gone wrong.
 *
 * ## Two controls, and what each of them is
 *
 * The **sign-in** is the reader’s, it produces a credential, and it is kept
 * nowhere; the app key it names is the site’s, built in, and nothing a reader
 * is asked for. **Browse** opens the folder the sign-in has made readable, and
 * it is offered only once it has, on §8.5’s rule: a button that opens a folder
 * the account cannot list is a control that cannot keep its promise. The
 * sign-in button is the deliberate exception the Google section makes too —
 * *disabled with the reason beside it* on a site built without an app key,
 * because the reason names the one thing a reader can do about it.
 */

import { button, el, field } from './dom'
import { icon } from './icons'
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
 * The section, or `null` where a sign-in cannot work at all.
 *
 * `null` in the standalone build only (§19): its origin is opaque, so every
 * request to Dropbox fails before a byte moves. The desktop build keeps the
 * section, unlike the Google one beside it — nothing here is registered against
 * an origin, so `app://viewer` signs in as well as a website does.
 *
 * `done` is called with the folder id when the reader asks to browse, which is
 * what closes the dialog and opens the panel on it.
 */
export function dropboxSection(done: (id: string) => void): HTMLElement | null {
  if (!DROPBOX_SIGN_IN_AVAILABLE) return null

  const account = el('p', { class: 'hint' })
  const error = el('p', { class: 'hint bucket-error' })
  const actions = el('div', { class: 'bucket-actions' })

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
    // Nothing to type: the app key a sign-in names is the site's, built in
    // (`config/siteDefaults.ts`), and a site built without one says so here
    // rather than offering a box only its maintainer could fill.
    account.textContent = state.configured
      ? accountLine(state)
      : 'Signing in to Dropbox is not set up on this site: it needs a Dropbox app key, which the ' +
        'site’s maintainer provides as DROPBOX_APP_KEY (docs/deploy.md).'

    const label = state.expiresAt !== null && !state.signedIn ? 'sign in again' : 'sign in with Dropbox'
    const signInButton = button(
      label,
      () => {
        error.textContent = ''
        signInButton.disabled = true
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
        class: 'btn btn-primary',
        ...(state.configured
          ? {}
          : {
              title:
                'This site was built without a Dropbox app key, so there is no app to sign in to.',
            }),
      },
    )
    signInButton.disabled = !state.configured

    actions.replaceChildren(
      signInButton,
      // Offered only when there is something to sign out of, and only where
      // there is a folder worth opening — §8.5 on both.
      ...(state.signedIn
        ? [
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
          ]
        : []),
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
    if (!account.isConnected) {
      off()
      return
    }
    show()
  })

  return el(
    'div',
    { class: 'connect-section' },
    // `plug` and not a brand mark: the icon set is Lucide’s, copied verbatim by
    // `npm run icons`, and it carries no Dropbox glyph. This section is a
    // connection to a service, which is what the mark says.
    el('h3', {}, icon('plug', { size: 15 }), el('span', { text: 'Dropbox' })),
    el('p', {
      class: 'hint',
      text: 'Browse a Dropbox in the Files panel: sign in with your own Dropbox account.',
    }),
    el('p', {
      class: 'hint',
      text:
        `The app is given ${DROPBOX_PERMISSIONS.join(' and ')}: read access to everything in ` +
        'your Dropbox, or to the app’s own folder inside it if the site registered it that way.',
    }),
    el('p', {
      class: 'hint',
      text:
        'The token lives only in this tab’s memory — never written to storage, gone when the tab ' +
        'closes, expiring on its own. A file already open keeps reading for the four hours its ' +
        'link lasts.',
    }),
    account,
    actions,
    codeRow,
    error,
  )
}

/** What this page can honestly say about the account, in one line. */
function accountLine(state: { signedIn: boolean; expiresAt: number | null }): string {
  const when = (at: number): string => new Date(at).toLocaleTimeString()
  if (state.signedIn && state.expiresAt !== null) {
    // No address, because nothing here asks for `account_info.read` (§24.7).
    // Saying which account would cost a second permission for a label, which is
    // not a trade this app makes.
    return `Signed in. The token is good until ${when(state.expiresAt)}; no account information ` +
      'was asked for, so this page does not know whose Dropbox it is.'
  }
  if (state.expiresAt !== null) {
    return `Signed in earlier; the token expired at ${when(state.expiresAt)}. Listing a folder ` +
      'will answer 401 until you sign in again.'
  }
  return 'Not signed in. Browsing needs it; a Dropbox share link you paste into the URL box ' +
    'does not.'
}
