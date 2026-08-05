/**
 * The two file-driven cards: **Linear annotations** and **Map overlays**
 * (spec §8.1).
 *
 * One class for both, because they differ in three things — their drop areas,
 * their per-row controls, and where their contents get drawn — and in nothing
 * else. Two classes would have been two copies of the loading, the error
 * reporting, the overlap warning, the colour picker and the remove button, kept
 * in step by hand.
 *
 * The rows are rebuilt from the store on every change rather than patched. The
 * list is a handful of items and the alternative — reconciling a DOM against a
 * list — is the one part of this app that would genuinely want a framework. The
 * single concession to that is {@link holdsFocus}: a rebuild is *deferred* while
 * a control in the list has the caret, because the change that asked for it
 * almost always came from that control.
 *
 * The row head carries the three things a reader changes without thinking — the
 * colour, the name and the order — as direct manipulation rather than as fields
 * behind a disclosure. Clicking the swatch opens the colour picker, clicking the
 * name edits it in place, and the grip drags the row up the stack. What is left
 * behind the chevron is what genuinely wants a form.
 */

import type { AnnotationLoader, DropZone } from '../annotations/loader'
import type { AnnotationStore } from '../annotations/store'
import type {
  AnnotationCard as CardKind,
  AnnotationEntry,
  ContigOverlap,
} from '../annotations/types'
import { button, el, fmt, trimNumber } from './dom'
import { icon, iconButton } from './icons'

interface ZoneSpec {
  zone: DropZone
  label: string
  hint: string
  accept: string
}

const LINEAR_ZONES: ZoneSpec[] = [
  {
    zone: 'gtf',
    label: 'Annotation',
    hint: 'One GTF or GFF gene model.',
    accept: '.gtf,.gff,.gff3,.gtf.gz,.gff.gz,.gff3.gz',
  },
  {
    zone: 'track',
    label: 'Tracks',
    hint: 'bigWig tracks, drawn as lines or areas.',
    accept: '.bw,.bigwig,.bigWig',
  },
  {
    zone: 'segments',
    label: 'Segments',
    hint: 'BED-like, drawn as boxes.',
    accept: '.bed,.narrowPeak,.broadPeak,.gappedPeak,.txt,.tsv',
  },
]

/**
 * The same two files, described as a 1D browser draws them.
 *
 * A BED is boxes on a lane, exactly as it is under Linear annotations, and a
 * BEDPE is an arc joining its two ends — which is what a loop call *is*, and
 * the picture every genome browser draws for one.
 */
const BROWSER_OVERLAY_ZONES: ZoneSpec[] = [
  {
    zone: 'segments',
    label: 'Regions',
    hint: 'BED-like, drawn as boxes on a lane of their own.',
    accept: '.bed,.narrowPeak,.broadPeak,.txt,.tsv',
  },
  {
    zone: 'pairs',
    label: 'Interactions',
    hint: 'BEDPE, or a table with chrom1/start1/end1/chrom2/start2/end2, drawn as arcs.',
    accept: '.bedpe,.txt,.tsv',
  },
]

const OVERLAY_ZONES: ZoneSpec[] = [
  {
    zone: 'segments',
    label: 'On the diagonal',
    hint: 'BED-like, drawn as a mark across the diagonal.',
    accept: '.bed,.narrowPeak,.broadPeak,.txt,.tsv',
  },
  {
    zone: 'pairs',
    label: 'Off the diagonal',
    hint: 'BEDPE, or a table with chrom1/start1/end1/chrom2/start2/end2, drawn as circles.',
    accept: '.bedpe,.tsv,.txt',
  },
]

/**
 * The `<option>` value that means "not one of these" in the group picker.
 *
 * A sentinel rather than an empty string, because the empty string is already
 * taken: it is what "no group" is stored as. A leading space cannot occur in a
 * name, which is trimmed before it is stored.
 */
const NEW_GROUP = ' new'

/** Lane thickness, in CSS pixels. Below the floor nothing in a lane is legible. */
const MIN_SIZE = 12
const MAX_SIZE = 400

export interface AnnotationCardProps {
  card: CardKind
  store: AnnotationStore
  loader: AnnotationLoader
  /**
   * A one-click offer, when the open map has annotations published beside it.
   *
   * Only the Linear card is given one, even though the set it loads spans both:
   * the offer is about *this map*, not about this card, and two buttons that do
   * the same thing would raise the question of how they differ.
   */
  demo?: { label: string; hint: string; run(): void }
  /**
   * Which kind of session this card is in.
   *
   * The controls are the same either way — a colour is a colour and a group is a
   * group — but three of the *sentences* are not: beside a map an overlay is
   * drawn on the diagonal and a pair is a circle off it, and in a 1D browser
   * there is no diagonal, a pair is an arc, and "bottom or right edge" is not a
   * choice anybody has. Saying so wrongly is worse than saying nothing, so the
   * card is told where it is.
   */
  context?: 'map' | 'browser'
}

