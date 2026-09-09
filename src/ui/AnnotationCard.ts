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

import {
  TRACK_OPS,
  TRACK_OP_LABELS,
  derivedTrackLabel,
  isTrackOp,
} from '../annotations/derived'
import type { AnnotationLoader } from '../annotations/loader'
import type { AnnotationStore } from '../annotations/store'
import { hasTrackControls, readsAlignments } from '../annotations/types'
import type { AnnotationEntry, ContigOverlap } from '../annotations/types'
import { TRACK_DRAG_TYPE, button, dragHasFiles, el, fmt } from './dom'
import { dragHasFileRow } from './fileDrag'
import { chooseFiles, filesFrom } from './chooseFiles'
import { pairIndexes } from '../annotations/loader'
import { cardTitle, icon, iconButton } from './icons'
import { bucketBrowseButton } from './browseButton'
import { mapsOrLead, placementField } from './lanePlacement'
import { subscribeReveal } from './revealTrack'
import { stepperField } from './trackControls'
import {
  colourByField,
  colourLegend,
  fillLegend,
  flipButton,
  heightField,
  layoutField,
  limitsField,
  mapqField,
  modeField,
  opacityField,
  duplicatesToggle,
  splitsToggle,
} from './laneSettings'

/**
 * The `<option>` value that means "not one of these" in the group picker.
 *
 * A sentinel rather than an empty string, because the empty string is already
 * taken: it is what "no group" is stored as. A leading space cannot occur in a
 * name, which is trimmed before it is stored.
 */
const NEW_GROUP = ' new'

export interface AnnotationCardProps {
  store: AnnotationStore
  /**
   * Every map a track could be drawn on, in the order they are on screen.
   *
   * Absent, or one entry, is a session with a single map, and the location
   * control keeps the shape it has always had. The labels are the deck's, since
   * naming a panel is the deck's business and not this card's.
   */
  maps?(): Array<{ id: string; label: string }>
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
  /**
   * A row out of the Files panel, dropped on this card.
   *
   * Takes the *event* rather than a file, because the bytes behind such a row
   * have not been fetched and a drop handler cannot await — see
   * `MatrixPanel.pickOnEdge`, which is the same door onto the map's own edges.
   * Absent means the drop is ignored, which is what a card with no session
   * behind it should do with one.
   */
  onPickDropped?(event: DragEvent): void
}

export class AnnotationCard {
  readonly el: HTMLElement
  private readonly list = el('div', { class: 'ann-list' })
  private readonly unsubscribe: () => void
  private readonly unsubscribeReveal: () => void
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
  /**
   * The row a shift-click counts *from*, and the reason ten tracks are two
   * gestures rather than ten.
   *
   * Ticking the first ten rows of a long stack was ten aims at an eleven-pixel
   * box, so the gesture every file list has — click one, shift-click another,
   * take everything between — is here too, and this is the "one" it counts
   * from. Every plain click sets it; a shift-click deliberately leaves it
   * alone, so a second shift-click re-extends the same span from the same start
   * rather than walking that start down the list one box at a time.
   *
   * An **id and never a position**, which is the subtle part. A position in this
   * list is only true for as long as nobody touches the list, and touching it is
   * ordinary: the rows are reorderable by drag and by arrow key ({@link grip}),
   * a row can be removed between the two clicks, and {@link fileRows} is a
   * *filter* over the store, so a store index is not a list index either. An
   * index remembered at the first click would name a different track by the
   * second. The id is resolved against {@link fileRows} at the moment the span
   * is taken, which is also what makes a stale anchor harmless: a row that has
   * gone is simply not found there, and the shift-click falls back to being a
   * plain one rather than selecting a span nobody asked for.
   */
  private anchor: string | null = null
  /**
   * Whether the toggle now being committed was made with shift held.
   *
   * A relay between two events, and it exists because neither of them carries
   * both halves of what the gesture needs: `change` says a checkbox has a new
   * value and carries no modifier keys, while `click` — which a checkbox fires
   * first, for a pointer press and for the space bar alike — carries the
   * modifiers and not yet the decision to act. So the shift is caught on the way
   * past and read a moment later by the handler that acts on it. Cleared as it
   * is read, so a `change` arriving with no click in front of it is an ordinary
   * toggle rather than one that inherits a shift from the click before.
   */
  private extending = false

