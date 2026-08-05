/**
 * The second file: a drop area, and the state of what landed on it.
 *
 * It lives in the Annotations column rather than in General, and the placement
 * is the argument: everything in that column is *something else laid over this
 * map*, and a second contact matrix is the largest thing anyone can lay over
 * one. General describes the file; this is a thing you do to it.
 *
 * The card is the whole of the comparison's interface. What it refuses, it
 * refuses here with the reason — same contigs, same bin size, cooler only — and
 * what it accepts it reports in one line, beside a button that takes it away
 * again. The map does the rest.
 */

import { button, el, fmt } from './dom'
import { icon, iconButton } from './icons'
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
    this.drop = el(
      'div',
      { class: 'dropzone dropzone-small', attrs: { tabindex: '0', role: 'button' } },
      el('div', { class: 'dropzone-title', text: 'Drop a second .cool or .mcool' }),
      el('div', {
        class: 'dropzone-sub',
        text: 'or click to choose one',
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
      class: 'input input-url',
      type: 'url',
      placeholder: 'https://bucket.example.org/other.cool',
    })
    this.urlInput.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter') return
      const url = this.urlInput.value.trim()
      if (url !== '') this.props.onOpen({ kind: 'remote', url })
    })

    this.el = el(
      'div',
      { class: 'card compare-card' },
      el(
        'h3',
        { class: 'card-head' },
        icon('git-compare', { size: 14 }),
        el('span', { text: 'Compare' }),
      ),
      this.body,
      fileInput,
    )
    this.render()
  }

  set(state: CompareState): void {
    this.state = state
    this.render()
  }

  private render(): void {
    switch (this.state.kind) {
      case 'empty':
        this.body.replaceChildren(
          el('p', {
            class: 'hint',
            text:
              'A second map fills the lower-left triangle, so the square stops being symmetric ' +
              'and the two are read against each other in one picture. It must be a cooler with ' +
              'the same chromosomes and the same bin size — anything else would put one file’s ' +
              'coordinates under another’s.',
          }),
          this.drop,
          el('details', { class: 'compare-url' }, el('summary', { text: 'or open one by URL' }), this.urlInput),
        )
        return
      case 'loading':
        this.body.replaceChildren(
          el('p', { class: 'compare-line', text: `Opening ${this.state.label}…` }),
        )
        return
      case 'error':
        this.body.replaceChildren(
          el('p', { class: 'inline-error', text: this.state.message }),
          button('try another file', () => this.set({ kind: 'empty' }), { class: 'btn btn-quiet' }),
        )
        return
      case 'open': {
        const info = this.state.info
        this.body.replaceChildren(
          el(
            'div',
            { class: 'compare-open' },
            el(
              'div',
              { class: 'compare-row' },
              el('span', { class: 'compare-mark compare-upper', text: '◥' }),
              el('span', {
                class: 'compare-name',
                text: this.props.primaryLabel(),
                title: 'Upper-right triangle',
              }),
              iconButton(
                'x',
                `Close ${this.props.primaryLabel()} and keep ${this.state.label} on its own`,
                () => this.props.onClose(1),
                { class: 'btn-close', size: 14 },
              ),
            ),
            el(
              'div',
              { class: 'compare-row' },
              el('span', { class: 'compare-mark compare-lower', text: '◣' }),
              el('span', {
                class: 'compare-name',
                text: this.state.label,
                title: 'Lower-left triangle',
              }),
              iconButton(
                'x',
                `Close ${this.state.label} and go back to one map`,
                () => this.props.onClose(2),
                { class: 'btn-close', size: 14 },
              ),
            ),
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