export class AnnotationCard {
  readonly el: HTMLElement
  private readonly list = el('div', { class: 'ann-list' })
  private readonly unsubscribe: () => void
  /** Rows the reader has opened, so a repaint does not fold them shut. */
  private readonly open = new Set<string>()
  /** A rebuild that arrived while a control was being edited. */
  private pending = false
  /** The row being dragged, while one is; see {@link grip}. */
  private dragging: string | null = null
  /** A control that should get the focus back after the next rebuild. */
  private refocus: { attribute: 'data-grip' | 'data-tick'; id: string } | null = null
  /**
   * The rows that are ticked, for the actions that apply to several at once.
   *
   * Putting six tracks in one group, or giving them one height, is six trips
   * through six rows otherwise — and the six are almost always chosen together
   * because they are the same experiment. Held here rather than in the store: a
   * selection is a gesture in progress, not a property of a track, and it should
   * not survive a reload the way a colour does.
   */
  private readonly ticked = new Set<string>()

  constructor(private readonly props: AnnotationCardProps) {
    const linear = props.card === 'linear'
    const browsing = props.context === 'browser'
    const zones = linear ? LINEAR_ZONES : browsing ? BROWSER_OVERLAY_ZONES : OVERLAY_ZONES

    this.el = el(
      'section',
      { class: 'card annotation-card' },
      // No subtitle. Each drop area under the heading already says what it takes
      // and how it is drawn, so a line saying it again for the card as a whole
      // was a line every reader scrolls past twice a session in a column that
      // has better uses for four rows of height.
      el('h3', {
        text: linear ? 'Linear annotations' : browsing ? 'Interactions' : 'Map overlays',
      }),
      ...(props.demo === undefined
        ? []
        : [
            button(props.demo.label, props.demo.run, {
              class: 'btn btn-wide ann-demo',
              title: props.demo.hint,
            }),
          ]),
      el('div', { class: 'drop-row' }, ...zones.map((spec) => this.dropzone(spec))),
      this.urlRow(zones),
      this.list,
    )

    // Focus leaving the list is what releases a deferred rebuild. Deferred to a
    // task, because at `focusout` time the *new* focus owner is not set yet, so
    // the check would see the document body and repaint into a control the
    // reader has merely tabbed to.
    this.list.addEventListener('focusout', () => {
      setTimeout(() => {
        if (this.pending) this.render()
      }, 0)
    })

    this.unsubscribe = props.store.subscribe(() => this.render())
    this.render()
  }

  destroy(): void {
    this.unsubscribe()
  }

  // -------------------------------------------------------------------------
  // Getting files in
  // -------------------------------------------------------------------------