  constructor(private readonly props: AnnotationCardProps) {
    // Where a file goes in, above the list of what is already in. What was here
    // instead was five labelled rectangles — one per format — which between
    // them asked the reader to know, before dropping, an answer the application
    // works out from the bytes a moment later, and which said "wrong rectangle"
    // when they guessed. One zone, and the card around it takes a file too.
    const load = loadZone(props.loader)
    this.el = el(
      'section',
      { class: 'card annotation-card' },
      cardTitle('Tracks', 'chart-area'),
      ...load.nodes,
      ...(props.demo === undefined
        ? []
        : [
            button(props.demo.label, props.demo.run, {
              class: 'btn btn-wide ann-demo',
              title: props.demo.hint,
            }),
          ]),
      this.list,
    )
    this.cardDrops(this.el, load.zone)

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
    // A press on the lane itself asks for this row (`ui/revealTrack.ts`). The
    // card is where the answer lives, so the card listens: it opens the fold,
    // and brings the row into view — a card scrolled somewhere else would
    // otherwise answer a click by changing something nobody can see.
    this.unsubscribeReveal = subscribeReveal((id) => this.reveal(id))
    this.render()
  }

  destroy(): void {
    this.unsubscribe()
    this.unsubscribeReveal()
  }

  /**
   * Open one row's settings and scroll to it.
   *
   * Opens rather than toggles: the gesture is "show me this", and a second click
   * on a lane a reader is already working on would otherwise shut the panel they
   * are working in. Ignored for a row this card does not hold, because both
   * cards in a session listen and only one of them has any given track.
   */
  private reveal(id: string): void {
    if (this.props.store.byId(id) === undefined) return
    const already = this.open.has(id)
    this.open.add(id)
    if (!already) this.render()
    const row = this.list.querySelector<HTMLElement>(`[data-id="${cssEscape(id)}"]`)
    row?.scrollIntoView({ block: 'nearest' })
  }

  // -------------------------------------------------------------------------
  // Getting files in
  // -------------------------------------------------------------------------

