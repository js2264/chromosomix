/**
 * The contact maps this session is holding: one, or two, or none on screen.
 *
 * It lives at the top of the Annotations column rather than in General, and the
 * placement is the argument: everything in that column is *something laid over
 * this genome*, and a contact matrix is the largest thing anyone can lay over
 * one. General describes the file; this is a thing you do with it.
 *
 * Which is also why each map wears the same **eye** a track's row wears. Hiding
 * the first one is what the 1D genome browser *is* — the same tracks, the same
 * store, the same window, with the matrix taken out of the picture — and the
 * map stays open behind it, so the trip back costs nothing but the eye again.
 * Two controls for two different acts, on the same row: the eye puts a map down
 * and the × lets go of it.
 *
 * The card is also the whole of the comparison's interface. What it refuses, it
 * refuses here with the reason — same contigs, same bin size, cooler only — and
 * what it accepts it reports in one line. The map does the rest.
 */

import { alignNames, type Alignment, type NamedSequence } from '../genome/naming'

import { button, el, fmt } from './dom'
import { cardTitle, iconButton } from './icons'
import { bucketBrowseButton } from './browseButton'
import type { OpenResult } from '../worker/protocol'
import { fileLabel } from './labels'

/** What the card is showing right now. */
export type CompareState =
  | { kind: 'empty' }
  | { kind: 'loading'; label: string }
  | { kind: 'error'; label: string; message: string }
  | { kind: 'open'; label: string; info: OpenResult }

export interface CompareCardProps {
  /** A file was dropped or a URL typed. */
  onOpen(source: { kind: 'local'; file: File } | { kind: 'remote'; url: string }): void
  /**
   * Take the matrix out of the picture, or put it back — the eye on a row.
   *
   * `1` is this session's own map, and hiding it *is* the 1D browser; `2` is the
   * second file, whose eye takes the lower-left triangle away and leaves the
   * upper one, which is the same map on its own.
   */
  onToggleShown(which: 1 | 2): void
  /** Whether each map is currently drawn. */
  isShown(which: 1 | 2): boolean
  /**
   * Put one of the two down and go back to a single map.
   *
   * Either one: closing the second leaves the first as it was, and closing the
   * first opens the second on its own — which is what a × beside a name has to
   * mean when there are two names, and is the same pair of actions the two File
   * cards in General already offer.
   */
  onClose(which: 1 | 2): void
  /** Swap which file is above the diagonal. */
  onSwap(): void
  /** What to call the map already open — the reader's name for it, or its file's. */
  primaryLabel(): string
  /**
   * What to call the second map. `undefined` before there is one.
   *
   * Asked of the session rather than taken from {@link CompareState}, which
   * carries the file's own label: a map can be renamed, and the names belong to
   * the session that is holding the maps (`ui/mapNames.ts`).
   */
  secondLabel?(): string | undefined
  /**
   * The reader typed a name into one of the two rows, or emptied the box.
   *
   * `null` is the empty box, which hands the map back to its file name — the
   * same rule that makes renaming a tab or a track undoable.
   */
  onRename?(which: 1 | 2, name: string | null): void
  /**
   * Whether there is a map open at all.
   *
   * `false` is a 1D browser that was started from a track, where this card is
   * the *first* slot rather than the second — no rows, and a drop area that
   * asks for a contact map rather than for one to compare against. It is here
   * for the same reason it is here with a map open: the column that lists what
   * is drawn over this genome is where a reader goes to add something to it.
   */
  hasPrimary(): boolean
}

export class CompareCard {
  readonly el: HTMLElement
  private readonly body = el('div', { class: 'ann-list compare-body' })
  private readonly slots: [DropSlot, DropSlot]
  private state: CompareState = { kind: 'empty' }

  constructor(private readonly props: CompareCardProps) {
    // One zone per slot, built once and reworded per render: which map a
    // rectangle asks for is a fact about the session that changes under it, and
    // rebuilding the element per frame would drop a drag in progress.
    this.slots = [this.dropSlot(), this.dropSlot()]
    this.el = el(
      'div',
      { class: 'card compare-card' },
      cardTitle('Contact maps', 'grid-2x2'),
      this.body,
      el(
        'details',
        { class: 'ann-url' },
        el('summary', { text: 'or open one by URL' }),
        el(
          'div',
          { class: 'ann-url-row' },
          this.urlInput,
          button('add', () => this.openUrl(), { class: 'btn' }),
          bucketBrowseButton((url) => this.props.onOpen({ kind: 'remote', url })),
        ),
      ),
    )
    this.render()
  }