  /**
   * One drop area.
   *
   * Clickable as well as droppable, because "drag a file here" is not a gesture
   * everyone has, and because a file manager is not always on screen beside the
   * browser. `multiple` on every zone but the gene model, which takes one.
   */
  private dropzone(spec: ZoneSpec): HTMLElement {
    const input = el('input', { class: 'hidden-input', type: 'file' })
    input.accept = spec.accept
    input.multiple = spec.zone !== 'gtf'
    input.addEventListener('change', () => {
      const files = Array.from(input.files ?? [])
      if (files.length > 0) this.props.loader.addFiles(this.props.card, spec.zone, files)
      // Cleared so choosing the same file twice fires `change` the second time.
      input.value = ''
    })

    const zone = el(
      'div',
      { class: 'ann-drop', title: spec.hint, attrs: { tabindex: '0', role: 'button' } },
      el('span', { class: 'ann-drop-label', text: spec.label }),
      el('span', { class: 'ann-drop-hint', text: spec.hint }),
      input,
    )
    zone.addEventListener('click', () => input.click())
    zone.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault()
        input.click()
      }
    })
    zone.addEventListener('dragover', (event) => {
      event.preventDefault()
      zone.classList.add('over')
    })
    zone.addEventListener('dragleave', () => zone.classList.remove('over'))
    zone.addEventListener('drop', (event) => {
      event.preventDefault()
      zone.classList.remove('over')
      const files = Array.from(event.dataTransfer?.files ?? [])
      if (files.length > 0) this.props.loader.addFiles(this.props.card, spec.zone, files)
    })
    return zone
  }

  /**
   * A URL box, folded away until it is wanted.
   *
   * Published tracks live on buckets beside published maps, and a reader
   * following a link to one should not have to download it first. The zone
   * picker is only offered when the card has more than one, and it decides
   * nothing that the file's own bytes will not overrule (§8.3).
   */
  private urlRow(zones: ZoneSpec[]): HTMLElement {
    const input = el('input', {
      class: 'input',
      type: 'url',
      placeholder: 'https://bucket.example.org/ATAC.bw',
    })
    const select = el('select', { class: 'select' })
    for (const spec of zones) select.appendChild(el('option', { value: spec.zone, text: spec.label }))

    const submit = (): void => {
      const url = input.value.trim()
      if (url === '') return
      this.props.loader.addUrl(this.props.card, select.value as DropZone, url)
      input.value = ''
    }
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') submit()
    })

    return el(
      'details',
      { class: 'ann-url' },
      el('summary', { text: 'or open one by URL' }),
      el('div', { class: 'ann-url-row' }, select, input, button('add', submit, { class: 'btn' })),
    )
  }

  // -------------------------------------------------------------------------
  // The rows
  // -------------------------------------------------------------------------

  /**
   * `true` while a control in the list is being edited.
   *
   * Only the controls carrying a value the reader has not finished giving. A
   * colour picker is the case that forces this: it fires `input` on every drag,
   * each of which is a store change, and replacing the `<input>` underneath an
   * open picker closes it. A half-typed name is the same problem more quietly —
   * the caret and the untyped rest of the word go with the node.
   *
   * A checkbox is the case that forces the *exception*. It commits on the click
   * that focuses it, so there is never a half-given value to protect — and
   * treating it like the rest deferred the rebuild that the tick was asking for,
   * which is exactly the batch bar it exists to open. The focus is put back on
   * the same box afterwards, so a second tick does not need a second aim.
   */
  private holdsFocus(): boolean {
    const active = document.activeElement
    if (!(active instanceof HTMLElement) || !this.list.contains(active)) return false
    if (active instanceof HTMLInputElement && active.type === 'checkbox') return false
    return (
      active instanceof HTMLInputElement ||
      active instanceof HTMLSelectElement ||
      active instanceof HTMLTextAreaElement
    )
  }

  private render(): void {
    if (this.holdsFocus()) {
      this.pending = true
      return
    }
    this.pending = false

    const entries = this.props.store.forCard(this.props.card)
    // Rows that have gone take their tick with them, or a batch would act on
    // ids the store has never heard of.
    for (const id of [...this.ticked]) {
      if (!entries.some((entry) => entry.id === id)) this.ticked.delete(id)
    }
    const batch = this.batchBar(entries)
    this.list.replaceChildren(
      ...entries.map((entry, index) => this.row(entry, index, entries.length)),
      ...(batch === null ? [] : [batch]),
    )

    // A keyboard reorder rebuilt the list out from under the grip that asked for
    // it; put the focus back on the row at the position it moved to, so a second
    // press moves the same row again rather than starting over from the mouse.
    const wanted = this.refocus
    this.refocus = null
    if (wanted !== null) {
      this.list
        .querySelector<HTMLElement>(`[${wanted.attribute}="${cssEscape(wanted.id)}"]`)
        ?.focus()
    }
  }

  private row(entry: AnnotationEntry, index: number, total: number): HTMLElement {
    const body = el('div', { class: 'ann-body' })
    const isOpen = this.open.has(entry.id)
    body.classList.toggle('hidden', !isOpen)
    if (isOpen) body.replaceChildren(...this.settings(entry))

    const row = el('div', {
      class: `ann-row ann-${entry.status}`,
      attrs: { 'data-id': entry.id },
    })

    const more = iconButton(
      isOpen ? 'chevron-down' : 'chevron-right',
      isOpen ? 'Hide this annotation’s settings' : 'Show this annotation’s settings',
      () => {
        if (this.open.has(entry.id)) this.open.delete(entry.id)
        else this.open.add(entry.id)
        this.render()
      },
      { class: 'btn btn-icon ann-more', size: 14 },
    )
    more.setAttribute('aria-expanded', String(isOpen))

    row.appendChild(
      el(
        'div',
        { class: 'ann-head' },
        // A grip only where there is something to reorder: a list of one has no
        // order, and a handle that does nothing is a control to be tried, then
        // doubted.
        ...(total > 1 ? [this.grip(entry, index, total)] : []),
        ...(total > 1 ? [this.tick(entry)] : []),
        this.swatch(entry),
        this.name(entry),
        // Which edge of the map — a choice a 1D browser does not have, since
        // there is one axis and everything is drawn along it.
        ...(entry.card === 'linear' && this.props.context !== 'browser'
          ? [this.placement(entry)]
          : []),
        this.visibility(entry),
        more,
        iconButton('x', 'Remove this annotation', () => this.props.store.remove(entry.id), {
          class: 'btn-close',
          size: 14,
        }),
      ),
    )

    if (entry.status === 'loading') {
      row.appendChild(el('p', { class: 'ann-note', text: 'reading…' }))
    } else if (entry.status === 'error') {
      row.appendChild(el('p', { class: 'inline-error ann-note', text: entry.error ?? 'failed' }))
    } else if (entry.status === 'detached') {
      row.appendChild(this.reattachNote(entry))
    } else {
      if (entry.summary !== undefined) {
        row.appendChild(el('p', { class: 'ann-note', text: entry.summary }))
      }
      const warning = overlapWarning(entry.overlap)
      if (warning !== null) row.appendChild(el('p', { class: 'ann-warn', text: warning }))
    }
    row.appendChild(body)
    this.acceptDrops(row, index)
    return row
  }

  /**
   * The way back from a reload.
   *
   * A dropped file cannot be re-read without a gesture, which is a privacy
   * property rather than a limitation (§11) — so the row keeps everything the
   * reader chose and asks for the file again, rather than vanishing and taking
   * the settings with it.
   */
  private reattachNote(entry: AnnotationEntry): HTMLElement {
    const input = el('input', { class: 'hidden-input', type: 'file' })
    input.addEventListener('change', () => {
      const file = input.files?.[0]
      if (file !== undefined) this.props.loader.reattach(entry.id, file)
    })
    const pick = button('re-open this file', () => input.click(), {
      class: 'btn btn-quiet',
      title: 'The settings below were kept; only the data has to be read again.',
    })
    return el('p', { class: 'ann-note ann-detached' }, `${entry.source.name} · `, pick, input)
  }

  // -------------------------------------------------------------------------
  // Reordering
  // -------------------------------------------------------------------------

  /**
   * The drag handle, and the only part of the row that starts a drag.
   *
   * Dragging from the row itself would fight every control on it — a text
   * selection in the name box, a slider, the swatch — so the gesture is given
   * one small target that does nothing else. Arrow keys do the same job, because
   * a reorder that needs a pointer is a reorder some readers cannot perform.
   */
  /**
   * The tick box that puts a row into the batch.
   *
   * Beside the name rather than in a mode of its own: a selection you have to
   * turn on is a selection nobody finds, and the box costs eleven pixels in a
   * row that already has five controls in it.
   */
  private tick(entry: AnnotationEntry): HTMLElement {
    const input = el('input', {
      class: 'checkbox ann-tick',
      type: 'checkbox',
      title: `Include ${entry.label} in the batch below`,
      attrs: { 'data-tick': entry.id },
    })
    input.checked = this.ticked.has(entry.id)
    input.addEventListener('change', () => {
      if (input.checked) this.ticked.add(entry.id)
      else this.ticked.delete(entry.id)
      this.refocus = { attribute: 'data-tick', id: entry.id }
      this.render()
    })
    return input
  }

  /**
   * What can be done to the ticked rows, and only while some are.
   *
   * Four things, and they are the four that are meaningless one at a time:
   * a shared autoscale group (which is a claim *about the set*), one height,
   * one colour, and removing them together. Everything else a track has is a
   * per-track decision and stays in the row.
   */
  private batchBar(entries: AnnotationEntry[]): HTMLElement | null {
    const chosen = entries.filter((entry) => this.ticked.has(entry.id))
    if (chosen.length < 2) return null
    const group = el('select', { class: 'select' })
    group.appendChild(el('option', { value: '', text: 'no group' }))
    for (const name of this.props.store.scaleGroups().keys()) {
      group.appendChild(el('option', { value: name, text: name }))
    }
    group.appendChild(el('option', { value: ' new', text: 'new group…' }))
    group.value = ''
    group.title = 'Resolve these tracks to one pair of limits'
    group.addEventListener('change', () => {
      let name = group.value
      if (name === ' new') {
        name = window.prompt('Name for the new autoscale group')?.trim() ?? ''
        if (name === '') {
          group.value = ''
          return
        }
      }
      for (const entry of chosen) this.props.store.restyle(entry.id, { group: name })
    })

    const colour = el('input', { class: 'ann-swatch', type: 'color', value: chosen[0].style.colour })
    colour.title = 'One colour for all of them'
    colour.addEventListener('input', () => {
      for (const entry of chosen) this.props.store.restyle(entry.id, { colour: colour.value })
    })

    return el(
      'div',
      { class: 'ann-batch' },
      el('span', { class: 'ann-batch-count', text: `${chosen.length} selected` }),
      group,
      colour,
      button('same height', () => {
        const tallest = Math.max(...chosen.map((entry) => entry.style.size))
        for (const entry of chosen) this.props.store.restyle(entry.id, { size: tallest })
      }, { class: 'btn btn-quiet', title: 'Give them all the height of the tallest' }),
      button('hide', () => {
        for (const entry of chosen) this.props.store.update(entry.id, { visible: false })
      }, { class: 'btn btn-quiet', title: 'Hide them all, keeping their settings' }),
      button('remove', () => {
        for (const entry of chosen) {
          this.ticked.delete(entry.id)
          this.props.store.remove(entry.id)
        }
      }, { class: 'btn btn-quiet ann-batch-remove', title: 'Remove them all' }),
      button('clear', () => {
        this.ticked.clear()
        this.render()
      }, { class: 'btn btn-quiet' }),
    )
  }

  private grip(entry: AnnotationEntry, index: number, total: number): HTMLElement {
    const node = el(
      'span',
      {
        class: 'ann-grip',
        title: 'Drag, or press the arrow keys, to reorder this annotation',
        attrs: {
          draggable: 'true',
          tabindex: '0',
          role: 'button',
          'aria-label': `Reorder ${entry.label}, ${index + 1} of ${total}`,
          'data-grip': entry.id,
        },
      },
      icon('grip-vertical', { size: 12 }),
    )

    node.addEventListener('dragstart', (event) => {
      this.dragging = entry.id
      const row = node.closest('.ann-row')
      row?.classList.add('is-dragging')
      if (event.dataTransfer !== null) {
        event.dataTransfer.effectAllowed = 'move'
        // Some browsers cancel a drag that carries nothing at all.
        event.dataTransfer.setData('text/plain', entry.id)
        // The row, not the handle: a 12-pixel ghost says nothing about what is
        // being moved.
        if (row instanceof HTMLElement) event.dataTransfer.setDragImage(row, 12, 12)
      }
    })
    node.addEventListener('dragend', () => {
      this.dragging = null
      this.clearDropMarks()
      this.list.querySelector('.is-dragging')?.classList.remove('is-dragging')
    })
    node.addEventListener('keydown', (event) => {
      const step = event.key === 'ArrowUp' ? -1 : event.key === 'ArrowDown' ? 1 : 0
      if (step === 0) return
      event.preventDefault()
      const to = index + step
      if (to < 0 || to >= total) return
      this.refocus = { attribute: 'data-grip', id: entry.id }
      this.props.store.move(entry.id, to)
    })
    return node
  }

  /**
   * Make one row a drop target.
   *
   * The half of the row the pointer is in decides which side of it the dragged
   * row lands on, which is the convention every list with this gesture uses and
   * the only one that can express "past the last row".
   */
  private acceptDrops(row: HTMLElement, index: number): void {
    const sideOf = (event: DragEvent): 'before' | 'after' => {
      const box = row.getBoundingClientRect()
      return event.clientY < box.top + box.height / 2 ? 'before' : 'after'
    }

    row.addEventListener('dragover', (event) => {
      if (this.dragging === null || this.dragging === row.dataset['id']) return
      // Without this the drop is refused and the ghost springs back.
      event.preventDefault()
      if (event.dataTransfer !== null) event.dataTransfer.dropEffect = 'move'
      this.clearDropMarks()
      row.classList.add(sideOf(event) === 'before' ? 'drop-before' : 'drop-after')
    })
    row.addEventListener('dragleave', () => {
      row.classList.remove('drop-before', 'drop-after')
    })
    row.addEventListener('drop', (event) => {
      const moved = this.dragging
      this.clearDropMarks()
      if (moved === null || moved === row.dataset['id']) return
      event.preventDefault()
      this.dragging = null

      const entries = this.props.store.forCard(this.props.card)
      const from = entries.findIndex((candidate) => candidate.id === moved)
      if (from < 0) return
      // Where it goes in the list as it stands, then the same place counted in
      // the list with the dragged row already taken out of it — which is the
      // list `move` inserts into.
      const insertAt = index + (sideOf(event) === 'after' ? 1 : 0)
      this.props.store.move(moved, insertAt > from ? insertAt - 1 : insertAt)
    })
  }

  private clearDropMarks(): void {
    for (const node of this.list.querySelectorAll('.drop-before, .drop-after')) {
      node.classList.remove('drop-before', 'drop-after')
    }
  }

  // -------------------------------------------------------------------------
  // The head's own controls
  // -------------------------------------------------------------------------

  /**
   * The colour, as the picker itself rather than as a button that opens one.
   *
   * `input[type=color]` styled down to the size of the swatch it replaces: one
   * click on the colour opens the picker, which is what a colour swatch in a
   * list of layers does everywhere else. The old arrangement — a dead square
   * here, the real control two clicks away behind the settings — made the
   * commonest change to an annotation one of the most expensive.
   */
  private swatch(entry: AnnotationEntry): HTMLElement {
    const input = el('input', {
      class: 'ann-swatch',
      type: 'color',
      value: entry.style.colour,
      title: `Colour for ${entry.label}`,
    })
    input.addEventListener('input', () =>
      this.props.store.restyle(entry.id, { colour: input.value }),
    )
    return input
  }

  /**
   * What the lane is called, on screen and in an exported figure.
   *
   * Editable in place, by clicking the name — the file name is a starting point
   * rather than an answer (`Yeast_ATAC.bw` and `Yeast_ATAC.narrowPeak` are two
   * annotations with one name, and the lane label is what tells them apart on
   * the plot). It is an `<input>` that looks like text until it has the caret,
   * rather than a label that swaps itself for one: the swap is a frame of
   * flicker and a lost first keystroke, and there is nothing the plain text
   * could do that the quiet input does not.
   */
  private name(entry: AnnotationEntry): HTMLElement {
    const input = el('input', {
      class: 'input ann-name',
      type: 'text',
      value: entry.label,
      title: `${entry.label} — click to rename`,
    })
    input.addEventListener('change', () => {
      const label = input.value.trim()
      // An empty name would leave a lane with nothing drawn on it and a row that
      // cannot be told from its neighbour; refused, by restoring what was there.
      if (label === '' || label === entry.label) {
        input.value = entry.label
        return
      }
      this.props.store.update(entry.id, { label })
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

  /** The bottom/right tick boxes — §8.1's "bottom, right, or both". */
  private placement(entry: AnnotationEntry): HTMLElement {
    const box = (edge: 'bottom' | 'right', label: string): HTMLElement => {
      const input = el('input', { class: 'checkbox', type: 'checkbox' })
      input.checked = entry.placement[edge]
      input.addEventListener('change', () =>
        this.props.store.update(entry.id, {
          placement: { ...entry.placement, [edge]: input.checked },
        }),
      )
      return el(
        'label',
        { class: 'ann-edge', title: `Draw this on the ${edge} edge of the map` },
        input,
        el('span', { text: label }),
      )
    }
    return el('div', { class: 'ann-edges' }, box('bottom', 'B'), box('right', 'R'))
  }

  private visibility(entry: AnnotationEntry): HTMLElement {
    // An eye, drawn at the size of the fold arrow beside it. The two glyphs it
    // used — a filled circle and an empty one — were a radio button as far as
    // anyone could tell, they were set in whatever font the OS chose, and they
    // were a different size from every other control on the row.
    const node = iconButton(
      entry.visible ? 'eye' : 'eye-off',
      entry.visible ? 'Hide, keeping the settings' : 'Show again',
      () => this.props.store.update(entry.id, { visible: !entry.visible }),
      { class: `btn btn-icon ann-eye${entry.visible ? '' : ' is-off'}`, size: 14 },
    )
    node.setAttribute('aria-pressed', String(entry.visible))
    return node
  }

  // -------------------------------------------------------------------------
  // Per-annotation settings
  // -------------------------------------------------------------------------

  /**
   * What is left once the head has taken the colour, the name and the order.
   *
   * Everything here is a decision about *how the data is drawn*, which is the
   * part worth folding away: it is settled once when a track is loaded and then
   * left alone, unlike the three the head carries.
   */
  private settings(entry: AnnotationEntry): HTMLElement[] {
    const out: HTMLElement[] = []
    // A lane has a thickness; an overlay is drawn on the map and has no lane.
    if (entry.card === 'linear') out.push(this.laneRow(entry))
    if (entry.kind === 'track') out.push(this.limits(entry), this.group(entry))
    if (entry.card === 'overlay') {
      if (entry.kind === 'segments') out.push(this.shape(entry))
      if (entry.kind === 'pairs') out.push(this.radius(entry))
      out.push(this.opacity(entry))
    }
    out.push(this.origin(entry))
    return out
  }

  /**
   * Where this came from, in small type at the bottom of the settings.
   *
   * A name is renameable and the default one is a file name with its suffix
   * taken off, so after an hour's work a panel of five tracks says nothing about
   * which file any of them is. Last and quiet, because it is looked up rather
   * than read: `title` carries the whole of a URL that is too long for the
   * column, and the text is selectable so it can be copied into a note.
   */
  private origin(entry: AnnotationEntry): HTMLElement {
    const source = entry.source
    const shown =
      source.kind === 'remote'
        ? source.url
        : source.kind === 'detached'
          ? `${source.name} — put down; the file is no longer readable`
          : source.name
    return el('p', { class: 'ann-origin', text: shown, title: shown })
  }

  /**
   * Lane thickness in pixels, with the drawing style beside it.
   *
   * A number box rather than the slider that was here. A slider is for a
   * quantity with no natural unit, and this one has the most natural unit there
   * is: the lane is *n* pixels tall on the screen you are looking at. Typing 60
   * is one gesture; finding 60 on a 120-pixel track running from 12 to 140 is a
   * drag, an overshoot and a squint. The two controls share a row because
   * neither fills one, and a settings body of six half-empty rows is one that
   * has to be scrolled.
   */
  private laneRow(entry: AnnotationEntry): HTMLElement {
    const size = el('input', {
      class: 'input input-num ann-size',
      type: 'number',
      value: String(Math.round(entry.style.size)),
      title: `Lane thickness in pixels — ${MIN_SIZE} to ${MAX_SIZE}.`,
    })
    size.min = String(MIN_SIZE)
    size.max = String(MAX_SIZE)
    size.step = '1'
    size.addEventListener('change', () => {
      const typed = Math.round(Number(size.value))
      if (!Number.isFinite(typed)) {
        size.value = String(Math.round(entry.style.size))
        return
      }
      // Clamped rather than refused: a typed 900 is a reader asking for a taller
      // lane than exists, and the tallest one is the answer to that.
      const clamped = Math.max(MIN_SIZE, Math.min(MAX_SIZE, typed))
      size.value = String(clamped)
      this.props.store.restyle(entry.id, { size: clamped })
    })

    return el(
      'div',
      { class: 'ann-inline' },
      el(
        'label',
        { class: 'field ann-field ann-field-tight' },
        el('span', { class: 'field-label', text: 'height' }),
        size,
        el('span', { class: 'ann-unit', text: 'px' }),
      ),
      ...(entry.kind === 'track' ? [this.mode(entry), this.flip(entry)] : []),
    )
  }

  /**
   * Draw this track's value axis upside down.
   *
   * For the half of an experiment that is measured downwards. Stranded RNA-seq
   * is the case that asks for it: forward reads growing up from a shared floor
   * and reverse reads growing *down* from it is one picture of one locus, and
   * two tracks both growing upwards is two pictures a reader has to mirror in
   * their head. A button rather than a checkbox, because it is a state the lane
   * is *in* and the lane shows it.
   */
  private flip(entry: AnnotationEntry): HTMLElement {
    const node = iconButton(
      'flip-vertical',
      'Invert this track’s value axis, so it grows downwards',
      () => this.props.store.restyle(entry.id, { flip: !entry.style.flip }),
      { class: `btn btn-icon ann-flip${entry.style.flip ? ' is-on' : ''}`, size: 14 },
    )
    node.setAttribute('aria-pressed', String(entry.style.flip))
    return node
  }

  private mode(entry: AnnotationEntry): HTMLElement {
    const select = el('select', { class: 'select' })
    for (const mode of ['area', 'line', 'bar'] as const) {
      select.appendChild(el('option', { value: mode, text: mode }))
    }
    select.value = entry.style.mode
    select.addEventListener('change', () =>
      this.props.store.restyle(entry.id, { mode: select.value as 'area' | 'line' | 'bar' }),
    )
    return el(
      'label',
      { class: 'field ann-field ann-field-tight' },
      el('span', { class: 'field-label', text: 'style' }),
      select,
    )
  }

  /**
   * Auto, or a pair of numbers.
   *
   * Auto means *what is in view*, recomputed as the view moves, which is the
   * behaviour a reader expects from a genome browser. The boxes are seeded from
   * the file's own header range so switching to manual starts somewhere sensible
   * rather than at zero — and seeded through the same trimming the colour clip
   * uses, capped at three decimals. A bigWig header hands back a `float32`
   * widened to a double, so the faithful value of a seed is
   * `0.03999999910593033`, and nothing past the third place of that survives
   * being drawn in a lane forty pixels tall.
   */
  private limits(entry: AnnotationEntry): HTMLElement {
    const { limits } = entry.style
    const seed = entry.fileExtent ?? { min: 0, max: 1 }
    const min = el('input', {
      class: 'input input-num',
      type: 'number',
      value: trimNumber(limits.auto ? seed.min : limits.min, 3),
      title: 'Floor of the value axis',
    })
    const max = el('input', {
      class: 'input input-num',
      type: 'number',
      value: trimNumber(limits.auto ? seed.max : limits.max, 3),
      title: 'Ceiling of the value axis',
    })
    /**
     * A toggle button, not a tick box.
     *
     * The tick box was a third control on a row that already held two number
     * boxes, and it took the width that made them overflow. A button carries its
     * state in its own border, needs no label beside it, and — unlike a tick box
     * — reads as the thing to press to *get back* to auto, which is the only
     * direction it is ever pressed in: leaving auto happens by typing a bound.
     */
    const auto = button('auto', () => setAuto(!auto.classList.contains('is-on')), {
      class: 'btn btn-quiet ann-auto',
    })

    /**
     * Put the button in a state, and store it.
     *
     * The button is repainted *here* rather than left to the rebuild the store
     * change will ask for, because the commonest way to leave auto is to type a
     * bound and press Enter — which leaves the caret in the box, and a rebuild
     * while a control in this list has the caret is deliberately deferred (see
     * `holdsFocus`). Without this the reader types a limit, sees the track
     * rescale, and is still looking at a button that says it is on auto.
     */
    const setAuto = (on: boolean): void => {
      const low = Number(min.value)
      const high = Number(max.value)
      // Refused rather than stored. `resolveLimits` answers an inverted or
      // unreadable pair with `{0, 1}`, so a mistyped bound would redraw the lane
      // against an axis nobody asked for and leave the reader hunting for the
      // number they typed. The box says so and keeps what was there — the same
      // answer the range under the track's name gives to the same mistake.
      if (!on && (!Number.isFinite(low) || !Number.isFinite(high) || !(high > low))) {
        for (const box of [min, max]) {
          box.classList.add('is-bad')
          window.setTimeout(() => box.classList.remove('is-bad'), 700)
        }
        return
      }
      auto.classList.toggle('is-on', on)
      auto.setAttribute('aria-pressed', String(on))
      auto.title = on
        ? 'Rescaling to what is on screen. Type a bound, or press this, to fix the range.'
        : 'Fixed to the pair beside this. Press to rescale to what is on screen instead.'
      this.props.store.restyle(entry.id, { limits: { auto: on, min: low, max: high } })
    }

    for (const box of [min, max]) {
      box.step = 'any'
      // Typing a bound *is* leaving auto — there is nothing else the reader
      // could mean by it, and making them clear a tick box first was a step
      // whose only effect was to be forgotten.
      box.addEventListener('change', () => setAuto(false))
    }

    auto.classList.toggle('is-on', limits.auto)
    auto.setAttribute('aria-pressed', String(limits.auto))
    auto.title = limits.auto
      ? 'Rescaling to what is on screen. Type a bound, or press this, to fix the range.'
      : 'Fixed to the pair beside this. Press to rescale to what is on screen instead.'

    return el(
      'div',
      {
        class: 'field field-block',
        title:
          'Auto rescales to whatever is on screen, as the view moves. A one-signed track is ' +
          'anchored at zero; a signed one is made symmetric so no change sits in the middle.',
      },
      el('span', { class: 'field-label', text: 'limits' }),
      el('div', { class: 'ann-limits' }, min, max, auto),
    )
  }

  /**
   * The autoscale group: the ones that exist, plus a way to start another.
   *
   * This was a free-text box, on the reasoning that the groups that exist are
   * the ones the reader has typed and that offering a list of them would mean
   * inventing a separate place to create one. That was wrong in the direction
   * that matters: a group is only a group once two tracks are in it, so the
   * second track has to be given the *same* name as the first, and a box gives
   * no way to find out what that was without opening the other row and reading
   * it. A misremembered name raises nothing — it quietly makes a group of one,
   * which looks exactly like a group that is not working. The list is the
   * memory; `new group…` is where a name is coined, so nothing had to move
   * elsewhere to get one.
   */
  private group(entry: AnnotationEntry): HTMLElement {
    const host = el('div', { class: 'ann-group' })

    const chooser = (): void => {
      const select = el('select', { class: 'select' })
      select.appendChild(el('option', { value: '', text: 'none' }))
      for (const name of this.groupNames()) {
        select.appendChild(el('option', { value: name, text: name }))
      }
      select.appendChild(el('option', { value: NEW_GROUP, text: 'new group…' }))
      select.value = entry.style.group
      select.addEventListener('change', () => {
        if (select.value === NEW_GROUP) naming()
        else this.props.store.restyle(entry.id, { group: select.value })
      })
      host.replaceChildren(select)
    }

    const naming = (): void => {
      const input = el('input', {
        class: 'input',
        type: 'text',
        placeholder: 'group name',
        title: 'Enter names the group; Escape leaves it as it was.',
      })
      // Committed on Enter and on leaving the box, abandoned on Escape. An empty
      // name is an abandonment too: it cannot be stored, since `''` already
      // means "no group".
      let settled = false
      const commit = (): void => {
        if (settled) return
        settled = true
        const name = input.value.trim()
        if (name === '') chooser()
        else this.props.store.restyle(entry.id, { group: name })
      }
      input.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') {
          event.preventDefault()
          commit()
        } else if (event.key === 'Escape') {
          event.preventDefault()
          settled = true
          chooser()
        }
      })
      input.addEventListener('blur', commit)
      host.replaceChildren(input)
      input.focus()
    }

    chooser()
    return this.field(
      'group',
      host,
      'Tracks sharing a group share one range, over everything they show. That is the only way ' +
        'two tracks can be compared by eye.',
    )
  }

  /** Every group name in use on this file, sorted, without duplicates. */
  private groupNames(): string[] {
    const names = new Set<string>()
    for (const row of this.props.store.entries) {
      if (row.kind === 'track' && row.style.group !== '') names.add(row.style.group)
    }
    return [...names].sort((a, b) => a.localeCompare(b))
  }

  private shape(entry: AnnotationEntry): HTMLElement {
    const select = el('select', { class: 'select' })
    select.appendChild(el('option', { value: 'element', text: 'element (box)' }))
    select.appendChild(el('option', { value: 'border', text: 'border (mark)' }))
    select.value = entry.style.shape
    select.title =
      'An element is an extent — a domain — and is drawn as the box it occupies. A border is a ' +
      'point call and is drawn as a mark across the diagonal, which stays visible at any zoom.'
    select.addEventListener('change', () =>
      this.props.store.restyle(entry.id, { shape: select.value as 'element' | 'border' }),
    )
    return this.field('shape', select)
  }

  private radius(entry: AnnotationEntry): HTMLElement {
    const input = el('input', { class: 'ann-range', type: 'range', value: String(entry.style.radius) })
    input.min = '3'
    input.max = '24'
    input.addEventListener('input', () =>
      this.props.store.restyle(entry.id, { radius: Number(input.value) }),
    )
    return this.field('radius', input)
  }

  private opacity(entry: AnnotationEntry): HTMLElement {
    const input = el('input', {
      class: 'ann-range',
      type: 'range',
      value: String(Math.round(entry.style.opacity * 100)),
    })
    input.min = '10'
    input.max = '100'
    input.addEventListener('input', () =>
      this.props.store.restyle(entry.id, { opacity: Number(input.value) / 100 }),
    )
    return this.field('opacity', input)
  }

  private field(label: string, control: HTMLElement, hint?: string): HTMLElement {
    return el(
      'label',
      { class: 'field ann-field', title: hint ?? '' },
      el('span', { class: 'field-label', text: label }),
      control,
    )
  }
}

