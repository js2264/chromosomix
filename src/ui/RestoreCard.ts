/**
 * The offer to pick a workspace back up, and the account of what is being kept.
 *
 * Two surfaces, one subject, so they live together: the banner that says *you
 * had six tabs open, would you like them back*, and the dialog that answers
 * *what exactly is this app remembering about me* — including the button that
 * makes the answer "nothing".
 *
 * ## Why this is an offer and not a restore
 *
 * `app/sessions.ts` decided, deliberately, that a set of open files belongs to
 * the window it was opened in and that closing the tab ends it. Nothing here
 * overturns that; the durable record (`state/workspace.ts`) is consulted only
 * when session storage is *absent*, which is exactly "the browser was closed".
 * Even then it is offered rather than applied, for two reasons that are not the
 * same reason. Reopening six files a week later reverses a decision the reader
 * made by closing them. And on a shared machine — the laptop §11 is written for,
 * holding data nobody has published — it would put somebody else's unpublished
 * figure on screen for whoever sat down next.
 *
 * So the banner asks, and **closing it forgets the record** rather than merely
 * hiding the banner — the × is a close cross in the corner, not a second,
 * unlabelled way to hide the note without answering it. An offer that comes
 * back tomorrow having been declined today is not an offer.
 *
 * ## Why the banner is the window's rather than the picker's
 *
 * It is a statement about *N tabs*, and a `Session` deliberately knows nothing
 * about the window it is in. Putting it on the picker would also make it
 * invisible in the case it is most useful: a link opened into a fresh browser
 * shows that file rather than the picker, and the reader's six other tabs are
 * exactly as worth offering then.
 */

import { Modal } from './Modal'
import { button, el } from './dom'
import { cardTitle, iconButton } from './icons'
import { fileLabel } from './labels'
import type { WorkspaceSummary } from '../state/workspace'
import type { StoredItem } from '../state/stored'

export interface RestoreBannerProps {
  summary: WorkspaceSummary
  /** ISO stamp the record carries, or `''` when it carries none. */
  savedAt: string
  onRestore(): void
  /** The × was clicked: the record is forgotten, not merely dismissed. */
  onDismiss(): void
}

/**
 * How long ago, in the coarsest unit that is still true.
 *
 * Coarse on purpose: "3 days ago" is what decides whether a reader wants these
 * tabs back, and a timestamp to the minute invites them to work out the answer
 * instead of reading it. An unparseable or absent stamp yields `null` and the
 * sentence simply omits the clause, because a wrong time here is worse than no
 * time — it is the only evidence the reader has about which session this was.
 */
