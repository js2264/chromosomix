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

import { button, el, fmt } from './dom'
import { cardTitle, iconButton } from './icons'
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
  /** The name of the file already open, for the labels. */
  primaryLabel(): string
}

export class CompareCard {
  readonly el: HTMLElement
  private readonly body = el('div', { class: 'compare-body' })
  private readonly drop: HTMLElement
  private readonly urlInput: HTMLInputElement
  private state: CompareState = { kind: 'empty' }

  constructor(private readonly props: CompareCardProps) {
    // Redrawn on demand rather than watched: the state that decides an eye —
    // which map is on screen — is the session's, and the session is what calls
    // `set`/`sync` when it changes.
    // The Tracks card's load zone, to the class: a thin unshaded box with a bold
    // line and a quiet one under it, and the URL behind a fold below. The two
    // cards ask the same thing — *put a file here* — and they sat one above the
    // other in the same column looking like two different applications, one with
    // a shaded panel and a centred title, one with a hairline rectangle.
    this.drop = el(
      'div',
      { class: 'ann-drop', attrs: { tabindex: '0', role: 'button' } },
      el('span', { class: 'ann-drop-label', text: 'Load a second map' }),
      el('span', {
        class: 'ann-drop-hint',
        text:
          'A cooler with the same chromosomes and the same bin size. Click to choose, or drop ' +
          'one here — it fills the lower-left triangle, so the square stops being symmetric and ' +
          'the two are read against each other in one picture.',
      }),
    )
    const fileInput = el('input', { class: 'hidden-input', type: 'file' })
    fileInput.addEventListener('change', () => {
      const file = fileInput.files?.[0]
      if (file) this.props.onOpen({ kind: 'local', file })
    })
    this.drop.addEventListener('click', () => fileInput.click())
    this.drop.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') fileInput.click()
    })
    this.drop.addEventListener('dragover', (event) => {
      event.preventDefault()
      this.drop.classList.add('over')
    })
    this.drop.addEventListener('dragleave', () => this.drop.classList.remove('over'))
    this.drop.addEventListener('drop', (event) => {
      event.preventDefault()
      this.drop.classList.remove('over')
      const file = event.dataTransfer?.files?.[0]
      if (file) this.props.onOpen({ kind: 'local', file })
    })

    this.urlInput = el('input', {
      class: 'input',
      type: 'url',
      placeholder: 'https://bucket.example.org/other.cool',
    })
    this.urlInput.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') this.openUrl()
    })

    this.el = el(
      'div',
      { class: 'card compare-card' },
      cardTitle('Contact maps', 'grid-2x2'),
      this.body,
      fileInput,
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

  private openUrl(): void {
    const url = this.urlInput.value.trim()
    if (url !== '') this.props.onOpen({ kind: 'remote', url })
  }

  private render(): void {
    switch (this.state.kind) {
      case 'loading':
        this.body.replaceChildren(
          this.mapRow(1, this.props.primaryLabel(), false),
          el('p', { class: 'compare-line', text: `Opening ${this.state.label}…` }),
        )
        return
      case 'error':
        this.body.replaceChildren(
          this.mapRow(1, this.props.primaryLabel(), false),
          el('p', { class: 'inline-error', text: this.state.message }),
          button('try another file', () => this.set({ kind: 'empty' }), { class: 'btn btn-quiet' }),
        )
        return
      case 'empty':
        // One map, and the slot the second would go in. The row is drawn even
        // with nothing to compare against, because the row is where the eye is
        // and the eye is how a reader leaves the matrix for the tracks.
        this.body.replaceChildren(
          this.mapRow(1, this.props.primaryLabel(), false),
          this.drop,
          el(
            'details',
            { class: 'ann-url' },
            el('summary', { text: 'or open one by URL' }),
            el(
              'div',
              { class: 'ann-url-row' },
              this.urlInput,
              button('add', () => this.openUrl(), { class: 'btn' }),
            ),
          ),
        )
        return
      case 'open': {
        const info = this.state.info
        this.body.replaceChildren(
          el(
            'div',
            { class: 'compare-open' },
            this.mapRow(1, this.props.primaryLabel(), true),
            this.mapRow(2, this.state.label, true),
          ),
          el('p', {
            class: 'hint',
            text:
              `${fmt.int(info.nContigs)} chromosomes · ${fmt.int(info.binsize ?? 0)} bp bins · ` +
              `${fmt.bytes(info.sourceBytes)}`,
          }),
          button('swap sides', () => this.props.onSwap(), {
            class: 'btn btn-quiet btn-wide',
            title:
              'Put the other file above the diagonal. The comparison is the same; which map the ' +
              'eye reads first is not.',
          }),
        )
        return
      }
    }
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
      { class: 'compare-row' },
      ...(paired
        ? [
            el('span', {
              class: `compare-mark ${which === 1 ? 'compare-upper' : 'compare-lower'}`,
              text: which === 1 ? '◥' : '◣',
            }),
          ]
        : []),
      el('span', {
        class: 'compare-name',
        text: label,
        title: paired ? (which === 1 ? 'Upper-right triangle' : 'Lower-left triangle') : label,
      }),
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
    )
  }
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

/** The first way two chromosome lists disagree, phrased for a reader. */
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
  for (let i = 0; i < a.length; i++) {
    if (a[i][0] !== b[i][0]) {
      return (
        `Chromosome ${fmt.int(i + 1)} is “${a[i][0]}” in this file and “${b[i][0]}” in the ` +
        'other. The two lists have to match, in order — a renamed or reordered assembly would ' +
        'draw one file’s chromosome under another’s label.'
      )
    }
    if (a[i][1] !== b[i][1]) {
      return (
        `“${a[i][0]}” is ${fmt.int(a[i][1])} bp in this file and ${fmt.int(b[i][1])} bp in the ` +
        'other. Same name, different sequence: the bins would not line up.'
      )
    }
  }
  return null
}