/**
 * `CSS.escape`, with a fallback.
 *
 * The ids this escapes are minted here and are always `a<digits>`, so nothing
 * needs escaping in practice. It is used anyway because the day one comes from
 * somewhere else is not the day to discover that the selector was built by
 * concatenation — and `CSS` is absent in a non-browser environment, which the
 * test runner is.
 */
function cssEscape(value: string): string {
  return typeof CSS !== 'undefined' && typeof CSS.escape === 'function'
    ? CSS.escape(value)
    : value.replace(/["\\]/g, '\\$&')
}

/**
 * What to say when a file and a map disagree about contig names.
 *
 * §8.2 requires this to be impossible to miss, and it applies to every format
 * rather than only to bigWig: a silent zero-overlap — a GTF using `chrI` against
 * a map using `I` — is the most likely support question there is, and it
 * presents as "the feature does not work" rather than as "these two files
 * disagree about names". The two failures want different fixes and are
 * therefore worded differently: no overlap at all is a naming convention
 * mismatch, and partial overlap is usually a partial annotation.
 */
export function overlapWarning(overlap: ContigOverlap | undefined): string | null {
  if (overlap === undefined || overlap.total === 0) return null
  if (overlap.matched === 0) {
    const sample = overlap.extra.length > 0 ? ` This file names ${overlap.extra.join(', ')}…` : ''
    return `No contig in this file matches the map (0 of ${fmt.int(overlap.total)}).${sample} ` +
      'Nothing will be drawn until the two use the same names.'
  }
  if (overlap.matched < overlap.total) {
    return `${fmt.int(overlap.matched)} of ${fmt.int(overlap.total)} contigs matched; ` +
      `nothing is drawn on ${overlap.missing.join(', ')}${overlap.missing.length < overlap.total - overlap.matched ? '…' : ''}.`
  }
  return null
}