  set(state: CompareState): void {
    this.state = state
    this.render()
  }

  /**
   * Redraw from what the session says now, without changing what is loaded.
   *
   * The eyes read the session rather than this card — which map is on screen is
   * a fact about the session and about nothing else — so the card has to be told
   * when that changes. `set` is for the *second file*'s own state and would
   * throw the loading and error phases away if it were used for this.
   */
  sync(): void {
    this.render()
  }

  private readonly urlInput = el('input', {
    class: 'input',
    type: 'url',
    placeholder: 'https://bucket.example.org/other.cool',
  })

  private openUrl(): void {
    const url = this.urlInput.value.trim()
    if (url !== '') this.props.onOpen({ kind: 'remote', url })
  }

  /**
   * Two slots, each either a map or a rectangle to put one on.
   *
   * The Tracks card's shape, to the class: a list of `.ann-row`s over a
   * `.ann-drop`, with the URL behind a fold underneath. The two cards ask the
   * same thing of a reader — *put a file here*, then *here is what is in* — and
   * a card that answered it in its own vocabulary was a second application in
   * the same column. It is also what makes the controls on a row look like the
   * controls on a track's row, since the rules that take the borders off them
   * are written against `.ann-row.ann-ready`.
   */
  private render(): void {
    const paired = this.state.kind === 'open'
    const first = this.props.hasPrimary()
    this.slots[0].label.textContent = 'Load a contact map'
    this.slots[0].hint.textContent =
      'A .cool or .mcool on this genome. Click to choose, or drop one here — the tracks come ' +
      'with it, drawn beside the map instead of along the axis.'
    this.slots[1].label.textContent = 'Load a second map'
    this.slots[1].hint.textContent =
      'A cooler with the same chromosomes and the same bin size. Click to choose, or drop one ' +
      'here — it fills the lower-left triangle, so the square stops being symmetric and the two ' +
      'are read against each other in one picture.'

    const top = first
      ? this.mapRow(1, this.props.primaryLabel(), paired)
      : this.slots[0].zone
    const bottom =
      this.state.kind === 'open'
        ? this.mapRow(2, this.props.secondLabel?.() ?? this.state.label, true)
        : this.state.kind === 'loading'
          ? this.pendingRow('loading', `Opening ${this.state.label}…`)
          : this.state.kind === 'error'
            ? this.pendingRow('error', this.state.message)
            : this.slots[1].zone
    this.body.replaceChildren(top, bottom)
  }

  /**
   * One map: which triangle it is in, what it is called, and the two things a
   * reader does to it.
   *
   * The same three-part head a track's row has, in the same order — a mark, a
   * name, then the eye and the ×. That is not imitation for its own sake: a map
   * and a track are both things drawn over this genome, and a reader who has
   * learned that the eye takes one out of the picture has learned it for both.
   *
   * The triangle marks appear only when there are two files, because with one
   * there is no diagonal to be on a side of.
   */
  private mapRow(which: 1 | 2, label: string, paired: boolean): HTMLElement {
    const shown = this.props.isShown(which)
    const eye = iconButton(
      shown ? 'eye' : 'eye-off',
      which === 1
        ? shown
          ? 'Hide the map and read this genome as tracks. It stays open — the eye brings it back.'
          : 'Draw the map again, where it was left'
        : shown
          ? 'Take the lower-left triangle out of the picture, keeping the file open'
          : 'Draw the second map again',
      () => this.props.onToggleShown(which),
      { class: `btn btn-icon ann-eye${shown ? '' : ' is-off'}`, size: 14 },
    )
    eye.setAttribute('aria-pressed', String(shown))
    return el(
      'div',
      { class: 'ann-row ann-ready compare-row' },
      el(
        'div',
        { class: 'ann-head' },
        ...(paired
          ? [
              el('span', {
                class: `compare-mark ${which === 1 ? 'compare-upper' : 'compare-lower'}`,
                text: which === 1 ? '◥' : '◣',
              }),
            ]
          : []),
        this.name(which, label, paired),
        eye,
        iconButton(
          'x',
          paired
            ? which === 1
              ? `Close ${label} and keep the other map on its own`
              : `Close ${label} and go back to one map`
            : `Close ${label} and keep browsing its genome as tracks`,
          () => this.props.onClose(which),
          { class: 'btn-close', size: 14 },
        ),
      ),
      ...(paired && which === 2 && this.state.kind === 'open'
        ? [
            el('p', {
              class: 'ann-note',
              text:
                `${fmt.int(this.state.info.nContigs)} chromosomes · ` +
                `${fmt.int(this.state.info.binsize ?? 0)} bp bins · ` +
                `${fmt.bytes(this.state.info.sourceBytes)}`,
            }),
            button('swap sides', () => this.props.onSwap(), {
              class: 'btn btn-quiet btn-wide',
              title:
                'Put the other file above the diagonal. The comparison is the same; which map ' +
                'the eye reads first is not.',
            }),
          ]
        : []),
    )
  }

