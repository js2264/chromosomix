/**
 * The **Structures** card: every 3D model the session holds, as rows (§25).
 *
 * A structure was a row of the Tracks card, among the bigWigs and the BEDs, for
 * as long as there was only ever one — a file the reader dropped, drawn by the
 * one cell of the deck. Now a model can also be *made* (the reconstruction task,
 * §25.6), and a list that mixes a loaded model, a computed one and eleven
 * tracks is a list nobody can find the model in. So models have a card: the
 * rows a reader loaded and the rows a task produced, one list, each with the
 * three things a model row is for and a track row is not.
 *
 * **Show in the deck** — the structure cell draws one model at a time, and this
 * is how the reader says which; the cell's own picker says the same thing from
 * the other side. **bed3d** — the model out, as the file it would be loaded
 * from, which is how a computed one leaves the tab. **The provenance** — what
 * made it and what it was made from, for a computed row, in the two lines the
 * Synthetic card writes under its own rows, because a model whose framing is
 * invisible is a picture nobody can defend.
 *
 * Everything else on a row is the Tracks card's own head — the colour, the name,
 * the eye, the close — calling the same store with the same arguments, and a
 * load zone that takes the three formats and nothing else, so the sentence on
 * it can say what they are.
 */

import { taskById } from '../analysis/registry'
import { g3dSummary, writeBed3d } from '../annotations/g3d'
import type { AnnotationLoader } from '../annotations/loader'
import type { AnnotationStore } from '../annotations/store'
import type { AnnotationEntry } from '../annotations/types'
import { chooseFiles, filesFrom } from './chooseFiles'
import { button, dragHasFiles, el } from './dom'
import { downloadBlob, exportBaseName, fileStamp } from './export'
import { cardTitle, iconButton } from './icons'

export interface StructureCardOptions {
  store: AnnotationStore
  loader: AnnotationLoader
  /**
   * Put this model in the deck's structure cell, opening the cell where there
   * is none. Absent where no deck is possible — a map-only build, a file with
   * no picture to sit beside — and the button is left off rather than wired to
   * nothing.
   */
  onShow?(entry: AnnotationEntry): void
  /**
   * Take the structure cell out of the deck: the eye's other half.
   *
   * A structure row has no lane and no track to hide, so `visible` meant
   * nothing on one — the eye toggled a flag no picture read. What a reader
   * means by the eye on a model is *stop showing it*, which is the cell.
   */
  onHide?(): void
  /** Which model the cell is showing, if any, so its row can say so. */
  shown?(): string | null
  /** A detached computed row's way back: the task, with its recipe, in the drawer. */
  onRecompute?(entry: AnnotationEntry): void
}

export class StructureCard {
  readonly el: HTMLElement
  private readonly list = el('div', { class: 'ann-list' })
  private readonly unsubscribe: () => void
  private pending = false

  constructor(private readonly options: StructureCardOptions) {
    const zone = loadZone(options.loader)
    this.el = el(
      'section',
      { class: 'card annotation-card structure-card' },
      cardTitle('Structures', 'box'),
      ...zone,
      this.list,
    )
    this.cardDrops(this.el, zone[0])
    this.list.addEventListener('focusout', () => {
      setTimeout(() => {
        if (this.pending) this.refresh()
      }, 0)
    })
    this.unsubscribe = this.options.store.subscribe(() => this.refresh())
    this.refresh()
  }

  destroy(): void {
    this.unsubscribe()
  }

  /**
   * A file dropped anywhere on this card, as the Tracks card takes one.
   *
   * The zone said "drop one anywhere on this card" and nothing listened, so a
   * `.g3d` had to be aimed at the *Tracks* card to be loaded at all — the card
   * whose list it then does not join, since the loader files it as a structure
   * either way. The sentence was right and the card was missing the handler.
   *
   * A file of any other kind dropped here still goes where its bytes say
   * (§8.3): the loader decides by content, so the row lands where it should
   * and the aim is only about which card a reader thinks to drop it on.
   */
  private cardDrops(host: HTMLElement, zone: HTMLElement): void {
    host.addEventListener('dragover', (event) => {
      if (!dragHasFiles(event)) return
      event.preventDefault()
      zone.classList.add('over')
    })
    host.addEventListener('dragleave', (event) => {
      // Only when the pointer has left the card, not when it crosses onto a row
      // inside it: `dragleave` fires at every child boundary.
      if (event.relatedTarget instanceof Node && host.contains(event.relatedTarget)) return
      zone.classList.remove('over')
    })
    host.addEventListener('drop', (event) => {
      event.preventDefault()
      event.stopPropagation()
      zone.classList.remove('over')
      const files = filesFrom(event.dataTransfer)
      if (files.length > 0) this.options.loader.addFiles(files)
    })
  }

