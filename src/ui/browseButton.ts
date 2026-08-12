/**
 * The button that opens the bucket browser, next to every box that takes a URL.
 *
 * Five boxes ask for one: the picker's *open a remote file*, the Tracks card's
 * fold, the Contact maps card's fold, the deck's add row, and the fold under an
 * empty cell of a deck. All five ask the same question — *which file* — and
 * until now only one of them had an answer for a reader who did not have the URL
 * in their hand, and that answer was behind a dialog for typing secret keys
 * into. This is the same view, offered where the question is asked.
 *
 * ## Why it is always there
 *
 * §8.5 says a control that cannot keep its promise is absent rather than
 * disabled, and the reading that would hide this button when no key is stored is
 * the wrong one: its promise is *find me a file on a bucket*, and with no bucket
 * yet the honest way to keep that promise is to say so and offer the one screen
 * that fixes it. Hiding it would also mean a button that appears and disappears
 * under the reader as keys are added and removed in another dialog — a control
 * that moves is worse than a control that explains itself.
 *
 * ## Why the module is this small
 *
 * So the import can be dynamic. The browser pulls in the listing parser and the
 * modal, ~8 kB that a session opening a public demo never touches, and a static
 * import from five cards would put all of it in the entry chunk to render a
 * button nobody pressed. Nothing here but `dom.ts` and a type.
 */

import { button } from './dom'
import type { BucketScope } from '../s3/credentials'

/**
 * A `browse…` button that opens the bucket browser and reports what was chosen.
 *
 * `onPick` is handed the object's URL and the scope it was listed under, which
 * is `null` only when the file came back through the credentials dialog rather
 * than through a listing. A caller with nowhere to put a credential can ignore
 * the second argument entirely: the lookup at the worker boundary
 * (`s3/attach.ts`) resolves the same key from the same URL.
 */
export function bucketBrowseButton(
  onPick: (url: string, scope: BucketScope | null) => void,
  options: { label?: string; class?: string; title?: string } = {},
): HTMLButtonElement {
  return button(
    options.label ?? 'browse…',
    () => {
      void import('./bucketBrowse').then(({ openBucketBrowser }) => {
        openBucketBrowser({ onPick })
      })
    },
    {
      class: options.class ?? 'btn',
      title:
        options.title ??
        'Browse a private bucket for a file, instead of pasting its URL',
    },
  )
}