  /**
   * What a map is called, on this row and everywhere else it is named.
   *
   * The Tracks card's own control, to the class: an `<input>` that looks like
   * text until it has the caret, rather than a label that swaps itself for one.
   * The argument is the same argument, and it is stronger here — a file name is
   * a starting point rather than an answer, and two conditions being compared
   * are `mat_G1.mcool::1000` and `mat_G2M.mcool::1000`, whose two informative
   * characters are the last thing anybody reads.
   *
   * An empty box hands the map back to its file name, which is what makes the
   * rename undoable; a session with no rename offered ({@link
   * CompareCardProps.onRename} absent) keeps the plain text it always had.
   */
  private name(which: 1 | 2, label: string, paired: boolean): HTMLElement {
    const rename = this.props.onRename
    const where = paired
      ? which === 1
        ? 'Upper-right triangle, and the upper band of a turned pair'
        : 'Lower-left triangle, and the lower band of a turned pair'
      : label
    if (rename === undefined) {
      return el('span', { class: 'ann-name ann-name-static', text: label, title: where })
    }
    const input = el('input', {
      class: 'input ann-name',
      type: 'text',
      value: label,
      title: `${where} — click to rename`,
    })
    input.addEventListener('change', () => {
      const typed = input.value.trim()
      if (typed === label) {
        input.value = label
        return
      }
      rename(which, typed === '' ? null : typed)
    })
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault()
        input.blur()
      } else if (event.key === 'Escape') {
        event.preventDefault()
        input.value = label
        input.blur()
      }
    })
    return input
  }

  /** The second slot while its file is being read, or after it was refused. */
  private pendingRow(kind: 'loading' | 'error', message: string): HTMLElement {
    return el(
      'div',
      { class: `ann-row ann-${kind}` },
      el('p', {
        class: kind === 'error' ? 'inline-error ann-note' : 'ann-note',
        text: message,
      }),
      ...(kind === 'error'
        ? [
            button('try another file', () => this.set({ kind: 'empty' }), {
              class: 'btn btn-quiet',
            }),
          ]
        : []),
    )
  }

  /** A rectangle a map is dropped on, with its own file input. */
  private dropSlot(): DropSlot {
    const label = el('span', { class: 'ann-drop-label' })
    const hint = el('span', { class: 'ann-drop-hint' })
    const zone = el('div', { class: 'ann-drop', attrs: { tabindex: '0', role: 'button' } }, label, hint)
    const fileInput = el('input', { class: 'hidden-input', type: 'file' })
    fileInput.addEventListener('change', () => {
      const file = fileInput.files?.[0]
      if (file) this.props.onOpen({ kind: 'local', file })
    })
    zone.appendChild(fileInput)
    zone.addEventListener('click', (event) => {
      if (event.target !== fileInput) fileInput.click()
    })
    zone.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') fileInput.click()
    })
    zone.addEventListener('dragover', (event) => {
      event.preventDefault()
      zone.classList.add('over')
    })
    zone.addEventListener('dragleave', () => zone.classList.remove('over'))
    zone.addEventListener('drop', (event) => {
      event.preventDefault()
      zone.classList.remove('over')
      const file = event.dataTransfer?.files?.[0]
      if (file) this.props.onOpen({ kind: 'local', file })
    })
    return { zone, label, hint }
  }
}

/** A drop rectangle and the two lines written in it. */
interface DropSlot {
  zone: HTMLElement
  label: HTMLElement
  hint: HTMLElement
}