  /** Every structure row, loaded or computed — the store's order. */
  rows(): AnnotationEntry[] {
    return this.options.store.entries.filter((entry) => entry.kind === 'structure')
  }

  refresh(): void {
    if (this.holdsFocus()) {
      this.pending = true
      return
    }
    this.pending = false
    this.list.replaceChildren(...this.rows().map((entry) => this.row(entry)))
  }

  private holdsFocus(): boolean {
    const active = document.activeElement
    if (!(active instanceof HTMLElement) || !this.list.contains(active)) return false
    return active instanceof HTMLInputElement || active instanceof HTMLSelectElement
  }

  private row(entry: AnnotationEntry): HTMLElement {
    const shown = this.options.shown?.() === entry.id
    const row = el('div', {
      class: `ann-row ann-${entry.status}${shown ? ' is-shown' : ''}`,
      attrs: { 'data-id': entry.id },
    })
    row.appendChild(
      el(
        'div',
        { class: 'ann-head' },
        this.swatch(entry),
        this.name(entry),
        this.visibility(entry),
        iconButton('x', 'Remove this structure', () => this.options.store.remove(entry.id), {
          class: 'btn-close',
          size: 14,
        }),
      ),
    )
    const made = madeBy(entry)
    if (made !== null) row.appendChild(el('p', { class: 'ann-note', text: made }))
    const note = noteOf(entry)
    if (note !== null) row.appendChild(el('p', { class: `ann-note${entry.status === 'error' ? ' ann-error' : ''}`, text: note }))
    const framing = entry.source.kind === 'computed' ? entry.source.framing : ''
    if (framing !== '') row.appendChild(el('p', { class: 'ann-origin', text: framing, title: framing }))
    if (entry.source.kind === 'local' || entry.source.kind === 'remote') {
      const origin = entry.source.kind === 'local' ? entry.source.name : entry.source.url
      row.appendChild(el('p', { class: 'ann-origin', text: origin, title: origin }))
    }
    row.appendChild(this.actions(entry, shown))
    return row
  }

  /** Show it, and take it away — the two things a model row is for. */
  private actions(entry: AnnotationEntry, shown: boolean): HTMLElement {
    const ready = entry.status === 'ready' && entry.payload?.kind === 'features'
    const nodes: HTMLElement[] = []
    if (this.options.onShow !== undefined) {
      nodes.push(
        disabledUnless(
          ready,
          button(shown ? 'shown in the deck' : 'show in the deck', () => this.options.onShow?.(entry), {
            class: `btn btn-quiet structure-show${shown ? ' is-on' : ''}`,
            title: shown
              ? 'The deck’s structure cell is drawing this model'
              : 'Draw this model in the deck’s structure cell, opening the cell if there is none',
          }),
        ),
      )
    }
    if (entry.status === 'detached' && entry.source.kind === 'computed' && this.options.onRecompute !== undefined) {
      nodes.push(
        button('recompute', () => this.options.onRecompute?.(entry), {
          class: 'btn btn-quiet',
          title: 'The model’s places were not carried across the reload; the recipe was. Run it again.',
        }),
      )
    }
    nodes.push(
      disabledUnless(
        ready,
        button('bed3d', () => this.save(entry), {
          class: 'btn btn-quiet structure-bed3d',
          title: 'The model as a bed3d — chrom, start, end, x, y, z — which this app and g3dtools read back',
        }),
      ),
    )
    return el('div', { class: 'ann-inline structure-actions' }, ...nodes)
  }

  private save(entry: AnnotationEntry): void {
    const payload = entry.payload
    if (payload === undefined || payload.kind !== 'features') return
    const stamp = fileStamp(new Date())
    const text = writeBed3d(payload.data, {
      label: entry.label,
      ...(entry.source.kind === 'computed' ? { file: entry.source.framing } : {}),
    })
    downloadBlob(new Blob([text], { type: 'text/plain' }), `${exportBaseName(entry.label)}-${stamp}.bed3d`)
  }

