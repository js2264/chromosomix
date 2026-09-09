/**
 * Choosing the grid a `.pairs` file is binned onto.
 *
 * ## Why this dialog exists at all
 *
 * It is the only one of its kind in the application, and that is a fact about
 * the format rather than about the design. Every other container *states* its
 * resolutions: a cooler has one, an `.mcool` and an `.mmetacool` list theirs, a
 * `.hic` carries a ladder. A `.pairs` is a list of contacts and has none — the
 * grid is a choice, and there is no map to show until somebody makes it.
 *
 * So the shape is: refuse the open, ask, open again. That is the same two-step
 * an `.mcool` addressed at its root already takes (§3.4) — the difference is
 * only that a collection's answer is in the file and this one is not.
 *
 * ## What the dialog is responsible for
 *
 * Making the choice a *decision* rather than a guess. Three things do that:
 *
 * - the **suggested base** is computed from the file's own numbers, so the box
 *   opens on a defensible value (`pairs/import.ts`);
 * - the **cost** of the current choice is shown and updates as it is typed —
 *   bin count, an upper bound on stored pixels, and what that would occupy.
 *   The bound is honest: `nnz` cannot be known without binning, and what *is*
 *   knowable is that it is at most the record count and at most the cells in
 *   the upper triangle;
 * - the **ladder** is previewed as the actual bin sizes, because "5 rungs" is
 *   not a thing anybody has an intuition about and `1, 2, 5, 10, 20 kb` is.
 *
 * ## The download switch
 *
 * On by default, and the reason is that the import is the expensive step: the
 * file has been read, the ladder is in memory, and writing it out is seconds
 * against minutes. A reader who has just waited for a big import and *then*
 * discovers the `.mcool` was an extra button is a reader who waits twice. It is
 * still a switch, because a reader looking at somebody else's file may not want
 * a copy of it in their downloads folder.
 */

import { el } from './dom'
import { Modal } from './Modal'
import { formatBp, roundToSeries } from '../pairs/import'
import { ladderSizes, MAX_LADDER_RUNGS } from '../pairs/ladder'
import type { PairsBinning, PairsProbeResult } from '../worker/protocol'

/** Bytes a stored pixel occupies in the imported table. */
const BYTES_PER_PIXEL = 12

export interface PairsDialogProps {
  probe: PairsProbeResult
  fileLabel: string
  /** Chosen and confirmed. The dialog has already closed. */
  onConfirm(binning: PairsBinning): void
  /** Dismissed without choosing, so the open is abandoned. */
  onCancel(): void
}

export function openPairsDialog(props: PairsDialogProps): Modal {
  let confirmed = false
  const modal = new Modal({
    title: `Bin ${props.fileLabel}`,
    body: (close) =>
      dialogBody(props, (binning) => {
        confirmed = true
        close()
        props.onConfirm(binning)
      }),
    onClose: () => {
      // Dismissal is a real answer — there is no map behind this dialog, so
      // closing it has to unwind the open rather than reveal something.
      if (!confirmed) props.onCancel()
    },
  })
  return modal
}

