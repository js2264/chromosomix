/**
 * The places a window can connect to, as data: an id, a name, a mark, a verb.
 *
 * Two doors offer the same four places and drew their own list of them. The
 * Connect dialog (`ui/ConnectCard.ts`) draws them as **tiles** — a place has a
 * name, and the tile is a tab over the form that connects it. The landing page
 * draws them as **buttons** — a reader who has just arrived has nothing to tab
 * between, so what they are offered is the gesture, and a button is named by
 * its verb. The two differ in exactly that word, which is why both are here
 * and why nothing else about a place is.
 *
 * No pane is here. The forms, the sign-ins and the flows behind them are the
 * dialog's, imported on a gesture (`App.openConnectDialog`), and this module
 * is deliberately light enough for the landing page to hold at load: three
 * constants and a list.
 *
 * ## What `works` is for
 *
 * §8.5's doctrine is that a control which cannot keep its promise is absent
 * rather than disabled, and the two doors part company on one place. Google's
 * OAuth registers an `http`/`https` origin, so the desktop build's
 * `app://viewer` cannot sign in at all (`auth/google.ts`). The dialog still
 * offers Drive, because a reader who went looking for it is owed the sentence
 * saying why it is not there; the landing page offers a row of things to press
 * and a button that leads only to an explanation is not one of them. So the
 * fact is recorded once, here, and each door reads it its own way.
 */

import { DROPBOX_SIGN_IN_AVAILABLE } from '../auth/dropbox'
import { GOOGLE_SIGN_IN_AVAILABLE } from '../auth/google'
import { IS_STANDALONE } from '../version'
import type { IconName } from './icons'

/** The four places, by the id the tiles, the buttons and the tests name them by. */
export type ProviderId = 'local' | 'bucket' | 'drive' | 'dropbox'

export interface ProviderFront {
  id: ProviderId
  /** The tile's name: a place, because a tab is labelled by where it goes. */
  label: string
  /** The button's name: a gesture, because a button is labelled by what it does. */
  verb: string
  mark: IconName
  /** Whether pressing this in *this* build reaches something that can act. See the header. */
  works: boolean
}

/**
 * The places this build can offer, in the order both doors show them.
 *
 * The standalone build is one HTML file with an opaque origin, so every remote
 * read fails before a byte moves (§19): it has this machine and nothing else.
 */
export function providerFronts(): ProviderFront[] {
  const out: ProviderFront[] = [
    { id: 'local', label: 'This machine', verb: 'choose a folder…', mark: 'hard-drive', works: true },
  ]
  if (IS_STANDALONE) return out
  out.push({ id: 'bucket', label: 'A bucket', verb: 'connect a bucket…', mark: 'cloud', works: true })
  out.push({
    id: 'drive',
    label: 'Google Drive',
    verb: 'sign in to Google…',
    mark: 'googledrive',
    works: GOOGLE_SIGN_IN_AVAILABLE,
  })
  // The one provider with an account and no key (§24.9). Signed in by a code
  // the reader pastes, which needs no registered address, so the desktop build
  // keeps it where it loses Drive.
  if (DROPBOX_SIGN_IN_AVAILABLE) {
    out.push({ id: 'dropbox', label: 'Dropbox', verb: 'sign in to Dropbox…', mark: 'dropbox', works: true })
  }
  return out
}
