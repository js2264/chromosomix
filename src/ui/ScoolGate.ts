/**
 * The one question this application asks before it reads (spec §12, §3.7).
 *
 * Everything else here is a bounded read, and where a read *is* expensive — the
 * whole-metagenome scan, the whole-file view — the gate asks about a cost the
 * reader could in principle have foreseen from the file's own numbers. This one
 * is different, and it is worth being explicit about why, because the answer is
 * a property of HDF5 rather than of this format or this viewer.
 *
 * A single-cell container is one cooler per cell. The cells' *names* live in the
 * container group's link storage, and HDF5 allocates that storage as members are
 * added — which, for every writer that exists, is immediately after writing that
 * cell's pixels. The result is that the index of a file is interleaved with its
 * data rather than gathered anywhere. Measured on the 3,882-cell Nagano 2017
 * file: listing the cells is 1,015 reads averaging 512 bytes, spread uniformly
 * across all 327 MB. It is not a property of that writer — a container written
 * by `cooler.create_scool` behaves the same way.
 *
 * So there is no chunk size that wins. The reads are ~500 bytes about 320 KB
 * apart, so any chunk large enough to coalesce them is large enough to fetch the
 * file, and any chunk small enough to avoid that needs a round trip each. The
 * two ends of that trade are the two buttons below, with the numbers on them:
 *
 * - **download it once** — one request, the whole object, then every cell view
 *   and every sum afterwards is a memory read with no network at all;
 * - **read it in pieces** — a few percent of the bytes, and about a thousand
 *   sequential requests, which is minutes rather than seconds.
 *
 * The third way out is the honest one and it is said on the panel rather than
 * hidden: a copy on the reader's own disk has neither cost, because a local file
 * is read in place.
 */

import { ViewerError } from '../errors'
import { button, el, fmt } from './dom'
import { Modal } from './Modal'

/** What the reader chose, or `null` when they closed the dialog. */
export type ScoolReading = 'whole' | 'fine' | null

/**
 * `true` when this error is the §12 listing gate rather than a failure.
 *
 * The shell asks before treating an open's rejection as an error screen, in
 * exactly the way it already asks whether a rejection was an mmetacool root —
 * both are refusals that mean *ask the reader something*, not *this file is
 * broken*.
 */
export function isListingGate(error: unknown): error is ViewerError {
  return error instanceof ViewerError && error.code === 'scool-listing-cost'
}

/** The object's size, as the gate's refusal recorded it. */
function sizeOf(error: ViewerError): number {
  const size = error.detail['size']
  return typeof size === 'number' && Number.isFinite(size) ? size : 0
}

/**
 * Put the choice on screen and resolve with it.
 *
 * Resolves `null` when the reader dismissed the panel, which is a real answer —
 * *neither*, I will fetch it myself — and the caller shows the file picker
 * again rather than starting a read nobody agreed to.
 */
export function askScoolReading(error: ViewerError, label: string): Promise<ScoolReading> {
  return new Promise((resolve) => {
    let answered: ScoolReading = null
    new Modal({
      title: 'How should this single-cell file be read?',
      variant: 'modal-wide',
      onClose: () => resolve(answered),
      body: (close) => {
        const size = sizeOf(error)
        const choose = (reading: Exclude<ScoolReading, null>) => () => {
          answered = reading
          close()
        }

        const whole = button(`download all ${fmt.bytes(size)} once`, choose('whole'), {
          class: 'btn btn-primary',
        })
        whole.title =
          'One request for the whole object. Everything afterwards — every cell, every sum, ' +
          'every region — is read from memory with no further network.'

        const fine = button('read it in small pieces', choose('fine'), { class: 'btn' })
        fine.title =
          'About a thousand small range requests instead. Far fewer bytes, but they are ' +
          'sequential, so expect minutes rather than seconds before the cells appear.'

        return el(
          'div',
          { class: 'about-body scool-gate' },
          el('p', {
            text:
              `${label} is a single-cell container. Its cells are listed from HDF5 link ` +
              'records that the writer interleaved with the cells own data, so reading that ' +
              'list means about a thousand small reads spread across the entire file — the ' +
              'one open in this viewer that is not a bounded read.',
          }),
          el('p', {
            text:
              'There is no chunk size that avoids both costs: the reads are around 500 bytes ' +
              'and roughly 320 KB apart, so anything large enough to coalesce them fetches ' +
              'the file anyway.',
          }),
          el('div', { class: 'modal-actions' }, whole, fine),
          el('p', {
            class: 'hint',
            text:
              'Neither cost applies to a copy on your own disk: a local file is read in ' +
              'place, so downloading it yourself and dropping it here is the third way out — ' +
              'and the one to prefer if you will open this file more than once.',
          }),
        )
      },
    })
  })
}