/**
 * Why these two files cannot be drawn in one square, or `null` when they can.
 *
 * Every clause is a way the picture would be a lie rather than a limitation of
 * the code, which is why each one names the thing that differs instead of
 * refusing generically:
 *
 * - **A genome layer.** A metacool's axis is contigs from thousands of
 *   independently assembled organisms, and two of them agree about a contig name
 *   by coincidence (§8.5's argument, applied to a whole matrix rather than to a
 *   track).
 * - **A different bin size.** The two triangles would be drawn at two
 *   resolutions in one grid, so a pixel would mean 1 kb on one side of the
 *   diagonal and 5 kb on the other.
 * - **Different chromosomes.** Every coordinate in the picture is an index into
 *   one list of sequences. Two lists means the lower triangle is a map of
 *   somewhere else, drawn under this one's labels.
 */
export function compareRefusal(
  primary: OpenResult,
  second: OpenResult,
  contigs: { primary: Array<[string, number]>; second: Array<[string, number]> },
): string | null {
  if (primary.hasGenomes || second.hasGenomes) {
    const which = primary.hasGenomes ? 'This file' : fileLabel(second.uri)
    return (
      `${which} has a genome layer, and a metacool is not compared this way (§8.5). Its axis is ` +
      'contigs from thousands of independently assembled organisms, so two such files agree ' +
      'about a contig name by coincidence rather than by construction.'
    )
  }
  if (primary.binsize !== second.binsize) {
    return (
      `Bin sizes differ: ${fmt.int(primary.binsize ?? 0)} bp against ` +
      `${fmt.int(second.binsize ?? 0)} bp. One grid cannot be two resolutions — open the ` +
      'matching resolution of the second file, if it has one.'
    )
  }
  const mismatch = firstContigMismatch(contigs.primary, contigs.second)
  if (mismatch !== null) return mismatch
  return null
}

/**
 * The first way two chromosome lists disagree, phrased for a reader.
 *
 * **A different spelling is not a disagreement** (§5.9). The two lists are
 * compared position by position, and where the names differ they are put to
 * {@link NameIndex} before the refusal is written: `chr1` against `1`, `chrXII`
 * against `12` and `chrM` against `MT` are the same assembly written by two
 * tools, and refusing to blend them was refusing the commonest pair of files
 * anybody actually has.
 *
 * What is *not* relaxed is anything the spelling cannot explain. The lists must
 * still be the same length and in the same order, because every coordinate in
 * the blended picture is an index into one of them; and two sequences that
 * match by name must still be the same number of bases, because that is the
 * check that catches hg19 against hg38 — where `chr1` is `chr1` in both and is
 * not the same sequence in either.
 */
function firstContigMismatch(
  a: Array<[string, number]>,
  b: Array<[string, number]>,
): string | null {
  if (a.length !== b.length) {
    return (
      `Chromosome counts differ: ${fmt.int(a.length)} against ${fmt.int(b.length)}. Every ` +
      'coordinate in the picture is an index into one list of sequences, so the two files have ' +
      'to carry the same list, in the same order.'
    )
  }
  const named = ([name, length]: [string, number]): NamedSequence => ({ name, length })
  // Built once and only where a name actually differs, which for two files out
  // of one pipeline is never.
  let alignment: Alignment | null = null
  for (let i = 0; i < a.length; i++) {
    if (a[i][0] !== b[i][0]) {
      alignment ??= alignNames(a.map(named), b.map(named))
      const match = alignment.pairs.get(a[i][0])
      if (match?.name === b[i][0]) {
        // One sequence, two conventions, at the same position in both lists.
        // The length check below still has to pass.
      } else {
        return (
          `Chromosome ${fmt.int(i + 1)} is “${a[i][0]}” in this file and “${b[i][0]}” in the ` +
          'other, and they are not two spellings of one name. The two lists have to match, in ' +
          'order — a renamed or reordered assembly would draw one file’s chromosome under ' +
          'another’s label.'
        )
      }
    }
    if (a[i][1] !== b[i][1]) {
      const same = a[i][0] === b[i][0]
      return (
        `“${a[i][0]}” is ${fmt.int(a[i][1])} bp in this file and ` +
        `${same ? '' : `“${b[i][0]}” is `}${fmt.int(b[i][1])} bp in the other. ` +
        `${same ? 'Same name' : 'One sequence by name'}, different sequence: the bins would ` +
        'not line up.'
      )
    }
  }
  return null
}
