/**
 * Refusals, rendered (spec §10).
 *
 * Every refusal names the file's actual state and the concrete fix. The reader
 * writes the sentence — it knows the actual value — and this view supplies the
 * heading, the "what to do" guidance and, where one exists, the action that
 * resolves it. Switching on `code` rather than pattern-matching the prose is
 * what makes each refusal read specifically instead of all of them reading like
 * "could not open file".
 *
 * The `__unbinned__` case matters more than its size suggests: it is
 * deliberately *not* the unknown-label error, so a user who types
 * `__unbinned__` learns that unassigned contigs are not a genome rather than
 * doubting a name they read in the file.
 */

import { ViewerError, type ErrorCode } from '../errors'
import { button, el } from './dom'

export interface ErrorViewProps {
  error: unknown
  /** Offered on every screen: go back to the picker. */
  onOpenFilePicker(): void
  /** Offered when the error names entries of a collection. */
  onOpenEntry?(entry: string): void
  /** Offered when the failed action can simply be retried. */
  onRetry?(): void
}

interface Guidance {
  title: string
  advice: string[]
}

const GUIDANCE: Record<ErrorCode, Guidance> = {
  'not-hdf5': {
    title: 'This is not an HDF5 file',
    advice: [
      'The first bytes are not an HDF5 signature, so it is not a cooler, a metacool or an mcool.',
      'If it is compressed (.gz, .zip), decompress it first — HDF5 is read in place and cannot be decompressed on the fly.',
    ],
  },
  'not-a-cooler': {
    title: 'HDF5, but not a cooler or metacool',
    advice: [
      'The file opened as HDF5 but carries neither a cooler nor a metacooler format attribute.',
      'Check you picked the right file; `metacooler attrs <file>` prints what is actually there.',
    ],
  },
  'mmetacool-root': {
    title: 'This is a collection, not a single map',
    advice: [
      'An .mmetacool holds complete metacool entries and is not itself a cooler, so it cannot be opened at its root.',
      'Address one entry with the :: syntax, e.g. file.mmetacool::entries/<name>.',
    ],
  },
  'mcool-root': {
    title: 'This is a resolution ladder, not a single map',
    advice: [
      'An .mcool holds one complete cooler per resolution and is not itself a cooler, so it cannot be opened at its root.',
      'Pick a resolution with the :: syntax, e.g. file.mcool::resolutions/1000 — or just drop the file again and the finest one opens.',
    ],
  },
  'entry-not-found': {
    title: 'No such entry in this collection',
    advice: ['Pick one of the entries listed below, or drop the :: suffix to see them all.'],
  },
  'bad-format-version': {
    title: 'Unsupported format version',
    advice: [
      'This viewer implements metacooler format version 1.',
      'Re-create the file with a matching metacooler release, or use a viewer build that matches the file.',
    ],
  },
  'bad-ordering': {
    title: 'Contigs are not grouped by genome',
    advice: [
      'The viewer requires contig-ordering = genome-then-length, because that is what makes each genome one contiguous bin range — every view depends on it.',
      'Re-create the file with the default ordering: `metacooler create ... --contig-order genome-then-length`.',
      'Files built from a cooler (cool ordering) or from a FASTA-ordered assembly land here; this is a known and deliberate exclusion.',
    ],
  },
  'variable-bins': {
    title: 'Variable-bin file',
    advice: [
      'This viewer supports fixed-bin files only. Fragment-level and contig-level metacools have variable bins and are refused.',
      'Produce a fixed-bin file with `metacooler binnify <file> --binsize <bp>` and open that.',
    ],
  },
  'unbinned-not-displayable': {
    title: 'Unassigned contigs are not a genome',
    advice: [
      '__unbinned__ holds every contig binning failed to assign. It is a bookkeeping row, not an organism, and there is nothing coherent to display for it.',
      'Its size is reported once, as a QC statistic, in the file info panel.',
    ],
  },
  'dense-too-large': {
    title: 'Selection too large to draw',
    advice: [
      'The requested block would need more memory than a browser tab can be asked for.',
      'Switch to contig level, narrow the range, or open a coarser resolution.',
    ],
  },
  'unknown-label': {
    title: 'Unknown genome or contig',
    advice: [
      'The label before the colon matched neither a genome nor a contig in this file.',
      'Genome and contig namespaces can collide; when they do, the genome wins.',
    ],
  },
  'bad-range': {
    title: 'That range does not parse',
    advice: [
      'Coordinates use cooler syntax: contig, or contig:start-end with optional thousands separators and k/M/G units.',
      'The end must not be before the start, and neither may fall outside the contig.',
    ],
  },
  unsupported: {
    title: 'Not available in the viewer',
    advice: [
      'This operation exists in the metacooler CLI but not here, because the browser reader deliberately never reads the table it would need.',
      'Run the equivalent `metacooler` command locally.',
    ],
  },
  'genome-coordinate-suffix': {
    title: 'Genome ranges are whole-genome',
    advice: [
      'A genome is a set of contigs, so a base-pair interval on it is not well defined.',
      'Use the genome name alone, or address one of its contigs with contig:start-end.',
    ],
  },
  'bigwig-no-overlap': {
    title: 'This bigWig names different sequences',
    advice: [
      'bigWig files are keyed on chromosome names, which here are contig names from /contigs — not genome names.',
      'Check the track was made against the same assembly as this map.',
    ],
  },
  'remote-no-ranges': {
    title: 'That host does not serve byte ranges',
    advice: [
      'The viewer reads a few kilobytes at a time; without Accept-Ranges: bytes it would have to download the whole file.',
      'Host the file on object storage with range support (any S3-compatible bucket), or download it and drop it here instead.',
    ],
  },
  'remote-cors': {
    title: 'That host will not let this page read the file',
    advice: [
      'Cross-origin GET and HEAD must be allowed, and Content-Length and Content-Range must be exposed.',
      'GEO and SRA cannot be used as hosts: they serve downloads as attachments, without range or CORS support.',
      'Downloading the file and dropping it here always works.',
    ],
  },
  'remote-too-large': {
    title: 'Too much to download for this operation',
    advice: [
      'This action reads every pixel, which over the network means fetching the whole file.',
      'Run it on a local copy, or publish a genome edge list beside the file (`metacooler network --level genome --header`).',
    ],
  },
  'bad-uri': {
    title: 'That URI does not parse',
    advice: ['Expected file, or file::group — for example file.mmetacool::entries/rep1.'],
  },
  format: {
    title: 'This file does not match the format',
    advice: ['`metacooler check <file>` reports what is wrong without raising.'],
  },
}

