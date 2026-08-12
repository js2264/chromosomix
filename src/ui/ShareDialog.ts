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
 */

import { Modal } from './Modal'
import { button, el } from './dom'
import { icon } from './icons'
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
}

export function openShareDialog(props: ShareDialogProps): Modal {
  const field = el('input', { class: 'share-link', type: 'text' }) as HTMLInputElement
  field.readOnly = true
  field.value = 'preparing…'

  const note = el('p', { class: 'hint' })
  const advice = el('p', { class: 'hint' })
  const shortRow = el('div', { class: 'share-row' })

  let link = ''

  const say = (message: string, kind: 'ok' | 'warn' = 'ok'): void => {
    note.textContent = message
    note.classList.toggle('warn', kind === 'warn')
  }

  const copy = async (): Promise<void> => {
    if (link === '') return
    try {
      await navigator.clipboard.writeText(link)
      say('Copied.')
    } catch {
      // Clipboard access is refused on an insecure origin and in some
      // embeddings, and the field is right there — so the fallback is to select
      // it and say so, rather than to report a failure the reader can trivially
      // work around.
      field.select()
      say('Select-and-copy: this browser did not allow the clipboard to be written.')
    }
  }

  const shortenIt = async (target: HTMLButtonElement): Promise<void> => {
    target.disabled = true
    const previous = target.textContent
    target.textContent = 'shortening…'
    try {
      const short = await shorten(link)
      link = short
      field.value = short
      advice.textContent = ''
      say(`Shortened by ${SHORTENER.name}. The long link still works if you kept it.`)
      target.remove()
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
    title: 'Share this session',
    body: () =>
      el(
        'div',
        { class: 'share-body' },
        el('p', {
          class: 'hint',
          text:
            'Everything in this tab — the view, the tracks and their colours, the marks and the ' +
            'bookmarks — encoded into the link itself. No server holds it, so it cannot expire ' +
            'and nothing about it reaches the site serving this page.',
        }),
        el('div', { class: 'share-row' }, field, button('copy', () => void copy(), { class: 'btn' })),
        advice,
        shortRow,
        note,
      ),
  })

  void (async () => {
    const payload = await encodeShare(props.config)
    link = shareUrl(props.base, payload)
    field.value = link
    field.select()

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
            'This session is over a local file, so it is not offered to a shortener: the ' +
            'recipient gets the tracks and the marks and is asked for the file, and sending a ' +
            'filename to a third party would buy nothing.',
        }),
      )
    }
  })()

  return modal
}
