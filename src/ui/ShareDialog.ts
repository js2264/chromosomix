/**
 * The share dialog: one link that is always honest, and one that is short.
 *
 * Two buttons and the difference between them stated out loud, because it is a
 * real difference and hiding it would be the kind of convenience that costs
 * somebody a broken link in a paper. The long one is the whole session encoded
 * into the fragment: no server, no expiry, works offline and in the desktop
 * build, and — the fragment never being sent on navigation — nothing about what
 * anybody is looking at reaches the host serving the page. The short one is a
 * third party's, is named as such, and takes the URL of the file being viewed
 * off this machine.
 *
 * The long link is on screen from the moment the dialog opens and stays there
 * through every outcome, including a failed shortening. Nothing here can leave
 * a reader with nothing to copy.
 *
 * And it is copied for them, the moment there is something to copy — opening
 * this dialog is already the whole of the intention, and the press of a button
 * afterwards was a step that existed only because nobody had removed it. The
 * clipboard is not silently taken, though: the note under the box says it was
 * written, because a clipboard that changed without a word is how somebody
 * pastes a link where they meant to paste the paragraph they had copied before.
 *
 * That note, and not a note in the corner. The corner is for work that finishes
 * after the thing the reader was waiting for (`ui/toast.ts`), and this finishes
 * while they are looking at the dialog it happened in — nine hundred pixels
 * away, over the status bar, in different words from the ones the copy button
 * produces, and gone in four seconds. Both outcomes of one action now land in
 * one place, in one wording: the refusal already did.
 */

import { Modal } from './Modal'
import { button, el } from './dom'
import { icon, iconButton } from './icons'
import { copyTextToClipboard } from './export'
import {
  SHORTENER,
  encodeShare,
  lengthAdvice,
  shareUrl,
  shorten,
  shortenable,
} from '../state/shareLink'
import type { SessionConfig } from '../state/SessionConfig'

export interface ShareDialogProps {
  config: SessionConfig
  /** The page's own address, without a fragment. */
  base: string
  /**
   * Called however the dialog was dismissed, so the opener can forget it.
   *
   * Every other opener in the application takes one and the shell relies on it:
   * `App` keeps the modal it opened in a field and treats a non-null field as
   * "a dialog owns the keyboard", so a dialog that never says it closed leaves
   * every shortcut, the command palette and every other dialog dead until the
   * page is reloaded. This one used not to take it.
   */
  onClose?(): void
}

/**
 * What the reader is told when the browser will not write the clipboard for us.
 *
 * Not phrased as an error, because from where the reader sits nothing has gone
 * wrong: the link is on screen, selected, and one keystroke from being theirs.
 */
const REFUSED = 'Select-and-copy: this browser did not allow the clipboard to be written.'