export class ErrorView {
  readonly el: HTMLElement

  constructor(props: ErrorViewProps) {
    const error = props.error
    const viewerError = error instanceof ViewerError ? error : null
    const guidance =
      viewerError === null
        ? { title: 'Something went wrong', advice: ['This is not one of the format refusals; the message below is the underlying failure.'] }
        : GUIDANCE[viewerError.code]

    const entries = extractEntries(viewerError)
    const actions: HTMLElement[] = []
    if (entries.length > 0 && props.onOpenEntry) {
      const open = props.onOpenEntry
      actions.push(
        el('div', { class: 'entry-list' }, ...entries.map((entry) => button(entry, () => open(entry)))),
      )
    }
    if (props.onRetry) actions.push(button('try again', props.onRetry))
    actions.push(button('open another file', props.onOpenFilePicker, { class: 'btn btn-quiet' }))

    this.el = el(
      'section',
      { class: 'view view-error' },
      el('h2', { class: 'error-title', text: guidance.title }),
      el('p', { class: 'error-message', text: error instanceof Error ? error.message : String(error) }),
      el('ul', { class: 'advice' }, ...guidance.advice.map((line) => el('li', { text: line }))),
      detailBlock(viewerError),
      el('div', { class: 'error-actions' }, ...actions),
    )
  }
}

/** Entry names carried on the error, so the UI can offer them as buttons. */
function extractEntries(error: ViewerError | null): string[] {
  if (error === null) return []
  const entries = error.detail['entries']
  if (!Array.isArray(entries)) return []
  return entries.filter((entry): entry is string => typeof entry === 'string')
}

function detailBlock(error: ViewerError | null): HTMLElement | null {
  if (error === null || Object.keys(error.detail).length === 0) return null
  return el(
    'details',
    { class: 'meta' },
    el('summary', { text: 'What the file actually says' }),
    el('pre', { class: 'json', text: JSON.stringify(error.detail, null, 2) }),
  )
}