  /**
   * Make the card take a dropped file, and make the *zone* say so.
   *
   * The card still accepts a file anywhere on it — a reader whose pointer is
   * over the eighth row when they let go meant to load the file, and refusing
   * on a technicality would be pedantry. What changed is what lights up: the
   * whole card used to, which is a two-hundred-pixel rectangle going blue
   * around a dashed box that is *already* the drawn target, so the one thing on
   * screen saying "put it here" was the thing that did not react. Now the zone
   * lights the moment a file crosses the card, wherever on it the pointer is.
   */
  private cardDrops(host: HTMLElement, zone: HTMLElement): void {
    host.addEventListener('dragover', (event) => {
      // A row out of the Files panel is the same gesture with the bytes
      // somewhere else, and this card is the plainest place to aim one: it is
      // the list the track is about to join.
      if (!dragHasFiles(event) && !dragHasFileRow(event)) return
      event.preventDefault()
      zone.classList.add('over')
    })
    host.addEventListener('dragleave', (event) => {
      // Only when the pointer has actually left the card, not when it crosses
      // from the card onto a row inside it — `dragleave` fires for every child
      // boundary, and without this the highlight flickers all the way down.
      if (event.relatedTarget instanceof Node && host.contains(event.relatedTarget)) return
      zone.classList.remove('over')
    })
    host.addEventListener('drop', (event) => {
      event.preventDefault()
      event.stopPropagation()
      zone.classList.remove('over')
      if (dragHasFileRow(event)) {
        // Handed to the session rather than to the loader, and that is not a
        // detour: a `.cool` dragged onto the Tracks card is still a map, and
        // `Session.addPicked` is where that is decided — for a dropped file it
        // has always been decided the same way, one level up in `dropped`.
        this.props.onPickDropped?.(event)
        return
      }
      const files = filesFrom(event.dataTransfer)
      if (files.length > 0) this.props.loader.addFiles(files)
    })
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

    const entries = this.fileRows()
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
        // A grip wherever it does something. Reordering needs two rows — a list
        // of one has no order, and a handle that does nothing is a control to be
        // tried and then doubted — but beside a *map* it has a second job even
        // for a single track: dragging it onto the bottom or right rectangle is
        // what moves that track between the map's two edges.
        ...(total > 1 || this.props.context !== 'browser'
          ? [this.grip(entry, index, total)]
          : []),
        ...(total > 1 ? [this.tick(entry)] : []),
        this.swatch(entry),
        this.name(entry),
        ...(entry.payload?.kind === 'features' ? [this.star(entry)] : []),
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
      // Two tones from one function: a **warning** is a file that does not fit
      // this map, and a **note** is a file that fits part of it, which on a
      // metagenome is what fitting looks like (§8.5). Painting the second one
      // yellow would make the ordinary case look like a fault.
      const warning = overlapWarning(entry.overlap)
      if (warning !== null) {
        row.appendChild(
          el('p', { class: warning.tone === 'warn' ? 'ann-warn' : 'ann-note', text: warning.text }),
        )
      }
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
    if (entry.source.kind === 'computed') {
      // There is no file to ask for. A called interval set is the answer to a
      // task that was run against a framing, and what survives a reload is the
      // recipe rather than the coordinates (§18.5) — so the honest note names
      // the task and points at the panel that can run it again, instead of
      // opening a file picker that could never be satisfied.
      return el('p', {
        class: 'ann-note ann-detached',
        text: `computed by ${entry.source.task} · run it again from the Analysis panel to redraw it`,
      })
    }
    // `multiple`, because some formats are a *pair*. A BAM without its index
    // re-attaches and immediately refuses (§8.13), and a bgzipped feature file
    // without its `.tbi` re-attaches and silently reads itself whole — so the
    // picker takes both and `pairIndexes` sorts out which is which, exactly as
    // a drop of the two does.
    const input = el('input', { class: 'hidden-input', type: 'file' })
    input.multiple = true
    input.addEventListener('change', () => {
      const chosen = [...(input.files ?? [])]
      if (chosen.length === 0) return
      // The pair whose file is the one this row is waiting for, where the
      // reader picked several; otherwise simply the first.
      const paired = pairIndexes(chosen)
      const match = paired.find((pair) => pair.file.name === entry.source.name) ?? paired[0]
      this.props.loader.reattach(entry.id, match.file, match.index)
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
   *
   * Three listeners on one control, which is one more than a checkbox usually
   * needs and one fewer than a div pretending to be one would need. The control
   * stays a real `input[type=checkbox]` — the space bar still toggles it, a
   * screen reader still calls it a checkbox — and the range gesture is layered
   * on top of it rather than reimplemented around it. See {@link anchor} for
   * what a span is counted from and {@link extending} for why the modifier has
   * to be caught an event early.
   */
  private tick(entry: AnnotationEntry): HTMLElement {
    const input = el('input', {
      class: 'checkbox ann-tick',
      type: 'checkbox',
      // The gesture is named in the tooltip because there is nowhere else a
      // reader could meet it: a modifier held over a box that looks exactly like
      // every other box is undiscoverable otherwise, and this card has no room
      // for a line of help text.
      title:
        `Include ${entry.label} in the batch below — shift-click to take every ` +
        `row between this one and the last one you clicked`,
      attrs: { 'data-tick': entry.id },
    })
    input.checked = this.ticked.has(entry.id)

    // A shift-click anywhere in a document also extends the *text* selection,
    // which comes up as the rows between the two boxes turning blue — the card
    // looking mid-drag every time a span is taken. That default belongs to
    // `mousedown`, so `mousedown` is the only place it can be refused; refusing
    // the *click* would cancel the tick itself, which is the whole gesture. The
    // focus that the prevented `mousedown` would have given the box is put back
    // by `refocus` a moment later, after the rebuild the tick asks for.
    input.addEventListener('mousedown', (event) => {
      if (event.shiftKey) event.preventDefault()
    })
    input.addEventListener('click', (event) => {
      this.extending = event.shiftKey
    })

    input.addEventListener('change', () => {
      const extending = this.extending
      this.extending = false
      // The rows **as they are now**, and the anchor found in them by id: this
      // is the resolution {@link anchor} exists to defer, and doing it here is
      // what survives a reorder, a removal or a filter between the two clicks.
      const rows = this.fileRows()
      const from =
        extending && this.anchor !== null
          ? rows.findIndex((row) => row.id === this.anchor)
          : -1
      const to = rows.findIndex((row) => row.id === entry.id)
      // No anchor, or an anchor whose row has gone: a plain toggle of the one
      // box, which is also what the gesture degrades to for a keyboard toggle —
      // there is no such thing as a shift-held space bar here.
      const span =
        from < 0 || to < 0
          ? [entry.id]
          : rows.slice(Math.min(from, to), Math.max(from, to) + 1).map((row) => row.id)
      // The state the *clicked* box is moving to, given to the whole span, in
      // either direction: shift-clicking an empty box fills the span and
      // shift-clicking a full one empties it, which is what a file explorer and
      // a diff view both do and what makes the second gesture undo the first.
      for (const id of span) {
        if (input.checked) this.ticked.add(id)
        else this.ticked.delete(id)
      }
      // Only a click that was *not* a range moves the anchor. A shift-click that
      // moved it would walk the start of the span forward, so extending a
      // selection by one more row would shrink it to two.
      if (from < 0) this.anchor = entry.id
      this.refocus = { attribute: 'data-tick', id: entry.id }
      // One rebuild for the whole span, not one per row: the set is filled
      // first and the list redrawn once, so ten rows cost the single repaint a
      // single tick costs — see {@link render}, which rebuilds every row.
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
      const coined = name === ' new'
      if (coined) {
        name = window.prompt('Name for the new autoscale group')?.trim() ?? ''
        if (name === '') {
          group.value = ''
          return
        }
      }
      for (const entry of chosen) this.props.store.restyle(entry.id, { group: name })
      // Naming a group is the end of the gesture that selected these rows: the
      // set now exists as a group, with a card of its own listing its members,
      // and leaving the ticks on leaves a second selection saying the same thing
      // — which the next batch action would silently act on. Clearing is exactly
      // what the `clear` button beside it does, run for the reader.
      if (coined) {
        this.ticked.clear()
        this.render()
      }
    })

    const colour = el('input', { class: 'ann-swatch', type: 'color', value: chosen[0].style.colour })
    colour.title = 'One colour for all of them'
    colour.addEventListener('input', () => {
      for (const entry of chosen) this.props.store.restyle(entry.id, { colour: colour.value })
    })

    // Exactly two, and both of them profiles. A comparison of three tracks is
    // not a thing, and a comparison of a gene model against a bigWig is not
    // either — so the control appears when the selection *is* a pair rather than
    // appearing always and refusing when clicked. The order is the order they
    // are listed in, which is the order the reader put them in and the only one
    // this code could justify: `a / b` and `b / a` are different questions and
    // nothing here can guess which was meant. The row that results is named for
    // the operation it is, so which way round it went is legible on the card;
    // the other way round is a second combine of the same two rows.
    const pair =
      chosen.length === 2 && chosen.every((entry) => entry.kind === 'track')
        ? this.combineControl(chosen[0], chosen[1])
        : null

    return el(
      'div',
      { class: 'ann-batch' },
      el('span', { class: 'ann-batch-count', text: `${chosen.length} selected` }),
      ...(pair === null ? [] : [pair]),
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

  /**
   * Make one lane out of the two that are ticked.
   *
   * A dropdown that acts on selection rather than a button beside a picker,
   * because the operation *is* the whole of the decision: the two operands are
   * already chosen, and asking for them again in a dialog would be asking the
   * reader to repeat the gesture they just made.
   *
   * The ticks are cleared afterwards for {@link batchBar}'s reason — the gesture
   * is finished, the result is a row of its own, and leaving the pair selected
   * leaves the next batch action pointing at the operands of something.
   */
  private combineControl(a: AnnotationEntry, b: AnnotationEntry): HTMLElement {
    const select = el('select', { class: 'select' })
    select.appendChild(el('option', { value: '', text: 'combine…' }))
    for (const op of TRACK_OPS) {
      select.appendChild(el('option', { value: op, text: TRACK_OP_LABELS[op] }))
    }
    select.value = ''
    select.title = `One lane from ${a.label} and ${b.label}, drawn as their comparison`
    select.addEventListener('change', () => {
      const op = select.value
      if (!isTrackOp(op)) return
      const entry = this.props.store.begin({
        card: 'linear',
        kind: 'track',
        // Nothing to name and nothing to re-read: the values are computed from
        // two rows that are already here, exactly as the 4C profile is computed
        // from the block already on screen.
        source: { kind: 'derived', name: derivedTrackLabel(a.label, b.label, op) },
        label: derivedTrackLabel(a.label, b.label, op),
        placement: a.placement,
      })
      this.props.store.update(entry.id, {
        derivedFrom: { a: a.id, b: b.id, op },
        // Ready the moment it exists: there is no file behind it to wait for,
        // and a lane is drawn when it is ready.
        status: 'ready',
        summary: `${TRACK_OP_LABELS[op]} of two tracks`,
      })
      this.ticked.clear()
      this.render()
    })
    return select
  }

  private grip(entry: AnnotationEntry, index: number, total: number): HTMLElement {
    const node = el(
      'span',
      {
        class: 'ann-grip',
        title:
          this.props.context === 'browser'
            ? 'Drag, or press the arrow keys, to reorder this annotation'
            : 'Drag to reorder — or onto the map’s bottom or right edge to draw it there. ' +
              'Arrow keys reorder.',
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
        // And the same id under a type only this app writes, so a drop target
        // outside this card — the map's two edge rectangles — can tell a track
        // being moved from a file being loaded and from a dragged word, while
        // the drag is still in the air and only `types` can be read.
        event.dataTransfer.setData(TRACK_DRAG_TYPE, entry.id)
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
      // Past the row it is swapping with, by identity: the rows on this card are
      // the store's *files*, and the store holds more than files (§8.9), so a
      // step in this list is not always a step in the store's own.
      const neighbour = this.fileRows()[to]
      const at = this.props.store.entries.findIndex((row) => row.id === neighbour?.id)
      if (neighbour === undefined || at < 0) return
      this.refocus = { attribute: 'data-grip', id: entry.id }
      this.props.store.moveTo(entry.id, at)
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

      // By **identity**, not by index. The rows on this card are the store's
      // *files*, which is not everything the store holds — the 4C profile lives
      // there too and is not listed — so a position in what is being looked at
      // is not a position in the store's own list. The row the drop landed on
      // names an entry, and the entry's place in the store is looked up, which
      // is what every other drag in the application does (`AnnotationStore.moveTo`).
      const rows = this.fileRows()
      const target = rows[index]
      if (target === undefined) return
      const entries = this.props.store.entries
      const from = entries.findIndex((candidate) => candidate.id === moved)
      const onto = entries.findIndex((candidate) => candidate.id === target.id)
      if (from < 0 || onto < 0) return
      // Where it goes in the list as it stands, then the same place counted in
      // the list with the dragged row already taken out of it — which is the
      // list `moveTo` inserts into.
      const insertAt = onto + (sideOf(event) === 'after' ? 1 : 0)
      this.props.store.moveTo(moved, insertAt > from ? insertAt - 1 : insertAt)
    })
  }

  /**
   * The rows this card lists: every loaded **file**, in one list.
   *
   * Which of the store's cards an entry belongs to still decides where it is
   * *drawn* — a pair goes on the map, everything else beside it — but that is a
   * fact about the format and not a shelf the reader has to put it on.
   *
   * The 4C profile shares the store and is not one of these. It is a reading of
   * the matrix rather than a file loaded against it, so there is nothing this
   * card could say about where it came from, nothing to put down, and nothing
   * to re-attach after a reload; its controls are on the lane itself and in the
   * lane's own menu (§8.9).
   *
   * **A metadata column is out on both counts** (§8.12). It came from no file —
   * it is a column of the map that is already open — so this card's whole
   * subject, *which file is this and can it still be read*, has no answer for
   * it; and it has a card of its own, which is where the drop-down that adds
   * one lives.
   *
   * **A synthetic track is out for the same reason and a stronger one.** It has
   * a card of its own — with the exports and the Recompute button that only a
   * computed lane has — and listing it here as well put every result in the
   * panel twice, under two rows that move and rename independently while
   * pointing at one entry. Its provenance is a recipe rather than a file, which
   * is the one thing this card exists to show.
   */
  private fileRows(): AnnotationEntry[] {
    return this.props.store.entries.filter(
      (entry) => entry.source.kind !== 'computed' && entry.source.kind !== 'metadata',
    )
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

  /**
   * Which feature set the search reads.
   *
   * Several gene models can be drawn at once — comparing two annotations of one
   * genome is a thing people do — but a search box answering from all of them
   * returns the same gene four times over, differing only in which file it came
   * from. So exactly one is the one being searched: filled here, empty on the
   * others, and one press moves it.
   */
  private star(entry: AnnotationEntry): HTMLElement {
    const current = this.props.store.searchSource()?.id === entry.id
    const node = iconButton(
      'star',
      current
        ? `${entry.label} is what the feature search reads`
        : `Search ${entry.label} instead`,
      () => this.props.store.makePrimary(entry.id),
      { class: `btn btn-icon ann-star${current ? ' is-on' : ''}`, size: 13 },
    )
    node.setAttribute('aria-pressed', String(current))
    node.disabled = current
    return node
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
    // Which edge of the map — a choice a 1D browser does not have, since there
    // is one axis and everything is drawn along it. And not offered for a pile
    // either: reads are 1D-only (§8.13), so beside a map the row is there to be
    // closed and renamed and nothing else. A control that silently does nothing
    // is worse than an absent one.
    if (entry.card === 'linear' && entry.kind !== 'reads' && this.props.context !== 'browser') {
      out.push(placementField(this.props.store, entry, mapsOrLead(this.props.maps)))
    }
    if (hasTrackControls(entry.kind)) out.push(this.limits(entry), this.group(entry))
    // Which reads count, on both of a BAM's rows (§8.13). Written through to
    // the other one — a mapping-quality floor applied to the pile and not to
    // the depth beside it is two pictures of two different files under one name
    // — which `patchReads` does, so the two controls need not know about each
    // other.
    if (readsAlignments(entry.kind)) {
      out.push(
        el(
          'div',
          { class: 'ann-inline' },
          mapqField(this.props.store, entry),
          duplicatesToggle(this.props.store, entry),
        ),
      )
    }
    // …and how the pile is drawn, which only the pile has. A colouring and a
    // pairing mean nothing to a depth curve, so they are not offered on the row
    // that draws one.
    if (entry.kind === 'reads') {
      // The key is built first and handed to the picker, so a colouring chosen
      // with the focus still on the select refreshes it immediately — this card
      // defers its own rebuild while a control holds focus, and the lane does
      // not.
      const key = colourLegend(entry)
      out.push(
        el(
          'div',
          { class: 'ann-inline' },
          colourByField(this.props.store, entry, (by) =>
            fillLegend(key, entry.style.colour, by),
          ),
          layoutField(this.props.store, entry),
        ),
        key,
        splitsToggle(this.props.store, entry),
      )
    }
    // A sequence lane's value axis is GC, and it is worth being able to clip:
    // between 0.3 and 0.5 is where a genome's variation actually lives. No
    // group, though — GC shares no units with anything else on the stack, so
    // resolving it together with a coverage track would flatten both.
    if (entry.kind === 'sequence') out.push(this.limits(entry))
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
   * The controls themselves are `ui/laneSettings.ts`'s, shared with the
   * Metadata card (§8.12); what is decided here is which of them a *kind* gets.
   * They share a row because neither fills one, and a settings body of six
   * half-empty rows is one that has to be scrolled.
   */
  private laneRow(entry: AnnotationEntry): HTMLElement {
    return el(
      'div',
      { class: 'ann-inline' },
      heightField(this.props.store, entry),
      ...(hasTrackControls(entry.kind) ? [this.mode(entry), this.flip(entry)] : []),
      ...(entry.kind === 'sequence' ? [this.mode(entry)] : []),
    )
  }

  /** The value-axis flip; the shared control (`ui/laneSettings.ts`). */
  private flip(entry: AnnotationEntry): HTMLElement {
    return flipButton(this.props.store, entry)
  }

  private mode(entry: AnnotationEntry): HTMLElement {
    return modeField(this.props.store, entry)
  }

  /** Auto, or a pair of numbers — the shared control (`ui/laneSettings.ts`). */
  private limits(entry: AnnotationEntry): HTMLElement {
    return limitsField(this.props.store, entry)
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
      if (hasTrackControls(row.kind) && row.style.group !== '') names.add(row.style.group)
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
    return opacityField(this.props.store, entry)
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
 *
 * Since §5.9 the first of those two is a much smaller category, and the wording
 * had to move with it. A track spelling its sequences `chr1` against a map
 * spelling them `1` is now *renamed on the way in* and matches in full, so a
 * zero here no longer means "these two use different conventions" — that case
 * is handled. It means the matcher looked and found nothing it could justify,
 * which is a different and more serious claim: two files about different
 * genomes. Telling a reader to go and rename their chromosomes would now be
 * advice for a problem they do not have.
 */
export interface OverlapNote {
  /**
   * How loudly to say it.
   *
   * `warn` is *this file does not fit this map* — no overlap at all, a partial
   * one on a single-genome file, or a cross-convention match whose lengths
   * disagree. `note` is *this file fits part of it*, which on a metagenome is
   * what fitting looks like: a track over a co-assembly covers the organisms it
   * was made about, and painting that yellow would make the ordinary case read
   * as a fault (§8.5).
   */
  tone: 'warn' | 'note'
  text: string
}

export function overlapWarning(overlap: ContigOverlap | undefined): OverlapNote | null {
  if (overlap === undefined || overlap.total === 0) return null
  if (overlap.matched === 0) {
    const sample = overlap.extra.length > 0 ? ` This file names ${overlap.extra.join(', ')}…` : ''
    return {
      tone: 'warn',
      text:
        `No contig in this file matches the map (0 of ${fmt.int(overlap.total)}).${sample} ` +
        'The usual naming conventions were tried, so this is likely a file about another genome.',
    }
  }
  // **On a metagenome the unit of the answer is the MAG** (§8.5). A track over
  // a co-assembly routinely covers a few organisms out of fifty — coverage of
  // one MAG, an annotation of another — and the sequence counts state that as
  // `412 of 20,566 contigs matched`, which is arithmetically true and reads
  // exactly like the failure above it. So the sentence is about genomes, and it
  // is not a warning: partial coverage is the *expected* shape of a track here,
  // and the reader is told which organisms it landed on rather than which
  // twenty thousand sequences it did not.
  const genomes = overlap.genomes
  if (genomes !== undefined && genomes.matched > 0) {
    if (genomes.matched === genomes.total) {
      return {
        tone: 'note',
        text:
          `${fmt.int(overlap.matched)} of ${fmt.int(overlap.total)} sequences, across all ` +
          `${fmt.int(genomes.total)} genomes.`,
      }
    }
    const more = genomes.matched > genomes.named.length ? '…' : ''
    return {
      tone: 'note',
      text:
        `${fmt.int(overlap.matched)} of ${fmt.int(overlap.total)} sequences, in ` +
        `${fmt.int(genomes.matched)} of ${fmt.int(genomes.total)} genomes: ` +
        `${genomes.named.join(', ')}${more}.`,
    }
  }
  if (overlap.matched < overlap.total) {
    return {
      tone: 'warn',
      text:
        `${fmt.int(overlap.matched)} of ${fmt.int(overlap.total)} contigs matched; ` +
        `nothing is drawn on ${overlap.missing.join(', ')}${overlap.missing.length < overlap.total - overlap.matched ? '…' : ''}.`,
    }
  }
  // Matched in full, and *that is the problem*: a rename this file was not sure
  // of counts as a match, so the two clauses above go quiet on the one case
  // that most warrants a word. hg19's `MT` against hg38's `chrM` is one name
  // apiece and two sequences (§5.9).
  if (overlap.contested !== undefined && overlap.contested.length > 0) {
    return {
      tone: 'warn',
      text:
        `Matched across two naming conventions, but the sequences are different ` +
        `lengths: ${overlap.contested.join(', ')}. Two assembly versions would look ` +
        `exactly like this — the coordinates still land, they just may not mean the same place.`,
    }
  }
  return null
}

/**
 * Where a file goes in: a dashed zone, and a URL under a fold.
 *
 * At the *top* of the Tracks card, above the list, rather than in a card of its
 * own below it. The two questions — *what is loaded* and *put something else
 * here* — are asked of the same thing, and separating them put the answer to the
 * second below however many rows the first had: with eight tracks loaded, the
 * way to load a ninth was to scroll past the eight. Above the list it stays
 * where it was whatever the list does.
 *
 * The zone carries the dashes because being a target is all it is; the card
 * around it takes a dropped file as well, anywhere on it, which is why the hint
 * says so rather than leaving the reader to aim.
 */
function loadZone(loader: AnnotationLoader): { nodes: HTMLElement[]; zone: HTMLElement } {
  // Through `chooseFiles` so a track *chosen* is remembered as readily as one
  // dropped — the picker hands back a grant where the browser has one, and falls
  // back to the input this used to hold everywhere else.
  const choose = async (): Promise<void> => {
    const files = await chooseFiles({ multiple: true })
    if (files.length > 0) loader.addFiles(files)
  }

  const zone = el(
    'div',
    { class: 'ann-drop', attrs: { tabindex: '0', role: 'button' } },
    el('span', { class: 'ann-drop-label', text: 'Load a track' }),
    el('span', {
      class: 'ann-drop-hint',
      text:
        'bigWig, bigBed, GTF, BED, BEDPE, VCF, FASTA or an indexed BAM. Click to choose, or drop one anywhere on ' +
        'this card — what it is and where it is drawn come from the file itself.',
    }),
  )
  zone.addEventListener('click', () => void choose())
  zone.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      void choose()
    }
  })
  // No drop handling of its own: the card around it takes a file anywhere on
  // it, a drop landing on the zone bubbles there, and the card lights *this*
  // element while it happens — so the target the reader is looking at is the
  // one that reacts, and one gesture still has one handler.

  const url = el('input', {
    class: 'input',
    type: 'url',
    placeholder: 'https://bucket.example.org/ATAC.bw',
  })
  const submit = (): void => {
    const value = url.value.trim()
    if (value === '') return
    loader.addUrl(value)
    url.value = ''
  }
  url.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') submit()
  })

  return {
    zone,
    nodes: [
      zone,
      el(
        'details',
        { class: 'ann-url' },
        el('summary', { text: 'or open one by URL' }),
        el(
          'div',
          { class: 'ann-url-row' },
          url,
          button('add', submit, { class: 'btn' }),
          // A track's URL is the one nobody has in their hand: a map is opened
          // from a link or an example, and the bigWigs beside it are keys in a
          // prefix whose names came off a run sheet.
          bucketBrowseButton((picked) => loader.addUrl(picked)),
        ),
      ),
    ],
  }
}

/**
 * The highest transparency a track may be set to.
 *
 * Not a hundred. A track at a hundred is a track that is not drawn, indexed
 * under a control that says nothing about visibility — a reader who typed it
 * would be looking for a missing track in the wrong card. `hide` is beside every
 * row and says what it does.
 */
const MAX_TRANSPARENCY = 90

/**
 * Transparency, for every track at once.
 *
 * A property of the *picture* rather than of any one track: what it is for is
 * reading a gene model through the coverage drawn over it, or telling two
 * overlaid strands apart, and both of those are answered by everything on screen
 * moving together. Set per track it would be a slider to visit six times, and
 * the sixth visit would be to undo the first.
 *
 * Lives here, beside the per-track controls, because it writes the same field of
 * the same store; the two Tracks cards each mount one.
 */
export function transparencyField(store: AnnotationStore): HTMLElement {
  return stepperField({
    label: 'transparency',
    title:
      `Transparency of every track, as a percentage — 0 is opaque, ${MAX_TRANSPARENCY} is ` +
      'nearly gone. Applies to all of them at once.',
    // Five, because one per cent of transparency is not a visible change and a
    // reader pressing this is watching the picture, not counting.
    step: 5,
    min: 0,
    max: MAX_TRANSPARENCY,
    // Read from the *store*, so the box shows what the tracks actually are: a
    // config loaded with faded tracks, or a single row's own opacity changed
    // from its settings, both land here.
    // Zero rather than `null` for an empty store: `null` means "leave the box
    // alone", which on a session with no tracks yet left it *blank* — a number
    // field showing nothing, in a card whose other two boxes show numbers. There
    // is a true answer here and it is zero: nothing is faded, because there is
    // nothing to fade, and a track dropped in a moment later arrives opaque.
    read: () => {
      const first = store.entries[0]
      return first === undefined ? 0 : Math.round((1 - first.style.opacity) * 100)
    },
    apply: (percent) => {
      const opacity = 1 - percent / 100
      for (const entry of store.entries) store.restyle(entry.id, { opacity })
    },
    subscribe: (onChange) => store.subscribe(onChange),
  })
}