export function openShareDialog(props: ShareDialogProps): Modal {
  // A box rather than an `<input>`. The link is a few hundred to a few thousand
  // characters of base64 on one line, and an input can only be scrolled through
  // it with the caret — no wheel, no drag past the edge, and nothing at all for
  // a reader who just wants to see how it ends. A `div` with `overflow-x` is
  // scrolled by every means a reader already knows, and `tabindex` keeps it on
  // the Tab order the input was on, so the dialog still opens with the caret on
  // the link (`Modal` focuses the body's first focusable) rather than on ✕.
  //
  // The `role` and the label are not decoration. An `<input readOnly>` is
  // announced by a screen reader as a named field holding a value; a bare
  // focusable `div` is announced as nothing at all, which would trade a
  // scrollable box for a stop on the Tab order that says why it is there to
  // nobody. `aria-readonly` because it is genuinely not editable — a reader who
  // is told they can type here and then cannot has been told a worse thing than
  // silence.
  const field = el('div', {
    class: 'share-link',
    attrs: {
      tabindex: '0',
      role: 'textbox',
      'aria-readonly': 'true',
      'aria-label': 'The link to this tab',
    },
    text: 'preparing…',
  })

  const note = el('p', { class: 'hint' })
  const advice = el('p', { class: 'hint' })
  const shortRow = el('div', { class: 'share-row' })

  let link = ''

  const say = (message: string, kind: 'ok' | 'warn' = 'ok'): void => {
    note.textContent = message
    note.classList.toggle('warn', kind === 'warn')
  }

  /**
   * Add a sentence to whatever the note already says instead of replacing it.
   *
   * Two of these can be true at the same moment and both are worth reading: the
   * shortener succeeded *and* the clipboard was refused. Replacing would drop
   * the first, which is the one that changed the link in the box.
   */
  const alsoSay = (message: string): void => {
    const already = note.textContent ?? ''
    note.textContent = already === '' ? message : `${already} ${message}`
  }

  /**
   * Select the whole link, as `input.select()` used to.
   *
   * This is the load-bearing half of the clipboard fallback and not a flourish:
   * where the clipboard API is refused — every insecure origin, which includes a
   * colleague's `file://` copy of this app — selecting the text is the entire
   * remedy the dialog can offer, and asking somebody to drag-select two thousand
   * characters of base64 by hand is not offering one.
   */
  const selectLink = (): void => {
    field.focus()
    const selection = window.getSelection?.()
    if (selection == null) return
    const range = document.createRange()
    range.selectNodeContents(field)
    selection.removeAllRanges()
    selection.addRange(range)
  }

  /**
   * The clipboard write, and whether it landed. Never throws.
   *
   * Through the shared helper rather than `navigator.clipboard.writeText`: the
   * API is missing outright in an insecure context, so the raw call throws a
   * `TypeError` on a property of `undefined` instead of rejecting, and this
   * dialog had its own copy of that reading (`ui/export.ts`).
   */
  const putOnClipboard = async (): Promise<boolean> => {
    try {
      await copyTextToClipboard(link)
      return true
    } catch {
      return false
    }
  }

  /** The button: the reader asked, so the answer goes in the dialog they are looking at. */
  const copy = async (): Promise<void> => {
    if (link === '') return
    if (await putOnClipboard()) {
      say('Copied to the clipboard.')
      return
    }
    selectLink()
    say(REFUSED)
  }

  /**
   * The copy nobody pressed a button for, on every link this dialog produces.
   *
   * Said in the dialog's own note, where the reader's eye is and where the
   * button's copy is answered. `alsoSay` rather than `say` because the note may
   * already be carrying the sentence about where the link came from — after a
   * shortening this runs a second time — and that one changed the link in the
   * box, so it is the one that must not be dropped. A refusal falls back to
   * exactly what the button falls back to: the text selected, and the sentence
   * explaining why.
   */
  const copyOnArrival = async (): Promise<void> => {
    if (link === '') return
    if (await putOnClipboard()) {
      alsoSay('Copied to the clipboard.')
      return
    }
    selectLink()
    alsoSay(REFUSED)
  }

  const shortenIt = async (target: HTMLButtonElement): Promise<void> => {
    target.disabled = true
    const previous = target.textContent
    target.textContent = 'shortening…'
    try {
      const short = await shorten(link)
      link = short
      field.textContent = short
      advice.textContent = ''
      say(`Shortened by ${SHORTENER.name}. The long link still works if you kept it.`)
      target.remove()
      // The short one is now what the reader will paste, so it is what the
      // clipboard should hold: leaving the long link there would hand somebody
      // the opposite of what they just pressed a button for. Not waited on, for
      // the same reason as on arrival — the button is already gone and the note
      // already says what happened.
      void copyOnArrival()
    } catch (error) {
      target.disabled = false
      target.textContent = previous ?? `shorten with ${SHORTENER.name}`
      say(
        `${SHORTENER.name} could not be reached — ${
          error instanceof Error ? error.message : String(error)
        } The link above is unaffected.`,
        'warn',
      )
    }
  }

  const modal = new Modal({
    title: 'Share this tab',
    // The wide panel, because the narrow one is narrower than this body wants to
    // be: the link and its button sit on one row, and in `min(34rem, 100%)` the
    // row wrapped the button under a box already too short to show a useful
    // stretch of the payload.
    variant: 'modal-wide',
    ...(props.onClose === undefined ? {} : { onClose: props.onClose }),
    body: () =>
      el(
        'div',
        { class: 'share-body' },
        el('p', {
          class: 'hint',
          text:
            'The link carries everything in this tab — the view, the tracks and their colours, ' +
            'the marks and the bookmarks. No server holds it, so it cannot expire, and nothing ' +
            'about it reaches the site serving this page.',
        }),
        el(
          'div',
          { class: 'share-row' },
          field,
          // The mark alone: the link is copied on arrival, so this button is the
          // second chance rather than the way through, and a word beside the box
          // reads as the instruction — press me — that it no longer is. The
          // title is its accessible name, which `iconButton` also sets as
          // `aria-label`, so nothing is lost by dropping the word.
          iconButton('clipboard-copy', 'Copy the link', () => void copy(), {
            class: 'btn btn-icon',
            size: 15,
          }),
        ),
        advice,
        shortRow,
        note,
      ),
  })

  void (async () => {
    const payload = await encodeShare(props.config)
    link = shareUrl(props.base, payload)
    field.textContent = link
    selectLink()
    // Started, not waited on. `copyOnArrival` cannot reject — it swallows the
    // one failure it has — but it can be *slow*, and a browser taking its time
    // over a clipboard permission must not hold back the length advice and the
    // shortener offer below, which are the rest of this dialog.
    void copyOnArrival()

    const long = lengthAdvice(link.length)
    if (long !== null) advice.textContent = long

    if (shortenable(props.config)) {
      const short = button(`shorten with ${SHORTENER.name}`, () => {}, { class: 'btn' })
      short.addEventListener('click', () => void shortenIt(short))
      shortRow.append(
        short,
        el('span', {
          class: 'hint',
          text: `sends the link — including the address of the file — to ${SHORTENER.name}`,
        }),
      )
    } else {
      shortRow.append(
        icon('info', { size: 14 }),
        el('span', {
          class: 'hint',
          text:
            'This tab is over a local file, so it is not offered to a shortener: the ' +
            'recipient gets the tracks and the marks and is asked for the file, and sending a ' +
            'filename to a third party would buy nothing.',
        }),
      )
    }
  })()

  return modal
}