export function agoLabel(savedAt: string, now: Date): string | null {
  const then = Date.parse(savedAt)
  if (Number.isNaN(then)) return null
  const seconds = Math.round((now.getTime() - then) / 1000)
  // A record from the future is a clock that moved, not a session from next
  // week. Saying nothing is the honest answer.
  if (seconds < 0) return null
  if (seconds < 90) return 'just now'
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes} minutes ago`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return hours === 1 ? 'an hour ago' : `${hours} hours ago`
  const days = Math.round(hours / 24)
  return days === 1 ? 'yesterday' : `${days} days ago`
}

/** `yeast.mcool, ATAC.bw and 4 more` — what the reader recognises it by. */
export function filesLabel(files: readonly string[]): string {
  const names = files.map((uri) => fileLabel(uri))
  if (names.length === 0) return 'nothing'
  if (names.length === 1) return names[0]
  if (names.length === 2) return `${names[0]} and ${names[1]}`
  return `${names[0]}, ${names[1]} and ${names.length - 2} more`
}

/** One line of plain English about a stored workspace. */
export function bannerLine(summary: WorkspaceSummary, ago: string | null): string {
  const tabs = summary.tabs === 1 ? '1 tab' : `${summary.tabs} tabs`
  const tracks =
    summary.tracks === 0 ? '' : summary.tracks === 1 ? ', with 1 track' : `, with ${summary.tracks} tracks`
  const when = ago === null ? '' : ` ${ago}`
  return `You had ${tabs} open${when}: ${filesLabel(summary.files)}${tracks}.`
}

/**
 * The banner itself.
 *
 * `role="status"` rather than an alert: it is worth announcing to a screen
 * reader on arrival and it is not an interruption — nothing is wrong, and
 * ignoring it entirely is a legitimate answer that leaves the record alone for
 * next time.
 */
export function restoreBanner(props: RestoreBannerProps): HTMLElement {
  const ago = agoLabel(props.savedAt, new Date())
  return el(
    'div',
    { class: 'restore-banner', attrs: { role: 'status' } },
    el('div', { class: 'restore-text' }, el('span', { text: bannerLine(props.summary, ago) })),
    el(
      'div',
      { class: 'restore-actions' },
      button('Restore', () => props.onRestore(), {
        class: 'btn btn-primary',
        title: 'Reopen those tabs, with their tracks, marks and filters.',
      }),
      // Said out loud in the title, because a close cross that also deletes is
      // not what a reader expects one to do — an icon alone cannot carry that,
      // so the accessible name does.
      iconButton(
        'x',
        'Close. This deletes the remembered workspace rather than hiding this note.',
        () => props.onDismiss(),
        { class: 'btn-close' },
      ),
    ),
  )
}

/**
 * A passing remark the reader can dismiss — not a modal, not an error view.
 *
 * The app had two ways to say something and no third: a `Modal`, which takes the
 * keyboard and demands an answer, and the error view, which replaces what is on
 * screen. Both are far too loud for *"this opened, and here is something you may
 * want to know about it"* — and a remark that has to be dismissed before the
 * reader can look at their map would be worse than not making it.
 *
 * So: the same row the restore offer uses, in the same place, with an × on it.
 * `role="status"` rather than `alert` for the same reason it is dismissible —
 * nothing is wrong, and ignoring it entirely is a legitimate answer.
 */
export function noticeBanner(message: string, onDismiss: () => void): HTMLElement {
  const row = el(
    'div',
    { class: 'restore-banner notice-banner', attrs: { role: 'status' } },
    el('div', { class: 'restore-text' }, el('span', { text: message })),
  )
  row.appendChild(
    el(
      'div',
      { class: 'restore-actions' },
      button('Dismiss', onDismiss, { class: 'btn btn-quiet', title: 'Hide this note.' }),
    ),
  )
  return row
}

export interface StoredDataProps {
  items: StoredItem[]
  onForgetAll(): void
  onClose?(): void
}

/**
 * What this app is keeping, and the button that ends it.
 *
 * The list is built by the caller rather than gathered here, because the stores
 * are spread across three layers and this module has no business knowing about
 * any of them. What it does own is the promise the dialog makes: if a thing is
 * held, it is named here, and **Forget everything** means everything — not the
 * new IndexedDB half while thirteen `localStorage` keys, one of them holding an
 * S3 secret in cleartext, quietly stay put.
 */
export function openStoredData(props: StoredDataProps): Modal {
  return new Modal({
    title: 'What this browser is remembering',
    ...(props.onClose === undefined ? {} : { onClose: props.onClose }),
    body: (close) =>
      el(
        'div',
        { class: 'stored-body' },
        el('p', {
          class: 'hint',
          text:
            'All of it is on this computer and none of it has been anywhere else. File contents ' +
            'are never among it: what is kept is which files were open and how you had them set ' +
            'up, never a copy of the data.',
        }),
        props.items.length === 0
          ? el('p', { text: 'Nothing is being kept.' })
          : el(
              'div',
              { class: 'card' },
              cardTitle('Stored', 'save'),
              el(
                'div',
                { class: 'kv' },
                ...props.items.flatMap((item) => [
                  el('div', { class: 'k', text: item.label }),
                  el('div', { class: 'v', text: item.detail, title: item.detail }),
                ]),
              ),
            ),
        el(
          'div',
          { class: 'stored-actions' },
          button(
            'Forget everything',
            () => {
              props.onForgetAll()
              close()
            },
            {
              class: 'btn btn-danger',
              title:
                'Clears every remembered workspace, preference and saved bucket key from this browser.',
            },
          ),
        ),
      ),
  })
}
