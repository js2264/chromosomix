/**
 * The questions this application asks before it reads (spec §12).
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
 *
 * ## The second gate, and why it is one module with the first
 *
 * A HiC-Pro pair (§3.9) has no index either, and for a blunter reason: it is
 * two text files. So its whole matrix is read and parsed before anything can be
 * drawn, and past a couple of hundred megabytes that is a wait worth stating.
 *
 * The two gates are the same *shape* — a refusal carrying the numbers, thrown
 * where the cost is about to be paid, caught by the shell, answered, and the
 * open re-issued with the answer on the source — and they differ in exactly two
 * ways, which is why they share this module rather than duplicating it:
 *
 * - an `.scool` offers **two** readings and a HiC-Pro pair **one**, because
 *   there is nothing to trade: it is read whole or not at all;
 * - an `.scool`'s cost is round trips, so a local file never pays it and is
 *   never asked; a HiC-Pro pair's is parsing and memory, which a local file
 *   pays in full — a gigabyte off a disk is the same ten seconds and the same
 *   gigabyte of typed arrays as a gigabyte off a bucket.
 */

import { ViewerError } from '../errors'
import { plotAnswers } from '../plot/answers'
import { button, el, fmt } from './dom'
import { Modal } from './Modal'

/** What the reader chose, or `null` when they closed the dialog. */
export type ScoolReading = 'whole' | 'fine' | null

/**
 * `true` when this error is a §12 load gate rather than a failure.
 *
 * The shell asks before treating an open's rejection as an error screen, in
 * exactly the way it already asks whether a rejection was an mmetacool root —
 * all of them are refusals that mean *ask the reader something*, not *this file
 * is broken*.
 */
export function isLoadGate(error: unknown): error is ViewerError {
  return (
    error instanceof ViewerError &&
    (error.code === 'scool-listing-cost' || error.code === 'hicpro-load-cost')
  )
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
export function askLoadCost(error: ViewerError, label: string): Promise<ScoolReading> {
  // A program driving the page answers for itself (§27): a HiC-Pro pair has one
  // reading, and an `.scool` the one its command chose (`plot/answers.ts`).
  const answers = plotAnswers()
  if (answers !== null) {
    return Promise.resolve(error.code === 'hicpro-load-cost' ? 'whole' : answers.scool)
  }
  if (error.code === 'hicpro-load-cost') return askHicProLoad(error)
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
              'records that the writer interleaved with the cells’ own data, so reading that ' +
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

/**
 * The HiC-Pro disclosure: what the read costs, and one button.
 *
 * Not a choice, because there is not one — the format has no index, so there is
 * no cheaper way to reach the first pixel and nothing to weigh against anything
 * else. What the panel is *for* is that a reader who clicks and then waits ten
 * seconds should have been told it would be ten seconds, and should know the
 * wait is once rather than per view. So it says both, and the second is the
 * part that turns a bad number into an acceptable one.
 */
function askHicProLoad(error: ViewerError): Promise<ScoolReading> {
  return new Promise((resolve) => {
    let answered: ScoolReading = null
    new Modal({
      title: 'This contact map has to be read whole first',
      variant: 'modal-wide',
      onClose: () => resolve(answered),
      body: (close) => {
        const bytes = numberIn(error, 'bytes')
        const go = button(`read all ${fmt.bytes(bytes)}`, () => {
          answered = 'whole'
          close()
        }, { class: 'btn btn-primary' })
        go.title =
          'Parse the matrix into memory. Every region, every zoom and every analysis ' +
          'afterwards is instant and costs no further reading.'

        return el(
          'div',
          { class: 'about-body scool-gate' },
          el('p', { text: error.message }),
          el('p', {
            text:
              'A HiC-Pro matrix is a list of pixels as text, with nothing to say where in ' +
              'the file any of them is — so unlike every other format here, a region cannot ' +
              'be reached without reading everything before it. It is read once, at about ' +
              '100 MB a second, and then behaves exactly like a cooler.',
          }),
          el('div', { class: 'modal-actions' }, go),
          el('p', {
            class: 'hint',
            text:
              'A finer resolution than this is better converted: cooler load -f coo turns the ' +
              'same two files into a .cool, which opens here in a few requests however large ' +
              'it is.',
          }),
        )
      },
    })
  })
}

/** A number the refusal recorded, or `0` where it did not. */
function numberIn(error: ViewerError, key: string): number {
  const value = error.detail[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}