  private swatch(entry: AnnotationEntry): HTMLElement {
    const input = el('input', {
      class: 'ann-swatch',
      type: 'color',
      value: entry.style.colour,
      title: `Colour for ${entry.label}`,
    })
    input.addEventListener('input', () => this.options.store.restyle(entry.id, { colour: input.value }))
    return input
  }

  private name(entry: AnnotationEntry): HTMLElement {
    const input = el('input', {
      class: 'input ann-name',
      type: 'text',
      value: entry.label,
      title: `${entry.label} — click to rename`,
    })
    input.addEventListener('change', () => {
      const label = input.value.trim()
      if (label === '' || label === entry.label) {
        input.value = entry.label
        return
      }
      this.options.store.update(entry.id, { label })
    })
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault()
        input.blur()
      } else if (event.key === 'Escape') {
        event.preventDefault()
        input.value = entry.label
        input.blur()
      }
    })
    return input
  }

  private visibility(entry: AnnotationEntry): HTMLElement {
    // **The eye is the deck's cell**, not the row's `visible` flag: a model is
    // drawn in one place and one place only, so "hide" can only mean take it
    // out of there. On the way in it opens the cell, as *show in the deck*
    // does; on the way out it closes it, and a deck left holding nothing goes
    // with it.
    const shown = this.options.shown?.() === entry.id
    const ready = entry.status === 'ready' && entry.payload?.kind === 'features'
    const node = iconButton(
      shown ? 'eye' : 'eye-off',
      shown ? 'Hide the model: take the structure cell out of the deck' : 'Show the model in the deck, opening the cell if there is none',
      () => {
        if (shown) this.options.onHide?.()
        else this.options.onShow?.(entry)
      },
      { class: `btn btn-icon ann-eye${shown ? '' : ' is-off'}`, size: 14 },
    )
    node.setAttribute('aria-pressed', String(shown))
    node.disabled = !ready || this.options.onShow === undefined
    return node
  }
}

/** A button that does nothing until the row has a model to do it with. */
function disabledUnless(ready: boolean, node: HTMLButtonElement): HTMLButtonElement {
  if (!ready) node.disabled = true
  return node
}

/** `Model from the map` — the task that made a computed row, or nothing. */
function madeBy(entry: AnnotationEntry): string | null {
  if (entry.source.kind !== 'computed') return null
  return taskById(entry.source.task)?.title ?? entry.source.task
}

/** The line under the name: what the row holds, or why it holds nothing yet. */
function noteOf(entry: AnnotationEntry): string | null {
  if (entry.status === 'error') return entry.error ?? 'the structure could not be read'
  if (entry.status === 'loading') return 'reading…'
  if (entry.status === 'detached') {
    return entry.source.kind === 'computed'
      ? 'the model’s places were not carried across the reload'
      : 'the file has to be pointed at again'
  }
  if (entry.payload?.kind === 'features') return g3dSummary(entry.payload.data)
  return entry.summary ?? null
}

/**
 * The zone a structure is loaded through.
 *
 * Its own zone rather than the Tracks card's, because the sentence on it is
 * the point: a reader with a `.3dg` from Dip-C does not know it is a g3d, and
 * the Tracks card's list of eight formats does not say so. A file of any
 * other kind dropped here still goes where its bytes say (§8.3) — the loader
 * decides by content — so the zone accepts and the row lands where it should.
 *
 * **The card is the target and nothing under it.** There is no box to paste a
 * URL into, here or on any other card: the same rule the Tracks and Contact
 * maps cards were brought to (§5.11), and for the same reasons — a remote file
 * arrives by the address bar, by a session, or by the Files column (§20), and
 * a text box under every drop zone was three ways of saying *open something*
 * on one card. A structure held by URL still opens exactly as it did; only the
 * box is gone.
 */
function loadZone(loader: AnnotationLoader): HTMLElement[] {
  const choose = async (): Promise<void> => {
    const files = await chooseFiles({ multiple: true })
    if (files.length > 0) loader.addFiles(files)
  }
  const zone = el(
    'div',
    { class: 'ann-drop', attrs: { tabindex: '0', role: 'button' } },
    el('span', { class: 'ann-drop-label', text: 'Load a structure' }),
    el('span', {
      class: 'ann-drop-hint',
      text:
        'A g3d (WashU, text or binary), a .3dg (Dip-C) or a bed3d. Click to choose, or drop one ' +
        'anywhere on this card; the deck’s structure cell draws it.',
    }),
  )
  zone.addEventListener('click', () => void choose())
  zone.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      void choose()
    }
  })
  return [zone]
}