function dialogBody(props: PairsDialogProps, done: (binning: PairsBinning) => void): HTMLElement {
  const { probe } = props

  const baseInput = el('input', {
    class: 'pairs-base',
    type: 'number',
    value: String(probe.suggestedBase),
    attrs: { min: '1', step: '1', 'aria-label': 'Base resolution in base pairs' },
  })
  const rungsInput = el('input', {
    class: 'pairs-rungs',
    type: 'number',
    value: String(Math.min(5, MAX_LADDER_RUNGS)),
    attrs: { min: '1', max: String(MAX_LADDER_RUNGS), step: '1', 'aria-label': 'Ladder rungs' },
  })
  const downloadInput = el('input', { type: 'checkbox', attrs: { checked: '' } })

  const ladderNote = el('p', { class: 'hint pairs-ladder' })
  const costNote = el('p', { class: 'hint pairs-cost' })
  const warning = el('p', { class: 'hint pairs-warning' })

  const start = el('button', { class: 'btn btn-primary', text: 'Build the map' })

  const currentBase = (): number => {
    const typed = Number(baseInput.value)
    return Number.isFinite(typed) && typed >= 1 ? Math.floor(typed) : probe.suggestedBase
  }
  const currentRungs = (): number => {
    const typed = Number(rungsInput.value)
    if (!Number.isFinite(typed)) return 1
    return Math.max(1, Math.min(MAX_LADDER_RUNGS, Math.floor(typed)))
  }

  const refresh = (): void => {
    const base = currentBase()
    const sizes = ladderSizes(base, currentRungs())
    ladderNote.textContent = `Ladder: ${sizes.map(formatBp).join(', ')}.`

    const nBins = binCount(probe, base)
    const records = probe.records
    const cells = (nBins * (nBins + 1)) / 2
    const maxPixels = Math.min(records ?? cells, cells)
    costNote.textContent =
      `${nBins.toLocaleString()} bins at ${formatBp(base)}` +
      `${records === null ? '' : `, over ${records.toLocaleString()} records`}` +
      ` — at most ${maxPixels.toLocaleString()} stored pixels (${formatBytes(maxPixels * BYTES_PER_PIXEL)}).`

    // The one thing worth warning about before a long read: a grid so fine
    // that most pixels hold a single contact is a scatter plot of the file
    // rather than a contact map, and it is also the way to run out of memory.
    const singleton = records !== null && records > 0 && cells > records * 4
    warning.textContent = singleton
      ? 'At this resolution most bins would hold at most one contact. A coarser base gives a map rather than a scatter of the reads.'
      : ''
    warning.style.display = singleton ? '' : 'none'
    start.disabled = base < 1
  }

  baseInput.addEventListener('input', refresh)
  rungsInput.addEventListener('input', refresh)
  // Typing a bin size and pressing Enter is the whole interaction; making that
  // work is the difference between a dialog and a form.
  for (const input of [baseInput, rungsInput]) {
    input.addEventListener('keydown', (event) => {
      if ((event as KeyboardEvent).key === 'Enter') {
        event.preventDefault()
        submit()
      }
    })
  }
  // Snap to the 1-2-5 series when the box loses focus: a reader who types
  // `1500` meant a round number, and the ladder above is built on round ones.
  baseInput.addEventListener('blur', () => {
    const snapped = roundToSeries(currentBase())
    if (snapped !== currentBase()) baseInput.value = String(snapped)
    refresh()
  })

  function submit(): void {
    done({
      base: currentBase(),
      rungs: currentRungs(),
      oneBased: true,
      download: downloadInput.checked,
    })
  }
  start.addEventListener('click', submit)

  refresh()

  return el(
    'div',
    { class: 'modal-body pairs-body' },
    el('p', {
      class: 'hint',
      text:
        'A .pairs file lists individual contacts and has no resolution of its own, so a grid ' +
        'has to be chosen. The file is read once; every rung of the ladder is built from that ' +
        'one pass and served from memory afterwards.',
    }),
    summaryLine(probe),
    el(
      'div',
      { class: 'pairs-fields' },
      el(
        'label',
        { class: 'field field-block' },
        el('span', { class: 'field-label', text: 'Base resolution (bp)' }),
        baseInput,
      ),
      el(
        'label',
        { class: 'field field-block' },
        el('span', { class: 'field-label', text: 'Ladder rungs' }),
        rungsInput,
      ),
    ),
    ladderNote,
    costNote,
    warning,
    el(
      'label',
      { class: 'checkbox pairs-download' },
      downloadInput,
      el('span', { text: 'Download the .mcool when it is ready' }),
    ),
    el('div', { class: 'pairs-actions' }, start),
  )
}

/** One line about the file, so the numbers below have something to refer to. */
function summaryLine(probe: PairsProbeResult): HTMLElement {
  const parts = [
    `${probe.contigs.length.toLocaleString()} ${probe.contigs.length === 1 ? 'sequence' : 'sequences'}`,
    `${formatBp(probe.genomeLength)} total`,
  ]
  if (probe.assembly !== null) parts.push(probe.assembly)
  parts.push(
    probe.indexed
      ? `indexed — ${(probe.records ?? 0).toLocaleString()} records`
      : 'no .px2 index, so the whole file is read',
  )
  return el('p', { class: 'hint pairs-summary', text: `${parts.join(' · ')}.` })
}

/** Bins the declared contigs occupy at `binSize`. */
function binCount(probe: PairsProbeResult, binSize: number): number {
  let total = 0
  for (const contig of probe.contigs) total += Math.ceil(contig.length / binSize)
  return total
}

/** `134217728` → `128 MB`. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${Math.round(bytes)} B`
  const units = ['kB', 'MB', 'GB', 'TB']
  let value = bytes / 1024
  let at = 0
  while (value >= 1024 && at < units.length - 1) {
    value /= 1024
    at++
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[at]}`
}
